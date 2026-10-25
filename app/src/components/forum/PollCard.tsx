/**
 * Poll card — a community proposal with its yes/no tally, chain badges, and
 * one-shot vote buttons for members.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import {authorLabel} from '../../services/author-label'
import type {Proposal} from '../../services/pnyx-api'
import {yesShare} from '../../services/pnyx-forum'
import {Button} from '../Buttons'
import {Card} from '../Card'
import {Typography} from '../Typography'
import {ChainBadge} from './ChainBadge'

export type PollCardProps = {
  readonly proposal: Proposal
  /** Handles for the list's authors, resolved once by the screen. Absent → the id shows. */
  readonly handles: ReadonlyMap<string, string>
  readonly isMember: boolean
  readonly isVoting: boolean
  readonly onVote: (value: 'yes' | 'no') => void
}

export function PollCard({proposal, handles, isMember, isVoting, onVote}: PollCardProps) {
  const {t} = useI18n()
  const share = yesShare(proposal.tally)

  return (
    <Card variant="outlined" style={styles.card} testID={`poll-${proposal.id}`}>
      <View style={styles.content}>
        <Typography variant="bodyMd_medium">{proposal.title}</Typography>
        {proposal.body.length > 0 && (
          <Typography variant="bodySm_regular" style={styles.body}>
            {proposal.body}
          </Typography>
        )}
        <Typography variant="bodyXs_regular" style={styles.meta}>
          {authorLabel(proposal.author, handles)}
        </Typography>
        <View style={styles.tallyTrack}>
          <View style={[styles.tallyFill, {width: `${Math.round(share * 100)}%`}]} />
        </View>
        <Typography variant="bodyXs_regular" style={styles.meta}>
          {t('forum.polls.tally', {yes: proposal.tally.yes, no: proposal.tally.no})}
        </Typography>
        <View style={styles.badges}>
          <ChainBadge chain={proposal.chain} />
          <ChainBadge chain={proposal.myVoteChain} prefix={t('forum.polls.yourVote')} />
        </View>
        {isMember && proposal.hasVoted !== true && (
          <View style={styles.voteRow}>
            <Button
              label={t('forum.polls.yes')}
              size="sm"
              onPress={() => onVote('yes')}
              isDisabled={isVoting}
              containerStyles={styles.voteButton}
              testID={`poll-${proposal.id}-yes`}
            />
            <Button
              label={t('forum.polls.no')}
              size="sm"
              variant="secondary"
              onPress={() => onVote('no')}
              isDisabled={isVoting}
              containerStyles={styles.voteButton}
              testID={`poll-${proposal.id}-no`}
            />
          </View>
        )}
        {isMember && proposal.hasVoted === true && (
          <Typography variant="bodyXs_regular" style={styles.meta}>
            {t('forum.polls.voted')}
          </Typography>
        )}
        {!isMember && (
          <Typography variant="bodyXs_regular" style={styles.meta}>
            {t('forum.polls.joinToVote')}
          </Typography>
        )}
      </View>
    </Card>
  )
}

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing.spacing12,
  },
  content: {
    gap: theme.spacing.spacing8,
  },
  body: {
    color: theme.colors.textAlternative,
  },
  meta: {
    color: theme.colors.textMuted,
  },
  tallyTrack: {
    height: 8,
    borderRadius: theme.borderRadius.rounded4,
    backgroundColor: theme.colors.backgroundAlternative,
    overflow: 'hidden',
  },
  tallyFill: {
    height: 8,
    backgroundColor: theme.colors.successDefault,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
  },
  voteRow: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
  },
  voteButton: {
    flex: 1,
  },
}))
