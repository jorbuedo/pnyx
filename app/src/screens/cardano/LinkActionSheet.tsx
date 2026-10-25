/**
 * What a link action actually is, and the questions that have to be answered
 * before any flow makes sense.
 *
 * A bottom sheet rather than a screen, opened by tapping the card in a message.
 * The card is a summary — who, and what — and this is the substance: the link
 * string itself, the target in full, which wallet acts, whether the network has
 * to change.
 *
 * **One sheet, two subjects.** A payment request and a delegation ask different
 * things of the user but ask them in the same shape, and the awkward half is
 * identical: *which wallet*. The selected one is a leftover from whatever the
 * user was doing before, quite possibly a wallet that cannot do this at all, so
 * it is asked rather than assumed. A second sheet would be a second answer to
 * that one question.
 *
 * Where they differ:
 *
 * - **Network.** A Cardano address states its own family in its bech32 prefix, so
 *   a mainnet request opened on preprod is knowable here and the switch is
 *   offered. A pool or DRep id carries no network marker at all, so there is
 *   nothing to check and nothing is claimed.
 * - **Who may act.** Anything that can produce a witness can pay, including a
 *   shared wallet — it signs its share and the co-sign rail collects the rest.
 *   The delegation list is narrower, and only because **this app's** staking
 *   screen refuses a wallet that does not sign alone. The chain has no such rule:
 *   a shared wallet can delegate. Until that screen goes through the co-sign rail
 *   the way send does, listing one here would be an offer that stops at a toast —
 *   so it is excluded and the copy says "not yet", never "cannot".
 *
 * Neither answer is applied silently. Switching networks changes which wallet's
 * funds are on screen and picking a wallet decides whose money or whose stake
 * moves, so the sheet states both and the user confirms. Nothing here signs; the
 * flow it hands off to still runs its own review and ceremony.
 *
 * One component, two entry points — the card in a thread or a channel opens it
 * inline, and a scanned QR or deep link opens it through `/wallet/link-action`,
 * which has no card to tap.
 *
 * @module
 */

import {Either} from 'effect'
import {router} from 'expo-router'
import {useCallback, useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Accordion} from '../../components/Accordion'
import {ButtonIcon} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {ChamferBackground} from '../../components/Chamfer'
import {Copiable} from '../../components/Copiable'
import {LinkActionCard} from '../../components/LinkActionCard'
import {Modal} from '../../components/Modal'
import {PoolDrepAvatar} from '../../components/PoolDrepAvatar'
import {DataRow} from '../../components/Row'
import {Typography} from '../../components/Typography'
import {ValueBox} from '../../components/ValueBox'
import {WalletIdenticon} from '../../components/WalletIdenticon'
import {getExplorerName, useExplorerPreference} from '../../hooks/useExplorerPreference'
import {logger} from '../../logger'
import {useConfig, useFormat, useI18n, useWalletList} from '../../providers'
import {useCopy} from '../../providers/CopyProvider'
import {networkFitFor} from '../../services/cardano/address-network'
import {canSpendForLink, spendCapability} from '../../services/cardano/link-action-wallets'
import {buildCoSignerLink} from '../../services/cardano/multisig/cosigner-invite'
import {packDefinition} from '../../services/cardano/multisig/definition-link'
import {cexplorerLogoUrl, type DRepTarget, useDRepInfo, usePoolInfo} from '../../services/cardano-pool-drep'
import type {LinkAction} from '../../services/link-action'
import {accountIdenticonSeed} from '../../utils/account-display'
import {truncateMiddle} from '../../utils/truncate'
import {registerSendPrefill, type SendPrefill} from './send/send-prefill-handoff'
import {registerStakePrefill, type StakePrefill} from './stake/stake-prefill-handoff'

const ADA_DECIMALS = 6

/**
 * What the sheet is about. The two shapes carry only what their own body needs —
 * a payment has no pool and a delegation has no amount, and modelling that as one
 * flat bag of optional fields would let a caller build a request that means
 * nothing.
 */
