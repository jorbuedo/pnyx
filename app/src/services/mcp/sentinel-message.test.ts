// Every sentinel must produce a sentence, because the alternative is an agent showing a person
// "An error has occurred" and retrying. The exhaustiveness is the point: a new sentinel added to the
// connector must fail to compile here rather than fall through to a default.
import {
  ConnectionRequired,
  MidnightAppSecretRequired,
  MidnightBalanceRequired,
  MidnightSignDataRequired,
  MidnightSubmitRequired,
  MidnightTransferRequired,
  type SentinelError,
  SignDataRequired,
  SignTxRequired,
} from '@pnyx/dapp-connector'
import {describe, expect, it} from 'vitest'
import {sentinelMessage} from './sentinel-message'

const ORIGIN = 'mcp://agent'

const all: readonly SentinelError[] = [
  new ConnectionRequired({origin: ORIGIN}),
  new SignTxRequired({txHex: '00', partialSign: false, origin: ORIGIN}),
  new SignDataRequired({addressHex: '00', payloadHex: '00', origin: ORIGIN}),
  new MidnightSignDataRequired({messageHex: '00', data: '00', origin: ORIGIN}),
  new MidnightTransferRequired({outputs: [], payFees: true, submit: false, origin: ORIGIN}),
  new MidnightSubmitRequired({txHex: '00', origin: ORIGIN}),
  new MidnightBalanceRequired({txHex: '00', payFees: true, origin: ORIGIN}),
  new MidnightAppSecretRequired({domain: 'example.com', origin: ORIGIN}),
]

describe('sentinelMessage', () => {
  it('answers every sentinel the connector can raise', () => {
    for (const sentinel of all) {
      const message = sentinelMessage(sentinel)
      expect(message.length, sentinel._tag).toBeGreaterThan(20)
    }
  })

  it('names the origin and the screen for a missing session, so the person knows where to go', () => {
    const message = sentinelMessage(new ConnectionRequired({origin: ORIGIN}))
    expect(message).toContain(ORIGIN)
    expect(message).toContain('serve agents')
  })

  it('tells an agent not to retry what needs a person', () => {
    // A model that reads "refused" retries; one that reads "ask the person" does not. This asserts the
    // distinction survives an edit to the copy.
    expect(sentinelMessage(new SignTxRequired({txHex: '00', partialSign: false, origin: ORIGIN}))).toContain(
      'Ask the person',
    )
  })
})
