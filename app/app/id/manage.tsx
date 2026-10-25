/**
 * Managing held names — behind the `handles` flag. See `./name.tsx` for why the guard is here as
 * well as on the affordance that leads to it.
 */
import {Redirect} from 'expo-router'
import {useFeatureFlag} from '../../src/hooks/useFeatureFlag'
import {ManageNamesScreen} from '../../src/screens/id/ManageNamesScreen'

export default function ManageNamesRoute() {
  return useFeatureFlag('handles') ? <ManageNamesScreen /> : <Redirect href="/id" />
}
