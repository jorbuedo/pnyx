/**
 * Whether the app may talk to a chain on a network at all.
 *
 * The control plane publishes a `(chain, network)` matrix; this module is the one rule that reads
 * it. The question it answers is not "is this network healthy" — nothing here probes anything — but
 * "has the fleet been told to stop using this pair".
 *
 * | remote entry            | usable | why |
 * |-------------------------|--------|-----|
 * | absent                  | yes    | no opinion published, keep working |
 * | `{}`                    | yes    | an entry carrying only endpoints is not a shutdown |
 * | `{enabled: true}`       | yes    | explicit, same as absent |
 * | `{enabled: false}`      | **no** | the only thing that takes a network away |
 *
 * **Fail open, always.** A remote config that fails to fetch, parses to nothing, or arrives in a
 * shape a future version writes and this build does not understand, leaves every pair usable. The
 * alternative — defaulting to unusable — turns one bad deploy of a JSON file into a fleet of
 * wallets that cannot reach any chain, which is a worse outcome than the one this mechanism exists
 * to fix.
 *
 * @module
 */

import type {RemoteChain, RemoteNetworkName, RemoteNetworksConfig} from '@pnyx/config'
import type {Network} from '@pnyx/wallet'

export type ChainAvailability = {
  /** Whether the app may use this chain on this network. */
  readonly usable: boolean
  /**
   * Why not, as a key suffix under `settings.endpoints.reason.*`, or `null` when usable.
   *
   * Carried even when the control plane supplied none, in which case it is `'unspecified'`: a
   * network that vanished without a stated reason still has to say something to the person holding
   * the phone.
   */
  readonly reasonCode: string | null
}

const USABLE: ChainAvailability = {usable: true, reasonCode: null}

/** What the control plane says about one pair. See the table in the module doc. */
export const chainAvailability = (
  rules: RemoteNetworksConfig | undefined,
  chain: RemoteChain,
  network: Network,
): ChainAvailability => {
  const rule = rules?.[chain]?.[network as RemoteNetworkName]
  if (rule?.enabled !== false) return USABLE
  const reasonCode = rule.reasonCode
  return {usable: false, reasonCode: reasonCode !== undefined && reasonCode !== '' ? reasonCode : 'unspecified'}
}

/** Shorthand for the common gate. */
export const isChainUsable = (rules: RemoteNetworksConfig | undefined, chain: RemoteChain, network: Network): boolean =>
  chainAvailability(rules, chain, network).usable

/**
 * The networks still usable for a chain, in the order given.
 *
 * Returns an empty array when the control plane has shut every one down. Callers must handle that
 * rather than index into it: "every network is off" is a state the control plane can legitimately
 * express, and the app's answer is to say so, not to pick one anyway.
 */
export const usableNetworks = (
  rules: RemoteNetworksConfig | undefined,
  chain: RemoteChain,
  networks: readonly Network[],
): readonly Network[] => networks.filter((network) => isChainUsable(rules, chain, network))

/**
 * The endpoints the control plane published for a Midnight network, if any.
 *
 * Returned even when the pair is disabled: the settings screen shows what the fleet default *is*
 * alongside the fact that the network is off, which is more useful than a blank row.
 */
export const remoteMidnightEndpoints = (rules: RemoteNetworksConfig | undefined, network: Network) =>
  rules?.midnight?.[network as RemoteNetworkName]?.endpoints

/**
 * The SteelSwap API base the control plane published, or `undefined` for "use the build's own".
 *
 * Read from the `mainnet` entry whatever network the wallet is on: SteelSwap serves mainnet DEX
 * data only, and the app gates swaps to mainnet, so a per-network steer here would be a knob with
 * nothing behind it.
 */
export const remoteCardanoSwapApi = (rules: RemoteNetworksConfig | undefined): string | undefined =>
  rules?.cardano?.mainnet?.endpoints?.swapApi
