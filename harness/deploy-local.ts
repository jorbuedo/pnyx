// Local-chain E2E (standalone network from infra/standalone/compose.yml): deploy BOTH contracts with
// a genesis-funded wallet and run every circuit ON-CHAIN with real proofs through the local proof
// server, then verify the final ledger state read back from the indexer.
//
// Two contract families (`docs/BOUNDED_STATE_ARCHITECTURE.md`): `identity.compact` is one deploy per
// identity and holds that person's row and contact card; `circle.compact` is one per circle. So this
// deploys one of each and runs two lifecycles — which is also the only place the *gated* half of a
// circle (invites, a second identity joining, moderation) is exercised against real proofs rather
// than the simulator.
//
// ⚠️ The circle here is deployed **through the SDK**, which samples the deploy nonce and installs a
// satisfiable maintenance authority. A real circle is built by `@pnyx/midnight-native` so its address
// commits to `(circleId, isOpen, founder)` and it deploys immutable (`docs/CONTRACT_MIGRATION.md`).
// Neither difference is visible to a circuit — `operations` and the ledger state are identical — so
// this is the right trade for a harness that exists to prove the *circuits* work on chain. The device
// deploy path is P5's job, on the emulator.
//
// `circle.compact` is **8 circuits** since the merge (`setInvite`, `join`, `setMember` each replaced
// a pair) — a deploy carries one verifier key per entry point at 2,119 bytes each, and eleven of them
// did not fit in a block. Full measurements: `docs/CONTRACT_MIGRATION.md`.
//
// Run: bun run e2e:local   (stack must be up: bun run chain:up)
import fs from 'node:fs'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath} from 'node:url'
import {deployContract} from '@midnight-ntwrk/midnight-js-contracts'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {assembleWallet, ensureDust, nightRaw, waitForSections} from '@pnyx/chain-client/wallet'
import {bytes32} from '@pnyx/contract-client/bytes'
import {
  identityJoinNullifier,
  inviteCommitment,
  personaCommitment,
} from '@pnyx/contract-client/circle-derivations'
import {type CirclePrivateState, createCircleWitnesses} from '@pnyx/contract-client/circle-witnesses'
import {CardKind, cardBatches, cardWriteSet, decodeCard, encodeCard, encodeChainAddress, type CardEntry} from '@pnyx/contract-client/card'
import {identityCommitment, pad32} from '@pnyx/contract-client/derivations'
import {type IdentityPrivateState, createIdentityWitnesses} from '@pnyx/contract-client/identity-witnesses'
import {Contract as CircleContract, ledger as circleLedger} from '../contract/managed/circle/contract/index.js'
import {Contract as IdentityContract, ledger as identityLedger} from '../contract/managed/identity/contract/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const managedDir = (target: 'identity' | 'circle') => path.resolve(here, '../contract/managed', target)

// Genesis-funded dev seed on the standalone node (CFG_PRESET=dev; testkit uses the same).
const GENESIS_SEED = process.env.LOCAL_SEED ?? '0000000000000000000000000000000000000000000000000000000000000001'

const env = {
  walletNetworkId: NetworkId.NetworkId.Undeployed,
  networkId: 'undeployed',
  indexer: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: 'http://127.0.0.1:9944',
  nodeWS: 'ws://127.0.0.1:9944',
  proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
}

setNetworkId(env.networkId)

const CIRCLE_ID = bytes32(99)
/** A second circle, gated, so the invite half of `join` is exercised at all — see `deployCircle`. */
const GATED_CIRCLE_ID = bytes32(98)

/** The founder: a moderator from the constructor, and a member once she joins. */
const alice: CirclePrivateState = {
  identitySk: bytes32(1),
  personaSk: bytes32(11),
  inviteSecret: bytes32(21),
}
/** A second identity, so an invite is actually redeemed by someone and a ban removes someone else. */
const bob: CirclePrivateState = {
  identitySk: bytes32(2),
  personaSk: bytes32(12),
  inviteSecret: bytes32(22),
}
/** A third invite, issued only so `setInvite(…, false)` has an unspent one to withdraw. */
const SPARE_INVITE = bytes32(23)

