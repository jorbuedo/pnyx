import {type Href, router} from 'expo-router'
import {Linking} from 'react-native'
import {logger} from '../logger'
import {isAllowedExternalLink} from '../services/allowed-links'
import {PushNavigationTarget} from '../services/notification-types'

/**
 * Push-tap navigation — Midnight-only shell.
 *
 * The funds surfaces are gone, so every legacy target that pointed at a removed
 * route now lands on the home screen. Forum-event navigation lands here in a
 * later phase (see docs/mobile-shell-plan.md phase 4).
 */
const navigationRouteMap: Record<PushNavigationTarget, Href | null> = {
  [PushNavigationTarget.Home]: '/community',
  [PushNavigationTarget.TransactionHistory]: '/community',
  [PushNavigationTarget.TransactionDetail]: '/community',
  [PushNavigationTarget.Portfolio]: '/community',
  [PushNavigationTarget.PortfolioAsset]: '/community',
  [PushNavigationTarget.Staking]: '/community',
  [PushNavigationTarget.StakingPool]: '/community',
  [PushNavigationTarget.Earn]: '/community',
  [PushNavigationTarget.Governance]: '/community',
  [PushNavigationTarget.GovernanceDrep]: '/community',
  [PushNavigationTarget.Swap]: '/community',
  [PushNavigationTarget.Tokens]: '/community',
  [PushNavigationTarget.TokenDetail]: '/community',
  [PushNavigationTarget.Nfts]: '/community',
  [PushNavigationTarget.NftDetail]: '/community',
  [PushNavigationTarget.Receive]: '/community',
  // The inbox, not a thread: the payload carries no conversation id, on purpose — see the service's
  // `notifications.ts`.
  [PushNavigationTarget.Dm]: '/community',
  [PushNavigationTarget.Notifications]: '/notifications',
  [PushNavigationTarget.Settings]: '/menu',
  [PushNavigationTarget.WalletManager]: '/settings/wallet-selection',
}

function navigateToTarget(target: PushNavigationTarget): void {
  const staticRoute = navigationRouteMap[target]

  logger.debug('[push-nav] navigateToTarget', {
    origin: 'push-notifications/tools',
    target,
    staticRoute,
  })

  if (staticRoute != null) {
    router.navigate(staticRoute)
    return
  }

  // Every target maps to a static route in this shell — nothing to do.
  logger.warn('[push-nav] target had no static route — tap is a no-op', {
    origin: 'push-notifications/tools',
    target,
  })
}

export function handlePushNavigation(data: Record<string, unknown>, navigation?: PushNavigationTarget): void {
  logger.debug('[push-nav] handlePushNavigation entry', {
    origin: 'push-notifications/tools',
    navigation,
    dataKeys: Object.keys(data),
    dataType: data.type,
    trigger: data.trigger,
    screen: data.screen,
    open_url: data.open_url,
  })

  if (typeof data.open_url === 'string') {
    if (isAllowedExternalLink(data.open_url)) {
      Linking.openURL(data.open_url).catch((e) => {
        logger.error('Failed to open notification URL', {origin: 'push-notifications/tools', cause: e})
      })
      return
    }
    logger.warn('Notification open_url dropped — not in allowedLinks', {
      origin: 'push-notifications/tools',
      open_url: data.open_url,
    })
  }

  if (navigation !== undefined) {
    navigateToTarget(navigation)
    return
  }

  if (data.screen !== undefined) {
    logger.warn('Unknown notification screen target', {
      origin: 'push-notifications/tools',
      screen: data.screen,
    })
    return
  }

  logger.warn('[push-nav] no navigation branch matched — tap is no-op', {
    origin: 'push-notifications/tools',
    dataKeys: Object.keys(data),
    dataType: data.type,
    trigger: data.trigger,
  })
}
