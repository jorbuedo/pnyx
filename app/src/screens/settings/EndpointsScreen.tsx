/**
 * Endpoint configuration, per chain and per network.
 *
 * Two tabs. **Midnight** is configurable: three endpoints per network, device overrides winning
 * over the control plane and the build. **Cardano** is not — its rail speaks Koios specifically, so
 * a URL set here could not be honoured until other providers are supported. The tab exists anyway,
 * because "where do I set the Cardano endpoint" is a question the Midnight tab invites, and an
 * empty answer in the place you looked beats no answer at all. The screen says only that it is
 * coming; the reason is ours, not the reader's.
 *
 * Three sources can name an endpoint and this screen shows all three: what the build ships, what
 * the control plane has pushed, and what this device has been told to use instead. The device wins
 * — see `config/chain-endpoints.ts` for the precedence and why it runs that way round.
 *
 * A field left empty is not an empty endpoint: it falls through to whatever the placeholder shows,
 * which is the control plane's value if there is one and the built-in otherwise. That is also how
 * an override is removed.
 *
 * Nothing is saved while someone is still typing. A half-typed URL would become the live endpoint
 * on the next keystroke, so values are validated and committed on blur.
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'
import {useCallback, useMemo, useState, useSyncExternalStore} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SegmentedControl} from '../../components/SegmentedControl'
import {SettingsGroup} from '../../components/SettingsGroup'
import {TextInput} from '../../components/TextInput'
import {Typography} from '../../components/Typography'
import {chainAvailability} from '../../config/chain-availability'
import {
  type EndpointKind,
  type EndpointRejection,
  type EndpointSource,
  validateEndpoint,
} from '../../config/chain-endpoints'
import {NETWORKS} from '../../config/networks'
import {useToast} from '../../hooks/useToast'
import type {TranslationKey} from '../../i18n/types'
import {logger} from '../../logger'
import {useI18n} from '../../providers/I18nProvider'
import {
  type EndpointRegistrySnapshot,
  getEndpointRegistrySnapshot,
  subscribeEndpointOverrides,
} from '../../services/midnight/endpoint-overrides'
import {clearNetworkEndpointOverrides, saveUserEndpointOverride} from '../../services/midnight/endpoint-overrides-store'
import {type ProbeResult, probeEndpoint} from '../../services/midnight/endpoint-probe'
import {describeMidnightEndpoint} from '../../services/midnight/networks'
import {getNetworkDisplayName} from '../../utils/network-utils'

const KINDS: readonly EndpointKind[] = ['indexer', 'node', 'nodeWs']

// Literal maps rather than template-built keys: `t` is typed on the key union, and a key assembled
// from a runtime string would need a cast that hides a missing translation until it renders.
// `remote` and `builtin` deliberately collapse to one label. Whether a default came from the
// control plane or from the build is our concern, not the reader's: both are "what the app chose",
// and naming the difference invites a question with no useful answer behind it. The distinction
// still exists in `resolveEndpoint` where it decides precedence.
const SOURCE_KEY = {
  user: 'settings.endpoints.source.user',
  remote: 'settings.endpoints.source.default',
  builtin: 'settings.endpoints.source.default',
  none: 'settings.endpoints.source.none',
} as const satisfies Record<EndpointSource, TranslationKey>

const KIND_LABEL = {
  indexer: 'settings.endpoints.field.indexer',
  node: 'settings.endpoints.field.node',
  nodeWs: 'settings.endpoints.field.nodeWs',
} as const satisfies Record<EndpointKind, TranslationKey>

const INVALID_KEY = {
  malformed: 'settings.endpoints.invalid.malformed',
  scheme: 'settings.endpoints.invalid.scheme',
  noHost: 'settings.endpoints.invalid.noHost',
} as const satisfies Record<EndpointRejection, TranslationKey>

/**
 * Reason codes the control plane may publish, mapped to the sentence each one gets.
 *
 * An unrecognised code falls back to the generic sentence rather than rendering the raw code: a
 * future control plane will publish codes this build has never heard of, and "midnight mainnet is
 * unavailable" is a better answer than "midnight mainnet is unavailable: chain_sunset_2027".
 */
const REASON_KEY: Record<string, TranslationKey> = {
  decommissioned: 'settings.endpoints.reason.decommissioned',
  maintenance: 'settings.endpoints.reason.maintenance',
  unspecified: 'settings.endpoints.reason.unspecified',
}

const reasonKey = (code: string | null): TranslationKey =>
  REASON_KEY[code ?? 'unspecified'] ?? 'settings.endpoints.reason.unspecified'

type ChainTab = 'midnight' | 'cardano'

