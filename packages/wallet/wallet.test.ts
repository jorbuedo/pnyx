/**
 * Integration tests for the wallet package.
 */

import {describe, expect, it} from '@effect/vitest'
import {
  AccountNotFoundError,
  AddressDiscoveryError,
  DerivationError,
  InsufficientFundsError,
  InvalidMnemonicError,
  SigningError,
  StorageError,
  SyncError,
  VerificationError,
  WalletCreationError,
  WalletError,
  WalletNotFoundError,
} from './errors.js'

describe('wallet package', () => {
  describe('error types', () => {
    it('WalletError has correct tag', () => {
      const error = new WalletError({message: 'test error'})
      expect(error._tag).toBe('WalletError')
      expect(error.message).toBe('test error')
    })

    it('WalletNotFoundError has correct tag', () => {
      const error = new WalletNotFoundError({groupId: 'test-id'})
      expect(error._tag).toBe('WalletNotFoundError')
      expect(error.groupId).toBe('test-id')
    })

    it('AccountNotFoundError has correct tag', () => {
      const error = new AccountNotFoundError({accountId: 'acc-id'})
      expect(error._tag).toBe('AccountNotFoundError')
      expect(error.accountId).toBe('acc-id')
    })

    it('WalletCreationError has correct tag', () => {
      const error = new WalletCreationError({message: 'creation failed'})
      expect(error._tag).toBe('WalletCreationError')
    })

    it('InsufficientFundsError has correct tag', () => {
      const error = new InsufficientFundsError({required: 1000n, available: 500n})
      expect(error._tag).toBe('InsufficientFundsError')
      expect(error.required).toBe(1000n)
      expect(error.available).toBe(500n)
    })

    it('DerivationError has correct tag', () => {
      const error = new DerivationError({message: 'derivation failed', path: 'm/1852/1815/0'})
      expect(error._tag).toBe('DerivationError')
      expect(error.path).toBe('m/1852/1815/0')
    })

    it('SyncError has correct tag', () => {
      const error = new SyncError({message: 'sync failed'})
      expect(error._tag).toBe('SyncError')
    })

    it('StorageError has correct tag', () => {
      const error = new StorageError({message: 'storage failed'})
      expect(error._tag).toBe('StorageError')
    })

    it('SigningError has correct tag', () => {
      const error = new SigningError({message: 'signing failed'})
      expect(error._tag).toBe('SigningError')
    })

    it('VerificationError has correct tag', () => {
      const error = new VerificationError({message: 'verification failed'})
      expect(error._tag).toBe('VerificationError')
    })

    it('AddressDiscoveryError has correct tag', () => {
      const error = new AddressDiscoveryError({message: 'discovery failed'})
      expect(error._tag).toBe('AddressDiscoveryError')
      expect(error.message).toBe('discovery failed')
    })

    it('InvalidMnemonicError has correct tag', () => {
      const error = new InvalidMnemonicError({message: 'invalid mnemonic'})
      expect(error._tag).toBe('InvalidMnemonicError')
      expect(error.message).toBe('invalid mnemonic')
    })
  })
})
