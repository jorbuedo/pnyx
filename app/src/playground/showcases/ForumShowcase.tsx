/**
 * Forum Showcase.
 *
 * Community / poll / message surfaces. The four sheets are visibility-driven, so
 * each has a button to open it rather than rendering inline.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../components/Buttons'
import {ChainBadge} from '../../components/forum/ChainBadge'
import {CreateCommunitySheet} from '../../components/forum/CreateCommunitySheet'
import {CreatePollSheet} from '../../components/forum/CreatePollSheet'
import {type DisplayNameChoice, DisplayNamePicker} from '../../components/forum/DisplayNamePicker'
import {JoinCommunitySheet} from '../../components/forum/JoinCommunitySheet'
import {MessageActionsSheet} from '../../components/forum/MessageActionsSheet'
import {PollCard} from '../../components/forum/PollCard'
import {SignInCard} from '../../components/forum/SignInCard'
import {MessageComposer} from '../../components/MessageComposer'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {fakeCircleRef, fakeOpenProposal, fakePendingProposal, fakePost, fakeVotedProposal} from '../data'

type OpenSheet = 'none' | 'create' | 'join' | 'poll' | 'actions'

/** Every forum fixture authors under a pseudonym, so no author here has a handle to resolve. */
const NO_HANDLES: ReadonlyMap<string, string> = new Map()

export const ForumShowcase = () => {
  const [open, setOpen] = useState<OpenSheet>('none')
  const [choice, setChoice] = useState<DisplayNameChoice>({mode: 'wallet', name: ''})
  const [message, setMessage] = useState('')
  const close = () => setOpen('none')

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Chain badge">
        <ShowcaseItem label="ChainBadge" inline>
          <ChainBadge chain={{status: 'pending'}} />
          <ChainBadge chain={{status: 'confirmed'}} />
          <ChainBadge chain={{status: 'failed', error: 'submit rejected'}} />
          <ChainBadge chain={null} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Poll card">
        <ShowcaseItem label="PollCard — open, member">
          <View style={styles.full}>
            <PollCard proposal={fakeOpenProposal} handles={NO_HANDLES} isMember isVoting={false} onVote={() => {}} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="PollCard — already voted">
          <View style={styles.full}>
            <PollCard proposal={fakeVotedProposal} handles={NO_HANDLES} isMember isVoting={false} onVote={() => {}} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="PollCard — not a member">
          <View style={styles.full}>
            <PollCard
              proposal={fakePendingProposal}
              handles={NO_HANDLES}
              isMember={false}
              isVoting={false}
              onVote={() => {}}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="PollCard — voting in flight">
          <View style={styles.full}>
            <PollCard proposal={fakeOpenProposal} handles={NO_HANDLES} isMember isVoting onVote={() => {}} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Identity & sign-in">
        <ShowcaseItem label="DisplayNamePicker">
          <View style={styles.full}>
            <DisplayNamePicker choice={choice} onChange={setChoice} identity="lyra" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="SignInCard">
          <View style={styles.full}>
            <SignInCard />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Composer">
        <ShowcaseItem label="MessageComposer">
          <View style={styles.full}>
            <MessageComposer
              value={message}
              onChangeText={setMessage}
              onSend={() => setMessage('')}
              placeholder="Message #treasury"
              sendLabel="Send"
              isSending={false}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="MessageComposer — sending">
          <View style={styles.full}>
            <MessageComposer
              value="Posting this one…"
              onChangeText={() => {}}
              onSend={() => {}}
              placeholder="Message #treasury"
              sendLabel="Send"
              isSending
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Sheets" description="Visibility-driven — open each to inspect it.">
        <ShowcaseItem label="CreateCommunitySheet">
          <Button label="Open CreateCommunitySheet" onPress={() => setOpen('create')} />
        </ShowcaseItem>
        <ShowcaseItem label="JoinCommunitySheet">
          <Button label="Open JoinCommunitySheet" onPress={() => setOpen('join')} />
        </ShowcaseItem>
        <ShowcaseItem label="CreatePollSheet">
          <Button label="Open CreatePollSheet" onPress={() => setOpen('poll')} />
        </ShowcaseItem>
        <ShowcaseItem label="MessageActionsSheet">
          <Button label="Open MessageActionsSheet" onPress={() => setOpen('actions')} />
        </ShowcaseItem>
      </ShowcaseSection>

      <CreateCommunitySheet visible={open === 'create'} onClose={close} onCreated={close} />
      {open === 'join' ? <JoinCommunitySheet circle={fakeCircleRef} onClose={close} onJoined={close} /> : null}
      <CreatePollSheet circleId={fakeCircleRef.id} visible={open === 'poll'} onClose={close} onCreated={close} />
      <MessageActionsSheet
        post={open === 'actions' ? fakePost : undefined}
        handles={NO_HANDLES}
        canReply
        onReply={close}
        onClose={close}
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  full: {
    width: '100%',
    gap: spacing.spacing8,
  },
}))
