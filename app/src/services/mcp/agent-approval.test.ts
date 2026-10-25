// The ordering IS the behaviour: one review at a time, a bounded wait, and exactly one answer per
// request. Each is invisible from the agent's side except as a hang or a wrong verdict.
import {ApiErrorCode, type WalletResponse} from '@pnyx/dapp-connector'
import {describe, expect, it, vi} from 'vitest'
import {createAgentApprovalGate, DEFAULT_APPROVAL_TIMEOUT_MS} from './agent-approval'

const settled = (id: string): WalletResponse => ({id, result: 'witness-set-hex'})

/**
 * The connector surface's refusal shape.
 *
 * ⚠️ Injected, because the gate is generic in what it answers with: a builder queues behind the same
 * gate and answers with a tool outcome, and a gate that built `WalletResponse`s itself would have
 * forced a second gate for it.
 */
const refusalFor =
  (id: string) =>
  (message: string): WalletResponse => ({id, error: {code: ApiErrorCode.Refused, message}})

/** A gate whose clock the test drives. */
const gate = (timeoutMs = 1000) => {
  const timers: {fn: () => void; ms: number}[] = []
  const g = createAgentApprovalGate({
    timeoutMs,
    setTimeoutImpl: (fn, ms) => {
      timers.push({fn, ms})
      return timers.length - 1
    },
    clearTimeoutImpl: () => {},
  })
  return {gate: g, fire: () => timers.at(-1)?.fn(), timers}
}

describe('createAgentApprovalGate', () => {
  it('answers with whatever the review settled', async () => {
    const {gate: g} = gate()
    const answer = await g.request({
      refuse: refusalFor('m1'),
      kind: 'a transaction signature',
      open: async (a) => a(settled('m1')),
    })
    expect(answer).toEqual({id: 'm1', result: 'witness-set-hex'})
  })

  it('reports what it is waiting for while a review is open', async () => {
    const {gate: g} = gate()
    let release: ((r: WalletResponse) => void) | undefined
    const pending = g.request({
      refuse: refusalFor('m1'),
      kind: 'a transaction signature',
      open: async (a) => {
        release = a
      },
    })
    expect(g.waitingFor()).toBe('a transaction signature')
    release?.(settled('m1'))
    await pending
    expect(g.waitingFor()).toBeUndefined()
  })

  // ⚠️ The review screen shows one thing at a time. Replacing it silently would put a signature the
  // agent asked for behind a screen describing a different transaction.
  it('refuses a second request while one is waiting, and says what for', async () => {
    const {gate: g} = gate()
    let release: ((r: WalletResponse) => void) | undefined
    const first = g.request({
      refuse: refusalFor('m1'),
      kind: 'a transaction signature',
      open: async (a) => {
        release = a
      },
    })
    const second = await g.request({refuse: refusalFor('m2'), kind: 'a data signature', open: async () => {}})
    expect(second.error?.code).toBe(ApiErrorCode.Refused)
    expect(second.error?.message).toContain('already waiting')
    expect(second.error?.message).toContain('a transaction signature')
    expect(second.id).toBe('m2')

    // And the gate reopens once the first one settles — a leaked flag refuses for ever, which looks
    // exactly like a wallet that stopped answering.
    release?.(settled('m1'))
    await first
    const third = await g.request({
      refuse: refusalFor('m3'),
      kind: 'a data signature',
      open: async (a) => a(settled('m3')),
    })
    expect(third.result).toBe('witness-set-hex')
  })

  // ⚠️ A timeout is not a decline. An agent told "declined" will not ask again; one told nobody
  // answered can. Getting this backwards teaches the model the wrong thing about a user who walked away.
  it('answers after the timeout, and does not call it a decline', async () => {
    const {gate: g, fire} = gate()
    const pending = g.request({refuse: refusalFor('m1'), kind: 'a transaction signature', open: async () => {}})
    fire()
    const answer = await pending
    expect(answer.error?.code).toBe(ApiErrorCode.Refused)
    expect(answer.error?.message).toContain('nobody answered')
    expect(answer.error?.message).not.toContain('declined')
    expect(g.waitingFor()).toBeUndefined()
  })

  it('ignores a late answer after the timeout has already replied', async () => {
    const {gate: g, fire} = gate()
    let release: ((r: WalletResponse) => void) | undefined
    const pending = g.request({
      refuse: refusalFor('m1'),
      kind: 'a transaction signature',
      open: async (a) => {
        release = a
      },
    })
    fire()
    const answer = await pending
    // The person finally approves; the agent has already been told nobody answered. Answering twice
    // would send a second frame for one request id.
    expect(() => release?.(settled('m1'))).not.toThrow()
    expect(answer.error?.message).toContain('nobody answered')
  })

  // A review that both settles and cancels — which the ticket does when it settles then unmounts —
  // must not produce two frames for one id.
  it('answers exactly once when the review both settles and cancels', async () => {
    const {gate: g} = gate()
    const answer = await g.request({
      refuse: refusalFor('m1'),
      kind: 'a transaction signature',
      open: async (a) => {
        a(settled('m1'))
        a({id: 'm1', error: {code: ApiErrorCode.Refused, message: 'user declined'}})
      },
    })
    expect(answer.result).toBe('witness-set-hex')
  })

  // `open` throwing means the review could not be built at all. That is a definite answer, so the agent
  // must get it now rather than sitting on the timeout.
  it('answers immediately when the review cannot be opened', async () => {
    const {gate: g, timers} = gate()
    const answer = await g.request({
      refuse: refusalFor('m1'),
      kind: 'a transaction signature',
      open: () => Promise.reject(new Error('no rail')),
    })
    expect(answer.error?.message).toContain('could not open the review')
    expect(answer.error?.message).toContain('no rail')
    // It did arm a timeout, and settling early is what stops it mattering.
    expect(timers).toHaveLength(1)
    expect(g.waitingFor()).toBeUndefined()
  })

  it('defaults to a bound a person can actually meet', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })

  it('uses real timers when none are injected', async () => {
    vi.useFakeTimers()
    try {
      const g = createAgentApprovalGate({timeoutMs: 50})
      const pending = g.request({refuse: refusalFor('m1'), kind: 'a transaction signature', open: async () => {}})
      await vi.advanceTimersByTimeAsync(60)
      expect((await pending).error?.message).toContain('nobody answered')
    } finally {
      vi.useRealTimers()
    }
  })
})
