/**
 * The Cardano signing layer for a review ceremony, assembled from the selected
 * wallet's signer kind.
 *
 * Every producer that pushes `/wallet/review-tx` needs the same thing: the
 * enclave vault for a software wallet, the device backend for a hardware one,
 * governance keys cached on first unlock, and `null` for a watch-only wallet so
 * the review screen can disable confirmation instead of offering a button that
 * must fail. That was written out inline in the send funnel; a second producer
 * (consolidation) makes it shared.
 *
 * `null` means the wallet genuinely cannot sign — never "we could not work it
 * out". A misconfigured wallet surfaces as an error at the call site.
 *
 * @module
 */

import type {SigningServiceTag} from '@pnyx/signing-service'
import {Effect, type Layer} from 'effect'
import {useCallback} from 'react'
import {useI18n, useWalletList} from '../providers'
import {useHardwareWallet} from '../providers/HardwareWalletProvider'
import {
  type CardanoRail,
  type CredentialStoreDeps,
  cardanoChainIdFor,
  cardanoSigningLayer,
  createCardanoHardwareBackend,
  govKeysAreCurrent,
  loadCardanoGovKeys,
  persistCardanoGovKeys,
} from '../services/cardano'
import {type KeySignerKind, signerKindOf} from '../services/cardano/signer-kind'

/** The credential kind a group signs with, or `null` when it holds none. */
const keyKindOf = (src: string | undefined): KeySignerKind | null => {
  const kind = signerKindOf(src)
  return kind === 'software' || kind === 'hardware' ? kind : null
}

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export type CardanoSigningLayerApi = {
  /**
   * How the selected wallet signs, or `null` when it cannot. `null` with a
   * `read-only` source is watch-only; `null` with any other source is a
   * configuration problem the caller must report.
   */
  readonly signerKind: ReturnType<typeof signerKindOf>
  /** The wallet's source as recorded on its primary wallet. */
  readonly source: string | undefined
  /**
   * Build the layer for a ceremony. `null` when the wallet cannot sign at all.
   *
   * `signAs` names a *different* group as the signer — the co-sign screen, where
   * the transaction belongs to a shared wallet and the signature comes from
   * whichever of its co-signers the user picked. It decides the hardware backend
   * and leaves the request untouched, because a request that names its own signer
   * must not then be redirected at another.
   */
  readonly resolveSigningLayer: (
    rail: CardanoRail,
    groupId: string,
    signAs?: {readonly groupId: string; readonly source: string | undefined},
  ) => Promise<Layer.Layer<SigningServiceTag> | null>
}

export const useCardanoSigningLayer = (): CardanoSigningLayerApi => {
  const {t} = useI18n()
  const hardware = useHardwareWallet()
  const {selectedWalletGroup, walletGroups} = useWalletList()
  const source = selectedWalletGroup?.primaryWallet.source
  const signerKind = signerKindOf(source)

  const resolveSigningLayer = useCallback(
    async (
      rail: CardanoRail,
      groupId: string,
      signAs?: {readonly groupId: string; readonly source: string | undefined},
    ): Promise<Layer.Layer<SigningServiceTag> | null> => {
      // No signer means no vault touch and no signing layer at all — never a
      // layer that would prompt for a key the wallet does not have.
      //
      // A script wallet DOES get a layer: a co-signer signs with their own
      // credential, so the ceremony is an ordinary one. What differs is the
      // request — `cardanoSigningLayer` forces it to a partial, sign-only pass
      // carrying the native scripts — and the terminal step, which the caller
      // routes to signature gathering instead of a broadcast.
      // Whose credential this ceremony actually uses. Without `signAs` that is
      // the selected wallet; with it, the co-signer the user picked — and a
      // wallet that cannot sign is refused on the group that would have signed,
      // not on the one that happens to be open.
      const effectiveKind = signAs === undefined ? signerKind : keyKindOf(signAs.source)
      if (effectiveKind === null) return null
      const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
      const vault = createEnclaveMnemonicVault()
      const govKeys = await Effect.runPromise(
        loadCardanoGovKeys(signAs?.groupId ?? groupId).pipe(Effect.orElseSucceed(() => null)),
      )
      const credentialDeps: CredentialStoreDeps = {
        retrieveMnemonic: (gid) =>
          vault.retrieve(gid, t('common.biometricPrompt')).pipe(
            Effect.tap((mnemonic) =>
              govKeysAreCurrent(govKeys)
                ? Effect.void
                : persistCardanoGovKeys(gid, mnemonic).pipe(Effect.orElseSucceed(() => null)),
            ),
            Effect.mapError((e) => ({message: e.message})),
          ),
        // Answers for the group it is *asked* about, not the selected one. A
        // script wallet's request arrives redirected at the co-signer's home
        // group, and that group's own source is what signs — assuming software
        // here would mishandle a hardware co-signer.
        resolveSource: (gid) =>
          Effect.succeed(
            gid === selectedWalletGroup?.groupId
              ? keyKindOf(source)
              : keyKindOf(walletGroups.find((g) => g.groupId === gid)?.primaryWallet?.source),
          ),
        resolveHardwareMeta: (gid) => Effect.promise(() => hardware.getMeta(gid)),
        resolveAccountXpub: () => (govKeys === null ? null : hexToBytes(govKeys.accountXpubHex)),
      }
      const hardwareBackend =
        effectiveKind === 'hardware'
          ? createCardanoHardwareBackend(hardware.getService(), cardanoChainIdFor(rail.config.network))
          : undefined
      return cardanoSigningLayer(
        rail,
        credentialDeps,
        hardwareBackend,
        signAs === undefined ? undefined : {applyAuthority: false},
      )
    },
    [signerKind, hardware, selectedWalletGroup, walletGroups, source, t],
  )

  return {signerKind, source, resolveSigningLayer}
}
