/**
 * DUST generation for the selected wallet.
 *
 * The screen's job is to answer "is my NIGHT working for me, and where is the DUST going" —
 * and, when nothing is generating, to say *which* of the several very different reasons
 * applies. A wallet that only shows "0 DUST" cannot distinguish not-registered from
 * registered-twice-so-the-network-ignores-you from your-NIGHT-predates-the-registration
 * from the-indexer-is-behind, and those need opposite responses.
 *
 * The destination is shown, not policed. Designating an address you do not control is how
 * DUST is delegated or sponsored, so an unrecognised destination is reported as someone
 * else's, never as a mistake.
 *
 * @module
 */

import {Effect, Either} from 'effect'
import {router} from 'expo-router'
import {useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Address} from '../../../components/Address'
import {Button} from '../../../components/Buttons/Button'
import {Card} from '../../../components/Card'
import {DataRow} from '../../../components/Row'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {SensitiveTypography} from '../../../components/SensitiveTypography'
import {StickyFooter} from '../../../components/StickyFooter'
import {Tag} from '../../../components/Tag'
import {TokenIcon} from '../../../components/TokenIcon'
import {Typography} from '../../../components/Typography'
import {useMidnightDust} from '../../../hooks/useMidnightDust'
import {useMidnightUnshieldedAddress} from '../../../hooks/useMidnightUnshieldedAddress'
import {logger} from '../../../logger'
import {useConfig, useCopy, useFormat, useI18n, useWalletList} from '../../../providers'
import {NIGHT_ASSET_ID} from '../../../services/cardano/night-redeem'
import {midnightFailureReason} from '../../../services/midnight/effect-boundary'
import {midnightFaucetFor, midnightFundsNetwork} from '../../../services/midnight/networks'
import {refreshDust} from '../../../services/midnight/refresh-dust'
import {registerDust} from '../../../services/midnight/register-dust'
import {
  type DestinationChoice,
  DUST_DECIMALS,
  describeDestination,
  dustAddressFromPayload,
} from '../../../services/midnight-dust'
import {DustDestinationPicker} from './DustDestinationPicker'
import {destinationLabel, statusPill} from './dust-presentation'
import {useDustActions} from './use-dust-actions'
import {useDustDestinations} from './use-dust-destinations'
import {useDustRegistration} from './use-dust-registration'
import {useRegistrableNight} from './use-registrable-night'

const ORIGIN = 'DustRegistrationScreen'

const NIGHT_DECIMALS = 6

/**
 * "3 minutes ago" for a sync stamp, or an em dash when there is none.
 *
 * Deliberately coarse: the exact second a sync finished is noise, and what a reader needs is whether
 * it was just now or a while back.
 */