const identityState: IdentityPrivateState = {identitySk: bytes32(7)}

/** Real values, so the card carries what a card will actually carry rather than filler. */
const HARNESS_MIDNIGHT_ADDR =
  'mn_shield-addr_preprod1j79fwduuxrpphd7v3flqufr6slsquc3laz5xcv0vn2ft23p4k6vnvh3vy3ckjx9leyts2yc3mak23suejz47je5dh9n5c9zfsagrm0gtahmdd'
const HARNESS_CARDANO_ADDR =
  'addr1q8g3dv6ptkgsafh7k5muggrvfde2szzmc2m8w4dt6zqnfa2rnfxqm3xzu9nsw0y5xrcvpmvj0hnzrqqz7hkxrqx6kkzs4pnxvz'
/** The `did:midnight:offchain` long form at its schema maximum — 951 B, so it spans three slots. */
const HARNESS_DID_LONG = `did:midnight:offchain:${'a'.repeat(64)}:${'Q'.repeat(864)}`

const aliceLeaf = personaCommitment(alice.personaSk)
const bobLeaf = personaCommitment(bob.personaSk)

const logger = createDefaultTestLogger()
console.log('Assembling genesis wallet…')
const wallet = await assembleWallet(logger, env, GENESIS_SEED)
console.log(`wallet: ${wallet.unshieldedKeystore.getBech32Address().asString()}`)
await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
const synced = await waitForSections(wallet, 5 * 60_000, (s) =>
  console.log(
    `sync: unshielded=${s.unshielded.progress?.isStrictlyComplete() === true} dust=${s.dust.state.progress.appliedIndex}/${s.dust.state.progress.highestRelevantWalletIndex}`,
  ),
)
const night = synced.unshielded.balances[nightRaw()] ?? 0n
console.log(`NIGHT balance: ${night}`)
if (night === 0n) {
  throw new Error('genesis wallet has no NIGHT — is the standalone node running with CFG_PRESET=dev?')
}
await ensureDust(wallet as never, console.log)

const step = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
  const t0 = performance.now()
  const result = await action()
  console.log(`${label.padEnd(24)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`)
  return result
}

// ── identity.compact ──────────────────────────────────────────────────────────────────────────────

const identityProviders = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir('identity'),
  privateStateStoreName: 'pnyx-local-identity',
})

// `C` is sealed into the contract at deploy and is half of what the real address commits to. The
// SDK samples its own deploy nonce and ignores one passed in — verified directly, two deploys of an
// identical state land on two addresses — so the *address* here is not content-derived and the
// native rail is what makes `C -> address` work. Nothing a circuit sees differs, which is the same
// trade `deployCircle` below makes.
const harnessC = identityCommitment(identityState.identitySk)

console.log('\n=== Deploying identity.compact (one per identity) ===')
const identityDeployed = await step('deploy identity', () =>
  deployContract(identityProviders as never, {
    compiledContract: CompiledContract.make('PnyxIdentity', IdentityContract).pipe(
      CompiledContract.withWitnesses(createIdentityWitnesses()),
      CompiledContract.withCompiledFileAssets(managedDir('identity')),
    ),
    privateStateId: 'identityLocal',
    initialPrivateState: identityState,
    args: [harnessC],
  } as never),
)
const identityAddress = identityDeployed.deployTxData.public.contractAddress
console.log(`identity contract: ${identityAddress}`)

// Named rather than an index signature: with `noUncheckedIndexedAccess` a `Record<string, fn>` lookup
// is possibly-undefined, and naming the circuits turns a typo into a compile error instead of a
// runtime "is not a function".
type IdentityCalls = Readonly<
  Record<'publishRow' | 'setPrimaryName' | 'setRow' | 'setRows', (...args: never[]) => Promise<unknown>>
>
const identityCall = (identityDeployed as unknown as {callTx: IdentityCalls}).callTx

