// Certificates + withdrawals as an Effect facade over Evolution's `Certificate` (== CSL).

import {
  Anchor,
  Bytes,
  Certificate,
  Credential,
  DRep,
  KeyHash,
  PoolKeyHash,
  ScriptHash,
  Url,
} from '@evolution-sdk/evolution'
import {op} from './Op.js'

const cert = (c: Parameters<typeof Certificate.toCBORHex>[0]) => Certificate.toCBORHex(c)
const credential = (hashHex: string, isScript: boolean) =>
  isScript ? Credential.makeScriptHash(Bytes.fromHex(hashHex)) : Credential.makeKeyHash(Bytes.fromHex(hashHex))
const pool = (hashHex: string) => PoolKeyHash.fromHex(hashHex)

/** ⚠️ This tier encodes "no anchor" as an EMPTY URL; Evolution models it as `undefined`. */
const anchor = (url: string, hashHex: string) =>
  url === ''
    ? undefined
    : new Anchor.Anchor({anchorUrl: new Url.Url({href: url}), anchorDataHash: Bytes.fromHex(hashHex)})

export const stakeRegistration = (credHex: string, isScript = false) =>
  op('certStakeRegistration', () =>
    cert(new Certificate.StakeRegistration({stakeCredential: credential(credHex, isScript)})),
  )
export const stakeDelegation = (credHex: string, poolKeyHashHex: string, isScript = false) =>
  op('certStakeDelegation', () =>
    cert(
      new Certificate.StakeDelegation({
        stakeCredential: credential(credHex, isScript),
        poolKeyHash: pool(poolKeyHashHex),
      }),
    ),
  )
/** Conway `reg_cert` (key-registration with explicit deposit). */
export const registration = (credHex: string, deposit: bigint, isScript = false) =>
  op('certReg', () => cert(new Certificate.RegCert({stakeCredential: credential(credHex, isScript), coin: deposit})))
/** Conway `unreg_cert` (key-deregistration with deposit refund). */
export const unregistration = (credHex: string, deposit: bigint, isScript = false) =>
  op('certUnreg', () =>
    cert(new Certificate.UnregCert({stakeCredential: credential(credHex, isScript), coin: deposit})),
  )

// ---- Conway governance ----

export type DRepKind = 'key' | 'script' | 'abstain' | 'no_confidence'

/**
 * ⚠️ This tier's discriminator, not Evolution's: a hash kind carries `drepHashHex`, the two
 * always-variants carry nothing. An unknown kind is refused rather than defaulted — there is no
 * safe default for who a stake credential delegated its vote to.
 */
const drep = (kind: DRepKind, hashHex: string) => {
  switch (kind) {
    case 'key':
      return DRep.fromKeyHash(KeyHash.fromHex(hashHex))
    case 'script':
      return DRep.fromScriptHash(ScriptHash.fromHex(hashHex))
    case 'abstain':
      return DRep.alwaysAbstain()
    case 'no_confidence':
      return DRep.alwaysNoConfidence()
    default:
      throw new Error(`drep: unknown kind ${String(kind)}`)
  }
}

/** Delegate a stake credential's vote to a DRep (key/script/abstain/no_confidence). */
export const voteDelegation = (credHex: string, drepKind: DRepKind, drepHashHex = '', isScript = false) =>
  op('certVoteDelegation', () =>
    cert(
      new Certificate.VoteDelegCert({
        stakeCredential: credential(credHex, isScript),
        drep: drep(drepKind, drepHashHex),
      }),
    ),
  )
/** DRep registration (16). Pass `anchorUrl=''` for no anchor. */
export const drepRegistration = (
  credHex: string,
  deposit: bigint,
  anchorUrl = '',
  anchorHashHex = '',
  isScript = false,
) =>
  op('certDrepRegistration', () =>
    cert(
      new Certificate.RegDrepCert({
        drepCredential: credential(credHex, isScript),
        coin: deposit,
        anchor: anchor(anchorUrl, anchorHashHex),
      }),
    ),
  )
export const stakeVoteDelegation = (
  credHex: string,
  poolHashHex: string,
  drepKind: DRepKind,
  drepHashHex = '',
  isScript = false,
) =>
  op('certStakeVoteDelegation', () =>
    cert(
      new Certificate.StakeVoteDelegCert({
        stakeCredential: credential(credHex, isScript),
        poolKeyHash: pool(poolHashHex),
        drep: drep(drepKind, drepHashHex),
      }),
    ),
  )
export const stakeRegDelegation = (credHex: string, poolHashHex: string, deposit: bigint, isScript = false) =>
  op('certStakeRegDelegation', () =>
    cert(
      new Certificate.StakeRegDelegCert({
        stakeCredential: credential(credHex, isScript),
        poolKeyHash: pool(poolHashHex),
        coin: deposit,
      }),
    ),
  )
export const voteRegDelegation = (
  credHex: string,
  drepKind: DRepKind,
  deposit: bigint,
  drepHashHex = '',
  isScript = false,
) =>
  op('certVoteRegDelegation', () =>
    cert(
      new Certificate.VoteRegDelegCert({
        stakeCredential: credential(credHex, isScript),
        drep: drep(drepKind, drepHashHex),
        coin: deposit,
      }),
    ),
  )
export const stakeVoteRegDelegation = (
  credHex: string,
  poolHashHex: string,
  drepKind: DRepKind,
  deposit: bigint,
  drepHashHex = '',
  isScript = false,
) =>
  op('certStakeVoteRegDelegation', () =>
    cert(
      new Certificate.StakeVoteRegDelegCert({
        stakeCredential: credential(credHex, isScript),
        poolKeyHash: pool(poolHashHex),
        drep: drep(drepKind, drepHashHex),
        coin: deposit,
      }),
    ),
  )

// ---- pool registration (3) + pieces ----
export interface PoolParams {
  readonly operatorHex: string
  readonly vrfKeyHashHex: string
  readonly pledge: bigint
  readonly cost: bigint
  readonly marginHex: string // from unitInterval
  readonly rewardAccountHex: string
  readonly ownerKeyHashHexes: ReadonlyArray<string>
  readonly relayHexes: ReadonlyArray<string>
  readonly metadataHex?: string
}
