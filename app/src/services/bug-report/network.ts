/**
 * The Cardano network id a bug-report signature is made under.
 *
 * Its own module, and not a `network === 'mainnet' ? 1 : 0` at the call site, because that
 * ternary is already open-coded in several places and each copy is a chance to sign under the
 * wrong network — which produces an address the verifier will not match and a 401 with nothing
 * to explain it.
 *
 * @module
 */

import {Address} from '@pnyx/cardano-core'

/** `mainnet` → mainnet, everything else → testnet. Absent or unknown is testnet, never mainnet. */
export const cardanoNetworkId = (network: string): Address.Network =>
  network === 'mainnet' ? Address.Network.Mainnet : Address.Network.Testnet
