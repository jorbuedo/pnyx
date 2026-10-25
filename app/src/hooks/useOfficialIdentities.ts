/**
 * The accounts we vouch for, from remote config.
 *
 * Decoded and memoised here so every surface asking "is this one of ours?" shares one answer and one
 * parse. See {@link module:../services/official-identity} for why this is keyed on `pnyx_id` and
 * never on a name.
 *
 * @module
 */

import {useMemo} from 'react'
import {useRemoteConfig} from '../providers/ConfigProvider'
import {type OfficialIdentities, readOfficialIdentities} from '../services/official-identity'

export const useOfficialIdentities = (): OfficialIdentities => {
  const {remoteConfig} = useRemoteConfig()
  const official = remoteConfig?.official
  return useMemo(() => readOfficialIdentities(official), [official])
}