console.log('\n=== identity lifecycle (real proofs, real blocks) ===')
// Rotation overwrites in place: there is one contract per identity, so a second publish has nowhere
// else to land. `publishRow` cannot touch naming — a third writer with no rules is how a primary
// handle stops meaning anything, and the predecessor contract had exactly that bug.
await step('publishRow', () => identityCall.publishRow(bytes32(0x70) as never, bytes32(0x71) as never))
await step('publishRow (rotate)', () => identityCall.publishRow(bytes32(0x80) as never, bytes32(0x81) as never))

const HANDLE = pad32('harness')
await step('setPrimaryName', () => identityCall.setPrimaryName(HANDLE as never))

// The card, through the real codec, so a drifted length prefix or continuation flag fails here as a
// card the chain stored and the client cannot read. Four entries is one `setRows` proof; the
// long-form DID is what forces a value across three slots.
const cardEntries: CardEntry[] = [
  {kind: CardKind.ChainAddress, value: encodeChainAddress('midnight:undeployed', HARNESS_MIDNIGHT_ADDR)},
  {kind: CardKind.ChainAddress, value: encodeChainAddress('cardano:preprod', HARNESS_CARDANO_ADDR)},
  {kind: CardKind.Website, value: 'https://pnyx.app/harness'},
  {kind: CardKind.Did, value: HARNESS_DID_LONG},
]
const cardWrites = cardWriteSet(cardEntries, 0)
const cardCalls = cardBatches(cardWrites)
for (const [i, batch] of cardCalls.entries()) {
  await step(`setRows (batch ${i + 1}/${cardCalls.length}, slots ${batch.map((r) => r.slot).join(',')})`, () =>
    identityCall.setRows(
      batch.map((r) => BigInt(r.slot)) as never,
      batch.map((r) => ({kind: BigInt(r.kind), value: r.value})) as never,
    ),
  )
}
// One single-row edit, so `setRow` is exercised on chain too and not only in the simulator.
const [noteRow] = encodeCard([{kind: CardKind.Note, value: 'written by the local harness'}])
const NOTE_SLOT = BigInt(cardWrites.length)
await step('setRow (append a note)', () =>
  identityCall.setRow(NOTE_SLOT as never, BigInt(noteRow!.kind) as never, noteRow!.value as never),
)

// ── circle.compact ────────────────────────────────────────────────────────────────────────────────

const circleProviders = initializeMidnightProviders(wallet, env, {
  zkConfigPath: managedDir('circle'),
  privateStateStoreName: 'pnyx-local-circle',
})

type CircleCalls = Readonly<
  Record<
    'setInvite' | 'addModerator' | 'join' | 'setMember' | 'leaveCircle',
    (...args: never[]) => Promise<unknown>
  >
>

/**
 * Deploy one circle and return its call surface plus an identity switch.
 *
 * **Two circles, because `join` has two behaviours behind one entry point.** The invite checks are
 * guarded by `open ||`, so on an open circle they short-circuit entirely — an invite issued there is
 * never consulted and never spent. A single open circle would therefore run `setInvite` and still
 * leave the whole invite lifecycle unexercised, which is exactly what the first version of this
 * harness did: it asserted bob's invite was spent, and it was not.
 */
const deployCircle = async (label: string, circleId: Uint8Array, isOpen: boolean) => {
  const stateId = `circle-${label}`
  const deployed = await step(`deploy circle (${label})`, () =>
    deployContract(circleProviders as never, {
      compiledContract: CompiledContract.make('PnyxCircle', CircleContract).pipe(
        CompiledContract.withWitnesses(createCircleWitnesses()),
        CompiledContract.withCompiledFileAssets(managedDir('circle')),
      ),
      privateStateId: stateId,
      initialPrivateState: alice,
      // The constructor's arguments, and the three the real address commits to.
      args: [circleId, isOpen, aliceLeaf],
    } as never),
  )
  const address = deployed.deployTxData.public.contractAddress
  console.log(`circle contract (${label}): ${address}`)
  return {
    address,
    call: (deployed as unknown as {callTx: CircleCalls}).callTx,
    /**
     * Switch which identity the witnesses speak for.
     *
     * The private state is scoped per contract address, so the scope is set explicitly rather than
     * inherited — three deployed contracts share one provider instance, and a stale scope would hand
     * one circle's witnesses another's state.
     */
    actAs: async (who: CirclePrivateState): Promise<void> => {
      circleProviders.privateStateProvider.setContractAddress(address)
      await circleProviders.privateStateProvider.set(stateId, who)
    },
  }
}

