// The Midnight write path is shared by the in-app browser and the agent surface, so these rules are now
// load-bearing for two callers. The sharpest one is `submitTransaction`: the sponsor pays the fee, so
// relaying bytes this wallet did not build is spending someone else's money.
import type {MidnightErrorCode, WalletResponse} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

/** Typed with its parameter so `mock.calls[0][0]` is the ticket rather than an empty tuple. */
const registerMidnightDappTicket = vi.fn((_ticket: unknown): string => 'mnt-1')
vi.mock('../midnight/dapp-tickets', () => ({
  registerMidnightDappTicket: (t: unknown) => registerMidnightDappTicket(t as never),
}))
// `@pnyx/midnight-native` reaches expo-modules-core, which does not load under vitest. Only the one
// reader this module uses is stubbed, and it is the switch between the two submission rails — so every
// test below states which rail it expects rather than inheriting a default.
const isTransactionBound = vi.fn(async () => false)
vi.mock('@pnyx/midnight-native', () => ({
  isTransactionBound: (...args: unknown[]) => isTransactionBound(...(args as [])),
}))
const submitSealedTransaction = vi.fn()
vi.mock('../midnight/submit-sealed', () => ({
  submitSealedTransaction: (...args: unknown[]) => submitSealedTransaction(...args),
}))
const discardPendingDustSpend = vi.fn(() => Effect.void)
vi.mock('../midnight/wallet/dust-state-store', () => ({
  discardPendingDustSpend: (...args: unknown[]) => discardPendingDustSpend(...(args as [])),
}))
const submitSponsoredTransfer = vi.fn()
vi.mock('../pnyx-proving', () => ({
  // ⚠️ Spread, not a re-listed parameter list. Naming the parameters here made the mock silently drop
  // `network` when the production signature gained it — the assertion below caught it, but a mock that
  // re-declares a signature is a place where any new argument disappears without a word.
  submitSponsoredTransfer: (...args: unknown[]) => submitSponsoredTransfer(...args),
}))

const {runMidnightBalance, runMidnightSubmit, runMidnightTransfer, wireCodeFor} = await import('./midnight-signing')

/** A set-backed handle, the same shape the hook passes. */
const builtByUsWith = (initial: readonly string[] = []) => {
  const set = new Set(initial)
  return {
    set,
    handle: {
      remember: (tx: string) => set.add(tx),
      forget: (tx: string) => set.delete(tx),
      has: (tx: string) => set.has(tx),
    },
  }
}

const output = {kind: 'unshielded', recipient: 'mn_addr1abc', tokenType: 'aa'.repeat(32), value: 5n}
/** The wallet a request names — never the selected one, which is the point of carrying it. */
const wallet = {groupId: 'g1', accountIndex: 0, label: 'Test wallet · Account 0'}

const captured = () => {
  const answers: WalletResponse[] = []
  const routes: string[] = []
  return {answers, routes, answer: (r: WalletResponse) => answers.push(r), navigate: (h: string) => routes.push(h)}
}

beforeEach(() => {
  registerMidnightDappTicket.mockClear()
  registerMidnightDappTicket.mockReturnValue('mnt-1')
  submitSponsoredTransfer.mockReset()
  submitSponsoredTransfer.mockResolvedValue(undefined)
  submitSealedTransaction.mockReset()
  isTransactionBound.mockReset()
  // Unbound by default, which is the sponsored rail. The sealed tests say so explicitly.
  isTransactionBound.mockResolvedValue(false)
  discardPendingDustSpend.mockClear()
})

