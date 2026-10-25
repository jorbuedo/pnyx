import {describe, expect, it} from 'vitest'
import {stepsFrom, validateChain} from './chain.js'
import {type Migration, MigrationChainError, type MigrationConfig} from './types.js'

const cfg = <T>(overrides: Partial<MigrationConfig<T>>): MigrationConfig<T> => ({
  key: 'test',
  currentVersion: 1,
  migrations: [],
  validate: (_v): _v is T => true,
  ...overrides,
})

describe('validateChain', () => {
  it('accepts an empty chain at currentVersion 1', () => {
    expect(() => validateChain(cfg({}))).not.toThrow()
  })

  it('rejects an empty chain when currentVersion > 1', () => {
    expect(() => validateChain(cfg({currentVersion: 2}))).toThrow(MigrationChainError)
  })

  it('rejects currentVersion < 1', () => {
    expect(() => validateChain(cfg({currentVersion: 0}))).toThrow(MigrationChainError)
    expect(() => validateChain(cfg({currentVersion: -1}))).toThrow(MigrationChainError)
  })

  it('rejects non-integer versions', () => {
    expect(() => validateChain(cfg({currentVersion: 1.5}))).toThrow(MigrationChainError)
  })

  it('accepts a contiguous v0 → v1 → v2 chain', () => {
    const migrations: Migration[] = [
      {from: 0, to: 1, migrate: (x) => x},
      {from: 1, to: 2, migrate: (x) => x},
    ]
    expect(() => validateChain(cfg({currentVersion: 2, migrations}))).not.toThrow()
  })

  it('accepts a chain that starts at v1 (no legacy detection)', () => {
    const migrations: Migration[] = [{from: 1, to: 2, migrate: (x) => x}]
    expect(() => validateChain(cfg({currentVersion: 2, migrations}))).not.toThrow()
  })

  it('rejects a chain with a gap', () => {
    const migrations: Migration[] = [
      {from: 0, to: 1, migrate: (x) => x},
      {from: 2, to: 3, migrate: (x) => x},
    ]
    expect(() => validateChain(cfg({currentVersion: 3, migrations}))).toThrow(/gap/)
  })

  it('rejects a chain where a step skips versions (to !== from + 1)', () => {
    const migrations: Migration[] = [{from: 0, to: 2, migrate: (x) => x}]
    expect(() => validateChain(cfg({currentVersion: 2, migrations}))).toThrow(/to must equal from \+ 1/)
  })

  it('rejects duplicate from-versions', () => {
    const migrations: Migration[] = [
      {from: 0, to: 1, migrate: (x) => x},
      {from: 0, to: 1, migrate: (x) => x},
    ]
    expect(() => validateChain(cfg({currentVersion: 1, migrations}))).toThrow(/duplicate/)
  })

  it('rejects a migration whose migrate is not a function', () => {
    const migrations = [{from: 0, to: 1, migrate: null as unknown as (x: unknown) => unknown}]
    expect(() => validateChain(cfg({currentVersion: 1, migrations}))).toThrow(/migrate must be a function/)
  })

  it('memoizes by config identity — subsequent calls are no-ops even if mutated', () => {
    const migrations: Migration[] = [{from: 0, to: 1, migrate: (x) => x}]
    const config = cfg({currentVersion: 1, migrations})
    expect(() => validateChain(config)).not.toThrow()
    // Mutate to a shape that would otherwise throw. Because the config
    // object identity is the memo key, validation is skipped.
    ;(config as {currentVersion: number}).currentVersion = 99
    expect(() => validateChain(config)).not.toThrow()
  })

  it("rejects a chain that doesn't end at currentVersion", () => {
    const migrations: Migration[] = [{from: 0, to: 1, migrate: (x) => x}]
    expect(() => validateChain(cfg({currentVersion: 3, migrations}))).toThrow(/ends at to=1/)
  })
})

describe('stepsFrom', () => {
  const migrations: Migration[] = [
    {from: 0, to: 1, migrate: (x) => `v1:${String(x)}`},
    {from: 1, to: 2, migrate: (x) => `v2:${String(x)}`},
    {from: 2, to: 3, migrate: (x) => `v3:${String(x)}`},
  ]

  it('returns every step when entering at v0', () => {
    expect(stepsFrom(migrations, 0)).toHaveLength(3)
  })

  it('skips steps whose from is below the entry version', () => {
    expect(stepsFrom(migrations, 2).map((m) => m.from)).toEqual([2])
  })

  it('returns [] when entering at or past the chain tip', () => {
    expect(stepsFrom(migrations, 3)).toEqual([])
    expect(stepsFrom(migrations, 4)).toEqual([])
  })
})
