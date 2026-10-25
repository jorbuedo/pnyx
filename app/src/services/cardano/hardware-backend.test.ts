import {DeviceLockedError, UserRejectedError} from '@pnyx/hardware'
import type {HardwareAccount, HardwareWalletService} from '@pnyx/hardware/service'
import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'

import {createCardanoHardwareBackend} from './hardware-backend'

const CHAIN = 'cardano:mainnet'
const ACCOUNT_PATH = "m/1852'/1815'/0'"
const PUBLIC_KEY = Uint8Array.from(Buffer.alloc(32, 0xab))
const CHAIN_CODE = Uint8Array.from(Buffer.alloc(32, 0xcd))
const XPUB = `${'ab'.repeat(32)}${'cd'.repeat(32)}`

const cachedAccount: HardwareAccount = {
  index: 0,
  path: ACCOUNT_PATH,
  address: 'addr1…',
  publicKey: PUBLIC_KEY,
  chainCode: CHAIN_CODE,
}

/**
 * Only the four members the backend touches. A cast rather than a full stub: the service's own
 * surface is large, and widening this fake would hide which parts the backend actually depends on.
 */
const serviceWith = (opts: {
  readonly cache?: ReadonlyMap<number, HardwareAccount>
  readonly onExport?: () => Effect.Effect<never, unknown>
  readonly countExports?: {n: number}
}): HardwareWalletService =>
  ({
    setReconnectionInfo: () => {},
    ensureReady: () => Effect.void,
    getAccountCache: () => opts.cache ?? new Map(),
    getCurrentDevice: () => ({
      getExtendedPublicKey: (_path: string) => {
        if (opts.countExports !== undefined) opts.countExports.n += 1
        // A failed Effect, like the real device port — not a synchronous throw, which would skip
        // the mapping under test.
        if (opts.onExport !== undefined) return opts.onExport()
        return Effect.succeed({publicKey: PUBLIC_KEY, chainCode: CHAIN_CODE})
      },
    }),
  }) as unknown as HardwareWalletService

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<Either.Either<A, unknown>> =>
  Effect.runPromise(Effect.either(eff))

describe('the wrong-device guard reads the connection cache', () => {
  it('answers from the cached account without touching the device', async () => {
    // ⚠️ A Ledger asks the user to confirm every account-key export, so a device read here is a
    // second prompt in front of every signature (2026-10-08 report). `ensureReady` already read
    // this account from the connected device, and the cache is emptied on connect AND disconnect,
    // so an entry can only describe the device currently attached.
    const exports = {n: 0}
    const backend = createCardanoHardwareBackend(
      serviceWith({cache: new Map([[0, cachedAccount]]), countExports: exports}),
      CHAIN,
    )
    const result = await run(backend.getAccountExtendedPublicKey(ACCOUNT_PATH))
    expect(result).toStrictEqual(Either.right(XPUB))
    expect(exports.n).toBe(0)
  })

  it('reads the device when the cache has no entry for that path', async () => {
    // A different account index, so the cached entry must NOT be used for it.
    const exports = {n: 0}
    const backend = createCardanoHardwareBackend(
      serviceWith({cache: new Map([[0, cachedAccount]]), countExports: exports}),
      CHAIN,
    )
    const result = await run(backend.getAccountExtendedPublicKey("m/1852'/1815'/7'"))
    expect(result).toStrictEqual(Either.right(XPUB))
    expect(exports.n).toBe(1)
  })

  it('reads the device when the cache is empty', async () => {
    const exports = {n: 0}
    const backend = createCardanoHardwareBackend(serviceWith({countExports: exports}), CHAIN)
    expect(await run(backend.getAccountExtendedPublicKey(ACCOUNT_PATH))).toStrictEqual(Either.right(XPUB))
    expect(exports.n).toBe(1)
  })
})

describe('device failures the user can act on', () => {
  it('flags a locked device, with a reason that is not empty', async () => {
    // ⚠️ `DeviceLockedError` carries no `message`, so the generic read produced an empty reason —
    // and an empty reason makes the review screen skip its callout entirely. That is why a locked
    // Ledger reported nothing but "Transaction failed" three times in a row.
    const backend = createCardanoHardwareBackend(
      serviceWith({
        onExport: () => Effect.fail(new DeviceLockedError({deviceType: 'ledger'})),
      }),
      CHAIN,
    )
    const result = await run(backend.getAccountExtendedPublicKey(ACCOUNT_PATH))
    expect(Either.isLeft(result)).toBe(true)
    const error = Either.isLeft(result) ? (result.left as {deviceLocked?: boolean; reason?: string}) : null
    expect(error?.deviceLocked).toBe(true)
    expect(error?.reason).toBe('the device is locked')
  })

  it('still flags a user decline, and does not call it a lock', async () => {
    const backend = createCardanoHardwareBackend(
      serviceWith({
        onExport: () => Effect.fail(new UserRejectedError({operation: 'getExtendedPublicKey'})),
      }),
      CHAIN,
    )
    const result = await run(backend.getAccountExtendedPublicKey(ACCOUNT_PATH))
    const error = Either.isLeft(result) ? (result.left as {deviceLocked?: boolean; userRejected?: boolean}) : null
    expect(error?.userRejected).toBe(true)
    expect(error?.deviceLocked).toBeUndefined()
  })
})