const relativeWhen = (unixSecs: number | null): string => {
  if (unixSecs === null) return '—'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * ⚠️ **There is only one kind of DUST.** An earlier version of this screen implied two — DUST "for a
 * Midnight address" versus DUST "this wallet can spend" — which is wrong and was confusing. Whichever
 * route generated it, DUST that lands on this wallet's dust address is this wallet's to spend. What
 * genuinely differs is *where the backing NIGHT is held*, and therefore which route a given network
 * supports: mainnet has the Cardano cNIGHT path today, preprod has the Midnight-native one.
 *
 * So this renders two different things: the **route** sections say what is available, and the
 * **holdings** section says what this wallet actually has, route-agnostic — read from the local
 * `DustLocalState`, because the spendable amount at an instant is the generation model run over it.
 *
 * Its own component because both branches of the screen render it; a copy per branch is how they drift.
 */
const DustHoldings = ({
  dust,
  format,
  t,
  styles,
  refresh,
}: {
  readonly dust: ReturnType<typeof useMidnightDust>
  readonly format: ReturnType<typeof useFormat>
  readonly t: ReturnType<typeof useI18n>['t']
  readonly styles: ReturnType<typeof Object.assign>
  /** `null` where there is nothing to refresh — no wallet, or no Midnight network. */
  readonly refresh: {readonly run: () => void; readonly busy: boolean; readonly note: string | null} | null
}) => (
  <>
    <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
      {t('midnightDust.heldTitle')}
    </Typography>

    <Card style={styles.card}>
      <Typography variant="bodySm_regular" style={styles.body}>
        {t('midnightDust.heldIntro')}
      </Typography>
      {dust.loading ? (
        <Typography variant="bodySm_regular" style={styles.body}>
          {'…'}
        </Typography>
      ) : dust.balance === null ? (
        // Never synced is not "holds none": one is a thing to do, the other a fact about the wallet.
        <Typography variant="bodySm_regular" style={styles.body}>
          {t('midnightDust.midnightNeverSynced')}
        </Typography>
      ) : (
        <>
          <DataRow
            label={t('midnightDust.midnightBalance')}
            value={format(dust.balance, {preset: 'cryptoBalance', currency: 'DUST', decimals: DUST_DECIMALS})}
          />
          <Typography variant="bodyXs_regular" style={styles.body}>
            {t('midnightDust.midnightOutputs', {count: dust.utxos})}
          </Typography>
          <Typography variant="bodyXs_regular" style={styles.body}>
            {/* The watermark, not the age. A state synced ten hours ago is still right if nothing has
                moved since — the balance is recomputed against the clock on every read — so nagging
                about age alone would train people to ignore the one line that matters. */}
            {dust.staleness === 'activity'
              ? t('midnightDust.midnightStale', {when: relativeWhen(dust.syncedAt)})
              : t('midnightDust.midnightSyncedAt', {when: relativeWhen(dust.syncedAt)})}
          </Typography>
        </>
      )}
      {/* Reporting staleness without offering a way to act on it is what left this rail stuck: a DUST
          state went stale fifteen minutes after somebody opened a developer screen, which switched
          self-funded sends off with no way back. It needs the vault, so it is a button rather than a
          timer. */}
      {refresh === null ? null : (
        <>
          <View style={styles.actionRow}>
            <Button
              label={refresh.busy ? t('midnightDust.refreshing') : t('midnightDust.refresh')}
              size="sm"
              variant="secondary"
              isLoading={refresh.busy}
              isDisabled={refresh.busy}
              onPress={refresh.run}
              testID="dust-refresh"
            />
          </View>
          {refresh.note === null ? null : (
            <Typography variant="bodyXs_regular" style={styles.body}>
              {refresh.note}
            </Typography>
          )}
        </>
      )}
    </Card>
  </>
)

/**
 * The Midnight-native route, and on preprod a way to get NIGHT for it.
 *
 * The faucet wants this wallet's Midnight address, so the button copies it before navigating — a step
 * that is otherwise a trip back to Receive and easy to get wrong by pasting the DUST address, which
 * cannot be paid.
 *
 * Renders nothing when neither action applies. A network supports one of the two routes, so the other
 * one's section is not "empty", it is *not this network's* — and a heading over a card that only says
 * so is the screen describing its own plumbing rather than what the user can do here.
 */
const MidnightRouteSection = ({
  t,
  styles,
  faucet,
  register,
}: {
  readonly t: ReturnType<typeof useI18n>['t']
  readonly styles: ReturnType<typeof Object.assign>
  /** `'pending'` while the address resolves — offered but disabled, never withdrawn. */
  readonly faucet: (() => void) | 'pending' | null
  readonly register: {readonly run: () => void; readonly busy: boolean; readonly note: string | null} | null
}) =>
  register === null && faucet === null ? null : (
    <>
      <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
        {t('midnightDust.midnightSectionTitle')}
      </Typography>
      <Card style={styles.card}>
        {register === null ? null : (
          <>
            <Typography variant="bodyXs_regular" style={styles.body}>
              {t('midnightDust.midnightRegisterBody')}
            </Typography>
            <View style={styles.actionRow}>
              <Button
                label={register.busy ? t('midnightDust.midnightRegistering') : t('midnightDust.midnightRegister')}
                size="sm"
                isLoading={register.busy}
                isDisabled={register.busy}
                onPress={register.run}
                testID="dust-register-midnight"
              />
            </View>
            {register.note === null ? null : (
              <Typography variant="bodyXs_regular" style={styles.body}>
                {register.note}
              </Typography>
            )}
          </>
        )}
        {faucet === null ? null : (
          <>
            <Typography variant="bodyXs_regular" style={styles.body}>
              {t('midnightDust.faucetBody')}
            </Typography>
            <View style={styles.actionRow}>
              <Button
                label={t('midnightDust.faucetOpen')}
                size="sm"
                isDisabled={faucet === 'pending'}
                {...(faucet === 'pending' ? {} : {onPress: faucet})}
                testID="dust-faucet"
              />
            </View>
          </>
        )}
      </Card>
    </>
  )

export const DustRegistrationScreen = () => {
  const {t} = useI18n()
  const format = useFormat()
  const ownDust = useMidnightDust()
  const {copy} = useCopy()
  const midnightAddress = useMidnightUnshieldedAddress()
  const {network} = useConfig()
  const fundsNetwork = midnightFundsNetwork(network)

  const faucetUrl = midnightFaucetFor(fundsNetwork)

  /**
   * Copy the Midnight address and open this network's faucet in the in-app browser.
   *
   * `null` where the network has no faucet — mainnet, and anything unmapped: offering a button that
   * leads nowhere is worse than not offering one. Also `null` with no address, because a faucet paste
   * of nothing is a wasted trip and the address is what it needs.
   */
  const openFaucet = useMemo(() => {
    // With a faucet but the address still resolving there is one, and it is about to work — so the
    // control is *disabled*, not absent. It used to vanish and reappear, which reads as the app losing
    // a feature rather than fetching something.
    if (faucetUrl === null) return null
    if (midnightAddress === undefined) return 'pending' as const
    return () => {
      copy({text: midnightAddress, feedback: t('midnightDust.faucetCopied')})
      router.push({pathname: '/browser', params: {url: faucetUrl}})
    }
  }, [faucetUrl, midnightAddress, copy, t])
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()

  const hasRegistrableNight = useRegistrableNight(selectedWalletGroup?.groupId, selectedAccountIndex, midnightAddress)
  const [registerBusy, setRegisterBusy] = useState(false)
  const [registerNote, setRegisterNote] = useState<string | null>(null)

  /**
   * Build a Midnight-native registration.
   *
   * `null` off preprod, because that is the only network where this route is live — and a button that
   * builds a transaction no chain will take is worse than no button.
   *
   * Builds **and** submits. The transaction is sealed and self-funding, so it goes straight to the
   * node rather than through the sponsor, and the note reports only what the chain accepted.
   */
  const midnightRegister = useMemo(() => {
    const groupId = selectedWalletGroup?.groupId
    if (fundsNetwork !== 'preprod' || groupId === undefined) return null
    // `undefined` means we could not tell, and that offers the button — see `use-registrable-night.ts`.
    if (hasRegistrableNight === false) return null
    return {
      busy: registerBusy,
      note: registerNote,
      run: () => {
        setRegisterBusy(true)
        setRegisterNote(null)
        void registerDust({
          groupId,
          accountIndex: selectedAccountIndex,
          networkId: fundsNetwork,
          register: true,
          biometricPrompt: t('common.biometricPrompt'),
        })
          .then((submitted) => {
            setRegisterNote(
              t('midnightDust.midnightRegisterSubmitted', {
                amount: format(submitted.allowFeePayment, {
                  preset: 'cryptoBalance',
                  currency: 'DUST',
                  decimals: DUST_DECIMALS,
                }),
              }),
            )
          })
          .catch((error: unknown) => {
            // Never silent: a registration that failed and said nothing is indistinguishable from one
            // nobody pressed.
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('the midnight dust registration did not go through', {origin: ORIGIN, error: message})
            setRegisterNote(message.slice(0, 160))
          })
          .finally(() => setRegisterBusy(false))
      },
    }
  }, [
    fundsNetwork,
    selectedWalletGroup,
    selectedAccountIndex,
    hasRegistrableNight,
    registerBusy,
    registerNote,
    t,
    format,
  ])

  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)

  /** Re-sync DUST on request. `null` off a Midnight funds network, where there is nothing to read. */
  const dustRefresh = useMemo(() => {
    const groupId = selectedWalletGroup?.groupId
    if (fundsNetwork === null || groupId === undefined) return null
    return {
      busy: refreshBusy,
      note: refreshNote,
      run: () => {
        setRefreshBusy(true)
        setRefreshNote(null)
        void Effect.runPromise(
          Effect.either(
            refreshDust({
              groupId,
              accountIndex: selectedAccountIndex,
              networkId: fundsNetwork,
              biometricPrompt: t('common.biometricPrompt'),
            }),
          ),
        )
          .then((outcome) => {
            if (Either.isLeft(outcome)) {
              // `_tag` names which layer refused — a cancelled fingerprint, a broken indexer and a
              // wallet that has already spent DUST used to arrive here as one indistinguishable string.
              logger.warn('the dust refresh failed', {
                origin: ORIGIN,
                failure: outcome.left._tag,
                error: midnightFailureReason(outcome.left),
              })
              setRefreshNote(midnightFailureReason(outcome.left).slice(0, 160))
              return
            }
            // The store announces the write, so `useMidnightDust` re-reads and the figure above moves
            // without this having to set it — the note only reports that the read happened.
            setRefreshNote(t('midnightDust.refreshed', {count: outcome.right.utxos}))
          })
          .finally(() => setRefreshBusy(false))
      },
    }
  }, [fundsNetwork, selectedWalletGroup, selectedAccountIndex, refreshBusy, refreshNote, t])

  const [picking, setPicking] = useState(false)
  /**
   * What a *future* registration would point at. Distinct from what is registered: before
   * registering there is nothing on chain to read, and after registering this is what a
   * change would move it to.
   */
  const [chosen, setChosen] = useState<DestinationChoice | null>(null)

  // Midnight addresses are seed-derived, so a hardware or read-only wallet has none — which
  // costs it the "This wallet" destination, and nothing else. Registration health is Cardano
  // data throughout (a stake key hash, UTxOs, history), so gating the whole screen on a
  // Midnight key told a read-only wallet registered twice and generating zero DUST that DUST
  // was "not available" — the exact silent failure this module exists to prevent. Signing is
  // gated where signing happens: the review ceremony reports watch-only itself.

  const {choices} = useDustDestinations()

  // Default the proposal to this wallet's own address — the common case — without
  // overriding a choice the user has already made.
  useEffect(() => {
    if (chosen !== null) return
    const own = choices.find((c) => c.owner.kind === 'self')
    if (own !== undefined) setChosen(own)
  }, [choices, chosen])

  const {assessment, registrations, night, generation, loading, unavailable, unavailableReasonKey, rail} =
    useDustRegistration()
  const actions = useDustActions(rail, selectedWalletGroup?.groupId ?? null, registrations)

  if (unavailable) {
    // ⚠️ **This gate is the Cardano path's, and only the Cardano path's.** cNIGHT registration exists
    // on Cardano mainnet and nowhere else, so that half genuinely has nothing to show. But NIGHT held
    // on *Midnight* generates DUST on whatever Midnight network the wallet is on — preprod included,
    // which is exactly where it is being used — so returning an empty state here hid the section that
    // works. The two paths share a screen and must not share this gate.
    return (
      <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
        <Typography variant="bodySm_regular" style={styles.intro}>
          {t('midnightDust.intro')}
        </Typography>

        {/* `wrongNetwork` is not a fault, it is "the other chain's route" — and naming it here put a
            Cardano heading above a card that only said "not here" on every preprod screen. An
            `unavailable` rail *is* a fault and still says so, because a wallet that cannot use the
            route it should be able to must not look identical to one on the wrong network. */}
        {unavailableReasonKey === 'wrongNetwork' ? null : (
          <>
            <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
              {t('midnightDust.cardanoSectionTitle')}
            </Typography>
            <Card style={styles.card}>
              <Typography variant="bodySm_regular" style={styles.body}>
                {t(`midnightDust.${unavailableReasonKey}` as never)}
              </Typography>
            </Card>
          </>
        )}

        <MidnightRouteSection t={t} styles={styles} faucet={openFaucet} register={midnightRegister} />

        <DustHoldings dust={ownDust} format={format} t={t} styles={styles} refresh={dustRefresh} />
      </SafeAreaViewWrapper>
    )
  }

  const current = registrations[0]
  const pill = assessment === null ? null : statusPill(assessment.state)
  const repairRemove = assessment?.action.kind === 'repairMultiRegistration' ? assessment.action.remove : []
  /**
   * Spending a registration needs the value it holds, read from the registering transaction's
   * own bytes. A provider that cannot serve CBOR leaves it absent, and offering a button that
   * can only fail to build is worse than not offering it.
   */
  const canSpendRegistrations = registrations.every((r) => r.valueHex !== undefined)
  const nightTotal = night.reduce((sum, u) => sum + u.value, 0n)

  // Registered: report what the chain says. Not registered: there is nothing to report, so
  // show the destination a registration *would* use. Saying "could not be read" when
  // nothing has been registered claims a failure that did not happen.
  const registered = current !== undefined
  const owner = registered ? describeDestination(current.dustAddr, choices) : (chosen?.owner ?? {kind: 'unknown'})
  const ownerLabel = destinationLabel(owner)
  // An unrecognised destination is still a known destination: the datum names it exactly, so
  // render the payload back to its `mn_dust` address rather than leaving the user with only
  // "another address" and no way to check it against what they intended.
  const addressOfPayload = (payload: string | undefined): string | null =>
    payload === undefined
      ? null
      : (choices.find((c) => c.payload === payload)?.address ?? dustAddressFromPayload(payload))
  const shownAddress = registered ? addressOfPayload(current.dustAddr) : (chosen?.address ?? null)
  const eligibleNight = generation?.eligibleNightStars ?? null
  // The *generation*’s current capacity, not a spendable balance — see `spendableDustAt`.
  const generatedCapacity = generation?.currentCapacitySpecks ?? null
  const dustCapacity = generation?.maxCapacitySpecks ?? null

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        assessment !== null && !registered ? (
          <StickyFooter>
            <Button
              label={t('midnightDust.actions.register')}
              isLoading={actions.busy}
              isDisabled={actions.busy || chosen === null}
              onPress={() => chosen !== null && actions.run({kind: 'register', dustPayload: chosen.payload}, night)}
              fullWidth
              testID="dust-register"
            />
          </StickyFooter>
        ) : undefined
      }
    >
      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('midnightDust.intro')}
      </Typography>

      <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
        {t('midnightDust.cardanoSectionTitle')}
      </Typography>

      <Card style={styles.card}>
        <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
          {t('midnightDust.nightTitle')}
        </Typography>
        {night.length === 0 ? (
          <Typography variant="bodySm_regular" style={styles.body}>
            {t('midnightDust.noNight')}
          </Typography>
        ) : (
          <View style={styles.assetRow}>
            <TokenIcon assetId={NIGHT_ASSET_ID} label="NIGHT" size={32} />
            <View style={styles.assetText}>
              <SensitiveTypography variant="bodyMd_medium">
                {format(nightTotal, {preset: 'cryptoBalance', currency: 'NIGHT', decimals: NIGHT_DECIMALS})}
              </SensitiveTypography>
              {/* Only the indexer knows which part of a holding is post-registration, and a
                  wallet whose NIGHT is mostly ineligible has no other way to find out. Shown
                  only when it differs — repeating the same figure twice says nothing. */}
              {eligibleNight !== null && eligibleNight !== nightTotal ? (
                <SensitiveTypography variant="bodyXs_regular" style={styles.body}>
                  {t('midnightDust.eligibleNight', {
                    amount: format(eligibleNight, {
                      preset: 'cryptoBalance',
                      currency: 'NIGHT',
                      decimals: NIGHT_DECIMALS,
                    }),
                  })}
                </SensitiveTypography>
              ) : null}
            </View>
          </View>
        )}
      </Card>

      {generatedCapacity === null ? null : (
        <Card style={styles.card}>
          <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
            {t('midnightDust.dustTitle')}
          </Typography>
          <SensitiveTypography variant="bodyMd_medium">
            {format(generatedCapacity, {preset: 'cryptoBalance', currency: 'DUST', decimals: DUST_DECIMALS})}
          </SensitiveTypography>
          {/* This figure is a function of *this* stake credential's eligible NIGHT alone
              (capacity = eligible NIGHT × 5 DUST). It is this wallet's contribution, not the
              destination's balance — a destination can be fed by many stake credentials, and
              on mainnet one is fed by 22. Calling it "your DUST" when the destination is
              someone else's would claim funds the user does not have. */}
          {owner.kind === 'self' ? null : (
            <Typography variant="bodyXs_regular" style={styles.body}>
              {t('midnightDust.dustNotHeld')}
            </Typography>
          )}
          {/* The headroom, not the ceiling: at capacity the ceiling is the number already
              above it, and repeating it reads as though something is still pending. */}
          {dustCapacity === null || generatedCapacity >= dustCapacity ? null : (
            <Typography variant="bodyXs_regular" style={styles.body}>
              {t('midnightDust.dustCapacity', {
                amount: format(dustCapacity, {preset: 'cryptoBalance', currency: 'DUST', decimals: DUST_DECIMALS}),
              })}
            </Typography>
          )}
        </Card>
      )}

      <MidnightRouteSection t={t} styles={styles} faucet={openFaucet} register={midnightRegister} />

      <Card style={styles.card}>
        <View style={styles.statusHeader}>
          <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
            {t('midnightDust.statusTitle')}
          </Typography>
          {pill !== null ? (
            <Tag label={t(`midnightDust.pill.${pill.labelKey}` as never)} variant={pill.variant} />
          ) : null}
        </View>
        <Typography variant="bodySm_regular" style={styles.body}>
          {loading || assessment === null ? '…' : t(`midnightDust.status.${assessment.surfaceKey}` as never)}
        </Typography>
        {assessment?.action.kind === 'activateExistingCnight' ? (
          <View style={styles.actionRow}>
            <Button
              label={t('midnightDust.actions.activate')}
              size="sm"
              isLoading={actions.busy}
              isDisabled={actions.busy}
              onPress={() => actions.activate(night)}
              testID="dust-activate"
            />
          </View>
        ) : null}
        {assessment?.action.kind === 'repairMultiRegistration' ? (
          <View style={styles.actionRow}>
            <Button
              label={t('midnightDust.actions.repair', {count: assessment.action.remove.length})}
              size="sm"
              isLoading={actions.busy}
              isDisabled={actions.busy || !canSpendRegistrations}
              onPress={() => actions.repair(repairRemove)}
              testID="dust-repair"
            />
          </View>
        ) : null}
      </Card>

      <Card style={styles.card}>
        <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
          {t(registered ? 'midnightDust.destinationTitle' : 'midnightDust.destinationPendingTitle')}
        </Typography>
        <Typography variant="bodyMd_medium">
          {t(
            `midnightDust.owner.${ownerLabel.key}` as never,
            ownerLabel.name === undefined ? {} : {name: ownerLabel.name},
          )}
        </Typography>
        {shownAddress !== null ? <Address address={shownAddress} /> : null}
        <View style={styles.actionRow}>
          <Button
            label={t('midnightDust.actions.changeDestination')}
            variant="secondary"
            size="sm"
            isDisabled={actions.busy || (registered && !canSpendRegistrations)}
            onPress={() => setPicking(true)}
            testID="dust-choose-destination"
          />
          {registered ? (
            <Button
              label={t('midnightDust.actions.deregister')}
              variant="secondary"
              size="sm"
              isDisabled={actions.busy || !canSpendRegistrations}
              onPress={() => actions.run({kind: 'deregister', current: current.ref}, night)}
              testID="dust-deregister"
            />
          ) : null}
        </View>
      </Card>

      {registrations.length > 1 ? (
        <Card style={styles.card}>
          <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
            {t('midnightDust.registrationsTitle')}
          </Typography>
          {registrations.map((reg) => (
            <View key={`${reg.ref.txHash}:${reg.ref.index}`} style={styles.registrationRow}>
              <Typography variant="bodySm_regular" style={styles.body}>
                {t('midnightDust.registrationRow', {slot: reg.txSlot})}
              </Typography>
              {/* Which destination each one names is the whole reason a user cares which
                  survives a repair — two registrations can point at different addresses. */}
              {addressOfPayload(reg.dustAddr) === null ? (
                <Typography variant="bodyXs_regular" style={styles.body}>
                  {t('midnightDust.owner.unknown')}
                </Typography>
              ) : (
                <Address address={addressOfPayload(reg.dustAddr) as string} />
              )}
            </View>
          ))}
        </Card>
      ) : null}

      {/* Last, and deliberately after the route's own cards. A route explains where DUST comes from —
          NIGHT held, what it generates, whether that is working, where it goes — and splitting that
          run with a wallet-level total left `STATUS` and `DUST GOES TO` reading as though they
          belonged to the spendable figure rather than to the registration above them. */}
      <DustHoldings dust={ownDust} format={format} t={t} styles={styles} refresh={dustRefresh} />

      <DustDestinationPicker
        visible={picking}
        choices={choices}
        {...(chosen !== null ? {selectedPayload: chosen.payload} : {})}
        onSelect={(choice) => {
          setChosen(choice)
          setPicking(false)
          // Already registered: picking is the change itself, so build it straight away
          // rather than leaving a chosen-but-unapplied destination on screen claiming to
          // be where DUST goes.
          if (registered)
            actions.run({kind: 'changeDestination', current: current.ref, dustPayload: choice.payload}, night)
        }}
        onDismiss={() => setPicking(false)}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
  card: {padding: spacing.spacing16, gap: spacing.spacing8},
  statusHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.spacing8},
  sectionLabel: {color: colors.textAlternative, textTransform: 'uppercase'},
  intro: {color: colors.textAlternative, paddingHorizontal: spacing.spacing4},
  body: {color: colors.textAlternative},
  assetRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing12},
  assetText: {flex: 1, gap: spacing.spacing2},
  actionRow: {flexDirection: 'row', gap: spacing.spacing8, paddingTop: spacing.spacing4},
  registrationRow: {gap: spacing.spacing2, paddingVertical: spacing.spacing4},
}))
