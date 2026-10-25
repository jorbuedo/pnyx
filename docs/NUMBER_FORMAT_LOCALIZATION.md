# Number Formatting & Localization

How the wallet renders and parses numbers (balances, fiat, prices,
percentages, amount inputs) across locales — and the rules for which API to
reach for in any given context.

Source files live in `app/src/i18n/` and
`app/src/providers/NumberFormatProvider.tsx`. Tests are in
`app/src/__tests__/i18n/`.

## TL;DR

- Every user-visible number uses the active `NumberLocale` from
  `NumberFormatProvider`. Inside React, reach for the hook layer
  (`useFormatCrypto`, `useFormatFiat`, `useFormatPercent`,
  `useFormatTokenBalance`, `useFormatFiatBalance`, …) — never call the bare
  formatters.
- Text inputs that accept a typed number use `useNumberParser()` and keep
  three views of the same input: `inputValue` (what the TextInput renders),
  `canonicalStr` (`.`-decimal for routing / state), `canonical` (atomic
  bigint for sending).
- Logs, analytics, telemetry events, and URL params use
  `formatInvariantNumber` — never a locale-aware formatter. Support reads
  these across locales and machines decode deep links.
- The active locale is `override ?? languageLocale`. A user can lock the
  number format in Settings → Number Format; otherwise it tracks the
  translation language (English → `en-US`, German → `de-DE`, …).

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  User settings                                                │
│  - Language picker      → I18nProvider.locale                 │
│  - Number format picker → NumberFormatProvider.override       │
└────────────┬──────────────────────────────────────────────────┘
             │
             ▼
┌───────────────────────────────────────────────────────────────┐
│  NumberFormatProvider                                         │
│  activeTag = override ?? languageLocale                       │
│  locale    = resolveNumberLocale(activeTag)                   │
│  (syncs BigNumber.FORMAT so vendored .toFormat() stays right) │
└────────────┬──────────────────────────────────────────────────┘
             │
    ┌────────┴────────────────────────┐
    ▼                                 ▼
┌─────────────────────┐   ┌──────────────────────────────────┐
│ Hook layer          │   │ Pure primitives                  │
│ useFormatCrypto     │   │ formatCrypto / formatFiat /      │
│ useFormatFiat       │   │ formatPercent                    │
│ useFormatPercent    │   │ parseNumberFromText              │
│ useFormatTokenBalance│  │ bigintToInputString              │
│ useFormatFiatBalance│   │ formatLocalizedNumber            │
│ useFormatActivityCrypto │ formatTokenBalance /             │
│ useFormatTxDetailCrypto │ formatFiatBalance / …            │
│ useFormatNetworkFeeFiat │ (number-display.ts)              │
│ useFormatNetworkFeeToken│                                   │
│ useFormatPercentage │   │ Every function accepts           │
│ useFormatTokenPrice │   │ `NumberLocale` explicitly.       │
│ useNumberParser     │   │ No hidden global state.          │
│ useNumberLocale     │   │                                  │
└─────────────────────┘   └──────────────────────────────────┘
             │                                 ▲
             └─────────────────────────────────┘
                     bind locale from context

