import {
  SigningBroadcastError,
  SigningDeviceError,
  SigningPayloadError,
  SigningSequenceError,
  SigningWitnessError,
} from '@pnyx/signing-service'
import {describe, expect, it} from 'vitest'
import {ceremonyFailureReason, ceremonyFailureStage, plutusFailureReason, submitRejectionReason} from './submit-failure'

// The real rejection the node returned for a DUST registration whose Plutus witnesses
// were dropped — the case that motivated this module.
const NODE_REJECTION =
  'submit rejected (400): {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":' +
  '["ConwayUtxowFailure (MissingScriptWitnessesUTXOW (NonEmptySet (fromList [ScriptHash ' +
  '\\"73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5\\"])))"]}}}}'

/** The readable half of {@link NODE_REJECTION}: nested, so it is kept whole. */
const NODE_ERROR =
  'ConwayUtxowFailure (MissingScriptWitnessesUTXOW (NonEmptySet (fromList [ScriptHash ' +
  '"73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5"])))'

describe('ceremonyFailureReason', () => {
  it('reads the node rejection out of a multi-leg ceremony failure', () => {
    const error = new SigningSequenceError({
      completed: [],
      failedIndex: 0,
      failure: new SigningBroadcastError({reason: NODE_REJECTION}),
    })

    // The wrapper's own `message` is empty, which is what used to swallow this.
    expect(error.message).toBe('')
    // The node's own entry, not the `submit rejected (400): {…}` envelope it
    // travelled in — see `submitRejectionReason`.
    expect(ceremonyFailureReason(error)).toBe(NODE_ERROR)
  })

  it('reads a single-leg broadcast failure directly', () => {
    expect(ceremonyFailureReason(new SigningBroadcastError({reason: NODE_REJECTION}))).toBe(NODE_ERROR)
  })

  it('reports a witness-coverage gap, which carries no reason', () => {
    const error = new SigningSequenceError({
      completed: [],
      failedIndex: 1,
      failure: new SigningWitnessError({missingKeyHashes: ['aabb', 'ccdd']}),
    })

    expect(ceremonyFailureReason(error)).toBe('missing signatures: aabb, ccdd')
  })

  it('returns null rather than inventing text for an unrecognised failure', () => {
    expect(ceremonyFailureReason(new Error(''))).toBeNull()
    expect(ceremonyFailureReason('boom')).toBeNull()
    expect(ceremonyFailureReason(undefined)).toBeNull()
    expect(ceremonyFailureReason({})).toBeNull()
  })

  it('falls back to a plain error message', () => {
    expect(ceremonyFailureReason(new Error('network unreachable'))).toBe('network unreachable')
  })
})

describe('ceremonyFailureStage', () => {
  // The stage picks the sentence the review screen shows. Before it existed every
  // arm below rendered as "The network rejected this transaction", which named the
  // wrong actor for three of the four.
  it('names the broadcast when the node is what refused', () => {
    expect(ceremonyFailureStage(new SigningBroadcastError({reason: NODE_REJECTION}))).toBe('broadcast')
  })

  it('names the device when the app could not reach it', () => {
    // The real failure from the 2026-10-07 report: a BLE-paired Trezor the
    // reconnect had enumerated over USB, so nothing was ever submitted.
    const error = new SigningDeviceError({
      reason: 'Failed to create Trezor transport: No Trezor devices found. Make sure your device is connected.',
    })
    expect(ceremonyFailureStage(error)).toBe('device')
  })

  it('separates the user declining from the device failing', () => {
    const error = new SigningDeviceError({reason: 'rejected on device', userRejected: true})
    expect(ceremonyFailureStage(error)).toBe('declined')
  })

  it('separates a locked device from a device that failed', () => {
    // ⚠️ The 2026-10-08 Ledger report: the app detected the lock (`DeviceLockedError`) and the
    // user still read "Transaction failed", because a lock was just another device failure. It is
    // the one device failure they can clear in seconds, so it gets its own stage and sentence.
    const error = new SigningDeviceError({reason: 'the device is locked', deviceLocked: true})
    expect(ceremonyFailureStage(error)).toBe('locked')
  })

  it('reads a locked device through a multi-leg wrapper', () => {
    const error = new SigningSequenceError({
      completed: [],
      failedIndex: 0,
      failure: new SigningDeviceError({reason: 'the device is locked', deviceLocked: true}),
    })
    expect(ceremonyFailureStage(error)).toBe('locked')
  })

  it('reads the stage through a multi-leg wrapper', () => {
    // `SigningSequenceError` has no stage of its own; the leg that failed does.
    const error = new SigningSequenceError({
      completed: [],
      failedIndex: 1,
      failure: new SigningDeviceError({reason: 'device disconnected'}),
    })
    expect(ceremonyFailureStage(error)).toBe('device')
  })

  it('claims no stage for a failure it cannot place', () => {
    // Neutral wording beats attributing a failure to a step we did not confirm.
    expect(ceremonyFailureStage(new SigningPayloadError({reason: 'unreadable address'}))).toBe('other')
    expect(ceremonyFailureStage(new Error('boom'))).toBe('other')
    expect(ceremonyFailureStage(null)).toBe('other')
  })
})

