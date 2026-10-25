import type {AddressGroup, ReviewedOperation, ReviewedTransaction, ReviewedVkeyWitness} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {translations} from '../../i18n/translations'
import {
  hasDeposit,
  requiredSignerSigned,
  reviewHeadline,
  reviewScreenTitleKey,
  reviewTitleKey,
  reviewWarningKeys,
  totalDeposit,
  WARNING_KEY,
  warningKeysForMode,
  willBroadcastOnConfirm,
  witnessRoleKey,
} from './review-model'

const emptyGroup: AddressGroup = {entries: [], deltas: [], parties: []}

const base: ReviewedTransaction = {
  chain: 'cardano',
  fee: 200_000n,
  inputs: [],
  unresolvedInputs: [],
  outputs: [],
  referenceInputs: [],
  metadata: {},
  requiredSigners: [],
  scripts: {native: 0, plutusV1: 0, plutusV2: 0, plutusV3: 0, redeemers: 0, datums: 0},
  ownDelta: [],
  ownGroup: emptyGroup,
  identityGroup: emptyGroup,
  escrowGroup: emptyGroup,
  otherGroup: emptyGroup,
  counterparties: [],
  operations: [],
  warnings: [],
}

const cred = {hashHex: 'aa'.repeat(28), type: 'key'} as const
const withOps = (operations: ReviewedOperation[]): ReviewedTransaction => ({...base, operations})

describe('reviewTitleKey', () => {
  it('defaults to send for a plain transfer', () => {
    expect(reviewTitleKey(base)).toBe('send')
  })

  it('prefers governance proposals over everything', () => {
    expect(
      reviewTitleKey(
        withOps([
          {kind: 'proposal-procedures', proposals: []},
          {kind: 'stake-registration', credential: cred, deposit: 2_000_000n},
        ]),
      ),
    ).toBe('governance')
  })

  it('maps voting to vote', () => {
    expect(reviewTitleKey(withOps([{kind: 'voting-procedures', votes: []}]))).toBe('vote')
  })

  it('maps delegation to delegate, plain stake reg to stake', () => {
    expect(
      reviewTitleKey(withOps([{kind: 'stake-delegation', credential: cred, poolKeyHashHex: 'bb'.repeat(28)}])),
    ).toBe('delegate')
    expect(reviewTitleKey(withOps([{kind: 'stake-registration', credential: cred, deposit: 2_000_000n}]))).toBe('stake')
  })

  it('maps drep/committee ops to governance, vote-delegation to delegate', () => {
    expect(reviewTitleKey(withOps([{kind: 'drep-registration', credential: cred, deposit: 500_000_000n}]))).toBe(
      'governance',
    )
    expect(
      reviewTitleKey(
        withOps([{kind: 'vote-delegation', credential: cred, drep: {type: 'key_hash', keyHashHex: 'cc'.repeat(28)}}]),
      ),
    ).toBe('delegate')
  })

  it('titles a swept reward withdrawal by what the transaction actually did', () => {
    // A withdrawal riding along with a send must not retitle it "Rewards".
    const withdrawal = {kind: 'reward-withdrawal', rewardAddress: {hex: '00'}, amount: 1n, own: true} as const
    const sendWithSweep: ReviewedTransaction = {
      ...withOps([withdrawal]),
      otherGroup: {
        entries: [],
        deltas: [],
        parties: [{ownership: {level: 'none'}, addresses: [{hex: 'ff'}], sent: [], received: [{quantity: 5n}]}],
      },
    }
    expect(reviewTitleKey(sendWithSweep)).toBe('send')

    // …and an operation that rides along with it wins outright.
    expect(reviewTitleKey(withOps([withdrawal, {kind: 'minting', policyIdHex: 'aa', assets: [], burns: false}]))).toBe(
      'mint',
    )
  })

  it('detects withdrawals, mint, burn, and contracts', () => {
    expect(
      reviewTitleKey(withOps([{kind: 'reward-withdrawal', rewardAddress: {hex: '00'}, amount: 1n, own: true}])),
    ).toBe('withdrawRewards')
    expect(reviewTitleKey(withOps([{kind: 'minting', policyIdHex: 'aa', assets: [], burns: false}]))).toBe('mint')
    expect(reviewTitleKey(withOps([{kind: 'minting', policyIdHex: 'aa', assets: [], burns: true}]))).toBe('burn')
    expect(reviewTitleKey(withOps([{kind: 'contract-execution', scriptDataHashHex: 'aa', collateralInputs: 1}]))).toBe(
      'contract',
    )
  })
})

describe('reviewHeadline', () => {
  it('is out for a negative coin delta', () => {
    expect(reviewHeadline({...base, ownDelta: [{quantity: -900_000n}]})).toEqual({
      direction: 'out',
      amounts: [{quantity: -900_000n}],
    })
  })

  it('is in for a positive coin delta', () => {
    expect(reviewHeadline({...base, ownDelta: [{quantity: 500_000n}]}).direction).toBe('in')
  })

  it('is neutral for zero or coin-absent delta', () => {
    expect(reviewHeadline(base).direction).toBe('neutral')
    expect(reviewHeadline({...base, ownDelta: [{assetId: 'aa.bb', quantity: 5n}]}).direction).toBe('neutral')
  })
})

