import type {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Analyze} from '@evolution-sdk/review'
import {XpubHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address, Keys, Wallet} from '@pnyx/cardano-core'
import {Effect, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {parseDRepTarget} from '../../cardano-pool-drep/drep-id'
import {KEY_AUTHORITY, type ScriptIndexAuthority, type SpendAuthority} from '../account'
import type {CardanoRailConfig} from '../config'
import {cardanoAccountFromSharedWallet} from '../multisig/account'
import {scriptsAt} from '../multisig/derive'
import {deriveOwnAccountXpub} from '../multisig/model'
import {flatTemplate, tagAt} from '../multisig/template'
import type {CoSignerRef, SharedWallet} from '../multisig/types'
import {makeCardanoRail} from '../rail'
import {applyAuthorityToRequest} from '../signing-adapters'
import {chainUtxo, mockChain} from '../test-provider'
import {
  buildDelegationReview,
  buildUnstakeReview,
  buildWithdrawReview,
  fetchStakeAccountState,
  poolHashHexFromBech32,
  rewardAddress,
  stakeWitnessBudget,
} from './staking-flow'
import type {StakeAccountState} from './state'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const CO_SIGNER_MNEMONIC = 'test walk nut penalty hip pave soap entry language right filter choice'
const GROUP = 'group-stake'
// A real preprod pool id (28-byte key hash under the `pool` hrp).
const POOL_ID = 'pool1dghwejqptsjtf9k8paspg9rhl8humxx0nh7sk37j0ada2dr9mqh'
const DREP_HASH_HEX = 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa'

const CONFIG: CardanoRailConfig = {
  network: 'preprod',
  koiosUrl: 'https://first-party.example/koios',
  networkId: 0,
  protocolMagic: 1,
}

let ownAddress: string

beforeAll(async () => {
  ownAddress = await Effect.runPromise(
    Effect.gen(function* () {
      const own = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      return yield* own.baseAddress(Address.Network.Testnet)
    }),
  )
})

/** 20 ADA at whichever address the rail under test watches. */
const UTXOS = (address: string = ownAddress) => [chainUtxo({address, txHash: '22', lovelace: 20_000_000n})]

const railWith = (accounts: Readonly<Record<string, EvolutionProvider.AccountInfo>> = {}) =>
  makeCardanoRail({config: CONFIG, addressBech32: ownAddress, accountIndex: 0}).pipe(
    Effect.provide(Layer.mergeAll(EvolutionDecodeLayer, mockChain({utxos: UTXOS(), accounts}))),
  )

const FRESH: StakeAccountState = {
  registered: false,
  currentPool: null,
  currentDrep: null,
  rewardsAvailable: 0n,
  deposit: null,
}

const DELEGATED: StakeAccountState = {
  registered: true,
  currentPool: POOL_ID,
  currentDrep: {kind: 'abstain'},
  rewardsAvailable: 1_500_000n,
  deposit: 2_000_000n,
}

const opKinds = (review: {reviewed: {operations: readonly {kind: string}[]}}) =>
  review.reviewed.operations.map((o) => o.kind)

const hex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * The credentials the built certificates actually carry, decoded from the body.
 *
 * Read off the bytes rather than inferred from a review warning: the warning is a
 * judgement about whose script it is, and what is under test here is which
 * credential *type* the certificate was encoded with.
 */
const certCredentials = async (bodyHex: string): Promise<readonly {isScript: boolean; hashHex: string}[]> => {
  const {body} = await Effect.runPromise(Inspect.txBody(bodyHex))
  return (body.certificates ?? [])
    .flatMap((c) => Analyze.certificateCredentials(c))
    .map((cred) => ({isScript: cred.isScript, hashHex: hex(cred.hash)}))
}

describe('stakeWitnessBudget', () => {
  const at = (requiredSigners: number, keyIndex = 0): ScriptIndexAuthority => ({
    keyIndex,
    scriptHashHex: 'cc'.repeat(28),
    nativeScriptHex: '8201',
    signerKeyHashes: ['aa'.repeat(28)],
    requiredSigners,
  })
  const script = (indexes: readonly ScriptIndexAuthority[], stakeRequired: number): SpendAuthority => ({
    kind: 'script',
    indexes,
    stake: {
      scriptHashHex: 'dd'.repeat(28),
      nativeScriptHex: '8202',
      signerKeyHashes: ['11'.repeat(28)],
      requiredSigners: stakeRequired,
    },
    validity: {invalidBefore: null, invalidHereafter: null},
    signingGroupId: null,
  })

  it('charges a key wallet one witness per input address plus its stake key', () => {
    expect(stakeWitnessBudget(KEY_AUTHORITY, 1)).toBe(2)
    expect(stakeWitnessBudget(KEY_AUTHORITY, 3)).toBe(4)
  })

  it('charges a script wallet a quorum on each side', () => {
    // 2-of-3 paying, 2-of-3 delegating: four witnesses, not two.
    expect(stakeWitnessBudget(script([at(2)], 2), 1)).toBe(4)
  })

  it('charges every payment index, because each owes its own quorum', () => {
    expect(stakeWitnessBudget(script([at(2, 0), at(2, 4)], 2), 1)).toBe(6)
  })

  it('does not let the input count move a script wallet answer', () => {
    // The quorum is the wallet's, not the selection's — so the caller's fixed
    // point settles on the first round rather than oscillating.
    const authority = script([at(2)], 3)
    expect(stakeWitnessBudget(authority, 1)).toBe(stakeWitnessBudget(authority, 9))
  })

  it('never sizes below what a 1-of-1 actually carries', () => {
    // The regression that matters is under-sizing: the fee is fixed in the body,
    // so a short budget fails when the last signature lands, not at build time.
    expect(stakeWitnessBudget(script([at(1)], 1), 1)).toBe(2)
  })
})

describe('poolHashHexFromBech32', () => {
  it('decodes a pool id to its 28-byte key hash and rejects non-pool input', async () => {
    const hex = await Effect.runPromise(poolHashHexFromBech32(POOL_ID))
    expect(hex).toHaveLength(56)
    const bad = await Effect.runPromise(Effect.flip(poolHashHexFromBech32('drep1abc')))
    expect(bad.kind).toBe('build-failed')
  })
})

describe('fetchStakeAccountState', () => {
  it('maps a never-seen stake address to the unregistered empty state', async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        return yield* fetchStakeAccountState(rail)
      }),
    )
    expect(state).toEqual(FRESH)
  })

  it('canonicalizes the koios abstain literal on a delegated account', async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith({})
        const rewardInfo = rewardAddress(rail)
        if (rewardInfo === null) throw new Error('rail has no reward address')
        const reward = rewardInfo.bech32
        const rail2 = yield* makeCardanoRail({config: CONFIG, addressBech32: ownAddress, accountIndex: 0}).pipe(
          Effect.provide(
            Layer.mergeAll(
              EvolutionDecodeLayer,
              mockChain({
                utxos: UTXOS(),
                accounts: {
                  [reward]: {
                    registered: true,
                    delegatedPool: POOL_ID,
                    // ⚠️ `delegatedDRep`, not `delegatedDrep` — the chain client's spelling.
                    delegatedDRep: 'drep_always_abstain',
                    rewardsAvailable: 1_500_000n,
                    deposit: 2_000_000n,
                    // Required-taking-undefined on the chain client: "the backend does not
                    // report it" is a distinct answer from zero, so it cannot be omitted.
                    controlledBalance: undefined,
                  },
                },
              }),
            ),
          ),
        )
        return yield* fetchStakeAccountState(rail2)
      }),
    )
    expect(state).toEqual(DELEGATED)
  })
})

