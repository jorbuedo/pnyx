import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {AddressHex, KeyHashHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {Scripts} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {requiredFor, statusOf} from './envelope'
import {
  addWitnessTextEnvelope,
  classifyIncoming,
  envelopeFromTxTextEnvelope,
  signersFromInputAddresses,
  signersFromScript,
  toTxTextEnvelope,
  toWitnessTextEnvelopes,
} from './interop'
import {
  parseTextEnvelope,
  serializeTextEnvelope,
  TEXT_ENVELOPE_TX,
  TEXT_ENVELOPE_UNWITNESSED,
  TEXT_ENVELOPE_WITNESS,
  witnessCborHex,
  witnessFromCborHex,
} from './text-envelope'
import type {TxEnvelope} from './types'

const PARAMS: Plan.ProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  coinsPerUtxoByte: 4310n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  maxValueSize: 5000n,
  maxTxSize: 16_384n,
}

const KEY_A = 'aa'.repeat(28)
const KEY_B = 'bb'.repeat(28)
const KEY_C = 'cc'.repeat(28)
const VKEY = '11'.repeat(32)
const SIG = '22'.repeat(64)

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A>)

let scriptHex: string
let bodyHex: string

beforeAll(async () => {
  scriptHex = await run(
    Scripts.nOfK(2n, await Promise.all([KEY_A, KEY_B, KEY_C].map((k) => run(Scripts.pubkey(KeyHashHex(k)))))),
  )
  bodyHex = Plan.buildUnsigned({
    inputs: [],
    mandatoryInputs: [{txHash: TxHashHex('ab'.repeat(32)), index: 0, assets: EvAssets.fromLovelace(10_000_000n)}],
    outputs: [
      {addressHex: AddressHex(`00${'11'.repeat(28)}${'88'.repeat(28)}`), assets: EvAssets.fromLovelace(5_000_000n)},
    ],
    changeAddressHex: AddressHex(`30${'10'.repeat(28)}${'99'.repeat(28)}`),
    params: PARAMS,
    nativeScripts: [scriptHex],
    signerCount: 2,
  }).bodyHex
})

const envelope = (over: Partial<TxEnvelope> = {}): TxEnvelope => ({
  version: 1,
  chainId: 'cardano:preprod',
  createdAt: '2026-08-09T00:00:00.000Z',
  createdBy: 'Duo',
  kind: 'multisig',
  bodyHex,
  nativeScriptHexes: [scriptHex],
  networkId: 0,
  protocolMagic: 1,
  accountIndex: 0,
  keyIndexes: [0],
  signers: [
    {id: 'cosigner#0', name: 'A', keyHashHex: KEY_A, signed: false},
    {id: 'cosigner#1', name: 'B', keyHashHex: KEY_B, signed: false},
    {id: 'cosigner#2', name: 'C', keyHashHex: KEY_C, signed: false},
  ],
  witnesses: [],
  ...over,
})

describe('text envelope format', () => {
  it('round-trips through the on-disk form', () => {
    const written = serializeTextEnvelope({type: TEXT_ENVELOPE_TX, description: 'Ledger Cddl Format', cborHex: 'a100'})
    expect(parseTextEnvelope(written)).toEqual({
      type: TEXT_ENVELOPE_TX,
      description: 'Ledger Cddl Format',
      cborHex: 'a100',
    })
  })

  it('refuses anything without a hex payload, rather than passing bad bytes on', () => {
    expect(parseTextEnvelope('{"type":"Tx ConwayEra","cborHex":"zz"}')).toBeNull()
    expect(parseTextEnvelope('{"type":"Tx ConwayEra","cborHex":"a1b"}')).toBeNull()
    expect(parseTextEnvelope('not json')).toBeNull()
    expect(parseTextEnvelope('{"cborHex":"a100"}')).toBeNull()
  })

  it('round-trips a witness through the shape `transaction assemble` takes', () => {
    expect(witnessFromCborHex(witnessCborHex(VKEY, SIG))).toEqual({vkeyHex: VKEY, sigHex: SIG})
  })

  it('also reads a bare vkey/signature pair, which some tooling exports', () => {
    // `[vkey, sig]` without the leading witness-set key.
    const bare = `82${'5820'}${VKEY}${'5840'}${SIG}`
    expect(witnessFromCborHex(bare)).toEqual({vkeyHex: VKEY, sigHex: SIG})
  })

  it('refuses a witness whose parts are the wrong size', () => {
    expect(witnessFromCborHex(witnessCborHex('11'.repeat(31), SIG))).toBeNull()
  })
})

