/**
 * Wallet-side Midnight dApp-connector handler — `@midnight-ntwrk/dapp-connector-api` 4.1.
 *
 * ⚠️ **Nobody else offers this.** Lace's connector is an extension, Moth's is an extension, ows has no
 * injection at all — so a Midnight dApp cannot reach a phone user anywhere today. The bridge this rides
 * is the one the Cardano connector already uses; only the chain and the method table differ.
 *
 * Like the Cardano handler, the host supplies an async {@link MidnightHandlerContext} and this module
 * caches nothing.
 *
 * `signData` fails with a **sentinel** rather than answering: signing arbitrary bytes with the user's key
 * needs their approval, so the host catches it and drives the signing UI, exactly as the Cardano handler
 * does for CIP-8. The payload is decoded to bytes here, where the encoding rule is pure and tested, so
 * the signer never has to guess at a text encoding.
 *
 * Everything else in the connector's read surface is served. An unregistered method answers
 * `InvalidRequest` through the resolver, so a dApp discovers what this wallet does rather than receiving
 * a fabricated address or a zero balance it would treat as real.
 *
 * @module
 */

import type {Configuration, ConnectionStatus, HistoryEntry} from '@midnight-ntwrk/dapp-connector-api'
import {Effect} from 'effect'
import type {ChainHandler, MethodHandler} from '../resolver.js'
import {invalidRequest, refused, unsupported} from '../resolver.js'
import {
  ConnectionRequired,
  MidnightAppSecretRequired,
  MidnightBalanceRequired,
  MidnightSignDataRequired,
  MidnightSubmitRequired,
  MidnightTransferRequired,
  type WireError,
} from '../types.js'
import {readAppSecretRequest} from './app-secret.js'
import {readBalanceRequest} from './balance-request.js'
import {readProvingCheckRequest, readProvingProveRequest} from './proving.js'
import {readSignDataRequest} from './sign-data.js'
import {readTransferRequest} from './transfer.js'

/**
 * The app-supplied data source. Addresses are Bech32m, as the connector API specifies — not raw bytes,
 * which is where the Cardano side differs.
 */
export type MidnightHandlerContext = {
  readonly unshieldedAddress: Effect.Effect<string, WireError>
  /** The wallet's own DUST address — derived, not the designated destination, which may be a stranger's. */
  readonly dustAddress: Effect.Effect<string, WireError>
  readonly shieldedAddresses: Effect.Effect<
    {
      readonly shieldedAddress: string
      readonly shieldedCoinPublicKey: string
      readonly shieldedEncryptionPublicKey: string
    },
    WireError
  >
  /**
   * Balances per token type, as atomic `bigint`s keyed by the 64-hex token type.
   *
   * NIGHT is `00…0` (32 zero bytes) and is included like any other — the API's own wording is
   * "potentially including Night".
   */
  readonly unshieldedBalances: Effect.Effect<Readonly<Record<string, bigint>>, WireError>
  /**
   * Shielded balances per token type, from the locally synced Zswap state.
   *
   * ⚠️ **A wallet that has never synced must fail here, not answer `{}`.** The API has no way to say
   * "unknown", and an empty record is the answer for a wallet that holds nothing — two different facts
   * a dApp would act on differently.
   */
  readonly shieldedBalances: Effect.Effect<Readonly<Record<string, bigint>>, WireError>
  /**
   * Current DUST and the ceiling the held NIGHT can generate.
   *
   * Both come from the indexer's `dustGenerationStatus` (`currentCapacity` / `maxCapacity`), so this
   * needs **no dust sync**: the numbers are readable without the wallet holding any dust state.
   */
  /**
   * Spendable DUST, and the ceiling the wallet's NIGHT generates towards.
   *
   * ⚠️ **Two facts from two sources, and `cap` may be absent.** `balance` is what this wallet can spend
   * now; `cap` comes from the DUST *generation registration*, which a wallet need not have — so `null`
   * means "no registration to read a ceiling from", never "a ceiling of zero". Reporting zero for an
   * absent registration is what made a wallet holding spendable DUST look like it had none.
   */
  readonly dustBalance: Effect.Effect<{readonly cap: bigint | null; readonly balance: bigint}, WireError>
  /**
   * Check a dApp's proof preimage against its circuit — the ZKIR alone, no keys and no SRS.
   *
   * `undefined` entries are the API's "nothing skipped here"; the shape is the ledger's own pi-skip
   * sequence, so it is passed through rather than reinterpreted.
   */
  readonly checkPreimage: (zkir: Uint8Array, preimage: Uint8Array) => Effect.Effect<(number | undefined)[], WireError>
  /**
   * Prove a dApp's circuit on this device, optionally binding the preimage to a caller's input.
   *
   * Seconds of CPU. The wallet is the prover here, not a proxy to one — which is the whole reason this
   * method is worth having.
   */
  readonly proveCircuit: (params: {
    /** Names the circuit; the material is omitted when the page believes the device already has it. */
    readonly digest: string
    readonly zkir?: Uint8Array
    readonly proverKey?: Uint8Array
    readonly verifierKey?: Uint8Array
    readonly preimage: Uint8Array
    readonly bindingInput?: Uint8Array
  }) => Effect.Effect<Uint8Array, WireError>
  readonly configuration: Effect.Effect<Configuration, WireError>
  readonly connectionStatus: Effect.Effect<ConnectionStatus, WireError>
  /**
   * One page of history, newest first. `pageNumber` is 1-based in the API.
   *
   * Paging is the host's job because only it knows how much history it holds.
   */
  readonly txHistory: (pageNumber: number, pageSize: number) => Effect.Effect<readonly HistoryEntry[], WireError>
  /**
   * A dApp's advance notice of which methods it intends to call, so the wallet can warm what they need.
   *
   * Advisory by design: the API specifies no effect a dApp may depend on, so ignoring it is conformant
   * and acting on it is an optimisation.
   */
  readonly hintUsage: (methods: readonly string[]) => Effect.Effect<void, WireError>
}

