import {describe, expect, it} from '@effect/vitest'
import {CARDANO_MAINNET, ETHEREUM_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import {
  COIN_TYPES,
  DERIVATION_CONFIGS,
  getChainFamily,
  getDerivationConfig,
  getDerivationPath,
} from './derivation-config.js'

describe('derivation-config', () => {
  describe('COIN_TYPES', () => {
    it('defines the registered Midnight coin type', () => {
      expect(COIN_TYPES.midnight).toBe(2400)
    })
  })

  describe('DERIVATION_CONFIGS', () => {
    it('midnight uses BIP-44 with purpose 44 and coin type 2400', () => {
      const config = DERIVATION_CONFIGS[MIDNIGHT_MAINNET]
      expect(config?.standard).toBe('bip44')
      expect(config?.purpose).toBe(44)
      expect(config?.coinType).toBe(2400)
      expect(config?.usesXPub).toBe(true)
      expect(config?.addressGapLimit).toBe(20)
    })

    it('cardano uses CIP-1852 at m/1852’/1815’', () => {
      const config = DERIVATION_CONFIGS[CARDANO_MAINNET]
      expect(config?.standard).toBe('cip1852')
      expect(config?.purpose).toBe(1852)
      expect(config?.coinType).toBe(1815)
      expect(config?.usesXPub).toBe(true)
    })
  })

  describe('getDerivationConfig', () => {
    it('returns config for midnight', () => {
      const config = getDerivationConfig(MIDNIGHT_MAINNET)
      expect(config.coinType).toBe(2400)
      expect(config.standard).toBe('bip44')
    })

    it('returns config for cardano', () => {
      const config = getDerivationConfig(CARDANO_MAINNET)
      expect(config.coinType).toBe(1815)
      expect(config.standard).toBe('cip1852')
    })

    it('throws for chains without a config', () => {
      expect(() => getDerivationConfig(ETHEREUM_MAINNET)).toThrow(/No derivation config/)
    })
  })

  describe('getDerivationPath', () => {
    it('generates correct BIP-44 path structure for midnight', () => {
      expect(getDerivationPath(MIDNIGHT_MAINNET, 0, false, 0)).toBe("m/44'/2400'/0'/0/0")
      expect(getDerivationPath(MIDNIGHT_MAINNET, 1, false, 0)).toBe("m/44'/2400'/1'/0/0")
      expect(getDerivationPath(MIDNIGHT_MAINNET, 0, true, 0)).toBe("m/44'/2400'/0'/1/0")
      expect(getDerivationPath(MIDNIGHT_MAINNET, 0, false, 5)).toBe("m/44'/2400'/0'/0/5")
    })

    it('generates correct CIP-1852 path structure for cardano', () => {
      expect(getDerivationPath(CARDANO_MAINNET, 0, false, 0)).toBe("m/1852'/1815'/0'/0/0")
      expect(getDerivationPath(CARDANO_MAINNET, 1, false, 0)).toBe("m/1852'/1815'/1'/0/0")
      expect(getDerivationPath(CARDANO_MAINNET, 0, true, 0)).toBe("m/1852'/1815'/0'/1/0")
    })
  })

  describe('getChainFamily', () => {
    it('categorizes supported chains correctly', () => {
      expect(getChainFamily(MIDNIGHT_MAINNET)).toBe('midnight')
      expect(getChainFamily(CARDANO_MAINNET)).toBe('cardano')
    })

    it('throws for unsupported chains', () => {
      expect(() => getChainFamily(ETHEREUM_MAINNET)).toThrow(/No chain family/)
    })
  })
})
