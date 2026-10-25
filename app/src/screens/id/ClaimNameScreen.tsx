/**
 * Claiming a name: the field, what each length costs, and which of your wallets holds a permit.
 *
 * These three belong together and did not fit on the ID tab. A name's price follows from its length,
 * so the lengths table is what makes the field's one-line verdict legible; and a permit sits in one
 * wallet, so "you hold one" is only useful next to *which* wallet holds it.
 *
 * **Nothing here says where to get a permit.** Acquiring one happens outside the app (product
 * decision, 2026-08-29), and a screen that pointed at somewhere to buy would be the thing app-store
 * review looks for. So this reports what is true — what a length costs, and what you already hold —
 * and stops there.
 *
 * ⚠️ **Permits are never held by the identity wallet.** A claim funds itself from the selected *funds*
 * wallet, and `bind` records `owner = C` regardless — the identity owns the name, the funds wallet
 * merely paid. See `handle-permit-address.ts` for why it is not even that wallet's main address.
 *
 * @module
 */

import {useMemo, useState} from 'react'
import {Linking, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {Card} from '../../components/Card'
import {ChamferSurface} from '../../components/Chamfer'
import {type FaqEntry, FaqSection as SharedFaqSection} from '../../components/FaqSection'
import {Modal} from '../../components/Modal'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {ValueBox} from '../../components/ValueBox'
import {midnightPaymentAddress} from '../../config/env'
import {useHandleActions} from '../../hooks/useHandleActions'
import {usePermitBalances} from '../../hooks/usePermitBalances'
import {useTierOffers} from '../../hooks/useTierOffers'
import {useI18n, usePnyxSession} from '../../providers'
import {useWalletList} from '../../providers/WalletProvider'
import type {TierRead} from '../../services/handle-offer-rule'
import {capacitiesFor, type ScriptClass} from '../../services/handle-tier-capacity'
import {TIER_COIN, TIER_NAME_KEY, visibleTiers} from '../../services/handle-tier-display'
import {tierRanges} from '../../services/handle-tier-ranges'
import {permitColour, permitContract, truncateColour} from '../../services/handle-tier-token'
import {midnightExplorerContractUrl} from '../../services/midnight/explorer'
import {HandleClaimForm} from './HandleClaimForm'

/**
 * Whether a length is the free one, or `undefined` while that cannot be established.
 *
 * ⚠️ The **only** chain fact this screen acts on. Whether a length is currently purchasable is not
 * something the app can do anything with — nothing here sells a ticket — and rendering it made a
 * closed tier read as "you can never have this name", when in truth every length but the free one is
 * claimable by anyone holding its ticket.
 */
const isFreeTier = (read: TierRead | undefined, tier: number): boolean | undefined => {
  if (read === undefined || read.kind !== 'offers') return undefined
  return read.offers.find((entry) => entry.tier === tier)?.free ?? false
}

export function ClaimNameScreen() {
  const {t} = useI18n()
  const {handle, busy, claim} = useHandleActions()
  const read = useTierOffers()
  const {state: permits} = usePermitBalances()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {identity} = usePnyxSession()
  const [infoTier, setInfoTier] = useState<number | undefined>(undefined)
  const held = permits.kind === 'balances' ? permits.balances.totalByTier : undefined
  const ranges = useMemo(() => visibleTiers(tierRanges(), held), [held])
  // Read once for the whole screen: the rows and the sheet show the same colours, and the decode is
  // the only place the address can be rejected.
  const contract = useMemo(() => permitContract(midnightPaymentAddress()), [])

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={[]} scrollable>
      <View style={styles.content}>
        {/* An identity may hold several names; only one is shown at a time. So the field stays, and
            the name already shown is named beside it rather than replacing it. */}
        <View style={styles.section}>
          <SectionHeader title={t('you.handle.title')} />
          {/* What a name is *for*, which used to be a card on the ID tab above a button leading here.
              It belongs next to the decision rather than next to the name you already show. */}
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('you.handle.about')}
          </Typography>
          <HandleClaimForm
            busy={busy}
            onClaim={(name) => void claim(name)}
            wallets={permits.kind === 'balances' ? permits.balances.wallets : []}
            selected={
              selectedWalletGroup === null
                ? undefined
                : {groupId: String(selectedWalletGroup.groupId), accountIndex: selectedAccountIndex}
            }
          />
          {handle !== undefined && (
            <Typography variant="bodyXs_regular" style={styles.muted} testID="claim-name-current">
              {t('you.handle.screen.alreadyShown', {name: handle})}
            </Typography>
          )}
        </View>

        {/* Between the two sections, not inside either: it is not a caveat about the tickets alone —
            the name claimed above is released by the same move. */}
        <Callout variant="info" message={t('you.handle.screen.tiersReset')} testID="claim-name-reset-notice" />

        {/* A ticket is a token you hold, so each one is its own card rather than a line in a shared
            one — a list of rows reads as a price table, which is exactly what this is not. */}
        <View style={styles.section} testID="claim-name-tiers">
          <SectionHeader title={t('you.handle.screen.tiersTitle')} />
          <View style={styles.tickets}>
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {t('you.handle.screen.tiersHint')}
            </Typography>
            {ranges.map((range) => (
              <TierTicket
                key={range.tier}
                tier={range.tier}
                contract={contract}
                free={isFreeTier(read, range.tier)}
                count={Number(held?.get(range.tier) ?? 0n)}
                onInfo={() => setInfoTier(range.tier)}
              />
            ))}
            {permits.kind === 'balances' && permits.balances.incomplete && (
              <Typography variant="bodyXs_regular" style={styles.muted} testID="claim-name-permits-unsynced">
                {t('you.handle.screen.permitsUnsynced')}
              </Typography>
            )}
          </View>
        </View>

        <FaqSection />
      </View>

      <TierInfoSheet
        tier={infoTier}
        contract={contract}
        holding={
          infoTier === undefined
            ? undefined
            : {free: isFreeTier(read, infoTier), count: Number(held?.get(infoTier) ?? 0n)}
        }
        network={identity?.network ?? null}
        onClose={() => setInfoTier(undefined)}
      />
    </SafeAreaViewWrapper>
  )
}

