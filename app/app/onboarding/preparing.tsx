/**
 * Preparing Wallet Screen.
 *
 * Two modes, decided by the onboarding flow flag `isAddWallet` (identity/wallet
 * split):
 *  - First run (`!isAddWallet`): establishes the IDENTITY — stores the seed in
 *    its dedicated enclave slot, persists the display name, signs in with SIWM.
 *    No wallet group is created; funds wallets are imported from the Wallets
 *    tab. If an identity slot already exists (re-entry / returning user), it
 *    restores instead of overwriting.
 *  - Add-wallet (`isAddWallet`): creates a funds wallet group for each default
 *    chain — the enclave key ceremony happens inside `createWallet` (keychain
 *    write under `BIOMETRY_ANY_OR_DEVICE_PASSCODE`).
 *
 * Shows the shared `<PreparingAnimation />` loader, then navigates to the
 * All Set success screen.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import {generateGroupId, TX_FETCH_MODE} from '@pnyx/wallet'
import {generateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {Effect} from 'effect'
import {router, useLocalSearchParams} from 'expo-router'
import {useEffect, useRef, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {ChamferBackground} from '../../src/components/Chamfer'
import {PreparingAnimation} from '../../src/components/onboarding/PreparingAnimation'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {StickyFooter} from '../../src/components/StickyFooter'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useMarkMnemonicBackupPending} from '../../src/hooks/useMnemonicBackupStatus'
import {logger} from '../../src/logger'
import {watchdog} from '../../src/logger/watchdog'
import {storage} from '../../src/platform/storage'
import {
  useConfig,
  useI18n,
  useOnboarding,
  usePnyxSession,
  useWalletData,
  useWalletList,
  useWalletSync,
} from '../../src/providers'
import {FUNDS_CHAINS} from '../../src/services/chains'
import {findExistingWalletForMnemonic} from '../../src/services/duplicate-wallet-detection'
import {pnyxIdForMnemonic} from '../../src/services/identity-candidates'
import {hasIdentityMnemonic, storeIdentityMnemonic} from '../../src/services/identity-wallet'
import {isMidnightChainId} from '../../src/services/midnight/scheduled-sync'
import {adoptRecoveredBirthdays, recordShieldedBirthdays} from '../../src/services/midnight/wallet/record-birthday'
import {prefetchIdentityArtifacts} from '../../src/services/pnyx-artifacts'
import {resolveIdentityNetwork} from '../../src/services/pnyx-session'

type PrepareStatus = 'creating' | 'complete' | 'error'

export default function PreparingWalletScreen() {
  const params = useLocalSearchParams<{name?: string}>()
  const {
    mnemonic: onboardingMnemonic,
    isQuickStart,
    isRestore,
    recoveredBirthdays,
    isAddWallet,
    existingGroupId: onboardingExistingGroupId,
    setExistingGroupMatch,
    reset: resetOnboarding,
  } = useOnboarding()
  const {createWallet, renameWallet, selectWallet, allWallets} = useWalletList()
  const {getAccountXPub} = useWalletData()
  const {syncWalletById} = useWalletSync()
  const {signInWithMnemonic, refreshIdentityEstablished, recordIdentity} = usePnyxSession()
  const markGroupPending = useMarkMnemonicBackupPending()
  const {enabledChains} = useConfig()
  const {t} = useI18n()
  const [status, setStatus] = useState<PrepareStatus>('creating')
  const [localError, setLocalError] = useState<string | null>(null)
  const createdRef = useRef(false)
  const groupIdRef = useRef<string | null>(null)
  // Persist mnemonic across retries so partially-created wallets use the same seed
  const mnemonicRef = useRef<string | null>(null)
  // Track which chains have been successfully created to avoid duplicates on retry
  const createdChainsRef = useRef<Set<ChainId>>(new Set())
  // Copy variant, frozen at mount. Keyed on the flow (add-wallet vs first-run),
  // not the async identity probe or wallet count — the first-run flow always
  // establishes the identity, so it shows identity copy ("Creating your Pnyx
  // identity…"), while add-wallet shows wallet copy.
  const [copyVariant] = useState<'wallet' | 'identity'>(() => (isAddWallet ? 'wallet' : 'identity'))

  const chainIds = FUNDS_CHAINS

  // Create wallets on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable refs and context; status triggers retry
  useEffect(() => {
    // Generate mnemonic once for quick start, reuse on retries
    if (!mnemonicRef.current) {
      mnemonicRef.current = onboardingMnemonic ?? (isQuickStart ? generateMnemonic(wordlist, 256) : null)
    }
    const mnemonic = mnemonicRef.current
    const name = params.name

    // Idempotency / re-entry guards: silent return — these are normal flow,
    // not bugs. Effect re-fires on every retry and on context re-renders.
    if (createdRef.current || status !== 'creating') return

    // Missing-state guards: these mean an upstream onboarding screen failed
    // to seed state before navigating here. Surface as an error instead of
    // a silent return — the screen otherwise sits on the loader forever
    // (the side-panel Google flow used to lose the mnemonic when the
    // root-level handoff navigation and the in-onboarding hydrator raced
    // on a single-read escrow). Logged at warn so Sentry catches it.
    // The identity run carries no name — the identity is chosen by avatar and named
    // on chain by its handle. Only the add-wallet run needs one, for the group list.
    if (!mnemonic || (isAddWallet && !name)) {
      // Explicit `: boolean` annotations: tsc will reject any future change
      // that drops the `Boolean(...)` coercion and feeds the raw mnemonic /
      // name into the log payload (Sentry breadcrumbs are PII-sensitive —
      // review feedback).
      const hasMnemonic: boolean = Boolean(mnemonic)
      const hasName: boolean = Boolean(name)
      logger.warn('Wallet creation blocked: missing mnemonic or wallet name', {
        origin: 'PreparingWallet',
        hasMnemonic,
        hasName,
        isQuickStart,
        isRestore,
      })
      setLocalError(null)
      setStatus('error')
      return
    }
    createdRef.current = true

    const doCreate = async () => {
      logger.info('Starting wallet creation', {origin: 'PreparingWallet', chainCount: chainIds.length})

      try {
        // First-run onboarding (NOT the add-wallet flow) establishes the
        // IDENTITY — a dedicated software-only seed in its own enclave slot
        // that powers SIWM/app auth. No funds wallet group is created here;
        // funds wallets are imported later from the Wallets tab (identity/
        // wallet split). The add-wallet flow sets `isAddWallet` and falls
        // through to group creation below. Branching on the flow flag (not the
        // async enclave probe) is what stops a first-run re-entry from leaking
        // the identity as a funds wallet group.
        if (!isAddWallet) {
          // Restore semantics: if the identity slot already exists (re-entry
          // after establishing it this session, or a returning user whose
          // enclave seed survived a data wipe), never overwrite it or create a
          // group — just finish; the app signs in with the existing identity.
          if (await hasIdentityMnemonic()) {
            logger.info('Identity already established — restoring, not re-creating', {origin: 'PreparingWallet'})
          } else {
            logger.info('Establishing identity wallet', {origin: 'PreparingWallet', isQuickStart, isRestore})
            await watchdog(storeIdentityMnemonic(mnemonic), {label: 'storeIdentityMnemonic', thresholdMs: 30_000})
            // Record the identity as soon as it exists, rather than waiting for sign-in to succeed.
            // Its `pnyx_id` is derivable offline in ~1 ms, and every avatar surface reads this
            // record — gating it on a JWT meant no avatar anywhere while registration was still
            // settling on chain, or if the service was simply unreachable.
            // The `pnyx_id` needs no network — it is the same identity on every one. The network is
            // recorded beside it only as the deployment this record was made against, which is what
            // decides where its row is looked up.
            await recordIdentity({
              pnyxId: await pnyxIdForMnemonic(mnemonic),
              network: resolveIdentityNetwork(),
            })
            await refreshIdentityEstablished()
            // Sign in while the seed is still in memory — no vault round-trip,
            // no OS prompt. Non-blocking: on failure the user lands signed-out
            // and the sign-in card remains the recovery path.
            void signInWithMnemonic(mnemonic)
          }
          // Both branches, not just the fresh one: a returning user whose enclave seed survived a
          // reinstall has an identity but an empty artifact cache, which is the same cold start.
          // Fire-and-forget — the publish path fetches the same files if this has not finished.
          prefetchIdentityArtifacts()
          resetOnboarding()
          await storage.remove('@pnyx/init_new_or_return_done')
          setStatus('complete')
          return
        }

        // Add-wallet path only. The guard above already returned for an add-wallet run without a
        // name; this narrows the type here rather than asserting it away.
        if (name === undefined) return
        // Resolve upgrade target. The name-input screen detects matches on
        // mount and stashes the match in onboarding context; if the user
        // submitted before that resolved, run the detection here too so the
        // upgrade still applies. Quick-start mnemonics are random — skip.
        let existingGroupId = onboardingExistingGroupId
        if (!existingGroupId && createdChainsRef.current.size === 0 && !isQuickStart) {
          const existingWallet = await findExistingWalletForMnemonic({
            mnemonic,
            wallets: allWallets,
            enabledChains,
            // Compare stored xpub bytes directly so we don't depend on
            // `wallet.checksum`, which is attached asynchronously during
            // first-load and can lag behind the React-state wallet list on
            // extension popup cold-open.
            getStoredXpub: async (groupId, chainId) => {
              try {
                return await getAccountXPub(chainId, groupId, 0)
              } catch (e: unknown) {
                // `null` is "no xpub cached", which is an ordinary cold start — a failed read
                // reaches the caller as the same answer.
                logger.warn('Stored xpub could not be read; treating it as absent', {
                  origin: 'preparing',
                  chainId,
                  groupId,
                  error: String(e),
                })
                return null
              }
            },
          })
          if (existingWallet) {
            existingGroupId = existingWallet.groupId
            setExistingGroupMatch({groupId: existingWallet.groupId, source: existingWallet.source})
          }
        }

        if (existingGroupId) {
          logger.info('Upgrading existing wallet in place', {
            origin: 'PreparingWallet',
            existingGroupId,
          })
          groupIdRef.current = existingGroupId
        }
        if (!groupIdRef.current) {
          groupIdRef.current = generateGroupId()
        }
        const groupId = groupIdRef.current

        // Create a wallet for each chain, skipping already-created ones on retry
        for (const chainId of chainIds) {
          if (createdChainsRef.current.has(chainId)) {
            logger.info('Skipping already-created chain', {origin: 'PreparingWallet', chainId})
            continue
          }
          logger.info('Creating wallet for chain', {origin: 'PreparingWallet', chainId})
          // Watchdog warns to Sentry if a single-chain `createWallet` hasn't
          // returned in 30s — covers the in-memory wallet build (chain xpub
          // derivations) + the enclave keychain write. Each phase should be
          // sub-second; the whole thing hanging is the silent-hang signal.
          await watchdog(
            createWallet({
              name,
              mnemonic,
              chainId,
              groupId,
            }),
            {label: 'createWallet', thresholdMs: 30_000, context: {groupId, chainId}},
          )
          createdChainsRef.current.add(chainId)
        }

        // On upgrade, rename the (now upgraded) group to honour whatever the
        // user submitted on the name screen — the wallet-manager's add-chain
        // branch deliberately doesn't touch the name, so we apply it here.
        if (existingGroupId) {
          await renameWallet(groupId, name)
        }

        // Mark backup pending in context (writes storage + updates in-memory state atomically)
        // before selecting the wallet, so any consumer that renders after selectWallet
        // already sees isPending=true without needing an async storage read.
        if (isQuickStart) {
          await markGroupPending(groupId)
        }

        // ⚠️ **A software wallet that finishes with no Midnight chain can hold no DUST.** That is the
        // real defect the old check was reaching for, and it is only decidable *here* — inside
        // `createWallet` the group is half-built, so the same question answered "no" on every
        // Cardano leg and put an error in the log of every creation. An upgrade is exempt: it
        // creates only the chains the group was missing, so the group may already have Midnight.
        if (!existingGroupId && ![...createdChainsRef.current].some(isMidnightChainId)) {
          logger.error('a software wallet finished creation with no Midnight chain, so it can hold no DUST', {
            origin: 'PreparingWallet',
            groupId,
            created: [...createdChainsRef.current],
          })
        }

        // ⚠️ **The shielded birthday, and only here.** The height a seed starts at is available
        // exactly once — recorded at a first sync instead, it would be that day's tip and every block
        // between would be skipped for good. `isRestore` picks which fact is true: a fresh seed's
        // history starts now, a restored one's started whenever the recovery blob says. Awaited rather
        // than fired off, because the very next thing this screen does is start syncing.
        //
        // An upgrade of an existing group is exempt on the create side: that seed is older than this
        // moment, so stamping today's tip would claim a birthday later than the truth.
        if (isRestore) {
          await Effect.runPromise(adoptRecoveredBirthdays(groupId, recoveredBirthdays ?? undefined))
        } else if (!existingGroupId) {
          await Effect.runPromise(recordShieldedBirthdays(groupId))
        }

        logger.info('All wallets created, selecting new wallet group', {origin: 'PreparingWallet', groupId})
        // Select the newly created wallet group without a specific chainId —
        // this activates the group in the "All Blockchains" aggregated view.
        await selectWallet(groupId)

        // Fire background sync for all chains immediately (don't await)
        for (const ch of chainIds) {
          syncWalletById(groupId, ch, {txMode: TX_FETCH_MODE.RECENT}).catch((e) =>
            logger.warn('Background sync failed', {origin: 'PreparingWallet', chainId: ch, error: String(e)}),
          )
        }

        resetOnboarding()
        await storage.remove('@pnyx/init_new_or_return_done')
        setStatus('complete')
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to create wallet'
        logger.error('Failed to create wallet', {origin: 'PreparingWallet', error: String(e)})
        setLocalError(msg)
        setStatus('error')
      }
    }

    doCreate()
  }, [status])

  useEffect(() => {
    // Straight to the app. There was a success screen between here and `/` whose only action was
    // `router.replace('/')` — a checkmark and a Done button standing between the user and the thing
    // they asked for.
    if (status === 'complete') router.replace('/')
  }, [status])

  /**
   * ⚠️ **Retrying cannot fix a missing-state failure.** The guard above fires when an upstream
   * screen did not seed the mnemonic; `handleRetry` only clears the flag and re-runs the same
   * check against the same empty context, so the screen would sit here failing for ever. The
   * distinguishing signal already exists: the guard sets `localError` to null, a thrown creation
   * error sets it to a message.
   */
  const stateWasLost = status === 'error' && localError === null

  const handleStartOver = () => {
    resetOnboarding()
    router.replace('/onboarding/new-or-return')
  }

  const handleRetry = () => {
    setLocalError(null)
    createdRef.current = false
    setStatus('creating')
  }

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      stickyFooter={
        status === 'error' ? (
          <StickyFooter>
            <Button
              label={stateWasLost ? t('onboarding.preparing.startOverButton') : t('common.buttons.tryAgain')}
              fullWidth
              size="xl"
              onPress={stateWasLost ? handleStartOver : handleRetry}
              testID={stateWasLost ? 'start-over-button' : 'retry-button'}
            />
          </StickyFooter>
        ) : undefined
      }
    >
      {/* Keep the loader visible for both 'creating' and 'complete'. The complete state is only
          ever rendered for ~one frame before `router.replace('/')` swaps the screen out, so
          showing a wallet avatar/identicon here would flash the wrong icon on the way past. */}
      {(status === 'creating' || status === 'complete') && (
        <View style={styles.creatingContainer}>
          <PreparingAnimation variant={copyVariant} />
        </View>
      )}

      {status === 'error' && (
        <View style={styles.content}>
          <View style={styles.iconContainer}>
            <View style={styles.errorIcon}>
              <ChamferBackground size="auto" fillToken="errorMuted" borderToken="errorBorder" borderWidth={1} />
              <UniIcon name="alert" size="xl" uniProps={(theme) => ({color: theme.colors.errorDefault})} />
            </View>
          </View>
          <View style={styles.textContainer}>
            <Typography variant="headingMd" style={styles.title}>
              {t('onboarding.preparing.errorTitle')}
            </Typography>
            <Typography variant="bodyMd_regular" style={styles.subtitle}>
              {localError ?? t('onboarding.preparing.errorStateLost')}
            </Typography>
          </View>
        </View>
      )}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.spacing24,
    gap: theme.spacing.spacing20,
  },
  creatingContainer: {
    flex: 1,
  },
  iconContainer: {
    width: 100,
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorIcon: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing24,
  },
  title: {
    textAlign: 'center',
    color: theme.colors.textDefault,
  },
  subtitle: {
    color: theme.colors.textAlternative,
    textAlign: 'center',
    maxWidth: 320,
  },
}))
