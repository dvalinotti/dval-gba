/**
 * The cartridge's pixel font. Press Start 2P draws every glyph on an 8 × 8
 * grid that fills its em. PocketJS bakes text at fixed slot sizes (12, 16,
 * 24 px, …), so the cartridge gets two faces from the one font:
 *
 * - regular: the em rescaled so `text-xs` (12 px) draws each font pixel as
 *   one screen pixel: 8 px glyphs for body text.
 * - bold: the font as published, so `font-bold text-base` (16 px) draws 2×
 *   and `font-bold text-2xl` (24 px) draws 3× for headings.
 *
 * To use another pixel font whose glyphs fill an 8 × 8 em, point SOURCE at
 * its WOFF. A different grid needs GLYPH_PIXELS changed here and GLYPH in
 * gen-app.ts, and the page layouts checked.
 *
 * Both faces are written to the ignored build directory and never
 * distributed; the repository carries the original WOFF and its license.
 */
import { inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = resolve(
  import.meta.dir,
  '../assets/fonts/PressStart2P-latin.woff'
)
/** Font pixels per em: the glyph grid's height. */
const GLYPH_PIXELS = 8
/** The `text-xs` slot's size in px, which the regular face fills at 1×. */
const TEXT_XS_PX = 12

// WOFF 1.0 and sfnt layout (https://www.w3.org/TR/WOFF/).
const WOFF_SIGNATURE = 0x774f4646 // "wOFF"
const WOFF_HEADER_SIZE = 44
const WOFF_ENTRY_SIZE = 20
const SFNT_HEADER_SIZE = 12
const SFNT_ENTRY_SIZE = 16
const HEAD_TAG = 0x68656164 // "head"
/** head.unitsPerEm is the uint16 at this offset in the head table. */
const UNITS_PER_EM_OFFSET = 18

interface Table {
  tag: number
  data: Uint8Array
  checksum: number
}

/** The sfnt flavor and decompressed tables of a WOFF 1.0 file. */
function readWoff(woff: Uint8Array): { flavor: number; tables: Table[] } {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength)
  if (view.getUint32(0) !== WOFF_SIGNATURE) {
    throw new Error('not a WOFF 1.0 file')
  }
  const flavor = view.getUint32(4)
  const count = view.getUint16(12)
  const tables: Table[] = []
  for (let i = 0; i < count; i++) {
    const entry = WOFF_HEADER_SIZE + i * WOFF_ENTRY_SIZE
    const offset = view.getUint32(entry + 4)
    const compressedLength = view.getUint32(entry + 8)
    const length = view.getUint32(entry + 12)
    const stored = woff.subarray(offset, offset + compressedLength)
    tables.push({
      tag: view.getUint32(entry),
      // A table is zlib-compressed only when that made it smaller.
      data:
        compressedLength < length
          ? new Uint8Array(inflateSync(stored))
          : stored.slice(),
      checksum: view.getUint32(entry + 16)
    })
  }
  return { flavor, tables }
}

/** An sfnt (TrueType/OpenType) file from tables, sorted by tag as the format requires. */
function writeSfnt(flavor: number, unsorted: Table[]): Uint8Array {
  const tables = [...unsorted].sort((a, b) => a.tag - b.tag)
  const count = tables.length
  // Each table starts on a 4-byte boundary after the table directory.
  let size = SFNT_HEADER_SIZE + SFNT_ENTRY_SIZE * count
  const offsets = tables.map((table) => {
    const at = size
    size += (table.data.length + 3) & ~3
    return at
  })
  const out = new Uint8Array(size)
  const sfnt = new DataView(out.buffer)
  // The directory's binary-search hints: the largest power of two <= count.
  let power = 1
  let log = 0
  while (power * 2 <= count) {
    power *= 2
    log++
  }
  sfnt.setUint32(0, flavor)
  sfnt.setUint16(4, count)
  sfnt.setUint16(6, power * SFNT_ENTRY_SIZE)
  sfnt.setUint16(8, log)
  sfnt.setUint16(10, (count - power) * SFNT_ENTRY_SIZE)
  tables.forEach((table, i) => {
    const entry = SFNT_HEADER_SIZE + i * SFNT_ENTRY_SIZE
    sfnt.setUint32(entry, table.tag)
    sfnt.setUint32(entry + 4, table.checksum)
    sfnt.setUint32(entry + 8, offsets[i])
    sfnt.setUint32(entry + 12, table.data.length)
    out.set(table.data, offsets[i])
  })
  return out
}

/** The font's tables with head.unitsPerEm replaced. The head table is copied, not edited in place. */
function withUnitsPerEm(tables: Table[], unitsPerEm: number): Table[] {
  return tables.map((table) => {
    if (table.tag !== HEAD_TAG) return table
    const data = table.data.slice()
    new DataView(data.buffer).setUint16(UNITS_PER_EM_OFFSET, unitsPerEm)
    return { ...table, data }
  })
}

/** Write the regular and bold faces to `directory` and return their paths. */
export function pixelFonts(directory: string): {
  regularTtf: string
  boldTtf: string
} {
  mkdirSync(directory, { recursive: true })
  const { flavor, tables } = readWoff(readFileSync(SOURCE))
  const head = tables.find((table) => table.tag === HEAD_TAG)
  if (!head) throw new Error(`${SOURCE} has no head table`)
  const unitsPerEm = new DataView(
    head.data.buffer,
    head.data.byteOffset
  ).getUint16(UNITS_PER_EM_OFFSET)
  // Scale the em so one font pixel is one screen pixel at TEXT_XS_PX.
  const regularEm = (unitsPerEm / GLYPH_PIXELS) * TEXT_XS_PX

  const regularTtf = resolve(directory, 'pixel-1x.ttf')
  const boldTtf = resolve(directory, 'pixel-2x.ttf')
  writeFileSync(
    regularTtf,
    writeSfnt(flavor, withUnitsPerEm(tables, regularEm))
  )
  writeFileSync(boldTtf, writeSfnt(flavor, tables))
  return { regularTtf, boldTtf }
}
