import {describe, expect, it} from 'vitest'
import {runtimeSpecifiers} from './specifiers.js'

describe('runtimeSpecifiers', () => {
  it('keeps value imports in every shape', () => {
    const code = [
      "import fs from 'node:fs'",
      "import {a, b} from './pair.js'",
      "import * as ns from 'namespaced'",
      "import 'side-effect'",
      "export {c} from './reexport.js'",
      "export * from './star.js'",
    ].join('\n')
    expect(new Set(runtimeSpecifiers(code))).toEqual(
      new Set(['node:fs', './pair.js', 'namespaced', 'side-effect', './reexport.js', './star.js']),
    )
  })

  it('drops type-only imports and re-exports', () => {
    const code = [
      // A string fixture for the specifier lexer, not an import — the path need not exist.
      "import type {Witnesses} from '../../../contract/managed/identity/contract/index.js'",
      "import type Config from './config.js'",
      "export type {ChainRef} from './store.js'",
    ].join('\n')
    expect(runtimeSpecifiers(code)).toEqual([])
  })

  it('keeps an import that only mixes in an inline type specifier', () => {
    // `import {type X, y}` still emits a runtime import for the module — unlike `import type {X}`.
    const code = "import {type SubmitRetryOptions, createTxSubmitter} from './submission.js'"
    expect(runtimeSpecifiers(code)).toEqual(['./submission.js'])
  })

  it('keeps multi-line import clauses', () => {
    const code = ['import {', '  assembleWallet,', '  ensureDust,', "} from './wallet.js'"].join('\n')
    expect(runtimeSpecifiers(code)).toEqual(['./wallet.js'])
  })

  it('drops a multi-line type-only import clause', () => {
    const code = ['import type {', '  PnyxPrivateState,', "} from './witnesses.js'"].join('\n')
    expect(runtimeSpecifiers(code)).toEqual([])
  })

  it('finds literal dynamic imports and requires', () => {
    const code = ["const m = await import('./lazy.js')", "const n = require('legacy')"].join('\n')
    expect(new Set(runtimeSpecifiers(code))).toEqual(new Set(['./lazy.js', 'legacy']))
  })

  it('ignores a dynamic import of a non-literal path', () => {
    // `createChainClient` loads the compiled contract this way. Unresolvable by design, and the reason
    // the sponsor host carries no contract module.
    const code = 'const contractModule = await import(options.contractModulePath)'
    expect(runtimeSpecifiers(code)).toEqual([])
  })

  it('deduplicates repeated specifiers', () => {
    const code = ["import {a} from './same.js'", "import {b} from './same.js'"].join('\n')
    expect(runtimeSpecifiers(code)).toEqual(['./same.js'])
  })

  it('does not treat the word from inside a string as a clause', () => {
    const code = ["const message = 'imported from nowhere'", "import {real} from './real.js'"].join('\n')
    expect(runtimeSpecifiers(code)).toEqual(['./real.js'])
  })

  it('reads the real sponsor entry point without inventing type-only imports', () => {
    const specs = runtimeSpecifiers(
      [
        '// header comment',
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import { createSponsorClient } from '@pnyx/chain-client/sponsor-client';",
        "import type { ProvenSettlement } from './chain.js';",
        "import { callbackSettlementSink } from './sponsor-callback.js';",
        "import { createSponsorQueue } from './sponsor.js';",
      ].join('\n'),
    )
    expect(new Set(specs)).toEqual(
      new Set(['node:fs', 'node:path', '@pnyx/chain-client/sponsor-client', './sponsor-callback.js', './sponsor.js']),
    )
    expect(specs).not.toContain('./chain.js')
  })
})
