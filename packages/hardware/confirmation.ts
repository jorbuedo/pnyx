/**
 * User confirmation flow for hardware wallet operations.
 *
 * Provides state tracking and callback hooks for UI feedback during
 * hardware wallet operations that require user confirmation on device.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type {HardwareErrorType} from './types'

// ============================================================================
// Types
// ============================================================================

/**
 * Typed message keys for confirmation state.
 *
 * These keys are set by the service layer and mapped to i18n translations
 * at the UI layer. The `message` field remains as an English fallback for
 * non-UI consumers (logs, debugging, third-party integrations).
 */
export type ConfirmationMessageKey =
  | 'export-public-key'
  | 'reconnecting'
  | 'open-app'
  | 'waiting-for-app'
  | 'sign-transaction'
  | 'sign-message'

type MessageFields = {
  readonly message?: string | undefined
  readonly messageKey?: ConfirmationMessageKey | undefined
  readonly messageParams?: Readonly<Record<string, string>> | undefined
}

/**
 * Confirmation flow state.
 *
 * Represents the current state of a hardware wallet operation that
 * requires user confirmation on the device.
 */
export type ConfirmationState =
  | {readonly type: 'idle'}
  | ({readonly type: 'waiting-for-device'} & MessageFields)
  | ({readonly type: 'confirm-on-device'; readonly operation?: string | undefined} & MessageFields)
  | ({readonly type: 'processing'; readonly progress?: number | undefined} & MessageFields)
  | ({readonly type: 'completed'} & MessageFields)
  | ({readonly type: 'rejected'} & MessageFields)
  | ({readonly type: 'error'; readonly error: HardwareErrorType} & MessageFields)

/**
 * Confirmation state change callback.
 */
export type ConfirmationStateCallback = (state: ConfirmationState) => void

/**
 * Progress callback for operations with measurable progress.
 */
export type ProgressCallback = (percent: number) => void

/**
 * Callbacks for confirmation flow events.
 */
export type ConfirmationCallbacks = {
  /** Called when the confirmation state changes */
  readonly onStateChange: ConfirmationStateCallback
  /** Called when progress is updated (for operations with measurable progress) */
  readonly onProgress?: ProgressCallback | undefined
  /** Called before the operation starts */
  readonly onStart?: (() => void) | undefined
  /** Called after the operation completes (success or failure) */
  readonly onComplete?: ((success: boolean) => void) | undefined
}

/**
 * Options for setting confirmation state.
 * Pass a plain string for backward-compatible raw messages, or an object
 * with `messageKey` + optional `messageParams` for UI-translatable messages.
 */
export type ConfirmationSetOptions = {
  readonly message?: string
  readonly messageKey?: ConfirmationMessageKey
  readonly messageParams?: Readonly<Record<string, string>>
}

/**
 * Configuration for confirmation flow.
 */
export type ConfirmationConfig = {
  /** Message to show when waiting for device */
  readonly waitingMessage?: string
  /** Message to show when confirming on device */
  readonly confirmMessage?: string
  /** Operation name for display */
  readonly operationName?: string
  /** Whether to automatically reset state after completion */
  readonly autoReset?: boolean
  /** Delay before auto-reset (ms) */
  readonly autoResetDelay?: number
}

// ============================================================================
// Default Messages
// ============================================================================

/**
 * Default messages for different operation types.
 */
export const DefaultMessages = {
  /** Default message for address derivation */
  getAddress: {
    waiting: 'Connecting to device...',
    confirm: 'Please verify the address on your device',
  },
  /** Default message for public key derivation */
  getPublicKey: {
    waiting: 'Connecting to device...',
    confirm: 'Please confirm on your device',
  },
  /** Default message for transaction signing */
  signTransaction: {
    waiting: 'Preparing transaction...',
    confirm: 'Please review and sign the transaction on your device',
  },
  /** Default message for message signing */
  signMessage: {
    waiting: 'Preparing message...',
    confirm: 'Please review and sign the message on your device',
  },
  /** Default message for address verification */
  verifyAddress: {
    waiting: 'Preparing verification...',
    confirm: 'Please verify the address matches on your device',
  },
} as const