export function EndpointsScreen() {
  const {t} = useI18n()
  const {showToast} = useToast()
  // The registry lives outside React because `networks.ts` reads it synchronously from everywhere.
  // `useSyncExternalStore` is how a component reads one of those, and here it is also the only shape
  // that survives React Compiler: a `revision` counter in a dependency array is not read by the memo
  // body, so the compiler treats it as unused and never recomputes — which it did, leaving the screen
  // showing and *testing* an endpoint that was no longer in force.
  const registry = useSyncExternalStore(subscribeEndpointOverrides, getEndpointRegistrySnapshot)
  const [tab, setTab] = useState<ChainTab>('midnight')

  const tabs = useMemo(
    () => [
      {label: t('settings.endpoints.tab.midnight'), value: 'midnight' as const, testID: 'endpoints-tab-midnight'},
      {label: t('settings.endpoints.tab.cardano'), value: 'cardano' as const, testID: 'endpoints-tab-cardano'},
    ],
    [t],
  )

  const commit = useCallback(
    async (network: Network, kind: EndpointKind, raw: string) => {
      const trimmed = raw.trim()
      if (trimmed === '') {
        await saveUserEndpointOverride(network, kind, null)
        return
      }
      const validation = validateEndpoint(kind, trimmed)
      if (!validation.ok) return
      await saveUserEndpointOverride(network, kind, validation.url)
      showToast({message: t('settings.endpoints.saved'), variant: 'success'})
    },
    [showToast, t],
  )

  const reset = useCallback(
    async (network: Network) => {
      await clearNetworkEndpointOverrides(network)
      showToast({message: t('settings.endpoints.resetDone'), variant: 'success'})
    },
    [showToast, t],
  )

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <SegmentedControl options={tabs} value={tab} onChange={setTab} testID="endpoints-tabs" />
      {tab === 'midnight' ? (
        <>
          <Callout variant="info" message={t('settings.endpoints.intro')} />
          {NETWORKS.map((network) => (
            <NetworkEndpoints key={network} network={network} registry={registry} onCommit={commit} onReset={reset} />
          ))}
        </>
      ) : (
        <View style={styles.comingSoon} testID="endpoints-cardano-coming-soon">
          <Callout variant="info" message={t('settings.endpoints.cardano.comingSoon')} />
        </View>
      )}
    </SafeAreaViewWrapper>
  )
}

function NetworkEndpoints({
  network,
  registry,
  onCommit,
  onReset,
}: {
  readonly network: Network
  /**
   * The registry snapshot, passed as a value rather than signalled by a counter. Re-keying the card
   * on a counter also worked, but remounted the focused field and fired a second blur, so every save
   * committed twice.
   */
  readonly registry: EndpointRegistrySnapshot
  readonly onCommit: (network: Network, kind: EndpointKind, raw: string) => Promise<void>
  readonly onReset: (network: Network) => Promise<void>
}) {
  const {t} = useI18n()
  const availability = useMemo(() => chainAvailability(registry.remote, 'midnight', network), [network, registry])
  const described = useMemo(
    () => KINDS.map((kind) => ({kind, ...describeMidnightEndpoint(network, kind, registry)})),
    [network, registry],
  )
  const hasOverride = described.some((d) => d.user !== undefined)
  const [probing, setProbing] = useState(false)
  const [results, setResults] = useState<Partial<Record<EndpointKind, ProbeResult>>>({})

  /**
   * Probe whatever is actually in force, which is the point: a field left empty is tested as the
   * default it falls through to, so "the shipped endpoint is down" and "the URL I typed is wrong"
   * are distinguishable without saving anything first.
   */
  const test = useCallback(async () => {
    setProbing(true)
    setResults({})
    const probed = await Promise.all(
      described.map(async (endpoint) =>
        endpoint.effective === null
          ? ([endpoint.kind, {status: 'refused', detail: t('settings.endpoints.source.none')}] as const)
          : ([endpoint.kind, await probeEndpoint(endpoint.kind, endpoint.effective)] as const),
      ),
    )
    setResults(Object.fromEntries(probed))
    setProbing(false)
  }, [described, t])

  return (
    <SettingsGroup
      label={getNetworkDisplayName(network, false)}
      link={{
        label: probing ? t('settings.endpoints.testing') : t('settings.endpoints.test'),
        onPress: () => {
          if (probing) return
          test().catch((error) => logger.warn('endpoint test failed', {network, error: String(error)}))
        },
        testID: `endpoints-test-${network}`,
      }}
    >
      {!availability.usable ? (
        <View style={styles.groupInset}>
          <Callout
            variant="warning"
            message={t('settings.endpoints.unavailable', {reason: t(reasonKey(availability.reasonCode))})}
          />
        </View>
      ) : null}
      <View style={styles.fields}>
        {described.map((endpoint) => (
          <EndpointField
            key={endpoint.kind}
            network={network}
            kind={endpoint.kind}
            initial={endpoint.user ?? ''}
            fallback={endpoint.fallback}
            effective={endpoint.effective}
            source={endpoint.source}
            probe={results[endpoint.kind]}
            probing={probing}
            onCommit={onCommit}
          />
        ))}
      </View>
      {hasOverride ? (
        <View style={styles.groupInset}>
          <Button
            variant="secondary"
            label={t('settings.endpoints.reset')}
            onPress={() => {
              onReset(network).catch((error) =>
                logger.warn('could not clear endpoint overrides', {network, error: String(error)}),
              )
            }}
            fullWidth
            testID={`endpoints-reset-${network}`}
          />
        </View>
      ) : null}
    </SettingsGroup>
  )
}

