/**
 * App implementations of the @pnyx/signing-service ports, composed over a
 * {@link CardanoRail}: credential resolution (ceremony cache → enclave vault),
 * broadcast (rail provider), and signing-path resolution (tx-review over the
 * spendable UTxO view).
 *
 * Pending-tx registration is NOT the broadcaster's job — it lacks the change
 * outputs; send flows broadcast via `rail.submitAndTrack` and use the signing
 * service in `signOnly` mode, or register after a `TxSubmitted` result.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import type {TxHashHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import {Keys} from '@pnyx/cardano-core'
import {asMnemonic, asSecretText, type Mnemonic} from '@pnyx/crypto'
import type {HardwareWalletMeta} from '@pnyx/hardware/storage'
import {
  type Broadcaster,
  BroadcasterTag,
  type CardanoTxContext,
  CardanoTxContextTag,
  type CredentialStore,
  CredentialStoreTag,
  type HardwareBackend,
  HardwareBackendTag,
  HardwareBackendUnavailable,
  type ResolvedCredential,
  SigningBroadcastError,
  SigningCredentialError,
  SigningPayloadError,
  type SigningRequest,
  type SigningService,
  SigningServiceLayer,
  SigningServiceTag,
} from '@pnyx/signing-service'
import {type ResolvedInput, resolveCardanoSigningPaths} from '@pnyx/tx-review'
import {utxoId} from '@pnyx/wallet'
import {Context, Effect, Layer} from 'effect'
import {logger} from '../../logger'
import {getCachedMaterial, isCeremonyActive, setCachedMaterial} from '../credential-vault/ceremony-cache'
import {accountScriptContext, authorityNativeScripts, authorityStakeContext, type SpendAuthority} from './account'
import {broadcastFailureReason} from './leaked-key'
import type {CardanoRail} from './rail'
import {utxoAddressHex, utxoAssetMap} from './utxo-view'

const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** What the credential store needs from the app — structural, for testability. */
export type CredentialStoreDeps = {
  /**
   * Biometric-gated mnemonic read (fires the OS prompt on cache miss).
   *
   * Returns the branded {@link Mnemonic}, which is the point (Phase 16 item 43): only a vault
   * decrypt mints that brand, so this seam cannot be satisfied by a caller that assembled seed
   * material some other way. That is a *type* obligation on every future implementation of this
   * port, not a convention a reviewer has to remember.
   */
  readonly retrieveMnemonic: (groupId: string) => Effect.Effect<Mnemonic, {readonly message: string}>
  /** The group's source kind — `null` when the group is unknown. */
  readonly resolveSource: (groupId: string) => Effect.Effect<'software' | 'hardware' | null, never>
  /** Stored hardware metadata for hardware groups. */
  readonly resolveHardwareMeta: (groupId: string) => Effect.Effect<HardwareWalletMeta | null, never>
  /** Recorded Cardano account xpub bytes (pubkey‖chaincode), if any. */
  readonly resolveAccountXpub?: (groupId: string) => Uint8Array | null
}

/**
 * Resolve signing material. Software: ceremony-cache fast-path, else the
 * enclave vault (whose retrieve IS the biometric prompt); the mnemonic is
 * passed through byte-for-byte (no trim/normalize). Hardware: stored device
 * metadata → a HardwareCredential reference.
 */
