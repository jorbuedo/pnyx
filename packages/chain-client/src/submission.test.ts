// Coin-race hardening: 1010-class detection, own-spend gating between transactions, and
// resync-rebuild-resubmit retries (bounded, exponential backoff).
import {describe, expect, it} from 'vitest'
import {type CoinSync, createTxSubmitter, isCoinContentionError, isTransientWalletPanic} from './submission.js'

const RPC_1010 = 'RpcError: 1010: Invalid Transaction: Custom error: 117'

const fakeCoinSync = (events: string[]): CoinSync => ({
  waitForOwnSpends: async () => {
    events.push('wait-observed')
  },
  resync: async () => {
    events.push('resync')
  },
})

describe('isCoinContentionError', () => {
  it('matches the node RPC rejection shape, including through cause chains', () => {
    expect(isCoinContentionError(new Error(RPC_1010))).toBe(true)
    expect(isCoinContentionError(new Error('submit failed', {cause: new Error(RPC_1010)}))).toBe(true)
    expect(isCoinContentionError(RPC_1010)).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isCoinContentionError(new Error('proof server timeout'))).toBe(false)
    expect(isCoinContentionError(new Error('1010 things happened'))).toBe(false)
    expect(isCoinContentionError(new Error('Invalid Transaction: nonce too low'))).toBe(false)
    expect(isCoinContentionError(undefined)).toBe(false)
  })
})

describe('isTransientWalletPanic', () => {
  it('matches the ledger WASM fee-calculation panic (retried), not other wallet errors', () => {
    const panic = new Error(
      "Wallet.Other: Unreachable code should not be executed (evaluating 'wasm.transaction_feesWithMargin(this.__wbg_ptr, params.__wbg_ptr, n)')",
    )
    expect(isTransientWalletPanic(panic)).toBe(true)
    expect(isTransientWalletPanic(new Error('submit failed', {cause: panic}))).toBe(true)
    expect(isTransientWalletPanic(new Error('Wallet.InsufficientFunds: could not balance dust'))).toBe(false)
  })

  it('is retried by the submitter with resync', async () => {
    const events: string[] = []
    const submit = createTxSubmitter(fakeCoinSync(events), {backoffMs: 1, sleep: async () => {}})
    let attempts = 0
    const result = await submit('join', async () => {
      attempts++
      if (attempts === 1) {
        throw new Error('Unreachable code should not be executed (evaluating wasm.transaction_feesWithMargin)')
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(2)
    expect(events).toContain('resync')
  })
})

describe('createTxSubmitter', () => {
  it('blocks until the wallet observed its own spend after each submission', async () => {
    const events: string[] = []
    const submit = createTxSubmitter(fakeCoinSync(events))
    await submit('tx1', async () => {
      events.push('submit:tx1')
      return 'ok'
    })
    await submit('tx2', async () => {
      events.push('submit:tx2')
      return 'ok'
    })
    expect(events).toEqual(['submit:tx1', 'wait-observed', 'submit:tx2', 'wait-observed'])
  })

  it('retries a 1010 rejection after a resync, rebuilding via the submit closure', async () => {
    const events: string[] = []
    const sleeps: number[] = []
    let resynced = false
    const coinSync = fakeCoinSync(events)
    const submit = createTxSubmitter(
      {
        ...coinSync,
        resync: async (timeoutMs: number) => {
          await coinSync.resync(timeoutMs)
          resynced = true
        },
      },
      {
        backoffMs: 7,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      },
    )
    let attempts = 0
    const result = await submit('vote', async () => {
      attempts++
      if (!resynced) {
        throw new Error(RPC_1010)
      }
      return `landed on attempt ${attempts}`
    })
    expect(result).toBe('landed on attempt 2')
    expect(sleeps).toEqual([7])
    expect(events).toEqual(['resync', 'wait-observed'])
  })

  it('bounds retries with exponential backoff, then surfaces the rejection', async () => {
    const sleeps: number[] = []
    const submit = createTxSubmitter(fakeCoinSync([]), {
      maxRetries: 2,
      backoffMs: 10,
      sleep: async (ms) => void sleeps.push(ms),
    })
    let attempts = 0
    await expect(
      submit('vote', async () => {
        attempts++
        throw new Error(RPC_1010)
      }),
    ).rejects.toThrow('1010')
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([10, 20])
  })

  it('does not retry non-contention failures', async () => {
    let attempts = 0
    const submit = createTxSubmitter(fakeCoinSync([]), {sleep: async () => {}})
    await expect(
      submit('join', async () => {
        attempts++
        throw new Error('proof generation failed')
      }),
    ).rejects.toThrow('proof generation failed')
    expect(attempts).toBe(1)
  })

  it('treats a failed own-spend wait as non-fatal (retry guard covers the next tx)', async () => {
    const logs: string[] = []
    const coinSync: CoinSync = {
      waitForOwnSpends: async () => {
        throw new Error('own-spend observation timeout 5ms')
      },
      resync: async () => {},
    }
    const submit = createTxSubmitter(coinSync, {log: (m) => logs.push(m)})
    await expect(submit('tx', async () => 'ok')).resolves.toBe('ok')
    expect(logs.join('\n')).toContain('did not settle')
  })
})
