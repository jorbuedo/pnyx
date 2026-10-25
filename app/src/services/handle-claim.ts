/**
 * Claiming a Pnyx handle from the device — four sponsored transactions.
 *
 * | # | transaction | contract | what it needs |
 * |---|---|---|---|
 * | 1 | the shell deploy | handle (new) | the canonical name and the payment address |
 * | 2 | `claimFreePermit(tier, recipient)` | payment | a free row for the tier — **only if no permit is held** |
 * | 3 | `bind` | handle | `identitySk`, **and the permit as an unshielded input** — **only if the shell is unowned** |
 * | 4 | `setPrimaryName` | identity | the **display** spelling, so the row shows the name |
 *
 * **The shell's own record decides how many of those run.** It is read once, before the vault is opened
 * and before anything is proven, and `bindStep` turns it into the next step. A name this identity
 * already holds skips straight to 4 — which is what makes a claim whose `bind` landed and whose
 * `setPrimaryName` did not finishable at all — and a name somebody else holds is refused before it
 * costs a permit, a proof or a biometric prompt.
 *
 * Each is proven on this device and relayed unbalanced: the sponsor pays every DUST fee, which is what
 * makes a name obtainable by a wallet holding nothing. `payment`, `handle` and `identity` are all
 * recognised by the sponsorship policy as templates, so no per-name configuration exists anywhere.
 *
 * **Why four and not one.** They cannot be batched: the shell must exist before `bind` can call it, and
 * `bind`'s transcript is built against the shell's *live* state; the permit must be a settled ledger
 * UTxO before it can be spent, so a mint and its spend cannot share a transaction; and the sponsor funds
 * exactly one contract action per transaction anyway.
 *
 * ⚠️ **Holding a name and showing one are different writes.** `bind` writes the *handle contract's*
 * owner — that is what makes the name yours. The name a client renders comes from
 * `identity(C).primaryName`, which only `setPrimaryName` writes. Without step 4 the name is held on
 * chain and invisible everywhere, which is how this first landed: the card spun until it timed out while
 * the claim had already succeeded. Resuming from that state is step 2 above.
 *
 * **The mint comes after the funding attempt, not before.** Ordering it first cost a wasted sponsored
 * mint on every retry — and the flow *is* retried, because a step has to wait for a block. Asking the
 * ledger what `bind` owes and minting only when the wallet cannot cover it makes a retry free.
 *
 * **Only `bind` needs funding, and only from the permit.** The mint spends nothing and the deploy
 * carries no value, so both are relayed exactly as built. `bind` declares
 * `unshielded_inputs[permitColour] = 1`, which is a deficit this wallet covers from its permit — the
 * same {@link module:./midnight/fund-transaction} machinery a dApp's transaction uses, because the
 * requirement is identical: read what the ledger says is owed, offer outputs that cover it, sign. The
 * permit colour is never derived here; the ledger names what is owed.
 *
 * ⚠️ **The permit is minted to a per-name address, not the wallet's main one.** `claimFreePermit`
 * discloses its recipient, so minting to the ordinary receive address would publish "this address owns
 * this name" for ever. See {@link module:./handle-permit-address}.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {permitTokenType} from '@pnyx/contract-client/derivations'
import {encodeHandle, handleTier, validateHandle} from '@pnyx/contract-client/handle'
import type {HandleOwnership} from '@pnyx/contract-client/handle-validity'
import {handleOwnership} from '@pnyx/contract-client/handle-validity'
import {identityCommitmentOf} from '@pnyx/contract-client/identity'
import {hex} from '@pnyx/crypto'
import {
  buildBindProvenTx,
  buildClaimFreePermitProvenTx,
  buildHandleDeployTx,
  handleAddress,
  handleRecord,
  nightPayload,
} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey, encodeNightAddress} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {midnightPaymentAddress} from '../config/env'
import {logger} from '../logger'
import {type BindStep, bindStep} from './handle-bind-decision'
import {claimAt} from './handle-claim-progress'
import {permitAddressIndex} from './handle-permit-address'
import {fetchContractMarker} from './midnight/contract-state'
import {runMidnight} from './midnight/effect-boundary'
import {fundingCandidatesFor} from './midnight/fund-candidates'
import {SPEND_CATCH_UP_TIMEOUT_MS, syncUnshieldedWallet} from './midnight/wallet/unshielded'
import {ensureCircuitArtifacts, ensureVerifierKeys} from './pnyx-artifacts'
import {readPnyxContractState} from './pnyx-contract-state'
import {writePrimaryName} from './primary-name-write'
import {relaySponsoredTx} from './sponsored-relay'

const ORIGIN = 'handle-claim'

/** Why a naming attempt did not reach the chain. */
export type HandleWriteFailure =
  /** The handle is not one this client will render — rejected before any proving cost. */
  | {readonly kind: 'invalid'; readonly reason: string}
  /** Proving failed on device. */
  | {readonly kind: 'proof'}
  /** The relay refused or could not be reached. `detail` is the service's own words. */
  | {readonly kind: 'relay'; readonly detail: string}
  /**
   * Nothing reached the chain, and why.
   *
   * ⚠️ **A code, not a message.** These are all user-facing — "try again in a moment" and "this name is
   * taken" are different things to say, and only two of them are retryable — so the reason has to
   * survive into the UI. An English `detail` string here would have been a translation the pipeline
   * never sees; the caller maps the code to a key.
   *
   * ⚠️ **Not a synonym for "no permit" any more.** A claim now mints its own permit.
   */
  | {readonly kind: 'unavailable'; readonly reason: UnavailableReason}

