#!/usr/bin/env bun
/**
 * Generate the cartridge's view from content/site.json.
 *
 * Every screen is pre-rendered: the GBA host bakes each <Show> branch of the
 * "Screen" layer into sprite tiles and swaps them when `page()` changes. The
 * generator lays each page out in absolute pixels on an 8 × 8 font grid,
 * wraps and fits the copy, and writes:
 *
 *   app/pages.ts   page index constants the model (app/app.ts) navigates by
 *   app/app.tsx    the view: chrome, input handlers and one branch per page
 *
 * Edit this file (or content/), not the generated ones.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PALETTE } from "../art/palette.ts";

const root = resolve(import.meta.dir, "..");
const site = JSON.parse(readFileSync(resolve(root, "content/site.json"), "utf8"));
const overridesPath = resolve(root, "content/overrides.json");
const overrides: { projects?: Record<string, { title?: string; description?: string }>; experience?: Record<string, { description?: string }> } =
  existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};

// Screen geometry, in screen pixels. The Screen layer's rect starts at PANEL;
// page content stays inside [LEFT, RIGHT) so the baked crop is 224 × 128.
const PANEL = { x: 8, y: 16, w: 224, h: 144 };
const LEFT = 16, RIGHT = 224, COLUMNS = (RIGHT - LEFT) / 8;
// BODY_BOTTOM is the lowest top a body line may have: 8 px of glyph and a
// 2 px gap above the footer rule at FOOTER_Y - 4.
const HEADING_Y = 26, BODY_Y = 44, FOOTER_Y = 145, BODY_BOTTOM = FOOTER_Y - 4 - 10;
const PITCH = 9;

const COLOR = {
  text: PALETTE.c, heading: PALETTE["4"], accent: PALETTE.b, dim: PALETTE.d, select: PALETTE["9"], rule: PALETTE.e,
};

// ---------------------------------------------------------------------------
// Copy fitting. Press Start 2P is monospaced: every glyph advances 8 px at 1×.

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** As many whole sentences as fit; otherwise the first sentence cut at a word with "...". */
function fit(text: string, width: number, maxLines: number): string[] {
  // A sentence ends at . ! or ? followed by a space, so "Express.js" stays whole.
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let best: string[] = [];
  for (let count = 1; count <= sentences.length; count++) {
    const lines = wrap(sentences.slice(0, count).join(" "), width);
    if (lines.length > maxLines) break;
    best = lines;
  }
  if (best.length) return best;
  const lines = wrap(sentences[0]!, width).slice(0, maxLines);
  let last = lines[maxLines - 1]!;
  while (last.length + 3 > width || /[,;:\s]$/.test(last)) last = last.includes(" ") ? last.slice(0, last.lastIndexOf(" ")) : last.slice(0, width - 3);
  lines[maxLines - 1] = last.replace(/[,;:.]$/, "") + "...";
  return lines;
}

/** Left text and right text on one monospaced line. */
function spread(left: string, right: string, width = COLUMNS): string {
  return left + " ".repeat(Math.max(1, width - left.length - right.length)) + right;
}

const center = (text: string, scale = 1) => Math.round((240 - text.length * 8 * scale) / 2);

// ---------------------------------------------------------------------------
// Page elements. Coordinates are screen pixels; emit() makes them relative to
// the Screen layer.

type Element =
  | { kind: "text"; x: number; y: number; text: string; color: string; scale?: 1 | 2 | 3 }
  | { kind: "image"; x: number; y: number; w: number; h: number; src: string }
  | { kind: "box"; x: number; y: number; w: number; h: number; color: string };

interface Page { name: string; elements: Element[] }

const SIZE = { 1: "text-xs", 2: "text-base font-bold", 3: "text-2xl font-bold" } as const;

