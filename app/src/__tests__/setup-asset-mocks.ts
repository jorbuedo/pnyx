/**
 * Vitest global setup: stub out static asset files so they can be require()'d
 * in test context without causing a SyntaxError.
 *
 * Node.js by default tries to parse required files as JavaScript or JSON.
 * SVG / PNG / JPEG files are binary or XML — they fail to parse.
 * This setup extends Node's module loader to return a stub string for these
 * extensions so that wallet source files using require('./foo.svg') resolve
 * to a truthy value in tests without errors.
 *
 * Production builds (Metro on React Native, webpack on web) handle these
 * assets natively via their own loaders — this stub is test-only.
 */
import Module from 'node:module'

// React Native + Expo modules check `__DEV__` at module init. Without this
// shim, importing anything that transitively pulls expo-modules-core blows up
// with `ReferenceError: __DEV__ is not defined` before any test can run.
;(globalThis as {__DEV__?: boolean}).__DEV__ = true

const ASSET_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']

for (const ext of ASSET_EXTENSIONS) {
  // Vitest's vite-node processes TypeScript files but raw asset files fall
  // through to Node's native CJS require(). Registering a custom extension
  // handler intercepts these before Node tries to parse them as JS/JSON.
  // @ts-expect-error — Module._extensions is a Node.js internal API
  Module._extensions[ext] = (mod: NodeJS.Module, filename: string) => {
    // @ts-expect-error — mod._compile is a Node.js internal API
    mod._compile(`module.exports = ${JSON.stringify(filename)}`, filename)
  }
}
