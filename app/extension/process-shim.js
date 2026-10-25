// Minimal process + Buffer + global shim for browser/extension service worker context.
// Covers the Node.js globals referenced by bundled dependencies.
import {Buffer as _Buffer} from 'buffer'
export const Buffer = _Buffer
export const global = globalThis
const noop = () => {}
const noopStream = {
  isTTY: false,
  columns: 80,
  write: noop,
  getColorDepth: () => 1,
}

export const process = {
  env: {NODE_ENV: 'production'},
  platform: 'browser',
  version: '',
  versions: {node: '', v8: ''},
  argv: [],
  pid: 0,
  exitCode: 0,
  browser: true,
  type: 'renderer',
  noDeprecation: false,
  throwDeprecation: false,
  traceDeprecation: false,
  __nwjs: false,
  stdout: noopStream,
  stderr: noopStream,
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  hrtime: Object.assign(
    (start) => {
      const now = performance.now()
      const s = Math.floor(now / 1000)
      const ns = Math.round((now % 1000) * 1e6)
      if (start) return [s - start[0], ns - start[1]]
      return [s, ns]
    },
    {
      bigint: () => BigInt(Math.round(performance.now() * 1e6)),
    },
  ),
  emit: noop,
  emitWarning: noop,
  on: noop,
  once: noop,
  off: noop,
  removeListener: noop,
  listeners: () => [],
  cwd: () => '/',
}
