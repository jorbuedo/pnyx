/**
 * Boundary guard for wallet-service receive-address resolution.
 *
 * `WalletService.getReceiveAddress` is typed `Effect<string, SyncError>`,
 * but the value crosses store/derivation layers and has been observed in
 * the field resolving `undefined` — which then crashed consumers
 * far from the source. Chain-agnostic by design: any non-empty string is a
 * plausible address here (Cardano bech32, EVM hex, Solana base58, …);
 * per-chain shape validation belongs to the consumers that need it.
 *
 * @module
 */

const describeValue = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return `string(len=${value.length})`
  return typeof value
}

export const ensureReceiveAddressValue = (value: unknown, context: {readonly chainId?: string | undefined}): string => {
  if (typeof value === 'string' && value.length > 0) return value
  const err = new Error(
    `Receive address resolution for ${context.chainId ?? 'unknown chain'} returned ${describeValue(value)}`,
  )
  err.name = 'ReceiveAddressInvalidError'
  throw err
}
