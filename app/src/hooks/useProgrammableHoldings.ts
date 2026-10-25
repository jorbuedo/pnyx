/**
 * An account's CIP-113 programmable-token holdings.
 *
 * Separate from `useCardanoPortfolio` on purpose. These are not spendable coins and must never be
 * summed into a balance a fee can be paid from: the address's payment credential is the deployment's
 * script, so an ordinary transaction cannot spend one at all. `docs/CARDANO_CUSTODY_MODEL.md` §4.
 *
 * The wallet's ordinary fetch paths cannot find these. A signing wallet enumerates its derived
 * addresses, and the smart wallet is not one of them — it pairs the deployment's script with our
 * stake credential. So it is asked for deliberately, by address, or not at all.
 *
 * @module
 */

import {useCallback, useEffect, useMemo, useState} from 'react'
import {
  type OwnProgrammableHoldings,
  type ProgrammableRow,
  readOwnProgrammableHoldings,
} from '../services/cardano/cip113/smart-wallet'
import {useCardanoRail} from './useCardanoRail'

// Re-exported for existing importers; both now live with the reader that produces them.
export type {OwnProgrammableHoldings, ProgrammableRow}

/** The hook's own extra state: the read has not answered yet. */
export type ProgrammableHoldings = OwnProgrammableHoldings | {readonly kind: 'loading'}

export const useProgrammableHoldings = (): ProgrammableHoldings => {
  const {rail} = useCardanoRail()
  const [state, setState] = useState<ProgrammableHoldings>({kind: 'loading'})

  // `rail` alone: the account's stake credential and the network are both read off it now, and a
  // change to either produces a new rail.
  const load = useCallback(async () => {
    if (rail === null) return
    setState(await readOwnProgrammableHoldings(rail, 'useProgrammableHoldings'))
  }, [rail])

  useEffect(() => {
    void load()
  }, [load])

  return state
}

/**
 * Just the asset ids, for the surfaces that only need to know which holdings move differently.
 *
 * Every asset picker in the app needs this — send, co-funding sources, swap — because none of
 * those transactions can spend a smart-wallet UTxO. Derived here rather than at each call site so
 * the answer cannot differ between two pickers looking at the same wallet.
 */
export const useProgrammableAssetIds = (): ReadonlySet<string> => {
  const holdings = useProgrammableHoldings()
  return useMemo(
    () =>
      new Set(
        holdings.kind === 'ready'
          ? holdings.rows.flatMap((r) => r.tokens.map((t) => `${t.policyIdHex}.${t.assetNameHex}`))
          : [],
      ),
    [holdings],
  )
}
