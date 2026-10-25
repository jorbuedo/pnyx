/**
 * The shared-wallet hub: the two things you can start here, and the answers to
 * what a shared wallet actually is.
 *
 * **Not a list.** It listed the shared wallets on the network, which was a second
 * copy of the wallet list — they are wallet groups, so they already appear there,
 * with their balance and their own screens. A wallet's composition lives on its
 * Manage wallet screen, next to everything else about that wallet.
 *
 * **Not a place to find your own key**, either: that is per wallet, and every
 * wallet that has one offers it on its own Manage wallet screen. Offering it here
 * meant answering for whichever wallet happened to be active.
 *
 * What is left is what only belongs here: starting a wallet, looking for one on
 * chain, and explaining a feature almost nobody has met before. The explanation
 * is the screen rather than a paragraph above a form, because every question it
 * answers was one a user had to ask someone.
 *
 * @module
 */

import {useRouter} from 'expo-router'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {Callout} from '../../../components/Callout'
import {Card} from '../../../components/Card'
import {Copiable} from '../../../components/Copiable'
import {type FaqEntry, FaqSection} from '../../../components/FaqSection'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {Typography} from '../../../components/Typography'
import {ValueBox} from '../../../components/ValueBox'
import {useSharedWallets} from '../../../hooks/useSharedWallets'
import type {TranslationKey} from '../../../i18n/types'
import {useI18n, useWalletList} from '../../../providers'
import type {DiscoveredWallet} from '../../../services/cardano/multisig/registration-discovery'
import {useRegistrationDiscovery} from './use-registration-discovery'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing16},
  actions: {gap: spacing.spacing8},
  discovery: {padding: spacing.spacing16, gap: spacing.spacing8},
  discoveryResults: {gap: spacing.spacing8},
  discoveryRow: {padding: spacing.spacing12, gap: spacing.spacing4},
  discoveryHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8},
  discoveryName: {flex: 1},
  answer: {color: colors.textMuted, paddingBottom: spacing.spacing12},
  muted: {color: colors.textMuted},
}))

/**
 * One search result.
 *
 * A result this device already has is shown as such rather than hidden: seeing
 * the wallet you are looking at listed as "found" with no explanation is worse
 * than one extra line, and it is the common case.
 */
function DiscoveryRow({wallet, alreadyAdded}: {wallet: DiscoveredWallet; alreadyAdded: boolean}) {
  const {t} = useI18n()
  // Names as the *publisher* wrote them — a stranger's strings until a
  // participant confirms them, which is why nothing here treats them as verified.
  const names = Object.values(wallet.participants)
    .map((p) => p.name)
    .filter((n): n is string => n !== undefined && n !== '')

  return (
    <Card variant="outlined" style={styles.discoveryRow} testID={`discovery-${wallet.txHash}`}>
      <View style={styles.discoveryHead}>
        <Typography variant="bodyMd_medium" style={styles.discoveryName} numberOfLines={1}>
          {wallet.name ?? t('multisig.discovery.unnamed')}
        </Typography>
        {alreadyAdded && (
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('multisig.discovery.alreadyAdded')}
          </Typography>
        )}
      </View>

      {names.length > 0 && (
        <Typography variant="bodyXs_regular" style={styles.muted}>
          {names.join(', ')}
        </Typography>
      )}

      {!alreadyAdded && (
        <>
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('multisig.discovery.notHere')}
          </Typography>
          <Copiable text={wallet.txHash} feedback={t('multisig.discovery.hashCopied')}>
            <ValueBox label={t('multisig.discovery.hashLabel')} value={wallet.txHash} />
          </Copiable>
        </>
      )}
    </Card>
  )
}

/**
 * The questions, in the order someone meets them: what it is, then what being in
 * one costs them, then how to run one, then how it survives a lost phone.
 *
 * Keys rather than markup per question, so adding one is a translation entry.
 */
const FAQ: readonly {readonly id: string; readonly q: TranslationKey; readonly a: TranslationKey}[] = [
  {id: 'what', q: 'multisig.faq.whatQ', a: 'multisig.faq.whatA'},
  {id: 'phrase', q: 'multisig.faq.phraseQ', a: 'multisig.faq.phraseA'},
  {id: 'who', q: 'multisig.faq.whoQ', a: 'multisig.faq.whoA'},
  {id: 'key', q: 'multisig.faq.keyQ', a: 'multisig.faq.keyA'},
  {id: 'create', q: 'multisig.faq.createQ', a: 'multisig.faq.createA'},
  {id: 'spend', q: 'multisig.faq.spendQ', a: 'multisig.faq.spendA'},
  {id: 'publish', q: 'multisig.faq.publishQ', a: 'multisig.faq.publishA'},
  {id: 'search', q: 'multisig.faq.searchQ', a: 'multisig.faq.searchA'},
  {id: 'lost', q: 'multisig.faq.lostQ', a: 'multisig.faq.lostA'},
  {id: 'change', q: 'multisig.faq.changeQ', a: 'multisig.faq.changeA'},
  {id: 'time', q: 'multisig.faq.timeQ', a: 'multisig.faq.timeA'},
]

export const SharedWalletsScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {wallets} = useSharedWallets()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const groupId = selectedWalletGroup?.groupId ?? null
  const discovery = useRegistrationDiscovery(
    groupId,
    selectedWalletGroup?.primaryWallet?.source ?? null,
    wallets,
    selectedAccountIndex,
  )

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <View style={styles.actions}>
        <Button
          label={t('multisig.list.create')}
          onPress={() => router.push('/wallet/create-multisig' as never)}
          fullWidth
          size="xl"
          testID="shared-wallets-create"
        />
        <Button
          label={discovery.state.status === 'done' ? t('multisig.discovery.again') : t('multisig.discovery.search')}
          variant="secondary"
          onPress={discovery.search}
          loading={discovery.state.status === 'searching'}
          disabled={groupId === null || discovery.state.status === 'searching'}
          fullWidth
          testID="shared-wallets-discover"
        />
      </View>

      {/* Results appear under the button that produced them, and only then — an
          empty results card above a FAQ would be a permanent hole in the screen.
          What a search can and cannot do is a question in the FAQ, not a caption. */}
      {discovery.state.status === 'done' ? (
        <Card variant="outlined" style={styles.discovery} testID="shared-wallets-discovery">
          {discovery.state.found.length === 0 ? (
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('multisig.discovery.none', {scanned: discovery.state.scanned})}
            </Typography>
          ) : (
            <View style={styles.discoveryResults}>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {t('multisig.discovery.summary', {
                  found: discovery.state.found.length,
                  scanned: discovery.state.scanned,
                })}
              </Typography>
              {discovery.state.found.map(({wallet, alreadyAdded}) => (
                <DiscoveryRow key={wallet.txHash} wallet={wallet} alreadyAdded={alreadyAdded} />
              ))}
            </View>
          )}
        </Card>
      ) : null}

      {discovery.state.status === 'failed' ? <Callout variant="warning" message={discovery.state.reason} /> : null}

      <FaqSection
        title={t('multisig.faq.title')}
        entries={FAQ.map((entry): FaqEntry => ({id: entry.id, question: t(entry.q), answer: t(entry.a)}))}
        testID="multisig-faq"
      />
    </SafeAreaViewWrapper>
  )
}