console.log('\n=== Deploying circle.compact (open) ===')
const open = await deployCircle('open', CIRCLE_ID, true)

console.log('\n=== open circle: the path the app actually uses (real proofs, real blocks) ===')
await step('join (alice, open)', () => open.call.join())
// Proposals are deploys now, and voting lives in `proposal.compact` — a separate contract this
// harness does not deploy. Once its native prototypes are ported, the vote leg belongs in a harness
// of its own (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10).
await step('leaveCircle (alice)', () => open.call.leaveCircle())

console.log('\n=== Deploying circle.compact (gated) ===')
const gated = await deployCircle('gated', GATED_CIRCLE_ID, false)

console.log('\n=== gated circle: invites, a second identity, moderation ===')
await step('setInvite (alice, on)', () =>
  gated.call.setInvite(inviteCommitment(alice.inviteSecret) as never, true as never),
)
await step('setInvite (bob, on)', () => gated.call.setInvite(inviteCommitment(bob.inviteSecret) as never, true as never))
await step('setInvite (spare, on)', () => gated.call.setInvite(inviteCommitment(SPARE_INVITE) as never, true as never))
await step('setInvite (spare, off)', () => gated.call.setInvite(inviteCommitment(SPARE_INVITE) as never, false as never))

await step('join (alice, invited)', () => gated.call.join())
await gated.actAs(bob)
await step('join (bob, invited)', () => gated.call.join())

await gated.actAs(alice)
await step('addModerator (bob)', () => gated.call.addModerator(bobLeaf as never))
await step('setMember (bob, off)', () => gated.call.setMember(bobLeaf as never, false as never))
await step('setMember (bob, on)', () => gated.call.setMember(bobLeaf as never, true as never))

// ── verification ──────────────────────────────────────────────────────────────────────────────────

console.log('\n=== Verifying final ledger state from the indexer ===')
const stateAt = async (address: string, what: string) => {
  const state = await circleProviders.publicDataProvider.queryContractState(address)
  if (!state) {
    throw new Error(`${what} state not found on the indexer at ${address}`)
  }
  return state.data
}

const idState = identityLedger(await stateAt(identityAddress, 'identity contract'))
const openState = circleLedger(await stateAt(open.address, 'open circle contract'))
const gatedState = circleLedger(await stateAt(gated.address, 'gated circle contract'))

// Read the card back off the chain through the same codec that wrote it.
const onChainRows = [...idState.card].map(([slot, row]) => ({
  slot: Number(slot),
  kind: Number(row.kind),
  value: row.value,
}))
const decodedCard = decodeCard(onChainRows)
const expectedCard: CardEntry[] = [...cardEntries, {kind: CardKind.Note, value: 'written by the local harness'}]

