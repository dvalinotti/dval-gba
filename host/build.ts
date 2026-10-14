#!/usr/bin/env bun
/**
 * Build the dval.dev cartridge:
 *
 * 1. Render the pixel art and fonts the app uses.
 * 2. Compile app/ with MicroTS to Rust, solving the layout at build time.
 * 3. Bake every sprite-layer state on the desktop (host/bake).
 * 4. Pack the baked frames into GBA tiles (host/assets.ts).
 * 5. Compile the cartridge (host/src) and turn the ELF into a ROM.
 *
 * Adapted from PocketJS's hosts/gba/build.ts (MIT). The pipeline is the same;
 * what changed is where the app, fonts and images come from.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  analyzeAot,
  buildAot
} from '../vendor/pocketjs/microts/compiler/aot-build.ts'
import {
  bakeAtlases,
  type BakedAtlas
} from '../vendor/pocketjs/framework/compiler/bake-font.ts'
import { bakeSvg } from '../vendor/pocketjs/framework/compiler/bake-svg.ts'
import { decodePng } from '../vendor/pocketjs/framework/compiler/pak.ts'
import type { LayerDeclarations } from '../vendor/pocketjs/microts/compiler/aot-paint-plan.ts'
import { packLayers } from './assets.ts'
import { pixelFonts } from '../scripts/fonts.ts'
import { buildArt } from '../scripts/art.ts'

const root = resolve(import.meta.dir, '..')
const pocket = resolve(root, 'vendor/pocketjs')
const work = resolve(root, '.build')
const gen = resolve(work, 'generated')
const appDir = resolve(root, 'app')
/** Where a build with --start-page compiles its copy of app/. */
const stagedAppDir = resolve(work, 'app')
const artDir = resolve(work, 'art')

export const GBA_TOOLCHAIN = 'nightly-2026-07-01'
const TARGET = 'thumbv4t-none-eabi'
const VIEWPORT: [number, number] = [240, 160]
/** Frames per second the model and animations tick at: every second VBlank. */
const TICK_RATE = 30
const ROM_TITLE = 'DVAL.DEV'
/** Four-character game code plus two-character maker code. */
const ROM_CODE = 'DVAL01'

// ---------------------------------------------------------------------------
// ELF to GBA ROM.

// ELF32 header fields (System V ABI).
const ELF_MAGIC = 0x7f454c46 // "\x7fELF"
const ELF_HEADER_SIZE = 52
const ELFCLASS32 = 1
const ELFDATA2LSB = 1
const EM_ARM = 40
const PT_LOAD = 1

// The cartridge is mapped at 0x08000000 and may be up to 32 MiB.
const ROM_START = 0x08000000
const ROM_END = 0x0a000000

// GBA cartridge header fields (GBATEK, "GBA Cartridge Header").
const HEADER_SIZE = 0xc0
const LOGO_OFFSET = 0x04
const TITLE_OFFSET = 0xa0
const CODE_OFFSET = 0xac
const FIXED_OFFSET = 0xb2
const FIXED_VALUE = 0x96
const CHECKSUM_OFFSET = 0xbd
/** The Nintendo logo the BIOS checks before it boots a cartridge. */
const LOGO =
  '24ffae51699aa2213d84820a84e409ad11248b98c0817f21a352be199309ce2010464a4af82731ec58c7e83382e3cebf85f4df94ce4b09c194568ac01372a7fc9f844d73a3ca9a615897a327fc039876231dc7610304ae56bf38840040a70efdff52fe036f9530f197fbc08560d68025a963be03014e38e2f9a234ffbb3e0344780090cb88113a9465c07c6387f03cafd625e48b380aac7221d4f807'

interface Segment {
  offset: number
  address: number
  size: number
}

