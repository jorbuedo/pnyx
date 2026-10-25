/**
 * Asking a gated community for an invite: what it requires, and which wallet you prove it with.
 *
 * ⚠️ **The requirements are shown before the choice, because the choice depends on them.** This was
 * a bare "Request an invite" button that signed with a key the person never picked — so a refusal
 * read as "your wallet does not qualify" when the truth was "we asked about a wallet you have never
 * funded". Now the rules come down first and the person picks which of their wallets to prove.
 *
 * ⚠️ **Any one requirement is enough** (`accountSatisfiesAny`), so the list is a list of ways in and
 * the copy says so. Reading it as a checklist would send someone off to satisfy all three.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useCircleInvitePolicy} from '../../hooks/useCircleInvitePolicy'
import type {TranslationKey} from '../../i18n/types'
import {logger} from '../../logger'
import {useI18n, usePnyxSession, useWalletData, useWalletList} from '../../providers'
import {registerInviteCeremony} from '../../services/circle-invite-ceremony'
import {
  type InviteWalletChoice,
  type InviteWalletSource,
  inviteEligibleWallets,
} from '../../services/circle-invite-eligibility'
import type {InviteRequestFailure} from '../../services/circle-invite-failure'
import {inviteRefusalLines} from '../../services/circle-invite-reasons'
import {beginCircleInviteRequest, completeCircleInviteRequest} from '../../services/circle-invite-request'
import {inviteRewardAddress, inviteSigningRequest} from '../../services/circle-invite-review'
import {accountIdenticonSeed} from '../../utils/account-display'
import {Accordion} from '../Accordion'
import {Button} from '../Buttons'
import {Typography} from '../Typography'
import {WalletIdenticon} from '../WalletIdenticon'
import {WalletRow} from '../WalletRow'
import {CircleRequirements} from './CircleRequirements'

const ORIGIN = 'CircleInviteRequestSection'

/** A Cardano wallet is any whose chain id is on the Cardano namespace, whatever its network. */
const isCardano = (chainId: string): boolean => chainId.startsWith('cardano:')

export type CircleInviteRequestSectionProps = {
  readonly circleId: string
  /** Called with the code once one is granted, so the sheet can fill its invite field. */
  readonly onGranted: (invite: string) => void
}

