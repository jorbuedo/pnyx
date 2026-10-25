/**
 * Drift guard: no new code assumes account 0.
 *
 * ⚠️ **This class of bug cannot be caught by testing, which is the whole reason for a guard.** A
 * hardcoded `accountIndex: 0` — or a parameter that *defaults* to 0 — compiles, runs, and reads the
 * wrong account silently. Nothing fails. And because every manual test drives the first account, the
 * assumption looks correct in exactly the situation where it is indistinguishable from being right.
 *
 * It had already happened: the chain-sync scheduler passed `accountIndex: 0` to `getReceiveAddress`,
 * the unshielded sync **and** the DUST sync, so a wallet sitting on any other account was never kept
 * current at all. The symptom was "self-funding does not work on this wallet", which points nowhere
 * near an index literal three layers away.
 *
 * A default of `0` is the softer form of the same thing, and the more durable: a caller that forgets
 * the argument gets account 0 and no diagnostic. Both shapes are checked.
 *
 * Adding a file here is a deliberate act that shows up in review — the point, as with
 * `sync-keys-scope.test.ts` and `endpoint-single-source.test.ts`.
 *
 * @module
 */

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const APP_ROOT = join(__dirname, '..', '..')
const ROOTS = [join(APP_ROOT, 'src'), join(APP_ROOT, 'app')]

/**
 * ⚠️ **Two allowlists, not one, and that is the point.** The two shapes fail differently, so a file that
 * legitimately carries one must not thereby be excused the other. `WalletProvider.tsx` is the case that
 * forced this: its long-standing API *defaults* are allowed, and the hardcoded literal that broke the
 * scheduler lived in the same file — a single allowlist would have made the guard blind to a recurrence
 * of the exact bug it was written for.
 */

/** May write `accountIndex: 0`, because the account genuinely *is* zero there. */
const ALLOWED_LITERALS = new Set([
  // This guard names the patterns it forbids.
  'src/services/no-pinned-account.test.ts',
  /*
   * Creation-time writes, where account 0 is the only account that exists yet: a wallet is created with
   * one account, and a shared wallet has a single script address. "The first account" rather than "some
   * account we hope is selected".
   */
  'src/services/wallet-service.ts',
  // Fixtures for the UI playground: fabricated wallets, not a wallet's real selection.
  'src/playground/data/wallets.ts',
  /*
   * ⚠️ Not the co-signer rail any more. Its key was derived at one default and *labelled* with another,
   * agreeing only by coincidence — a mismatch publishes a key under an account it does not belong to,
   * and that lands on the other participants in a shared wallet. Both sides now read the caller's
   * selection, so they agree by construction. These two remain because the account they name is a
   * *counterparty's*, taken from the envelope rather than assumed about us.
   */
  'src/services/cardano/cosign/interop.ts',
  'src/services/cardano/multiparty/build.ts',
])

/** May default an account parameter to 0. */
const ALLOWED_DEFAULTS = new Set([
  'src/services/no-pinned-account.test.ts',
  /*
   * API defaults on the wallet surface. Long-standing and load-bearing for many call sites; narrowing
   * them is its own piece of work, and doing it here would mean changing every caller in one commit.
   * ⚠️ Not permission for a new one — that is the bug this file exists for. And note these files are
   * **not** in `ALLOWED_LITERALS`: a hardcoded index here is still caught.
   */
  'src/providers/WalletProvider.tsx',
  'src/services/wallet-service.ts',
  'src/services/cardano/account.ts',
  'src/services/cardano/cardano-store.ts',
  /*
   * Same rail, and this one has a *storage* consequence: account 0 keeps the suffix-free key so existing
   * caches survive, and other accounts append `.${account}`. Changing the default would silently
   * repoint reads at a key that was never written.
   */
  'src/services/cardano/gov-keys.ts',
])

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Production files only.
 *
 * A test fixture saying `accountIndex: 0` is *data* — it describes a wallet the test invented, and
 * asserting on account 0 is how most of these suites are legibly written. What this guard is for is
 * production code that assumes the selected account is 0, which is a different thing entirely.
 */
const files = ROOTS.flatMap((root) => walk(root))
  .map((full) => ({rel: full.slice(APP_ROOT.length + 1).replaceAll('\\', '/'), text: readFileSync(full, 'utf8')}))
  .filter((f) => !/\.test\.tsx?$/.test(f.rel))

describe('no code pins itself to account 0', () => {
  it('finds the files it is meant to be checking', () => {
    // A walk that silently matched nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('hardcodes no `accountIndex: 0`', () => {
    const offenders = files
      .filter((f) => !ALLOWED_LITERALS.has(f.rel) && /accountIndex:\s*0\b/.test(f.text))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('coalesces no account to 0 with `?? 0`', () => {
    // ⚠️ The third shape, and the one that hid the longest: `accountIndex: params.accountIndex ?? 0`
    // reads as careful — it *looks* like it handles the optional case. It handles it by guessing. The
    // Midnight address repair did exactly this and wrote account 0's rows for whatever account you were
    // on, so the Receive screen was empty and the sync had no address to read.
    const offenders = files
      .filter((f) => !ALLOWED_DEFAULTS.has(f.rel) && /\baccountIndex\s*\?\?\s*0\b/.test(f.text))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('defaults no account parameter to 0', () => {
    // The softer, more durable form: a caller that forgets the argument reads the wrong account with
    // no diagnostic at all.
    const offenders = files
      .filter(
        (f) =>
          !ALLOWED_DEFAULTS.has(f.rel) &&
          (/\baccountIndex\s*=\s*0\b/.test(f.text) || /\baccount\s*=\s*0\b/.test(f.text)),
      )
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })
})
