export {signerKindOf} from '../cardano/signer-kind'

import {signerKindOf, signsAlone} from '../cardano/signer-kind'

/**
 * Cardano CIP-30 signing core, shared by the mobile in-app browser
 * (`useDappConnector`) and the extension sign-host (`useExtensionSignHost`).
 *
 * Transport-agnostic: callers pass how to `answer` a request (WebView delivery
 * on mobile; a `DAPP_SIGN_DECISION` message in the extension) and how to
 * navigate to the review screen. The signing logic — review build, ceremony
 * ticket, hardware/software layer, CIP-95 backfill — is identical for both.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import type {TxHashHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address} from '@pnyx/cardano-core'
import {ApiErrorCode, DataSignErrorCode, TxSignErrorCode, type WalletResponse} from '@pnyx/dapp-connector'
import {type ResolvedInput, reviewCardanoTx} from '@pnyx/tx-review'
import {type CardanoGovKeys, utxoId} from '@pnyx/wallet'
import {Effect} from 'effect'
import {decodeSignDataPayload} from '../../components/DappBrowser/sign-data-decode'
import {logger} from '../../logger'
import type {HardwareWalletContextValue} from '../../providers/HardwareWalletProvider'
import {registerReviewTicket} from '../../screens/cardano/review-handoff'
import {
  CARDANO_PAYMENT_PATH,
  CARDANO_STAKE_PATH,
  type CredentialStoreDeps,
  cardanoChainIdFor,
  cardanoSigningLayer,
  createCardanoHardwareBackend,
  govKeysAreCurrent,
  persistCardanoGovKeys,
} from '../cardano'
import type {CardanoRail} from '../cardano/rail'
import {utxoAssetMap} from '../cardano/utxo-view'

/** The hardware-wallet capabilities the signing core needs. */
export type HardwareAccess = Pick<HardwareWalletContextValue, 'getMeta' | 'getService'>

/** Ambient signing dependencies, threaded from the React host. */
export type CardanoSigningEnv = {
  readonly hardware: HardwareAccess
  /** Localized biometric-prompt title. */
  readonly biometricPrompt: string
  /** Mutable CIP-95 gov-key cache; backfilled off the first ceremony. */
  readonly govKeysRef: {current: CardanoGovKeys | null}
}

/** Answer a resolved CIP-30 request (the full WalletResponse, id included). */
export type SignAnswer = (response: WalletResponse) => void

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const errMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const walletUtxoToResolvedInput = (utxo: UTxO.UTxO, addressHex: string): ResolvedInput => ({
  txHashHex: utxoId(utxo).split(':')[0] as TxHashHex,
  index: Number(utxo.index),
  addressHex,
  coin: utxo.assets.lovelace,
  tokens: [...utxoAssetMap(utxo)].map(([assetId, amount]) => {
    const [policyIdHex = '', assetNameHex = ''] = assetId.split('.')
    return {policyIdHex, assetNameHex, amount}
  }),
})

const resolveDataSigningPath = (rail: CardanoRail, addressHex: string): string | null => {
  try {
    const info = Address.inspect(addressHex)
    if (info.paymentCredHex === rail.account.paymentKeyHashHex) return CARDANO_PAYMENT_PATH
    if (info.stakeCredHex === rail.account.stakeKeyHashHex) return CARDANO_STAKE_PATH
    return null
  } catch (e: unknown) {
    // `null` is also "this address is not ours", the branch above — so an address we failed to
    // inspect is refused for the same reason as one that genuinely is not ours, on the path
    // that decides what a dApp can make us sign.
    logger.warn('Address could not be inspected for a signing path', {
      origin: 'dapp-signing',
      error: String(e),
    })
    return null
  }
}

const makeCredentialDeps = (env: CardanoSigningEnv, kind: 'software' | 'hardware'): CredentialStoreDeps => ({
  retrieveMnemonic: (gid) =>
    Effect.gen(function* () {
      const {createEnclaveMnemonicVault} = yield* Effect.promise(() => import('../credential-vault'))
      const mnemonic = yield* createEnclaveMnemonicVault().retrieve(gid, env.biometricPrompt)
      // Backfill CIP-95 / xpub gov keys off the same ceremony (public data).
      if (!govKeysAreCurrent(env.govKeysRef.current)) {
        const keys = yield* persistCardanoGovKeys(gid, mnemonic).pipe(Effect.orElseSucceed(() => null))
        if (keys !== null) env.govKeysRef.current = keys
      }
      return mnemonic
    }).pipe(Effect.mapError((e: {message?: string}) => ({message: e.message ?? 'vault error'}))),
  resolveSource: () => Effect.succeed(kind),
  resolveHardwareMeta: (gid) => Effect.promise(() => env.hardware.getMeta(gid)),
  resolveAccountXpub: () =>
    env.govKeysRef.current === null ? null : hexToBytes(env.govKeysRef.current.accountXpubHex),
})

