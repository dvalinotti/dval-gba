#!/usr/bin/env bun
/**
 * Lift the cartridge's content out of a dval.dev checkout:
 *
 *   bun scripts/sync-content.ts [path/to/dval.dev]   (default ../dval.dev)
 *
 * Writes content/site.json, pixelates each project's image into
 * assets/projects/<slug>.png (32 × 32, snapped to the Sweetie 16 palette) and
 * the home page photo into assets/portrait.png (64 × 64, 16 colors of its own).
 * All are committed, so building the ROM never needs the website checkout.
 * Hand edits belong in content/overrides.json, which this script never touches.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { basename, resolve } from 'node:path'
import ts from 'typescript'
import { PALETTE, rgb } from '../art/palette.ts'
import type { Principle, Project, Role, Site } from './content.ts'
import {
  decode,
  kmeans,
  lumaDistance,
  nearest,
  resample,
  rgbDistance,
  toGba,
  writePng
} from './pixels.ts'

const root = resolve(import.meta.dir, '..')
const checkout = resolve(process.argv[2] ?? resolve(root, '../dval.dev'))
if (!existsSync(resolve(checkout, 'content/projects'))) {
  throw new Error(
    `${checkout} is not a dval.dev checkout (no content/projects)`
  )
}

/** Project logos are 32 × 32. */
const LOGO = 32
/** Logo pixels less than half covered become transparent. */
const OPAQUE = 128
/** The title portrait is 64 × 64 with a palette of its own. */
const PORTRAIT = 64
const PORTRAIT_COLORS = 16
const KMEANS_ROUNDS = 30
/** Width of the white ring around the portrait, like the site's border. */
const RING = 2
const SWEETIE_16 = Object.values(PALETTE).map(rgb)

const read = (path: string) => readFileSync(resolve(checkout, path), 'utf8')

/** The first capture group of `pattern` in `source`, or an error naming `what`. */
function capture(source: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(source)?.[1]
  if (match === undefined) throw new Error(`${what} not found`)
  return match
}

/** Collapse HTML, Markdown and whitespace into one line of plain text. */
function plain(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*|__|\*|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8627;/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim()
}

/** Minimal frontmatter reader: `key: value` lines, quotes stripped. */
function frontmatter(source: string): {
  data: Record<string, string>
  body: string
} {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source)
  if (!match) throw new Error('missing frontmatter')
  const data: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const pair = /^(\w+):\s*(.*)$/.exec(line)
    if (pair) data[pair[1]] = pair[2].trim().replace(/^['"](.*)['"]$/, '$1')
  }
  return { data, body: match[2] }
}

/**
 * Read a JS literal of arrays, objects and plain strings as data. Anything
 * else (calls, identifiers, interpolated templates) is rejected, so syncing
 * never runs code from the checkout.
 */
function literal(node: ts.Node): unknown {
  if (ts.isParenthesizedExpression(node)) return literal(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal)
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        const named =
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        if (!named) {
          throw new Error(`unsupported property: ${property.getText()}`)
        }
        return [property.name.text, literal(property.initializer)]
      })
    )
  }
  throw new Error(`unsupported value: ${node.getText()}`)
}

/** A square logo, letterboxed and snapped to Sweetie 16 like the UI art. */
function pixelateLogo(source: string, out: string) {
  const image = decode(source)
  const side = Math.max(image.width, image.height)
  const left = (image.width - side) / 2
  const top = (image.height - side) / 2
  const samples = resample(image, LOGO, left, top, side)
  writePng(out, LOGO, LOGO, (x, y) => {
    const { color, alpha } = samples[y * LOGO + x]
    if (alpha < OPAQUE) return null
    return SWEETIE_16[nearest(color, SWEETIE_16, rgbDistance)]
  })
}

/**
 * The home page avatar as a pixel portrait: the top square of the photo (the
 * site crops it with object-fit: cover, object-position: top), reduced to
 * PORTRAIT_COLORS colors of its own so skin and hair keep their tones, and
 * masked to a circle with a white ring.
 */
