import {describe, expect, it} from 'vitest'
import {readPendingMetadata, setPendingMetadata} from './metadata-handoff'

describe('metadata handoff', () => {
  it('reads back what was parked under the same label', () => {
    setPendingMetadata('1447', {heading: 'Reeve: financial records (label 1447)', lines: ['{', '  "org": {', '}']})

    expect(readPendingMetadata('1447')).toEqual({
      heading: 'Reeve: financial records (label 1447)',
      lines: ['{', '  "org": {', '}'],
    })
  })

  it('answers nothing for a label nobody parked', () => {
    setPendingMetadata('1447', {heading: 'a', lines: ['x']})

    expect(readPendingMetadata('674')).toBeUndefined()
  })

  it('drops the previous payload, so a second transaction cannot read the first', () => {
    setPendingMetadata('1447', {heading: 'first tx', lines: ['first']})
    setPendingMetadata('674', {heading: 'second tx', lines: ['second']})

    expect(readPendingMetadata('1447')).toBeUndefined()
    expect(readPendingMetadata('674')?.lines).toEqual(['second'])
  })

  it('replaces the payload when the same label is parked again', () => {
    setPendingMetadata('1447', {heading: 'first tx', lines: ['first']})
    setPendingMetadata('1447', {heading: 'second tx', lines: ['second']})

    expect(readPendingMetadata('1447')).toEqual({heading: 'second tx', lines: ['second']})
  })
})