describe('reviewWarningKeys', () => {
  it('maps IR warnings to i18n leaf keys in order', () => {
    expect(reviewWarningKeys({...base, warnings: ['large-fee', 'burning']})).toEqual(['largeFee', 'burning'])
  })

  it('drops plutus-contract and unresolved-inputs: structure, not risk', () => {
    // ⚠️ A NIGHT redeem showed three orange banners, two of which said only "this is a contract
    // call that spends a contract's UTxO" — which is what a redeem IS. Both facts are already on
    // screen: the review is titled "Smart Contract" with Operations and Contracts tabs, and the
    // inputs the wallet could not resolve are listed under their own count in UTxOs. Alarms that
    // fire on the normal case are what make the abnormal one invisible.
    expect(reviewWarningKeys({...base, warnings: ['plutus-contract', 'unresolved-inputs']})).toEqual([])
    expect(reviewWarningKeys({...base, warnings: ['plutus-contract', 'large-fee']})).toEqual(['largeFee'])
  })

  it('drops no-ttl: our builder never sets a TTL, so a banner would fire on every tx', () => {
    // It is stated as an expiry row in the Details tab instead. A warning that is
    // always on is a warning nobody reads.
    expect(reviewWarningKeys({...base, warnings: ['no-ttl']})).toEqual([])
    expect(reviewWarningKeys({...base, warnings: ['no-ttl', 'large-fee']})).toEqual(['largeFee'])
  })

  it('leads with the leaked signing key — everything else is advice, that one is a key already gone', () => {
    expect(reviewWarningKeys({...base, warnings: ['leaked-signing-key', 'large-fee']})).toEqual([
      'leakedSigningKey',
      'largeFee',
    ])
  })

  it('has real copy for every warning member', () => {
    // Asserting a count only proves the map has entries; what matters is that
    // each one resolves to a string the user can read. A missing leaf renders
    // the raw key in the warnings block (which is how `multiSig` shipped broken).
    const copy = translations.txReview.warnings as Record<string, string | undefined>
    for (const [warning, leaf] of Object.entries(WARNING_KEY)) {
      if (leaf === undefined) continue
      expect(typeof copy[leaf], `txReview.warnings.${leaf} (for '${warning}')`).toBe('string')
    }
  })
})

describe('warningKeysForMode', () => {
  const warned = {
    ...base,
    warnings: ['leaked-signing-key', 'large-fee', 'unknown-body-fields', 'plutus-contract', 'unresolved-inputs'],
  } as ReviewedTransaction

  it('shows every warning while the user still has a signing decision to make', () => {
    // The two structural ones are absent in both modes — they never reach a mode filter at all.
    expect(warningKeysForMode(warned, 'confirm')).toEqual(['leakedSigningKey', 'largeFee', 'unknownBodyFields'])
  })

  it('quietens signing advice on a settled transaction but keeps the leaked key', () => {
    // A burned key is not a decision the reader already made — it is a fact about
    // the transaction, and a settled tx is where it gets discovered.
    expect(warningKeysForMode(warned, 'detail')).toEqual(['leakedSigningKey', 'unknownBodyFields'])
  })
})

describe('witnessRoleKey', () => {
  const witness = (over: Partial<ReviewedVkeyWitness> = {}): ReviewedVkeyWitness => ({
    vkeyHex: 'aa'.repeat(32),
    signatureHex: 'bb'.repeat(64),
    keyHashHex: 'cc'.repeat(28),
    satisfiesRequiredSigner: false,
    leaksSigningKey: false,
    ...over,
  })

  it('names whose key signed', () => {
    expect(witnessRoleKey(witness({owner: 'wallet'}))).toBe('wallet')
    expect(witnessRoleKey(witness({owner: 'identity'}))).toBe('identity')
  })

  it('prefers ownership over the required-signers list when a key is both', () => {
    // "This is your key" is what the reader acts on; "it was required" is not.
    expect(witnessRoleKey(witness({owner: 'wallet', satisfiesRequiredSigner: true}))).toBe('wallet')
  })

  it('calls a key that is only required a required signer', () => {
    expect(witnessRoleKey(witness({satisfiesRequiredSigner: true}))).toBe('requiredSigner')
  })

  it('calls an unmatched key external — a real answer, not a shrug', () => {
    expect(witnessRoleKey(witness())).toBe('external')
  })

  it('distinguishes an unhashable key from an external one', () => {
    // Every match against it was unanswerable, so reporting "external" would be
    // asserting something we never checked.
    expect(
      witnessRoleKey({
        vkeyHex: 'not-a-key',
        signatureHex: 'bb'.repeat(64),
        satisfiesRequiredSigner: false,
        leaksSigningKey: false,
      }),
    ).toBe('unidentified')
  })

  it('has real copy for every role it can return', () => {
    const copy = translations.txReview.signatures.role as Record<string, string | undefined>
    for (const role of ['wallet', 'identity', 'requiredSigner', 'external', 'unidentified']) {
      expect(typeof copy[role], `txReview.signatures.role.${role}`).toBe('string')
    }
  })
})

