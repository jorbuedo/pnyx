/**
 * Bottom sheet for creating a community: name, description, join gate (open or
 * invite-only, both live), and the creator's "appear as" choice.
 *
 * @module
 */

import {useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../../logger'
import {useI18n, usePnyxSession} from '../../providers'
import {pnyxApi} from '../../services/pnyx-api'
import {type ForumErrorKey, forumErrorKey} from '../../services/pnyx-forum'
import {submitDeviceCircle} from '../../services/pnyx-proving'
import {Button} from '../Buttons'
import {ChamferBackground} from '../Chamfer'
import {Modal} from '../Modal'
import {RadioMark} from '../RadioMark'
import {TextArea} from '../TextArea'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'
import {type DisplayNameChoice, DisplayNamePicker, isChoiceValid, personaFromChoice} from './DisplayNamePicker'

export type CreateCommunitySheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
  /** Called with the new community id after a successful create. */
  readonly onCreated: (circleId: string) => void
}

export function CreateCommunitySheet({visible, onClose, onCreated}: CreateCommunitySheetProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [choice, setChoice] = useState<DisplayNameChoice>({mode: 'wallet', name: ''})
  // Sealed into the contract's address at creation, so it is chosen once here and never edited.
  const [isOpen, setIsOpen] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<ForumErrorKey | undefined>(undefined)

  const canSubmit = session !== undefined && name.trim().length > 0 && isChoiceValid(choice) && !isSubmitting

  const submit = async () => {
    if (!canSubmit || session === undefined) return
    setIsSubmitting(true)
    setError(undefined)
    // On-device proving iff the flag is on and we hold the anonymous-identity master. Unlike join,
    // there is no on-chain id to wait for first — createCircle mints it — so the only precondition is
    // being able to derive the creator's persona for the join that follows.
    const forumRootBytes = session.forumRoot
    // No server-side fallback: creating a circle is a deploy the device builds, and the service only
    // pays for it.
    const useDevice = forumRootBytes !== undefined
    try {
      const persona = personaFromChoice(choice)
      const {circle} = await pnyxApi.createCircle(session.token, {
        name: name.trim(),
        description: description.trim(),
        // Sent explicitly rather than left to the service's default: the same value is sealed into the
        // contract's address below, and the two must not be able to disagree.
        isOpen,
        ...(persona === undefined ? {} : {persona}),
      })
      if (useDevice && forumRootBytes !== undefined) {
        // Deliberately not awaited: the pair is deploy → wait for it to confirm on-chain → join, which
        // takes as long as two settlements. The user lands in the community immediately and the chain
        // badge follows, matching how join/vote/proposal already settle. A failure here leaves the
        // circle with no chain ref, which renders as "not on chain" rather than a lie.
        void submitDeviceCircle({
          token: session.token,
          forumRoot: forumRootBytes,
          contentCircleId: circle.id,
          isOpen,
        }).catch((e: unknown) => {
          logger.error('device-proven circle creation failed', {
            origin: 'CreateCommunitySheet',
            circleId: circle.id,
            cause: e,
          })
        })
      }
      setName('')
      setDescription('')
      setChoice({mode: 'wallet', name: ''})
      onCreated(circle.id)
    } catch (e) {
      setError(forumErrorKey(e))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('forum.create.title')}
      testID="create-community-sheet"
    >
      <View style={styles.content}>
        <TextInput
          value={name}
          onChange={setName}
          placeholder={t('forum.create.namePlaceholder')}
          fullWidth
          testID="create-community-name"
        />
        <TextArea
          value={description}
          onChange={setDescription}
          placeholder={t('forum.create.descriptionPlaceholder')}
          fullWidth
          testID="create-community-description"
        />
        <Typography variant="bodySm_medium" style={styles.sectionLabel}>
          {t('forum.create.gateLabel')}
        </Typography>
        <View style={styles.gateRow}>
          <Pressable
            onPress={() => setIsOpen(true)}
            accessibilityRole="radio"
            accessibilityState={{selected: isOpen}}
            accessibilityLabel={t('forum.create.gateOpen')}
            style={styles.gateOption}
            testID="create-community-gate-open"
          >
            <ChamferBackground
              size="auto"
              borderToken={isOpen ? 'primaryDefault' : 'borderDefaultWeak'}
              borderWidth={1}
            />
            <View style={styles.gateTitleRow}>
              <RadioMark selected={isOpen} />
              <Typography variant="bodyMd_medium">{t('forum.create.gateOpen')}</Typography>
            </View>
            <Typography variant="bodySm_regular" style={styles.gateDescription}>
              {t('forum.create.gateOpenDescription')}
            </Typography>
          </Pressable>
          <Pressable
            onPress={() => setIsOpen(false)}
            accessibilityRole="radio"
            accessibilityState={{selected: !isOpen}}
            accessibilityLabel={t('forum.create.gateInvite')}
            style={styles.gateOption}
            testID="create-community-gate-invite"
          >
            <ChamferBackground
              size="auto"
              borderToken={isOpen ? 'borderDefaultWeak' : 'primaryDefault'}
              borderWidth={1}
            />
            <View style={styles.gateTitleRow}>
              <RadioMark selected={!isOpen} />
              <Typography variant="bodyMd_medium">{t('forum.create.gateInvite')}</Typography>
            </View>
            <Typography variant="bodySm_regular" style={styles.gateDescription}>
              {t('forum.create.gateInviteDescription')}
            </Typography>
          </Pressable>
        </View>
        <DisplayNamePicker
          choice={choice}
          onChange={setChoice}
          identity={session?.identity}
          testID="create-community-display-name"
        />
        {error !== undefined && (
          <Typography variant="bodySm_regular" style={styles.error}>
            {t(error)}
          </Typography>
        )}
        <Button
          label={t('forum.home.create')}
          onPress={() => void submit()}
          isDisabled={!canSubmit}
          isLoading={isSubmitting}
          fullWidth
          testID="create-community-submit"
        />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing.spacing12,
  },
  sectionLabel: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  gateRow: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
  },
  gateOption: {
    flex: 1,
    gap: theme.spacing.spacing4,
    padding: theme.spacing.spacing12,
  },
  gateTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  gateDescription: {
    color: theme.colors.textAlternative,
  },
  error: {
    color: theme.colors.errorDefault,
  },
}))
