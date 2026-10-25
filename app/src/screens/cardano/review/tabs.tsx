/**
 * The review tabs: Overview, UTxOs, Operations, Smart-contracts, Signatures,
 * Details. Each is presentation-only over a `ReviewedTransaction` + the
 * enrichment context. A tab renders only when it has content (see `visibleTabs`).
 *
 * @module
 */

import type {
  PartyAggregate,
  ReviewedIO,
  ReviewedOperation,
  ReviewedTransaction,
  ReviewedVkeyWitness,
  ReviewedVote,
  TransactionWarning,
} from '@pnyx/tx-review'
import {useRouter} from 'expo-router'
import {useMemo} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Callout} from '../../../components/Callout'
import {Card} from '../../../components/Card'
import {Copiable} from '../../../components/Copiable'
import {Image} from '../../../components/Image'
import {DataRow} from '../../../components/Row'
import {Tag} from '../../../components/Tag'
import {Typography} from '../../../components/Typography'
import {UtxoRef} from '../../../components/Utxo'
import {useCardanoTipHeight} from '../../../hooks/useCardanoTipHeight'
import {useExplorerPreference} from '../../../hooks/useExplorerPreference'
import {useFormatDate} from '../../../hooks/useFormatDate'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useScriptVerification} from '../../../hooks/useScriptVerification'
import {formatGroupedInteger} from '../../../i18n/number-format'
import {useFormat, useI18n} from '../../../providers'
import {useNumberLocale} from '../../../providers/NumberFormatProvider'
import {confirmationsFor} from '../../../services/cardano/confirmations'
import {rosterByCoSigner} from '../../../services/cardano/cosign/envelope'
import type {SignatureStatus} from '../../../services/cardano/cosign/types'
import {
  type MetadataEntry,
  metadataEntries,
  metadataMessageLines,
  metadataRawText,
} from '../../../services/cardano/metadata/entries'
import {metadataLabelInfo} from '../../../services/cardano/metadata/label-registry'
import type {ScriptVerification} from '../../../services/cardano/script-verification'
import {type PoolInfo, useDRepInfo, usePoolInfo} from '../../../services/cardano-pool-drep'
import {requiredSignerSigned, totalDeposit, warningKeysForMode, witnessRoleKey} from '../review-model'
import {AssetLine, CopyableId, KeyValueRow, ReviewAddress, Section} from './components'
import {useEnrichment} from './enrichment'
import {
  drepLabel,
  govActionId,
  govActionLabelKey,
  operationLabelKey,
  poolBech32,
  truncateMiddle,
  voterId,
} from './format'
import {groupIosByAddress} from './io-groups'
import {setPendingMetadata} from './metadata-handoff'

const ADA_DECIMALS = 6

const styles = StyleSheet.create(({spacing, colors}) => ({
  tab: {gap: spacing.spacing12, paddingTop: spacing.spacing12},
  card: {gap: spacing.spacing4, padding: spacing.spacing12},
  warnings: {gap: spacing.spacing8},
  party: {gap: spacing.spacing2},
  partySublabel: {color: colors.textAlternative},
  opTitle: {color: colors.textDefault},
  empty: {color: colors.textAlternative, textAlign: 'center', paddingVertical: spacing.spacing24},
  choiceYes: {color: colors.successDefault},
  choiceNo: {color: colors.errorDefault},
  choiceAbstain: {color: colors.textAlternative},
  metaValue: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8, flexShrink: 1},
  metaLogo: {borderRadius: spacing.spacing8},
  metaText: {alignItems: 'flex-end', flexShrink: 1},
  metaMain: {color: colors.textDefault, textAlign: 'right'},
  metaSub: {color: colors.textAlternative, textAlign: 'right'},
  ioGroup: {gap: spacing.spacing4, paddingBottom: spacing.spacing8},
  utxoRef: {paddingVertical: spacing.spacing4},
  ioEntryDivided: {
    borderTopWidth: 1,
    borderTopColor: colors.borderDefaultWeak,
    marginTop: spacing.spacing8,
    paddingTop: spacing.spacing8,
  },
  // The amounts read as belonging to the UTxO row above them.
  utxoAmounts: {paddingLeft: spacing.spacing12},
  provenanceRow: {gap: spacing.spacing4, paddingVertical: spacing.spacing8},
  provenanceTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.spacing8},
  provenanceNote: {color: colors.textAlternative},
  provenanceDivided: {
    borderTopWidth: 1,
    borderTopColor: colors.borderDefaultWeak,
    marginTop: spacing.spacing8,
    paddingTop: spacing.spacing8,
  },
  metaBlock: {gap: spacing.spacing2, paddingVertical: spacing.spacing4},
  metaLabel: {color: colors.textAlternative},
  metaLine: {color: colors.textDefault},
  metaToggle: {color: colors.primaryDefault, paddingTop: spacing.spacing4},
  witness: {gap: spacing.spacing2, paddingVertical: spacing.spacing4},
  witnessTop: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8},
  witnessRole: {flexShrink: 0},
  witnessKey: {flex: 1, textAlign: 'right', color: colors.textDefault},
  witnessLeak: {textAlign: 'right'},
  roleDefault: {color: colors.textAlternative},
  roleOwn: {color: colors.textDefault},
  roleLeaked: {color: colors.errorDefault},
  roleSigned: {color: colors.successDefault},
}))

const useAda = () => {
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  return (lovelace: bigint) =>
    format(lovelace < 0n ? -lovelace : lovelace, {
      preset: 'cryptoTxDetail',
      currency: adaTicker,
      decimals: ADA_DECIMALS,
    })
}

/**
 * `network_id` is optional in the tx body and our builder does not emit it, so
 * absence is the normal case — it must not read as "testnet". Returns the i18n
 * key for a stated id, or null when the body says nothing.
 */
const networkNameKey = (networkId?: number): 'txReview.network.mainnet' | 'txReview.network.testnet' | null =>
  networkId === undefined ? null : networkId === 1 ? 'txReview.network.mainnet' : 'txReview.network.testnet'

