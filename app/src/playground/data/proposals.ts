/**
 * Fake governance proposal data for UI Playground.
 *
 * @module
 */

export type FakeProposal = {
  id: string
  title: string
  type: 'treasury' | 'parameter' | 'constitutional' | 'info'
  status: 'active' | 'passed' | 'rejected' | 'expired'
  yesVotes: number
  noVotes: number
  abstainVotes: number
  expiresAt: number
  createdAt: number
  description?: string
  url?: string
}

const now = Date.now()
const day = 24 * 60 * 60 * 1000

export const fakeProposals: FakeProposal[] = [
  {
    id: 'prop1',
    title: 'Treasury Withdrawal for Marketing Initiative',
    type: 'treasury',
    status: 'active',
    yesVotes: 2500000000,
    noVotes: 500000000,
    abstainVotes: 100000000,
    expiresAt: now + 7 * day,
    createdAt: now - 7 * day,
    description: 'Proposal to allocate 1M ADA from treasury for global marketing campaigns.',
    url: 'https://gov.tools/proposal/prop1',
  },
  {
    id: 'prop2',
    title: 'Increase Minimum Pool Cost',
    type: 'parameter',
    status: 'active',
    yesVotes: 1800000000,
    noVotes: 1200000000,
    abstainVotes: 300000000,
    expiresAt: now + 14 * day,
    createdAt: now - 3 * day,
    description: 'Proposal to increase the minimum pool cost from 340 to 500 ADA.',
  },
  {
    id: 'prop3',
    title: 'Constitutional Amendment: Voting Threshold',
    type: 'constitutional',
    status: 'passed',
    yesVotes: 5000000000,
    noVotes: 1000000000,
    abstainVotes: 500000000,
    expiresAt: now - 1 * day,
    createdAt: now - 30 * day,
  },
  {
    id: 'prop4',
    title: 'Community Survey: DeFi Priorities',
    type: 'info',
    status: 'expired',
    yesVotes: 800000000,
    noVotes: 200000000,
    abstainVotes: 1500000000,
    expiresAt: now - 10 * day,
    createdAt: now - 40 * day,
  },
]

export type FakeDRep = {
  id: string
  name: string
  drepId: string
  votingPower: string
  delegators: number
  status: 'active' | 'inactive' | 'retired'
  bio?: string
}

export const fakeDReps: FakeDRep[] = [
  {
    id: 'drep1',
    name: 'Example DRep',
    drepId: 'drep1qx2kd28nq8ac5prwg32hhvudlwggpgfp8utlyqxu6wqgz62f79q',
    votingPower: '50,000,000 ADA',
    delegators: 1234,
    status: 'active',
    bio: 'Example delegated representative supporting Cardano governance.',
  },
  {
    id: 'drep2',
    name: 'Community Voice',
    drepId: 'drep1abc123def456789',
    votingPower: '25,000,000 ADA',
    delegators: 567,
    status: 'active',
  },
  {
    id: 'drep3',
    name: 'Retired DRep',
    drepId: 'drep1xyz789retired',
    votingPower: '0 ADA',
    delegators: 0,
    status: 'retired',
  },
]
