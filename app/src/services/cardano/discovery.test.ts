import {Address as EvolutionAddress, Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import type {AddressRow} from '@pnyx/store/address-table'
import {deriveCardanoAddressBook as deriveBook, deriveCardanoAccountXpub} from '@pnyx/wallet'
import {Effect} from 'effect'
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  clearDerivedAddressBooks,
  discoverAndPersistCardanoAddresses,
  discoveryDue,
  MIN_DISCOVERY_INTERVAL_MS,
  scanCardanoRole,
  seenAddressUsedSet,
  txHistoryUsageProbe,
  txHistoryWindowProbe,
  type UsageOracle,
  UsageProbeError,
  utxoUsageProbe,
} from './discovery'

/**
 * Counts addresses derived, by wrapping the real derivation rather than replacing it —
 * the saving this file pins is in what gets *derived*, and the scan's returned rows
 * cannot show it (the gap rule stops at the same index either way).
 */
/**
 * Real addresses, because the probes DECODE what they are handed.
 *
 * ⚠️ They used to be strings like `addr1spentout`, which nothing decoded and which therefore
 * stood in for an address for as long as the port carried bech32 straight through.
 */
const ADDR_A =
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh'
const ADDR_B = 'addr_test1vzpwq95z3xyum8vqndgdd9mdnmafh3djcxnc6jemlgdmswcve6tkw'
const ADDR_C =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'
const ADDR_FOREIGN =
  'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w'
const TX_REF = 'ab'.repeat(32)

/** The refusal the probes must not read as "unused". */
const refused = () => Effect.fail(new EvolutionProvider.ProviderError({message: '429 rate limited'}))

const derived = {count: 0, calls: [] as {role: number; from: number; to: number}[]}
vi.mock('@pnyx/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pnyx/wallet')>()
  return {
    ...actual,
    deriveCardanoAddressBook: (xpub: string, options?: Parameters<typeof actual.deriveCardanoAddressBook>[1]) => {
      const from = options?.from ?? 0
      const count = options?.count ?? 20
      const roles = options?.roles ?? [0, 1]
      for (const role of roles) derived.calls.push({role, from, to: count})
      derived.count += (count - from) * roles.length
      return actual.deriveCardanoAddressBook(xpub, options)
    },
  }
})

// The derivation API takes its codec backend from the caller; a test names it.
const deriveCardanoAddressBook = (...args: Parameters<typeof deriveBook>) => deriveBook(...args)

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const REF = {groupId: 'g1', chainId: 'cardano', accountIndex: 0}

let xpubHex: string

beforeAll(async () => {
  xpubHex = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
})

// The derived-book memo is process-level, so without this each test would be served the
// previous one's book and the derivation counts below would measure nothing.
beforeEach(() => {
  clearDerivedAddressBooks()
})

/**
 * In-memory address table.
 *
 * Replaces by `(group, chain, account, branch, index)` because that is the real
 * store's contract (`@pnyx/store/address-table`: "upsert / upsertMany replace by
 * (group, chain, account, branch, index)"). It used to append, which modelled no
 * store at all: once discovery began writing each window as it scanned — and the
 * doubling loop re-scanned the same indexes — an appending fake reported rows twice
 * for a run that writes each row once.
 *
 * `calls` counts writes, so a test can assert that rows land *during* the scan
 * rather than only at the end.
 */
const sink = () => {
  const byKey = new Map<string, AddressRow>()
  const state = {
    calls: 0,
    get rows(): AddressRow[] {
      return [...byKey.values()]
    },
    upsert: (incoming: readonly AddressRow[]) =>
      Effect.sync(() => {
        state.calls += 1
        for (const row of incoming) {
          byKey.set(`${row.groupId}/${row.chainId}/${row.accountIndex}/${row.branch}/${row.index}`, row)
        }
      }),
  }
  return state
}