describe('submitRejectionReason', () => {
  const REAL_400 =
    'submit rejected (400): {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayMempoolFailure \\"All inputs are spent. Transaction has probably already been included\\""],"kind":"ShelleyTxValidationError"},"tag":"TxValidationErrorInCardanoMode"},"tag":"TxCmdTxSubmitValidationError"},"tag":"TxSubmitFail"}'

  it('pulls out the sentence a person can act on', () => {
    // Verbatim from a preprod rejection. Shown raw, the toast truncated it
    // mid-token — technically the reason, and unreadable, which is the same as
    // having none.
    expect(submitRejectionReason(REAL_400)).toBe('All inputs are spent. Transaction has probably already been included')
  })

  it('finds the error however deeply the era nests it', () => {
    expect(submitRejectionReason('x: {"a":{"b":{"c":{"error":["Boom \\"it broke\\""]}}}}')).toBe('it broke')
  })

  it('keeps a bare constructor with no quoted text', () => {
    // The tag is then the whole message; dropping it would leave nothing.
    expect(submitRejectionReason('x: {"error":["ValueNotConservedUTxO"]}')).toBe('ValueNotConservedUTxO')
  })

  it('joins several failures rather than picking one', () => {
    expect(submitRejectionReason('x: {"error":["A \\"one\\"","B \\"two\\""]}')).toBe('one; two')
  })

  it('answers null for anything that is not a submit rejection', () => {
    // Never a guess: the caller keeps its own wording rather than showing junk.
    expect(submitRejectionReason('vault error')).toBeNull()
    expect(submitRejectionReason('submit rejected (400): not json {')).toBeNull()
    expect(submitRejectionReason('{"tag":"TxSubmitFail"}')).toBeNull()
  })

  it('is applied by ceremonyFailureReason, so callers get the sentence', () => {
    expect(ceremonyFailureReason({reason: REAL_400})).toBe(
      'All inputs are spent. Transaction has probably already been included',
    )
  })
})

// ⚠️ **A script failure is tens of kilobytes and every other rejection is a sentence.** The real one
// below arrived on mainnet 2026-08-28 carrying the whole base64 script, the whole TxInfo dump and the
// redeemer blob inside a single `error` string — and reached the review screen as one red line. That is
// the same defect this module exists for, one layer down.
describe('a Plutus script failure', () => {
  const plutus = (over: {hash?: string; info?: string; version?: string} = {}) =>
    [
      'ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True)',
      `(FailedUnexpectedly (PlutusFailure \\"\\nThe ${over.version ?? 'PlutusV3'} script failed:`,
      `\\nBase64-encoded script bytes:\\n\\\\"WQyEAQEAKYAKukq6${'A'.repeat(4000)}\\\\"`,
      `\\nThe script hash is:ScriptHash \\\\"${over.hash ?? '73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5'}\\\\"`,
      '\\nThe plutus evaluation error is: CekError An error has occurred:',
      "\\nThe machine terminated because of an error, either from a built-in function or from an explicit use of 'error'.",
      '\\nCaused by: error\\nThe protocol version is: Version 11',
      `\\nScriptInfo: ${over.info ?? 'SpendingScript'} (TxOutRef {txOutRefId = 8394018e, txOutRefIdx = 0})`,
      `\\nTxInfo:\\n  TxId: 448662eb\\n  Inputs: [ ${'x'.repeat(6000)} ]\\n\\" :| [])))))`,
    ].join('')

  it('condenses it to the script, the handler and the reason', () => {
    const entry = plutus()
    const out = plutusFailureReason(entry)
    expect(out).not.toBeNull()
    // The point of the exercise: two orders of magnitude, and nothing meaningful lost.
    expect(entry.length).toBeGreaterThan(10_000)
    expect((out as string).length).toBeLessThan(300)
    expect(out).toContain('PlutusV3 script 73e4aea31b5b…')
    expect(out).toContain('refused this spend')
    expect(out).toContain('The machine terminated because of an error')
  })

  it('drops the bulk and keeps nothing that had meaning', () => {
    const out = plutusFailureReason(plutus()) as string
    expect(out).not.toContain('WQyEAQEAKYAKukq6')
    expect(out).not.toContain('TxInfo')
    expect(out).not.toContain('Base64')
  })

  /**
   * ⚠️ **On a multi-purpose validator one script hash serves the mint and the spend**, so which handler
   * refused is the difference between two pieces of code. The hash alone says neither.
   */
  it('names which handler refused', () => {
    expect(plutusFailureReason(plutus({info: 'MintingScript'}))).toContain('refused this mint')
    expect(plutusFailureReason(plutus({info: 'RewardingScript'}))).toContain('refused this withdrawal')
    // An unknown purpose is not guessed at.
    expect(plutusFailureReason(plutus({info: 'SomethingNewScript'}))).toContain('refused this transaction')
  })

  // `Caused by: error` is the name of the builtin that raised, not a reason. Appending it produced
  // "caused by: error", which is worse than silence.
  it('never reports `Caused by: error` as the cause', () => {
    expect(plutusFailureReason(plutus())).not.toContain('Caused by: error')
  })

  it('reads as a rejection through the normal path too', () => {
    const raw = `submit rejected (400): {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["${plutus().replace(/"/g, '\\"')}"]}}}}`
    const reason = submitRejectionReason(raw)
    expect(reason === null || reason.includes('refused this spend')).toBe(true)
  })

  it('is null for anything that is not a script failure', () => {
    expect(plutusFailureReason('ConwayMempoolFailure "All inputs are spent."')).toBeNull()
  })
})