function emit(element: Element): string {
  const at = `absolute left-[${element.x - PANEL.x}] top-[${element.y - PANEL.y}]`;
  switch (element.kind) {
    case "text": {
      // Branch roots need a constant size; a monospaced line's is known.
      const scale = element.scale ?? 1;
      return `<Text class="${at} w-[${element.text.length * 8 * scale}] h-[${8 * scale}] ${SIZE[scale]} text-[${element.color}]">{${JSON.stringify(element.text)}}</Text>`;
    }
    case "image": return `<Image class="${at} w-[${element.w}] h-[${element.h}]" src="${element.src}" />`;
    case "box": return `<View class="${at} w-[${element.w}] h-[${element.h}] bg-[${element.color}]" />`;
  }
}

const text = (x: number, y: number, value: string, color: string = COLOR.text, scale: 1 | 2 | 3 = 1): Element => ({ kind: "text", x, y, text: value, color, scale });
const rule = (y: number): Element => ({ kind: "box", x: LEFT, y, w: RIGHT - LEFT, h: 1, color: COLOR.rule });
const lines = (x: number, y: number, values: string[], color: string = COLOR.text): Element[] => values.map((value, i) => text(x, y + i * PITCH, value, color));
const rows = (top: number) => Math.floor((BODY_BOTTOM - top) / PITCH) + 1;

/**
 * A content page: the heading comes first, because the presenter recognizes
 * the mounted branch by its first element, so each heading must be unique.
 */
function framed(heading: string, counter: string, body: Element[], footer = "<> MORE      B: MENU"): Element[] {
  return [text(LEFT, HEADING_Y, spread(heading, counter), COLOR.heading), rule(HEADING_Y + 11), ...body, rule(FOOTER_Y - 4), text(LEFT, FOOTER_Y, footer, COLOR.dim)];
}

const counter = (index: number, count: number) => `${String(index + 1).padStart(String(count).length, "0")}/${count}`;

// ---------------------------------------------------------------------------
// Pages.

const pages: Page[] = [];
const add = (name: string, elements: Element[]) => { pages.push({ name, elements }); return pages.length - 1; };

// The title is the home page's hero: the portrait over the name. The header
// bar already says dval.dev.
const TITLE = add("title", [
  text(center("PRESS START"), FOOTER_Y, "PRESS START", COLOR.heading),
  { kind: "image", x: 120 - 32, y: HEADING_Y, w: 64, h: 64, src: site.portrait },
  text(center(site.name.toUpperCase(), 2), 97, site.name.toUpperCase(), COLOR.text, 2),
  { kind: "box", x: center(site.name.toUpperCase(), 2), y: 115, w: site.name.length * 16, h: 2, color: COLOR.accent },
  text(center("SOFTWARE ENGINEER"), 123, "SOFTWARE ENGINEER", COLOR.accent),
]);

const SECTIONS = [
  { label: "ABOUT", icon: "icon-about.png", caption: "Who I am, what I value" },
  { label: "PROJECTS", icon: "icon-projects.png", caption: "Things I've built" },
  { label: "EXPERIENCE", icon: "icon-experience.png", caption: "Where I've worked" },
  { label: "CONTACT", icon: "icon-contact.png", caption: "Say hello" },
];
const MENU = pages.length;
SECTIONS.forEach((_, selected) => {
  const items = SECTIONS.flatMap((section, i) => {
    const y = BODY_Y + 2 + i * 22, on = i === selected;
    return [
      ...(on ? [{ kind: "box", x: LEFT, y: y - 2, w: RIGHT - LEFT, h: 20, color: COLOR.select } as Element, text(LEFT + 4, y + 4, ">", COLOR.heading)] : []),
      { kind: "image", x: LEFT + 20, y, w: 16, h: 16, src: section.icon } as Element,
      text(LEFT + 44, y + 4, section.label, on ? COLOR.heading : COLOR.text),
    ];
  });
  // The caption is the first element: it is what differs between menu pages.
  add(`menu-${selected}`, [
    text(LEFT, FOOTER_Y, SECTIONS[selected]!.caption, COLOR.dim),
    text(LEFT, HEADING_Y, "MAIN MENU", COLOR.heading), rule(HEADING_Y + 11), ...items, rule(FOOTER_Y - 4),
  ]);
});

