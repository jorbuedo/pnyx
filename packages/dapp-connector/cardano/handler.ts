/**
 * Wallet-side Cardano CIP-30 (+95/142) handler. Data methods answer with exact wire encodings
 * (TransactionUnspentOutput / Value / raw-address hex), built from Evolution's own encoders;
 * `enable`/`signTx`/`signData` fail with sentinel errors the host app catches to drive its
 * connection/review UI.
 *
 * ⚠️ **The wire form IS the answer here, which is why hex appears at all.** CIP-30 specifies
 * `cbor<value>` and `cbor<transaction_unspent_output>`, so this is the serialized edge rather than
 * a conversion on the way to one — the handler works in bags and encodes once, where it used to
 * encode per UTxO and add the hexes pairwise.
 *
 * The host supplies an async {@link CardanoHandlerContext} — the handler never
 * caches wallet data.
 *
 * @module
 */

import type {QueryLayer as Cip139} from '@evolution-sdk/cip139'
import {
  Assets,
  Bytes,
  CBOR,
  Address as EvAddress,
  Credential as EvCredential,
  TransactionHash as EvTransactionHash,
  TransactionInput as EvTransactionInput,
  TxOut,
} from '@evolution-sdk/evolution'
import {AddressHex, TxHashHex, ValueHex} from '@evolution-sdk/review/Brands'
import {Tx} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import type {ChainHandler, MethodHandler} from '../resolver.js'
import {invalidRequest, refused} from '../resolver.js'
import {ApiErrorCode, ConnectionRequired, SignDataRequired, SignTxRequired, WireError} from '../types.js'
import {type CardanoUtxo, parseValueTarget, selectUtxosForTarget} from './utxo-selection.js'

