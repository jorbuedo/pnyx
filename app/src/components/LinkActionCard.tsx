/**
 * A link inside a message, rendered as something you can read and act on.
 *
 * One card for every kind of action link, shared by DM threads and circle
 * channels — the same string means the same thing in both, and a card per surface
 * would be two answers to one question.
 *
 * What every case gets right, because these are the properties that make a card
 * safe to tap:
 *
 * - It **names what would happen** before anything happens. Not "open link" but
 *   "Request from addr1…", "join Treasury", "open app.example.com".
 * - It **never acts**. The whole card is the tap target and it opens a sheet with
 *   the details, the wallet to use and the network to be on; that sheet hands off to
 *   the real flow, which has its own review and its own signature. A card that could
 *   act would be a message that spends money — and the message came from someone
 *   else.
 * - It **carries no second tap target**. The address inside is not copiable here
 *   (`copiable={false}`) because two nested targets is one the user cannot reliably
 *   hit; the copy lives on the sheet, which shows the request in full.
 * - Our **own** message is a record where answering it would be answering
 *   ourselves. That is true of the two multisig cards — an invite we sent must not
 *   offer "share my key" — and not of a payment request or a dApp link, where acting
 *   on something you posted is ordinary.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {getExplorerName, useExplorerPreference} from '../hooks/useExplorerPreference'
import {logger} from '../logger'
import {useFormat, useI18n} from '../providers'
import {requiredFor, statusOf} from '../services/cardano/cosign/envelope'
import type {TxEnvelope} from '../services/cardano/cosign/types'
import {signPolicy} from '../services/cardano/multisig/template'
import {cexplorerLogoUrl, useDRepInfo, usePoolInfo} from '../services/cardano-pool-drep'
import type {LinkAction} from '../services/link-action'
import {truncateMiddle} from '../utils/truncate'
import {Address} from './Address'
import {Button} from './Buttons/Button'
import {Card} from './Card'
import {PoolDrepAvatar} from './PoolDrepAvatar'
import {Typography} from './Typography'

const ADA_DECIMALS = 6

export type LinkActionCardProps = {
  readonly action: LinkAction
  /** True when we sent it — our own action link is a record of what we asked. */
  readonly mine: boolean
  readonly busy?: boolean
  /**
   * Per-kind handlers. Each is optional and an absent one hides its affordance
   * rather than offering something that will fail: a wallet that cannot co-sign has
   * no key to share, and a request this build cannot act on should not invite a tap.
   */
  readonly onShareKey?: (() => void) | undefined
  readonly onUseKey?: (() => void) | undefined
  /** Take a received shared-wallet definition to the screen that reviews and adds it. */
  readonly onUseWallet?: (() => void) | undefined
  /**
   * Open the details sheet. One handler for every card that has a sheet — a
   * payment request and both delegations open the same one, so a second prop name
   * would only be a second name for one action.
   */
  readonly onOpenDetails?: (() => void) | undefined
  /**
   * Open a URL in the in-app browser. One handler for the dApp card and the
   * explorer card — the card knows which URL, the surface knows how to open one.
   */
  readonly onOpenUrl?: ((url: string) => void) | undefined
  /** Open a transaction in the app's own review screen. */
  readonly onOpenTransaction?: ((hash: string) => void) | undefined
  /** Take a shared-wallet transaction to the co-sign screen. */
  readonly onOpenCosign?: ((envelope: TxEnvelope) => void) | undefined
  /**
   * Long-press the card itself, for the surface's message actions.
   *
   * Threaded into every branch rather than left to an outer wrapper: a card that
   * has its own `Pressable` captures the gesture, so a wrapper around it would
   * long-press on plain text and do nothing on exactly the rows most worth acting
   * on.
   */
  readonly onLongPress?: (() => void) | undefined
}

