// Wrangler's CompiledWasm rule turns a `.wasm` import into a compiled module.
// Vite (vitest) hands back a URL string instead — callers must tolerate both.
declare module '*.wasm' {
  const mod: WebAssembly.Module
  export default mod
}
