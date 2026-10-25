import {describe, expect, it} from 'vitest'
import {bytesToHex} from './bytes'
import messagesJson from './messages.json' with {type: 'json'}
import {decodeMessage, encodeMessage, loadDefinitions, parseConfigure} from './protobuf'
import {getThpProtobufDefinitions} from './thp/protobuf-definitions'

const originalFunction = globalThis.Function

const forceReflectionFallback = (messageName: string) => {
  const root = parseConfigure(messagesJson as import('protobufjs').INamespace)
  const messageType = root.lookupType(messageName) as unknown as {setup: () => unknown}
  const throwingFunction = (() => {
    throw new Error('CSP blocked Function')
  }) as unknown as FunctionConstructor

  ;(globalThis as typeof globalThis & {Function: FunctionConstructor}).Function = throwingFunction
  try {
    messageType.setup()
  } finally {
    ;(globalThis as typeof globalThis & {Function: FunctionConstructor}).Function = originalFunction
  }

  return root
}

const encodeHex = (root: import('protobufjs').Root, messageName: string, data: Record<string, unknown>) =>
  bytesToHex(encodeMessage(root, messageName, data).message)

describe('trezor protobuf reflection fallback', () => {
  it('matches codegen output for SignTx when reflection fallback is forced', () => {
    const data = {
      inputs_count: 1,
      outputs_count: 2,
      coin_name: 'Bitcoin',
      version: 1,
      lock_time: 0,
    }
    const normalRoot = parseConfigure(messagesJson as import('protobufjs').INamespace)
    const fallbackRoot = forceReflectionFallback('SignTx')

    expect(encodeHex(normalRoot, 'SignTx', data)).toBe('080210011a07426974636f696e20012800')
    expect(encodeHex(fallbackRoot, 'SignTx', data)).toBe(encodeHex(normalRoot, 'SignTx', data))
  })

  it('matches codegen output for CardanoSignTxInit when reflection fallback is forced', () => {
    const data = {
      signing_mode: 0,
      protocol_magic: 764824073,
      network_id: 1,
      inputs_count: 1,
      outputs_count: 1,
      fee: '200000',
      certificates_count: 0,
      withdrawals_count: 0,
      has_auxiliary_data: false,
      witness_requests_count: 1,
      minting_asset_groups_count: 0,
      collateral_inputs_count: 0,
      required_signers_count: 0,
      has_collateral_return: false,
      reference_inputs_count: 0,
      derivation_type: 2,
      include_network_id: true,
      tag_cbor_sets: true,
    }
    const normalRoot = parseConfigure(messagesJson as import('protobufjs').INamespace)
    const fallbackRoot = forceReflectionFallback('CardanoSignTxInit')

    expect(encodeHex(normalRoot, 'CardanoSignTxInit', data)).toBe(
      '0800108994d9ec0218012001280130c09a0c4000480050006001680070027801880100900100980100a80100b80101',
    )
    expect(encodeHex(fallbackRoot, 'CardanoSignTxInit', data)).toBe(encodeHex(normalRoot, 'CardanoSignTxInit', data))
  })
})

// CardanoNativeScript is self-recursive (`scripts` is a repeated
// CardanoNativeScript), so decode depth is driven by the payload, not the
// schema. A malicious device could otherwise exhaust the JS stack — see
// CVE-2026-44289. protobufjs's generated decoders guard themselves; the
// reflection fallback needs its own counter.
const varint = (n: number): number[] => {
  const out: number[] = []
  let rest = n
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  out.push(rest)
  return out
}

/** `depth` levels of nested CardanoNativeScript.scripts (field 2, wire type 2). */
const nestedScripts = (depth: number): Uint8Array => {
  let payload: number[] = []
  for (let i = 0; i < depth; i++) payload = [0x12, ...varint(payload.length), ...payload]
  return Uint8Array.from(payload)
}

const rootFor = (path: 'codegen' | 'reflection') =>
  path === 'reflection'
    ? forceReflectionFallback('CardanoNativeScript')
    : parseConfigure(messagesJson as import('protobufjs').INamespace)

describe('trezor protobuf decode depth guard', () => {
  for (const path of ['codegen', 'reflection'] as const) {
    it(`bounds recursion instead of overflowing the stack on the ${path} path`, () => {
      // Comfortably past Reader.recursionLimit (100) but far below what it
      // takes to actually exhaust the stack — an unguarded decoder decodes
      // this happily, so the assertion fails without the depth counter.
      expect(() => decodeMessage(rootFor(path), 'CardanoNativeScript', nestedScripts(500))).toThrow(
        /maximum nesting depth exceeded/,
      )
    })

    it(`still decodes legitimately nested scripts on the ${path} path`, () => {
      // type=ALL(1), one nested script of type=PUB_KEY(0)
      const payload = Uint8Array.from([0x08, 0x01, 0x12, 0x02, 0x08, 0x00])
      const {type, message} = decodeMessage(rootFor(path), 'CardanoNativeScript', payload)

      expect(type).toBe('CardanoNativeScript')
      expect(message.type).toBe('ALL')
      expect((message.scripts as {type: string}[])[0]?.type).toBe('PUB_KEY')
    })
  }
})