describe('runMidnightTransfer', () => {
  it('registers a ticket and navigates to the Midnight review route', () => {
    const c = captured()
    const {handle} = builtByUsWith()
    runMidnightTransfer({
      id: 'm1',
      origin: 'mcp://agent',
      outputs: [output],
      wallet,
      submit: false,
      payFees: true,
      ...c,
      builtByUs: handle,
    })
    expect(c.routes).toEqual(['/wallet/midnight/review?dapp=mnt-1'])
    expect(c.answers).toEqual([])
  })

  // ⚠️ The hand-off problem, not a builder problem: these paths return the bytes and the *caller*
  // submits, so the wallet never learns whether the DUST its fee spent was actually spent.
  it('refuses a self-funding transfer, and does not reach a screen', () => {
    const c = captured()
    runMidnightTransfer({
      id: 'm1',
      origin: 'mcp://agent',
      outputs: [output],
      wallet,
      submit: false,
      payFees: false,
      ...c,
      builtByUs: builtByUsWith().handle,
    })
    expect(c.routes).toEqual([])
    expect(c.answers[0]?.error?.message).toContain('pays its own fee')
    expect(registerMidnightDappTicket).not.toHaveBeenCalled()
  })

  it('refuses a transfer with no outputs', () => {
    const c = captured()
    runMidnightTransfer({
      id: 'm1',
      origin: 'mcp://agent',
      outputs: [],
      wallet,
      submit: false,
      payFees: true,
      ...c,
      builtByUs: builtByUsWith().handle,
    })
    expect(c.answers[0]?.error?.message).toContain('no output')
    expect(registerMidnightDappTicket).not.toHaveBeenCalled()
  })

  // Settling remembers the bytes, which is what makes them submittable at all.
  it('remembers what the review built, and answers with it', () => {
    const c = captured()
    const {set, handle} = builtByUsWith()
    runMidnightTransfer({
      id: 'm1',
      origin: 'mcp://agent',
      outputs: [output],
      wallet,
      submit: false,
      payFees: true,
      ...c,
      builtByUs: handle,
    })
    const ticket = registerMidnightDappTicket.mock.calls[0]?.[0] as unknown as {
      settle: (tx: string) => void
      rail: string
    }
    ticket.settle('abcd')
    expect(set.has('abcd')).toBe(true)
    expect(c.answers[0]).toEqual({id: 'm1', result: {tx: 'abcd'}})
    // An unshielded output is an unshielded rail; the screen renders a different surface per rail.
    expect(ticket.rail).toBe('unshielded')
  })

  it('routes a shielded output to the shielded rail', () => {
    const c = captured()
    runMidnightTransfer({
      id: 'm1',
      origin: 'mcp://agent',
      wallet,
      submit: false,
      outputs: [{...output, kind: 'shielded'}],
      payFees: true,
      ...c,
      builtByUs: builtByUsWith().handle,
    })
    expect((registerMidnightDappTicket.mock.calls[0]?.[0] as unknown as {rail: string}).rail).toBe('shielded')
  })

  // ⚠️ `Rejected` means the user declined. It used to be the answer to every funding failure, so a
  // wallet that could not cover the amount told the caller its owner had refused.
  it('carries the ticket’s own api code through, rather than calling everything a decline', () => {
    const c = captured()
    runMidnightTransfer({
      id: 'm1',
      origin: 'mcp://agent',
      outputs: [output],
      wallet,
      submit: false,
      payFees: true,
      ...c,
      builtByUs: builtByUsWith().handle,
    })
    const ticket = registerMidnightDappTicket.mock.calls[0]?.[0] as unknown as {
      reject: (reason: string, apiCode?: MidnightErrorCode) => void
    }
    ticket.reject('not enough NIGHT', 'InsufficientFunds')
    expect(c.answers[0]?.error?.apiCode).toBe('InsufficientFunds')
    ticket.reject('user cancelled')
    expect(c.answers[1]?.error?.apiCode).toBe('Rejected')
  })
})

