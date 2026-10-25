# @pnyx/hardware

Effect-native hardware-wallet layer for Pnyx's **non-Midnight** wallets. Midnight
has no device app (research doc 08), so the forum identity is never hardware-backed;
hardware covers imported BTC / EVM / SOL / ADA wallets only.

## Status (2026-07-12)

Phase-8 foundation. This package currently ships the **SDK-free core**, which is
unit-tested and has no device dependency:

- `types.ts` — the vendor-agnostic `HardwareDevice` contract, `ExtendedPublicKey`
  (the `{publicKey, chainCode}[]` payload `WalletManager.createFromDevice` already
  consumes), and the `LedgerTransport` / `LedgerTransportFactory` seams.
- `errors.ts` — the `Data.TaggedError` taxonomy.
- `derivation.ts` — path builders (CIP-1852, BIP-84, BIP-44, Solana), vendor-aware
  (Ledger vs Trezor Solana divergence). Golden-path tested.

## The device-gated layer (next chunk — needs real devices to verify)

Ported from a proven, already-Effect-native hardware layer:

1. **Ledger transport (RN)** — implement `LedgerTransportFactory` over
   `@ledgerhq/react-native-hw-transport-ble` (+ `@ledgerhq/react-native-hid` for
   Android USB). Add these as **optional peer deps** so the
   core stays importable without them.
2. **Per-chain Ledger apps** — wrap `@ledgerhq/hw-app-{btc,eth,solana}` +
   `@cardano-foundation/ledgerjs-hw-app-cardano`, exposing `getExtendedPublicKey(s)`
   → `ExtendedPublicKey`. This is the address/xpub priority.
3. **Device factory + service** — `createLedgerDevice(factory)` returning
   `HardwareDevice`; a `Ref`-backed service for scan → connect → open-app → derive,
   plus BLE permission/readiness plumbing.
4. **Wire to the wallet** — feed derived xpubs into `WalletManager.createFromDevice`
   (`packages/wallet/account/wallet-manager.ts`), which already stores per-account
   xpubs and flags the group `isHardware`.

**Trezor** — mobile Trezor has no `trezor-connect` path (web-only iframe), so it
rides on a bespoke THP protocol + native transport stack (itself ported
from open-source Trezor Suite).

- ✅ **Protocol core ported (2026-07-12)** — `trezor-protocol/` (protobuf, THP v2
  Noise handshake, `device-session`, `call-loop`, BLE protocol helpers,
  bridge-transport) + `trezor-native/transport/` abstraction. Builds clean; 63
  ported tests pass.
- ✅ **THP pairing verified on real hardware (2026-08-05)** — full CodeEntry pairing
  against a **Trezor Safe 7 (T3W1, firmware 2.10.0, THP 2.1) over BLE**: channel →
  Noise_XX → `ThpPairingRequest` → on-device confirm → 6-digit code → CPace →
  credential. First execution of the CPace path against firmware; `pairing.test.ts`
  now covers it (elligator2 against upstream vectors, `validateCodeEntryTag`
  accept/reject).

> ⚠️ **Do not bump `protobufjs` without re-pairing a Trezor from scratch.**
>
> THP message types are **not** in `messages.json`; they are loaded at runtime by
> `loadDefinitions('thp', …)` and merged into the root `MessageType` enum. protobufjs
> **7.6.5** added a root-level `_fullyQualifiedObjects` cache and an early bailout in
> `Namespace.lookup`, so a *relative* `lookupEnum('MessageType')` from a nested
> namespace resolves to the **root** enum instead of the package's own. Under 7.4.0
> the local definition won.
>
> That silently disabled the merge (`a7df11b`, a CVE bump). Every THP message then had
> no wire number and went out as `0x0000` = `Initialize`; the device answered
> `Failure_UnexpectedMessage`, "Message unrecognized in pairing context". It stayed
> hidden for nine days because **only** dynamically-loaded packages were affected — all
> v1 messages kept working — and because the sole affected path is *fresh* pairing,
> which a device holding a credential skips entirely.
>
> Resolution no longer depends on how protobufjs resolves a relative name
> (`messageTypeEnums` collects every `MessageType` enum; `pkg.nested.MessageType` is
> read directly), and a miss now **throws** instead of falling back to the message
> name — a string through `setUint16` is `NaN` → `0x0000`, invisible on the wire.
> `protobuf.test.ts` pins both directions. The remaining exposure is behavioural: a
> future version could break the merge differently, and only a real pairing would show
> it.
- ✅ **USB rail linked into the app (2026-08-05)** — the `react-native-usb` Expo
  module lives at `trezor-native/react-native-usb/` but was **never compiled into
  the binary**: it sits below the root `packages/*` workspace glob, so it was
  absent from `node_modules`, invisible to `expo-modules-autolinking`, and
  `requireNativeModule('ReactNativeUsb')` could only throw. It is now its own
  workspace package (`@pnyx/react-native-usb`) and a dependency of
  `app`. Discovery came with it — see the USB discovery notes below.

  No expo config plugin is needed: the module's own `AndroidManifest.xml` carries
  the three USB receivers and merges into the app.
