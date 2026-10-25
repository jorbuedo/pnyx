// Every case forges a signature that genuinely used the bad nonce, then asserts we
// classify it — the same method the incident-response scanner validates itself with.
// A correctly-signed signature must come back clean, or the check would condemn
// every transaction it sees.
import {sha512} from '@noble/hashes/sha2.js'
import {describe, expect, it} from 'vitest'
import {ed25519} from './curves.js'
import {detectWeakEd25519Nonce} from './weak-nonce.js'

const L = ed25519.Point.Fn.ORDER
const scalarLE = (b: Uint8Array): bigint => {
  let x = 0n
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i] as number)
  return x % L
}
const bytesLE = (x: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let v = x
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const basepointMul = (r: bigint): Uint8Array => ed25519.Point.BASE.multiply(r === 0n ? L : r).toBytes()

const secret = scalarLE(sha512(new TextEncoder().encode('weak-nonce-test-key')))
const A = basepointMul(secret)
const M = new Uint8Array(32).fill(0x5f)

/** A signature that really did use nonce scalar `r` — verifiable, and leaking. */
const forge = (r: bigint): Uint8Array => {
  const R = basepointMul(r)
  const h = scalarLE(sha512(cat(R, A, M)))
  const S = (((r + h * secret) % L) + L) % L
  return cat(R, bytesLE(S))
}

describe('detectWeakEd25519Nonce', () => {
  const cases: readonly (readonly [string, bigint])[] = [
    ['H(M)', scalarLE(sha512(M))],
    ['H(zero32|M)', scalarLE(sha512(cat(new Uint8Array(32), M)))],
    ['H(zero1|M)', scalarLE(sha512(cat(new Uint8Array(1), M)))],
    ['H("undefined"|M)', scalarLE(sha512(cat(new TextEncoder().encode('undefined'), M)))],
    ['reduce(M)', scalarLE(M)],
    ['H(A|M)', scalarLE(sha512(cat(A, M)))],
  ]

  for (const [label, r] of cases) {
    it(`flags a signature whose nonce was ${label}`, () => {
      expect(detectWeakEd25519Nonce(M, A, forge(r))?.derivation).toBe(label)
    })
  }

  it('leaves a properly signed signature alone', () => {
    // The false-positive direction is the dangerous one: this check gates submission.
    const priv = new Uint8Array(32).fill(7)
    const pub = ed25519.getPublicKey(priv)
    expect(detectWeakEd25519Nonce(M, pub, ed25519.sign(M, priv))).toBeNull()
  })

  it('is message-specific: the same forged signature is clean against another message', () => {
    const sig = forge(scalarLE(sha512(M)))
    const other = new Uint8Array(32).fill(0x11)
    expect(detectWeakEd25519Nonce(other, A, sig)).toBeNull()
  })

  it('ignores malformed inputs rather than throwing', () => {
    expect(detectWeakEd25519Nonce(M, A, new Uint8Array(63))).toBeNull()
    expect(detectWeakEd25519Nonce(M, new Uint8Array(31), forge(1n))).toBeNull()
  })
})
