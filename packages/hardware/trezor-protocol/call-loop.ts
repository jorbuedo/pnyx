/**
 * Call loop: core call orchestration that handles device UI interrupts.
 *
 * Implements the typedCall pattern from @trezor/connect: sends a protobuf
 * message and loops on device interrupts (ButtonRequest, PinMatrixRequest,
 * PassphraseRequest) until the actual response arrives.
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'
import type {MessageResponse} from './protobuf'

const logger = getLogger('hardware')

// --- Result types ---

type Success<T> = {readonly success: true; readonly payload: T}
type ErrorResult = {readonly success: false; readonly error: string; readonly message?: string | undefined}
type Result<T> = Success<T> | ErrorResult

const ok = <T>(payload: T): Success<T> => ({success: true, payload})
const fail = (err: string, message?: string): ErrorResult => ({success: false, error: err, message})

// --- Callback types ---

/**
 * Callbacks for device UI events.
 */
export type DeviceCallbacks = {
  /** Called when device requests PIN entry. Return the PIN string, or throw to cancel. */
  readonly onPinRequest?: ((type?: string) => Promise<string>) | undefined
  /** Called when PIN entry was invalid. */
  readonly onInvalidPin?: (() => void) | undefined
  /** Called when device requests a passphrase. Return value + optional on-device flag. */
  readonly onPassphraseRequest?: (() => Promise<{value: string; passphraseOnDevice?: boolean}>) | undefined
  /** Called when device requests a button confirmation (informational). */
  readonly onButtonRequest?: ((code: string) => void) | undefined
  /** Called when device requests a word during recovery. Return the word string, or throw to cancel. */
  readonly onWordRequest?: ((type?: string) => Promise<string>) | undefined
}

// --- Transport call function type ---

/**
 * Low-level transport call function.
 * Sends a named protobuf message and returns the decoded response.
 * When `receiveOnly` is true, skips sending and only reads the next message.
 */
export type TransportCall = (
  name: string,
  data: Record<string, unknown>,
  options?: {timeout?: number | undefined; signal?: AbortSignal | undefined; receiveOnly?: boolean | undefined},
) => Promise<Result<MessageResponse>>

// --- Call loop ---

/**
 * Sends a protobuf message and handles device UI interrupts in a loop.
 *
 * The loop continues until either:
 * - A response matching one of `expectedTypes` arrives → returns success
 * - A `Failure` message arrives → returns error
 * - The call is aborted via signal → returns error
 *
 * Device interrupts handled:
 * - `ButtonRequest` → notifies callback, sends `ButtonAck`, continues
 * - `PinMatrixRequest` → invokes callback for PIN, sends `PinMatrixAck`, continues
 * - `PassphraseRequest` → invokes callback for passphrase, sends `PassphraseAck`, continues
 * - `WordRequest` → invokes callback for word during recovery, sends `WordAck`, continues
 */
