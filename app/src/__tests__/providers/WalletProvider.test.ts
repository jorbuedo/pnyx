/**
 * Unit tests for wallet error types used by WalletProvider.
 *
 * Verifies that typed errors from @pnyx/wallet are compatible with
 * the standard Error interface and carry correct metadata.
 *
 * @module
 */

import {InvalidMnemonicError, SigningError, TransactionParseError, WalletError, WalletNotFoundError} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'

describe('Wallet error types', () => {
  describe('WalletError', () => {
    it('is an instance of Error', () => {
      const error = new WalletError({message: 'test error'})
      expect(error).toBeInstanceOf(Error)
    })

    it('has correct message', () => {
      const error = new WalletError({message: 'Wallet service not initialized'})
      expect(error.message).toBe('Wallet service not initialized')
    })

    it('has correct _tag', () => {
      const error = new WalletError({message: 'test'})
      expect(error._tag).toBe('WalletError')
    })

    it('preserves cause when provided', () => {
      const cause = new Error('root cause')
      const error = new WalletError({message: 'wrapped', cause})
      expect(error.cause).toBe(cause)
    })
  })

  describe('WalletNotFoundError', () => {
    it('is an instance of Error', () => {
      const error = new WalletNotFoundError({groupId: 'test-id'})
      expect(error).toBeInstanceOf(Error)
    })

    it('has correct groupId', () => {
      const error = new WalletNotFoundError({groupId: 'none'})
      expect(error.groupId).toBe('none')
    })

    it('has correct _tag', () => {
      const error = new WalletNotFoundError({groupId: 'test'})
      expect(error._tag).toBe('WalletNotFoundError')
    })
  })

  describe('InvalidMnemonicError', () => {
    it('is an instance of Error', () => {
      const error = new InvalidMnemonicError({message: 'bad mnemonic'})
      expect(error).toBeInstanceOf(Error)
    })

    it('has correct message', () => {
      const error = new InvalidMnemonicError({message: 'Invalid password or mnemonic not found'})
      expect(error.message).toBe('Invalid password or mnemonic not found')
    })

    it('has correct _tag', () => {
      const error = new InvalidMnemonicError({message: 'test'})
      expect(error._tag).toBe('InvalidMnemonicError')
    })
  })

  describe('TransactionParseError', () => {
    it('is an instance of Error', () => {
      const error = new TransactionParseError({message: 'bad CBOR'})
      expect(error).toBeInstanceOf(Error)
    })

    it('has correct message', () => {
      const error = new TransactionParseError({message: 'Failed to parse transaction body from CBOR'})
      expect(error.message).toBe('Failed to parse transaction body from CBOR')
    })

    it('has correct _tag', () => {
      const error = new TransactionParseError({message: 'test'})
      expect(error._tag).toBe('TransactionParseError')
    })
  })

  describe('SigningError', () => {
    it('is an instance of Error', () => {
      const error = new SigningError({message: 'signing failed'})
      expect(error).toBeInstanceOf(Error)
    })

    it('has correct message', () => {
      const error = new SigningError({message: 'Password is required for software wallet signing'})
      expect(error.message).toBe('Password is required for software wallet signing')
    })

    it('has correct _tag', () => {
      const error = new SigningError({message: 'test'})
      expect(error._tag).toBe('SigningError')
    })
  })

  describe('Error compatibility', () => {
    it('WalletError can be caught as Error', () => {
      try {
        throw new WalletError({message: 'test'})
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).message).toBe('test')
      }
    })

    it('WalletNotFoundError message is accessible via Error interface', () => {
      try {
        throw new WalletNotFoundError({groupId: 'abc'})
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
      }
    })

    it('typed errors can be distinguished by _tag', () => {
      const errors = [
        new WalletError({message: 'a'}),
        new WalletNotFoundError({groupId: 'b'}),
        new InvalidMnemonicError({message: 'c'}),
        new TransactionParseError({message: 'd'}),
        new SigningError({message: 'e'}),
      ]

      const tags = errors.map((e) => e._tag)
      expect(tags).toEqual([
        'WalletError',
        'WalletNotFoundError',
        'InvalidMnemonicError',
        'TransactionParseError',
        'SigningError',
      ])
    })
  })
})
