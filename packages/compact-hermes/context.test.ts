/**
 * The module-scope shapes every generated driver builds before it runs anything.
 *
 * ⚠️ **This file exists because the device found what the test suite did not.** Each driver builds
 * `new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, dummyContractAddress())`
 * at module scope — a dummy `_emptyContext` it type-checks against and never queries. The first shim
 * required a state and opened its native handle eagerly, so importing the driver threw
 * `Cannot convert undefined value to object` before a single circuit ran. Nothing here needs the
 * native module, which is exactly the property under test: this path must not touch it.
 */

import * as ocrt from '@midnight-ntwrk/onchain-runtime-v3'
import {describe, expect, it} from 'vitest'
import {ChargedState, ContractState, dummyContractAddress, QueryContext, StateValue} from './index'

describe('the dummy context a driver builds at module scope', () => {
  it('constructs with no state at all', () => {
    expect(() => new ContractState()).not.toThrow()
    expect(new ContractState().serialized.length).toBe(0)
    expect(new ContractState().data).toBeInstanceOf(ChargedState)
  })

  it('builds a query context over it without opening a native handle', () => {
    // If this reached the bridge it would throw — there is no native module in Node. Not throwing
    // *is* the assertion that the handle is lazy.
    expect(() => new QueryContext(new ContractState().data, dummyContractAddress())).not.toThrow()
  })

  it('names the reason when something tries to actually query the dummy', () => {
    const ctx = new QueryContext(new ContractState().data, dummyContractAddress())
    expect(() => ctx.query([])).toThrow(/no contract state/)
  })

  it('frees a context that was never queried without complaining', () => {
    const ctx = new QueryContext(new ContractState().data, dummyContractAddress())
    expect(() => ctx.free()).not.toThrow()
  })

  it('gives the dummy address the runtime itself gives', () => {
    // ⚠️ Pinned against the real module rather than a remembered width. This asserted 35 bytes
    // ("a one-byte network tag and a 32-byte address") for as long as it existed; a ContractAddress
    // at this layer carries no tag, and nothing caught it because the dummy is never queried.
    expect(dummyContractAddress()).toBe(ocrt.dummyContractAddress())
    expect(dummyContractAddress()).toHaveLength(64)
  })
})

describe('state values a circuit pushes', () => {
  // Pure data, no handle — which is what keeps the bridge to a VM call plus a few hashes.
  it('encodes a cell and a null as the runtime tagged union', () => {
    const cell = {
      value: [new Uint8Array([1, 2])],
      alignment: [{tag: 'atom' as const, value: {tag: 'bytes' as const, length: 32}}],
    }
    expect(StateValue.newCell(cell).encode()).toEqual({tag: 'cell', content: cell})
    expect(StateValue.newNull().encode()).toEqual({tag: 'null'})
  })

  it('refuses the constructor shapes by name rather than returning something plausible', () => {
    expect(() => StateValue.newMap()).toThrow(/deploy\.rs/)
    expect(() => StateValue.newArray()).toThrow(/deploy\.rs/)
    expect(() => StateValue.newBoundedMerkleTree()).toThrow(/deploy\.rs/)
  })
})
