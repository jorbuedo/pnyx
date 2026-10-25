# @pnyx/identicon

Deterministic identicon generation and CIP-4 wallet checksum for Cardano wallets.

## Features

- **Blockies identicons** — deterministic SVG identicons from hex seed strings using XORshift PRNG
- **CIP-4 wallet checksum** — BLAKE2B-512 seed + FNV-1a plate matching the CIP-4 reference implementation
- **Color palettes** — 5 curated color schemes selected by the first byte of the seed
- **Saturation adjustment** — HSL-based saturation control for color theming
- **SVG output** — generates inline SVG strings and base64 data URIs (no canvas dependency)

## Usage

```ts
import {Blockies, walletChecksum} from '@pnyx/identicon'

// Generate a CIP-4 checksum from an account public key hex string
const checksum = walletChecksum(accountPublicKeyHex)
// { plate: 'XDLP-0123', seed: '...' }

// Generate an identicon SVG from the checksum seed
const svg = Blockies({seed: checksum.seed}).asSvg()
const base64 = Blockies({seed: checksum.seed}).asBase64()
```

### Blockies Options

```ts
Blockies({seed}).asSvg({
  size: 8,              // grid size (default 8)
  scale: 8,             // pixel scale per cell (default 8)
  saturationFactor: 0,  // saturation adjustment -100..100 (default 0)
})
```

### Wallet Checksum (CIP-4)

Produces a visual wallet identifier compatible with the CIP-4 reference implementation:

- **seed**: BLAKE2B-512 of the hex string (as UTF-8), personalized with `"wallets checksum"` (128 hex chars)
- **plate**: FNV-1a-32 of the seed encoded as `"XXXX-1234"` using a 16-character alphabet (`ABCDEJHKLNOPSTXZ`)

```ts
const {plate, seed} = walletChecksum('a1b2c3d4e5f6...')
// plate: "XDLP-0123" — human-readable wallet identifier
// seed: "ee195d4a..." — 128-char hex string for identicon generation
```

### Color Saturation

```ts
import {colorSaturation} from '@pnyx/identicon'

colorSaturation('#FF0000', 0)    // unchanged
colorSaturation('#FF0000', 50)   // more saturated
colorSaturation('#FF0000', -100) // fully desaturated → gray
```

## Modules

| Module | Description |
|--------|-------------|
| `blockies.ts` | XORshift PRNG-based SVG identicon generator |
| `checksum.ts` | CIP-4 wallet checksum (BLAKE2B-512 + FNV-1a-32) |
| `color-scheme.ts` | 5 curated color palettes for identicon theming |
| `color-saturation.ts` | Hex → HSL saturation adjustment |

## Dependencies

- `@noble/hashes` — BLAKE2B-512 with personalization support
