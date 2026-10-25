# Using Effect in React

This guide covers patterns for integrating Effect services with React components in the wallet app.

## Overview

Effect services run outside React's component lifecycle. This guide shows how to:
- Provide Effect services to React components
- Fetch data using Effect (replacing react-query)
- Manage state using Effect (replacing zustand hooks)
- Handle subscriptions and cleanup

## Provider Pattern

### Runtime Context

Create a React context that provides the Effect runtime:

> ⚠️ **This sample is not what the app runs, and it has three defects.** The runtime it builds is never
> disposed; `useMemo` is the wrong hook for creating a resource (React may recompute it, StrictMode runs
> it twice, and the discarded runtime leaks); and a context-provided runtime cannot be reached from the
> 47 of the app's 86 `Effect.provide` sites that live in non-React `services/`. What shipped instead was
> a **module-level** runtime carrying only the stateless `Codec`/`Decode` layers — and it is gone too:
> `Codec` is no longer a service anyone requires, so what remains is the single
> `cardanoDecodeLayer` in `app/src/services/cardano-decode-layer.ts`, provided where `Decode`
> is actually needed. See the Phase B second-half section of `EFFECT_MIGRATION.md`.

```typescript
// providers/RuntimeProvider.tsx
import {createContext, useContext, useMemo, type ReactNode} from 'react'
import {ManagedRuntime, Layer} from 'effect'

// Define your app's services
type AppServices = WalletService | StorageService | ApiService

// Create context
const RuntimeContext = createContext<ManagedRuntime<AppServices, never> | null>(null)

// Provider component
export const RuntimeProvider = ({
  children,
  layer,
}: {
  children: ReactNode
  layer: Layer.Layer<AppServices, never, never>
}) => {
  const runtime = useMemo(
    () => ManagedRuntime.make(layer),
    [layer],
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
  if (!runtime) {
    throw new Error('useRuntime must be used within RuntimeProvider')
  }
  return runtime
}
```

### App Setup

```typescript
// app/_layout.tsx
import {RuntimeProvider} from '@/providers/RuntimeProvider'
import {AppServicesLive} from '@/services'

export default function RootLayout() {
  return (
    <RuntimeProvider layer={AppServicesLive}>
      <ThemeProvider>
        <Stack />
      </ThemeProvider>
    </RuntimeProvider>
  )
}
```

### Services Layer

```typescript
// services/index.ts
import {Layer} from 'effect'

// Combine all service layers
export const AppServicesLive = Layer.mergeAll(
  WalletServiceLive,
  StorageServiceLive,
  ApiServiceLive,
)

// For testing
export const AppServicesTest = Layer.mergeAll(
  WalletServiceTest,
  MemoryStorageLive,
  MockApiServiceLive,
)
```

## Data Fetching (replacing react-query)

### Basic Data Hook

```typescript
// hooks/useEffect.ts
import {useEffect, useState, useCallback} from 'react'
import {Effect} from 'effect'

type UseEffectState<A, E> = {
  data: A | null
  error: E | null
  loading: boolean
}

export function useEffectQuery<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deps: unknown[] = [],
) {
  const runtime = useRuntime()
  const [state, setState] = useState<UseEffectState<A, E>>({
    data: null,
    error: null,
    loading: true,
  })

  useEffect(() => {
    const controller = new AbortController()
    setState((s) => ({...s, loading: true}))

    runtime.runPromise(effect, {signal: controller.signal}).then(
      (data) => setState({data, error: null, loading: false}),
      (error) => setState({data: null, error: error as E, loading: false}),
    )

    return () => controller.abort()
  }, [runtime, ...deps])

  return state
}
```

### Balance Hook Example

