import {describe, expect, it} from 'vitest'
import {readProvingCheckRequest, readProvingProveRequest} from './proving.js'

const ZKIR = 'aabb'
const PK = 'ccdd'
const VK = 'eeff'
const PREIMAGE = '0011'
const BINDING = '01'.padEnd(64, '0')

const refused = (result: {ok: boolean}): boolean => !result.ok

describe('readProvingCheckRequest', () => {
  it('decodes the circuit and the preimage', () => {
    const result = readProvingCheckRequest([ZKIR, PREIMAGE])

    expect(result.ok && [...result.request.zkir]).toEqual([0xaa, 0xbb])
    expect(result.ok && [...result.request.preimage]).toEqual([0x00, 0x11])
  })

  it('refuses a missing or malformed piece, naming which', () => {
    expect(refused(readProvingCheckRequest([]))).toBe(true)
    expect(refused(readProvingCheckRequest([ZKIR]))).toBe(true)
    const bad = readProvingCheckRequest(['zz', PREIMAGE])
    expect(refused(bad)).toBe(true)
    // The dApp is assembling these from its own key provider, so it needs to know which one it got wrong.
    expect(bad.ok === false && bad.error.message).toContain('ZKIR')
  })
})

const DIGEST = 'ab'.repeat(32)

describe('readProvingProveRequest', () => {
  it('decodes the whole circuit plus the preimage', () => {
    const result = readProvingProveRequest([DIGEST, PREIMAGE, ZKIR, PK, VK])

    expect(result.ok && result.request.digest).toBe(DIGEST)
    expect(result.ok && [...(result.request.verifierKey ?? [])]).toEqual([0xee, 0xff])
    // Absent rather than a zero-filled 32 bytes: "leave the preimage's binding input alone" and "bind
    // it to zero" are different requests.
    expect(result.ok && result.request.bindingInput).toBeUndefined()
  })

  it('accepts a digest with no circuit — the wallet may already hold it', () => {
    // The whole point of the handshake: a 10 MB prover key costs ~38 s of bridge on device, so the
    // second proof of a circuit sends nothing but its name.
    const result = readProvingProveRequest([DIGEST, PREIMAGE, '', '', ''])

    expect(result.ok && result.request.zkir).toBeUndefined()
    expect(result.ok && result.request.digest).toBe(DIGEST)
  })

  it('refuses a partial circuit, which could neither be cached nor be a cache hit', () => {
    expect(refused(readProvingProveRequest([DIGEST, PREIMAGE, ZKIR, '', '']))).toBe(true)
    expect(refused(readProvingProveRequest([DIGEST, PREIMAGE, ZKIR, PK, '']))).toBe(true)
  })

  it('refuses a missing or malformed digest rather than proving something unnamed', () => {
    expect(refused(readProvingProveRequest([]))).toBe(true)
    expect(refused(readProvingProveRequest(['', PREIMAGE]))).toBe(true)
    expect(refused(readProvingProveRequest(['NOTHEX', PREIMAGE]))).toBe(true)
  })

  it('accepts a 32-byte binding input, and treats null as absent', () => {
    const bound = readProvingProveRequest([DIGEST, PREIMAGE, ZKIR, PK, VK, BINDING])
    expect(bound.ok && bound.request.bindingInput).toHaveLength(32)

    // The bridge turns an omitted trailing argument into null.
    const unbound = readProvingProveRequest([DIGEST, PREIMAGE, ZKIR, PK, VK, null])
    expect(unbound.ok && unbound.request.bindingInput).toBeUndefined()
  })

  it('refuses a binding input that is not 32 bytes rather than padding it', () => {
    const result = readProvingProveRequest([DIGEST, PREIMAGE, ZKIR, PK, VK, '0102'])

    expect(refused(result)).toBe(true)
    expect(result.ok === false && result.error.message).toContain('32 bytes')
  })

  it('refuses a missing preimage by name', () => {
    const result = readProvingProveRequest([DIGEST])

    expect(refused(result)).toBe(true)
    expect(result.ok === false && result.error.message).toContain('preimage')
  })
})
