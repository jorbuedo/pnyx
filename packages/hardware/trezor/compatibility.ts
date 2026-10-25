import type {TrezorDeviceFeatures, TrezorInternalModel, TrezorModel, TrezorRawCapability} from '../types'

const DEFAULT_CAPABILITIES_T1 = [
  'Capability_Bitcoin',
  'Capability_Bitcoin_like',
  'Capability_Crypto',
  'Capability_Ethereum',
  'Capability_NEM',
  'Capability_Stellar',
  'Capability_U2F',
] as const satisfies readonly TrezorRawCapability[]

const DEFAULT_CAPABILITIES_TT = [
  'Capability_Bitcoin',
  'Capability_Bitcoin_like',
  'Capability_Binance',
  'Capability_Cardano',
  'Capability_Crypto',
  'Capability_EOS',
  'Capability_Ethereum',
  'Capability_Monero',
  'Capability_NEM',
  'Capability_Ripple',
  'Capability_Stellar',
  'Capability_Tezos',
  'Capability_U2F',
] as const satisfies readonly TrezorRawCapability[]

const createTrezorConnectCapabilityMinFirmware = <TCapability extends string>(
  capabilityMinFirmware: Readonly<Record<TCapability, Partial<Record<TrezorInternalModel, string>>>>,
): Readonly<Record<TCapability, Partial<Record<TrezorInternalModel, string>>>> => capabilityMinFirmware

const createTrezorConnectMethodMinFirmware = <TMethod extends string>(
  methodMinFirmware: Readonly<Record<TMethod, Partial<Record<TrezorInternalModel, string>>>>,
): Readonly<Record<TMethod, Partial<Record<TrezorInternalModel, string>>>> => methodMinFirmware

const TREZOR_CONNECT_CAPABILITY_MIN_FIRMWARE = createTrezorConnectCapabilityMinFirmware({
  replaceTransaction: {
    T1B1: '1.9.4',
    T2T1: '2.3.5',
  },
  amountUnit: {
    T1B1: '1.9.4',
    T2T1: '2.3.5',
  },
  decreaseOutput: {
    T1B1: '1.10.0',
    T2T1: '2.4.0',
  },
  eip1559: {
    T1B1: '1.10.4',
    T2T1: '2.4.2',
  },
  taproot: {
    T1B1: '1.10.4',
    T2T1: '2.4.3',
  },
  signMessageNoScriptType: {
    T1B1: '1.10.4',
    T2T1: '2.4.3',
  },
  'eip712-domain-only': {
    T1B1: '1.10.6',
    T2T1: '2.4.4',
  },
  coinjoin: {
    T1B1: '1.12.1',
    T2T1: '2.5.3',
  },
  chunkify: {
    T1B1: '0',
    T2T1: '2.6.3',
    T2B1: '2.6.3',
    T3B1: '2.8.1',
    T3T1: '2.7.2',
  },
} as const)

const TREZOR_CONNECT_METHOD_MIN_FIRMWARE = createTrezorConnectMethodMinFirmware({
  cardanoGetAddress: {
    T1B1: '0',
    T2T1: '2.4.3',
  },
  cardanoGetPublicKey: {
    T1B1: '0',
    T2T1: '2.4.3',
  },
  cardanoSignTransaction: {
    T1B1: '0',
    T2T1: '2.6.0',
  },
  cardanoSignMessage: {
    T1B1: '0',
    T2T1: '2.9.1',
    T2B1: '2.9.1',
    T3B1: '2.9.1',
    T3T1: '2.9.1',
    T3W1: '2.9.1',
  },
  ethereumSignTypedData: {
    T1B1: '1.10.5',
    T2T1: '2.4.3',
  },
  showDeviceTutorial: {
    T1B1: '0',
    T2T1: '0',
    T2B1: '2.6.1',
    T3B1: '2.8.1',
    T3T1: '2.8.0',
  },
  authenticateDevice: {
    T1B1: '0',
    T2T1: '0',
    T2B1: '2.6.1',
    T3B1: '2.8.1',
    T3T1: '2.8.0',
  },
  rebootToBootloader: {
    T1B1: '1.10.0',
    T2T1: '2.6.0',
  },
  getFirmwareHash: {
    T1B1: '1.11.1',
    T2T1: '2.5.1',
  },
  solanaGetPublicKey: {
    T1B1: '0',
    T2T1: '2.6.4',
    T2B1: '2.6.4',
    T3B1: '2.8.1',
    T3T1: '2.7.2',
  },
  solanaGetAddress: {
    T1B1: '0',
    T2T1: '2.6.4',
    T2B1: '2.6.4',
    T3B1: '2.8.1',
    T3T1: '2.7.2',
  },
  solanaSignTransaction: {
    T1B1: '0',
    T2T1: '2.6.4',
    T2B1: '2.6.4',
    T3B1: '2.8.1',
    T3T1: '2.7.2',
  },
  changeLanguage: {
    T1B1: '0',
    T2T1: '2.7.0',
    T2B1: '2.7.0',
    T3B1: '2.8.1',
    T3T1: '2.7.2',
  },
} as const)

