/**
 * Trezor-specific types.
 *
 * @module
 */

import type {TrezorDeviceFeatures} from '../types'

/**
 * Trezor Connect manifest configuration.
 */
export type TrezorManifest = {
  /** Contact email */
  readonly email: string
  /** App URL */
  readonly appUrl: string
  /** App name */
  readonly appName?: string
}

/**
 * Trezor Connect initialization options.
 */
export type TrezorInitOptions = {
  /** Manifest configuration */
  readonly manifest: TrezorManifest
  /** Enable debug mode */
  readonly debug?: boolean
  /** Lazy load the library */
  readonly lazyLoad?: boolean
  /** Environment (web, node, react-native) */
  readonly env?: 'web' | 'node' | 'react-native'
  /** Config source URL */
  readonly configSrc?: string
  /** Iframe source URL */
  readonly iframeSrc?: string
  /** Popup source URL */
  readonly popupSrc?: string
  /** WebUSB source URL */
  readonly webusbSrc?: string
  /** Trusted host */
  readonly trustedHost?: boolean
  /** Pre-instantiated transport objects (for native USB/BLE on React Native) */
  readonly transports?: readonly unknown[]
  /** Auto-reconnect transport on disconnect */
  readonly transportReconnect?: boolean
}

/**
 * Trezor connection state.
 */
export type TrezorConnectionState = {
  /** Whether initialized */
  readonly initialized: boolean
  /** Whether connected */
  readonly connected: boolean
  /** Device features if connected */
  readonly features?: TrezorDeviceFeatures
  /** Device path/ID */
  readonly devicePath?: string
}

/**
 * Trezor device event types.
 */
export type TrezorDeviceEvent = {
  readonly type: 'device-connect' | 'device-disconnect' | 'device-changed'
  readonly payload: {
    readonly type: 'acquired' | 'unacquired' | 'unreadable'
    readonly id?: string
    readonly path?: string
    readonly label?: string
    readonly state?: string
    readonly features?: TrezorDeviceFeatures
  }
}

/**
 * Trezor UI event types — discriminated union with payloads for each UI request.
 *
 * These events are emitted by `@trezor/connect` core when the host must display
 * PIN, passphrase, or button-confirmation UIs (older models without touchscreens).
 */
export type TrezorUIEvent =
  | {readonly type: 'ui-request_pin'; readonly payload: {readonly device: unknown; readonly type?: string}}
  | {readonly type: 'ui-invalid_pin'; readonly payload: {readonly device: unknown}}
  | {readonly type: 'ui-request_passphrase'; readonly payload: {readonly device: unknown}}
  | {readonly type: 'ui-request_passphrase_on_device'; readonly payload: {readonly device: unknown}}
  | {readonly type: 'ui-request_button'; readonly payload: {readonly code: string; readonly device: unknown}}
  | {readonly type: 'ui-request_confirmation'; readonly payload: {readonly view: string; readonly device: unknown}}
  | {readonly type: 'ui-close_window'; readonly payload?: undefined}

/**
 * Trezor Cardano address parameters.
 */
export type TrezorCardanoAddressParams = {
  /** Address type */
  readonly addressType: TrezorCardanoAddressType
  /** Network ID */
  readonly networkId: number
  /** Protocol magic */
  readonly protocolMagic: number
  /** Spending key path as string */
  readonly spendingPath: string
  /** Staking key path as string */
  readonly stakingPath?: string
  /** Staking key hash */
  readonly stakingKeyHash?: string
  /** Staking script hash */
  readonly stakingScriptHash?: string
}

/**
 * Trezor Cardano address types.
 */
export type TrezorCardanoAddressType =
  | 0 // BASE
  | 1 // BASE_SCRIPT_KEY
  | 2 // BASE_KEY_SCRIPT
  | 3 // BASE_SCRIPT_SCRIPT
  | 4 // POINTER
  | 5 // POINTER_SCRIPT
  | 6 // ENTERPRISE
  | 7 // ENTERPRISE_SCRIPT
  | 8 // BYRON
  | 14 // REWARD
  | 15 // REWARD_SCRIPT

/**
 * Trezor Cardano get address request.
 */
export type TrezorCardanoGetAddressRequest = {
  /** Address parameters */
  readonly addressParameters: TrezorCardanoAddressParams
  /** Show on device display */
  readonly showOnTrezor?: boolean
  /** Derivation type */
  readonly derivationType?: number
}

/**
 * Trezor Cardano get address response.
 */
export type TrezorCardanoGetAddressResponse = {
  /** Address (bech32 or base58) */
  readonly address: string
  /** Protocol magic used */
  readonly protocolMagic: number
  /** Network ID used */
  readonly networkId: number
  /** Serialized path */
  readonly serializedPath?: string
  /** Serialized staking path */
  readonly serializedStakingPath?: string
}

/**
 * Trezor Cardano get public key request.
 */
