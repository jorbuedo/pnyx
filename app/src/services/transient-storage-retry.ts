import {isTransientStorageError} from '@pnyx/store/errors'
import {Schedule} from 'effect'

/**
 * Bounded retry for a chain sync aborted by a transient storage blip — the
 * IndexedDB connection closing as the extension popup/SW suspends, or the
 * expo-sqlite handle closing on Android teardown / under BUSY contention. Only
 * transient store errors are retried (others fail on the first attempt), capped
 * at 2 retries with short exponential spacing so a genuine failure surfaces
 * quickly and we never loop. Matters most on the *initial* sync, where an
 * aborted read would otherwise persist no snapshot and strand the wallet.
 *
 * Lives in its own dep-light module (only `effect` + `@pnyx/store/errors`)
 * so it can be unit-tested without importing the full wallet-service graph.
 */
export const TRANSIENT_STORAGE_SYNC_RETRY = Schedule.recurs(2).pipe(
  Schedule.intersect(Schedule.exponential('100 millis')),
  Schedule.whileInput((e: {message: string}) => isTransientStorageError(e.message)),
)
