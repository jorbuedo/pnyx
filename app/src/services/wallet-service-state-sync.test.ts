/**
 * Every wallet-creating path must fold the manager's groups back into this
 * service's state.
 *
 * The UI reads `groups` from the service's own `SubscriptionRef`, not from the
 * wallet manager — so a creator that registers a group and returns leaves the
 * wallet list a relaunch behind. Both `createSharedWalletGroup` and
 * `createReadOnlyCardanoWallet` did exactly that: the wallet was created, saved
 * to disk, and then absent from the switcher until the app was restarted.
 *
 * A source-level guard rather than a behavioural test because the service wires
 * SQLite tables, store factories and a sync manager; standing all that up to
 * assert one call would test the fakes. This asserts the rule the bug broke, and
 * it fails on the next creator that forgets.
 */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'wallet-service.ts'), 'utf8')

/** Each `const name = …` block at the service's top level, with its body. */
const topLevelBlocks = (): readonly {readonly name: string; readonly body: string}[] => {
  const starts = [...SOURCE.matchAll(/^ {4}const (\w+) = /gm)]
  return starts.map((m, i) => ({
    name: m[1] ?? '',
    body: SOURCE.slice(m.index ?? 0, starts[i + 1]?.index ?? SOURCE.length),
  }))
}

describe('non-derived address rows survive a schema drop', () => {
  // ⚠️ The address table drops and recreates on a version mismatch and nothing rewrites
  // a shared or watch-only wallet's row, because no key of ours derives it. The restore
  // has to run on load, or the first schema bump leaves those wallets addressless.
  it('load() restores them before anything can read an address', () => {
    const loadBlock = SOURCE.slice(SOURCE.indexOf('const load = ('), SOURCE.indexOf('const cachedAddressRow'))
    expect(loadBlock).toContain('restoreNonDerivedAddresses')
  })

  it('the restore writes only rows that are missing', () => {
    const block = SOURCE.slice(SOURCE.indexOf('const restoreNonDerivedAddresses'), SOURCE.indexOf('const load = ('))
    // Restoring unconditionally would reset `isUsed` on every load, and for a watch-only
    // wallet that flag is the reason its single address is in the book at all.
    expect(block).toContain('getAddress')
    expect(block).toContain('if (existing !== null) continue')
  })
})

describe('wallet-service group creators', () => {
  it('every path that registers a group re-reads the manager state', () => {
    const creators = topLevelBlocks().filter((b) => /walletManager\s*\n?\s*\.create/.test(b.body))
    expect(creators.length, 'expected to find the group-creating functions').toBeGreaterThan(0)

    const missing = creators.filter((b) => !b.body.includes('syncManagerState()')).map((b) => b.name)
    expect(
      missing,
      `These create a wallet group without calling syncManagerState(), so the wallet list will not ` +
        `show it until the app restarts:\n${missing.join('\n')}`,
    ).toEqual([])
  })
})
