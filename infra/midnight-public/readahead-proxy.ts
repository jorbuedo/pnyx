/**
 * Read-ahead WebSocket proxy for the Midnight indexer's catch-up walk.
 *
 * `chain-indexer` walks the chain one block at a time and waits for every answer:
 * measured against the public RPC, 11 requests per block at ~48 ms each, which is ~16 days for
 * mainnet's 2.8 M blocks while the link idles at 2 KiB/s. The same RPC serves 875 blocks/s when
 * the questions overlap, so the fix is not a faster machine or a bigger pipe: it is to ask ahead.
 *
 * This proxy keeps the indexer's sequential conversation and answers it from a cache filled by
 * parallel upstream requests. The indexer cannot tell the difference.
 *
 * The per-block request set is a fixed template parameterised only by the block hash:
 *
 *   archive_v1_hashByHeight [height]        -> [hash]
 *   archive_v1_header       [hash]          (asked twice)
 *   archive_v1_body         [hash]
 *   archive_v1_call         [hash, fn, args] for Core_version, MidnightRuntimeApi_get_zswap_state_root,
 *                                            SystemParametersApi_get_terms_and_conditions, _get_d_parameter
 *   archive_v1_storage      [hash, items, null] -> operation id, then storageEvent notifications
 *                                                  terminated by `storageDone`, then stopStorage
 *
 * Templates are also **learned**: a request whose parameters contain a block hash we know is
 * recorded and prefetched from then on, so a runtime upgrade that changes the call set costs one
 * slow block rather than a broken proxy. Only calls whose arguments are the same for every block
 * qualify, and the learned set is capped -- see `learn`.
 *
 * Everything not recognised (chainHead_v1_follow and its events, rpc_methods, genesisHash) is
 * passed through on a dedicated per-client connection, so subscription ids stay the upstream's.
 */

import {decideTemplate} from './template-learning.js'