/**
 * One party tier. `showAddresses` is off for our own wallet — its addresses are
 * change plumbing the reader gains nothing from, and the amounts are what
 * matter; everywhere else the address *is* the answer to "who".
 */
const PartyTier = ({
  title,
  parties,
  showAddresses,
  sublabelOf,
}: {
  readonly title: string
  readonly parties: readonly PartyAggregate[]
  readonly showAddresses: boolean
  readonly sublabelOf?: (party: PartyAggregate) => string | undefined
}) => {
  const withMovement = parties.filter((p) => p.sent.length > 0 || p.received.length > 0)
  if (withMovement.length === 0) return null

  return (
    <Card variant="outlined" style={styles.card}>
      <Section title={title}>
        {withMovement.map((party, index) => {
          const address = party.addresses[0]
          const sublabel = sublabelOf?.(party)
          return (
            <View key={`${address?.hex ?? 'party'}_${index}`} style={styles.party}>
              {showAddresses ? party.addresses.map((a) => <ReviewAddress key={a.hex} address={a} />) : null}
              {sublabel !== undefined ? (
                <Typography variant="bodyXs_regular" style={styles.partySublabel}>
                  {sublabel}
                </Typography>
              ) : null}
              {party.sent.map((a) => (
                <AssetLine key={`s_${a.assetId ?? 'ada'}`} amount={{...a, quantity: -a.quantity}} />
              ))}
              {party.received.map((a) => (
                <AssetLine key={`r_${a.assetId ?? 'ada'}`} amount={a} />
              ))}
            </View>
          )
        })}
      </Section>
    </Card>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────
export const OverviewTab = ({
  reviewed,
  mode = 'confirm',
  expectedWarnings,
}: {
  readonly reviewed: ReviewedTransaction
  readonly mode?: 'confirm' | 'detail'
  readonly expectedWarnings?: ReadonlySet<TransactionWarning> | undefined
}) => {
  const {t} = useI18n()
  const ada = useAda()
  const warnings = warningKeysForMode(reviewed, mode, expectedWarnings)
  const deposit = totalDeposit(reviewed)
  const networkKey = networkNameKey(reviewed.networkId)
  const message = useMemo(() => metadataMessageLines(reviewed.metadata), [reviewed.metadata])
  const {formatDateTime} = useFormatDate()
  const when = useMemo(() => {
    if (reviewed.timestamp === undefined) return null
    const ms = Date.parse(reviewed.timestamp)
    return Number.isFinite(ms) ? formatDateTime(new Date(ms), {dateStyle: 'medium', timeStyle: 'short'}) : null
  }, [reviewed.timestamp, formatDateTime])

  const escrowSublabel = (party: PartyAggregate) =>
    party.ownership.level === 'escrow' && party.ownership.owner === 'identity'
      ? t('txReview.labels.escrowDelegatesToIdentity')
      : t('txReview.labels.escrowDelegatesToWallet')

  const otherSublabel = (party: PartyAggregate) =>
    party.ownership.level === 'stake-hijack' ? t('txReview.labels.reusesYourStakeKey') : undefined

  return (
    <View style={styles.tab}>
      {/* A script-failed transaction is on-chain and cost its fee and collateral,
          but did none of what the rest of this screen describes. Stated first,
          because reading the movement below without it is reading a plan that
          did not happen. Only `failed` is surfaced: `confirmed` is what every
          other transaction here already is, so a pill saying so would be noise. */}
      {reviewed.status === 'failed' ? (
        <Callout variant="error" message={t('txReview.warnings.scriptExecutionFailed')} />
      ) : null}
      {warnings.length > 0 ? (
        <View style={styles.warnings}>
          {warnings.map((key) => (
            <Callout key={key} variant="warning" message={t(`txReview.warnings.${key}` as never)} />
          ))}
        </View>
      ) : null}

      {/* A CIP-20 message is addressed to whoever is reading this screen, and it
          often explains the whole transaction — so it belongs here, not behind a
          tab. Every other metadata label stays in Details. */}
      {message !== null ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.details.metadataMessage')}>
            {message.map((line, i) => (
              <Typography key={`${i}_${line}`} variant="bodySm_regular" style={styles.metaLine}>
                {line}
              </Typography>
            ))}
          </Section>
        </Card>
      ) : null}

      {/* Tier order is fixed — the ID first because it is the rarest and the most
          surprising to find in a transaction — and every tier is conditional. */}
      <PartyTier title={t('txReview.labels.yourIdentity')} parties={reviewed.identityGroup.parties} showAddresses />
      <PartyTier title={t('txReview.labels.yourWallet')} parties={reviewed.ownGroup.parties} showAddresses={false} />
      <PartyTier
        title={t('txReview.labels.yourEscrows')}
        parties={reviewed.escrowGroup.parties}
        showAddresses
        sublabelOf={escrowSublabel}
      />
      <PartyTier
        title={t('txReview.labels.others')}
        parties={reviewed.otherGroup.parties}
        showAddresses
        sublabelOf={otherSublabel}
      />

      <Card variant="outlined" style={styles.card}>
        {/* Only a settled transaction has a timestamp — absent while confirming. */}
        {when !== null ? <KeyValueRow label={t('txReview.labels.when')} value={when} /> : null}
        {networkKey !== null ? <KeyValueRow label={t('txReview.labels.network')} value={t(networkKey)} /> : null}
        <KeyValueRow label={t('txReview.labels.fee')} value={ada(reviewed.fee)} />
        {deposit > 0n ? <KeyValueRow label={t('txReview.labels.deposit')} value={ada(deposit)} /> : null}
      </Card>
    </View>
  )
}

// ── UTxOs ─────────────────────────────────────────────────────────────────

/** The amounts one UTxO holds. Shared by the tab row and the UTxO details sheet. */
const IoAmounts = ({io}: {readonly io: ReviewedIO}) => (
  <>
    {io.amounts.map((a) => (
      <AssetLine key={a.assetId ?? 'ada'} amount={a} showSign={false} />
    ))}
  </>
)

/**
 * What an output attaches beyond value. A datum by hash is called out as
 * off-chain rather than shown as a hex blob that looks like data but isn't: the
 * reader cannot interpret the output without a datum this transaction does not
 * contain, and that is the fact worth stating. An inline datum and a reference
 * script are stated as sizes — both run to kilobytes.
 */
const IoAttachments = ({io}: {readonly io: ReviewedIO}) => {
  const {t} = useI18n()
  const {datum, refScript} = io
  const unconfirmed = io.fromUnconfirmedTx === true
  if (datum === undefined && refScript === undefined && !unconfirmed) return null
  return (
    <View style={styles.utxoAmounts}>
      {/* Per-row, because with several inputs the banner cannot say WHICH one is
          contingent — and that is the input a reader would look for. */}
      {unconfirmed ? (
        <Typography variant="bodyXs_regular" style={styles.partySublabel}>
          {t('txReview.utxos.unconfirmedSource')}
        </Typography>
      ) : null}
      {datum?.kind === 'inline' ? (
        <CopyableId
          label={t('txReview.utxos.inlineDatum', {bytes: Math.ceil(datum.hex.length / 2)})}
          value={datum.hex}
        />
      ) : null}
      {datum?.kind === 'hash' ? <CopyableId label={t('txReview.utxos.datumHash')} value={datum.hashHex} /> : null}
      {refScript !== undefined ? (
        <KeyValueRow
          label={t('txReview.utxos.referenceScript')}
          value={t('txReview.utxos.scriptBytes', {bytes: Math.ceil(refScript.hex.length / 2)})}
        />
      ) : null}
    </View>
  )
}

/**
 * One address and the UTxOs at it. An entry with no `outpoint` is an output of
 * the transaction being reviewed: it does not exist yet, so it has no
 * `hash#index` to show or tap.
 *
 * Several entries can share an address — a self-send lands its target output and
 * its change at the same one. Without a per-entry heading their amounts stack into
 * a single list, which reads as one UTxO holding two separate ADA balances. An
 * input names itself by its `hash#index`; an output has no hash yet, so it is named
 * by its position in the transaction body, which is `ios` order.
 */
const IoList = ({label, ios}: {readonly label: string; readonly ios: readonly ReviewedIO[]}) => {
  const {getExplorerUrl} = useExplorerPreference()
  const {t} = useI18n()
  const groups = useMemo(() => groupIosByAddress(ios), [ios])
  const positionOf = useMemo(() => new Map(ios.map((io, i) => [io, i] as const)), [ios])
  return (
    <Card variant="outlined" style={styles.card}>
      <Section title={label}>
        {groups.map((group) => {
          const address = group.address.bech32 ?? group.address.hex
          const split = group.entries.length > 1
          return (
            <View key={group.address.hex} style={styles.ioGroup}>
              <ReviewAddress address={group.address} />
              {group.entries.map((io, i) => (
                <View
                  key={io.outpoint ? `${io.outpoint.txHashHex}#${io.outpoint.index}` : `no-outpoint_${i}`}
                  style={split && i > 0 ? styles.ioEntryDivided : undefined}
                >
                  {io.outpoint !== undefined ? (
                    <UtxoRef
                      txHashHex={io.outpoint.txHashHex}
                      index={io.outpoint.index}
                      address={address}
                      amounts={<IoAmounts io={io} />}
                      style={styles.utxoRef}
                      explorerUrl={getExplorerUrl('tx', io.outpoint.txHashHex)}
                    />
                  ) : split ? (
                    <Typography variant="bodyXs_regular" style={styles.metaLabel}>
                      {t('txReview.utxos.outputIndex', {index: positionOf.get(io) ?? i})}
                    </Typography>
                  ) : null}
                  <View style={styles.utxoAmounts}>
                    <IoAmounts io={io} />
                  </View>
                  <IoAttachments io={io} />
                </View>
              ))}
            </View>
          )
        })}
      </Section>
    </Card>
  )
}

export const UtxosTab = ({reviewed}: {readonly reviewed: ReviewedTransaction}) => {
  const {getExplorerUrl} = useExplorerPreference()
  const {t} = useI18n()
  const mint = reviewed.operations.filter((op) => op.kind === 'minting')
  return (
    <View style={styles.tab}>
      <IoList label={t('txReview.utxos.inputs', {count: reviewed.inputs.length})} ios={reviewed.inputs} />
      {reviewed.unresolvedInputs.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.utxos.foreignInputs', {count: reviewed.unresolvedInputs.length})}>
            {/* Foreign UTxOs: we have their identity but not their address or value. */}
            {reviewed.unresolvedInputs.map((i) => (
              <UtxoRef
                key={`${i.txHashHex}_${i.index}`}
                txHashHex={i.txHashHex}
                index={i.index}
                style={styles.utxoRef}
                explorerUrl={getExplorerUrl('tx', i.txHashHex)}
              />
            ))}
          </Section>
        </Card>
      ) : null}
      {/* Read, not spent — so they belong here with the other UTxOs rather than
          only as a count on the Contracts tab. They are references, so like
          foreign inputs all we have is their identity. */}
      {reviewed.referenceInputs.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.utxos.referenceInputs', {count: reviewed.referenceInputs.length})}>
            <Typography variant="bodySm_regular" style={styles.metaLine}>
              {t('txReview.utxos.referenceInputsNote')}
            </Typography>
            {reviewed.referenceInputs.map((i) => (
              <UtxoRef
                key={`${i.txHashHex}_${i.index}`}
                txHashHex={i.txHashHex}
                index={i.index}
                style={styles.utxoRef}
                explorerUrl={getExplorerUrl('tx', i.txHashHex)}
              />
            ))}
          </Section>
        </Card>
      ) : null}
      <IoList label={t('txReview.utxos.outputs', {count: reviewed.outputs.length})} ios={reviewed.outputs} />
      {mint.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.utxos.mintBurn')}>
            {mint.map(
              (op) =>
                op.kind === 'minting' &&
                op.assets.map((asset) => (
                  <AssetLine
                    key={`${op.policyIdHex}.${asset.assetNameHex}`}
                    amount={{assetId: `${op.policyIdHex}.${asset.assetNameHex}`, quantity: asset.quantity}}
                  />
                )),
            )}
          </Section>
        </Card>
      ) : null}
    </View>
  )
}

