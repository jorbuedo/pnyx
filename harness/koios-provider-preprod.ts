/**
 * Evolution's Koios provider against the real endpoint, read-only.
 *
 * Every member the wallet depends on, driven over preprod, counting the requests each one
 * spends. It exists because the unit tests stub `fetch`: they prove the call shape and say
 * nothing about what Koios actually answers. This is the gap between "the mapping is right"
 * and "the wire agrees", and it is the one a device pass would otherwise be the first to find.
 *
 * ⚠️ **Submits nothing and holds no key.** The account below is a busy preprod account read off
 * the chain; it is used because it has 3,000+ UTxOs and hundreds of addresses, which is what
 * exercises the paths that only appear at scale: the body-size chunking, the page merge, and the
 * credential-keyed query.
 *
 * ⚠️ **Run it with the harness tsconfig, or it does not load at all:**
 *
 *   bun run preprod:koios
 *
 * The repo maps every `@evolution-sdk` subpath at `dist/*.d.ts` for `tsc`, and bun honours
 * tsconfig `paths` AT RUN TIME, so a subpath import would load a declaration file that exports
 * nothing.
 */

import {
  Address as EvAddress,
  Bytes as EvBytes,
  Data as EvData,
  InlineDatum as EvInlineDatum,
  KeyHash,
  OriginalBytes,
  Provider as EvProvider,
  RequestBudget,
  RewardAddress as EvRewardAddress,
  TransactionHash as EvTransactionHash,
  TransactionInput as EvTransactionInput,
} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {awaitConfirmations} from '../app/src/services/cardano/await-confirmations.js'
import {koiosProviderLayer} from '../app/src/services/cardano/koios-provider.js'
import {providerErrorText} from '../app/src/services/cardano/provider-error.js'
import {utxoAddressBech32, utxoAssetMap, utxoTxHashHex} from '../app/src/services/cardano/utxo-view.js'

/** A busy preprod account, read off the chain. Read-only: nothing here is signed or submitted. */
const ADDRESS_BECH32 =
  'addr_test1qp4dh5etpe4g55cgsg4uhlfm0hrhzn35287ur57aksgqjwm2m0fjkrn23ffs3q3te07nklw8w98rg50ac8famdqspyasj9caxm'
const STAKE_BECH32 = 'stake_test1up4dh5etpe4g55cgsg4uhlfm0hrhzn35287ur57aksgqjwce84m7h'
const SCRIPT_BECH32 = 'addr_test1wzpaveyshpnq5fn0ke3uxd329tgd509445eeqd3s2pzmk0qg9xn5l'
const PAYMENT_CREDENTIAL = '6adbd32b0e6a8a5308822bcbfd3b7dc7714e3451fdc1d3ddb410093b'

const ADDRESS = EvAddress.fromBech32(ADDRESS_BECH32)
// Their reward address is a BRANDED STRING, not a decoded type: constructed through the
// schema rather than cast, so a value that is not a reward address is rejected here.
const STAKE = EvRewardAddress.RewardAddress.make(STAKE_BECH32)
const SCRIPT = EvAddress.fromBech32(SCRIPT_BECH32)

/** Requests per path, so each member's cost is visible rather than asserted. */
let spent: {path: string; status: number}[] = []
RequestBudget.setObserver((report) => spent.push({path: report.path, status: report.status}))

const layer = koiosProviderLayer('preprod')

/** Run one member, reporting what it answered and what it cost. */
const drive = async <A>(
  what: string,
  effect: Effect.Effect<A, EvProvider.ProviderError, EvProvider.ProviderEffect>,
  describe: (a: A) => string,
): Promise<A | null> => {
  spent = []
  const started = Date.now()
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(layer)))
  const ms = Date.now() - started
  const paths = [...new Set(spent.map((s) => s.path))].join(' ')
  const refused = spent.filter((s) => s.status >= 400).length
  const cost = `${spent.length} req${refused > 0 ? ` (${refused} refused)` : ''} ${ms}ms ${paths}`
  if (exit._tag === 'Success') {
    console.log(`✓ ${what.padEnd(30)} ${describe(exit.value).padEnd(46)} ${cost}`)
    return exit.value
  }
  // ⚠️ Through `providerErrorText`, not `String(cause)`: their error keeps the real reason in
  // `cause` and only a summary in `message`, so the raw summary is the half that says nothing.
  const reason = exit.cause._tag === 'Fail' ? providerErrorText(exit.cause.error) : String(exit.cause)
  console.log(`✗ ${what.padEnd(30)} ${reason.slice(0, 44).padEnd(46)} ${cost}`)
  return null
}

