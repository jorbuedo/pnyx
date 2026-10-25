import type {UTxO} from '@evolution-sdk/evolution'
import {describe, expect, it} from 'vitest'
import {testUtxo} from '../cardano/test-utxo'
import {utxoTxHashHex} from '../cardano/utxo-view'
import {isAdaId, isPureAda, MAX_BUILD_UTXOS, selectSwapUtxos} from './signing-context'

const POLICY = 'aa'.repeat(28)
const SNEK = `${POLICY}.534e454b`

/**
 * ⚠️ Built, not cast. This was `{...} as unknown as UTxO.UTxO` over the old wallet shape — which
 * type-checked while the runtime value had no `assets` bag at all, so every selector read
 * `undefined` the moment they started asking a `UTxO` for one.
 */
/** A readable label becomes a real 32-byte hash, so a UTxO can be named in an assertion. */
const labelHash = (label: string): string =>
  [...label]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
const labelOf = (hashHex: string): string =>
  (hashHex.match(/../g) ?? [])
    .map((b) => Number.parseInt(b, 16))
    .filter((n) => n !== 0)
    .map((n) => String.fromCharCode(n))
    .join('')

const utxo = (id: string, lovelace: bigint, assets?: ReadonlyArray<readonly [string, bigint]>): UTxO.UTxO =>
  testUtxo({txHash: labelHash(id), lovelace, ...(assets === undefined ? {} : {assets: new Map(assets)})})

describe('isAdaId / isPureAda', () => {
  it('treats both ADA sentinels as ADA', () => {
    expect(isAdaId('')).toBe(true)
    expect(isAdaId('.')).toBe(true)
    expect(isAdaId(SNEK)).toBe(false)
  })

  it('calls a UTxO pure ADA only when it holds no assets at all', () => {
    expect(isPureAda(utxo('a', 10n))).toBe(true)
    expect(isPureAda(utxo('b', 10n, [[SNEK, 1n]]))).toBe(false)
  })
})

describe('selectSwapUtxos', () => {
  it('covers an ADA swap with the FEWEST pure-ADA UTxOs, largest first', () => {
    // The aggregator does its own coin selection from what we hand it; a large
    // set makes the solver crawl, so the covering set must stay minimal.
    const spendable = [utxo('small', 5_000_000n), utxo('big', 200_000_000n), utxo('mid', 50_000_000n)]
    const picked = selectSwapUtxos(spendable, {inputAssetId: '', inputAmount: 100_000_000n})
    expect(picked.map((u) => labelOf(utxoTxHashHex(u)))).toEqual(['big'])
  })

  it('adds more ADA UTxOs only until the leg plus headroom is covered', () => {
    const spendable = [utxo('a', 60_000_000n), utxo('b', 60_000_000n), utxo('c', 60_000_000n)]
    // 100 ADA leg + 15 ADA headroom = 115 ADA, so two of the three suffice.
    const picked = selectSwapUtxos(spendable, {inputAssetId: '', inputAmount: 100_000_000n})
    expect(picked).toHaveLength(2)
  })

  it('covers a token sell with the token-bearing UTxOs first, then tops up ADA', () => {
    const spendable = [
      utxo('adaOnly', 100_000_000n),
      utxo('tokenSmall', 2_000_000n, [[SNEK, 100n]]),
      utxo('tokenBig', 2_000_000n, [[SNEK, 900n]]),
    ]
    const picked = selectSwapUtxos(spendable, {inputAssetId: SNEK, inputAmount: 500n})
    // Largest token holding covers 500 on its own; ADA is then topped up for fees.
    expect(picked.map((u) => labelOf(utxoTxHashHex(u)))).toEqual(['tokenBig', 'adaOnly'])
  })

  it('takes several token UTxOs when one does not cover the amount', () => {
    const spendable = [
      utxo('t1', 2_000_000n, [[SNEK, 300n]]),
      utxo('t2', 2_000_000n, [[SNEK, 300n]]),
      utxo('ada', 100_000_000n),
    ]
    const picked = selectSwapUtxos(spendable, {inputAssetId: SNEK, inputAmount: 500n})
    expect(picked.filter((u) => labelOf(utxoTxHashHex(u)).startsWith('t'))).toHaveLength(2)
  })

  it('never exceeds the solver cap even when the wallet is dust-heavy', () => {
    // A whale wallet with many tiny UTxOs would otherwise send a payload the
    // solver chokes on.
    const spendable = Array.from({length: 100}, (_, i) => utxo(`u${i}`, 1_000_000n))
    const picked = selectSwapUtxos(spendable, {inputAssetId: '', inputAmount: 500_000_000n})
    expect(picked.length).toBeLessThanOrEqual(MAX_BUILD_UTXOS)
  })

  it('returns what it could cover rather than throwing when the balance falls short', () => {
    // The build will fail upstream with a real reason; inventing an error here
    // would replace that reason with a worse one.
    const picked = selectSwapUtxos([utxo('a', 1_000_000n)], {inputAssetId: '', inputAmount: 500_000_000n})
    expect(picked.map((u) => labelOf(utxoTxHashHex(u)))).toEqual(['a'])
  })
})