```typescript
// hooks/useBalance.ts
import {Effect} from 'effect'

export function useBalance(address: string) {
  const query = useMemo(
    () =>
      Effect.gen(function* () {
        const wallet = yield* WalletService
        return yield* wallet.getBalance(address)
      }),
    [address],
  )

  return useEffectQuery(query, [address])
}

// Usage in component
function BalanceDisplay({address}: {address: string}) {
  const {data: balance, loading, error} = useBalance(address)

  if (loading) return <ActivityIndicator />
  if (error) return <Text>Error: {error.message}</Text>
  return <Text>Balance: {balance?.toString()}</Text>
}
```

### Mutation Hook

```typescript
// hooks/useEffectMutation.ts
import {useState, useCallback} from 'react'
import {Effect} from 'effect'

export function useEffectMutation<A, E, R, Args extends unknown[]>(
  effectFn: (...args: Args) => Effect.Effect<A, E, R>,
) {
  const runtime = useRuntime()
  const [state, setState] = useState<{
    data: A | null
    error: E | null
    loading: boolean
  }>({
    data: null,
    error: null,
    loading: false,
  })

  const mutate = useCallback(
    async (...args: Args) => {
      setState((s) => ({...s, loading: true}))

      try {
        const data = await runtime.runPromise(effectFn(...args))
        setState({data, error: null, loading: false})
        return data
      } catch (error) {
        setState({data: null, error: error as E, loading: false})
        throw error
      }
    },
    [runtime, effectFn],
  )

  return {...state, mutate}
}

// Usage
function SendButton({to, amount}: {to: string; amount: bigint}) {
  const {mutate: send, loading} = useEffectMutation(
    (to: string, amount: bigint) =>
      Effect.gen(function* () {
        const wallet = yield* WalletService
        return yield* wallet.sendTransaction(to, amount)
      }),
  )

  return (
    <Button
      onPress={() => send(to, amount)}
      disabled={loading}
    >
      {loading ? 'Sending...' : 'Send'}
    </Button>
  )
}
```

### Query with Refetch

```typescript
// hooks/useEffectQueryWithRefetch.ts
export function useEffectQueryWithRefetch<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deps: unknown[] = [],
) {
  const runtime = useRuntime()
  const [state, setState] = useState<UseEffectState<A, E>>({
    data: null,
    error: null,
    loading: true,
  })
  const [refetchCounter, setRefetchCounter] = useState(0)

  const refetch = useCallback(() => {
    setRefetchCounter((c) => c + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setState((s) => ({...s, loading: true}))

    runtime.runPromise(effect, {signal: controller.signal}).then(
      (data) => setState({data, error: null, loading: false}),
      (error) => setState({data: null, error: error as E, loading: false}),
    )

    return () => controller.abort()
  }, [runtime, refetchCounter, ...deps])

  return {...state, refetch}
}
```

## State Management (replacing zustand hooks)

### useSyncExternalStore Pattern

For reactive state that updates components automatically.