const TREZOR_INTERNAL_MODELS = new Set<TrezorInternalModel>(['T1B1', 'T2T1', 'T2B1', 'T3B1', 'T3T1', 'T3W1'])

const MODEL_TO_INTERNAL_MODEL: Record<TrezorModel, TrezorInternalModel> = {
  one: 'T1B1',
  T: 'T2T1',
  safe3: 'T3B1',
  safe5: 'T3T1',
  safe7: 'T3W1',
}

export type TrezorConnectDerivedCapability = keyof typeof TREZOR_CONNECT_CAPABILITY_MIN_FIRMWARE
export type TrezorConnectMethod = keyof typeof TREZOR_CONNECT_METHOD_MIN_FIRMWARE
export type TrezorConnectCapabilityUnavailableReason = 'update-required' | 'no-support' | 'trezor-connect-outdated'
export type TrezorConnectUnavailableInfo<TKey extends string> = {
  readonly kind: 'capability' | 'method'
  readonly key: TKey
  readonly reason: TrezorConnectCapabilityUnavailableReason
  readonly currentVersion: string
  readonly requiredVersion?: string
}

export const compareTrezorFirmwareVersions = (a: string, b: string): number => {
  const parse = (version: string): [number, number, number] => {
    const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  }

  const av = parse(a)
  const bv = parse(b)
  for (let i = 0; i < av.length; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

export const normalizeTrezorInternalModel = (
  internalModel: string | undefined,
  fallbackModel?: TrezorModel,
): TrezorInternalModel | undefined => {
  if (internalModel && TREZOR_INTERNAL_MODELS.has(internalModel as TrezorInternalModel)) {
    return internalModel as TrezorInternalModel
  }

  return fallbackModel ? MODEL_TO_INTERNAL_MODEL[fallbackModel] : undefined
}

export const getTrezorRawCapabilities = (
  capabilities: readonly TrezorRawCapability[] | undefined,
): readonly TrezorRawCapability[] => capabilities ?? []

export const parseTrezorCapabilities = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'rawCapabilities'> | undefined,
): readonly TrezorRawCapability[] => {
  if (!features) return []
  if (features.rawCapabilities.length > 0) return features.rawCapabilities
  return features.model === 'one' ? DEFAULT_CAPABILITIES_T1 : DEFAULT_CAPABILITIES_TT
}

export const getTrezorConnectUnavailableCapabilities = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'internalModel' | 'firmwareVersion'> | undefined,
): Partial<Record<TrezorConnectDerivedCapability, TrezorConnectCapabilityUnavailableReason>> => {
  if (!features) {
    return Object.fromEntries(
      Object.keys(TREZOR_CONNECT_CAPABILITY_MIN_FIRMWARE).map((capability) => [capability, 'update-required']),
    ) as Partial<Record<TrezorConnectDerivedCapability, TrezorConnectCapabilityUnavailableReason>>
  }

  const internalModel = normalizeTrezorInternalModel(features.internalModel, features.model)
  if (!internalModel) {
    return Object.fromEntries(
      Object.keys(TREZOR_CONNECT_CAPABILITY_MIN_FIRMWARE).map((capability) => [capability, 'update-required']),
    ) as Partial<Record<TrezorConnectDerivedCapability, TrezorConnectCapabilityUnavailableReason>>
  }

  const unavailable: Partial<Record<TrezorConnectDerivedCapability, TrezorConnectCapabilityUnavailableReason>> = {}

  for (const capability of Object.keys(TREZOR_CONNECT_CAPABILITY_MIN_FIRMWARE) as TrezorConnectDerivedCapability[]) {
    const minVersion = TREZOR_CONNECT_CAPABILITY_MIN_FIRMWARE[capability][internalModel]
    if (!minVersion) continue
    if (minVersion === '0' || compareTrezorFirmwareVersions(features.firmwareVersion, minVersion) < 0) {
      unavailable[capability] = minVersion === '0' ? 'no-support' : 'update-required'
    }
  }

  return unavailable
}

