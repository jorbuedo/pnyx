// Local simulator for `identity.compact`, chaining the CircuitContext across calls.
import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime'
import {sampleCoinPublicKey} from '@midnight-ntwrk/ledger-v8'
import {Contract, type Ledger, ledger} from '../../../contract/managed/identity/contract/index.js'
import {createIdentityWitnesses, type IdentityPrivateState} from './identity-witnesses.js'

type IdentityCircuitId = 'publishRow' | 'setPrimaryName' | 'setRow' | 'setRows'

export type IdentitySimulator = {
  readonly contract: Contract<IdentityPrivateState>
  readonly contractAddress: string
  readonly coinPublicKey: string
  call<K extends IdentityCircuitId>(
    circuitId: K,
    ...args: Parameters<Contract<IdentityPrivateState>['impureCircuits'][K]> extends [unknown, ...infer A] ? A : never
  ): CircuitResults<IdentityPrivateState, unknown>
  getLedger(): Ledger
  /** Snapshot of the current circuit context (for building call txs off this state). */
  getContext(): CircuitContext<IdentityPrivateState>
  /** The contract state with its data advanced to the current query-context state. */
  getContractState(): ReturnType<Contract<IdentityPrivateState>['initialState']>['currentContractState']
  getPrivateState(): IdentityPrivateState
  setPrivateState(next: IdentityPrivateState): void
}

/**
 * @param identity `C` — sealed into the contract at deploy, so the simulator must be told which
 *   identity this contract *is*. There is one contract per identity now; passing a `C` the private
 *   state cannot derive gives a contract whose every circuit fails `requireOwner`, which is the
 *   correct behaviour to be able to test.
 */
export const createIdentitySimulator = (
  initialPrivateState: IdentityPrivateState,
  identity: Uint8Array,
): IdentitySimulator => {
  const contract = new Contract<IdentityPrivateState>(createIdentityWitnesses())
  const contractAddress = sampleContractAddress()
  const coinPublicKey = sampleCoinPublicKey()
  const constructed = contract.initialState(createConstructorContext(initialPrivateState, coinPublicKey), identity)
  let context: CircuitContext<IdentityPrivateState> = createCircuitContext(
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
        ctx: CircuitContext<IdentityPrivateState>,
        ...rest: unknown[]
      ) => CircuitResults<IdentityPrivateState, unknown>
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
