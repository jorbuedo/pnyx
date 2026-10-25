/**
 * React hooks over the pool / DRep metadata services, bound to the active
 * Cardano network. Same pattern as `cardano-assets`: a module-level session
 * cache (with a short retry TTL for the `null`/unresolved case) plus an
 * `active`-guarded effect — no react-query in this app.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {getActiveCardanoNetwork, onCardanoNetworkChange} from '../cardano/config'
import {getPoolDRepConfig, getPoolDRepRegisterConfig} from './config'
import {type DRepInfo, type DRepListEntry, fetchDRepInfo, fetchDRepList} from './drep'
import {fetchPoolInfo, fetchPoolList, type PoolInfo} from './pool'

const network = getActiveCardanoNetwork

// Unresolved (null) results retry after this window; hits are kept for the session.
const NULL_TTL_MS = 5 * 60_000

type Cached<T> = {readonly at: number; readonly value: T | null}
const poolCache = new Map<string, Cached<PoolInfo>>()
const drepCache = new Map<string, Cached<DRepInfo>>()

// Pool / DRep ids are not network-qualified — drop both when the rail moves.
onCardanoNetworkChange(() => {
  poolCache.clear()
  drepCache.clear()
})

const fresh = <T>(cell: Cached<T> | undefined): cell is Cached<T> =>
  cell !== undefined && (cell.value !== null || Date.now() - cell.at < NULL_TTL_MS)

/**
 * Resolve pool metadata for `poolId` (`pool1…` bech32 or hex). `null`/empty →
 * no lookup. Returns `{info, loading}`; `info` is `null` until resolved or when
 * the pool is unknown (the caller renders the bech32 id as the fallback).
 */
export const usePoolInfo = (poolId: string | undefined): {info: PoolInfo | null; loading: boolean} => {
  const [info, setInfo] = useState<PoolInfo | null>(() => (poolId ? (poolCache.get(poolId)?.value ?? null) : null))
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!poolId) {
      setInfo(null)
      return
    }
    const cached = poolCache.get(poolId)
    if (fresh(cached)) {
      setInfo(cached.value)
      return
    }
    let active = true
    setLoading(true)
    void Effect.runPromise(fetchPoolInfo(poolId, getPoolDRepRegisterConfig(network())))
      .then((value) => {
        poolCache.set(poolId, {at: Date.now(), value})
        if (active) setInfo(value)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [poolId])

  return {info, loading}
}

/**
 * Resolve DRep metadata for a `drep1…` id. A non-`drep1` value (abstain /
 * no-confidence / empty) is not looked up. Returns `{info, loading}`.
 */
export const useDRepInfo = (drepId: string | undefined): {info: DRepInfo | null; loading: boolean} => {
  // abstain / no-confidence / empty are not `drep1…` ids → skip the lookup.
  const id = drepId?.startsWith('drep1') === true ? drepId : undefined
  const [info, setInfo] = useState<DRepInfo | null>(() => (id ? (drepCache.get(id)?.value ?? null) : null))
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (id === undefined) {
      setInfo(null)
      return
    }
    const cached = drepCache.get(id)
    if (fresh(cached)) {
      setInfo(cached.value)
      return
    }
    let active = true
    setLoading(true)
    void Effect.runPromise(fetchDRepInfo(id, getPoolDRepRegisterConfig(network())))
      .then((value) => {
        drepCache.set(id, {at: Date.now(), value})
        if (active) setInfo(value)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [id])

  return {info, loading}
}

/**
 * Full pool list for the picker. `list === null` + `failed` after an
 * unreachable backend; `reload` retries (the service TTL-caches successes).
 */
export const usePoolList = (): {list: readonly PoolInfo[] | null; loading: boolean; reload: () => void} => {
  const [list, setList] = useState<readonly PoolInfo[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the manual refresh trigger.
  useEffect(() => {
    let active = true
    setLoading(true)
    void Effect.runPromise(fetchPoolList(getPoolDRepConfig(network())))
      .then((value) => {
        if (active) setList(value)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [nonce])

  return {list, loading, reload: () => setNonce((n) => n + 1)}
}

/** Full DRep list for the picker (see `fetchDRepList` for the network split). */
export const useDRepList = (): {list: readonly DRepListEntry[] | null; loading: boolean; reload: () => void} => {
  const [list, setList] = useState<readonly DRepListEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the manual refresh trigger.
  useEffect(() => {
    let active = true
    setLoading(true)
    void Effect.runPromise(fetchDRepList(getPoolDRepConfig(network())))
      .then((value) => {
        if (active) setList(value)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [nonce])

  return {list, loading, reload: () => setNonce((n) => n + 1)}
}