Escape hatch (never goes through the provider):
┌───────────────────────────────────────────────────────────────┐
│ formatInvariantNumber — locale-invariant `.` / `,`            │
│  for logs, analytics, deep-link URLs                          │
└───────────────────────────────────────────────────────────────┘
```

**Wiring.** `NumberFormatProvider` is mounted once in
`app/app/_layout.tsx`, directly under `I18nProvider`. Everything
else in the tree sees the active locale via context.

## Concepts

### `NumberLocale`

The shared locale descriptor. Produced by `resolveNumberLocale(tag)`,
which probes `Intl.NumberFormat` for the actual decimal and group
characters so we don't hardcode assumptions.

```ts
type NumberLocale = {
  readonly tag: string       // BCP-47, e.g. "en-US" / "de-DE"
  readonly decimal: string   // "." or ","
  readonly group: string     // ",", ".", " ", " " (NBSP / narrow NBSP)
  readonly groupSize: 3
}
```

### The parser contract (`parseNumberFromText`)

Takes raw TextInput text and returns four views:

```ts
{
  inputValue: string     // what the TextInput.value should render
  canonicalStr: string   // "."-decimal, no grouping — for parent state / API
  canonical: bigint      // atomic units (lovelace, wei, sats, …)
  isEmpty: boolean
}
```

The parser is deliberately forgiving; the rules are upstream-hardened:

| Case | Behavior |
|------|---------|
| Single `.` or `,` | Always treated as the decimal, regardless of keyboard/locale mismatch. User on a DE keyboard typing `1,5` and user on a US keyboard typing `1.5` produce the same canonical. |
| Both `.` and `,` present | Position-based — **last one wins** as decimal, everything before is grouping. `"1,234.56"` and `"1.234,56"` both parse to `1234.56`. |
| Same separator repeated, every segment after the first is exactly 3 digits | Treated as grouping. `"1,234,567"` → `1234567`. |
| Same separator repeated, but segments aren't all 3-digit | Typo like `"123.45.67"` — last becomes decimal, earlier ones treated as integer digits. |
| Multiple consecutive separators | First valid one is the decimal; stray ones discarded. |
| Leading decimal `.45` | Normalised to `0.45`. |
| Trailing decimal `12.` | Preserved in `inputValue` (user is still typing); stripped from `canonicalStr`. |
| Fractional digits beyond `precision` | **Truncated**, never rounded — a wallet must never send more than the user sees. |
| Whitespace (space / NBSP / narrow NBSP) | Always grouping, always stripped. |
| Non-digit / non-separator chars | Dropped. |

See `number-format-parse.test.ts` (389 lines) for the full surface.

### `formatLocalizedNumber` vs the display formatters

`formatLocalizedNumber(amount, {locale, minFrac, maxFrac})` is the shared
low-level primitive. All higher-level helpers compose on top of it or on
top of `Intl.NumberFormat` directly.

Higher-level formatters (in `i18n/number-format.ts`):

- `formatCrypto(value: bigint, {decimals, locale, symbol, abbreviate?, subscript?})`
  — primary display formatter for token amounts. Uses Intl for integer
  grouping (honors Spanish "no grouping below 10,000" and French NBSP
  automatically), preserves bigint precision, supports compact notation
  (`3.15M`) and subscript-zero compression (`0.0₆123`).
- `formatFiat(value: number, {currency, locale, ...})` — drives
  `Intl.NumberFormat({style: 'currency'})` so symbol placement
  (`$1.00` vs `1,00 €` vs `¥100`) is correct per locale.
- `formatPercent(value: number, {locale, fractionDigits?, asPercent?})` —
  Intl percent, handles the locale-specific spacing before `%`.

Design-system specialised formatters (in `utils/number-display.ts`):
`formatTokenBalance`, `formatFiatBalance`, `formatTokenPrice`,
`formatPercentage`, `formatNetworkFeeFiat`, `formatNetworkFeeToken`,
`formatActivityCrypto`, `formatTxDetailCrypto`. These implement the
Figma-spec rules (8-digit cap, subscript triggers, abbreviation
thresholds, trailing-zero trim) and accept an optional `NumberLocale`
parameter with an `EN_US_NUMBER_LOCALE` default. **In React, always prefer
the hook wrappers** — they thread the active locale automatically.

### `bigintToInputString`

The inverse of `parseNumberFromText(...).canonical`. Given a bigint
atomic-unit amount and a locale, emits the decimal-form string the
TextInput expects (locale's decimal separator, no grouping, trailing
zeros stripped, `""` for `0n` so the placeholder shows).

Used by Max buttons and any code path that hydrates a TextInput from a
bigint value.

### Invariant format — the escape hatch

`formatInvariantNumber(amount, {minFrac?, maxFrac?})` — `.` decimal, `,`
thousands, no locale awareness. For:

- **Logs / analytics** (Sentry, `logger.*`). Support reads these
  across locales.
- **Deep-link URLs** (`?amount=1.5`). Machine-to-machine, must parse on
  the other end without locale context.
- **CSV / clipboard-for-external-tools** (future). Spreadsheets and
  third-party tooling expect a canonical form.

Anything visible to the user goes through the locale-aware path, not this.

## Usage guide

### In React — use the hooks

```tsx
import {useFormatCrypto, useFormatFiat, useFormatPercent} from '../providers'

