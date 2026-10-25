/**
 * About Pnyx — what this is, and what it is not yet.
 *
 * A rail destination rather than a community pane: none of it is about the selected circle, and
 * repeating it per circle would make the preprod warning look like a property of one community
 * instead of the whole deployment.
 *
 * ⚠️ **The callout is the reason this screen exists.** Everything here runs on Midnight preprod and
 * none of it migrates — a user who writes a month of posts and then loses them was misled by the
 * absence of this, not by anything the app said. It is deliberately not dismissible: it stays true
 * for as long as the deployment does.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Callout} from '../../components/Callout'
import {FaqSection} from '../../components/FaqSection'
import {Typography} from '../../components/Typography'
import {useI18n} from '../../providers'

/**
 * The question ids, in the order they read.
 *
 * Ids rather than indices because `FaqSection` tracks which panel is open by id, and a reordering
 * that silently moved the open panel would be the kind of bug nobody reports.
 */
const FAQ_IDS = ['whatIsCircle', 'onChain', 'persona', 'ban', 'invite', 'data'] as const

export function InfoPanel() {
  const {t} = useI18n()
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Typography variant="headingSm" numberOfLines={1}>
          {t('forum.info.title')}
        </Typography>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Callout variant="warning" message={t('forum.info.preprodCallout')} testID="info-preprod-callout" />
        <FaqSection
          title={t('forum.info.faqTitle')}
          entries={FAQ_IDS.map((id) => ({
            id,
            question: t(`forum.info.faq.${id}Q`),
            answer: t(`forum.info.faq.${id}A`),
          }))}
          testID="info-faq"
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    flex: 1,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  content: {
    padding: theme.spacing.spacing12,
    gap: theme.spacing.spacing16,
  },
}))
