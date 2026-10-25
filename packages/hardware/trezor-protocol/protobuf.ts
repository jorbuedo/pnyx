/**
 * Protobuf encode/decode wrapper around protobufjs/light.
 *
 * Replaces @trezor/protobuf's parseConfigure, encodeMessage, decodeMessage,
 * and loadDefinitions.
 *
 * Includes a CSP-safe fallback: when browser extension CSP blocks Function()
 * constructor (used by protobufjs codegen), reflection-based encode/decode
 * is installed automatically.
 *
 * Ported from trezor-suite/packages/protobuf/src/{encode,decode,utils,load-definitions,index}.ts
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'
import Long from 'long'
import * as protobuf from 'protobufjs/light'
import {bytesToHex, hexToBytes} from './bytes'

const logger = getLogger('hardware')

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)

// Configure Long.js for safe int64/uint64 handling.
// Must be done before any protobufjs operations.
protobuf.util.Long = Long
protobuf.configure()

type Type = protobuf.Type
const {Enum, Writer, Reader} = protobuf

/**
 * A `Type.decode` that also accepts the current nesting depth, so recursive
 * schemas (CardanoNativeScript, EthereumFieldType) can't exhaust the stack.
 * protobufjs's generated decoders track depth internally; ours cannot, because
 * each nested call re-enters through `Type.decode`.
 */
type ReflectionDecode = (reader: protobuf.Reader | Uint8Array, length?: number, depth?: number) => protobuf.Message

// ---------------------------------------------------------------------------
// CSP-safe fallback for protobufjs codegen
//
// protobufjs uses @protobufjs/codegen which calls Function() constructor
// to generate optimized encode/decode functions. Browser extension CSP
// blocks Function(), so we catch the error and install reflection-based
// implementations that use Writer/Reader directly.
// ---------------------------------------------------------------------------

/** Wire type for a protobuf field type name. */
const wireType = (type: string): number => {
  switch (type) {
    case 'fixed64':
    case 'sfixed64':
    case 'double':
      return 1 // 64-bit
    case 'string':
    case 'bytes':
      return 2 // length-delimited
    case 'fixed32':
    case 'sfixed32':
    case 'float':
      return 5 // 32-bit
    default:
      return 0 // varint
  }
}

/** Write a single scalar or message field to a Writer. */
function writeFieldValue(writer: protobuf.Writer, field: protobuf.Field, value: unknown): void {
  const id = field.id
  if (field.resolvedType) {
    if (field.resolvedType instanceof Enum) {
      writer.uint32((id << 3) | 0).int32(value as number)
    } else {
      // Nested message — fork, encode, ldelim
      field.resolvedType.encode(value as Record<string, unknown>, writer.uint32((id << 3) | 2).fork()).ldelim()
    }
    return
  }
  const wt = wireType(field.type)
  writer.uint32((id << 3) | wt)
  // biome-ignore lint/suspicious/noExplicitAny: Writer method dispatch
  ;(writer as any)[field.type](value)
}

/** Read a single field value from a Reader. */
function readFieldValue(reader: protobuf.Reader, field: protobuf.Field, depth: number): unknown {
  if (field.resolvedType) {
    if (field.resolvedType instanceof Enum) {
      return reader.int32()
    }
    // Nested message. The third argument is only honoured by our reflection
    // decoder; codegen decoders ignore it and apply their own depth counter.
    return (field.resolvedType.decode as ReflectionDecode)(reader, reader.uint32(), depth + 1)
  }
  // biome-ignore lint/suspicious/noExplicitAny: Reader method dispatch
  return (reader as any)[field.type]()
}

