// Balance and submit a harness transaction THROUGH THE PHONE, over the wallet's MCP surface.
//
// The companion to `./device-proof-provider.ts`, and the half that was missing. That one moved
// *proving* onto the device while a Node wallet still paid the fee and broadcast the bytes — same key,
// different process, which is not the same thing as the wallet doing it. These two providers move the
// remaining steps:
//
//   ProofProvider.proveTx   → the phone's native prover        (device-proof-provider.ts)
//   WalletProvider.balanceTx → the phone's fee + a person's approval   ← here
//   MidnightProvider.submitTx → the phone's submission rail            ← here
//
// With all three pointed at the wallet, a script composes and nothing else: the transaction is proven
// on the device, paid for by the device (its own DUST, or the sponsor if `prefer-self` degrades), shown
// to a person who approves it, and broadcast by the device. No Node wallet is assembled, no seed is
// read here, and no DUST of ours is spent anywhere but on the phone.
//
// ⚠️ **`balanceTx` blocks on a human.** `midnight_balanceUnsealedTransaction` puts the transaction on
// the wallet's funding review and the call does not return until somebody approves or rejects it. That
// is the point rather than a limitation — but it means a script using these providers is interactive,
// and a timeout here is a person who has not looked at their phone.
import {Transaction} from '@midnight-ntwrk/midnight-js-protocol/ledger'
import type {MidnightProvider, WalletProvider} from '@midnight-ntwrk/midnight-js-types'

import {mcpClient} from './device-proof-provider.js'

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const fromHex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'))

/**
 * The hex out of a tool result.
 *
 * ⚠️ **Three shapes, because the surface has three.** Every result is `JSON.stringify`d, so a plain hex
 * answer arrives quoted (`"abc…"`), a structured one arrives as an object (`{"tx":"abc…"}`), and only a
 * tool that returns raw text arrives bare. Handling just one of them reads a whole JSON document as a
 * hex string and reports a working wallet as a broken one — which is exactly what happened the first
 * time this ran, *after* the phone had already paid and sealed.
 */
const hexAnswer = (answer: string, what: string): Uint8Array => {
  let value: unknown = answer
  try {
    const parsed: unknown = JSON.parse(answer)
    value = typeof parsed === 'object' && parsed !== null ? (parsed as {tx?: unknown}).tx : parsed
  } catch {
    // Not JSON at all, so the raw text is the answer. Checked as hex below like every other shape.
  }
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`the wallet answered ${what} with something that is not hex: ${answer.slice(0, 160)}`)
  }
  return fromHex(value)
}

/**
 * Read a transaction back without being told which binding state it is in.
 *
 * ⚠️ **The JS deserializer takes its markers on trust.** Given the wrong triple it does not fail on the
 * tag — it misreads the bytes and surfaces something unrelated further down (`Invalid signature value`
 * is the one this rail has seen). So a plain try-the-other-one fallback is unsafe here, and the guard
 * is a round trip: markers that were wrong do not re-serialize to the bytes that came in.
 *
 * Both states are legitimate answers. The wallet seals what it paid for itself and leaves what the
 * sponsor will pay for unbound, and which one it chose is its decision, not the caller's.
 */
const readTransaction = (raw: Uint8Array): {tx: unknown; bound: boolean} => {
  for (const binding of ['binding', 'pre-binding'] as const) {
    try {
      const tx = (Transaction as unknown as {deserialize: (...a: unknown[]) => unknown}).deserialize(
        'signature',
        'proof',
        binding,
        raw,
      )
      const again = (tx as {serialize: () => Uint8Array}).serialize()
      if (again.length === raw.length && again.every((byte, i) => byte === raw[i])) {
        return {tx, bound: binding === 'binding'}
      }
    } catch {
      // Not this shape. The round trip above is what actually decides; a throw only rules one out
      // earlier, and the error is deliberately not reported because the other branch may still succeed
      // — a failure that matters is the one raised below, after both were tried.
    }
  }
  throw new Error(`the wallet returned ${raw.length} bytes that are neither a bound nor a pre-binding transaction`)
}

export type WalletMcpProviders = {
  readonly walletProvider: WalletProvider
  readonly midnightProvider: MidnightProvider
  /** What the wallet said about the last balancing — whether the phone paid, and for what. */
  readonly lastBalance: () => {readonly bound: boolean; readonly bytes: number} | null
}

/**
 * Providers backed by a paired, serving wallet.
 *
 * The keys are fetched once at construction because `WalletProvider` exposes them synchronously — and
 * they are the wallet's own, so a transaction's new coins are encrypted to the phone rather than to a
 * key this script would have had to hold.
 */
export const walletMcpProviders = async (params: {
  readonly url: string
  readonly authorization: string
  readonly log?: (message: string) => void
}): Promise<WalletMcpProviders> => {
  const log = params.log ?? ((message: string) => console.log(`  ${message}`))
  const client = mcpClient(params.url, params.authorization)

  const addresses = JSON.parse(await client.call('midnight_getShieldedAddresses', {})) as {
    shieldedCoinPublicKey?: string
    shieldedEncryptionPublicKey?: string
  }
  const coinPublicKey = addresses.shieldedCoinPublicKey
  const encryptionPublicKey = addresses.shieldedEncryptionPublicKey
  if (coinPublicKey === undefined || encryptionPublicKey === undefined) {
    // Not a default: a transaction's new coins are encrypted to this key, and a wrong or invented one
    // strands them exactly the way a missing change output does.
    throw new Error('the wallet did not report its shielded keys, so nothing can be encrypted to it')
  }

  let last: {bound: boolean; bytes: number} | null = null

  return {
    lastBalance: () => last,
    walletProvider: {
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encryptionPublicKey,
      async balanceTx(tx: unknown) {
        const raw = (tx as {serialize: () => Uint8Array}).serialize()
        log(`asking the wallet to cover ${raw.length} bytes — approve it on the phone`)
        const answer = await client.call('midnight_balanceUnsealedTransaction', {
          tx: toHex(raw),
          options: {payFees: true},
        })
        const read = readTransaction(hexAnswer(answer, 'a balanced transaction'))
        last = {bound: read.bound, bytes: raw.length}
        log(read.bound ? 'the phone paid its own DUST and sealed it' : 'the sponsor will pay; it came back unbound')
        return read.tx
      },
    } as unknown as WalletProvider,
    midnightProvider: {
      async submitTx(tx: unknown) {
        // ⚠️ **Read the identifiers before submitting.** The wallet answers a submission with nothing —
        // the connector's `submitTransaction` is void — and a device-built transaction has no hash to
        // ask for afterwards. An identifier is what a send is matched by on chain, so it is taken from
        // the bytes being sent rather than hoped for in the reply.
        const identifiers = (tx as {identifiers: () => string[]}).identifiers()
        const raw = (tx as {serialize: () => Uint8Array}).serialize()
        log(`handing ${raw.length} bytes to the wallet to broadcast`)
        await client.call('midnight_submitTransaction', {tx: toHex(raw)})
        const id = identifiers[0]
        if (id === undefined) {
          throw new Error('the transaction carries no identifiers, so nothing can be matched on chain')
        }
        return id
      },
    } as unknown as MidnightProvider,
  }
}