/** Oracle over a used-set, counting what the scan actually asked the network. */
const oracleOver = (
  used: ReadonlySet<string | undefined>,
  opts: {readonly alreadyUsed?: ReadonlySet<string>; readonly window?: boolean; readonly batch?: boolean} = {},
) => {
  const calls = {probe: 0, anyUsed: 0, usedAmong: 0, batched: 0}
  const known = new Map<string, boolean>()
  for (const a of opts.alreadyUsed ?? []) known.set(a, true)
  const oracle: UsageOracle = {
    known: (a) => known.get(a),
    probe: (a) => {
      const hit = known.get(a)
      if (hit !== undefined) return Effect.succeed(hit)
      calls.probe++
      return Effect.sync(() => {
        const isUsed = used.has(a)
        known.set(a, isUsed)
        return isUsed
      })
    },
    ...(opts.window === true
      ? {
          anyUsed: (addrs: readonly string[]) =>
            Effect.sync(() => {
              calls.anyUsed++
              return addrs.some((a) => used.has(a))
            }),
        }
      : {}),
    ...(opts.batch === true
      ? {
          // The real oracle writes the batch answer into the memo `known`/`probe`
          // read from — model that, or the test proves nothing about the saving.
          usedAmong: (addrs: readonly string[]) =>
            Effect.sync(() => {
              calls.usedAmong++
              calls.batched += addrs.length
              for (const a of addrs) known.set(a, used.has(a))
            }),
        }
      : {}),
  }
  return {oracle, calls}
}

describe('scanCardanoRole', () => {
  it('gap-limit stops after N consecutive unused; a used index extends the scan', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 10}))
    const used = new Set([book.external[0]?.bech32, book.external[2]?.bech32])
    const {oracle} = oracleOver(used)
    const scanned = await Effect.runPromise(scanCardanoRole(book.external, oracle, 2))
    // idx0 used, idx1 unused(gap1), idx2 used(reset), idx3 unused(gap1), idx4 unused(gap2 → stop).
    expect(scanned.map((s) => s.addr.index)).toEqual([0, 1, 2, 3, 4])
    expect(scanned.filter((s) => s.isUsed).map((s) => s.addr.index)).toEqual([0, 2])
  })

  it('clears an untouched window in one call instead of one call per address', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 20}))
    const {oracle, calls} = oracleOver(new Set(), {window: true})

    const scanned = await Effect.runPromise(scanCardanoRole(book.external, oracle, 20))

    expect(scanned).toHaveLength(20)
    expect(scanned.every((s) => !s.isUsed)).toBe(true)
    expect(calls.anyUsed).toBe(1)
    expect(calls.probe).toBe(0)
  })

  it('falls back to per-address probing for a window that has activity', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 4}))
    const {oracle, calls} = oracleOver(new Set([book.external[1]?.bech32]), {window: true})

    const scanned = await Effect.runPromise(scanCardanoRole(book.external, oracle, 4))

    expect(scanned.filter((s) => s.isUsed).map((s) => s.addr.index)).toEqual([1])
    expect(calls.anyUsed).toBe(1)
    expect(calls.probe).toBe(4)
  })

  it('asks the network nothing for addresses a previous scan already proved used', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 10}))
    const usedBech32 = [book.external[0]?.bech32, book.external[1]?.bech32].filter((a): a is string => a !== undefined)
    const {oracle, calls} = oracleOver(new Set(usedBech32), {alreadyUsed: new Set(usedBech32), window: true})

    const scanned = await Effect.runPromise(scanCardanoRole(book.external, oracle, 2))

    expect(scanned.filter((s) => s.isUsed).map((s) => s.addr.index)).toEqual([0, 1])
    // The known-used prefix costs nothing, and the frontier window — all unknown,
    // so eligible for the shortcut — clears in a single call.
    expect(calls.probe).toBe(0)
    expect(calls.anyUsed).toBe(1)
  })
  it('answers a whole window in one batched call, per address, with no probing after it', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 20}))
    const used = new Set([book.external[0]?.bech32, book.external[5]?.bech32])
    const {oracle, calls} = oracleOver(used, {batch: true, window: true})

    const scanned = await Effect.runPromise(scanCardanoRole(book.external, oracle, 20))

    expect(scanned.filter((s) => s.isUsed).map((s) => s.addr.index)).toEqual([0, 5])
    expect(calls.usedAmong).toBe(1)
    // The saving is the point: a window with activity used to cost one call per
    // address, and the `anyUsed` shortcut could not help it.
    expect(calls.probe).toBe(0)
    expect(calls.anyUsed).toBe(0)
  })

  it('a used address in a later batched window still extends the scan past the gap', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 12}))
    const {oracle, calls} = oracleOver(new Set([book.external[2]?.bech32, book.external[6]?.bech32]), {batch: true})

    const scanned = await Effect.runPromise(scanCardanoRole(book.external, oracle, 4))

    // idx2 and idx6 each reset the run, so the gap of 4 is only reached at idx10 —
    // three windows in, which is what the batch has to have been asked for.
    expect(scanned.filter((s) => s.isUsed).map((s) => s.addr.index)).toEqual([2, 6])
    expect(scanned.map((s) => s.addr.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(calls.usedAmong).toBe(3)
  })

  it('asks the batch only about addresses it does not already know', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 8}))
    const seeded = [book.external[0]?.bech32, book.external[1]?.bech32].filter((a): a is string => a !== undefined)
    const {oracle, calls} = oracleOver(new Set(seeded), {alreadyUsed: new Set(seeded), batch: true})

    await Effect.runPromise(scanCardanoRole(book.external, oracle, 4))

    // 8 addresses, 2 already proved used — the network is asked about 6.
    expect(calls.batched).toBe(6)
    expect(calls.probe).toBe(0)
  })
})

