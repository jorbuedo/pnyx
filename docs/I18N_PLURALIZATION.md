# i18n — Pluralization

## Why this exists

English pluralization is trivial (`1 token` / `2 tokens`). Most other languages aren't. Russian needs four forms, Polish three, Arabic six. CJK languages have none — adding `-s` produces garbage (`トークンs`). Before this migration, the wallet's i18n schema encoded plurals as a binary `'s'` / `''` suffix selected at the call site. The AI translation pipeline faithfully reproduced that broken schema in every language, shipping visible plural errors to every non-EN user.

The fix is **ICU MessageFormat** at the EN source. ICU lets the translator widen each locale to its actual CLDR categories without leaking per-locale rules into the English TS file.

## The contract

Every plural-affected string in `app/src/i18n/translations.ts` uses one ICU shape:

```ts
'{count, plural, one {# token} other {# tokens}}'
```

The runtime engine (`app/src/i18n/provider.ts`, `intl-messageformat`) selects the branch via `Intl.PluralRules` under the active locale. The translation pipeline widens the EN source per locale (Russian gets `one`/`few`/`many`/`other`, Arabic gets six branches, CJK collapses to a single branch).

**A string is plural-affected if** a count variable drives noun/verb/article/unit inflection nearby, OR the caller dispatches between two keys by a count comparison, OR the caller concatenates a count to a bare unit string externally.

## Five patterns that are bugs

All five are banned at the EN source. The first column is what NOT to write.

| Pattern | Example (bad) | Fix |
|---|---|---|
| `{plural}` placeholder | `'{count} attempt{plural} remaining'` | `'{count, plural, one {# attempt} other {# attempts}} remaining'` |
| `(s)` / `(es)` / `(ns)` shorthand | `'{count} device(s) found'` | `'{count, plural, one {# device} other {# devices}} found'` |
| Plural-only form + count var | `'{count} words'` (wrong at count=1) | `'{count, plural, one {# word} other {# words}}'` |
| Sibling keys `*One` / `*Other` / `*Many` | `countOne: '1 dApp'` + `countMany: '{count} dApps'` | `count: '{count, plural, one {# dApp} other {# dApps}}'` |
| Bare unit + external count concat | `day: 'd'` (caller does `${count}${t('...day')}`) | `day: '{count, plural, one {#d} other {#d}}'` + caller passes `{count}` |

## Caller rules

```ts
// ❌ stringifying breaks non-EN — intl-messageformat parseFloats values;
//    locale-formatted thousand-separators ('1.000' in de-DE) → 1 → wrong category
t('foo', {count: String(count)})
t('foo', {count: count.toString()})
t('foo', {count: formatCount(count, numberLocale)})
t('foo', {count: formatLocalizedNumber(count, {locale})})

// ✅ raw number — `#` inside the branch handles locale grouping at format time
t('foo', {count})
```

```ts
// ❌ caller dispatch defeats the point of ICU
count === 1 ? t('fooOne') : t('fooOther', {count})

// ✅ one call, ICU dispatches internally
t('foo', {count})
```

```tsx
// ❌ count rendered as JSX sibling — locks word order; non-EN locales may need to invert it
<Typography>{n} {t('forum.home.members')}</Typography>

// ✅ count inside the branch via `#`
<Typography>{t('forum.home.members', {count: n})}</Typography>
```

## Things that look like plurals but aren't

Don't migrate these — they're fine:

- **Plain `{var}` substitution.** `'Welcome, {name}!'`, `'Accepted: {date}'`. No count inflection. ICU handles plain `{var}` natively anyway.
- **Idiomatic plural-only words.** `'network fees'`, `'Terms of Service'`. The noun is plural in EN but there's no count parameter. Not a plural surface.
- **Semantic siblings that aren't CLDR categories.** `toastDisconnectOne` / `toastDisconnectAll` is action-target distinction (one specific dApp vs bulk), not a count. `walletPickerOther: 'Other wallets'` is the literal word "remaining". `nextRewardNone: '—'` is a missing-data sentinel.

If you grep `*One` / `*Other` / `*None` you'll see those three. They're false positives — leave them.

## ICU authoring rules

- Use `#` inside plural branches, **not** `{count}`. `#` resolves with locale grouping (`1,000` en-US, `1.000` de-DE, `1 000` fr-FR). `{count}` skips grouping.
- EN source uses only `one` / `other` (+ optional `=0` for an empty-state literal like `'No tabs'`). Don't enumerate `few` / `many` / `two` in EN — the translation pipeline widens per locale automatically.
- **Narrow scope.** Wrap only the count + noun. Keep static text outside the block. `'Incorrect password. {n, plural, one {# attempt} other {# attempts}} remaining.'` — not the whole sentence inside each branch. Wide scope inflates translation cost and churns every branch on every copy edit.
- Use `plural` not `select`. `select` is literal string match (`'one'` matches `'one'`); `plural` runs through `Intl.PluralRules`. They look almost identical and behave completely differently.

## The silent-regression gotcha

The provider has a try/catch around `IntlMessageFormat.format()`. Malformed ICU (`'{count, pluraL, …}'` — note the capital L) doesn't crash — it falls back to returning the unparsed template. **The malformed template renders as visible literal text in the UI.** Type-safe at compile time, broken at render time, no test failure.

Always render-test new plural keys in at least one non-EN locale before merging. Russian is the canonical check — it exercises `one` / `few` / `many` / `other` branches.

## Translation pipeline

`app/src/i18n/translations.ts` is the only file you edit by hand. The `translations_*.ts` files are auto-generated from the EN source and overwritten on every sync. Hand-edits to non-EN catalogs get reverted by the next auto-sync.

## Hermes only ships three Intl primitives

Hermes (0.14.1, RN 0.83) exposes **`Intl.Collator`, `Intl.DateTimeFormat`, `Intl.NumberFormat` and `Intl.getCanonicalLocales` — nothing else.** `PluralRules`, `RelativeTimeFormat`, `ListFormat`, `Segmenter` and `DisplayNames` are all absent on device. V8 has them all, so **web and vitest cannot catch a missing one** — the screen works everywhere except the shipped app.

The two failure modes differ, and the quiet one is not the dangerous one:

| Primitive | Missing behaviour |
|---|---|
| `Intl.PluralRules` | `intl-messageformat` throws per string, the provider catches, the raw ICU template renders as literal text |
| `Intl.RelativeTimeFormat` | **the constructor call throws — the screen crashes** |

Every primitive beyond the three native ones must be polyfilled in `app/index.js`, in `@formatjs`'s documented order (`getCanonicalLocales` → `Locale` → `PluralRules` → `RelativeTimeFormat`), with CLDR locale data loaded for every key in `SUPPORTED_LOCALES`. Locale-data `require()`s must be **static string literals** — Metro can't resolve a templated or looped path, so the data would be silently missing from the bundle.

Locale data is per-package: relative-time wording differs between Simplified and Traditional Chinese, so `zh-TW` needs `zh-Hant` on top of `zh`; plural rules don't, because Chinese has a single category and the package ships only `zh`.

`app/src/i18n/provider.test.ts` guards this — it asserts `index.js` loads data covering every supported locale, and pins the throw-on-missing behaviour. Adding a locale, or dropping a polyfill, fails there.

## Enforcement

The ⚠️ **ICU Pluralization Policy** section of `CLAUDE.md` is the agent-facing contract (banned/allowed patterns, PR review heuristics, verification greps); this doc is the orientation and worked examples.
