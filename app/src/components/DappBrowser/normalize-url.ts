/**
 * Deciding whether what the user typed is an address to open or words to search.
 *
 * Split out of `DappBrowserScreen` because it is pure and because getting it wrong is invisible: a URL
 * treated as a search silently sends whatever was typed to a third-party search engine, which for
 * something like an internal host or a pasted link with a token in it is a small leak as well as a
 * failure to navigate.
 *
 * @module
 */

import {type BrowserSearchEngine, buildSearchUrl} from '../../services/browser-prefs-storage'

/**
 * The URL to load for `input`, or a search for it.
 *
 * ⚠️ **An explicit scheme is decisive, and it is checked first.** This used to be nested *inside* a
 * `includes('.')` test, so `http://localhost:8765/` — no dot anywhere, since a port is a colon — was
 * sent to a search engine despite plainly being a URL. Anything the user prefixed with `http://` or
 * `https://` is a URL by construction and needs no heuristic.
 *
 * The dot rule then covers the ordinary bare-hostname case (`example.com/x`), and `localhost` is
 * allowed without one because it is a hostname by definition and a dev server is the common reason to
 * type it. Everything else is a search: `note: buy milk` has a colon and no scheme, and must not become
 * a navigation.
 */
export const normalizeUrl = (input: string, engine: BrowserSearchEngine): string => {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.includes(' ')) return buildSearchUrl(engine, trimmed)
  // `localhost`, `localhost:8765`, `localhost/path` — a hostname with no dot to find.
  if (trimmed === 'localhost' || /^localhost[:/]/.test(trimmed)) return `http://${trimmed}`
  if (trimmed.includes('.')) return `https://${trimmed}`
  return buildSearchUrl(engine, trimmed)
}
