/**
 * Utility functions replacing @trezor/utils.
 *
 * Provides scheduleAction, createDeferred, arrayPartition, getSynchronize,
 * resolveAfter, and readMessageBuffer.
 *
 * @module
 */

import * as ERRORS from './errors'
import {noopLogger, type ProtocolLogger} from './logger'

// --- Deferred ---

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

export const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

// --- Schedule action with timeout + abort ---

export type ScheduleActionParams = {
  timeout?: number | undefined
  signal?: AbortSignal | undefined
  graceful?: boolean | undefined
}

/**
 * Execute an async action with timeout and abort signal support.
 *
 * Simplified version of @trezor/utils scheduleAction — supports a single
 * attempt with timeout and signal, which is all the transport adapter uses.
 */
export const scheduleAction = <T>(
  action: (signal: AbortSignal) => Promise<T>,
  params?: ScheduleActionParams,
): Promise<T> => {
  const {timeout, signal, graceful} = params ?? {}
  const controller = new AbortController()

  // Link external signal
  if (signal) {
    if (signal.aborted) {
      return Promise.reject(new Error(ERRORS.ABORTED_BY_SIGNAL))
    }
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, {once: true})
    // Clean up when our controller aborts for other reasons
    controller.signal.addEventListener('abort', () => signal.removeEventListener('abort', onAbort), {once: true})
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const actionPromise = action(graceful ? controller.signal : controller.signal)

  const timeoutPromise =
    timeout !== undefined
      ? new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort(ERRORS.ABORTED_BY_TIMEOUT)
            reject(new Error(ERRORS.ABORTED_BY_TIMEOUT))
          }, timeout)
        })
      : null

  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        const reason = controller.signal.reason
        reject(new Error(typeof reason === 'string' ? reason : ERRORS.ABORTED_BY_SIGNAL))
      },
      {once: true},
    )
  })

  const promises: Promise<T>[] = [actionPromise, abortPromise]
  if (timeoutPromise) promises.push(timeoutPromise)

  return Promise.race(promises).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  })
}

// --- Array partition ---

/**
 * Split an array into two groups based on a predicate.
 */
export const arrayPartition = <T>(arr: readonly T[], predicate: (item: T) => boolean): [T[], T[]] => {
  const pass: T[] = []
  const fail: T[] = []
  for (const item of arr) {
    if (predicate(item)) pass.push(item)
    else fail.push(item)
  }
  return [pass, fail]
}

// --- Synchronize ---

/**
 * Creates a synchronization wrapper that ensures only one async operation runs at a time.
 */
export const getSynchronize = (logger: ProtocolLogger = noopLogger) => {
  let pending: Promise<unknown> = Promise.resolve()
  return <T>(action: () => Promise<T>): Promise<T> => {
    const run = pending.then(action, action)
    // Keeps the tail from staying rejected; `run` carries the rejection to the caller.
    pending = run.catch((e) => {
      logger.debug('Synchronized action rejected', {origin: 'trezor-protocol', error: String(e)})
    })
    return run
  }
}

// --- Resolve after ---

/**
 * Promise that resolves after a delay.
 */
export const resolveAfter = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- Read message buffer ---

type Success<T> = {readonly success: true; readonly payload: T}
type ErrorResult = {readonly success: false; readonly error: string; readonly message?: string | undefined}

const ok = <T>(payload: T): Success<T> => ({success: true, payload})
const fail = (err: string, message?: string): ErrorResult => ({success: false, error: err, message})

/**
 * Creates a message buffer for asynchronous read operations.
 *
 * Handles the race condition where device messages can arrive before
 * or after the transport calls read(). Uses a deferred promise pattern.
 *
 * Replaces @trezor/transport/lib/utils/readMessageBuffer.
 */
export const readMessageBuffer = () => {
  const buffers: Record<string, Uint8Array[]> = {}
  const pendingReads: Record<string, Deferred<Uint8Array>> = {}

  const onMessage = (path: string, data: Uint8Array) => {
    const pending = pendingReads[path]
    if (pending) {
      delete pendingReads[path]
      pending.resolve(data)
    } else {
      if (!buffers[path]) buffers[path] = []
      buffers[path].push(data)
    }
  }

  const read = (path: string, signal?: AbortSignal): Promise<Success<Uint8Array> | ErrorResult> => {
    // Check buffer first
    const buffered = buffers[path]
    if (buffered && buffered.length > 0) {
      const data = buffered.shift()
      if (!data) return Promise.resolve(fail(ERRORS.DEVICE_DISCONNECTED_DURING_ACTION, 'empty buffer'))
      if (buffered.length === 0) delete buffers[path]
      return Promise.resolve(ok(data))
    }

    // Wait for next message
    const dfd = createDeferred<Uint8Array>()
    pendingReads[path] = dfd

    if (signal) {
      const onAbort = () => {
        delete pendingReads[path]
        dfd.reject(new Error(ERRORS.ABORTED_BY_SIGNAL))
      }
      signal.addEventListener('abort', onAbort, {once: true})
      dfd.promise.then(
        () => signal.removeEventListener('abort', onAbort),
        () => signal.removeEventListener('abort', onAbort),
      )
    }

    return dfd.promise.then(
      (data) => ok(data),
      (err) => fail(ERRORS.DEVICE_DISCONNECTED_DURING_ACTION, err instanceof Error ? err.message : String(err)),
    )
  }

  const cancelRead = (path: string) => {
    const pending = pendingReads[path]
    if (pending) {
      delete pendingReads[path]
      pending.reject(new Error(ERRORS.ABORTED_BY_SIGNAL))
    }
    delete buffers[path]
  }

  return {onMessage, read, cancelRead}
}
