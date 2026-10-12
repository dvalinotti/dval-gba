/**
 * Press Start 2P draws on an 8 × 8 grid: one font pixel is 125 of its 1000
 * units per em. PocketJS bakes text at fixed slot sizes (12, 16, 24 px, …), so
 * the cartridge gets two faces from the one font:
 *
 * - regular: the em rescaled to 1500 units, so `text-xs` (12 px) draws each
 *   font pixel as exactly one screen pixel: 8 px glyphs for body text.
 * - bold: the font as published, so `font-bold text-base` (16 px) draws 2×
 *   and `font-bold text-2xl` (24 px) draws 3× for headings.
 *
 * Both are written to the ignored build directory and never distributed; the
 * repository carries the original WOFF and its OFL license.
 */
import { inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = resolve(import.meta.dir, "../assets/fonts/PressStart2P-latin.woff");

/** WOFF 1.0 to sfnt, optionally rewriting head.unitsPerEm. */
export function woffToSfnt(woff: Uint8Array, unitsPerEm?: number): Uint8Array {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (view.getUint32(0) !== 0x774f4646) throw new Error("not a WOFF 1.0 file");
  const flavor = view.getUint32(4), count = view.getUint16(12);
  const tables: { tag: number; data: Uint8Array; checksum: number }[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 44 + i * 20;
    const tag = view.getUint32(entry), offset = view.getUint32(entry + 4), compressed = view.getUint32(entry + 8), length = view.getUint32(entry + 12);
    const raw = woff.subarray(offset, offset + compressed);
    tables.push({ tag, data: compressed < length ? new Uint8Array(inflateSync(raw)) : raw.slice(), checksum: view.getUint32(entry + 16) });
  }
  tables.sort((a, b) => a.tag - b.tag);
  let size = 12 + 16 * count;
  const offsets = tables.map(table => { const at = size; size += (table.data.length + 3) & ~3; return at; });
  const out = new Uint8Array(size), sfnt = new DataView(out.buffer);
  let power = 1, log = 0;
  while (power * 2 <= count) { power *= 2; log++; }
  sfnt.setUint32(0, flavor); sfnt.setUint16(4, count); sfnt.setUint16(6, power * 16); sfnt.setUint16(8, log); sfnt.setUint16(10, count * 16 - power * 16);
  tables.forEach((table, i) => {
    // head.unitsPerEm is the uint16 at offset 18 of the head table.
    if (unitsPerEm && table.tag === 0x68656164) new DataView(table.data.buffer, table.data.byteOffset).setUint16(18, unitsPerEm);
    const entry = 12 + i * 16;
    sfnt.setUint32(entry, table.tag); sfnt.setUint32(entry + 4, table.checksum); sfnt.setUint32(entry + 8, offsets[i]!); sfnt.setUint32(entry + 12, table.data.length);
    out.set(table.data, offsets[i]!);
  });
  return out;
}

export function pixelFonts(directory: string): { regularTtf: string; boldTtf: string } {
  mkdirSync(directory, { recursive: true });
  const woff = readFileSync(SOURCE);
  const regularTtf = resolve(directory, "pixel-1x.ttf"), boldTtf = resolve(directory, "pixel-2x.ttf");
  writeFileSync(regularTtf, woffToSfnt(woff, 1500));
  writeFileSync(boldTtf, woffToSfnt(woff));
  return { regularTtf, boldTtf };
}