/** Why a claim could not proceed. Ordered roughly by how early it is decided. */
export type UnavailableReason =
  /** No payment contract is configured, so this build has no namespace. */
  | 'no-registry'
  /** The payment or handle contract's state could not be read. */
  | 'registry-unreachable'
  /** The seed could not be unlocked, so the permit's key could not be derived. */
  | 'wallet-locked'
  /** This tier has no free row — the storefront should not have offered the button. */
  | 'tier-not-free'
  /** The shell was relayed just now. `bind` reads its live state, so the claim resumes on a retry. */
  | 'registering'
  /** The permit has not landed yet. The one other retryable case. */
  | 'permit-pending'
  /** Somebody else already holds this name. */
  | 'taken'
  /**
   * Banned or burned. Live on chain, never usable, and — for a burn — never free again.
   *
   * ⚠️ Its own reason because "taken" invites a retry and this never succeeds. `bind` would have
   * failed anyway; saying so before proving saves a proof and says the true thing.
   */
  | 'reserved'
  /** A disagreement inside this build — logged in full, never shown in detail. */
  | 'internal'
  /** The action exists on chain but the app does not offer it. Releasing a name burns it. */
  | 'not-offered'
  /**
   * The name **is** held — `bind` landed — but the identity row could not be pointed at it.
   *
   * ⚠️ Its own reason because it is the one failure that must not read as "claiming failed": the claim
   * succeeded, and retrying the whole chain would waste a mint on a name the caller already owns.
   */
  | 'bound-not-shown'

export type HandleWriteResult = {readonly ok: true} | {readonly ok: false; readonly failure: HandleWriteFailure}

export type ClaimInputs = {
  readonly identitySk: Uint8Array
  /** The identity contract — carried for `releaseHandle`, which writes the row rather than a handle. */
  readonly contractAddress: Uint8Array
  readonly networkId: string
  /** Absolute unix-second expiry — a duration writes Timestamp(3600) and the node rejects it. */
  readonly expiresAtSecs: number
  /** ⚠️ Explicit, never pinned: the permit is derived from a seed and signed by one account's key. */
  readonly groupId: string
  readonly accountIndex: number
  /** Localized biometric-prompt title — the vault needs one. */
  readonly biometricPrompt: string
}

