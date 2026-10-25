import {Address} from '@pnyx/cardano-core'
import {beforeAll, describe, expect, it} from 'vitest'
import {
  type CustodyProviders,
  custodyOfAddress,
  isFreelySpendable,
  noCustodyKnowledge,
  partitionByCustody,
} from './custody'

const OUR_PAY = '11'.repeat(28)
const OUR_STAKE = '22'.repeat(28)
const SHARED_SCRIPT = '33'.repeat(28)
const PLB = '44'.repeat(28)
const OLD_PLB = '55'.repeat(28)
const UNKNOWN_SCRIPT = '66'.repeat(28)
const FOREIGN_KEY = '77'.repeat(28)

let ourAddress: string
let sharedAddress: string
let smartWallet: string
let oldSmartWallet: string
let escrow: string
let foreignKeyAddress: string

const OWN_KEYS = {sharesOurStake: true, keyOwnership: 'own-keys'} as const
const STAKE_ACCOUNT = {sharesOurStake: true, keyOwnership: 'stake-account'} as const

const providers: CustodyProviders = {
  ownKeyCredentials: new Set([OUR_PAY]),
  sharedWalletScripts: new Map([[SHARED_SCRIPT, 'shared-1']]),
  protocolScripts: new Map([
    [PLB, {protocol: 'cip113' as const}],
    [OLD_PLB, {protocol: 'cip113' as const, generationId: '12637c7c'}],
  ]),
}

beforeAll(() => {
  const t = Address.Network.Testnet
  ourAddress = Address.toBech32Sync(Address.baseHex(t, OUR_PAY, OUR_STAKE))
  sharedAddress = Address.toBech32Sync(Address.baseScriptHex(t, SHARED_SCRIPT, OUR_STAKE))
  smartWallet = Address.toBech32Sync(Address.baseScriptHex(t, PLB, OUR_STAKE))
  oldSmartWallet = Address.toBech32Sync(Address.baseScriptHex(t, OLD_PLB, OUR_STAKE))
  escrow = Address.toBech32Sync(Address.baseScriptHex(t, UNKNOWN_SCRIPT, OUR_STAKE))
  foreignKeyAddress = Address.toBech32Sync(Address.baseHex(t, FOREIGN_KEY, OUR_STAKE))
})

describe('custodyOfAddress', () => {
  it('our own key credential is spendable', () => {
    expect(custodyOfAddress(ourAddress, providers, OWN_KEYS)).toEqual({kind: 'key'})
  })

  it('a shared wallet we hold a roster for is ours, with co-signers', () => {
    expect(custodyOfAddress(sharedAddress, providers, OWN_KEYS)).toEqual({
      kind: 'script-quorum',
      walletId: 'shared-1',
    })
  })

  it('the configured PLB is ours, spendable through its contract', () => {
    // The case the old boolean got wrong in the "excludes what is ours" direction.
    expect(custodyOfAddress(smartWallet, providers, OWN_KEYS)).toEqual({
      kind: 'script-protocol',
      protocol: 'cip113',
    })
  })

  it('a superseded generation is associated and nameable, not spendable', () => {
    expect(custodyOfAddress(oldSmartWallet, providers, OWN_KEYS)).toEqual({
      kind: 'associated',
      reason: {kind: 'prior-generation', protocol: 'cip113', generationId: '12637c7c'},
    })
  })

  it('an unclaimed script under our stake key is associated without a story', () => {
    // A DEX order or a thawing redeem. Ours economically; not ours to move; and deliberately not
    // labelled, because an unattributed script is as likely a multisig as a prior deployment.
    expect(custodyOfAddress(escrow, providers, OWN_KEYS)).toEqual({
      kind: 'associated',
      reason: {kind: 'unrecognised-script'},
    })
  })

  it('a foreign key credential under our stake key is not ours', () => {
    expect(custodyOfAddress(foreignKeyAddress, providers, OWN_KEYS)).toEqual({kind: 'foreign'})
  })

  it('an unclaimed script NOT sharing our stake key is foreign, not associated', () => {
    // Association is what makes an escrow worth showing. Without it there is nothing to show.
    expect(custodyOfAddress(escrow, providers, {sharesOurStake: false, keyOwnership: 'own-keys'})).toEqual({
      kind: 'foreign',
    })
  })

  it('an undecodable address is foreign rather than a guess', () => {
    expect(custodyOfAddress('not-an-address', providers, OWN_KEYS)).toEqual({kind: 'foreign'})
  })

  it('knows nothing without providers, and says so as foreign', () => {
    expect(custodyOfAddress(ourAddress, noCustodyKnowledge, OWN_KEYS)).toEqual({kind: 'foreign'})
  })
})

