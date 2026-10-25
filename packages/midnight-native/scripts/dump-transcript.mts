// Prints the Impact op program a compiled circuit actually produced, so the hand-written
// `*_prototype` in rust/src/preimage.rs can mirror it instead of being guessed at.
//
// The Rust prototypes must reproduce the compiled circuit's transcript byte for byte. Deriving them
// from the .compact source by eye is how you get "Public transcript input mismatch for input 9"
// with no clue which op drifted. `Transcript.program` is the ground truth; this prints it.
//
// Run from the repo root (contract/managed must exist — `bun run compile:contract`):
//   node --import tsx packages/midnight-native/scripts/dump-transcript.mts join
//   node --import tsx packages/midnight-native/scripts/dump-transcript.mts setInvite
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {bytes32} from '@pnyx/contract-client/bytes'
import {encodeHandle} from '@pnyx/contract-client/handle'
import {type CirclePrivateState, createCircleWitnesses} from '@pnyx/contract-client/circle-witnesses'
import {createHandleSimulator} from '@pnyx/contract-client/handle-simulator'
import {createPaymentSimulator, shieldedContractRecipient, userRecipient} from '@pnyx/contract-client/payment-simulator'
import {createPaymentWitnesses} from '@pnyx/contract-client/payment-witnesses'
import {createHandleWitnesses} from '@pnyx/contract-client/handle-witnesses'
import {createIdentityWitnesses} from '@pnyx/contract-client/identity-witnesses'
import {createCircleSimulator} from '@pnyx/contract-client/circle-simulator'
import {createProposalSimulator} from '@pnyx/contract-client/proposal-simulator'
import {createProposalWitnesses} from '@pnyx/contract-client/proposal-witnesses'
import {createIdentitySimulator} from '@pnyx/contract-client/identity-simulator'
import {FREE_COLOR, identityCommitment, pad32, persistentHash32} from '@pnyx/contract-client/derivations'
import {
  identityJoinNullifier,
  inviteAuthorityCommitment,
  inviteCommitment,
  personaCommitment,
} from '@pnyx/contract-client/circle-derivations'
import {LedgerParameters, sampleEncryptionPublicKey, ZswapChainState} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenCallTxFromInitialStates} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {Contract} from '../../../contract/managed/circle/contract/index.js'
import {Contract as HandleContract} from '../../../contract/managed/handle/contract/index.js'
import {Contract as PaymentContract} from '../../../contract/managed/payment/contract/index.js'
import {Contract as IdentityContract} from '../../../contract/managed/identity/contract/index.js'
import {Contract as ProposalContract} from '../../../contract/managed/proposal/contract/index.js'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const circleManagedDir = path.resolve(packageDir, '../../contract/managed/circle')
const identityManagedDir = path.resolve(packageDir, '../../contract/managed/identity')
const handleManagedDir = path.resolve(packageDir, '../../contract/managed/handle')
const paymentManagedDir = path.resolve(packageDir, '../../contract/managed/payment')
const proposalManagedDir = path.resolve(packageDir, '../../contract/managed/proposal')

setNetworkId('undeployed')

const privateState: CirclePrivateState = {
  identitySk: bytes32(7),
  personaSk: bytes32(11),
  inviteSecret: bytes32(17),
}

/**
 * The founder moderator leaf the constructor seeds.
 *
 * ⚠️ Derived from the caller's own `personaSk` rather than an arbitrary 32 bytes, because
 * `requireModerator` recomputes `personaCommitment(personaSk())` and looks *that* up — with an
 * unrelated leaf seated, every moderator-gated circuit fails to run at all and there is no transcript
 * to dump. `join` does not read `moderators`, so its program is unchanged by this.
 */
const FOUNDER = personaCommitment(bytes32(11))
/** The founder's auth key, and the promoted moderator's — recognisable bytes so a drift is visible. */
const FOUNDER_AUTH = bytes32(0x61)
const MODERATOR_AUTH = bytes32(0x62)
const CIRCLE_ID = bytes32(1)