/** The one place the payment contract's absence becomes a refusal rather than a crash. */
const requirePayment = (): Uint8Array | undefined => {
  const configured = midnightPaymentAddress()
  if (configured === undefined) return undefined
  const decoded = hex.decode(configured)
  if (decoded._tag === 'Left' || decoded.right.length !== 32) {
    // The env gate checks the shape, so reaching here means a build that skipped it.
    logger.error('the configured payment address is not 32 bytes of hex', {origin: ORIGIN})
    return undefined
  }
  return decoded.right
}

/**
 * Claim `handle` for this identity.
 *
 * `makePrimary` is a request rather than a branch: the row takes the name either way, because that is
 * what the circuit does.
 *
 * Idempotent at every step, which is what makes a retry safe: the shell is only deployed when the
 * indexer says nothing is there, and a second `claimFreePermit` mints a second permit rather than
 * failing (deliberately unbounded — see `docs/FOLLOW_UPS.md`), so the cost of a retry is a spare permit
 * nobody spends.
 */
export const claimHandle = async (
  handle: string,
  _makePrimary: boolean,
  inputs: ClaimInputs,
): Promise<HandleWriteResult> => {
  const checked = validateHandle(handle)
  if (!checked.ok) return {ok: false, failure: {kind: 'invalid', reason: checked.reason}}
  const name = encodeHandle(checked.handle)
  const tier = handleTier(name)

  const payment = requirePayment()
  if (payment === undefined) {
    logger.warn('handle claim refused: this build has no payment contract', {origin: ORIGIN})
    return {ok: false, failure: {kind: 'unavailable', reason: 'no-registry'}}
  }

  // 1. The shell. Its address is a pure function of the canonical name and the payment address, so a
  //    second claim of one name derives the same address and is refused on chain.
  const shell = await ensureHandleShell({name, payment, inputs})
  if (!shell.ok) return shell

  // 2. Whose the name already is — before the vault is opened and before anything is proven. `bind`
  //    asserts an unowned shell, so without this every owned shell failed the same way, including
  //    **this identity's own**: a claim whose `bind` landed and whose `setPrimaryName` did not told its
  //    owner the name was taken and could not be finished. It also saves a permit, a proof and a
  //    biometric prompt on a name nobody could have claimed.
  const step = await shellOwnership(shell.address, inputs.identitySk)
  if (step.kind === 'refuse') return {ok: false, failure: {kind: 'unavailable', reason: step.reason}}

  if (step.kind === 'bind') {
    // The address the permit is minted to, and the key that will spend it. Derived from the seed once
    // and used for both, so the two cannot disagree about which output is being spent.
    let permit: {readonly nightRoleKey: Uint8Array; readonly recipient: Uint8Array; readonly address: string}
    try {
      permit = await derivePermitKey(name, inputs)
    } catch (error) {
      logger.warn('handle claim could not derive its permit address', {origin: ORIGIN, error: String(error)})
      return {ok: false, failure: {kind: 'unavailable', reason: 'wallet-locked'}}
    }
    // 3. Bind, funded from the permit — and the permit minted only if there is not one already. The
    //    ledger decides: `bind` declares what it owes and the wallet either covers it or does not.
    const bound = await bindName({
      name: checked.handle,
      address: shell.address,
      permit,
      inputs,
      tier,
      payment,
      // Minting is the fallback, so it is passed in rather than called first. A claim whose permit is
      // already at its address — a resumed one, or a tier bought rather than given — mints nothing.
      mint: () => mintFreePermit({name, tier, payment, recipient: permit.recipient, inputs}),
    })
    if (!bound.ok) return bound
  } else {
    // Already bound by us, so the claim resumes at the write that displays it — no permit, no proof of
    // `bind`, and no open tier needed.
    logger.info('this identity already holds the name; finishing the claim', {origin: ORIGIN, name: checked.handle})
  }

  // 4. Point the identity row at the name, which is the only reason anything renders it.
  // ⚠️ The name is already held at this point, so a failure here loses the *display*, not the claim.
  // Said in the claim chain's own words, because "claiming failed" would be wrong and would invite a
  // retry of the whole chain.
  const written = await writePrimaryName({display: checked.display, inputs})
  if (written.ok) return written
  if (written.failure.kind === 'unavailable' && written.failure.reason === 'not-shown') {
    return {ok: false, failure: {kind: 'unavailable', reason: 'bound-not-shown'}}
  }
  return {ok: false, failure: written.failure}
}

