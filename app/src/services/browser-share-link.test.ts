import {describe, expect, it} from 'vitest'
import {inAppShareBody} from './browser-share-link'
import {readLinkAction} from './link-action'

const PAGE = 'https://glacier-redeem.pxkq.uk/redeem?id=7'

describe('inAppShareBody', () => {
  it('wraps an https page as a CIP-0158 browse URI', () => {
    expect(inAppShareBody(PAGE)).toBe(`web+cardano://browse/v1?uri=${encodeURIComponent(PAGE)}`)
  })

  it('carries http as well as https', () => {
    expect(inAppShareBody('http://localhost:3000/')).toContain('web+cardano://browse/v1?uri=')
  })

  // The round trip is the whole point: what the composer sends has to be what the thread cards.
  it('round-trips through readLinkAction as a dApp card naming the host', () => {
    const action = readLinkAction(inAppShareBody(PAGE))
    expect(action).toEqual({kind: 'dapp', url: PAGE, host: 'glacier-redeem.pxkq.uk'})
  })

  // readLinkAction matches the whole trimmed body, so surrounding whitespace is fine and appended
  // prose is not — worth pinning, because "share with a note" would silently stop carding.
  it('still cards with surrounding whitespace, and does not once text is appended', () => {
    expect(readLinkAction(`\n  ${inAppShareBody(PAGE)}  \n`)).not.toBeNull()
    expect(readLinkAction(`look at this ${inAppShareBody(PAGE)}`)).toBeNull()
  })

  // A card link that cannot be parsed back would render as a wall of percent-encoding, so anything
  // the browse authority cannot carry stays a plain string the reader can at least read.
  it('leaves a scheme the browse authority cannot carry as plain text', () => {
    for (const raw of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'pnyx://x/y']) {
      expect(inAppShareBody(raw)).toBe(raw)
    }
  })

  it('leaves something that is not a URL alone', () => {
    expect(inAppShareBody('not a url')).toBe('not a url')
    expect(inAppShareBody('')).toBe('')
  })

  // Query strings and fragments survive intact — a dApp's state is often entirely in them.
  it('preserves query and fragment', () => {
    const deep = 'https://app.example/swap?from=ADA&to=NIGHT#pool-7'
    const action = readLinkAction(inAppShareBody(deep))
    expect(action).toMatchObject({kind: 'dapp', url: deep})
  })
})