/** A 320-byte row value with recognisable bytes, so a drifted atom is visible in the dump. */
const filledValue = (seed: number): Uint8Array => {
  const out = new Uint8Array(320)
  out.fill(seed & 0xff, 0, 16)
  return out
}

const circuitId = process.argv[2]
if (circuitId === undefined) throw new Error('usage: dump-transcript.mts <circuitId>')

/**
 * Ledger state each circuit needs before it can run, and the args it takes. Keyed by circuit so one
 * script covers every port: the setup calls run through the simulator, then the call under
 * inspection is built against the state they produced.
 */
const SETUP: Record<
  string,
  {
    readonly before: readonly (() => void)[]
    readonly args: readonly unknown[]
    readonly sim?: ReturnType<typeof createCircleSimulator>
  }
> = {}

const FOUNDER_JOINED = identityJoinNullifier(CIRCLE_ID, privateState.identitySk)

const sim = createCircleSimulator(privateState, {
  circleId: CIRCLE_ID,
  isOpen: true,
  founderModerator: FOUNDER,
  founderAuth: FOUNDER_AUTH,
  founderJoined: FOUNDER_JOINED,
})

/**
 * Whoever joins in these dumps, it is never the founder.
 *
 * The constructor seats the founder in `members` and spends their join nullifier, so a founder
 * calling `join` fails the identity assert and produces no transcript at all.
 */
const JOINER: CirclePrivateState = {
  identitySk: bytes32(37),
  personaSk: bytes32(31),
  inviteSecret: bytes32(41),
}

const asJoiner = () => {
  sim.setPrivateState(JOINER)
}

SETUP.join = {before: [asJoiner], args: []}

/**
 * The **gated** arm of `join`, which is a different program from the open one.
 *
 * `join` merged the two paths and guards the invite checks with `open ||`, so an open circle
 * short-circuits them and never touches `invites` while a gated one reads the registry and removes
 * the commitment it spends. One circuit, two transcripts — this dumps the second, which is the one
 * the device rail has never been able to build.
 */
const gatedSim = createCircleSimulator(privateState, {
  circleId: CIRCLE_ID,
  isOpen: false,
  founderModerator: FOUNDER,
  founderAuth: FOUNDER_AUTH,
  founderJoined: FOUNDER_JOINED,
})

const inviteTheJoiner = () => {
  gatedSim.call('setInvite', inviteCommitment(JOINER.inviteSecret), true)
  gatedSim.setPrivateState(JOINER)
}

SETUP['join:gated'] = {before: [inviteTheJoiner], args: [], sim: gatedSim}

/** A second persona, joined so there is a member to promote. */
const MEMBER_PERSONA_SK = bytes32(31)
const joinAMember = () => {
  // The simulator calls as whoever the private state names, so the member joins as themselves and the
  // caller is put back to the founder for the circuit under inspection.
  sim.setPrivateState({identitySk: bytes32(37), personaSk: MEMBER_PERSONA_SK, inviteSecret: bytes32(41)})
  sim.call('join')
  sim.setPrivateState(privateState)
}
SETUP.addModerator = {before: [joinAMember], args: [personaCommitment(MEMBER_PERSONA_SK), MODERATOR_AUTH]}

/**
 * `setInvite` branches on `active`, and the two arms are different programs — one inserts, the other
 * asserts membership and removes. Both are listed so a prototype is checked against the arm it claims
 * to build rather than whichever happened to be dumped first.
 */
const INVITE_COMMITMENT = bytes32(51)
const issueInvite = () => {
  sim.call('setInvite', INVITE_COMMITMENT, true)
}
SETUP.setInvite = {before: [], args: [INVITE_COMMITMENT, true]}
SETUP['setInvite:revoke'] = {before: [issueInvite], args: [INVITE_COMMITMENT, false]}