describe('buildDelegationReview', () => {
  it('first-time setup, software wallet: one combined stake+vote+reg cert with the key deposit', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildDelegationReview(
          rail,
          GROUP,
          FRESH,
          {pool: POOL_ID, drep: parseDRepTarget('drep_always_abstain')},
          'software',
        )
      }),
    )
    expect(opKinds(review)).toEqual(['stake-vote-reg-delegation'])
    // 2 ADA deposit leaves the wallet on top of the fee
    const ownCoin = review.reviewed.ownDelta.find((a) => a.assetId === undefined)
    expect(ownCoin !== undefined && ownCoin.quantity <= -2_000_000n).toBe(true)
    expect(review.request.payload._tag).toBe('CardanoTx')
    expect(review.tracked.consumedUtxoIds).toEqual([`${'22'.repeat(32)}:0`])
  })

  it('first-time setup, hardware wallet: registration, stake delegation and vote delegation', async () => {
    // ⚠️ The case a Trezor run failed on 2026-10-08. CIP-21 forbids the combined certificate in a
    // hardware-wallet transaction and BOTH device converters refuse it, so a device gets the
    // atomic ones. The ORDER is load-bearing: certificates apply in sequence, so the registration
    // precedes the delegations that depend on it.
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildDelegationReview(
          rail,
          GROUP,
          FRESH,
          {pool: POOL_ID, drep: parseDRepTarget('drep_always_abstain')},
          'hardware',
        )
      }),
    )
    expect(opKinds(review)).toEqual(['stake-registration', 'stake-delegation', 'vote-delegation'])
    // One registration, so one deposit — three certificates must not pay it three times.
    const ownCoin = review.reviewed.ownDelta.find((a) => a.assetId === undefined)
    expect(ownCoin !== undefined && ownCoin.quantity <= -2_000_000n).toBe(true)
    expect(ownCoin !== undefined && ownCoin.quantity > -4_000_000n).toBe(true)
  })

  it('registered, pool-only change: plain stake delegation, no deposit', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildDelegationReview(
          rail,
          GROUP,
          DELEGATED,
          {pool: 'pool1z5uqdk7dzdxaae5633fqfcu2eqzy3a3rgtuvy087fdld7yws0xt', drep: {kind: 'abstain'}}, // drep unchanged
          'software',
        )
      }),
    )
    expect(opKinds(review)).toEqual(['stake-delegation'])
  })

  it('registered, DRep-only change: plain vote delegation to a key DRep', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildDelegationReview(
          rail,
          GROUP,
          DELEGATED,
          {pool: POOL_ID, drep: {kind: 'key', hashHex: DREP_HASH_HEX}}, // pool unchanged
          'software',
        )
      }),
    )
    expect(opKinds(review)).toEqual(['vote-delegation'])
  })

  it('fails nothing-to-do when the selection matches the current delegation', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const rail = yield* railWith()
          yield* rail.sync
          return yield* buildDelegationReview(
            rail,
            GROUP,
            DELEGATED,
            {pool: POOL_ID, drep: {kind: 'abstain'}},
            'software',
          )
        }),
      ),
    )
    expect(error).toMatchObject({_tag: 'StakeBuildError', kind: 'nothing-to-do'})
  })
})