type Json = unknown
type RpcRequest = {jsonrpc?: string; id?: number | string; method?: string; params?: Json}
type RpcResponse = {jsonrpc: '2.0'; id: number | string; result?: Json; error?: Json}

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`${name} is required`)
  return v
}
const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got ${raw}`)
  return n
}

const UPSTREAM = env('PNYX_UPSTREAM_WS')
const PORT = num('PNYX_PROXY_PORT', 9944)
const DEPTH = num('PNYX_PREFETCH_DEPTH', 96)
const CONNS = num('PNYX_UPSTREAM_CONNS', 8)
const INFLIGHT = num('PNYX_MAX_INFLIGHT', 256)
const MISS_CONNS = num('PNYX_MISS_CONNS', 2)
const CONNECT_TIMEOUT_MS = num('PNYX_CONNECT_TIMEOUT_MS', 15_000)

const log = (level: 'info' | 'warn' | 'error', message: string, kvs: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({t: new Date().toISOString(), level, message, ...kvs}))

// Constructed minus released. This is intent, not truth: the leak that took down the LAN was
// precisely Bun holding a socket open that we believed we had closed, so compare it against
// `netstat -an | grep ESTABLISHED` rather than trusting it alone.
const sockets = {opened: 0, released: 0}
const liveSockets = (): number => sockets.opened - sockets.released

/** A block's cached answers. `storage` holds the storageEvent payloads, not the opaque operation id. */
type BlockEntry = {hash: string; answers: Map<string, Json>; storage: Map<string, Json[]>}

const keyOf = (method: string, params: Json): string => `${method}|${JSON.stringify(params ?? null)}`

/** One upstream connection, multiplexing many in-flight requests over a single socket. */
class Upstream {
  private ws: WebSocket | undefined
  private nextId = 1
  private readonly pending = new Map<number, {resolve: (v: Json) => void; reject: (e: Error) => void}>()
  private readonly subscriptions = new Map<string, (params: Json) => void>()
  private ready: Promise<void> | undefined

  constructor(
    private readonly url: string,
    private readonly label: string,
  ) {}

  private connect(): Promise<void> {
    if (this.ready !== undefined) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      sockets.opened += 1
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        sockets.released += 1
      }
      // Bun leaves an errored or never-completed socket in ESTABLISHED with no close frame, so a
      // retrying caller orphans one per attempt — 3,652 of them across three days, which exhausted
      // the NAT table of the router in front of it. Every exit from this promise closes the socket.
      const discard = (why: string, error: Error): void => {
        try {
          ws.close()
        } catch (e) {
          log('warn', 'upstream close failed', {label: this.label, why, error: String(e)})
        }
        release()
        if (this.ws === ws) {
          this.ready = undefined
          this.ws = undefined
        }
        reject(error)
      }
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          const error = new Error(`upstream connect timed out after ${CONNECT_TIMEOUT_MS} ms`)
          log('warn', 'upstream connect timed out', {label: this.label, ms: CONNECT_TIMEOUT_MS})
          discard('connect-timeout', error)
        }
      }, CONNECT_TIMEOUT_MS)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = (event) => {
        clearTimeout(timer)
        const error = new Error(`upstream socket error: ${String((event as {message?: string}).message ?? event)}`)
        log('warn', 'upstream error', {label: this.label, error: error.message})
        discard('socket-error', error)
      }
      ws.onclose = () => {
        clearTimeout(timer)
        release()
        // `discard` can have reconnected before this fires, in which case `this.ws` is a newer
        // socket that owns the pending map: clearing it here would orphan that socket ESTABLISHED
        // with nothing referencing it, one per upstream error.
        if (this.ws !== undefined && this.ws !== ws) {
          log('warn', 'stale upstream closed, keeping live socket', {label: this.label, live: liveSockets()})
          return
        }
        log('warn', 'upstream closed, dropping in-flight requests', {label: this.label, inFlight: this.pending.size})
        for (const [, p] of this.pending) p.reject(new Error('upstream closed'))
        this.pending.clear()
        this.subscriptions.clear()
        this.ready = undefined
        this.ws = undefined
      }
      ws.onmessage = (event) => this.onMessage(String(event.data))
    })
    return this.ready
  }

  private onMessage(raw: string): void {
    let msg: RpcResponse & RpcRequest
    try {
      msg = JSON.parse(raw) as RpcResponse & RpcRequest
    } catch (e) {
      log('warn', 'upstream sent unparseable frame', {label: this.label, error: String(e), bytes: raw.length})
      return
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      if (p === undefined) return
      this.pending.delete(msg.id)
      if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result ?? null)
      return
    }
    if (typeof msg.method === 'string') {
      const params = msg.params as {subscription?: string} | undefined
      const sub = params?.subscription
      if (typeof sub === 'string') {
        const handler = this.subscriptions.get(sub)
        if (handler === undefined) return

        handler(msg.params ?? null)
      }
    }
  }

  async call(method: string, params: Json): Promise<Json> {
    await this.connect()
    const ws = this.ws
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) throw new Error('upstream not open')
    const id = this.nextId++
    const promise = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, {resolve, reject})
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout after 60s: ${method}`))
      }, 60_000)
    })
    ws.send(JSON.stringify({jsonrpc: '2.0', id, method, params}))
    return promise
  }

  /** Run a storage operation to completion, returning the storageEvent payloads in order. */
  async storage(params: Json): Promise<Json[]> {
    const events: Json[] = []
    const done = Promise.withResolvers<void>()
    const opId = (await this.call('archive_v1_storage', params)) as string
    if (typeof opId !== 'string') throw new Error(`archive_v1_storage returned ${JSON.stringify(opId)}`)
    this.subscriptions.set(opId, (p) => {
      const result = (p as {result?: {event?: string}})?.result
      events.push((p as {result?: Json}).result ?? null)
      if (result?.event === 'storageDone') done.resolve()
    })
    const timer = setTimeout(() => done.reject(new Error('storage operation did not finish in 60s')), 60_000)
    try {
      await done.promise
    } finally {
      clearTimeout(timer)
      this.subscriptions.delete(opId)
      this.call('archive_v1_stopStorage', [opId]).catch((e) =>
        log('warn', 'stopStorage failed', {label: this.label, operation: opId, error: String(e)}),
      )
    }
    return events
  }

  /** Forward a client subscription's notifications. Used by the pass-through path only. */
  track(subscription: string, handler: (params: Json) => void): void {
    this.subscriptions.set(subscription, handler)
  }

  /** Release the socket. The pass-through path builds one Upstream per client, so without this
   * every client reconnect orphans one -- and the indexer reconnects on every restart. */
  close(): void {
    const ws = this.ws
    this.ready = undefined
    this.ws = undefined
    if (ws === undefined) return
    try {
      ws.close()
    } catch (e) {
      log('warn', 'upstream close failed', {label: this.label, why: 'explicit', error: String(e)})
    }
  }
}

