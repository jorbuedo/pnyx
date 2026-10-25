/**
 * Package-level logger for `@pnyx/migrations`.
 *
 * This logger is separate from the per-consumer `onOutcome` hook on
 * `MigrationConfig`. Outcomes (missing / no-op / migrated / quarantined)
 * are reported through `onOutcome` — one hook per consumer, wired to the
 * app's own logger. THIS logger only fires for framework-internal
 * diagnostics — today, just the case where a consumer's own `onOutcome`
 * hook throws. Using a separate named logger means a broken consumer
 * hook doesn't silence the framework's ability to report the breakage.
 *
 * Routed through the registry: every transport the app registers via
 * `loggerRegistry.addTransport(...)` fans out to this logger.
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'

export const logger = getLogger('migrations')
