/**
 * The shim's own encoding, on both directions of the bridge — the layer a device had to stand in for.
 *
 * ⚠️ **Two bugs reached hardware through this gap.** The Rust tests are fed transcripts Node already
 * hex-encoded, so they never touch the shim's JSON; the device probe was the only thing that did,
 * which made each shim bug cost a cross-compile, a gradle build, a Metro bundle and a walk through
 * the menus. Both are pinned below, and both are pure — no native module, no emulator.
 */

import {describe, expect, it} from 'vitest'
import {encodeProgram, queryResult} from './index'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

describe('a program on its way to the bridge', () => {
  it('turns byte atoms into hex wherever they are nested', () => {
    const encoded = encodeProgram([
      {dup: {n: 0}},
      {idx: {path: [{tag: 'value', value: {value: [new Uint8Array([0x03])], alignment: []}}]}},
      {push: {value: {tag: 'cell', content: {value: [new Uint8Array([0xde, 0xad])], alignment: []}}}},
    ])
    const json = JSON.stringify(encoded)
    expect(json).toContain('"dead"')
    expect(json).toContain('"03"')
    // The failure itself: `JSON.stringify(new Uint8Array([1]))` is `{"0":1}`, not a string.
    expect(json).not.toContain('"0":')
  })

  it('leaves numbers alone, because the native side reads them as integers', () => {
    expect(encodeProgram({dup: {n: 2}})).toEqual({dup: {n: 2}})
    expect(encodeProgram({alignment: [{tag: 'atom', value: {tag: 'bytes', length: 32}}]})).toEqual({
      alignment: [{tag: 'atom', value: {tag: 'bytes', length: 32}}],
    })
  })

  it('passes a bare op string through untouched', () => {
    expect(encodeProgram(['member', 'add'])).toEqual(['member', 'add'])
  })
})

describe('read events coming back', () => {
  /** One `popeq` result: a `Bytes<1>` boolean holding `true`. */
  const raw = () => [
    {
      tag: 'read',
      content: {value: ['01'], alignment: [{tag: 'atom' as const, value: {tag: 'bytes' as const, length: 1}}]},
    },
  ]

  const zeroCost = {readTime: 0n, computeTime: 0n, bytesWritten: 0n, bytesDeleted: 0n}

  it('decodes hex atoms into bytes', () => {
    const [event] = queryResult(null as never, zeroCost, raw()).events
    expect(event?.content.value.map(hex)).toEqual(['01'])
  })

  /**
   * ⚠️ **The device bug, in one assertion.** `circuit-context.js` reads `results.events` twice — once
   * to fill the public transcript, once to hand the value to the circuit — and the circuit's
   * descriptor decodes it with a `fromValue` that calls `value.shift()`. Sharing one array between
   * the two reads drains the atom out of the transcript, and the call reaches the prover with a
   * boolean that has zero atoms and does not fit its own alignment.
   */
  it('hands out a fresh copy on every property access, so one consumer cannot drain another', () => {
    // ⚠️ Two reads of the **same** result object, which is exactly what `circuit-context.js` does.
    // Calling the decoder twice instead would prove the decoder is pure — true, irrelevant, and not
    // what broke.
    const result = queryResult(null as never, zeroCost, raw())
    const forTranscript = result.events
    const forCircuit = result.events

    // What a descriptor's `fromValue` does to the value it is given.
    forCircuit[0]?.content.value.shift()

    expect(forCircuit[0]?.content.value).toHaveLength(0)
    expect(forTranscript[0]?.content.value).toHaveLength(1)
    expect(forTranscript[0]?.content.value.map(hex)).toEqual(['01'])
  })
})