export type TrezorCardanoGetPublicKeyRequest = {
  /** Derivation path as string */
  readonly path: string
  /** Show on device display */
  readonly showOnTrezor?: boolean
  /** Derivation type */
  readonly derivationType?: number
}

/**
 * Trezor Cardano get public key response.
 */
export type TrezorCardanoGetPublicKeyResponse = {
  /** Public key hex */
  readonly publicKey: string
  /** Node containing xpub */
  readonly node: {
    readonly public_key: string
    readonly chain_code: string
    readonly depth: number
    readonly child_num: number
    readonly fingerprint: number
  }
}

/**
 * Trezor Cardano transaction input.
 */
export type TrezorCardanoInput = {
  /** Previous transaction hash */
  readonly prev_hash: string
  /** Previous output index */
  readonly prev_index: number
  /** Path if owned */
  readonly path?: string
}

/**
 * Trezor Cardano transaction output.
 */
export type TrezorCardanoOutput = {
  /** Address (if external) */
  readonly address?: string
  /** Address parameters (if internal) */
  readonly addressParameters?: TrezorCardanoAddressParams
  /** Amount in lovelace */
  readonly amount: string
  /** Token bundle */
  readonly tokenBundle?: readonly TrezorCardanoAssetGroup[]
  /** Datum hash */
  readonly datumHash?: string
  /** Inline datum */
  readonly inlineDatum?: string
  /** Reference script */
  readonly referenceScript?: string
  /** Output format */
  readonly format?: number
}

/**
 * Trezor Cardano asset group.
 */
export type TrezorCardanoAssetGroup = {
  /** Policy ID */
  readonly policyId: string
  /** Tokens */
  readonly tokenAmounts: readonly TrezorCardanoToken[]
}

/**
 * Trezor Cardano token.
 */
export type TrezorCardanoToken = {
  /** Asset name hex */
  readonly assetNameBytes: string
  /** Amount (for output tokens) */
  readonly amount?: string
  /** Mint amount (for minting/burning — sint64, can be negative) */
  readonly mintAmount?: string
}

/**
 * Trezor Cardano certificate.
 * Matches Trezor Connect CardanoCertificate type.
 */
export type TrezorCardanoCertificate = {
  /** Certificate type */
  readonly type: TrezorCardanoCertificateType
  /** Stake key path */
  readonly path?: string
  /** Stake key hash */
  readonly keyHash?: string
  /** Script hash */
  readonly scriptHash?: string
  /** Pool ID */
  readonly pool?: string
  /** Deposit amount (Conway-era certs) */
  readonly deposit?: string
  /** DRep (for VOTE_DELEGATION) */
  readonly dRep?: TrezorCardanoDRep
}

/**
 * Trezor Cardano DRep params (for VOTE_DELEGATION certificates).
 * Matches Trezor Connect CardanoDRep type.
 */
export type TrezorCardanoDRep = {
  /** DRep type: 0=KEY_HASH, 1=SCRIPT_HASH, 2=ABSTAIN, 3=NO_CONFIDENCE */
  readonly type: TrezorCardanoDRepType
  /** Key hash (for KEY_HASH type) */
  readonly keyHash?: string
  /** Script hash (for SCRIPT_HASH type) */
  readonly scriptHash?: string
}

/**
 * Trezor Cardano DRep types.
 */
export type TrezorCardanoDRepType =
  | 0 // KEY_HASH
  | 1 // SCRIPT_HASH
  | 2 // ABSTAIN
  | 3 // NO_CONFIDENCE

/**
 * Trezor Cardano certificate types.
 * Matches CardanoCertificateType from @trezor/protobuf.
 */
export type TrezorCardanoCertificateType =
  | 0 // STAKE_REGISTRATION
  | 1 // STAKE_DEREGISTRATION
  | 2 // STAKE_DELEGATION
  | 3 // STAKE_POOL_REGISTRATION
  | 7 // STAKE_REGISTRATION_CONWAY
  | 8 // STAKE_DEREGISTRATION_CONWAY
  | 9 // VOTE_DELEGATION

/**
 * Trezor Cardano withdrawal.
 */
export type TrezorCardanoWithdrawal = {
  /** Stake key path */
  readonly path?: string
  /** Stake key hash */
  readonly keyHash?: string
  /** Script hash */
  readonly scriptHash?: string
  /** Amount in lovelace */
  readonly amount: string
}

/**
 * Trezor Cardano voter type.
 * Maps to the voter types used in Conway-era governance.
 */
export type TrezorCardanoVoterType =
  | 0 // COMMITTEE_KEY_HASH
  | 1 // COMMITTEE_SCRIPT_HASH
  | 2 // DREP_KEY_HASH
  | 3 // DREP_SCRIPT_HASH
  | 4 // STAKE_POOL_KEY_HASH

/**
 * Trezor Cardano voter.
 */
