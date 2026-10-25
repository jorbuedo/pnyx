# Coverage — extraction checkpoint

_Generated after the extraction pass. Chain tip: slot 193449575 (~2026-07-25), 13,725,110 blocks, 122,692,557 txs._

## Distinct assets with a usable media URI

**9,967,486** assets have a fetchable media candidate (of 9,968,633 total media rows).
- Unfetchable (no CID/URL recovered — junk/empty/`none`): **1,147** (0.0%)

### By kind
| kind | count |
|---|--:|
| nft | 9,964,670 |
| ft-logo | 3,963 |

### By URI scheme
| scheme | count | % |
|---|--:|--:|
| ipfs | 9,665,598 | 97.0 |
| data | 187,570 | 1.9 |
| http | 68,509 | 0.7 |
| arweave | 42,107 | 0.4 |
| data-registry | 3,702 | 0.0 |
| other | 1,146 | 0.0 |
| none | 1 | 0.0 |

### By CIP-67 name class (of the 721/registry rows)
| class | count |
|---|--:|
| plain | 9,811,870 |
| cip68-nft222 | 151,349 |
| registry | 3,702 |
| cip68-rft444 | 913 |
| cip68-unresolved | 496 |
| cip68-ft333 | 267 |
| cip68-ref100 | 36 |

## CIP-25 vs CIP-68

- **CIP-25 (label 721) assets with media** (this dataset, NFT rows): **9,964,670**
- **CIP-68 user tokens on-chain** (from mint tally — 222+333+444): **300,784** (222=295,496, 333=3,602, 444=1,686); reference NFTs (100)=298,908
- CIP-68 metadata lives in the reference-NFT datum. **v1 scope decision pending** (see below). Most CIP-68 assets do NOT post 721, so they are largely absent from the CIP-25 count above.

### Asset-name resolution quality
| method | count |
|---|--:|
| hex | 9,733,822 |
| cip68-datum | 119,416 |
| unverified | 75,090 |
| one-to-one | 36,603 |
| subject | 3,702 |

_`hex` = metadata asset-name key matched the on-chain mint exactly; `one-to-one` = single mint/single entry association; `unverified` = no mint match, best-guess hex (fingerprint may not correspond to a real on-chain asset)._

## Mint-year curve (NFT media rows)

| year | assets |
|---|--:|
| 2021 | 2,487,019 |
| 2022 | 4,349,611 |
| 2023 | 1,788,321 |
| 2024 | 976,070 |
| 2025 | 294,999 |
| 2026 | 68,650 |

## Calibration — MEASURED on a live sample

A stratified undefined-asset sample was actually fetched (public gateways only, no local kubo, single pass) and encoded to 720px WebP. **These are lower bounds** on eventual coverage — kubo + multi-day retries lift them.

### Fetch hit-rate by scheme (the loss signal)
| scheme | hit rate |
|---|--:|
| ipfs | 75% |
| http | 20% |
| arweave | 95% |
| data | 100% |
| data-registry | 100% |

**HTTP-hosted media is ~80% gone** (dead domains, expired certs) — it skews to older mints and is the bulk of what is permanently lost. IPFS 75% (public gw), Arweave 95%, on-chain data/registry 100% (unlosable).

### Output WebP size — depends entirely on the animation policy
| policy | mean/asset | median | p90 |
|---|--:|--:|--:|
| **first-frame still** (recommended) | **32.5 KB** | 25.8 KB | 67.3 KB |
| animated WebP | 208.8 KB | — | — |

_Animated sources encode to an avg **2.0 MB** WebP (p90 5.4 MB) vs 23.1 KB as a still — a 6× blob-size multiplier for zero benefit, since `AssetMedia` renders a still at 240pt. **Recommendation: first-frame still.**_

## Projected output size & cost (measured)

Estimated **7,494,174** assets fetch successfully (applying measured per-scheme hit-rates to the corpus).
| policy | blob size | R2 storage $/mo |
|---|--:|--:|
| first-frame still (32.5 KB) | **~232 GB** | **$3.48** |
| animated WebP (208.8 KB) | ~1492 GB (~1.5 TB) | $22.38 |


## Disk headroom for the fetch phase

- **Free on / : 372 GB.** Final still-policy blob: **~232 GB** → fits, with margin.
- Animated policy (~1.5 TB) does **NOT** fit — another reason for the still policy.
- Scratch (originals streamed through a temp dir, not retained; 50 MB source cap): budget ~5-10 GB transient.
- State DB + logs: ~8 GB. `meta721.jsonl` (12 GB) is deletable after this checkpoint.

## CIP-68 scope decision (needs your call)

The naive assumption is that CIP-68 needs a live indexer (kupo/ogmios/db-sync) because its metadata is in the reference-NFT datum, i.e. "ledger state." **That is not quite true here:** CIP-68 metadata lives in an *inline datum* on the label-100 reference-NFT output, and inline datums are recorded in transaction outputs — which ARE in the immutable chunks. So CIP-68 is reachable from the same dump, no new infra, by a second pass that scans outputs for label-100 ref-NFT + inline datum and takes the latest by slot (approximating current ledger state; correct except for the rare recreated-without-change case).

**Options for v1:**
- **(A) CIP-25 only** — ship the 9,964,670 assets now. Defers ~149,435 CIP-68 assets *not* also carrying 721. **The asset that motivated this project is CIP-68, so this defers the motivating case.**
- **(B) CIP-25 + CIP-68 from chunks** (recommended) — one extra Rust pass over the dump (~10-15 min) + a datum parser. No kupo/ogmios. Adds the full 300,784-asset CIP-68 universe.
- **(C) CIP-68 via external indexer** — the textbook path; requires syncing kupo/ogmios (hours-days of infra). No advantage over (B) here.

## The unfetchable list = the loss record

```sql
SELECT policy_id, asset_name_hex, fingerprint, scheme, image_raw, mint_slot, status, last_error
FROM asset WHERE status NOT IN ('ok') ORDER BY mint_slot;  -- the record of what was lost
```
Already-unfetchable at extraction (no CID/URL recoverable): **1,147**. The rest of the loss is measured during the fetch (projected from calibration: ~25% of fetchable candidates, concentrated in the HTTP scheme and older mints).
