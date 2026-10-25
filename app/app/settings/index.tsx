/**
 * `/settings` (bare) — the hub moved to the Menu tab; redirect there. Detail
 * screens still live under `/settings/*` and are pushed over the tabs.
 * See docs/mobile-shell-plan.md phase 6, product/STATUS.md nav reshape.
 *
 * @module
 */

import {Redirect} from 'expo-router'

export default function SettingsIndexRedirect() {
  return <Redirect href="/menu" />
}
