/**
 * Capture what the **compactc-generated drivers** emit, across every contract we ship.
 *
 * This is the evidence for plan item 32: each transcript here was produced by the real
 * `@midnight-ntwrk/compact-runtime` running the real `contract/managed/<c>/contract/index.js` in
 * Node — no shim, no hand-port. `compact_host_bridge.rs` then feeds every one through
 * `preimage.build` and proves it. A verifying proof per circuit means the generated driver can
 * replace that circuit's hand-port.
 *
 * ⚠️ **A transcript is only meaningful against the state it ran on**, so each entry carries the
 * state snapshot taken immediately before its call.
 *
 *   node --import tsx packages/midnight-native/scripts/dump-driver-transcripts.mts
 */
import {writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {identityJoinNullifier, personaCommitment} from '../../contract-client/src/circle-derivations.js'
import {createCircleSimulator} from '../../contract-client/src/circle-simulator.js'
import type {CirclePrivateState} from '../../contract-client/src/circle-witnesses.js'
import {createHandleSimulator} from '../../contract-client/src/handle-simulator.js'
import {createIdentitySimulator} from '../../contract-client/src/identity-simulator.js'
import {coinPublicKeyRecipient, createPaymentSimulator, userRecipient} from '../../contract-client/src/payment-simulator.js'
import {createProposalSimulator} from '../../contract-client/src/proposal-simulator.js'
import type {ProposalPrivateState} from '../../contract-client/src/proposal-witnesses.js'
import {FREE_COLOR, identityCommitment, pad32, persistentHash32} from '../../contract-client/src/derivations.js'
import {encodeHandle} from '../../contract-client/src/handle.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '../rust/fixtures')

const bytes32 = (n: number): Uint8Array => new Uint8Array(32).fill(n)
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

/** Uint8Array → hex, bigint → string, so the whole transcript is JSON the bridge can parse. */
const plain = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return hex(v)
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]))
  }
  return v
}

type Captured = {
  contract: string
  entryPoint: string
  /**
   * ⚠️ **A transcript is bound to its address, not only its state.** `payment.claimFreePermit` reads
   * the contract's own address, so replaying it under a different one fails as a `ReadMismatch` that
   * names two hashes and no cause. Carried per entry rather than assumed by the reader.
   */
  contractAddress: string
  state: string
  input: unknown
  output: unknown
  program: unknown[]
  privateTranscriptOutputs: unknown[]
  /**
   * ⚠️ **The half of a shielded call the transcript does not carry.** `ZswapLocalState` says which
   * coins the *circuit* created and spent; the offer beside the call is built from it, and without
   * it a shielded transcript proves and is then rejected as an effects-check failure. Recorded for
   * every circuit — it is empty for the fourteen that touch no zswap, which is itself the evidence
   * that they need no offer.
   */
  zswap: {inputs: unknown[]; outputs: unknown[]}
}

const captured: Captured[] = []

/** Snapshot the state, run the circuit, keep what the driver filled in. */
const zswapOf = (sim: {getContext: () => {currentZswapLocalState: {inputs: unknown[]; outputs: unknown[]}}}) =>
  sim.getContext().currentZswapLocalState

const capture = (
  contract: string,
  entryPoint: string,
  sim: {
    contractAddress: string
    getContractState: () => {serialize: () => Uint8Array}
    getContext: () => {currentZswapLocalState: {inputs: unknown[]; outputs: unknown[]}}
    call: (id: never, ...a: never[]) => unknown
  },
  ...args: unknown[]
): void => {
  const state = sim.getContractState().serialize()
  // ⚠️ **The simulator's `ZswapLocalState` is cumulative, not per-call.** It is chained across every
  // circuit the simulator runs, so reading it after the call attributes the *previous* call's coins
  // to this one — `rotateAdmin` came out carrying `buyPermitShielded`'s offer. Only the difference
  // belongs to this circuit.
  const before = zswapOf(sim)
  const seen = {inputs: before.inputs.length, outputs: before.outputs.length}
  const result = sim.call(entryPoint as never, ...(args as never[])) as {
    proofData: {input: unknown; output: unknown; publicTranscript: unknown[]; privateTranscriptOutputs: unknown[]}
  }
  captured.push({
    contract,
    entryPoint,
    // The simulator's address is hex-with-a-network-tag; the bridge takes the 32-byte body.
    contractAddress: sim.contractAddress.slice(-64),
    state: hex(state),
    input: plain(result.proofData.input),
    output: plain(result.proofData.output),
    program: plain(result.proofData.publicTranscript) as unknown[],
    privateTranscriptOutputs: plain(result.proofData.privateTranscriptOutputs) as unknown[],
    zswap: {
      inputs: plain(zswapOf(sim).inputs.slice(seen.inputs)) as unknown[],
      outputs: plain(zswapOf(sim).outputs.slice(seen.outputs)) as unknown[],
    },
  })
  const zswap = {
    inputs: zswapOf(sim).inputs.slice(seen.inputs),
    outputs: zswapOf(sim).outputs.slice(seen.outputs),
  }
  const coins = zswap.inputs.length + zswap.outputs.length
  console.log(
    `  ${contract}.${entryPoint}: ${result.proofData.publicTranscript.length} ops${coins > 0 ? ` (+${zswap.inputs.length} zswap in / ${zswap.outputs.length} out)` : ''}`,
  )
}

