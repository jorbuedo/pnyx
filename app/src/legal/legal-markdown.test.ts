/**
 * Content lint for the legal documents.
 *
 * These are rendered by `src/utils/markdown.tsx`, which supports a deliberately small subset:
 * `#`/`##` headings, single-line `- ` list items, paragraphs (consecutive lines joined with a
 * space), and inline `**bold**`. Prose that strays outside it does not fail to build — it renders
 * wrong, in a legally binding document, and only a person opening the screen would notice.
 *
 * Both bugs below were real, found on 2026-09-13 by the dev lead reading the rendered page:
 * a markdown table came out as pipe soup, and wrapped list items broke the list because the
 * parser's loop is `while (lines[i].startsWith('- '))` — a continuation line indented under a
 * bullet becomes its own paragraph.
 *
 * If the renderer gains a feature, relax the matching rule here in the same change.
 */

import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const DOCS = ['privacy-policy', 'terms-of-service'] as const

const linesOf = (doc: string): string[] => readFileSync(join(__dirname, doc, 'en-US.md'), 'utf8').split('\n')

describe.each(DOCS)('%s/en-US.md renders under the markdown subset', (doc) => {
  const lines = linesOf(doc)

  it('is not empty', () => {
    expect(lines.length).toBeGreaterThan(20)
  })

  it('uses no tables — the renderer has no table block', () => {
    const offenders = lines.filter((l) => l.trim().startsWith('|'))
    expect(offenders).toEqual([])
  })

  it('keeps every list item on one line — a wrapped item silently splits the list', () => {
    const offenders: string[] = []
    lines.forEach((line, i) => {
      if (!line.startsWith('- ')) return
      const next = lines[i + 1]
      // A continuation line is indented and non-empty. The parser cannot see it as part of the item.
      if (next !== undefined && /^\s+\S/.test(next)) offenders.push(line.slice(0, 60))
    })
    expect(offenders).toEqual([])
  })

  it('closes every bold marker, with no asterisk inside', () => {
    // The renderer splits on /(\*\*[^*]+\*\*)/, so an unmatched or nested marker renders literally.
    for (const line of lines) {
      const markers = line.match(/\*\*/g)?.length ?? 0
      expect(markers % 2, `odd number of ** markers: ${line.slice(0, 60)}`).toBe(0)
    }
  })

  it('speaks as Pnyx and names no other entity', () => {
    const text = readFileSync(join(__dirname, doc, 'en-US.md'), 'utf8')
    expect(text).toContain('**Pnyx**')
    expect(text).not.toMatch(/Pxkq Labs/i)
  })

  it('carries no draft marker or unfilled placeholder', () => {
    // A `[bracketed]` span or a DRAFT banner shipped to users is the failure these two guard.
    const text = readFileSync(join(__dirname, doc, 'en-US.md'), 'utf8')
    expect(text).not.toMatch(/\bDRAFT\b|pending legal review/i)
    expect(text).not.toMatch(/\[[^\]]+\]/)
  })

  it('says the app is in open early access', () => {
    expect(readFileSync(join(__dirname, doc, 'en-US.md'), 'utf8')).toContain('open early access')
  })

  it('gives no email address', () => {
    // Support is reached inside the app, not by mail; a mailbox here would be a dead end and
    // would hand phishers a sanctioned-looking address.
    const text = readFileSync(join(__dirname, doc, 'en-US.md'), 'utf8')
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/)
  })
})
