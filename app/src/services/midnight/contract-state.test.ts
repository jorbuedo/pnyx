import {afterEach, describe, expect, it, vi} from 'vitest'
import {fetchContractStateByAddress, fetchTransactionHeight} from './contract-state'

vi.mock('../../logger', () => ({logger: {debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn()}}))

const ADDRESS = 'aa'.repeat(32)

/**
 * The request bodies asserted here were replayed verbatim against
 * `indexer.preprod.midnight.network` while this was written: the offset form returns the
 * `ContractDeploy` at that height where the plain form returns the latest `ContractCall`. Pinning the
 * shape locally is what stops that drifting without anyone noticing, since a silently-ignored offset
 * reads as "the electorate has not changed" rather than as an error.
 */
const captureBody = (reply: unknown) => {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: {body: string}) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return {ok: true, json: async () => reply} as unknown as Response
    }),
  )
  return bodies
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const stateReply = {data: {contractAction: {state: 'ab', transaction: {block: {height: 7}}}}}

describe('fetchContractStateByAddress', () => {
  it('omits the offset entirely when no point in time is asked for', async () => {
    const bodies = captureBody(stateReply)
    await fetchContractStateByAddress(ADDRESS, 'preprod')
    expect(bodies[0]?.variables).toEqual({address: ADDRESS})
  })

  it('sends a blockOffset for a height', async () => {
    const bodies = captureBody(stateReply)
    await fetchContractStateByAddress(ADDRESS, 'preprod', {height: 2534090})
    expect(bodies[0]?.variables).toEqual({address: ADDRESS, offset: {blockOffset: {height: 2534090}}})
  })

  it('sends a transactionOffset for a transaction hash', async () => {
    const bodies = captureBody(stateReply)
    await fetchContractStateByAddress(ADDRESS, 'preprod', {txHash: 'bb'.repeat(32)})
    expect(bodies[0]?.variables).toEqual({address: ADDRESS, offset: {transactionOffset: {hash: 'bb'.repeat(32)}}})
  })

  it('declares the offset variable so the indexer accepts it', async () => {
    const bodies = captureBody(stateReply)
    await fetchContractStateByAddress(ADDRESS, 'preprod', {height: 1})
    expect(bodies[0]?.query).toContain('$offset: ContractActionOffset')
    expect(bodies[0]?.query).toContain('contractAction(address: $address, offset: $offset)')
  })

  it('reads the state the offset returned, not the latest', async () => {
    captureBody(stateReply)
    const snapshot = await fetchContractStateByAddress(ADDRESS, 'preprod', {height: 2534090})
    expect(snapshot).toEqual({state: new Uint8Array([0xab]), height: 7})
  })
})

describe('fetchTransactionHeight', () => {
  it('resolves a transaction to the block it landed in', async () => {
    captureBody({data: {transactions: [{block: {height: 2534090}}]}})
    await expect(fetchTransactionHeight('cc'.repeat(32), 'preprod')).resolves.toBe(2534090)
  })

  it('is null for a transaction the indexer does not know', async () => {
    captureBody({data: {transactions: []}})
    await expect(fetchTransactionHeight('dd'.repeat(32), 'preprod')).resolves.toBeNull()
  })

  it('is null rather than throwing when the indexer refuses', async () => {
    captureBody({errors: [{message: 'nope'}]})
    await expect(fetchTransactionHeight('ee'.repeat(32), 'preprod')).resolves.toBeNull()
  })
})
