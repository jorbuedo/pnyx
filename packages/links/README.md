# @pnyx/links

Cardano URI parsing and brand-specific deep link handling.

Private workspace package — installed via the monorepo workspace, not a registry.

The `effect` package is a **runtime dependency** — `parse()` returns an
`Effect<...>` and `InvalidUriError` is built on Effect's tagged-error helpers.

## Features

- Parse and build Cardano URIs (`web+cardano://...`) per CIP-13
- Legacy CIP-13 bare address format (`web+cardano:<address>?amount=...`)
- Brand-specific deep links (`pnyx://...`, `https://pnyx.pxkq.uk/w1/...`)
- 12 URI authorities for the Cardano protocol
- Type-safe with Effect-TS
- Round-trip parsing (parse -> build -> same URI)

## Cardano URIs (web+cardano://)

### Supported Authorities

| Authority | Format | Purpose |
|-----------|--------|---------|
| `claim` | `web+cardano://claim/v1?faucet_url=<url>&code=<code>` | Token faucet claims (CIP-99) |
| `browse` | `web+cardano://browse/v1?uri=<http(s) url>` | Block explorer links (CIP-158) |
| `pay` | `web+cardano://pay?address=...&amount=...` | Payment requests (CIP-13) |
| `pay-v1` | `web+cardano://pay/v1/<address>?l=&i=&n=&t=` | Enhanced payments, native assets (CIP-157) |
| `payment` | Alias for `pay` | Legacy compatibility |
| `stake` | `web+cardano://stake/<pool_id>` | Stake pool delegation |
| `drep` | `web+cardano://drep/<drep_id>` | DRep delegation |
| `transaction` | `web+cardano://transaction/<hash>` | View transaction (CIP-107) |
| `block` | `web+cardano://block/<hash>` | View block (CIP-107) |
| `address` | `web+cardano://address/<addr>` | View address (CIP-134) |
| `connect` | `web+cardano://connect?...` | Wallet connect |
| `backup` | `web+cardano://backup?v=1&enc=<envelope>` | Encrypted wallet backup (CIP-0301) |
| `watch` | `web+cardano://watch/v1?address=<addr>&name=<label>` | Hand over a wallet to watch — **no CIP** |
| `legacy-transfer` | `web+cardano://legacy-transfer?...` | Byron wallet transfer |

`watch` is ours. No cross-wallet standard exists for handing over a wallet to watch, so it borrows
CIP-13's grammar (a versioned authority with query parameters) without claiming a number. Proposing it
as a CIP was considered and declined (2026-08-15) — it stays a Pnyx-local authority.

The legacy CIP-13 bare address format `web+cardano:<address>?amount=...&memo=...` is also supported and parses as a `pay` authority.

### Parsing

```typescript
import { parse, isCardanoUri } from '@pnyx/links'
import { Effect } from 'effect'

// Parse a payment URI
const result = await Effect.runPromise(
  parse('web+cardano://pay?address=addr1...&amount=1000000')
)
// { authority: 'pay', address: 'addr1...', amount: 1000000n }

// Legacy CIP-13 bare address format also works
const legacy = await Effect.runPromise(
  parse('web+cardano:addr1...?amount=5000000')
)
// { authority: 'pay', address: 'addr1...', amount: 5000000n }

// Type guard
isCardanoUri('web+cardano://pay?address=addr1...') // true
isCardanoUri('web+cardano:addr1...')                // true (legacy)
isCardanoUri('https://example.com')                 // false
```

### Building

```typescript
import { build } from '@pnyx/links'

const payUri = build({
  authority: 'pay',
  address: 'addr1...',
  amount: 5000000n,
  message: 'Coffee'
})
// 'web+cardano://pay?address=addr1...&amount=5000000&message=Coffee'

const stakeUri = build({ authority: 'stake', poolId: 'pool1abc' })
// 'web+cardano://stake/pool1abc'
```

### Direct Authority Access

```typescript
import { Authorities } from '@pnyx/links'

const uri = Authorities.Pay.build('addr1...', 1000000n, 'Tip')
```

## Brand-Specific Links