/**
 * One ticket, drawn as the coin it is: a struck face carrying the mark, and beside it what the ticket
 * is called and how many you hold.
 *
 * The face is a chamfer of its own rather than a plain block, because the card's cut runs through the
 * bottom-left corner — the corner the face occupies. A square block there would fill back in the very
 * corner the card cut away. Both are measured, both scale their cut to their own height, and the two
 * heights are the same, so the cuts agree without either being told the other's size.
 */
function TierTicket({
  tier,
  contract,
  free,
  count,
  onInfo,
}: {
  readonly tier: number
  /** `undefined` when this build has no payment contract to derive a colour from. */
  readonly contract: Uint8Array | undefined
  /** `undefined` while the offers cannot be read — not the same fact as "not free". */
  readonly free: boolean | undefined
  readonly count: number
  /** Omitted where the ticket *is* the subject — the sheet's own header has nothing to open. */
  readonly onInfo?: (() => void) | undefined
}) {
  const {t} = useI18n()
  const coin = TIER_COIN[tier]
  const colour = useMemo(
    () => (contract === undefined ? undefined : truncateColour(permitColour(contract, tier))),
    [contract, tier],
  )

  return (
    <Card style={styles.ticket} testID={`claim-name-tier-${tier}`}>
      {/* The metal belongs to the ticket, not to the theme — see `TIER_ACCENT`. */}
      <ChamferSurface size="auto" cut="bottomLeft" fill={coin?.fill} sheen={0.22} style={styles.coin}>
        {/* No shades means no face and no mark — a coin drawn without them would be a wrong colour
            rather than a missing one. */}
        {coin !== undefined && (
          <View style={styles.mark}>
            <UniIcon name="pnyxLogo" size="md" color={coin.glint} style={styles.markGlint} />
            <UniIcon name="pnyxLogo" size="md" color={coin.stamp} />
          </View>
        )}
      </ChamferSurface>
      <View style={styles.ticketBody}>
        <View style={styles.ticketNameGroup}>
          {/* Uppercased in style, never in JS: a translated rank is not always case-foldable the way
              `toUpperCase()` assumes. */}
          <Typography variant="bodySm_medium" style={styles.ticketName}>
            {t(`you.handle.screen.tierName.${TIER_NAME_KEY[tier]}` as 'you.handle.screen.tierName.gold')}
          </Typography>
          {onInfo !== undefined && (
            <Pressable
              onPress={onInfo}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('you.handle.screen.info.openLabel')}
              testID={`claim-name-info-${tier}`}
            >
              <UniIcon name="info" size="sm" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
            </Pressable>
          )}
        </View>
        {colour !== undefined && (
          <Typography variant="bodyXs_regular" style={styles.colour} testID={`claim-name-colour-${tier}`}>
            {colour}
          </Typography>
        )}
        <Typography variant="bodySm_regular" style={free === true ? styles.free : styles.muted}>
          {free === undefined
            ? t('you.handle.screen.tierUnknown')
            : free
              ? t('you.handle.screen.tierFree')
              : t('you.handle.screen.tierCount', {count})}
        </Typography>
      </View>
    </Card>
  )
}