describe('runMidnightBalance', () => {
  it('registers a funding ticket and navigates to the funding route', () => {
    const c = captured()
    runMidnightBalance({
      id: 'm1',
      origin: 'mcp://agent',
      txHex: 'beef',
      wallet,
      payFees: true,
      ...c,
      builtByUs: builtByUsWith().handle,
    })
    expect(c.routes).toEqual(['/wallet/midnight/fund?dapp=mnt-1'])
    // Only the hex travels: what it owes is the ledger's statement, read by the screen.
    expect(registerMidnightDappTicket.mock.calls[0]?.[0]).toMatchObject({kind: 'funding', txHex: 'beef'})
  })

  it('refuses a self-funding balance too', () => {
    const c = captured()
    runMidnightBalance({
      id: 'm1',
      origin: 'mcp://agent',
      txHex: 'beef',
      wallet,
      payFees: false,
      ...c,
      builtByUs: builtByUsWith().handle,
    })
    expect(c.answers[0]?.error?.message).toContain('pays its own fee')
    expect(c.routes).toEqual([])
  })
})

describe('runMidnightSubmit', () => {
  // `networkId` is the funds axis, and it is required: the sponsor holds one wallet per network and
  // cannot read the network out of the bytes.
  const base = {id: 'm1', origin: 'mcp://agent', sessionToken: 'jwt', wallet, networkId: 'preprod'}

  // ⚠️ **The rule that protects the sponsor.** Every Midnight fee is paid by the sponsor, so relaying a
  // transaction this wallet did not build is a standing invitation to spend somebody else's fees.
  /**
   * ⚠️ **The rail is chosen by the bytes, not by a flag.** A transaction this wallet paid for from its
   * own DUST is sealed, and the sponsor cannot bind what is already bound — handing it over gets a
   * refusal about the shape, mentioning neither the fee nor the transaction.
   */
  it('sends a sealed transaction to the node and never to the sponsor', async () => {
    isTransactionBound.mockResolvedValue(true)
    submitSealedTransaction.mockReturnValue(Effect.succeed({extrinsicHash: '0xfeed', extrinsicBytes: 9}))
    const c = captured()
    await runMidnightSubmit({...base, txHex: 'abcd', ...c, builtByUs: builtByUsWith(['abcd']).handle})
    expect(submitSealedTransaction).toHaveBeenCalledTimes(1)
    expect(submitSponsoredTransfer).not.toHaveBeenCalled()
    // Void on both rails: the result must not depend on who paid.
    expect(c.answers[0]?.result).toBeNull()
  })

  /**
   * ⚠️ **A refused transaction has to release the DUST it reserved.** The review records the fee's
   * spend as pending on approval, because this function may never be called. If the node then refuses
   * the bytes, that record describes something that will never happen, and the next fee proves against
   * a state carrying a commitment the chain has never seen — answered as `Custom error: 170`, a message
   * about a proof for what is really a bookkeeping fault. Cost two attempts to diagnose.
   */
  it('frees the reserved DUST when the node refuses the transaction', async () => {
    isTransactionBound.mockResolvedValue(true)
    submitSealedTransaction.mockReturnValue(
      Effect.fail({_tag: 'SubmitSealedError', cause: 'rejected', reason: 'Custom error: 182'}),
    )
    const c = captured()
    await runMidnightSubmit({...base, txHex: 'abcd', ...c, builtByUs: builtByUsWith(['abcd']).handle})
    expect(discardPendingDustSpend).toHaveBeenCalledWith(wallet.groupId, wallet.accountIndex)
  })

  /**
   * ⚠️ The other half, and the dangerous one. An unreachable node may have taken the bytes, so freeing
   * the DUST would let the next fee spend an output that is genuinely gone.
   */
  it('keeps the DUST reserved when the node could not be reached', async () => {
    isTransactionBound.mockResolvedValue(true)
    submitSealedTransaction.mockReturnValue(
      Effect.fail({_tag: 'SubmitSealedError', cause: 'unreachable', reason: 'socket closed'}),
    )
    const c = captured()
    await runMidnightSubmit({...base, txHex: 'abcd', ...c, builtByUs: builtByUsWith(['abcd']).handle})
    expect(discardPendingDustSpend).not.toHaveBeenCalled()
  })

  it('refuses bytes it did not build, and does not reach the sponsor at all', async () => {
    const c = captured()
    await runMidnightSubmit({...base, txHex: 'beef', ...c, builtByUs: builtByUsWith().handle})
    expect(submitSponsoredTransfer).not.toHaveBeenCalled()
    expect(c.answers[0]?.error?.message).toContain('only transactions it built')
  })

  it('submits bytes it built, forgets them, and answers null', async () => {
    const c = captured()
    const {set, handle} = builtByUsWith(['beef'])
    await runMidnightSubmit({...base, txHex: 'beef', ...c, builtByUs: handle})
    expect(submitSponsoredTransfer).toHaveBeenCalledOnce()
    expect(submitSponsoredTransfer.mock.calls[0]?.[1]).toEqual(new Uint8Array([0xbe, 0xef]))
    // ⚠️ Which sponsor wallet balances it. Without this the bytes reach whichever network the host
    // defaults to, and a mismatch is accepted and then refused inside `balanceTx`.
    expect(submitSponsoredTransfer.mock.calls[0]?.[2]).toBe('preprod')
    // Forgotten: a second submission of the same bytes is a double-spend the node would refuse anyway.
    expect(set.has('beef')).toBe(false)
    expect(c.answers[0]).toEqual({id: 'm1', result: null})
  })

  it('refuses a second submission of the same bytes', async () => {
    const c = captured()
    const {handle} = builtByUsWith(['beef'])
    await runMidnightSubmit({...base, txHex: 'beef', ...c, builtByUs: handle})
    await runMidnightSubmit({...base, txHex: 'beef', ...c, builtByUs: handle})
    expect(submitSponsoredTransfer).toHaveBeenCalledOnce()
    expect(c.answers[1]?.error?.message).toContain('only transactions it built')
  })

  // A failed submit must stay submittable: forgetting the bytes on failure would make a retry
  // indistinguishable from a stranger's transaction.
  it('keeps the bytes when the sponsor refuses, so a retry is still possible', async () => {
    submitSponsoredTransfer.mockRejectedValue(new Error('sponsor is out of DUST'))
    const c = captured()
    const {set, handle} = builtByUsWith(['beef'])
    await runMidnightSubmit({...base, txHex: 'beef', ...c, builtByUs: handle})
    expect(set.has('beef')).toBe(true)
    expect(c.answers[0]?.error?.message).toContain('sponsor is out of DUST')
  })

  it('refuses when there is no session to sponsor with', async () => {
    const c = captured()
    await runMidnightSubmit({
      ...base,
      sessionToken: undefined,
      txHex: 'beef',
      ...c,
      builtByUs: builtByUsWith(['beef']).handle,
    })
    expect(submitSponsoredTransfer).not.toHaveBeenCalled()
    expect(c.answers[0]?.error?.message).toContain('no session')
  })

  it('refuses bytes that are not hex', async () => {
    const c = captured()
    await runMidnightSubmit({...base, txHex: 'zzzz', ...c, builtByUs: builtByUsWith(['zzzz']).handle})
    expect(submitSponsoredTransfer).not.toHaveBeenCalled()
    expect(c.answers[0]?.error?.message).toContain('not a hex transaction')
  })
})

describe('wireCodeFor', () => {
  // Pinned because it is easy to "simplify" into calling everything a refusal. Only a genuine refusal is
  // `Refused`: a wallet that cannot fund something has not refused it.
  it('maps a decline to Refused and everything else away from it', () => {
    expect(wireCodeFor('Rejected')).toBe(-3)
    expect(wireCodeFor('PermissionRejected')).toBe(-3)
    expect(wireCodeFor('InvalidRequest')).toBe(-1)
    expect(wireCodeFor('InsufficientFunds')).toBe(-2)
    expect(wireCodeFor('InternalError')).toBe(-2)
  })
})