// ── Operations ──────────────────────────────────────────────────────────────

// Only these delegation certs resolve the target pool's name/logo (FU-3). A
// pool-retirement targets your own pool and keeps the bare bech32 id.
const DELEGATION_POOL_KINDS: ReadonlySet<ReviewedOperation['kind']> = new Set([
  'stake-delegation',
  'stake-vote-delegation',
  'stake-reg-delegation',
  'stake-vote-reg-delegation',
])

const delegationPoolId = (op: ReviewedOperation): string | undefined =>
  DELEGATION_POOL_KINDS.has(op.kind) && 'poolKeyHashHex' in op ? poolBech32(op.poolKeyHashHex) : undefined

/** A label with a resolved name (main) + the bech32 id (sub) + an optional logo. */
const MetaRow = ({
  label,
  main,
  sub,
  logoUrl,
}: {
  readonly label: string
  readonly main: string
  readonly sub?: string | undefined
  readonly logoUrl?: string | undefined
}) => (
  <DataRow
    label={label}
    size="md"
    value={
      <View style={styles.metaValue}>
        {logoUrl ? (
          <Image source={{uri: logoUrl}} width={20} height={20} style={styles.metaLogo} fallBackImage={null} />
        ) : null}
        <View style={styles.metaText}>
          <Typography variant="bodyMd_medium" style={styles.metaMain}>
            {main}
          </Typography>
          {sub ? (
            <Typography variant="bodySm_regular" style={styles.metaSub}>
              {truncateMiddle(sub)}
            </Typography>
          ) : null}
        </View>
      </View>
    }
  />
)