/**
 * The signing layer for one rail and signer kind.
 *
 * Exported because the builder family raises the same ceremony from its own module: a build the person
 * approves is signed by the wallet that built it, and a second way of assembling this layer is a second
 * place for the hardware backend to be forgotten.
 */
export const signingLayerFor = (env: CardanoSigningEnv, rail: CardanoRail, kind: 'software' | 'hardware') =>
  cardanoSigningLayer(
    rail,
    makeCredentialDeps(env, kind),
    kind === 'hardware'
      ? createCardanoHardwareBackend(env.hardware.getService(), cardanoChainIdFor(rail.config.network))
      : undefined,
  )

/**
 * Build the review for a dApp `signTx`, register the ceremony ticket, and
 * navigate to the review screen. Answers with the witness-set hex on settle,
 * or a CIP-30 error on cancel / failure.
 */
export const runSignTx = async (params: {
  readonly rail: CardanoRail
  readonly groupId: string
  readonly source: string | undefined
  readonly env: CardanoSigningEnv
  readonly id: string
  readonly txHex: string
  readonly partialSign: boolean
  /**
   * The requesting dApp's origin, recorded in the signing audit.
   *
   * ⚠️ **Required, not optional, and that is the point.** This was missing while the audit entry below
   * already referenced `origin` — a *free identifier*, which `tsc` accepted because the RN app's `lib`
   * includes `DOM` and resolved it to `window.origin`. Hermes has no such global, so every dApp
   * `signTx` threw `Property 'origin' doesn't exist` and the dApp saw it as an InternalError. Declared
   * here so the same shape cannot come back silently.
   */
  readonly origin: string | null
  readonly answer: SignAnswer
  readonly navigateToReview: (ticketId: string) => void
}): Promise<void> => {
  const {rail, groupId, source, env, id, txHex, partialSign, origin, answer, navigateToReview} = params
  const kind = signerKindOf(source)
  // A script wallet cannot answer a connector `signTx`: the signatures belong to
  // other people, so there is nothing synchronous to return. CIP-106 replaces
  // this call with an asynchronous gather for exactly that reason; until the
  // connector speaks it, refusing is the honest answer.
  if (!signsAlone(kind)) {
    answer({id, error: {code: TxSignErrorCode.ProofGeneration, message: 'wallet cannot sign'}})
    return
  }
  try {
    const bodyHex = await Effect.runPromise(Inspect.txBodyFromTx(txHex))
    // A dApp's transaction can carry a message written *by the dApp*, which is
    // exactly the kind of thing a signer should read before approving.
    const auxHex = await Effect.runPromise(Inspect.auxFromTx(txHex))
    const spendable = await Effect.runPromise(rail.spendableUtxos)
    const resolvedInputs = spendable.map((u) => walletUtxoToResolvedInput(u, rail.account.addressHex))
    const protocolParams = await Effect.runPromise(rail.protocolParams)
    const reviewed = await Effect.runPromise(
      reviewCardanoTx(
        bodyHex,
        rail.account.walletContext,
        resolvedInputs,
        protocolParams,
        undefined,
        undefined,
        auxHex,
      ).pipe(Effect.provideService(Decode, rail.decode)),
    )
    const signingLayer = signingLayerFor(env, rail, kind)
    let answered = false
    const ticketId = registerReviewTicket({
      legs: [
        {
          reviewed,
          request: {
            groupId,
            payload: {
              _tag: 'CardanoTx',
              bodyHex,
              networkId: rail.config.networkId,
              protocolMagic: rail.config.protocolMagic,
              signOnly: true,
              partial: partialSign,
            },
          },
        },
      ],
      groupId,
      audit: {purpose: 'dapp-tx', origin},
      signingLayer,
      // Stays put: a dApp signature belongs back in the dApp's context, and the browser
      // flow that opened this is not finished when the signature lands.
      doneHref: null,
      onSettled: (results) => {
        answered = true
        // A dApp signTx is always one leg; anything else means the review screen
        // ran a ceremony this rail never asked for.
        const result = results.length === 1 ? results[0] : undefined
        if (result?._tag === 'TxSignedOnly') answer({id, result: result.witnessSetHex})
        else answer({id, error: {code: TxSignErrorCode.ProofGeneration, message: 'unexpected result'}})
      },
      onError: (error) => {
        answered = true
        answer({id, error: {code: TxSignErrorCode.ProofGeneration, message: errMessage(error)}})
      },
      onCancel: () => {
        if (answered) return
        answer({id, error: {code: TxSignErrorCode.UserDeclined, message: 'user declined'}})
      },
    })
    navigateToReview(ticketId)
  } catch (error) {
    answer({id, error: {code: ApiErrorCode.InternalError, message: errMessage(error)}})
  }
}

