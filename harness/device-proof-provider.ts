// Prove a harness transaction ON THE PHONE, through the wallet's MCP surface.
//
// The differentiator, used from the other side: every other wallet's proving provider forwards to a
// proof server, and ours *is* the device. `midnight_provingProviderCheck` / `midnight_provingProviderProve`
// expose the same circuit-level `ProvingProvider` a dApp page reaches through `getProvingProvider`, so a
// script can point midnight-js at a running app instead of a container.
//
// The seam is midnight-js's own: `httpClientProofProvider` is a four-line adapter over a circuit-level
// `ProvingProvider`, and the /prove-tx endpoint is not used at all. So swapping in another
// `ProvingProvider` is the whole change — the transaction-level `proveTx` below is copied from it.
//
//   ProofProvider (transaction) → ProvingProvider (circuit) → MCP → the phone's native prover
//
// ⚠️ The device refuses circuits above K=16 and takes no SRS from the caller: proof soundness stays
// rooted in the wallet's own pinned ceremony, not in whatever a script hands it.
import {sha256} from '@noble/hashes/sha2.js'
import {CostModel} from '@midnight-ntwrk/midnight-js-protocol/ledger'
import type {ProofProvider, ZKConfigProvider} from '@midnight-ntwrk/midnight-js-types'

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const fromHex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'))

/**
 * The proof, out of the JSON every tool result is wrapped in.
 *
 * ⚠️ **A string answer arrives quoted.** The tool surface `JSON.stringify`s every result, so the proof
 * comes back as `"abc123…"` and decoding those quotes as hex yields bytes that are not a proof. The
 * ledger then reports it far downstream — `expected header tag 'midnight:proof-versioned:', got ''` —
 * which reads as a broken prover rather than as a caller that never unwrapped the answer.
 */
const proofBytes = (answer: string): Uint8Array => {
  const hexText: unknown = JSON.parse(answer)
  if (typeof hexText !== 'string' || hexText === '' || !/^[0-9a-f]+$/i.test(hexText)) {
    throw new Error(`the wallet answered with something that is not a proof: ${answer.slice(0, 120)}`)
  }
  return fromHex(hexText)
}

/** The wallet's own words for a cache miss — the one failure that is answered by resending, not raised. */
const isCacheMiss = (error: unknown): boolean => String(error).includes('is not on this device')

/**
 * A binding input is a field element the ledger reads little-endian in 32 bytes.
 *
 * A bigint has no length of its own, so the padding *is* the conversion — a shorter encoding is a
 * different scalar, and the wallet refuses anything that is not exactly 32.
 */
