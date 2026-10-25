/**
 * Persisted shared-wallet registry, keyed `cardano.multisig.{network}.{id}`.
 *
 * The network is in the key because the old registry keyed by script address
 * alone, so `list()` returned preprod and mainnet wallets together and every
 * entry point that asked "do I have a multisig wallet?" answered yes on the
 * wrong network. Callers now scope their reads.
 *
 * @module
 */

import {Address} from '@pnyx/cardano-core'
import type {Storage, StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import {createProfileStorage} from '../../profile/profile-storage'
import {type TemplateJson, templateFromJson, templateToJson} from './template'
import type {CoSignerRef, SharedWallet, SharedWalletRegistrationState} from './types'

const PREFIX = 'cardano.multisig.'
const scopeOf = (network: Address.Network): string => `${PREFIX}${network}.`
const keyOf = (network: Address.Network, id: string): string => `${scopeOf(network)}${id}`

type StoredWallet = {
  readonly id: string
  readonly name: string
  readonly coSigners: readonly CoSignerRef[]
  readonly paymentTemplate: TemplateJson
  readonly delegationTemplate: TemplateJson
  readonly network: Address.Network
  readonly accountIndex: number
  readonly selfGroupId?: string
  readonly createdAt: string
  readonly registration?: SharedWalletRegistrationState
}

export const serializeWallet = (w: SharedWallet): string =>
  JSON.stringify({
    ...w,
    paymentTemplate: templateToJson(w.paymentTemplate),
    delegationTemplate: templateToJson(w.delegationTemplate),
  } satisfies StoredWallet)

/**
 * Parse a stored wallet, returning `null` for anything that is not one.
 *
 * Shape is checked rather than trusted: a partially-written or hand-edited
 * record that revived into a wallet with an empty roster would compile to a
 * script anyone can spend.
 */
export const parseWallet = (raw: string): SharedWallet | null => {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const o = v as Partial<StoredWallet>
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.createdAt !== 'string') return null
    if (typeof o.accountIndex !== 'number' || typeof o.network !== 'number') return null
    if (!Array.isArray(o.coSigners) || o.coSigners.length === 0) return null
    for (const c of o.coSigners) {
      if (typeof c?.tag !== 'string' || typeof c?.name !== 'string' || typeof c?.accountXpubHex !== 'string') {
        return null
      }
    }
    // Validated, not revived: a half-written or hand-edited template used to be
    // trusted structurally, and a wrong one compiles to a wrong spending rule.
    const paymentTemplate = templateFromJson(o.paymentTemplate)
    const delegationTemplate = templateFromJson(o.delegationTemplate)
    if (paymentTemplate === null || delegationTemplate === null) return null
    return {
      id: o.id,
      name: o.name,
      coSigners: o.coSigners,
      paymentTemplate,
      delegationTemplate,
      network: o.network,
      accountIndex: o.accountIndex,
      ...(typeof o.selfGroupId === 'string' ? {selfGroupId: o.selfGroupId} : {}),
      createdAt: o.createdAt,
      ...(o.registration === undefined ? {} : {registration: o.registration}),
    }
  } catch (e: unknown) {
    // `null` removes the shared wallet from the list entirely.
    logger.warn('Shared wallet record could not be read; it will not be listed', {
      origin: 'multisig/storage',
      error: String(e),
    })
    return null
  }
}

export const saveSharedWallet = (storage: Storage, wallet: SharedWallet): Effect.Effect<void, StorageError> =>
  storage.set(keyOf(wallet.network, wallet.id), serializeWallet(wallet))

export const getSharedWallet = (
  storage: Storage,
  network: Address.Network,
  id: string,
): Effect.Effect<SharedWallet | null, StorageError> =>
  Effect.map(storage.get(keyOf(network, id)), (raw) => (raw === null ? null : parseWallet(raw)))

export const removeSharedWallet = (
  storage: Storage,
  network: Address.Network,
  id: string,
): Effect.Effect<void, StorageError> => storage.remove(keyOf(network, id))

/** Every shared wallet on one network, oldest first. */
export const listSharedWallets = (
  storage: Storage,
  network: Address.Network,
): Effect.Effect<readonly SharedWallet[], StorageError> =>
  Effect.gen(function* () {
    const scope = scopeOf(network)
    const keys = (yield* storage.keys()).filter((k) => k.startsWith(scope))
    const out: SharedWallet[] = []
    for (const key of keys) {
      const raw = yield* storage.get(key)
      const wallet = raw === null ? null : parseWallet(raw)
      if (wallet) out.push(wallet)
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  })

/**
 * Rename a shared wallet wherever it is held, and report whether one was found.
 *
 * Both networks are checked, because the record is network-keyed while the
 * wallet *group* is not: a shared wallet can be renamed from the wallet list
 * while the app sits on another network, and reading only the active one would
 * leave the registry holding the old name — which is the name the composition
 * screen shows, a re-share carries, and a publish writes on chain.
 */
export const renameSharedWallet = (storage: Storage, id: string, name: string): Effect.Effect<boolean, StorageError> =>
  Effect.gen(function* () {
    for (const network of [Address.Network.Mainnet, Address.Network.Testnet]) {
      const wallet = yield* getSharedWallet(storage, network, id)
      if (wallet === null) continue
      yield* saveSharedWallet(storage, {...wallet, name})
      return true
    }
    return false
  })

export type SharedWalletRegistry = {
  readonly save: (w: SharedWallet) => Effect.Effect<void, StorageError>
  readonly get: (network: Address.Network, id: string) => Effect.Effect<SharedWallet | null, StorageError>
  readonly remove: (network: Address.Network, id: string) => Effect.Effect<void, StorageError>
  readonly list: (network: Address.Network) => Effect.Effect<readonly SharedWallet[], StorageError>
  /** `false` when no shared wallet has that id — an ordinary wallet group, then. */
  readonly rename: (id: string, name: string) => Effect.Effect<boolean, StorageError>
}

export const platformSharedWalletRegistry = (): SharedWalletRegistry => {
  const storage = createProfileStorage()
  return {
    save: (w) => saveSharedWallet(storage, w),
    get: (network, id) => getSharedWallet(storage, network, id),
    remove: (network, id) => removeSharedWallet(storage, network, id),
    list: (network) => listSharedWallets(storage, network),
    rename: (id, name) => renameSharedWallet(storage, id, name),
  }
}

let walletSeq = 0
/** Stable local id for a new shared wallet. */
export const newSharedWalletId = (): string => {
  walletSeq += 1
  return `${Date.now().toString(36)}-${walletSeq.toString(36)}`
}
