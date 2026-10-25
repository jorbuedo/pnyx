// Regenerates rust/fixtures/handle_* — the states and inputs the Rust `bind`/`rebind` port is tested
// against.
//
// The states come from the **real compact runtime**, not from bytes a test invented: that is what
// makes them an oracle for the hand-written transcripts in rust/src/preimage.rs. ⚠️ Still a weaker
// guarantee than chain-written state — re-capture from preprod once a handle contract is deployed
// there.
//
// ⚠️ `bind` spends a permit and `rebind` spends a per-name one, so neither call *balances* in a
// simulator — the fixtures exist to test transcript construction and proving, not settlement. A live
// claim additionally needs `payment.compact` deployed and a `grantPermit` run against it.
//
// Run from the repo root (contract/managed/handle must exist — `bun run compile:contract`):
//   node --import tsx packages/midnight-native/scripts/dump-handle-fixtures.mts
import {mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {sampleCoinPublicKey, sampleEncryptionPublicKey} from '@midnight-ntwrk/ledger-v8'
import {createUnprovenDeployTxFromVerifierKeys} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {Contract as HandleContract} from '../../../contract/managed/handle/contract/index.js'
import {Contract as IdentityContract} from '../../../contract/managed/identity/contract/index.js'
import {Contract as PaymentContract} from '../../../contract/managed/payment/contract/index.js'
import {Contract as ProposalContract} from '../../../contract/managed/proposal/contract/index.js'
import {createHandleWitnesses} from '@pnyx/contract-client/handle-witnesses'
import {createIdentityWitnesses} from '@pnyx/contract-client/identity-witnesses'
import {createPaymentWitnesses} from '@pnyx/contract-client/payment-witnesses'
import {createProposalWitnesses} from '@pnyx/contract-client/proposal-witnesses'
import {bytes32} from '@pnyx/contract-client/bytes'
import {identityCommitment, moderatePermitDomain, pad32, persistentHash32} from '@pnyx/contract-client/derivations'
import {createHandleSimulator} from '@pnyx/contract-client/handle-simulator'
import {encodeHandle, handleTier} from '@pnyx/contract-client/handle'
import {FREE_COLOR} from '@pnyx/contract-client/derivations'
import {createPaymentSimulator, shieldedContractRecipient, userRecipient} from '@pnyx/contract-client/payment-simulator'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = (name: string) => path.resolve(packageDir, 'rust/fixtures', name)
mkdirSync(path.resolve(packageDir, 'rust/fixtures'), {recursive: true})

setNetworkId('undeployed')

const IDENTITY_SK = bytes32(0x2a)
const C = identityCommitment(IDENTITY_SK)
const NEW_OWNER = identityCommitment(bytes32(0x77))
const GRANT_SECRET = bytes32(0x5a)
// ⚠️ `pnyx:admin`, not `pnyx:admin:v1`. The tag lost its suffix when `647d188c` made the admin
// rotatable, and this script — in no tsconfig, run by nothing — kept the old one. `setPrice` then
// failed `requireAdmin` with *"not authorised"*, so `payment_free_t6.contract_state` froze at
// 2026-08-26 and `build_claim_free_permit_tx.rs` has been red since 2026-08-29 against a state the
// contract no longer produces. Read from `contract/payment.compact`'s `adminCommitment`, not from
// memory.
const ADMIN_AUTH = persistentHash32([pad32('pnyx:admin'), GRANT_SECRET])
const PAYMENT = bytes32(0x33)

/**
 * Six bytes, so `handleTier` buckets it at **3**. Deliberately not a tier the arms happen to share:
 * the transcript claims one permit colour and only one, so a fixture on a boundary would pass against
 * a builder that picked its neighbour.
 */
const NAME = encodeHandle('zephyr')

const fresh = () => createHandleSimulator({identitySk: IDENTITY_SK, name: NAME}, NAME, PAYMENT)

const write = (name: string, bytes: Uint8Array) => {
  writeFileSync(out(name), bytes)
  console.log(`wrote ${name} (${bytes.length} bytes)`)
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

const writeText = (name: string, text: string) => {
  writeFileSync(out(name), text)
  console.log(`wrote ${name}`)
}

/**
 * A constructor's state **from the deploy path**, not the simulator's.
 *
 * ⚠️ The difference is the whole point. `initialContractState` here carries the `operations` map —
 * one verifier key per entry point — and the maintenance authority, and the contract address is a
 * hash over all of it. The simulator produces only the ledger `data`, so a fixture taken from it
 * leaves the two largest contributors to the address unchecked, and the Rust builder could get them
 * both wrong with every test still green.
 */
const deployState = async (
  name: string,
  target: string,
  contract: unknown,
  witnesses: unknown,
  privateState: unknown,
  args: readonly unknown[],
) => {
  const managedDir = path.resolve(packageDir, `../../contract/managed/${target}`)
  const compiledContract = CompiledContract.make(name, contract as never).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(managedDir),
  )
  const unsubmitted = await createUnprovenDeployTxFromVerifierKeys(
    new NodeZkConfigProvider<string>(managedDir),
    sampleCoinPublicKey(),
    {compiledContract, initialPrivateState: privateState, args, signingKey: undefined} as never,
    sampleEncryptionPublicKey(),
  )
  return unsubmitted.public.initialContractState
}

// 1. An unbound shell — what `bind` is called against, and the state the Rust address derivation has
//    to reproduce. From the deploy path, so the verifier-key map is covered too.
const unbound = fresh()
const unboundDeploy = await deployState(
  'PnyxHandle',
  'handle',
  HandleContract,
  createHandleWitnesses(),
  {identitySk: IDENTITY_SK, name: NAME},
  [NAME, {bytes: PAYMENT}],
)
write('handle_unbound.contract_state', unboundDeploy.serialize())

// 2. The same contract after a successful bind — what `rebind` is called against.
const bound = fresh()
bound.call('bind')
write('handle_bound.contract_state', bound.getContractState().serialize())

// 3. A *fresh* identity and payment contract — the constructor's output for each, which is what the
//    Rust `*_ledger_state` builders must reproduce byte for byte. The address is a hash over this
//    state, so a single wrong cell makes every derived address wrong, and nothing else would say so.
const identityFresh = await deployState(
  'PnyxIdentity',
  'identity',
  IdentityContract,
  createIdentityWitnesses(),
  {identitySk: IDENTITY_SK},
  [C],
)
write('identity_fresh.contract_state', identityFresh.serialize())

const PAYMENT_TREASURY = bytes32(0x11)
/** Who a claimed permit is minted to in the fixture — an ordinary user address. */
const PAYMENT_RECIPIENT = bytes32(0x22)
const PAYMENT_SHIELDED_TREASURY = bytes32(0x12)
const paymentFresh = await deployState(
  'PnyxPayment',
  'payment',
  PaymentContract,
  createPaymentWitnesses(),
  {grantSecret: GRANT_SECRET, nextAdminSecret: bytes32(0x66)},
  [userRecipient(PAYMENT_TREASURY), shieldedContractRecipient(PAYMENT_SHIELDED_TREASURY), ADMIN_AUTH],
)
write('payment_fresh.contract_state', paymentFresh.serialize())

// The same contract with **tier 6 opened free**, which is the state `claimFreePermit` is built against:
// its only gate is that row's presence, so a fresh deployment is precisely the state where the call must
// fail. The simulator writes the row; the deploy-path state above supplies the operations map.
const paymentFreeSim = createPaymentSimulator(
  {grantSecret: GRANT_SECRET, nextAdminSecret: bytes32(0x66)},
  userRecipient(PAYMENT_TREASURY),
  shieldedContractRecipient(PAYMENT_SHIELDED_TREASURY),
  ADMIN_AUTH,
)
paymentFreeSim.call('setPrice', 6n, FREE_COLOR, 1n)
write('payment_free_t6.contract_state', paymentFreeSim.getContractState().serialize())
writeText(
  'payment.inputs.json',
  `${JSON.stringify(
    {
      contractAddress: paymentFreeSim.contractAddress,
      freeTier: 6,
      recipient: hex(PAYMENT_RECIPIENT),
      adminAuth: hex(ADMIN_AUTH),
    },
    null,
    2,
  )}\n`,
)

// A fresh proposal, from the DEPLOY path so its verifier-key map is the one a real deploy installs —
// the simulator's own operations map differs, and that is what
// `proposal_state_matches_the_compiled_constructor` compares.
const PROPOSAL_CIRCLE_ID = bytes32(1)
const PROPOSAL_CONTENT = bytes32(0x31)
const PROPOSAL_AUTHOR = bytes32(0x0b)
const PROPOSAL_MEMBERS_ROOT = 12345678901234567890n
const proposalFresh = await deployState(
  'PnyxProposal',
  'proposal',
  ProposalContract,
  createProposalWitnesses(),
  {personaSk: PROPOSAL_AUTHOR, ballotOption: 0, ballotRand: bytes32(13), memberPath: undefined},
  [PROPOSAL_CIRCLE_ID, PROPOSAL_MEMBERS_ROOT, PROPOSAL_CONTENT, PROPOSAL_AUTHOR, 4n],
)
write('proposal_fresh.contract_state', proposalFresh.serialize())

writeFileSync(
  out('handle.inputs.json'),
  `${JSON.stringify(
    {
      contractAddress: unbound.contractAddress,
      boundContractAddress: bound.contractAddress,
      coinPublicKey: unbound.coinPublicKey,
      identitySk: Buffer.from(IDENTITY_SK).toString('hex'),
      c: Buffer.from(C).toString('hex'),
      newOwner: Buffer.from(NEW_OWNER).toString('hex'),
      name: Buffer.from(NAME).toString('hex'),
      tier: handleTier(NAME),
      payment: Buffer.from(PAYMENT).toString('hex'),
      adminAuth: Buffer.from(ADMIN_AUTH).toString('hex'),
      moderateDomain: Buffer.from(moderatePermitDomain(NAME)).toString('hex'),
      proposalCircleId: Buffer.from(PROPOSAL_CIRCLE_ID).toString('hex'),
      proposalContent: Buffer.from(PROPOSAL_CONTENT).toString('hex'),
      proposalAuthor: Buffer.from(PROPOSAL_AUTHOR).toString('hex'),
      proposalMembersRoot: PROPOSAL_MEMBERS_ROOT.toString(),
      proposalOptionCount: 4,
      paymentTreasury: Buffer.from(PAYMENT_TREASURY).toString('hex'),
      paymentShieldedTreasury: Buffer.from(PAYMENT_SHIELDED_TREASURY).toString('hex'),
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote handle.inputs.json (tier ${handleTier(NAME)}, address ${unbound.contractAddress})`)
