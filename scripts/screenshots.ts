#!/usr/bin/env bun
/**
 * Play the built ROM headlessly in mGBA and save screenshots (3× scale) plus
 * a contact sheet.
 *
 *   bun scripts/screenshots.ts          a tour of each kind of screen -> docs/screenshots/
 *   bun scripts/screenshots.ts --all    every page, for review -> .build/all-pages/
 *
 * Needs libmgba and its headers (Debian/Ubuntu: apt install libmgba-dev).
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import type { Site } from './content.ts'

const root = resolve(import.meta.dir, '..')
const rom = resolve(root, 'dist/dval-gba.gba')
const runner = resolve(root, '.build/shots')
const raw = resolve(root, '.build/shots-raw')
const all = process.argv.includes('--all')
const out = resolve(root, all ? '.build/all-pages' : 'docs/screenshots')
/** Screenshots are 3× the GBA's 240 × 160. */
const SCALE = 3
const W = 240
const H = 160

const compile = Bun.spawnSync(
  ['cc', resolve(root, 'tools/shots.c'), '-o', runner, '-lmgba'],
  { stdout: 'inherit', stderr: 'inherit' }
)
if (compile.exitCode !== 0) {
  throw new Error('could not compile tools/shots.c; is libmgba installed?')
}

const site: Site = JSON.parse(
  readFileSync(resolve(root, 'content/site.json'), 'utf8')
)
/** Steps that page right through a section, naming each page after the first. */
const pages = (prefix: string, count: number): [string, string][] =>
  Array.from({ length: count - 1 }, (_, i) => [
    `${prefix}-${i + 2}`,
    'press RIGHT'
  ])

/** [screenshot name, step]: a tour of each kind of screen, or with --all every page. */
const TOUR: [string | null, string][] = all
  ? [
      ['title', 'wait 90'],
      ['menu', 'press START'],
      ['about-1', 'press A'],
      ...pages('about', 1 + site.principles.length),
      [null, 'press B'],
      [null, 'press DOWN'],
      ['projects-1', 'press A'],
      ...pages('projects', site.projects.length),
      [null, 'press B'],
      [null, 'press DOWN'],
      ['experience-1', 'press A'],
      ...pages('experience', site.experience.length),
      [null, 'press B'],
      [null, 'press DOWN'],
      ['contact', 'press A']
    ]
  : [
      ['title', 'wait 90'],
      ['menu', 'press START'],
      ['about', 'press A'],
      ['about-performance', 'press RIGHT'],
      [null, 'press B'],
      ['menu-projects', 'press DOWN'],
      ['projects', 'press A'],
      ['projects-2', 'press RIGHT'],
      [null, 'press B'],
      [null, 'press DOWN'],
      ['experience', 'press A'],
      ['experience-2', 'press RIGHT'],
      [null, 'press B'],
      [null, 'press DOWN'],
      ['contact', 'press A']
    ]

rmSync(raw, { recursive: true, force: true })
mkdirSync(raw, { recursive: true })
const play = Bun.spawnSync(
  [runner, rom, raw, ...TOUR.map(([, step]) => step)],
  { stdout: 'inherit', stderr: 'inherit' }
)
if (play.exitCode !== 0) throw new Error('mGBA run failed')
// Start the output from empty so renamed or removed screens don't linger.
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

/** Draw a raw 240 × 160 RGBA frame into `target` at (x0, y0), SCALE times larger. */
function scaled(rgba: Uint8Array, x0: number, y0: number, target: PNG) {
  for (let y = 0; y < H * SCALE; y++) {
    for (let x = 0; x < W * SCALE; x++) {
      const from = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 4
      const to = ((y0 + y) * target.width + x0 + x) * 4
      target.data.set(rgba.subarray(from, from + 4), to)
    }
  }
}

const shots = TOUR.map(([name], index) => [name, index] as const).filter(
  ([name]) => name !== null
)
// The contact sheet: every named shot in a grid.
const columns = all ? 4 : 3
const gap = 12
/** The opaque dark gray between shots, as RGBA. */
const BACKGROUND = [0x22, 0x22, 0x22, 0xff]
const sheet = new PNG({
  width: columns * (W * SCALE + gap) + gap,
  height: Math.ceil(shots.length / columns) * (H * SCALE + gap) + gap
})
for (let at = 0; at < sheet.data.length; at += 4) sheet.data.set(BACKGROUND, at)
shots.forEach(([name, index], i) => {
  const rgba = new Uint8Array(
    readFileSync(resolve(raw, `${String(index).padStart(2, '0')}.rgba`))
  )
  const png = new PNG({ width: W * SCALE, height: H * SCALE })
  scaled(rgba, 0, 0, png)
  Bun.write(resolve(out, `${name}.png`), PNG.sync.write(png))
  scaled(
    rgba,
    gap + (i % columns) * (W * SCALE + gap),
    gap + Math.floor(i / columns) * (H * SCALE + gap),
    sheet
  )
})
Bun.write(resolve(out, 'tour.png'), PNG.sync.write(sheet))
console.log(`${shots.length} screenshots -> ${out}`)
