/** Turn art/sprites.ts and the contact QR code into PNGs the build can bake. */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import qrcode from 'qrcode-generator'
import { PALETTE, rgb, type PaletteKey } from '../art/palette.ts'
import { SPRITES } from '../art/sprites.ts'
import type { Site } from './content.ts'
import { writePng } from './pixels.ts'

const root = resolve(import.meta.dir, '..')

/** A sprite's grid: one row per string, one palette key (or "." for transparent) per pixel. */
function sprite(name: string, rows: string[], out: string) {
  const width = rows[0].length
  rows.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(
        `${name}: row ${y} is ${row.length} pixels wide, expected ${width}`
      )
    }
    for (const key of row) {
      if (key !== '.' && !(key in PALETTE)) {
        throw new Error(
          `${name}: row ${y} uses "${key}", which is not in art/palette.ts`
        )
      }
    }
  })
  writePng(resolve(out, `${name}.png`), width, rows.length, (x, y) => {
    const key = rows[y][x]
    return key === '.' ? null : rgb(PALETTE[key as PaletteKey])
  })
}

/**
 * A QR code, `scale` pixels per module, centered on the smallest
 * power-of-two square (PocketJS textures are powers of two) that leaves at
 * least a two-module quiet zone. Returns the square's size.
 */
function qr(text: string, scale: number, path: string): number {
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  const modules = code.getModuleCount()
  let size = 1
  while (size < (modules + 4) * scale) size *= 2
  const margin = Math.floor((size - modules * scale) / 2)
  const ink = rgb(PALETTE['0'])
  const paper = rgb(PALETTE.c)
  writePng(path, size, size, (x, y) => {
    const column = Math.floor((x - margin) / scale)
    const row = Math.floor((y - margin) / scale)
    const inside =
      x >= margin && y >= margin && column < modules && row < modules
    return inside && code.isDark(row, column) ? ink : paper
  })
  return size
}

export function buildArt(out: string) {
  mkdirSync(out, { recursive: true })
  for (const [name, rows] of Object.entries(SPRITES)) sprite(name, rows, out)
  const site: Site = JSON.parse(
    readFileSync(resolve(root, 'content/site.json'), 'utf8')
  )
  qr(site.contact.url, 2, resolve(out, 'contact-qr.png'))
}

if (import.meta.main) buildArt(resolve(root, '.build/art'))