/** Hex to bytes, strict: a malformed credential from a dApp must fail here, not later. */
const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error(`not hex: ${hex.slice(0, 32)}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export type {CardanoUtxo} from './utxo-selection.js'

/**
 * CIP-139 chain reads, with the library's Effect requirements already satisfied by the
 * host and failures normalized to the wire error type.
 *
 * Derived from `Cip139.QueryLayer` rather than restated, so adding an operation to the
 * library surfaces here as a type error instead of being quietly missing.
 */
export type CardanoQueryContext = {
  readonly [K in keyof Cip139.QueryLayer]: Cip139.QueryLayer[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer R, unknown, unknown>
    ? (...args: A) => Effect.Effect<R, WireError>
    : never
} & {
  /**
   * The two reads CIP-139 does not define, exposed under `api.experimental.*` — see
   * `Cip139.makeQueryExperimental`. `tip` is not optional in practice: without the
   * current slot a dApp cannot set a validity interval, so a strict 139 implementation
   * leaves it still needing its own backend for that one value.
   */
  readonly tip: Effect.Effect<unknown, WireError>
  readonly resolveOutpoints: (
    ...args: Parameters<Cip139.QueryExperimental['resolveOutpoints']>
  ) => Effect.Effect<unknown, WireError>
}

/**
 * The app-supplied data source. Addresses are raw address bytes as hex (the
 * CIP-30 wire form — not bech32).
 */
export type CardanoHandlerContext = {
  readonly networkId: Effect.Effect<number, WireError>
  /** CIP-142 network magic (mainnet 764824073, preprod 1, preview 2). */
  readonly networkMagic: Effect.Effect<number, WireError>
  readonly utxos: Effect.Effect<readonly CardanoUtxo[], WireError>
  /** Pure-ADA UTxOs reserved/usable as collateral. */
  readonly collateralUtxos: Effect.Effect<readonly CardanoUtxo[], WireError>
  readonly changeAddressHex: Effect.Effect<string, WireError>
  readonly usedAddressHexes: Effect.Effect<readonly string[], WireError>
  readonly unusedAddressHexes: Effect.Effect<readonly string[], WireError>
  readonly rewardAddressHexes: Effect.Effect<readonly string[], WireError>
  /** Submit a signed tx (CBOR hex) → tx hash. */
  readonly submitTx: (signedTxHex: string) => Effect.Effect<string, WireError>
  readonly pubDRepKeyHex: Effect.Effect<string, WireError>
  readonly registeredPubStakeKeyHexes: Effect.Effect<readonly string[], WireError>
  readonly unregisteredPubStakeKeyHexes: Effect.Effect<readonly string[], WireError>
  /**
   * CIP-139 chain reads. **Optional, and its absence is the off switch**: when the host
   * omits it the extension is neither advertised nor served, so a wallet build that does
   * not want to answer for arbitrary chain data simply does not pass it.
   *
   * Serving it spends the wallet's Koios budget on the dApp's traffic pattern, and that
   * budget is personal — each identity holds an authenticated tier obtained by signing
   * Koios's challenge with its own stake key (`services/cardano/koios-register.ts`).
   * Gating is therefore at ENABLE time, where the user approves the extension, and not
   * per call: a prompt per query would be unusable, and a dApp that has been granted the
   * extension has already been granted chain reads.
   */
  readonly query?: CardanoQueryContext
}

/** CIP-30 Paginate. */
type Paginate = {readonly page: number; readonly limit: number}

const asPaginate = (value: unknown): Paginate | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const p = value as {page?: unknown; limit?: unknown}
  // {paginate: undefined} JSON-serializes to {} over the bridge — treat as absent.
  if (typeof p.page !== 'number' || typeof p.limit !== 'number') return undefined
  return {page: p.page, limit: p.limit}
}

/** Apply CIP-30 pagination; out-of-range page → InvalidRequest carrying {maxSize}. */
const paginate = <T>(items: readonly T[], p: Paginate | undefined): Effect.Effect<readonly T[], WireError> => {
  if (!p) return Effect.succeed(items)
  if (p.limit <= 0 || p.page < 0) return Effect.fail(invalidRequest('invalid paginate arguments'))
  const maxSize = Math.ceil(items.length / p.limit)
  if (p.page > 0 && p.page >= maxSize) {
    return Effect.fail(
      new WireError({code: ApiErrorCode.InvalidRequest, message: 'paginate page out of range', data: {maxSize}}),
    )
  }
  return Effect.succeed(items.slice(p.page * p.limit, (p.page + 1) * p.limit))
}

/**
 * A host UTxO's contents as a bag.
 *
 * ⚠️ The asset keys are the DOTTED spelling the host hands over (`policy.name`), and
 * `Assets.fromRecord` reads that as well as its own joined one. Mixing the two answers `0n` for
 * an asset that is present, which is a plausible balance rather than an error.
 */
const utxoAssets = (utxo: CardanoUtxo): Assets.Assets =>
  Assets.fromRecord({
    lovelace: utxo.coin,
    ...Object.fromEntries(utxo.assets.map((a) => [`${a.policyHex}.${a.nameHex}`, a.quantity])),
  })

/**
 * One `TransactionUnspentOutput` hex (`[input, output]`) — the CIP-30 UTxO wire form.
 *
 * ⚠️ `encodingFormat: 'babbage'` is passed explicitly. Conway accepts both output shapes and
 * Evolution defaults to the Shelley array; a dApp balancing against these bytes must be shown the
 * shape the wallet would sign.
 */
const encodeUtxo = (utxo: CardanoUtxo): string =>
  Bytes.toHex(
    CBOR.encodeArrayAsDefinite([
      // The host's UTxO set is plain hex by the time it reaches us; these two fields are a
      // tx hash and raw address bytes by the context's contract, asserted once here.
      Bytes.fromHex(Tx.inputHex(TxHashHex(utxo.txHashHex), BigInt(utxo.index))),
      TxOut.toCBORBytes(
        new TxOut.TransactionOutput({
          address: EvAddress.fromHex(AddressHex(utxo.addressHex)),
          assets: utxoAssets(utxo),
          encodingFormat: 'babbage',
        }),
      ),
    ]),
  )

const encodeUtxos = (utxos: readonly CardanoUtxo[]): Effect.Effect<readonly string[], WireError> =>
  Effect.succeed(utxos.map(encodeUtxo))

export const createCardanoHandler = (
  context: CardanoHandlerContext,
  isConnected: (origin: string) => Effect.Effect<boolean>,
): ChainHandler => {
  const requireConnection = (origin: string): Effect.Effect<void, WireError> =>
    Effect.flatMap(isConnected(origin), (connected) => (connected ? Effect.void : Effect.fail(refused())))

  const methods = new Map<string, MethodHandler>()

  // ── connection ──
  methods.set('isEnabled', (_params, ctx) => isConnected(ctx.origin))
  methods.set('enable', (_params, ctx) =>
    Effect.flatMap(isConnected(ctx.origin), (connected) =>
      connected ? Effect.succeed(true) : Effect.fail(new ConnectionRequired({origin: ctx.origin})),
    ),
  )
  // CIP-139 is advertised only when the host actually wired the chain reads. The flag
  // tells a dApp it can stop bringing its own query layer, so claiming it without a
  // backend behind it would strand that dApp at its first call.
  methods.set('getExtensions', (_params, ctx) =>
    Effect.as(requireConnection(ctx.origin), [
      {cip: 95},
      {cip: 142},
      ...(context.query !== undefined ? [{cip: 139}] : []),
    ]),
  )

  // ── data ──
  methods.set('getNetworkId', (_params, ctx) => Effect.zipRight(requireConnection(ctx.origin), context.networkId))
  methods.set('cip142_getNetworkMagic', (_params, ctx) =>
    Effect.zipRight(requireConnection(ctx.origin), context.networkMagic),
  )

  methods.set('getBalance', (_params, ctx) =>
    Effect.gen(function* () {
      yield* requireConnection(ctx.origin)
      const utxos = yield* context.utxos
      // ⚠️ Summed as bags and encoded ONCE. CIP-30 asks for `cbor<value>`, so the hex is the
      // answer rather than a step: this used to encode a value per UTxO and add the hexes
      // pairwise, decoding and re-encoding the running total on every input.
      let total = Assets.zero
      for (const utxo of utxos) total = Assets.merge(total, utxoAssets(utxo))
      return ValueHex(Assets.toCBORHex(total))
    }),
  )

  methods.set('getUtxos', (params, ctx) =>
    Effect.gen(function* () {
      yield* requireConnection(ctx.origin)
      const p = params as {amount?: unknown; paginate?: unknown} | undefined
      const utxos = yield* context.utxos
      let filtered: readonly CardanoUtxo[] = utxos
      if (p?.amount !== undefined && p.amount !== null) {
        if (typeof p.amount !== 'string') {
          return yield* invalidRequest('getUtxos amount must be a cbor<value> hex string')
        }
        const target = yield* parseValueTarget(p.amount).pipe(
          Effect.mapError(() => invalidRequest('invalid getUtxos amount: expected cbor<value> hex or lovelace')),
        )
        const selected = selectUtxosForTarget(utxos, target)
        if (selected === null) return null // CIP-30: cannot satisfy the request
        filtered = selected
      }
      const paged = yield* paginate(filtered, asPaginate(p?.paginate))
      return yield* encodeUtxos(paged)
    }),
  )

  methods.set('getCollateral', (params, ctx) =>
    Effect.gen(function* () {
      yield* requireConnection(ctx.origin)
      const p = params as {amount?: unknown} | undefined
      let amount: bigint | undefined
      if (p?.amount !== undefined && p.amount !== null) {
        if (typeof p.amount !== 'string') return yield* invalidRequest('getCollateral amount must be a string')
        // CIP-30: cbor<Coin>; bare decimal accepted for reference-connector compat.
        amount = /^\d+$/.test(p.amount)
          ? BigInt(p.amount)
          : (yield* parseValueTarget(p.amount).pipe(
              Effect.mapError(() => invalidRequest('invalid getCollateral amount: expected cbor<Coin>')),
            )).coin
      }
      const utxos = yield* context.collateralUtxos
      if (amount !== undefined) {
        const total = utxos.reduce((acc, u) => acc + u.coin, 0n)
        if (total < amount) {
          return yield* Effect.fail(
            new WireError({code: ApiErrorCode.InternalError, message: 'insufficient collateral UTxOs available'}),
          )
        }
      }
      return yield* encodeUtxos(utxos)
    }),
  )

  methods.set('getUsedAddresses', (params, ctx) =>
    Effect.gen(function* () {
      yield* requireConnection(ctx.origin)
      const p = params as {paginate?: unknown} | undefined
      const pagination = asPaginate(p?.paginate) ?? asPaginate(p)
      return yield* paginate(yield* context.usedAddressHexes, pagination)
    }),
  )
  methods.set('getUnusedAddresses', (_params, ctx) =>
    Effect.zipRight(requireConnection(ctx.origin), context.unusedAddressHexes),
  )
  methods.set('getChangeAddress', (_params, ctx) =>
    Effect.zipRight(requireConnection(ctx.origin), context.changeAddressHex),
  )
  methods.set('getRewardAddresses', (_params, ctx) =>
    Effect.zipRight(requireConnection(ctx.origin), context.rewardAddressHexes),
  )

  // ── signing → sentinels ──
  methods.set('signTx', (params, ctx) =>
    Effect.gen(function* () {
      yield* requireConnection(ctx.origin)
      const p = params as {tx?: unknown; partialSign?: unknown} | string | undefined
      const txHex = typeof p === 'string' ? p : typeof p?.tx === 'string' ? p.tx : undefined
      const partialSign = typeof p === 'object' && p !== null && p.partialSign === true
      if (!txHex) return yield* invalidRequest('missing transaction parameter')
      return yield* Effect.fail(new SignTxRequired({txHex, partialSign, origin: ctx.origin}))
    }),
  )

  const signData: MethodHandler = (params, ctx) =>
    Effect.gen(function* () {
      yield* requireConnection(ctx.origin)
      const p = params as {addr?: unknown; payload?: unknown} | undefined
      if (typeof p?.addr !== 'string' || typeof p?.payload !== 'string') {
        return yield* invalidRequest('missing addr or payload parameter')
      }
      return yield* Effect.fail(new SignDataRequired({addressHex: p.addr, payloadHex: p.payload, origin: ctx.origin}))
    })
  methods.set('signData', signData)
  methods.set('cip95_signData', signData)

  // ── submission ──
  methods.set('submitTx', (params, ctx) =>
    Effect.gen(function* () {
      yield* requireConnection(ctx.origin)
      const p = params as {tx?: unknown} | string | undefined
      const txHex = typeof p === 'string' ? p : typeof p?.tx === 'string' ? p.tx : undefined
      if (!txHex) return yield* invalidRequest('missing transaction parameter')
      return yield* context.submitTx(txHex)
    }),
  )

  // ── CIP-95 governance ──
  methods.set('cip95_getPubDRepKey', (_params, ctx) =>
    Effect.zipRight(requireConnection(ctx.origin), context.pubDRepKeyHex),
  )
  methods.set('cip95_getRegisteredPubStakeKeys', (_params, ctx) =>
    Effect.zipRight(requireConnection(ctx.origin), context.registeredPubStakeKeyHexes),
  )
  methods.set('cip95_getUnregisteredPubStakeKeys', (_params, ctx) =>
    Effect.zipRight(requireConnection(ctx.origin), context.unregisteredPubStakeKeyHexes),
  )

  // ── CIP-139 Universal Query Layer ──
  //
  // Request shapes are the CIP's own (`CIP-0139/cip-0144.md`): a bare scalar for most
  // operations, `{}` for the listings, and a CIP-116 `Credential` object for the
  // payment-credential lookup. Every id is bech32 (`pool1…`, `drep1…`, `cc_hot1…`,
  // `gov_action1…`), so nothing needs re-encoding on the way through.
  const query = context.query
  if (query !== undefined) {
    /** A bare-string request parameter, tolerating `{value}` from a bridge that wraps. */
    const oneString = (params: unknown, what: string): Effect.Effect<string, WireError> => {
      if (typeof params === 'string') return Effect.succeed(params)
      const p = params as {value?: unknown} | null | undefined
      if (typeof p?.value === 'string') return Effect.succeed(p.value)
      return Effect.fail(invalidRequest(`${what} expects a ${what.replace(/^cip139_get/, '')} string`))
    }
    /**
     * Register an operation taking one bech32/hex string.
     *
     * `S` is whatever brand the library's query layer declares for that operation —
     * `Bech32`, `TxHashHex`, or a plain id. A dApp hands us an unvalidated string, so
     * the brand is applied after `oneString`'s wire check, which is all the provenance
     * an untrusted value can have; the codec still rejects a malformed one.
     */
    const oneStringOp = <S extends string>(
      name: string,
      call: (value: S) => Effect.Effect<unknown, WireError>,
    ): void => {
      methods.set(name, (params, ctx) =>
        Effect.gen(function* () {
          yield* requireConnection(ctx.origin)
          return yield* call((yield* oneString(params, name)) as S)
        }),
      )
    }
    /**
     * Register an operation whose argument is a DECODED domain value.
     *
     * ⚠️ The decode is the validation, and it replaced a cast. The query layer used to take
     * branded hex, so a dApp's string was branded after a type check and the brand asserted
     * nothing — a malformed value failed somewhere downstream, as whatever error that code
     * happened to raise. These decoders fail here, as `InvalidRequest`, which is what a
     * malformed argument from a dApp actually is.
     */
    const decodedOp = <A>(
      name: string,
      decode: (value: string) => A,
      call: (value: A) => Effect.Effect<unknown, WireError>,
    ): void => {
      methods.set(name, (params, ctx) =>
        Effect.gen(function* () {
          yield* requireConnection(ctx.origin)
          const raw = yield* oneString(params, name)
          const decoded = yield* Effect.try({
            try: () => decode(raw),
            catch: (e) => invalidRequest(`${name}: ${e instanceof Error ? e.message : String(e)}`),
          })
          return yield* call(decoded)
        }),
      )
    }
    /** Register an operation taking no arguments. */
    const noArgOp = (name: string, call: Effect.Effect<unknown, WireError>): void => {
      methods.set(name, (_params, ctx) => Effect.zipRight(requireConnection(ctx.origin), call))
    }

    // A dApp sends an address as bech32 or as raw hex; both are legitimate on this wire, so
    // both are accepted and anything else is an invalid request rather than a later failure.
    decodedOp(
      'cip139_getUtxosByAddress',
      (value) => (value.startsWith('addr') ? EvAddress.fromBech32(value) : EvAddress.fromHex(value)),
      query.getUtxosByAddress,
    )
    // A reward address is bech32 by definition — the branded string their type declares.
    oneStringOp('cip139_getUtxosByStakeCredential', query.getUtxosByStakeCredential)
    decodedOp('cip139_getUtxosByTransactionHash', EvTransactionHash.fromHex, query.getUtxosByTransactionHash)
    oneStringOp('cip139_getVotesByDrepId', query.getVotesByDrepId)
    oneStringOp('cip139_getVotesBySpoId', query.getVotesBySpoId)
    oneStringOp('cip139_getVotesByCcId', query.getVotesByCcId)
    oneStringOp('cip139_getVotesByProposalId', query.getVotesByProposalId)
    oneStringOp('cip139_getDrepById', query.getDrepById)
    oneStringOp('cip139_getDrepByStakeCredential', query.getDrepByStakeCredential)
    oneStringOp('cip139_getCommitteeMemberById', query.getCommitteeMemberById)
    oneStringOp('cip139_getPoolById', query.getPoolById)
    oneStringOp('cip139_getProposalById', query.getProposalById)

    noArgOp('cip139_getProtocolParametersByLatest', query.getProtocolParametersByLatest())
    noArgOp('cip139_getAllDreps', query.getAllDreps())
    noArgOp('cip139_getAllCommitteeMembers', query.getAllCommitteeMembers())
    noArgOp('cip139_getAllPools', query.getAllPools())
    noArgOp('cip139_getAllProposals', query.getAllProposals())

    methods.set('cip139_getUtxosByAsset', (params, ctx) =>
      Effect.gen(function* () {
        yield* requireConnection(ctx.origin)
        const p = params as {asset_name?: unknown; minting_policy_hash?: unknown} | null | undefined
        if (typeof p?.asset_name !== 'string' || typeof p?.minting_policy_hash !== 'string') {
          return yield* invalidRequest('cip139_getUtxosByAsset expects {asset_name, minting_policy_hash} hex strings')
        }
        return yield* query.getUtxosByAsset(p.asset_name, p.minting_policy_hash)
      }),
    )

    methods.set('cip139_getUtxosByPaymentCredential', (params, ctx) =>
      Effect.gen(function* () {
        yield* requireConnection(ctx.origin)
        // A CIP-116 `Credential` is `{tag: 'pubkey_hash' | 'script_hash', value: hex}`.
        // The hash is what the lookup needs; a bare hex string is accepted too, since
        // that is what a hand-rolled caller reaches for first.
        const p = params as {value?: unknown; tag?: unknown} | string | null | undefined
        const hex = typeof p === 'string' ? p : typeof p?.value === 'string' ? p.value : undefined
        if (hex === undefined) {
          return yield* invalidRequest('cip139_getUtxosByPaymentCredential expects a CIP-116 Credential or a hex hash')
        }
        // 28 bytes of key hash. A script credential cannot be told from a key one by its
        // bytes, and CIP-139's query is defined over the PAYMENT credential a wallet holds,
        // which is a key hash — so a script hash is refused rather than guessed at.
        const credential = yield* Effect.try({
          try: () => EvCredential.makeKeyHash(hexToBytes(hex)),
          catch: (e) =>
            invalidRequest(`cip139_getUtxosByPaymentCredential: ${e instanceof Error ? e.message : String(e)}`),
        })
        return yield* query.getUtxosByPaymentCredential(credential)
      }),
    )

    methods.set('cip139_getProtocolParametersByEpoch', (params, ctx) =>
      Effect.gen(function* () {
        yield* requireConnection(ctx.origin)
        const p = params as {value?: unknown} | number | null | undefined
        const epoch = typeof p === 'number' ? p : typeof p?.value === 'number' ? p.value : undefined
        if (epoch === undefined || !Number.isInteger(epoch) || epoch < 0) {
          return yield* invalidRequest('cip139_getProtocolParametersByEpoch expects a non-negative integer epoch')
        }
        return yield* query.getProtocolParametersByEpoch(epoch)
      }),
    )

    // ── the two gap fillers, under `experimental` so they cannot be read as standard ──
    noArgOp('experimental_tip', query.tip)
    methods.set('experimental_resolveOutpoints', (params, ctx) =>
      Effect.gen(function* () {
        yield* requireConnection(ctx.origin)
        const p = params as {refs?: unknown} | readonly unknown[] | null | undefined
        const raw = Array.isArray(p)
          ? p
          : Array.isArray((p as {refs?: unknown})?.refs)
            ? (p as {refs: unknown[]}).refs
            : undefined
        if (raw === undefined) {
          return yield* invalidRequest('experimental_resolveOutpoints expects an array of {txHash, index}')
        }
        const refs: {txHash: string; index: number}[] = []
        for (const r of raw) {
          const ref = r as {txHash?: unknown; index?: unknown}
          if (typeof ref?.txHash !== 'string' || typeof ref?.index !== 'number') {
            return yield* invalidRequest('each outpoint must be {txHash: string, index: number}')
          }
          refs.push({txHash: ref.txHash, index: ref.index})
        }
        const inputs = yield* Effect.try({
          try: () =>
            refs.map(
              (ref) =>
                new EvTransactionInput.TransactionInput({
                  transactionId: EvTransactionHash.fromHex(ref.txHash),
                  index: BigInt(ref.index),
                }),
            ),
          catch: (e) => invalidRequest(`cip139_resolveOutpoints: ${e instanceof Error ? e.message : String(e)}`),
        })
        return yield* query.resolveOutpoints(inputs)
      }),
    )
  }

  return {chainType: 'cardano', methods}
}
