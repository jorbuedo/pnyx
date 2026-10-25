import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {handleTier, MAX_HANDLE_BYTES} from './handle.js'

// The tier boundaries are the one naming rule enforced on both sides, and the only one where a
// disagreement is silently harmful: `bind` requires a permit whose color is *exactly* the tier it
// derives from the name, so a client that buckets a name differently builds a transaction that cannot
// prove — and the failure surfaces as a proof rejection, not as "wrong tier".
//
// This replaced a floor. Until 2026-08-24 the shared rule was a 5-byte minimum in `claimName`, pinned
// against `identity.compact`; short names are now *priced* rather than forbidden, so the shared rule is
// the bucketing instead. Full reasoning: `docs/BOUNDED_STATE_ARCHITECTURE.md` §3.5.
//
// Live since 2026-08-24, when `contract/handle.compact` landed. Its predecessor pinned a 5-byte floor
// against `identity.compact` and was skipped for a day while naming had no contract; if this file ever
// needs skipping again, the reason to write down is *which* contract is missing.
const CONTRACT_PATH = '../../../contract/handle.compact'

/**
 * The byte index each tier boundary is probed at. A tier starting at length L is detected by
 * `b[L - 1] == 0` meaning "shorter than L", so the probe index is one less than the tier's first
 * length: tiers start at 3, 4, 5, 7, 11 and 23 bytes.
 */
const PROBE_INDICES = [2, 3, 4, 6, 10, 22] as const

// Read lazily. It matters if this ever goes back to `describe.skip`: a skipped body still *evaluates*,
// so reading at collection time would throw on a missing contract and fail the file rather than skip it.
//
// The `\(` matters: without it a rename to `nameTierX` still matches as a prefix, and the whole file
// passes while pinning nothing.
const tierCircuit = (): string | undefined => {
  const source = readFileSync(fileURLToPath(new URL(CONTRACT_PATH, import.meta.url)), 'utf8')
  return source.match(/circuit nameTier\((?:[^}]*)}/)?.[0]
}

describe('handle tier parity with handle.compact', () => {
  it('finds the tier circuit, so a rename cannot make this test vacuous', () => {
    expect(tierCircuit()).toBeDefined()
  })

  it('probes exactly the boundaries the client buckets on', () => {
    // Scoped to the tier expression, not the whole circuit: `b[31] == 0` is the canonicality guard and
    // matches the same shape, so sweeping the circuit would pin the guard as if it were a boundary.
    const expression = (tierCircuit() ?? '').match(/return \((?:[^;]*)\)/)?.[0] ?? ''
    expect(expression, 'the tier expression should be a single return').not.toBe('')
    const probed = [...expression.matchAll(/b\[(\d+)] == 0/g)].map((m) => Number(m[1]))
    expect(probed).toEqual([...PROBE_INDICES])
  })

  it('guards canonicality by forcing the top limb to zero', () => {
    // Without this the limb recomposition leaves one field wrap representable, whose carries change
    // the low limbs the tier reads — a premium name at a cheap tier. See MAX_HANDLE_BYTES.
    expect(tierCircuit()).toMatch(/b\[31] == 0/)
  })

  it('refuses an empty name, which the encoding reserves for "no handle"', () => {
    expect(tierCircuit()).toMatch(/b\[0] != 0/)
  })

  it('agrees with the client on every length', () => {
    // The client's table read back out of the circuit's probe indices: a name of length L sits in the
    // tier whose probes it passes. Derived from PROBE_INDICES rather than restated, so the two halves
    // of this file cannot drift apart either.
    for (let length = 1; length <= MAX_HANDLE_BYTES; length++) {
      const fromProbes = PROBE_INDICES.filter((index) => length >= index + 1).length
      const bytes = new Uint8Array(32)
      bytes.fill(0x61, 0, length)
      expect(handleTier(bytes), `${length} bytes`).toBe(fromProbes)
    }
  })
})

// The other cross-language link in `handle.compact`, and the one that fails hardest if it drifts: the
// name's moderation-capability domain. The contract seals it in its constructor, so it is part of the
// handle's address; `payment.grantModeratePermit` mints that colour; `moderate` spends it. A client
// deriving a different value mints a token no handle will ever accept, and since `moderateDomain` is
// sealed there is no circuit that could repair it — the name is unmoderatable for ever.
//
// Asserted against the *compiled* constructor rather than the source text, because the source only
// shows the expression while the ledger shows what it actually produced.
describe('the moderation domain agrees across the client, the contract and Rust', () => {
  it('seals exactly what moderatePermitDomain derives', async () => {
    const {createHandleSimulator} = await import('./handle-simulator.js')
    const {moderatePermitDomain} = await import('./derivations.js')
    const {encodeHandle} = await import('./handle.js')
    const {bytes32} = await import('./bytes.js')

    const name = encodeHandle('alice')
    const sim = createHandleSimulator({identitySk: bytes32(0x2a), name}, name, bytes32(0x33))
    expect(new Uint8Array(sim.getLedger().moderateDomain)).toEqual(moderatePermitDomain(name))
  })

  it('is a function of the name, so one name cannot moderate another', async () => {
    const {createHandleSimulator} = await import('./handle-simulator.js')
    const {encodeHandle} = await import('./handle.js')
    const {bytes32} = await import('./bytes.js')

    const alice = encodeHandle('alice')
    const bob = encodeHandle('bob')
    const a = createHandleSimulator({identitySk: bytes32(0x2a), name: alice}, alice, bytes32(0x33))
    const b = createHandleSimulator({identitySk: bytes32(0x2a), name: bob}, bob, bytes32(0x33))
    expect(new Uint8Array(a.getLedger().moderateDomain)).not.toEqual(new Uint8Array(b.getLedger().moderateDomain))
  })

  it('carries no admin secret at all — the template has nothing to leak', () => {
    const contract = readFileSync(fileURLToPath(new URL(CONTRACT_PATH, import.meta.url)), 'utf8')
    expect(contract).not.toMatch(/adminAuth/)
    expect(contract).not.toMatch(/grantSecret/)
    expect(contract).toMatch(/sealed ledger moderateDomain: Bytes<32>;/)
  })
})
