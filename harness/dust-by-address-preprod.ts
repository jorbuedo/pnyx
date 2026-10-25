// Can a DUST balance be read for one address, without syncing the dust ledger?
//
// The dust wallet in the SDK replays `dustLedgerEvents` — 1.4M+ events on preprod, ~20 min — and that is
// what makes DUST expensive on a phone. But the indexer also exposes
// `dustGenerations(dustAddress, startIndex, endIndex)`, whose items carry `owner`, the backing NIGHT
// `value`, the `initialValue` in SPECK, `ctime`, both Merkle indices and a collapsed Merkle tree update.
// For a wallet with 31 registered NIGHT UTxOs that is ~31 items rather than 1.4M events.
//
// This script asks the question directly: subscribe for one dust address and print what comes back.
//
// ⚠️ `startIndex`/`endIndex` are indices into the **global** dust generation Merkle tree, not a page
// offset into this address's own entries. Scanning 0..50,000 on a chain with 1.4M dust events finds
// nothing and looks exactly like "this address has no DUST" — which is precisely the false zero that
// cost session 59.
//
// Run: PREPROD_MNEMONIC="…" bun run preprod:dust
import {Effect} from 'effect'
import {deriveMidnightDustAddress} from '../packages/wallet/account/derivation/midnight.js'
import {mnemonicToSeed} from '../packages/wallet/account/seed.js'

const INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws'

const mnemonic = process.env.PREPROD_MNEMONIC
if (mnemonic === undefined || mnemonic === '') {
  console.error('PREPROD_MNEMONIC is required (the wallet whose dust address is queried)')
  process.exit(2)
}

const endIndex = Number(process.env.DUST_END_INDEX ?? 5_000_000)
const dustAddress = await Effect.runPromise(
  deriveMidnightDustAddress(await mnemonicToSeed(mnemonic.trim().split(/\s+/).join(' ')), {networkId: 'preprod'}),
)
console.log(`dust address: ${dustAddress}\nscanning generation indices 0..${endIndex}\n`)

const QUERY = `subscription Dust($addr: DustAddress!, $start: Int, $end: Int) {
  dustGenerations(dustAddress: $addr, startIndex: $start, endIndex: $end) {
    __typename
    ... on DustGenerationsItem {
      commitmentMtIndex
      generationMtIndex
      owner
      value
      initialValue
      backingNight
      ctime
      transactionHash
    }
    ... on DustGenerationsProgress {
      highestIndex
    }
    ... on DustGenerationDtimeUpdateItem {
      generationMtIndex
      owner
      newDtime
    }
  }
}`

type Item = {
  __typename: string
  generationMtIndex?: number
  commitmentMtIndex?: number
  owner?: string
  value?: string
  initialValue?: string
  ctime?: number
  highestIndex?: number
  newDtime?: number
}

const items: Item[] = []
const socket = new WebSocket(INDEXER_WS, ['graphql-transport-ws'])
const deadline = setTimeout(() => {
  console.log('\n(no more events for 45 s — stopping)')
  finish()
}, 45_000)

const finish = () => {
  clearTimeout(deadline)
  const generations = items.filter((i) => i.__typename === 'DustGenerationsItem')
  const dtimes = items.filter((i) => i.__typename === 'DustGenerationDtimeUpdateItem')
  const progress = items.filter((i) => i.__typename === 'DustGenerationsProgress')
  console.log(
    [
      '',
      '=== Result ===',
      `generation items: ${generations.length}`,
      `dtime updates:    ${dtimes.length}`,
      `progress frames:  ${progress.length}${progress.length > 0 ? ` (highest index ${progress.at(-1)?.highestIndex})` : ''}`,
    ].join('\n'),
  )
  if (generations.length > 0) {
    const backingNight = generations.reduce((sum, i) => sum + BigInt(i.value ?? '0'), 0n)
    const initialDust = generations.reduce((sum, i) => sum + BigInt(i.initialValue ?? '0'), 0n)
    console.log(`backing NIGHT (STAR): ${backingNight}`)
    console.log(`initial DUST (SPECK): ${initialDust}`)
    console.log('\nfirst three:')
    for (const item of generations.slice(0, 3)) {
      console.log(
        `  genMt=${item.generationMtIndex} commitMt=${item.commitmentMtIndex} night=${item.value} ` +
          `initialDust=${item.initialValue} ctime=${item.ctime}`,
      )
    }
  }
  socket.close()
  process.exit(0)
}

socket.addEventListener('open', () => socket.send(JSON.stringify({type: 'connection_init'})))
socket.addEventListener('error', (event) => {
  console.error(`socket error: ${String(event)}`)
  process.exit(1)
})
socket.addEventListener('close', (event) => {
  if (items.length === 0) console.error(`socket closed before any event (code ${event.code})`)
})
socket.addEventListener('message', (event) => {
  const frame = JSON.parse(String(event.data)) as {type: string; payload?: {data?: {dustGenerations?: Item}; errors?: unknown[]}}
  if (frame.type === 'connection_ack') {
    socket.send(
      JSON.stringify({
        id: '1',
        type: 'subscribe',
        payload: {query: QUERY, variables: {addr: dustAddress, start: 0, end: endIndex}},
      }),
    )
    return
  }
  if (frame.type === 'next') {
    // A GraphQL error arrives inside `next`, never as an `error` frame — a client that ignores this
    // reports a malformed query as "the address has nothing".
    if (frame.payload?.errors !== undefined) {
      console.error(`indexer error: ${JSON.stringify(frame.payload.errors)}`)
      process.exit(1)
    }
    const item = frame.payload?.data?.dustGenerations
    if (item !== undefined) {
      items.push(item)
      if (items.length <= 5 || item.__typename !== 'DustGenerationsItem') {
        console.log(`${item.__typename} ${JSON.stringify(item).slice(0, 160)}`)
      }
      deadline.refresh()
    }
    return
  }
  if (frame.type === 'complete') {
    console.log('\n(subscription complete)')
    finish()
  }
  if (frame.type === 'error') {
    console.error(`subscription error frame: ${JSON.stringify(frame.payload)}`)
    process.exit(1)
  }
})