export type LinkActionSubject =
  | {
      readonly kind: 'payment'
      readonly prefill: SendPrefill
      /** The requester's note (CIP-157 `n=`), shown as theirs. */
      readonly note?: string | undefined
      /** The requester's reference (CIP-157 `i=`), shown so it can be quoted back. */
      readonly paymentId?: string | undefined
      /**
       * The request also asked for native tokens, which this app cannot send from
       * a link. One line, no fingerprints: CIP-14 ids are unreadable and — being
       * one-way hashes of (policy, name) — unusable here anyway. What the payer
       * needs is the fact, so they do not think the ADA settled it.
       */
      readonly asksForAssets?: boolean | undefined
    }
  | {
      readonly kind: 'delegation'
      readonly prefill: StakePrefill
      /** Set for a pool delegation; the sheet resolves its name and logo. */
      readonly poolId?: string | undefined
      /** Set for a vote delegation, as received — `null` for the system targets. */
      readonly drepId?: string | null | undefined
      /** The canonical target, so the sheet can name Abstain / No confidence itself. */
      readonly drepTarget?: DRepTarget | undefined
    }
  /**
   * Everything else a link can be — a dApp, something to look at, or a kind this
   * build can name and not carry out.
   *
   * It has no fields of its own because it needs none: the card already renders
   * every one of these, and the sheet's job for them is to put that card behind a
   * confirmation rather than to describe them a second way. Two descriptions of
   * one link is two things to keep in step.
   */
  | {readonly kind: 'other'; readonly action: LinkAction}

export type LinkActionSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  /** What is being considered, or `null` when the handoff has expired. */
  readonly subject: LinkActionSubject | null
  /** The original link text, so the sheet can show exactly what was received. */
  readonly rawLink?: string | undefined
  /**
   * True when the message carrying this link is one we sent.
   *
   * A property of the surface, not of the link — a scanned code has no sender — so
   * it is a prop rather than a field on the subject. It exists because the two
   * multisig shapes are answered *by the other party*: the card already hides the
   * button on our own, and without this the sheet would show one the card refused.
   */
  readonly mine?: boolean | undefined
}

