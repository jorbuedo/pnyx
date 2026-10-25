/**
 * Channel panel — the right zone of the home layout, showing the selected
 * community. Members get the channel list in collapsible category groups
 * (#general under CHANNELS, polls under POLLS); non-members get the community
 * description with the join flow; signed-out users get the SIWM sign-in card.
 *
 * @module
 */

import {router} from 'expo-router'
import {useState} from 'react'
import {Pressable, RefreshControl, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {ChamferBackground} from '../../components/Chamfer'
import {EmptyState} from '../../components/EmptyState'
import {ChainBadge} from '../../components/forum/ChainBadge'
import {ChannelSheet} from '../../components/forum/ChannelSheet'
import {CircleRequirements} from '../../components/forum/CircleRequirements'
import {JoinCommunitySheet} from '../../components/forum/JoinCommunitySheet'
import {ManageCircleSheet} from '../../components/forum/ManageCircleSheet'
import {SignInCard} from '../../components/forum/SignInCard'
import {SkeletonBase} from '../../components/Loaders/Skeleton'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {useCircleInvitePolicy} from '../../hooks/useCircleInvitePolicy'
import {useCommunityView} from '../../hooks/useCommunityView'
import {logger} from '../../logger'
import {useI18n, usePnyxSession} from '../../providers'
import type {Circle} from '../../services/pnyx-api'
import {submitDeviceCircle} from '../../services/pnyx-proving'
import {CommunityInfoSheet} from './CommunityInfoSheet'
import {canRetryCircleDeploy} from './chain-retry'
import {emptyPanelBody} from './empty-panel-body'

export type ChannelPanelProps = {
  /** The rail's selected community; undefined when none exist / none picked. */
  readonly circle: Circle | undefined
  /** Whether the community list itself failed to load. */
  readonly listError: boolean
  /** Refreshes the rail's joined-state after a membership change. */
  readonly onMembershipChanged: () => void
}

/**
 * A collapsible section label, with an optional action on the right.
 *
 * ⚠️ The action is a **sibling** of the toggle, not a child of it. Adding "new channel" as another
 * `ChannelRow` read as a channel *called* "New channel" — same icon, same shape, same place in the
 * list — so it belongs on the header where the section's own affordances live.
 */
function CategoryHeader({
  label,
  isCollapsed,
  onToggle,
  testID,
  action,
}: {
  readonly label: string
  readonly isCollapsed: boolean
  readonly onToggle: () => void
  readonly testID: string
  readonly action?: {readonly label: string; readonly onPress: () => void; readonly testID: string}
}) {
  return (
    <View style={styles.categoryHeaderRow}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{expanded: !isCollapsed}}
        style={styles.categoryHeader}
        testID={testID}
      >
        <UniIcon
          name={isCollapsed ? 'rightThin' : 'downThin'}
          size="xs"
          uniProps={(theme) => ({color: theme.colors.textMuted})}
        />
        <Typography variant="bodyXs_medium" style={styles.categoryLabel}>
          {label.toUpperCase()}
        </Typography>
      </Pressable>
      {action !== undefined && (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={12}
          style={styles.categoryAction}
          testID={action.testID}
        >
          <UniIcon name="plus" size="xs" uniProps={(theme) => ({color: theme.colors.textMuted})} />
        </Pressable>
      )}
    </View>
  )
}

export function ChannelRow({
  name,
  description,
  onPress,
  testID,
}: {
  readonly name: string
  readonly description: string
  readonly onPress: () => void
  readonly testID: string
}) {
  const [isPressed, setIsPressed] = useState(false)

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setIsPressed(true)}
      onPressOut={() => setIsPressed(false)}
      style={styles.channelRow}
      testID={testID}
    >
      {isPressed && <ChamferBackground size="auto" fillToken="backgroundHover" />}
      <UniIcon name="hash" size="sm" uniProps={(theme) => ({color: theme.colors.textMuted})} />
      <View style={styles.channelBody}>
        <Typography variant="bodyMd_medium">{name}</Typography>
        {/* Omitted rather than rendered empty: an empty line still reserves its height, which left the
            title sitting high against the hash icon instead of centred. */}
        {description.length > 0 && (
          <Typography variant="bodyXs_regular" style={styles.channelDescription} numberOfLines={1}>
            {description}
          </Typography>
        )}
      </View>
    </Pressable>
  )
}

