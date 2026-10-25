/**
 * The Midnight write path, as functions any surface can drive.
 *
 * Extracted from `useDappConnector`'s switch so the **agent** surface can reach the same review screens
 * the in-app browser does. There is one canonical review path in this app and nothing may sign outside
 * it, so a second caller gets these functions and the routes they navigate to — never a copy of the
 * screens (`docs/MCP_DEV_TOOL_SPEC.md` milestone 3). Shaped deliberately like
 * {@link module:./dapp-signing}'s `runSignTx`: everything surface-specific is injected, so the body is
 * the rule and nothing else.
 *
 * **Three requests, two of which need a person:**
 *
 * | request | screen | why |
 * |---|---|---|
 * | `makeTransfer` | `/wallet/midnight/review` | there is a transaction, and the user sees what a key authorises |
 * | `balanceUnsealedTransaction` | `/wallet/midnight/fund` | a transfer has a recipient and a funding does not; one screen covering both would render fields that cannot exist for one |
 * | `submitTransaction` | none | what is being authorised was authorised when it was built — the check that matters is *whose* bytes these are |
 *
 * ⚠️ **`builtByUs` is shared across surfaces on purpose.** The sponsor pays whatever `submitTransaction`
 * relays, so the wallet submits only what it built. An agent that calls `makeTransfer` and then
 * `submitTransaction` is the same wallet doing both — one set, injected, rather than one per surface,
 * which would make a transfer built in the browser unsubmittable by an agent and vice versa.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {ApiErrorCode, type MidnightErrorCode, type WalletResponse} from '@pnyx/dapp-connector'
import {isTransactionBound} from '@pnyx/midnight-native'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {registerMidnightDappTicket} from '../midnight/dapp-tickets'
import {runMidnight} from '../midnight/effect-boundary'
import {submitSealedTransaction} from '../midnight/submit-sealed'
import {discardPendingDustSpend} from '../midnight/wallet/dust-state-store'
import {submitSponsoredTransfer} from '../pnyx-proving'

const ORIGIN = 'midnight-signing'

/** An output as `makeTransfer` describes it. */
export type MidnightTransferOutput = {
  readonly kind: string
  readonly recipient: string
  readonly tokenType: string
  readonly value: bigint
}

/** Remembering which bytes this wallet built, so only those are ever relayed. */
export type BuiltByUs = {
  readonly remember: (txHex: string) => void
  readonly forget: (txHex: string) => void
  readonly has: (txHex: string) => boolean
}

/** How a Midnight request answers its caller, and how it reaches a screen. */
type Common = {
  readonly id: string
  readonly origin: string
  /**
   * The wallet and account this request is for, and how to name it on screen.
   *
   * ⚠️ Named by the caller, never taken from the selection: an agent may be granted several wallets, and
   * the review has to build and persist against the one the call named.
   */
  readonly wallet: {readonly groupId: string; readonly accountIndex: number; readonly label: string}
  readonly answer: (response: WalletResponse) => void
  readonly navigate: (href: string) => void
  readonly builtByUs: BuiltByUs
}

/**
 * The CIP-30 number to send beside a Midnight code.
 *
 * The two vocabularies differ in size — CIP-30 has four codes, Midnight's union six — so the number is
 * the coarse one a Cardano-shaped page understands while `apiCode` carries the detail. Only a genuine
 * refusal is `Refused`: a wallet that cannot fund something has not refused it.
 */
export const wireCodeFor = (apiCode: MidnightErrorCode): number => {
  switch (apiCode) {
    case 'Rejected':
    case 'PermissionRejected':
      return ApiErrorCode.Refused
    case 'InvalidRequest':
      return ApiErrorCode.InvalidRequest
    default:
      return ApiErrorCode.InternalError
  }
}

const refuse = (
  params: {readonly id: string; readonly answer: (r: WalletResponse) => void},
  apiCode: MidnightErrorCode,
  message: string,
): void => params.answer({id: params.id, error: {code: wireCodeFor(apiCode), apiCode, message}})

/**
 * The one refusal both review paths share.
 *
 * ⚠️ **`payFees: false` asks the wallet to build a transaction that funds itself**, which the device can
 * now do (`services/midnight/send-self-funded.ts`). What blocks it here is the *hand-off*, not the
 * builder: these paths return the bytes to the caller and the **caller** submits, so the wallet never
 * learns whether the DUST its fee spent was actually spent. Persisting the post-spend state would strand
 * an output whenever the caller dropped the transaction; not persisting it would double-spend one
 * whenever they sent it — and neither is recoverable, because the fast sync refuses a wallet that has
 * spent DUST. Honouring it needs an outcome channel for handed-away transactions, or the event replay.
 */
