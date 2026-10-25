/**
 * The per-network endpoint table, and that an unknown network yields nothing rather than a neighbour.
 */

import {describe, expect, it} from 'vitest'
import {
  knownMidnightNetworks,
  midnightFaucetFor,
  midnightFundsNetwork,
  midnightIndexerFor,
  midnightNodeFor,
} from './networks'

describe('midnightIndexerFor', () => {
  it('resolves the official rails', () => {
    // Not Midnight's own: theirs was decommissioned on 2026-09-30 and the name does not resolve.
    // This is the indexer we run (`infra/midnight-public/`), reached through a Cloudflare Tunnel.
    expect(midnightIndexerFor('mainnet')).toBe('https://midnight-mainnet.pxkq.uk/api/v4/graphql')
    expect(midnightIndexerFor('preprod')).toBe('https://indexer.preprod.midnight.network/api/v4/graphql')
    expect(midnightIndexerFor('preview')).toBe('https://indexer.preview.midnight.network/api/v4/graphql')
  })

  it('points the local chain at the standalone stack', () => {
    expect(midnightIndexerFor('undeployed')).toBe('http://127.0.0.1:8088/api/v4/graphql')
  })

  // Substituting a neighbour's endpoint would read another chain's state as this one's — every
  // identity lookup would report a real peer as unpublished. A build with no declared network is the
  // same case: nothing to derive from.
  it.each([[null], ['testnet'], ['devnet'], ['']])('reports no endpoint for %s', (network) => {
    expect(midnightIndexerFor(network)).toBeNull()
  })

  // Each network's indexer must be that network's: a mainnet indexer holds no action for a preprod
  // contract, so a swap makes every lookup report "unreachable" instead of failing loudly.
  it('never maps two networks to the same endpoint', () => {
    const urls = knownMidnightNetworks().map((n) => midnightIndexerFor(n))
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('midnightNodeFor', () => {
  it('resolves the official rails', () => {
    expect(midnightNodeFor('mainnet')).toBe('https://rpc.mainnet.midnight.network')
    expect(midnightNodeFor('preprod')).toBe('https://rpc.preprod.midnight.network')
    expect(midnightNodeFor('preview')).toBe('https://rpc.preview.midnight.network')
  })

  it('points the local chain at the standalone stack', () => {
    expect(midnightNodeFor('undeployed')).toBe('http://127.0.0.1:9944')
  })

  it.each([[null], ['testnet'], ['devnet'], ['']])('reports no node for %s', (network) => {
    expect(midnightNodeFor(network)).toBeNull()
  })

  // A sealed transaction is submitted to whichever node this resolves, so two networks sharing one
  // would submit one chain's transaction to another — which the ledger rejects opaquely.
  it('never maps two networks to the same node', () => {
    const urls = knownMidnightNetworks().map((n) => midnightNodeFor(n))
    expect(new Set(urls).size).toBe(urls.length)
  })

  // The tables are separate and could drift apart silently; every network with an indexer needs a
  // node, or the DUST rail works on a network the send rail cannot submit on.
  it('covers every network the indexer table knows', () => {
    for (const network of knownMidnightNetworks()) {
      expect(midnightNodeFor(network)).not.toBeNull()
    }
  })
})

describe('midnightFundsNetwork', () => {
  it('maps the app networks we have endpoints for', () => {
    expect(midnightFundsNetwork('mainnet')).toBe('mainnet')
    expect(midnightFundsNetwork('preprod')).toBe('preprod')
    expect(midnightFundsNetwork('preview')).toBe('preview')
  })

  it('returns null for a network with no Midnight endpoint, rather than a neighbour', () => {
    // Substituting one would read another chain's state as this one's — the same refusal
    // `midnightIndexerFor` makes.
    expect(midnightFundsNetwork(null)).toBeNull()
    expect(midnightFundsNetwork('sancho')).toBeNull()
  })

  // The bridge pairs Cardano preprod with Midnight preview; this function does not, and must not start
  // to. Making them agree would point the preprod selector position at a chain none of the deployed
  // identity, handle or DUST state exists on.
  it('does not follow the USDM bridge pairing', () => {
    expect(midnightFundsNetwork('preprod')).not.toBe('preview')
  })

  // Whatever this resolves has to be a network the tables can actually serve, or the funds rail
  // selects a chain with no indexer and no node.
  it('only ever names a network the endpoint tables know', () => {
    for (const app of ['mainnet', 'preprod', 'preview']) {
      const funds = midnightFundsNetwork(app)
      expect(midnightIndexerFor(funds)).not.toBeNull()
      expect(midnightNodeFor(funds)).not.toBeNull()
    }
  })
})

describe('midnightFaucetFor', () => {
  it('resolves the approved faucet for each test network', () => {
    expect(midnightFaucetFor('preprod')).toBe('https://faucet.preprod.midnight.network/')
    expect(midnightFaucetFor('preview')).toBe('https://faucet.preview.midnight.network/')
  })

  // A faucet button on mainnet would lead somewhere that cannot fund the address it was handed;
  // `undeployed`'s genesis wallet is pre-funded and needs none.
  it.each([['mainnet'], ['undeployed'], [null], ['sancho']])('offers no faucet for %s', (network) => {
    expect(midnightFaucetFor(network)).toBeNull()
  })

  // Two networks sharing a faucet would fund an address on the wrong chain, silently.
  it('never maps two networks to the same faucet', () => {
    const urls = ['preprod', 'preview'].map((n) => midnightFaucetFor(n))
    expect(new Set(urls).size).toBe(urls.length)
  })
})
