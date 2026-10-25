/**
 * Shared esbuild browser shim definitions for the Chrome extension build.
 *
 * Used by the background script and the Ledger / Trezor BLE bridge bundles to
 * replace Node.js built-ins and browser-incompatible packages with lightweight
 * service-worker-compatible stubs.
 *
 * Why a function-based Transform instead of an ES6 class:
 * cipher-base (used by create-hash → bitcoinjs-lib) calls Transform.call(this)
 * in ES5 inheritance style. ES6 classes throw when invoked without 'new', so
 * we provide a constructor function that handles both call styles.
 *
 * @module
 */

import type {Plugin} from 'esbuild'

const streamShim = [
  `function Transform() {`,
  `  if (!(this instanceof Transform)) return new Transform();`,
  `  this._events = this._events || {};`,
  `  this.readable = true; this.writable = true;`,
  `}`,
  `Transform.prototype.on = function(ev, fn) { (this._events[ev] = this._events[ev] || []).push(fn); return this; };`,
  `Transform.prototype.emit = function(ev) { var ls = this._events[ev]; if (ls) { var a = Array.prototype.slice.call(arguments, 1); for (var i = 0; i < ls.length; i++) ls[i].apply(this, a); } };`,
  `Transform.prototype.removeListener = function(ev, fn) { if (this._events[ev]) this._events[ev] = this._events[ev].filter(function(l) { return l !== fn; }); return this; };`,
  `Transform.prototype.removeAllListeners = function(ev) { if (ev) delete this._events[ev]; else this._events = {}; return this; };`,
  `Transform.prototype.once = function(ev, fn) { var self = this; function w() { self.removeListener(ev, w); fn.apply(this, arguments); } return this.on(ev, w); };`,
  `Transform.prototype.push = function() {};`,
  `Transform.prototype.pipe = function(dest) { return dest; };`,
  `Transform.prototype.write = function(chunk, enc, cb) { if (typeof enc === 'function') cb = enc; if (typeof cb === 'function') cb(); return true; };`,
  `Transform.prototype.end = function(chunk, enc, cb) { if (typeof chunk === 'function') cb = chunk; else if (typeof enc === 'function') cb = enc; if (typeof cb === 'function') cb(); return this; };`,
  `Transform.prototype.destroy = function() { return this; };`,
  `Transform.prototype.resume = function() { return this; };`,
  `Transform.prototype.pause = function() { return this; };`,
  `export { Transform };`,
  `export var Readable = Transform; export var Writable = Transform;`,
  `export var Duplex = Transform; export var PassThrough = Transform; export var Stream = Transform;`,
  `export default {};`,
].join('\n')

/**
 * Map of module specifiers to their browser-compatible stub implementations.
 * Covers Node.js built-ins and packages that reference Node APIs unavailable
 * in Chrome extension service workers.
 */
