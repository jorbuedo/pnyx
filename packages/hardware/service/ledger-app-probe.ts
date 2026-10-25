import {BITCOIN_CASH_MAINNET, BITCOIN_MAINNET, type ChainId, DOGECOIN_MAINNET, LITECOIN_MAINNET} from '@pnyx/config'
import {Duration, Effect} from 'effect'

import {getAddressPath} from '../derivation/service-paths'
import {getAppForChain} from '../ledger/chains'
import {type ChainAppType, type HardwareDevice, HardwareError, type HardwareErrorType} from '../types'

// Probes are pre-sign liveness checks, not user-approval APDUs. The probe
// either gets a response within a couple of seconds on a healthy BLE
// notify channel or never returns at all on a half-open one. Cap the wait
// short so the ensureApp recovery path (force disconnect + reconnect)
// fires quickly instead of letting the user stare at "Reconnecting…" for
// 10+ seconds.
const PROBE_TIMEOUT_MS = 2_000

const withProbeTimeout = <A>(effect: Effect.Effect<A, HardwareErrorType>): Effect.Effect<A, HardwareErrorType> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(PROBE_TIMEOUT_MS),
      onTimeout: () => new HardwareError({message: 'Ledger app probe timed out'}),
    }),
  )

type BitcoinFamilyAppType = Extract<ChainAppType, 'bitcoin' | 'litecoin' | 'dogecoin' | 'bitcoin-cash'>

const getChainForBtcFamily = (chainId: ChainId): BitcoinFamilyAppType | null => {
  switch (chainId) {
    case BITCOIN_MAINNET:
      return 'bitcoin'
    case LITECOIN_MAINNET:
      return 'litecoin'
    case DOGECOIN_MAINNET:
      return 'dogecoin'
    case BITCOIN_CASH_MAINNET:
      return 'bitcoin-cash'
    default:
      return null
  }
}

type ConfigProbeApp = {
  readonly getAppConfiguration: () => Effect.Effect<unknown, HardwareErrorType>
}

type AddressProbeApp = {
  readonly getAddress: (path: string, verify?: boolean) => Effect.Effect<unknown, HardwareErrorType>
}

const hasGetAppConfiguration = (value: unknown): value is ConfigProbeApp =>
  typeof value === 'object' &&
  value !== null &&
  'getAppConfiguration' in value &&
  typeof (value as {getAppConfiguration?: unknown}).getAppConfiguration === 'function'

const hasGetAddress = (value: unknown): value is AddressProbeApp =>
  typeof value === 'object' &&
  value !== null &&
  'getAddress' in value &&
  typeof (value as {getAddress?: unknown}).getAddress === 'function'

const probeAppConfiguration = (
  device: HardwareDevice,
  app: Extract<ChainAppType, 'ethereum' | 'solana' | 'tron'>,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const appResult = yield* Effect.either(device.getChainApp(app))
    if (appResult._tag === 'Left' || !hasGetAppConfiguration(appResult.right)) {
      return false
    }

    const probeResult = yield* Effect.either(withProbeTimeout(appResult.right.getAppConfiguration()))
    return probeResult._tag === 'Right'
  })

const probeBitcoinFamilyApp = (device: HardwareDevice, chain: ChainId): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const appType = getChainForBtcFamily(chain)
    if (!appType) return false

    const appResult = yield* Effect.either(device.getChainApp(appType))
    if (appResult._tag === 'Left' || !hasGetAddress(appResult.right)) {
      return false
    }

    const probePath = getAddressPath(chain, 0, 0)
    const probeResult = yield* Effect.either(withProbeTimeout(appResult.right.getAddress(probePath, false)))
    return probeResult._tag === 'Right'
  })

/**
 * Probe whether the Ledger app for the target chain is already open.
 *
 * This is used as a fallback when the generic BOLOS app-name probe is flaky
 * right after BLE reconnects. The probe is app-specific so it can confirm
 * the correct app without forcing an unnecessary close/open cycle.
 */
export const probeLedgerAppOpen = (device: HardwareDevice, chain: ChainId): Effect.Effect<boolean, never> => {
  const appInfo = getAppForChain(chain)
  if (!appInfo) {
    return Effect.succeed(false)
  }

  switch (appInfo.id) {
    case 'cardano':
      return Effect.gen(function* () {
        const probeResult = yield* Effect.either(withProbeTimeout(device.getAppVersion()))
        return probeResult._tag === 'Right'
      })

    case 'ethereum':
      return probeAppConfiguration(device, 'ethereum')

    case 'solana':
      return probeAppConfiguration(device, 'solana')

    case 'tron':
      return probeAppConfiguration(device, 'tron')

    case 'bitcoin':
      return probeBitcoinFamilyApp(device, chain)

    default:
      return Effect.succeed(false)
  }
}