const SELF_FUNDING_REFUSAL =
  'this wallet does not yet build a transfer that pays its own fee through the review flow; omit payFees or set it to true'

/**
 * `makeTransfer`: this wallet composes the whole transaction, and the user approves it on the Midnight
 * review screen.
 *
 * With `submit` false the bytes go back to whoever asked and nothing is sent — what a page wants, since
 * it submits for itself. With `submit` true the review sends it too, which is what an agent wants: it has
 * no rail of its own, so handing it bytes only forces a second call.
 */
export const runMidnightTransfer = (
  params: Common & {
    readonly outputs: readonly MidnightTransferOutput[]
    readonly payFees: boolean
    /**
     * Submit after approval rather than handing the bytes back.
     *
     * A page submits for itself; an agent has no rail of its own and wants the send.
     */
    readonly submit: boolean
  },
): void => {
  if (!params.payFees) {
    refuse(params, 'InvalidRequest', SELF_FUNDING_REFUSAL)
    return
  }
  const [output] = params.outputs
  if (output === undefined) {
    refuse(params, 'InvalidRequest', 'no output to transfer')
    return
  }
  const ticketId = registerMidnightDappTicket({
    kind: 'transfer',
    origin: params.origin,
    groupId: params.wallet.groupId,
    accountIndex: params.wallet.accountIndex,
    walletLabel: params.wallet.label,
    submitAfterApproval: params.submit,
    rail: output.kind === 'shielded' ? 'shielded' : 'unshielded',
    recipient: output.recipient,
    tokenType: output.tokenType,
    amount: output.value,
    settle: (txHex) => {
      params.builtByUs.remember(txHex)
      params.answer({id: params.id, result: {tx: txHex}})
    },
    // ⚠️ `Rejected` means **the user declined**, and it used to be the answer to every funding failure —
    // so a wallet that simply could not cover the amount told the caller its owner had refused.
    reject: (reason, apiCode = 'Rejected') => refuse(params, apiCode, reason),
  })
  params.navigate(`/wallet/midnight/review?dapp=${ticketId}`)
}

/**
 * `balanceUnsealedTransaction`: the caller composed the transaction and this wallet covers what it owes.
 *
 * Only the hex is carried through. What it owes is the ledger's statement, read from the bytes by the
 * screen — carrying a figure through here would put a second opinion beside the authoritative one.
 */
export const runMidnightBalance = (params: Common & {readonly txHex: string; readonly payFees: boolean}): void => {
  if (!params.payFees) {
    refuse(params, 'InvalidRequest', SELF_FUNDING_REFUSAL)
    return
  }
  const ticketId = registerMidnightDappTicket({
    kind: 'funding',
    origin: params.origin,
    groupId: params.wallet.groupId,
    accountIndex: params.wallet.accountIndex,
    walletLabel: params.wallet.label,
    txHex: params.txHex,
    settle: (txHex) => {
      // Remembered like a built transfer: the user approved *this* transaction, and the sponsor pays for
      // whatever `submitTransaction` relays.
      params.builtByUs.remember(txHex)
      params.answer({id: params.id, result: {tx: txHex}})
    },
    reject: (reason) => refuse(params, 'Rejected', reason),
  })
  params.navigate(`/wallet/midnight/fund?dapp=${ticketId}`)
}

/**
 * `submitTransaction`: relay bytes this wallet built, through the sponsor.
 *
 * No screen. What is being authorised was authorised when it was built, so the check that matters is
 * *whose* bytes these are — a transaction this wallet did not build would be sponsored by it, which is a
 * standing invitation to spend somebody else's fees.
 */
