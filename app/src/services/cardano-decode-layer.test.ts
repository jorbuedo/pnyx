import {Decode} from '@evolution-sdk/review/Decode'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {cardanoDecodeLayer} from './cardano-decode-layer'

describe('cardanoDecodeLayer', () => {
  it('decodes through the backend this build drives on, not merely alongside it', () => {
    // ⚠️ A behavioural discriminator, not a tautology. `c24105` is a tag-2 bignum encoding of 5, and
    // it is the one filed divergence between the two backends (D11): Evolution's CBOR reader
    // resolves tag 2/3 inside the decoder and yields a plain int, where pure-TS preserves the
    // bignum form and reports it as one. A plain `05` is identical on both, so this vector
    // discriminates the backend rather than the input.
    //
    // There is no switch to key this off any more: Evolution is the only backend the app builds,
    // so the expected shape is unconditional. A wiring change that reintroduced pure-TS anywhere in
    // this path fails here, which is the point — a test that cannot tell which backend produced the
    // bytes could not have caught the flip not taking effect.
    const decoded = Effect.runSync(
      Effect.flatMap(Decode, (decode) => Effect.sync(() => decode.plutusData('c24105'))).pipe(
        Effect.provide(cardanoDecodeLayer),
      ),
    ) as {readonly type: string}

    expect(decoded.type).toBe('int')
  })
})