const checks: [string, boolean][] = [
  // identity.compact — the contract *is* the identity, so the sealed id is what the address means.
  ['sealed id is the client-side commitment', Buffer.from(idState.id).equals(Buffer.from(harnessC))],
  // Two writes, one row: rotation overwrote in place and left the *later* anchor.
  ['row rotated in place', idState.anchor[0] === 0x80 && idState.authPub[0] === 0x81],
  ['primary name set', Buffer.from(idState.primaryName).equals(Buffer.from(HANDLE))],
  ['primary name survived the key rotation', idState.primaryName[0] !== 0],
  ['card holds every row written', Number(idState.card.size()) === cardWrites.length + 1],
  ['card decodes with no defects', decodedCard.defects.length === 0],
  ['card round-trips through the chain', JSON.stringify(decodedCard.entries) === JSON.stringify(expectedCard)],
  [
    'long-form DID rejoined across slots',
    decodedCard.entries.some((e) => e.kind === CardKind.Did && e.value === HARNESS_DID_LONG),
  ],

  // The open circle — its identity, fixed by its constructor.
  ['open circleId as constructed', Buffer.from(openState.circleId).equals(Buffer.from(CIRCLE_ID))],
  ['open circle is open', openState.isOpen],
  [
    'alice identity nullifier spent on the open circle',
    openState.joinedIdentities.member(identityJoinNullifier(CIRCLE_ID, alice.identitySk)),
  ],
  // The merged `join` short-circuits its invite checks when `isOpen`, so an open circle must never
  // consult the invite registry — this is the assertion that caught the first version of this harness
  // issuing invites on an open circle and believing they were redeemed.
  ['open circle consumed no invites', [...openState.invites].length === 0],

  // Proposals and votes are no longer here: each proposal is its own contract, so there is nothing
  // per-proposal in a circle's state to assert (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10).
  ['alice left the open circle', openState.members.findPathForLeaf(aliceLeaf) === undefined],

  // The gated circle — where invites are load-bearing.
  ['gated circle is gated', !gatedState.isOpen],
  [
    'alice identity nullifier spent on the gated circle',
    gatedState.joinedIdentities.member(identityJoinNullifier(GATED_CIRCLE_ID, alice.identitySk)),
  ],
  [
    'bob identity nullifier spent on the gated circle',
    gatedState.joinedIdentities.member(identityJoinNullifier(GATED_CIRCLE_ID, bob.identitySk)),
  ],
  // Single-use is now enforced by **absence**: joining removes the commitment, which is what let the
  // grow-for-ever `spentInvites` set be deleted. So a spent invite is one that is no longer listed.
  ['alice invite spent', !gatedState.invites.member(inviteCommitment(alice.inviteSecret))],
  ['bob invite spent', !gatedState.invites.member(inviteCommitment(bob.inviteSecret))],
  ['spare invite revoked', !gatedState.invites.member(inviteCommitment(SPARE_INVITE))],
  ['the invite registry is empty once every invite is spent or revoked', [...gatedState.invites].length === 0],

  // Moderation, on the gated circle. Bob was banned and reinstated, so his leaf is present — at a
  // *new* index, which is what makes "removed then appended" different from "never removed".
  ['bob reinstated in the members tree', gatedState.members.findPathForLeaf(bobLeaf) !== undefined],
  ['bob is a moderator', gatedState.moderators.findPathForLeaf(bobLeaf) !== undefined],
  [
    'alice is still a moderator on the gated circle',
    gatedState.moderators.findPathForLeaf(aliceLeaf) !== undefined,
  ],
]
for (const [label, ok] of checks) {
  console.log(`${ok ? '✔' : '✘'} ${label}`)
}
if (checks.some(([, ok]) => !ok)) {
  throw new Error('on-chain state verification FAILED')
}

const deployFile = path.resolve(here, '../.local-deploy.json')
fs.writeFileSync(
  deployFile,
  `${JSON.stringify(
    {
      network: 'undeployed',
      // `identityAddress` is what the content service reads for logins and registration
      // (`IDENTITY_CONTRACT_ADDRESS`); without it a local run has no identity rows.
      identityAddress,
      // The open circle, recorded so the submit-proven harness has something to prove against — the
      // native rail builds the open `join`. The app does not learn a circle's address this way; it
      // derives it (`docs/CONTRACT_MIGRATION.md`).
      circleAddress: open.address,
      circleId: Buffer.from(CIRCLE_ID).toString('hex'),
      gatedCircleAddress: gated.address,
      gatedCircleId: Buffer.from(GATED_CIRCLE_ID).toString('hex'),
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
)
console.log(`\nAll on-chain checks passed. Recorded → ${deployFile}`)
await wallet.stop()
process.exit(0)
