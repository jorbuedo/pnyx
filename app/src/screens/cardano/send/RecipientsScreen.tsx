/**
 * Send funnel step 1 — recipients only: manage up to {@link MAX_TARGETS}
 * addresses (input, resolution, contacts), then continue to the amounts hub.
 *
 * @module
 */

import {useRouter} from 'expo-router'
import {useCallback, useEffect, useRef} from 'react'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../../components/StickyFooter'
import {useConfig, useI18n} from '../../../providers'
import {routeRecipient} from '../../../services/send/recipient-rail'
import {QueuedLegsBanner} from './QueuedLegsBanner'
import {RecipientRow} from './RecipientRow'
import {useSendFlow} from './SendFlowProvider'
import {addTarget, isTargetResolved, maxTargetsFor, removeTarget, setTargetAddress} from './state'

const styles = StyleSheet.create(({spacing}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
}))

export const RecipientsScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {network} = useConfig()
  const {state, setState, resolvingIndex, railReady, resolveAddress, selectContact} = useSendFlow()

  /**
   * Whether this input can be resolved yet.
   *
   * `railReady` is the *Cardano* rail's address load, and a Midnight recipient needs none of it —
   * the address carries its own rail. Gating both on it would make Midnight send unreachable on a
   * wallet with no Cardano account, which is a wallet this app supports.
   */
  const canResolve = useCallback(
    (raw: string) => railReady || routeRecipient(raw.trim(), network).rail === 'midnight',
    [railReady, network],
  )

  const onResolve = useCallback(
    (index: number) => {
      const target = state.targets[index]
      if (target === undefined || target.address.trim().length === 0 || isTargetResolved(target, state.rail)) return
      resolveAddress(index, target.address)
    },
    [state.targets, state.rail, resolveAddress],
  )

  // Auto-resolve after the user pauses typing — blur alone is unreliable on
  // Android soft keyboards. Failed inputs are remembered so a bad address
  // doesn't re-toast on every render; editing the field clears the memory.
  const attempted = useRef(new Set<string>())
  useEffect(() => {
    const index = state.targets.findIndex(
      (tg, i) =>
        tg.address.trim().length > 0 &&
        !isTargetResolved(tg, state.rail) &&
        canResolve(tg.address) &&
        !attempted.current.has(`${i}:${tg.address}`),
    )
    if (index < 0 || resolvingIndex !== null) return
    const target = state.targets[index]
    if (target === undefined) return
    const timer = setTimeout(() => {
      attempted.current.add(`${index}:${target.address}`)
      resolveAddress(index, target.address)
    }, 600)
    return () => clearTimeout(timer)
  }, [state.targets, state.rail, resolvingIndex, canResolve, resolveAddress])

  const allResolved = state.targets.every((tg) => isTargetResolved(tg, state.rail))

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          {/* Above Continue rather than under the first recipient: there it sat
              between the address field and that recipient's own contact actions,
              reading as part of them. */}
          {maxTargetsFor(state.rail) > 1 ? (
            <Button
              label={t('cardanoSend.addRecipient')}
              variant="nakedDefault"
              leftIcon="plus"
              onPress={() => setState(addTarget)}
              isDisabled={state.targets.length >= maxTargetsFor(state.rail)}
              testID="cardano-send-add-recipient"
            />
          ) : null}
          <Button
            label={t('common.buttons.continue')}
            onPress={() => router.push('/wallet/send/amounts' as never)}
            fullWidth
            size="xl"
            isDisabled={!allResolved}
            testID="send-recipients-continue"
          />
        </StickyFooter>
      }
    >
      <QueuedLegsBanner />
      {state.targets.map((target, index) => (
        <RecipientRow
          // biome-ignore lint/suspicious/noArrayIndexKey: targets are positional; identity is the slot
          key={index}
          index={index}
          target={target}
          rail={state.rail}
          canRemove={state.targets.length > 1}
          resolving={resolvingIndex === index}
          onAddressChange={(text) => setState((s) => setTargetAddress(s, index, text))}
          onResolve={() => onResolve(index)}
          onRemove={() => setState((s) => removeTarget(s, index))}
          onSelectContact={(addr) => selectContact(index, addr)}
        />
      ))}
    </SafeAreaViewWrapper>
  )
}
