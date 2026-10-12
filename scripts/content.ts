/**
 * The shape of the cartridge's content: content/site.json, which
 * sync-content.ts writes from the website, and content/overrides.json, which
 * holds hand-written copy. gen-app.ts reads both.
 */

export interface Principle {
  title: string
  text: string
}

export interface Project {
  /** The Markdown file's name in dval.dev's content/projects. */
  slug: string
  title: string
  company: string | null
  /** "personal" or "professional". */
  tag: string
  /** Sort order on dval.dev/projects. */
  position: number
  description: string
  /** The pixelated logo, relative to assets/. */
  image: string
}

export interface Role {
  title: string
  /** The company. */
  at: string
  start: string
  end: string
  description: string
}

export interface Site {
  /** The dval.dev commit the content was synced from. */
  source: { repository: string; commit: string }
  name: string
  /** The pixel portrait, relative to assets/. */
  portrait: string
  intro: string
  principles: Principle[]
  projects: Project[]
  experience: Role[]
  contact: { url: string; email: string; github: string }
}

/** Cartridge-only copy, keyed by project slug and by company. */
export interface Overrides {
  projects?: Record<string, { title?: string; description?: string }>
  experience?: Record<string, { description?: string }>
}