const pool = Array.from({length: CONNS}, (_, i) => new Upstream(UPSTREAM, `pool-${i}`))
let rr = 0
const nextUpstream = (): Upstream => {
  const u = pool[rr % pool.length]
  rr += 1
  if (u === undefined) throw new Error('upstream pool is empty')
  return u
}

// Prefetch keeps up to INFLIGHT/8 heights in flight, ~12 calls each, so a cache miss sharing the
// pool queues behind hundreds of requests that nobody is waiting on. The miss is the only call the
// indexer actually blocks on, so it gets sockets of its own.
const missPool = Array.from({length: MISS_CONNS}, (_, i) => new Upstream(UPSTREAM, `miss-${i}`))
let missRr = 0
const nextMiss = (): Upstream => {
  const u = missPool[missRr % missPool.length]
  missRr += 1
  if (u === undefined) throw new Error('miss pool is empty')
  return u
}

/** Per-block request templates, seeded from a measured walk and extended by observation. */
const callTemplates = new Set<string>([
  JSON.stringify(['Core_version', '0x']),
  JSON.stringify(['MidnightRuntimeApi_get_zswap_state_root', '0x']),
  JSON.stringify(['SystemParametersApi_get_terms_and_conditions', '0x']),
  JSON.stringify(['SystemParametersApi_get_d_parameter', '0x']),
])
const storageTemplates = new Set<string>([
  JSON.stringify([[{key: '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7', type: 'value'}], null]),
])

// A warm height holds a header, a body and ~10 call/storage answers, so the cache is the process's
// whole footprint. Bound it by count rather than trusting the window to keep moving. That "~10" is
// an assumption this bound depends on, and `template-learning.ts` is what keeps it true.
const MAX_WARM = DEPTH * 8

const blocks = new Map<number, BlockEntry>()
const heightOfHash = new Map<string, number>()
let cursor = 0
let prefetchTop = 0
let running = 0
let chainTipReached = false
const stats = {hits: 0, misses: 0, prefetched: 0, failures: 0}

// Two numbers that between them account for the whole wall clock: how long the indexer waits on us
// (missMs, the only blocking upstream work) and how long we wait on the indexer (idleMs, the gap
// between answering one request and receiving the next). Whichever dominates owns the stall.
const timing = {missMs: 0, missMax: 0, idleMs: 0, idleMax: 0, byMethod: new Map<string, {n: number; ms: number}>()}
let lastReplyAt: number | undefined

const noteMiss = (method: string, ms: number): void => {
  timing.missMs += ms
  if (ms > timing.missMax) timing.missMax = ms
  const m = timing.byMethod.get(method) ?? {n: 0, ms: 0}
  m.n += 1
  m.ms += ms
  timing.byMethod.set(method, m)
}

const noteIdle = (): void => {
  if (lastReplyAt === undefined) return
  const gap = performance.now() - lastReplyAt
  lastReplyAt = undefined
  timing.idleMs += gap
  if (gap > timing.idleMax) timing.idleMax = gap
}

const slowestMethods = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [method, m] of [...timing.byMethod].sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)) {
    out[method] = `${m.n}x ${Math.round(m.ms)}ms`
  }
  return out
}

const evictBelow = (height: number): void => {
  for (const [h, entry] of blocks) {
    if (h >= height) continue
    blocks.delete(h)
    heightOfHash.delete(entry.hash)
  }
}

/** Fetch one height's whole template set in parallel and cache it. */
const prefetchHeight = async (height: number): Promise<void> => {
  if (blocks.has(height)) return
  const up = nextUpstream()
  const hashes = (await up.call('archive_v1_hashByHeight', [height])) as string[]
  const hash = Array.isArray(hashes) ? hashes[0] : undefined
  if (typeof hash !== 'string') {
    chainTipReached = true
    return
  }
  chainTipReached = false
  const entry: BlockEntry = {hash, answers: new Map(), storage: new Map()}
  entry.answers.set(keyOf('archive_v1_hashByHeight', [height]), hashes)

  const work: Promise<void>[] = [
    nextUpstream()
      .call('archive_v1_header', [hash])
      .then((r) => void entry.answers.set(keyOf('archive_v1_header', [hash]), r)),
    nextUpstream()
      .call('archive_v1_body', [hash])
      .then((r) => void entry.answers.set(keyOf('archive_v1_body', [hash]), r)),
  ]
  for (const tpl of callTemplates) {
    const [fn, args] = JSON.parse(tpl) as [string, string]
    const params = [hash, fn, args]
    work.push(
      nextUpstream()
        .call('archive_v1_call', params)
        .then((r) => void entry.answers.set(keyOf('archive_v1_call', params), r)),
    )
  }
  for (const tpl of storageTemplates) {
    const [items, child] = JSON.parse(tpl) as [Json, Json]
    const params = [hash, items, child]
    work.push(
      nextUpstream()
        .storage(params)
        .then((events) => void entry.storage.set(keyOf('archive_v1_storage', params), events)),
    )
  }
  await Promise.all(work)
  blocks.set(height, entry)
  heightOfHash.set(hash, height)
  stats.prefetched += 1
}