export const LinkActionSheet = ({visible, onClose, subject, rawLink, mine = false}: LinkActionSheetProps) => {
  const {t} = useI18n()
  const format = useFormat()
  const {copy} = useCopy()
  const {walletGroups, selectedWalletGroup, selectWallet} = useWalletList()
  const {network, setNetwork} = useConfig()
  const [busy, setBusy] = useState(false)
  /**
   * Only what the user actually tapped. The default is *derived* below rather than
   * seeded here: this sheet is mounted with the screen and merely toggles `visible`,
   * so a `useState` initialiser runs while the wallet list is still empty — it would
   * capture "nothing selected" once, before any wallet exists, and never reconsider.
   */
  const [pickedGroupId, setPickedGroupId] = useState<string | null>(null)

  const delegating = subject?.kind === 'delegation'
  /** No wallet and no network are involved in opening a link or a page. */
  const other = subject?.kind === 'other' ? subject.action : null
  const {getExplorerUrl, explorerId} = useExplorerPreference()

  // Resolved unconditionally — both hooks treat `undefined` as "no lookup", which
  // keeps them above the branch where hooks have to live.
  const {info: poolInfo} = usePoolInfo(subject?.kind === 'delegation' ? subject.poolId : undefined)
  const {info: drepInfo} = useDRepInfo(subject?.kind === 'delegation' ? (subject.drepId ?? undefined) : undefined)

  /**
   * Who may act, which is narrower for staking — but only because this app's
   * staking screen refuses anything that does not sign alone, not because the
   * chain does. A shared wallet can delegate; the screen just has no co-sign path
   * yet, so listing one here would be an offer that ends at a toast.
   */
  const usable = useCallback(
    (source: Parameters<typeof canSpendForLink>[0]) =>
      delegating ? spendCapability(source) === 'signs-alone' : canSpendForLink(source),
    [delegating],
  )

  const eligible = useMemo(() => walletGroups.filter((g) => usable(g.primaryWallet?.source)), [walletGroups, usable])

  /**
   * The wallet the user was already using, when it could actually do this. Not an
   * assumption about which wallet *should* act — the list is still shown and still
   * asked — just the sensible starting point, so the common case is one tap.
   *
   * Checked against `eligible` rather than trusting the source alone, so the default
   * can only ever be a row that is on screen to be unselected.
   */
  const defaultGroupId = useMemo(
    () => eligible.find((g) => g.groupId === selectedWalletGroup?.groupId)?.groupId ?? null,
    [eligible, selectedWalletGroup],
  )

  const chosenGroupId = pickedGroupId ?? defaultGroupId

  /**
   * The chosen wallet first. The list lives inside a collapsed accordion, so the
   * one row that shows when it is shut has to be the one that would be used —
   * otherwise the summary names a wallet the button will not spend from.
   */
  const ordered = useMemo(
    () => [...eligible].sort((a, b) => Number(b.groupId === chosenGroupId) - Number(a.groupId === chosenGroupId)),
    [eligible, chosenGroupId],
  )
  const chosen = ordered.find((g) => g.groupId === chosenGroupId) ?? null

  /**
   * The wallets left out, named so their absence is not a mystery. Deduped: two
   * groups can share a name (a shared wallet exists per network) and the same
   * sentence twice reads as a rendering bug.
   */
  const excluded = useMemo(
    () => [...new Set(walletGroups.filter((g) => !usable(g.primaryWallet?.source)).map((g) => g.name))].join(', '),
    [walletGroups, usable],
  )

  const fit = useMemo(
    () =>
      subject?.kind === 'payment'
        ? networkFitFor(subject.prefill.addressBech32, network)
        : // A pool or DRep id says nothing about a network, so there is nothing to
          // check. Claiming otherwise would be inventing a fact.
          {kind: 'unknown' as const},
    [subject, network],
  )

  const proceed = useCallback(async () => {
    // `other` never reaches here: it has no wallet to pick and its own action
    // opens a page directly.
    if (subject === null || subject.kind === 'other' || chosenGroupId === null) return
    setBusy(true)
    try {
      // Order matters: the network first, because the rail the flow resolves is
      // per (wallet, network) and switching after selection would rebuild it.
      if (fit.kind === 'switch') await setNetwork(fit.switchTo)
      if (chosenGroupId !== selectedWalletGroup?.groupId) await selectWallet(chosenGroupId)
      onClose()
      if (subject.kind === 'payment') {
        router.push({pathname: '/wallet/send', params: {prefill: registerSendPrefill(subject.prefill)}})
      } else if (subject.kind === 'delegation') {
        router.push({pathname: '/wallet/stake', params: {prefill: registerStakePrefill(subject.prefill)}})
      }
    } catch (error) {
      logger.error('link action handoff failed', {origin: 'LinkActionSheet', error})
    } finally {
      setBusy(false)
    }
  }, [subject, chosenGroupId, fit, selectedWalletGroup, selectWallet, setNetwork, onClose])

  const amount =
    subject?.kind !== 'payment' || subject.prefill.lovelace == null
      ? null
      : format(subject.prefill.lovelace, {preset: 'cryptoTxDetail', currency: 'ADA', decimals: ADA_DECIMALS})

  const title = delegating
    ? subject.poolId !== undefined
      ? t('linkAction.stake.title')
      : t('linkAction.drep.title')
    : other !== null
      ? t('linkAction.landing.externalTitle')
      : t('linkAction.landing.title')

  /**
   * What the "other" kinds offer, if anything. A dApp and a page have somewhere to
   * go; a named-only link has nothing, and gets no button rather than a dead one.
   *
   * **A co-signer key has a destination; an invite does not**, and the asymmetry is
   * the point. A key is bound into a spending policy on a screen that needs no
   * conversation, so it goes there. Answering an invite means sending *your* key to
   * whoever asked, and a link arriving from outside does not say who they are — so
   * it is named and left alone rather than given a button that would have to guess
   * a recipient. Answering one still happens in the thread it arrived in.
   */
  /**
   * Why this link offers nothing, when it offers nothing and the reason is not
   * already on the card.
   *
   * A `named-only` card states its own reason in its body, so a second line here
   * would be the same sentence twice. The two multisig shapes do not: their bodies
   * describe the *request*, and on our own message the button simply vanishes —
   * which is the case that reads as broken and the reason this sheet is now
   * reachable from every card at all.
   */
  const nothingToDo =
    other === null || !mine
      ? null
      : other.kind === 'multisig-invite'
        ? t('multisig.dm.inviteOwn')
        : other.kind === 'cosigner-key'
          ? t('multisig.dm.keyOwn')
          : null

  const otherAction = ((): {label: string; go: () => void} | null => {
    if (other === null) return null
    // Our own message is never ours to answer. The card already withholds the
    // button; the sheet must not put it back, or the two disagree about the same
    // link and the sheet is the one that acts.
    if (mine && (other.kind === 'multisig-invite' || other.kind === 'cosigner-key')) return null
    switch (other.kind) {
      case 'cosigner-key':
        return {
          label: t('multisig.dm.useKey'),
          // Rebuilt from the payload rather than passed through as `rawLink`: the
          // scanned entry point has no raw string to hand over, and the screen reads
          // the link form. `buildCoSignerLink` is the same encoder that produced it,
          // so this is a round trip, not a second spelling.
          go: () => {
            const link = buildCoSignerLink(other.accountXpubHex)
            if (Either.isLeft(link)) {
              logger.error('co-signer key landed but could not be re-encoded', {
                origin: 'LinkActionSheet',
                reason: link.left.kind,
              })
              return
            }
            router.push(`/wallet/create-multisig?cosignerKey=${encodeURIComponent(link.right)}` as never)
          },
        }
      case 'dapp':
        return {
          label: t('linkAction.dapp.action'),
          go: () => router.push({pathname: '/browser', params: {url: other.url}}),
        }
      case 'transaction':
        return {
          label: t('linkAction.explorer.txSublabel'),
          // Route type isn't inferred for the tx group; narrow cast per CLAUDE.md.
          go: () => router.push(`/wallet/tx/${other.hash}` as never),
        }
      case 'explorer':
        return {
          label: t('linkAction.explorer.sublabel', {explorer: getExplorerName(explorerId)}),
          go: () => router.push({pathname: '/browser', params: {url: getExplorerUrl('block', other.id)}}),
        }
      case 'watch-only':
        return {
          label: t('linkAction.watchOnly.action'),
          go: () =>
            router.push({
              pathname: '/onboarding/watch-only',
              params: {address: other.address, ...(other.name === undefined ? {} : {name: other.name})},
            }),
        }
      case 'backup':
        return {
          label: t('linkAction.backup.action'),
          go: () => router.push({pathname: '/onboarding/restore-from-backup', params: {link: other.link}}),
        }
      case 'dm-invite':
        return {
          label: t('linkAction.dmInvite.action'),
          // The accept screen is where the permit is stored and the conversation offered — a link
          // must not silently grant itself, and this sheet's job is to ask, not to act.
          go: () => router.push({pathname: '/dm/accept-invite', params: {permit: other.permit}}),
        }
      case 'shared-wallet':
        return {
          label: t('multisig.dm.useWallet'),
          // The payload rather than the raw link, for the same reason a co-signer
          // key is re-encoded: the scanned entry point has no raw string to hand
          // on, and the destination reads the packed form. It reviews the roster
          // and the policy and asks before adding anything.
          go: () =>
            router.push({
              pathname: '/wallet/shared-wallet',
              params: {def: packDefinition(other.definition)},
            }),
        }
      case 'claim':
        return {
          label: t('linkAction.claim.action'),
          // The claim screen asks which wallet should receive and confirms the
          // hand-off before anything is sent, so this button opens a question
          // rather than starting a request. `params` is JSON because route params
          // are strings and CIP-99's pass-through set has no fixed shape.
          go: () =>
            router.push({
              pathname: '/wallet/claim',
              params: {faucetUrl: other.faucetUrl, code: other.code, extra: JSON.stringify(other.params)},
            }),
        }
      // Everything left is named and not acted on: a flow this build does not have,
      // or one whose own entry point is the only safe way in. Listed rather than
      // defaulted, so a new kind cannot arrive here and silently do nothing.
      case 'payment-request':
      case 'stake-delegation':
      case 'drep-delegation':
      case 'address':
      case 'multisig-invite':
      case 'cosign-request':
      case 'named-only':
        return null
    }
  })()

  /**
   * The link itself, as one control rather than a box of text.
   *
   * A card is a reading of a link and this sheet is where the reading can be
   * checked against the original — but the original is a long opaque string that
   * nobody reads, and printing it pushed everything that matters below the fold.
   * Copying is the only thing anyone actually does with it, so that is all it
   * offers.
   */
  const copyLink =
    rawLink === undefined ? undefined : (
      <ButtonIcon
        icon="link"
        variant="naked"
        size="md"
        onPress={() => void copy({text: rawLink, feedback: t('linkAction.landing.linkCopied')})}
        containerProps={{accessibilityLabel: t('linkAction.landing.copyLink')}}
        testID="link-action-copy-link"
      />
    )

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      showDragIndicator
      // The target, a possible network warning and the wallet list can outrun a
      // phone screen, so the content area scrolls. The button is an `action`
      // rather than content: `ModalActions` renders outside the ScrollView, so it
      // stays put while the rest moves and can never be scrolled out of reach.
      scrollable
      title={title}
      headerRight={copyLink}
      actions={
        subject === null
          ? undefined
          : other !== null
            ? otherAction === null
              ? undefined
              : [
                  {
                    label: otherAction.label,
                    onPress: () => {
                      onClose()
                      otherAction.go()
                    },
                    variant: 'primary' as const,
                    testID: 'link-action-continue',
                  },
                ]
            : [
                {
                  label:
                    fit.kind === 'switch'
                      ? t('linkAction.landing.switchAndContinue')
                      : t('linkAction.landing.continue'),
                  onPress: () => void proceed(),
                  variant: 'primary' as const,
                  disabled: chosenGroupId === null || busy,
                  loading: busy,
                  testID: 'link-action-continue',
                },
              ]
      }
      actionsLayout="vertical"
      testID="link-action-sheet"
    >
      {subject === null ? (
        // The handoff is in-memory and single-consumer, so this is a reload or a
        // stale link rather than a malformed one. Said as such.
        <Callout variant="warning" message={t('linkAction.landing.expired')} />
      ) : (
        <View style={styles.body}>
          {subject.kind === 'payment' ? (
            <PaymentBody subject={subject} amount={amount} />
          ) : subject.kind === 'delegation' ? (
            <DelegationBody subject={subject} poolInfo={poolInfo} drepInfo={drepInfo} />
          ) : (
            /* The card, verbatim and inert. It already renders every one of these
               kinds; describing them a second way here would be two descriptions of
               one link to keep in step. No handlers — the sheet's own action is the
               only way out, which is the whole reason this screen exists. */
            <LinkActionCard action={subject.action} mine={mine} />
          )}

          {nothingToDo !== null && <Callout variant="info" message={nothingToDo} testID="link-action-nothing-to-do" />}

          {other === null && fit.kind === 'switch' && (
            <Callout
              variant="warning"
              message={t('linkAction.landing.networkSwitch', {from: fit.from, to: fit.switchTo})}
            />
          )}

          {other !== null ? null : eligible.length === 0 ? (
            <>
              <Typography variant="bodySm_medium">
                {delegating ? t('linkAction.landing.delegateFrom') : t('linkAction.landing.payFrom')}
              </Typography>
              <Callout
                variant="warning"
                message={delegating ? t('linkAction.landing.noDelegationWallet') : t('linkAction.landing.noWallet')}
              />
            </>
          ) : (
            /* Shut by default, showing only the wallet that would be used. A wallet
               list is as long as the user's wallet list, and printing all of it made
               a sheet that scrolls past everything else to reach a choice most people
               will not change. Expanding is their decision. */
            <Accordion
              title={delegating ? t('linkAction.landing.delegateFrom') : t('linkAction.landing.payFrom')}
              description={chosen?.name}
              spacing="compact"
              leftContent={
                chosen === null ? undefined : (
                  <WalletIdenticon
                    seed={accountIdenticonSeed(chosen.primaryWallet?.checksum?.seed ?? chosen.groupId, 0)}
                    iconStyle="blockies"
                    size={32}
                  />
                )
              }
              testID="link-action-wallets"
            >
              <View style={styles.walletList}>
                {ordered.map((group) => (
                  <Pressable
                    key={group.groupId}
                    onPress={() => setPickedGroupId(group.groupId)}
                    accessibilityRole="radio"
                    accessibilityState={{selected: group.groupId === chosenGroupId}}
                    style={[styles.row, group.groupId === chosenGroupId && styles.rowSelected]}
                    testID={`link-action-wallet-${group.groupId}`}
                  >
                    <ChamferBackground size="auto" borderToken="borderDefaultWeak" />
                    <WalletIdenticon
                      seed={accountIdenticonSeed(group.primaryWallet?.checksum?.seed ?? group.groupId, 0)}
                      iconStyle="blockies"
                      size={32}
                    />
                    <View style={styles.rowName}>
                      <Typography variant="bodyMd_medium" numberOfLines={1}>
                        {group.name}
                      </Typography>
                      {/* A shared wallet can pay, but confirming starts a gather rather
                          than finishing a payment. Said on the row, because it changes
                          what the user is agreeing to. (It never reaches here when
                          delegating — that list is signs-alone only.) */}
                      {spendCapability(group.primaryWallet?.source) === 'needs-co-signers' && (
                        <Typography variant="bodyXs_regular" style={styles.muted}>
                          {t('linkAction.landing.needsCoSigners')}
                        </Typography>
                      )}
                    </View>
                  </Pressable>
                ))}
              </View>
            </Accordion>
          )}

          {/* Named rather than hidden: a wallet missing from the list above is a
              question the user would otherwise be left with. */}
          {other === null && excluded !== '' && (
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {delegating
                ? t('linkAction.landing.excludedForDelegation', {names: excluded})
                : t('linkAction.landing.excludedWatchOnly', {names: excluded})}
            </Typography>
          )}
        </View>
      )}
    </Modal>
  )
}

