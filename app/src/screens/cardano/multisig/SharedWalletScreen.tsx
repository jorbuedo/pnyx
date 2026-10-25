/**
 * A shared wallet's composition: who can sign, under what rule, on which
 * network — and the one link that carries all of it to someone else.
 *
 * One screen serves two arrivals, because they are the same question asked from
 * either side:
 *
 * - **`id`** — a wallet on this device. Review it later, and re-share it: a
 *   participant who lost their copy, or who never got one, needs exactly this.
 * - **`def`** — a definition that arrived in a link. The same reading, before
 *   deciding to add it. Reviewing an incoming wallet and reviewing your own must
 *   show the same fields in the same order, or "is this the wallet I agreed to?"
 *   becomes a diffing exercise across two layouts.
 *
 * Read-only throughout. A shared wallet's composition is fixed at creation —
 * every co-signer's address derivation depends on it, so editing one here would
 * silently fork the wallet away from everyone else's copy. Changing who can sign
 * means building a new wallet and moving the funds.
 *
 * @module
 */

import {Effect, Either} from 'effect'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {Share, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {Callout} from '../../../components/Callout'
import {Card} from '../../../components/Card'
import {Copiable} from '../../../components/Copiable'
import {QRCard} from '../../../components/QRCard'
import {DataRow} from '../../../components/Row'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {Typography} from '../../../components/Typography'
import {useSharedWallets} from '../../../hooks/useSharedWallets'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {getActiveCardanoNetwork} from '../../../services/cardano/config'
import {
  addressNetworkOf,
  encodeAccountXvk,
  newSharedWalletId,
  platformSharedWalletRegistry,
  type SharedWallet,
  scriptsAt,
  signPolicy,
  validityBounds,
} from '../../../services/cardano/multisig'
import {
  buildDefinitionLink,
  definitionFitsQr,
  type SharedWalletDefinition,
  unpackDefinition,
} from '../../../services/cardano/multisig/definition-link'
import {checkImport, definitionAsWallet, selfTagIn} from '../../../services/cardano/multisig/import-definition'
import {registerComposerDraft} from '../../../services/composer-draft'
import {OwnWalletPickerModal} from './OwnWalletPickerModal'
import {PayerPickerModal} from './PayerPickerModal'
import {usePublishRegistration} from './use-publish-registration'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing16},
  card: {padding: spacing.spacing16, gap: spacing.spacing12},
  rosterRow: {gap: spacing.spacing4},
  rosterHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8},
  muted: {color: colors.textMuted},
  you: {color: colors.primaryDefault},
  key: {color: colors.textMuted},
  actions: {gap: spacing.spacing8},
}))

const ORIGIN = 'SharedWalletScreen'

/** The bech32 `acct_shared_xvk…` for a roster key, or the hex if it will not encode. */
const keyText = (accountXpubHex: string): string => {
  const bech32 = encodeAccountXvk(accountXpubHex)
  if (Either.isRight(bech32)) return bech32.right
  // Never expected — the roster is validated on the way in — but showing the hex
  // beats showing nothing where the value is what a reader is here to check.
  logger.warn('shared wallet: a roster key would not encode as bech32', {origin: ORIGIN})
  return accountXpubHex
}

