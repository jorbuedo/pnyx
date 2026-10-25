// Local simulator for `circle.compact`. Takes the constructor's arguments, because a circle's
// identity, openness and founding moderator are fixed at deploy and feed its contract address.
import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime'
import {sampleCoinPublicKey} from '@midnight-ntwrk/ledger-v8'
import {Contract, type Ledger, ledger} from '../../../contract/managed/circle/contract/index.js'
import {type CirclePrivateState, createCircleWitnesses} from './circle-witnesses.js'

type CircleCircuitId =
  | 'setInvite'
  | 'issueInvite'
  | 'setInviteAuthority'
  | 'addModerator'
  | 'join'
  | 'setMember'
  | 'leaveCircle'

export type CircleSimulator = {
  readonly contract: Contract<CirclePrivateState>
  readonly contractAddress: string
  readonly coinPublicKey: string
  call<K extends CircleCircuitId>(
    circuitId: K,
    ...args: Parameters<Contract<CirclePrivateState>['impureCircuits'][K]> extends [unknown, ...infer A] ? A : never
  ): CircuitResults<CirclePrivateState, unknown>
  getLedger(): Ledger
  /** Snapshot of the current circuit context (for building call txs off this state). */
  getContext(): CircuitContext<CirclePrivateState>
  /** The contract state with its data advanced to the current query-context state. */
  getContractState(): ReturnType<Contract<CirclePrivateState>['initialState']>['currentContractState']
  getPrivateState(): CirclePrivateState
  setPrivateState(next: CirclePrivateState): void
}

export type CircleDeploy = {
  readonly circleId: Uint8Array
  readonly isOpen: boolean
  readonly founderModerator: Uint8Array
  /** The auth key seated for the founder — `moderatorAuth[founderModerator]`. */
  readonly founderAuth: Uint8Array
  /**
   * The founder's `identityJoinNullifier`, seated in `joinedIdentities` beside their member leaf.
   *
   * The constructor makes the founder a member, so a gated circle needs no self-invite — but without
   * the nullifier they could `join` again and hold a second leaf.
   */
  readonly founderJoined: Uint8Array
}

export const createCircleSimulator = (
  initialPrivateState: CirclePrivateState,
  deploy: CircleDeploy,
): CircleSimulator => {
  const contract = new Contract<CirclePrivateState>(createCircleWitnesses())
  const contractAddress = sampleContractAddress()
  const coinPublicKey = sampleCoinPublicKey()
  const constructed = contract.initialState(
    createConstructorContext(initialPrivateState, coinPublicKey),
    deploy.circleId,
    deploy.isOpen,
    deploy.founderModerator,
    deploy.founderAuth,
    deploy.founderJoined,
  )
  let context: CircuitContext<CirclePrivateState> = createCircuitContext(
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
        ctx: CircuitContext<CirclePrivateState>,
        ...rest: unknown[]
      ) => CircuitResults<CirclePrivateState, unknown>
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