const PoolRow = ({poolId}: {readonly poolId: string}) => {
  const {t} = useI18n()
  const {info} = usePoolInfo(poolId)
  const label = poolName(info)
  return (
    <MetaRow
      label={t('txReview.opFields.pool')}
      main={label ?? truncateMiddle(poolId)}
      sub={label !== undefined ? poolId : undefined}
      logoUrl={info?.logoUrl}
    />
  )
}

const DRepRow = ({drepId}: {readonly drepId: string}) => {
  const {t} = useI18n()
  const {info} = useDRepInfo(drepId)
  const name = info?.givenName
  return (
    <MetaRow
      label={t('txReview.opFields.drep')}
      main={name ?? truncateMiddle(drepId)}
      sub={name !== undefined ? drepId : undefined}
      logoUrl={info?.imageUrl}
    />
  )
}

/** Best pool display label: `[TICKER] Name` → ticker → name → undefined. */
const poolName = (info: PoolInfo | null): string | undefined => {
  if (info === null) return undefined
  if (info.ticker !== undefined && info.name !== undefined) return `[${info.ticker}] ${info.name}`
  return info.ticker ?? info.name
}

const OperationRows = ({op}: {readonly op: ReviewedOperation}) => {
  const {t} = useI18n()
  const ada = useAda()
  const poolId = delegationPoolId(op)
  const drep = 'drep' in op ? drepLabel(op.drep) : undefined
  const rows: {label: string; value: string; mono?: boolean}[] = []

  switch (op.kind) {
    case 'pool-retirement':
      rows.push({label: t('txReview.opFields.pool'), value: poolBech32(op.poolKeyHashHex), mono: true})
      rows.push({label: t('txReview.opFields.epoch'), value: String(op.epoch)})
      break
    case 'reward-withdrawal':
      rows.push({label: t('txReview.labels.amount'), value: ada(op.amount)})
      // A zero withdrawal is a script-satisfying no-op, not a payout: DEX orders
      // routinely include one. Unannotated it reads as a bug.
      if (op.amount === 0n) rows.push({label: '', value: t('txReview.opFields.zeroWithdrawal')})
      break
    case 'unknown-certificate':
      rows.push({
        label: t('txReview.opFields.certificateType'),
        value: op.label ?? (op.tag !== undefined ? `#${op.tag}` : t('txReview.opFields.unknownType')),
        mono: op.label === undefined,
      })
      break
    default:
      break
  }
  if (drep && drep.kind !== 'id')
    rows.push({label: t('txReview.opFields.drep'), value: t(`txReview.drep.${drep.kind}` as never)})
  if ('deposit' in op && op.deposit > 0n) rows.push({label: t('txReview.labels.deposit'), value: ada(op.deposit)})
  if (op.kind === 'contract-execution' && op.totalCollateral !== undefined)
    rows.push({label: t('txReview.opFields.collateral'), value: ada(op.totalCollateral)})

  return (
    <Card variant="outlined" style={styles.card}>
      <Typography variant="bodyMd_medium" style={styles.opTitle}>
        {t(`txReview.operations.${operationLabelKey(op)}` as never)}
      </Typography>
      {poolId ? <PoolRow poolId={poolId} /> : null}
      {drep && drep.kind === 'id' && drep.id ? <DRepRow drepId={drep.id} /> : null}
      {rows.map((r) => (
        <KeyValueRow key={r.label} label={r.label} value={r.value} mono={r.mono ?? false} />
      ))}
      {op.kind === 'voting-procedures'
        ? op.votes.map((v) => <VoteRows key={`${v.govActionId.txHashHex}_${v.govActionId.index}`} vote={v} />)
        : null}
      {op.kind === 'proposal-procedures'
        ? op.proposals.map((p) => (
            <View key={`${p.action.type}_${p.rewardAccountHex}`}>
              <KeyValueRow
                label={t('txReview.opFields.action')}
                value={t(`txReview.govActions.${govActionLabelKey(p.action)}` as never)}
              />
              <KeyValueRow label={t('txReview.labels.deposit')} value={ada(p.deposit)} />
            </View>
          ))
        : null}
    </Card>
  )
}

