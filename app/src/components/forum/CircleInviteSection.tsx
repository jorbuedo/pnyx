/**
 * A founder minting an invite code by hand, to give to somebody in particular.
 *
 * ⚠️ **A code is shown once and is never recoverable.** The chain stores `inviteCommitment(secret)`,
 * a one-way hash, so nobody — us included — can read an invite back off the ledger. If the founder
 * closes this without copying it, the only remedy is minting another and revoking the first.
 *
 * ⚠️ **This no longer uploads anything.** It used to offer "add one to the shared pool", which handed
 * the service a *usable secret* to dispense — the shape forced by a service that could not mint. It
 * can now: a founder delegates a narrow, revocable on-chain authority (`CircleAutoJoinSection`) and
 * the service issues one invite per qualifying wallet, holding no unissued codes at all.
 *
 * @module
 */

import {circleIdFromContentId} from '@pnyx/contract-client/circle-id'
import {encodeCircleInvite} from '@pnyx/contract-client/circle-invite'
import {randomBytes} from '@pnyx/crypto'
import {Effect} from 'effect'
import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../../logger'
import {copyToClipboard} from '../../platform/clipboard'
import {useI18n, usePnyxSession} from '../../providers'
import {type ForumErrorKey, forumErrorKey} from '../../services/pnyx-forum'
import {submitDeviceSetInvite} from '../../services/pnyx-proving'
import {Button} from '../Buttons'
import {ChamferSurface} from '../Chamfer'
import {Typography} from '../Typography'

const ORIGIN = 'CircleInviteSection'

export type CircleInviteSectionProps = {
  readonly circleId: string
  /**
   * The circle's contract address, or undefined while its deploy is unconfirmed.
   *
   * Minting needs it twice over — to read the moderators tree for the path, and as the call's
   * target — so the controls stay hidden rather than offering a button that cannot work.
   */
  readonly contractAddress: string | undefined
}

export function CircleInviteSection({circleId, contractAddress}: CircleInviteSectionProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const [minting, setMinting] = useState(false)
  const [code, setCode] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<ForumErrorKey | undefined>(undefined)

  const token = session?.token
  const forumRoot = session?.forumRoot

  /** Mint one invite and show it to the founder. The secret never leaves this device. */
  const mint = async () => {
    if (token === undefined || forumRoot === undefined || contractAddress === undefined) return
    setMinting(true)
    setError(undefined)
    setCopied(false)
    try {
      const secret = await Effect.runPromise(randomBytes(32))
      await submitDeviceSetInvite({
        token,
        forumRoot,
        contentCircleId: circleId,
        chainCircleId: circleIdFromContentId(circleId),
        circleContractAddress: contractAddress,
        secret,
      })
      // Held only in this component's state, never persisted: it is a capability, and the
      // shortest life we can give it is the life of this sheet.
      setCode(encodeCircleInvite(secret))
      logger.info('invite minted for the founder to share', {origin: ORIGIN, circleId})
    } catch (e) {
      logger.warn('minting an invite failed', {origin: ORIGIN, circleId, error: String(e)})
      setError(forumErrorKey(e))
    } finally {
      setMinting(false)
    }
  }

  if (contractAddress === undefined) {
    return (
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('forum.manage.inviteNeedsChain')}
      </Typography>
    )
  }

  return (
    <View style={styles.section}>
      <Typography variant="bodyMd_medium">{t('forum.manage.inviteTitle')}</Typography>
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('forum.manage.inviteHint')}
      </Typography>

      {code !== undefined && (
        <ChamferSurface size="auto" fillToken="backgroundAlternative" style={styles.codeBox}>
          {/* ⚠️ Stated, not implied: the chain holds a hash of this and it cannot be read back. */}
          <Typography variant="bodySm_regular" style={styles.warning}>
            {t('forum.manage.inviteShownOnce')}
          </Typography>
          <Typography variant="bodySm_regular" style={styles.code} selectable testID="circle-invite-code">
            {code}
          </Typography>
          <Button
            label={copied ? t('common.labels.copied') : t('common.buttons.copy')}
            variant="secondary"
            onPress={() => {
              void copyToClipboard(code).then(
                () => setCopied(true),
                (e: unknown) => logger.warn('could not copy the invite', {origin: ORIGIN, error: String(e)}),
              )
            }}
            fullWidth
            testID="circle-invite-copy"
          />
        </ChamferSurface>
      )}

      <Button
        label={t('forum.manage.inviteMint')}
        onPress={() => void mint()}
        isDisabled={minting || token === undefined || forumRoot === undefined}
        isLoading={minting}
        fullWidth
        testID="circle-invite-mint"
      />
      {error !== undefined && (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t(error)}
        </Typography>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  section: {
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
  codeBox: {
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing12,
  },
  code: {
    color: theme.colors.textDefault,
    fontFamily: 'monospace',
  },
}))