describe('seenAddressUsedSet', () => {
  const ADDRS = [Bech32(ADDR_A), Bech32(ADDR_B), Bech32(ADDR_C)]

  /** The typed read answers DECODED addresses, which is what the adapter has to convert back. */
  const seen = (bech32s: readonly string[]) => () => Effect.succeed(bech32s.map((b) => EvolutionAddress.fromBech32(b)))

  it('reads presence as used and absence as unused', async () => {
    const used = await Effect.runPromise(seenAddressUsedSet(seen([ADDR_C, ADDR_A]))(ADDRS))
    expect([...used].sort()).toEqual([ADDR_A, ADDR_C].sort())
  })

  it('an empty answer means every address is unused, not that the call failed', async () => {
    const used = await Effect.runPromise(seenAddressUsedSet(seen([]))(ADDRS))
    expect(used.size).toBe(0)
  })

  it('ignores an address that was not asked about — we never derived it, so it is not ours', async () => {
    const used = await Effect.runPromise(seenAddressUsedSet(seen([ADDR_A, ADDR_FOREIGN]))(ADDRS))
    expect([...used]).toEqual([ADDR_A])
  })

  it('fails rather than reporting a wallet has no used addresses it could not check', async () => {
    const result = await Effect.runPromiseExit(seenAddressUsedSet(() => refused())(ADDRS))
    expect(result._tag).toBe('Failure')
  })
})

