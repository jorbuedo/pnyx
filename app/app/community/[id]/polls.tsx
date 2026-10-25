/**
 * Polls screen — the community's polls as a full-screen pushed route, opened
 * from the POLLS category in the home channel panel. Tally bars and voting
 * come from PollCard; members can create new polls.
 */

import {circleIdFromContentId} from '@pnyx/contract-client/circle-id'
import {Stack, useLocalSearchParams} from 'expo-router'
import {useState} from 'react'
import {FlatList, Pressable, RefreshControl} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {CreatePollSheet} from '../../../src/components/forum/CreatePollSheet'
import {PollCard} from '../../../src/components/forum/PollCard'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {useAuthorHandles} from '../../../src/hooks/useAuthorHandles'
import {useCommunityView} from '../../../src/hooks/useCommunityView'
import {logger} from '../../../src/logger'
import {useI18n, usePnyxSession} from '../../../src/providers'
import {pnyxApi} from '../../../src/services/pnyx-api'
import {submitDeviceVote} from '../../../src/services/pnyx-proving'

export default function PollsScreen() {
  const {id} = useLocalSearchParams<{id: string}>()
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const {view, error, isLoading, refresh} = useCommunityView(id)
  const [pollSheetVisible, setPollSheetVisible] = useState(false)
  const [votingId, setVotingId] = useState<string | undefined>(undefined)

  const member = view?.membership ?? null
  const proposals = view?.proposals ?? []
  const handles = useAuthorHandles(proposals.map((p) => p.author))

  const vote = (proposalId: string, value: 'yes' | 'no') => {
    if (session === undefined || view === undefined) return
    setVotingId(proposalId)
    const token = session.token
    const root = session.forumRoot
    const proposal = view.proposals.find((p) => p.id === proposalId)
    // Device proving needs the circle's contract address, the proposal's own contract address, and
    // the transaction that deployed it — that last one is what pins the electorate, since the
    // proposal sealed the members root as it stood in that block.
    const circleAddress = view.circle.chain?.status === 'confirmed' ? view.circle.chain.chainId : undefined
    const proposalChain = proposal?.chain?.status === 'confirmed' ? proposal.chain : undefined
    const proposalAddress = proposalChain?.chainId
    const proposalDeployTx = proposalChain?.txId
    // No server-side fallback: the service cannot prove a vote, only submit one this device proved.
    void (async () => {
      try {
        await pnyxApi.vote(token, proposalId, value)
        if (
          root !== undefined &&
          circleAddress !== undefined &&
          proposalAddress !== undefined &&
          proposalDeployTx !== undefined
        ) {
          await submitDeviceVote({
            token,
            forumRoot: root,
            contentCircleId: view.circle.id,
            chainCircleId: circleIdFromContentId(view.circle.id),
            circleContractAddress: circleAddress,
            proposalContractAddress: proposalAddress,
            proposalDeployTxHash: proposalDeployTx,
            contentProposalId: proposalId,
            value,
          })
          logger.info('device-proven vote committed', {origin: 'polls', proposalId})
        } else {
          // Not an error: a proposal whose deploy has not settled yet has no electorate to prove
          // against. Logged so "the tally moved but nothing went on chain" is visible.
          logger.debug('vote stayed in the content plane; the proposal is not settled on chain', {
            origin: 'polls',
            proposalId,
            hasCircle: circleAddress !== undefined,
            hasProposal: proposalAddress !== undefined,
            hasDeployTx: proposalDeployTx !== undefined,
          })
        }
      } catch (e) {
        logger.error('vote failed', {origin: 'polls', error: String(e)})
      } finally {
        refresh()
        setVotingId(undefined)
      }
    })()
  }

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']} noPadding>
      <Stack.Screen options={{title: t('forum.community.polls')}} />
      <FlatList
        data={proposals}
        keyExtractor={(p) => p.id}
        renderItem={({item}) => (
          <PollCard
            proposal={item}
            handles={handles}
            isMember={member !== null}
            isVoting={votingId === item.id}
            onVote={(value) => vote(item.id, value)}
          />
        )}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refresh} />}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          error !== undefined && view === undefined ? (
            <Typography variant="bodySm_regular" style={styles.error} testID="polls-error">
              {t('forum.community.notFound')}
            </Typography>
          ) : view !== undefined && member !== null ? (
            <Pressable onPress={() => setPollSheetVisible(true)} hitSlop={8} style={styles.newPoll} testID="polls-new">
              <Typography variant="bodySm_medium" style={styles.newPollLabel}>
                {t('forum.polls.new')}
              </Typography>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          view !== undefined ? (
            <Typography variant="bodySm_regular" style={styles.empty} testID="polls-empty">
              {t('forum.polls.empty')}
            </Typography>
          ) : null
        }
      />

      {view !== undefined && (
        <CreatePollSheet
          circleId={view.circle.id}
          chainCircleId={view.circle.chain?.status === 'confirmed' ? view.circle.chain.chainId : undefined}
          visible={pollSheetVisible}
          onClose={() => setPollSheetVisible(false)}
          onCreated={() => {
            setPollSheetVisible(false)
            refresh()
          }}
        />
      )}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
    gap: theme.spacing.spacing12,
  },
  error: {
    color: theme.colors.errorDefault,
  },
  newPoll: {
    alignSelf: 'flex-end',
  },
  newPollLabel: {
    color: theme.colors.primaryDefault,
  },
  empty: {
    color: theme.colors.textMuted,
  },
}))
