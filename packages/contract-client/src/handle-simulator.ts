// Local simulator for `contract/handle.compact`, chaining the CircuitContext across calls.
import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime'
import {sampleCoinPublicKey} from '@midnight-ntwrk/ledger-v8'
import {Contract, type Ledger, ledger} from '../../../contract/managed/handle/contract/index.js'
import {createHandleWitnesses, type HandlePrivateState} from './handle-witnesses.js'

type HandleCircuitId = 'bind' | 'rebind' | 'moderate' | 'revoke'

export type HandleSimulator = {
  readonly contract: Contract<HandlePrivateState>
  readonly contractAddress: string
  readonly coinPublicKey: string
  call<K extends HandleCircuitId>(
    circuitId: K,
    ...args: Parameters<Contract<HandlePrivateState>['impureCircuits'][K]> extends [unknown, ...infer A] ? A : never
  ): CircuitResults<HandlePrivateState, unknown>
  getLedger(): Ledger
  /** Snapshot of the current circuit context (for building call txs off this state). */
  getContext(): CircuitContext<HandlePrivateState>
  /** The contract state with its data advanced to the current query-context state. */
  getContractState(): ReturnType<Contract<HandlePrivateState>['initialState']>['currentContractState']
  getPrivateState(): HandlePrivateState
  setPrivateState(next: HandlePrivateState): void
}

/**
 * @param name The canonical name sealed at deploy. There is one contract per name, and the address
 *   derives from it — so a simulator told a different name from the one in the private state models a
 *   caller whose limbs cannot recompose, which is the failure worth being able to test.
 * @param payment The `PaymentContract` address whose mint the permit colors derive from. Sealed, and
 *   therefore part of this contract's address.
 *
 * There is no admin argument: `moderate` is authorised by holding this name's moderation capability,
 * which `payment.grantModeratePermit` mints, so the template carries no secret to configure.
 */
export const createHandleSimulator = (
  initialPrivateState: HandlePrivateState,
  name: Uint8Array,
  payment: Uint8Array,
): HandleSimulator => {
  const contract = new Contract<HandlePrivateState>(createHandleWitnesses())
  const contractAddress = sampleContractAddress()
  const coinPublicKey = sampleCoinPublicKey()
  const constructed = contract.initialState(createConstructorContext(initialPrivateState, coinPublicKey), name, {
    bytes: payment,
  })
  let context: CircuitContext<HandlePrivateState> = createCircuitContext(
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
        ctx: CircuitContext<HandlePrivateState>,
        ...rest: unknown[]
      ) => CircuitResults<HandlePrivateState, unknown>
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
