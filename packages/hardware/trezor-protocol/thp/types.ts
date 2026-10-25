/**
 * THP protocol types.
 *
 * Replaces @trezor/protocol ThpState class types and THP message types.
 *
 * @module
 */

// --- Pairing method enum ---

export enum ThpPairingMethod {
  SkipPairing = 1,
  CodeEntry = 2,
  QrCode = 3,
  NFC = 4,
}

// --- Device properties ---

export type ThpDeviceProperties = {
  internal_model: string
  model_variant: number
  protocol_version_major: number
  protocol_version_minor: number
  pairing_methods: (keyof typeof ThpPairingMethod)[]
}

// --- Handshake credentials ---

export type ThpHandshakeCredentials = {
  pairingMethods: ThpPairingMethod[]
  handshakeHash: Uint8Array
  handshakeCommitment: Uint8Array
  codeEntryChallenge: Uint8Array
  trezorEncryptedStaticPubkey: Uint8Array
  hostEncryptedStaticPubkey: Uint8Array
  staticKey: Uint8Array
  hostStaticPublicKey: Uint8Array
  hostKey: Uint8Array
  trezorKey: Uint8Array
  trezorCpacePublicKey: Uint8Array
}

// --- Pairing credentials (persisted) ---

export type ThpCredentialResponse = {
  trezor_static_public_key: string
  credential: string
}

export type ThpCredentials = ThpCredentialResponse & {
  host_static_key: string
  autoconnect?: boolean
}

// --- Sync bit ---

export type ThpMessageSyncBit = 0 | 1

// --- THP channel state (serializable for persistence) ---

export type ThpChannelState = {
  channel: string // 2 bytes as hex
  sendBit: ThpMessageSyncBit
  recvBit: ThpMessageSyncBit
  sendAckBit: ThpMessageSyncBit
  recvAckBit: ThpMessageSyncBit
  sendNonce: number
  recvNonce: number
  expectedResponses: number[]
  recentMessage: string
}

export type ThpStateSerialized = {
  properties?: ThpDeviceProperties | undefined
  credentials: ThpCredentials[]
} & ThpChannelState

export type ThpPhase = 'handshake' | 'pairing' | 'paired'

// --- THP-layer message types (not in firmware .proto files) ---

export type ThpError = {
  code: 'ThpTransportBusy' | 'ThpUnallocatedChannel' | 'ThpDecryptionFailed' | 'ThpDeviceLocked' | 'ThpUnknownError'
  message: string
}

export type ThpCreateChannelRequest = {
  nonce: Uint8Array
}

export type ThpCreateChannelResponse = {
  nonce: Uint8Array
  channel: Uint8Array
  properties: ThpDeviceProperties
  handshakeHash: Uint8Array
}

export type ThpHandshakeInitRequest = {
  key: Uint8Array
  tryToUnlock: 0 | 1
}

export type ThpHandshakeInitResponse = {
  trezorEphemeralPubkey: Uint8Array
  trezorEncryptedStaticPubkey: Uint8Array
  tag: Uint8Array
}

export type ThpHandshakeCompletionRequest = {
  hostPubkey: Uint8Array
  encryptedPayload: Uint8Array
}

// 0 - not paired
// 1 - paired but will require connection confirmation
// 2 - paired with autoconnect
export type ThpHandshakeCompletionResponse = {
  state: 0 | 1 | 2
}

// --- THP protobuf message types ---

export type ThpHandshakeCompletionReqNoisePayload = {
  host_pairing_credential?: string
}

export type ThpCreateNewSession = {derive_cardano?: boolean} & (
  | {passphrase: string; on_device?: undefined}
  | {passphrase?: undefined; on_device: boolean}
)

export type ThpPairingRequest = {
  host_name: string
  app_name: string
}

export type ThpSelectMethod = {
  selected_pairing_method: ThpPairingMethod
}

export type ThpCodeEntryCommitment = {
  commitment: string
}

export type ThpCodeEntryChallenge = {
  challenge: string
}

export type ThpCodeEntryCpaceTrezor = {
  cpace_trezor_public_key: string
}

export type ThpCodeEntryCpaceHostTag = {
  cpace_host_public_key: string
  tag: string
}

export type ThpCodeEntrySecret = {
  secret: string
}

export type ThpQrCodeTag = {
  tag: string
}

export type ThpQrCodeSecret = {
  secret: string
}

export type ThpNfcTagHost = {
  tag: string
}

export type ThpNfcTagTrezor = {
  tag: string
}

export type ThpCredentialRequest = {
  host_static_public_key: string
  autoconnect: boolean
  credential?: string
}

export type ThpEndRequest = Record<string, never>
export type ThpEndResponse = Record<string, never>
export type ThpPairingRequestApproved = Record<string, never>
export type ThpPairingPreparationsFinished = Record<string, never>

// --- Message response ---

export type ThpMessageResponse<T extends string = string> = {
  type: T
  message: Record<string, unknown>
}

// --- Decoded protocol message ---

export type DecodedThpMessage = {
  header: Uint8Array
  chunkHeader: Uint8Array
  length: number
  messageType: number
  payload: Uint8Array
}