Brand links handle brand-specific deep links that use the native brand scheme (`pnyx://`) or HTTPS fallback (`https://pnyx.pxkq.uk/w1/...`).

### Supported Use Cases

| Feature | Use Case | Purpose |
|---------|----------|---------|
| `transfer` | `request/ada` | Multi-target ADA payment request |
| `transfer` | `request/ada-with-link` | Payment with embedded web+cardano:// link |
| `transfer` | `request/crypto` | Chain-aware native/token payment request |
| `exchange` | `order/show-create-result` | Exchange order result display |
| `browser` | `launch` | Launch dApp URL in in-app browser |

All brand links support partner integration fields (appId, authorization, signature, redirectTo).

### Parsing Brand Links

```typescript
import { parseBrandLink, isBrandLink } from '@pnyx/links'

// Detect brand links
isBrandLink('pnyx://pnyx.pxkq.uk/w1/browser/launch?dappUrl=...', 'pnyx') // true
isBrandLink('https://pnyx.pxkq.uk/w1/browser/launch?dappUrl=...')          // true

// Parse
const action = parseBrandLink(
  'pnyx://pnyx.pxkq.uk/w1/browser/launch?dappUrl=https%3A%2F%2Fapp.com',
  'pnyx'
)
// { feature: 'browser', useCase: 'launch', params: { dappUrl: 'https://app.com' } }
```

### Building Brand Links

```typescript
import { buildBrandLink } from '@pnyx/links'

const url = buildBrandLink(
  { feature: 'browser', useCase: 'launch', params: { dappUrl: 'https://app.com' } },
  'pnyx'
)
// 'pnyx://pnyx.pxkq.uk/w1/browser/launch?dappUrl=https%3A%2F%2Fapp.com'
```

### Chain-Aware Transfer Requests

Partner integrations can request a concrete wallet send with `transfer/request/crypto`.
The `amount` value is base units: lovelace for ADA, wei for ETH, and token
base units for ERC-20s such as USDC.
Pass `redirectTo` as the raw HTTPS return URL; the builder applies the query
encoding and preserves nested callback parameters.

Accepted chains are exported as a const tuple so partners get IDE autocomplete:

```typescript
import { KNOWN_TRANSFER_CHAINS, type KnownTransferChain } from '@pnyx/links'

KNOWN_TRANSFER_CHAINS // readonly ['cardano:mainnet', 'eip155:1']
```

```typescript
import { buildTransferRequestCryptoLink } from '@pnyx/links'

const url = buildTransferRequestCryptoLink({
  chain: 'eip155:1',
  asset: 'ETH',
  address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  amount: '50000000000000000',
  redirectTo: 'https://example.com/pw/?orderId=123',
  appId: '18d1545a-a59b-45cb-a180-157b110c77fe',
})
// 'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?...'
```

Important integration notes:

- `client='encryptus'` enables the Encryptus label normalizer.
- Encryptus `chain='CARDANO'` with `name='ADA'` maps to `chain='cardano:mainnet'` and `asset='ADA'`.
- Encryptus `chain='ETHEREUM'` with `name='USDC'` maps to `chain='eip155:1'`, `asset='USDC'`, and the Ethereum mainnet USDC contract token.
- Encryptus `chain='ETH'`/`chain='ETHEREUM'` with `name='ETH'` maps to native Ethereum. The `amount` must already be wei.
- Without a supported `client`, pass canonical values directly, for example `chain='cardano:mainnet'` or `chain='eip155:1'`.
- `amount` must be an integer string in base units. For example, `2000000` means `2 ADA`, and
  `5050000` means `5.05 USDC`.
- Pass `redirectTo` as a raw URL. Do not wrap it with `encodeURIComponent`; this helper handles query encoding.

## Error Handling

```typescript
import { parse, InvalidUriError } from '@pnyx/links'
import { Effect, Exit } from 'effect'

const result = await Effect.runPromiseExit(parse('invalid-uri'))

if (Exit.isFailure(result)) {
  // Handle InvalidUriError
  console.error('Parse failed:', result.cause)
}
```

## Development

To run the package tests from a checkout:

```bash
bun vitest run packages/links
```