/** Ask the provider for one optional member, failing the drive when the backend omits it. */
const member = <K extends keyof EvProvider.ProviderEffect, A>(
  key: K,
  use: (m: NonNullable<EvProvider.ProviderEffect[K]>) => Effect.Effect<A, EvProvider.ProviderError>,
): Effect.Effect<A, EvProvider.ProviderError, EvProvider.ProviderEffect> =>
  Effect.flatMap(EvProvider.ProviderEffect, (p) => {
    const m = p[key]
    return m === undefined
      ? Effect.fail(new EvProvider.ProviderError({message: `${String(key)} is not served by this backend`}))
      : use(m as NonNullable<EvProvider.ProviderEffect[K]>)
  })

console.log("\n=== Evolution's Koios provider, over preprod ===\n")

const provider = await Effect.runPromise(
  Effect.flatMap(EvProvider.ProviderEffect, (p) => Effect.succeed(p)).pipe(Effect.provide(layer)),
)

/**
 * The members the wallet depends on, and whether this backend serves them.
 *
 * ⚠️ Enumerated rather than reflected off the object: `Object.keys` reports what the backend
 * happens to carry, which is the wrong question. This asks whether the surface the app reads is
 * served, so a member that disappears upstream shows up here as absent.
 */
const EXPECTED = [
  'getTip',
  'getUtxos',
  'getProtocolParameters',
  'resolveOutRefs',
  'submitTx',
  'awaitTx',
  'getTxConfirmations',
  'getTxsAt',
  'getTxInfo',
  'getTxCbor',
  'getAccountAddresses',
  'getAddressesSeen',
  'getAccountTxs',
  'getAccountInfo',
  'getAccountUtxos',
  'getUtxosByAsset',
  'getScriptByHash',
  'getUtxosByPaymentCredential',
  'getUtxosByPaymentCredentials',
  'getUtxosOfTransaction',
  'getProtocolParametersAt',
  'getDReps',
  'getDRep',
  'getCommittee',
  'getPools',
  'getPool',
  'getProposals',
  'getProposal',
  'getChainParameters',
  'getVotesByDRep',
  'getVotesByPool',
  'getVotesByCommittee',
  'getVotesByProposal',
] as const satisfies ReadonlyArray<keyof EvProvider.ProviderEffect>

const absent = EXPECTED.filter((m) => provider[m] === undefined)
console.log(
  `members expected ${EXPECTED.length}, absent: ${absent.length === 0 ? 'none — the surface is fully served' : absent.join(', ')}\n`,
)

const tip = await drive(
  'getTip',
  member('getTip', (m) => m()),
  (t) => `slot ${t.slot} epoch ${t.epoch}`,
)

// ⚠️ The endpoint that changed: `/address_info`, one request, datum and reference script intact.
await drive(
  'getUtxos',
  Effect.flatMap(EvProvider.ProviderEffect, (p) => p.getUtxos(ADDRESS)),
  (us) => `${us.length} utxos, ${us.filter((u) => u.scriptRef !== undefined).length} with a script`,
)

// Two reads, one request: the client's own epoch-params cache.
await drive(
  'getProtocolParameters x2 (cached)',
  Effect.flatMap(EvProvider.ProviderEffect, (p) =>
    Effect.zipRight(p.getProtocolParameters(), p.getProtocolParameters()),
  ),
  (p) => `minFeeA ${p.minFeeA} refScript ${p.minFeeRefScriptCostPerByte}`,
)

const addresses = await drive(
  'getAccountAddresses',
  member('getAccountAddresses', (m) => m(STAKE)),
  (as) => `${as.length} addresses`,
)

// ⚠️ `getAccountAddresses` answers the addresses holding value, not every address ever derived —
// one, for this account. So the chunking below needs addresses from somewhere else; see below.
console.log(`  (getAccountAddresses answered ${addresses?.length ?? 0}: value sits at that many)`)

const accountTxs = await drive(
  'getAccountTxs newest-first',
  member('getAccountTxs', (m) => m(STAKE, {limit: 100})),
  (rs) => `${rs.length} refs, newest height ${rs[0]?.blockHeight}`,
)

