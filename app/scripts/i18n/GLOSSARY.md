# Pnyx translation brief

Pnyx is a privacy-preserving governance forum and multi-chain crypto wallet, shipped as a
mobile app (iOS + Android). It holds Cardano and Midnight wallets, derives addresses for
BTC / EVM / Solana, supports Ledger and Trezor, and hosts a Discord-shaped forum where
identity is a key rather than an account.

## Hard rules (a violation fails automated validation)

1. **Preserve every placeholder exactly.** `{name}`, `{count}`, `{amount}`, `{origin}`,
   `{methods}`, `{blocks}`, `{kb}` and friends are variable names. Never translate, rename,
   re-case, space, or reorder the characters inside the braces. You may move a placeholder
   within the sentence if the target grammar needs it.
2. **ICU plurals keep their structure and take the target locale's categories.**
   English `{count, plural, one {# token} other {# tokens}}` must stay a
   `{count, plural, ...}` block. Supply exactly the categories this locale needs
   (listed in your task). The `#` character stays a literal `#`; it renders the number.
3. **No em dashes (—) anywhere.** The English source was just rewritten to remove them.
   Use whatever punctuation is natural for the locale: a period, colon, comma, parentheses.
   Chinese and Japanese should use their own full-width punctuation (。、：（）), not a dash.
4. **Keep trailing ellipses** (`…`), leading/trailing spaces, and `\n` exactly as in English.
5. **Output valid JSON** with exactly the same keys as the input chunk, in the same order.

## Never translate

Pnyx, Midnight, Cardano, Solana, Ethereum, Bitcoin, ADA, NIGHT, DUST, UTxO / UTXO, DRep,
CIP-13 / CIP-146 / CIP-157 / CIP-30, Koios, Auth0, Google, Apple, Ledger, Trezor,
`addr1`, `#general`, and any hex/bech32 sample string.

Treat NIGHT and DUST as proper nouns (they are tokens), not as the words "night" and "dust".

## Vocabulary

| English | Meaning | Note |
|---|---|---|
| community / communities | a forum circle | The UI never says "circle". Translate as the ordinary word for an online community. |
| display name | a per-community persona | The UI never says "persona". |
| recovery phrase | the BIP-39 seed phrase | Use one consistent term across the whole file. |
| shared wallet | a multisig wallet | |
| co-signer | a participant in a shared wallet | |
| watch-only | a wallet holding no signing key | |
| passkey | a WebAuthn passkey | Use the platform's established local term. |
| handle / name | a claimed on-chain username | |
| ticket | the entitlement that claims a handle of a given length | A product concept with no settled translation. Pick the natural word for a voucher/entitlement in your language and use it consistently; keep it distinct from "permit". |
| stake pool, delegate, saturation, rewards | Cardano staking | Use the terms Cardano wallets already use in this locale. |
| swap, batcher, limit order | trading | |
| sponsor, relay, indexer, node, mainnet, preprod | infrastructure | |
| on-chain | recorded on the blockchain | |
| seed phrase, secure storage, screen lock, biometrics | device security | |

## Tone

Short, plain, calm. The app explains risk without alarm and never blames the user.
UI labels and buttons stay as short as the English. Body copy may run slightly longer
if the language needs it, but do not add explanation the English does not have.
Match the English sentence count where you reasonably can.

Never invent a claim the English does not make. If the English is vague, stay vague.

## The word "wallet"

Each locale has one word for a wallet, given in your task and in
`scripts/i18n/locales.ts`. Use it consistently, including inside compounds
("shared wallet", "watch-only wallet", "identity wallet", "funds wallet",
"your wallet's addresses"). Do not alternate between the local word and the
English one within a file.

## Two keys are copied, not translated

`you.handle.screen.tierUnknown` and `you.midnightCity.noValue` are both the single
character `—`. It is a "no value yet" glyph in a table, not prose, and it must look
identical in every locale. Copy it through byte for byte. The no-em-dash rule above
does not apply to these two keys, and to nothing else.