/**
 * How long a step waits for the transaction before it to land, and how often it looks.
 *
 * Bounded rather than open-ended: on timeout the claim returns its ordinary retryable failure and the
 * user taps again, which is the behaviour that existed before waiting was added. A wait that never
 * ends would be a spinner with no way out.
 */
const SETTLE_TIMEOUT_MS = 90_000
const SETTLE_POLL_MS = 3_000

/**
 * Poll until `isThere`, or give up.
 *
 * Sleeps first: nothing this waits on can be true in the same tick the relay returned, so checking
 * immediately only wastes a round trip.
 */
const awaitOnChain = async (what: string, isThere: () => Promise<boolean>): Promise<boolean> => {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
    if (await isThere()) {
      logger.info('a claim step landed', {origin: ORIGIN, what})
      return true
    }
  }
  logger.warn('a claim step did not land in time; the claim stays resumable', {origin: ORIGIN, what})
  return false
}

/**
 * Whether this name's permit is already sitting at its address.
 *
 * ⚠️ **The colour is derived here, and only for the *check*.** Spending still asks the ledger what the
 * transaction owes (`fundWithPermit`), so a drift between the two fails funding rather than spending
 * the wrong token. Deriving buys the thing that matters: knowing whether a permit exists *before*
 * building a proof, where the old order proved `bind` and threw the proof away when the permit turned
 * out to be missing — a wasted device proof on the first attempt of every claim.
 */
const permitHeldAt = async (params: {
  readonly permit: {readonly address: string}
  readonly tier: number
  readonly payment: Uint8Array
  readonly inputs: ClaimInputs
}): Promise<boolean> => {
  const colour = hex.encode(permitTokenType(params.payment, params.tier))
  logger.debug('checking whether this name’s permit is already at its address', {
    origin: ORIGIN,
    address: params.permit.address,
    colour,
  })
  const synced = await runMidnight(
    syncUnshieldedWallet({
      groupId: params.inputs.groupId,
      accountIndex: params.inputs.accountIndex,
      address: params.permit.address,
      network: params.inputs.networkId,
      timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
    }),
  )
  const held = synced.utxos.some((utxo) => utxo.tokenType.toLowerCase() === colour && utxo.value > 0n)
  logger.debug('the permit address is synced', {origin: ORIGIN, utxos: synced.utxos.length, held})
  return held
}