/**
 * `issueInvite` — `setInvite`'s body behind the authority gate instead of the moderator gate.
 *
 * ⚠️ The caller must be the **attestor**, a persona that never joined and holds only
 * `inviteAuthoritySk`. Dumping this as the founder would produce a transcript whose gate happens to
 * pass for the wrong reason, and the Rust port takes no moderator path at all.
 */
const ATTESTOR_SK = bytes32(0xa7)
const ATTESTOR = inviteAuthorityCommitment(ATTESTOR_SK)
const authoritySim = createCircleSimulator(privateState, {
  circleId: CIRCLE_ID,
  isOpen: false,
  founderModerator: FOUNDER,
  founderAuth: FOUNDER_AUTH,
  founderJoined: FOUNDER_JOINED,
})
const delegateToAttestor = () => {
  authoritySim.call('setInviteAuthority', ATTESTOR)
  authoritySim.setPrivateState({
    identitySk: bytes32(0xa1),
    personaSk: bytes32(0xa2),
    inviteSecret: bytes32(0xa3),
    inviteAuthoritySk: ATTESTOR_SK,
  })
}
const authorityIssues = () => {
  authoritySim.call('issueInvite', INVITE_COMMITMENT, true)
}
SETUP.issueInvite = {before: [delegateToAttestor], args: [INVITE_COMMITMENT, true], sim: authoritySim}
SETUP['issueInvite:revoke'] = {
  before: [delegateToAttestor, authorityIssues],
  args: [INVITE_COMMITMENT, false],
  sim: authoritySim,
}
SETUP.setInviteAuthority = {before: [], args: [ATTESTOR]}
// `createProposal` no longer exists — a proposal is a deploy — and `castVote`/`revealVote` moved to
// `proposal.compact`, a different contract with a different state layout, so they need their own
// simulator here when their native prototypes are ported (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10).

// `identity.compact`'s circuits, which live in a different contract and so need a different
// simulator. One contract per identity now, so the simulator is told which `C` the contract is
// sealed to — every circuit authorises by deriving it from the witness.
const IDENTITY_SK = bytes32(7)
const identitySim = createIdentitySimulator({identitySk: IDENTITY_SK}, identityCommitment(IDENTITY_SK))
const ANCHOR = bytes32(0x70)
const AUTH_PUB = bytes32(0x71)

/** A card row that is written, and one that clears. Kind 0 is the contract's remove sentinel. */
const cardRow = (kind: number) => ({kind: BigInt(kind), value: filledValue(kind)})
const EMPTY_ROW = {kind: 0n, value: new Uint8Array(320)}

const publishOnce = () => {
  identitySim.call('publishRow', ANCHOR, AUTH_PUB)
}
const writeRow0 = () => {
  identitySim.call('setRow', 0n, 8n, filledValue(8))
}
const writeRows0to3 = () => {
  identitySim.call('setRows', [0n, 1n, 2n, 3n], [cardRow(8), cardRow(9), cardRow(3), cardRow(1)])
}