export const BROWSER_SHIMS: ReadonlyMap<string, string> = new Map([
  [
    'cross-fetch',
    // Chrome extension service workers have native fetch but no XMLHttpRequest.
    // cross-fetch's node build uses XMLHttpRequest internally; replace it with
    // a thin wrapper around the native fetch available in service workers.
    [
      `export var fetch = globalThis.fetch.bind(globalThis);`,
      `export var Headers = globalThis.Headers;`,
      `export var Request = globalThis.Request;`,
      `export var Response = globalThis.Response;`,
      `export default globalThis.fetch.bind(globalThis);`,
    ].join('\n'),
  ],
  [
    'react-native',
    [
      `var noop = function(){};`,
      `var NoopComponent = function(){ return null; };`,
      `export var Platform = { OS: 'web', select: function(obj){ return obj.web ?? obj.default; } };`,
      `export var NativeEventEmitter = class {};`,
      `export var TurboModuleRegistry = { getEnforcing: function(){ return {}; } };`,
      `export var NativeModules = {};`,
      `export var AppState = { currentState: 'active', addEventListener: function(){ return { remove: noop }; } };`,
      `export var AppRegistry = { registerComponent: noop, runApplication: noop };`,
      `export var LogBox = { ignoreLogs: noop, ignoreAllLogs: noop };`,
      `export var Alert = { alert: noop };`,
      `export var Appearance = { getColorScheme: function(){ return 'light'; }, addChangeListener: function(){ return { remove: noop }; } };`,
      `export var StyleSheet = { create: function(s){ return s; }, flatten: function(s){ return s; }, hairlineWidth: 1 };`,
      `export var Dimensions = { get: function(){ return { width: 0, height: 0, scale: 1, fontScale: 1 }; }, addEventListener: function(){ return { remove: noop }; } };`,
      `export var Animated = { Value: class { interpolate(){ return this; } }, View: NoopComponent, Text: NoopComponent, createAnimatedComponent: function(c){ return c; }, timing: function(){ return { start: noop }; }, spring: function(){ return { start: noop }; }, event: noop };`,
      `export var Easing = { linear: noop, ease: noop, bezier: function(){ return noop; } };`,
      `export var Keyboard = { dismiss: noop, addListener: function(){ return { remove: noop }; } };`,
      `export var Modal = NoopComponent;`,
      `export var PanResponder = { create: function(){ return { panHandlers: {} }; } };`,
      `export var ScrollView = NoopComponent;`,
      `export var View = NoopComponent;`,
      `export var Text = NoopComponent;`,
      `export var TextInput = NoopComponent;`,
      `export var Image = NoopComponent;`,
      `export var TouchableOpacity = NoopComponent;`,
      `export var TouchableWithoutFeedback = NoopComponent;`,
      `export var UIManager = { getViewManagerConfig: function(){ return {}; } };`,
      `export default new Proxy({}, { get: function(_, key){ if (key === 'Platform') return Platform; return undefined; } });`,
    ].join('\n'),
  ],
  // Re-export the Web Crypto API available in service workers
  ['crypto', `export default globalThis.crypto; export const { subtle, getRandomValues } = globalThis.crypto ?? {};`],
  ['stream', streamShim],
  // Empty stubs for Node builtins only used in conditional server paths
  ['http', `export default {};`],
  ['https', `export default {};`],
  ['zlib', `export default {};`],
  [
    'util',
    [
      `var inspectCustom = typeof Symbol !== 'undefined' ? Symbol.for('nodejs.util.inspect.custom') : undefined;`,
      `export var inspect = Object.assign(function inspect(obj) { return String(obj); }, { custom: inspectCustom });`,
      `export var types = {};`,
      `export default { inspect: inspect, types: types };`,
    ].join('\n'),
  ],
])

/** Shim keys needed by the background service worker (full set). */
export const BACKGROUND_SHIM_KEYS = [...BROWSER_SHIMS.keys()] as const

/** Shim keys needed by the BLE bridge bundles (Node built-ins only). */
export const BRIDGE_SHIM_KEYS = ['stream', 'http', 'https', 'zlib', 'util'] as const

/**
 * esbuild plugin that replaces Node.js built-ins and browser-incompatible
 * packages with lightweight service-worker-compatible stubs.
 *
 * @param keys - Which shims to include. Defaults to all shims (background script).
 *               Pass BRIDGE_SHIM_KEYS for BLE bridge bundles.
 */
export function browserShimsPlugin(keys: ReadonlyArray<string> = BACKGROUND_SHIM_KEYS): Plugin {
  const active = new Map([...BROWSER_SHIMS].filter(([k]) => keys.includes(k)))
  return {
    name: 'browser-shims',
    setup(build) {
      build.onResolve({filter: new RegExp(`^(${[...active.keys()].join('|')})(/.*)?$`)}, (args) => ({
        path: args.path,
        namespace: 'browser-shims',
      }))
      build.onLoad({filter: /.*/, namespace: 'browser-shims'}, (args) => {
        const base = args.path.split('/')[0] ?? args.path
        return {contents: active.get(base) ?? 'export default {};', loader: 'js'}
      })
    },
  }
}