/**
 * The questions the screen raises and cannot answer in a row.
 *
 * ⚠️ **Provisional answers** (2026-08-30), expected to be revisited. Each is grounded in what the
 * contracts do today rather than in intent, so a wrong one means the behaviour moved: handover is
 * `rebind`, suspension and retirement are `moderate`, and recovery follows from `owner = C`.
 */
function FaqSection() {
  const {t} = useI18n()
  const entries: readonly FaqEntry[] = [
    {id: 'why', question: t('you.handle.screen.faq.whyTicketsQ'), answer: t('you.handle.screen.faq.whyTicketsA')},
    {id: 'where', question: t('you.handle.screen.faq.whereQ'), answer: t('you.handle.screen.faq.whereA')},
    {id: 'transfer', question: t('you.handle.screen.faq.transferQ'), answer: t('you.handle.screen.faq.transferA')},
    {id: 'banned', question: t('you.handle.screen.faq.bannedQ'), answer: t('you.handle.screen.faq.bannedA')},
    {id: 'lost', question: t('you.handle.screen.faq.lostQ'), answer: t('you.handle.screen.faq.lostA')},
    {id: 'howMany', question: t('you.handle.screen.faq.howManyQ'), answer: t('you.handle.screen.faq.howManyA')},
  ]
  return <SharedFaqSection title={t('you.handle.screen.faq.title')} entries={entries} testID="claim-name-faq" />
}

/**
 * What one rank actually claims: the name lengths it covers in each script, and the token it is.
 *
 * The rows cannot carry this. A tier is a range of UTF-8 bytes, so "how long a name" has three answers
 * depending on what you write in — and a single number on the row would have quietly meant "if you
 * write in Latin".
 */
