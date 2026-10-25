/**
 * Dev Showcase.
 *
 * Developer-only surfaces. These are the ones that keep their hardcoded hex on
 * purpose — they are meant to be unmistakable rather than on-brand, and none of
 * them ships in a release build.
 *
 * @module
 */

import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {DevDbDumpButton} from '../../components/DevDbDumpButton'
import {DevLogsView} from '../../components/DevLogsView'
import {DevModeToggle} from '../../components/DevModeToggle'
import {MaintenanceTakeover} from '../../components/MaintenanceTakeover'
import {UpdateOverlay} from '../../components/UpdateOverlay'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const DevShowcase = () => {
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <ShowcaseSection title="Toggles & buttons">
          <ShowcaseItem label="DevModeToggle — a transparent 5-tap target, so nothing to see">
            <View style={styles.full}>
              <DevModeToggle />
            </View>
          </ShowcaseItem>
          <ShowcaseItem label="DevDbDumpButton">
            <View style={styles.fabHost}>
              <DevDbDumpButton />
            </View>
          </ShowcaseItem>
        </ShowcaseSection>

        <ShowcaseSection title="Full-screen takeovers" description="Normally cover the whole app; bounded here.">
          <ShowcaseItem label="UpdateOverlay">
            <View style={styles.tall}>
              <UpdateOverlay />
            </View>
          </ShowcaseItem>
          <ShowcaseItem label="MaintenanceTakeover">
            <View style={styles.tall}>
              <MaintenanceTakeover />
            </View>
          </ShowcaseItem>
        </ShowcaseSection>
      </ScrollView>

      {/* Outside the ScrollView: DevLogsView is a FlatList, and a virtualized list
          inside a same-orientation ScrollView fights it for the scroll gesture. */}
      <ShowcaseSection title="Log viewer" description="The Settings → Dev → Logs surface.">
        <ShowcaseItem label="DevLogsView">
          <View style={styles.tall}>
            <DevLogsView />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing, borderRadius}) => ({
  container: {
    flex: 1,
    gap: spacing.spacing24,
    paddingBottom: spacing.spacing16,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  full: {
    width: '100%',
    gap: spacing.spacing8,
  },
  fabHost: {
    // The FAB anchors itself 212 from the bottom, so a short host puts it out of view.
    width: '100%',
    height: 280,
    borderRadius: borderRadius.rounded12,
    borderWidth: 1,
    borderColor: colors.borderDefaultWeak,
  },
  tall: {
    width: '100%',
    height: 320,
    borderRadius: borderRadius.rounded12,
    borderWidth: 1,
    borderColor: colors.borderDefaultWeak,
    overflow: 'hidden',
  },
}))