function BalanceCard({lovelace}: {lovelace: bigint}) {
  const formatCrypto = useFormatCrypto()
  const formatFiat = useFormatFiat()
  return (
    <>
      <Text>{formatCrypto(lovelace, {decimals: 6, symbol: 'ADA'})}</Text>
      <Text>{formatFiat(42.13, {currency: 'USD'})}</Text>
    </>
  )
}
```

Design-system wrappers follow the same pattern:

```tsx
import {useFormatTokenBalance, useFormatFiatBalance} from '../providers'

const formatToken = useFormatTokenBalance()
const formatFiat = useFormatFiatBalance()

formatToken(1.5)            // "1.50"
formatFiat(1234.56, '$')    // en-US: "$1,234.56"  |  de-DE: "1.234,56 $"
```

Grab the raw locale only when passing it to a pure helper:

```tsx
import {useNumberLocale} from '../providers'
import {computeFiatValue} from '../utils/format'

const locale = useNumberLocale()
const fiat = computeFiatValue(amountStr, token, locale)
```

### In amount inputs — use the parser

Three-value pattern: TextInput owns `inputValue`, parent owns
`canonical`/`canonicalStr`.

```tsx
import {useNumberParser, useNumberLocale} from '../providers'
import {bigintToInputString} from '../i18n/number-format'