describe('wire type resolution', () => {
  /**
   * The defect this pins: every THP message resolved to no number, the miss fell through to the
   * message *name* cast to `number`, and `setUint16` wrote `0x0000` — message type 0, `Initialize`.
   * A real T3W1 answered `Failure_UnexpectedMessage` ("Message unrecognized in pairing context") on
   * `ThpPairingRequest` while the payload was byte-perfect, which is what made it survive being
   * looked at directly more than once.
   */
  const loaded = async () => {
    const messages = parseConfigure(messagesJson as never)
    await loadDefinitions(messages, 'thp', getThpProtobufDefinitions as never)
    return messages
  }

  it('resolves a dynamically loaded THP message to its firmware wire number', async () => {
    const messages = await loaded()
    // 1008 matches the firmware's ThpMessageType enum, decoded from upstream's bufbuild descriptors.
    expect(encodeMessage(messages, 'ThpPairingRequest', {host_name: 'Pnyx', app_name: 'Pnyx'}).messageType).toBe(1008)
    expect(encodeMessage(messages, 'ThpSelectMethod', {selected_pairing_method: 2}).messageType).toBe(1010)
    expect(encodeMessage(messages, 'ThpEndRequest', {}).messageType).toBe(1018)
  })

  it('still resolves root-level messages, which read from the same rule', async () => {
    const messages = await loaded()
    expect(encodeMessage(messages, 'GetFeatures', {}).messageType).toBe(55)
    expect(encodeMessage(messages, 'ButtonAck', {}).messageType).toBe(27)
  })

  it('never returns a non-number, whatever the lookup does', async () => {
    const messages = await loaded()
    for (const name of ['ThpPairingRequest', 'ThpCodeEntryChallenge', 'GetFeatures']) {
      // A string here is silently written as 0x0000 by setUint16 — the whole failure mode.
      expect(typeof encodeMessage(messages, name, {}).messageType, name).toBe('number')
    }
  })

  it('throws for a message with no wire type rather than inventing one', async () => {
    const messages = await loaded()
    // `ThpDeviceProperties` is a real type that is never sent as a message, so it has no enum entry.
    expect(() => encodeMessage(messages, 'ThpDeviceProperties', {})).toThrow(/No wire type for message/)
  })
})

describe('decode-side wire type resolution', () => {
  /**
   * The mirror of the encode defect, and the reason fixing only encode moved the failure one step
   * later instead of removing it: `ThpPairingRequest` was finally accepted, the device raised its
   * confirm prompt, and decoding the approval threw "Cannot read property 'length' of undefined" —
   * `valuesById[1009]` was `undefined` and went straight into `lookupType`.
   */
  const loaded = async () => {
    const messages = parseConfigure(messagesJson as never)
    await loadDefinitions(messages, 'thp', getThpProtobufDefinitions as never)
    return messages
  }

  it('decodes the THP approval that answers a confirmed pairing prompt', async () => {
    const messages = await loaded()
    expect(decodeMessage(messages, 1009, new Uint8Array(0))).toEqual({
      type: 'ThpPairingRequestApproved',
      message: {},
    })
  })

  it('decodes a THP message that carries fields', async () => {
    const messages = await loaded()
    expect(decodeMessage(messages, 1024, new Uint8Array(0)).type).toBe('ThpCodeEntryCommitment')
  })

  it('still decodes root-level messages', async () => {
    const messages = await loaded()
    expect(decodeMessage(messages, 27, new Uint8Array(0)).type).toBe('ButtonAck')
  })

  it('names the unknown type instead of passing undefined into lookupType', async () => {
    const messages = await loaded()
    // The old failure was "Cannot read property 'length' of undefined", which named nothing at all.
    expect(() => decodeMessage(messages, 9999, new Uint8Array(0))).toThrow(/Unknown message type 9999/)
  })
})

describe('loadDefinitions enum merge', () => {
  /**
   * The regression that took Trezor pairing down for nine days, and the reason it was invisible.
   *
   * protobufjs 7.6.5 (a CVE bump, a7df11b) added a root-level `_fullyQualifiedObjects` cache and an
   * early bailout in `Namespace.lookup`, so a *relative* `lookupEnum('MessageType')` from a nested
   * namespace started resolving to the ROOT enum instead of the package's own. The merge here was
   * guarded by `found.parent === pkg` — correct under 7.4.0 — so it silently stopped running, every
   * THP message lost its wire number, and frames went out as 0x0000 (`Initialize`).
   *
   * Asserting the merged result rather than the mechanism: it holds whichever way protobufjs resolves
   * names next.
   */
  it('merges a loaded package MessageType into the root enum', async () => {
    const messages = parseConfigure(messagesJson as never)
    await loadDefinitions(messages, 'thp', getThpProtobufDefinitions as never)
    const root = messages.lookupEnum('MessageType')
    expect(root.values.ThpPairingRequest).toBe(1008)
    expect(root.values.ThpCodeEntryCpaceHostTag).toBe(1027)
    // Root values must survive the merge untouched.
    expect(root.values.GetFeatures).toBe(55)
  })
})
