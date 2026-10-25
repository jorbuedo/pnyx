/**
 * Editing the contact card — its own screen, not a sheet.
 *
 * It was a modal first, and several editable fields inside one did not perform (dev-lead call,
 * 2026-08-26): a bottom sheet that has to grow for the keyboard while holding a scrolling list of live
 * inputs is the shape React Native is worst at. A pushed screen gets the keyboard handling, the scroll
 * and the header for free.
 *
 * **One commit.** Every row is live — change a kind, change a value, remove a row — and `Save` writes the
 * card. The modal's add-then-save rhythm meant typing a value and pressing Save silently dropped it,
 * which is the defect this shape removes rather than mitigates.
 *
 * ⚠️ The card is **public chain state**, and saving costs one on-device proof per four rows. Both are
 * said on the screen: the first because it is irreversible, the second because a save is seconds of
 * work and a spinner with no figure reads as stuck.
 *
 * @module
 */

import {cardSaveCost, normalizeCardEntries, ROW_PAYLOAD_BYTES} from '@pnyx/contract-client/card'
import {useRouter} from 'expo-router'
import {useEffect, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button, ButtonIcon} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {Card} from '../../components/Card'
import {ChamferBackground} from '../../components/Chamfer'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SettingsPickerRow} from '../../components/SettingsPickerRow'
import {StickyFooter} from '../../components/StickyFooter'
import {TextInput} from '../../components/TextInput'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {useContactCard} from '../../hooks/useContactCard'
import {useI18n, usePnyxSession} from '../../providers'
import {type CardOption, entryForOption, offeredOptions} from './card-kind-label'
import {
  type CardValueCheck,
  checkCardanoCardValue,
  checkCardValue,
  checkChainAddressValue,
  invalidKey,
} from './card-value-check'
import {type DraftRow, nextRowId, seedDraftRows} from './draft-rows'

