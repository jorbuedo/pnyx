// Local simulator for `proposal.compact` — one deploy per proposal, so its constructor arguments are
// its whole identity and every one of them is sealed.
import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime'
import {sampleCoinPublicKey} from '@midnight-ntwrk/ledger-v8'
import {Contract, type Ledger, ledger} from '../../../contract/managed/proposal/contract/index.js'
import {createProposalWitnesses, type ProposalPrivateState} from './proposal-witnesses.js'

type ProposalCircuitId = 'castVote' | 'revealVote'

export type ProposalSimulator = {
  readonly contract: Contract<ProposalPrivateState>
  readonly contractAddress: string
  readonly coinPublicKey: string
  call<K extends ProposalCircuitId>(
    circuitId: K,
    ...args: Parameters<Contract<ProposalPrivateState>['impureCircuits'][K]> extends [unknown, ...infer A] ? A : never
  ): CircuitResults<ProposalPrivateState, unknown>
  getLedger(): Ledger
  getContext(): CircuitContext<ProposalPrivateState>
  getContractState(): ReturnType<Contract<ProposalPrivateState>['initialState']>['currentContractState']
  getPrivateState(): ProposalPrivateState
  setPrivateState(next: ProposalPrivateState): void
}

export type ProposalDeploy = {
  readonly circleId: Uint8Array
  /**
   * The circle's members root at creation — the electorate, frozen. A ban afterwards does not
   * disenfranchise and a join afterwards does not enfranchise.
   */
  readonly membersRoot: bigint
  /** Commitment to the off-chain body. The proposal's identity, folded into its deploy nonce. */
  readonly content: Uint8Array
  /** The author's persona. Disclosed deliberately, so a moderator can name what they ban. */
  readonly author: Uint8Array
  /** How many options the ballot carries. Yes/no is 2; the contract accepts 2..8. */
  readonly optionCount: number
}

export const createProposalSimulator = (
  initialPrivateState: ProposalPrivateState,
  deploy: ProposalDeploy,
): ProposalSimulator => {
  const contract = new Contract<ProposalPrivateState>(createProposalWitnesses())
  const contractAddress = sampleContractAddress()
  const coinPublicKey = sampleCoinPublicKey()
  const constructed = contract.initialState(
    createConstructorContext(initialPrivateState, coinPublicKey),
    deploy.circleId,
    deploy.membersRoot,
    deploy.content,
    deploy.author,
    BigInt(deploy.optionCount),
  )
  let context: CircuitContext<ProposalPrivateState> = createCircuitContext(
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
        ctx: CircuitContext<ProposalPrivateState>,
        ...rest: unknown[]
      ) => CircuitResults<ProposalPrivateState, unknown>
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
