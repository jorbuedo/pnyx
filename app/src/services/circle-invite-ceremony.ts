/**
 * Hand an invite request to the one review screen, like every other producer.
 *
 * A gated circle's requirements are about a person's real Cardano wallet, so asserting one is a
 * funds-wallet signature — and `docs/SIGNING_AUDIT.md` admits no exemption for those. This registers
 * a **message leg** (`decodeSignDataPayload` of the challenge, under the reward address being
 * asserted) and returns the ticket id for the caller to navigate with; `TxReviewScreen` shows the
 * bytes, takes the confirmation, and reports the signature back through `onSigned`.
 *
 * ⚠️ **`doneHref: null` — stay where you were.** The signature is not the thing the person came for:
 * it is exchanged for an invite code that belongs in the join sheet they left open. Leaving for the
 * wallet home would strand them one screen away from the field the code lands in.
 *
 * @module
 */

import type {CardanoDataPayload, SigningRequest} from '@pnyx/signing-service'
import {Effect} from 'effect'
import {decodeSignDataPayload} from '../components/DappBrowser/sign-data-decode'
import {logger} from '../logger'
import {registerReviewTicket} from '../screens/cardano/review-handoff'
import {getCardanoRail} from './cardano/rail'
import {cardanoSigningLayer} from './cardano/signing-adapters'

const ORIGIN = 'circle-invite-ceremony'

/** What the review screen hands back: the COSE_Sign1 and the COSE_Key that verifies it. */
export type InviteSignature = {
  readonly signature: string
  readonly key: string
}

export type InviteCeremonyParams = {
  readonly groupId: string
  readonly accountIndex: number
  /** A synced address of that wallet — the rail's primary, not what gets asserted. */
  readonly addressBech32: string
  readonly request: SigningRequest & {readonly payload: CardanoDataPayload}
  /** Raw reward-address bytes, shown on the review screen as the identity being asserted. */
  readonly rewardHex: string
  readonly biometricPrompt: string
  readonly onSigned: (signature: InviteSignature) => void
  readonly onError: (error: unknown) => void
  readonly onCancel: () => void
}

/**
 * Register the ceremony and return its ticket id, or `null` when no rail can be built for the
 * wallet — which means the app has no Cardano endpoint configured, not that the wallet is at fault.
 */
export const registerInviteCeremony = async (params: InviteCeremonyParams): Promise<string | null> => {
  const pending = getCardanoRail(params.groupId, params.addressBech32, undefined, {
    accountIndex: params.accountIndex,
  })
  if (pending === null) {
    logger.warn('no Cardano rail is configured, so an invite cannot be reviewed', {
      origin: ORIGIN,
      groupId: params.groupId,
    })
    return null
  }
  const rail = await pending
  // Dynamic, so the enclave module stays off the path a cancelled request takes.
  const {createEnclaveMnemonicVault} = await import('./credential-vault')
  const vault = createEnclaveMnemonicVault()
  const signingLayer = cardanoSigningLayer(rail, {
    retrieveMnemonic: (gid) =>
      vault.retrieve(gid, params.biometricPrompt).pipe(Effect.mapError((e) => ({message: e.message}))),
    // Software only: `inviteEligibleWallets` offers no other kind, because a device will not export
    // the stake private key CIP-8 needs here.
    resolveSource: () => Effect.succeed('software'),
    resolveHardwareMeta: () => Effect.succeed(null),
  })

  return registerReviewTicket({
    legs: [
      {
        kind: 'message',
        // The decoded form, so the screen renders what the bytes prove rather than a summary.
        message: decodeSignDataPayload(params.request.payload.payloadHex),
        // The reward address, so the person sees *which* stake credential they are asserting — the
        // one thing about this signature that decides whether the circle will admit them.
        addressHex: params.rewardHex,
        // In-app action: there is no requesting site to name, and inventing one would render an
        // unverified origin the user could mistake for a third party.
        origin: null,
        requestedBy: 'app',
        request: params.request,
      },
    ],
    groupId: params.groupId,
    audit: {purpose: 'circle-invite-request', origin: null},
    signingLayer,
    titleKey: 'forum.join.reviewTitle',
    doneHref: null,
    onSettled: (results) => {
      const result = results.length === 1 ? results[0] : undefined
      if (result?._tag !== 'DataSigned') {
        params.onError(new Error(`expected one DataSigned result, got ${results.length}`))
        return
      }
      params.onSigned({signature: result.signature, key: result.key})
    },
    onError: params.onError,
    onCancel: params.onCancel,
  })
}
