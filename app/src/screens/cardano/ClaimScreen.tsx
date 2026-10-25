/**
 * Redeeming a CIP-99 token claim.
 *
 * A claim link is the one `web+cardano:` shape that asks the wallet to *send*
 * something: the user's receiving address and a code, POSTed to a server the link
 * names. So this screen is a consent screen before it is anything else. CIP-99
 * asks implementers for exactly that — "we are about to send your address and code
 * to <host>, are you sure" — and the two facts that make the question answerable
 * are the host and which wallet's address is being handed over.
 *
 * **Nothing here signs and nothing here reaches the chain.** The faucet distributes
 * later, from its own wallet, so the honest end state is "asked and queued" rather
 * than "received" — and the copy has to hold that line or the user watches for
 * funds that were never promised to arrive at once.
 *
 * **Every wallet may receive, watch-only included.** The wallet picker on the link
 * sheet filters by what can *spend*, because paying needs a witness; being paid
 * needs nothing but an address. Reusing that filter here would have hidden the
 * wallets a claim is most useful for.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {router, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Accordion} from '../../components/Accordion'
import {Address} from '../../components/Address'
import {Button} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {ChamferBackground} from '../../components/Chamfer'
import {DataRow} from '../../components/Row'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {Typography} from '../../components/Typography'
import {WalletIdenticon} from '../../components/WalletIdenticon'
import {formatGroupedInteger} from '../../i18n/number-format'
import {logger} from '../../logger'
import {useConfig, useFormat, useI18n, useWalletAddress, useWalletList} from '../../providers'
import {useNumberFormat} from '../../providers/NumberFormatProvider'
import {
  type ClaimOutcome,
  type ClaimToken,
  claimTokenName,
  passThroughParamsOf,
  postClaim,
} from '../../services/cardano/claim-faucet'
import {accountIdenticonSeed} from '../../utils/account-display'
import {getNetworkDisplayName} from '../../utils/network-utils'
import {hostOfUrl} from '../../utils/url-host'

const ADA_DECIMALS = 6

/** The i18n key describing an outcome, and whether it reads as good news. */
const OUTCOME_COPY = {
  accepted: {key: 'claim.outcome.accepted', tone: 'success'},
  queued: {key: 'claim.outcome.queued', tone: 'success'},
  claimed: {key: 'claim.outcome.claimed', tone: 'success'},
  invalidaddress: {key: 'claim.outcome.invalidAddress', tone: 'error'},
  missingcode: {key: 'claim.outcome.missingCode', tone: 'error'},
  invalidnetwork: {key: 'claim.outcome.invalidNetwork', tone: 'error'},
  notfound: {key: 'claim.outcome.notFound', tone: 'error'},
  alreadyclaimed: {key: 'claim.outcome.alreadyClaimed', tone: 'warning'},
  expired: {key: 'claim.outcome.expired', tone: 'warning'},
  tooearly: {key: 'claim.outcome.tooEarly', tone: 'warning'},
  ratelimited: {key: 'claim.outcome.rateLimited', tone: 'warning'},
  server: {key: 'claim.outcome.server', tone: 'error'},
  malformed: {key: 'claim.outcome.malformed', tone: 'error'},
  unreachable: {key: 'claim.outcome.unreachable', tone: 'error'},
} as const

const copyFor = (outcome: ClaimOutcome) =>
  outcome.kind === 'rejected' ? OUTCOME_COPY[outcome.reason] : OUTCOME_COPY[outcome.kind]