> **This is now implemented, and it diverges from the sample below in two ways** — see
> `app/src/hooks/useServiceState.ts`, which is the authority. It takes a **selector** and a
> `SubscriptionRef | undefined`, returning `S | undefined`: a whole-value read re-renders on every
> write, and the services that own these refs are built asynchronously, so a caller does not have the
> ref on its first render. And it does not call `useRuntime()` — there is no `ManagedRuntime` yet
> (Phase B's second half), so the subscription forks on the default runtime via
> `hooks/service-state-subscription.ts`. Treat the sample as the shape, not the signature.

```typescript
// hooks/useServiceState.ts
import {useSyncExternalStore, useCallback, useRef, useEffect} from 'react'
import {Effect, SubscriptionRef, Stream, Fiber} from 'effect'

export function useServiceState<A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
): A {
  const runtime = useRuntime()

  // Get initial value synchronously
  const getSnapshot = useCallback(
    () => Effect.runSync(SubscriptionRef.get(ref)),
    [ref],
  )

  // Subscribe to changes
  const subscribe = useCallback(
    (callback: () => void) => {
      const fiber = runtime.runFork(
        Stream.runForEach(
          SubscriptionRef.changes(ref),
          () => {
            callback()
            return Effect.void
          },
        ),
      )

      return () => {
        Effect.runSync(Fiber.interrupt(fiber))
      }
    },
    [ref, runtime],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
```

### Service-Based State Hook

```typescript
// hooks/useWalletState.ts
export function useWalletState() {
  const runtime = useRuntime()

  // Access the service's internal SubscriptionRef
  // This requires the service to expose it
  const ref = useMemo(() => {
    return runtime.runSync(
      Effect.gen(function* () {
        const wallet = yield* WalletService
        return wallet.stateRef // Exposed SubscriptionRef
      }),
    )
  }, [runtime])

  return useServiceState(ref)
}

// Service with exposed ref
const makeWalletService = Effect.gen(function* () {
  const stateRef = yield* SubscriptionRef.make<WalletState>({
    balance: 0n,
    address: null,
    syncing: false,
  })

  return {
    stateRef, // Expose for React hooks

    getState: () => SubscriptionRef.get(stateRef),
    setBalance: (balance: bigint) =>
      SubscriptionRef.update(stateRef, (s) => ({...s, balance})),
    // ... other methods
  }
})
```

### Selector Pattern

```typescript
// hooks/useWalletBalance.ts
export function useWalletBalance(): bigint {
  const state = useWalletState()
  return state.balance
}

// Or with memo for derived values
export function useFiatValue(): number {
  const state = useWalletState()
  const price = usePriceState()

  return useMemo(
    () => (Number(state.balance) * price) / 1_000_000,
    [state.balance, price],
  )
}
```

## Subscription Handling

### Stream Subscription Hook

```typescript
// hooks/useStream.ts
import {useEffect, useState} from 'react'
import {Stream, Effect} from 'effect'

export function useStream<A, E>(
  stream: Stream.Stream<A, E, AppServices>,
  onValue: (value: A) => void,
) {
  const runtime = useRuntime()
  const [error, setError] = useState<E | null>(null)

  useEffect(() => {
    const fiber = runtime.runFork(
      Stream.runForEach(stream, (value) => {
        onValue(value)
        return Effect.void
      }).pipe(
        Effect.catchAll((e) => {
          setError(e as E)
          return Effect.void
        }),
      ),
    )

    return () => {
      Effect.runSync(Fiber.interrupt(fiber))
    }
  }, [stream, onValue, runtime])

  return {error}
}
```

### Event Subscription Example

```typescript
// components/TransactionNotifications.tsx
function TransactionNotifications() {
  const runtime = useRuntime()
  const [notifications, setNotifications] = useState<Transaction[]>([])

  useEffect(() => {
    const fiber = runtime.runFork(
      Effect.gen(function* () {
        const events = yield* EventService
        yield* Stream.runForEach(
          events.transactions(),
          (tx) => {
            setNotifications((prev) => [...prev, tx])
            return Effect.void
          },
        )
      }),
    )

    return () => {
      Effect.runSync(Fiber.interrupt(fiber))
    }
  }, [runtime])

  return (
    <View>
      {notifications.map((tx) => (
        <TransactionCard key={tx.id} transaction={tx} />
      ))}
    </View>
  )
}
```

## Error Boundaries

### Effect Error Boundary

```typescript
// components/EffectErrorBoundary.tsx
import {Component, type ReactNode} from 'react'

interface Props {
  children: ReactNode
  fallback: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

export class EffectErrorBoundary extends Component<Props, State> {
  state: State = {error: null}

  static getDerivedStateFromError(error: Error): State {
    return {error}
  }

  reset = () => {
    this.setState({error: null})
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset)
    }
    return this.props.children
  }
}

// Usage
<EffectErrorBoundary
  fallback={(error, reset) => (
    <View>
      <Text>Error: {error.message}</Text>
      <Button onPress={reset}>Retry</Button>
    </View>
  )}
>
  <WalletScreen />
</EffectErrorBoundary>
```

## Complete Example: Wallet Provider

```typescript
// providers/WalletProvider.tsx
import {createContext, useContext, type ReactNode} from 'react'
import {Effect, Layer} from 'effect'

interface WalletContextValue {
  address: string | null
  balance: bigint
  loading: boolean
  sync: () => Promise<void>
  send: (to: string, amount: bigint) => Promise<string>
}

const WalletContext = createContext<WalletContextValue | null>(null)

export function WalletProvider({children}: {children: ReactNode}) {
  const runtime = useRuntime()
  const state = useWalletState()

  const sync = useCallback(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const wallet = yield* WalletService
        yield* wallet.sync()
      }),
    )
  }, [runtime])

  const send = useCallback(
    async (to: string, amount: bigint) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const wallet = yield* WalletService
          return yield* wallet.sendTransaction(to, amount)
        }),
      )
    },
    [runtime],
  )

  const value: WalletContextValue = {
    address: state.address,
    balance: state.balance,
    loading: state.syncing,
    sync,
    send,
  }

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within WalletProvider')
  }
  return context
}
```

## Testing Components

### Mock Runtime Provider

```typescript
// test-utils/MockRuntimeProvider.tsx
import {Layer} from 'effect'

export const MockRuntimeProvider = ({
  children,
  overrides = {},
}: {
  children: ReactNode
  overrides?: Partial<{
    wallet: WalletService
    storage: StorageService
  }>
}) => {
  const mockLayer = Layer.mergeAll(
    overrides.wallet
      ? Layer.succeed(WalletService, overrides.wallet)
      : MockWalletServiceLive,
    overrides.storage
      ? Layer.succeed(StorageService, overrides.storage)
      : MemoryStorageLive,
  )

  return (
    <RuntimeProvider layer={mockLayer}>
      {children}
    </RuntimeProvider>
  )
}
```

### Component Test Example

```typescript
// components/BalanceDisplay.test.tsx
import {render, screen, waitFor} from '@testing-library/react-native'
import {Layer, Effect} from 'effect'

describe('BalanceDisplay', () => {
  it('shows balance from service', async () => {
    const mockWallet = {
      getBalance: () => Effect.succeed(1000000n),
      // ... other methods
    }

    render(
      <MockRuntimeProvider overrides={{wallet: mockWallet}}>
        <BalanceDisplay address="addr1..." />
      </MockRuntimeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('1000000')).toBeTruthy()
    })
  })
})
```

## Best Practices

### 1. Keep Effects Out of Render

Effects should run in `useEffect`, not during render:

```typescript
// Good
useEffect(() => {
  runtime.runPromise(effect)
}, [])

// Bad - runs on every render
const data = runtime.runSync(effect)
```

### 2. Use Cancellation

Always support cancellation for async effects:

```typescript
useEffect(() => {
  const controller = new AbortController()

  runtime.runPromise(effect, {signal: controller.signal})

  return () => controller.abort()
}, [])
```

### 3. Memoize Effect Definitions

Prevent effect recreation on every render:

```typescript
// Good
const effect = useMemo(
  () => Effect.gen(function* () { /* ... */ }),
  [address], // Only recreate when address changes
)

// Bad - new effect on every render
const effect = Effect.gen(function* () { /* ... */ })
```

### 4. Prefer Services Over Direct Effects

Use services for business logic, effects for orchestration:

```typescript
// Good - logic in service
const wallet = yield* WalletService
yield* wallet.sync()

// Avoid - logic spread across components
yield* fetchUTXOs(address)
yield* updateBalance(utxos)
yield* saveToStorage(wallet)
```

## References

- [EFFECT_PATTERNS.md](./EFFECT_PATTERNS.md) - Core Effect patterns
- [MIGRATION_ZUSTAND.md](./MIGRATION_ZUSTAND.md) - Zustand to Effect migration
- [Effect React Integration](https://effect.website/docs/react)
- [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
