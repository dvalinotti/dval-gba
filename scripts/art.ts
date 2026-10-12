/** Turn art/sprites.ts and the contact QR code into PNGs the build can bake. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import qrcode from "qrcode-generator";
import { PALETTE, rgb, type PaletteKey } from "../art/palette.ts";
import { SPRITES } from "../art/sprites.ts";

const root = resolve(import.meta.dir, "..");

function writePng(path: string, width: number, height: number, pixel: (x: number, y: number) => [number, number, number] | null) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = pixel(x, y), at = (y * width + x) * 4;
    png.data.set(color ? [...color, 255] : [0, 0, 0, 0], at);
  }
  writeFileSync(path, PNG.sync.write(png));
}

function sprite(name: string, rows: string[], out: string) {
  const width = rows[0]!.length;
  rows.forEach((row, y) => {
    if (row.length !== width) throw new Error(`${name}: row ${y} is ${row.length} pixels wide, expected ${width}`);
    for (const key of row) if (key !== "." && !(key in PALETTE)) throw new Error(`${name}: row ${y} uses "${key}", which is not in art/palette.ts`);
  });
  writePng(resolve(out, `${name}.png`), width, rows.length, (x, y) => {
    const key = rows[y]![x]!;
    return key === "." ? null : rgb(PALETTE[key as PaletteKey]);
  });
}

/**
 * A QR code, `scale` pixels per module, centered on the smallest
 * power-of-two square (PocketJS textures are powers of two) that leaves at
 * least a two-module quiet zone.
 */
function qr(text: string, scale: number, path: string) {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const modules = code.getModuleCount();
  let size = 1;
  while (size < (modules + 4) * scale) size *= 2;
  const margin = Math.floor((size - modules * scale) / 2);
  const ink = rgb(PALETTE["0"]), paper = rgb(PALETTE.c);
  writePng(path, size, size, (x, y) => {
    const column = Math.floor((x - margin) / scale), row = Math.floor((y - margin) / scale);
    const dark = x >= margin && y >= margin && column < modules && row < modules && code.isDark(row, column);
    return dark ? ink : paper;
  });
  return size;
}

export function buildArt(out: string) {
  mkdirSync(out, { recursive: true });
  for (const [name, rows] of Object.entries(SPRITES)) sprite(name, rows, out);
  const site = JSON.parse(readFileSync(resolve(root, "content/site.json"), "utf8"));
  qr(site.contact.url, 2, resolve(out, "contact-qr.png"));
}

if (import.meta.main) buildArt(resolve(root, ".build/art"));