const PaymentBody = ({
  subject,
  amount,
}: {
  subject: Extract<LinkActionSubject, {kind: 'payment'}>
  amount: string | null
}) => {
  const {t} = useI18n()
  return (
    <>
      <View style={styles.headBlock}>
        <Typography variant="bodySm_regular" style={styles.headLabel}>
          {amount === null ? t('linkAction.landing.amountOpen') : t('linkAction.landing.amountLabel')}
        </Typography>
        {amount !== null && (
          <Typography variant="headingMd" style={styles.headValue}>
            {amount}
          </Typography>
        )}
      </View>

      {/* Label above rather than beside: `title` renders a two-column row that
          leaves the address half the width, and an address truncated harder than
          it needs to be is one the user cannot check.
          Copiable here — this is the surface that shows the request in full, and
          the card that opened it deliberately has no copy of its own. */}
      <View style={styles.field}>
        <Typography variant="bodyXs_regular" style={styles.muted}>
          {t('linkAction.payment.to')}
        </Typography>
        {/* `ValueBox`, not `Address`. This is the surface for *checking* an
            address against another source, and `ValueBox` renders it verbatim
            over as many lines as it needs. `Address` truncates to a fixed
            character count, which on a wide sheet left dead space before the copy
            icon — and raising the count only added a second ellipsis where the
            text then clipped. Wrapping in `Copiable` keeps the tap-to-copy. */}
        <Copiable text={subject.prefill.addressBech32} feedback={t('address.details.copied')}>
          <ValueBox value={subject.prefill.addressBech32} />
        </Copiable>
      </View>

      {subject.note !== undefined && subject.note !== '' && (
        <View style={styles.field}>
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('linkAction.landing.noteLabel')}
          </Typography>
          {/* The requester's words, quoted — it is text from someone else and must
              not read as the wallet speaking. */}
          <Typography variant="bodySm_regular">{t('linkAction.payment.note', {note: subject.note})}</Typography>
        </View>
      )}

      {subject.paymentId !== undefined && subject.paymentId !== '' && (
        <View style={styles.field}>
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('linkAction.landing.referenceLabel')}
          </Typography>
          <Typography variant="bodySm_regular">{subject.paymentId}</Typography>
        </View>
      )}

      {subject.asksForAssets === true && (
        <Callout variant="warning" message={t('linkAction.landing.alsoAsksForTokens')} />
      )}
    </>
  )
}