/** The ELF's loadable segments, with addresses relative to the start of ROM. */
function loadSegments(elf: Uint8Array): Segment[] {
  if (elf.length < ELF_HEADER_SIZE) throw new Error('Truncated ELF32 header')
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength)
  const isArmElf32 =
    view.getUint32(0, false) === ELF_MAGIC &&
    elf[4] === ELFCLASS32 &&
    elf[5] === ELFDATA2LSB &&
    view.getUint16(18, true) === EM_ARM
  if (!isArmElf32) throw new Error('Expected ARM little-endian ELF32')

  const tableOffset = view.getUint32(28, true)
  const entrySize = view.getUint16(42, true)
  const count = view.getUint16(44, true)
  if (
    !count ||
    entrySize < 32 ||
    tableOffset + entrySize * count > elf.length
  ) {
    throw new Error('Invalid ELF32 program headers')
  }

  const segments: Segment[] = []
  for (let i = 0; i < count; i++) {
    const entry = tableOffset + i * entrySize
    if (view.getUint32(entry, true) !== PT_LOAD) continue
    const source = view.getUint32(entry + 4, true)
    const address = view.getUint32(entry + 12, true)
    const length = view.getUint32(entry + 16, true)
    if (!length) continue
    const inRom =
      address >= ROM_START &&
      address + length <= ROM_END &&
      source + length <= elf.length
    if (!inRom) throw new Error('ELF load segment is outside GBA ROM')
    segments.push({
      offset: source,
      address: address - ROM_START,
      size: length
    })
  }
  return segments
}

/** Lay the ELF's load segments out by address and write the cartridge header. */
export function gbaRom(
  elf: Uint8Array,
  title: string,
  code: string
): Uint8Array {
  if (title.length > 12 || code.length !== 6) {
    throw new Error(
      'ROM title is at most 12 characters; game + maker code is 6'
    )
  }
  const segments = loadSegments(elf)
  const startsWithHeader = segments.some(
    (segment) => segment.address === 0 && segment.size >= HEADER_SIZE
  )
  if (!startsWithHeader) throw new Error('Missing GBA startup/header segment')

  const end = Math.max(
    HEADER_SIZE,
    ...segments.map((segment) => segment.address + segment.size)
  )
  // Unused ROM reads as 0xff, like erased flash. The size is word-aligned.
  const rom = new Uint8Array((end + 3) & ~3).fill(0xff)
  for (const segment of segments) {
    const bytes = elf.subarray(segment.offset, segment.offset + segment.size)
    rom.set(bytes, segment.address)
  }

  rom.set(Buffer.from(LOGO, 'hex'), LOGO_OFFSET)
  rom.fill(0, TITLE_OFFSET, HEADER_SIZE)
  rom.set(new TextEncoder().encode(title), TITLE_OFFSET)
  rom.set(new TextEncoder().encode(code), CODE_OFFSET)
  rom[FIXED_OFFSET] = FIXED_VALUE
  // The complement check: the BIOS requires 0x19 plus bytes 0xa0..0xbd to be
  // zero modulo 256.
  let sum = 0x19
  for (let i = TITLE_OFFSET; i < CHECKSUM_OFFSET; i++) sum += rom[i]
  rom[CHECKSUM_OFFSET] = -sum & 0xff
  return rom
}

// ---------------------------------------------------------------------------
// Build steps.

function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawnSync(command, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, ...env }
  })
  if (child.exitCode !== 0) throw new Error(`${command.join(' ')} failed`)
}

/** Every `src="…"` an app source file names, resolved against the image directories. */
function appImages(directories: string[]): Map<string, string> {
  const images = new Map<string, string>()
  const sources = readdirSync(appDir).filter((name) => /\.tsx?$/.test(name))
  for (const file of sources) {
    const source = readFileSync(resolve(appDir, file), 'utf8')
    for (const [, name] of source.matchAll(/\bsrc="([^"]+)"/g)) {
      const path = directories
        .map((directory) => resolve(directory, name))
        .find(existsSync)
      if (!path) {
        throw new Error(
          `${file}: image ${name} is not in ${directories.join(' or ')}`
        )
      }
      images.set(name, path)
    }
  }
  return images
}

/** Each page's name, by index, from the comment gen-app writes above its branch. */
function pageNames(): string[] {
  const view = readFileSync(resolve(appDir, 'app.tsx'), 'utf8')
  const names: string[] = []
  const branch = /\{\/\* (\S+) \*\/\}\s*<Show when=\{page\(\) === (\d+)\}>/g
  for (const [, name, index] of view.matchAll(branch)) {
    names[Number(index)] = name
  }
  return names
}

/**
 * The directory to compile the app from. Without a start page that is app/
 * itself. With one, it is a copy of app/ in .build/app whose START constant
 * is that page (an index or a page name), so a dev build boots straight to
 * the page being worked on and the committed files stay as they are.
 */