await drive(
  'getAccountTxs asc+limit 1 (oldest)',
  member('getAccountTxs', (m) => m(STAKE, {order: 'asc', limit: 1})),
  (rs) => `oldest height ${rs[0]?.blockHeight}`,
)

if (accountTxs !== null && accountTxs.length > 1 && accountTxs[0]!.blockHeight !== undefined) {
  const newest = accountTxs[0]!.blockHeight
  await drive(
    'getAccountTxs beforeBlock (window)',
    member('getAccountTxs', (m) => m(STAKE, {beforeBlock: newest, limit: 3})),
    (rs) => `${rs.length} refs, all below ${newest}: ${rs.every((r) => (r.blockHeight ?? 0) < newest)}`,
  )

  // ⚠️ 100 hashes is past the ~76 a single body holds.
  const hashes = accountTxs.map((r) => r.txHash)
  await drive(
    `getTxInfo x${hashes.length} (chunked)`,
    member('getTxInfo', (m) => m(hashes)),
    (ts) => `${ts.length} transactions, fees ${ts.length > 0 ? 'present' : 'none'}`,
  )
  await drive(
    `getTxCbor x${hashes.length} (chunked)`,
    member('getTxCbor', (m) => m(hashes)),
    (ts) => `${ts.length} bodies, first ${ts[0]?.cborHex.length ?? 0} hex chars`,
  )

  /**
   * ⚠️ The chunking, on the wire. Koios 413s a body over 5120 bytes — about 47 base addresses —
   * so these two only split when the address book is large.
   *
   * The book here is **one real address plus 59 synthetic ones**, each a valid preprod base
   * address over an arbitrary key hash. That is deliberately better than 60 harvested addresses:
   * the synthetic ones are addresses the chain has never seen, so the answer is *checkable* —
   * `getAddressesSeen` must return exactly the real one, and `getTxsAt` must return only its
   * refs. A book of 60 real addresses would make any answer look plausible.
   *
   * ⚠️ BASE addresses, not enterprise ones: an enterprise address is ~63 characters, so 60 of
   * them come to 4,021 bytes and never split. A base address is ~108, which is what a wallet's
   * address book actually holds and what crosses the 5120-byte limit.
   *
   * ⚠️ And built through `Address.make` with **`stakingCredential`** — the field `Address` uses.
   * The `BaseAddress` class spells its own `stakeCredential` and has its own encoder; handing one
   * to `Address.toBech32` encoded an ENTERPRISE address with the stake credential dropped, 63
   * characters instead of 108. TypeScript rejects that — but **bun strips types without checking
   * them**, so in a harness it is a silent wrong answer rather than a compile error.
   */
  const synthetic = Array.from({length: 59}, (_, i) =>
    EvAddress.Address.make({
      networkId: 0,
      paymentCredential: KeyHash.fromHex(`${(i + 1).toString(16).padStart(4, '0')}${'ab'.repeat(26)}`),
      stakingCredential: KeyHash.fromHex(`${(i + 1).toString(16).padStart(4, '0')}${'cd'.repeat(26)}`),
    }),
  )
  const book = [ADDRESS, ...synthetic]
  const bodyBytes = JSON.stringify({_addresses: book.map((a) => EvAddress.toBech32(a))}).length
  console.log(`  (an address book of ${book.length} is ${bodyBytes} bytes — Koios refuses over 5120)`)

  await drive(
    `getAddressesSeen x${book.length} (chunked)`,
    member('getAddressesSeen', (m) => m(book)),
    (as) =>
      `${as.length} seen: ${
        as.length === 1 && EvAddress.toBech32(as[0]!) === ADDRESS_BECH32 ? 'exactly the real one' : '⚠️ unexpected set'
      }`,
  )
  await drive(
    `getTxsAt x${book.length} (chunk+merge)`,
    member('getTxsAt', (m) => m(book, {limit: 5})),
    (rs) =>
      `${rs.length} refs, desc ${rs.every((r, i) => i === 0 || (rs[i - 1]!.blockHeight ?? 0) >= (r.blockHeight ?? 0))}${
        rs.length === new Set(rs.map((r) => EvTransactionHash.toHex(r.txHash))).size ? ', deduped' : ' ⚠️ DUPLICATES'
      }`,
  )
  await drive(
    `getTxsAt x${book.length} + offset`,
    member('getTxsAt', (m) => m(book, {limit: 5, offset: 10})).pipe(
      Effect.map(() => '⚠️ ANSWERED — a refusal was expected'),
      Effect.catchAll((e) =>
        Effect.succeed(`refused, correctly: ${providerErrorText(e).includes('offset cannot be applied')}`),
      ),
    ),
    (m) => m,
  )

  // ⚠️ The query that could never have worked: it put a Uint8Array in the JSON body.
  await drive(
    'getUtxosByPaymentCredential',
    member('getUtxosByPaymentCredential', (m) => m(KeyHash.fromHex(PAYMENT_CREDENTIAL))),
    (us) => `${us.length} utxos under the credential`,
  )

  /**
   * ⚠️ **The read that fixed a live regression, driven over real rows.**
   *
   * `resolveOutRefs` is contracted to report what it found and FLAG `spent`; `getUtxosByOutRef`
   * *filters* a consumed output away and carries no flag, so served from that alone every
   * `spent` is `undefined`. Three consumers read it. A stubbed `fetch` cannot tell us Koios
   * actually sends `is_spent`, which is the whole question — so this resolves the INPUTS of a
   * landed transaction, which are spent by definition, and asserts the flag came back `true`
   * rather than absent.
   */
  const landed = await drive(
    'getTxInfo (one, for its inputs)',
    member('getTxInfo', (m) => m([accountTxs[0]!.txHash])),
    (ts) => `${ts[0]?.inputs.length ?? 0} inputs on the newest transaction`,
  )
  // `outpoint` is optional on an indexed IO — absent when the backend omits it, which is the
  // case this cannot be driven in.
  const consumed = (landed?.[0]?.inputs ?? []).flatMap((i) => (i.outpoint === undefined ? [] : [i.outpoint]))
  const asInputs = consumed.map(
    (c) => new EvTransactionInput.TransactionInput({transactionId: c.txHash, index: BigInt(c.index)}),
  )
  if (asInputs.length > 0) {
    await drive(
      'resolveOutRefs (spent inputs)',
      member('resolveOutRefs', (m) => m(asInputs)),
      (os) => {
        const flagged = os.filter((o) => o.spent === true).length
        const unknown = os.filter((o) => o.spent === undefined).length
        return `${os.length}/${asInputs.length} resolved, ${flagged} flagged spent${
          unknown > 0 ? `, ⚠️ ${unknown} with NO FLAG` : ''
        }`
      },
    )

    // The same outpoints through the builder's read, which filters a consumed output away. The
    // two answers differing is the contract, not a discrepancy.
    await drive(
      'getUtxosByOutRef (same refs, filtered)',
      Effect.flatMap(EvProvider.ProviderEffect, (p) => p.getUtxosByOutRef(asInputs)),
      (us) => `${us.length} of ${asInputs.length} still unspent — the filter, on the wire`,
    )
  }

  /**
   * Depth, not presence: a landed transaction is many confirmations deep.
   *
   * ⚠️ Through Pnyx's own `awaitConfirmations`, which is the production path — Evolution's
   * `awaitTx` answers presence, and the depth poll over `getTxConfirmations` is ours.
   */
  await drive(
    'awaitConfirmations depth 2',
    Effect.flatMap(EvProvider.ProviderEffect, (p) =>
      awaitConfirmations(p, accountTxs[0]!.txHash, {tries: 1, intervalMs: 1, confirmations: 2}),
    ),
    (ok) => `confirmed at depth 2: ${ok}`,
  )

  await drive(
    'getUtxosOfTransaction',
    member('getUtxosOfTransaction', (m) => m(accountTxs[0]!.txHash)),
    (os) => `${os.length} outputs produced`,
  )
}

