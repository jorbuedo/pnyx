/**
 * Warm the SteelSwap CIP-8 durable key from the Pnyx identity.
 *
 * SteelSwap's `/api/v2/*` pricing needs a bearer key; the anon path is
 * Turnstile-gated, so we mint a durable key via CIP-8. The signing credential
 * is the identity's own Cardano payment key (CIP-1852 account 0, external
 * role) — the same identity-seed pattern `koios-register.ts` uses, so it works
 * even when the active funds wallet is read-only. The minted key is app-global
 * pricing auth, persisted and reused across every wallet.
 *
 * Best-effort and at most once per process; a failure just leaves pricing
 * unauthenticated (callers already degrade to absent, never a fabricated price).
 *
 * @module
 */

import {XprvHex} from '@evolution-sdk/review/Brands'
import {Address, Cose, Keys} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import {identityPaymentXprv} from '../identity-role-keys'
import {recordInfraSignature} from '../signing-audit'
import type {CardanoAssetsConfig} from './config'
import {getSteelswapKey, type SteelswapSigner, setSteelswapKeyStore, setSteelswapSigner} from './steelswap-auth'
import type {FetchLike} from './token-metadata'

/** Identity's CIP-1852 account used to sign the SteelSwap challenge (funds untouched). */
const SIGNING_ACCOUNT = 0

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>

// Persist the durable key via platform storage (mirrors the Koios JWT store).
// Bound here — not in `steelswap-auth` — so that module stays free of the
// `react-native-mmkv` coupling and unit-testable.
setSteelswapKeyStore({
  get: (key) => storage.get(key),
  set: (key, value) => storage.set(key, value).then(() => undefined),
  remove: (key) => storage.remove(key).then(() => undefined),
})

// One warm attempt per process — avoids re-deriving/minting on every rail build.
let attempted = false

/** SteelSwap serves mainnet Cardano data only; network id for the signing address. */
const networkIdOf = (network: string): Address.Network => (network === 'mainnet' ? 1 : 0)

/**
 * DEV-ONLY throwaway signing seed for web testing, where the identity vault
 * (react-native-keychain) is unavailable. Stripped from production builds via
 * the `__DEV__` gate below. Signs only the SteelSwap pricing challenge (public
 * market-data auth) with a disposable address — never touches funds.
 */
const DEV_SIGNING_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'

/**
 * The identity's derived payment key — from the session cache, so a renewal does
 * not re-read the vault (Phase 16 item 42) — or, only in `__DEV__` when the
 * enclave vault can't be read (web has no keychain), one derived from a
 * disposable dev seed so the CIP-8 flow can be exercised in the browser.
 * Rethrows in production.
 *
 * The dev key is derived on the spot and deliberately **not** cached: it is
 * throwaway, and putting it in the identity cache would blur which key a later
 * reader is looking at.
 */
const signingPaymentXprv = async (): Promise<string> => {
  try {
    return await identityPaymentXprv(SIGNING_ACCOUNT)
  } catch (e) {
    if (!__DEV__) throw e
    logger.warn('SteelSwap CIP-8: identity vault unavailable — using DEV signing seed (web testing only)', {
      origin: 'SteelswapRegister',
    })
    return Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* Keys.rootKeyFromMnemonic(DEV_SIGNING_MNEMONIC)
        return yield* Keys.deriveCip1852(root, SIGNING_ACCOUNT, 0, 0)
      }),
    )
  }
}

/**
 * Derive the identity's Cardano payment key and build a {@link SteelswapSigner}:
 * its bech32 enterprise address + a `sign(payloadHex)` that CIP-8 / COSESign1
 * signs with that key. Pure crypto over the identity seed — no network.
 */
const buildIdentitySigner = (
  paymentXprvHex: string,
  networkId: Address.Network,
): Effect.Effect<SteelswapSigner, unknown> =>
  Effect.gen(function* () {
    const paymentKeyHashHex = yield* Keys.keyHashOf(XprvHex(paymentXprvHex))
    const addressHex = Address.enterpriseHex(networkId, paymentKeyHashHex)
    const addressBech32 = yield* Address.toBech32(addressHex)
    return {
      addressBech32,
      sign: async (payloadHex: string) => {
        const sig = await Effect.runPromise(Cose.signData(XprvHex(paymentXprvHex), addressHex, payloadHex, true))
        // The signer is handed to `steelswap-auth`, which mints the durable key with it; recording
        // here rather than there is what keeps the entry next to the actual signature.
        void recordInfraSignature({
          purpose: 'steelswap-register',
          payloadHex,
          signer: addressHex,
          signerKind: 'cardano-address-hex',
        })
        return sig
      },
    }
  })

/**
 * Register the identity signer and warm the durable key, once per process.
 * Fire-and-forget from rail setup — a failure leaves pricing unauthenticated.
 */
export const ensureSteelswapKey = (config: CardanoAssetsConfig): void => {
  if (attempted) return
  // Nothing to warm, and nothing that *could* warm: the endpoint holds the credential, so building
  // a signer and minting a CIP-8 key would derive a CIP-1852 key (14.8 s of a 61 s boot, measured)
  // for a key no request ever sends. On a testnet the mint cannot succeed anyway.
  if (config.steelswapKeyInjectedByEndpoint) {
    logger.info('SteelSwap credential is injected by the endpoint; no CIP-8 key needed', {
      origin: 'SteelswapRegister',
      network: config.network,
    })
    attempted = true
    return
  }
  attempted = true
  void (async () => {
    try {
      // ⚠️ **Registered as a thunk, not built here.** Building it reads the identity
      // vault and derives a CIP-1852 key — PBKDF2 in JS, measured at **14.8 s of a 61 s
      // boot** on a device, on the one thread everything else needs. The durable key is
      // persisted, so every launch after the first answers from storage and never needs
      // a signer at all; this used to pay for one regardless and then throw it away.
      setSteelswapSigner(async () => {
        const paymentXprvHex = await signingPaymentXprv()
        return Effect.runPromise(buildIdentitySigner(paymentXprvHex, networkIdOf(config.network)))
      })
      // Warm the durable key so the first pricing request doesn't pay the mint latency.
      // A hit costs a storage read; only a miss reaches the thunk above.
      await Effect.runPromise(
        getSteelswapKey(config, defaultFetch).pipe(
          Effect.catchAll((e) => {
            logger.warn('SteelSwap key warm-up failed; the first pricing request pays the mint', {
              origin: 'SteelswapRegister',
              network: config.network,
              error: String(e),
            })
            return Effect.succeed('')
          }),
        ),
      )
      logger.info('SteelSwap CIP-8 durable key ready', {origin: 'SteelswapRegister', network: config.network})
    } catch (e) {
      logger.warn('SteelSwap CIP-8 key warm failed (pricing may be unauthenticated)', {
        origin: 'SteelswapRegister',
        error: String(e),
      })
    }
  })()
}