// `setRow` and `writeSlot` branch on kind == 0, and the *clear* branch branches again on whether the
// slot is present — `writeSlot` emits no ops at all for clearing an absent slot. Every reachable
// shape is listed so a Rust prototype can be checked against the one it claims to build rather than
// against whichever happened to be dumped first.
const IDENTITY_SETUP: Record<string, {readonly before: readonly (() => void)[]; readonly args: readonly unknown[]}> = {
  publishRow: {before: [], args: [ANCHOR, AUTH_PUB]},
  'publishRow:rotate': {before: [publishOnce], args: [ANCHOR, AUTH_PUB]},
  setPrimaryName: {before: [publishOnce], args: [encodeHandle('alice')]},
  // Write a slot that was empty.
  setRow: {before: [publishOnce], args: [0n, 8n, filledValue(8)]},
  // Overwrite a slot that already holds a row.
  'setRow:overwrite': {before: [publishOnce, writeRow0], args: [0n, 9n, filledValue(9)]},
  // Clear a present slot — the `member` popeq is asserted true, then rem + ins.
  'setRow:clear': {before: [publishOnce, writeRow0], args: [0n, 0n, new Uint8Array(320)]},
  // Four writes, no clears.
  setRows: {
    before: [publishOnce],
    args: [[0n, 1n, 2n, 3n], [cardRow(8), cardRow(9), cardRow(3), cardRow(1)]],
  },
  // Two writes and two clears of PRESENT slots — the clear arm emits its ops.
  'setRows:clearPresent': {
    before: [publishOnce, writeRows0to3],
    args: [[0n, 1n, 2n, 3n], [cardRow(8), cardRow(9), EMPTY_ROW, EMPTY_ROW]],
  },
  // Two writes and two clears of ABSENT slots — the clear arm emits the `member` popeq (false) and
  // then *nothing*, which is the shape a Rust builder is most likely to get wrong.
  'setRows:clearAbsent': {
    before: [publishOnce],
    args: [[0n, 1n, 40n, 41n], [cardRow(8), cardRow(9), EMPTY_ROW, EMPTY_ROW]],
  },
}

// `handle.compact` — one contract per claimed name. Its two provable-by-a-user circuits are the ones
// the device cannot yet build, so their programs are what this dump exists for.
//
// ⚠️ `bind` and `rebind` are the first ported circuits that call `receiveUnshielded`, and that is NOT
// a transcript op — it records an *effect*. So the op program printed below is only half of what a
// Rust prototype has to reproduce; the effects block printed after it is the other half, and
// `QueryContext::query` will not produce it on its own.
const HANDLE_SK = bytes32(9)
const HANDLE_NAME = encodeHandle('alice')
const PAYMENT_ADDRESS = bytes32(0x33)
const NEW_OWNER = identityCommitment(bytes32(0x77))

const handleSim = createHandleSimulator({identitySk: HANDLE_SK, name: HANDLE_NAME}, HANDLE_NAME, PAYMENT_ADDRESS)

const bindOnce = () => {
  handleSim.call('bind')
}

const HANDLE_SETUP: Record<string, {readonly before: readonly (() => void)[]; readonly args: readonly unknown[]}> = {
  bind: {before: [], args: []},
  rebind: {before: [bindOnce], args: [NEW_OWNER]},
  // `moderate` now spends a per-name capability minted by `payment`, so it takes where to send it back.
  moderate: {before: [], args: [true, userRecipient(bytes32(0x22))]},
  revoke: {before: [bindOnce], args: []},
}

// `payment.compact` — one deploy, global, and the only contract here that can never be replaced.
// `grantPermit` is the one that matters first: it mints the permit `handle.compact`'s `bind` spends,
// so nothing about a handle claim can be exercised end to end until it runs.
const PAYMENT_GRANT_SECRET = bytes32(0x5a)
const PAYMENT_ADMIN_AUTH = persistentHash32([pad32('pnyx:admin:v1'), PAYMENT_GRANT_SECRET])
const PAYMENT_TREASURY = userRecipient(bytes32(0x11))
const PAYMENT_BUYER = userRecipient(bytes32(0x22))
const PAYMENT_CURRENCY = bytes32(0x99)

const paymentSim = createPaymentSimulator(
  {grantSecret: PAYMENT_GRANT_SECRET, nextAdminSecret: bytes32(0x66)},
  PAYMENT_TREASURY,
  // The contract arm, which is the same bytes the unshielded spelling produced — so this fixture's
  // payment address, and every handle template sealed against it, are unchanged.
  shieldedContractRecipient(bytes32(0x12)),
  PAYMENT_ADMIN_AUTH,
)

const priceTier2 = () => {
  paymentSim.call('setPrice', 2n, PAYMENT_CURRENCY, 5n)
}