function TierInfoSheet({
  tier,
  contract,
  holding,
  network,
  onClose,
}: {
  readonly tier: number | undefined
  readonly contract: Uint8Array | undefined
  /** `undefined` when no ticket is open — there are then no holdings to describe. */
  readonly holding: {readonly free: boolean | undefined; readonly count: number} | undefined
  readonly network: string | null
  readonly onClose: () => void
}) {
  const {t} = useI18n()
  const range = tier === undefined ? undefined : tierRanges().find((r) => r.tier === tier)

  const payment = midnightPaymentAddress()
  const colour = contract === undefined || tier === undefined ? undefined : permitColour(contract, tier)
  const contractUrl = payment === undefined ? null : midnightExplorerContractUrl(network, payment)

  const scriptLabel: Record<ScriptClass, string> = {
    latin: t('you.handle.screen.info.scriptLatin'),
    cyrillic: t('you.handle.screen.info.scriptCyrillic'),
    cjk: t('you.handle.screen.info.scriptCjk'),
  }

  return (
    <Modal visible={range !== undefined} onClose={onClose} position="bottom" testID="claim-name-info-modal">
      <View style={styles.sheet}>
        {range !== undefined && (
          <>
            {/* The ticket itself is the title. Its own coin and colour say which one this is more
                exactly than a name could, and it is the same object the list draws — a second
                rendering of the same thing is how the two drift apart. */}
            {holding !== undefined && (
              <TierTicket tier={range.tier} contract={contract} free={holding.free} count={holding.count} />
            )}

            <Typography variant="bodySm_medium">{t('you.handle.screen.info.lengthsTitle')}</Typography>
            {capacitiesFor(range).map((capacity) => (
              <View key={capacity.script} style={styles.row}>
                <Typography variant="bodySm_regular" style={styles.rowName}>
                  {scriptLabel[capacity.script]}
                </Typography>
                <Typography variant="bodySm_regular" style={styles.muted}>
                  {capacity.from === null || capacity.to === null
                    ? t('you.handle.screen.info.charactersNone')
                    : capacity.from === capacity.to
                      ? t('you.handle.screen.info.charactersSingle', {from: capacity.from})
                      : t('you.handle.screen.info.characters', {from: capacity.from, to: capacity.to})}
                </Typography>
              </View>
            ))}

            {colour !== undefined && (
              <>
                {/* No heading of its own: `ValueBox` already labels itself, and the two together read
                    as the same words twice. */}
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {t('you.handle.screen.info.tokenHint')}
                </Typography>
                <ValueBox
                  label={t('you.handle.screen.info.tokenTitle')}
                  value={colour}
                  copyFeedback={t('you.handle.screen.info.tokenCopied')}
                  testID="claim-name-token-id"
                />
              </>
            )}

            {/* `null` when the network has no explorer this build knows — no link rather than a guess. */}
            {contractUrl !== null && (
              <Button
                variant="secondary"
                label={t('you.handle.screen.info.viewContract')}
                onPress={() => void Linking.openURL(contractUrl)}
                fullWidth
                testID="claim-name-view-contract"
              />
            )}
          </>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  // No background of its own: the screen sits on the app surface, so a card reads as a card.
  safeArea: {flex: 1},
  content: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
  card: {
    width: '100%',
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing16,
  },
  tickets: {gap: theme.spacing.spacing8},
  // No padding: the face is flush to the card's edge, so the body carries the inset instead.
  ticket: {width: '100%', flexDirection: 'row', alignItems: 'stretch'},
  coin: {width: 60, alignItems: 'center', justifyContent: 'center'},
  mark: {alignItems: 'center', justifyContent: 'center'},
  // Offset down, not up: the sheen puts the light at the top, so the lip that catches it is the lower one.
  markGlint: {position: 'absolute', transform: [{translateY: 1}]},
  ticketBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing16,
    paddingHorizontal: theme.spacing.spacing16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing4,
  },
  // The ladder reads down the rank column, so the lengths sit beside their rank rather than drifting
  // right against the availability. A fixed rank width is what keeps the numbers in a column of their
  // own instead of ragged behind names of different lengths.
  rowLeft: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing12},
  rowName: {minWidth: 78},
  // No fixed rank column and a hair's gap: the button annotates the name, so it travels with it
  // rather than sitting in a column of its own.
  ticketNameGroup: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing6},
  ticketName: {textTransform: 'uppercase'},
  colour: {flex: 1, textAlign: 'center', color: theme.colors.textAlternative},
  muted: {color: theme.colors.textAlternative},
  free: {color: theme.colors.successDefault},
  sheet: {gap: theme.spacing.spacing12, padding: theme.spacing.spacing16},
  section: {width: '100%'},
}))
