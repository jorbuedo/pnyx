/**
 * Resolve a SteelSwap DEX id to its display name, from the cached catalog.
 *
 * A route leg carries an id like `MinswapV2CPPState`; the catalog turns that
 * into "Minswap". When the catalog is unavailable the id is returned unchanged
 * rather than blanked — a raw venue name is worse-looking but still true.
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {type DexInfo, getDexes} from '../services/cardano-swap/dexes'

export const useDexNames = (): ((id: string) => string) => {
  const [byId, setById] = useState<ReadonlyMap<string, DexInfo>>(() => new Map())

  useEffect(() => {
    let active = true
    void getDexes(Date.now()).then((list) => {
      if (active) setById(new Map(list.map((d) => [d.id, d])))
    })
    return () => {
      active = false
    }
  }, [])

  return (id: string) => byId.get(id)?.name ?? id
}