const freeTier6 = () => {
  paymentSim.call('setPrice', 6n, FREE_COLOR, 1n)
}

const PAYMENT_SETUP: Record<string, {readonly before: readonly (() => void)[]; readonly args: readonly unknown[]}> = {
  setPrice: {before: [], args: [2n, PAYMENT_CURRENCY, 5n]},
  'setPrice:remove': {before: [priceTier2], args: [2n, PAYMENT_CURRENCY, 0n]},
  grantPermit: {before: [], args: [2n, PAYMENT_BUYER]},
  grantRebindPermit: {before: [], args: [encodeHandle('alice'), PAYMENT_BUYER]},
  grantModeratePermit: {before: [], args: [encodeHandle('alice'), PAYMENT_BUYER]},
  rotateAdmin: {before: [], args: []},
  buyPermitUnshielded: {before: [priceTier2], args: [2n, PAYMENT_CURRENCY, PAYMENT_BUYER]},
  // The free tier is a price row under a reserved colour, so the setup is a `setPrice` like any other
  // currency's — which is the whole point of modelling free as one.
  claimFreePermit: {before: [freeTier6], args: [6n, PAYMENT_BUYER]},
}

// `proposal.compact` — one deploy per proposal, holding everything that grows per *vote*. Its two
// circuits are the ones a device cannot yet build, so their programs are what this dump exists for.
//
// The electorate is a snapshot, so the members root is captured from a *populated circle* and the
// voter's path is handed in — the proposal contract holds no tree to look one up in.
const PROPOSAL_CONTENT = bytes32(0x31)
const proposalCircle = createCircleSimulator(privateState, {
  circleId: CIRCLE_ID,
  isOpen: true,
  founderModerator: FOUNDER,
  founderAuth: FOUNDER_AUTH,
  founderJoined: FOUNDER_JOINED,
})
// No `join`: the constructor already seated this caller as a member, and joining again would be
// refused as an identity that has already joined.
const voterLeaf = personaCommitment(privateState.personaSk)
const voterPath = proposalCircle.getLedger().members.findPathForLeaf(voterLeaf)
if (voterPath === undefined) throw new Error('the voter did not land in the members tree')

const proposalSim = createProposalSimulator(
  {personaSk: privateState.personaSk, ballotOption: 2, ballotRand: bytes32(13), memberPath: voterPath as never},
  {
    circleId: CIRCLE_ID,
    membersRoot: proposalCircle.getLedger().members.root().field,
    content: PROPOSAL_CONTENT,
    author: voterLeaf,
    optionCount: 4,
  },
)

const castOnce = () => {
  proposalSim.call('castVote')
}

const PROPOSAL_SETUP: Record<string, {readonly before: readonly (() => void)[]; readonly args: readonly unknown[]}> = {
  castVote: {before: [], args: []},
  revealVote: {before: [castOnce], args: []},
}

/** Which contract a circuit label belongs to, and everything needed to build its call tx. */
const CONTRACTS = [
  {setup: SETUP, target: sim, managedDir: circleManagedDir, name: 'Circle', contract: Contract, witnesses: createCircleWitnesses()},
  {setup: IDENTITY_SETUP, target: identitySim, managedDir: identityManagedDir, name: 'PnyxIdentity', contract: IdentityContract, witnesses: createIdentityWitnesses()},
  {setup: HANDLE_SETUP, target: handleSim, managedDir: handleManagedDir, name: 'PnyxHandle', contract: HandleContract, witnesses: createHandleWitnesses()},
  {setup: PAYMENT_SETUP, target: paymentSim, managedDir: paymentManagedDir, name: 'PnyxPayment', contract: PaymentContract, witnesses: createPaymentWitnesses()},
  {setup: PROPOSAL_SETUP, target: proposalSim, managedDir: proposalManagedDir, name: 'PnyxProposal', contract: ProposalContract, witnesses: createProposalWitnesses()},
] as const