/** Create a reflection-based encoder for a message type. */
function reflectionEncoder(
  mtype: Type,
): (message: Record<string, unknown>, writer?: protobuf.Writer) => protobuf.Writer {
  return function encode(message: Record<string, unknown>, writer?: protobuf.Writer): protobuf.Writer {
    if (!writer) writer = Writer.create()
    for (const field of mtype.fieldsArray) {
      field.resolve()
      if (!hasOwn(message, field.name)) continue
      const value = (message as Record<string, unknown>)[field.name]
      if (value == null) continue
      if (field.repeated) {
        const arr = value as unknown[]
        for (let j = 0; j < arr.length; j++) {
          writeFieldValue(writer, field, arr[j])
        }
      } else {
        writeFieldValue(writer, field, value)
      }
    }
    return writer
  }
}

/** Create a reflection-based decoder for a message type. */
function reflectionDecoder(mtype: Type): ReflectionDecode {
  return function decode(input: protobuf.Reader | Uint8Array, length?: number, depth = 0): protobuf.Message {
    if (depth > Reader.recursionLimit) throw Error('maximum nesting depth exceeded')
    const reader = input instanceof Reader ? input : Reader.create(input)
    const end = length === undefined ? reader.len : reader.pos + length
    // biome-ignore lint/suspicious/noExplicitAny: dynamic message construction
    const message: any = new mtype.ctor()
    while (reader.pos < end) {
      const tag = reader.uint32()
      const fieldId = tag >>> 3
      const wt = tag & 7
      const field = mtype.fieldsById[fieldId]
      if (!field) {
        reader.skipType(wt, depth)
        continue
      }
      field.resolve()
      const value = readFieldValue(reader, field, depth)
      if (field.repeated) {
        if (!message[field.name] || message[field.name] === protobuf.util.emptyArray) {
          message[field.name] = []
        }
        message[field.name].push(value)
      } else {
        message[field.name] = value
      }
    }
    return message
  }
}

/** Create a reflection-based fromObject for a message type. */
function reflectionFromObject(mtype: Type): (object: Record<string, unknown>) => protobuf.Message {
  return function fromObject(object: Record<string, unknown>): protobuf.Message {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic message construction
    const message: any = new mtype.ctor()
    for (const field of mtype.fieldsArray) {
      const value = object[field.name]
      if (value == null) continue
      field.resolve()
      if (field.resolvedType instanceof Enum) {
        if (field.repeated) {
          message[field.name] = (value as unknown[]).map((v) =>
            typeof v === 'string' ? ((field.resolvedType as protobuf.Enum).values[v] ?? 0) : v,
          )
        } else {
          message[field.name] =
            typeof value === 'string' ? ((field.resolvedType as protobuf.Enum).values[value] ?? 0) : value
        }
      } else if (field.resolvedType) {
        if (field.repeated) {
          message[field.name] = (value as Record<string, unknown>[]).map((v) =>
            (field.resolvedType as Type).fromObject(v),
          )
        } else {
          message[field.name] = (field.resolvedType as Type).fromObject(value as Record<string, unknown>)
        }
      } else if (field.type === 'bytes') {
        message[field.name] =
          typeof value === 'string' ? protobuf.util.newBuffer(protobuf.util.base64.length(value)) : value
      } else {
        message[field.name] = value
      }
    }
    return message
  }
}

/** Create a reflection-based toObject for a message type. */
function reflectionToObject(mtype: Type): (message: protobuf.Message) => Record<string, unknown> {
  return function toObject(message: protobuf.Message): Record<string, unknown> {
    const object: Record<string, unknown> = {}
    for (const field of mtype.fieldsArray) {
      const value = (message as unknown as Record<string, unknown>)[field.name]
      if (value == null) {
        if (field.repeated) object[field.name] = []
        continue
      }
      field.resolve()
      if (field.resolvedType instanceof Enum) {
        if (field.repeated) {
          object[field.name] = (value as number[]).map((v) => (field.resolvedType as protobuf.Enum).valuesById[v] ?? v)
        } else {
          object[field.name] = (field.resolvedType as protobuf.Enum).valuesById[value as number] ?? value
        }
      } else if (field.resolvedType) {
        if (field.repeated) {
          object[field.name] = (value as protobuf.Message[]).map((v) => (field.resolvedType as Type).toObject(v))
        } else {
          object[field.name] = (field.resolvedType as Type).toObject(value as protobuf.Message)
        }
      } else {
        object[field.name] = value
      }
    }
    return object
  }
}

