// Regenerates rust/fixtures/identity_* — the states and inputs the Rust identity port is tested
// against. Replaces dump-identity-row-preimage.mts, which built the retired `identities`-map
// contract's fixtures (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.1).
//
// The states come from the **real compact runtime**, not from bytes a test invented: that is what
// makes them an oracle for the hand-written transcripts in rust/src/preimage.rs. ⚠️ Still a weaker
// guarantee than chain-written state — re-capture from preprod once the new contract is deployed
// there.
//
// Run from the repo root (contract/managed/identity must exist — `bun run compile:contract`):
//   node --import tsx packages/midnight-native/scripts/dump-identity-fixtures.mts
import {mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {bytes32} from '@pnyx/contract-client/bytes'
import {CardKind, cardBatches, cardWriteSet, encodeCard} from '@pnyx/contract-client/card'
import {identityCommitment} from '@pnyx/contract-client/derivations'
import {encodeHandle} from '@pnyx/contract-client/handle'
import {createIdentitySimulator} from '@pnyx/contract-client/identity-simulator'
import type {IdentityPrivateState} from '@pnyx/contract-client/identity-witnesses'
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = (name: string) => path.resolve(packageDir, 'rust/fixtures', name)

setNetworkId('undeployed')

const IDENTITY_SK = bytes32(0x2a)
const C = identityCommitment(IDENTITY_SK)
const ANCHOR = bytes32(0x70)
const AUTH_PUB = bytes32(0x71)
const HANDLE = encodeHandle('zephyr')

const privateState: IdentityPrivateState = {identitySk: IDENTITY_SK}
const fresh = () => createIdentitySimulator(privateState, C)

mkdirSync(path.dirname(out('x')), {recursive: true})
const write = (name: string, bytes: Uint8Array) => {
  writeFileSync(out(name), bytes)
  console.log(`wrote ${bytes.length} bytes to ${name}`)
}

// 1. The constructor's own state — what a builder deserializes before the first call. Also the
//    "deployed but nothing published" case the reader must report as None rather than as an error.
const constructed = fresh()
write('identity_constructed.contract_state', constructed.getContractState().serialize())

// 2. A published row, no card.
const published = fresh()
published.call('publishRow', ANCHOR, AUTH_PUB)
write('identity_row_published.contract_state', published.getContractState().serialize())
write('identity_row_published.c', C)

// 3. Published, named — so the reader's `primaryName` path sees a real left-aligned handle. This is
//    the alignment regression: a `Bytes<32>` atom arrives trimmed of trailing zeros, and a reader
//    that right-aligns it turns `zephyr` into 26 zeros followed by the text.
const named = fresh()
named.call('publishRow', ANCHOR, AUTH_PUB)
named.call('setPrimaryName', HANDLE)
write('identity_row_named.contract_state', named.getContractState().serialize())

// 4. Published with a card, including a value that spans three slots — the case the codec's
//    continuation bit exists for, and the one a decoder that reads a single row would pass anyway.
const DID_LONG = `did:midnight:offchain:${'a'.repeat(64)}:${'Q'.repeat(864)}`
const CARD = [
  {kind: CardKind.MidnightShieldedAddress, value: 'mn_shield-addr_preprod1qqqqqqqqqqqqqqqqqqqqqqqqq'},
  {kind: CardKind.Website, value: 'https://pnyx.app/zephyr'},
  {kind: CardKind.Did, value: DID_LONG},
] as const
const carded = fresh()
carded.call('publishRow', ANCHOR, AUTH_PUB)
for (const batch of cardBatches(cardWriteSet([...CARD], 0))) {
  carded.call(
    'setRows',
    batch.map((r) => BigInt(r.slot)),
    batch.map((r) => ({kind: BigInt(r.kind), value: r.value})),
  )
}
write('identity_row_card.contract_state', carded.getContractState().serialize())

// 5. Inputs the Rust preimage tests reconstruct their calls from. `cardRowSlot`/`cardRowKind` name
//    the single-row edit those tests build, and `occupiedSlots` is how many the card fixture holds —
//    a Rust test clearing a slot has to know which ones are actually there.
const cardRows = encodeCard([...CARD])
writeFileSync(
  out('identity.inputs.json'),
  `${JSON.stringify(
    {
      contractAddress: published.contractAddress,
      coinPublicKey: published.coinPublicKey,
      identitySk: Buffer.from(IDENTITY_SK).toString('hex'),
      c: Buffer.from(C).toString('hex'),
      anchorFill: 0x70,
      authPubFill: 0x71,
      handle: Buffer.from(HANDLE).toString('hex'),
      occupiedSlots: cardRows.length,
      cardRowSlot: 0,
      cardRowKind: CardKind.Note,
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote identity.inputs.json (contractAddress ${published.contractAddress}, ${cardRows.length} card rows)`)