const VoteRows = ({vote}: {readonly vote: ReviewedVote}) => {
  const {t} = useI18n()
  const choiceStyle =
    vote.choice === 'yes' ? styles.choiceYes : vote.choice === 'no' ? styles.choiceNo : styles.choiceAbstain
  return (
    <View>
      <KeyValueRow label={t('txReview.opFields.voter')} value={voterId(vote.voter)} mono />
      <KeyValueRow
        label={t('txReview.opFields.action')}
        value={govActionId(vote.govActionId.txHashHex, vote.govActionId.index)}
        mono
      />
      <DataRow
        label={t('txReview.opFields.vote')}
        size="md"
        value={
          <Typography variant="bodyMd_medium" style={choiceStyle}>
            {t(`txReview.vote.${vote.choice}` as never)}
          </Typography>
        }
      />
    </View>
  )
}

export const OperationsTab = ({reviewed}: {readonly reviewed: ReviewedTransaction}) => (
  <View style={styles.tab}>
    {reviewed.operations.map((op, i) => (
      <OperationRows key={`${op.kind}_${i}`} op={op} />
    ))}
  </View>
)

// ── Smart contracts ─────────────────────────────────────────────────────────

/** Tag variant + label for a verdict. `unknown` is deliberately neutral: the
 *  registry was not reached, which says nothing about the contract. */
const provenanceTag = (v: ScriptVerification | undefined): {variant: 'success' | 'secondary'; key: string} =>
  v?.status === 'verified'
    ? {variant: 'success', key: 'verified'}
    : {variant: 'secondary', key: v?.status === 'unverified' ? 'unverified' : 'unknown'}

/**
 * CIP-171 provenance, one block per script the transaction touches.
 *
 * Rendered only when a registry is configured. A verified script shows the
 * repository and commit somebody rebuilt to get this hash; everything else says
 * what it is — not registered, or not checkable — because "no badge" and "we
 * could not ask" are different facts and a reader acts differently on each.
 */
const ScriptProvenanceCard = ({reviewed}: {readonly reviewed: ReviewedTransaction}) => {
  const {t} = useI18n()
  const {scripts, verdicts, loading, available} = useScriptVerification(reviewed)
  if (!available || scripts.length === 0) return null
  return (
    <Card variant="outlined" style={styles.card}>
      <Section title={t('txReview.contracts.provenance.title')}>
        {loading ? (
          <Typography variant="bodySm_regular" style={styles.provenanceNote}>
            {t('txReview.contracts.provenance.checking')}
          </Typography>
        ) : null}
        {scripts.map((script, i) => {
          const verdict = verdicts.get(script.hashHex)
          const tag = provenanceTag(verdict)
          return (
            <View key={script.hashHex} style={[styles.provenanceRow, i > 0 ? styles.provenanceDivided : undefined]}>
              <View style={styles.provenanceTop}>
                <Typography variant="bodySm_regular" style={styles.provenanceNote}>
                  {script.sites.map((site) => t(`txReview.contracts.provenance.site.${site}` as never)).join(' · ')}
                </Typography>
                <Tag
                  size="sm"
                  variant={tag.variant}
                  {...(tag.key === 'verified' ? {icon: 'shieldCheck' as const} : {})}
                  label={t(`txReview.contracts.provenance.${tag.key}` as never)}
                />
              </View>
              <CopyableId label={t('txReview.contracts.provenance.scriptHash')} value={script.hashHex} />
              {verdict?.status === 'verified' ? (
                <>
                  <CopyableId label={t('txReview.contracts.provenance.repository')} value={verdict.sourceUrl} />
                  <CopyableId label={t('txReview.contracts.provenance.commit')} value={verdict.commitHash} />
                  {verdict.sourcePath !== '' ? (
                    <KeyValueRow label={t('txReview.contracts.provenance.path')} value={verdict.sourcePath} />
                  ) : null}
                  <KeyValueRow
                    label={t('txReview.contracts.provenance.compiler')}
                    value={`${verdict.compilerType} ${verdict.compilerVersion}`}
                  />
                  {verdict.env !== null ? (
                    <KeyValueRow label={t('txReview.contracts.provenance.buildEnv')} value={verdict.env} />
                  ) : null}
                  <Typography variant="bodySm_regular" style={styles.provenanceNote}>
                    {t('txReview.contracts.provenance.verifiedNote')}
                  </Typography>
                </>
              ) : (
                <Typography variant="bodySm_regular" style={styles.provenanceNote}>
                  {t(
                    verdict?.status === 'unverified'
                      ? 'txReview.contracts.provenance.unverifiedNote'
                      : 'txReview.contracts.provenance.unknownNote',
                  )}
                </Typography>
              )}
            </View>
          )
        })}
      </Section>
    </Card>
  )
}

