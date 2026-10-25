// Local simulator for `contract/payment.compact`, chaining the CircuitContext across calls.
import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime'
import {sampleCoinPublicKey} from '@midnight-ntwrk/ledger-v8'
import {Contract, type Ledger, ledger} from '../../../contract/managed/payment/contract/index.js'
import {createPaymentWitnesses, type PaymentPrivateState} from './payment-witnesses.js'

type PaymentCircuitId =
  | 'setPrice'
  | 'buyPermitUnshielded'
  | 'buyPermitShielded'
  | 'claimFreePermit'
  | 'grantPermit'
  | 'grantRebindPermit'
  | 'grantModeratePermit'
  | 'rotateAdmin'

type Either = {
  readonly is_left: boolean
  readonly left: {bytes: Uint8Array}
  readonly right: {bytes: Uint8Array}
}

/**
 * A recipient on the **unshielded** rail: `Either<ContractAddress, UserAddress>`.
 *
 * ⚠️ **Not interchangeable with the shielded one, and the arms run the opposite way.** Unshielded is
 * `Either<ContractAddress, UserAddress>` — left is the contract. Shielded is
 * `Either<ZswapCoinPublicKey, ContractAddress>` — left is the *user*. The two are the same shape at
 * runtime, so only the phantom tag below stops one being passed where the other belongs. It exists
 * because that substitution was made everywhere a shielded recipient was ever constructed, including
 * the sealed `shieldedTreasury` of the preprod deploy: `userRecipient` there set `is_left: false`,
 * which on the shielded rail names a **contract** at what is actually a user's NIGHT address — an
 * address with no contract on it, so every shielded purchase would have forwarded the coin somewhere
 * nothing can ever spend it from.
 *
 * The tag is optional and never set, so it costs nothing at runtime and nothing crosses to a circuit.
 */
export type UnshieldedRecipient = Either & {readonly __rail?: 'unshielded'}

/** A recipient on the **shielded** rail: `Either<ZswapCoinPublicKey, ContractAddress>`. */
export type ShieldedRecipient = Either & {readonly __rail?: 'shielded'}

const ZERO = new Uint8Array(32)

/** A `UserAddress` recipient — the **right** arm of `Either<ContractAddress, UserAddress>`. */
export const userRecipient = (address: Uint8Array): UnshieldedRecipient => ({
  is_left: false,
  left: {bytes: ZERO},
  right: {bytes: address},
})

/** A `ContractAddress` recipient on the unshielded rail — the **left** arm. */
export const contractRecipient = (address: Uint8Array): UnshieldedRecipient => ({
  is_left: true,
  left: {bytes: address},
  right: {bytes: ZERO},
})

/**
 * A shielded recipient that is a user: the **left** arm of
 * `Either<ZswapCoinPublicKey, ContractAddress>`.
 *
 * ⚠️ Takes a **coin public key**, not a NIGHT user address. They are different key material — the
 * first 32 bytes of an `mn_shield-addr`, not the payload of a `night` address — and passing the
 * latter produces a coin only a key nobody holds could spend.
 */
export const coinPublicKeyRecipient = (coinPublicKey: Uint8Array): ShieldedRecipient => ({
  is_left: true,
  left: {bytes: coinPublicKey},
  right: {bytes: ZERO},
})

/** A shielded recipient that is a contract — the **right** arm. */
export const shieldedContractRecipient = (address: Uint8Array): ShieldedRecipient => ({
  is_left: false,
  left: {bytes: ZERO},
  right: {bytes: address},
})

export type PaymentSimulator = {
  readonly contract: Contract<PaymentPrivateState>
  readonly contractAddress: string
  readonly coinPublicKey: string
  call<K extends PaymentCircuitId>(
    circuitId: K,
    ...args: Parameters<Contract<PaymentPrivateState>['impureCircuits'][K]> extends [unknown, ...infer A] ? A : never
  ): CircuitResults<PaymentPrivateState, unknown>
  getLedger(): Ledger
  getContext(): CircuitContext<PaymentPrivateState>
  getContractState(): ReturnType<Contract<PaymentPrivateState>['initialState']>['currentContractState']
  getPrivateState(): PaymentPrivateState
  setPrivateState(next: PaymentPrivateState): void
}

/**
 * @param treasury Where an **unshielded** purchase is forwarded, in the circuit that receives it.
 * @param shieldedTreasury Where a **shielded** purchase is forwarded. A separate value because
 *   `sendImmediateShielded` addresses `Either<ZswapCoinPublicKey, ContractAddress>` while
 *   `sendUnshielded` addresses `Either<ContractAddress, UserAddress>` — disjoint types whose arms
 *   also run the opposite way. Build it with `coinPublicKeyRecipient`, never `userRecipient`.
 * @param adminAuth `persistentHash(["pnyx:admin", grantSecret])`. Mutable — `rotateAdmin` moves it.
 *   Its **initial** value still lands in the initial state and therefore in the
 *   address; a simulator given one the private state cannot derive models a caller who is not the
 *   moderator, which is the case worth being able to test.
 */
export const createPaymentSimulator = (
  initialPrivateState: PaymentPrivateState,
  treasury: UnshieldedRecipient,
  shieldedTreasury: ShieldedRecipient,
  adminAuth: Uint8Array,
): PaymentSimulator => {
  const contract = new Contract<PaymentPrivateState>(createPaymentWitnesses())
  const contractAddress = sampleContractAddress()
  const coinPublicKey = sampleCoinPublicKey()
  const constructed = contract.initialState(
    createConstructorContext(initialPrivateState, coinPublicKey),
    treasury,
    shieldedTreasury,
    adminAuth,
  )
  let context: CircuitContext<PaymentPrivateState> = createCircuitContext(
    contractAddress,
    coinPublicKey,
    constructed.currentContractState,
    constructed.currentPrivateState,
  )
  return {
    contract,
    contractAddress,
    coinPublicKey,
    call: (circuitId, ...args) => {
      const circuit = contract.impureCircuits[circuitId] as (
        ctx: CircuitContext<PaymentPrivateState>,
        ...rest: unknown[]
      ) => CircuitResults<PaymentPrivateState, unknown>
      const results = circuit(context, ...args)
      context = results.context
      return results
    },
    getLedger: () => ledger(context.currentQueryContext.state),
    getContext: () => context,
    getContractState: () => {
      constructed.currentContractState.data = context.currentQueryContext.state
      return constructed.currentContractState
    },
    getPrivateState: () => context.currentPrivateState,
    setPrivateState: (next) => {
      context = {...context, currentPrivateState: next}
    },
  }
}