const aboutCount = 1 + site.principles.length;
const ABOUT = add("about-intro", framed("ABOUT", counter(0, aboutCount), [
  text(LEFT, BODY_Y, "Hi, my name is", COLOR.dim),
  text(LEFT, BODY_Y + 12, site.name.toUpperCase(), COLOR.text, 2),
  ...lines(LEFT, BODY_Y + 36, fit(site.intro, COLUMNS, rows(BODY_Y + 36))),
]));
const ICONS: Record<string, string> = { Performance: "icon-performance.png", Accessibility: "icon-accessibility.png", Privacy: "icon-privacy.png" };
site.principles.forEach((principle: { title: string; text: string }, i: number) => {
  add(`about-${principle.title.toLowerCase()}`, framed("ABOUT", counter(i + 1, aboutCount), [
    { kind: "image", x: LEFT, y: BODY_Y, w: 16, h: 16, src: ICONS[principle.title] ?? "icon-about.png" },
    text(LEFT + 24, BODY_Y + 4, principle.title.toUpperCase(), COLOR.heading),
    ...lines(LEFT, BODY_Y + 24, fit(principle.text, COLUMNS, rows(BODY_Y + 24))),
  ]));
});

const PROJECTS = pages.length;
site.projects.forEach((project: { slug: string; title: string; company: string | null; tag: string; description: string; image: string }, i: number) => {
  const override = overrides.projects?.[project.slug] ?? {};
  const textLeft = LEFT + 40, width = (RIGHT - textLeft) / 8;
  const title = fit(override.title ?? project.title, width, 2);
  const meta = project.tag === "personal" ? "Personal project" : project.company ?? "Professional";
  const top = BODY_Y + 40;
  add(`project-${project.slug}`, framed("PROJECTS", counter(i, site.projects.length), [
    { kind: "image", x: LEFT, y: BODY_Y, w: 32, h: 32, src: project.image },
    ...lines(textLeft, BODY_Y + 2, title),
    text(textLeft, BODY_Y + 2 + title.length * PITCH + 3, meta.slice(0, width), COLOR.accent),
    ...lines(LEFT, top, fit(override.description ?? project.description, COLUMNS, rows(top))),
  ]));
});

const EXPERIENCE = pages.length;
site.experience.forEach((role: { title: string; at: string; start: string; end: string; description: string }, i: number) => {
  const title = fit(role.title, COLUMNS, 2);
  let y = BODY_Y;
  const body: Element[] = [...lines(LEFT, y, title, COLOR.heading)];
  y += title.length * PITCH + 2;
  body.push(text(LEFT, y, `@ ${role.at}`.slice(0, COLUMNS), COLOR.accent));
  y += PITCH + 1;
  body.push(text(LEFT, y, `${role.start} - ${role.end}`, COLOR.dim));
  y += PITCH + 6;
  body.push(...lines(LEFT, y, fit(overrides.experience?.[role.at]?.description ?? role.description, COLUMNS, rows(y))));
  add(`experience-${i}`, framed("EXPERIENCE", counter(i, site.experience.length), body));
});