/**
 * Run a dApp `signData` request through the **review screen** and answer with the
 * DataSignature.
 *
 * It used to sign straight from a bottom sheet. It now registers a message leg and
 * navigates, so every dApp- or user-prompted signature goes through one review
 * surface (Phase 16 item 41; `product/STATUS.md` → "One review surface for all
 * signing"). The bytes are decoded here rather than in the screen so the screen
 * stays a renderer, and so what the user sees is provably derived from the payload
 * that will be signed.
 */
export const runSignData = async (params: {
  readonly rail: CardanoRail
  readonly groupId: string
  readonly source: string | undefined
  readonly env: CardanoSigningEnv
  readonly id: string
  readonly addressHex: string
  readonly payloadHex: string
  readonly origin: string | null
  readonly answer: SignAnswer
  readonly navigateToReview: (ticketId: string) => void
}): Promise<void> => {
  const {rail, groupId, source, env, id, addressHex, payloadHex, origin, answer, navigateToReview} = params
  const kind = signerKindOf(source)
  const signingPath = resolveDataSigningPath(rail, addressHex)
  if (signingPath === null) {
    answer({id, error: {code: DataSignErrorCode.AddressNotPK, message: 'address not owned by this wallet'}})
    return
  }
  // CIP-106 disables `signData` for a script wallet outright: a script has no key
  // to sign with, so there is no answer to give.
  if (!signsAlone(kind)) {
    answer({id, error: {code: DataSignErrorCode.ProofGeneration, message: 'wallet cannot sign'}})
    return
  }
  try {
    const signingLayer = signingLayerFor(env, rail, kind)
    let answered = false
    const ticketId = registerReviewTicket({
      legs: [
        {
          kind: 'message',
          // A request from outside the app: a dApp or a scanned payload, whoever it says it is.
          requestedBy: 'external',
          message: decodeSignDataPayload(payloadHex),
          addressHex,
          origin,
          request: {
            groupId,
            payload: {
              _tag: 'CardanoData',
              addressHex,
              payloadHex,
              signingPath,
              networkId: rail.config.networkId,
              protocolMagic: rail.config.protocolMagic,
            },
          },
        },
      ],
      groupId,
      audit: {purpose: 'dapp-message', origin},
      signingLayer,
      titleKey: 'txReview.dapp.signDataTitle',
      // Stays put: a dApp signature belongs back in the dApp's context, and the browser
      // flow that opened this is not finished when the signature lands.
      doneHref: null,
      onSettled: (results) => {
        answered = true
        // Exactly one leg: nothing batches `signData`, so more than one result
        // means the screen ran a ceremony this rail never asked for.
        const result = results.length === 1 ? results[0] : undefined
        if (result?._tag === 'DataSigned') answer({id, result: {signature: result.signature, key: result.key}})
        else answer({id, error: {code: DataSignErrorCode.ProofGeneration, message: 'unexpected result'}})
      },
      onError: (error) => {
        answered = true
        answer({id, error: {code: DataSignErrorCode.ProofGeneration, message: errMessage(error)}})
      },
      onCancel: () => {
        if (answered) return
        answer({id, error: {code: DataSignErrorCode.UserDeclined, message: 'user declined'}})
      },
    })
    navigateToReview(ticketId)
  } catch (error) {
    answer({id, error: {code: DataSignErrorCode.ProofGeneration, message: errMessage(error)}})
  }
}