export const createCredentialStore = (deps: CredentialStoreDeps): CredentialStore => ({
  resolve: (groupId) =>
    Effect.gen(function* () {
      const source = yield* deps.resolveSource(groupId)
      if (source === null) {
        return yield* Effect.fail(new SigningCredentialError({groupId, reason: 'unknown wallet group'}))
      }
      if (source === 'hardware') {
        const meta = yield* deps.resolveHardwareMeta(groupId)
        if (meta === null) {
          return yield* Effect.fail(new SigningCredentialError({groupId, reason: 'hardware metadata missing'}))
        }
        const xpub = deps.resolveAccountXpub?.(groupId) ?? null
        const transportHint = meta.transportHint ?? (meta.bleDeviceId !== undefined ? ('ble' as const) : undefined)
        return {
          kind: 'hardware',
          deviceType: meta.deviceType,
          ...(meta.bleDeviceId !== undefined ? {bleDeviceId: meta.bleDeviceId} : {}),
          ...(transportHint !== undefined ? {transportHint} : {}),
          ...(xpub !== null ? {accountXpubHex: bytesToHex(xpub)} : {}),
        } satisfies ResolvedCredential
      }

      const cached = isCeremonyActive(groupId) ? getCachedMaterial(groupId, 'mnemonic') : null
      // `asMnemonic` on the cache hit, not a widening to `string`: the cached value was put there by
      // a vault retrieve earlier in the same ceremony, so it has the provenance the brand asserts.
      // Letting this path fall back to bare `string` would quietly un-brand the fast path.
      const mnemonic =
        cached !== null
          ? asMnemonic(cached)
          : yield* deps
              .retrieveMnemonic(groupId)
              .pipe(Effect.mapError((e) => new SigningCredentialError({groupId, reason: e.message})))
      if (cached === null && isCeremonyActive(groupId)) setCachedMaterial(groupId, 'mnemonic', mnemonic)

      const rootXprvHex = yield* Keys.rootKeyFromMnemonic(mnemonic).pipe(
        Effect.mapError((e) => new SigningCredentialError({groupId, reason: `root key derivation: ${e.message}`})),
      )
      // The one mint of `SecretText` on the funds path, and it sits immediately after a derivation
      // whose input was a branded `Mnemonic` — so the provenance chain the brand asserts
      // (vault → Mnemonic → root xprv) is complete and checkable here rather than assumed.
      return {kind: 'software', rootXprvHex: asSecretText(rootXprvHex)} satisfies ResolvedCredential
    }),
})

/** Broadcast through the rail's provider (send flows register pending state separately). */
export const createBroadcaster = (rail: CardanoRail): Broadcaster => ({
  broadcast: (_chain, signedTxHex) =>
    rail.submit(signedTxHex).pipe(
      // ⚠️ The accepted case logs too. Only the rejection did, and "a submit that
      // was refused" and "a submit that never ran" then read identically in a
      // trail — which is how a send that had in fact landed on mainnet
      // (2026-10-07) took a chain query to confirm, because the app's own logs
      // could not say whether it had been submitted at all.
      Effect.tap((txHash) =>
        Effect.sync(() => logger.info('cardano broadcast accepted', {origin: 'createBroadcaster', txHash})),
      ),
      Effect.mapError((e) => {
        const reason = broadcastFailureReason(e)
        // The one place every rail submit failure passes through, so the node's own
        // words are recorded here rather than reconstructed from a screen's toast.
        logger.warn('cardano broadcast rejected', {origin: 'createBroadcaster', reason})
        return new SigningBroadcastError({reason, cause: e})
      }),
    ),
})

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

/**
 * The wallet's spendable view as review-resolvable inputs, **each keeping its own address**.
 *
 * ⚠️ Stamping the account's primary address on all of them was wrong twice over.
 * `resolveCardanoSigningPaths` reads the payment credential *off this field* to decide which key
 * must witness an input, so a UTxO anywhere else had its credential misreported: the extra payment
 * keys registered by `cardanoAccountFromAddress` were unreachable, and a multi-delegation address
 * (our payment key, a stake credential we do not derive) resolved to the primary's credential
 * instead of its own — costing that input its witness, silently, under `partial` signing.
 *
 * `toAddressHex` is the codec's bech32 decode, injected so this stays a pure function.
 */