function MyAmountInput({value, onChange}: {value: bigint; onChange: (v: bigint) => void}) {
  const locale = useNumberLocale()
  const parse = useNumberParser()
  const [inputValue, setInputValue] = useState(() => bigintToInputString(value, DECIMALS, locale))

  const handleChange = useCallback((text: string) => {
    const parsed = parse(text, {decimals: DECIMALS})
    setInputValue(parsed.inputValue)
    onChange(parsed.canonical)
  }, [parse, onChange])

  return <TextInputBase value={inputValue} onChangeText={handleChange} keyboardType="decimal-pad" />
}
```

When the parent's `value` changes from outside (Max button, token
reset, parallel route estimate), sync it back — but only if the
user's `inputValue` doesn't already canonicalize to the parent's
value (so mid-typing states like `"12,"` survive):

```tsx
useEffect(() => {
  setInputValue((current) => {
    const {canonicalStr, isEmpty} = parse(current, {decimals: DECIMALS})
    if ((isEmpty ? '' : canonicalStr) === amount) return current
    return locale.decimal === '.' ? amount : amount.replace('.', locale.decimal)
  })
}, [amount, locale.decimal, parse])
```

Functional `setInputValue` is important: it lets the effect only
depend on external inputs (`amount`, `locale.decimal`, `parse`), so
it doesn't re-fire on every keystroke.

Reference: `app/src/components/AmountInput.tsx`,
`app/src/components/Swap/SwapAmountCard.tsx`, and
`app/app/send/amount.tsx`.

### In Effect / non-React code — pass locale explicitly

Pure formatters accept an explicit `NumberLocale` with an `en-US`
default. If the value is user-facing and the caller has access to
locale (e.g. via a React ancestor threading `useNumberLocale()` into
props), pass it. Otherwise, it's analytics / logs — use
`formatInvariantNumber`.

### The "Match Language" setting

The number format picker (`app/app/settings/number-format.tsx`)
has two modes:

1. **Match Language** (default) — `setOverride(null)`. Number format
   follows the translation language. Switching EN → DE also switches
   `1,234.56` → `1.234,56`.
2. **Explicit override** — `setOverride('ja-JP')`. The number format
   stays `ja-JP` no matter what language the UI is in. Persisted in
   `@pnyx/number_format_preference` storage.

The rationale: a user browsing the app in English may still want the
German number format (because they're used to `1.234,56`), and vice
versa. Numeric conventions and reading conventions don't always move
together.

## Locale quirks we handle

- **Spanish (`es-ES`): no grouping below 10,000.** Intl honors this
  automatically if you don't force `useGrouping: true`. Our `formatPlain`
  helper and every `Intl.NumberFormat` call deliberately omits that flag.
- **French (`fr-FR`) / Russian (`ru-RU`): NBSP / narrow NBSP as group
  separator.** The parser strips these (they can never be a decimal).
  `Intl.NumberFormat.format` produces them correctly for display.
- **Japanese (`ja-JP`), Chinese (`zh-CN`/`zh-TW`): `.` decimal, `,`
  group, but compact notation uses CJK characters (`万`/`億`).** Handled
  transparently by Intl when `notation: 'compact'`.
- **Currency placement varies.** `$1.00` (en-US) vs `1,00 $` (de-DE) vs
  `¥100` (ja-JP, zero-decimal). `formatFiat` delegates to Intl to get
  this right; our subscript-zero renderer uses `substituteNumberBody` to
  preserve the currency frame while swapping the number body.

## What to use when

| Context | API |
|---------|-----|
| Balance / list cell in React | `useFormatCrypto` / `useFormatTokenBalance` |
| Fiat value in React | `useFormatFiat` / `useFormatFiatBalance` |
| Percent in React | `useFormatPercent` / `useFormatPercentage` |
| Network fee in React | `useFormatNetworkFeeFiat` / `useFormatNetworkFeeToken` |
| TX activity / detail in React | `useFormatActivityCrypto` / `useFormatTxDetailCrypto` |
| TextInput onChangeText | `useNumberParser` |
| TextInput seeded from a bigint | `bigintToInputString(value, decimals, useNumberLocale())` |
| Computing fiat from a string amount | `computeFiatValue(amountStr, token, useNumberLocale())` |
| Any logger, analytics event, or URL param | `formatInvariantNumber` — never a locale-aware formatter |
| Tests | Pass `EN_US_NUMBER_LOCALE` (exported) or build a custom `NumberLocale` |

## Testing

- Parser surface → `number-format-parse.test.ts` — every locale
  mismatch, paste variant, trailing separator, precision, noise pattern.
- Display formatter surface (`formatCrypto` / `formatFiat` /
  `formatPercent`) → `number-format-display.test.ts`.
- Every supported BCP-47 tag's separator, compact, and subscript output →
  `number-format-locales.test.ts`.

Tests use `EN_US_NUMBER_LOCALE` as the default and construct other
locales explicitly so the suite doesn't depend on the Node/RN runtime's
ICU data matching a specific revision.

## Adding a new formatter

1. Implement the pure function in `i18n/number-format.ts` (if generic)
   or `utils/number-display.ts` (if design-system specialised). Accept
   `NumberLocale` as the final option; default to `EN_US_NUMBER_LOCALE`
   for non-React callers.
2. Add a hook wrapper in `providers/NumberFormatProvider.tsx` that
   binds the active locale and returns a stable callback (`useCallback`
   with `[locale]`).
3. Export the hook from `providers/index.ts`.
4. Add cases to the relevant test file.
5. Update the "What to use when" table above.

## Adding a new supported locale

1. Add the BCP-47 tag + translations to `SUPPORTED_LOCALES` in
   `app/src/i18n/provider.ts`.
2. `resolveNumberLocale(tag)` will probe Intl at runtime — no extra
   wiring needed for the format side, assuming the tag's separators are
   well-defined.
3. Add a test case to `number-format-locales.test.ts` covering the new
   tag's decimal, group, compact, and currency output.
4. Verify the Settings → Number Format list picks it up automatically
   (it's built from `SUPPORTED_LOCALES`).

## Related

- `app/src/i18n/provider.ts` — translation language registry.
- `app/src/i18n/number-format.ts` — primitives and display formatters.
- `app/src/i18n/number-format-invariant.ts` — invariant escape hatch.
- `app/src/providers/NumberFormatProvider.tsx` — context + hook layer.
- `app/src/utils/number-display.ts` — design-system specialised formatters.
- `app/app/settings/number-format.tsx` — user-facing picker.
