// Regenerates rust/fixtures/cast_vote.* and reveal_vote.* — the initial `ContractState`s and inputs
// the Rust proving tests build `proposal.compact`'s two circuits against.
//
// A proposal is its own contract (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10), so its electorate is a
// **snapshot**: the members root is captured from a populated circle and the voter's path is handed in.
// The proposal holds no tree, which is why the path is a fixture input rather than something the Rust
// builder finds in state.
//
// Run from the repo root (contract/managed must exist — `bun run compile:contract`):
//   node --import tsx packages/midnight-native/scripts/dump-vote-preimages.mts
import {mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {bytes32} from '@pnyx/contract-client/bytes'
import {
  identityJoinNullifier,
  inviteAuthorityCommitment,
  personaCommitment,
} from '@pnyx/contract-client/circle-derivations'
import {createCircleSimulator} from '@pnyx/contract-client/circle-simulator'
import type {CirclePrivateState} from '@pnyx/contract-client/circle-witnesses'
import {createProposalSimulator} from '@pnyx/contract-client/proposal-simulator'
import {createProposalWitnesses, type ProposalPrivateState} from '@pnyx/contract-client/proposal-witnesses'
import {
  type ContractCall,
  LedgerParameters,
  type PreProof,
  sampleEncryptionPublicKey,
  ZswapChainState,
} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenCallTxFromInitialStates} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {Contract} from '../../../contract/managed/proposal/contract/index.js'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const managedDir = path.resolve(packageDir, '../../contract/managed/proposal')
const fixtures = path.resolve(packageDir, 'rust/fixtures')

setNetworkId('undeployed')

const CIRCLE_ID = bytes32(1)
const CONTENT = bytes32(0x31)
const BALLOT_OPTION = 2
const BALLOT_RAND = bytes32(13)
const OPTION_COUNT = 4

const voter: CirclePrivateState = {identitySk: bytes32(7), personaSk: bytes32(11), inviteSecret: bytes32(17)}
/// A second member with a known secret, seated after the founder so its leaf index is not zero.
/// Read by `build_leave_circle_preimage.rs`.
const LEAVER_SK = bytes32(0x51)

/**
 * The attestor this circle delegates invite issuance to.
 *
 * Seated here rather than by the Rust test, because `issueInvite`'s transcript reads
 * `inviteAuthority` back with a `popeq`: against a circle that delegated to nobody the arm cannot
 * run at all, and there would be nothing to prove. `build_moderation_preimages.rs` recomputes this
 * commitment from the same secret.
 */
const ATTESTOR_SK = bytes32(0xa7)

// A populated circle, so the sealed root is a real historic root with the voter's leaf in it.
// The voter is also the founding moderator, purely so the extra members below can be seated with
// `setMember` — the one entry point that can add a leaf without a second identity to join with.
const circle = createCircleSimulator(voter, {
  circleId: CIRCLE_ID,
  isOpen: true,
  founderModerator: personaCommitment(voter.personaSk),
  founderAuth: bytes32(0x61),
  founderJoined: identityJoinNullifier(CIRCLE_ID, voter.identitySk),
})
// No `join`: the constructor seats the founder as a member and spends their join nullifier, so a
// founder calling it fails the identity assert.
circle.call('setInviteAuthority', inviteAuthorityCommitment(ATTESTOR_SK))
// One live invite, so the **revoke** arm of `setInvite`/`issueInvite` has something to remove. Those
// are different programs from the issue arm (they read the map first), and against an empty registry
// they could only ever be tested as a refusal.
const SEATED_INVITE = bytes32(0x33)
circle.call('setInvite', SEATED_INVITE, true)
const voterLeaf = personaCommitment(voter.personaSk)
// More than one member, so a path with real siblings is exercised rather than one that is all blanks:
// a single-leaf tree hides every left/right mistake, in the encoder and in the Rust reader alike.
//
// ⚠️ The first extra leaf is a **real persona commitment**, not an opaque `bytes32`, so something
// with a known `personaSk` sits at a **non-zero** index. The founder is seated by the constructor and
// therefore always index 0, where every bit of a leaf index is zero — a `leaveCircle` proved only
// against the founder passes whichever way round the index bits are read. `LEAVER_SK` is what makes
// that derivation observable.
circle.call('setMember', personaCommitment(LEAVER_SK), true)
circle.call('setMember', bytes32(0x42), true)
const memberPath = circle.getLedger().members.findPathForLeaf(voterLeaf)
if (memberPath === undefined) throw new Error('the voter did not land in the members tree')
const membersRoot = circle.getLedger().members.root().field

const privateState: ProposalPrivateState = {
  personaSk: voter.personaSk,
  ballotOption: BALLOT_OPTION,
  ballotRand: BALLOT_RAND,
  memberPath: memberPath as never,
}

