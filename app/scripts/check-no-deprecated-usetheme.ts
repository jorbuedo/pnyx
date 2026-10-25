#!/usr/bin/env bun
/**
 * CI gate: block reintroduction of deprecated useTheme() reads.
 *
 * useTheme() exposes only mode controls (themeMode,
 * setThemeMode, toggleTheme). Any read of .theme / .isDark / .colors must
 * route through Unistyles primitives:
 *   - useUnistyles() / withUnistyles() — for theme reads
 *   - useIsDark() (src/theme/use-is-dark.ts) — for the dark/light branch
 *   - StyleSheet.create((theme, rt) => …) — for style closures
 *
 * TypeScript already catches this via the slimmed ThemeContextValue type, but
 * this grep-based gate gives a clearer error message and survives downstream
 * type-loosening accidents (e.g. an `as any` cast slipping through review).
 *
 * @module
 */

import {execSync} from 'node:child_process'

// Match: useTheme().theme / useTheme().isDark / useTheme().colors
const PROP_ACCESS = String.raw`useTheme\(\)\.(theme|isDark|colors)\b`

// Match: const {theme[, …]} = useTheme()  /  const {…, isDark[, …]} = useTheme()  / etc.
// `[^})]*` keeps the destructure on a single line; multi-line destructures of useTheme() are rare and the type system catches them.
const DESTRUCTURE = String.raw`const\s*\{[^})]*\b(theme|isDark|colors)\b[^})]*\}\s*=\s*useTheme\(\)`

const PATTERN = `${PROP_ACCESS}|${DESTRUCTURE}`

const allowlist = (line: string): boolean => {
  // JSDoc / comment lines that only mention the deprecated form for documentation purposes
  if (/^\s*\*/.test(line.split(':').slice(2).join(':'))) return true
  // The lint script itself (this file)
  if (line.includes('scripts/check-no-deprecated-usetheme.ts')) return true
  return false
}

const main = (): void => {
  let raw: string
  try {
    raw = execSync(`grep -rEn "${PATTERN}" src app --include='*.ts' --include='*.tsx'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // grep exits 1 when no matches — that's the success case for us.
    const status = (err as {status?: number}).status
    if (status === 1) {
      process.stdout.write('check-no-deprecated-usetheme: clean\n')
      return
    }
    process.stderr.write(`check-no-deprecated-usetheme: grep failed (${status})\n`)
    process.exit(2)
  }

  const offenders = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !allowlist(l))

  if (offenders.length === 0) {
    process.stdout.write('check-no-deprecated-usetheme: clean\n')
    return
  }

  process.stderr.write('check-no-deprecated-usetheme: deprecated useTheme() reads found:\n')
  for (const line of offenders) process.stderr.write(`  ${line}\n`)
  process.stderr.write(
    [
      '',
      'Migrate the read to Unistyles:',
      '  - theme         → const {theme} = useUnistyles()  /  StyleSheet.create((theme) => …)  /  withUnistyles(...)',
      '  - isDark        → useIsDark()  (src/theme/use-is-dark.ts)',
      '  - colors        → theme.colors.* via the above',
      '',
      'useTheme() is reserved for {themeMode, setThemeMode, toggleTheme} only.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

main()
