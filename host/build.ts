#!/usr/bin/env bun
/**
 * Build the dval.dev cartridge: compile app/ with MicroTS, bake its sprite
 * layers on the desktop, pack them into GBA tiles and link the ROM.
 *
 * Adapted from PocketJS's hosts/gba/build.ts (MIT). The pipeline is the same;
 * what changed is where the app, fonts and images come from.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { analyzeAot, buildAot } from "../vendor/pocketjs/microts/compiler/aot-build.ts";
import { bakeAtlases } from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import { bakeSvg } from "../vendor/pocketjs/framework/compiler/bake-svg.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import type { LayerDeclarations } from "../vendor/pocketjs/microts/compiler/aot-paint-plan.ts";
import { packLayers } from "./assets.ts";
import { pixelFonts } from "../scripts/fonts.ts";
import { buildArt } from "../scripts/art.ts";

const root = resolve(import.meta.dir, "..");
const pocket = resolve(root, "vendor/pocketjs");
export const GBA_TOOLCHAIN = "nightly-2026-07-01";
const VIEWPORT: [number, number] = [240, 160];
const TICK_RATE = 30;
// Cartridge boot logo bytes defined by the GBA ROM header format.
const logo = "24ffae51699aa2213d84820a84e409ad11248b98c0817f21a352be199309ce2010464a4af82731ec58c7e83382e3cebf85f4df94ce4b09c194568ac01372a7fc9f844d73a3ca9a615897a327fc039876231dc7610304ae56bf38840040a70efdff52fe036f9530f197fbc08560d68025a963be03014e38e2f9a234ffbb3e0344780090cb88113a9465c07c6387f03cafd625e48b380aac7221d4f807";

/** Extract ELF32 load segments by physical address and write the cartridge header. */
export function gbaRom(elf: Uint8Array, title: string, code: string): Uint8Array {
  if (elf.length < 52) throw new Error("Truncated ELF32 header");
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46 || elf[4] !== 1 || elf[5] !== 1 || view.getUint16(18, true) !== 40) throw new Error("Expected ARM little-endian ELF32");
  const offset = view.getUint32(28, true), size = view.getUint16(42, true), count = view.getUint16(44, true);
  if (!count || size < 32 || offset + size * count > elf.length) throw new Error("Invalid ELF32 program headers");
  const segments: { offset: number; address: number; size: number }[] = [];
  let end = 192;
  for (let i = 0; i < count; i++) {
    const p = offset + i * size;
    if (view.getUint32(p, true) !== 1) continue;
    const address = view.getUint32(p + 12, true), length = view.getUint32(p + 16, true), source = view.getUint32(p + 4, true);
    if (!length) continue;
    if (address < 0x08000000 || address + length > 0x0a000000 || source + length > elf.length) throw new Error("ELF load segment is outside GBA ROM");
    segments.push({ offset: source, address: address - 0x08000000, size: length });
    end = Math.max(end, address - 0x08000000 + length);
  }
  if (!segments.some(segment => segment.address === 0 && segment.size >= 192)) throw new Error("Missing GBA startup/header segment");
  if (title.length > 12 || code.length !== 6) throw new Error("ROM title is at most 12 characters; game + maker code is 6");
  const rom = new Uint8Array((end + 3) & ~3).fill(0xff);
  for (const segment of segments) rom.set(elf.subarray(segment.offset, segment.offset + segment.size), segment.address);
  rom.set(Buffer.from(logo, "hex"), 4);
  rom.fill(0, 0xa0, 0xc0);
  rom.set(new TextEncoder().encode(title), 0xa0);
  rom.set(new TextEncoder().encode(code), 0xac);
  rom[0xb2] = 0x96;
  let checksum = 0x19;
  for (let i = 0xa0; i <= 0xbc; i++) checksum += rom[i]!;
  rom[0xbd] = -checksum & 0xff;
  return rom;
}

/** Every `src="…"` an app source file names, resolved against the image directories. */
function appImages(appDir: string, directories: string[]): Map<string, string> {
  const images = new Map<string, string>();
  for (const file of readdirSync(appDir).filter(name => /\.tsx?$/.test(name))) {
    for (const match of readFileSync(resolve(appDir, file), "utf8").matchAll(/\bsrc="([^"]+)"/g)) {
      const name = match[1]!;
      const path = directories.map(directory => resolve(directory, name)).find(existsSync);
      if (!path) throw new Error(`${file}: image ${name} is not in ${directories.join(" or ")}`);
      images.set(name, path);
    }
  }
  return images;
}

