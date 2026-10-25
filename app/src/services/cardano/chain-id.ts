/**
 * Cardano ChainId for the device/wallet layer.
 *
 * The hardware service and `WalletManager` key the Ledger app + stored chain on
 * a `ChainId`, and only `cardano:mainnet` is a defined ChainId literal — the
 * Cardano app itself is network-agnostic (preprod/preview are selected by the
 * `networkId` / `protocolMagic` carried in each signing request, not by a
 * distinct ChainId). So every Cardano network maps to the one Cardano ChainId.
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId} from '@pnyx/config'
import type {CardanoNetwork} from './config'

/**
 * The Cardano `ChainId` for `network`. Always `cardano:mainnet`: it identifies
 * the chain *family* (Ledger app / stored chain), while the actual network is
 * carried per-request. `network` is accepted so callers read intent and a
 * future per-network ChainId is a one-line change here.
 */
export const cardanoChainIdFor = (_network: CardanoNetwork): ChainId => CARDANO_MAINNET

/**
 * Whether `chainId` names the Cardano family.
 *
 * ⚠️ **Reads the prefix rather than calling `getChainFamily`, which throws** on any chain
 * id it does not enumerate — `cardano:preprod` included. This is used to decide whether a
 * scheduler tick has Cardano work to do, and a tick must not be taken down by an id it
 * merely does not recognise.
 *
 * Canonical because the check had been open-coded in four places; new callers belong here
 * rather than adding a fifth copy.
 */
export const isCardanoChainId = (chainId: ChainId): boolean => String(chainId).startsWith('cardano:')
