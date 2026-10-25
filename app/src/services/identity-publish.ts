/**
 * Publishing an identity row from the device (`docs/PNYX_IDENTITY_PLAN.md`).
 *
 * Separate from {@link module:./identity-row} because this is the only half that needs
 * `@pnyx/midnight-native`: `publishIdentityRow` carries a witness, so unlike `publishDmAnchor`
 * the service cannot submit it on our behalf — that would mean handing over `identitySk`. The
 * device builds a proven transaction and the service only relays it.
 *
 * @module
 */

import {decodePnyxId} from '@pnyx/contract-client/identity'
import {hex} from '@pnyx/crypto'
import {buildPublishRowProvenTx, type CircuitArtifactPaths} from '@pnyx/midnight-native'
import {logger} from '../logger'
import {ensureIdentityShell} from './identity-contract'
import {resolveIdentityRow} from './identity-row'
import {ensureCircuitArtifacts} from './pnyx-artifacts'
import {requireContractStateAt} from './pnyx-contract-state'
import {relaySponsoredTx} from './sponsored-relay'

const ORIGIN = 'identity-publish'

export type PublishRowInputs = {
  readonly artifacts: CircuitArtifactPaths
  /** Current on-chain contract state, from the service's chain read. */
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  readonly anchor: Uint8Array
  readonly authPub: Uint8Array
  /** All-zero for no `.night` claim. */
  /** Derived on the device from `forumRoot`; never sent anywhere. */
  readonly identitySk: Uint8Array
  readonly networkId: string
  /**
   * Absolute unix-second expiry of the transaction's intent — **not** a duration.
   *
   * Named for what it is because the native field it feeds is called `ttlSecs`, and passing the
   * duration the name suggests writes `Timestamp(3600)` (1970) into the intent. The chain then
   * rejects it as `Intent TTL has expired`, surfaced through the relay as a bare 502.
   */
  readonly expiresAtSecs: number
}

/** Publishing failed, and why — `proof` and `relay` fail at different layers and retry differently. */
export class IdentityPublishError extends Error {
  readonly stage: 'proof' | 'relay'
  constructor(stage: 'proof' | 'relay', message: string, cause?: unknown) {
    super(message)
    this.stage = stage
    this.cause = cause
    this.name = 'IdentityPublishError'
  }
}

/**
 * Publish or rotate this device's identity row.
 *
 * Proves on-device, then relays to `POST /register` — which is unauthenticated precisely because
 * this is what bootstraps authentication: `authPub` has to be on chain before it can back a login.
 * The service pays the fee and cannot author the transaction.
 */
export const publishIdentityRow = async (inputs: PublishRowInputs): Promise<void> => {
  let tx: Uint8Array
  try {
    // `ttlSecs` is the native field's name; the value is the absolute expiry, not a duration.
    const {expiresAtSecs, ...rest} = inputs
    tx = await buildPublishRowProvenTx({...rest, ttlSecs: expiresAtSecs})
  } catch (error) {
    throw new IdentityPublishError('proof', 'failed to build the proven identity transaction', error)
  }
  try {
    await relaySponsoredTx(tx)
  } catch (error) {
    throw new IdentityPublishError('relay', error instanceof Error ? error.message : String(error), error)
  }
}

/**
 * Make sure this identity has a published row, so it can log in.
 *
 * Registration must precede the *first* login rather than follow it, because login reads `authPub`
 * from the row — the reverse order deadlocks. `/register` is unauthenticated for exactly this
 * reason, and safe because the transaction is proven on this device and the service can only relay
 * it (docs/PNYX_IDENTITY_PLAN.md → Bootstrap).
 *
 * Idempotent by construction: the row is keyed by `C`, so re-publishing overwrites our own row
 * rather than appending. Returns `false` when registration is impossible on this build — no chain,
 * no artifacts, or no native prover — which the caller must surface rather than retry blindly.
 */
export const ensureIdentityRegistered = async (input: {
  readonly identity: string
  readonly anchor: Uint8Array
  readonly authPub: Uint8Array
  readonly identitySk: Uint8Array
  readonly networkId: string
  /** Absolute unix-second expiry — see {@link PublishRowInputs.expiresAtSecs}. */
  readonly expiresAtSecs: number
}): Promise<boolean> => {
  // ⚠️ The shell before the row lookup, not after. A contract that is not deployed reads as
  // `unavailable` — the indexer cannot tell "nothing there" from "could not ask" — and `unavailable` is
  // the one answer that must never be published on top of. Checking deployment first is what stops a
  // brand-new identity from refusing to register for ever, and it costs the same marker query the row
  // read pays anyway.
  const shell = await ensureIdentityShell({
    c: decodePnyxId(input.identity).identity,
    networkId: input.networkId,
    expiresAtSecs: input.expiresAtSecs,
  })
  if (shell.kind !== 'deployed') {
    logger.info('registration is waiting for this identity’s own contract', {
      origin: ORIGIN,
      address: hex.encode(shell.address),
      state: shell.kind,
      ...(shell.kind === 'unknown' ? {reason: shell.reason} : {}),
    })
    return false
  }

  const lookupStartedAt = Date.now()
  const existing = await resolveIdentityRow(input.identity)
  if (existing.kind === 'row') {
    // The path the registration cache exists to skip. Logged so the saving is measurable rather than
    // asserted: this is the marker query + ledger read + native decode a returning login used to pay.
    logger.debug('identity row already on chain', {origin: ORIGIN, lookupMs: Date.now() - lookupStartedAt})
    return true
  }
  // `unavailable` means the state could not be read; publishing on top of that would spend a proof
  // against state we never saw.
  if (existing.kind === 'unavailable') {
    logger.warn('registration skipped: this identity’s contract state was unreadable', {origin: ORIGIN})
    return false
  }

  // Each `false` below is logged with its reason. Registration is the precondition for login, so an
  // unexplained skip surfaces later as "identity has not been registered" with nothing behind it.
  let state: Uint8Array
  try {
    // From an indexer, not our service: registration is the one call a brand-new identity makes, and
    // it has no reason to ask a backend for a public ledger it can read itself.
    state = await requireContractStateAt(hex.encode(shell.address))
  } catch (error) {
    logger.warn('registration skipped: contract state unreachable', {origin: ORIGIN, error: String(error)})
    return false
  }

  const artifactsStartedAt = Date.now()
  // `publishRow`, not `publishIdentityRow`: the entry point was renamed with the per-identity contract
  // and the old name is not in the manifest — a stale name here fetches nothing and reads as an
  // artifact outage.
  const artifacts = await ensureCircuitArtifacts('publishRow', 'identity')
  const artifactsMs = Date.now() - artifactsStartedAt

  // Timed and logged because a *successful* registration used to say nothing at all: the only trace
  // was a gap in the log where on-device proving had happened, so how long it costs on real hardware
  // was never actually measured (an estimate read off that gap turned out to be the app waiting for a
  // button press). Split from the artifact fetch, which is cached after the first run and would
  // otherwise be indistinguishable from proving.
  const provingStartedAt = Date.now()
  await publishIdentityRow({
    artifacts,
    contractState: state,
    contractAddress: shell.address,
    anchor: input.anchor,
    authPub: input.authPub,
    identitySk: input.identitySk,
    networkId: input.networkId,
    expiresAtSecs: input.expiresAtSecs,
  })
  logger.info('identity row published', {
    origin: ORIGIN,
    identity: input.identity,
    provingMs: Date.now() - provingStartedAt,
    artifactsMs,
    stateBytes: state.length,
  })
  return true
}
