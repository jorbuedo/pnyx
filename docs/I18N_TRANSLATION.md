# Translating the wallet

English is the only language anyone authors by hand. `app/src/i18n/translations.ts`
is the source of truth; the eleven `translations_<locale>.ts` files are generated from it and
must never be hand-edited.

There is no hosted translation service and no CI job. Regeneration is a deliberate, local
run: chunk the English source, translate each chunk, validate, emit. The scripts live in
`app/scripts/i18n/`.

## Why the validation step exists

`createTranslator` (`src/i18n/provider.ts`) falls back to English per key, so a locale that
has quietly lost half its keys looks fine in review and simply renders English on a Japanese
phone. `interpolate` is worse: it catches ICU errors and returns the **unparsed template**,
so a malformed plural ships as literal `{count, plural, one {...}}` text in the UI.

Both failures are silent. `scripts/i18n/validate.ts` and `src/i18n/locale-parity.test.ts`
are what make them loud.

## Rules a translation must satisfy

These are enforced by `validate.ts` before emission and by `locale-parity.test.ts` in the
suite. A violation is a failure, not a warning.

| Rule | Why |
|---|---|
| Exactly the English key set, no extras | A missing key silently renders English |
| Identical placeholder set (`{name}`, `{count}`, …) | A renamed placeholder interpolates nothing |
| Every English plural block survives as a plural block | Losing it renders one hardcoded grammatical number |
| Plural blocks cover the locale's CLDR categories | `ru-RU` needs `one/few/many/other`; `ja-JP` needs only `other` |
| The message parses and formats under `intl-messageformat` | Malformed ICU becomes visible template text |
| No em dashes | Repo-wide copy rule, see below |

Plural categories come from `Intl.PluralRules(locale).resolvedOptions().pluralCategories`
rather than a hand-maintained table, so they cannot drift from what the runtime selects.

## No em dashes

Em dashes (`—`) are banned in every user-facing string, English and translated alike. Use a
period, colon, comma or parentheses; CJK locales use their own full-width punctuation. The
only exceptions are the two "no value" placeholder glyphs allowlisted in
`src/i18n/em-dash.test.ts`.

This is a copy rule only. Code, comments and docs are unaffected.

## The workflow

```bash
cd app

# 1. Split the English source into ~400-key chunks under .i18n-work/src
bun scripts/i18n/chunk.ts

# 2. Translate. One translator per locale, writing
#    .i18n-work/out/<locale>/chunk-NN.json for every chunk in .i18n-work/src.
#    Brief the translator with scripts/i18n/GLOSSARY.md plus the locale's
#    register and plural categories from scripts/i18n/locales.ts.

# 3. Validate. Non-zero exit means nothing gets emitted; the full list lands in
#    .i18n-work/out/<locale>/ISSUES.json
bun scripts/i18n/validate.ts es-ES

# 4. Emit the locale file
bun scripts/i18n/emit.ts es-ES
```

`translations_*.ts` is excluded from Biome (`biome.json`), so there is no formatting
step: the emitter's output is the final formatting. It writes 2-space indent, single
quotes and trailing commas to match the rest of the repo.

Finally, run the suite: `bunx vitest run src/i18n/`.

`.i18n-work/` is scratch. It is not committed, and it can be deleted between runs.

## Adding or changing a string

1. Edit the English string in `translations.ts`.
2. Regenerate the affected locales before the change ships.

`locale-parity.test.ts` fails the moment a locale drifts from the English key set, so a
forgotten regeneration is caught in the suite rather than falling back to English on screen.

## Adding a locale

1. Add its row to `scripts/i18n/locales.ts` (code, English name, register, any script notes).
2. Translate, validate and emit it like any other.
3. Import it in `src/i18n/provider.ts` and add its entry to `SUPPORTED_LOCALES` with the
   native name and flag.

`locale-parity.test.ts` picks it up automatically from `SUPPORTED_LOCALES`.