/** Reflection-based verify (always passes — our encode/decode handles validation). */
function reflectionVerify(_mtype: Type): (message: Record<string, unknown>) => string | null {
  return function verify(_message: Record<string, unknown>): string | null {
    return null
  }
}

/**
 * Install reflection-based methods on a Type when codegen is blocked by CSP.
 * Also ensures the constructor exists (codegen generates constructors too).
 */
function installReflectionMethods(mtype: Type): void {
  // Ensure constructor exists (Type.generateConstructor also uses codegen)
  // biome-ignore lint/suspicious/noExplicitAny: protobufjs internals
  if (!(mtype as any)._ctor) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic constructor
    const Ctor: any = function MessageCtor(this: Record<string, unknown>, properties?: Record<string, unknown>) {
      if (properties) {
        for (const key of Object.keys(properties)) {
          if (properties[key] != null) this[key] = properties[key]
        }
      }
    }
    Ctor.prototype = Object.create(protobuf.Message.prototype)
    Ctor.prototype.constructor = Ctor
    // Set default values on prototype
    for (const field of mtype.fieldsArray) {
      if (field.repeated) {
        Ctor.prototype[field.name] = protobuf.util.emptyArray
      } else if (field.bytes) {
        Ctor.prototype[field.name] = protobuf.util.emptyObject
      } else {
        Ctor.prototype[field.name] = field.defaultValue
      }
    }
    mtype.ctor = Ctor
    Ctor.$type = mtype
  }
  // Install reflection-based methods
  // biome-ignore lint/suspicious/noExplicitAny: protobufjs internals
  ;(mtype as any).encode = reflectionEncoder(mtype)
  // biome-ignore lint/suspicious/noExplicitAny: protobufjs internals
  ;(mtype as any).decode = reflectionDecoder(mtype)
  // biome-ignore lint/suspicious/noExplicitAny: protobufjs internals
  ;(mtype as any).verify = reflectionVerify(mtype)
  // biome-ignore lint/suspicious/noExplicitAny: protobufjs internals
  ;(mtype as any).fromObject = reflectionFromObject(mtype)
  // biome-ignore lint/suspicious/noExplicitAny: protobufjs internals
  ;(mtype as any).toObject = reflectionToObject(mtype)
}

// Monkey-patch Type.prototype.setup to catch CSP errors from codegen
const _originalSetup = protobuf.Type.prototype.setup
protobuf.Type.prototype.setup = function cspSafeSetup(this: Type): Type {
  try {
    return _originalSetup.call(this)
  } catch (e: unknown) {
    // CSP blocked Function() in codegen — install reflection-based methods. Expected on a
    // hardened runtime, which is why this is debug rather than a warning.
    logger.debug('protobuf codegen setup blocked; using reflection methods', {
      origin: 'trezor/protobuf',
      error: String(e),
    })
    installReflectionMethods(this)
    return this
  }
}

// --- Primitive type detection ---

const primitiveTypes = [
  'bool',
  'string',
  'bytes',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'double',
  'float',
]

const isPrimitiveField = (fieldType: string): boolean => primitiveTypes.includes(fieldType)

// --- Parse / configure ---

/**
 * Parse a protobuf JSON namespace into a Root.
 */
export const parseConfigure = (data: protobuf.INamespace | string): protobuf.Root => {
  if (typeof data === 'string') {
    return protobuf.Root.fromJSON(JSON.parse(data))
  }
  return protobuf.Root.fromJSON(data)
}

// --- Message lookups ---

