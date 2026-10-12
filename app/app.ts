import { createSignal } from "solid-js";
import { frames, type i32 } from "@pocketjs/framework/solid/std";
import {
  ABOUT, ABOUT_PAGES, CONTACT, CONTACT_PAGES, EXPERIENCE, EXPERIENCE_PAGES, MENU, PROJECTS, PROJECT_PAGES, SECTIONS, TITLE,
} from "./pages";

/** The page on screen: an index into the branches app/app.tsx generates. */
export const [page, setPage] = createSignal<i32>(TITLE);
/** Header heartbeat frame. */
export const [beat, setBeat] = createSignal<i32>(0);

function firstPage(section: i32): i32 {
  if (section === 0) return ABOUT;
  if (section === 1) return PROJECTS;
  if (section === 2) return EXPERIENCE;
  return CONTACT;
}

function pageCount(section: i32): i32 {
  if (section === 0) return ABOUT_PAGES;
  if (section === 1) return PROJECT_PAGES;
  if (section === 2) return EXPERIENCE_PAGES;
  return CONTACT_PAGES;
}

/** The menu section a content page belongs to, or -1 on the title and menu. */
function sectionOf(current: i32): i32 {
  if (current >= CONTACT) return 3;
  if (current >= EXPERIENCE) return 2;
  if (current >= PROJECTS) return 1;
  if (current >= ABOUT) return 0;
  return -1;
}

function inMenu(current: i32): boolean {
  return current >= MENU && current < MENU + SECTIONS;
}

/** A or START: leave the title screen, or open the selected section. */
export function confirm(): void {
  const current = page();
  if (current === TITLE) setPage(MENU);
  else if (inMenu(current)) setPage(firstPage(current - MENU));
}

/** B: back to the menu, with the section just left still selected. */
export function back(): void {
  const current = page();
  const section = sectionOf(current);
  if (section >= 0) setPage(MENU + section);
  else if (inMenu(current)) setPage(TITLE);
}

export function up(): void {
  const current = page();
  if (inMenu(current)) setPage(current === MENU ? MENU + SECTIONS - 1 : current - 1);
}

export function down(): void {
  const current = page();
  if (inMenu(current)) setPage(current === MENU + SECTIONS - 1 ? MENU : current + 1);
}

/** Right or R: the next page of the open section, wrapping around. */
export function next(): void {
  const current = page();
  const section = sectionOf(current);
  if (section < 0) return;
  const first = firstPage(section);
  setPage(first + (current - first + 1) % pageCount(section));
}

/** Left or L: the previous page of the open section, wrapping around. */
export function previous(): void {
  const current = page();
  const section = sectionOf(current);
  if (section < 0) return;
  const first = firstPage(section);
  const count = pageCount(section);
  setPage(first + (current - first + count - 1) % count);
}

// MicroTS tasks use bounded loops. This bound covers over two years at 30 Hz;
// each iteration suspends, so the host does no work while the wait is pending.
async function pulse(): Promise<void> {
  for (let step: i32 = 0; step < 2147483647; step++) {
    await frames(12);
    setBeat(1 - beat());
  }
}

export function start(): void {
  pulse();
}