export const SharedWalletScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {showToast} = useToast()
  const {id, def} = useLocalSearchParams<{id?: string; def?: string}>()
  const {wallets, loading, reload} = useSharedWallets()
  const {registerSharedWalletGroup, selectWallet} = useWalletList()

  const local = useMemo(() => (id === undefined ? null : (wallets.find((w) => w.id === id) ?? null)), [id, wallets])

  /** An incoming definition, or the failure that says why it is not one. */
  const incoming = useMemo(() => (def === undefined ? null : unpackDefinition(def)), [def])

  /**
   * The composition being shown, from whichever side it arrived.
   *
   * Memoized because it is the identity the address derivation keys on: rebuilt
   * every render, the effect below would re-derive on each one.
   */
  const definition = useMemo<SharedWalletDefinition | null>(
    () =>
      local !== null
        ? {
            name: local.name,
            coSigners: local.coSigners,
            paymentTemplate: local.paymentTemplate,
            delegationTemplate: local.delegationTemplate,
            network: local.network,
            accountIndex: local.accountIndex,
          }
        : incoming !== null && Either.isRight(incoming)
          ? incoming.right
          : null,
    [local, incoming],
  )

  /**
   * The script address this composition derives.
   *
   * Shown for both arrivals: for our own wallet it is where funds live, and for
   * an incoming definition it is the wallet's identity — the one value that says
   * "this is the wallet we agreed on" before anything is added.
   */
  const [address, setAddress] = useState<string | null>(null)
  useEffect(() => {
    if (definition === null) {
      setAddress(null)
      return
    }
    let active = true
    const preview = local ?? definitionAsWallet(definition, {id: 'preview', createdAt: ''})
    void Effect.runPromise(scriptsAt(preview, 0))
      .then((scripts) => {
        if (active) setAddress(scripts.addressBech32)
      })
      .catch((e: unknown) => {
        // The composition still reads without it, so this is a missing row rather
        // than a broken screen — but it is never silently missing.
        logger.warn('shared wallet: could not derive the script address', {origin: ORIGIN, error: String(e)})
        if (active) setAddress(null)
      })
    return () => {
      active = false
    }
  }, [definition, local])

  const link = local === null ? null : buildDefinitionLink(local)

  const shareLink = useCallback(async () => {
    if (link === null) return
    await Share.share({message: link})
  }, [link])

  /**
   * Hand the definition to the DM composer rather than posting it — the same rule
   * the co-signer key and the invite follow: the inbox picks the conversation, the
   * thread opens with the link in the box, and the user presses send. One
   * participant per send, deliberately: who receives a wallet is a decision per
   * person, and a fan-out would make it one tap for all of them.
   */
  const sendInMessage = useCallback(() => {
    if (link === null) return
    router.push(`/community?draft=${registerComposerDraft(link)}` as never)
  }, [link, router])

  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const importCheck = useMemo(
    () =>
      incoming === null || Either.isLeft(incoming)
        ? null
        : checkImport(incoming.right, {
            activeNetwork: addressNetworkOf(getActiveCardanoNetwork()),
            existing: wallets,
          }),
    [incoming, wallets],
  )

  /**
   * Add an incoming wallet.
   *
   * `selfXpubHex` is optional because both cases are real: usually the reader is
   * in the roster and the wallet they signed up with holds the key, and sometimes
   * they are adding a wallet they can only watch — a treasury they are not a
   * member of, or their own before the member wallet is restored on this device.
   * What must not happen is claiming a signing group that cannot sign, so the key
   * is matched against the roster rather than assumed.
   */
  const add = useCallback(
    async (self: {readonly groupId: string; readonly accountXpubHex: string} | null) => {
      if (incoming === null || Either.isLeft(incoming)) return
      const target = incoming.right
      if (self !== null && selfTagIn(target, self.accountXpubHex) === null) {
        showToast({variant: 'error', message: t('multisig.composition.notInRoster')})
        return
      }
      setBusy(true)
      try {
        const wallet = definitionAsWallet(target, {
          id: newSharedWalletId(),
          createdAt: new Date().toISOString(),
          ...(self === null ? {} : {selfXpubHex: self.accountXpubHex, selfGroupId: self.groupId}),
        })
        const scripts = await Effect.runPromise(scriptsAt(wallet, 0))
        await Effect.runPromise(platformSharedWalletRegistry().save(wallet))
        await registerSharedWalletGroup({
          groupId: wallet.id,
          name: wallet.name,
          addresses: [scripts.addressBech32],
          checksumSeed: scripts.paymentScriptHashHex,
        })
        reload()
        showToast({variant: 'success', message: t('multisig.composition.added')})
        router.replace(`/wallet/shared-wallet?id=${wallet.id}` as never)
      } catch (e) {
        logger.warn('shared wallet: import failed', {origin: ORIGIN, error: String(e)})
        showToast({variant: 'error', message: t('multisig.composition.addFailed')})
      } finally {
        setBusy(false)
      }
    },
    [incoming, registerSharedWalletGroup, reload, router, showToast, t],
  )

  /**
   * Publishing lives here because this is the screen that holds the composition,
   * and a registration is that composition written to the chain. It used to hang
   * off a list of shared wallets that no longer exists.
   */
  const {publish, busy: publishing, canPublish, publishAsPayer} = usePublishRegistration(reload)
  const [payerOpen, setPayerOpen] = useState(false)
  const published = local?.registration?.status === 'published'

  const policy = definition === null ? null : signPolicy(definition.paymentTemplate)
  const bounds = definition === null ? null : validityBounds(definition.paymentTemplate)

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      {definition === null ? (
        <Callout
          variant={loading && id !== undefined ? 'info' : 'error'}
          message={
            loading && id !== undefined
              ? t('common.labels.loading')
              : incoming !== null && Either.isLeft(incoming)
                ? incoming.left.kind === 'version'
                  ? t('multisig.composition.errorVersion')
                  : t('multisig.composition.errorUnreadable')
                : t('multisig.composition.errorMissing')
          }
        />
      ) : (
        <>
          {importCheck !== null && Either.isLeft(importCheck) ? (
            <Callout
              variant="warning"
              message={
                importCheck.left.kind === 'wrong-network'
                  ? t('multisig.composition.wrongNetwork', {network: getActiveCardanoNetwork()})
                  : t('multisig.composition.alreadyHere')
              }
              {...(importCheck.left.kind === 'already-present'
                ? {
                    actionLabel: t('multisig.composition.openExisting'),
                    onAction: () =>
                      router.replace(
                        `/wallet/shared-wallet?id=${(importCheck.left as {wallet: SharedWallet}).wallet.id}` as never,
                      ),
                    actionTestID: 'shared-wallet-open-existing',
                  }
                : {})}
            />
          ) : null}

          <Card variant="outlined" style={styles.card} testID="shared-wallet-composition">
            <DataRow label={t('multisig.composition.name')} value={definition.name} />
            <DataRow
              label={t('multisig.composition.policy')}
              value={policy === null ? '' : t('multisig.list.policy', {required: policy.required, total: policy.total})}
            />
            <DataRow
              label={t('multisig.composition.notBefore')}
              value={
                bounds?.from === null || bounds === null
                  ? t('multisig.create.timeLockFromEmpty')
                  : t('multisig.composition.slot', {slot: bounds.from.toString()})
              }
            />
            <DataRow
              label={t('multisig.composition.notAfter')}
              value={
                bounds?.until === null || bounds === null
                  ? t('multisig.create.timeLockUntilEmpty')
                  : t('multisig.composition.slot', {slot: bounds.until.toString()})
              }
            />
            <DataRow label={t('multisig.composition.network')} value={getActiveCardanoNetwork()} />
            <DataRow label={t('multisig.composition.account')} value={String(definition.accountIndex)} />
            {local?.registration === undefined ? null : (
              <DataRow
                label={t('multisig.composition.registration')}
                value={
                  local.registration.status === 'published'
                    ? t('multisig.detail.registrationPublished')
                    : local.registration.status === 'pending'
                      ? t('multisig.detail.registrationPending')
                      : t('multisig.composition.registrationSkipped')
                }
              />
            )}
          </Card>

          <Card variant="outlined" style={styles.card} testID="shared-wallet-roster">
            <Typography variant="bodyMd_medium">
              {t('multisig.composition.coSigners', {count: definition.coSigners.length})}
            </Typography>
            {definition.coSigners.map((c) => (
              <View key={c.tag} style={styles.rosterRow}>
                <View style={styles.rosterHead}>
                  <Typography variant="bodyMd_regular">
                    {c.name === '' ? t('multisig.composition.unnamed') : c.name}
                  </Typography>
                  {c.isSelf === true ? (
                    <Typography variant="bodyXs_medium" style={styles.you}>
                      {t('multisig.you')}
                    </Typography>
                  ) : null}
                </View>
                <Copiable text={keyText(c.accountXpubHex)} feedback={t('multisig.composition.keyCopied')}>
                  <Typography variant="bodyXs_regular" style={styles.key} numberOfLines={1}>
                    {keyText(c.accountXpubHex)}
                  </Typography>
                </Copiable>
              </View>
            ))}
          </Card>

          {address === null ? null : (
            <Card variant="outlined" style={styles.card} testID="shared-wallet-address">
              <Typography variant="bodyMd_medium">{t('multisig.composition.address')}</Typography>
              <Copiable text={address} feedback={t('multisig.composition.address')}>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {address}
                </Typography>
              </Copiable>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {t('multisig.composition.addressHint')}
              </Typography>
            </Card>
          )}

          {/* A registration is paid for by an ordinary funded wallet — the shared
              wallet is precisely the one that cannot pay for it. When the active
              wallet cannot, that is said rather than shown as a missing button. */}
          {local === null || published ? null : (
            <>
              <Typography variant="bodySm_regular" style={styles.muted}>
                {t('multisig.composition.publishHint')}
              </Typography>
              <Button
                label={t('multisig.detail.publish')}
                variant="secondary"
                // Whichever wallet is active, publishing is reachable: if it can pay,
                // it pays; if it cannot — and viewing a shared wallet's own screen
                // means it cannot — the picker chooses a payer. Refusing here left
                // the only route to this screen unable to use it.
                onPress={() => (canPublish ? publish(local) : setPayerOpen(true))}
                isLoading={publishing}
                fullWidth
                testID="shared-wallet-publish"
              />
            </>
          )}

          {/* Sharing is offered for a wallet this device holds. An incoming
              definition is not re-shareable until it is added: forwarding one we
              have not accepted would spread a roster nobody here has checked. */}
          {link === null ? null : (
            <>
              <Typography variant="bodySm_regular" style={styles.muted}>
                {t('multisig.composition.shareExplainer')}
              </Typography>
              {definitionFitsQr(link) ? (
                <QRCard value={link} fill testID="shared-wallet-qr" />
              ) : (
                <Callout variant="info" message={t('multisig.composition.qrTooLarge')} />
              )}
              <View style={styles.actions}>
                <Button
                  label={t('multisig.composition.sendInMessage')}
                  onPress={sendInMessage}
                  fullWidth
                  testID="shared-wallet-send-dm"
                />
                <Button
                  label={t('multisig.composition.shareLink')}
                  onPress={shareLink}
                  variant="secondary"
                  fullWidth
                  testID="shared-wallet-share"
                />
              </View>
            </>
          )}

          {/* Adding is offered only for an incoming definition this device can
              actually take: the wrong network or a copy already here both have
              their own callout above, and a second refusal on a button would say
              the same thing twice. */}
          {importCheck !== null && Either.isRight(importCheck) ? (
            <View style={styles.actions}>
              <Button
                label={t('multisig.composition.add')}
                onPress={() => setPickerOpen(true)}
                fullWidth
                size="xl"
                isLoading={busy}
                isDisabled={busy}
                testID="shared-wallet-add"
              />
              <Button
                label={t('multisig.composition.addWatchOnly')}
                onPress={() => void add(null)}
                variant="nakedDefault"
                fullWidth
                isDisabled={busy}
                testID="shared-wallet-add-watch"
              />
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {t('multisig.composition.addHint')}
              </Typography>
            </View>
          ) : null}
        </>
      )}

      <PayerPickerModal
        visible={payerOpen}
        onClose={() => setPayerOpen(false)}
        onPicked={(payerGroupId) => {
          setPayerOpen(false)
          if (local === null) return
          // Switch first: the rail, the fee and the signing ceremony all belong to
          // the wallet that pays. `publishAsPayer` waits for the rail to be that
          // wallet's before it builds anything.
          publishAsPayer(local, payerGroupId)
          void selectWallet(payerGroupId).catch((error: unknown) => {
            logger.warn('shared wallet: could not switch to the paying wallet', {
              origin: ORIGIN,
              payerGroupId,
              error: String(error),
            })
            showToast({variant: 'error', message: t('multisig.detail.publishFailed')})
          })
        }}
      />

      <OwnWalletPickerModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPicked={(picked) => void add({groupId: picked.groupId, accountXpubHex: picked.accountXpubHex})}
        takenXpubs={[]}
      />
    </SafeAreaViewWrapper>
  )
}