describe('exporting for other tools', () => {
  it('labels an unsigned transaction the way cardano-cli build does', async () => {
    const text = await run(toTxTextEnvelope(envelope()))
    expect(text.type).toBe(TEXT_ENVELOPE_UNWITNESSED)
    expect(text.description).toBe('Ledger Cddl Format')
  })

  it('labels it a transaction once a signature has been collected', async () => {
    const text = await run(toTxTextEnvelope(envelope({witnesses: [{vkeyHex: VKEY, sigHex: SIG, keyHashHex: KEY_A}]})))
    expect(text.type).toBe(TEXT_ENVELOPE_TX)
  })

  it('exports each collected witness on its own', async () => {
    const witnesses = toWitnessTextEnvelopes(envelope({witnesses: [{vkeyHex: VKEY, sigHex: SIG, keyHashHex: KEY_A}]}))
    expect(witnesses).toHaveLength(1)
    expect(witnesses[0]?.type).toBe(TEXT_ENVELOPE_WITNESS)
    expect(witnessFromCborHex(witnesses[0]?.cborHex ?? '')).toEqual({vkeyHex: VKEY, sigHex: SIG})
  })
})

describe('importing a bare transaction file', () => {
  it('reconstructs a co-signing session from a transaction nobody annotated', async () => {
    const text = await run(toTxTextEnvelope(envelope()))
    const rebuilt = await run(
      envelopeFromTxTextEnvelope({
        cborHex: text.cborHex,
        chainId: 'cardano:preprod',
        createdBy: 'imported',
        createdAt: 'now',
      }),
    )
    expect(rebuilt.bodyHex).toBe(bodyHex)
    expect(rebuilt.nativeScriptHexes).toEqual([scriptHex])
    expect(rebuilt.signers.map((s) => s.keyHashHex)).toEqual([KEY_A, KEY_B, KEY_C])
  })

  it('gets the quorum from the script, so a 2-of-3 file is a 2-of-3 session', async () => {
    const text = await run(toTxTextEnvelope(envelope()))
    const rebuilt = await run(
      envelopeFromTxTextEnvelope({
        cborHex: text.cborHex,
        chainId: 'cardano:preprod',
        createdBy: 'imported',
        createdAt: 'now',
      }),
    )
    expect(requiredFor(rebuilt)).toBe(2)
    expect(statusOf(rebuilt, requiredFor(rebuilt)).total).toBe(3)
  })

  it('refuses a scriptless transaction whose inputs nobody resolved, rather than tracking an empty quorum', async () => {
    const plain = Plan.buildUnsigned({
      inputs: [],
      mandatoryInputs: [{txHash: TxHashHex('cd'.repeat(32)), index: 0, assets: EvAssets.fromLovelace(10_000_000n)}],
      outputs: [
        {
          addressHex: AddressHex(`00${'11'.repeat(28)}${'88'.repeat(28)}`),
          assets: EvAssets.fromLovelace(5_000_000n),
        },
      ],
      changeAddressHex: AddressHex(`00${'22'.repeat(28)}${'88'.repeat(28)}`),
      params: PARAMS,
      signerCount: 1,
    }).bodyHex
    const assembled = await run(
      toTxTextEnvelope(envelope({bodyHex: plain, nativeScriptHexes: []})).pipe(Effect.map((t) => t.cborHex)),
    )
    const result = await Effect.runPromise(
      Effect.either(
        envelopeFromTxTextEnvelope({
          cborHex: assembled,
          chainId: 'cardano:preprod',
          createdBy: 'imported',
          createdAt: 'now',
        }) as Effect.Effect<TxEnvelope, {reason?: string}>,
      ),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left.reason).toBe('no-native-script')
  })

  /**
   * The co-funded case, and the one a `cardano-cli` user actually produces.
   *
   * A scriptless transaction has no script to read a roster out of — its signers are the
   * payment credentials its *inputs* sit on, which the file does not contain. Given those
   * addresses (the caller resolves them against the chain), the import becomes a multiparty
   * session. Proven end to end on preprod: cardano-cli built the body, Pnyx imported and
   * signed one share, cardano-cli witnessed the other and assembled using Pnyx's witness.
   */
  it('builds a multiparty session from a scriptless transaction whose inputs are resolved', async () => {
    const assembled = await run(
      toTxTextEnvelope(envelope({bodyHex, nativeScriptHexes: []})).pipe(Effect.map((t) => t.cborHex)),
    )
    const rebuilt = await run(
      envelopeFromTxTextEnvelope({
        cborHex: assembled,
        chainId: 'cardano:preprod',
        createdBy: 'imported',
        createdAt: 'now',
        inputAddressHexes: [`00${KEY_A}${'88'.repeat(28)}`, `00${KEY_B}${'88'.repeat(28)}`],
      }),
    )
    expect(rebuilt.kind).toBe('multiparty')
    expect(rebuilt.nativeScriptHexes).toEqual([])
    expect(rebuilt.signers.map((s) => s.keyHashHex)).toEqual([KEY_A, KEY_B])
    // Multiparty needs every contributing key; there is no script quorum to relax it.
    expect(requiredFor(rebuilt)).toBe(2)
  })
})