/** The permit's own key, address and recipient bytes. Opens the vault once. */
const derivePermitKey = async (
  name: Uint8Array,
  inputs: ClaimInputs,
): Promise<{readonly nightRoleKey: Uint8Array; readonly recipient: Uint8Array; readonly address: string}> => {
  const {createEnclaveMnemonicVault} = await import('./credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(inputs.groupId, inputs.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  const index = permitAddressIndex(name)
  const nightRoleKey = await Effect.runPromise(
    deriveMidnightRoleKey(seed, Roles.NightExternal, {account: inputs.accountIndex, index}),
  )
  const recipient = nightPayload(nightRoleKey)
  const address = encodeNightAddress(recipient, inputs.networkId)
  claimAt('permit')
  logger.debug('derived this name’s permit address', {origin: ORIGIN, index, address})
  return {nightRoleKey, recipient, address}
}

const mintFreePermit = async (params: {
  readonly name: Uint8Array
  readonly tier: number
  readonly payment: Uint8Array
  readonly recipient: Uint8Array
  readonly inputs: ClaimInputs
}): Promise<HandleWriteResult> => {
  const paymentHex = hex.encode(params.payment)
  const state = await readPnyxContractState(paymentHex)
  if (state === null) {
    logger.warn('handle claim refused: the payment contract could not be read', {origin: ORIGIN, address: paymentHex})
    return {ok: false, failure: {kind: 'unavailable', reason: 'registry-unreachable'}}
  }
  let tx: Uint8Array
  const startedAt = Date.now()
  try {
    tx = await buildClaimFreePermitProvenTx({
      artifacts: await ensureCircuitArtifacts('claimFreePermit', 'payment'),
      contractState: state,
      contractAddress: params.payment,
      tier: params.tier,
      recipient: params.recipient,
      networkId: params.inputs.networkId,
      ttlSecs: params.inputs.expiresAtSecs,
    })
  } catch (error) {
    // ⚠️ The commonest cause is not a defect: the circuit asserts a free row for the tier, so a tier
    // that is not free fails *here* rather than at the node. Reported as `unavailable`, with the reason.
    logger.warn('the free-permit transaction could not be built', {
      origin: ORIGIN,
      tier: params.tier,
      error: String(error),
    })
    return {
      ok: false,
      failure: {kind: 'unavailable', reason: 'tier-not-free'},
    }
  }
  claimAt('awaiting-permit')
  logger.info('free permit proved on device', {
    origin: ORIGIN,
    tier: params.tier,
    ms: Date.now() - startedAt,
    bytes: tx.length,
  })
  try {
    await relaySponsoredTx(tx)
  } catch (error) {
    return {ok: false, failure: {kind: 'relay', detail: error instanceof Error ? error.message : String(error)}}
  }
  return {ok: true}
}

type ShellResult =
  | {readonly ok: true; readonly address: Uint8Array}
  | {readonly ok: false; readonly failure: HandleWriteFailure}

const ensureHandleShell = async (params: {
  readonly name: Uint8Array
  readonly payment: Uint8Array
  readonly inputs: ClaimInputs
}): Promise<ShellResult> => {
  const keysDir = await ensureVerifierKeys('handle')
  const address = await handleAddress({keysDir, name: params.name, payment: params.payment})
  const addressHex = hex.encode(address)
  const marker = await fetchContractMarker(addressHex)
  if (marker !== null) {
    // Already there: either a retry of our own claim, or somebody else holds this name — `bind` decides
    // which, by refusing a shell whose owner is already set.
    logger.debug('the shell for this name is already deployed', {origin: ORIGIN, address: addressHex})
    return {ok: true, address}
  }
  let deploy: {readonly address: Uint8Array; readonly tx: Uint8Array}
  try {
    deploy = await buildHandleDeployTx({
      keysDir,
      name: params.name,
      payment: params.payment,
      networkId: params.inputs.networkId,
      ttlSecs: params.inputs.expiresAtSecs,
    })
  } catch (error) {
    logger.warn('the handle shell deploy could not be built', {
      origin: ORIGIN,
      address: addressHex,
      error: String(error),
    })
    return {ok: false, failure: {kind: 'proof'}}
  }
  // The builder returns the address it will create. A disagreement means the two derivations have
  // drifted, and binding into the wrong contract is worse than failing.
  if (hex.encode(deploy.address) !== addressHex) {
    logger.error('the handle deploy would create a different contract than we derived', {
      origin: ORIGIN,
      derived: addressHex,
      built: hex.encode(deploy.address),
    })
    return {ok: false, failure: {kind: 'unavailable', reason: 'internal'}}
  }
  try {
    await relaySponsoredTx(deploy.tx)
  } catch (error) {
    return {ok: false, failure: {kind: 'relay', detail: error instanceof Error ? error.message : String(error)}}
  }
  logger.info('handle shell deploy relayed', {origin: ORIGIN, address: addressHex})
  claimAt('awaiting-shell')
  // ⚠️ Accepted, not landed. `bind` reads the shell's live state, so it cannot be built until the
  // deploy is on chain — so wait for it here rather than returning a retry the user has to tap.
  const landed = await awaitOnChain(
    'handle shell deploy',
    async () => (await readPnyxContractState(addressHex)) !== null,
  )
  return landed ? {ok: true, address} : {ok: false, failure: {kind: 'unavailable', reason: 'registering'}}
}

/**
 * What the shell says about its own owner, as the step a claim takes next.
 *
 * `'bind'` on a state or record we could not read: `bind`'s own assert is the backstop, and refusing on
 * a read failure would block a claim on an outage. The read is the one {@link bindName} makes anyway,
 * and the state cache serves both from one round trip.
 */
const shellOwnership = async (address: Uint8Array, identitySk: Uint8Array): Promise<BindStep> => {
  const addressHex = hex.encode(address)
  const state = await readPnyxContractState(addressHex)
  if (state === null) {
    logger.warn('the shell’s state could not be read; letting bind decide', {origin: ORIGIN, address: addressHex})
    return {kind: 'bind'}
  }
  let held: HandleOwnership
  try {
    held = handleOwnership(await handleRecord(state), identityCommitmentOf(identitySk))
  } catch (error) {
    logger.warn('the shell’s record could not be decoded; letting bind decide', {
      origin: ORIGIN,
      address: addressHex,
      error: String(error),
    })
    return {kind: 'bind'}
  }
  const step = bindStep(held)
  logger.info('the shell’s own record decided the next step', {
    origin: ORIGIN,
    address: addressHex,
    held,
    step: step.kind,
  })
  return step
}

const bindName = async (params: {
  readonly name: string
  readonly address: Uint8Array
  readonly permit: {readonly nightRoleKey: Uint8Array; readonly recipient: Uint8Array; readonly address: string}
  readonly inputs: ClaimInputs
  /** This name's tier and the contract that mints its permit — for the pre-check, before proving. */
  readonly tier: number
  readonly payment: Uint8Array
  /** Called only when the permit is not already at its address. */
  readonly mint: () => Promise<HandleWriteResult>
}): Promise<HandleWriteResult> => {
  const addressHex = hex.encode(params.address)
  const state = await readPnyxContractState(addressHex)
  if (state === null) {
    logger.warn('bind skipped: the shell’s state could not be read', {origin: ORIGIN, address: addressHex})
    return {ok: false, failure: {kind: 'unavailable', reason: 'registry-unreachable'}}
  }

  // ⚠️ **Before proving, not after.** `bind` cannot be funded without the permit, so building the
  // proof first meant every first attempt proved `bind`, discovered nothing to spend, and threw the
  // proof away — a whole device proof, twice per claim. Minting is cheap to decide and cheap to wait
  // for; proving is neither.
  const held = await permitHeldAt({
    permit: params.permit,
    tier: params.tier,
    payment: params.payment,
    inputs: params.inputs,
  })
  if (!held) {
    const minted = await params.mint()
    if (!minted.ok) return minted
    const arrived = await awaitOnChain('claim permit mint', () =>
      permitHeldAt({permit: params.permit, tier: params.tier, payment: params.payment, inputs: params.inputs}),
    )
    if (!arrived) return {ok: false, failure: {kind: 'unavailable', reason: 'permit-pending'}}
  }

  let tx: Uint8Array
  const startedAt = Date.now()
  try {
    tx = await buildBindProvenTx({
      artifacts: await ensureCircuitArtifacts('bind', 'handle'),
      contractState: state,
      contractAddress: params.address,
      identitySk: params.inputs.identitySk,
      networkId: params.inputs.networkId,
      ttlSecs: params.inputs.expiresAtSecs,
    })
  } catch (error) {
    // `bind` asserts the shell is unowned and unbanned. The check above already answered that, so
    // reaching here means the state moved between the read and the proof — somebody bound the name in
    // between — or the circuit refused for a reason the record does not carry.
    logger.warn('the bind transaction could not be built', {origin: ORIGIN, address: addressHex, error: String(error)})
    return {ok: false, failure: {kind: 'unavailable', reason: 'taken'}}
  }
  claimAt('bind')
  logger.info('bind proved on device', {origin: ORIGIN, ms: Date.now() - startedAt, bytes: tx.length})

  // The permit was watched onto the chain above, so a shortfall here is no longer the ordinary
  // first-attempt case — it means the ledger owes something this address cannot cover, and the caller
  // gets that verdict rather than a mint it does not need.
  const funded = await fundWithPermit(tx, params.permit, params.inputs)
  if (!funded.ok) return funded
  try {
    await relaySponsoredTx(funded.tx)
  } catch (error) {
    return {ok: false, failure: {kind: 'relay', detail: error instanceof Error ? error.message : String(error)}}
  }
  logger.info('handle bind relayed', {origin: ORIGIN, name: params.name, address: addressHex})
  claimAt('relaying')
  return {ok: true}
}

type FundResult =
  | {readonly ok: true; readonly tx: Uint8Array}
  | {readonly ok: false; readonly failure: HandleWriteFailure}

/**
 * Cover `bind`'s permit deficit from the permit's own address.
 *
 * The colour is never derived here: `readTxDeficits` asks the ledger what the transaction owes, which
 * is the same value the circuit asserted. One fewer hand-ported derivation to drift.
 */
const fundWithPermit = async (
  tx: Uint8Array,
  permit: {readonly nightRoleKey: Uint8Array; readonly recipient: Uint8Array; readonly address: string},
  inputs: ClaimInputs,
): Promise<FundResult> => {
  const {readTxDeficits} = await import('./midnight/fund-transaction')
  const {walletBalanceUnsealedTransaction} = await import('@pnyx/midnight-native')
  const deficits = await readTxDeficits(tx)
  if (deficits.length === 0) {
    logger.error('bind owes nothing, which means it is not spending a permit', {origin: ORIGIN})
    return {ok: false, failure: {kind: 'unavailable', reason: 'internal'}}
  }
  // Only this name's permit address is synced, not the wallet's main one — the permit is the only thing
  // that may fund this, and offering other outputs would put the main address in the transaction.
  const synced = await runMidnight(
    syncUnshieldedWallet({
      groupId: inputs.groupId,
      accountIndex: inputs.accountIndex,
      address: permit.address,
      network: inputs.networkId,
      timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
    }),
  )
  const offer = fundingCandidatesFor(synced.utxos, deficits)
  if (!offer.ok) {
    // The ordinary case on a first attempt: the mint has not landed yet. Distinguished from a real
    // shortfall only by retrying, so the message says so.
    logger.info('the permit for this name has not arrived yet', {
      origin: ORIGIN,
      address: permit.address,
      utxos: synced.utxos.length,
      caughtUp: synced.caughtUp,
      reason: offer.shortfall.reason,
    })
    return {ok: false, failure: {kind: 'unavailable', reason: 'permit-pending'}}
  }
  const funded = await walletBalanceUnsealedTransaction({
    transaction: tx,
    nightRoleKey: permit.nightRoleKey,
    candidates: offer.candidates.map((utxo) => ({
      value: utxo.value,
      tokenType: decodeHex(utxo.tokenType, 'token type'),
      intentHash: decodeHex(utxo.intentHash, 'intent hash'),
      outputIndex: utxo.outputIndex,
    })),
  })
  logger.info('bind funded from this name’s permit', {origin: ORIGIN, was: tx.length, now: funded.length})
  return {ok: true, tx: funded}
}

/** Indexer hex, or a throw. Never a zero-filled fallback: that would spend the wrong output. */
const decodeHex = (text: string, what: string): Uint8Array => {
  const decoded = hex.decode(text)
  if (decoded._tag === 'Left') throw new Error(`${what} is not hex: ${text}`)
  return decoded.right
}

/**
 * Release `handle`.
 *
 * ⚠️ Still unavailable, and now for a different reason than claiming was. `handle.compact`'s `revoke`
 * burns the name — permanently, by design, so that a released name cannot be re-registered by a
 * squatter watching for it. That is a product decision nobody has taken, so nothing here offers it.
 */
export const releaseHandle = async (handle: string, _inputs: ClaimInputs): Promise<HandleWriteResult> => {
  logger.debug('handle release refused: revoke burns the name and is not offered', {origin: ORIGIN, handle})
  return {ok: false, failure: {kind: 'unavailable', reason: 'not-offered'}}
}