export const getTrezorConnectUnavailableCapabilityInfo = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'internalModel' | 'firmwareVersion'> | undefined,
  capability: TrezorConnectDerivedCapability,
): TrezorConnectUnavailableInfo<TrezorConnectDerivedCapability> | undefined => {
  if (!features) {
    return {
      kind: 'capability',
      key: capability,
      reason: 'update-required',
      currentVersion: 'unknown',
    }
  }

  const internalModel = normalizeTrezorInternalModel(features.internalModel, features.model)
  if (!internalModel) {
    return {
      kind: 'capability',
      key: capability,
      reason: 'update-required',
      currentVersion: features.firmwareVersion,
    }
  }

  const minVersion = TREZOR_CONNECT_CAPABILITY_MIN_FIRMWARE[capability][internalModel]
  if (!minVersion) return undefined
  if (minVersion === '0') {
    return {
      kind: 'capability',
      key: capability,
      reason: 'no-support',
      currentVersion: features.firmwareVersion,
    }
  }
  if (compareTrezorFirmwareVersions(features.firmwareVersion, minVersion) < 0) {
    return {
      kind: 'capability',
      key: capability,
      reason: 'update-required',
      currentVersion: features.firmwareVersion,
      requiredVersion: minVersion,
    }
  }
  return undefined
}

export const getTrezorConnectUnavailableMethods = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'internalModel' | 'firmwareVersion'> | undefined,
): Partial<Record<TrezorConnectMethod, TrezorConnectCapabilityUnavailableReason>> => {
  if (!features) {
    return Object.fromEntries(
      Object.keys(TREZOR_CONNECT_METHOD_MIN_FIRMWARE).map((method) => [method, 'update-required']),
    ) as Partial<Record<TrezorConnectMethod, TrezorConnectCapabilityUnavailableReason>>
  }

  const internalModel = normalizeTrezorInternalModel(features.internalModel, features.model)
  if (!internalModel) {
    return Object.fromEntries(
      Object.keys(TREZOR_CONNECT_METHOD_MIN_FIRMWARE).map((method) => [method, 'update-required']),
    ) as Partial<Record<TrezorConnectMethod, TrezorConnectCapabilityUnavailableReason>>
  }

  const unavailable: Partial<Record<TrezorConnectMethod, TrezorConnectCapabilityUnavailableReason>> = {}

  for (const method of Object.keys(TREZOR_CONNECT_METHOD_MIN_FIRMWARE) as TrezorConnectMethod[]) {
    const minVersion = TREZOR_CONNECT_METHOD_MIN_FIRMWARE[method][internalModel]
    if (!minVersion) continue
    if (minVersion === '0' || compareTrezorFirmwareVersions(features.firmwareVersion, minVersion) < 0) {
      unavailable[method] = minVersion === '0' ? 'no-support' : 'update-required'
    }
  }

  return unavailable
}

export const getTrezorConnectUnavailableMethodInfo = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'internalModel' | 'firmwareVersion'> | undefined,
  method: TrezorConnectMethod,
): TrezorConnectUnavailableInfo<TrezorConnectMethod> | undefined => {
  if (!features) {
    return {
      kind: 'method',
      key: method,
      reason: 'update-required',
      currentVersion: 'unknown',
    }
  }

  const internalModel = normalizeTrezorInternalModel(features.internalModel, features.model)
  if (!internalModel) {
    return {
      kind: 'method',
      key: method,
      reason: 'update-required',
      currentVersion: features.firmwareVersion,
    }
  }

  const minVersion = TREZOR_CONNECT_METHOD_MIN_FIRMWARE[method][internalModel]
  if (!minVersion) return undefined
  if (minVersion === '0') {
    return {
      kind: 'method',
      key: method,
      reason: 'no-support',
      currentVersion: features.firmwareVersion,
    }
  }
  if (compareTrezorFirmwareVersions(features.firmwareVersion, minVersion) < 0) {
    return {
      kind: 'method',
      key: method,
      reason: 'update-required',
      currentVersion: features.firmwareVersion,
      requiredVersion: minVersion,
    }
  }
  return undefined
}

export const formatTrezorConnectUnavailableInfo = (
  info: TrezorConnectUnavailableInfo<string>,
  description: string,
): string => {
  if (info.reason === 'update-required' && info.requiredVersion) {
    return `${description} requires Trezor firmware ${info.requiredVersion}+ (current: ${info.currentVersion}).`
  }
  if (info.reason === 'trezor-connect-outdated') {
    return `${description} requires a newer Trezor compatibility layer.`
  }
  return `${description} is not supported on this Trezor model/firmware.`
}

export const isTrezorConnectCapabilityUnavailable = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'internalModel' | 'firmwareVersion'> | undefined,
  capability: TrezorConnectDerivedCapability,
): boolean => getTrezorConnectUnavailableCapabilities(features)[capability] !== undefined

export const isTrezorConnectMethodUnavailable = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'internalModel' | 'firmwareVersion'> | undefined,
  method: TrezorConnectMethod,
): boolean => getTrezorConnectUnavailableMethods(features)[method] !== undefined

export const shouldUseLegacyBitcoinSignProcess = (
  features: Pick<TrezorDeviceFeatures, 'model' | 'internalModel' | 'firmwareVersion'> | undefined,
): boolean => isTrezorConnectCapabilityUnavailable(features, 'replaceTransaction')
