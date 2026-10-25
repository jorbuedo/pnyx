/**
 * Browser route — the in-app dApp browser (multi-tab WebView host), pushed
 * full screen from the home rail's browser slot. On extension: nothing — the
 * extension has no WebView surface.
 */

import {StyleSheet} from 'react-native-unistyles'

import {DappBrowserScreen} from '../src/components/DappBrowser/DappBrowserScreen'
import {SafeAreaViewWrapper} from '../src/components/SafeAreaViewWrapper'
import {isExtension} from '../src/platform'
import {useDappBrowserState} from '../src/providers'

export default function BrowserRoute() {
  const {isInDapp} = useDappBrowserState()

  if (isExtension) {
    // Extension surface is not built yet — see the "Not yet mapped: Extension popup +
    // fullscreen layout for Browser" item in `product/STATUS.md`.
    return null
  }

  return (
    <SafeAreaViewWrapper style={styles.wrapper} edges={isInDapp ? ['top'] : ['top', 'bottom']} hasBottomMenu={false}>
      <DappBrowserScreen />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  wrapper: {flex: 1, backgroundColor: theme.colors.background},
}))
