import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {gzipSync} from 'node:zlib'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {loadDustState, storeDustState} from './dust-state.js'

describe('dust-state', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dust-state-'))
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('round-trips a snapshot', () => {
    const file = path.join(dir, 'dust.gz')
    const state = JSON.stringify({watermark: 123456n.toString(), tree: 'x'.repeat(10_000)})
    storeDustState(file, state)
    expect(loadDustState(file)).toBe(state)
  })

  it('returns null when no snapshot exists', () => {
    expect(loadDustState(path.join(dir, 'missing.gz'))).toBeNull()
  })

  it('throws on a corrupt snapshot instead of returning garbage', () => {
    const file = path.join(dir, 'corrupt.gz')
    fs.writeFileSync(file, Buffer.from('not gzip data'))
    expect(() => loadDustState(file)).toThrow()
  })

  it('creates missing parent directories', () => {
    const file = path.join(dir, 'nested', 'deeper', 'dust.gz')
    storeDustState(file, 'state')
    expect(loadDustState(file)).toBe('state')
  })

  it('overwrites atomically and leaves no temp file behind', () => {
    const file = path.join(dir, 'dust.gz')
    storeDustState(file, 'first')
    storeDustState(file, 'second')
    expect(loadDustState(file)).toBe('second')
    expect(fs.readdirSync(dir)).toEqual(['dust.gz'])
  })

  it('writes owner-only permissions', () => {
    const file = path.join(dir, 'dust.gz')
    storeDustState(file, 'state')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('stores gzip-compressed bytes on disk', () => {
    const file = path.join(dir, 'dust.gz')
    const state = 'a'.repeat(100_000)
    storeDustState(file, state)
    const onDisk = fs.readFileSync(file)
    expect(onDisk.length).toBeLessThan(state.length)
    expect(onDisk.length).toBeGreaterThan(0)
    expect(onDisk.equals(gzipSync(Buffer.from(state, 'utf8')))).toBe(true)
  })
})