/** Rejects anything but an empty/absent parameter list, so a typo'd call is not silently answered. */
const noParams =
  (method: string) =>
  (params: unknown): Effect.Effect<void, WireError> => {
    if (params === undefined || params === null) return Effect.void
    if (Array.isArray(params) && params.length === 0) return Effect.void
    return Effect.fail(invalidRequest(`${method} takes no parameters`))
  }

/**
 * `getTxHistory(pageNumber, pageSize)`.
 *
 * Both must be positive integers. A zero or negative page is rejected rather than coerced to the first
 * one: a dApp paging from 0 would silently receive page 1 twice and conclude the history repeats.
 */
const readPaging = (params: unknown): Effect.Effect<{page: number; size: number}, WireError> => {
  const args = Array.isArray(params) ? params : []
  const [page, size] = args
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
  if (!ok(page) || !ok(size)) {
    return Effect.fail(invalidRequest('getTxHistory takes a positive integer pageNumber and pageSize'))
  }
  return Effect.succeed({page, size})
}

/**
 * Atomic amounts cross the bridge as **decimal strings**, never as `bigint` or `Number`.
 *
 * The transport is `JSON.stringify` over `postMessage`, which throws on a bigint; a `Number` would round
 * anything past 2^53. The injected provider converts back on the page side, so the dApp still sees the
 * `bigint` the API promises.
 */
const asDecimal = (value: bigint): string => value.toString()

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * The methods this wallet serves, and only those.
 *
 * ⚠️ **Everything but `getConnectionStatus` needs an authorised session.** A page that has not been
 * approved must not be able to read an address, a balance or a history — those are the whole reason the
 * approval exists. `connect` is what asks for it: with no session it fails with `ConnectionRequired`,
 * which the host catches to raise the approval sheet, exactly as CIP-30's `enable` does.
 *
 * `getConnectionStatus` stays open on purpose. It is the one method whose honest answer when
 * unauthorised is *an answer* — `disconnected` — rather than a refusal, and a dApp needs to be able to
 * ask before prompting the user.
 */
