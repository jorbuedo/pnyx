import type {UTxO} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {resolvedInputsFromSpendable} from './signing-adapters'
import {testUtxo} from './test-utxo'

/** The account's primary address: payment `0'/0/0` + stake `0'/2/0`. */
const PRIMARY =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'
/**
 * The same payment key with a stake credential this wallet does not derive — what Eternl's
 * multi-delegation produces. Spendable by us; invisible to an address-keyed or stake-keyed fetch.
 */
const MULTI_DELEGATION =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7s5x7x4e49fkw9ydmrzsjdek5v45cyh5qqs8hsm9l2vcyutsszhdem'

const utxo = (address: string, fill: string): UTxO.UTxO =>
  testUtxo({txHash: fill.repeat(32), address, lovelace: 1_000_000n})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect))

const pathsFor = (utxos: readonly UTxO.UTxO[]) =>
  Effect.gen(function* () {
    return yield* resolvedInputsFromSpendable(utxos)
  })

const paymentCredOf = async (addressHex: string) => Address.inspect(addressHex).paymentCredHex

describe('resolvedInputsFromSpendable', () => {
  it('keeps each utxo on its own address rather than the account primary', async () => {
    const result = await run(pathsFor([utxo(PRIMARY, '11'), utxo(MULTI_DELEGATION, '22')]))
    if (result._tag === 'Left') throw new Error(String(result.left))
    const [first, second] = result.right
    expect(first?.addressHex).not.toBe(second?.addressHex)
  })

  // The whole point. resolveCardanoSigningPaths reads the payment credential off addressHex to
  // decide which key witnesses the input; a primary-address stamp made a multi-delegation input
  // report the primary's credential, and its witness was never requested.
  it('reports the multi-delegation input under its own payment credential', async () => {
    const result = await run(pathsFor([utxo(MULTI_DELEGATION, '22')]))
    if (result._tag === 'Left') throw new Error(String(result.left))
    const resolved = result.right[0]
    if (resolved === undefined) throw new Error('expected one resolved input')

    const primaryHex = Address.fromBech32Sync(Bech32(PRIMARY))
    // Same payment key on both addresses — so the credential must match the primary's while the
    // address must not. That pair is what distinguishes "kept its address" from "got stamped".
    expect(await paymentCredOf(resolved.addressHex)).toBe(await paymentCredOf(primaryHex))
    expect(resolved.addressHex).not.toBe(primaryHex)
  })

  it('carries the value through', async () => {
    const result = await run(pathsFor([utxo(PRIMARY, '11')]))
    if (result._tag === 'Left') throw new Error(String(result.left))
    expect(result.right[0]?.coin).toBe(1_000_000n)
  })

  // ⚠️ The "fails rather than drops an unreadable address" test is GONE, and the guarantee is
  // stronger for it. Skipping such an input would cost it its witness, which is the silent failure
  // that path existed to remove — but a `UTxO` carries an already-decoded `Address`, so an input
  // with an unreadable one cannot be constructed, let alone reach the resolver. The fixture for it
  // (`'not-an-address'`) is now refused by `testUtxo` itself. `resolveOwnInputs` is infallible as
  // a result, and `InputAddressError` went with the check.
})