export const runMidnightSubmit = async (
  params: Omit<Common, 'navigate'> & {
    readonly txHex: string
    readonly sessionToken: string | undefined
    /**
     * Which Midnight network the bytes are for — the funds axis, from the app's selector.
     *
     * ⚠️ The sponsor holds one wallet per network and this is what picks it. It is not read from the
     * transaction because nothing in JavaScript can: the ledger bindings expose no `networkId`
     * accessor. The sponsor guards the bytes against its own network before spending, so a wrong value
     * here is a named refusal rather than a transaction on the wrong chain.
     */
    readonly networkId: string
  },
): Promise<void> => {
  if (!params.builtByUs.has(params.txHex)) {
    logger.warn('a caller asked us to submit a transaction we did not build', {
      origin: ORIGIN,
      dapp: params.origin,
      bytes: params.txHex.length / 2,
    })
    // Naming the rule lets a caller use makeTransfer rather than guess.
    refuse(params, 'InvalidRequest', 'this wallet submits only transactions it built — use makeTransfer first')
    return
  }
  if (params.sessionToken === undefined) {
    params.answer({
      id: params.id,
      error: {
        code: ApiErrorCode.InternalError,
        apiCode: 'InternalError',
        message: 'the wallet has no session to sponsor this submission',
      },
    })
    return
  }
  const decoded = hex.decode(params.txHex)
  if (decoded._tag === 'Left') {
    refuse(params, 'InvalidRequest', 'not a hex transaction')
    return
  }
  try {
    // ⚠️ **Which rail depends on who paid.** A sponsored transaction goes out pre-binding so the
    // service can merge its fee and bind it; one this wallet paid for from its own DUST is already
    // sealed, and the sponsor has nothing left to add — it refuses the shape, with a message about
    // neither the fee nor the transaction. The reader's own verdict decides, rather than a flag this
    // function would have to be told and could be told wrongly.
    if (await isTransactionBound(decoded.right)) {
      const {extrinsicHash} = await runMidnight(
        submitSealedTransaction({transaction: decoded.right, network: params.networkId}).pipe(
          // ⚠️ **A definitive rejection has to release the DUST it reserved.** The review screen records
          // the fee's spend as *pending* when it approves, because this function may never be called —
          // the page decides whether to submit. But a transaction the node has refused will never land,
          // so leaving the record standing poisons the next fee: it proves against a state carrying a
          // commitment the chain has never seen, and the node answers `Custom error: 170`
          // (`InvalidDustSpendProof`) — a message about a proof, for a bookkeeping fault.
          //
          // ⚠️ Only on `rejected`. An unreachable node may have taken the bytes, and discarding then
          // would let the next fee spend an output that is genuinely gone.
          Effect.tapError((error) =>
            error.cause === 'rejected'
              ? discardPendingDustSpend(params.wallet.groupId, params.wallet.accountIndex).pipe(
                  Effect.tap(() =>
                    Effect.sync(() =>
                      logger.info('the node refused a self-paid transaction, so its DUST is free again', {
                        origin: ORIGIN,
                        dapp: params.origin,
                        reason: error.reason,
                      }),
                    ),
                  ),
                  Effect.catchAll((storeError) =>
                    Effect.sync(() =>
                      logger.error('a refused transaction’s pending DUST spend could not be discarded', {
                        origin: ORIGIN,
                        dapp: params.origin,
                        error: String(storeError),
                      }),
                    ),
                  ),
                )
              : Effect.void,
          ),
        ),
      )
      params.builtByUs.forget(params.txHex)
      logger.info('a dApp transaction this wallet paid for was submitted directly', {
        origin: ORIGIN,
        dapp: params.origin,
        extrinsicHash,
        bytes: decoded.right.length,
      })
      // The same `null` the sponsored branch returns: the API is void, and inventing a field on one
      // of two rails would make the result depend on who paid.
      params.answer({id: params.id, result: null})
      return
    }
    await submitSponsoredTransfer(params.sessionToken, decoded.right, params.networkId)
    // Spent: a second submission of the same bytes is a double-spend the node would refuse anyway, and
    // forgetting them here says so earlier.
    params.builtByUs.forget(params.txHex)
    logger.info('a dApp transaction was submitted for sponsorship', {
      origin: ORIGIN,
      dapp: params.origin,
      bytes: decoded.right.length,
    })
    // The API returns void; there is nothing to report but success.
    params.answer({id: params.id, result: null})
  } catch (error) {
    logger.warn('a dApp transaction could not be submitted', {
      origin: ORIGIN,
      dapp: params.origin,
      error: String(error),
    })
    params.answer({
      id: params.id,
      error: {
        code: ApiErrorCode.InternalError,
        apiCode: 'InternalError',
        message: error instanceof Error ? error.message : 'the transaction could not be submitted',
      },
    })
  }
}