const owner = CONTRACTS.find((c) => c.setup[circuitId] !== undefined)
if (owner === undefined) {
  throw new Error(
    `no setup recorded for '${circuitId}' — add one (known: ${CONTRACTS.flatMap((c) => Object.keys(c.setup)).join(', ')})`,
  )
}
const plan = owner.setup[circuitId] as {
  readonly before: readonly (() => void)[]
  readonly args: readonly unknown[]
  // A variant that needs a differently-constructed contract runs against its own simulator — a gated
  // circle seals `isOpen: false` into its state, so it cannot be reached from the open one.
  readonly sim?: typeof sim
}
for (const step of plan.before) step()

// Captured after the setup calls and before the call under inspection: this is the state the Rust
// builder will deserialize, so the transcript printed below is the one it has to reproduce.
const target = plan.sim ?? owner.target
const initialContractState = target.getContractState()

const zkConfigProvider = new NodeZkConfigProvider<string>(owner.managedDir)
const compiledContract = CompiledContract.make(owner.name, owner.contract as never).pipe(
  CompiledContract.withWitnesses(owner.witnesses as never),
  CompiledContract.withCompiledFileAssets(owner.managedDir),
)

const unsubmitted = await createUnprovenCallTxFromInitialStates(
  zkConfigProvider,
  {
    compiledContract,
    // The label may carry a `:variant` suffix; the circuit id is the part before it.
    circuitId: circuitId.split(':')[0],
    contractAddress: target.contractAddress,
    args: plan.args,
    coinPublicKey: target.coinPublicKey,
    initialContractState,
    initialZswapChainState: new ZswapChainState(),
    ledgerParameters: LedgerParameters.initialParameters(),
    initialPrivateState: target.getPrivateState(),
  } as never,
  sampleEncryptionPublicKey(),
)

const intents = unsubmitted.private.unprovenTx.intents
if (intents === undefined) throw new Error('unproven tx has no intents')
const calls = [...intents.values()].flatMap((intent) => intent.actions.filter((a) => 'proof' in a))
if (calls.length !== 1) throw new Error(`expected exactly one contract call, found ${calls.length}`)
const call = calls[0] as {
  guaranteedTranscript?: {program: unknown[]; effects?: unknown}
  fallibleTranscript?: {program: unknown[]; effects?: unknown}
}

// The private transcript is the other half a Rust prototype has to reproduce, and the half with no
// error message when it drifts — a wrong ORDER proves nothing and fails as "Public transcript input
// mismatch" several layers from the cause. Printed with alignment, since that is what a hand-written
// AlignedValue has to match.
const privateOutputs = (unsubmitted.private as {privateTranscriptOutputs?: unknown[]}).privateTranscriptOutputs
if (privateOutputs !== undefined) {
  console.log(`\n=== ${circuitId} / private transcript: ${privateOutputs.length} outputs ===`)
  privateOutputs.forEach((out, i) => {
    console.log(`${String(i).padStart(3)}  ${JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`)
  })
}

for (const [stage, transcript] of [
  ['guaranteed', call.guaranteedTranscript],
  ['fallible', call.fallibleTranscript],
] as const) {
  if (transcript === undefined) {
    console.log(`\n=== ${circuitId} / ${stage}: none ===`)
    continue
  }
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x))
  console.log(`\n=== ${circuitId} / ${stage}: ${transcript.program.length} ops ===`)
  transcript.program.forEach((op, i) => {
    console.log(`${String(i).padStart(3)}  ${json(op)}`)
  })
  // Effects are the half of a transcript that no op produces. `receiveUnshielded` lands here and
  // nowhere in the program, so a Rust port that only mirrors ops builds a transcript the node rejects.
  if (transcript.effects !== undefined) console.log(`     effects  ${json(transcript.effects)}`)
}