describe('usage probes', () => {
  // The wallet that surfaced this: spent-out, 1486 transactions, an address in
  // active use at index 36. UTxO presence answered "unused" for every address it
  // owns — including index 0 — so the gap scan stopped on its first window and
  // the wallet stopped recognising its own address.
  //
  // ⚠️ It used to be the string `addr1spentout`, which is not an address. The probes now
  // DECODE what they are given, so a fixture nothing decoded could no longer stand in for one.
  const SPENT_OUT = Bech32(ADDR_A)

  const rows = (n: number) => () => Effect.succeed(Array.from({length: n}, () => ({txHash: TX_REF})) as never)

  it('history probe: a spent-out address with transactions is used', async () => {
    expect(await Effect.runPromise(txHistoryUsageProbe(rows(1))(SPENT_OUT))).toBe(true)
  })

  it('history probe: an address with no transactions is unused', async () => {
    expect(await Effect.runPromise(txHistoryUsageProbe(rows(0))(SPENT_OUT))).toBe(false)
  })

  it('history probe asks for one row, not the whole history, about the decoded address', async () => {
    // index 0 of that wallet has 1000 transactions; this is an existence check.
    let asked: {readonly addresses: readonly string[]; readonly limit?: number} | undefined
    const probe = txHistoryUsageProbe((addresses, opts) => {
      asked = {
        addresses: addresses.map(EvolutionAddress.toBech32),
        ...(opts?.limit === undefined ? {} : {limit: opts.limit}),
      }
      return Effect.succeed([{txHash: TX_REF}] as never)
    })
    await Effect.runPromise(probe(SPENT_OUT))
    expect(asked?.limit).toBe(1)
    // The bech32 survived the decode/encode round trip, so the probe asked about OUR address.
    expect(asked?.addresses).toEqual([ADDR_A])
  })

  it('window probe: a single row proves the window has activity, an empty answer clears it', async () => {
    const asked: {readonly addresses: readonly string[]; readonly limit?: number}[] = []
    const record =
      (n: number): NonNullable<EvolutionProvider.ProviderEffect['getTxsAt']> =>
      (addresses, opts) => {
        asked.push({
          addresses: addresses.map(EvolutionAddress.toBech32),
          ...(opts?.limit === undefined ? {} : {limit: opts.limit}),
        })
        return Effect.succeed(Array.from({length: n}, () => ({txHash: TX_REF})) as never)
      }
    const window = [Bech32(ADDR_A), Bech32(ADDR_B)]

    expect(await Effect.runPromise(txHistoryWindowProbe(record(1))(window))).toBe(true)
    expect(await Effect.runPromise(txHistoryWindowProbe(record(0))(window))).toBe(false)

    // Asked once for the whole window, one row deep.
    expect(asked.map((a) => a.addresses)).toEqual([
      [ADDR_A, ADDR_B],
      [ADDR_A, ADDR_B],
    ])
    expect(asked.every((a) => a.limit === 1)).toBe(true)
  })

  it('window probe fails rather than clearing a window it could not check', async () => {
    const exit = await Effect.runPromiseExit(txHistoryWindowProbe(() => refused())([Bech32(ADDR_A), Bech32(ADDR_B)]))
    expect(exit._tag).toBe('Failure')
  })

  it('utxo probe cannot see a spent-out address — why it is the last resort', async () => {
    expect(await Effect.runPromise(utxoUsageProbe(() => Effect.succeed([]))(SPENT_OUT))).toBe(false)
  })

  it.each([
    ['history', () => txHistoryUsageProbe(() => refused())],
    ['utxo', () => utxoUsageProbe(() => refused())],
  ])('%s probe fails rather than reporting "unused" when it cannot answer', async (_name, make) => {
    // A rate limit must never read as "this address was never used": that is how
    // a network blip becomes a truncated address book.
    const exit = await Effect.runPromiseExit(make()(SPENT_OUT))
    expect(exit._tag).toBe('Failure')
  })

  it('fails rather than probing an address that does not decode', async () => {
    // The probe is `yield*`-ed by the walk, so an undecodable derivation has to be a typed
    // failure: a throw here would be a defect that bypasses every `UsageProbeError` handler.
    const exit = await Effect.runPromiseExit(txHistoryUsageProbe(rows(1))(Bech32('addr1spentout')))
    expect(exit._tag).toBe('Failure')
    expect(exit._tag === 'Failure' && exit.cause._tag).not.toBe('Die')
  })
})

