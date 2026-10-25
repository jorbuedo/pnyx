/**
 * Midnight block-explorer links, per network.
 *
 * Approved for use by Jordi (2026-08-20). It is a third-party service (Tech-Expansion), not Midnight's own
 * infrastructure like the indexer in `./networks.ts` — so it is used for *links the user opens*, never as a
 * data source. Nothing in the app reads from it.
 *
 * ⚠️ **The network is baked into each deployment**, not passed as a parameter: the app is built with
 * `NEXT_PUBLIC_NETWORK` and talks to a matching backend, so `www` is mainnet-only and each test network has
 * its own host. Pointing a preprod hash at `www` would render "not found" and read as a lost transaction.
 *
 * Paths are the app's own route templates (`/transactions/${hash}`, `/address/${addr}`,
 * `/contracts/${addr}`, `/blocks/${n}`), read out of its bundle rather than guessed.
 *
 * @module
 */

const HOST: Readonly<Record<string, string>> = {
  mainnet: 'https://www.midnightexplorer.com',
  preprod: 'https://preprod.midnightexplorer.com',
  preview: 'https://preview.midnightexplorer.com',
}

/**
 * The explorer host for `network`, or `null` when we know of none — `undeployed` (a local chain nothing
 * public can see) and any name we do not recognise. `null` means the caller shows no link, which is the
 * honest answer; a link to the wrong network's explorer is worse than no link.
 */
export const midnightExplorerHost = (network: string | null): string | null =>
  network === null ? null : (HOST[network] ?? null)

const url = (network: string | null, path: string): string | null => {
  const host = midnightExplorerHost(network)
  return host === null ? null : `${host}${path}`
}

/** A transaction page, by hash. */
export const midnightExplorerTxUrl = (network: string | null, hash: string): string | null =>
  hash === '' ? null : url(network, `/transactions/${hash}`)

/**
 * An address page.
 *
 * ⚠️ Only meaningful for an **unshielded** address. A shielded address has no on-chain presence to browse —
 * that is the point of it — and a DUST address is a registration target, not a ledger account. Callers pass
 * the unshielded one or nothing.
 */
export const midnightExplorerAddressUrl = (network: string | null, address: string): string | null =>
  address === '' ? null : url(network, `/address/${address}`)

/** A contract page, by contract address. */
export const midnightExplorerContractUrl = (network: string | null, address: string): string | null =>
  address === '' ? null : url(network, `/contracts/${address}`)

/** A block page, by height. */
export const midnightExplorerBlockUrl = (network: string | null, height: number): string | null =>
  Number.isSafeInteger(height) && height >= 0 ? url(network, `/blocks/${height}`) : null

/** The name shown on a "view on …" affordance. */
export const MIDNIGHT_EXPLORER_NAME = 'Midnight Explorer'
