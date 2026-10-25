import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {PayUri} from '../types.js'

/**
 * Parse a pay/payment URI (CIP-13)
 * Format: web+cardano://pay?address=<addr>&amount=<lovelace>&message=<msg>
 */
export const parse = (url: URL): Effect.Effect<PayUri, InvalidUriError> =>
  Effect.gen(function* () {
    const address = url.searchParams.get('address')

    if (!address) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Pay URI requires address parameter',
        }),
      )
    }

    const amountStr = url.searchParams.get('amount')
    let amount: bigint | undefined

    if (amountStr) {
      try {
        amount = BigInt(amountStr)
        if (amount < 0n) {
          return yield* Effect.fail(
            new InvalidUriError({
              uri: url.href,
              reason: 'Amount cannot be negative',
            }),
          )
        }
      } catch {
        return yield* Effect.fail(
          new InvalidUriError({
            uri: url.href,
            reason: `Invalid amount: "${amountStr}" is not a valid integer`,
          }),
        )
      }
    }

    const message = url.searchParams.get('message') ?? undefined

    return {
      authority: 'pay' as const,
      address,
      ...(amount !== undefined && {amount}),
      ...(message !== undefined && {message}),
    }
  })

/**
 * Build a pay URI
 */
export const build = (address: string, amount?: bigint, message?: string): string => {
  const params = new URLSearchParams({address})
  if (amount !== undefined) params.set('amount', amount.toString())
  if (message) params.set('message', message)
  return `web+cardano://pay?${params}`
}