export type TrezorCardanoVoter = {
  /** Voter type */
  readonly type: TrezorCardanoVoterType
  /** Key hash (for key-based voters) */
  readonly keyHash?: string
  /** Script hash (for script-based voters) */
  readonly scriptHash?: string
}

/**
 * Trezor Cardano voting procedure.
 */
export type TrezorCardanoVotingProcedure = {
  /** Voter */
  readonly voter: TrezorCardanoVoter
  /** Governance action ID */
  readonly govActionId: {
    readonly txHash: string
    readonly index: number
  }
  /** Voting procedure */
  readonly votingProcedure: {
    readonly vote: number
    readonly anchor?: {
      readonly url: string
      readonly hash: string
    }
  }
}

/**
 * Trezor Cardano sign transaction request.
 */
export type TrezorCardanoSignTxRequest = {
  /** Signing mode */
  readonly signingMode: number
  /** Protocol magic */
  readonly protocolMagic: number
  /** Network ID */
  readonly networkId: number
  /** Inputs */
  readonly inputs: readonly TrezorCardanoInput[]
  /** Outputs */
  readonly outputs: readonly TrezorCardanoOutput[]
  /** Fee */
  readonly fee: string
  /** TTL */
  readonly ttl?: string
  /** Validity interval start */
  readonly validityIntervalStart?: string
  /** Certificates */
  readonly certificates?: readonly TrezorCardanoCertificate[]
  /** Withdrawals */
  readonly withdrawals?: readonly TrezorCardanoWithdrawal[]
  /** Auxiliary data hash */
  readonly auxiliaryDataHash?: string
  /** Mint */
  readonly mint?: readonly TrezorCardanoAssetGroup[]
  /** Script data hash */
  readonly scriptDataHash?: string
  /** Collateral inputs */
  readonly collateralInputs?: readonly TrezorCardanoInput[]
  /** Required signers */
  readonly requiredSigners?: readonly {
    readonly keyPath?: string
    readonly keyHash?: string
  }[]
  /** Network ID in body */
  readonly includeNetworkId?: boolean
  /** Collateral return */
  readonly collateralReturn?: TrezorCardanoOutput
  /** Total collateral */
  readonly totalCollateral?: string
  /** Reference inputs */
  readonly referenceInputs?: readonly TrezorCardanoInput[]
  /** Voting procedures (Conway governance) */
  readonly votingProcedures?: readonly TrezorCardanoVotingProcedure[]
  /** Additional witness paths */
  readonly additionalWitnessRequests?: readonly string[]
  /** Derivation type */
  readonly derivationType?: number
  /** Tag CBOR sets with tag 258 (Conway-era CIP-0057) */
  readonly tagCborSets?: boolean
  /** CIP-36 registration parameters */
  readonly auxiliaryData?: {
    readonly cip36RegistrationParameters?: {
      readonly votingPublicKey: string
      readonly stakingPath: string
      readonly nonce: string
      readonly format: number
      readonly paymentAddressParameters: TrezorCardanoAddressParams
      readonly delegations?: readonly {
        readonly votingPublicKey: string
        readonly weight: number
      }[]
    }
  }
}

/**
 * Trezor Cardano sign transaction response.
 */
export type TrezorCardanoSignTxResponse = {
  /** Transaction hash */
  readonly hash: string
  /** Witnesses */
  readonly witnesses: readonly {
    /** Witness type */
    readonly type: number
    /** Public key */
    readonly pubKey: string
    /** Signature */
    readonly signature: string
    /** Chain code */
    readonly chainCode?: string
  }[]
  /** Auxiliary data supplement */
  readonly auxiliaryDataSupplement?: {
    readonly type: number
    readonly auxiliaryDataHash: string
    readonly cip36VoteRegistrationSignature?: string
  }
}

/**
 * Trezor Cardano sign message request (CIP-8).
 */
export type TrezorCardanoSignMessageRequest = {
  /** Signing derivation path */
  readonly path: readonly number[]
  /** Message payload as hex string */
  readonly payload: string
  /** Prefer hex display on device */
  readonly preferHexDisplay?: boolean
  /** Derivation type */
  readonly derivationType?: number
  /** Protocol magic */
  readonly protocolMagic?: number
  /** Network ID */
  readonly networkId?: number
}

/**
 * Trezor Cardano sign message response.
 */
export type TrezorCardanoSignMessageResponse = {
  /** Signature hex */
  readonly signature: string
  /** Public key hex */
  readonly pubKey: string
  /** COSE Sign1 headers */
  readonly headers: {
    readonly protected: {
      /** Address field hex */
      readonly address: string
    }
  }
}

/**
 * Trezor Connect response wrapper.
 */
export type TrezorResponse<T> =
  | {
      readonly success: true
      readonly payload: T
    }
  | {
      readonly success: false
      readonly payload: {
        readonly error: string
        readonly code?: string
      }
    }
