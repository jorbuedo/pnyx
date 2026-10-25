/**
 * HardwareWalletProvider — owns the single `HardwareWalletService` (built with
 * the platform BLE/USB glue) and the `HardwareWalletStorage`, and exposes the
 * pairing/import + signing-backend surface the UI and the Cardano signing rail
 * consume.
 *
 * Non-Midnight only: hardware never touches the software-only Midnight identity.
 *
 * @module
 */

import {BITCOIN_MAINNET, CARDANO_MAINNET, ETHEREUM_MAINNET, SOLANA_MAINNET} from '@pnyx/config'
import {base58} from '@pnyx/crypto'
import {
  createHardwareWalletService,
  type DetectedDevice,
  type HardwareAccount,
  type HardwareWalletService,
  type HardwareWalletState,
  type TrezorConfig,
  type TrezorUIRequest,
} from '@pnyx/hardware/service'
import {createHardwareWalletStorage, type HardwareWalletMeta} from '@pnyx/hardware/storage'
import {PlatformStorageLayerEffect} from '@pnyx/storage'
import {Effect} from 'effect'
import {createContext, type ReactNode, useCallback, useContext, useMemo, useRef} from 'react'
import {useServiceState} from '../hooks/useServiceState'
import {logger} from '../logger'
import {
  createBLETransportFactoryForDevice,
  createLedgerTransportFactory,
  createUSBTransportFactoryForDevice,
  decodeLedgerUsbId,
  getBleManager,
  isBLEAvailable,
  isHardwareUSBSupported,
  isUSBHIDSupported,
  requestBLEPermissions,
  startBLEScan,
  startHardwareUSBScan,
  waitForBluetoothReady,
} from '../platform'
import {CARDANO_ACCOUNT_PATH, persistDeviceCardanoGovKeys} from '../services/cardano'
import {readDeviceSharedAccountXpub, verifyDeviceAccountXpub, xpubHexOf} from '../services/cardano/multisig'
import {useWalletList} from './WalletProvider'

/** The Ledger app that signs Cardano (matches `LEDGER_APPS.cardano.appName`). */
const CARDANO_LEDGER_APP = 'Cardano ADA'

export type HardwareWalletContextValue = {
  /**
   * Stream detected devices over every available transport (USB + BLE); returns
   * an unsubscribe. Bluetooth being unavailable is reported through
   * `onBluetoothUnavailable` rather than thrown, so USB discovery survives it.
   */
  readonly startScan: (
    onDevice: (device: DetectedDevice) => void,
    onBluetoothUnavailable?: (error: unknown) => void,
  ) => Promise<() => void>
  /** True where USB discovery exists for either vendor (Android host mode). */
  readonly usbSupported: boolean
  /** Connect to a scanned device — Ledger or Trezor, over USB or BLE. */
  readonly connect: (device: DetectedDevice) => Promise<void>
  /**
   * The user-set label of the connected device, or null when it has none.
   *
   * The only way to learn it over USB: a BLE advertisement carries the label,
   * but a USB string descriptor is a fixed vendor string. Best-effort — a device
   * that won't answer must not fail the pairing it already completed.
   */
  readonly getConnectedDeviceLabel: () => Promise<string | null>
  /** Cardano accounts (index/path/xpub) from the connected device. */
  readonly getCardanoAccounts: (count: number) => Promise<readonly HardwareAccount[]>
  /**
   * Import a Cardano account as a hardware wallet group: creates the group from
   * the device account xpub and persists the device metadata. Returns groupId.
   */
  readonly importCardanoAccount: (params: {
    readonly device: DetectedDevice
    readonly account: HardwareAccount
    readonly name: string
  }) => Promise<string>
  /**
   * Add another device account to an existing hardware group (Cardano account +
   * BTC/EVM/SOL companions), then select it. Returns the new account index.
   */
  readonly addAccountToGroup: (params: {
    readonly device: DetectedDevice
    readonly account: HardwareAccount
    readonly groupId: string
  }) => Promise<number>
  /**
   * Read the CIP-1854 co-signer key for accounts already in a hardware group and
   * cache it — the backfill for wallets imported before the key was read at
   * import time.
   *
   * Every account is verified against the CIP-1852 xpub it was imported under
   * first, so a different device cannot write its key here. Stops at the first
   * account that fails, reporting how many were done: a partial result is the
   * truth, and continuing past a wrong device would write more of its keys.
   */
  readonly importSharedKeys: (params: {
    readonly device: DetectedDevice
    readonly groupId: string
    readonly accounts: readonly {readonly accountIndex: number; readonly accountXpubHex: string}[]
  }) => Promise<{readonly status: 'ok' | 'wrong-device' | 'failed'; readonly imported: number}>
  readonly disconnect: () => Promise<void>
  /** The device service — for the signing backend (`createCardanoHardwareBackend`). */
  readonly getService: () => HardwareWalletService
  /** Persisted device metadata for a group (for signing-time reconnect). */
  readonly getMeta: (groupId: string) => Promise<HardwareWalletMeta | null>
  /** The active Trezor UI request (PIN/passphrase/pairing), or null. */
  readonly trezorUIRequest: TrezorUIRequest | null
  readonly resolveTrezorPin: (pin: string) => void
  readonly rejectTrezorPin: () => void
  readonly resolveTrezorPassphrase: (value: string, onDevice?: boolean) => void
  readonly rejectTrezorPassphrase: () => void
  readonly resolvePairingCode: (code: string) => void
  readonly rejectPairingCode: () => void
}

