/**
 * Sweetie 16 by GrafxKid (CC0): every pixel-art sprite, the window chrome and
 * the pixelated project logos draw from these sixteen colors, so the
 * cartridge's shared 256-color sprite palette never has to approximate.
 * Keys are the characters the sprite grids in art/sprites.ts use.
 */
export const PALETTE = {
  "0": "#1a1c2c", // ink
  "1": "#5d275d", // plum
  "2": "#b13e53", // red
  "3": "#ef7d57", // orange
  "4": "#ffcd75", // yellow
  "5": "#a7f070", // lime
  "6": "#38b764", // green
  "7": "#257179", // teal
  "8": "#29366f", // navy
  "9": "#3b5dc9", // blue
  a: "#41a6f6", // sky
  b: "#73eff7", // cyan
  c: "#f4f4f4", // white
  d: "#94b0c2", // silver
  e: "#566c86", // slate
  f: "#333c57", // charcoal
} as const;

export type PaletteKey = keyof typeof PALETTE;

export function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255];
}
