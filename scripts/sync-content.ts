#!/usr/bin/env bun
/**
 * Lift the cartridge's content out of a dval.dev checkout:
 *
 *   bun scripts/sync-content.ts [path/to/dval.dev]   (default ../dval.dev)
 *
 * Writes content/site.json, pixelates each project's image into
 * assets/projects/<slug>.png (32 × 32, snapped to the Sweetie 16 palette) and
 * the home page photo into assets/portrait.png (64 × 64, 16 colors of its own).
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
const LOGO = 32, PORTRAIT = 64, PORTRAIT_COLORS = 16;

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

/**
 * The home page avatar as a pixel portrait: the top square of the photo (the
 * site crops it with object-fit: cover, object-position: top), area-averaged
 * to size × size, reduced to its own `colors` with k-means so skin and hair
 * keep their tones, then masked to a circle with a 2 px white ring like the
 * site's border. Colors are rounded to the GBA's 5 bits per channel.
 */
function portrait(source: string, out: string, size: number, colors: number) {
  const image = decode(source), side = Math.min(image.width, image.height), scale = side / size;
  const x0 = (image.width - side) / 2;
  const pixels: number[][] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = Math.floor(y * scale); sy < Math.ceil((y + 1) * scale); sy++) {
      for (let sx = Math.floor(x0 + x * scale); sx < Math.ceil(x0 + (x + 1) * scale); sx++) {
        const at = (sy * image.width + sx) * 4;
        r += image.data[at]!; g += image.data[at + 1]!; b += image.data[at + 2]!; n++;
      }
    }
    pixels.push([r / n, g / n, b / n]);
  }
  // Luma-weighted distance, so the palette spends its colors where eyes notice.
  const distance = (a: number[], b: number[]) => 0.3 * (a[0]! - b[0]!) ** 2 + 0.59 * (a[1]! - b[1]!) ** 2 + 0.11 * (a[2]! - b[2]!) ** 2;
  const closest = (pixel: number[], centers: number[][]) => {
    let best = 0;
    centers.forEach((center, i) => { if (distance(center, pixel) < distance(centers[best]!, pixel)) best = i; });
    return best;
  };
  let centers = Array.from({ length: colors }, (_, i) => pixels[Math.floor((i + 0.5) * pixels.length / colors)]!.slice());
  for (let round = 0; round < 30; round++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const pixel of pixels) {
      const sum = sums[closest(pixel, centers)]!;
      sum[0]! += pixel[0]!; sum[1]! += pixel[1]!; sum[2]! += pixel[2]!; sum[3]!++;
    }
    centers = sums.map((sum, i) => sum[3] ? [sum[0]! / sum[3]!, sum[1]! / sum[3]!, sum[2]! / sum[3]!] : centers[i]!);
  }
  centers = centers.map(center => center.map(channel => Math.min(248, Math.round(channel / 8) * 8)));
  const ring = rgb(PALETTE.c), radius = size / 2;
  const png = new PNG({ width: size, height: size });
  pixels.forEach((pixel, i) => {
    const x = i % size, y = Math.floor(i / size), from = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
    png.data.set(from > radius ? [0, 0, 0, 0] : from > radius - 2 ? [...ring, 255] : [...centers[closest(pixel, centers)]!, 255], i * 4);
  });
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
const avatar = /src="\/([^"]+)"/.exec(readFileSync(resolve(site, "components/Avatar.vue"), "utf8"))?.[1];
if (!avatar) throw new Error("components/Avatar.vue: photo not found");
portrait(resolve(site, "public", avatar), resolve(root, "assets/portrait.png"), PORTRAIT, PORTRAIT_COLORS);

// Contact details from the footer's social links.
const footer = readFileSync(resolve(site, "components/Footer.vue"), "utf8");
const link = (label: string) => new RegExp(`path: '([^']+)',\\s*label: '${label}'`).exec(footer)?.[1] ?? "";
const email = link("Email").replace(/^mailto:/, "");
const github = link("Github").replace(/^https?:\/\//, "");

const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: site }).stdout.toString().trim();
const content = {
  source: { repository: "dvalinotti/dval.dev", commit },
  name: "Dan Valinotti",
  portrait: "portrait.png",
  intro,
  principles,
  projects,
  experience,
  contact: { url: "https://dval.dev/contact", email, github },
};
writeFileSync(resolve(root, "content/site.json"), JSON.stringify(content, null, 2) + "\n");
console.log(`content/site.json: ${projects.length} projects, ${experience.length} roles, ${principles.length} principles (dval.dev ${commit})`);