await drive(
  'getAccountInfo',
  member('getAccountInfo', (m) => m(STAKE)),
  (a) => (a === null ? 'never seen on chain' : `registered ${a.registered}, pool ${a.delegatedPool ?? 'none'}`),
)

await drive(
  'getAccountUtxos offset+limit',
  member('getAccountUtxos', (m) => m(STAKE, {offset: 10, limit: 5})),
  (us) => `${us.length} utxos (windowed from 10)`,
)

await drive(
  'getChainParameters',
  member('getChainParameters', (m) => m()),
  (c) =>
    `protocol ${c.protocolVersion.major}.${c.protocolVersion.minor}, ${c.poolVotingThresholds.length} pool thresholds`,
)

await drive(
  'getDRep (one)',
  member('getDRep', (m) => m('drep_always_abstain')),
  (d) => (d === null ? 'not found' : `${d.drepId} active ${d.active}`),
)

await drive(
  'getCommittee',
  member('getCommittee', (m) => m()),
  (ms) => `${ms.length} members`,
)

await drive(
  'getProtocolParametersAt (tip epoch)',
  member('getProtocolParametersAt', (m) => m(tip?.epoch ?? 300)),
  (p) => `minFeeB ${p.minFeeB}`,
)

/**
 * The wallet's own conversion, over REAL chain rows.
 *
 * ⚠️ The balance is the most visible number in the app and this function computes it. Unit tests
 * build their UTxOs with Evolution's constructors, which is right but cannot produce the shapes
 * the chain actually holds — a token whose asset name is empty, a policy with several names under
 * it, an amount past 2^53. These rows come off preprod.
 */
