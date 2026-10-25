import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  cardanoRailConfigFrom,
  getActiveCardanoNetwork,
  getCardanoRailConfig,
  onCardanoNetworkChange,
  setActiveCardanoNetwork,
} from './config'

describe('cardanoRailConfigFrom', () => {
  it('returns null without a configured endpoint (no public fallback)', () => {
    expect(cardanoRailConfigFrom({})).toBeNull()
    expect(cardanoRailConfigFrom({network: 'preprod'})).toBeNull()
    expect(cardanoRailConfigFrom({koiosUrl: '  '})).toBeNull()
  })

  it('builds mainnet config', () => {
    expect(cardanoRailConfigFrom({network: 'mainnet', koiosUrl: 'https://koios.internal/api/v1'})).toEqual({
      network: 'mainnet',
      koiosUrl: 'https://koios.internal/api/v1',
      networkId: 1,
      protocolMagic: 764824073,
    })
  })

  it('builds preprod/preview configs with their magics', () => {
    expect(cardanoRailConfigFrom({network: 'preprod', koiosUrl: 'https://k/api'})).toMatchObject({
      networkId: 0,
      protocolMagic: 1,
    })
    expect(cardanoRailConfigFrom({network: 'preview', koiosUrl: 'https://k/api'})).toMatchObject({
      networkId: 0,
      protocolMagic: 2,
    })
  })

  it('falls back to mainnet for unknown network values', () => {
    expect(cardanoRailConfigFrom({network: 'devnet', koiosUrl: 'https://k/api'})).toMatchObject({network: 'mainnet'})
  })
})

describe('the active network', () => {
  afterEach(() => {
    setActiveCardanoNetwork('mainnet')
  })

  it('starts on the build default', () => {
    expect(getActiveCardanoNetwork()).toBe('mainnet')
    expect(getCardanoRailConfig()).toMatchObject({network: 'mainnet', networkId: 1})
  })

  it('re-points the rail config, koios endpoint included', () => {
    setActiveCardanoNetwork('preview')

    expect(getActiveCardanoNetwork()).toBe('preview')
    expect(getCardanoRailConfig()).toMatchObject({
      network: 'preview',
      networkId: 0,
      protocolMagic: 2,
      koiosUrl: 'https://preview.koios.rest/api/v1',
    })
  })

  it('notifies listeners once per real change, not on a no-op set', () => {
    const listener = vi.fn()
    const unsubscribe = onCardanoNetworkChange(listener)

    setActiveCardanoNetwork('preprod')
    setActiveCardanoNetwork('preprod')
    expect(listener).toHaveBeenCalledTimes(1)

    setActiveCardanoNetwork('mainnet')
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    setActiveCardanoNetwork('preview')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