function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  if (child.exitCode !== 0) throw new Error(`${command.join(" ")} failed`);
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("bun host/build.ts [--outdir=<directory>]\nRequires rustup toolchain install nightly-2026-07-01 --component rust-src");
    return;
  }
  const options = process.argv.slice(2);
  if (options.some(arg => !arg.startsWith("--outdir="))) throw new Error("Unknown argument; use --help");
  const out = resolve(options.find(arg => arg.startsWith("--outdir="))?.slice(9) ?? resolve(root, "dist"));
  const work = resolve(root, ".build");
  const gen = resolve(work, "generated");
  mkdirSync(out, { recursive: true });
  mkdirSync(gen, { recursive: true });

  // Pixel art sources become PNGs before the compiler or baker sees them.
  const artDir = resolve(work, "art");
  buildArt(artDir);

  // The page is solved at build time in the no_std wasm core: the same crate
  // and float math the cartridge runs. Fonts come first because text leaves
  // measure during that solve.
  const appDir = resolve(root, "app");
  const entry = resolve(appDir, "app.tsx");
  const { regularTtf, boldTtf } = pixelFonts(resolve(work, "fonts"));
  const fonts = await bakeAtlases({ codepoints: [], slots: analyzeAot(entry, { strict: true }).styles.usedFontSlots, regularTtf, boldTtf });
  run([process.execPath, resolve(pocket, "tools/wasm.ts")], pocket);
  const wasm = resolve(pocket, "hosts/web/pocketjs.wasm");
  // Optional per-layer declarations (size ranges, glyph sets, text lengths)
  // the recipes cannot infer from literals and types.
  const declarationsPath = resolve(appDir, "gba-layers.json");
  const declarations: LayerDeclarations = existsSync(declarationsPath) ? JSON.parse(readFileSync(declarationsPath, "utf8")) : {};
  const result = await buildAot(entry, { outDir: gen, strict: true, format: false, layoutEnvironment: {
    viewport: VIEWPORT, fontAtlases: fonts.map(font => font.bytes), wasm: readFileSync(wasm), spriteLayers: true, tickRate: TICK_RATE, declarations,
  } });
  for (const region of result.layout.regions) console.log(`layout-baked ${region.name}: ${region.nodes} nodes, ${region.formulas} formula leaves, ${region.islands} live islands, ${region.layers.length} sprite layers`);
  // The sprite layer plan drives the desktop baker and the packer.
  const layers = result.layout.regions.flatMap(region => region.layers);
  writeFileSync(resolve(gen, "layers.json"), JSON.stringify({ viewport: VIEWPORT, tickRate: TICK_RATE, settleFrames: 40, layers }, null, 2) + "\n");
  for (const font of fonts) writeFileSync(resolve(gen, `font-${font.slot}.bin`), font.bytes);
  const images: string[] = [];
  for (const [name, file] of appImages(appDir, [artDir, resolve(root, "assets")])) {
    const bytes = readFileSync(file);
    const image = name.endsWith(".svg") ? bakeSvg(bytes.toString()) : decodePng(bytes);
    const path = resolve(gen, `${name.replaceAll("/", "_")}.rgba`);
    writeFileSync(path, image.rgba);
    images.push(`{ let id = ui.core_mut().upload_texture(include_bytes!(${JSON.stringify(path)}), ${image.width}, ${image.height}, microts::pocketjs_core::spec::psm::PSM_8888); assert!(id >= 0); ui.register_image(${JSON.stringify(name)}, id); }`);
  }
  writeFileSync(resolve(gen, "include.rs"), `#[path = ${JSON.stringify(resolve(gen, "mod.rs"))}]\nmod generated;\n#[allow(dead_code)]\nfn load_fonts(ui: &mut microts::Ui) {\n${fonts.map(font => `assert!(ui.core_mut().load_font_atlas(include_bytes!(${JSON.stringify(resolve(gen, `font-${font.slot}.bin`))})));`).join("\n")}\n}\n#[allow(dead_code)]\nfn load_images(ui: &mut microts::Ui) {\n${images.join("\n")}\n}\n`);

  const bakeDirectory = resolve(work, "baked");
  mkdirSync(bakeDirectory, { recursive: true });
  const bakeCommand = ["cargo", "+stable", "run", "--locked", "--release", "--manifest-path", resolve(root, "host/bake/Cargo.toml"), "--target-dir", resolve(work, "bake-target"), "--", bakeDirectory];
  run(bakeCommand, root, { GBA_GENERATED: gen });
  const assets = packLayers(bakeDirectory, gen);
  for (const layer of assets.layers) console.log(`layer ${layer.name}: ${layer.frames} frames x ${layer.bytesPerFrame} B, crop [${layer.crop.join(", ")}], ${layer.oam} OAM, ${layer.vramBytes} B VRAM`);
  console.log(`OAM ${assets.oamSlots}/128, OBJ VRAM ${assets.vramBytes}/32768 B, frame ROM ${assets.frameBytes} B`);

  const command = ["cargo", `+${GBA_TOOLCHAIN}`, "build", "--locked", "--release", "--target", "thumbv4t-none-eabi", "-Z", "build-std=core,alloc", "--manifest-path", resolve(root, "host/Cargo.toml"), "--target-dir", resolve(work, "target")];
  const rustflags = ["-C", `link-arg=-T${resolve(root, "host/gba.ld")}`, "-C", "link-arg=--gc-sections"];
  run(command, root, { GBA_GENERATED: gen, CARGO_ENCODED_RUSTFLAGS: rustflags.join("\x1f") });
  const elf = readFileSync(resolve(work, "target/thumbv4t-none-eabi/release/dval-gba"));
  const rom = gbaRom(elf, "DVAL.DEV", "DVAL01");
  writeFileSync(resolve(out, "dval-gba.elf"), elf);
  writeFileSync(resolve(out, "dval-gba.gba"), rom);
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const pocketCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: pocket }).stdout.toString().trim();
  writeFileSync(resolve(out, "build.json"), JSON.stringify({
    target: "thumbv4t-none-eabi", toolchain: GBA_TOOLCHAIN, pocketjs: pocketCommit, command, rustflags, bakeCommand,
    romBytes: rom.length, romSha256: hash(rom), elfSha256: hash(elf),
    nominalTickHz: TICK_RATE, vblanksPerPresentation: 2,
    fontSlots: result.program.styles.usedFontSlots,
    layout: result.layout.regions.map(region => ({ ...region, layers: region.layers.map(layer => ({ name: layer.name, kind: layer.recipe.kind, rect: layer.rect })) })),
    renderer: "mode0-bg-obj", assets,
  }, null, 2) + "\n");
  console.log(`dval-gba: ${rom.length} ROM bytes -> ${resolve(out, "dval-gba.gba")}`);
}
if (import.meta.main) await main();
