import {describe, expect, it} from 'vitest'
import {THP_CONTROL_BYTE} from './constants'
import {encode} from './encode'
import {createThpState, type ThpState} from './state'

/**
 * The THP 2.1 negotiation bit.
 *
 * A device reporting `protocol_version_minor > 0` expects the host to say it speaks 2.1 by setting
 * the ack bit (bit 3) on the HANDSHAKE_INIT_REQ magic byte. Sending the bare control byte leaves the
 * device on a different ACK discipline than the host follows — which is what a real T3W1 on firmware
 * 2.10 rejected, with `Failure_UnexpectedMessage` ("Message unrecognized in pairing context") on the
 * first ENCRYPTED frame after the handshake (`ThpPairingRequest`), while every earlier step succeeded.
 *
 * Driven through the public {@link encode} rather than the internal dispatch, so the test exercises
 * the path a caller actually takes.
 */
describe('handshake init magic byte', () => {
  const channel = new Uint8Array([0xab, 0xcd])

  const stateWith = (piggybackAckAvailable: boolean): ThpState => {
    const state = createThpState()
    state.channel = channel
    state.piggybackAckAvailable = piggybackAckAvailable
    return state
  }

  const frame = (piggybackAckAvailable: boolean): Uint8Array =>
    encode({
      messageName: 'ThpHandshakeInitRequest',
      data: {key: new Uint8Array(32).fill(7), tryToUnlock: 0},
      thpState: stateWith(piggybackAckAvailable),
      // Unused for a THP control message, which never reaches the protobuf encoder.
      protobufEncoder: () => {
        throw new Error('protobufEncoder must not be called for a THP control message')
      },
    })

  it('sets the ack bit when the device speaks THP 2.1', () => {
    // bit 3 — `addAckBit` is `magic | (ackBit << 3)`.
    expect(frame(true)[0]).toBe(THP_CONTROL_BYTE.HANDSHAKE_INIT_REQ | 0b1000)
  })

  it('leaves the bare control byte for a 2.0 device', () => {
    expect(frame(false)[0]).toBe(THP_CONTROL_BYTE.HANDSHAKE_INIT_REQ)
  })

  it('changes only the magic byte, not the rest of the frame', () => {
    // Guards against "fixing" this by shifting the length field or the payload.
    const on = frame(true)
    const off = frame(false)
    expect(on).toHaveLength(off.length)
    // The trailing CRC covers the magic byte, so it legitimately differs; everything between must not.
    expect(on.slice(1, on.length - 4)).toEqual(off.slice(1, off.length - 4))
  })

  it('defaults to unavailable, so a device that reports nothing is treated as 2.0', () => {
    expect(createThpState().piggybackAckAvailable).toBe(false)
  })
})
