import {describe, expect, it} from 'vitest'

import {describeLedgerErrorCode, nameLedgerRejection} from './ledger-error-codes'

describe('describeLedgerErrorCode', () => {
  // Both were read off preprod by submitting a transaction whose verdict was known in advance
  // (`packages/midnight-native/rust/tests/dust_registration_error_codes.rs`), so they anchor the whole
  // table: a transcription slip that shifted it would break at least one of them.
  it('names the two codes verified against the live chain', () => {
    expect(describeLedgerErrorCode(166)).toBe('Malformed::InvalidNetworkId')
    expect(describeLedgerErrorCode(173)).toBe('Malformed::InsufficientDustForRegistrationFee')
  })

  it('names the codes this repo hit before the table existed', () => {
    expect(describeLedgerErrorCode(117)).toBe('Malformed::NotNormalized')
    expect(describeLedgerErrorCode(168)).toBe('Malformed::FeeCalculation')
    expect(describeLedgerErrorCode(192)).toBe('Malformed::InputsSignaturesLengthMismatch')
    expect(describeLedgerErrorCode(104)).toBe('Invalid::Transcript')
  })

  // The table is not variant order — nothing about the ledger crate's enums predicts it.
  it('is a lookup, not arithmetic over the ledger’s variant order', () => {
    expect(describeLedgerErrorCode(139)).toBe('Malformed::UnknownError')
    expect(describeLedgerErrorCode(140)).toBeNull()
  })

  it('returns null for a code this build has no entry for', () => {
    // Distinct from the node's own "unknown error" codes, which are named above.
    expect(describeLedgerErrorCode(45)).toBeNull()
    expect(describeLedgerErrorCode(254)).toBeNull()
  })
})

describe('nameLedgerRejection', () => {
  it('appends the name and keeps the raw code', () => {
    expect(
      nameLedgerRejection('author_submitExtrinsic was rejected: 1010 Invalid Transaction ("Custom error: 173")'),
    ).toBe(
      'author_submitExtrinsic was rejected: 1010 Invalid Transaction ("Custom error: 173") — Malformed::InsufficientDustForRegistrationFee',
    )
  })

  it('leaves a message with no custom error untouched', () => {
    expect(nameLedgerRejection('state_getRuntimeVersion was rejected: -32000 boom')).toBe(
      'state_getRuntimeVersion was rejected: -32000 boom',
    )
  })

  it('leaves a code it cannot name untouched rather than guessing', () => {
    expect(nameLedgerRejection('rejected: 1010 Invalid Transaction ("Custom error: 254")')).toBe(
      'rejected: 1010 Invalid Transaction ("Custom error: 254")',
    )
  })
})
