/**
 * The reach half of `sync-keys.ts`'s bound.
 *
 * That cache holds **spend-capable** material — a DUST role key signs a dust spend, a Zswap role key
 * spends coins — so unlike `identity-role-keys.ts` it cannot claim its blast radius is bounded by
 * capability. What bounds it is residency (evicted on lock) and *reach*: only the modules that sync
 * may read it. A signing path that imported it would turn a hold granted for reading into one that
 * can spend, with no prompt and nothing on screen.
 *
 * A comment asking people not to do that is not a gate, so this is the gate. Adding a module here is
 * a deliberate act that shows up in review, which is the point.
 */

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

/** Files allowed to read the sync keys. Anything else must open the vault for its own intent. */
const ALLOWED = new Set([
  // The cache itself.
  'services/midnight/sync-keys.ts',
  'services/midnight/sync-keys-store.ts',
  'services/midnight/sync-keys-store.test.ts',
  'services/midnight/sync-keys.test.ts',
  'services/midnight/sync-keys-scope.test.ts',
  // Populates the cache from a prompt the user asked for.
  'services/midnight/refresh-dust.ts',
  // Consumes it for scheduled, unprompted syncs.
  'services/midnight/scheduled-sync.ts',
  /*
   * ⚠️ **Populate-only — they write and never read.** Read this before adding more.
   *
   * These four are money paths that have just opened the vault, so they hand the scheduler what it
   * needs via `rememberSyncKeysForScheduler` rather than leaving DUST to go stale. Each already holds
   * the mnemonic outright, so none gains a capability it did not have, and the reach this file guards
   * is unchanged.
   *
   * Nor is the residency new: `sync-keys.ts` already decided on one hold of derived keys, evicted on
   * lock and surviving background, *instead of a prompt per sync* — precisely so a DUST state would
   * stop going stale and self-funded sends would stop switching themselves off. What was missing was
   * anything to **establish** that hold: only `refresh-dust.ts` did, so it took a manual refresh to
   * start a session's hold. These four establish it from prompts the user was answering anyway.
   *
   * Anything added here that *reads* the cache is a different and much larger claim.
   */
  'services/midnight/build-transfer.ts',
  'services/midnight/send-self-funded.ts',
  'services/midnight/register-dust.ts',
  'services/midnight/fund-transaction.ts',
  // Same shape as the four above: it opens the vault to pay a transaction's fee from this wallet's
  // DUST, so it holds the mnemonic outright and only ever writes. It is the path most dependent on the
  // hold existing — a fee is refused outright when the DUST state has gone stale.
  'services/midnight/pay-own-fee.ts',
  /*
   * ⚠️ **Populate-only, and the largest surface in this list.** Wallet creation, wallet import and
   * `addAccount` each hold the mnemonic from a prompt the user just answered, so each hands the
   * scheduler the DUST key rather than leaving that wallet — or that *account* — unable to keep DUST
   * current until a manual refresh. An added account is the sharper case: it has its own key at its own
   * index, so without this it is the one account the scheduler could never sync.
   *
   * It is a provider rather than a service, which is why the note is here: it must stay **write-only**.
   * Nothing in this file may come to *read* the cache, because a provider's value is in autocomplete for
   * every screen and that is exactly how seed-derived material leaks into a component (Phase 16 item 42).
   */
  'providers/WalletProvider.tsx',
  /*
   * ⚠️ **Reads the cache to persist it, and writes it back on restore.** The one place that holds every
   * wallet's DUST key at once, so it is the largest single grant in this list — and the reason it is
   * acceptable is that the material is unchanged (DUST keys, already cached) and the *residency* is
   * what moves: from memory-only to one keychain slot, read behind the same biometric as a seed.
   *
   * Not the shielded key. A Zswap key spends coins and there is no viewing-only shielded sync
   * (`State::insert_coin` indexes by a spend-derived nullifier), so persisting it is a different and
   * much larger claim that would need its own slot and its own decision.
   */
  'services/midnight/dust-key-book.ts',
  'services/midnight/dust-key-book.test.ts',
  // Drops it on lock, beside the other caches.
  'hooks/useCeremonyCacheLifecycle.ts',
  'services/midnight/sync-keys-store.ts',
  'hooks/useCeremonyCacheLifecycle.test.ts',
])

const SRC = join(__dirname, '..', '..')

const sourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') sourceFiles(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('sync-keys reach', () => {
  it('is imported only by the sync path and the lock lifecycle', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const relative = file
        .slice(SRC.length + 1)
        .split('\\')
        .join('/')
      if (ALLOWED.has(relative)) continue
      const text = readFileSync(file, 'utf8')
      if (
        /from\s+['"][^'"]*midnight\/sync-keys(-store)?['"]/.test(text) ||
        /['"]\.\/sync-keys(-store)?['"]/.test(text)
      ) {
        offenders.push(relative)
      }
    }
    // Naming them rather than asserting a count: a failure should say which file, not that a number
    // moved. If one of these genuinely needs the keys, add it to ALLOWED and say why in the review.
    expect(offenders).toEqual([])
  })
})