/** Keep `DEPTH` heights ahead of the indexer warm, bounded by in-flight work. */
const pump = (): void => {
  while (running < INFLIGHT / 8 && prefetchTop < cursor + DEPTH && !chainTipReached) {
    const height = prefetchTop
    prefetchTop += 1
    running += 1
    prefetchHeight(height)
      .catch((e) => {
        stats.failures += 1
        blocks.delete(height)
        if (height < prefetchTop) prefetchTop = height
        log('warn', 'prefetch failed, will retry', {height, error: String(e)})
      })
      .finally(() => {
        running -= 1
      })
  }
}
setInterval(pump, 50)
setInterval(() => {
  if (chainTipReached) prefetchTop = Math.max(prefetchTop - 1, cursor)
}, 6_000)
setInterval(() => {
  log('info', 'readahead', {
    cursor,
    prefetchTop,
    warm: blocks.size,
    sockets: liveSockets(),
    ...stats,
    hitRate: stats.hits + stats.misses === 0 ? 0 : +(stats.hits / (stats.hits + stats.misses)).toFixed(3),
    missMs: Math.round(timing.missMs),
    missMax: Math.round(timing.missMax),
    idleMs: Math.round(timing.idleMs),
    idleMax: Math.round(timing.idleMax),
    slowest: slowestMethods(),
  })
  timing.missMs = 0
  timing.missMax = 0
  timing.idleMs = 0
  timing.idleMax = 0
  timing.byMethod.clear()
}, 30_000)

let capWarned = false

/** Learn a template from a request the indexer made against a block we know. */
const learn = (method: string, params: Json): void => {
  const decision = decideTemplate(method, params, {
    knowsBlock: (hash) => heightOfHash.has(hash),
    callTemplates,
    storageTemplates,
  })
  if (decision.verdict === 'learn') {
    ;(decision.kind === 'call' ? callTemplates : storageTemplates).add(decision.template)
    log('info', `learned ${decision.kind} template`, {template: decision.template})
    return
  }
  // Once, not per request: that the cap now binds is a single fact, and whatever floods it next
  // will arrive thousands of times.
  if (decision.verdict === 'cap-reached' && !capWarned) {
    capWarned = true
    log('warn', 'learned template cap reached, no longer learning', {
      kind: decision.kind,
      cap: decision.cap,
      template: decision.template,
    })
  }
}

