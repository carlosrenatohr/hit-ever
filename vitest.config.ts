import { defineConfig } from 'vitest/config'

/**
 * Wrangler bundles `.wasm` through its CompiledWasm rule (a WebAssembly.Module,
 * see wrangler.jsonc). Vite refuses a plain `.wasm` import, so tests get an
 * empty URL string instead — the code detects that and the tests inject a
 * module compiled from the same vendored bytes (`setWebpWasmForTests`).
 */
function wasmAsUrl() {
  const PREFIX = '\0wasm-url:'
  return {
    name: 'wasm-as-url',
    enforce: 'pre' as const,
    resolveId(id: string) {
      return id.endsWith('.wasm') ? PREFIX + id : null
    },
    load(id: string) {
      return id.startsWith(PREFIX) ? 'export default ""' : null
    },
  }
}

export default defineConfig({
  plugins: [wasmAsUrl()],
})
