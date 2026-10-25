/**
 * Run a **compactc-generated contract driver** on this device, and turn what it emits into a proven
 * transaction.
 *
 * This is the consumer side of plan item 32. `contract/managed/<c>/contract/index.js` is the
 * compiler's own output, run unmodified against `@midnight-ntwrk/compact-runtime` — which reaches
 * the device's Rust instead of WebAssembly, because Metro aliases its wasm-bindgen dependency to
 * `@pnyx/compact-hermes`. Nothing here knows which circuit it is running; adding one is a
 * `compile:contract`, not a hand-port plus seven bridge files plus an app rebuild.
 *
 * ⚠️ **The handle must be freed.** `QueryContext` holds a native context for the life of the call;
 * a driver that throws mid-circuit would leak one until the process ends, so the `finally` is not
 * decoration.
 *
 * ⚠️ **Tx-level proving, never the standalone preimage.** `Transaction::prove` overwrites each
 * call's `binding_input` with the intent's binding commitment, so a circuit proof made on its own
 * cannot be lifted into a transaction afterwards. `tx.build` does both halves in one native call.
 *
 * @module
 */

import {compactOp} from '@pnyx/midnight-native'
import {logger} from '../../logger'

const ORIGIN = 'driver-circuit'

/** What a driver fills in as it runs — `partialProofData`, in the runtime's own shape. */
type ProofData = {
  readonly input: unknown
  readonly output: unknown
  readonly publicTranscript: unknown[]
  readonly privateTranscriptOutputs: unknown[]
}

export type DriverCall = {
  /** The circuit's name, which is also its key location in the artifacts. */
  readonly entryPoint: string
  /** The contract's address (hex), and the state the transcript must run against. */
  readonly contractAddress: string
  readonly contractState: Uint8Array
  /** Runs the circuit and returns what the driver recorded. */
  readonly run: () => ProofData
}

export type DriverArtifacts = {
  readonly zkir: Uint8Array
  readonly proverKey: Uint8Array
  readonly verifierKey: Uint8Array
  readonly params: Uint8Array
}

const hex = (b: Uint8Array): string => {
  let out = ''
  for (const byte of b) out += byte.toString(16).padStart(2, '0')
  return out
}

const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * `Uint8Array` → hex and `bigint` → string, so a transcript crosses the bridge as JSON.
 *
 * Recursive because a program is a recursive tagged union: an `idx` path holds keys, a key holds an
 * aligned value, an aligned value holds byte atoms.
 */
const plain = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return hex(v)
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(plain)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]))
  }
  return v
}

/**
 * Build a proven-unbound transaction by running the generated driver.
 *
 * The state is passed in rather than read here so the caller owns freshness: a transcript is only
 * valid against the state it ran on, and a stale read is a transaction the node refuses.
 */
export const buildProvenTxFromDriver = (
  call: DriverCall,
  artifacts: DriverArtifacts,
  networkId: string,
  ttlSecs: number,
): Uint8Array => {
  const started = Date.now()
  let proofData: ProofData
  try {
    proofData = call.run()
  } catch (e) {
    // The driver's own asserts land here — "not a member", "no such invite". Logged rather than
    // swallowed: a circuit that refuses and one that could not run look identical to the caller.
    logger.warn('a generated driver refused its circuit', {
      origin: ORIGIN,
      entryPoint: call.entryPoint,
      error: String(e),
    })
    throw e
  }
  const ranMs = Date.now() - started

  const out = JSON.parse(
    compactOp(
      'tx.build',
      JSON.stringify({
        state: hex(call.contractState),
        address: call.contractAddress,
        entryPoint: call.entryPoint,
        program: plain(proofData.publicTranscript),
        privateTranscriptOutputs: plain(proofData.privateTranscriptOutputs),
        input: plain(proofData.input),
        output: plain(proofData.output),
        zkir: hex(artifacts.zkir),
        proverKey: hex(artifacts.proverKey),
        verifierKey: hex(artifacts.verifierKey),
        params: hex(artifacts.params),
        networkId,
        ttlSecs,
      }),
    ),
  ) as {tx: string}

  logger.info('built a proven tx from the generated driver', {
    origin: ORIGIN,
    entryPoint: call.entryPoint,
    ops: proofData.publicTranscript.length,
    driverMs: ranMs,
    totalMs: Date.now() - started,
  })
  return fromHex(out.tx)
}