export const createMidnightHandler = (
  context: MidnightHandlerContext,
  isConnected: (origin: string) => Effect.Effect<boolean>,
): ChainHandler => {
  const requireConnection = (origin: string): Effect.Effect<void, WireError> =>
    Effect.flatMap(isConnected(origin), (connected) => (connected ? Effect.void : Effect.fail(refused())))
  const nullary =
    <A>(method: string, effect: Effect.Effect<A, WireError>): MethodHandler =>
    (params, ctx) =>
      noParams(method)(params).pipe(Effect.andThen(requireConnection(ctx.origin)), Effect.andThen(effect))

  const methods = new Map<string, MethodHandler>([
    [
      'getUnshieldedAddress',
      nullary(
        'getUnshieldedAddress',
        context.unshieldedAddress.pipe(Effect.map((unshieldedAddress) => ({unshieldedAddress}))),
      ),
    ],
    [
      'getDustAddress',
      nullary('getDustAddress', context.dustAddress.pipe(Effect.map((dustAddress) => ({dustAddress})))),
    ],
    ['getShieldedAddresses', nullary('getShieldedAddresses', context.shieldedAddresses)],
    [
      'getUnshieldedBalances',
      nullary(
        'getUnshieldedBalances',
        context.unshieldedBalances.pipe(
          Effect.map((balances) => Object.fromEntries(Object.entries(balances).map(([t, v]) => [t, asDecimal(v)]))),
        ),
      ),
    ],
    [
      'getShieldedBalances',
      nullary(
        'getShieldedBalances',
        context.shieldedBalances.pipe(
          // Decimal strings, like the unshielded side: JSON cannot carry a bigint, and a coin is a
          // Uint<128>. The injected provider restores them.
          Effect.map((balances) => Object.fromEntries(Object.entries(balances).map(([t, v]) => [t, asDecimal(v)]))),
        ),
      ),
    ],
    [
      'getDustBalance',
      nullary(
        'getDustBalance',
        context.dustBalance.pipe(
          // `cap` stays null rather than becoming '0': an absent registration is not a ceiling of zero.
          Effect.map(({cap, balance}) => ({cap: cap === null ? null : asDecimal(cap), balance: asDecimal(balance)})),
        ),
      ),
    ],
    ['getConfiguration', nullary('getConfiguration', context.configuration)],
    [
      // Ungated: "are we connected?" must be answerable before a connection exists, and the answer for
      // an unauthorised page is `disconnected` rather than an error.
      'getConnectionStatus',
      (params, ctx) =>
        noParams('getConnectionStatus')(params).pipe(
          Effect.andThen(isConnected(ctx.origin)),
          Effect.flatMap((connected) =>
            connected ? context.connectionStatus : Effect.succeed({status: 'disconnected' as const}),
          ),
        ),
    ],
    [
      // What the page's `connect(networkId)` calls. Approval is the host's job, so this only decides
      // whether one is needed.
      'connect',
      (params, ctx) => {
        const args = Array.isArray(params) ? params : []
        const requested = args[0]
        if (requested !== undefined && typeof requested !== 'string') {
          return Effect.fail(invalidRequest('connect takes a network id string'))
        }
        return Effect.gen(function* () {
          if (!(yield* isConnected(ctx.origin))) {
            return yield* Effect.fail(new ConnectionRequired({origin: ctx.origin}))
          }
          const status = yield* context.connectionStatus
          // Refusing a network mismatch here is the point: an API bound to a chain the dApp did not ask
          // for is the one error it cannot detect afterwards.
          if (status.status === 'connected' && requested !== undefined && status.networkId !== requested) {
            return yield* Effect.fail(invalidRequest(`this wallet is on ${status.networkId}, not ${requested}`))
          }
          return status
        })
      },
    ],
    [
      'getTxHistory',
      (params, ctx) =>
        readPaging(params).pipe(
          Effect.tap(() => requireConnection(ctx.origin)),
          Effect.andThen(({page, size}) => context.txHistory(page, size)),
        ),
    ],
    [
      'signData',
      (params, ctx) => {
        const read = readSignDataRequest(params)
        if (!read.ok) return Effect.fail(read.error)
        const {message, data} = read.request
        // Authorisation first, then the user's approval of this particular payload. An unapproved page
        // must not even reach the signing sheet.
        // The host signs and answers; nothing is signed without the user seeing it.
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(
            Effect.fail(new MidnightSignDataRequired({messageHex: toHex(message), data, origin: ctx.origin})),
          ),
        )
      },
    ],
    [
      // Build + sign, then hand the bytes back — the host raises the review, so this only decides
      // whether the request is one the wallet could honour. Nothing is submitted here.
      'makeTransfer',
      (params, ctx) => {
        const read = readTransferRequest(params)
        if (!read.ok) return Effect.fail(read.error)
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(
            Effect.fail(
              new MidnightTransferRequired({
                outputs: read.request.outputs,
                payFees: read.request.payFees,
                submit: read.request.submit,
                origin: ctx.origin,
              }),
            ),
          ),
        )
      },
    ],
    [
      // Funding a transaction somebody else composed. Like `makeTransfer` this only decides whether the
      // request is one the wallet could honour — what the transaction actually owes is the ledger's
      // statement, read natively by the host, and it is what the review screen names.
      'balanceUnsealedTransaction',
      (params, ctx) => {
        const read = readBalanceRequest(params)
        if (!read.ok) return Effect.fail(read.error)
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(
            Effect.fail(
              new MidnightBalanceRequired({
                txHex: read.request.txHex,
                payFees: read.request.payFees,
                origin: ctx.origin,
              }),
            ),
          ),
        )
      },
    ],
    [
      // The wallet as relayer. The session the sponsor requires lives in the host, so this routes
      // rather than answers.
      'submitTransaction',
      (params, ctx) => {
        const args = Array.isArray(params) ? params : []
        const txHex = args[0]
        if (typeof txHex !== 'string' || txHex === '' || txHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(txHex)) {
          return Effect.fail(invalidRequest('submitTransaction takes a hex-encoded transaction'))
        }
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(Effect.fail(new MidnightSubmitRequired({txHex: txHex.toLowerCase(), origin: ctx.origin}))),
        )
      },
    ],
    [
      // Declared and refused, which is the honest shape for something this wallet cannot do rather
      // than has not got round to. A sealed transaction is cryptographically bound, so adding inputs
      // means re-binding it, and re-binding needs the DUST fee — which lives with the sponsor, not
      // here. The API's own documentation tells a dApp to use `balanceUnsealedTransaction` when the
      // wallet cannot balance a sealed one, so the refusal names that route.
      'balanceSealedTransaction',
      (_params, ctx) =>
        requireConnection(ctx.origin).pipe(
          Effect.andThen(
            Effect.fail(
              unsupported(
                'this wallet cannot balance a sealed transaction: it is already bound, and re-binding needs the DUST fee a sponsor holds — use balanceUnsealedTransaction',
              ),
            ),
          ),
        ),
    ],
    [
      // Declared and refused because it is not built yet, which is a different fact from the one
      // above and says so. The design is settled (a sibling of the unshielded transfer builder with a
      // caller-chosen segment and no change output); it needs one native export.
      'makeIntent',
      (_params, ctx) =>
        requireConnection(ctx.origin).pipe(
          Effect.andThen(Effect.fail(unsupported('this wallet does not build intents yet'))),
        ),
    ],
    [
      // Not in the connector API: a wallet extension method (Moth's `specs/003-derive-app-secret`),
      // implemented under their vendor-neutral constants so one seed derives one secret everywhere.
      'deriveAppSecret',
      (params, ctx) => {
        const read = readAppSecretRequest(params)
        if (!read.ok) return Effect.fail(read.error)
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(Effect.fail(new MidnightAppSecretRequired({domain: read.domain, origin: ctx.origin}))),
        )
      },
    ],
    [
      // The handshake only: the callable provider is built in the page, because the API's
      // `KeyMaterialProvider` argument and `ProvingProvider` result are objects with methods and
      // neither can cross a JSON bridge. This says "yes, and you are authorised".
      'getProvingProvider',
      nullary('getProvingProvider', Effect.succeed(true)),
    ],
    [
      'provingProviderCheck',
      (params, ctx) => {
        const read = readProvingCheckRequest(params)
        if (!read.ok) return Effect.fail(read.error)
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(context.checkPreimage(read.request.zkir, read.request.preimage)),
        )
      },
    ],
    [
      'provingProviderProve',
      (params, ctx) => {
        const read = readProvingProveRequest(params)
        if (!read.ok) return Effect.fail(read.error)
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(context.proveCircuit(read.request)),
          // Hex on the way out for the same reason the keys arrive as hex: the bridge is JSON.
          Effect.map(toHex),
        )
      },
    ],
    [
      'hintUsage',
      (params, ctx) => {
        const args = Array.isArray(params) ? params : []
        const names = args[0]
        if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
          return Effect.fail(invalidRequest('hintUsage takes an array of method names'))
        }
        // Resolves to `null` rather than `undefined`: the wire form is JSON, where `undefined`
        // disappears from the response object and a dApp cannot tell success from a dropped field.
        return requireConnection(ctx.origin).pipe(
          Effect.andThen(context.hintUsage(names as readonly string[])),
          Effect.as(null),
        )
      },
    ],
  ])

  return {chainType: 'midnight', methods}
}