/**
 * Resolve a message name to the wire type number the device reads.
 *
 * **The enum beside the message, not the one from the root.** protobufjs's `lookupEnum` walks *past* a
 * namespace's own `MessageType` when called on that namespace, so a dynamically loaded package
 * (`loadDefinitions('thp', …)`) never contributed its numbers even though they were merged in
 * correctly. Every THP message therefore resolved to nothing.
 *
 * That mattered because the miss used to fall through to `(messageTypeId ?? name) as number` — the
 * *name* in a `number`'s clothing. `encodeProtobufMessage` then hands it to `setUint16`, which coerces
 * a string to `NaN` and writes `0x0000`: message type 0, `Initialize`. A real T3W1 answered
 * `Failure_UnexpectedMessage` — "Message unrecognized in pairing context" — because it was being sent
 * an `Initialize` mid-pairing, and the payload was perfectly formed the whole time, which is what made
 * this survive several rounds of looking straight at it.
 *
 * So a miss now throws. There is no correct number to guess, and a wrong one is invisible on the wire.
 */
/**
 * Every `MessageType` enum in the tree — the root's, plus one per dynamically loaded package.
 *
 * `lookupEnum` cannot be used for this: protobufjs walks *past* a namespace's own `MessageType`, so
 * the root lookup silently misses everything `loadDefinitions` added. Collecting them explicitly is
 * what lets encode and decode share one rule instead of each having its own blind spot — they had the
 * same defect in opposite directions, and fixing only the encode side moved the failure one step
 * later rather than removing it.
 */
const messageTypeEnums = (messages: protobuf.Root): protobuf.Enum[] => {
  const found: protobuf.Enum[] = []
  const visit = (ns: protobuf.NamespaceBase) => {
    for (const child of ns.nestedArray) {
      if (child instanceof Enum) {
        if (child.name === 'MessageType') found.push(child)
      } else if (child instanceof protobuf.Namespace) {
        visit(child as protobuf.NamespaceBase)
      }
    }
  }
  visit(messages)
  return found
}

const createMessageFromName = (messages: protobuf.Root, name: string) => {
  const Message = messages.lookupType(name)

  // The message's own namespace first: for a root-level message this *is* the root enum, and for a
  // loaded package it is the package's, so one rule covers both.
  const parent = Message.parent as protobuf.Namespace | null
  const sibling = parent?.nested?.MessageType
  let messageTypeId: unknown = sibling instanceof Enum ? sibling.values[name] : undefined

  if (typeof messageTypeId !== 'number') {
    for (const candidate of messageTypeEnums(messages)) {
      const value = candidate.values[name]
      if (typeof value === 'number') {
        messageTypeId = value
        break
      }
    }
  }

  if (typeof messageTypeId !== 'number' && Message.options) {
    messageTypeId = Message.options['(wire_type)']
  }

  if (typeof messageTypeId !== 'number') {
    throw new Error(
      `No wire type for message "${name}": it is in no MessageType enum and carries no (wire_type) option. ` +
        'Add it to the enum of the namespace that defines it — sending a message with an unresolved ' +
        'type writes 0x0000 (Initialize) and the device rejects it as unexpected.',
    )
  }

  return {Message, messageType: messageTypeId}
}

const createMessageFromType = (messages: protobuf.Root, messageType: number | string) => {
  if (typeof messageType === 'string') {
    const Message = messages.lookupType(messageType)
    return {Message, messageName: messageType}
  }

  // Searched across every MessageType enum, not just the root's: a THP response (`1009`
  // ThpPairingRequestApproved, the reply to a confirmed pairing prompt) is only in the loaded
  // package's enum, and the root lookup returned `undefined` — which went straight into
  // `lookupType` and surfaced as "Cannot read property 'length' of undefined", naming nothing.
  let messageName: string | undefined
  for (const candidate of messageTypeEnums(messages)) {
    const name = candidate.valuesById[messageType]
    if (typeof name === 'string') {
      messageName = name
      break
    }
  }

  if (messageName === undefined) {
    throw new Error(
      `Unknown message type ${messageType}: in no MessageType enum. If it is a THP message, its ` +
        'definitions were not loaded before the response arrived.',
    )
  }

  const Message = messages.lookupType(messageName)

  return {Message, messageName}
}