const frToLeHex = (value: bigint): string => {
  if (value < 0n) throw new Error('a binding input must not be negative')
  const out = new Uint8Array(32)
  let rest = value
  for (let i = 0; i < 32; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return toHex(out)
}

/** A minimal MCP-over-HTTP client: initialize, then `tools/call`. */
export const mcpClient = (url: string, authorization: string) => {
  let sessionId: string | null = null

  const rpc = async (method: string, params?: unknown, notify = false): Promise<unknown> => {
    const body: Record<string, unknown> = {jsonrpc: '2.0', method, ...(params === undefined ? {} : {params})}
    if (!notify) body.id = Math.floor(Math.random() * 1e9)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The transport may answer as SSE, so the last `data:` line is the payload.
        accept: 'application/json, text/event-stream',
        authorization,
        ...(sessionId === null ? {} : {'mcp-session-id': sessionId}),
      },
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid !== null) sessionId = sid
    if (notify) return null
    const text = await res.text()
    if (!res.ok) throw new Error(`MCP ${method} failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    const events = text.split('\n').filter((line) => line.startsWith('data:'))
    const payload = events.length > 0 ? events[events.length - 1]!.slice(5).trim() : text
    return JSON.parse(payload)
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const answer = (await rpc('tools/call', {name, arguments: args})) as {
      result?: {isError?: boolean; content?: {text?: string}[]}
      error?: {message?: string}
    }
    if (answer.error) throw new Error(`${name}: ${answer.error.message ?? 'failed'}`)
    const text = answer.result?.content?.[0]?.text ?? ''
    // An `isError` result is the wallet answering, not the transport failing — its text is the reason.
    if (answer.result?.isError === true) throw new Error(`${name}: ${text}`)
    return text
  }

  const ready = (async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 'pnyx-harness', version: '1'},
    })
    await rpc('notifications/initialized', undefined, true)
  })()

  return {
    call: async (name: string, args: Record<string, unknown>) => {
      await ready
      return call(name, args)
    },
  }
}

/**
 * The device as a circuit-level proving provider.
 *
 * ⚠️ **Optimistic by digest, exactly as the injected page-side provider is.** A prover key is megabytes
 * and shipping one dominates the call, so the first attempt names the circuit by digest alone; the
 * wallet caches by content across sessions, and a miss costs one round trip against megabytes of
 * transport for guessing the other way.
 */
const deviceProvingProvider = <K extends string>(
  client: ReturnType<typeof mcpClient>,
  zkConfigProvider: ZKConfigProvider<K>,
  log: (message: string) => void,
) => {
  const sent = new Map<string, boolean>()

  return {
    async check(serializedPreimage: Uint8Array, keyLocation: K) {
      const zkir = await zkConfigProvider.getZKIR(keyLocation)
      const text = await client.call('midnight_provingProviderCheck', {
        zkir: toHex(zkir as unknown as Uint8Array),
        preimage: toHex(serializedPreimage),
      })
      // The API's shape is `(bigint | undefined)[]`; JSON has neither, so an absent entry arrives as
      // null and a present one as a number.
      const skips = JSON.parse(text) as (number | null)[]
      return skips.map((entry) => (entry === null ? undefined : BigInt(entry)))
    },

    async prove(serializedPreimage: Uint8Array, keyLocation: K, overwriteBindingInput?: bigint) {
      const [zkir, proverKey, verifierKey] = (await Promise.all([
        zkConfigProvider.getZKIR(keyLocation),
        zkConfigProvider.getProverKey(keyLocation),
        zkConfigProvider.getVerifierKey(keyLocation),
      ])) as unknown as [Uint8Array, Uint8Array, Uint8Array]

      const joined = new Uint8Array(zkir.length + proverKey.length + verifierKey.length)
      joined.set(zkir, 0)
      joined.set(proverKey, zkir.length)
      joined.set(verifierKey, zkir.length + proverKey.length)
      const digest = toHex(sha256(joined))

      const binding = overwriteBindingInput === undefined ? undefined : frToLeHex(overwriteBindingInput)
      const request = (withMaterial: boolean) =>
        client.call('midnight_provingProviderProve', {
          digest,
          preimage: toHex(serializedPreimage),
          ...(withMaterial ? {zkir: toHex(zkir), proverKey: toHex(proverKey), verifierKey: toHex(verifierKey)} : {}),
          ...(binding === undefined ? {} : {bindingInput: binding}),
        })

      const withCircuit = async () => {
        log(`sending ${keyLocation} and its ${(joined.length / 1e6).toFixed(1)} MB circuit to the device`)
        const proof = proofBytes(await request(true))
        sent.set(digest, true)
        return proof
      }

      if (sent.get(digest) === false) return withCircuit()

      try {
        log(`proving ${keyLocation} on the device (circuit ${digest.slice(0, 12)}… by digest)`)
        return proofBytes(await request(false))
      } catch (error) {
        // ⚠️ Only a miss is retried. A circuit over K=16, a declined session or a malformed preimage
        // are answers, and resending megabytes would turn each into the same misleading second failure.
        if (!isCacheMiss(error)) throw error
        log(`the device does not hold ${digest.slice(0, 12)}…`)
        sent.set(digest, false)
        return withCircuit()
      }
    },
  }
}

/**
 * A midnight-js `ProofProvider` backed by the phone.
 *
 * Drop-in for `httpClientProofProvider(url, zkConfigProvider)` — same adapter, different prover.
 */
export const deviceProofProvider = <K extends string>(params: {
  readonly url: string
  readonly authorization: string
  readonly zkConfigProvider: ZKConfigProvider<K>
  readonly log?: (message: string) => void
}): ProofProvider => {
  const log = params.log ?? ((message: string) => console.log(`  ${message}`))
  const client = mcpClient(params.url, params.authorization)
  const provingProvider = deviceProvingProvider(client, params.zkConfigProvider, log)

  return {
    async proveTx(unprovenTx: {prove: (p: unknown, c: unknown) => Promise<unknown>}) {
      return unprovenTx.prove(provingProvider, CostModel.initialCostModel())
    },
  } as unknown as ProofProvider
}
