import {Assets, Bytes, Address as EvAddress, TransactionBody, TxOut} from '@evolution-sdk/evolution'
import {TxHashHex} from '@evolution-sdk/review/Brands'
import {Address, Keys, Tx, Wallet} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {
  addSignature,
  assembleEnvelope,
  constructEnvelope,
  keyIndexesOf,
  networkOfChainId,
  parseEnvelope,
  requiredFor,
  rosterByCoSigner,
  scriptRoleAt,
  serializeEnvelope,
  statusOf,
} from './envelope'
import type {EnvelopeSigner, EnvelopeWitness, ScriptRole} from './types'

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const signer = (id: string, keyHashHex: string): EnvelopeSigner => ({id, name: id, keyHashHex, signed: false})

let bodyHex: string
let witness: EnvelopeWitness

beforeAll(async () => {
  const built = await run(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        0,
      )
      const addr = Address.fromBech32Sync(yield* account.baseAddress(Address.Network.Testnet))
      const input = Tx.inputHex(TxHashHex('11'.repeat(32)), 0n)
      const output = TxOut.toCBORBytes(
        new TxOut.TransactionOutput({
          address: EvAddress.fromHex(addr),
          assets: Assets.fromLovelace(1_000_000n),
          encodingFormat: 'babbage',
        }),
      )
      const body = TransactionBody.toCBORHex(
        TransactionBody.fromEncoded({inputs: [Bytes.fromHex(input)], outputs: [output], fee: 200_000n}),
      )
      const xprv = yield* account.paymentKey()
      const w = yield* Tx.partialSign(body, xprv)
      return {body, witness: {vkeyHex: w.vkeyHex, sigHex: w.sigHex, keyHashHex: yield* Keys.keyHash(w.vkeyHex)}}
    }),
  )
  bodyHex = built.body
  witness = built.witness
})

describe('networkOfChainId', () => {
  it('derives networkId + protocol magic from the canonical id', () => {
    expect(networkOfChainId('cardano:mainnet')).toEqual({networkId: 1, protocolMagic: 764824073})
    expect(networkOfChainId('cardano:preprod')).toEqual({networkId: 0, protocolMagic: 1})
    // Preprod and preview share networkId 0, which is why the envelope is built from a chain
    // id: the old `(networkId, protocolMagic?)` pair defaulted a missing magic to preprod and
    // would have labelled this transaction preprod.
    expect(networkOfChainId('cardano:preview')).toEqual({networkId: 0, protocolMagic: 2})
  })
})

describe('envelope construct / addSignature / status', () => {
  // `all [a, b]`, the two roster keys. A placeholder that is not a script would
  // leave the quorum on the roster fallback and never reach the ledger's own rule.
  const pubkeyScript = (keyHashHex: string) => `8200581c${keyHashHex}`
  const allOfBoth = () => `820182${pubkeyScript(witness.keyHashHex)}${pubkeyScript('ff'.repeat(28))}`

  const base = () =>
    constructEnvelope({
      kind: 'multisig',
      bodyHex,
      nativeScriptHexes: [allOfBoth()],
      chainId: 'cardano:preprod',
      createdBy: 'test',
      createdAt: '2026-07-13T00:00:00Z',
      accountIndex: 0,
      keyIndex: 0,
      signers: [signer('a', witness.keyHashHex), signer('b', 'ff'.repeat(28))],
    })

  it('starts unsigned', () => {
    const env = base()
    const status = statusOf(env, 2)
    expect(status).toMatchObject({signed: 0, required: 2, total: 2, meetsQuorum: false})
  })

  it('addSignature marks the matching signer + is idempotent', () => {
    const env = addSignature(base(), witness)
    expect(env.signers.find((s) => s.id === 'a')?.signed).toBe(true)
    expect(env.signers.find((s) => s.id === 'b')?.signed).toBe(false)
    expect(statusOf(env, 2)).toMatchObject({signed: 1, meetsQuorum: false})
    // idempotent on the same vkey
    expect(addSignature(env, witness).witnesses).toHaveLength(1)
  })

  it('multiparty status requires all signers', () => {
    const mp = {...base(), kind: 'multiparty' as const}
    expect(statusOf(mp, 1).required).toBe(2) // total, not the passed required
  })

  it('serialize → parse round-trips', async () => {
    const env = addSignature(base(), witness)
    const parsed = await run(parseEnvelope(serializeEnvelope(env)))
    expect(parsed.bodyHex).toBe(env.bodyHex)
    expect(parsed.witnesses).toHaveLength(1)
  })

  it('parse rejects non-envelope JSON', async () => {
    const err = await run(Effect.flip(parseEnvelope('{"hello":1}')))
    expect(err._tag).toBe('EnvelopeError')
  })

  // An envelope can come from another tool, which may spell the network CIP-34 style. Accept it
  // on the way in, store one spelling.
  it('parse normalizes a CIP-34 chain id to the canonical form', async () => {
    const foreign = JSON.stringify({...base(), chainId: 'cip34:0-2'})
    const parsed = await run(parseEnvelope(foreign))
    expect(parsed.chainId).toBe('cardano:preview')
  })

  it('parse rejects a chain id it cannot place, rather than carrying it opaquely', async () => {
    // Mislabelling a network is how a preprod transaction gets signed against mainnet keys.
    for (const chainId of ['cip34:0-42', 'cardano:testnet', 'eip155:1', '']) {
      const err = await run(Effect.flip(parseEnvelope(JSON.stringify({...base(), chainId}))))
      expect(err._tag).toBe('EnvelopeError')
    }
    const missing = await run(Effect.flip(parseEnvelope(JSON.stringify({...base(), chainId: undefined}))))
    expect(missing._tag).toBe('EnvelopeError')
  })

  it('assembles a submittable tx once signed', async () => {
    const env = addSignature(base(), witness)
    const signedHex = await run(assembleEnvelope(env))
    expect(signedHex).toContain(bodyHex)
    expect(signedHex).toContain(witness.vkeyHex)
  })
})

