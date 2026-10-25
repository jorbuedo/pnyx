/**
 * The credential + hardware wiring every swap-rail ceremony shares.
 *
 * Lives beside the hooks rather than in `services/cardano-swap` because it is
 * bound to `useHardwareWallet`'s shape and to the i18n `t`. The pure UTxO half
 * is in `services/cardano-swap/signing-context.ts`, which is unit-testable.
 *
 * @module
 */

import {Effect} from 'effect'
import type {useI18n} from '../providers'
import type {useHardwareWallet} from '../providers/HardwareWalletProvider'
import {
  type CredentialStoreDeps,
  cardanoChainIdFor,
  createCardanoHardwareBackend,
  govKeysAreCurrent,
  loadCardanoGovKeys,
  persistCardanoGovKeys,
} from '../services/cardano'
import type {CardanoRail} from '../services/cardano/rail'

type Hardware = ReturnType<typeof useHardwareWallet>
type Translate = ReturnType<typeof useI18n>['t']

export const credentialDepsFor = (
  kind: 'software' | 'hardware',
  hardware: Hardware,
  t: Translate,
): CredentialStoreDeps => ({
  retrieveMnemonic: (gid) =>
    Effect.gen(function* () {
      const {createEnclaveMnemonicVault} = yield* Effect.promise(() => import('../services/credential-vault'))
      const mnemonic = yield* createEnclaveMnemonicVault().retrieve(gid, t('common.biometricPrompt'))
      const govKeys = yield* loadCardanoGovKeys(gid).pipe(Effect.orElseSucceed(() => null))
      if (!govKeysAreCurrent(govKeys))
        yield* persistCardanoGovKeys(gid, mnemonic).pipe(Effect.orElseSucceed(() => null))
      return mnemonic
    }).pipe(Effect.mapError((e: {message?: string}) => ({message: e.message ?? 'vault error'}))),
  resolveSource: () => Effect.succeed(kind),
  resolveHardwareMeta: (gid) => Effect.promise(() => hardware.getMeta(gid)),
  resolveAccountXpub: () => null,
})

export const hardwareBackendFor = (rail: CardanoRail, kind: 'software' | 'hardware', hardware: Hardware) =>
  kind === 'hardware'
    ? createCardanoHardwareBackend(hardware.getService(), cardanoChainIdFor(rail.config.network))
    : undefined
