/**
 * The display name for a connector `ChainType`.
 *
 * A `Record<ChainType, string>` rather than a lookup with a fallback: a chain added to the union
 * without a name here is a build error, where a fallback would render the raw wire value to a user —
 * which is what the connections list did before it was keyed by `ChainType`.
 *
 * @module
 */

import type {ChainType} from '@pnyx/dapp-connector'

export const CHAIN_TYPE_LABELS: Record<ChainType, string> = {cardano: 'Cardano', midnight: 'Midnight'}
