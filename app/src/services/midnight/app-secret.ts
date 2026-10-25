/**
 * Deriving the per-site secret behind the connector's `deriveAppSecret`.
 *
 * HKDF-SHA-256 over the **Metadata** role key, salted and info'd with the constants in
 * `@pnyx/dapp-connector`'s `app-secret` module — Moth's vendor-neutral v1, so the same seed yields the
 * same secret in any wallet that implements the method. A dApp's per-user secret has to survive the
 * user changing wallets, which is the only reason the constants are somebody else's.
 *
 * ⚠️ **Role 4 (Metadata) on purpose.** It is non-spending: elsewhere it derives only a public identity
 * address, so a leaked app secret cannot expose the seed, the unshielded signing key, or the Zswap and
 * DUST spend keys. HKDF is one-way over it, so the secret is also uncorrelatable with that public
 * address. Deriving from a *spending* role would make one leaked secret a wallet-draining event.
 *
 * ⚠️ **`origin` is the wallet's, from the approved session.** Never a parameter — that binding is what
 * stops one site asking for another site's secret. The caller here is the connector host, which has it
 * from the request that arrived.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex, hkdfSha256} from '@pnyx/crypto'
import {APP_SECRET_LENGTH, appSecretInfo, appSecretSalt} from '@pnyx/dapp-connector'
import {deriveMidnightRoleKey} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {logger} from '../../logger'

const ORIGIN = 'midnight-app-secret'

export type DeriveAppSecretParams = {
  readonly groupId: string
  readonly accountIndex: number
  /** The requesting page, taken from the session — see the module note. */
  readonly origin: string
  /** The dApp's label, already validated as short printable ASCII by the connector. */
  readonly domain: string
  readonly biometricPrompt: string
}

/**
 * Derive the 32-byte secret for one `(wallet, origin, domain)`, hex-encoded.
 *
 * Throws if the vault refuses — which is the user declining, and must reach the dApp as a refusal
 * rather than as a secret nobody authorised.
 */
export const deriveAppSecret = async (params: DeriveAppSecretParams): Promise<string> => {
  const {createEnclaveMnemonicVault} = await import('../credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  const metadataKey = await Effect.runPromise(
    deriveMidnightRoleKey(seed, Roles.Metadata, {account: params.accountIndex}),
  )
  const secret = await Effect.runPromise(
    hkdfSha256(metadataKey, appSecretInfo(params.origin, params.domain), APP_SECRET_LENGTH, appSecretSalt()),
  )
  // The domain and origin, never the secret: this log exists to show the derivation happened for the
  // site that asked, and a secret in a log file is the secret leaking.
  logger.info('derived an app secret for a dApp', {origin: ORIGIN, dapp: params.origin, domain: params.domain})
  return hex.encode(secret)
}