export function ContactCardScreen() {
  const {t} = useI18n()
  const router = useRouter()
  const {entries, current, busy, save} = useContactCard()
  const {identity} = usePnyxSession()
  const [draft, setDraft] = useState<readonly DraftRow[] | undefined>(undefined)
  // The chain a Cardano or Midnight row records is the one this identity is on, not a fixed default.
  const options = offeredOptions(identity?.network ?? 'mainnet')
  /** Which row's kind picker is open, by row id. One at a time: two open lists is a wall again. */
  const [pickingId, setPickingId] = useState<number | undefined>(undefined)
  /**
   * Cardano verdicts by row id.
   *
   * Their decoder runs under an Effect layer, so they cannot be computed in render like the others. The
   * overlay starts empty and a row with no entry yet shows nothing — never "invalid", which would flag
   * a good address for as long as the decode takes.
   */
  const [cardanoChecks, setCardanoChecks] = useState<Readonly<Record<number, CardValueCheck>>>({})

  // Seeded once the read lands. `undefined` until then, so an empty card and an unread one are not the
  // same screen — the second must not offer a Save that would clear rows it never saw.
  useEffect(() => {
    if (entries !== undefined && draft === undefined) setDraft(seedDraftRows(entries))
  }, [entries, draft])

  useEffect(() => {
    if (draft === undefined) return
    const pending = draft.filter((row) => row.option.chainId?.startsWith('cardano:') === true)
    if (pending.length === 0) {
      setCardanoChecks({})
      return
    }
    let live = true
    void Promise.all(pending.map(async (row) => [row.id, await checkCardanoCardValue(row.value)] as const)).then(
      (pairs) => {
        if (live) setCardanoChecks(Object.fromEntries(pairs))
      },
    )
    return () => {
      live = false
    }
  }, [draft])

  if (draft === undefined || current === undefined) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.body}>
        <Typography variant="bodySm_regular" style={styles.muted}>
          {t('you.card.loading')}
        </Typography>
      </SafeAreaViewWrapper>
    )
  }

  const setRow = (id: number, next: Partial<Pick<DraftRow, 'option' | 'value'>>) =>
    setDraft(draft.map((row) => (row.id === id ? {...row, ...next} : row)))
  /** Cardano is the one chain whose check cannot be synchronous, so it is named rather than switched on. */
  const isCardanoRow = (option: CardOption) => option.chainId?.startsWith('cardano:') === true
  const checkRow = (row: DraftRow): CardValueCheck =>
    row.option.chainId === undefined
      ? checkCardValue(row.option.kind, row.value)
      : checkChainAddressValue(row.option.chainId, row.value, row.option.expect)
  // Normalised first, so the figure is the plan's own count rather than a guess over raw input: a
  // half-typed row is dropped and an unedited one is not counted as changed.
  const cost = cardSaveCost(current, normalizeCardEntries(draft.map((row) => entryForOption(row.option, row.value))))
  /** A row's verdict: the async overlay for Cardano, the synchronous check for everything else. */
  const check = (row: DraftRow): CardValueCheck =>
    isCardanoRow(row.option) ? (cardanoChecks[row.id] ?? 'unknown') : checkRow(row)
  const anyInvalid = draft.some((row) => check(row) === 'invalid')

  return (
    <>
      <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.body}>
        <Callout variant="info" message={t('you.card.hint')} testID="id-card-public-notice" />

        {draft.map((row, index) => (
          /* ⚠️ Keyed by `id`, never by index. Removing a row shifts every later index, so an
             index key hands the next row the previous one's input state — the value you just
             typed reappears under a different entry. */
          <Card key={row.id} style={styles.row} testID={`id-card-row-${index}`}>
            {/* The row's header: what this entry is on the left, the chevron hard right, and removing
                it as an icon beside them. A full-width Remove button underneath made every row three
                tall and read as the card's action rather than the row's. */}
            <View style={styles.rowHeader}>
              <Pressable
                onPress={() => setPickingId(pickingId === row.id ? undefined : row.id)}
                accessibilityRole="button"
                accessibilityLabel={t('you.card.pickKind')}
                style={styles.kindButton}
                testID={`id-card-kind-${index}`}
              >
                <ChamferBackground size="auto" fillToken="backgroundAlternative" />
                <Typography variant="bodySm_medium" style={styles.kindLabel}>
                  {t(row.option.labelKey)}
                </Typography>
                {/* Down when closed, up when open — this is a selector, not a foldable section, and
                    `SectionHeader`'s right/down convention belongs to the latter. ⚠️ There is no
                    `chevronUp` asset (and naming one compiles and renders nothing), so the one chevron
                    is rotated rather than a second SVG added for a 180° turn. */}
                <View style={pickingId === row.id ? styles.chevronUp : undefined}>
                  <UniIcon name="chevronDown" size="sm" uniProps={(theme) => ({color: theme.colors.textMuted})} />
                </View>
              </Pressable>
              <ButtonIcon
                // `close` at `sm`, the same affordance `SendSourcesCard` uses to drop a row from a form.
                // A filled path, so nothing thin has to land on a pixel boundary — `expo-image`
                // rasterizes SVGs, and both trash glyphs are strokes drawn at 0.833 scale, which is what
                // made them read as aliased rather than as paths.
                icon="close"
                variant="naked"
                size="sm"
                onPress={() => {
                  setDraft(draft.filter((other) => other.id !== row.id))
                  setPickingId(undefined)
                }}
                containerProps={{accessibilityLabel: t('you.card.remove')}}
                testID={`id-card-remove-${index}`}
              />
            </View>
            {pickingId === row.id && (
              <View style={styles.kinds}>
                {options.map((option) => (
                  <SettingsPickerRow
                    key={option.id}
                    label={t(option.labelKey)}
                    selected={row.option.id === option.id}
                    onPress={() => {
                      setRow(row.id, {option})
                      setPickingId(undefined)
                    }}
                    testID={`id-card-kind-${index}-${option.id}`}
                  />
                ))}
              </View>
            )}
            {/* A single-line `TextInput`, not a `TextArea`. Almost every value is one line — an address,
                an email, a handle — and a text area's ~140px box is empty space for all of them; the
                long ones are long *horizontally*, which a single line scrolls. It also owns the error
                message, so the verdict does not need a `Typography` of its own. */}
            <TextInput
              value={row.value}
              onChange={(value) => setRow(row.id, {value})}
              placeholder={t('you.card.valuePlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              size="sm"
              fullWidth
              isError={check(row) === 'invalid'}
              {...(check(row) === 'invalid' ? {message: t(invalidKey(row.option.kind))} : {})}
              testID={`id-card-value-${index}`}
            />
            {/* A value longer than one row spans slots, which costs another quarter of a proof. Said
                per row, because it is the row that is long. */}
            {row.value.length > ROW_PAYLOAD_BYTES && (
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {t('you.card.spansRows')}
              </Typography>
            )}
          </Card>
        ))}

        <Button
          label={t('you.card.add')}
          variant="secondary"
          leftIcon="plus"
          onPress={() => {
            // Cardano first because it is the rail the app is built around; the row's own picker
            // changes it, so this is a starting point rather than a guess about intent.
            setDraft([...draft, {id: nextRowId(draft), option: options[0] as CardOption, value: ''}])
            setPickingId(undefined)
          }}
          fullWidth
          testID="id-card-add"
        />
      </SafeAreaViewWrapper>

      <StickyFooter>
        <Typography variant="bodyXs_regular" style={styles.cost} testID="id-card-cost">
          {t('you.card.saveCost', {count: cost})}
        </Typography>
        <Button
          label={busy ? t('you.card.saving') : t('you.card.save')}
          variant="primary"
          // Two reasons to refuse, and the footer's figure explains the second: a blank row cannot be
          // stored at all (kind zero is the contract's remove sentinel, so "a row saying nothing" is not
          // a state), and a save with nothing to write would toast "Card saved" over no work.
          isDisabled={busy || cost === 0 || anyInvalid || draft.some((row) => row.value.trim() === '')}
          isLoading={busy}
          fullWidth
          onPress={() => {
            // `entryForOption` trims and puts the chain back in front of the address.
            void save(draft.map((row) => entryForOption(row.option, row.value))).then(() => router.back())
          }}
          testID="id-card-save"
        />
      </StickyFooter>
    </>
  )
}

const styles = StyleSheet.create((theme) => ({
  body: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing12},
  row: {gap: theme.spacing.spacing8, padding: theme.spacing.spacing12},
  rowHeader: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing8},
  kindButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
  },
  kindLabel: {color: theme.colors.textDefault},
  chevronUp: {transform: [{rotate: '180deg'}]},
  kinds: {gap: theme.spacing.spacing8},
  muted: {color: theme.colors.textAlternative},
  cost: {color: theme.colors.textAlternative, textAlign: 'center'},
}))
