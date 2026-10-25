# @pnyx/wallet

Core wallet functionality for Cardano applications.

## Overview

This package provides wallet management and operations:

- **Account Manager** - Multi-account HD wallet support with BIP44 address discovery
- **UTXO Manager** - UTXO tracking, collateral selection, incremental sync
- **Transaction Manager** - History tracking with classification (sent/received/self/multi)
- **Sync Manager** - Background synchronization with prioritization and backoff
- **CIP-8 Signing** - Message signing with COSE_Sign1 structure

## Installation

```bash
bun add @pnyx/wallet
```

## Usage

### Account Management

```typescript
import { createAccount, createAddressChain, DEFAULT_GAP_LIMIT } from '@pnyx/wallet'
import { Effect } from 'effect'

const account = await Effect.runPromise(
  createAccount({
    walletId: 'my-wallet' as WalletId,
    index: 0,
    publicKey: accountPublicKey,
    rewardAddress: 'stake1...',
  })
)

// Access address chains
console.log(account.externalChain.addresses) // Receive addresses
console.log(account.internalChain.addresses) // Change addresses
```

### UTXO Management

```typescript
import { autoSelectCollateral, validateCollateral } from '@pnyx/wallet'

// Auto-select collateral UTXOs
const collateral = autoSelectCollateral(utxos, {
  minLovelace: 5_000_000n,
  maxUtxos: 3,
})

// Validate collateral meets requirements
const isValid = validateCollateral(collateral, 5_000_000n)
```

### Transaction Classification

```typescript
import { classifyTransaction, createTransactionSummary } from '@pnyx/wallet'

const direction = classifyTransaction(transaction, ownAddresses)
// Returns: 'sent' | 'received' | 'self' | 'multi'

const summary = createTransactionSummary(transaction, ownAddresses, currentTip)
// Returns full summary with net balance change
```

### CIP-8 Message Signing

```typescript
import {
  signMessage,
  buildCoseSign1FromSignature,
  buildSigStructure,
  encodeProtectedHeaders,
} from '@pnyx/wallet'
import { Effect } from 'effect'

// Sign with private key (all-in-one)
const result = await Effect.runPromise(
  signMessage(address, privateKey, payload)
)
console.log(result.signature) // COSE_Sign1 bytes
console.log(result.key)       // COSE_Key bytes

// Build from external signature (e.g., from WalletSigner or hardware device)
const coseSign1 = await Effect.runPromise(
  buildCoseSign1FromSignature(address, rawSignature, payload, publicKey)
)

// Composable signing with WalletSigner:
// 1. Build the COSE Sig_structure
// 2. Sign it with any WalletSigner
// 3. Wrap in COSE_Sign1
const protectedHeaders = encodeProtectedHeaders()
const sigStructure = buildSigStructure(protectedHeaders, messageBytes)
const signResult = await Effect.runPromise(signer.signData(sigStructure, signingPath))
const cose = await Effect.runPromise(
  buildCoseSign1FromSignature(address, signResult.signature, messageBytes, signResult.publicKey)
)
```

### CIP-30 Sign Data Adapter

```typescript
import { createCip30SignDataAdapterFromWalletSigner } from '@pnyx/wallet'

// Create a CIP-30 signData adapter from any WalletSigner
const adapter = createCip30SignDataAdapterFromWalletSigner(
  walletSigner,
  "m/1852'/1815'/0'/0/0"
)

// Use in CIP-30 API implementation
const { signature, key } = await Effect.runPromise(adapter.signData(address, payload))
```

### Sync Strategies

```typescript
import {
  prioritizeWallets,
  parallelSync,
  createBackoffState,
  withBackoff
} from '@pnyx/wallet'
import { Effect } from 'effect'

// Prioritize wallets for sync
const ordered = prioritizeWallets(wallets, states, selectedId, 'lastSelected')

// Sync with exponential backoff
const backoff = createBackoffState({ initial: 1000, max: 30000, multiplier: 2 })
const result = await Effect.runPromise(
  withBackoff(syncEffect, backoff)
)
```

## Types

### WalletUtxo

```typescript
type WalletUtxo = {
  readonly txHash: Uint8Array
  readonly txIndex: number
  readonly address: string
  readonly value: {
    readonly lovelace: bigint
    readonly assets?: ReadonlyMap<string, bigint>
  }
  readonly addressing?: {
    readonly accountIndex: number
    readonly role: 0 | 1
    readonly addressIndex: number
  }
}
```

### TransactionSummary

```typescript
type TransactionSummary = {
  readonly hash: string
  readonly direction: 'sent' | 'received' | 'self' | 'multi'
  readonly status: 'pending' | 'confirmed' | 'failed'
  readonly timestamp?: Date
  readonly confirmations: number | null
  readonly amount: {
    readonly lovelace: bigint
    readonly assets: ReadonlyMap<string, bigint>
  }
  readonly fee: bigint
}
```

## Architecture

```
wallet/
├── account/           # Account and address management
│   ├── account.ts     # Account type and operations
│   ├── address-chain.ts    # BIP44 address discovery
│   └── address-generator.ts # CIP-1852 derivation
├── utxo/              # UTXO state management
│   ├── utxo.ts        # UTXO utilities
│   ├── collateral.ts  # Collateral selection
│   └── utxo-diff.ts   # Incremental sync support
├── transaction/       # Transaction handling
│   ├── transaction-summary.ts # Classification
│   └── optimistic.ts  # Optimistic updates
├── sync/              # Synchronization
│   ├── sync-manager.ts     # Orchestration
│   ├── sync-strategies.ts  # Prioritization
│   └── backoff.ts     # Retry with backoff
└── signing/           # Message signing
    ├── cip8.ts        # COSE_Sign1 implementation (signMessage, buildSigStructure, buildCoseSign1FromSignature)
    └── cip30-adapter.ts # CIP-30 signData adapters (from private key or WalletSigner)
```

## Related Packages

- `@pnyx/cardano` - Cardano types and builder
- `@pnyx/blockchain` - Base blockchain abstractions
- `@pnyx/signer` - Signing abstraction