const HardwareWalletContext = createContext<HardwareWalletContextValue | null>(null)

const selectTrezorUIRequest = (state: HardwareWalletState): TrezorUIRequest | null => state.trezorUIRequest

export function HardwareWalletProvider({children}: {children: ReactNode}) {
  const {createFromDevice, persistDeviceDeriveOnlyAddress, setDeviceXpubs, addDeviceAccount, selectAccount} =
    useWalletList()

  // One service + storage for the app lifetime.
  const serviceRef = useRef<HardwareWalletService | null>(null)
  if (serviceRef.current === null) {
    serviceRef.current = Effect.runSync(
      createHardwareWalletService({
        platformBLEScan: startBLEScan,
        platformUsbScan: startHardwareUSBScan,
        platformRequestBLEPermissions: requestBLEPermissions,
        platformWaitForBluetoothReady: waitForBluetoothReady,
        // Share the app's single BleManager so the native Trezor transport
        // connects on the same client that ran the scan (lazy — defers creation).
        platformGetBleManager: getBleManager,
        createTransportFactory: createLedgerTransportFactory,
        createBLETransportForDevice: createBLETransportFactoryForDevice,
        isBLEAvailable,
        isUSBHIDSupported,
        logger,
      }),
    )
  }
  const service = serviceRef.current

  const storageRef = useRef<Awaited<ReturnType<typeof runStorage>> | null>(null)
  // The modals read the request straight off the service's state; `?? null` is the type collapsing,
  // not a fallback — this service is built synchronously above, so its ref is never absent.
  const trezorUIRequest = useServiceState(service.state, selectTrezorUIRequest) ?? null

  const getStorage = useCallback(async () => {
    if (storageRef.current === null) storageRef.current = await runStorage()
    return storageRef.current
  }, [])

  const value = useMemo<HardwareWalletContextValue>(() => {
    const cardanoChainId = CARDANO_MAINNET

    const connect = async (device: DetectedDevice) => {
      if (device.type === 'trezor') {
        // Hand the already-discovered device + its transport to the service so
        // connectTrezor connects directly, rather than running a second scan
        // (which fails while the app scan is still tearing down the adapter).
        const trezorCfg: Partial<TrezorConfig> =
          device.transportType === 'bluetooth'
            ? {transports: ['NativeBluetoothTransport'], bleDeviceId: device.id}
            : {transports: ['NativeUsbTransport']}
        await Effect.runPromise(service.connectTrezor(trezorCfg, true))
        return
      }
      // A USB Ledger carries its vendor/product pair in the row id; BLE rows
      // carry a peripheral id. Routing on `transportType` alone would send a
      // cabled Ledger down a GATT connect that can never find it.
      const usbHandle = device.transportType === 'usb' ? decodeLedgerUsbId(device.id) : null
      if (usbHandle !== null) {
        const usbFactory = await createUSBTransportFactoryForDevice(usbHandle)
        await Effect.runPromise(service.connectLedger(usbFactory, undefined, undefined, true))
        return
      }
      const factory = await createBLETransportFactoryForDevice(device.id)
      await Effect.runPromise(service.connectLedger(factory, undefined, device.id, true))
    }

    // Read and cache the account's CIP-1854 co-signer key while the device is
    // still connected and its Cardano app open — the one moment it costs no user
    // step. Without it the wallet cannot put itself on a shared wallet's roster,
    // and cannot recognise itself on one it is already named in.
    //
    // Best-effort, like the companion chains: a device that declines the 1854
    // path leaves the wallet importable and sends the user to the reconnect flow
    // instead. Nothing partial is written — `persistDeviceCardanoGovKeys` writes
    // a complete record or none, so a failure here reads as "not imported yet"
    // rather than as a record that is quietly short a field.
    const cacheSharedAccountKey = async (groupId: string, account: HardwareAccount): Promise<void> => {
      // One index, not two. The group slot and the device account index are the
      // same number now, so taking them separately would only let them drift.
      const {index} = account
      const shared = await Effect.runPromise(Effect.either(readDeviceSharedAccountXpub(service, index)))
      if (shared._tag === 'Left') {
        logger.warn('Hardware shared-account xpub unavailable', {
          origin: 'HardwareWallet',
          groupId,
          accountIndex: index,
          reason: shared.left.kind,
        })
        return
      }
      const written = await Effect.runPromise(
        Effect.either(
          persistDeviceCardanoGovKeys(
            groupId,
            {accountXpubHex: xpubHexOf(account.publicKey, account.chainCode), sharedAccountXpubHex: shared.right},
            index,
          ),
        ),
      )
      if (written._tag === 'Left') {
        logger.warn('Hardware gov-key cache failed', {origin: 'HardwareWallet', groupId, accountIndex: index})
      }
    }

    // Derive-only companion chains (BTC/EVM stored as xpubs → address rebuilds on
    // read; SOL persisted as an address row) for a group account `slot`, derived
    // at the device account index. Trezor exposes every coin in one session;
    // Ledger would need per-app switching, so this is Trezor-only. Best-effort:
    // a chain the device can't derive is logged and skipped, never failing import.
    const deriveCompanionChains = async (
      device: DetectedDevice,
      deviceAccountIndex: number,
      groupId: string,
      slot: number,
    ): Promise<void> => {
      if (device.type !== 'trezor') return
      for (const chainId of [BITCOIN_MAINNET, ETHEREUM_MAINNET] as const) {
        try {
          const [derived] = await Effect.runPromise(service.getAccounts(chainId, 1, deviceAccountIndex))
          if (derived !== undefined) {
            await setDeviceXpubs(groupId, [{chainId, publicKey: derived.publicKey, chainCode: derived.chainCode}], slot)
          }
        } catch (error) {
          logger.warn('Hardware derive-only xpub failed', {origin: 'HardwareWallet', chainId, error: String(error)})
        }
      }
      // SOL has no public-child derivation. Trezor returns the ed25519 public key
      // but no formatted address, and a Solana address IS base58(pubkey), so
      // derive it here (32-byte guard so a malformed key never persists).
      try {
        const [sol] = await Effect.runPromise(service.getAccounts(SOLANA_MAINNET, 1, deviceAccountIndex))
        const solAddress =
          sol === undefined
            ? ''
            : sol.address.length > 0
              ? sol.address
              : sol.publicKey.length === 32
                ? base58.encode(sol.publicKey)
                : ''
        logger.debug('Hardware Solana account', {
          origin: 'HardwareWallet',
          pubKeyLen: sol?.publicKey.length ?? 0,
          addrLen: solAddress.length,
        })
        if (solAddress.length > 0) {
          await persistDeviceDeriveOnlyAddress({groupId, chain: 'solana', accountIndex: slot, address: solAddress})
        }
      } catch (error) {
        logger.warn('Hardware Solana address failed', {origin: 'HardwareWallet', error: String(error)})
      }
    }

    return {
      // USB first, and independent of BLE: a plugged-in Trezor must still be
      // offered when Bluetooth is off or its permission was denied — that is the
      // whole point of the cable. So a BLE failure is reported, not thrown.
      startScan: async (onDevice, onBluetoothUnavailable) => {
        const stopUsb = await Effect.runPromise(service.startUsbScan(onDevice))
        let stopBle: () => void = () => {}
        try {
          stopBle = await Effect.runPromise(service.startBLEScan(onDevice))
        } catch (error) {
          logger.warn('Hardware BLE scan unavailable', {origin: 'HardwareWallet', error: String(error)})
          onBluetoothUnavailable?.(error)
        }
        return () => {
          stopBle()
          stopUsb()
        }
      },
      usbSupported: isHardwareUSBSupported(),
      connect,
      getConnectedDeviceLabel: async () => {
        const features = await Effect.runPromise(Effect.either(service.getDeviceFeatures()))
        if (features._tag === 'Left') {
          logger.warn('Hardware device label unavailable', {origin: 'HardwareWallet', error: String(features.left)})
          return null
        }
        // Trezor-only: a Ledger has no user-set label in its features, and its
        // BLE advertisement is already the name the pair screen shows.
        const label = features.right.type === 'trezor' ? features.right.label : undefined
        return label !== undefined && label.trim().length > 0 ? label.trim() : null
      },
      getCardanoAccounts: (count) => Effect.runPromise(service.getAccounts(cardanoChainId, count)),
      importCardanoAccount: async ({device, account, name}) => {
        const storage = await getStorage()
        // Ledger needs the Cardano app open to expose account keys.
        if (device.type === 'ledger') await Effect.runPromise(service.openApp(CARDANO_LEDGER_APP))
        // The group slot IS the device account index. They were allowed to
        // diverge (slot 0 for whichever row the user picked), and every signing
        // path derives from the slot — so importing the device's account 2 built
        // the wallet's addresses from one key and its witnesses from another.
        const groupId = await createFromDevice({
          name,
          deviceType: device.type,
          publicKeys: [{publicKey: account.publicKey, chainCode: account.chainCode, accountIndex: account.index}],
          chainId: cardanoChainId,
        })
        await deriveCompanionChains(device, account.index, groupId, account.index)
        await cacheSharedAccountKey(groupId, account)

        const meta: HardwareWalletMeta = {
          groupId: groupId as HardwareWalletMeta['groupId'],
          deviceType: device.type,
          deviceModel: device.name,
          firmwareVersion: '',
          derivationPath: CARDANO_ACCOUNT_PATH,
          accountIndex: account.index,
          createdAt: new Date(),
          // No USB counterpart to `bleDeviceId`: the Android device path is
          // scoped to the port and changes on replug, so only the hint persists.
          ...(device.transportType === 'bluetooth'
            ? {bleDeviceId: device.id, transportHint: 'ble' as const}
            : device.transportType === 'usb'
              ? {transportHint: 'usb' as const}
              : {}),
        }
        await Effect.runPromise(storage.store(meta))
        return groupId
      },
      addAccountToGroup: async ({device, account, groupId}) => {
        // Ledger needs the Cardano app open to expose account keys.
        if (device.type === 'ledger') await Effect.runPromise(service.openApp(CARDANO_LEDGER_APP))
        // The device account index is the group slot — not the next free one.
        // "Next free" made the two diverge the moment a user skipped a row, and
        // signing derives from the slot (see `importCardanoAccount`).
        const slot = account.index
        await addDeviceAccount(groupId, cardanoChainId, slot, {
          publicKey: account.publicKey,
          chainCode: account.chainCode,
        })
        await deriveCompanionChains(device, account.index, groupId, slot)
        await cacheSharedAccountKey(groupId, account)
        await selectAccount(cardanoChainId, slot)
        return slot
      },
      importSharedKeys: async ({device, groupId, accounts}) => {
        // Ledger needs the Cardano app open to expose account keys.
        if (device.type === 'ledger') await Effect.runPromise(service.openApp(CARDANO_LEDGER_APP))
        let imported = 0
        for (const {accountIndex, accountXpubHex} of accounts) {
          // Prove this is the device the account was imported from before
          // recording anything. Another device with another seed answers the
          // 1854 read perfectly happily, and the key it returns would be filed
          // as this wallet's roster identity.
          const ok = await Effect.runPromise(
            Effect.either(verifyDeviceAccountXpub(service, accountIndex, accountXpubHex)),
          )
          if (ok._tag === 'Left') {
            if (ok.left.kind === 'wrong-device') return {status: 'wrong-device' as const, imported}
            logger.warn('Shared-key backfill: account verify failed', {
              origin: 'HardwareWallet',
              groupId,
              accountIndex,
              reason: ok.left.kind,
            })
            return {status: 'failed' as const, imported}
          }
          const shared = await Effect.runPromise(Effect.either(readDeviceSharedAccountXpub(service, accountIndex)))
          if (shared._tag === 'Left') return {status: 'failed' as const, imported}
          const written = await Effect.runPromise(
            Effect.either(
              persistDeviceCardanoGovKeys(groupId, {accountXpubHex, sharedAccountXpubHex: shared.right}, accountIndex),
            ),
          )
          if (written._tag === 'Left') return {status: 'failed' as const, imported}
          imported += 1
        }
        return {status: 'ok' as const, imported}
      },
      disconnect: () => Effect.runPromise(service.disconnect({intentional: true})),
      getService: () => service,
      getMeta: async (groupId) => {
        const storage = await getStorage()
        return Effect.runPromise(storage.get(groupId as HardwareWalletMeta['groupId']))
      },
      trezorUIRequest,
      resolveTrezorPin: (pin) => service.resolveTrezorPin(pin),
      rejectTrezorPin: () => service.rejectTrezorPin(),
      resolveTrezorPassphrase: (v, onDevice) => service.resolveTrezorPassphrase(v, onDevice),
      rejectTrezorPassphrase: () => service.rejectTrezorPassphrase(),
      resolvePairingCode: (code) => service.resolvePairingCode(code),
      rejectPairingCode: () => service.rejectPairingCode(),
    }
  }, [
    service,
    createFromDevice,
    persistDeviceDeriveOnlyAddress,
    setDeviceXpubs,
    addDeviceAccount,
    selectAccount,
    trezorUIRequest,
    getStorage,
  ])

  return <HardwareWalletContext.Provider value={value}>{children}</HardwareWalletContext.Provider>
}

const runStorage = () => Effect.runPromise(Effect.provide(createHardwareWalletStorage(), PlatformStorageLayerEffect))

export function useHardwareWallet(): HardwareWalletContextValue {
  const ctx = useContext(HardwareWalletContext)
  if (ctx === null) throw new Error('useHardwareWallet must be used within HardwareWalletProvider')
  return ctx
}
