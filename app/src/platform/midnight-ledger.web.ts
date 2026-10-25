/**
 * Web bootstrap for the Midnight ledger WASM.
 *
 * Metro cannot bundle the webpack-style static `.wasm` ESM import in
 * `@midnight-ntwrk/ledger-v8`'s browser entry, so on web the package resolves
 * to its JS bindings module (`midnight_ledger_wasm_bg.js` — see
 * metro.config.js) and this module registers the initializer that loads the
 * `.wasm` (bundled as a Metro asset), instantiates it with the same import map
 * the package's Node entry builds, and hands the instance to the bindings.
 * `@pnyx/wallet`'s curve backend awaits the initializer before every ledger
 * op, so derivation works once instantiation completes.
 *
 * The snippet import list mirrors `midnight_ledger_wasm_fs.js`; the hashed
 * directory name changes on every `@midnight-ntwrk/ledger-v8` upgrade, which
 * breaks these imports loudly at bundle time — regenerate the list from the
 * new `_fs.js` when bumping the package.
 *
 * @module
 */

import * as bg from '@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.js'
import wasmModuleId from '@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.wasm'
import * as inline0 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline0.js'
import * as inline1 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline1.js'
import * as inline2 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline2.js'
import * as inline3 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline3.js'
import * as inline4 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline4.js'
import * as inline5 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline5.js'
import * as inline6 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline6.js'
import * as inline7 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline7.js'
import * as inline8 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline8.js'
import * as inline9 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline9.js'
import * as inline10 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline10.js'
import * as inline11 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline11.js'
import * as inline12 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline12.js'
import * as inline13 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline13.js'
import * as inline14 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline14.js'
import * as inline15 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline15.js'
import * as inline16 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline16.js'
import * as inline17 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline17.js'
import * as inline18 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline18.js'
import * as inline19 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline19.js'
import * as inline20 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline20.js'
import * as inline21 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline21.js'
import * as inline22 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline22.js'
import * as inline23 from '@midnight-ntwrk/ledger-v8/snippets/midnight-ledger-wasm-9f71df61dc0427fb/inline23.js'
import {setMidnightLedgerInitializer} from '@pnyx/wallet'
import {Asset} from 'expo-asset'

const SNIPPET_DIR = './snippets/midnight-ledger-wasm-9f71df61dc0427fb'
const snippets = {
  inline0,
  inline1,
  inline2,
  inline3,
  inline4,
  inline5,
  inline6,
  inline7,
  inline8,
  inline9,
  inline10,
  inline11,
  inline12,
  inline13,
  inline14,
  inline15,
  inline16,
  inline17,
  inline18,
  inline19,
  inline20,
  inline21,
  inline22,
  inline23,
} as const

const buildImports = (): WebAssembly.Imports => {
  const imports: WebAssembly.Imports = {
    './midnight_ledger_wasm_bg.js': bg as unknown as WebAssembly.ModuleImports,
  }
  for (const [name, mod] of Object.entries(snippets)) {
    imports[`${SNIPPET_DIR}/${name}.js`] = mod as unknown as WebAssembly.ModuleImports
  }
  return imports
}

const instantiate = async (): Promise<void> => {
  const uri = Asset.fromModule(wasmModuleId as number).uri
  const response = await fetch(uri)
  if (!response.ok) {
    throw new Error(`Midnight ledger WASM fetch failed: ${response.status} ${uri}`)
  }
  const bytes = await response.arrayBuffer()
  // Not instantiateStreaming: the dev server serves assets without the
  // required application/wasm content type.
  const {instance} = await WebAssembly.instantiate(bytes, buildImports())
  const exports = instance.exports as {__wbindgen_start: () => void}
  ;(bg as {__wbg_set_wasm: (wasm: WebAssembly.Exports) => void}).__wbg_set_wasm(instance.exports)
  exports.__wbindgen_start()
}

let ready: Promise<void> | null = null

setMidnightLedgerInitializer(() => {
  // Memoized so concurrent ops share one instantiation; reset on failure so a
  // transient fetch error doesn't poison every later derivation.
  ready ??= instantiate().catch((cause: unknown) => {
    ready = null
    throw cause
  })
  return ready
})