// --- Encode ---

const transformEncode = (fieldType: string, value: unknown): unknown => {
  if (fieldType === 'bytes') {
    // Edge case: empty string bytes fields (e.g., MultisigRedeemScriptType signatures)
    // must be preserved as-is, not converted to empty buffer.
    if (typeof value === 'string' && !value) return value
    return hexToBytes(value as string)
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError('field value is not within safe integer range')
  }
  // Normalize typographic quotes
  if (fieldType === 'string' && typeof value === 'string') {
    return (value as string).replace(/[\u2018\u2019]/g, "'")
  }
  return value
}

function patch(Message: Type, payload: Record<string, unknown>): Record<string, unknown> {
  const patched: Record<string, unknown> = {}

  if (!Message.fields) return patched

  for (const key of Object.keys(Message.fields)) {
    const field = Message.fields[key]
    if (!field) continue
    const value = payload[key]

    if (typeof value === 'undefined') continue

    // Primitive type
    if (isPrimitiveField(field.type)) {
      if (field.repeated) {
        patched[key] = (value as unknown[]).map((v) => transformEncode(field.type, v))
      } else {
        patched[key] = transformEncode(field.type, value)
      }
      continue
    }

    // Repeated non-primitive
    if (field.repeated) {
      const fieldType = Message.lookupTypeOrEnum(field.type)
      if (fieldType instanceof Enum) {
        // Enum arrays don't require patching — both string keys and numeric values are accepted
        patched[key] = value
      } else {
        patched[key] = (value as Record<string, unknown>[]).map((v) => patch(fieldType as Type, v))
      }
    }
    // Nested message type
    else if (typeof value === 'object' && value !== null) {
      const RefMessage = Message.lookupType(field.type)
      patched[key] = patch(RefMessage, value as Record<string, unknown>)
    }
    // Enum by numeric value
    else if (typeof value === 'number') {
      const RefEnum = Message.lookupEnum(field.type)
      patched[key] = RefEnum.values[value]
    } else {
      patched[key] = value
    }
  }

  return patched
}

const encode = (Message: Type, data: Record<string, unknown>): Uint8Array => {
  const payload = patch(Message, data)
  const message = Message.fromObject(payload)
  return Message.encode(message).finish()
}

/**
 * Encode a named message to binary protobuf.
 *
 * @returns The numeric messageType and the encoded binary message.
 */
export const encodeMessage = (
  messages: protobuf.Root,
  messageName: string,
  data: Record<string, unknown>,
): {messageType: number; message: Uint8Array} => {
  const {Message, messageType} = createMessageFromName(messages, messageName)
  const message = encode(Message, data)
  return {messageType, message}
}

// --- Decode ---

type Field = protobuf.Field

const transformDecode = (field: Field, value: unknown): unknown => {
  if (isPrimitiveField(field.type)) {
    // Optional undefined → null for compatibility
    if (typeof value === 'undefined' || value === null) return null

    if (field.type === 'bytes') {
      return bytesToHex(value as Uint8Array)
    }

    // Long type handling
    if (field.long) {
      const longVal = value as {toNumber: () => number; toString: () => string}
      if (Number.isSafeInteger(longVal.toNumber())) {
        return longVal.toNumber()
      }
      return longVal.toString()
    }

    return value
  }

  // Enum type
  if (field.resolvedType && 'valuesById' in field.resolvedType) {
    return (field.resolvedType as protobuf.Enum).valuesById[value as number]
  }

  // Nested message type
  if (field.resolvedType?.fields) {
    return messageToJSON(value as protobuf.Message<Record<string, unknown>>, field.resolvedType.fields)
  }

  throw new Error(`transport: decode: case not handled: ${field}`)
}

