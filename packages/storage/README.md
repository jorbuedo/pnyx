# @pnyx/storage

Platform-agnostic storage abstraction for the Pnyx app.

## Overview

This package provides a unified storage interface with:

- **Storage service** - Abstract storage operations with Effect
- **Memory adapter** - In-memory storage for testing
- **JSON utilities** - Type-safe JSON serialization
- **Platform detection** - Detect runtime environment

## Installation

```bash
bun add @pnyx/storage
```

## Usage

### Using Memory Storage

```typescript
import { createMemoryStorage } from '@pnyx/storage'
import { Effect } from 'effect'

const storage = createMemoryStorage()

// Store and retrieve values
await Effect.runPromise(
  Effect.gen(function* () {
    yield* storage.set('user', { name: 'Alice' })
    const user = yield* storage.get('user')
    console.log(user) // { name: 'Alice' }
  })
)
```

### JSON Utilities

```typescript
import { serializeJson, deserializeJson } from '@pnyx/storage'
import { Effect } from 'effect'

const data = { count: 42, items: ['a', 'b', 'c'] }

// Serialize with pretty printing
const json = Effect.runSync(serializeJson(data, true))

// Deserialize with validation
const parsed = Effect.runSync(deserializeJson(json))
```

### Platform Detection

```typescript
import { detectPlatform } from '@pnyx/storage'

const platform = detectPlatform()
// Returns: 'node' | 'browser' | 'react-native' | 'unknown'
```

## Storage Interface

```typescript
interface Storage {
  get: <T>(key: string) => Effect.Effect<T | null, StorageError>
  set: <T>(key: string, value: T) => Effect.Effect<void, StorageError>
  remove: (key: string) => Effect.Effect<void, StorageError>
  clear: () => Effect.Effect<void, StorageError>
  keys: () => Effect.Effect<readonly string[], StorageError>
  has: (key: string) => Effect.Effect<boolean, StorageError>
}
```

## Platform Adapters

The package provides the interface; platform-specific implementations should be added:

- **AsyncStorage** - React Native
- **MMKV** - React Native (high performance)
- **Chrome storage** - Browser extensions (`BrowserExtensionStorage`)
- **IndexedDB** - Web browsers
- **localStorage** - Web browsers (simple)

## Migration from Other Storage Solutions

### From AsyncStorage (React Native)

```typescript
// Before (AsyncStorage)
import AsyncStorage from '@react-native-async-storage/async-storage'

await AsyncStorage.setItem('wallet', JSON.stringify(data))
const data = JSON.parse(await AsyncStorage.getItem('wallet') ?? 'null')

// After (@pnyx/storage)
import { Storage } from '@pnyx/storage'
import { Effect } from 'effect'

const program = Effect.gen(function* () {
  const storage = yield* Storage
  yield* storage.setJson('wallet', data)
  const data = yield* storage.getJson<WalletData>('wallet')
})
```

### From MMKV (React Native)

```typescript
// Before (MMKV)
import { MMKV } from 'react-native-mmkv'

const storage = new MMKV()
storage.set('settings', JSON.stringify(settings))
const settings = JSON.parse(storage.getString('settings') ?? '{}')

// After (@pnyx/storage)
const program = Effect.gen(function* () {
  const storage = yield* Storage
  yield* storage.setJson('settings', settings)
  const settings = yield* storage.getJson<Settings>('settings')
})

// Use MMKV adapter for the underlying implementation
const MMKVStorageLive = Layer.succeed(Storage, createMMKVStorage())
```

### From chrome.storage (Browser Extensions)

```typescript
// Before (chrome.storage)
await chrome.storage.local.set({ key: value })
const result = await chrome.storage.local.get('key')

// After (@pnyx/storage)
import { BrowserExtensionStorage } from '@pnyx/storage'

const program = Effect.gen(function* () {
  const storage = yield* Storage
  yield* storage.set('key', value)
  const value = yield* storage.get('key')
})

// Use extension storage adapter
const ExtensionStorageLive = BrowserExtensionStorage.layer('local')
```

### From Zustand Persist Middleware

```typescript
// Before (Zustand persist)
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const useStore = create(
  persist(
    (set) => ({ count: 0, increment: () => set((s) => ({ count: s.count + 1 })) }),
    { name: 'counter-storage' }
  )
)

// After (@pnyx/storage with Effect)
const makeCounterService = Effect.gen(function* () {
  const storage = yield* Storage

  // Load initial state
  const initial = yield* storage.getJson<{ count: number }>('counter-storage').pipe(
    Effect.orElseSucceed(() => ({ count: 0 }))
  )
  const state = yield* Ref.make(initial)

  return {
    getCount: () => Ref.get(state).pipe(Effect.map((s) => s.count)),
    increment: () =>
      Effect.gen(function* () {
        yield* Ref.update(state, (s) => ({ count: s.count + 1 }))
        yield* storage.setJson('counter-storage', yield* Ref.get(state))
      }),
  }
})
```

## JSON Utilities

Type-safe JSON operations with validation:

```typescript
import { Storage } from '@pnyx/storage'
import { Effect } from 'effect'

interface UserSettings {
  theme: 'light' | 'dark'
  language: string
}

const program = Effect.gen(function* () {
  const storage = yield* Storage

  // Set with automatic JSON serialization
  yield* storage.setJson('settings', { theme: 'dark', language: 'en' })

  // Get with type inference
  const settings = yield* storage.getJson<UserSettings>('settings')

  // Update existing value
  yield* storage.updateJson<UserSettings>('settings', (prev) => ({
    ...prev,
    theme: 'light',
  }))
})
```

## References

- [MIGRATION_ZUSTAND.md](../../docs/archive/MIGRATION_ZUSTAND.md) - Full Zustand migration guide
- [EFFECT_PATTERNS.md](../../docs/EFFECT_PATTERNS.md) - Effect-TS patterns
