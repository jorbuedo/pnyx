// Untyped internals of @midnight-ntwrk/ledger-v8 that the web WASM bootstrap
// (midnight-ledger.web.ts) imports directly: the wasm-bindgen JS bindings, the
// snippet modules, and the .wasm binary (a Metro asset — resolves to an asset
// module id).
declare module '@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.js'
declare module '@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.wasm'
declare module '@midnight-ntwrk/ledger-v8/snippets/*'