describe('buildUnstakeReview', () => {
  it('deregisters with the deposit refund AND withdraws pending rewards in the same tx', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildUnstakeReview(rail, GROUP, DELEGATED)
      }),
    )
    const kinds = opKinds(review)
    expect(kinds).toContain('stake-deregistration')
    expect(kinds).toContain('reward-withdrawal')
    // refund + rewards flow back: net own delta = +2 ADA deposit +1.5 ADA rewards − fee > 0
    const ownCoin = review.reviewed.ownDelta.find((a) => a.assetId === undefined)
    expect(ownCoin !== undefined && ownCoin.quantity > 3_000_000n).toBe(true)
  })

  it('fails nothing-to-do when the key is not registered', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const rail = yield* railWith()
          yield* rail.sync
          return yield* buildUnstakeReview(rail, GROUP, FRESH)
        }),
      ),
    )
    expect(error).toMatchObject({kind: 'nothing-to-do'})
  })
})

describe('a shared wallet delegating', () => {
  // A 2-of-3 CIP-1854 wallet whose stake credential is a script hash. Everything
  // below is derived from real mnemonics rather than stubbed, because what is
  // under test is which 28 bytes end up where and under which credential type.
  const sharedWallet = async (): Promise<SharedWallet> => {
    const xpubs = await Promise.all(
      [MNEMONIC, CO_SIGNER_MNEMONIC, MNEMONIC].map((m, i) =>
        Effect.runPromise(
          Keys.rootKeyFromMnemonic(m).pipe(Effect.flatMap((root) => deriveOwnAccountXpub(root, i === 2 ? 1 : 0))),
        ),
      ),
    )
    const coSigners: CoSignerRef[] = xpubs.map((accountXpubHex, i) => ({
      tag: tagAt(i),
      name: `C${i}`,
      accountXpubHex: XpubHex(accountXpubHex),
      ...(i === 0 ? {isSelf: true as const} : {}),
    }))
    const template = flatTemplate(
      {kind: 'atLeast', n: 2},
      coSigners.map((c) => c.tag),
    )
    return {
      id: 'shared-1',
      name: 'Council',
      coSigners,
      paymentTemplate: template,
      delegationTemplate: template,
      network: Address.Network.Testnet,
      accountIndex: 0,
      createdAt: '2026-08-10T00:00:00.000Z',
    }
  }

  const sharedRail = (state: StakeAccountState | null = null) =>
    Effect.gen(function* () {
      const wallet = yield* Effect.promise(sharedWallet)
      const account = yield* cardanoAccountFromSharedWallet(wallet, 0)
      const accounts =
        state === null
          ? {}
          : {
              [account.rewardAddressBech32 ?? '']: {
                registered: state.registered,
                delegatedPool: state.currentPool,
                delegatedDRep: null,
                rewardsAvailable: state.rewardsAvailable,
                deposit: state.deposit ?? undefined,
                controlledBalance: undefined,
              } satisfies EvolutionProvider.AccountInfo,
            }
      const rail = yield* makeCardanoRail({
        config: CONFIG,
        addressBech32: account.addressBech32,
        account,
        accountIndex: 0,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(EvolutionDecodeLayer, mockChain({utxos: UTXOS(account.addressBech32), accounts})),
        ),
      )
      yield* rail.sync
      return {rail, account, wallet}
    })

  it('builds the certificate under a script credential, not a key one', async () => {
    // `Certs.*` defaults `isScript` to false, so an omitted flag produces a
    // well-formed certificate for an account that does not exist — the chain is
    // the first thing that would have objected.
    const {review, stakeScriptHashHex} = await Effect.runPromise(
      Effect.gen(function* () {
        const {rail, account} = yield* sharedRail()
        const built = yield* buildDelegationReview(
          rail,
          GROUP,
          FRESH,
          {pool: POOL_ID, drep: parseDRepTarget('drep_always_abstain')},
          'script',
        )
        return {review: built, stakeScriptHashHex: account.stakeKeyHashHex}
      }),
    )
    // All three certificates, because the flag is per-certificate: one of them defaulting to a key
    // credential would delegate an account that does not exist.
    expect(await certCredentials(review.bodyHex)).toEqual([
      {isScript: true, hashHex: stakeScriptHashHex},
      {isScript: true, hashHex: stakeScriptHashHex},
      {isScript: true, hashHex: stakeScriptHashHex},
    ])
  })

  it('does not warn about the wallet own delegation script', async () => {
    // The warning means "a script you do not control is acting here". A shared
    // wallet delegating itself is the only way it can ever stake, so an alarm on
    // it teaches the user to ignore the banner in the case that matters.
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const {rail} = yield* sharedRail()
        return yield* buildDelegationReview(rail, GROUP, FRESH, {pool: POOL_ID, drep: {kind: 'abstain'}}, 'script')
      }),
    )
    expect(review.reviewed.warnings).not.toContain('script-certificate')
  })

  it('leaves a key wallet certificate on the key credential', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildDelegationReview(
          rail,
          GROUP,
          FRESH,
          {pool: POOL_ID, drep: parseDRepTarget('drep_always_abstain')},
          'software',
        )
      }),
    )
    const creds = await certCredentials(review.bodyHex)
    expect(creds.every((c) => c.isScript)).toBe(false)
    expect(review.reviewed.warnings).not.toContain('script-certificate')
  })

  it('sends the delegation script to the signer, since nothing else knows it is needed', async () => {
    const {payloadScripts, stakingScriptHex} = await Effect.runPromise(
      Effect.gen(function* () {
        const {rail, wallet} = yield* sharedRail()
        const review = yield* buildDelegationReview(
          rail,
          GROUP,
          FRESH,
          {pool: POOL_ID, drep: {kind: 'abstain'}},
          'script',
        )
        const scripts = yield* scriptsAt(wallet, 0)
        const payload = review.request.payload
        return {
          payloadScripts: payload._tag === 'CardanoTx' ? (payload.nativeScripts ?? []) : [],
          stakingScriptHex: scripts.stakingScriptHex,
        }
      }),
    )
    expect(payloadScripts).toEqual([stakingScriptHex])
  })

  it('carries a key wallet no scripts at all', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildWithdrawReview(rail, GROUP, DELEGATED)
      }),
    )
    const payload = review.request.payload
    expect(payload._tag === 'CardanoTx' && 'nativeScripts' in payload).toBe(false)
  })

  it('composes with the authority into payment + delegation, each exactly once', async () => {
    // The builder knows the transaction names the stake credential; the authority
    // knows the inputs sit at script addresses. A script sent twice is a witness
    // set the ledger rejects, so the two contributions must not overlap.
    const scripts = await Effect.runPromise(
      Effect.gen(function* () {
        const {rail, account, wallet} = yield* sharedRail()
        const review = yield* buildDelegationReview(
          rail,
          GROUP,
          FRESH,
          {pool: POOL_ID, drep: {kind: 'abstain'}},
          'script',
        )
        const applied = applyAuthorityToRequest(account.authority, review.request)
        const at0 = yield* scriptsAt(wallet, 0)
        const payload = applied.payload
        return {
          sent: payload._tag === 'CardanoTx' ? (payload.nativeScripts ?? []) : [],
          payment: at0.paymentScriptHex,
          staking: at0.stakingScriptHex,
        }
      }),
    )
    expect([...scripts.sent].sort()).toEqual([scripts.staking, scripts.payment].sort())
    expect(new Set(scripts.sent).size).toBe(scripts.sent.length)
  })

  it('withdraws rewards from the script reward account', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const {rail} = yield* sharedRail()
        return yield* buildWithdrawReview(rail, GROUP, DELEGATED)
      }),
    )
    expect(opKinds(review)).toEqual(['reward-withdrawal'])
  })

  it('deregisters under the script credential too', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const {rail} = yield* sharedRail()
        return yield* buildUnstakeReview(rail, GROUP, DELEGATED)
      }),
    )
    expect(opKinds(review)).toContain('stake-deregistration')
    expect((await certCredentials(review.bodyHex)).every((c) => c.isScript)).toBe(true)
  })
})

describe('buildWithdrawReview', () => {
  it('withdraws the claimable rewards only', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith()
        yield* rail.sync
        return yield* buildWithdrawReview(rail, GROUP, DELEGATED)
      }),
    )
    expect(opKinds(review)).toEqual(['reward-withdrawal'])
    const ownCoin = review.reviewed.ownDelta.find((a) => a.assetId === undefined)
    // 1.5 ADA rewards in, fee out — still net positive
    expect(ownCoin !== undefined && ownCoin.quantity > 1_000_000n).toBe(true)
  })

  it('fails nothing-to-do with zero rewards', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const rail = yield* railWith()
          yield* rail.sync
          return yield* buildWithdrawReview(rail, GROUP, {...DELEGATED, rewardsAvailable: 0n})
        }),
      ),
    )
    expect(error).toMatchObject({kind: 'nothing-to-do'})
  })
})