const zkConfigProvider = new NodeZkConfigProvider<string>(managedDir)
const compiledContract = CompiledContract.make('PnyxProposal', Contract).pipe(
  CompiledContract.withWitnesses(createProposalWitnesses()),
  CompiledContract.withCompiledFileAssets(managedDir),
)

const deploy = {
  circleId: CIRCLE_ID,
  membersRoot,
  content: CONTENT,
  author: voterLeaf,
  optionCount: OPTION_COUNT,
} as const

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/** Build one circuit against a given starting state, and write its preimage + state fixtures. */
const dump = async (name: string, circuitId: 'castVote' | 'revealVote', before: readonly string[]) => {
  const sim = createProposalSimulator(privateState, deploy)
  for (const step of before) sim.call(step as 'castVote')
  const initialContractState = sim.getContractState()

  const unsubmitted = await createUnprovenCallTxFromInitialStates(
    zkConfigProvider,
    {
      compiledContract,
      circuitId,
      contractAddress: sim.contractAddress,
      args: [],
      coinPublicKey: sim.coinPublicKey,
      initialContractState,
      initialZswapChainState: new ZswapChainState(),
      ledgerParameters: LedgerParameters.initialParameters(),
      initialPrivateState: privateState,
    } as never,
    sampleEncryptionPublicKey(),
  )

  const intents = unsubmitted.private.unprovenTx.intents
  if (intents === undefined) throw new Error('unproven tx has no intents')
  const calls = [...intents.values()].flatMap((intent) =>
    intent.actions.filter((a): a is ContractCall<PreProof> => 'proof' in a && a.proof.instance === 'pre-proof'),
  )
  const call = calls[0]
  if (call === undefined || calls.length !== 1) {
    throw new Error(`expected exactly one contract call with a pre-proof, found ${calls.length}`)
  }

  mkdirSync(fixtures, {recursive: true})
  const preimage = call.proof.serialize()
  writeFileSync(path.join(fixtures, `${name}.preimage`), preimage)
  const stateBytes = initialContractState.serialize()
  writeFileSync(path.join(fixtures, `${name}.contract_state`), stateBytes)
  console.log(`wrote ${name}: ${preimage.length}-byte preimage, ${stateBytes.length}-byte state`)
  return sim.contractAddress
}

const castAddress = await dump('cast_vote', 'castVote', [])
const revealAddress = await dump('reveal_vote', 'revealVote', ['castVote'])

// The member path, flattened as the bridge carries it: 20 x (32-byte little-endian sibling, 1 byte
// goes_left). `member_path_from_bytes` in preimage.rs is the decoder.
const pathBytes = new Uint8Array(20 * 33)
;(memberPath as {path: {sibling: {field: bigint}; goes_left: boolean}[]}).path.forEach((entry, i) => {
  const le = new Uint8Array(32)
  let v = entry.sibling.field
  for (let b = 0; b < 32; b++) {
    le[b] = Number(v & 0xffn)
    v >>= 8n
  }
  pathBytes.set(le, i * 33)
  pathBytes[i * 33 + 32] = entry.goes_left ? 1 : 0
})

// The **circle's** populated state, so the Rust side can be tested against the same tree this path was
// read out of. A voter needs the path as of the proposal's sealed root, and the cheapest honest source
// is the circle's own state at that height — read straight from the chain, no client-side mirror.
writeFileSync(path.join(fixtures, 'circle_populated.contract_state'), circle.getContractState().serialize())
console.log('wrote circle_populated.contract_state')

writeFileSync(
  path.join(fixtures, 'vote.inputs.json'),
  `${JSON.stringify(
    {
      castVoteAddress: castAddress,
      revealVoteAddress: revealAddress,
      circleId: hex(CIRCLE_ID),
      content: hex(CONTENT),
      personaSk: hex(voter.personaSk),
      voterLeaf: hex(voterLeaf),
      membersRoot: membersRoot.toString(),
      // The same root as little-endian bytes, so a Rust test can compare it without a bignum parser —
      // the sealed ledger cell holds a field element and every other value in this file is hex.
      membersRootLe: hex(
        (() => {
          const le = new Uint8Array(32)
          let v = membersRoot
          for (let b = 0; b < 32; b++) {
            le[b] = Number(v & 0xffn)
            v >>= 8n
          }
          return le
        })(),
      ),
      optionCount: OPTION_COUNT,
      ballotOption: BALLOT_OPTION,
      ballotRand: hex(BALLOT_RAND),
      memberPath: hex(pathBytes),
      inviteAuthoritySk: hex(ATTESTOR_SK),
      seatedInvite: hex(SEATED_INVITE),
    },
    null,
    2,
  )}\n`,
)
console.log('wrote vote.inputs.json')