function pixelatePortrait(source: string, out: string) {
  const image = decode(source)
  const side = Math.min(image.width, image.height)
  const samples = resample(image, PORTRAIT, (image.width - side) / 2, 0, side)
  const colors = samples.map((sample) => sample.color)
  const palette = kmeans(
    colors,
    PORTRAIT_COLORS,
    KMEANS_ROUNDS,
    lumaDistance
  ).map(toGba)
  const ring = rgb(PALETTE.c)
  const radius = PORTRAIT / 2
  writePng(out, PORTRAIT, PORTRAIT, (x, y) => {
    const fromCenter = Math.hypot(x + 0.5 - radius, y + 0.5 - radius)
    if (fromCenter > radius) return null
    if (fromCenter > radius - RING) return ring
    const color = colors[y * PORTRAIT + x]
    return palette[nearest(color, palette, lumaDistance)]
  })
}

// Projects, in the order dval.dev/projects lists them.
mkdirSync(resolve(root, 'assets/projects'), { recursive: true })
const projects: Project[] = readdirSync(resolve(checkout, 'content/projects'))
  .filter((file) => file.endsWith('.md'))
  .sort()
  .map((file) => {
    const { data, body } = frontmatter(read(`content/projects/${file}`))
    const slug = basename(file, '.md')
    pixelateLogo(
      resolve(checkout, 'public/img', data.image),
      resolve(root, 'assets/projects', `${slug}.png`)
    )
    return {
      slug,
      title: data.title,
      company: data.company ?? null,
      tag: data.tag,
      position: Number(data.position),
      description: plain(body),
      image: `projects/${slug}.png`
    }
  })
  .sort((a, b) => a.position - b.position)

// Experience lives in pages/experience.vue as an array literal.
const expItems = capture(
  read('pages/experience.vue'),
  /const expItems: ExpItem\[\] = (\[[\s\S]*?\n\])/,
  'pages/experience.vue: expItems'
)
const statement = ts.createSourceFile(
  'expItems.ts',
  `(${expItems})`,
  ts.ScriptTarget.Latest,
  true
).statements[0] as ts.ExpressionStatement
const experience: Role[] = (literal(statement.expression) as Role[]).map(
  (item) => ({
    title: item.title,
    at: item.at,
    start: item.start,
    end: item.end,
    description: plain(item.description)
  })
)

// The home page: intro paragraph and the three guiding principles.
const home = read('pages/index.vue')
const intro = plain(
  capture(
    home,
    /<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/,
    'pages/index.vue: intro'
  )
)
const principles: Principle[] = [
  ...home.matchAll(
    /<h3[^>]*>([\s\S]*?)<\/h3>\s*<p class="sidebar">([\s\S]*?)<\/p>/g
  )
].map((match) => ({ title: plain(match[1]), text: plain(match[2]) }))
if (principles.length !== 3) {
  throw new Error(
    `pages/index.vue: found ${principles.length} principles, expected 3`
  )
}

// The home page photo.
const avatar = capture(
  read('components/Avatar.vue'),
  /src="\/([^"]+)"/,
  'components/Avatar.vue: photo'
)
pixelatePortrait(
  resolve(checkout, 'public', avatar),
  resolve(root, 'assets/portrait.png')
)

// Contact details from the footer's social links.
const footer = read('components/Footer.vue')
const link = (label: string) =>
  capture(
    footer,
    new RegExp(`path: '([^']+)',\\s*label: '${label}'`),
    `components/Footer.vue: ${label} link`
  )
const email = link('Email').replace(/^mailto:/, '')
const github = link('Github').replace(/^https?:\/\//, '')

const commit = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
  cwd: checkout
})
  .stdout.toString()
  .trim()
const content: Site = {
  source: { repository: 'dvalinotti/dval.dev', commit },
  name: 'Dan Valinotti',
  portrait: 'portrait.png',
  intro,
  principles,
  projects,
  experience,
  contact: { url: 'https://dval.dev/contact', email, github }
}
writeFileSync(
  resolve(root, 'content/site.json'),
  JSON.stringify(content, null, 2) + '\n'
)
console.log(
  `content/site.json: ${projects.length} projects, ${experience.length} roles, ${principles.length} principles (dval.dev ${commit})`
)