export const ContractsTab = ({reviewed}: {readonly reviewed: ReviewedTransaction}) => {
  const {t} = useI18n()
  const ada = useAda()
  const s = reviewed.scripts
  return (
    <View style={styles.tab}>
      <Card variant="outlined" style={styles.card}>
        {reviewed.scriptDataHashHex ? (
          <CopyableId label={t('txReview.contracts.scriptDataHash')} value={reviewed.scriptDataHashHex} />
        ) : null}
        {reviewed.collateral ? (
          <>
            <KeyValueRow
              label={t('txReview.contracts.collateralInputs')}
              value={String(reviewed.collateral.inputs.length)}
            />
            {reviewed.collateral.balance !== undefined ? (
              <KeyValueRow label={t('txReview.opFields.collateral')} value={ada(reviewed.collateral.balance)} />
            ) : null}
          </>
        ) : null}
        {/* Scripts increasingly live in reference inputs rather than the witness
            set, so "Plutus scripts 0" alone reads as "no contract here" on a
            transaction that plainly runs one. */}
        {reviewed.referenceInputs.length > 0 ? (
          <KeyValueRow
            label={t('txReview.contracts.referenceInputs')}
            value={String(reviewed.referenceInputs.length)}
          />
        ) : null}
        <KeyValueRow
          label={t('txReview.contracts.plutusScripts')}
          value={String(s.plutusV1 + s.plutusV2 + s.plutusV3)}
        />
        <KeyValueRow label={t('txReview.contracts.nativeScripts')} value={String(s.native)} />
        <KeyValueRow label={t('txReview.contracts.datums')} value={String(s.datums)} />
        <KeyValueRow label={t('txReview.contracts.redeemers')} value={String(s.redeemers)} />
      </Card>
      <ScriptProvenanceCard reviewed={reviewed} />
      {/* Where the collateral goes back to if the scripts succeed. Without it the
          tab states how much is at risk and never says whose it is or where the
          remainder lands — and this output is the difference between losing the
          whole collateral input and losing only the covered amount. */}
      {reviewed.collateral?.returnOutput !== undefined ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.contracts.collateralReturn')}>
            <ReviewAddress address={reviewed.collateral.returnOutput.address} />
            <View style={styles.utxoAmounts}>
              <IoAmounts io={reviewed.collateral.returnOutput} />
            </View>
          </Section>
        </Card>
      ) : null}
    </View>
  )
}

// ── Signatures ──────────────────────────────────────────────────────────────
/**
 * One witness: what the key is to this wallet, then the key itself.
 *
 * The role fills a column that was empty, which buys the key ~10 more characters
 * before truncation — and it is the fact a reader wants first, because a witness
 * hex on its own says nothing. A leaked key keeps its role and gains the reason,
 * so "this is yours" and "this is burned" are never traded against each other.
 */
const WitnessRow = ({witness}: {readonly witness: ReviewedVkeyWitness}) => {
  const {t} = useI18n()
  const role = witnessRoleKey(witness)
  return (
    <View style={styles.witness}>
      <View style={styles.witnessTop}>
        <Typography
          variant="bodySm_regular"
          style={[
            styles.witnessRole,
            witness.leaksSigningKey ? styles.roleLeaked : role === 'external' ? styles.roleDefault : styles.roleOwn,
          ]}
        >
          {t(`txReview.signatures.role.${role}` as never)}
        </Typography>
        <Typography variant="bodySm_regular" style={styles.witnessKey}>
          {truncateMiddle(witness.vkeyHex, 16, 10)}
        </Typography>
      </View>
      {witness.leaksSigningKey ? (
        <Typography variant="bodyXs_regular" style={[styles.roleLeaked, styles.witnessLeak]}>
          {t('txReview.signatures.leakedWitness')}
        </Typography>
      ) : null}
      {/* The signature itself, so it can be verified elsewhere. It is what the
          leak check above ran on, and on a disputed transaction it is the only
          thing that settles who authorised what. */}
      <CopyableId label={t('txReview.signatures.signature')} value={witness.signatureHex} />
    </View>
  )
}

/**
 * What authorises this transaction, by kind. The Contracts tab counts scripts
 * because they *run*; they are counted again here because they also *authorise* —
 * a transaction spending from a script address has fewer key signatures than it
 * has requirements, and reading only the vkey list makes that look unsatisfied.
 *
 * **Redeemers, not script counts, are the signal.** Scripts increasingly live in
 * reference inputs rather than the witness set, so a transaction invoking three
 * contracts can carry `plutusScripts: 0` — the same trap the Contracts tab
 * documents. Each redeemer is one script invocation being authorised, whether the
 * script travels with the transaction or is referenced.
 *
 * Rows appear only when non-zero, except the key-signature count, which is what
 * the rest of the tab lists and therefore always worth stating alongside.
 */
const WitnessKinds = ({reviewed}: {readonly reviewed: ReviewedTransaction}) => {
  const {t} = useI18n()
  const s = reviewed.scripts
  const plutus = s.plutusV1 + s.plutusV2 + s.plutusV3
  const bootstrap = reviewed.bootstrapWitnesses ?? 0
  if (bootstrap === 0 && plutus === 0 && s.native === 0 && s.redeemers === 0) return null
  return (
    <Card variant="outlined" style={styles.card}>
      <Section title={t('txReview.signatures.witnessKinds')}>
        <KeyValueRow
          label={t('txReview.signatures.vkeyWitnessesCount')}
          value={String(reviewed.witnessSet?.length ?? 0)}
        />
        {bootstrap > 0 ? (
          <KeyValueRow label={t('txReview.signatures.bootstrapWitnesses')} value={String(bootstrap)} />
        ) : null}
        {s.redeemers > 0 ? (
          <KeyValueRow label={t('txReview.signatures.scriptAuthorizations')} value={String(s.redeemers)} />
        ) : null}
        {s.native > 0 ? (
          <KeyValueRow label={t('txReview.signatures.nativeWitnesses')} value={String(s.native)} />
        ) : null}
        {plutus > 0 ? <KeyValueRow label={t('txReview.signatures.plutusWitnesses')} value={String(plutus)} /> : null}
      </Section>
    </Card>
  )
}

/**
 * When a `signatureStatus` is supplied (multisig/multiparty), render the quorum
 * panel — "R of T", per-signer Signed/Pending, nested co-signer counts. Else
 * fall back to the honest required-signers + witness lists from the IR.
 */
