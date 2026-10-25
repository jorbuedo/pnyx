/**
 * Fake staking pool data for UI Playground.
 *
 * @module
 */

export type FakePool = {
  id: string
  poolId: string
  name: string
  ticker: string
  saturation: number
  margin: number
  fixedCost: string
  pledge: string
  activeStake: string
  liveStake: string
  blocksMinted: number
  delegators: number
  homepage?: string
  description?: string
}

export const fakePools: FakePool[] = [
  {
    id: 'pool1',
    poolId: 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy',
    name: 'Example Stake Pool',
    ticker: 'EMUR1',
    saturation: 45,
    margin: 2.0,
    fixedCost: '340 ADA',
    pledge: '1,000,000 ADA',
    activeStake: '45,000,000 ADA',
    liveStake: '46,500,000 ADA',
    blocksMinted: 1234,
    delegators: 5678,
    homepage: 'https://pnyx.pxkq.uk',
    description: 'Example stake pool supporting Cardano development.',
  },
  {
    id: 'pool2',
    poolId: 'pool1abc123def456789xyz',
    name: 'Cardano Foundation',
    ticker: 'CF1',
    saturation: 78,
    margin: 1.5,
    fixedCost: '340 ADA',
    pledge: '500,000 ADA',
    activeStake: '78,000,000 ADA',
    liveStake: '79,200,000 ADA',
    blocksMinted: 2345,
    delegators: 12345,
  },
  {
    id: 'pool3',
    poolId: 'pool1xyz789abc123def',
    name: 'Community Pool',
    ticker: 'COMM',
    saturation: 95,
    margin: 3.0,
    fixedCost: '340 ADA',
    pledge: '100,000 ADA',
    activeStake: '95,000,000 ADA',
    liveStake: '96,000,000 ADA',
    blocksMinted: 3456,
    delegators: 8901,
    description: 'A community-run pool with focus on decentralization.',
  },
]

export const fakeStakingInfo = {
  stakedAmount: '10,000.00 ADA',
  rewards: '125.50 ADA',
  pool: fakePools[0],
  epoch: 456,
  nextRewardEpoch: 458,
}
