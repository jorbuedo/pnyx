/**
 * Which review warnings are definitional for a DUST registration operation, and so carry no
 * information as alarms.
 *
 * A registration *is* a mint — the auth token is the registration — and a script call; a spend of one
 * always takes a validator-held input that is not ours; and the fee looks disproportionate only because
 * the ratio test measures fee against value sent while these send almost nothing, the min-ADA at the
 * validator being a reclaimable deposit rather than a payment. The fee itself is still on screen in its
 * own row, and anything unexpected still warns.
 *
 * ⚠️ **One set covers every leg of a ceremony**, so a multi-leg operation needs the union of what its
 * legs raise — see `changeDestination` below. Getting that wrong does not fail a transaction; it warns
 * the user about the very thing they asked for, on the screen where they are deciding whether the
 * review can be trusted at all.
 *
 * Pure and its own module so it can be tested without the hook's React chain.
 *
 * @module
 */

import type {TransactionWarning} from '@pnyx/tx-review'
import type {RegistrationIntent} from '../../../services/midnight-dust'

/** Raised by every leg of every operation here. */
const ALWAYS: readonly TransactionWarning[] = ['plutus-contract', 'large-fee']

export const expectedFor = (kind: RegistrationIntent['kind']): readonly TransactionWarning[] => {
  switch (kind) {
    case 'register':
      return [...ALWAYS, 'minting']
    case 'deregister':
      return [...ALWAYS, 'unresolved-inputs', 'burning']
    // ⚠️ Two legs, not one: the validator's spend handler requires the auth token burned, so a
    // destination change is a deregister followed by a register (`build-registration.ts`). It therefore
    // burns *and* mints, and both are exactly what the user asked for.
    case 'changeDestination':
      return [...ALWAYS, 'unresolved-inputs', 'burning', 'minting']
  }
}