- ⏳ **Remaining (device-gated):** the
  `trezor/` `HardwareDevice` impl (device + multichain). The latter needs the shared
  `types.ts`/`errors.ts` with **the legacy crypto stack excised** — Cardano tx-signing there routes
  to `@evolution-sdk/hardware-cardano` + `@evolution-sdk/review` (this package's actual deps; the
  `@pnyx/cardano-effect` this used to name is retired), not the banned legacy signing packages. Needs a physical
  Trezor to verify.

Verification of layers 1–3 requires a physical Ledger (BLE) — none is attached in
CI, so they land with device-tested sign-off, not emulator screenshots.

## Hardware wallet discovery over USB (Android)

Android-only — iOS has no USB host mode, so `isHardwareUSBSupported()` is false
there and discovery yields BLE devices only.

**Two unrelated native rails**, fanned out from `startHardwareUSBScan` and merged
behind one subscription, so an unavailable rail contributes nothing rather than
failing the other:

| | Trezor | Ledger |
|---|---|---|
| Module | vendored `react-native-usb` (Expo) | `@ledgerhq/react-native-hid` |
| Enumerate | `listDevices()` | `TransportHID.listen` (replays attached, then hot-plug) |
| Vendor filter | `TREZOR_USB_DESCRIPTORS`, VID **+** PID | Ledger USB vendor id, done inside the transport |
| Permission prompt | during discovery | at connect (`HID.openDevice`) |
| Row `id` | Android device path | `ledger-usb:<vid>:<pid>` (`platform/ledger-usb-device.ts`) |

The row id differs because each vendor's transport reopens a device differently:
Trezor's takes the device path, `TransportHID.open` takes `{vendorId, productId}`.
Both are strings/numbers, so neither needs a side map of native descriptors — but
`UsbDeviceInfo.id` is therefore **opaque to the service** and must round-trip to
the platform layer untouched. `HardwareWalletProvider.connect` decides Ledger
USB vs BLE by whether the id decodes as a Ledger USB handle, not by
`transportType` alone.

Because Ledger's rail does not prompt during discovery, **a Ledger USB row is not
proof the app can open the device** — the prompt comes when you tap it.

### Trezor specifics

There is nothing to *scan* for: the OS already knows what is plugged in. The work
is permission, and the ordering matters:

| Step | Where | Note |
|---|---|---|
| Enumerate every attached device | `ReactNativeUsbModule.listDevices()` | `getDevices()` **hides** devices without permission, so it cannot be used to discover one |
| Keep only Trezors | `usb/trezor-usb-devices.ts` | matches `TREZOR_USB_DESCRIPTORS` (VID+PID pair, not VID alone) |
| Prompt for anything unpermitted | `requestPermission(deviceName)` | resolves `true`/`false` when the user answers |
| Emit the device | `usb/scan.ts` | **only once permission is held** — a row that cannot connect is worse than no row |
| Track hot-plug | `onDeviceConnect` / `onDeviceDisconnect` | the grant path re-emits through `onDeviceConnect` |

Three traps this rail is built around:

- **A permission grant used to be a dead end.** `ReactNativeUsbPermissionReceiver`
  has always existed, but nothing called `setOnDevicePermissionCallback`, so a
  granted dialog emitted no event and the device only appeared on the next
  foreground transition. The module now wires it and re-emits `onDeviceConnect`.
- **`UsbDevice.getSerialNumber()` throws `SecurityException` on API 29+** without
  device permission. Reading it unguarded while enumerating an unpermitted device
  takes the whole enumeration down, which is precisely when discovery has to work.
- **The unprompted permission requests are scoped to Trezor VID/PIDs**
  (`TREZOR_USB_IDS` in the Kotlin module, mirroring `TREZOR_USB_DESCRIPTORS`). The
  attach broadcast and the foreground sweep fire for whatever is on the bus, so
  unscoped they pop "allow USB access?" for a plugged hub or dock on app launch —
  alarming in a wallet. `listDevices()` stays unfiltered and `requestPermission()`
  trusts its caller; the authoritative Trezor filter is the JS one, which is where
  it can be unit-tested.

The Android device path addresses the **port**, not the device, so a USB pairing
persists `transportHint: 'usb'` and no device id — where BLE persists
`bleDeviceId`.

### Display name

A USB string descriptor is a fixed vendor string, so discovery over USB can only
offer "Trezor" — where a BLE advertisement *is* the user-set label. The label is
therefore read from `GetFeatures` after connect and merged by
`screens/hardware/device-display-name.ts`. This matters beyond the banner:
`importCardanoAccount` names the wallet from the device, so without it a cabled
Trezor imports as a generic "Trezor".

Ledger has no user-set label; its `deviceModel.productName` ("Nano X") is the name.

### Bluetooth is not a prerequisite

Bluetooth being unavailable does **not** cancel USB discovery — a cabled device
must still pair with the radio off. `startScan` reports it through
`onBluetoothUnavailable` instead of throwing, and the pair screen dims the
Bluetooth chip rather than failing the scan.
