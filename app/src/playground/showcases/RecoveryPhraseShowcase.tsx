/**
 * Recovery Phrase Showcase.
 *
 * Recovery-phrase handling is two distinct flows built from small controlled
 * pieces, and the pieces were previously scattered across three categories.
 *
 *  - **Entry** (`app/onboarding/restore.tsx`) — state lives in
 *    `useRecoveryPhraseInput`; the screen maps it over `RecoveryWordCell`s.
 *  - **Verification** (`app/settings/backup-verification.tsx`) — the user
 *    re-selects the words in order.
 *
 * Every component here has exactly one consumer, which is why they are grouped
 * by flow rather than listed alphabetically.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {MnemonicDisplay} from '../../components/MnemonicDisplay'
import {SelectedWordsArea, WordSelectionArea} from '../../components/MnemonicVerification'
import {RecoveryPhraseStatus} from '../../components/onboarding/RecoveryPhraseStatus'
import {RecoveryWordCell} from '../../components/onboarding/RecoveryWordCell'
import {RecoveryWordCountSelector} from '../../components/onboarding/RecoveryWordCountSelector'
import {WordSuggestionBar} from '../../components/WordSuggestionBar'
import type {MnemonicWordCount} from '../../utils/mnemonic'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {fakeWordEntries} from '../data'

/** A real 12-word BIP-39 phrase — the display masks it, and it is not a funded wallet. */
const PHRASE = fakeWordEntries.map((e) => e.word).join(' ')

export const RecoveryPhraseShowcase = () => {
  const [wordCount, setWordCount] = useState<MnemonicWordCount>(24)
  const [word, setWord] = useState('abandon')
  const [selected, setSelected] = useState(fakeWordEntries.slice(0, 3))

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Entry — restore.tsx" description="Four pieces, all controlled by useRecoveryPhraseInput.">
        <ShowcaseItem label="RecoveryWordCountSelector">
          <View style={styles.full}>
            <RecoveryWordCountSelector wordCount={wordCount} onChange={setWordCount} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="RecoveryWordCell — valid and errored">
          <View style={styles.grid}>
            <RecoveryWordCell
              index={0}
              value={word}
              hasError={false}
              onChange={setWord}
              onFocus={() => {}}
              onBlur={() => {}}
              onSubmit={() => {}}
              onKeyPress={() => {}}
              registerRef={() => {}}
              testID="playground-word-0"
            />
            <RecoveryWordCell
              index={1}
              value="notaword"
              hasError
              onChange={() => {}}
              onFocus={() => {}}
              onBlur={() => {}}
              onSubmit={() => {}}
              onKeyPress={() => {}}
              registerRef={() => {}}
              testID="playground-word-1"
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="WordSuggestionBar">
          <View style={styles.full}>
            <WordSuggestionBar
              suggestions={['abandon', 'ability', 'able']}
              currentWord="ab"
              onSelectSuggestion={setWord}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="RecoveryPhraseStatus — cell error">
          <View style={styles.full}>
            <RecoveryPhraseStatus cellErrors={{1: 'invalidWord'}} submitError={null} pasteNotice={null} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="RecoveryPhraseStatus — bad checksum">
          <View style={styles.full}>
            <RecoveryPhraseStatus cellErrors={{}} submitError="invalidChecksum" pasteNotice={null} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="RecoveryPhraseStatus — paste notice">
          <View style={styles.full}>
            <RecoveryPhraseStatus cellErrors={{}} submitError={null} pasteNotice={{pasted: 24, accepted: 12}} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Verification — backup-verification.tsx"
        description="The user re-selects the words in order to prove they wrote the phrase down."
      >
        <ShowcaseItem label="MnemonicDisplay — masked">
          <View style={styles.full}>
            <MnemonicDisplay mnemonic={PHRASE} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="MnemonicDisplay — revealed">
          <View style={styles.full}>
            <MnemonicDisplay mnemonic={PHRASE} initiallyRevealed />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="SelectedWordsArea">
          <View style={styles.full}>
            <SelectedWordsArea
              selectedEntries={selected}
              expectedOrder={fakeWordEntries}
              onRemoveLast={() => setSelected((prev) => prev.slice(0, -1))}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="WordSelectionArea">
          <View style={styles.full}>
            <WordSelectionArea
              shuffledEntries={fakeWordEntries}
              selectedEntries={selected}
              expectedOrder={fakeWordEntries}
              onSelectWord={(entry) => setSelected((prev) => [...prev, entry])}
              onReplaceLastWord={(entry) => setSelected((prev) => [...prev.slice(0, -1), entry])}
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
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
  grid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.spacing8,
  },
}))