console.log('\n=== the wallet\'s serialized-edge reads, over those rows ===\n')

const checkConversion = async (what: string, address: EvAddress.Address) => {
  const rows = await Effect.runPromise(
    Effect.flatMap(EvProvider.ProviderEffect, (p) => p.getUtxos(address)).pipe(Effect.provide(layer)),
  )
  // ⚠️ There is no conversion left to check — the rail carries these rows as they are. What still
  // needs live data is the SERIALIZED-EDGE reads: the `policy.name` spelling `utxoAssetMap` emits,
  // and that an empty asset name survives as empty rather than reading as absent.
  const lovelace = rows.reduce((sum, u) => sum + u.assets.lovelace, 0n)
  const assetKeys = new Set(rows.flatMap((u) => [...utxoAssetMap(u).keys()]))
  const tokens = rows.reduce((n, u) => n + utxoAssetMap(u).size, 0)
  const emptyNamed = [...assetKeys].filter((k) => k.endsWith('.')).length

  console.log(`  ${what}`)
  console.log(
    `    rows ${rows.length}, lovelace ${lovelace}`,
  )
  console.log(`    token entries ${tokens}, distinct assets ${assetKeys.size}, empty-named ${emptyNamed}`)
  console.log(
    `    every row has an address ${rows.every((u) => utxoAddressBech32(u).length > 0)}, every hash is 64 hex ${rows.every((u) => utxoTxHashHex(u).length === 64)}`,
  )

  /**
   * ⚠️ **The inline datum's ORIGINAL bytes, on the wire.**
   *
   * A script consumer matches a datum by its hash, so a datum that re-encodes differently hashes
   * differently and the match fails. Evolution records the bytes a datum arrived as through the
   * `OriginalBytes` side channel, and `cip113`/`cip139` emit `datum_hex` ONLY from that channel —
   * absent rather than re-derived, because a re-derivation is a fabrication of exactly what the
   * field exists to prevent. So the question a stubbed `fetch` cannot answer is whether Koios's
   * own decode populates it: if it does not, `datum_hex` is silently absent on the path we ship.
   */
  const inlineDatums = rows.flatMap((u) => {
    const d = u.datumOption
    return d !== undefined && EvInlineDatum.isInlineDatum(d) ? [d] : []
  })
  if (inlineDatums.length > 0) {
    const preserved = inlineDatums.filter((d) => OriginalBytes.get(d) !== undefined)
    const reencoded = inlineDatums.filter((d) => {
      const raw = OriginalBytes.get(d)
      return raw !== undefined && EvBytes.toHex(raw) !== EvData.toCBORHex(d.data)
    })
    console.log(
      `    inline datums ${inlineDatums.length}, original bytes preserved ${preserved.length}${
        preserved.length === inlineDatums.length ? '' : ' ⚠️ SOME LOST — datum_hex would be absent'
      }, re-encode differs on ${reencoded.length}`,
    )
  }
}

await checkConversion('an account with 3,000+ ADA-only UTxOs', ADDRESS)
// ⚠️ A SECOND address, because the first holds no tokens — so it exercises none of the
// multi-asset conversion, which is the half most likely to be wrong (a policy with several names
// under it, and an empty asset name that is a real name).
await checkConversion('a script address holding tokens', SCRIPT)

console.log('\n⚠️ Read-only: nothing above submitted a transaction.\n')
RequestBudget.setObserver(null)