function stageApp(start: string | undefined): string {
  if (start === undefined) return appDir
  const names = pageNames()
  const index = /^\d+$/.test(start) ? Number(start) : names.indexOf(start)
  if (index < 0 || index >= names.length) {
    const list = names.map((name, page) => `${page} ${name}`).join(', ')
    throw new Error(`Unknown start page ${start}; the pages are ${list}`)
  }
  rmSync(stagedAppDir, { recursive: true, force: true })
  cpSync(appDir, stagedAppDir, { recursive: true })
  const pages = resolve(stagedAppDir, 'pages.ts')
  const startLine = /^export const START = \d+$/m
  const constants = readFileSync(pages, 'utf8')
  if (!startLine.test(constants)) {
    throw new Error('app/pages.ts has no START; run scripts/gen-app.ts')
  }
  writeFileSync(
    pages,
    constants.replace(startLine, `export const START = ${index}`)
  )
  console.log(`start page ${index} (${names[index]})`)
  return stagedAppDir
}

/**
 * Compile app/ to Rust in .build/generated. The layout is solved at build
 * time in the no_std wasm core: the same crate and float math the cartridge
 * runs. Fonts are baked first because text measures during that solve.
 */
async function compileApp(source: string) {
  const entry = resolve(source, 'app.tsx')
  const { regularTtf, boldTtf } = pixelFonts(resolve(work, 'fonts'))
  const fonts = await bakeAtlases({
    codepoints: [],
    slots: analyzeAot(entry, { strict: true }).styles.usedFontSlots,
    regularTtf,
    boldTtf
  })
  run([process.execPath, resolve(pocket, 'tools/wasm.ts')], pocket)
  const wasm = resolve(pocket, 'hosts/web/pocketjs.wasm')
  // Optional per-layer declarations (size ranges, glyph sets, text lengths)
  // the recipes cannot infer from literals and types.
  const declarationsPath = resolve(appDir, 'gba-layers.json')
  const declarations: LayerDeclarations = existsSync(declarationsPath)
    ? JSON.parse(readFileSync(declarationsPath, 'utf8'))
    : {}
  const result = await buildAot(entry, {
    outDir: gen,
    strict: true,
    format: false,
    layoutEnvironment: {
      viewport: VIEWPORT,
      fontAtlases: fonts.map((font) => font.bytes),
      wasm: readFileSync(wasm),
      spriteLayers: true,
      tickRate: TICK_RATE,
      declarations
    }
  })
  for (const region of result.layout.regions) {
    console.log(
      `layout-baked ${region.name}: ${region.nodes} nodes, ${region.formulas} formula leaves, ${region.islands} live islands, ${region.layers.length} sprite layers`
    )
  }
  // The sprite layer plan drives the desktop baker and the packer.
  const layers = result.layout.regions.flatMap((region) => region.layers)
  const plan = {
    viewport: VIEWPORT,
    tickRate: TICK_RATE,
    settleFrames: 40,
    layers
  }
  writeFileSync(
    resolve(gen, 'layers.json'),
    JSON.stringify(plan, null, 2) + '\n'
  )
  writeInclude(fonts)
  return result
}

/**
 * Write include.rs, which both the baker and the cartridge include: the
 * generated app module plus functions that load the baked fonts and images.
 */
function writeInclude(fonts: BakedAtlas[]) {
  const loadFonts = fonts.map((font) => {
    const path = resolve(gen, `font-${font.slot}.bin`)
    writeFileSync(path, font.bytes)
    return `assert!(ui.core_mut().load_font_atlas(include_bytes!(${JSON.stringify(path)})));`
  })
  const loadImages = [...appImages([artDir, resolve(root, 'assets')])].map(
    ([name, file]) => {
      const bytes = readFileSync(file)
      const image = name.endsWith('.svg')
        ? bakeSvg(bytes.toString())
        : decodePng(bytes)
      const path = resolve(gen, `${name.replaceAll('/', '_')}.rgba`)
      writeFileSync(path, image.rgba)
      return `{ let id = ui.core_mut().upload_texture(include_bytes!(${JSON.stringify(path)}), ${image.width}, ${image.height}, microts::pocketjs_core::spec::psm::PSM_8888); assert!(id >= 0); ui.register_image(${JSON.stringify(name)}, id); }`
    }
  )
  const include = [
    `#[path = ${JSON.stringify(resolve(gen, 'mod.rs'))}]`,
    'mod generated;',
    '#[allow(dead_code)]',
    'fn load_fonts(ui: &mut microts::Ui) {',
    ...loadFonts,
    '}',
    '#[allow(dead_code)]',
    'fn load_images(ui: &mut microts::Ui) {',
    ...loadImages,
    '}',
    ''
  ]
  writeFileSync(resolve(gen, 'include.rs'), include.join('\n'))
}

