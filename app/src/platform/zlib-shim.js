// zlib polyfill wrapper for web/extension bundles.
//
// `browserify-zlib` exposes Z_* and BROTLI_* constants as top-level properties
// but does NOT expose a `.constants` object. Node's real `zlib` has both. Newer
// libraries (axios 1.x http adapter, undici, etc.) read `zlib.constants.Z_SYNC_FLUSH`
// at module-eval time and crash with "Cannot read properties of undefined (reading
// 'Z_SYNC_FLUSH')" when polyfilled by `browserify-zlib` alone.
//
// Even when the consumer module is unreachable at runtime (axios picks XHR on web),
// Metro statically evaluates all `require()` calls inside an included file, so a
// single missing constant freezes the whole app.

const zlib = require('browserify-zlib')

if (!zlib.constants) {
  const constants = {}
  for (const key of Object.keys(zlib)) {
    if (/^(Z_|BROTLI_|DEFLATE|INFLATE|GZIP|GUNZIP|UNZIP|NONE)/.test(key) && typeof zlib[key] !== 'function') {
      constants[key] = zlib[key]
    }
  }
  zlib.constants = constants
}

module.exports = zlib
