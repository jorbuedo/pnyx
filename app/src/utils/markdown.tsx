/**
 * Lightweight markdown-to-React-Native renderer.
 *
 * Covers the subset used by our legal documents: headings (#, ##), bold (**),
 * unordered lists (-), and paragraphs. Good enough for now instead of pulling
 * in a full markdown rendering library.
 *
 * @module
 */

import {Fragment} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Typography, type TypographyProps} from '../components/Typography'

type Variant = TypographyProps['variant']

type Block =
  | {type: 'heading'; level: 1 | 2; text: string}
  | {type: 'paragraph'; text: string}
  | {type: 'list'; items: string[]}

/** Parse a markdown string into an array of blocks. */
function parse(md: string): Block[] {
  const lines = md.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // Skip empty lines
    if (line.trim() === '') {
      i++
      continue
    }

    // Headings
    if (line.startsWith('## ')) {
      blocks.push({type: 'heading', level: 2, text: line.slice(3).trim()})
      i++
      continue
    }
    if (line.startsWith('# ')) {
      blocks.push({type: 'heading', level: 1, text: line.slice(2).trim()})
      i++
      continue
    }

    // Unordered list — collect consecutive list items
    if (line.startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && lines[i]?.startsWith('- ')) {
        items.push(lines[i]?.slice(2).trim() ?? '')
        i++
      }
      blocks.push({type: 'list', items})
      continue
    }

    // Paragraph — collect consecutive non-empty, non-special lines
    const paragraphLines: string[] = []
    while (i < lines.length && lines[i]?.trim() !== '' && !lines[i]?.startsWith('#') && !lines[i]?.startsWith('- ')) {
      paragraphLines.push(lines[i]?.trim() ?? '')
      i++
    }
    if (paragraphLines.length > 0) {
      blocks.push({type: 'paragraph', text: paragraphLines.join(' ')})
    }
  }

  return blocks
}

/** Render inline bold (**text**) within a string. */
function renderInline(text: string, variant: Variant, key: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  if (parts.length === 1) {
    return (
      <Typography key={key} variant={variant} style={styles.text}>
        {text}
      </Typography>
    )
  }

  // Filter empty strings produced by split when bold is at start/end
  const filtered = parts.filter((p) => p.length > 0)

  return (
    <Typography key={key} variant={variant} style={styles.text}>
      {filtered.map((part, idx) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          const inner = part.slice(2, -2)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: static markdown content, never reordered
            <Typography key={`${key}-b-${idx}`} variant="bodyMd_medium">
              {inner}
            </Typography>
          )
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: static markdown content, never reordered
        return <Fragment key={`${key}-t-${idx}`}>{part}</Fragment>
      })}
    </Typography>
  )
}

/** Render a markdown string as React Native elements. */
export function Markdown({children}: {children: string}) {
  const blocks = parse(children)

  return (
    <View style={styles.container}>
      {blocks.map((block, i) => {
        const key = `md-${i}`

        switch (block.type) {
          case 'heading':
            return (
              <Typography
                key={key}
                variant={block.level === 1 ? 'headingLg' : 'headingSm'}
                style={[styles.text, styles.heading]}
              >
                {block.text}
              </Typography>
            )

          case 'list':
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item) => (
                  <View key={`${key}-li-${item}`} style={styles.listItem}>
                    <Typography variant="bodyMd_regular" style={styles.bullet}>
                      {'\u2022'}
                    </Typography>
                    {renderInline(item, 'bodyMd_regular', `${key}-li-${item}-t`)}
                  </View>
                ))}
              </View>
            )

          case 'paragraph':
            return renderInline(block.text, 'bodyMd_regular', key)
        }
      })}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing.spacing12,
  },
  text: {
    lineHeight: 24,
    color: theme.colors.textDefault,
  },
  heading: {
    paddingTop: theme.spacing.spacing8,
  },
  list: {
    gap: theme.spacing.spacing4,
  },
  listItem: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
  },
  bullet: {
    lineHeight: 24,
    color: theme.colors.textDefault,
  },
}))