describe('a spend across several payment indexes', () => {
  // `all [A]` and `all [B]` — one signature each, compiled so the decoder reads a
  // real rule rather than the roster count fallback.
  const ONE_KEY_SCRIPT_A = `8201818200581c${'a1'.repeat(28).slice(0, 56)}`
  const ONE_KEY_SCRIPT_B = `8201818200581c${'b1'.repeat(28).slice(0, 56)}`

  /**
   * Rows for a 1-of-2 wallet spending indexes 0 and 1 — four rows, because each
   * co-signer owes a witness at each index. `signed` is set on the envelope after
   * construction: `constructEnvelope` recomputes it from the collected witnesses,
   * and this test is about the quorum rule rather than about witness matching.
   */
  const twoIndexes = (signed: {readonly at0?: boolean; readonly at1?: boolean; readonly bothAt0?: boolean} = {}) => {
    const rows: readonly EnvelopeSigner[] = [
      {id: 'alice', name: 'Alice', keyHashHex: 'aa'.repeat(28), signed: signed.at0 === true || signed.bothAt0 === true},
      {id: 'bob', name: 'Bob', keyHashHex: 'bb'.repeat(28), signed: signed.bothAt0 === true},
      {id: 'alice', name: 'Alice', keyHashHex: 'a1'.repeat(28), signed: signed.at1 === true, scriptIndex: 1},
      {id: 'bob', name: 'Bob', keyHashHex: 'b1'.repeat(28), signed: false, scriptIndex: 1},
    ]
    const env = constructEnvelope({
      kind: 'multisig',
      bodyHex,
      nativeScriptHexes: [ONE_KEY_SCRIPT_A, ONE_KEY_SCRIPT_B],
      chainId: 'cardano:preprod',
      createdBy: 'test',
      createdAt: '2026-08-09T00:00:00Z',
      accountIndex: 0,
      keyIndexes: [0, 1],
      signers: rows,
    })
    return {...env, signers: rows}
  }

  it('records every index it spends', () => {
    expect(keyIndexesOf(twoIndexes())).toEqual([0, 1])
  })

  it('sums the requirement across scripts', () => {
    // One signature per script, so two for the transaction.
    expect(requiredFor(twoIndexes())).toBe(2)
  })

  it('is not satisfied by two signatures at the same index', () => {
    // The whole reason the quorum is judged per script. Both of these have two
    // signatures against a requirement of two, and only one of them can be
    // submitted: the other leaves index 1's inputs unauthorised, and the ledger
    // rejects it after every co-signer has done their part.
    const wrong = statusOf(twoIndexes({bothAt0: true}), 2)
    expect(wrong.signed).toBe(2)
    expect(wrong.meetsQuorum).toBe(false)
  })

  it('is satisfied by one signature at each index', () => {
    const right = statusOf(twoIndexes({at0: true, at1: true}), 2)
    expect(right.signed).toBe(2)
    expect(right.meetsQuorum).toBe(true)
  })

  it('falls back to the aggregate count when a script cannot be read', () => {
    // An envelope from another tool whose scripts we cannot decode still has to
    // report something; the roster count is the knowing fallback.
    const opaque = constructEnvelope({
      kind: 'multisig',
      bodyHex,
      nativeScriptHexes: ['zz', 'zz'],
      chainId: 'cardano:preprod',
      createdBy: 'test',
      createdAt: '2026-08-09T00:00:00Z',
      accountIndex: 0,
      signers: [signer('a', 'aa'.repeat(28)), signer('b', 'bb'.repeat(28))],
    })
    expect(requiredFor(opaque)).toBe(2)
  })

  it('reports no derivation for an envelope that never carried one', () => {
    // An imported bare transaction. `null`, not index 0 — signing at a guessed
    // index produces a witness the script does not name.
    const imported = constructEnvelope({
      kind: 'multisig',
      bodyHex,
      nativeScriptHexes: [ONE_KEY_SCRIPT_A],
      chainId: 'cardano:preprod',
      createdBy: 'test',
      createdAt: '2026-08-09T00:00:00Z',
      accountIndex: 0,
      signers: [signer('a', 'aa'.repeat(28))],
    })
    expect(keyIndexesOf(imported)).toBeNull()
  })

  it('shows one row per person, not one per index', () => {
    // The same co-signer appears once per script in the envelope. Rendering the
    // raw rows lists Alice twice with nothing to tell the entries apart — and
    // duplicate React keys with it.
    const roster = rosterByCoSigner(twoIndexes({at0: true}).signers)
    expect(roster.map((r) => r.id)).toEqual(['alice', 'bob'])
    expect(roster[0]).toMatchObject({name: 'Alice', signed: 1, owed: 2})
    expect(roster[1]).toMatchObject({name: 'Bob', signed: 0, owed: 2})
  })

  it('keeps a co-signer marked as us even when only one of their rows says so', () => {
    const rows: readonly EnvelopeSigner[] = [
      {id: 'alice', name: 'Alice', keyHashHex: 'aa'.repeat(28), signed: false, isSelf: true},
      {id: 'alice', name: 'Alice', keyHashHex: 'a1'.repeat(28), signed: false, scriptIndex: 1},
    ]
    expect(rosterByCoSigner(rows)[0]?.isSelf).toBe(true)
  })

  it('reads a legacy scalar keyIndex as the one-index list', async () => {
    // The old shape could only describe one index, so this is lossless rather than
    // a default. A stored envelope from before the change must still be signable.
    const legacy = JSON.stringify({
      version: 1,
      chainId: 'cardano:preprod',
      createdAt: '2026-08-09T00:00:00Z',
      createdBy: 'test',
      kind: 'multisig',
      bodyHex,
      nativeScriptHexes: [ONE_KEY_SCRIPT_A],
      networkId: 0,
      accountIndex: 0,
      keyIndex: 4,
      signers: [signer('a', 'aa'.repeat(28))],
      witnesses: [],
    })
    const parsed = await run(parseEnvelope(legacy))
    expect(keyIndexesOf(parsed)).toEqual([4])
    // And the old spelling does not survive alongside the new one.
    expect('keyIndex' in parsed).toBe(false)
  })
})