/** Render every sprite-layer state on the desktop, then pack the frames into GBA tiles. */
function bakeLayers() {
  const bakeDirectory = resolve(work, 'baked')
  mkdirSync(bakeDirectory, { recursive: true })
  const command = [
    'cargo',
    '+stable',
    'run',
    '--locked',
    '--release',
    '--manifest-path',
    resolve(root, 'host/bake/Cargo.toml'),
    '--target-dir',
    resolve(work, 'bake-target'),
    '--',
    bakeDirectory
  ]
  run(command, root, { GBA_GENERATED: gen })
  const assets = packLayers(bakeDirectory, gen)
  for (const layer of assets.layers) {
    console.log(
      `layer ${layer.name}: ${layer.frames} frames x ${layer.bytesPerFrame} B, crop [${layer.crop.join(', ')}], ${layer.oam} OAM, ${layer.vramBytes} B VRAM`
    )
  }
  console.log(
    `OAM ${assets.oamSlots}/128, OBJ VRAM ${assets.vramBytes}/32768 B, frame ROM ${assets.frameBytes} B`
  )
  return { command, assets }
}

/** Compile the cartridge crate for the GBA's ARM7TDMI and return the ELF. */
function compileCartridge() {
  const command = [
    'cargo',
    `+${GBA_TOOLCHAIN}`,
    'build',
    '--locked',
    '--release',
    '--target',
    TARGET,
    '-Z',
    'build-std=core,alloc',
    '--manifest-path',
    resolve(root, 'host/Cargo.toml'),
    '--target-dir',
    resolve(work, 'target')
  ]
  const rustflags = [
    '-C',
    `link-arg=-T${resolve(root, 'host/gba.ld')}`,
    '-C',
    'link-arg=--gc-sections'
  ]
  run(command, root, {
    GBA_GENERATED: gen,
    CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f')
  })
  const elf = readFileSync(resolve(work, `target/${TARGET}/release/dval-gba`))
  return { command, rustflags, elf }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      `bun host/build.ts [--outdir=<directory>] [--start-page=<index or name>]\nRequires rustup toolchain install ${GBA_TOOLCHAIN} --component rust-src`
    )
    return
  }
  const options = process.argv.slice(2)
  const option = (name: string) =>
    options.find((arg) => arg.startsWith(name))?.slice(name.length)
  if (
    options.some(
      (arg) => !arg.startsWith('--outdir=') && !arg.startsWith('--start-page=')
    )
  ) {
    throw new Error('Unknown argument; use --help')
  }
  const outdir = option('--outdir=')
  const out = resolve(outdir ?? resolve(root, 'dist'))
  mkdirSync(out, { recursive: true })
  mkdirSync(gen, { recursive: true })

  buildArt(artDir)
  const result = await compileApp(stageApp(option('--start-page=')))
  const bake = bakeLayers()
  const cartridge = compileCartridge()
  const rom = gbaRom(cartridge.elf, ROM_TITLE, ROM_CODE)
  writeFileSync(resolve(out, 'dval-gba.elf'), cartridge.elf)
  writeFileSync(resolve(out, 'dval-gba.gba'), rom)

  // build.json records what produced this ROM.
  const hash = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex')
  const pocketCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: pocket
  })
    .stdout.toString()
    .trim()
  const report = {
    target: TARGET,
    toolchain: GBA_TOOLCHAIN,
    pocketjs: pocketCommit,
    command: cartridge.command,
    rustflags: cartridge.rustflags,
    bakeCommand: bake.command,
    romBytes: rom.length,
    romSha256: hash(rom),
    elfSha256: hash(cartridge.elf),
    nominalTickHz: TICK_RATE,
    vblanksPerPresentation: 2,
    fontSlots: result.program.styles.usedFontSlots,
    layout: result.layout.regions.map((region) => ({
      ...region,
      layers: region.layers.map((layer) => ({
        name: layer.name,
        kind: layer.recipe.kind,
        rect: layer.rect
      }))
    })),
    renderer: 'mode0-bg-obj',
    assets: bake.assets
  }
  writeFileSync(
    resolve(out, 'build.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  console.log(
    `dval-gba: ${rom.length} ROM bytes -> ${resolve(out, 'dval-gba.gba')}`
  )
}

if (import.meta.main) await main()