function messageToJSON(
  MessageParam: protobuf.Message<Record<string, unknown>>,
  fields: Type['fields'],
): Record<string, unknown> {
  if (!MessageParam) return {}

  // Get rid of Message.prototype references
  const message = {...MessageParam} as Record<string, unknown>
  const res: Record<string, unknown> = {}

  for (const key of Object.keys(fields)) {
    const field = fields[key]
    if (!field) continue
    const value = message[key]

    if (field.repeated) {
      res[key] = (value as unknown[]).map((v) => transformDecode(field, v))
    } else {
      res[key] = transformDecode(field, value)
    }
  }

  return res
}

const decode = (Message: Type, data: Uint8Array): Record<string, unknown> => {
  const decoded = Message.decode(new Uint8Array(data))
  return messageToJSON(decoded, decoded.$type.fields)
}

/**
 * Decoded message response.
 */
export type MessageResponse = {
  type: string
  message: Record<string, unknown>
}

/**
 * Decode a binary protobuf message by its numeric type ID or string name.
 */
export const decodeMessage = (
  messages: protobuf.Root,
  messageType: number | string,
  data: Uint8Array,
): MessageResponse => {
  const {Message, messageName} = createMessageFromType(messages, messageType)
  const message = decode(Message, data)
  return {type: messageName, message}
}

/**
 * Dynamically load additional protobuf definitions into an existing Root,
 * merging MessageType enums.
 */
export const loadDefinitions = async (
  messages: protobuf.Root,
  packageName: string,
  packageLoader: () => protobuf.INamespace | Promise<protobuf.INamespace>,
): Promise<void> => {
  // Check if package already exists
  try {
    const pkg = messages.lookup(packageName)
    if (pkg) return
  } catch (e: unknown) {
    // protobufjs throws rather than returning undefined for an absent package, so this is the
    // ordinary "not loaded yet" path.
    logger.debug('protobuf package not found; loading it', {
      origin: 'trezor/protobuf',
      packageName,
      error: String(e),
    })
  }

  // Get current MessageType enum
  let enumType: protobuf.Enum | undefined
  try {
    enumType = messages.lookupEnum('MessageType')
  } catch (e: unknown) {
    logger.debug('protobuf MessageType enum not present yet', {origin: 'trezor/protobuf', error: String(e)})
  }

  // Load definitions into a scoped namespace.
  // define(name) creates the namespace, addJSON(nested) populates it —
  // passing the full INamespace to define() as a second arg doesn't work
  // because protobufjs treats the {nested: ...} wrapper as a literal child.
  const packageMessages = await packageLoader()
  const pkg = messages.define(packageName)
  const nested = (packageMessages as protobuf.INamespace).nested
  if (nested) {
    pkg.addJSON(nested as {[k: string]: protobuf.AnyNestedObject})
  }

  // Merge the package's MessageType values into the root MessageType.
  //
  // Read straight off `pkg.nested`, never via `pkg.lookupEnum('MessageType')`. That is what this used
  // to do, guarded by `found.parent === pkg` to skip the root's enum — correct under protobufjs 7.4.0,
  // where a relative lookup found the local definition first. 7.6.5 added a root-level
  // `_fullyQualifiedObjects` cache and an early bailout that resolves the bare name `MessageType`
  // against `".MessageType"`, so `found` became the *root* enum every time, the guard never passed,
  // and this merge silently stopped running. Every THP message then had no wire number
  // (see `createMessageFromName`), went out as `0x0000` = `Initialize`, and the device rejected
  // pairing as an unexpected message. Nothing in this repo changed; a security bump did it.
  const ownEnum = pkg.nested?.MessageType
  const packageEnumType = ownEnum instanceof Enum ? ownEnum : undefined

  if (enumType && packageEnumType) {
    try {
      for (const key of Object.keys(packageEnumType.values)) {
        const val = packageEnumType.values[key]
        if (val !== undefined) enumType.add(key, val)
      }
      pkg.remove(packageEnumType)
    } catch (e) {
      messages.remove(pkg)
      throw e
    }
  }
}
