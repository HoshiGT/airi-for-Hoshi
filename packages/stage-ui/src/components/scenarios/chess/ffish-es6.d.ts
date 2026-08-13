// The shipped ffish.d.ts omits `wasmBinary`, the Emscripten option that
// bypasses the glue's runtime fetch of the wasm file (needed because the
// production Electron renderer serves the app over file://, where fetch
// rejects and Module.ready never resolves). Declared here so the in-app load
// path in ffish-module.ts stays typed instead of casting at the call site.
declare module 'ffish-es6' {
  interface ModuleOptions {
    /** Raw wasm bytes; skips fetch/instantiateStreaming in the Emscripten glue. */
    wasmBinary?: ArrayBuffer | Uint8Array
  }
}