export function ClaimScreen() {
  const {t} = useI18n()
  const format = useFormat()
  const {locale} = useNumberFormat()
  const {network} = useConfig()
  const {walletGroups, selectedWalletGroup} = useWalletList()
  const {getReceiveAddress} = useWalletAddress()

  const {faucetUrl, code, extra} = useLocalSearchParams<{faucetUrl?: string; code?: string; extra?: string}>()

  const params = useMemo(() => passThroughParamsOf(extra), [extra])
  const host = useMemo(() => (typeof faucetUrl === 'string' ? hostOfUrl(faucetUrl) : null), [faucetUrl])

  const [pickedGroupId, setPickedGroupId] = useState<string | null>(null)
  const chosenGroupId = pickedGroupId ?? selectedWalletGroup?.groupId ?? walletGroups[0]?.groupId ?? null
  const chosen = useMemo(
    () => walletGroups.find((group) => group.groupId === chosenGroupId) ?? null,
    [walletGroups, chosenGroupId],
  )

  const [address, setAddress] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<ClaimOutcome | null>(null)

  // The address is per wallet, so changing wallet clears both it and any answer
  // already given: an outcome is about the address it was claimed for, and leaving
  // it on screen under a different wallet's name would be a lie about which one
  // the faucet accepted.
  useEffect(() => {
    if (chosenGroupId === null) return
    let live = true
    setAddress(null)
    setOutcome(null)
    getReceiveAddress({groupId: chosenGroupId, chainId: CARDANO_MAINNET})
      .then((derived) => {
        if (live) setAddress(derived)
      })
      .catch((error: unknown) => {
        logger.warn('claim: no Cardano receive address for group', {origin: 'ClaimScreen', error})
        if (live) setAddress(null)
      })
    return () => {
      live = false
    }
  }, [chosenGroupId, getReceiveAddress])

  /** Leaving without a claim. Back where there is something to go back to — a
   *  direct navigation has nothing underneath. */
  const close = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/wallets')
  }, [])

  const send = useCallback(async () => {
    if (typeof faucetUrl !== 'string' || typeof code !== 'string' || address === null) return
    setSending(true)
    const answer = await postClaim({uri: {faucetUrl, code, params}, address})
    logger.info('claim: faucet answered', {
      origin: 'ClaimScreen',
      host,
      kind: answer.kind,
      ...(answer.kind === 'rejected' ? {reason: answer.reason} : {}),
    })
    setOutcome(answer)
    setSending(false)
  }, [faucetUrl, code, params, address, host])

  // A link that names no https faucet cannot be redeemed and cannot be described.
  // The classifier already refuses these, so this is the direct-navigation guard.
  if (typeof faucetUrl !== 'string' || typeof code !== 'string' || host === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
        <Callout variant="error" message={t('claim.errors.badLink')} />
      </SafeAreaViewWrapper>
    )
  }

  const payout = outcome !== null && outcome.kind !== 'rejected' ? outcome : null
  const copy = outcome === null ? null : copyFor(outcome)
  /** Nothing has been asked yet, or the faucet was never reached — both worth a send. */
  const retryable = outcome === null || (outcome.kind === 'rejected' && outcome.reason === 'unreachable')

  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
      {/* The consent sentence CIP-99 asks for, stated before anything is sent and
          naming the host rather than the URL — the host is the part a reader can
          judge. */}
      <Callout variant="warning" message={t('claim.consent', {host})} />

      <View style={styles.field}>
        <DataRow label={t('claim.faucet')} value={host} />
        <DataRow label={t('claim.code')} value={code} />
        <DataRow label={t('claim.network')} value={getNetworkDisplayName(network, false)} />
      </View>

      <Accordion
        title={t('claim.receiveInto')}
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
        testID="claim-wallets"
      >
        <View style={styles.walletList}>
          {walletGroups.map((group) => (
            <Pressable
              key={group.groupId}
              onPress={() => setPickedGroupId(group.groupId)}
              accessibilityRole="radio"
              accessibilityState={{selected: group.groupId === chosenGroupId}}
              style={[styles.row, group.groupId === chosenGroupId && styles.rowSelected]}
              testID={`claim-wallet-${group.groupId}`}
            >
              <ChamferBackground size="auto" borderToken="borderDefaultWeak" />
              <WalletIdenticon
                seed={accountIdenticonSeed(group.primaryWallet?.checksum?.seed ?? group.groupId, 0)}
                iconStyle="blockies"
                size={32}
              />
              <Typography variant="bodyMd_medium" numberOfLines={1} style={styles.rowName}>
                {group.name}
              </Typography>
            </Pressable>
          ))}
        </View>
      </Accordion>

      {/* Shown in full, because it is the thing being handed over. */}
      {address === null ? (
        <Typography variant="bodyXs_regular" style={styles.muted}>
          {t('claim.noAddress')}
        </Typography>
      ) : (
        <Address address={address} modalTitle={t('claim.receiveInto')} />
      )}

      {copy !== null && <Callout variant={copy.tone} message={t(copy.key)} />}

      {payout !== null && (
        <View style={styles.field}>
          {payout.lovelace !== null && (
            <DataRow
              label={t('claim.payoutAda')}
              value={format(payout.lovelace, {preset: 'cryptoBalance', currency: 'ADA', decimals: ADA_DECIMALS})}
            />
          )}
          {(payout.tokens ?? []).map((token: ClaimToken) => (
            <DataRow
              key={token.unit}
              label={claimTokenName(token.unit)}
              value={formatGroupedInteger(token.quantity, locale)}
            />
          ))}
          {/* CIP-99 carries a bare quantity and never says how many places the asset
              has, and this screen has no metadata lookup to ask. So the number is
              printed as the faucet stated it and the units are named — the live
              faucet's `1000000000` is 1,000 tUSDM, and rendering that as "1B tUSDM"
              (which a crypto preset does, compacting as well) was wrong twice. */}
          {payout.tokens !== null && payout.tokens.length > 0 && (
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {t('claim.baseUnits')}
            </Typography>
          )}
          {payout.kind !== 'claimed' && payout.queuePosition !== null && (
            <DataRow label={t('claim.queuePosition')} value={String(payout.queuePosition)} />
          )}
          {payout.kind === 'claimed' && payout.txHash !== null && (
            <DataRow label={t('claim.txHash')} value={payout.txHash} />
          )}
        </View>
      )}

      <View style={styles.spacer} />

      {/* One send per answer. A faucet that said "already claimed" or "queued" will
          say it again, and a retry button next to a settled outcome invites the
          user to hammer a rate limiter. Only a failure to reach it is worth
          repeating — but a settled claim still needs a way out, or the screen is a
          dead end behind a back arrow. It is not navigated away from
          automatically: the queue position and the payout are the answer, and
          leaving on its own would take them off screen before they were read. */}
      {retryable ? (
        <Button
          label={outcome === null ? t('claim.send') : t('claim.retry')}
          onPress={() => void send()}
          isDisabled={address === null || sending}
          isLoading={sending}
          fullWidth
          testID="claim-send"
        />
      ) : (
        <Button
          // Success goes to the wallet rather than back: the tokens arrive later,
          // and that is where they will show up. A refusal goes back to whatever
          // opened the link, which is where the user was.
          label={payout !== null ? t('claim.viewWallet') : t('claim.done')}
          variant={payout !== null ? 'primary' : 'secondary'}
          onPress={() => (payout !== null ? router.replace('/wallets') : close())}
          fullWidth
          testID="claim-done"
        />
      )}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing12, flexGrow: 1},
  field: {gap: theme.spacing.spacing4},
  muted: {color: theme.colors.textMuted},
  walletList: {gap: theme.spacing.spacing8, paddingTop: theme.spacing.spacing8},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing12,
  },
  rowSelected: {borderColor: theme.colors.primaryDefault},
  rowName: {flex: 1},
  spacer: {flex: 1},
}))
