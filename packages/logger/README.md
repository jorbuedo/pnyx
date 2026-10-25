# @pnyx/logger

Structured logging with transports, level filtering, and an in-memory trail buffer.

## Overview

A lightweight logger designed for cross-platform use. It supports multiple transports (console, Sentry, custom), log level and origin filtering, and maintains a ring buffer of recent entries for runtime diagnostics.

## Usage

### Basic logging

```typescript
import {createLogger, consoleTransport, LogLevel} from '@pnyx/logger'

const logger = createLogger({level: LogLevel.Debug})
logger.addTransport(consoleTransport)

logger.info('Application started', {origin: 'App'})
logger.debug('Cache hit', {origin: 'Storage', key: 'user-prefs'})
logger.warn('Slow query', {origin: 'DB', durationMs: 1200})
logger.error(new Error('Connection failed'), {origin: 'Network'})
```

### Trail buffer

Every logged entry is stored in an in-memory ring buffer (max 500 entries). This powers the dev tools logs viewer without requiring disk storage.

```typescript
// Read all buffered entries (readonly)
const entries = logger.trail // readonly LogEntry[]

// Each entry contains:
// { id, level, message, metadata, timestamp }
```

The trail is append-only. When it exceeds 500 entries, the oldest entry is evicted.

### Filtering

```typescript
// Filter by level — only logs at this level or higher severity are processed
logger.setLevel(LogLevel.Warn) // only warn + error

// Filter by origin — only matching origins are logged
logger.setFilter(/Network|Storage/) // regex match on metadata.origin
logger.setFilter(null) // clear filter

// Enable/disable all logging
logger.disable()
logger.enable()
```

### Custom transports

A transport is a function that receives log events. Add as many as needed; each receives every log entry that passes level/origin filtering.

```typescript
import type {LogTransport} from '@pnyx/logger'

const fileTransport: LogTransport = ({level, message, metadata, timestamp}) => {
  fs.appendFileSync('app.log', `${timestamp} [${level}] ${message}\n`)
}

const removeTransport = logger.addTransport(fileTransport)
// Later: removeTransport() to unsubscribe
```

### Effect service

For Effect-TS applications, use the service layer for dependency injection:

```typescript
import {log, LoggerService, LoggerServiceLive, makeLoggerLayer} from '@pnyx/logger'

// Use convenience functions in Effect.gen blocks
const program = Effect.gen(function* () {
  yield* log.info('Starting sync', {origin: 'Wallet'})
  // ...
  yield* log.error('Sync failed', {origin: 'Wallet'})
})

// Provide via layer
const result = program.pipe(Effect.provide(LoggerServiceLive))

// Or create a custom layer from an existing logger instance
const customLayer = makeLoggerLayer(myLogger)
```

Pre-built layers:

| Layer | Behavior |
|-------|----------|
| `LoggerServiceLive` | Console transport, debug level |
| `LoggerServiceSilent` | Discards all logs (for tests) |

## API

### `createLogger(options?)`

Creates a new logger instance.

- `options.level` — Initial log level (default: `'info'`)
- Returns: `Logger`

### `Logger`

| Property/Method | Description |
|-----------------|-------------|
| `level` | Current log level (readonly) |
| `trail` | Ring buffer of last 500 `LogEntry` objects (readonly) |
| `filter` | Current origin filter regex or null (readonly) |
| `debug(message, metadata?)` | Log at debug level |
| `info(message, metadata?)` | Log at info level |
| `warn(message, metadata?)` | Log at warn level |
| `error(error, metadata?)` | Log at error level (accepts `Error` or `string`) |
| `addTransport(transport)` | Add a transport, returns unsubscribe function |
| `setLevel(level)` | Set minimum log level |
| `setFilter(regex)` | Filter by origin (null to clear) |
| `enable()` / `disable()` | Toggle all logging |

### `LogEntry`

```typescript
type LogEntry = {
  id: string        // Unique ID (e.g. "log-1706000000000-1")
  level: LogLevel   // 'debug' | 'info' | 'warn' | 'error'
  message: string   // Extracted message string
  metadata: LogMetadata
  timestamp: number // Epoch milliseconds
}
```

### `LogMetadata`

```typescript
type LogMetadata = {
  type?: 'default' | 'debug' | 'error' | 'navigation' | 'http' | 'info' | 'query' | 'transaction' | 'ui' | 'user'
  origin?: string       // Source module/package
  [key: string]: unknown // Arbitrary extra fields
}
```

The `type` field maps to Sentry breadcrumb categories. The `origin` field identifies the source module and is used for origin-based filtering.

### Log level priority

Levels are ordered by severity. Setting `setLevel('warn')` suppresses `debug` and `info`.

| Level | Priority |
|-------|----------|
| `error` | 0 (highest) |
| `warn` | 1 |
| `info` | 2 |
| `debug` | 3 (lowest) |