describe('a payment script beside a delegation script', () => {
  const ONE_KEY_PAYMENT = `8201818200581c${'a1'.repeat(28).slice(0, 56)}`
  const ONE_KEY_STAKE = `8201818200581c${'e1'.repeat(28).slice(0, 56)}`

  const withRoles = (scriptRoles?: readonly ScriptRole[]) =>
    constructEnvelope({
      kind: 'multisig',
      bodyHex,
      nativeScriptHexes: [ONE_KEY_PAYMENT, ONE_KEY_STAKE],
      chainId: 'cardano:preprod',
      createdBy: 'test',
      createdAt: '2026-08-09T00:00:00Z',
      accountIndex: 0,
      keyIndexes: [0, 0],
      ...(scriptRoles === undefined ? {} : {scriptRoles}),
      signers: [signer('alice', 'a1'.repeat(28)), {...signer('alice', 'e1'.repeat(28)), scriptIndex: 1}],
    })

  it('says which script is which, so each is signed with the right key', () => {
    const env = withRoles(['payment', 'stake'])
    expect(scriptRoleAt(env, 0)).toBe('payment')
    expect(scriptRoleAt(env, 1)).toBe('stake')
  })

  it('reads an envelope with no roles as all payment', () => {
    // Every envelope written before a shared wallet could stake. The default has
    // to be payment: it is what those envelopes meant, and the only direction
    // that cannot mis-derive a key for one of them.
    const env = withRoles(undefined)
    expect('scriptRoles' in env).toBe(false)
    expect(scriptRoleAt(env, 0)).toBe('payment')
    expect(scriptRoleAt(env, 1)).toBe('payment')
  })

  it('does not write an all-payment role list, which would be a new spelling for the default', () => {
    expect('scriptRoles' in withRoles(['payment', 'payment'])).toBe(false)
  })

  it('counts both quorums, because the ledger checks each script separately', () => {
    expect(requiredFor(withRoles(['payment', 'stake']))).toBe(2)
  })

  it('survives a serialize / parse round trip with its roles intact', async () => {
    const parsed = await run(parseEnvelope(serializeEnvelope(withRoles(['payment', 'stake']))))
    expect(parsed.scriptRoles).toEqual(['payment', 'stake'])
  })

  it('refuses a role list that does not line up with the scripts', async () => {
    // Read positionally, so a short list silently makes the last script a payment
    // one — which for a delegation means signing it with the wrong key.
    const broken = JSON.parse(serializeEnvelope(withRoles(['payment', 'stake'])))
    broken.scriptRoles = ['payment']
    const result = await Effect.runPromise(Effect.either(parseEnvelope(JSON.stringify(broken))))
    expect(result._tag).toBe('Left')
  })

  it('refuses a role that is neither', async () => {
    const broken = JSON.parse(serializeEnvelope(withRoles(['payment', 'stake'])))
    broken.scriptRoles = ['payment', 'governance']
    const result = await Effect.runPromise(Effect.either(parseEnvelope(JSON.stringify(broken))))
    expect(result._tag).toBe('Left')
  })
})