const qrSize = 64, qrRight = LEFT + qrSize + 8, side = Math.floor((RIGHT - qrRight) / 8);
const [user, domain] = site.contact.email.split("@");
const CONTACT = add("contact", framed("CONTACT", "", [
  { kind: "image", x: LEFT, y: BODY_Y, w: qrSize, h: qrSize, src: "contact-qr.png" },
  text(qrRight, BODY_Y + 2, "EMAIL", COLOR.dim),
  text(qrRight, BODY_Y + 12, user.slice(0, side)),
  text(qrRight, BODY_Y + 21, `@${domain}`.slice(0, side)),
  text(qrRight, BODY_Y + 36, "GITHUB", COLOR.dim),
  ...lines(qrRight, BODY_Y + 46, wrap(site.contact.github.replace("/", "/ "), side).map(line => line.replace("/ ", "/"))),
  text(qrRight, BODY_Y + 70, "SCAN FOR", COLOR.dim),
  text(qrRight, BODY_Y + 79, site.contact.url.replace(/^https?:\/\//, "").slice(0, side), COLOR.accent),
], "B: MENU"));

// ---------------------------------------------------------------------------
// Checks the cartridge relies on.

const firsts = new Set<string>();
for (const page of pages) {
  const first = page.elements[0]!;
  if (first.kind !== "text") throw new Error(`${page.name}: the first element must be text`);
  if (firsts.has(first.text)) throw new Error(`${page.name}: first text "${first.text}" repeats another page's; the presenter could not tell them apart`);
  firsts.add(first.text);
  for (const element of page.elements) {
    const w = element.kind === "text" ? element.text.length * 8 * (element.scale ?? 1) : element.w;
    const h = element.kind === "text" ? 8 * (element.scale ?? 1) : element.h;
    if (element.x < LEFT || element.x + w > RIGHT || element.y < HEADING_Y || element.y + h > FOOTER_Y + 8)
      throw new Error(`${page.name}: ${JSON.stringify(element)} leaves the ${RIGHT - LEFT} x ${FOOTER_Y + 8 - HEADING_Y} content area`);
  }
}

// ---------------------------------------------------------------------------
// Output.

const header = "// Generated by scripts/gen-app.ts from content/site.json. Do not edit.\n";
writeFileSync(resolve(root, "app/pages.ts"), header + `import type { i32 } from "@pocketjs/framework/solid/std";

export const TITLE: i32 = ${TITLE};
export const MENU: i32 = ${MENU};
export const SECTIONS: i32 = ${SECTIONS.length};
export const ABOUT: i32 = ${ABOUT};
export const ABOUT_PAGES: i32 = ${aboutCount};
export const PROJECTS: i32 = ${PROJECTS};
export const PROJECT_PAGES: i32 = ${site.projects.length};
export const EXPERIENCE: i32 = ${EXPERIENCE};
export const EXPERIENCE_PAGES: i32 = ${site.experience.length};
export const CONTACT: i32 = ${CONTACT};
export const CONTACT_PAGES: i32 = 1;
`);

const branches = pages.map((page, index) => `        {/* ${page.name} */}
        <Show when={page() === ${index}}>
          ${page.elements.map(emit).join("\n          ")}
        </Show>`).join("\n");

writeFileSync(resolve(root, "app/app.tsx"), header + `import { Show } from "solid-js";
import { ActionHandler, Image, Text, View } from "@pocketjs/framework/solid/components";
import { onMount } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { back, beat, confirm, down, next, page, previous, start, up } from "./app";

export default function App() {
  onMount(start);
  return (
    <View debugName="Cartridge" class="w-full h-full layout-baked bg-[${PALETTE["0"]}]">
      <ActionHandler button={BTN.CIRCLE} onPress={confirm} />
      <ActionHandler button={BTN.START} onPress={confirm} />
      <ActionHandler button={BTN.CROSS} onPress={back} />
      <ActionHandler button={BTN.UP} onPress={up} />
      <ActionHandler button={BTN.DOWN} onPress={down} />
      <ActionHandler button={BTN.RIGHT} onPress={next} />
      <ActionHandler button={BTN.RTRIGGER} onPress={next} />
      <ActionHandler button={BTN.LEFT} onPress={previous} />
      <ActionHandler button={BTN.LTRIGGER} onPress={previous} />
      <View class="absolute left-0 top-0 w-[240] h-[16] bg-[${PALETTE["8"]}]" />
      <Text class="absolute left-[8] top-[4] text-xs text-[${PALETTE.c}]">{"dval.dev"}</Text>
      <View class="absolute left-[4] top-[18] w-[232] h-[140] bg-[${PALETTE.c}]" />
      <View class="absolute left-[6] top-[20] w-[228] h-[136] bg-[${PALETTE["0"]}]" />
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
`);
console.log(`app/app.tsx: ${pages.length} pages`);
