import {describe, expect, it} from 'vitest'
import {
  buildExplorerUrl,
  DEFAULT_EXPLORER_ID,
  EXPLORER_CONFIGS,
  EXPLORER_IDS,
  type ExplorerNetwork,
  type ExplorerUrlType,
  getExplorerDomain,
  getExplorerName,
  getNetworkBaseUrl,
  getTokenIdForm,
  parseExplorerId,
} from './explorerConfig'

const ALL_TYPES: readonly ExplorerUrlType[] = ['tx', 'address', 'stake', 'pool', 'token', 'drep', 'block']
const ALL_NETWORKS: readonly ExplorerNetwork[] = ['mainnet', 'preprod', 'preview']

describe('explorer registry', () => {
  it('lists every configured explorer in picker order', () => {
    expect(EXPLORER_IDS).toEqual(['cardanoscan', 'cexplorer', 'adastat'])
    expect(Object.keys(EXPLORER_CONFIGS).sort()).toEqual([...EXPLORER_IDS].sort())
  })

  it('defaults to an explorer that is actually in the registry', () => {
    expect(EXPLORER_IDS).toContain(DEFAULT_EXPLORER_ID)
  })

  it('covers every link type on every explorer, so no preference breaks a link', () => {
    for (const id of EXPLORER_IDS) {
      for (const type of ALL_TYPES) {
        expect(EXPLORER_CONFIGS[id].paths[type], `${id}.${type}`).toMatch(/^\/.+\/$/)
      }
    }
  })

  it('names and domains read as the sites brand themselves', () => {
    expect(getExplorerName('cardanoscan')).toBe('Cardanoscan')
    expect(getExplorerName('cexplorer')).toBe('Cexplorer')
    expect(getExplorerName('adastat')).toBe('AdaStat')
    expect(getExplorerDomain('cardanoscan')).toBe('cardanoscan.io')
    expect(getExplorerDomain('cexplorer')).toBe('cexplorer.io')
    expect(getExplorerDomain('adastat')).toBe('adastat.net')
  })
})

describe('parseExplorerId', () => {
  it('accepts known ids', () => {
    expect(parseExplorerId('adastat')).toBe('adastat')
  })

  it('rejects anything else rather than inventing a default', () => {
    expect(parseExplorerId('blockchair')).toBeNull()
    expect(parseExplorerId('')).toBeNull()
    expect(parseExplorerId(null)).toBeNull()
    expect(parseExplorerId(undefined)).toBeNull()
  })
})

describe('getNetworkBaseUrl', () => {
  it('leaves mainnet alone', () => {
    expect(getNetworkBaseUrl('cardanoscan', 'mainnet')).toBe('https://cardanoscan.io')
    expect(getNetworkBaseUrl('adastat', 'mainnet')).toBe('https://adastat.net')
  })

  it('puts testnets on a subdomain', () => {
    expect(getNetworkBaseUrl('cardanoscan', 'preprod')).toBe('https://preprod.cardanoscan.io')
    expect(getNetworkBaseUrl('cexplorer', 'preview')).toBe('https://preview.cexplorer.io')
    expect(getNetworkBaseUrl('adastat', 'preprod')).toBe('https://preprod.adastat.net')
    expect(getNetworkBaseUrl('adastat', 'preview')).toBe('https://preview.adastat.net')
  })
})

describe('buildExplorerUrl', () => {
  // The paths differ per site and were verified against each explorer with real
  // ids — these expectations are the record of that, so a "tidy-up" that makes
  // them uniform fails here instead of shipping dead links.
  it('builds Cardanoscan paths', () => {
    const build = (type: ExplorerUrlType, value: string) => buildExplorerUrl('cardanoscan', type, value, 'mainnet')
    expect(build('tx', 'abc')).toBe('https://cardanoscan.io/transaction/abc')
    expect(build('address', 'addr1xyz')).toBe('https://cardanoscan.io/address/addr1xyz')
    expect(build('stake', 'stake1xyz')).toBe('https://cardanoscan.io/stakeKey/stake1xyz')
    expect(build('pool', 'pool1abc')).toBe('https://cardanoscan.io/pool/pool1abc')
    expect(build('token', 'asset1abc')).toBe('https://cardanoscan.io/token/asset1abc')
    expect(build('drep', 'drep1abc')).toBe('https://cardanoscan.io/drep/drep1abc')
    expect(build('block', '42')).toBe('https://cardanoscan.io/block/42')
  })

  it('builds Cexplorer paths', () => {
    const build = (type: ExplorerUrlType, value: string) => buildExplorerUrl('cexplorer', type, value, 'mainnet')
    expect(build('tx', 'abc')).toBe('https://cexplorer.io/tx/abc')
    expect(build('address', 'addr1xyz')).toBe('https://cexplorer.io/address/addr1xyz')
    expect(build('stake', 'stake1xyz')).toBe('https://cexplorer.io/stake/stake1xyz')
    expect(build('pool', 'pool1abc')).toBe('https://cexplorer.io/pool/pool1abc')
    expect(build('token', 'asset1abc')).toBe('https://cexplorer.io/asset/asset1abc')
    expect(build('drep', 'drep1abc')).toBe('https://cexplorer.io/drep/drep1abc')
    expect(build('block', '42')).toBe('https://cexplorer.io/block/42')
  })

  it('builds AdaStat paths — plural segments, stake served from /addresses/', () => {
    const build = (type: ExplorerUrlType, value: string) => buildExplorerUrl('adastat', type, value, 'mainnet')
    expect(build('tx', 'abc')).toBe('https://adastat.net/transactions/abc')
    expect(build('address', 'addr1xyz')).toBe('https://adastat.net/addresses/addr1xyz')
    expect(build('stake', 'stake1xyz')).toBe('https://adastat.net/addresses/stake1xyz')
    expect(build('pool', 'pool1abc')).toBe('https://adastat.net/pools/pool1abc')
    expect(build('token', 'asset1abc')).toBe('https://adastat.net/tokens/asset1abc')
    expect(build('drep', 'drep1abc')).toBe('https://adastat.net/dreps/drep1abc')
    expect(build('block', '42')).toBe('https://adastat.net/blocks/42')
  })

  it('uses each explorer’s canonical token-id form', () => {
    // Verified by hand 2026-07-26 (bot protection makes it unautomatable): all three
    // accept BOTH the CIP-14 fingerprint and the policyId+assetNameHex unit, so the
    // form only decides whether we land on the canonical URL or get redirected.
    // Cexplorer canonicalises to the fingerprint, AdaStat to the unit, Cardanoscan
    // serves both without redirecting.
    expect(getTokenIdForm('cardanoscan')).toBe('fingerprint')
    expect(getTokenIdForm('cexplorer')).toBe('fingerprint')
    expect(getTokenIdForm('adastat')).toBe('unit')
  })

  it('carries the network subdomain into the built URL', () => {
    expect(buildExplorerUrl('cardanoscan', 'tx', 'abc', 'preprod')).toBe(
      'https://preprod.cardanoscan.io/transaction/abc',
    )
    expect(buildExplorerUrl('adastat', 'drep', 'drep1abc', 'preview')).toBe(
      'https://preview.adastat.net/dreps/drep1abc',
    )
  })

  it('produces an https URL containing the value for every combination', () => {
    for (const id of EXPLORER_IDS) {
      for (const type of ALL_TYPES) {
        for (const network of ALL_NETWORKS) {
          const url = buildExplorerUrl(id, type, 'VALUE', network)
          expect(url, `${id}/${type}/${network}`).toMatch(/^https:\/\/[^/]+\/.+\/VALUE$/)
        }
      }
    }
  })
})
