import {encodeCardanoSignRequest, fountainEncoder, UR_TYPE_SIGN_REQUEST, UR_TYPE_SIGNATURE} from '@pnyx/ur'
import {describe, expect, it} from 'vitest'
import {urScanSession} from './ur-scan-session'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

const request = encodeCardanoSignRequest({
  // Large enough to need several frames, which is the whole point of the session.
  signData: bytes(900, 0x5a),
  utxos: [],
  extraSigners: [],
})

const parts = (count: number, maxFragment = 120): string[] => {
  const encoder = fountainEncoder(request, UR_TYPE_SIGN_REQUEST, maxFragment)
  return Array.from({length: count}, () => encoder.nextPart())
}

describe('accumulating a multi-frame sequence', () => {
  it('starts idle', () => {
    expect(urScanSession().state()).toEqual({kind: 'idle'})
  })

  it('reports progress while scanning and completes at the end', () => {
    const session = urScanSession()
    const frames = parts(40)
    let state = session.state()
    for (const frame of frames) {
      state = session.accept(frame)
      if (state.kind === 'complete') break
    }
    expect(state.kind).toBe('complete')
    if (state.kind === 'complete') expect(state.ur.type).toBe(UR_TYPE_SIGN_REQUEST)
  })

  it('moves the progress fraction forward monotonically', () => {
    const session = urScanSession()
    let previous = 0
    for (const frame of parts(40)) {
      const state = session.accept(frame)
      if (state.kind === 'scanning') {
        expect(state.progress.fraction).toBeGreaterThanOrEqual(previous)
        previous = state.progress.fraction
      }
      if (state.kind === 'complete') break
    }
    expect(previous).toBeGreaterThan(0)
  })

  // The same code stays in shot after the last needed frame. That must not read as an error.
  it('stays complete when the finished code keeps being scanned', () => {
    const session = urScanSession()
    const frames = parts(40)
    let state = session.state()
    for (const frame of frames) {
      state = session.accept(frame)
      if (state.kind === 'complete') break
    }
    expect(state.kind).toBe('complete')
    expect(session.accept(frames[0] as string).kind).toBe('complete')
    expect(session.accept('not a ur at all').kind).toBe('complete')
  })

  it('completes immediately on a single-part UR', () => {
    const small = encodeCardanoSignRequest({signData: bytes(20, 1), utxos: [], extraSigners: []})
    const encoder = fountainEncoder(small, UR_TYPE_SIGN_REQUEST, 500)
    expect(encoder.isSinglePart).toBe(true)
    const state = urScanSession().accept(encoder.nextPart())
    expect(state.kind).toBe('complete')
  })
})

describe('frames it should shrug off', () => {
  // A camera will catch unrelated codes and partial reads. Those must not wedge the scan.
  it('treats a non-UR payload as recoverable', () => {
    const session = urScanSession()
    const state = session.accept('https://example.com')
    expect(state.kind).toBe('error')
    if (state.kind === 'error') expect(state.recoverable).toBe(true)
  })

  it('keeps working after a bad frame', () => {
    const session = urScanSession()
    session.accept('garbage')
    const frames = parts(40)
    let state = session.state()
    for (const frame of frames) {
      state = session.accept(frame)
      if (state.kind === 'complete') break
    }
    expect(state.kind).toBe('complete')
  })
})

describe('frames it should refuse loudly', () => {
  /**
   * The mismatched-UR-type guard. Two sequences interleaved would assemble bytes from different
   * messages, so this is unrecoverable — and telling the user beats a progress bar that never
   * fills.
   */
  it('refuses a second sequence of a different type', () => {
    const session = urScanSession()
    const [first] = parts(1)
    expect(session.accept(first as string).kind).toBe('scanning')

    const other = fountainEncoder(bytes(900, 7), UR_TYPE_SIGNATURE, 120)
    const state = session.accept(other.nextPart())
    expect(state.kind).toBe('error')
    if (state.kind === 'error') {
      expect(state.recoverable).toBe(false)
      expect(state.message).toContain('type-changed')
    }
  })

  it('refuses a UR type outside the accepted list', () => {
    const session = urScanSession({acceptedTypes: [UR_TYPE_SIGN_REQUEST]})
    const other = fountainEncoder(bytes(900, 7), 'crypto-psbt', 120)
    const state = session.accept(other.nextPart())
    expect(state.kind).toBe('error')
    if (state.kind === 'error') {
      expect(state.recoverable).toBe(false)
      expect(state.message).toBe('unsupported:crypto-psbt')
    }
  })

  it('accepts a type that is on the list', () => {
    const session = urScanSession({acceptedTypes: [UR_TYPE_SIGN_REQUEST]})
    expect(session.accept(parts(1)[0] as string).kind).toBe('scanning')
  })

  // Same UR type, different message — the decoder catches this, and it is fatal.
  it('refuses a part from a different message of the same type', () => {
    const session = urScanSession()
    expect(session.accept(parts(1)[0] as string).kind).toBe('scanning')
    const otherMessage = encodeCardanoSignRequest({signData: bytes(900, 0x77), utxos: [], extraSigners: []})
    const other = fountainEncoder(otherMessage, UR_TYPE_SIGN_REQUEST, 120)
    const state = session.accept(other.nextPart())
    expect(state.kind).toBe('error')
    if (state.kind === 'error') expect(state.recoverable).toBe(false)
  })
})

describe('reset', () => {
  it('returns to idle and can scan a fresh sequence', () => {
    const session = urScanSession()
    session.accept(parts(1)[0] as string)
    session.reset()
    expect(session.state()).toEqual({kind: 'idle'})

    let state = session.state()
    for (const frame of parts(40)) {
      state = session.accept(frame)
      if (state.kind === 'complete') break
    }
    expect(state.kind).toBe('complete')
  })

  it('clears a wedged type mismatch', () => {
    const session = urScanSession()
    session.accept(parts(1)[0] as string)
    const other = fountainEncoder(bytes(900, 7), UR_TYPE_SIGNATURE, 120)
    expect(session.accept(other.nextPart()).kind).toBe('error')
    session.reset()
    expect(session.accept(parts(1)[0] as string).kind).toBe('scanning')
  })
})
