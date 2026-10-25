/**
 * A section of questions and answers, as accordions.
 *
 * One component rather than one per screen: this shape was written for the name
 * claim screen and the shared-wallet hub needs exactly the same thing, and two
 * copies would drift in padding, in text colour, and in whether more than one
 * panel can be open.
 *
 * One open at a time — an accordion where every panel can be open is a wall of
 * text with chevrons in it.
 *
 * @module
 */

import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Accordion} from './Accordion'
import {Card} from './Card'
import {SectionHeader} from './SectionHeader'
import {Typography} from './Typography'

const styles = StyleSheet.create((theme) => ({
  section: {width: '100%'},
  card: {width: '100%', gap: theme.spacing.spacing8, padding: theme.spacing.spacing16},
  answer: {color: theme.colors.textAlternative},
}))

export type FaqEntry = {
  /** Stable across renders — it is what "which one is open" is tracked by. */
  readonly id: string
  readonly question: string
  readonly answer: string
}

export type FaqSectionProps = {
  readonly title: string
  readonly entries: readonly FaqEntry[]
  /** Prefix for the per-question testIDs, which become `<testID>-<entry id>`. */
  readonly testID?: string | undefined
}

export const FaqSection = ({title, entries, testID}: FaqSectionProps) => {
  const [open, setOpen] = useState<string | undefined>(undefined)

  return (
    <View style={styles.section} testID={testID}>
      <SectionHeader title={title} />
      <Card style={styles.card}>
        {entries.map((entry) => (
          <Accordion
            key={entry.id}
            title={entry.question}
            spacing="compact"
            isExpanded={open === entry.id}
            onExpandedChange={(expanded) => setOpen(expanded ? entry.id : undefined)}
            {...(testID === undefined ? {} : {testID: `${testID}-${entry.id}`})}
          >
            <Typography variant="bodySm_regular" style={styles.answer}>
              {entry.answer}
            </Typography>
          </Accordion>
        ))}
      </Card>
    </View>
  )
}