export const LinkActionCard = ({
  action,
  mine,
  busy,
  onShareKey,
  onUseKey,
  onUseWallet,
  onOpenDetails,
  onOpenUrl,
  onOpenTransaction,
  onOpenCosign,
  onLongPress,
}: LinkActionCardProps) => {
  const {t} = useI18n()
  const format = useFormat()
  // Resolved unconditionally — both hooks treat `undefined` as "no lookup", which
  // keeps them above the per-kind branches, where hooks may not go.
  const {info: poolInfo} = usePoolInfo(action.kind === 'stake-delegation' ? action.poolId : undefined)
  const {info: drepInfo} = useDRepInfo(action.kind === 'drep-delegation' ? action.drepId : undefined)
  const {getExplorerUrl: explorerUrl, explorerId} = useExplorerPreference()
  const explorerName = getExplorerName(explorerId)

  /**
   * The press behaviour every card shares: tapping opens the details sheet.
   *
   * **No card may be inert.** A tap that does nothing is indistinguishable from a
   * broken one, and the kinds with nothing to *do* are exactly the kinds that most
   * need to say why — an invitation you sent yourself, a link this build can name
   * and not carry out. The sheet is where that explanation lives, so every kind
   * reaches it, and the per-kind buttons below stay as the shortcut for the case
   * where there is a single obvious action.
   */
  const opens = (label: string) => ({
    onPress: onOpenDetails,
    onLongPress,
    disabled: onOpenDetails === undefined && onLongPress === undefined,
    accessibilityRole: 'button' as const,
    accessibilityLabel: label,
    style: styles.card,
  })

  /**
   * One action button, or nothing when this surface offers none.
   *
   * `suppressWhenMine` is the "answering ourselves" rule, and it is per kind rather
   * than blanket: see the module note.
   */
  const button = (
    label: string,
    onPress: (() => void) | undefined,
    testID: string,
    variant: 'primary' | 'secondary',
    suppressWhenMine = false,
  ) =>
    (suppressWhenMine && mine) || onPress === undefined ? null : (
      <View style={styles.actions}>
        <Button
          label={label}
          variant={variant}
          onPress={onPress}
          isLoading={busy === true}
          containerStyles={styles.action}
          testID={testID}
        />
      </View>
    )

  if (action.kind === 'multisig-invite') {
    return (
      <Card {...opens(t('multisig.dm.inviteTitle'))} testID="link-action-multisig-invite">
        <Typography variant="bodySm_medium">{t('multisig.dm.inviteTitle')}</Typography>
        <Typography variant="bodyXs_regular" style={styles.label}>
          {mine ? t('multisig.dm.inviteSentBody') : t('multisig.dm.inviteBody')}
        </Typography>
        {button(t('multisig.dm.shareMyKey'), onShareKey, 'dm-multisig-share-key', 'primary', true)}
      </Card>
    )
  }

  if (action.kind === 'cosigner-key') {
    return (
      <Card {...opens(t('multisig.dm.keyTitle'))} testID="link-action-cosigner-key">
        <Typography variant="bodySm_medium">{t('multisig.dm.keyTitle')}</Typography>
        <Typography variant="bodyXs_regular" style={styles.label}>
          {mine ? t('multisig.dm.keyOwn') : t('multisig.dm.keyBody')}
        </Typography>
        {mine ? null : button(t('multisig.dm.useKey'), onUseKey, 'dm-multisig-use-key', 'secondary', true)}
      </Card>
    )
  }

  if (action.kind === 'shared-wallet') {
    const policy = signPolicy(action.definition.paymentTemplate)
    return (
      <Card
        {...opens(t('multisig.dm.walletTitle', {wallet: action.definition.name}))}
        testID="link-action-shared-wallet"
      >
        <Typography variant="bodySm_medium">
          {t('multisig.dm.walletTitle', {wallet: action.definition.name})}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.label}>
          {mine
            ? t('multisig.dm.walletOwn')
            : t('multisig.dm.walletBody', {
                count: action.definition.coSigners.length,
                policy: t('multisig.list.policy', {required: policy.required, total: policy.total}),
              })}
        </Typography>
        {mine ? null : button(t('multisig.dm.useWallet'), onUseWallet, 'dm-multisig-use-wallet', 'secondary', true)}
      </Card>
    )
  }

  if (action.kind === 'payment-request') {
    // The bigint goes straight to the formatter with its decimals — the lossless
    // path, and the only one: a lovelace count past 2^53 cannot survive a number,
    // and this is the figure the user is being asked to agree to.
    const amount =
      action.lovelace === null
        ? null
        : format(action.lovelace, {preset: 'cryptoTxDetail', currency: 'ADA', decimals: ADA_DECIMALS})
    return (
      <Card
        onPress={onOpenDetails}
        onLongPress={onLongPress}
        disabled={onOpenDetails === undefined && onLongPress === undefined}
        accessibilityRole="button"
        accessibilityLabel={
          amount === null ? t('linkAction.payment.titleOpen') : t('linkAction.payment.title', {amount})
        }
        style={styles.card}
        testID="link-action-payment-request"
      >
        {/* Three centred lines: who is asking, their address, and the figure. The
            number is what the user is being asked for, so it is the largest thing on
            the card — an open request has none to show and says so instead. */}
        <Typography variant="bodyXs_regular" style={styles.centredLabel}>
          {t('linkAction.payment.requestFrom')}
        </Typography>
        <Address
          address={action.address}
          showModal={false}
          copiable={false}
          style={styles.centredAddress}
          textStyle={styles.addressText}
        />
        <Typography variant="headingLg" style={styles.amount}>
          {amount ?? t('linkAction.payment.anyAmount')}
        </Typography>
      </Card>
    )
  }

  // Both delegation cards are summaries in the same shape as the payment one: the
  // whole card is the tap target and the detail lives in the sheet it opens. The
  // name and logo come from the pool / DRep register — never from the link, which
  // would be the sender's own string next to someone else's id.
  if (action.kind === 'stake-delegation' || action.kind === 'drep-delegation') {
    const isPool = action.kind === 'stake-delegation'
    const id = isPool ? action.poolId : action.drepId
    const registeredName = isPool ? poolInfo?.name : drepInfo?.givenName
    // Derived from the id when the register has no logo — the CDN serves a generic
    // placeholder for an unknown id, which beats an initials disc reading "PO" off
    // the bech32 prefix. The system targets have no id and keep their initials.
    const imageUrl =
      (isPool ? poolInfo?.logoUrl : drepInfo?.imageUrl) ??
      (id.startsWith('pool1') || id.startsWith('drep1') ? cexplorerLogoUrl(id) : null)
    // Abstain and No confidence are targets without an id: naming them by their
    // literal (`drep_always_abstain`) would be showing plumbing.
    const systemLabel =
      !isPool && action.target.kind === 'abstain'
        ? t('cardanoStaking.abstain')
        : !isPool && action.target.kind === 'no_confidence'
          ? t('cardanoStaking.noConfidence')
          : null
    const heading = registeredName ?? systemLabel ?? null

    return (
      <Card
        onPress={onOpenDetails}
        onLongPress={onLongPress}
        disabled={onOpenDetails === undefined && onLongPress === undefined}
        accessibilityRole="button"
        accessibilityLabel={`${isPool ? t('linkAction.stake.title') : t('linkAction.drep.title')}: ${heading ?? id}`}
        style={styles.card}
        testID={isPool ? 'link-action-stake' : 'link-action-drep'}
      >
        <Typography variant="bodyXs_regular" style={styles.centredLabel}>
          {isPool ? t('linkAction.stake.title') : t('linkAction.drep.title')}
        </Typography>
        <PoolDrepAvatar imageUrl={imageUrl} label={poolInfo?.ticker ?? heading ?? id} size={40} />
        {/* The name when the register has one, the id when it does not — the id is
            the honest fallback, never a fabricated name. */}
        {heading === null ? (
          <Address
            address={id}
            showModal={false}
            copiable={false}
            style={styles.centredAddress}
            textStyle={styles.addressText}
          />
        ) : (
          <>
            <Typography variant="headingLg" style={styles.amount} numberOfLines={2}>
              {heading}
            </Typography>
            <Address
              address={id}
              showModal={false}
              copiable={false}
              style={styles.centredAddress}
              textStyle={styles.addressText}
            />
          </>
        )}
      </Card>
    )
  }

  if (action.kind === 'address') {
    // An address in a message is one somebody wants used, and this build has no
    // address viewer. Tapping opens the payment sheet with no amount set — the card
    // says "address" rather than inventing a sum nobody asked for.
    return (
      <Card
        onPress={onOpenDetails}
        onLongPress={onLongPress}
        disabled={onOpenDetails === undefined && onLongPress === undefined}
        accessibilityRole="button"
        accessibilityLabel={`${t('linkAction.address.title')}: ${action.address}`}
        style={styles.card}
        testID="link-action-address"
      >
        <Typography variant="bodyXs_regular" style={styles.centredLabel}>
          {t('linkAction.address.title')}
        </Typography>
        <Address
          address={action.address}
          showModal={false}
          copiable={false}
          style={styles.centredAddress}
          textStyle={styles.addressText}
        />
        <Typography variant="bodySm_regular" style={styles.centredLabel}>
          {t('linkAction.address.sublabel')}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'transaction') {
    // Stays in the app: `/wallet/tx/<hash>` renders any on-chain transaction, so
    // handing this to a browser would leave the app to show something the app can
    // show better.
    return (
      <Card
        onPress={onOpenTransaction === undefined ? undefined : () => onOpenTransaction(action.hash)}
        onLongPress={onLongPress}
        disabled={onOpenTransaction === undefined && onLongPress === undefined}
        accessibilityRole="button"
        accessibilityLabel={`${t('linkAction.explorer.tx')}: ${action.hash}`}
        style={styles.card}
        testID="link-action-transaction"
      >
        <Typography variant="bodyXs_regular" style={styles.centredLabel}>
          {t('linkAction.explorer.tx')}
        </Typography>
        <Address
          address={action.hash}
          showModal={false}
          copiable={false}
          style={styles.centredAddress}
          textStyle={styles.addressText}
        />
        <Typography variant="bodySm_regular" style={styles.centredLabel}>
          {t('linkAction.explorer.txSublabel')}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'explorer') {
    // A block has no in-app viewer, so this goes to the explorer the user picked in
    // settings — never one chosen here.
    const url = explorerUrl('block', action.id)
    return (
      <Card
        onPress={onOpenUrl === undefined ? undefined : () => onOpenUrl(url)}
        onLongPress={onLongPress}
        disabled={onOpenUrl === undefined && onLongPress === undefined}
        accessibilityRole="button"
        accessibilityLabel={`${t('linkAction.explorer.block')}: ${action.id}`}
        style={styles.card}
        testID="link-action-explorer"
      >
        <Typography variant="bodyXs_regular" style={styles.centredLabel}>
          {t('linkAction.explorer.block')}
        </Typography>
        <Address
          address={action.id}
          showModal={false}
          copiable={false}
          style={styles.centredAddress}
          textStyle={styles.addressText}
        />
        <Typography variant="bodySm_regular" style={styles.centredLabel}>
          {t('linkAction.explorer.sublabel', {explorer: explorerName})}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'named-only') {
    // Named and offered nothing, deliberately. Every one of these is a flow this
    // build does not have, or one whose own entry point is the only safe way in.
    // Saying so beats a wall of URL, and beats a card that would not deliver.
    const copy = NAMED_ONLY_COPY[action.what]
    return (
      <Card {...opens(t(copy.title))} testID={`link-action-named-${action.what}`}>
        <Typography variant="bodySm_medium">{t(copy.title)}</Typography>
        {/* Said once, in the same place on every card in this group, so "we understood
            this and it does nothing" is legible before the explanation is read. */}
        <Typography variant="bodyXs_medium" style={styles.unsupported}>
          {t('linkAction.namedOnly.unsupported')}
        </Typography>
        {action.detail !== undefined && (
          <Typography variant="bodyXs_regular" style={styles.centredLabel} numberOfLines={1}>
            {action.detail}
          </Typography>
        )}
        <Typography variant="bodyXs_regular" style={styles.label}>
          {t(copy.body)}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'cosign-request') {
    const {envelope} = action
    const required = requiredFor(envelope)
    const status = statusOf(envelope, required)
    return (
      <Card
        onPress={onOpenCosign === undefined ? undefined : () => onOpenCosign(envelope)}
        onLongPress={onLongPress}
        disabled={onOpenCosign === undefined && onLongPress === undefined}
        accessibilityRole="button"
        accessibilityLabel={t('multisig.dm.cosignTitle')}
        style={styles.card}
        testID="link-action-cosign"
      >
        <Typography variant="bodyXs_regular" style={styles.centredLabel}>
          {mine ? t('multisig.dm.cosignSentTitle') : t('multisig.dm.cosignTitle')}
        </Typography>
        {/* Signatures, not an amount. What the transaction *does* is the review
            screen's job to show, and it shows it properly — a number here would be
            a second reading of the same bytes, and the one that disagrees silently
            would be the one someone signs. */}
        <Typography variant="headingLg" style={styles.amount}>
          {t('multisig.dm.cosignProgress', {signed: status.signed, required: status.required})}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.centredLabel}>
          {status.meetsQuorum ? t('multisig.dm.cosignReady') : t('multisig.dm.cosignWaiting')}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'watch-only') {
    return (
      <Card {...opens(t('linkAction.watchOnly.title'))} testID="link-action-watch-only">
        <Typography variant="bodySm_medium">{t('linkAction.watchOnly.title')}</Typography>
        {action.name !== undefined && (
          <Typography variant="bodyXs_regular" style={styles.centredLabel} numberOfLines={1}>
            {action.name}
          </Typography>
        )}
        <Typography variant="bodyXs_regular" style={styles.label} numberOfLines={1}>
          {truncateMiddle(action.address)}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'backup') {
    return (
      <Card {...opens(t('linkAction.backup.title'))} testID="link-action-backup">
        <Typography variant="bodySm_medium">{t('linkAction.backup.title')}</Typography>
        {/* The warning belongs on the card, not only behind the tap: a reader who
            never opens the sheet should still know a seed they were handed is one
            its sender kept. */}
        <Typography variant="bodyXs_regular" style={styles.label}>
          {t('linkAction.backup.warning')}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'claim') {
    return (
      <Card {...opens(t('linkAction.claim.title'))} testID="link-action-claim">
        <Typography variant="bodySm_medium">{t('linkAction.claim.title')}</Typography>
        {/* The host, not the URL: it is the party the address would be sent to, and
            it is the only part of a faucet URL a reader can judge. */}
        <Typography variant="bodyXs_regular" style={styles.centredLabel} numberOfLines={1}>
          {action.host}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.label}>
          {t('linkAction.claim.sends')}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'dapp') {
    // No Open button: the card names where it would go and the tap opens the sheet, which explains it
    // and owns the one way out. An inline button made this the one card that acted on a link someone
    // else sent, and the second tap target the module note rules out.
    return (
      <Card {...opens(t('linkAction.dapp.title'))} testID="link-action-dapp">
        <Typography variant="bodySm_medium">{t('linkAction.dapp.title')}</Typography>
        <Typography variant="bodyXs_regular" style={styles.label} numberOfLines={1}>
          {action.host}
        </Typography>
      </Card>
    )
  }

  if (action.kind === 'dm-invite') {
    return (
      <Card {...opens(t('linkAction.dmInvite.title'))} testID="link-action-dm-invite">
        <Typography variant="bodySm_medium">{t('linkAction.dmInvite.title')}</Typography>
        {/* ⚠️ Says what an invite *is*, and names nobody. The issuer is inside the token and this
            card has not verified it — the service does that when the permit is first presented. */}
        <Typography variant="bodyXs_regular" style={styles.label}>
          {t('linkAction.dmInvite.sublabel')}
        </Typography>
      </Card>
    )
  }

  // The `never` holds only while every kind above has a branch, so a new `LinkAction`
  // shape is a compile error here rather than a card describing it as a dApp and
  // showing a `host` it does not have. The runtime arm says only what it knows.
  const uncarded: never = action
  logger.warn('LinkActionCard: link action with no card', {kind: (uncarded as LinkAction).kind})
  return (
    <Card {...opens(t('linkAction.namedOnly.unsupported'))} testID="link-action-unsupported">
      <Typography variant="bodySm_medium" style={styles.unsupported}>
        {t('linkAction.namedOnly.unsupported')}
      </Typography>
    </Card>
  )
}

/**
 * Title and explanation per named-only kind. A lookup rather than a template key,
 * so every string stays statically reachable for the translation pipeline.
 */
const NAMED_ONLY_COPY = {
  connect: {title: 'linkAction.namedOnly.connectTitle', body: 'linkAction.namedOnly.connectBody'},
  legacyTransfer: {title: 'linkAction.namedOnly.legacyTitle', body: 'linkAction.namedOnly.legacyBody'},
  transferTargets: {title: 'linkAction.namedOnly.targetsTitle', body: 'linkAction.namedOnly.targetsBody'},
  exchangeResult: {title: 'linkAction.namedOnly.exchangeTitle', body: 'linkAction.namedOnly.exchangeBody'},
  otherChain: {title: 'linkAction.namedOnly.otherChainTitle', body: 'linkAction.namedOnly.otherChainBody'},
} as const

const styles = StyleSheet.create((theme) => ({
  card: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: theme.spacing.spacing2,
    padding: theme.spacing.spacing12,
  },
  label: {color: theme.colors.textAlternative},
  addressText: {color: theme.colors.textAlternative},
  centredLabel: {color: theme.colors.textAlternative, textAlign: 'center'},
  unsupported: {color: theme.colors.warningDefault, textAlign: 'center'},
  // The component's own container is a `flex: 1` row; centring it here rather than
  // stretching keeps the truncated address in the middle instead of hard left.
  centredAddress: {justifyContent: 'center'},
  amount: {textAlign: 'center'},
  actions: {flexDirection: 'row', gap: theme.spacing.spacing8, marginTop: theme.spacing.spacing4},
  action: {flex: 1},
}))