export const SignaturesTab = ({
  reviewed,
  signatureStatus,
}: {
  readonly reviewed: ReviewedTransaction
  readonly signatureStatus?: SignatureStatus | undefined
}) => {
  const {t} = useI18n()
  if (signatureStatus) {
    return (
      <View style={styles.tab}>
        <Card variant="outlined" style={styles.card}>
          <KeyValueRow
            label={t('txReview.signatures.quorum')}
            value={t('txReview.signatures.rOfT', {
              signed: signatureStatus.signed,
              required: signatureStatus.required,
            })}
          />
          <KeyValueRow
            label={t(`multisig.kind.${signatureStatus.kind}` as never)}
            value={t('txReview.signatures.rOfT', {signed: signatureStatus.signed, required: signatureStatus.total})}
          />
        </Card>
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.signatures.signers')}>
            {rosterByCoSigner(signatureStatus.signers).map((s) => (
              <KeyValueRow
                key={s.id}
                label={`${s.name}${s.isSelf ? t('multisig.you') : ''}`}
                value={
                  s.nested
                    ? t('txReview.signatures.rOfT', {signed: s.nested.signed, required: s.nested.required})
                    : // A co-signer owes one witness per payment index the spend
                      // touches. Their own progress, when it is more than one.
                      s.owed > 1
                      ? t('txReview.signatures.rOfT', {signed: s.signed, required: s.owed})
                      : s.signed > 0
                        ? t('txReview.signatures.signed')
                        : t('txReview.signatures.pending')
                }
              />
            ))}
          </Section>
        </Card>
      </View>
    )
  }
  const required = reviewed.requiredSigners
  const signed = reviewed.witnessSet?.length ?? 0
  return (
    <View style={styles.tab}>
      <Card variant="outlined" style={styles.card}>
        <KeyValueRow
          label={t('txReview.signatures.status')}
          value={
            // A body with no required-signers field yields "2 of 0", which is not a
            // fact about anything. Count what is there instead.
            required.length > 0
              ? t('txReview.signatures.nOfM', {signed, required: required.length})
              : t('txReview.signatures.witnessCount', {count: signed})
          }
        />
      </Card>
      {required.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.signatures.requiredSigners')}>
            {required.map((hash) => {
              const signed = requiredSignerSigned(reviewed, hash)
              return (
                <View key={hash} style={styles.witnessTop}>
                  <Typography
                    variant="bodySm_regular"
                    style={[styles.witnessRole, signed === true ? styles.roleSigned : styles.roleDefault]}
                  >
                    {signed === null
                      ? t('txReview.signatures.unsignedBody')
                      : signed
                        ? t('txReview.signatures.signed')
                        : t('txReview.signatures.pending')}
                  </Typography>
                  <Typography variant="bodySm_regular" style={styles.witnessKey}>
                    {truncateMiddle(hash, 16, 10)}
                  </Typography>
                </View>
              )
            })}
          </Section>
        </Card>
      ) : null}
      <WitnessKinds reviewed={reviewed} />
      {reviewed.witnessSet && reviewed.witnessSet.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.signatures.witnesses')}>
            {reviewed.witnessSet.map((w) => (
              <WitnessRow key={w.vkeyHex} witness={w} />
            ))}
          </Section>
        </Card>
      ) : null}
    </View>
  )
}

// ── Details ─────────────────────────────────────────────────────────────────

/**
 * Lines shown before a block collapses.
 *
 * Any label can carry an arbitrarily large payload — a Reeve journal
 * (`INDIVIDUAL_TRANSACTIONS`, label 1447) pretty-printed at 2-space indent runs
 * to hundreds of lines — and rendering them all put every one into a single
 * scrolling `Section`, burying every row beneath it.
 */
const METADATA_COLLAPSED_LINES = 8

/**
 * One metadata label and its content, as a block rather than a row: a CIP-20
 * message is prose, and any other value is JSON that does not fit on one line.
 *
 * The heading names the label where CIP-10 registers one, so an unrecognised
 * payload is not left as a bare number over a JSON dump. Most labels in use are
 * unregistered, so the un-named form is a first-class case, not a fallback.
 */
const MetadataBlock = ({entry}: {readonly entry: MetadataEntry}) => {
  const {t} = useI18n()
  const router = useRouter()

  const info = entry.isMessage || entry.joinedLabels !== undefined ? undefined : metadataLabelInfo(entry.key)
  const heading = entry.isMessage
    ? t('txReview.details.metadataMessage')
    : entry.joinedLabels !== undefined
      ? t(entry.isHex ? 'txReview.details.metadataJoinedData' : 'txReview.details.metadataJoined', {
          labels: `${entry.joinedLabels[0]}–${entry.joinedLabels[entry.joinedLabels.length - 1]}`,
        })
      : info === undefined
        ? t('txReview.details.metadataLabelUnknown', {label: entry.key})
        : info.cip === undefined
          ? t('txReview.details.metadataLabelNamed', {name: info.name, label: entry.key})
          : t('txReview.details.metadataLabelNamedCip', {name: info.name, cip: info.cip, label: entry.key})

  const hidden = entry.lines.length - METADATA_COLLAPSED_LINES
  const lines = hidden <= 0 ? entry.lines : entry.lines.slice(0, METADATA_COLLAPSED_LINES)

  return (
    <View style={styles.metaBlock}>
      <Typography variant="bodySm_regular" style={styles.metaLabel}>
        {heading}
      </Typography>
      {lines.map((line, i) => (
        <Typography key={`${entry.key}_${i}`} variant="bodySm_regular" style={styles.metaLine}>
          {line}
        </Typography>
      ))}
      {hidden > 0 ? (
        <Pressable
          onPress={() => {
            setPendingMetadata(entry.key, {heading, lines: entry.lines})
            router.push({pathname: '/wallet/tx-metadata', params: {label: entry.key}})
          }}
          accessibilityRole="button"
          testID={`metadata-toggle-${entry.key}`}
        >
          <Typography variant="bodySm_medium" style={styles.metaToggle}>
            {t('txReview.details.metadataShowAll', {count: hidden})}
          </Typography>
        </Pressable>
      ) : null}
    </View>
  )
}

/**
 * Details holds what no other tab shows. Network and the transaction hash are NOT
 * here: Overview states the network, and the detail screen's own footer carries the
 * transaction id with its explorer link.
 */
