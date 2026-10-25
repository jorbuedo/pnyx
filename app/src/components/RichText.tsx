/**
 * Rich localization text — looks up an ICU-style message string from the
 * locale dictionary and renders it with inline React nodes for
 * `<tag>...</tag>` placeholders (links, emphasis) and `{placeholder}`
 * substitutions (strings or React nodes).
 *
 * `intl.formatMessage` is intentionally NOT used: the wallet's
 * `babel-plugin-formatjs` config requires statically-analyzable message ids,
 * which a generic wrapper cannot provide. The rest of the wallet sidesteps
 * that via `useI18n().t(key)` (see `i18n/provider.ts#createTranslator`); this
 * component takes the same dictionary-lookup approach but adds a small
 * subset of ICU rich-text on top — enough for the consent / troubleshooting
 * strings without pulling in a new dependency.
 *
 * Supported message syntax (matching the strings in `i18n/translations.ts`):
 *   - `<tag>...</tag>`  → calls `values.tag(chunks)`; tags may nest
 *   - `{name}`          → substitutes `values.name`; allowed inside tags
 *
 * Anything outside this subset (ICU plurals, selects, `#` interpolation,
 * escaping with `'`) is rendered verbatim.
 *
 * @module
 */

import {Fragment, type ReactNode, useMemo} from 'react'
import type {StyleProp, TextStyle} from 'react-native'

import {getLocaleMessages} from '../i18n/provider'
import type {TranslationKey} from '../i18n/types'
import {useI18n} from '../providers'
import {Typography, type TypographyProps} from './Typography'

export type RichTextValues = Record<string, string | number | boolean | ((chunks: ReactNode) => ReactNode)>

export type RichTextProps = {
  /** Flattened message id (e.g. `init.newOrReturn.consent`). */
  messageId: TranslationKey
  values?: RichTextValues
  style?: StyleProp<TextStyle>
  variant?: TypographyProps['variant']
  testID?: string
}

type Token =
  | {type: 'text'; value: string}
  | {type: 'placeholder'; name: string}
  | {type: 'tag'; name: string; children: Token[]}

const TAG_NAME = /^<([a-zA-Z][\w-]*)>/
const PLACEHOLDER = /^\{(\w+)\}/

/**
 * Parse a message into a token tree. Tags are matched non-greedily by
 * scanning for the first `</name>` after the opening tag, so nested tags
 * with the same name are not supported (we don't need them).
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const rest = input.slice(i)

    const tagMatch = rest.match(TAG_NAME)
    if (tagMatch) {
      const name = tagMatch[1] as string
      const openLen = tagMatch[0].length
      const closeTag = `</${name}>`
      const closeIdx = input.indexOf(closeTag, i + openLen)
      if (closeIdx !== -1) {
        const inner = input.slice(i + openLen, closeIdx)
        tokens.push({type: 'tag', name, children: tokenize(inner)})
        i = closeIdx + closeTag.length
        continue
      }
    }

    const phMatch = rest.match(PLACEHOLDER)
    if (phMatch) {
      tokens.push({type: 'placeholder', name: phMatch[1] as string})
      i += phMatch[0].length
      continue
    }

    // Plain text run — scan to the next `<` or `{`.
    let next = i + 1
    while (next < input.length && input[next] !== '<' && input[next] !== '{') {
      next++
    }
    tokens.push({type: 'text', value: input.slice(i, next)})
    i = next
  }

  return tokens
}

function renderTokens(tokens: Token[], values: RichTextValues | undefined): ReactNode[] {
  return tokens.map((token, idx) => {
    if (token.type === 'text') {
      return token.value
    }

    if (token.type === 'placeholder') {
      const value = values?.[token.name]
      if (typeof value === 'function') {
        // Placeholders aren't expected to be tag handlers; render nothing rather than crash.
        return null
      }
      return value != null ? String(value) : `{${token.name}}`
    }

    const handler = values?.[token.name]
    const inner = renderTokens(token.children, values)
    if (typeof handler === 'function') {
      // biome-ignore lint/suspicious/noArrayIndexKey: token order is stable across renders for a given message
      return <Fragment key={idx}>{handler(inner)}</Fragment>
    }
    // Unknown / non-function tag value — render the inner content unchanged.
    // biome-ignore lint/suspicious/noArrayIndexKey: token order is stable across renders for a given message
    return <Fragment key={idx}>{inner}</Fragment>
  })
}

/**
 * Renders a translated string that may contain `<tag>...</tag>` rich-text
 * markers and `{placeholder}` substitutions.
 *
 * @example
 * ```tsx
 * <RichText
 *   messageId="init.newOrReturn.consent"
 *   values={{
 *     terms: (chunks) => (
 *       <Typography variant="bodyXs_regular" onPress={openTerms}>{chunks}</Typography>
 *     ),
 *   }}
 * />
 * ```
 */
export function RichText({messageId, values, style, variant = 'bodyXs_regular', testID}: RichTextProps) {
  const {locale} = useI18n()

  // Mirror createTranslator's fallback chain: selected locale → English → !!key sentinel.
  const message = useMemo(() => {
    const dict = getLocaleMessages(locale)
    const en = getLocaleMessages('en-US')
    return dict[messageId] ?? en[messageId] ?? `!!${messageId}`
  }, [locale, messageId])

  const tokens = useMemo(() => tokenize(message), [message])

  return (
    <Typography variant={variant} style={style} testID={testID}>
      {renderTokens(tokens, values)}
    </Typography>
  )
}