let synthSeq = 0
const PASSTHROUGH = new Set([
  'chainHead_v1_follow',
  'chainHead_v1_unfollow',
  'chainHead_v1_header',
  'chainHead_v1_unpin',
  'chainHead_v1_body',
  'chainHead_v1_call',
  'chainHead_v1_storage',
  'chainHead_v1_continue',
  'chainHead_v1_stopOperation',
])

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req, server) {
    if (server.upgrade(req)) return undefined
    return new Response('websocket only', {status: 400})
  },
  websocket: {
    open(ws) {
      const passthrough = new Upstream(UPSTREAM, 'passthrough')
      const synthetic = new Set<string>()
      ;(ws as unknown as {state: unknown}).state = {passthrough, synthetic}
      log('info', 'client connected', {})
    },
    async message(ws, raw) {
      const state = (ws as unknown as {state: {passthrough: Upstream; synthetic: Set<string>}}).state
      let req: RpcRequest
      try {
        req = JSON.parse(String(raw)) as RpcRequest
      } catch (e) {
        log('warn', 'client sent unparseable frame', {error: String(e)})
        return
      }
      const {id, method, params} = req
      if (method === undefined || id === undefined) {
        log('warn', 'client frame without method or id', {method, id})
        return
      }
      noteIdle()
      const reply = (body: Partial<RpcResponse>) => {
        ws.send(JSON.stringify({jsonrpc: '2.0', id, ...body}))
        lastReplyAt = performance.now()
      }

      // Height requests drive the read-ahead window.
      if (method === 'archive_v1_hashByHeight' && Array.isArray(params) && typeof params[0] === 'number') {
        const height = params[0]
        if (height > cursor + DEPTH || height < cursor - DEPTH) {
          // The indexer seeked, it did not walk: a restart probes the finalized head before resuming
          // at its own height. A window that only ever moves up latches on that probe, which stops
          // eviction and unbounds the cache (measured: 2026-10-11 03:00, dead of memory at 03:25).
          log('info', 'window reseek', {from: cursor, to: height, warm: blocks.size})
          cursor = height
          prefetchTop = height
          chainTipReached = false
          blocks.clear()
          heightOfHash.clear()
        } else if (height > cursor) {
          cursor = height
          if (prefetchTop < cursor) prefetchTop = cursor
        }
        // Size-triggered, not height-triggered: whatever the window does, the cache stays bounded.
        if (blocks.size > MAX_WARM) evictBelow(cursor - 32)
        pump()
      }

      if (method === 'archive_v1_stopStorage' && Array.isArray(params) && typeof params[0] === 'string') {
        if (state.synthetic.delete(params[0])) {
          reply({result: false})
          return
        }
      }

      if (!PASSTHROUGH.has(method)) {
        // Answers are keyed by the block they belong to: by height for hashByHeight, by hash for
        // everything else. Looking in the cursor's entry instead would miss the (common) case of
        // the indexer still working through a block the window has already moved past.
        const entry = Array.isArray(params)
          ? typeof params[0] === 'number'
            ? blocks.get(params[0])
            : typeof params[0] === 'string'
              ? blocks.get(heightOfHash.get(params[0]) ?? -1)
              : undefined
          : undefined
        const key = keyOf(method, params ?? null)
        const hit = entry?.answers.get(key)
        if (hit !== undefined) {
          stats.hits += 1
          reply({result: hit})
          return
        }
        const storageHit = entry?.storage.get(key)
        if (storageHit !== undefined) {
          stats.hits += 1
          const opId = `pfx-${synthSeq++}`
          state.synthetic.add(opId)
          reply({result: opId})
          for (const event of storageHit) {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'archive_v1_storageEvent',
                params: {subscription: opId, result: event},
              }),
            )
          }
          return
        }
        stats.misses += 1
        learn(method, params ?? null)
        const missStarted = performance.now()
        try {
          if (method === 'archive_v1_storage') {
            const events = await nextMiss().storage(params)
            const opId = `pfx-${synthSeq++}`
            state.synthetic.add(opId)
            reply({result: opId})
            for (const event of events) {
              ws.send(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'archive_v1_storageEvent',
                  params: {subscription: opId, result: event},
                }),
              )
            }
          } else {
            reply({result: await nextMiss().call(method, params ?? null)})
          }
          noteMiss(method, performance.now() - missStarted)
        } catch (e) {
          noteMiss(method, performance.now() - missStarted)
          log('warn', 'upstream call failed, reporting to client', {method, error: String(e)})
          reply({error: {code: -32603, message: String(e)}})
        }
        return
      }

      // Pass-through: subscriptions and anything stateful keep the upstream's own ids.
      try {
        const result = await state.passthrough.call(method, params ?? null)
        if (method === 'chainHead_v1_follow' && typeof result === 'string') {
          state.passthrough.track(result, (p) =>
            ws.send(JSON.stringify({jsonrpc: '2.0', method: 'chainHead_v1_followEvent', params: p})),
          )
        }
        reply({result})
      } catch (e) {
        log('warn', 'passthrough call failed, reporting to client', {method, error: String(e)})
        reply({error: {code: -32603, message: String(e)}})
      }
    },
    close(ws) {
      const state = (ws as unknown as {state?: {passthrough: Upstream}}).state
      state?.passthrough.close()
      log('info', 'client disconnected', {...stats, sockets: liveSockets()})
    },
  },
})

log('info', 'read-ahead proxy listening', {
  port: PORT,
  upstream: UPSTREAM,
  depth: DEPTH,
  connections: CONNS,
  missConnections: MISS_CONNS,
})