// ============================================================================
// State Management
// ============================================================================

/**
 * Creates a confirmation state manager.
 *
 * @param callbacks - Callbacks for state changes
 * @param config - Configuration options
 * @returns State management functions
 */
export const createConfirmationStateManager = (callbacks: ConfirmationCallbacks, config: ConfirmationConfig = {}) => {
  let currentState: ConfirmationState = {type: 'idle'}
  let autoResetTimer: ReturnType<typeof setTimeout> | null = null

  const setState = (state: ConfirmationState): void => {
    currentState = state
    callbacks.onStateChange(state)

    // Handle auto-reset
    if (config.autoReset && (state.type === 'completed' || state.type === 'rejected' || state.type === 'error')) {
      if (autoResetTimer) clearTimeout(autoResetTimer)
      autoResetTimer = setTimeout(() => {
        setState({type: 'idle'})
      }, config.autoResetDelay ?? 3000)
    }
  }

  const parseOptions = (
    options?: string | ConfirmationSetOptions,
  ): {message?: string; messageKey?: ConfirmationMessageKey; messageParams?: Readonly<Record<string, string>>} =>
    typeof options === 'string' ? {message: options} : (options ?? {})

  return {
    /** Gets the current state */
    getState: () => currentState,

    /** Sets state to waiting for device */
    setWaiting: (options?: string | ConfirmationSetOptions) => {
      const {message, messageKey, messageParams} = parseOptions(options)
      setState({type: 'waiting-for-device', message: message ?? config.waitingMessage, messageKey, messageParams})
    },

    /** Sets state to confirm on device */
    setConfirm: (options?: string | ConfirmationSetOptions) => {
      const {message, messageKey, messageParams} = parseOptions(options)
      setState({
        type: 'confirm-on-device',
        message: message ?? config.confirmMessage,
        messageKey,
        messageParams,
        operation: config.operationName,
      })
    },

    /** Sets state to processing */
    setProcessing: (options?: string | ConfirmationSetOptions, progress?: number) => {
      const {message, messageKey, messageParams} = parseOptions(options)
      setState({type: 'processing', message, messageKey, messageParams, progress})
      if (progress !== undefined && callbacks.onProgress) {
        callbacks.onProgress(progress)
      }
    },

    /** Sets state to completed */
    setCompleted: (options?: string | ConfirmationSetOptions) => {
      const {message, messageKey, messageParams} = parseOptions(options)
      setState({type: 'completed', message, messageKey, messageParams})
      callbacks.onComplete?.(true)
    },

    /** Sets state to rejected (user rejected on device) */
    setRejected: (options?: string | ConfirmationSetOptions) => {
      const {message, messageKey, messageParams} = parseOptions(options)
      setState({type: 'rejected', message: message ?? 'Operation was rejected on device', messageKey, messageParams})
      callbacks.onComplete?.(false)
    },

    /** Sets state to error */
    setError: (error: HardwareErrorType, options?: string | ConfirmationSetOptions) => {
      const {message, messageKey, messageParams} = parseOptions(options)
      setState({type: 'error', error, message: message ?? error.message, messageKey, messageParams})
      callbacks.onComplete?.(false)
    },

    /** Resets state to idle */
    reset: () => {
      if (autoResetTimer) {
        clearTimeout(autoResetTimer)
        autoResetTimer = null
      }
      setState({type: 'idle'})
    },

    /** Cleans up (cancels any pending timers) */
    cleanup: () => {
      if (autoResetTimer) {
        clearTimeout(autoResetTimer)
        autoResetTimer = null
      }
    },
  }
}

export type ConfirmationStateManager = ReturnType<typeof createConfirmationStateManager>

// ============================================================================
// Effect Wrappers
// ============================================================================