export const resolvedInputsFromSpendable = (
  utxos: readonly UTxO.UTxO[],
): Effect.Effect<readonly ResolvedInput[], SigningPayloadError> =>
  Effect.forEach(utxos, (utxo) =>
    Effect.try({
      // ⚠️ The `toAddressHex` parameter is gone. Every one of the three callers passed the SAME
      // lambda — `(b) => Address.fromBech32Sync(Bech32(b))` — to undo a bech32 rendering this
      // function had just done, so the seam only ever converted a value back to what it was.
      try: () => walletUtxoToResolvedInput(utxo, utxoAddressHex(utxo)),
      // Not skipped: an input we cannot place is an input we will not witness, and a short witness
      // set is the failure mode this whole path exists to avoid.
      catch: (e) =>
        new SigningPayloadError({
          reason: `unreadable address on spendable utxo ${utxoId(utxo)}: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
    }),
  )

/** Resolve signing paths against the rail's spendable view + key registry. */
export const createCardanoTxContext = (rail: CardanoRail): CardanoTxContext => ({
  resolveSigningPaths: (bodyHex) =>
    Effect.gen(function* () {
      const spendable = yield* rail.spendableUtxos
      const resolvedInputs = yield* resolvedInputsFromSpendable(spendable)
      return yield* resolveCardanoSigningPaths(
        bodyHex,
        rail.account.keyRegistry,
        resolvedInputs,
        accountScriptContext(rail.account),
        // Passed unconditionally: resolution reads it only for a body that names
        // the stake credential, so every flow reaching this layer gets the
        // delegation right without any of them asking what it is signing.
        authorityStakeContext(rail.account.authority),
      ).pipe(
        Effect.mapError((e) => new SigningPayloadError({reason: e.message, cause: e})),
        Effect.provideService(Decode, rail.decode),
      )
    }),
})

/**
 * Force a script wallet's request into a co-signer's shape.
 *
 * A shared wallet's signature is *one of several*, so a complete signing pass
 * is not merely wrong here — it is impossible. `partial` skips the
 * witness-coverage check, which would otherwise fail because we hold one of N
 * keys; `signOnly` returns the witness set rather than assembling and
 * broadcasting a transaction that is still short of its quorum; and the native
 * scripts are what the ledger needs to validate the spend at all.
 *
 * Done here rather than in each flow, because here it cannot be forgotten: send,
 * stake, swap, consolidation, dust and the dApp bridge all reach the signing
 * service through this layer, and none of them has to know what kind of wallet
 * it is serving. A key wallet's request passes through untouched.
 */
export const applyAuthorityToRequest = (authority: SpendAuthority, request: SigningRequest): SigningRequest => {
  if (authority.kind !== 'script' || request.payload._tag !== 'CardanoTx') return request
  return {
    ...request,
    // A shared wallet holds no credential, so the vault has nothing under its
    // id. The request is redirected at the group that contributed our co-signer
    // xpub — left alone when the roster does not include us, where the ceremony
    // then fails honestly rather than reading someone else's seed.
    ...(authority.signingGroupId === null ? {} : {groupId: authority.signingGroupId}),
    payload: {
      ...request.payload,
      signOnly: true,
      partial: true,
      // Every index's script: a transaction spending two of them must carry both,
      // or phase-1 rejects the half it cannot validate.
      nativeScripts: [...(request.payload.nativeScripts ?? []), ...authorityNativeScripts(authority)],
    },
  }
}

/**
 * Wrap a signing service so every request passes through {@link applyAuthority}.
 *
 * `getSignerKind` is left alone: it reports the *credential* that signs, and a
 * co-signer still signs with their own software or hardware key.
 */
const withAuthority = (authority: SpendAuthority, service: SigningService): SigningService => ({
  sign: (request, onProgress) => service.sign(applyAuthorityToRequest(authority, request), onProgress),
  signAll: (requests, onProgress) =>
    service.signAll(
      requests.map((r) => applyAuthorityToRequest(authority, r)),
      onProgress,
    ),
  getSignerKind: service.getSignerKind,
})

/**
 * The composed signing layers for one rail. Pass `hardwareBackend` (built by
 * `createCardanoHardwareBackend` over the device service) for hardware groups;
 * omit it for software-only signing, where the unavailable stub fails any
 * hardware op with a clear error.
 */
export const cardanoSigningLayer = (
  rail: CardanoRail,
  credentialDeps: CredentialStoreDeps,
  hardwareBackend?: HardwareBackend,
  opts?: {
    /**
     * Leave requests exactly as the caller built them.
     *
     * For a request that already names its own signer, the wrapper is not a
     * safety net but an override: it would redirect the group at
     * `signingGroupId` — always the *first* co-signer we hold a key for — and
     * append native scripts the request already carries. That is what made "sign
     * as" impossible, and it is why co-signing depended on which wallet happened
     * to be selected.
     *
     * Only safe when the request is complete on its own: `signOnly`, `partial`,
     * `nativeScripts` and the signing paths all set. `partialSignRequest` is.
     */
    readonly applyAuthority?: boolean
  },
): Layer.Layer<SigningServiceTag> =>
  Layer.map(SigningServiceLayer, (ctx) =>
    Context.make(
      SigningServiceTag,
      opts?.applyAuthority === false
        ? Context.get(ctx, SigningServiceTag)
        : withAuthority(rail.account.authority, Context.get(ctx, SigningServiceTag)),
    ),
  ).pipe(
    Layer.provide(Layer.succeed(CredentialStoreTag, createCredentialStore(credentialDeps))),
    Layer.provide(
      hardwareBackend !== undefined ? Layer.succeed(HardwareBackendTag, hardwareBackend) : HardwareBackendUnavailable,
    ),
    Layer.provide(Layer.succeed(BroadcasterTag, createBroadcaster(rail))),
    Layer.provide(Layer.succeed(CardanoTxContextTag, createCardanoTxContext(rail))),
  )

export type {SigningService}
