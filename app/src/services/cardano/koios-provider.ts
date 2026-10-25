/**
 * The Koios-backed chain provider, and the request budget we hold Koios to.
 *
 * Evolution's `KoiosProvider.Koios` answers every member the wallet asks for, so there is
 * nothing to adapt here: this builds that client and publishes its `ProviderEffect`. What is
 * ours rather than theirs is the pacing POLICY below, the per-request timeout we hold it to, and
 * the conventions beside it ({@link ./await-confirmations} for depth, {@link ./provider-error} for
 * a readable failure).
 *
 * @module
 */

import {KoiosProvider, Provider, RequestBudget} from '@evolution-sdk/evolution'
import {Layer} from 'effect'

export type KoiosNetwork = 'mainnet' | 'preprod' | 'preview'

const KOIOS_URL: Record<KoiosNetwork, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
}

/**
 * Koios's published allowance is 100 requests per 10 seconds, on the public and the free-key
 * tiers alike.
 *
 * ⚠️ The margin is under the ceiling on purpose. The window is enforced on the server's clock,
 * and a request in flight is already counted there while it is still pending here, so pacing to
 * exactly 100 rides the edge and loses.
 *
 * ⚠️ Pacing is opt-in per host: a provider that never calls `RequestBudget.configure` is counted
 * and never held back, which is the one state that looks metered and is not. A gap scan or a
 * history backfill spends 100 requests in a couple of seconds.
 */
export const KOIOS_REQUEST_BUDGET = {limit: 90, windowMs: 10_000} as const

/**
 * Per-request ceiling for a Koios read, raised from Evolution's 10-second default.
 *
 * ⚠️ **A judgement, not a measurement.** `/address_info` for a busy address measured 764 KB, and
 * 10 seconds needs ~76 KB/s sustained to finish it — inside a phone's reach on wifi, outside it on
 * a weak mobile link, where the read fails as a `ProviderError` and the balance screen has nothing
 * to show. 30 seconds needs ~25 KB/s. What it buys is a longer wait before the same typed failure;
 * what it costs is that a genuinely dead link takes three times as long to say so.
 *
 * ⚠️ Deliberately **not** the app's other `*_TIMEOUT_MS` of 15 s (`pnyx-artifacts`,
 * `pnyx-session`). Those bound a small JSON manifest and a sign-in handshake; copying their number
 * here would be copying a convention set for a different payload size.
 *
 * ⚠️ It is a ceiling on ONE request, not on an operation: a paged read — `getAccountUtxos`,
 * `getUtxosByPaymentCredential(s)`, the history walk — spends it per page, so a large answer is
 * not refused for being large. That placement is why those reads could be given a timeout at all;
 * before 2026-10-10 they had none and `getUtxos` over a credential bounded its whole walk.
 */
export const KOIOS_REQUEST_TIMEOUT_MS = 30_000

/** The default endpoint for a network, for a caller with no first-party URL configured. */
export const koiosUrlFor = (network: KoiosNetwork): string => KOIOS_URL[network]

/**
 * The Koios provider for a network, as a layer.
 *
 * Pass `baseUrl` to point at a first-party or self-hosted deployment, which production must do:
 * the public instances are rate-limited and outside our operational control.
 *
 * `authToken` is a getter, not a string, so a token minted or refreshed after this layer was
 * built is still picked up. A token bound for a plain-http endpoint is refused by Evolution's
 * request layer before the request goes out, so it is not re-checked here.
 */
export const koiosProviderLayer = (
  network: KoiosNetwork,
  baseUrl?: string,
  authToken?: () => string | undefined,
): Layer.Layer<Provider.ProviderEffect> => {
  const base = baseUrl ?? KOIOS_URL[network]
  RequestBudget.configure(base, KOIOS_REQUEST_BUDGET)
  return Layer.succeed(
    Provider.ProviderEffect,
    new KoiosProvider.Koios(base, authToken, {requestTimeoutMs: KOIOS_REQUEST_TIMEOUT_MS}).effect,
  )
}
