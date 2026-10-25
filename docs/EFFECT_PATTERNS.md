# Effect-TS Patterns

This document describes the Effect-TS patterns used throughout the project.

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Effect Creation](#effect-creation)
3. [Effect Composition](#effect-composition)
4. [Error Handling](#error-handling)
5. [Services](#services)
6. [Option Types](#option-types)
7. [Common Patterns](#common-patterns)
8. [Best Practices](#best-practices)

## Core Concepts

### What is an Effect?

An `Effect<A, E, R>` represents a computation that:
- Produces a value of type `A` (success)
- May fail with an error of type `E`
- Requires dependencies of type `R`

```typescript
import {Effect} from 'effect'

// Effect<number, never, never>
// - Returns number
// - Never fails
// - No dependencies
const simpleEffect = Effect.succeed(42)

// Effect<string, Error, never>
// - Returns string
// - May fail with Error
// - No dependencies
const failableEffect = Effect.try(() => {
  if (Math.random() > 0.5) {
    return "Success!"
  }
  throw new Error("Failed")
})
```

### Running Effects

```typescript
// Run and await result
const result = await Effect.runPromise(myEffect)

// Run synchronously (only for effects with no async operations)
const syncResult = Effect.runSync(myEffect)

// Run with custom runtime
const runtime = Effect.Runtime.defaultRuntime
const result = await Effect.Runtime.runPromise(runtime)(myEffect)
```

## Effect Creation

### From Values

```typescript
// Success value
const success = Effect.succeed(42)

// Failure
const failure = Effect.fail(new Error("Something went wrong"))

// From Option
import {Option} from 'effect'
const optionEffect = Effect.fromOption(
  Option.some(42),
  () => new Error("None value"),
)
```

### From Functions

```typescript
// Synchronous function that may throw
const fromSync = Effect.try(() => {
  return JSON.parse(jsonString)
})

// With custom error transformation
const fromSyncCustom = Effect.try({
  try: () => JSON.parse(jsonString),
  catch: (error) => new ParseError(String(error)),
})

// Async function
const fromAsync = Effect.tryPromise(() => fetch(url))

// Async with custom error
const fromAsyncCustom = Effect.tryPromise({
  try: () => fetch(url),
  catch: (error) => new NetworkError(String(error)),
})
```

### Generator-Based (Recommended)

```typescript
const program = Effect.gen(function* () {
  // Yield effects to unwrap them
  const user = yield* fetchUser(userId)
  const posts = yield* fetchPosts(user.id)
  const comments = yield* fetchComments(posts.map(p => p.id))
  
  return {user, posts, comments}
})
```

## Effect Composition

### Sequential Composition

```typescript
// Using flatMap (bind)
const result = Effect.succeed(2).pipe(
  Effect.flatMap((n) => Effect.succeed(n * 2)),
  Effect.flatMap((n) => Effect.succeed(n + 10)),
) // Effect<number, never, never> = 14

// Using gen (preferred for multiple steps)
const result = Effect.gen(function* () {
  const a = yield* fetchA()
  const b = yield* fetchB(a)
  const c = yield* fetchC(b)
  return c
})
```

### Parallel Composition

```typescript
// Run two effects in parallel
const [user, settings] = await Effect.runPromise(
  Effect.all([
    fetchUser(userId),
    fetchSettings(userId),
  ]),
)

// Run many effects in parallel
const results = await Effect.runPromise(
  Effect.all(
    ids.map(id => fetchItem(id)),
  ),
)

// Race two effects (first to complete wins)
const result = await Effect.runPromise(
  Effect.race(
    fetchFromPrimary(),
    fetchFromBackup(),
  ),
)
```

### Transformation

```typescript
// Map over success value
const doubled = myEffect.pipe(
  Effect.map((n) => n * 2),
)

// Map over error
const customError = myEffect.pipe(
  Effect.mapError((e) => new CustomError(e)),
)

// Transform both success and error
const transformed = myEffect.pipe(
  Effect.mapBoth({
    onSuccess: (n) => n * 2,
    onFailure: (e) => new CustomError(e),
  }),
)
```

## Error Handling

### Catching Errors

```typescript
// Catch all errors
const safe = myEffect.pipe(
  Effect.catchAll((error) => {
    console.error(error)
    return Effect.succeed(defaultValue)
  }),
)

// Catch specific error types
const specific = myEffect.pipe(
  Effect.catchTag("NetworkError", (error) => {
    return retryWithBackup()
  }),
)

// Provide fallback
const withFallback = myEffect.pipe(
  Effect.orElse(() => Effect.succeed(defaultValue)),
)
```

### Retrying

```typescript
// Retry with exponential backoff
const retried = myEffect.pipe(
  Effect.retry({
    times: 3,
    schedule: Schedule.exponential("100 millis"),
  }),
)

// Retry until success
const retryForever = myEffect.pipe(
  Effect.retry(Schedule.forever),
)
```

### Either Pattern

```typescript
// Convert Effect to Either for explicit error handling
const either = await Effect.runPromise(
  myEffect.pipe(Effect.either),
)

if (Either.isLeft(either)) {
  console.error("Failed:", either.left)
} else {
  console.log("Success:", either.right)
}
```

## Services

### Defining a Service

```typescript
import {Effect, Context} from 'effect'

// Define service interface
export interface UserService {
  readonly getUser: (id: string) => Effect.Effect<User, Error>
  readonly updateUser: (user: User) => Effect.Effect<void, Error>
}

// Create service tag
export const UserService = Context.GenericTag<UserService>("UserService")

// Implement service
export const makeUserService = (database: Database): UserService => ({
  getUser: (id) => Effect.tryPromise(() => database.findUser(id)),
  updateUser: (user) => Effect.tryPromise(() => database.saveUser(user)),
})

// Create layer
export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const database = yield* Database
    return makeUserService(database)
  }),
)
```

### Using Services

```typescript
// Access service in Effect
const program = Effect.gen(function* () {
  const userService = yield* UserService
  const user = yield* userService.getUser("123")
  return user
})

// Provide service implementation
const result = await Effect.runPromise(
  program.pipe(Effect.provide(UserServiceLive)),
)
```

### Effect.Service Pattern (New API)

```typescript
export class HttpExplorer extends Effect.Service<HttpExplorer>()(
  'CardanoExplorer/Http',
  {
    effect: Effect.gen(function* () {
      // Service implementation
      return {
        indices: (xpub, start, limit) => /* ... */,
        coins: (xpub, snapshot) => /* ... */,
      }
    }),
  },
) {}

// Usage
const program = Effect.gen(function* () {
  const explorer = yield* HttpExplorer
  return yield* explorer.indices(xpub, 0, 20)
}).pipe(Effect.provide(HttpExplorer.Default))
```

## Option Types

### Working with Option

```typescript
import {Option} from 'effect'

// Create Options
const some = Option.some(42)
const none = Option.none()

// Check Option
if (Option.isSome(option)) {
  console.log(option.value)
}

// Get value or default
const value = Option.getOrElse(option, () => 0)

// Transform Option
const doubled = Option.map(option, (n) => n * 2)

// Convert to Effect
const effect = Option.match(option, {
  onSome: (value) => Effect.succeed(value),
  onNone: () => Effect.fail(new Error("No value")),
})
```

### Option in this codebase

```typescript
// Assets are Option<bigint>
const assets: Record<string, Option<bigint>> = {
  '': Option.some(1_000_000n), // Lovelace
  'policy.asset': Option.some(100n),
}

// Check if asset exists
const lovelace = assets['']
if (lovelace && Option.isSome(lovelace)) {
  console.log(`Balance: ${lovelace.value}`)
}

// Convert to string for serialization
const amount = Option.isSome(lovelace) ? lovelace.value.toString() : '0'
```

## Common Patterns

### Builder Pattern with Immutability

```typescript
// Transaction plan is immutable
let plan = defaultPlan

// Each transformation returns new plan
plan = payment(plan, recipient, amount)
plan = calculateFee(plan, feeConfig)
plan = donation(plan, charity, donationAmount)
```

### Snapshot Merging

```typescript
// Progressive synchronization
let snapshot = empty

// Fetch updates
const update = await Effect.runPromise(
  explorer.indices(xpub, 0, 20),
)

// Merge immutably
snapshot = merge(snapshot, update)
```

### Tagged Errors

```typescript
export class NetworkError extends Error {
  readonly _tag = "NetworkError"
}

export class ParseError extends Error {
  readonly _tag = "ParseError"
}

// Catch specific error
const handled = myEffect.pipe(
  Effect.catchTag("NetworkError", (error) => {
    return retryWithBackup()
  }),
)
```

## Best Practices

### 1. Use Effect.gen for Multiple Steps

**Good:**
```typescript
const program = Effect.gen(function* () {
  const a = yield* fetchA()
  const b = yield* fetchB(a)
  return b
})
```

**Avoid:**
```typescript
const program = fetchA().pipe(
  Effect.flatMap((a) => fetchB(a)),
)
```

### 2. Always Type Effect Return Values

**Good:**
```typescript
export const fetchUser = (id: string): Effect.Effect<User, Error> => {
  return Effect.tryPromise(() => database.findUser(id))
}
```

**Avoid:**
```typescript
export const fetchUser = (id: string) => {
  return Effect.tryPromise(() => database.findUser(id))
}
```

### 3. Handle Errors Explicitly

**Good:**
```typescript
const safe = myEffect.pipe(
  Effect.catchAll((error) => {
    console.error("Operation failed:", error)
    return Effect.succeed(defaultValue)
  }),
)
```

**Avoid:**
```typescript
// Letting errors propagate without handling
const result = await Effect.runPromise(myEffect)
```

### 4. Use Services for Dependencies

**Good:**
```typescript
const program = Effect.gen(function* () {
  const db = yield* Database
  const user = yield* db.getUser(id)
  return user
})
```

**Avoid:**
```typescript
// Direct dependency injection
const program = (database: Database) => {
  return database.getUser(id)
}
```

### 5. Prefer Parallel Execution When Possible

**Good:**
```typescript
const [user, settings, posts] = await Effect.runPromise(
  Effect.all([
    fetchUser(id),
    fetchSettings(id),
    fetchPosts(id),
  ]),
)
```

**Avoid:**
```typescript
const user = await Effect.runPromise(fetchUser(id))
const settings = await Effect.runPromise(fetchSettings(id))
const posts = await Effect.runPromise(fetchPosts(id))
```

### 6. Use Option Instead of Null/Undefined

**Good:**
```typescript
type User = {
  name: string
  email: Option<string>
}
```

**Avoid:**
```typescript
type User = {
  name: string
  email: string | null | undefined
}
```

## Streams & Events

Effect Streams provide reactive data processing similar to RxJS Observables.

### Creating Streams

```typescript
import {Stream, Effect} from 'effect'

// From values
const numbers = Stream.fromIterable([1, 2, 3, 4, 5])

// From Effect
const userStream = Stream.fromEffect(fetchUser(userId))

// From async iterable
const events = Stream.fromAsyncIterable(
  eventSource,
  (error) => new EventError(String(error)),
)

// Infinite stream with schedule
const ticks = Stream.schedule(Schedule.spaced('1 second'))
```

### Transforming Streams

```typescript
// Map values
const doubled = Stream.map(numbers, (n) => n * 2)

// Filter values
const evens = Stream.filter(numbers, (n) => n % 2 === 0)

// FlatMap (like switchMap)
const userPosts = Stream.flatMap(userStream, (user) =>
  Stream.fromEffect(fetchPosts(user.id)),
)

// Tap for side effects
const logged = Stream.tap(numbers, (n) =>
  Effect.log(`Processing: ${n}`),
)
```

### Running Streams

```typescript
// Collect all values
const values = await Effect.runPromise(
  Stream.runCollect(numbers),
)

// Run for side effects only
await Effect.runPromise(
  Stream.runDrain(
    Stream.tap(numbers, (n) => Effect.log(`Got: ${n}`)),
  ),
)

// Take first N values
const first3 = await Effect.runPromise(
  Stream.runCollect(Stream.take(numbers, 3)),
)
```

### PubSub for Events

PubSub replaces RxJS Subject for event broadcasting:

```typescript
import {PubSub, Effect} from 'effect'

// Create a PubSub
const events = await Effect.runPromise(PubSub.unbounded<WalletEvent>())

// Publish events
await Effect.runPromise(PubSub.publish(events, {type: 'sync-started'}))

// Subscribe to events
const subscription = await Effect.runPromise(
  Effect.gen(function* () {
    const queue = yield* PubSub.subscribe(events)
    // Process events from queue
    const event = yield* Queue.take(queue)
    return event
  }),
)
```

### Broadcasting Streams

```typescript
// Broadcast a stream to multiple consumers
const broadcast = await Effect.runPromise(
  Stream.broadcast(sourceStream, 2),
)

// Each consumer gets the same values
const [stream1, stream2] = broadcast
```

## Refs & Mutable State

Effect Refs provide controlled mutable state.

### Creating Refs

```typescript
import {Ref, Effect} from 'effect'

// Create a Ref with initial value
const counter = await Effect.runPromise(Ref.make(0))

// Create a Ref in Effect.gen
const program = Effect.gen(function* () {
  const ref = yield* Ref.make({balance: 0, transactions: []})
  return ref
})
```

### Reading and Writing

```typescript
// Get current value
const value = yield* Ref.get(counter)

// Set new value
yield* Ref.set(counter, 10)

// Update based on current value
yield* Ref.update(counter, (n) => n + 1)

// Get and set atomically
const old = yield* Ref.getAndSet(counter, 0)

// Update and get new value
const newValue = yield* Ref.updateAndGet(counter, (n) => n + 1)
```

### Modify for Complex Updates

```typescript
// Modify returns a tuple of [result, newState]
const result = yield* Ref.modify(counter, (n) => [
  `Count was ${n}`,  // Return value
  n + 1,             // New state
])
```

### Reactive State with Stream.changes

```typescript
// Create stream of state changes (requires SubscriptionRef)
import {SubscriptionRef, Stream} from 'effect'

const ref = await Effect.runPromise(SubscriptionRef.make(0))

// Get a stream of changes
const changes = SubscriptionRef.changes(ref)

// Subscribe to changes
await Effect.runPromise(
  Stream.runForEach(changes, (value) =>
    Effect.log(`Value changed to: ${value}`),
  ),
)
```

## React Integration

Using Effect services in React components.

### Runtime Provider Pattern

```typescript
import {createContext, useContext, useMemo, type ReactNode} from 'react'
import {Effect, Layer, ManagedRuntime} from 'effect'

// Create runtime context
const RuntimeContext = createContext<ManagedRuntime<AppServices, never> | null>(null)

// Provider component
export const RuntimeProvider = ({children}: {children: ReactNode}) => {
  const runtime = useMemo(
    () => ManagedRuntime.make(AppServicesLive),
    [],
  )

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  )
}

// Hook to access runtime
export const useRuntime = () => {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('RuntimeProvider not found')
  return runtime
}
```

### useEffect Hook Pattern

```typescript
import {useEffect, useState} from 'react'
import {Effect} from 'effect'

export const useEffectService = <A, E>(
  effect: Effect.Effect<A, E, AppServices>,
) => {
  const runtime = useRuntime()
  const [state, setState] = useState<{
    data: A | null
    error: E | null
    loading: boolean
  }>({data: null, error: null, loading: true})

  useEffect(() => {
    const controller = new AbortController()

    runtime.runPromise(
      effect.pipe(Effect.interruptible),
      {signal: controller.signal},
    ).then(
      (data) => setState({data, error: null, loading: false}),
      (error) => setState({data: null, error: error as E, loading: false}),
    )

    return () => controller.abort()
  }, [effect, runtime])

  return state
}
```

### Data Fetching (replacing react-query)

```typescript
// Service for data fetching
const WalletService = Context.GenericTag<WalletService>('WalletService')

interface WalletService {
  getBalance: (address: string) => Effect.Effect<Balance, WalletError>
  getTransactions: (address: string) => Effect.Effect<Transaction[], WalletError>
}

// Hook using the service
export const useBalance = (address: string) => {
  const runtime = useRuntime()
  const [balance, setBalance] = useState<Balance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<WalletError | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)

    runtime.runPromise(
      Effect.gen(function* () {
        const wallet = yield* WalletService
        return yield* wallet.getBalance(address)
      }),
      {signal: controller.signal},
    ).then(
      (data) => {
        setBalance(data)
        setLoading(false)
      },
      (err) => {
        setError(err as WalletError)
        setLoading(false)
      },
    )

    return () => controller.abort()
  }, [address, runtime])

  return {balance, loading, error}
}
```

### State Management (replacing zustand)

```typescript
import {useSyncExternalStore} from 'react'
import {SubscriptionRef, Effect} from 'effect'

// Create a store hook from SubscriptionRef
export const createStore = <A>(ref: SubscriptionRef.SubscriptionRef<A>) => {
  let currentValue = Effect.runSync(Ref.get(ref))

  // Subscribe to changes
  Effect.runFork(
    Stream.runForEach(SubscriptionRef.changes(ref), (value) => {
      currentValue = value
      return Effect.void
    }),
  )

  return {
    getSnapshot: () => currentValue,
    subscribe: (callback: () => void) => {
      const fiber = Effect.runFork(
        Stream.runForEach(SubscriptionRef.changes(ref), () => {
          callback()
          return Effect.void
        }),
      )
      return () => Effect.runSync(Fiber.interrupt(fiber))
    },
  }
}

// Use in component
const store = createStore(walletStateRef)

export const useWalletState = () => {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  )
}
```

## Testing

Testing Effect-based code with vitest.

### Testing Effects

```typescript
import {describe, it, expect} from 'vitest'
import {Effect} from 'effect'

describe('Effect tests', () => {
  it('should succeed with expected value', async () => {
    const effect = Effect.succeed(42)
    const result = await Effect.runPromise(effect)
    expect(result).toBe(42)
  })

  it('should fail with expected error', async () => {
    const effect = Effect.fail(new Error('expected'))
    await expect(Effect.runPromise(effect)).rejects.toThrow('expected')
  })

  it('should handle either result', async () => {
    const effect = Effect.succeed(42)
    const either = await Effect.runPromise(Effect.either(effect))
    expect(Either.isRight(either)).toBe(true)
    if (Either.isRight(either)) {
      expect(either.right).toBe(42)
    }
  })
})
```

### Testing Services with Layers

```typescript
import {describe, it, expect} from 'vitest'
import {Effect, Layer} from 'effect'

// Test implementation
const TestUserService = Layer.succeed(
  UserService,
  {
    getUser: (id) => Effect.succeed({id, name: 'Test User'}),
    updateUser: (user) => Effect.void,
  },
)

describe('Service tests', () => {
  it('should use test service', async () => {
    const program = Effect.gen(function* () {
      const service = yield* UserService
      return yield* service.getUser('123')
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestUserService)),
    )

    expect(result.name).toBe('Test User')
  })
})
```

### Testing Streams

```typescript
import {describe, it, expect} from 'vitest'
import {Stream, Effect, Chunk} from 'effect'

describe('Stream tests', () => {
  it('should collect stream values', async () => {
    const stream = Stream.fromIterable([1, 2, 3])
    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(Chunk.toArray(result)).toEqual([1, 2, 3])
  })

  it('should transform stream', async () => {
    const stream = Stream.fromIterable([1, 2, 3]).pipe(
      Stream.map((n) => n * 2),
    )
    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(Chunk.toArray(result)).toEqual([2, 4, 6])
  })
})
```

### Testing with Mocked Dependencies

```typescript
import {describe, it, expect, vi} from 'vitest'
import {Effect, Layer} from 'effect'

describe('Mocked service tests', () => {
  it('should track service calls', async () => {
    const mockGetUser = vi.fn().mockReturnValue(
      Effect.succeed({id: '123', name: 'Mock User'}),
    )

    const MockUserService = Layer.succeed(
      UserService,
      {
        getUser: mockGetUser,
        updateUser: () => Effect.void,
      },
    )

    const program = Effect.gen(function* () {
      const service = yield* UserService
      return yield* service.getUser('123')
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(MockUserService)),
    )

    expect(mockGetUser).toHaveBeenCalledWith('123')
  })
})
```

### Testing Refs

```typescript
import {describe, it, expect} from 'vitest'
import {Ref, Effect} from 'effect'

describe('Ref tests', () => {
  it('should update ref value', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make(0)
        yield* Ref.update(ref, (n) => n + 1)
        yield* Ref.update(ref, (n) => n + 1)
        return yield* Ref.get(ref)
      }),
    )
    expect(result).toBe(2)
  })
})
```

### Testing with Module-Level State

When testing code that uses module-level state (Maps, Sets, caches), always clear state in **both** `beforeEach` and `afterEach` to prevent test interference:

```typescript
import {beforeEach, afterEach, describe, it, expect} from 'vitest'
import * as Cache from './cache.js'

describe('checkEligibility', () => {
  // Clear before each test to ensure clean state
  beforeEach(() => {
    Cache.invalidateAll()
  })

  // Clear after each test for cleanup
  afterEach(() => {
    Cache.invalidateAll()
  })

  it('returns cached allocation', async () => {
    const testAddr = 'addr1cached'
    const allocation = createMockAllocation({address: testAddr})
    
    // Cache key must match the data within for realistic testing
    Cache.set(testAddr, allocation)

    // Should not call external APIs when cached
    global.fetch = vi.fn().mockRejectedValue(new Error('Should not be called'))

    const result = await Effect.runPromise(checkEligibility(testAddr))

    expect(result.address).toBe(testAddr)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
```

**Key principles:**
- **beforeEach**: Ensures each test starts with clean state (prevents interference from previous tests)
- **afterEach**: Cleans up after each test (good hygiene)
- **Realistic data**: Cache keys should match the data they contain (e.g., don't cache `{address: 'addr1test'}` under key `'addr1cached'`)
- **Mock external calls**: Verify cached data prevents unnecessary API calls

## References

- [Effect Documentation](https://effect.website/)
- [Effect GitHub](https://github.com/Effect-TS/effect)
- [Effect Discord](https://discord.gg/effect-ts)

## Examples in this repo

- **Wallet manager**: `packages/wallet/account/wallet-manager.ts`
- **URI parser**: `packages/links/parser.ts`
- **Remote config**: `packages/config/remote-config.ts`
- **Encrypted backup (Argon2id + XChaCha20 over `@pnyx/crypto`)**: `app/src/utils/encrypted-backup.ts`
