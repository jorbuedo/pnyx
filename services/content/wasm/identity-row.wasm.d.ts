// `.wasm` imports resolve to a compiled module in workerd; wrangler bundles the file.
declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}