describe('merging a witness file', () => {
  it('takes the signature in and derives its key hash rather than trusting a label', async () => {
    const merged = await run(addWitnessTextEnvelope(envelope(), witnessCborHex(VKEY, SIG)))
    expect(merged.witnesses).toHaveLength(1)
    expect(merged.witnesses[0]?.vkeyHex).toBe(VKEY)
    // The hash is computed from the vkey, so a witness cannot claim to be a
    // signer it is not.
    expect(merged.witnesses[0]?.keyHashHex).toHaveLength(56)
  })

  it('refuses bytes that are not a witness', async () => {
    const result = await Effect.runPromise(
      Effect.either(addWitnessTextEnvelope(envelope(), 'a100') as Effect.Effect<TxEnvelope, {reason?: string}>),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left.reason).toBe('undecodable')
  })
})

describe('classifyIncoming', () => {
  it('tells a transaction file from a witness file', () => {
    expect(
      classifyIncoming(serializeTextEnvelope({type: TEXT_ENVELOPE_TX, description: '', cborHex: 'a100'}))?.kind,
    ).toBe('text-envelope-tx')
    expect(
      classifyIncoming(serializeTextEnvelope({type: TEXT_ENVELOPE_WITNESS, description: '', cborHex: 'a100'}))?.kind,
    ).toBe('text-envelope-witness')
  })

  it('accepts an earlier era, because the shape it selects has not changed', () => {
    expect(classifyIncoming('{"type":"Tx BabbageEra","description":"","cborHex":"a100"}')?.kind).toBe(
      'text-envelope-tx',
    )
  })

  it('is null for our own envelope, so the caller falls through to its own parser', () => {
    expect(classifyIncoming('{"version":1,"bodyHex":"a100"}')).toBeNull()
  })
})

describe('signersFromInputAddresses', () => {
  const KEY_X = 'aa'.repeat(28)
  const KEY_Y = 'bb'.repeat(28)
  const base = (cred: string) => `00${cred}${'88'.repeat(28)}`

  it('names one signer per distinct key the inputs sit on', () => {
    expect(signersFromInputAddresses([base(KEY_X), base(KEY_Y)], new Set()).map((s) => s.keyHashHex)).toEqual([
      KEY_X,
      KEY_Y,
    ])
  })

  // One key owes one witness however many of its coins the transaction spends.
  it('collapses several inputs on one key into a single row', () => {
    expect(signersFromInputAddresses([base(KEY_X), base(KEY_X)], new Set())).toHaveLength(1)
  })

  it('marks a signer whose witness is already in the file', () => {
    const [signer] = signersFromInputAddresses([base(KEY_X)], new Set([KEY_X]))
    expect(signer?.signed).toBe(true)
  })

  // A script credential cannot produce a vkey witness, so it is not a signer.
  it('skips a script payment credential', () => {
    expect(signersFromInputAddresses([`10${KEY_X}${'88'.repeat(28)}`], new Set())).toEqual([])
  })

  it('skips an address it cannot read rather than failing the whole import', () => {
    expect(signersFromInputAddresses(['not-an-address', base(KEY_X)], new Set())).toHaveLength(1)
  })
})

describe('signersFromScript', () => {
  it('marks a signer signed when its key hash is already witnessed', () => {
    const signers = signersFromScript(scriptHex, new Set([KEY_B]))
    expect(signers.map((s) => s.signed)).toEqual([false, true, false])
  })

  it('labels rows by key hash, since the file carries no names', () => {
    const signers = signersFromScript(scriptHex, new Set())
    expect(signers[0]?.name).toContain('…')
    expect(signers[0]?.name.startsWith(KEY_A.slice(0, 8))).toBe(true)
  })
})