/**
 * Wraps a hardware operation with confirmation state tracking.
 *
 * This function provides state updates throughout the operation lifecycle:
 * 1. Sets state to 'waiting-for-device' before starting
 * 2. Sets state to 'confirm-on-device' when waiting for user confirmation
 * 3. Sets state to 'processing' while operation is in progress
 * 4. Sets state to 'completed', 'rejected', or 'error' based on result
 *
 * @param operation - The Effect to wrap
 * @param callbacks - Callbacks for state changes
 * @param config - Configuration options
 * @returns Wrapped Effect with confirmation tracking
 */
export const withConfirmation = <A>(
  operation: Effect.Effect<A, HardwareErrorType>,
  callbacks: ConfirmationCallbacks,
  config: ConfirmationConfig = {},
): Effect.Effect<A, HardwareErrorType> =>
  Effect.gen(function* () {
    const manager = createConfirmationStateManager(callbacks, config)

    // Signal start
    callbacks.onStart?.()
    manager.setWaiting()

    // Small delay to allow UI to update before device interaction
    yield* Effect.sleep(100)

    // Set confirm state before operation
    manager.setConfirm()

    // Run the operation
    const result = yield* Effect.either(operation)

    if (result._tag === 'Left') {
      const error = result.left

      // Check if it's a user rejection
      if (error._tag === 'UserRejectedError') {
        manager.setRejected()
      } else {
        manager.setError(error)
      }

      return yield* Effect.fail(error)
    }

    manager.setCompleted()
    return result.right
  })

/**
 * Creates an Effect-based confirmation state ref.
 *
 * Useful for integrating with Effect-based state management.
 *
 * @param initial - Initial state
 * @returns Effect that creates a state ref
 */
export const createConfirmationRef = (
  initial: ConfirmationState = {type: 'idle'},
): Effect.Effect<Ref.Ref<ConfirmationState>> => Ref.make(initial)

/**
 * Creates confirmation callbacks that update a Ref.
 *
 * @param ref - State ref to update
 * @param additionalCallbacks - Additional callbacks to merge
 * @returns Confirmation callbacks
 */
export const refConfirmationCallbacks = (
  ref: Ref.Ref<ConfirmationState>,
  additionalCallbacks?: Partial<ConfirmationCallbacks>,
): ConfirmationCallbacks => ({
  onStateChange: (state) => {
    Effect.runSync(Ref.set(ref, state))
    additionalCallbacks?.onStateChange?.(state)
  },
  onProgress: additionalCallbacks?.onProgress,
  onStart: additionalCallbacks?.onStart,
  onComplete: additionalCallbacks?.onComplete,
})

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Gets a human-readable message for a confirmation state.
 *
 * @param state - Current confirmation state
 * @returns Human-readable message
 */
export const getConfirmationMessage = (state: ConfirmationState): string => {
  switch (state.type) {
    case 'idle':
      return ''
    case 'waiting-for-device':
      return state.message ?? 'Connecting to device...'
    case 'confirm-on-device':
      return state.message ?? 'Please confirm on your device'
    case 'processing':
      return state.message ?? 'Processing...'
    case 'completed':
      return state.message ?? 'Operation completed'
    case 'rejected':
      return state.message ?? 'Operation rejected'
    case 'error':
      return state.message ?? 'An error occurred'
  }
}

/**
 * Checks if the confirmation state indicates the operation is active.
 *
 * @param state - Current confirmation state
 * @returns True if operation is active
 */
export const isOperationActive = (state: ConfirmationState): boolean =>
  state.type === 'waiting-for-device' || state.type === 'confirm-on-device' || state.type === 'processing'

/**
 * Checks if the confirmation state indicates the operation is complete.
 *
 * @param state - Current confirmation state
 * @returns True if operation is complete (success or failure)
 */
export const isOperationComplete = (state: ConfirmationState): boolean =>
  state.type === 'completed' || state.type === 'rejected' || state.type === 'error'

/**
 * Checks if the confirmation state indicates success.
 *
 * @param state - Current confirmation state
 * @returns True if operation completed successfully
 */
export const isOperationSuccessful = (state: ConfirmationState): boolean => state.type === 'completed'
