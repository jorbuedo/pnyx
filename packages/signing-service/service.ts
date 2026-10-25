/**
 * The signing service — one boundary that turns a `SigningRequest` into
 * witnesses / a broadcast tx, dispatching on the payload's chain arm and the
 * group's credential kind. `signAll` runs dependent legs sequentially
 * (stop-on-failure, no rollback) — the "tx chaining" primitive; wrap the whole
 * call in ONE credential-vault ceremony so the user authenticates once.
 *
 * @module
 */

import {Context, Effect, Layer} from 'effect'
import {type ProgressFn, signCardanoData, signCardanoTx} from './cardano.js'
import {BroadcasterTag, CardanoTxContextTag, CredentialStoreTag, HardwareBackendTag} from './ports.js'
import type {SignerKind, SigningCredentialError, SigningError, SigningRequest, SigningSuccess} from './types.js'
import {SigningSequenceError} from './types.js'

/** Progress callback for `signAll` — `index` identifies the leg. */
export type SequenceProgressFn = (progress: Parameters<ProgressFn>[0], index: number) => void

export type SigningService = {
  readonly sign: (request: SigningRequest, onProgress?: ProgressFn) => Effect.Effect<SigningSuccess, SigningError>
  /**
   * Sign (and broadcast, per-payload) several requests strictly in order —
   * later legs may depend on earlier broadcasts. Stops at the first failure;
   * already-broadcast legs stay broadcast (the error carries them).
   */
  readonly signAll: (
    requests: readonly SigningRequest[],
    onProgress?: SequenceProgressFn,
  ) => Effect.Effect<readonly SigningSuccess[], SigningSequenceError>
  /** Which credential kind signs for this group (drives review-UI affordances). */
  readonly getSignerKind: (groupId: string) => Effect.Effect<SignerKind, SigningCredentialError>
}

export class SigningServiceTag extends Context.Tag('@pnyx/signing-service/SigningService')<
  SigningServiceTag,
  SigningService
>() {}

/**
 * Live layer — capture the ports once, dispatch per payload `_tag`. New chains
 * add a payload member + an arm here; the ports stay untouched.
 */
export const SigningServiceLayer: Layer.Layer<
  SigningServiceTag,
  never,
  CredentialStoreTag | HardwareBackendTag | BroadcasterTag | CardanoTxContextTag
> = Layer.effect(
  SigningServiceTag,
  Effect.gen(function* () {
    const deps = {
      credentials: yield* CredentialStoreTag,
      hardware: yield* HardwareBackendTag,
      broadcaster: yield* BroadcasterTag,
      txContext: yield* CardanoTxContextTag,
    }

    const sign: SigningService['sign'] = (request, onProgress) => {
      switch (request.payload._tag) {
        case 'CardanoTx':
          return signCardanoTx(deps, request, request.payload, onProgress)
        case 'CardanoData':
          return signCardanoData(deps, request, request.payload, onProgress)
      }
    }

    const signAll: SigningService['signAll'] = (requests, onProgress) =>
      Effect.gen(function* () {
        const completed: SigningSuccess[] = []
        for (let i = 0; i < requests.length; i++) {
          const request = requests[i]
          if (request === undefined) continue
          const result = yield* sign(request, onProgress ? (p) => onProgress(p, i) : undefined).pipe(
            Effect.mapError(
              (failure) => new SigningSequenceError({completed: [...completed], failedIndex: i, failure}),
            ),
          )
          completed.push(result)
        }
        return completed
      })

    const getSignerKind: SigningService['getSignerKind'] = (groupId) =>
      Effect.map(deps.credentials.resolve(groupId), (credential) => credential.kind)

    return {sign, signAll, getSignerKind} satisfies SigningService
  }),
)
