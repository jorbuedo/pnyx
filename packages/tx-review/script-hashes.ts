/**
 * Every script hash a reviewed Cardano transaction touches, with WHERE it came
 * from — the input a CIP-171 verification lookup needs.
 *
 * Pure and chain-shaped: it reads the review IR and nothing else, so it can be
 * tested without a network, a wallet or a renderer.
 *
 * A minting policy id IS a script hash (the policy is the script), which is why
 * `minting` operations are collected alongside script payment credentials. A
 * `scriptDataHashHex` is NOT: it is a hash over the redeemers, datums and cost
 * models, and looking it up would ask the registry about a value no script has.
 */
import type {ReviewedCredential, ReviewedIO, ReviewedTransaction} from './types.js'

/** Where in the transaction a script hash was found. Ordered by how directly the
 *  user is exposed to it: spending from one runs it, sending to one locks funds
 *  under it, minting under one runs it, and a certificate/withdrawal authorises
 *  through it. */
export type ScriptHashSite = 'input' | 'output' | 'mint' | 'certificate' | 'withdrawal' | 'reference-script'

export type TouchedScript = {
  /** 28-byte blake2b-224 script hash, lowercase hex. */
  readonly hashHex: string
  /** Every site this hash appeared at, in first-seen order. */
  readonly sites: readonly ScriptHashSite[]
}

const scriptCredOf = (io: ReviewedIO): string | undefined => {
  const payment: ReviewedCredential | undefined = io.credentials?.payment
  return payment !== undefined && payment.type === 'script' ? payment.hashHex.toLowerCase() : undefined
}

const isHash28 = (hex: string): boolean => /^[0-9a-f]{56}$/.test(hex)

/**
 * The script hash of a reward account, or `undefined` when its credential is a
 * key. A reward address is one header byte + a 28-byte hash, and the header's
 * high nibble says which: `0b1110` = key, `0b1111` = script.
 */
const scriptRewardAccount = (addressHex: string): string | undefined => {
  const hex = addressHex.toLowerCase()
  if (hex.length !== 58) return undefined
  const header = Number.parseInt(hex.slice(0, 2), 16)
  if (Number.isNaN(header) || header >> 4 !== 0b1111) return undefined
  return hex.slice(2)
}

/**
 * Collect the transaction's script hashes, de-duplicated, in first-seen order.
 *
 * Malformed hashes are dropped rather than passed on: a lookup key that is not a
 * 28-byte hash can only ever miss, and a miss renders as "not verified", which
 * would report a decoding problem as a fact about the contract.
 */
export const touchedScripts = (reviewed: ReviewedTransaction): readonly TouchedScript[] => {
  const order: string[] = []
  const sites = new Map<string, ScriptHashSite[]>()
  const add = (hashHex: string | undefined, site: ScriptHashSite): void => {
    if (hashHex === undefined) return
    const hex = hashHex.toLowerCase()
    if (!isHash28(hex)) return
    const existing = sites.get(hex)
    if (existing === undefined) {
      order.push(hex)
      sites.set(hex, [site])
      return
    }
    if (!existing.includes(site)) existing.push(site)
  }

  for (const io of reviewed.inputs) add(scriptCredOf(io), 'input')
  for (const io of reviewed.outputs) add(scriptCredOf(io), 'output')
  for (const op of reviewed.operations) {
    switch (op.kind) {
      case 'minting':
        add(op.policyIdHex, 'mint')
        break
      case 'stake-registration':
      case 'stake-deregistration':
      case 'stake-delegation':
      case 'vote-delegation':
      case 'stake-vote-delegation':
      case 'stake-reg-delegation':
      case 'vote-reg-delegation':
      case 'stake-vote-reg-delegation':
      case 'drep-registration':
      case 'drep-deregistration':
      case 'drep-update':
        if (op.credential.type === 'script') add(op.credential.hashHex, 'certificate')
        break
      case 'committee-hot-auth':
        if (op.cold.type === 'script') add(op.cold.hashHex, 'certificate')
        if (op.hot.type === 'script') add(op.hot.hashHex, 'certificate')
        break
      case 'committee-cold-resign':
        if (op.cold.type === 'script') add(op.cold.hashHex, 'certificate')
        break
      case 'reward-withdrawal':
        add(scriptRewardAccount(op.rewardAddress.hex), 'withdrawal')
        break
      default:
        break
    }
  }
  return order.map((hashHex) => ({hashHex, sites: sites.get(hashHex) ?? []}))
}