export const DetailsTab = ({
  reviewed,
  mode = 'confirm',
}: {
  readonly reviewed: ReviewedTransaction
  readonly mode?: 'confirm' | 'detail'
}) => {
  const {t} = useI18n()
  const locale = useNumberLocale()
  const {formatDateTime} = useFormatDate()
  const {dateOfSlot} = useEnrichment()
  const tipHeight = useCardanoTipHeight()
  // The CIP-20 message is on the Overview now; Details carries every other label.
  const entries = useMemo(() => metadataEntries(reviewed.metadata).filter((e) => !e.isMessage), [reviewed.metadata])
  const cbor = reviewed.cbor
  const block = reviewed.block
  const confirmations = confirmationsFor(tipHeight, block?.height)

  /**
   * A slot with its wall-clock time beside it. "Expires at slot 152 741 887" is
   * not an answer to "when does this expire", and the slot still has to be there
   * — it is what the transaction actually contains and what a node reports.
   */
  const slotWithTime = (slot: bigint): string => {
    const grouped = formatGroupedInteger(slot, locale)
    const date = dateOfSlot(slot)
    return date === null ? grouped : `${grouped} · ${formatDateTime(date, {dateStyle: 'medium', timeStyle: 'short'})}`
  }

  const rows = [
    // Always stated: "never expires" is a real property of the transaction, just
    // not an alarm — it used to be a banner on every tx we build.
    reviewed.ttl !== undefined ? (
      <KeyValueRow key="ttl" label={t('txReview.details.ttl')} value={slotWithTime(reviewed.ttl)} />
    ) : mode === 'confirm' ? (
      // Worth stating before signing; on a settled transaction its expiry
      // stopped mattering the moment it was accepted.
      <KeyValueRow key="ttl" label={t('txReview.details.ttl')} value={t('txReview.details.ttlNone')} />
    ) : null,
    reviewed.validityIntervalStart !== undefined ? (
      <KeyValueRow
        key="validityStart"
        label={t('txReview.details.validityStart')}
        value={slotWithTime(reviewed.validityIntervalStart)}
      />
    ) : null,
    reviewed.auxiliaryDataHashHex ? (
      <CopyableId key="metaHash" label={t('txReview.details.metadataHash')} value={reviewed.auxiliaryDataHashHex} />
    ) : null,
    // The exact bytes, for decoding elsewhere — the one thing this tab can offer
    // that no amount of rendering replaces. The label names which artifact it is,
    // because pasting a bare body where a transaction is expected fails opaquely.
    // Size stated: a copy of several KB is worth knowing about beforehand.
    cbor !== undefined && cbor.hex.length > 0 ? (
      <CopyableId
        key="cbor"
        label={t(`txReview.details.${cbor.kind === 'transaction' ? 'txCbor' : 'bodyCbor'}`, {
          bytes: Math.ceil(cbor.hex.length / 2),
        })}
        value={cbor.hex}
      />
    ) : null,
  ].filter((row) => row !== null)

  // Where the transaction landed. Only a settled one has any of this, and each
  // row is independently absent — a producer reports what its source gave it.
  const blockRows =
    block === undefined
      ? []
      : [
          block.height !== undefined ? (
            <KeyValueRow
              key="height"
              label={t('txReview.details.blockHeight')}
              value={formatGroupedInteger(block.height, locale)}
            />
          ) : null,
          // The one row here that is not a fact about the transaction — it is the
          // distance from its block to now, so it is read live and absent when
          // that read cannot be trusted.
          confirmations !== null ? (
            <KeyValueRow
              key="confirmations"
              label={t('txReview.details.confirmations')}
              value={formatGroupedInteger(confirmations, locale)}
            />
          ) : null,
          block.slot !== undefined ? (
            <KeyValueRow key="slot" label={t('txReview.details.slot')} value={slotWithTime(BigInt(block.slot))} />
          ) : null,
          block.epoch !== undefined ? (
            <KeyValueRow
              key="epoch"
              label={t('txReview.details.epoch')}
              value={formatGroupedInteger(block.epoch, locale)}
            />
          ) : null,
          block.hashHex !== undefined ? (
            <CopyableId key="blockHash" label={t('txReview.details.blockHash')} value={block.hashHex} />
          ) : null,
        ].filter((row) => row !== null)

  return (
    <View style={styles.tab}>
      {blockRows.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          <Section title={t('txReview.details.block')}>{blockRows}</Section>
        </Card>
      ) : null}
      {/* Every row here is conditional, and a settled transaction can match none
          of them — an outlined card with nothing in it reads as a failed load. */}
      {rows.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          {rows}
        </Card>
      ) : null}
      {entries.length > 0 ? (
        <Card variant="outlined" style={styles.card}>
          <Section
            title={t('txReview.details.metadata')}
            // The section owns the copy, not each block: what a reader wants out of here
            // is the payload as it sits on chain — every label, uncollapsed, unreassembled.
            rightSlot={
              <Copiable
                text={metadataRawText(reviewed.metadata)}
                feedback={t('txReview.details.metadataCopied')}
                iconSize={16}
                testID="metadata-copy"
              />
            }
          >
            {entries.map((entry) => (
              <MetadataBlock key={entry.key} entry={entry} />
            ))}
          </Section>
        </Card>
      ) : null}
    </View>
  )
}

/** Which tabs have content for this tx (drives the tab bar + content switch). */
export type ReviewTabKey = 'overview' | 'utxos' | 'operations' | 'contracts' | 'signatures' | 'details'

export const visibleTabs = (reviewed: ReviewedTransaction): readonly ReviewTabKey[] => {
  const tabs: ReviewTabKey[] = ['overview', 'utxos']
  if (reviewed.operations.length > 0) tabs.push('operations')
  const s = reviewed.scripts
  if (reviewed.scriptDataHashHex || reviewed.collateral || s.plutusV1 + s.plutusV2 + s.plutusV3 + s.native > 0)
    tabs.push('contracts')
  if (reviewed.requiredSigners.length > 0 || (reviewed.witnessSet?.length ?? 0) > 0) tabs.push('signatures')
  tabs.push('details')
  return tabs
}
