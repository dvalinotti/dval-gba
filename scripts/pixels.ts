/**
 * Image helpers shared by the content sync and the art build: decode a photo
 * or logo, area-average it down to sprite size, pick colors and write PNGs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

export type RGB = [number, number, number]

/** Decoded RGBA pixels, row by row. */
export interface Bitmap {
  width: number
  height: number
  data: Uint8Array
}

/** One downsampled pixel: its alpha-weighted average color and coverage (0–255). */
export interface Sample {
  color: RGB
  alpha: number
}

export function decode(path: string): Bitmap {
  const bytes = readFileSync(path)
  const image = /\.jpe?g$/i.test(path)
    ? jpeg.decode(bytes, { useTArray: true })
    : PNG.sync.read(bytes)
  return { width: image.width, height: image.height, data: image.data }
}

/**
 * Area-average the square at (left, top) with sides of `side` source pixels
 * down to size × size samples. The square may extend past the image, which
 * letterboxes a non-square image: source pixels outside are skipped, and a
 * sample with none inside has alpha 0.
 */
export function resample(
  image: Bitmap,
  size: number,
  left: number,
  top: number,
  side: number
): Sample[] {
  const scale = side / size
  const samples: Sample[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fromX = left + x * scale
      const fromY = top + y * scale
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      let count = 0
      const rowEnd = Math.min(image.height, Math.ceil(fromY + scale))
      const columnEnd = Math.min(image.width, Math.ceil(fromX + scale))
      for (let sy = Math.max(0, Math.floor(fromY)); sy < rowEnd; sy++) {
        for (let sx = Math.max(0, Math.floor(fromX)); sx < columnEnd; sx++) {
          const at = (sy * image.width + sx) * 4
          const a = image.data[at + 3]
          r += image.data[at] * a
          g += image.data[at + 1] * a
          b += image.data[at + 2] * a
          alpha += a
          count++
        }
      }
      samples.push(
        alpha
          ? { color: [r / alpha, g / alpha, b / alpha], alpha: alpha / count }
          : { color: [0, 0, 0], alpha: 0 }
      )
    }
  }
  return samples
}

export type Distance = (a: RGB, b: RGB) => number

/** Squared distance in RGB. */
export const rgbDistance: Distance = (a, b) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** Squared distance weighted by each channel's share of luma, which tracks what eyes notice. */
export const lumaDistance: Distance = (a, b) =>
  0.3 * (a[0] - b[0]) ** 2 +
  0.59 * (a[1] - b[1]) ** 2 +
  0.11 * (a[2] - b[2]) ** 2

/** The index of the palette color closest to `color`; the first one on a tie. */
export function nearest(
  color: RGB,
  palette: RGB[],
  distance: Distance
): number {
  let best = 0
  for (let i = 1; i < palette.length; i++) {
    if (distance(palette[i], color) < distance(palette[best], color)) best = i
  }
  return best
}

/**
 * A `k`-color palette for `colors` by k-means. The starting centers are
 * evenly spaced picks from `colors`, so the result is deterministic.
 */
export function kmeans(
  colors: RGB[],
  k: number,
  rounds: number,
  distance: Distance
): RGB[] {
  let centers = Array.from(
    { length: k },
    (_, i) => [...colors[Math.floor(((i + 0.5) * colors.length) / k)]] as RGB
  )
  for (let round = 0; round < rounds; round++) {
    const sums = centers.map(() => ({ color: [0, 0, 0] as RGB, count: 0 }))
    for (const color of colors) {
      const sum = sums[nearest(color, centers, distance)]
      sum.color[0] += color[0]
      sum.color[1] += color[1]
      sum.color[2] += color[2]
      sum.count++
    }
    // A center that won no colors stays where it was.
    centers = sums.map(({ color, count }, i) =>
      count
        ? [color[0] / count, color[1] / count, color[2] / count]
        : centers[i]
    )
  }
  return centers
}

/** Round each channel to the GBA's 5 bits (multiples of 8, at most 248), so the cartridge shows the exact color. */
export const toGba = (color: RGB): RGB =>
  color.map((channel) => Math.min(248, Math.round(channel / 8) * 8)) as RGB

/** Write a PNG; `pixel` returns a color, or null for transparent. */
export function writePng(
  path: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => RGB | null
) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pixel(x, y)
      png.data.set(color ? [...color, 255] : [0, 0, 0, 0], (y * width + x) * 4)
    }
  }
  writeFileSync(path, PNG.sync.write(png))
}