export function CircleInviteRequestSection({circleId, onGranted}: CircleInviteRequestSectionProps) {
  const {t} = useI18n()
  const router = useRouter()
  const {session} = usePnyxSession()
  const {walletGroups} = useWalletList()
  const {listAddressesForWallet} = useWalletData()
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  // `undefined` until the header is tapped: until then the picker follows the selection (open while
  // nothing is chosen), and after it the person's own choice wins in both directions.
  const [pickerOpen, setPickerOpen] = useState<boolean | undefined>(undefined)
  const [requesting, setRequesting] = useState(false)
  const [failure, setFailure] = useState<InviteRequestFailure | undefined>(undefined)

  const token = session?.token

  const {rules} = useCircleInvitePolicy(circleId)

  const {eligible, hiddenNoKey, hiddenNoCardano} = useMemo(
    () =>
      inviteEligibleWallets(
        walletGroups.map((group) => {
          const cardano = group.wallets.find((w) => isCardano(w.chainId))
          return {
            groupId: group.groupId,
            name: group.name,
            source: (cardano?.source ?? group.primaryWallet.source) as InviteWalletSource,
            hasCardano: cardano !== undefined,
            accountIndex: cardano?.selectedAccountIndex ?? 0,
            checksumSeed: group.primaryWallet?.checksum?.seed,
          }
        }),
      ),
    [walletGroups],
  )

  // One wallet is not a choice — pre-select it so the common case is a single tap.
  useEffect(() => {
    if (chosen === undefined && eligible.length === 1) setChosen(eligible[0]?.groupId)
  }, [chosen, eligible])

  const fail = useCallback(
    (failure: InviteRequestFailure, reason: string) => {
      logger.warn('requesting an invite failed', {origin: ORIGIN, circleId, reason})
      setFailure(failure)
      setRequesting(false)
    },
    [circleId],
  )

  /**
   * Fetch the challenge, then hand it to the review screen.
   *
   * The signature asserts a funds wallet's stake credential, so it is consented to on
   * `TxReviewScreen` like every other funds signature — this never holds key material. `requesting`
   * stays true across that navigation: the sheet is still mid-request until the ceremony settles,
   * and the person returns to a button that says so.
   */
  const request = async (wallet: InviteWalletChoice) => {
    if (token === undefined) return
    setRequesting(true)
    setFailure(undefined)

    const begun = await beginCircleInviteRequest({token, circleId})
    if (!begun.ok) {
      fail(begun.failure, 'no challenge')
      return
    }

    try {
      const rows = await listAddressesForWallet(wallet.groupId, CARDANO_MAINNET, {
        accountIndex: wallet.accountIndex,
        branch: 'external',
      })
      // The stake credential is the same behind every address of the account, so the first is as
      // good as any — but *none* means the wallet has not derived yet, which is a real absence and
      // not something to substitute an address for.
      const addressBech32 = rows[0]?.human
      if (addressBech32 === undefined) {
        fail({kind: 'failed', message: 'no derived address'}, 'the chosen wallet has derived no Cardano address')
        return
      }
      const reward = await inviteRewardAddress(addressBech32)
      const ticketId = await registerInviteCeremony({
        groupId: wallet.groupId,
        accountIndex: wallet.accountIndex,
        addressBech32,
        rewardHex: reward.rewardHex,
        request: inviteSigningRequest({
          groupId: wallet.groupId,
          accountIndex: wallet.accountIndex,
          rewardHex: reward.rewardHex,
          payload: begun.challenge.payload,
        }),
        biometricPrompt: t('common.biometricPrompt'),
        onSigned: (signature) => {
          void (async () => {
            const result = await completeCircleInviteRequest({
              token,
              circleId,
              challenge: begun.challenge,
              reward,
              signature,
            })
            setRequesting(false)
            if (result.ok) {
              onGranted(result.invite)
              return
            }
            setFailure(result.failure)
          })()
        },
        onError: (error) => fail({kind: 'failed', message: String(error)}, `the ceremony failed: ${String(error)}`),
        // Not a failure: the person looked at what they were asserting and chose not to. Saying
        // nothing and re-enabling the button is the whole response.
        onCancel: () => setRequesting(false),
      })
      if (ticketId === null) {
        fail({kind: 'unavailable'}, 'no Cardano rail is configured')
        return
      }
      router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
    } catch (e) {
      fail({kind: 'failed', message: String(e)}, `could not prepare the request: ${String(e)}`)
    }
  }

  // Nothing to ask for: this community hands out no invites automatically. Said plainly rather than
  // by hiding the section, so somebody who was told to "request one" is not left looking for it.
  if (rules === null || (rules !== undefined && rules.length === 0)) {
    return (
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('forum.join.requestFailed.noPolicy')}
      </Typography>
    )
  }
  if (rules === undefined) {
    return (
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('forum.join.requirementsLoading')}
      </Typography>
    )
  }

  const selected = eligible.find((wallet) => wallet.groupId === chosen)

  return (
    <View style={styles.section}>
      <CircleRequirements rules={rules} />

      {eligible.length === 0 ? (
        <>
          <Typography variant="bodySm_medium">{t('forum.join.chooseWallet')}</Typography>
          <Typography variant="bodySm_regular" style={styles.warning}>
            {t('forum.join.noEligibleWallet')}
          </Typography>
        </>
      ) : (
        /* Shut once a wallet is picked, showing only that wallet — the same collapsed shape the
           link-action sheet uses for the identical question. Printing every wallet inline pushed
           the requirements above it and the Join button below it off a phone screen. */
        <Accordion
          title={t('forum.join.chooseWallet')}
          description={selected?.name ?? t('forum.join.noWalletChosen')}
          spacing="compact"
          isExpanded={pickerOpen ?? selected === undefined}
          onExpandedChange={setPickerOpen}
          leftContent={
            selected === undefined ? undefined : (
              <WalletIdenticon
                seed={accountIdenticonSeed(selected.checksumSeed ?? selected.groupId, 0)}
                iconStyle="blockies"
                size={32}
              />
            )
          }
          testID="invite-wallet-picker"
        >
          <View style={styles.walletList}>
            {eligible.map((wallet) => (
              <WalletRow
                key={wallet.groupId}
                groupId={wallet.groupId}
                name={wallet.name}
                checksumSeed={wallet.checksumSeed}
                selected={chosen === wallet.groupId}
                onPress={() => {
                  setChosen(wallet.groupId)
                  setPickerOpen(false)
                }}
                testID={`invite-wallet-${wallet.groupId}`}
              />
            ))}
            {/* Counted, never silently dropped: a shorter list of "your wallets" with no explanation
                leaves a reader hunting for the one that is missing. Inside the list they explain,
                so the collapsed summary stays one line. */}
            {hiddenNoKey > 0 && (
              <Typography variant="bodySm_regular" style={styles.hint}>
                {t('forum.join.walletsHiddenNoKey', {count: hiddenNoKey})}
              </Typography>
            )}
            {hiddenNoCardano > 0 && (
              <Typography variant="bodySm_regular" style={styles.hint}>
                {t('forum.join.walletsHiddenNoCardano', {count: hiddenNoCardano})}
              </Typography>
            )}
          </View>
        </Accordion>
      )}

      <Button
        label={t('forum.join.requestInvite')}
        variant="secondary"
        onPress={() => selected !== undefined && void request(selected)}
        isDisabled={requesting || token === undefined || selected === undefined}
        isLoading={requesting}
        fullWidth
        testID="join-community-request-invite"
      />

      {failure !== undefined && (
        <Typography variant="bodySm_regular" style={styles.error} testID="join-community-request-failure">
          {t(failureKey(failure))}
        </Typography>
      )}
      {/* One line per rule, in the community's own rule order — see `inviteRefusalLines`. Under the
          heading above rather than replacing it: the first sentence says the request failed, these
          say what to go and do about it. */}
      {failure?.kind === 'not-eligible' &&
        inviteRefusalLines(failure.reasons).map((line) => (
          <Typography
            variant="bodySm_regular"
            style={styles.error}
            key={line.kind === 'known' ? line.key : `unknown-${line.code}`}
            testID="join-community-request-reason"
          >
            {line.kind === 'known' ? t(line.key) : t('forum.join.requestFailed.reasonUnknown', {code: line.code})}
          </Typography>
        ))}
    </View>
  )
}

const failureKey = (failure: InviteRequestFailure): TranslationKey =>
  failure.kind === 'not-eligible'
    ? 'forum.join.requestFailed.notEligible'
    : failure.kind === 'none-left'
      ? 'forum.join.requestFailed.noneLeft'
      : failure.kind === 'unavailable'
        ? 'forum.join.requestFailed.unavailable'
        : failure.kind === 'no-policy'
          ? 'forum.join.requestFailed.noPolicy'
          : 'forum.join.requestFailed.failed'

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing.spacing8,
  },
  walletList: {
    gap: theme.spacing.spacing8,
    paddingTop: theme.spacing.spacing8,
  },
  hint: {
    color: theme.colors.textMuted,
  },
  warning: {
    color: theme.colors.warningDefault,
  },
  error: {
    color: theme.colors.errorDefault,
  },
}))
