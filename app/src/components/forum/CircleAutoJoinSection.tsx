/**
 * A founder turning on self-service joining: who may enter, in one action.
 *
 * ⚠️ **Choosing requirements and delegating are one act, not two.** They were two buttons, and that
 * was wrong: a founder who set a rule and stopped had a gate that refused everyone with a message
 * about *us*, and nothing in the product would have told them. Saving now posts the requirements and,
 * if this circle has not delegated yet, proves `setInviteAuthority` in the same tap. Clearing them
 * withdraws it again.
 *
 * ⚠️ **A set, and any one of them admits.** "Who may join" is a question about people, so a list
 * under it is a list of groups who may — see `accountSatisfiesAny`. All-of would make two rules
 * strictly narrower than one, so a founder adding a second to widen their circle would close it.
 *
 * ⚠️ **The permission state comes from the contract, never from the API.** `authorityCommitment` is
 * what we *would* use; whether this circle accepted it lives in its `inviteAuthority` ledger cell.
 * See `services/circle-invite-delegation.ts` for why a failed read is a fourth state and not "off",
 * and why nothing is claimed until the commitment read has actually finished.
 *
 * @module
 */

import {circleIdFromContentId} from '@pnyx/contract-client/circle-id'
import {useCallback, useEffect, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import type {TranslationKey} from '../../i18n/types'
import {logger} from '../../logger'
import {useI18n, usePnyxSession} from '../../providers'
import {type DelegationState, delegationState} from '../../services/circle-invite-delegation'
import {type InviteRule, pnyxApi} from '../../services/pnyx-api'
import {type ForumErrorKey, forumErrorKey} from '../../services/pnyx-forum'
import {readCircleInviteAuthority, submitDeviceSetInviteAuthority} from '../../services/pnyx-proving'
import {Button} from '../Buttons'
import {ChamferSurface} from '../Chamfer'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'

const ORIGIN = 'CircleAutoJoinSection'

/** Two minutes of asking, every five seconds — a Midnight call lands well inside it or it failed. */
const SETTLE_ATTEMPTS = 24
const SETTLE_INTERVAL_MS = 5_000

/** Withdrawal is `setInviteAuthority(zero)` — one transaction, and the delegation is over. */
const NOBODY = new Uint8Array(32)

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * The rules the attestor can evaluate — `circle-invite-policy.ts` is where the set is defined.
 *
 * ⚠️ `drep-any` ("anyone delegating to any DRep") was withdrawn on 2026-09-10 as a rule nobody asked
 * for. The parser no longer knows it either, so this list and the service's cannot drift into a kind
 * one side offers and the other refuses.
 */
const RULES = [
  {
    kind: 'drep-delegated',
    label: 'forum.manage.autoRuleDrepNamed',
    placeholder: 'forum.manage.autoRuleDrepNamedPlaceholder',
  },
  {kind: 'pool-member', label: 'forum.manage.autoRulePool', placeholder: 'forum.manage.autoRulePoolPlaceholder'},
  {kind: 'ada-threshold', label: 'forum.manage.autoRuleAda', placeholder: 'forum.manage.autoRuleAdaPlaceholder'},
] as const satisfies readonly {kind: string; label: TranslationKey; placeholder: TranslationKey}[]

type RuleKind = (typeof RULES)[number]['kind']

/** ADA in, lovelace out — the service stores a decimal string and never a float. */
const LOVELACE = 1_000_000n

export type CircleAutoJoinSectionProps = {
  readonly circleId: string
  /** The circle's contract address, or undefined while its deploy is unconfirmed. */
  readonly contractAddress: string | undefined
}

export function CircleAutoJoinSection({circleId, contractAddress}: CircleAutoJoinSectionProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const [selected, setSelected] = useState<ReadonlySet<RuleKind>>(new Set())
  const [params, setParams] = useState<Readonly<Record<string, string>>>({})
  const [ourAuthority, setOurAuthority] = useState<string | null>(null)
  const [hadPolicy, setHadPolicy] = useState(false)
  /** `false` until the policy read resolves — see {@link delegation}. */
  const [policyLoaded, setPolicyLoaded] = useState(false)
  /**
   * `undefined` while the answer is still being assembled.
   *
   * ⚠️ **Not `unknown`, and not `other`.** `delegationState` reads a null commitment as "somebody
   * else holds it", which is right once the read has *finished* and wrong while it is in flight — it
   * flashed *"this community has given permission to somebody else"* at a founder whose own
   * delegation was live. Nothing is claimed until both reads are in.
   */
  const [delegation, setDelegation] = useState<DelegationState | undefined>(undefined)
  /** Which button is in flight — both write, and only the one pressed should spin. */
  const [pending, setPending] = useState<'save' | 'off' | undefined>(undefined)
  /**
   * A submitted change the chain has not shown yet.
   *
   * ⚠️ **The relay accepts before the chain agrees.** Re-reading `inviteAuthority` the moment a
   * withdrawal is submitted returns the *old* cell, so the screen said "On." and offered "Turn off"
   * to a founder who had just turned it off — and would have charged them a second sponsored
   * transaction to do it again. The read is right; it is simply early.
   */
  const [settling, setSettling] = useState<'on' | 'off' | undefined>(undefined)
  const [error, setError] = useState<ForumErrorKey | undefined>(undefined)

  const token = session?.token
  const forumRoot = session?.forumRoot

  const refreshPolicy = useCallback(async () => {
    if (token === undefined) return
    try {
      const read = await pnyxApi.getCircleInvitePolicy(token, circleId)
      setOurAuthority(read.authorityCommitment)
      setHadPolicy(read.rules !== null)
      setSelected(new Set((read.rules ?? []).map((rule) => rule.kind as RuleKind)))
      setParams(Object.fromEntries((read.rules ?? []).map((rule) => [rule.kind, displayParam(rule)])))
    } catch (e) {
      // Logged rather than swallowed: "no rules set" and "the read failed" render as the same empty
      // form, and only one of them is something the founder should act on.
      logger.warn('could not read the invite policy', {origin: ORIGIN, circleId, error: String(e)})
    } finally {
      // Set either way. A failed read still means "we are done asking", and leaving it false would
      // hold the control in `checking` for ever rather than showing what the chain says.
      setPolicyLoaded(true)
    }
  }, [token, circleId])

  const refreshDelegation = useCallback(async () => {
    if (contractAddress === undefined || !policyLoaded) return
    try {
      setDelegation(delegationState(await readCircleInviteAuthority(contractAddress), ourAuthority, false))
    } catch (e) {
      // ⚠️ `unknown`, never `none`. Showing "off" for a failed read invites the founder to redo a
      // delegation that may already be live — a sponsored transaction that changes nothing.
      logger.warn('could not read the circle’s invite authority', {origin: ORIGIN, circleId, error: String(e)})
      setDelegation(delegationState(undefined, ourAuthority, true))
    }
  }, [contractAddress, ourAuthority, policyLoaded, circleId])

  /**
   * Read the contract until it shows `want`, or until the bound runs out.
   *
   * Bounded on purpose: a transaction that never lands must leave the control showing what the
   * chain actually says, not spinning for ever on what we hoped it would say.
   */
  const settle = useCallback(
    async (want: 'ours' | 'none', commitment: string | null) => {
      if (contractAddress === undefined) return
      setSettling(want === 'ours' ? 'on' : 'off')
      try {
        for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
          try {
            const read = delegationState(await readCircleInviteAuthority(contractAddress), commitment, false)
            setDelegation(read)
            if (read === want) return
          } catch (e) {
            // One failed read inside the poll is not the answer — keep asking until the bound.
            logger.debug('the invite-authority read failed while settling', {
              origin: ORIGIN,
              circleId,
              error: String(e),
            })
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS))
        }
        logger.warn('the invite authority did not settle within the bound', {origin: ORIGIN, circleId, want})
      } finally {
        setSettling(undefined)
      }
    },
    [contractAddress, circleId],
  )

  useEffect(() => {
    void refreshPolicy()
  }, [refreshPolicy])

  useEffect(() => {
    void refreshDelegation()
  }, [refreshDelegation])

  const toggle = (kind: RuleKind) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const chosen = RULES.filter((rule) => selected.has(rule.kind))
  const incomplete = chosen.some((rule) => (params[rule.kind] ?? '').trim() === '')
  /** Whether there is anything to turn off, so "turn off" is never offered for a circle already off. */
  const isOn = delegation === 'ours' || hadPolicy

  /**
   * Save the requirements **and** the permission, in that order.
   *
   * Order matters: the content write is cheap and reversible, the chain call is neither. Posting the
   * rules first means a founder whose delegation fails still has their requirements recorded and can
   * retry the expensive half alone.
   */
  const save = async (rules: InviteRule[]) => {
    if (token === undefined || forumRoot === undefined || contractAddress === undefined) return
    setPending(rules.length === 0 ? 'off' : 'save')
    setError(undefined)
    try {
      const answered = await pnyxApi.setCircleInvitePolicy(token, circleId, {rules})
      if (answered.authorityCommitment !== undefined) setOurAuthority(answered.authorityCommitment)
      setHadPolicy(rules.length > 0)
      const commitment = answered.authorityCommitment ?? ourAuthority
      // Only when it would change something. Re-proving an authority the circle already holds costs a
      // sponsored transaction and moves nothing, which is part of what the four-state read is for.
      if (rules.length > 0 && delegation !== 'ours' && commitment !== null) {
        await submitDeviceSetInviteAuthority({
          token,
          forumRoot,
          contentCircleId: circleId,
          chainCircleId: circleIdFromContentId(circleId),
          circleContractAddress: contractAddress,
          authority: fromHex(commitment),
        })
        logger.info('invite authority delegated', {origin: ORIGIN, circleId})
        await settle('ours', commitment)
      } else if (rules.length === 0 && delegation === 'ours') {
        await submitDeviceSetInviteAuthority({
          token,
          forumRoot,
          contentCircleId: circleId,
          chainCircleId: circleIdFromContentId(circleId),
          circleContractAddress: contractAddress,
          authority: NOBODY,
        })
        logger.info('invite authority withdrawn', {origin: ORIGIN, circleId})
        await settle('none', commitment)
      }
      // The form follows the write: leaving the rules on screen after turning it off shows a gate
      // that is no longer there.
      if (rules.length === 0) {
        setSelected(new Set())
        setParams({})
      }
      logger.info('invite requirements saved', {origin: ORIGIN, circleId, rules: rules.length})
      // Re-read rather than assume. A write that made no chain call still changed the rules, and
      // `settle` above has already brought the cell up to date when there was one.
      if (delegation !== undefined) await refreshDelegation()
    } catch (e) {
      logger.warn('saving the joining requirements failed', {origin: ORIGIN, circleId, error: String(e)})
      setError(forumErrorKey(e))
    } finally {
      setPending(undefined)
    }
  }

  const ruleParams = (): InviteRule[] =>
    chosen.map((rule) => ({kind: rule.kind, param: storedParam(rule.kind, params[rule.kind] ?? '')}))

  if (contractAddress === undefined) return null

  /**
   * ⚠️ **"Turn off" only when there is something on.** An empty form on a circle that never
   * delegated is not an invitation to turn anything off — it read as one, disabled, as the opening
   * state of the screen.
   */
  const action: TranslationKey =
    chosen.length === 0 && isOn
      ? 'forum.manage.autoTurnOff'
      : delegation === 'ours' && chosen.length > 0
        ? 'forum.manage.autoSaveChanges'
        : 'forum.manage.autoTurnOn'

  const status: TranslationKey =
    settling === 'on'
      ? 'forum.manage.autoPermissionTurningOn'
      : settling === 'off'
        ? 'forum.manage.autoPermissionTurningOff'
        : delegation === undefined
          ? 'forum.manage.autoPermissionChecking'
          : delegation === 'ours'
            ? 'forum.manage.autoPermissionOn'
            : delegation === 'other'
              ? 'forum.manage.autoPermissionOther'
              : delegation === 'unknown'
                ? 'forum.manage.autoPermissionUnknown'
                : 'forum.manage.autoPermissionOff'

  return (
    <View style={styles.section}>
      <Typography variant="bodyMd_medium">{t('forum.manage.autoTitle')}</Typography>
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('forum.manage.autoHint')}
      </Typography>

      <Typography variant="bodySm_medium">{t('forum.manage.autoRuleTitle')}</Typography>
      {/* Stated, not implied: with several requirements, meeting one is enough. */}
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('forum.manage.autoRuleAnyOf')}
      </Typography>

      {RULES.map((rule) => (
        <View key={rule.kind} style={styles.rule}>
          <RuleRow
            label={t(rule.label)}
            isSelected={selected.has(rule.kind)}
            onPress={() => toggle(rule.kind)}
            testID={`circle-auto-rule-${rule.kind}`}
          />
          {selected.has(rule.kind) && (
            <TextInput
              value={params[rule.kind] ?? ''}
              onChange={(value) => setParams((current) => ({...current, [rule.kind]: value}))}
              placeholder={t(rule.placeholder)}
              fullWidth
              testID={`circle-auto-rule-param-${rule.kind}`}
            />
          )}
        </View>
      ))}

      <Typography variant="bodySm_regular" style={delegation === 'unknown' ? styles.warning : styles.hint}>
        {t(status)}
      </Typography>

      <Button
        label={t(action)}
        variant={chosen.length > 0 ? 'primary' : 'secondary'}
        onPress={() => void save(ruleParams())}
        // ⚠️ Disabled while the state is unknown or still being read. Offering a save over a chain
        // read we could not make is how a founder pays for a transaction that changes nothing.
        isDisabled={
          pending !== undefined ||
          settling !== undefined ||
          forumRoot === undefined ||
          incomplete ||
          delegation === undefined ||
          delegation === 'unknown' ||
          (chosen.length === 0 && !isOn)
        }
        isLoading={pending === 'save' && settling === undefined}
        fullWidth
        testID="circle-auto-save"
      />

      {/* Named, not inferred: while it is on, the primary button says "Save changes" and the only
          way off was to clear every rule and guess that the label would change. */}
      {isOn && chosen.length > 0 && (
        <Button
          label={t('forum.manage.autoTurnOff')}
          variant="secondary"
          onPress={() => void save([])}
          // Not while the chain read failed, for the same reason the save is not: withdrawal needs
          // `delegation === 'ours'`, so an 'unknown' here would drop the rules and leave the
          // delegation standing.
          isDisabled={
            pending !== undefined ||
            settling !== undefined ||
            forumRoot === undefined ||
            delegation === undefined ||
            delegation === 'unknown'
          }
          isLoading={pending === 'off' && settling === undefined}
          fullWidth
          testID="circle-auto-turn-off"
        />
      )}

      {error !== undefined && (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t(error)}
        </Typography>
      )}
    </View>
  )
}