const DelegationBody = ({
  subject,
  poolInfo,
  drepInfo,
}: {
  subject: Extract<LinkActionSubject, {kind: 'delegation'}>
  poolInfo: ReturnType<typeof usePoolInfo>['info']
  drepInfo: ReturnType<typeof useDRepInfo>['info']
}) => {
  const {t} = useI18n()
  const format = useFormat()
  const id = subject.poolId ?? subject.drepId ?? null
  // The registered name when the register carries one, the id when it does not.
  // Never a name supplied by the link — that is the sender's string next to
  // someone else's id, which is a place to put a lie.
  const name = subject.poolId !== undefined ? (poolInfo?.name ?? null) : (drepInfo?.givenName ?? null)
  // Abstain and No confidence are targets with no id; naming them by their literal
  // (`drep_always_abstain`) would be showing plumbing.
  const systemLabel =
    subject.drepTarget?.kind === 'abstain'
      ? t('cardanoStaking.abstain')
      : subject.drepTarget?.kind === 'no_confidence'
        ? t('cardanoStaking.noConfidence')
        : null
  // Truncated when it falls back to the id — the full string is in the copiable
  // field directly below, so a heading that wraps over two lines only shouts.
  const heading = name ?? systemLabel ?? (id === null ? null : truncateMiddle(id, 14, 6))
  // Derived from the id when the register carries no logo: the CDN serves a generic
  // placeholder for an unknown id, and an initials disc reading "PO" off a bech32
  // prefix says less than nothing.
  const imageUrl =
    (subject.poolId !== undefined ? poolInfo?.logoUrl : drepInfo?.imageUrl) ??
    (id !== null && (id.startsWith('pool1') || id.startsWith('drep1')) ? cexplorerLogoUrl(id) : null)

  return (
    <>
      <View style={styles.headBlock}>
        <PoolDrepAvatar imageUrl={imageUrl} label={poolInfo?.ticker ?? heading ?? 'ADA'} size={56} />
        {heading !== null && (
          <Typography variant="headingMd" style={styles.headValue} numberOfLines={2}>
            {heading}
          </Typography>
        )}
        {poolInfo?.ticker !== undefined && (
          <Typography variant="bodySm_regular" style={styles.headLabel}>
            {poolInfo.ticker}
          </Typography>
        )}
      </View>

      {/* The id in full, so it can be checked against another source — the same
          reason the payment body shows the address verbatim. Absent for Abstain
          and No confidence, which have no id to check. */}
      {id !== null && (
        <View style={styles.field}>
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {subject.poolId !== undefined ? t('linkAction.stake.poolLabel') : t('linkAction.drep.drepLabel')}
          </Typography>
          <Copiable text={id} feedback={t('address.details.copied')}>
            <ValueBox value={id} />
          </Copiable>
        </View>
      )}

      {/* What the target actually is, where the register knows — the numbers that
          decide whether this is a pool worth delegating to. */}
      {poolInfo !== null && (
        <View style={styles.field}>
          {poolInfo.roa !== undefined && (
            <DataRow
              label={t('cardanoStaking.metrics.roa')}
              value={t('cardanoStaking.roaValue', {roa: poolInfo.roa.toFixed(2)})}
            />
          )}
          {poolInfo.saturation !== undefined && (
            <DataRow
              label={t('cardanoStaking.metrics.saturation')}
              value={`${(poolInfo.saturation * 100).toFixed(0)}%`}
            />
          )}
          {poolInfo.delegators !== undefined && (
            <DataRow label={t('cardanoStaking.metrics.delegators')} value={String(poolInfo.delegators)} />
          )}
        </View>
      )}

      {drepInfo?.votingPower !== undefined && (
        <View style={styles.field}>
          <DataRow
            label={t('linkAction.drep.votingPower')}
            value={format(drepInfo.votingPower, {preset: 'cryptoBalance', currency: 'ADA', decimals: ADA_DECIMALS})}
          />
        </View>
      )}

      <Typography variant="bodyXs_regular" style={styles.muted}>
        {t('linkAction.landing.delegationNote')}
      </Typography>
    </>
  )
}

const styles = StyleSheet.create((theme) => ({
  body: {gap: theme.spacing.spacing12},
  headBlock: {gap: theme.spacing.spacing2, alignItems: 'center'},
  headLabel: {color: theme.colors.textMuted, textAlign: 'center'},
  headValue: {textAlign: 'center'},
  field: {gap: theme.spacing.spacing4},
  walletList: {gap: theme.spacing.spacing8, paddingTop: theme.spacing.spacing8},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    padding: theme.spacing.spacing12,
  },
  rowSelected: {borderColor: theme.colors.primaryDefault},
  rowName: {flex: 1},
  muted: {color: theme.colors.textMuted},
}))
