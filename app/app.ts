// The cartridge's model: which page is on screen, and what each button does.
// MicroTS compiles this file to Rust, so it keeps to the subset it supports:
// i32 numbers, named functions and signals (see AGENTS.md).
import { createSignal } from 'solid-js'
import { frames, type i32 } from '@pocketjs/framework/solid/std'
import {
  MENU,
  SECTIONS,
  SECTION_PAGES,
  SECTION_START,
  START,
  TITLE
} from './pages'

/** sectionOf's answer for the title and menu pages. */
const NO_SECTION = -1
/** Frames each heartbeat frame stays up: 12 frames at 30 Hz is 0.4 s. */
const BEAT_FRAMES = 12
/** The largest i32. MicroTS tasks loop with a bound, so this stands in for forever. */
const I32_MAX = 2147483647

/** The page on screen: an index into the branches app/app.tsx generates. */
export const [page, setPage] = createSignal<i32>(START)
/** Which of the header heart's two frames is showing. */
export const [beat, setBeat] = createSignal<i32>(0)

/** The section a content page belongs to, or NO_SECTION. */
function sectionOf(current: i32): i32 {
  for (let section = 0; section < SECTIONS; section++) {
    const first = SECTION_START[section]
    if (current >= first && current < first + SECTION_PAGES[section]) {
      return section
    }
  }
  return NO_SECTION
}

function inMenu(current: i32): boolean {
  return current >= MENU && current < MENU + SECTIONS
}

/** `value` wrapped into 0 .. count - 1, for a step of one either way. */
function cycle(value: i32, count: i32): i32 {
  return (value + count) % count
}

/** Move the menu highlight `delta` sections, wrapping around. */
function moveCursor(delta: i32): void {
  const current = page()
  if (!inMenu(current)) return
  setPage(MENU + cycle(current - MENU + delta, SECTIONS))
}

/** Turn `delta` pages within the open section, wrapping around. */
function turnPage(delta: i32): void {
  const current = page()
  const section = sectionOf(current)
  if (section === NO_SECTION) return
  const first = SECTION_START[section]
  setPage(first + cycle(current - first + delta, SECTION_PAGES[section]))
}

/** A or Start: leave the title screen, or open the highlighted section. */
export function confirm(): void {
  const current = page()
  if (current === TITLE) setPage(MENU)
  else if (inMenu(current)) setPage(SECTION_START[current - MENU])
}

/** B: back to the menu with the section just left highlighted, or from the menu to the title. */
export function back(): void {
  const current = page()
  const section = sectionOf(current)
  if (section !== NO_SECTION) setPage(MENU + section)
  else if (inMenu(current)) setPage(TITLE)
}

export function up(): void {
  moveCursor(-1)
}

export function down(): void {
  moveCursor(1)
}

/** Right or R. */
export function next(): void {
  turnPage(1)
}

/** Left or L. */
export function previous(): void {
  turnPage(-1)
}

/** Flip the header heart every BEAT_FRAMES frames. Each await suspends until then. */
async function pulse(): Promise<void> {
  for (let step: i32 = 0; step < I32_MAX; step++) {
    await frames(BEAT_FRAMES)
    setBeat(1 - beat())
  }
}

/** Runs once when the view mounts. */
export function start(): void {
  pulse()
}
