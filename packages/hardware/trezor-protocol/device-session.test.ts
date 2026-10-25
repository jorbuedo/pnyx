import {describe, expect, it, vi} from 'vitest'
import {type BitcoinRefTx, bitcoinSignTx, type DeviceSession} from './device-session'

const txRequest = (message: Record<string, unknown>) =>
  ({
    success: true as const,
    payload: {
      type: 'TxRequest',
      message,
    },
  }) as const

const createMockSession = (
  handler: DeviceSession['typedCall'],
): DeviceSession & {
  typedCall: ReturnType<typeof vi.fn<DeviceSession['typedCall']>>
} => ({
  sessionId: 'mock-session',
  typedCall: vi.fn(handler),
  rawCall: vi.fn(async () => ({success: true as const, payload: {type: 'Success', message: {}}})),
  release: vi.fn(async () => {}),
  updateCallbacks: vi.fn(),
})

describe('bitcoinSignTx', () => {
  const inputs = [
    {
      address_n: [2147483732, 2147483648, 2147483648, 0, 0] as const,
      prev_hash: 'aa'.repeat(32),
      prev_index: 0,
      amount: '1000',
      script_type: 'SPENDWITNESS',
    },
  ] as const

  const outputs = [
    {
      address: 'bc1qtestaddress00000000000000000000000000000',
      amount: '900',
      script_type: 'PAYTOADDRESS',
    },
  ] as const

  const refTx: BitcoinRefTx = {
    version: 1,
    locktime: 0,
    inputs: [{prev_hash: 'bb'.repeat(32), prev_index: 1, script_sig: '', sequence: 0xffffffff}],
    bin_outputs: [{amount: '1000', script_pubkey: `0014${'11'.repeat(20)}`}],
  }

  it('omits extra_data_len from legacy TXMETA when extra data is absent', async () => {
    const session = createMockSession(async (messageName, _expectedType, data) => {
      if (messageName === 'SignTx') {
        return txRequest({request_type: 'TXMETA', details: {tx_hash: 'prev-tx'}})
      }

      if (messageName === 'TxAck') {
        expect(data).toEqual({
          tx: {
            version: 1,
            lock_time: 0,
            inputs_cnt: 1,
            outputs_cnt: 1,
          },
        })
        return txRequest({request_type: 'TXFINISHED'})
      }

      throw new Error(`Unexpected message: ${messageName}`)
    })

    const result = await bitcoinSignTx(session, {
      inputs,
      outputs,
      refTxs: new Map([['prev-tx', refTx]]),
    })

    expect(result.success).toBe(true)
    expect(session.typedCall).toHaveBeenNthCalledWith(
      2,
      'TxAck',
      'TxRequest',
      {
        tx: {
          version: 1,
          lock_time: 0,
          inputs_cnt: 1,
          outputs_cnt: 1,
        },
      },
      undefined,
    )
  })

  it('uses explicit TxAckPrevMeta flow when legacy signing is disabled', async () => {
    const session = createMockSession(async (messageName, _expectedType, data) => {
      if (messageName === 'SignTx') {
        return txRequest({request_type: 'TXINPUT', details: {request_index: 0}})
      }

      if (messageName === 'TxAckInput') {
        expect(data).toEqual({tx: {input: inputs[0]}})
        return txRequest({request_type: 'TXMETA', details: {tx_hash: 'prev-tx'}})
      }

      if (messageName === 'TxAckPrevMeta') {
        expect(data).toEqual({
          tx: {
            version: 1,
            lock_time: 0,
            inputs_count: 1,
            outputs_count: 1,
          },
        })
        return txRequest({request_type: 'TXFINISHED'})
      }

      throw new Error(`Unexpected message: ${messageName}`)
    })

    const result = await bitcoinSignTx(session, {
      inputs,
      outputs,
      refTxs: new Map([['prev-tx', refTx]]),
      useLegacySignProcess: false,
    })

    expect(result.success).toBe(true)
    expect(session.typedCall).toHaveBeenNthCalledWith(2, 'TxAckInput', 'TxRequest', {tx: {input: inputs[0]}}, undefined)
    expect(session.typedCall).toHaveBeenNthCalledWith(
      3,
      'TxAckPrevMeta',
      'TxRequest',
      {
        tx: {
          version: 1,
          lock_time: 0,
          inputs_count: 1,
          outputs_count: 1,
        },
      },
      undefined,
    )
  })
})