describe('requiredSignerSigned', () => {
  const HASH = 'cc'.repeat(28)
  const witness = (keyHashHex?: string): ReviewedVkeyWitness => ({
    vkeyHex: 'aa'.repeat(32),
    signatureHex: 'bb'.repeat(64),
    ...(keyHashHex !== undefined ? {keyHashHex} : {}),
    satisfiesRequiredSigner: false,
    leaksSigningKey: false,
  })

  it('is true when a witness carries that key hash', () => {
    expect(requiredSignerSigned({...base, witnessSet: [witness(HASH)]}, HASH)).toBe(true)
  })

  it('is false when the witness set is present but lacks it', () => {
    expect(requiredSignerSigned({...base, witnessSet: [witness('dd'.repeat(28))]}, HASH)).toBe(false)
  })

  it('is null with no witness set — an unsigned body does not say "pending"', () => {
    expect(requiredSignerSigned(base, HASH)).toBeNull()
  })

  it('does not count an unhashable witness as a match', () => {
    expect(requiredSignerSigned({...base, witnessSet: [witness()]}, HASH)).toBe(false)
  })
})

describe('totalDeposit / hasDeposit', () => {
  it('sums deposit-bearing operations from their resolved (not hardcoded) values', () => {
    const tx = withOps([
      {kind: 'stake-registration', credential: cred, deposit: 2_000_000n},
      {kind: 'drep-registration', credential: cred, deposit: 500_000_000n},
      {kind: 'stake-delegation', credential: cred, poolKeyHashHex: 'bb'.repeat(28)},
    ])
    expect(totalDeposit(tx)).toBe(502_000_000n)
    expect(hasDeposit(tx)).toBe(true)
  })

  it('is 0/false when no operation carries a deposit', () => {
    expect(totalDeposit(withOps([{kind: 'stake-delegation', credential: cred, poolKeyHashHex: 'bb'.repeat(28)}]))).toBe(
      0n,
    )
    expect(hasDeposit(base)).toBe(false)
  })
})

describe('willBroadcastOnConfirm', () => {
  const tx = (over: {readonly signOnly?: boolean} = {}) => ({_tag: 'CardanoTx' as const, ...over})

  it('broadcasts an ordinary send', () => {
    expect(willBroadcastOnConfirm(tx(), false)).toBe(true)
  })

  it('does not broadcast a signOnly request', () => {
    // A dApp `signTx`, an air-gap reply, a co-signer's partial pass: each hands a
    // witness set back to whoever submits.
    expect(willBroadcastOnConfirm(tx({signOnly: true}), false)).toBe(false)
  })

  it('does not broadcast a shared wallet own transaction, which never says signOnly', () => {
    // The regression this exists for. `applyAuthorityToRequest` stamps `signOnly`
    // inside the signing layer, so the request reaching the review looks exactly
    // like an ordinary send — and the button said "Confirm & Send" for a tap that
    // sends nothing.
    expect(willBroadcastOnConfirm(tx(), true)).toBe(false)
  })

  it('still does not broadcast when the quorum is already met', () => {
    // Submitting is the co-sign screen's own action, one screen later.
    expect(willBroadcastOnConfirm(tx(), true)).toBe(false)
  })

  it('says nothing about a message leg', () => {
    expect(willBroadcastOnConfirm({_tag: 'CardanoMessage'}, false)).toBe(false)
    expect(willBroadcastOnConfirm(undefined, false)).toBe(false)
  })
})

describe('reviewScreenTitleKey', () => {
  // Built from the shared `base` rather than a hand-rolled shape: the derivation walks inputs and
  // operations, and a partial fixture only proves the test does not reach them.
  const contractTx: ReviewedTransaction = {
    ...base,
    operations: [{kind: 'contract-execution'} as ReviewedOperation],
  }

  it('lets the producer name its own screen', () => {
    // ⚠️ The bug: `titleKey` was set by nine producers and read by none, so a CIP-113 transfer
    // was titled "Smart Contract" over what the user was actually doing — sending a token.
    expect(reviewScreenTitleKey('cardanoSend.programmableTitle', contractTx)).toBe('cardanoSend.programmableTitle')
  })

  it('derives from the transaction when the producer says nothing', () => {
    expect(reviewScreenTitleKey(undefined, contractTx)).toBe('txReview.titles.contract')
  })

  it('falls back to the message title for a message leg', () => {
    expect(reviewScreenTitleKey(undefined, null)).toBe('txReview.actions.signMessage')
  })

  it('lets a producer title a message leg too', () => {
    // A signature request names itself; having no transaction to derive from does not
    // override an explicit choice.
    expect(reviewScreenTitleKey('airGap.message.title', null)).toBe('airGap.message.title')
  })
})