export function ChannelPanel({circle, listError, onMembershipChanged}: ChannelPanelProps) {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const {view, isLoading, refresh} = useCommunityView(circle?.id)
  // Only a gated circle asks anything, and only someone outside it needs to know before joining.
  const invitePolicy = useCircleInvitePolicy(circle?.id, circle?.isOpen === false)
  const [channelSheetVisible, setChannelSheetVisible] = useState(false)
  const [manageVisible, setManageVisible] = useState(false)
  // Only the founder may create a channel, and the service refuses anyone else — so the affordance is
  // shown to exactly whom it will work for rather than failing after the tap.
  const isFounder = view !== undefined && view.membership !== null && view.membership.persona === view.circle.author
  const [infoVisible, setInfoVisible] = useState(false)
  const [joinVisible, setJoinVisible] = useState(false)
  const [channelsCollapsed, setChannelsCollapsed] = useState(false)
  const [headerPressed, setHeaderPressed] = useState(false)
  const [pollsCollapsed, setPollsCollapsed] = useState(false)
  const [isRetryingChain, setIsRetryingChain] = useState(false)

  const member = view?.membership ?? null
  const isMember = session !== undefined && member !== null

  /**
   * The settlement to render, preferring the view's own copy.
   *
   * The `circle` prop is the rail's list entry, fetched once — so a deploy that settles after the
   * circle was created leaves it saying nothing until the app restarts. `useCommunityView` refreshes
   * on focus, on socket (re)connect and on every signal for this circle, so its copy is the live one.
   * Guarded on the id because `view` still holds the previous community for the fetch after a switch.
   */
  const chain = view !== undefined && view.circle.id === circle?.id ? view.circle.chain : circle?.chain

  const canRetryChain = canRetryCircleDeploy({
    isFounder,
    status: chain?.status,
    hasForumRoot: session?.forumRoot !== undefined,
    isRetrying: isRetryingChain,
  })

  const retryChainDeploy = () => {
    const forumRoot = session?.forumRoot
    if (!canRetryChain || circle === undefined || session === undefined || forumRoot === undefined) return
    setIsRetryingChain(true)
    // Not awaited, matching how the create sheet fires it: deploy → wait for confirmation → join is
    // two settlements, and the badge already reports the state the service is publishing.
    submitDeviceCircle({
      token: session.token,
      forumRoot,
      contentCircleId: circle.id,
      // Fixed at creation — `isOpen` feeds the contract address, so a retry has to reproduce it.
      isOpen: true,
    })
      .catch((e: unknown) => {
        logger.error('retrying the circle deploy failed', {
          origin: 'ChannelPanel',
          circleId: circle.id,
          cause: e,
        })
      })
      .finally(() => {
        setIsRetryingChain(false)
        refresh()
        onMembershipChanged()
      })
  }

  if (circle === undefined) {
    // Which of the three bodies goes under the sign-in card; see empty-panel-body.ts for the rule.
    const body = emptyPanelBody({listError, signedIn: session !== undefined})
    return (
      <View style={styles.panel}>
        <ChamferBackground size="auto" fillToken="backgroundAlternative" />
        <View style={styles.emptyPanel}>
          {session === undefined && <SignInCard testID="panel-sign-in" />}
          {body === 'error' && (
            <Typography variant="bodySm_regular" style={styles.error} testID="panel-error">
              {t('forum.home.unreachable')}
            </Typography>
          )}
          {body === 'empty' && (
            <EmptyState
              icon="community"
              title={t('forum.home.emptyTitle')}
              description={t('forum.home.emptyDescription')}
              testID="panel-empty"
            />
          )}
        </View>
      </View>
    )
  }

  return (
    <View style={styles.panel}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => setInfoVisible(true)}
          accessibilityRole="button"
          accessibilityLabel={t('forum.community.info')}
          onPressIn={() => setHeaderPressed(true)}
          onPressOut={() => setHeaderPressed(false)}
          style={styles.header}
          testID="panel-header"
        >
          {headerPressed && <ChamferBackground size="auto" fillToken="backgroundHover" />}
          <Typography variant="headingSm" numberOfLines={1}>
            {circle.name}
          </Typography>
          <View style={styles.headerMeta}>
            <Typography variant="bodyXs_regular" style={styles.meta}>
              {t('forum.home.members', {count: circle.memberCount})}
            </Typography>
            <ChainBadge
              chain={isRetryingChain ? {status: 'pending'} : chain}
              template={circle.template}
              {...(canRetryChain ? {onPress: retryChainDeploy, pressLabel: t('forum.chain.retry')} : {})}
              testID="panel-chain-badge"
            />
          </View>
        </Pressable>
        {/* A sibling of the info press, not nested inside it — a button within a button gives the
            outer one the tap as well, and the info sheet would open behind this one. */}
        {isFounder && (
          <Pressable
            onPress={() => setManageVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t('forum.manage.action')}
            hitSlop={12}
            style={styles.headerAction}
            testID="panel-manage"
          >
            <UniIcon name="settings" size="sm" uniProps={(theme) => ({color: theme.colors.textMuted})} />
          </Pressable>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refresh} />}
        showsVerticalScrollIndicator={false}
      >
        {isMember ? (
          <>
            <CategoryHeader
              label={t('forum.community.channels')}
              isCollapsed={channelsCollapsed}
              onToggle={() => setChannelsCollapsed((collapsed) => !collapsed)}
              testID="panel-category-channels"
              {...(isFounder
                ? {
                    action: {
                      label: t('forum.channels.addAccessibilityLabel'),
                      onPress: () => setChannelSheetVisible(true),
                      testID: 'panel-channel-new',
                    },
                  }
                : {})}
            />
            {!channelsCollapsed && (
              <>
                <ChannelRow
                  name={t('forum.community.general')}
                  description={t('forum.community.generalDescription')}
                  onPress={() => router.push(`/community/${circle.id}/general`)}
                  testID="panel-channel-general"
                />
                {(view?.channels ?? [])
                  // `general` is already the default stream's row above; a channel actually named that
                  // would otherwise draw twice and the two would disagree about which posts they hold.
                  .filter((channel) => channel.name !== 'general')
                  .map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      name={channel.name}
                      // Its own description, or nothing. Repeating the default stream's line here
                      // described every channel as community-wide discussion, which most are not.
                      description={channel.description ?? ''}
                      onPress={() => router.push(`/community/${circle.id}/${channel.name}`)}
                      testID={`panel-channel-${channel.name}`}
                    />
                  ))}
              </>
            )}
            <CategoryHeader
              label={t('forum.community.polls')}
              isCollapsed={pollsCollapsed}
              onToggle={() => setPollsCollapsed((collapsed) => !collapsed)}
              testID="panel-category-polls"
            />
            {!pollsCollapsed && (
              <ChannelRow
                name={t('forum.community.pollsEntry')}
                description={t('forum.community.pollsDescription')}
                onPress={() => router.push(`/community/${circle.id}/polls`)}
                testID="panel-channel-polls"
              />
            )}
          </>
        ) : session !== undefined && view === undefined ? (
          // Signed in but membership hasn't resolved yet — show skeleton channel
          // rows, NOT the join gate (a real member would otherwise see a wrong
          // "Join" affordance flash before `view` confirms membership).
          <View testID="panel-loading">
            {[0, 1].map((g) => (
              <View key={g}>
                <View style={styles.categoryHeader}>
                  <SkeletonBase show width={64} height={10} radius={4} />
                </View>
                <View style={styles.channelRow}>
                  <SkeletonBase show width={16} height={16} radius={4} />
                  <View style={styles.channelBody}>
                    <SkeletonBase show width={96} height={14} radius={6} />
                    <SkeletonBase show width={150} height={10} radius={4} />
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.joinGate}>
            {circle.description.length > 0 && (
              <Typography variant="bodySm_regular" style={styles.description}>
                {circle.description}
              </Typography>
            )}
            {session === undefined ? (
              <SignInCard testID="panel-sign-in" />
            ) : (
              <View style={styles.joinPrompt}>
                {/* Before the tap, not only inside the sheet: a gated circle is browsable, so this
                    is where someone decides whether they have a wallet worth trying. */}
                <CircleRequirements rules={invitePolicy.rules} testID="panel-requirements" />
                <ChamferBackground size="auto" borderToken="borderDefaultWeak" />
                <Typography variant="bodySm_regular" style={styles.meta}>
                  {t('forum.community.joinPrompt')}
                </Typography>
                <Button
                  label={t('forum.home.join')}
                  onPress={() => setJoinVisible(true)}
                  fullWidth
                  testID="panel-join"
                />
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <ManageCircleSheet
        circleId={circle.id}
        isOpen={circle.isOpen}
        // ⚠️ `chain`, not `circle.chain` — the same live-vs-stale distinction the badge above makes,
        // and this line had the stale side. The rail's list entry is fetched once, so a circle whose
        // deploy settled in this session reported "not on chain yet" *while the badge beside it said
        // On-chain*, and every invite control stayed hidden until the app restarted.
        contractAddress={chain?.status === 'confirmed' ? chain.chainId : undefined}
        displayChar={view?.circle.displayChar}
        visible={manageVisible}
        onClose={() => setManageVisible(false)}
        onChanged={() => {
          refresh()
          onMembershipChanged()
        }}
      />
      <ChannelSheet
        circleId={circle.id}
        visible={channelSheetVisible}
        onClose={() => setChannelSheetVisible(false)}
        onSaved={refresh}
      />
      <CommunityInfoSheet
        circle={view?.circle ?? circle}
        membership={member}
        // ⚠️ `chain`, not `circle.chain` — the live read, for the same reason the manage sheet takes
        // it: a deploy that settled this session is still `pending` on the rail's fetched-once entry,
        // and a leave routed on that would drop the row while the leaf stayed.
        contractAddress={chain?.status === 'confirmed' ? chain.chainId : undefined}
        visible={infoVisible}
        onClose={() => setInfoVisible(false)}
        onLeft={() => {
          refresh()
          onMembershipChanged()
        }}
      />
      <JoinCommunitySheet
        circle={joinVisible ? {id: circle.id, name: circle.name, isOpen: circle.isOpen} : undefined}
        chainCircleId={circle.chain?.status === 'confirmed' ? circle.chain.chainId : undefined}
        onClose={() => setJoinVisible(false)}
        onJoined={() => {
          setJoinVisible(false)
          refresh()
          onMembershipChanged()
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    flex: 1,
    overflow: 'hidden',
  },
  emptyPanel: {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
  },
  error: {
    color: theme.colors.errorDefault,
    textAlign: 'center',
  },
  header: {
    // Takes the row so the info press still spans everything the action does not use.
    flex: 1,
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
    gap: theme.spacing.spacing4,
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
  },
  meta: {
    color: theme.colors.textMuted,
  },
  description: {
    color: theme.colors.textAlternative,
  },
  scrollContent: {
    padding: theme.spacing.spacing8,
    gap: theme.spacing.spacing4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // The rule belongs to the row, not to the title block: left on `header` it stopped short of the
    // manage button and read as an underline under the name.
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  headerAction: {
    paddingHorizontal: theme.spacing.spacing12,
  },
  categoryHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  categoryHeader: {
    // Takes the row so the label's tap target still spans the width the action does not use.
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing4,
    paddingHorizontal: theme.spacing.spacing8,
    paddingTop: theme.spacing.spacing12,
    paddingBottom: theme.spacing.spacing4,
  },
  categoryAction: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingTop: theme.spacing.spacing12,
    paddingBottom: theme.spacing.spacing4,
  },
  categoryLabel: {
    color: theme.colors.textMuted,
    letterSpacing: 0.8,
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing8,
  },
  channelBody: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  channelDescription: {
    color: theme.colors.textMuted,
  },
  joinGate: {
    padding: theme.spacing.spacing8,
    gap: theme.spacing.spacing12,
  },
  joinPrompt: {
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing12,
  },
}))
