#!/usr/bin/env bun
/**
 * Generate the cartridge's view from content/site.json.
 *
 * Every screen is pre-rendered: the GBA host bakes each <Show> branch of the
 * "Screen" layer into sprite tiles and swaps them when `page()` changes. The
 * generator lays each page out in absolute pixels on an 8 × 8 font grid,
 * wraps and fits the copy, and writes:
 *
 *   app/pages.ts   page index tables the model (app/app.ts) navigates by
 *   app/app.tsx    the view: chrome, input handlers and one branch per page
 *
 * Edit this file (or content/), not the generated ones.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as prettier from 'prettier'
import { PALETTE } from '../art/palette.ts'
import type { Overrides, Site } from './content.ts'

const root = resolve(import.meta.dir, '..')
const site: Site = JSON.parse(
  readFileSync(resolve(root, 'content/site.json'), 'utf8')
)
const overridesPath = resolve(root, 'content/overrides.json')
const overrides: Overrides = existsSync(overridesPath)
  ? JSON.parse(readFileSync(overridesPath, 'utf8'))
  : {}

// ---------------------------------------------------------------------------
// Screen geometry, in screen pixels.

const SCREEN_WIDTH = 240
/** Press Start 2P draws every glyph in an 8 × 8 cell at 1×. */
const GLYPH = 8
/** The Screen layer's rect. Pages are baked relative to its corner. */
const PANEL = { x: 8, y: 16, w: 224, h: 144 }
/** Page content stays inside [LEFT, RIGHT), so the baked crop is 224 × 128. */
const LEFT = 16
const RIGHT = 224
const COLUMNS = (RIGHT - LEFT) / GLYPH
const HEADING_Y = 26
const BODY_Y = 44
const FOOTER_Y = 145
/** The lowest page content may reach: the footer line's bottom edge. */
const CONTENT_BOTTOM = FOOTER_Y + GLYPH
/** Body lines are 8 px of glyph plus 1 px of leading. */
const PITCH = 9
/** The lowest top a body line may have: 2 px above the footer rule. */
const BODY_BOTTOM = FOOTER_Y - 4 - GLYPH - 2

const COLOR = {
  text: PALETTE.c,
  heading: PALETTE['4'],
  accent: PALETTE.b,
  dim: PALETTE.d,
  select: PALETTE['9'],
  rule: PALETTE.e
}

type Scale = 1 | 2 | 3

/** Width in pixels of a monospaced line at `scale`. */
const textWidth = (value: string, scale: Scale = 1) =>
  value.length * GLYPH * scale

/** The x that centers a line on the screen. */
const center = (value: string, scale: Scale = 1) =>
  Math.round((SCREEN_WIDTH - textWidth(value, scale)) / 2)

// ---------------------------------------------------------------------------
// Copy fitting. Widths are in characters, since every glyph is the same width.

