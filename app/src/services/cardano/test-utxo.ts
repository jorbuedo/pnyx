/**
 * UTxO fixtures for tests, beside {@link ./test-provider} and for the same reason.
 *
 * ⚠️ **Evolution's `UTxO` validates on construction**, so a fixture cannot be an object literal any
 * more — and that is the point. `addr_test1demo`, `TxHashHex('aa')` and a zero-quantity token were
 * all constructible under the old wallet-shaped type and none of them is a value a chain can
 * produce. One builder here means a test states the case it cares about and borrows a real address
 * for the rest, rather than inventing one that decodes to nothing.
 *
 * @module
 */

import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, UTxO} from '@evolution-sdk/evolution'
import {TEST_ADDRESS} from './test-addresses.js'

export {TEST_ADDRESS, TEST_ADDRESSES} from './test-addresses.js'

/**
 * A UTxO. `txHash` takes either a 64-char hex string or a single byte to fill 32 with, because
 * tests overwhelmingly want "some distinct hash" rather than a specific one.
 */
export const testUtxo = (params: {
  readonly txHash: string | number
  readonly index?: number
  readonly address?: string
  readonly lovelace: bigint
  /** `policy.name` → quantity, the dotted spelling the app keys on. */
  readonly assets?: ReadonlyMap<string, bigint>
}): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(
      typeof params.txHash === 'number'
        ? params.txHash.toString(16).padStart(2, '0').repeat(32)
        : params.txHash.padEnd(64, '0'),
    ),
    index: BigInt(params.index ?? 0),
    address: EvolutionAddress.fromBech32(params.address ?? TEST_ADDRESS),
    assets: [...(params.assets ?? new Map())].reduce((bag, [id, quantity]) => {
      const [policy = '', name = ''] = id.split('.')
      return EvAssets.addByHex(bag, policy, name, quantity)
    }, EvAssets.fromLovelace(params.lovelace)),
  })