// ── circle ─────────────────────────────────────────────────────────────────────────────────────
console.log('circle:')
const CIRCLE_ID = bytes32(1)
const founder: CirclePrivateState = {identitySk: bytes32(7), personaSk: bytes32(11), inviteSecret: bytes32(17)}
const circle = createCircleSimulator(founder, {
  circleId: CIRCLE_ID,
  isOpen: true,
  founderModerator: personaCommitment(founder.personaSk),
  founderAuth: bytes32(0x61),
  founderJoined: identityJoinNullifier(CIRCLE_ID, founder.identitySk),
})
capture('circle', 'setInvite', circle, bytes32(0x33), true)
capture('circle', 'setInviteAuthority', circle, bytes32(0xa7))
capture('circle', 'setMember', circle, bytes32(0x41), true)
// A member exists now, so the founder can be promoted against a real leaf.
capture('circle', 'addModerator', circle, bytes32(0x41), bytes32(0x62))

// ⚠️ Snapshot the electorate **before** leaving: `leaveCircle` blanks the founder's leaf, so a path
// read afterwards finds nothing. The proposal below votes against this root.
const voterLeaf = personaCommitment(founder.personaSk)
const memberPath = circle.getLedger().members.findPathForLeaf(voterLeaf)
if (memberPath === undefined) throw new Error('the founder did not land in the members tree')
const membersRoot = circle.getLedger().members.root().field

capture('circle', 'leaveCircle', circle)

const NAME = encodeHandle('zephyr')

// ── identity ───────────────────────────────────────────────────────────────────────────────────
console.log('identity:')
const identitySk = bytes32(3)
const identity = createIdentitySimulator({identitySk}, identityCommitment(identitySk))
capture('identity', 'publishRow', identity, bytes32(0x51), bytes32(0x52))
capture('identity', 'setRow', identity, 1n, 2n, new Uint8Array(320).fill(0x53))
capture('identity', 'setPrimaryName', identity, NAME)

// ── handle ─────────────────────────────────────────────────────────────────────────────────────
console.log('handle:')
const handle = createHandleSimulator({identitySk: bytes32(5), name: NAME}, NAME, bytes32(0x71))
capture('handle', 'bind', handle)

// ── proposal ──────────────────────────────────────────────────────────────────────────────────
//
// A proposal is its own contract and holds no tree: its electorate is a **snapshot**, so the members
// root and the voter's path are deploy inputs. The circle above is where both come from.
console.log('proposal:')
const proposalPrivate: ProposalPrivateState = {
  personaSk: founder.personaSk,
  ballotOption: 1,
  ballotRand: bytes32(0x5a),
  memberPath: memberPath as never,
}
const proposal = createProposalSimulator(proposalPrivate, {
  circleId: CIRCLE_ID,
  membersRoot,
  content: bytes32(0x31),
  author: voterLeaf,
  optionCount: 2,
})
capture('proposal', 'castVote', proposal)
// revealVote needs the sealed ballot the commit above wrote — same simulator, in order.
capture('proposal', 'revealVote', proposal)

// ── payment ───────────────────────────────────────────────────────────────────────────────────
//
// ⚠️ **The only contract here that reaches zswap**, and only through `buyPermitShielded` — the other
// seven circuits touch none of it. That one circuit is why the bridge serves a coin commitment at
// all, so it is captured below rather than left to a hand-port.
console.log('payment:')
// ⚠️ Derived the way the contract does (`adminCommitment(grantSecret())`), not picked — an
// unrelated constant fails `requireAdmin` with "not authorised" and every admin circuit is skipped.
const GRANT_SECRET = bytes32(0x64)
const ADMIN_AUTH = persistentHash32([pad32('pnyx:admin'), GRANT_SECRET])
const payment = createPaymentSimulator(
  {grantSecret: GRANT_SECRET, nextAdminSecret: bytes32(0x66)},
  userRecipient(bytes32(0x11)),
  // ⚠️ A **coin public key**, and the left arm — the shielded `Either` runs the opposite way from the
  // unshielded one above it. This is the arm a real deploy uses, so it is the arm the one circuit
  // that reads this field gets captured against.
  coinPublicKeyRecipient(bytes32(0x12)),
  ADMIN_AUTH,
)
capture('payment', 'setPrice', payment, 6n, FREE_COLOR, 1n)
capture('payment', 'claimFreePermit', payment, 6n, userRecipient(bytes32(0x22)))
capture('payment', 'grantPermit', payment, 3n, userRecipient(bytes32(0x22)))

// The shielded rail. ⚠️ **The coin is received and forwarded in the same circuit**, so this one
// transcript carries a zswap receive *and* a spend — `_receiveShielded_0` then `_sendShielded_0`,
// two coin commitments and one nullifier. Nothing else in the repo produces either.
//
// ⚠️ Priced **below** what the coin carries on purpose: the circuit asserts `value >= price` and
// forwards the whole coin, so an equal price would leave the over-payment branch unexercised.
const PAID_COLOR = bytes32(0x77)
capture('payment', 'setPrice', payment, 2n, PAID_COLOR, 500n)
capture('payment', 'buyPermitShielded', payment, 2n, {nonce: bytes32(0x88), color: PAID_COLOR, value: 900n}, userRecipient(bytes32(0x22)))

// ⚠️ Last: it moves `adminAuth`, so every admin circuit above it must already have run.
capture('payment', 'rotateAdmin', payment)

writeFileSync(path.join(fixtures, 'driver.transcripts.json'), `${JSON.stringify(captured, null, 2)}\n`)
console.log(`\nwrote driver.transcripts.json: ${captured.length} circuits across 5 contracts`)