export const typedCall = async (
  transport: TransportCall,
  messageName: string,
  expectedTypes: string | readonly string[],
  data: Record<string, unknown> = {},
  callbacks?: DeviceCallbacks,
  signal?: AbortSignal,
): Promise<Result<MessageResponse>> => {
  const expected = typeof expectedTypes === 'string' ? [expectedTypes] : expectedTypes

  let name = messageName
  let payload = data
  // Track stale messages discarded to prevent infinite loops
  let staleDiscardCount = 0
  const MAX_STALE_DISCARD = 3

  while (true) {
    if (signal?.aborted) {
      return fail('Aborted by signal')
    }

    const response = await transport(name, payload, {signal})
    if (!response.success) return response

    const {type, message} = response.payload

    switch (type) {
      case 'Failure': {
        const code = (message.code as string) ?? 'Failure_UnknownCode'
        const errorMessage =
          (message.message as string) ||
          // NOT "installation failed": the firmware raises this generically, and it is what a THP
          // pairing rejection arrives as. Saying "installation" sent a whole debugging session
          // looking at firmware versions instead of at the pairing exchange.
          (code === 'Failure_FirmwareError' ? 'Device firmware reported an internal error' : undefined) ||
          (code === 'Failure_ActionCancelled' ? 'Action cancelled by user' : undefined) ||
          (code === 'Failure_InvalidProtocol'
            ? 'Device requires THP (Trezor Host Protocol). Safe 7 devices need encrypted communication which is not yet supported.'
            : undefined) ||
          `Unknown failure (code=${code})`

        return fail(code, errorMessage)
      }

      case 'ButtonRequest': {
        const code = (message.code as string) ?? 'ButtonRequest_Other'

        // Notify the UI
        if (code === 'ButtonRequest_PassphraseEntry') {
          // Informational — passphrase entry is on device
        } else {
          callbacks?.onButtonRequest?.(code)
        }

        // Loop back with ButtonAck
        name = 'ButtonAck'
        payload = {}
        break
      }

      case 'PinMatrixRequest': {
        if (!callbacks?.onPinRequest) {
          // No PIN callback — cancel the operation
          await transport('Cancel', {})
          return fail('Failure_PinCancelled', 'PIN entry not available')
        }

        try {
          const pin = await callbacks.onPinRequest(message.type as string | undefined)
          name = 'PinMatrixAck'
          payload = {pin}
        } catch (e: unknown) {
          // A rejection here is how a cancel is signalled — but a callback that threw for any
          // other reason is reported to the user as their own cancellation.
          logger.debug('PIN request rejected; treating it as a user cancellation', {
            origin: 'trezor/call-loop',
            error: String(e),
          })
          await transport('Cancel', {})
          return fail('Failure_PinCancelled', 'PIN entry cancelled by user')
        }
        break
      }

      case 'PassphraseRequest': {
        if (!callbacks?.onPassphraseRequest) {
          // No passphrase callback — send empty passphrase
          name = 'PassphraseAck'
          payload = {passphrase: ''}
          break
        }

        try {
          const result = await callbacks.onPassphraseRequest()
          if (result.passphraseOnDevice) {
            name = 'PassphraseAck'
            payload = {on_device: true}
          } else {
            name = 'PassphraseAck'
            // Normalize unicode per Trezor spec (NFKD)
            payload = {passphrase: result.value.normalize('NFKD')}
          }
        } catch (e: unknown) {
          logger.debug('Passphrase request rejected; treating it as a user cancellation', {
            origin: 'trezor/call-loop',
            error: String(e),
          })
          await transport('Cancel', {})
          return fail('Failure_ActionCancelled', 'Passphrase entry cancelled by user')
        }
        break
      }

      case 'WordRequest': {
        if (!callbacks?.onWordRequest) {
          // No word callback — cancel the operation
          await transport('Cancel', {})
          return fail('Failure_ActionCancelled', 'Word entry not available')
        }

        try {
          const word = await callbacks.onWordRequest(message.type as string | undefined)
          name = 'WordAck'
          payload = {word}
        } catch (e: unknown) {
          logger.debug('Word request rejected; treating it as a user cancellation', {
            origin: 'trezor/call-loop',
            error: String(e),
          })
          await transport('Cancel', {})
          return fail('Failure_ActionCancelled', 'Word entry cancelled by user')
        }
        break
      }

      case 'Deprecated_PassphraseStateRequest': {
        // Legacy compatibility — just ack and continue
        name = 'Deprecated_PassphraseStateAck'
        payload = {}
        break
      }

      default: {
        // Check if this is the expected response type
        if (expected.includes(type)) {
          return ok(response.payload)
        }

        // Stale message from a previous session (e.g. CardanoPublicKey left in the
        // USB buffer after a disconnection during key derivation). Discard it and
        // re-read the actual response without re-sending the original message.
        // Use receiveOnly reads to drain stale data without generating new responses.
        while (staleDiscardCount < MAX_STALE_DISCARD) {
          staleDiscardCount++
          const reread = await transport(messageName, data, {signal, receiveOnly: true})
          if (!reread.success) return reread
          if (expected.includes(reread.payload.type)) {
            return ok(reread.payload)
          }
          // Got another unexpected message — discard and try again
        }

        // Too many unexpected messages — fail
        return fail(
          'Failure_UnexpectedMessage',
          `Response of unexpected type: ${type}. Expected: ${expected.join(', ')}`,
        )
      }
    }
  }
}

// --- Multi-step exchange helpers ---

/**
 * Sends a sequence of messages, each expecting a specific ack type.
 * Used for Cardano multi-step signing protocol.
 */
export const sendSequence = async (
  transport: TransportCall,
  steps: ReadonlyArray<{name: string; data: Record<string, unknown>; expectedType: string}>,
  callbacks?: DeviceCallbacks,
  signal?: AbortSignal,
): Promise<Result<MessageResponse>> => {
  let lastResponse: Result<MessageResponse> | undefined

  for (const step of steps) {
    const response = await typedCall(transport, step.name, step.expectedType, step.data, callbacks, signal)
    if (!response.success) return response
    lastResponse = response
  }

  return lastResponse ?? fail('Failure_UnexpectedMessage', 'Empty sequence')
}
