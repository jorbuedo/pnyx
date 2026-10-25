import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {base64, utf8} from '@pnyx/crypto'
import {Either} from 'effect'
import {describe, expect, it} from 'vitest'

import {PNYX_LOGO_SVG, PNYX_WALLET_ICON_DATA_URI} from './wallet-icon'

const ASSET_PATH = join(dirname(new URL(import.meta.url).pathname), '../../../assets/icons/PnyxLogo.svg')

describe('PNYX_LOGO_SVG', () => {
  // The inlined copy exists because neither the app nor the extension build can
  // read the asset at the point it is needed. This is the guard that keeps the
  // copy honest: update the asset, update the constant.
  it('matches assets/icons/PnyxLogo.svg byte for byte', () => {
    expect(PNYX_LOGO_SVG).toBe(readFileSync(ASSET_PATH, 'utf8'))
  })

  it('carries its own fill so it renders without a tint prop', () => {
    // dApps render this into a bare <img>; a `currentColor` mark would come out invisible.
    expect(PNYX_LOGO_SVG).not.toContain('currentColor')
    expect(PNYX_LOGO_SVG).toContain('#5443D6')
  })

  it('keeps a viewBox so it scales to whatever box the dApp gives it', () => {
    expect(PNYX_LOGO_SVG).toContain('viewBox="0 0 174 175"')
  })
})

describe('PNYX_WALLET_ICON_DATA_URI', () => {
  it('is a base64 image data URI', () => {
    expect(PNYX_WALLET_ICON_DATA_URI.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('decodes back to the logo markup', () => {
    const payload = PNYX_WALLET_ICON_DATA_URI.slice('data:image/svg+xml;base64,'.length)
    const decoded = Either.flatMap(base64.decode(payload), utf8.decode)
    expect(Either.getOrThrow(decoded)).toBe(PNYX_LOGO_SVG)
  })

  it('contains only characters that survive JSON and JS string embedding', () => {
    // The URI is JSON.stringify'd into the injected script; base64 + the data:
    // prefix must not introduce quotes, backslashes or angle brackets.
    expect(PNYX_WALLET_ICON_DATA_URI).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/)
  })

  it('stays small enough to inline on every page load', () => {
    // Injected before content load into every tab — a bloated icon is a tax on
    // every navigation, so keep it well under 4 KB.
    expect(PNYX_WALLET_ICON_DATA_URI.length).toBeLessThan(4096)
  })
})
