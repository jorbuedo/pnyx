/**
 * Whether the selected wallet can contribute its CIP-1854 co-signer key right
 * now, and what to do about it if not.
 *
 * The cache read is what makes this a hook rather than a pure call: a hardware
 * wallet's key is only knowable from storage, so "can this wallet co-sign?" is
 * asynchronous for that source and synchronous for every other. Screens that ask
 * the pure `coSignerKeySourceOf` alone can only ever answer "a device is
 * needed", which is what made every hardware wallet look permanently excluded.
 *
 * @module
 */

import type {WalletSource} from '@pnyx/wallet'
import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {loadCardanoGovKeys} from '../services/cardano'
import {type CoSignerKeySource, coSignerKeyAccessOf, coSignerKeySourceOf} from '../services/cardano/multisig'

export type CoSignerKeyAccess = {
  /** `null` until the cache read settles — screens should show neither state yet. */
  readonly access: CoSignerKeySource | null
  /** Re-read the cache, e.g. after returning from the pair flow. */
  readonly refresh: () => void
}

export const useCoSignerKeyAccess = (
  groupId: string | null,
  source: WalletSource | null,
  /**
   * Which account's co-signer key. **Required**, because the account that *derives* the key and the
   * account the message *labels* must be the same value — and they used to be two defaults that
   * happened to match. A key labelled with the wrong index is the `eternl-assigns-keys-by-position`
   * failure, and it lands on the other participants in a shared wallet rather than on this one.
   */
  account: number,
): CoSignerKeyAccess => {
  const [access, setAccess] = useState<CoSignerKeySource | null>(null)

  const read = useCallback(async (): Promise<CoSignerKeySource | null> => {
    if (groupId === null || source === null) return null
    // Only the device path costs a read; everything else is decided by the
    // source alone, so a mnemonic wallet never waits on storage to render.
    const base = coSignerKeySourceOf(source)
    if (base.kind !== 'device') return base
    const keys = await Effect.runPromise(loadCardanoGovKeys(groupId, account).pipe(Effect.orElseSucceed(() => null)))
    return coSignerKeyAccessOf(source, keys?.sharedAccountXpubHex !== undefined)
  }, [groupId, source, account])

  useEffect(() => {
    let active = true
    void read().then((next) => {
      if (active) setAccess(next)
    })
    return () => {
      active = false
    }
  }, [read])

  // Deliberately not guarded by an `active` flag: this is called on screen
  // focus, so the component is mounted by construction and a stale write is the
  // effect's concern, not this one's.
  const refresh = useCallback(() => {
    void read().then(setAccess)
  }, [read])

  return {access, refresh}
}