function EndpointField({
  network,
  kind,
  initial,
  fallback,
  effective,
  source,
  probe,
  probing,
  onCommit,
}: {
  readonly network: Network
  readonly kind: EndpointKind
  readonly initial: string
  readonly fallback: string | null
  readonly effective: string | null
  readonly source: EndpointSource
  readonly probe: ProbeResult | undefined
  readonly probing: boolean
  readonly onCommit: (network: Network, kind: EndpointKind, raw: string) => Promise<void>
}) {
  const {t} = useI18n()
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  const onBlur = useCallback(() => {
    const trimmed = draft.trim()
    // A blur that changed nothing is not a save. Without this, simply tapping through the fields
    // rewrote storage and re-toasted on every pass.
    if (trimmed === initial.trim()) {
      setError(null)
      return
    }
    if (trimmed !== '') {
      const validation = validateEndpoint(kind, trimmed)
      if (!validation.ok) {
        setError(t(INVALID_KEY[validation.reason]))
        return
      }
    }
    setError(null)
    onCommit(network, kind, draft).catch((e) =>
      logger.warn('could not save endpoint override', {network, kind, error: String(e)}),
    )
  }, [draft, initial, kind, network, onCommit, t])

  return (
    <View style={styles.field}>
      <TextInput
        label={t(KIND_LABEL[kind])}
        value={draft}
        onChange={(value) => {
          setDraft(value)
          if (error !== null) setError(null)
        }}
        onBlur={onBlur}
        placeholder={fallback ?? t('settings.endpoints.noDefault')}
        isError={error !== null}
        message={error ?? undefined}
        messageVariant="error"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        fullWidth
        testID={`midnight-endpoint-${network}-${kind}`}
      />
      <Typography variant="bodySm_regular" style={styles.source}>
        {t(SOURCE_KEY[source])}
      </Typography>
      {/* The URL in force, spelled out. `TextInput` hides a placeholder behind an unfloated label,
          so a default left in the placeholder is invisible until the field is tapped, which is
          exactly when it stops being the thing you wanted to read. */}
      {effective !== null ? (
        <Typography variant="bodySm_regular" style={styles.effective}>
          {effective}
        </Typography>
      ) : null}
      {probing || probe !== undefined ? (
        <Typography
          variant="bodySm_regular"
          style={probe === undefined ? styles.source : probe.status === 'accepted' ? styles.accepted : styles.refused}
          testID={`endpoint-probe-${network}-${kind}`}
        >
          {probe === undefined
            ? t('settings.endpoints.testing')
            : probe.status === 'accepted'
              ? t('settings.endpoints.accepted', {detail: probe.detail})
              : t('settings.endpoints.refused', {detail: probe.detail})}
        </Typography>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing.spacing16,
    padding: theme.spacing.spacing16,
  },
  // SettingsGroup's card pads vertically only (spacing4): it expects SettingsRow children, which
  // bring their own horizontal inset. One wrapper supplies it for all three fields, rather than each
  // field padding itself — which doubled up against the card and left the header looking detached.
  fields: {
    paddingHorizontal: theme.spacing.spacing12,
    gap: theme.spacing.spacing16,
  },
  field: {
    gap: theme.spacing.spacing4,
  },
  groupInset: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingTop: theme.spacing.spacing8,
  },
  source: {
    color: theme.colors.textMuted,
  },
  effective: {
    color: theme.colors.textAlternative,
  },
  comingSoon: {
    gap: theme.spacing.spacing8,
  },
  accepted: {
    color: theme.colors.successDefault,
  },
  refused: {
    color: theme.colors.errorDefault,
  },
}))