/** Greedy word wrap. A word longer than a line is split across lines. */
function wrap(value: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (let word of value.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) {
        lines.push(line)
        line = ''
      }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!line) {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line += ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * As many whole sentences as fit in `maxLines`. If not even the first
 * sentence fits, it is cut at a word boundary and ends with "...".
 */
function fit(value: string, width: number, maxLines: number): string[] {
  // A sentence ends at . ! or ? followed by a space, so "Express.js" stays whole.
  const sentences = value.split(/(?<=[.!?])\s+/).filter(Boolean)
  let best: string[] = []
  for (let count = 1; count <= sentences.length; count++) {
    const lines = wrap(sentences.slice(0, count).join(' '), width)
    if (lines.length > maxLines) break
    best = lines
  }
  if (best.length) return best

  const lines = wrap(sentences[0], width).slice(0, maxLines)
  let last = lines[maxLines - 1]
  // Drop words until "..." fits and the line doesn't end on a separator.
  while (last.length + 3 > width || /[,;:\s]$/.test(last)) {
    last = last.includes(' ')
      ? last.slice(0, last.lastIndexOf(' '))
      : last.slice(0, width - 3)
  }
  lines[maxLines - 1] = last.replace(/[,;:.]$/, '') + '...'
  return lines
}

/** Left text and right text on one line, `width` characters wide. */
function spread(left: string, right: string, width = COLUMNS): string {
  const gap = Math.max(1, width - left.length - right.length)
  return left + ' '.repeat(gap) + right
}

/** "01/13": a page's position in its section, zero-padded to the count. */
function counter(index: number, count: number): string {
  const digits = String(count).length
  return `${String(index + 1).padStart(digits, '0')}/${count}`
}

// ---------------------------------------------------------------------------
// Page elements. Coordinates are screen pixels; emit() makes them relative to
// the Screen layer.

type Element =
  | {
      kind: 'text'
      x: number
      y: number
      text: string
      color: string
      scale: Scale
    }
  | { kind: 'image'; x: number; y: number; w: number; h: number; src: string }
  | { kind: 'box'; x: number; y: number; w: number; h: number; color: string }

interface Page {
  name: string
  elements: Element[]
}

/** Tailwind classes that select each scale's baked font slot (scripts/fonts.ts). */
const FONT_CLASS: Record<Scale, string> = {
  1: 'text-xs',
  2: 'text-base font-bold',
  3: 'text-2xl font-bold'
}

const text = (
  x: number,
  y: number,
  value: string,
  color: string = COLOR.text,
  scale: Scale = 1
): Element => ({ kind: 'text', x, y, text: value, color, scale })

const image = (x: number, y: number, size: number, src: string): Element => ({
  kind: 'image',
  x,
  y,
  w: size,
  h: size,
  src
})

const box = (
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
): Element => ({ kind: 'box', x, y, w, h, color })

/** A 1 px horizontal rule across the content area. */
const rule = (y: number) => box(LEFT, y, RIGHT - LEFT, 1, COLOR.rule)

/** One text element per line, PITCH apart. */
const lines = (
  x: number,
  y: number,
  values: string[],
  color: string = COLOR.text
): Element[] => values.map((value, i) => text(x, y + i * PITCH, value, color))

/** How many body lines fit from `top` down to BODY_BOTTOM. */
const rows = (top: number) => Math.floor((BODY_BOTTOM - top) / PITCH) + 1

/** An element's size in pixels. */
function size(element: Element): { w: number; h: number } {
  if (element.kind !== 'text') return element
  return {
    w: textWidth(element.text, element.scale),
    h: GLYPH * element.scale
  }
}

/** One element as JSX. Branch roots need a constant size, so text gets one. */
function emit(element: Element): string {
  const { w, h } = size(element)
  const at = `absolute left-[${element.x - PANEL.x}] top-[${element.y - PANEL.y}] w-[${w}] h-[${h}]`
  switch (element.kind) {
    case 'text': {
      const classes = `${at} ${FONT_CLASS[element.scale]} text-[${element.color}]`
      return `<Text class="${classes}">{${JSON.stringify(element.text)}}</Text>`
    }
    case 'image':
      return `<Image class="${at}" src="${element.src}" />`
    case 'box':
      return `<View class="${at} bg-[${element.color}]" />`
  }
}

/**
 * A content page. The heading comes first because the presenter recognizes
 * the mounted branch by its first element, so each page's heading line
 * (heading plus counter) must be unique.
 */
function framed(
  heading: string,
  count: string,
  body: Element[],
  footer = '<> MORE      B: MENU'
): Element[] {
  return [
    text(LEFT, HEADING_Y, spread(heading, count), COLOR.heading),
    rule(HEADING_Y + 11),
    ...body,
    rule(FOOTER_Y - 4),
    text(LEFT, FOOTER_Y, footer, COLOR.dim)
  ]
}

// ---------------------------------------------------------------------------
// Pages.

/** The home page's hero: the portrait over the name. The header bar already says dval.dev. */
function titlePage(): Page {
  const name = site.name.toUpperCase()
  const role = 'SOFTWARE ENGINEER'
  const portrait = 64
  return {
    name: 'title',
    elements: [
      text(center('PRESS START'), FOOTER_Y, 'PRESS START', COLOR.heading),
      image((SCREEN_WIDTH - portrait) / 2, HEADING_Y, portrait, site.portrait),
      text(center(name, 2), 97, name, COLOR.text, 2),
      box(center(name, 2), 115, textWidth(name, 2), 2, COLOR.accent),
      text(center(role), 123, role, COLOR.accent)
    ]
  }
}

/** One menu page per section, each with that section highlighted. */
function menuPages(): Page[] {
  return SECTIONS.map((selected, selectedIndex) => {
    const items = SECTIONS.flatMap((section, i): Element[] => {
      const y = BODY_Y + 2 + i * 22
      const on = i === selectedIndex
      const highlight = on
        ? [
            box(LEFT, y - 2, RIGHT - LEFT, 20, COLOR.select),
            text(LEFT + 4, y + 4, '>', COLOR.heading)
          ]
        : []
      return [
        ...highlight,
        image(LEFT + 20, y, 16, section.icon),
        text(LEFT + 44, y + 4, section.label, on ? COLOR.heading : COLOR.text)
      ]
    })
    return {
      name: `menu-${selectedIndex}`,
      // The caption is the first element: it is what differs between menu pages.
      elements: [
        text(LEFT, FOOTER_Y, selected.caption, COLOR.dim),
        text(LEFT, HEADING_Y, 'MAIN MENU', COLOR.heading),
        rule(HEADING_Y + 11),
        ...items,
        rule(FOOTER_Y - 4)
      ]
    }
  })
}

const PRINCIPLE_ICONS: Record<string, string> = {
  Performance: 'icon-performance.png',
  Accessibility: 'icon-accessibility.png',
  Privacy: 'icon-privacy.png'
}

/** The intro, then one page per guiding principle. */
function aboutPages(): Page[] {
  const count = 1 + site.principles.length
  const introTop = BODY_Y + 36
  const intro: Page = {
    name: 'about-intro',
    elements: framed('ABOUT', counter(0, count), [
      text(LEFT, BODY_Y, 'Hi, my name is', COLOR.dim),
      text(LEFT, BODY_Y + 12, site.name.toUpperCase(), COLOR.text, 2),
      ...lines(LEFT, introTop, fit(site.intro, COLUMNS, rows(introTop)))
    ])
  }
  const principles = site.principles.map((principle, i): Page => {
    const top = BODY_Y + 24
    const icon = PRINCIPLE_ICONS[principle.title] ?? 'icon-about.png'
    return {
      name: `about-${principle.title.toLowerCase()}`,
      elements: framed('ABOUT', counter(i + 1, count), [
        image(LEFT, BODY_Y, 16, icon),
        text(
          LEFT + 24,
          BODY_Y + 4,
          principle.title.toUpperCase(),
          COLOR.heading
        ),
        ...lines(LEFT, top, fit(principle.text, COLUMNS, rows(top)))
      ])
    }
  })
  return [intro, ...principles]
}

/** One page per project: logo, title, company, description. */
function projectPages(): Page[] {
  const textLeft = LEFT + 40
  const width = (RIGHT - textLeft) / GLYPH
  const top = BODY_Y + 40
  return site.projects.map((project, i): Page => {
    const override = overrides.projects?.[project.slug] ?? {}
    const title = fit(override.title ?? project.title, width, 2)
    const meta =
      project.tag === 'personal'
        ? 'Personal project'
        : (project.company ?? 'Professional')
    const metaY = BODY_Y + 2 + title.length * PITCH + 3
    const description = override.description ?? project.description
    return {
      name: `project-${project.slug}`,
      elements: framed('PROJECTS', counter(i, site.projects.length), [
        image(LEFT, BODY_Y, 32, project.image),
        ...lines(textLeft, BODY_Y + 2, title),
        text(textLeft, metaY, meta.slice(0, width), COLOR.accent),
        ...lines(LEFT, top, fit(description, COLUMNS, rows(top)))
      ])
    }
  })
}

/** One page per role: title, company, dates, description. */
function experiencePages(): Page[] {
  return site.experience.map((role, i): Page => {
    const title = fit(role.title, COLUMNS, 2)
    const atY = BODY_Y + title.length * PITCH + 2
    const datesY = atY + PITCH + 1
    const top = datesY + PITCH + 6
    const description =
      overrides.experience?.[role.at]?.description ?? role.description
    return {
      name: `experience-${i}`,
      elements: framed('EXPERIENCE', counter(i, site.experience.length), [
        ...lines(LEFT, BODY_Y, title, COLOR.heading),
        text(LEFT, atY, `@ ${role.at}`.slice(0, COLUMNS), COLOR.accent),
        text(LEFT, datesY, `${role.start} - ${role.end}`, COLOR.dim),
        ...lines(LEFT, top, fit(description, COLUMNS, rows(top)))
      ])
    }
  })
}

/** The QR code to dval.dev/contact, with the email and GitHub beside it. */
function contactPages(): Page[] {
  const qrSize = 64
  const x = LEFT + qrSize + 8
  const width = Math.floor((RIGHT - x) / GLYPH)
  const [user, domain] = site.contact.email.split('@')
  // Break the GitHub path after its slash rather than mid-word.
  const github = wrap(site.contact.github.replace('/', '/ '), width).map(
    (line) => line.replace('/ ', '/')
  )
  const url = site.contact.url.replace(/^https?:\/\//, '')
  const body = [
    image(LEFT, BODY_Y, qrSize, 'contact-qr.png'),
    text(x, BODY_Y + 2, 'EMAIL', COLOR.dim),
    text(x, BODY_Y + 12, user.slice(0, width)),
    text(x, BODY_Y + 21, `@${domain}`.slice(0, width)),
    text(x, BODY_Y + 36, 'GITHUB', COLOR.dim),
    ...lines(x, BODY_Y + 46, github),
    text(x, BODY_Y + 70, 'SCAN FOR', COLOR.dim),
    text(x, BODY_Y + 79, url.slice(0, width), COLOR.accent)
  ]
  return [{ name: 'contact', elements: framed('CONTACT', '', body, 'B: MENU') }]
}

/** The main menu, in order. Each section's pages follow the menu pages in this order. */
const SECTIONS = [
  {
    label: 'ABOUT',
    icon: 'icon-about.png',
    caption: 'Who I am, what I value',
    pages: aboutPages
  },
  {
    label: 'PROJECTS',
    icon: 'icon-projects.png',
    caption: "Things I've built",
    pages: projectPages
  },
  {
    label: 'EXPERIENCE',
    icon: 'icon-experience.png',
    caption: "Where I've worked",
    pages: experiencePages
  },
  {
    label: 'CONTACT',
    icon: 'icon-contact.png',
    caption: 'Say hello',
    pages: contactPages
  }
]

// The title, one menu page per section, then every section's pages. The model
// finds sections through SECTION_START and SECTION_PAGES.
const TITLE = 0
const MENU = 1
const pages: Page[] = [titlePage(), ...menuPages()]
const sectionStart: number[] = []
const sectionPages: number[] = []
for (const section of SECTIONS) {
  const built = section.pages()
  sectionStart.push(pages.length)
  sectionPages.push(built.length)
  pages.push(...built)
}

// ---------------------------------------------------------------------------
// Checks the cartridge relies on.

const firsts = new Set<string>()
for (const page of pages) {
  const first = page.elements[0]
  if (first.kind !== 'text') {
    throw new Error(`${page.name}: the first element must be text`)
  }
  if (firsts.has(first.text)) {
    throw new Error(
      `${page.name}: first text "${first.text}" repeats another page's; the presenter could not tell them apart`
    )
  }
  firsts.add(first.text)
  for (const element of page.elements) {
    const { w, h } = size(element)
    const inside =
      element.x >= LEFT &&
      element.x + w <= RIGHT &&
      element.y >= HEADING_Y &&
      element.y + h <= CONTENT_BOTTOM
    if (!inside) {
      throw new Error(
        `${page.name}: ${JSON.stringify(element)} leaves the ${RIGHT - LEFT} x ${CONTENT_BOTTOM - HEADING_Y} content area`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Output, formatted with the repository's Prettier settings.

const header =
  '// Generated by scripts/gen-app.ts from content/site.json. Do not edit.\n'

async function write(path: string, source: string) {
  const file = resolve(root, path)
  const options = await prettier.resolveConfig(file)
  writeFileSync(
    file,
    await prettier.format(header + source, { ...options, filepath: file })
  )
}

await write(
  'app/pages.ts',
  `
/** The title screen. */
export const TITLE = ${TITLE};
/** The first menu page. Page MENU + i is the menu with section i highlighted. */
export const MENU = ${MENU};
/** How many sections the menu lists. */
export const SECTIONS = ${SECTIONS.length};
/** Each section's first page, in menu order (${SECTIONS.map((section) => section.label).join(', ')}). */
export const SECTION_START = ${JSON.stringify(sectionStart)};
/** How many pages each section has, in menu order. */
export const SECTION_PAGES = ${JSON.stringify(sectionPages)};
`
)

const branches = pages
  .map(
    (page, index) => `{/* ${page.name} */}
        <Show when={page() === ${index}}>
          ${page.elements.map(emit).join('\n')}
        </Show>`
  )
  .join('\n')

await write(
  'app/app.tsx',
  `import { Show } from "solid-js";
import { ActionHandler, Image, Text, View } from "@pocketjs/framework/solid/components";
import { onMount } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { back, beat, confirm, down, next, page, previous, start, up } from "./app";

export default function App() {
  onMount(start);
  return (
    <View debugName="Cartridge" class="w-full h-full layout-baked bg-[${PALETTE['0']}]">
      <ActionHandler button={BTN.CIRCLE} onPress={confirm} />
      <ActionHandler button={BTN.START} onPress={confirm} />
      <ActionHandler button={BTN.CROSS} onPress={back} />
      <ActionHandler button={BTN.UP} onPress={up} />
      <ActionHandler button={BTN.DOWN} onPress={down} />
      <ActionHandler button={BTN.RIGHT} onPress={next} />
      <ActionHandler button={BTN.RTRIGGER} onPress={next} />
      <ActionHandler button={BTN.LEFT} onPress={previous} />
      <ActionHandler button={BTN.LTRIGGER} onPress={previous} />
      <View class="absolute left-0 top-0 w-[240] h-[16] bg-[${PALETTE['8']}]" />
      <Text class="absolute left-[8] top-[4] text-xs text-[${PALETTE.c}]">{"dval.dev"}</Text>
      <View class="absolute left-[4] top-[18] w-[232] h-[140] bg-[${PALETTE.c}]" />
      <View class="absolute left-[6] top-[20] w-[228] h-[136] bg-[${PALETTE['0']}]" />
      <View class="absolute left-[7] top-[21] w-[226] h-[134] bg-[${PALETTE.f}]" />
      <View debugName="Beat" class="absolute left-[220] top-0 w-[16] h-[16]">
        <Show when={beat() === 0}><Image class="absolute left-0 top-0 w-[16] h-[16]" src="heart-0.png" /></Show>
        <Show when={beat() === 1}><Image class="absolute left-0 top-0 w-[16] h-[16]" src="heart-1.png" /></Show>
      </View>
      <View debugName="Screen" class="absolute left-[${PANEL.x}] top-[${PANEL.y}] w-[${PANEL.w}] h-[${PANEL.h}]">
        ${branches}
      </View>
    </View>
  );
}
`
)
console.log(`app/app.tsx: ${pages.length} pages`)