describe('discoverAndPersistCardanoAddresses', () => {
  it('does not persist a truncated book when the probe cannot answer', async () => {
    const store = sink()
    const exit = await Effect.runPromiseExit(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: () => Effect.fail(new UsageProbeError({reason: 'rate limited'})),
        upsert: store.upsert,
      }),
    )

    expect(exit._tag).toBe('Failure')
    // Nothing written: the caller keeps the address set it already had rather
    // than having it overwritten by "nothing is used".
    expect(store.rows).toEqual([])
  })

  it('reaches an address past the first window when usage is contiguous', async () => {
    // Mirrors the wallet that surfaced this: external indices 0..28 used, then a
    // live address at 36. A UTxO probe called all of them unused (spent out) and
    // the scan stopped at 20 — which is why the wallet did not recognise its own
    // index-36 address. With a truthful probe each used index resets the gap, so
    // the scan walks past 28 and finds 36.
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 60}))
    const used = new Set([...Array.from({length: 29}, (_, i) => book.external[i]?.bech32), book.external[36]?.bech32])
    const store = sink()

    const {rows} = await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) => Effect.succeed(used.has(b)),
        upsert: store.upsert,
      }),
    )

    const external = rows.filter((r) => r.branch === 'external')
    expect(external.some((r) => r.index === 36 && r.isUsed)).toBe(true)
    expect(Math.max(...external.map((r) => r.index))).toBeGreaterThanOrEqual(36)
  })

  // ⚠️ Measured on the wallet this exists for: external ended at 89 used addresses and
  // internal at 575. Under one shared counter the external book was grown to 640 to keep
  // the internal scan company — 2480 derivations for a 664-address answer. Each role now
  // stops where its own gap does.
  // ⚠️ The scan runs every five minutes and re-derived its whole book each time — 800
  // CKDpub derivations, 12.4 s of a 17 s walk on the wallet this was measured against,
  // for a book that cannot have changed.
  it('a re-scan in the same process derives nothing and answers the same', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 60}))
    const used = new Set(Array.from({length: 25}, (_, i) => book.external[i]?.bech32))
    const run = () => {
      const store = sink()
      derived.count = 0
      return Effect.runPromise(
        discoverAndPersistCardanoAddresses({
          accountXpubHex: xpubHex,
          network: Address.Network.Mainnet,
          ref: REF,
          probe: (b) => Effect.succeed(used.has(b)),
          upsert: store.upsert,
        }),
      ).then((result) => ({result, derivedThisRun: derived.count}))
    }

    const first = await run()
    const second = await run()

    expect(first.derivedThisRun, 'the first run has to derive the book').toBeGreaterThan(0)
    expect(second.derivedThisRun, 'the second must not re-derive a book that cannot have changed').toBe(0)
    expect(second.result.rows).toEqual(first.result.rows)
    expect(second.result.knownAddresses).toEqual(first.result.knownAddresses)
  })

  it('a different network derives its own book rather than reusing the first', async () => {
    const store = sink()
    const probe = () => Effect.succeed(false)
    const forNetwork = (network: Address.Network) =>
      Effect.runPromise(
        discoverAndPersistCardanoAddresses({accountXpubHex: xpubHex, network, ref: REF, probe, upsert: store.upsert}),
      )

    await forNetwork(Address.Network.Mainnet)
    derived.count = 0
    const testnet = await forNetwork(Address.Network.Testnet)

    // ⚠️ A derived-address cache keyed without the network is how one network's
    // addresses get served on another.
    expect(derived.count).toBeGreaterThan(0)
    expect(testnet.knownAddresses[0]?.startsWith('addr_test')).toBe(true)
  })

  it('a sparse role stops growing when the dense one keeps going', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 200}))
    // Lopsided on purpose: external is done inside the first window, internal is not.
    const used = new Set([
      ...Array.from({length: 3}, (_, i) => book.external[i]?.bech32),
      ...Array.from({length: 100}, (_, i) => book.internal[i]?.bech32),
    ])
    const store = sink()
    derived.count = 0
    derived.calls = []

    await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) => Effect.succeed(used.has(b)),
        upsert: store.upsert,
      }),
    )

    const grownTo = (role: number) => Math.max(...derived.calls.filter((c) => c.role === role).map((c) => c.to))
    expect(grownTo(1), 'the dense role has to grow past its 100th used index').toBeGreaterThanOrEqual(160)
    expect(grownTo(0), 'the sparse role should never have followed it').toBeLessThan(grownTo(1))
    // Every index is derived exactly once across the whole run, both roles together.
    expect(derived.count).toBe(grownTo(0) + grownTo(1))
  })

  it('a batched used-set answers the whole scan, and the per-address probe is never called', async () => {
    // The measurement this exists for: 611 used addresses cost ~6-7 minutes at one
    // paced call per address. Batched, the same walk is one call per window — and
    // the doubling loop must not undo that by re-asking about a grown book.
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 120}))
    const used = new Set(Array.from({length: 100}, (_, i) => book.external[i]?.bech32))
    const store = sink()
    let probes = 0
    let batches = 0
    let asked = 0

    const {rows} = await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) =>
          Effect.sync(() => {
            probes += 1
            return used.has(b)
          }),
        seenAmong: (addrs) =>
          Effect.sync(() => {
            batches += 1
            asked += addrs.length
            return new Set(addrs.filter((a) => used.has(a)))
          }),
        upsert: store.upsert,
      }),
    )

    const external = rows.filter((r) => r.branch === 'external')
    expect(external.filter((r) => r.isUsed)).toHaveLength(100)
    expect(Math.max(...external.map((r) => r.index))).toBeGreaterThanOrEqual(99)
    expect(probes).toBe(0)
    // Every address is asked about exactly once across the whole run, doubling
    // included — the memo the batch writes into is what makes the re-scan free.
    expect(asked).toBe(new Set(rows.map((r) => r.human)).size)
    expect(batches).toBeLessThan(asked / 10)
  })

  it('persists each window as it is scanned, not only once the whole walk finishes', async () => {
    // A wallet with hundreds of used addresses takes minutes of paced probing. The scan
    // used to write nothing until it had finished all of it, so for the whole walk the
    // address table stayed empty and CIP-30 `getUsedAddresses` answered with the primary
    // address alone — a wrong answer indistinguishable from a correct one. An interrupted
    // walk also threw away everything it had learned.
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 40}))
    // Used across several windows, so the scan cannot terminate early.
    const used = new Set([0, 2, 4, 6, 8, 10, 12].map((i) => book.external[i]?.bech32))
    const store = sink()
    /** Rows visible to a reader the moment the probe is asked about index 12. */
    let seenMidScan = -1

    await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) =>
          Effect.sync(() => {
            if (b === book.external[12]?.bech32) seenMidScan = store.rows.length
            return used.has(b)
          }),
        upsert: store.upsert,
        gapLimit: 4,
      }),
    )

    // The point of the change: a reader partway through the walk sees real rows.
    expect(seenMidScan).toBeGreaterThan(0)
    expect(store.calls).toBeGreaterThan(1)
  })

  it('derives from the xpub, persists external+internal rows with isUsed, and returns used+primary as knownAddresses', async () => {
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 10}))
    const usedExternal = new Set([book.external[0]?.bech32, book.external[2]?.bech32])
    const store = sink()

    const result = await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) => Effect.succeed(usedExternal.has(b)),
        upsert: store.upsert,
        gapLimit: 2,
      }),
    )

    const external = store.rows.filter((r) => r.branch === 'external')
    const internal = store.rows.filter((r) => r.branch === 'internal')

    // External scan stops at idx4 (idx3+idx4 consecutive unused); internal has no used → stops at idx1.
    expect(external.map((r) => r.index)).toEqual([0, 1, 2, 3, 4])
    expect(internal.map((r) => r.index)).toEqual([0, 1])

    // isUsed flags match the probe.
    expect(external.filter((r) => r.isUsed).map((r) => r.index)).toEqual([0, 2])
    expect(internal.every((r) => !r.isUsed)).toBe(true)

    // Cardano rows carry the payment-key-hash credential, distinct from the bech32.
    const ext0 = external[0] as AddressRow
    expect(ext0.hash).toMatch(/^[0-9a-f]{56}$/)
    expect(ext0.hash).not.toBe(ext0.human)
    expect(ext0.human).toBe(book.external[0]?.bech32)

    // knownAddresses = used addresses + the primary receive address (external[0]).
    expect(new Set(result.knownAddresses)).toEqual(new Set([book.external[0]?.bech32, book.external[2]?.bech32]))

    // The far tail beyond the gap stop is never scanned/persisted.
    const tail = book.external[9]?.bech32
    expect(store.rows.some((r) => r.human === tail)).toBe(false)
  })

  it('grows the derived book past the initial window to reach dense high-index usage', async () => {
    // Every even index 0..50 used, gap 2 ⇒ never two consecutive unused, so the
    // scan must derive past the initial 40-address window to reach index 50.
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 60}))
    const usedExternal = new Set(book.external.filter((_, i) => i % 2 === 0 && i <= 50).map((a) => a.bech32))
    const store = sink()
    const result = await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) => Effect.succeed(usedExternal.has(b)),
        upsert: store.upsert,
        gapLimit: 2,
      }),
    )
    // Index 50 (well past the old fixed 40 cap) is discovered.
    expect(new Set(result.knownAddresses).has(book.external[50]?.bech32 as string)).toBe(true)
    expect(store.rows.some((r) => r.branch === 'external' && r.index === 50 && r.isUsed)).toBe(true)
  })

  it('re-scan pays only for the frontier when told what was already used', async () => {
    // The re-scan cost that made discovery run ~200 paced calls on every rail
    // mount: without the seed, every known-used address is re-probed.
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 40}))
    const usedBech32 = book.external.slice(0, 15).map((a) => a.bech32)
    const used = new Set(usedBech32)
    let probes = 0

    const result = await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) =>
          Effect.sync(() => {
            probes++
            return used.has(b)
          }),
        upsert: sink().upsert,
        gapLimit: 2,
        alreadyUsed: new Set(usedBech32),
      }),
    )

    // Every seeded address is still reported used, and none of them cost a probe.
    expect(usedBech32.every((a) => result.knownAddresses.includes(a))).toBe(true)
    expect(probes).toBeLessThan(usedBech32.length)
  })

  it('a newly-used address is still found — only positives may be seeded', async () => {
    // Seeding negatives would be the dangerous half: this asserts an address that
    // was unused at the last scan is picked up once it has history.
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 20}))
    const seeded = [book.external[0]?.bech32].filter((a): a is string => a !== undefined)
    const nowUsed = new Set([...seeded, book.external[1]?.bech32])

    const result = await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: (b) => Effect.succeed(nowUsed.has(b)),
        upsert: sink().upsert,
        gapLimit: 2,
        alreadyUsed: new Set(seeded),
      }),
    )

    expect(result.knownAddresses).toContain(book.external[1]?.bech32 as string)
  })

  it('persists the primary even when nothing is used (fresh wallet)', async () => {
    const store = sink()
    const result = await Effect.runPromise(
      discoverAndPersistCardanoAddresses({
        accountXpubHex: xpubHex,
        network: Address.Network.Mainnet,
        ref: REF,
        probe: () => Effect.succeed(false),
        upsert: store.upsert,
        gapLimit: 2,
      }),
    )
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpubHex, {count: 1}))
    expect(result.knownAddresses).toEqual([book.external[0]?.bech32])
  })
})

describe('discoveryDue', () => {
  const now = 1_800_000_000_000

  it('is due when the account has never been scanned', () => {
    expect(discoveryDue(null, now)).toBe(true)
  })

  it('is not due again within the interval — the seeded rail is already that answer', () => {
    expect(discoveryDue(now - 1000, now)).toBe(false)
    expect(discoveryDue(now - (MIN_DISCOVERY_INTERVAL_MS - 1), now)).toBe(false)
  })

  it('is due once the interval has elapsed', () => {
    expect(discoveryDue(now - MIN_DISCOVERY_INTERVAL_MS, now)).toBe(true)
    expect(discoveryDue(now - MIN_DISCOVERY_INTERVAL_MS * 3, now)).toBe(true)
  })

  it('is due on an unusable timestamp rather than skipping forever', () => {
    expect(discoveryDue(Number.NaN, now)).toBe(true)
  })
})
