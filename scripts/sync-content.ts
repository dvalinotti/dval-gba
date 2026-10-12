#!/usr/bin/env bun
/**
 * Lift the cartridge's content out of a dval.dev checkout:
 *
 *   bun scripts/sync-content.ts [path/to/dval.dev]   (default ../dval.dev)
 *
 * Writes content/site.json and pixelates each project's image into
 * assets/projects/<slug>.png (32 × 32, snapped to the Sweetie 16 palette).
 * Both are committed, so building the ROM never needs the website checkout.
 * Hand edits belong in content/overrides.json, which this script never touches.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import ts from "typescript";
import { PALETTE, rgb } from "../art/palette.ts";

const root = resolve(import.meta.dir, "..");
const site = resolve(process.argv[2] ?? resolve(root, "../dval.dev"));
if (!existsSync(resolve(site, "content/projects"))) throw new Error(`${site} is not a dval.dev checkout (no content/projects)`);
const LOGO = 32;

/** Collapse markup and whitespace into one line of plain text. */
function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*|__|\*|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#8627;/g, "")
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
}

/** Minimal frontmatter reader: `key: value` lines, quotes stripped. */
function frontmatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error("missing frontmatter");
  const data: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const pair = /^(\w+):\s*(.*)$/.exec(line);
    if (pair) data[pair[1]!] = pair[2]!.trim().replace(/^['"](.*)['"]$/, "$1");
  }
  return { data, body: match[2]! };
}

function decode(path: string): { width: number; height: number; data: Uint8Array } {
  const bytes = readFileSync(path);
  if (/\.jpe?g$/i.test(path)) {
    const image = jpeg.decode(bytes, { useTArray: true });
    return { width: image.width, height: image.height, data: image.data };
  }
  const image = PNG.sync.read(bytes);
  return { width: image.width, height: image.height, data: image.data };
}

const SWATCHES = Object.values(PALETTE).map(rgb);

/** Area-average down to size × size (letterboxed), then snap each pixel to the palette. */
function pixelate(source: string, out: string, size: number) {
  const image = decode(source);
  const scale = Math.max(image.width, image.height) / size;
  const offsetX = (size - image.width / scale) / 2, offsetY = (size - image.height / scale) / 2;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const x0 = (x - offsetX) * scale, y0 = (y - offsetY) * scale;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(image.height, Math.ceil(y0 + scale)); sy++) {
      for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(image.width, Math.ceil(x0 + scale)); sx++) {
        const at = (sy * image.width + sx) * 4, alpha = image.data[at + 3]!;
        r += image.data[at]! * alpha; g += image.data[at + 1]! * alpha; b += image.data[at + 2]! * alpha; a += alpha; n++;
      }
    }
    const at = (y * size + x) * 4;
    if (!n || a / n < 128) { png.data.set([0, 0, 0, 0], at); continue; }
    const color = [r / a, g / a, b / a];
    let best = SWATCHES[0]!, distance = Infinity;
    for (const swatch of SWATCHES) {
      const d = swatch.reduce((sum, channel, i) => sum + (channel - color[i]!) ** 2, 0);
      if (d < distance) { best = swatch; distance = d; }
    }
    png.data.set([...best, 255], at);
  }
  writeFileSync(out, PNG.sync.write(png));
}

// Projects, in the order dval.dev/projects lists them.
const projectDir = resolve(site, "content/projects");
mkdirSync(resolve(root, "assets/projects"), { recursive: true });
const projects = readdirSync(projectDir).filter(file => file.endsWith(".md")).sort().map(file => {
  const { data, body } = frontmatter(readFileSync(resolve(projectDir, file), "utf8"));
  const slug = basename(file, ".md");
  pixelate(resolve(site, "public/img", data.image!), resolve(root, "assets/projects", `${slug}.png`), LOGO);
  return {
    slug, title: data.title!, company: data.company ?? null, tag: data.tag!, position: Number(data.position),
    description: plain(body), image: `projects/${slug}.png`,
  };
}).sort((a, b) => a.position - b.position);

/**
 * Read a JS literal of arrays, objects and plain strings as data. Anything
 * else (calls, identifiers, interpolated templates) is rejected, so syncing
 * never runs code from the checkout.
 */
function literal(node: ts.Node): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map(property => {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        throw new Error(`unsupported property: ${property.getText()}`);
      }
      return [property.name.text, literal(property.initializer)];
    }));
  }
  throw new Error(`unsupported value: ${node.getText()}`);
}

// Experience lives in pages/experience.vue as an array literal.
const experienceSource = readFileSync(resolve(site, "pages/experience.vue"), "utf8");
const expItems = /const expItems: ExpItem\[\] = (\[[\s\S]*?\n\])/.exec(experienceSource)?.[1];
if (!expItems) throw new Error("pages/experience.vue: expItems array not found");
const expression = (ts.createSourceFile("expItems.ts", `(${expItems})`, ts.ScriptTarget.Latest, true).statements[0] as ts.ExpressionStatement).expression;
const experience = (literal(ts.isParenthesizedExpression(expression) ? expression.expression : expression) as { start: string; end: string; title: string; at: string; description: string }[])
  .map(item => ({ title: item.title, at: item.at, start: item.start, end: item.end, description: plain(item.description) }));

// The home page: intro paragraph and the three guiding principles.
const home = readFileSync(resolve(site, "pages/index.vue"), "utf8");
const intro = plain(/<h1[^>]*>([\s\S]*?)<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(home)?.[2] ?? "");
const principles = [...home.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>\s*<p class="sidebar">([\s\S]*?)<\/p>/g)]
  .map(match => ({ title: plain(match[1]!), text: plain(match[2]!) }));
if (!intro || principles.length !== 3) throw new Error("pages/index.vue: intro or principles not found");

// Contact details from the footer's social links.
const footer = readFileSync(resolve(site, "components/Footer.vue"), "utf8");
const link = (label: string) => new RegExp(`path: '([^']+)',\\s*label: '${label}'`).exec(footer)?.[1] ?? "";
const email = link("Email").replace(/^mailto:/, "");
const github = link("Github").replace(/^https?:\/\//, "");

const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: site }).stdout.toString().trim();
const content = {
  source: { repository: "dvalinotti/dval.dev", commit },
  name: "Dan Valinotti",
  intro,
  principles,
  projects,
  experience,
  contact: { url: "https://dval.dev/contact", email, github },
};
writeFileSync(resolve(root, "content/site.json"), JSON.stringify(content, null, 2) + "\n");
console.log(`content/site.json: ${projects.length} projects, ${experience.length} roles, ${principles.length} principles (dval.dev ${commit})`);
