import {describe, expect, it} from 'vitest'
import {decodeUr} from '../ur.js'
import {
  ALGO_BIP32_ED25519,
  CHAIN_TYPE_ADA,
  CHAIN_TYPE_ADA_CIP_1854,
  CURVE_ED25519,
  decodeQrHardwareCall,
  encodeQrHardwareCall,
  UR_TYPE_QR_HARDWARE_CALL,
} from './hardware-call.js'
import {classifyScannedUr} from './scan.js'

/**
 * A real call, captured from the Eternl browser extension on 2026-08-07 — what it shows *before*
 * it will scan an export. Every other vector in this package is published or a round-trip against
 * ourselves; this one came off a live counterparty, which makes it the most valuable fixture here.
 * Do not "tidy" it.
 */
const ETERNL_CALL =
  'UR:QR-HARDWARE-CALL/OXADAEAOTAAHBZOYADLFTAAHCMOXADTAADDYOYADLNCFATFMYKCFATCHYKAEYKAOADAXADAAJZFPFYFPHEFXGAGDHEEHETECEETAAHCMOXADTAADDYOYADLNCFATFNYKCFATCHYKAEYKAOADAXADAAIAFPFYFPAXIYIHJYIHJPJTJZAAADFHGSSGEH'

const callBytes = () => {
  const parsed = decodeUr(ETERNL_CALL)
  if (!parsed.ok) throw new Error(`fixture is not a UR: ${parsed.error.kind}`)
  return parsed.value
}

describe("Eternl's key-derivation call", () => {
  it('is a qr-hardware-call', () => {
    expect(callBytes().type).toBe(UR_TYPE_QR_HARDWARE_CALL)
  })

  it('asks for both Cardano key chains at account 0', () => {
    const decoded = decodeQrHardwareCall(callBytes().cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    // m/1854'/1815'/0' (multisig) and m/1852'/1815'/0' (standard) — every component hardened.
    expect(decoded.value.schemas.map((s) => s.keyPath.components)).toEqual([
      [
        {index: 1854, hardened: true},
        {index: 1815, hardened: true},
        {index: 0, hardened: true},
      ],
      [
        {index: 1852, hardened: true},
        {index: 1815, hardened: true},
        {index: 0, hardened: true},
      ],
    ])
  })

  it('labels them, and names itself', () => {
    const decoded = decodeQrHardwareCall(callBytes().cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.schemas.map((s) => s.chainType)).toEqual(['ADA_CIP_1854', 'ADA'])
    expect(decoded.value.origin).toBe('eternl')
    expect(decoded.value.callType).toBe(0)
    expect(decoded.value.version).toBe(1)
  })

  it('carries curve and algo through without interpreting them', () => {
    const decoded = decodeQrHardwareCall(callBytes().cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    for (const schema of decoded.value.schemas) {
      expect(schema.curve).toBe(1)
      expect(schema.algo).toBe(1)
    }
  })

  it('classifies as its own kind, not as something signable', () => {
    const classified = classifyScannedUr(callBytes())
    expect(classified.kind).toBe('qr-hardware-call')
  })
})

describe('rejects a call it cannot act on', () => {
  it('reports a payload that is not a call at all', () => {
    expect(decodeQrHardwareCall(Uint8Array.from([0xff, 0xff])).ok).toBe(false)
  })

  it('reports a call carrying no key-derivation request', () => {
    // {3: "eternl"} — an origin and nothing else.
    const bytes = Uint8Array.from([0xa1, 0x03, 0x66, 0x65, 0x74, 0x65, 0x72, 0x6e, 0x6c])
    const decoded = decodeQrHardwareCall(bytes)
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error).toMatch(/no key-derivation call/)
  })

  it('reports a call asking for nothing', () => {
    // {2: 1301({1: []})}
    const bytes = Uint8Array.from([0xa1, 0x02, 0xd9, 0x05, 0x15, 0xa1, 0x01, 0x80])
    const decoded = decodeQrHardwareCall(bytes)
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error).toMatch(/asks for no keys/)
  })
})

describe('encodeQrHardwareCall', () => {
  const adaAccount = {
    keyPath: {
      components: [
        {index: 1852, hardened: true},
        {index: 1815, hardened: true},
        {index: 0, hardened: true},
      ],
    },
    curve: CURVE_ED25519,
    algo: ALGO_BIP32_ED25519,
    chainType: CHAIN_TYPE_ADA,
  }

  // ⚠️ Round-tripped through our own decoder, which was written from a **real Eternl call** rather
  // than from the spec — so this pins the encoder to a shape a counterparty actually sent, not to my
  // reading of the registry.
  it('round-trips a two-account call through the decoder', () => {
    const call = {
      callType: 0,
      origin: 'pnyx',
      version: 1,
      schemas: [adaAccount, {...adaAccount, chainType: CHAIN_TYPE_ADA_CIP_1854}],
    }
    const decoded = decodeQrHardwareCall(encodeQrHardwareCall(call))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.callType).toBe(0)
    expect(decoded.value.origin).toBe('pnyx')
    expect(decoded.value.version).toBe(1)
    expect(decoded.value.schemas).toHaveLength(2)
    expect(decoded.value.schemas[0]?.keyPath.components).toEqual(adaAccount.keyPath.components)
    expect(decoded.value.schemas[1]?.chainType).toBe(CHAIN_TYPE_ADA_CIP_1854)
  })

  // The optional fields really are optional in both directions: a call carrying only what it must is
  // still answerable, and writing absent fields as defaults would put values on the wire we did not mean.
  it('omits what the caller did not state', () => {
    const decoded = decodeQrHardwareCall(encodeQrHardwareCall({schemas: [{keyPath: adaAccount.keyPath}]}))
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.callType).toBeUndefined()
    expect(decoded.value.origin).toBeUndefined()
    expect(decoded.value.schemas[0]?.curve).toBeUndefined()
  })

  // ⚠️ A call asking for nothing is a QR a user would scan into a device for no reason, and the
  // decoder already refuses one — so producing one would be us emitting what we would reject.
  it('refuses to ask for no keys', () => {
    expect(() => encodeQrHardwareCall({schemas: []})).toThrow(/no keys/)
  })
})

// ⚠️ **The strongest check available in this package: re-encode a call a real counterparty sent.**
// `ETERNL_CALL` came off the live extension, so if our writer reproduces its bytes then the field
// order, the optional-field choices and the keypath pairing all match what a Keystone is known to
// have been asked. If it ever stops matching byte-for-byte, read the diff before "fixing" the test —
// a difference here is a difference a device sees.
describe('our encoder against the captured Eternl call', () => {
  const captured = decodeUr(ETERNL_CALL)

  it('re-encodes to the same bytes', () => {
    if (!captured.ok) throw new Error('the captured fixture must decode')
    const decoded = decodeQrHardwareCall(captured.value.cbor)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(Buffer.from(encodeQrHardwareCall(decoded.value)).toString('hex')).toBe(
      Buffer.from(captured.value.cbor).toString('hex'),
    )
  })
})