/**
 * The stored `param` for what the founder typed.
 *
 * ⚠️ **ADA is shown and lovelace is stored.** A founder typing "5" means 5 ADA, and storing 5 would
 * gate on five *millionths* of one — a threshold nobody would notice was wrong, because it admits
 * everybody. Whole ADA only: the input is a round number, and a fraction of an ADA is not a gate.
 */
const storedParam = (kind: string, typed: string): string =>
  kind === 'ada-threshold' ? (BigInt(typed.trim().replace(/[^0-9]/g, '') || '0') * LOVELACE).toString() : typed.trim()

/** The inverse, for filling the form from what the service stored. */
const displayParam = (rule: InviteRule): string => {
  if (rule.param === null) return ''
  if (rule.kind !== 'ada-threshold') return rule.param
  try {
    return (BigInt(rule.param) / LOVELACE).toString()
  } catch (e) {
    // A stored threshold we cannot read is our bug. Shown empty rather than as a wrong number, and
    // logged, because a silently blank field reads as "no threshold set".
    logger.warn('could not read a stored ADA threshold', {origin: ORIGIN, param: rule.param, error: String(e)})
    return ''
  }
}

function RuleRow({
  label,
  isSelected,
  onPress,
  testID,
}: {
  readonly label: string
  readonly isSelected: boolean
  readonly onPress: () => void
  readonly testID: string
}) {
  styles.useVariants({selected: isSelected})
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{checked: isSelected}}
      testID={testID}
    >
      {/* The surface owns its corner and its fill — the app's shape language is a cut, not a
          radius, and `ChamferSurface` is the one place that decides which. */}
      <ChamferSurface
        size="auto"
        fillToken={isSelected ? 'primaryDefault' : 'backgroundAlternative'}
        style={styles.ruleRow}
      >
        <Typography variant="bodySm_regular" style={styles.ruleLabel}>
          {label}
        </Typography>
      </ChamferSurface>
    </Pressable>
  )
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing.spacing8,
  },
  rule: {
    gap: theme.spacing.spacing8,
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
  ruleRow: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
  },
  ruleLabel: {
    variants: {
      selected: {
        true: {color: theme.colors.primaryInverse},
        false: {color: theme.colors.textDefault},
      },
    },
  },
}))
