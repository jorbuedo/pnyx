import {describe, expect, it} from 'vitest'
import {MAX_TRANSFER_OUTPUTS, readTransferRequest} from './transfer.js'

const NIGHT = '00'.repeat(32)

const output = (over: Record<string, unknown> = {}) => ({
  kind: 'unshielded',
  type: NIGHT,
  value: '1000000',
  recipient: 'mn_addr_preprod1abc',
  ...over,
})

const request = (result: ReturnType<typeof readTransferRequest>) => {
  if (!result.ok) throw new Error(`expected a request, got: ${result.error.message}`)
  return result.request
}

const refused = (result: ReturnType<typeof readTransferRequest>): boolean => !result.ok

describe('readTransferRequest', () => {
  it('reads an output, restoring the value the bridge sent as a decimal string', () => {
    // JSON cannot carry a bigint, and a Uint<128> amount would round past 2^53 as a Number. The API
    // promised the dApp bigints, so the conversion has to happen here or the transfer is wrong.
    const parsed = request(readTransferRequest([[output({value: '9007199254740993'})]]))

    expect(parsed.outputs).toEqual([
      {kind: 'unshielded', tokenType: NIGHT, value: 9_007_199_254_740_993n, recipient: 'mn_addr_preprod1abc'},
    ])
  })

  it('accepts a bigint directly, for a caller that is not the bridge', () => {
    expect(request(readTransferRequest([[output({value: 5n})]])).outputs[0]?.value).toBe(5n)
  })

  it('accepts both kinds', () => {
    expect(request(readTransferRequest([[output({kind: 'shielded'})]])).outputs[0]?.kind).toBe('shielded')
  })

  it('lower-cases the token type so one token has one key', () => {
    expect(request(readTransferRequest([[output({type: 'AB'.repeat(32)})]])).outputs[0]?.tokenType).toBe(
      'ab'.repeat(32),
    )
  })

  describe('refusals', () => {
    it('refuses no outputs rather than building an empty transfer', () => {
      expect(refused(readTransferRequest([[]]))).toBe(true)
      expect(refused(readTransferRequest([]))).toBe(true)
    })

    it('refuses more outputs than the builder can express, naming the limit', () => {
      const result = readTransferRequest([[output(), output()]])

      expect(refused(result)).toBe(true)
      // The dApp can act on this: split the request. A transfer quietly missing its second output is
      // the alternative, and it would be approved as if it were the whole thing.
      expect(result.ok === false && result.error.message).toContain('one output per transfer')
      expect(MAX_TRANSFER_OUTPUTS).toBe(1)
    })

    it('carries payFees through rather than judging it', () => {
      // It used to refuse `false` outright, because the phone held no DUST. The device can pay its own
      // way now, but whether it can *right now* needs a synced DUST state — which this module cannot
      // see. So the request travels and the host answers it.
      const read = readTransferRequest([[output()], {payFees: false}])
      expect(read.ok).toBe(true)
      if (read.ok) expect(read.request.payFees).toBe(false)
    })

    it('defaults payFees to true, as the API specifies', () => {
      const read = readTransferRequest([[output()]])
      expect(read.ok).toBe(true)
      if (read.ok) expect(read.request.payFees).toBe(true)
    })

    it('accepts payFees true or absent', () => {
      expect(refused(readTransferRequest([[output()], {payFees: true}]))).toBe(false)
      expect(refused(readTransferRequest([[output()], {}]))).toBe(false)
    })

    it('refuses a non-boolean payFees', () => {
      expect(refused(readTransferRequest([[output()], {payFees: 'yes'}]))).toBe(true)
    })

    it('refuses an unknown output kind rather than picking a rail', () => {
      expect(refused(readTransferRequest([[output({kind: 'dust'})]]))).toBe(true)
      expect(refused(readTransferRequest([[output({kind: undefined})]]))).toBe(true)
    })

    it('refuses a token type that is not 64 hex', () => {
      expect(refused(readTransferRequest([[output({type: 'night'})]]))).toBe(true)
      expect(refused(readTransferRequest([[output({type: '00'})]]))).toBe(true)
    })

    it('refuses a value that is not a whole number', () => {
      // `1.5` and `1e6` both parse as numbers elsewhere in JS and would silently become something else.
      expect(refused(readTransferRequest([[output({value: '1.5'})]]))).toBe(true)
      expect(refused(readTransferRequest([[output({value: '1e6'})]]))).toBe(true)
      expect(refused(readTransferRequest([[output({value: 1_000_000})]]))).toBe(true)
      expect(refused(readTransferRequest([[output({value: '-1'})]]))).toBe(true)
    })

    it('refuses a zero value, which would spend a fee to move nothing', () => {
      expect(refused(readTransferRequest([[output({value: '0'})]]))).toBe(true)
    })

    it('refuses a missing recipient', () => {
      expect(refused(readTransferRequest([[output({recipient: ''})]]))).toBe(true)
      expect(refused(readTransferRequest([[output({recipient: undefined})]]))).toBe(true)
    })
  })
})
