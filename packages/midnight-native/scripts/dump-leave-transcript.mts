/**
 * Capture what the **compactc-generated driver** actually emits for `leaveCircle`, so the host
 * bridge can be checked against it without a device.
 *
 * This is the oracle item 32 needs. Node has WebAssembly, so here the real
 * `@midnight-ntwrk/compact-runtime` runs the real `contract/managed/circle/contract/index.js`
 * against the real fixture — no shim, no hand-port. What it writes out is the driver's own
 * `partialProofData`: the verify-mode public transcript (with every `popeq` result substituted) and
 * the private transcript outputs.
 *
 * `compact_host_bridge.rs` then feeds exactly this through `preimage.build` and proves it. A
 * verifying proof means the generated driver's transcript is provable by our rail — which is the
 * whole premise of replacing `preimage.rs`'s hand-ports.
 *
 *   node --import tsx packages/midnight-native/scripts/dump-leave-transcript.mts
 */
import {writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createCircleSimulator} from '../../contract-client/src/circle-simulator.js'
import type {CirclePrivateState} from '../../contract-client/src/circle-witnesses.js'
import {identityJoinNullifier, personaCommitment} from '../../contract-client/src/circle-derivations.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '../rust/fixtures')

const bytes32 = (n: number): Uint8Array => new Uint8Array(32).fill(n)
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

const CIRCLE_ID = bytes32(1)
/** The same founder `dump-vote-preimages.mts` seats, so both scripts describe one circle. */
const founder: CirclePrivateState = {identitySk: bytes32(7), personaSk: bytes32(11), inviteSecret: bytes32(17)}

const circle = createCircleSimulator(founder, {
  circleId: CIRCLE_ID,
  isOpen: true,
  founderModerator: personaCommitment(founder.personaSk),
  founderAuth: bytes32(0x61),
  founderJoined: identityJoinNullifier(CIRCLE_ID, founder.identitySk),
})

// The state the transcript runs against, captured *before* the call — a transcript is only
// meaningful against the state it was produced from.
const stateBefore = circle.getContractState().serialize()

const result = circle.call('leaveCircle')

/**
 * `partialProofData` as the driver filled it in. `publicTranscript` is already verify-mode: the
 * runtime substituted each read's content into its `popeq` after the gather pass.
 */
const proofData = result.proofData as {
  input: unknown
  output: unknown
  publicTranscript: unknown[]
  privateTranscriptOutputs: unknown[]
}

/** Uint8Array → hex, and bigint → string, so the whole thing is JSON the bridge can parse. */
const plain = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return hex(v)
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]))
  }
  return v
}

const out = {
  entryPoint: 'leaveCircle',
  state: hex(stateBefore),
  input: plain(proofData.input),
  output: plain(proofData.output),
  program: plain(proofData.publicTranscript),
  privateTranscriptOutputs: plain(proofData.privateTranscriptOutputs),
}

writeFileSync(path.join(fixtures, 'leave_circle.transcript.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(
  `wrote leave_circle.transcript.json: ${out.program.length} ops, ` +
    `${out.privateTranscriptOutputs.length} private outputs, ${stateBefore.length}-byte state`,
)
