import {describe, expect, it} from 'vitest'
import {
  authorityNativeScripts,
  authorityPlanFields,
  authorityScriptContexts,
  authorityStakeContext,
  KEY_AUTHORITY,
  type ScriptIndexAuthority,
  type ScriptStakeAuthority,
  type SpendAuthority,
} from './account'

const at = (over: Partial<ScriptIndexAuthority> = {}): ScriptIndexAuthority => ({
  keyIndex: 0,
  scriptHashHex: 'cc'.repeat(28),
  nativeScriptHex: '8201',
  signerKeyHashes: ['aa'.repeat(28), 'bb'.repeat(28)],
  requiredSigners: 2,
  ...over,
})

const stakeAuthority = (over: Partial<ScriptStakeAuthority> = {}): ScriptStakeAuthority => ({
  scriptHashHex: 'dd'.repeat(28),
  nativeScriptHex: '8202',
  signerKeyHashes: ['11'.repeat(28), '22'.repeat(28)],
  requiredSigners: 2,
  ...over,
})

const script = (over: Partial<Extract<SpendAuthority, {kind: 'script'}>> = {}): SpendAuthority => ({
  kind: 'script',
  indexes: [at()],
  stake: stakeAuthority(),
  validity: {invalidBefore: null, invalidHereafter: null},
  signingGroupId: 'group-home',
  ...over,
})

describe('authorityPlanFields — key wallets', () => {
  it('contributes nothing, so an ordinary plan is byte-identical to before', () => {
    expect(authorityPlanFields(KEY_AUTHORITY)).toEqual({extraSigners: 0})
  })

  it('omits nativeScripts entirely rather than passing an empty array', () => {
    // An empty `nativeScripts` is not the same as absent to the builder.
    expect('nativeScripts' in authorityPlanFields(KEY_AUTHORITY)).toBe(false)
  })
})

describe('authorityPlanFields — script wallets', () => {
  it('carries the native scripts every spend must witness', () => {
    expect(authorityPlanFields(script()).nativeScripts).toEqual(['8201'])
  })

  it('budgets the quorum beyond the one witness a build already assumes', () => {
    // A 2-of-3 costs two witnesses' worth of bytes; the caller's own count
    // covers the first, so the authority adds the rest.
    expect(authorityPlanFields(script({indexes: [at({requiredSigners: 3})]})).extraSigners).toBe(2)
    expect(authorityPlanFields(script({indexes: [at({requiredSigners: 1})]})).extraSigners).toBe(0)
  })

  it('never asks for a negative budget', () => {
    expect(authorityPlanFields(script({indexes: [at({requiredSigners: 0})]})).extraSigners).toBe(0)
  })

  it('sets a ttl from an upper time-lock bound', () => {
    // Without it a time-locked script fails phase-1 whenever it is submitted.
    const fields = authorityPlanFields(script({validity: {invalidBefore: null, invalidHereafter: 900n}}))
    expect(fields.ttl).toBe(900)
  })

  it('omits the ttl when the template sets no upper bound', () => {
    expect('ttl' in authorityPlanFields(script())).toBe(false)
  })

  it('leaves the delegation script out — a spend that carries it is invalid', () => {
    // ExtraneousScriptWitnessesUTXOW: the ledger requires the witness set to hold
    // exactly the scripts the transaction needs, so an unused one is a rejection,
    // not merely wasted bytes. Only a certificate or a withdrawal may bring it.
    expect(authorityPlanFields(script()).nativeScripts).not.toContain('8202')
  })

  it('leaves the delegation quorum out of the spend budget', () => {
    // Sizing a plain send for the stake quorum too would overpay every fee.
    expect(authorityPlanFields(script({stake: stakeAuthority({requiredSigners: 5})})).extraSigners).toBe(1)
  })
})

describe('authorityStakeContext', () => {
  it('has nothing to say about a key wallet', () => {
    expect(authorityStakeContext(KEY_AUTHORITY)).toBeUndefined()
  })

  it('hands back the delegation script, its leaves and its quorum', () => {
    expect(authorityStakeContext(script())).toEqual({
      scriptHashHex: 'dd'.repeat(28),
      nativeScriptHex: '8202',
      signerKeyHashes: ['11'.repeat(28), '22'.repeat(28)],
      requiredSigners: 2,
    })
  })

  it('is one script for the account, whatever the payment indexes are', () => {
    // CIP-1854 pins stake keys at role 2 index 0, so a wallet delegates once
    // however many indexes its funds are spread across.
    const spread = script({indexes: [at({keyIndex: 0}), at({keyIndex: 4})]})
    expect(authorityStakeContext(spread)).toEqual(authorityStakeContext(script()))
  })
})

describe('authorityPlanFields — several payment indexes', () => {
  const two = script({
    indexes: [
      at({keyIndex: 0, scriptHashHex: 'c0'.repeat(28), nativeScriptHex: '8200'}),
      at({keyIndex: 3, scriptHashHex: 'c3'.repeat(28), nativeScriptHex: '8203'}),
    ],
  })

  it('carries every index script, since the ledger validates each on its own inputs', () => {
    // Missing one fails phase-1 for the half of the inputs it guards.
    expect(authorityPlanFields(two).nativeScripts).toEqual(['8200', '8203'])
  })

  it('budgets a quorum per index, not one for the transaction', () => {
    // Two indexes of a 2-of-3 carry four witnesses by the time they can be
    // submitted. Sizing for two leaves the fee short exactly when the last
    // co-signer signs — the failure arrives after every human step is done.
    expect(authorityPlanFields(two).extraSigners).toBe(3)
  })
})

describe('authorityNativeScripts', () => {
  it('is empty for a key wallet', () => {
    expect(authorityNativeScripts(KEY_AUTHORITY)).toEqual([])
  })
})

describe('authorityScriptContexts', () => {
  it('is absent for a key wallet — its addresses already say who signs', () => {
    expect(authorityScriptContexts(KEY_AUTHORITY)).toBeUndefined()
  })

  it('lists every leaf the script names, including co-signers we cannot sign for', () => {
    // The ones we cannot sign for still matter: they are what the quorum panel
    // shows as outstanding.
    expect(authorityScriptContexts(script())?.[0]?.signerKeyHashes).toEqual(['aa'.repeat(28), 'bb'.repeat(28)])
  })

  it('names the script those leaves belong to, so a spend past it can be refused', () => {
    expect(authorityScriptContexts(script())?.[0]?.scriptHashHex).toBe('cc'.repeat(28))
  })

  it('gives one context per index, each with its own script and leaves', () => {
    // Pairing one index's leaves with another's script hash is the mistake this
    // shape exists to prevent: the witness would be made for a key the script
    // guarding those inputs does not name.
    const contexts = authorityScriptContexts(
      script({
        indexes: [
          at({keyIndex: 0, scriptHashHex: 'c0'.repeat(28), signerKeyHashes: ['a0'.repeat(28)]}),
          at({keyIndex: 3, scriptHashHex: 'c3'.repeat(28), signerKeyHashes: ['a3'.repeat(28)]}),
        ],
      }),
    )
    expect(contexts).toEqual([
      {scriptHashHex: 'c0'.repeat(28), signerKeyHashes: ['a0'.repeat(28)]},
      {scriptHashHex: 'c3'.repeat(28), signerKeyHashes: ['a3'.repeat(28)]},
    ])
  })
})
