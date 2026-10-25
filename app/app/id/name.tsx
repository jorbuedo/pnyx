/**
 * Claiming a name on chain — behind the `handles` flag.
 *
 * The screen is reached from the ID tab's name row, which already gates on the flag, so this is the
 * guard for a link that outlived the affordance: a saved route, or a build where the flag flipped off.
 * Redirects rather than renders an explanation, because there is nothing a user can do here while
 * the vertical is off.
 */
import {Redirect} from 'expo-router'
import {useFeatureFlag} from '../../src/hooks/useFeatureFlag'
import {ClaimNameScreen} from '../../src/screens/id/ClaimNameScreen'

export default function ClaimNameRoute() {
  return useFeatureFlag('handles') ? <ClaimNameScreen /> : <Redirect href="/id" />
}
