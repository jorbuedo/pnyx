/**
 * Small protobuf shape translators for the Trezor Cardano transport layer.
 *
 * Lives in its own module so the pure transformations are unit-testable
 * without pulling `device.ts` (which carries the full transport surface).
 *
 * @module
 */

import {parseDerivationPath} from '../utils'

/**
 * Translate a converter-level `TrezorCardanoAddressParams` (camelCase fields,
 * string paths, plus `networkId` / `protocolMagic` for the outer message) to
 * the wire shape of `CardanoAddressParametersType`.
 *
 * The reflection-based protobuf encoder reads fields by their proto name
 * (`address_type`, `address_n`, `address_n_staking` — snake_case, uint32
 * arrays). Passing the original camelCase shape would silently emit an empty
 * `address_n` and produce a tx body hash divergent from the host's bech32.
 *
 * `networkId` / `protocolMagic` are intentionally dropped here — they live on
 * `CardanoSignTxInit`, not on the per-output address params.
 */
export const toProtoAddressParams = (params: {
  readonly addressType: number
  readonly spendingPath: string
  readonly stakingPath?: string
  readonly stakingKeyHash?: string
  readonly stakingScriptHash?: string
}): Record<string, unknown> => ({
  address_type: params.addressType,
  address_n: parseDerivationPath(params.spendingPath),
  ...(params.stakingPath ? {address_n_staking: parseDerivationPath(params.stakingPath)} : {}),
  ...(params.stakingKeyHash ? {staking_key_hash: params.stakingKeyHash} : {}),
  ...(params.stakingScriptHash ? {script_staking_hash: params.stakingScriptHash} : {}),
})