describe('key ownership modes', () => {
  it('a signing wallet does not own a stranger key sharing its stake credential', () => {
    // What multi-delegation produces. Theirs, not ours.
    expect(custodyOfAddress(foreignKeyAddress, providers, OWN_KEYS)).toEqual({kind: 'foreign'})
  })

  it('watch-only owns any key credential under the stake account', () => {
    // It holds no keys at all, so "a credential we hold" would report an empty wallet. ⚠️ This is
    // the documented limit of watch-only, made explicit rather than implicit.
    expect(custodyOfAddress(foreignKeyAddress, providers, STAKE_ACCOUNT)).toEqual({kind: 'key'})
  })

  it('watch-only still does not own a key credential outside its stake account', () => {
    expect(
      custodyOfAddress(foreignKeyAddress, providers, {sharesOurStake: false, keyOwnership: 'stake-account'}),
    ).toEqual({kind: 'foreign'})
  })

  it('the mode never affects scripts, which are resolved by claim', () => {
    for (const ctx of [OWN_KEYS, STAKE_ACCOUNT]) {
      expect(custodyOfAddress(smartWallet, providers, ctx)).toEqual({
        kind: 'script-protocol',
        protocol: 'cip113',
      })
      expect(custodyOfAddress(escrow, providers, ctx)).toEqual({
        kind: 'associated',
        reason: {kind: 'unrecognised-script'},
      })
    }
  })
})

describe('isFreelySpendable', () => {
  it('admits only our own key', () => {
    // ⚠️ Widening this without making coin selection custody-aware lets a script UTxO be picked to
    // pay a fee on an ordinary send. If this test is edited, `projectSpendable` must change too.
    expect(isFreelySpendable({kind: 'key'})).toBe(true)
    expect(isFreelySpendable({kind: 'script-quorum', walletId: 'x'})).toBe(false)
    expect(isFreelySpendable({kind: 'script-protocol', protocol: 'cip113'})).toBe(false)
    expect(isFreelySpendable({kind: 'associated', reason: {kind: 'unrecognised-script'}})).toBe(false)
    expect(isFreelySpendable({kind: 'foreign'})).toBe(false)
  })
})

describe('partitionByCustody', () => {
  const row = (address: string) => ({txHash: 'aa', index: 0, address})
  const addressOf = (r: {readonly address: string}) => r.address

  it('keeps restricted rows instead of discarding them', () => {
    // The whole reason this replaces a filter: a DEX position must be reportable, not vanish.
    const part = partitionByCustody(
      [row(ourAddress), row(escrow), row(smartWallet), row(foreignKeyAddress)],
      providers,
      OWN_KEYS,
      addressOf,
    )
    expect(part.spendable.map((r) => r.address)).toEqual([ourAddress])
    expect(part.restricted.map((r) => r.custody.kind)).toEqual(['associated', 'script-protocol'])
    expect(part.foreign.map((r) => r.address)).toEqual([foreignKeyAddress])
  })

  it('spendable holds only what the old key-credential filter held', () => {
    // The behaviour-preserving claim of this step: replacing the drop with a partition must not
    // change what coin selection sees.
    const rows = [row(ourAddress), row(sharedAddress), row(smartWallet), row(escrow), row(foreignKeyAddress)]
    const part = partitionByCustody(rows, providers, OWN_KEYS, addressOf)
    expect(part.spendable).toEqual([row(ourAddress)])
  })

  // ⚠️ The "address-less row is foreign" case is GONE, and not because it stopped mattering:
  // the rows are Evolution `UTxO`s now and an address is required on one, so the state the old
  // branch defended against is unrepresentable. Attributing such a row to the account's primary
  // address was how a foreign coin became a spendable one — that risk is now carried by the type
  // rather than by a test.
})
