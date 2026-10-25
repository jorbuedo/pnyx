import { describe, expect, it } from 'vitest';
import { createJournalLog, journalLine, SYSLOG_PRIORITY, underSystemd } from './journal-log.js';

describe('journalLine', () => {
  it('prefixes the syslog priority under systemd, so journalctl -p can filter', () => {
    expect(journalLine('error', '[sponsor] boom', { underSystemd: true })).toBe('<3>[sponsor] boom');
    expect(journalLine('warn', '[sponsor] odd', { underSystemd: true })).toBe('<4>[sponsor] odd');
    expect(journalLine('info', '[sponsor] fine', { underSystemd: true })).toBe('<6>[sponsor] fine');
  });

  it('shows the level as text off systemd, where there is no journal to filter', () => {
    expect(journalLine('error', 'boom', { underSystemd: false })).toBe('ERROR boom');
    expect(journalLine('warn', 'odd', { underSystemd: false })).toBe('WARN odd');
  });

  it('leaves an info line alone off systemd, so ordinary output stays clean', () => {
    expect(journalLine('info', 'fine', { underSystemd: false })).toBe('fine');
  });

  it('uses the syslog severities journald expects', () => {
    expect(SYSLOG_PRIORITY).toEqual({ error: 3, warn: 4, info: 6 });
  });
});

describe('underSystemd', () => {
  it('is true when systemd has connected stdout to the journal', () => {
    expect(underSystemd({ JOURNAL_STREAM: '8:12345' })).toBe(true);
  });

  it('is false under a plain shell', () => {
    expect(underSystemd({})).toBe(false);
  });

  it('treats an empty value as absent rather than as a journal stream', () => {
    expect(underSystemd({ JOURNAL_STREAM: '' })).toBe(false);
  });
});

describe('createJournalLog', () => {
  it('labels every line and tags the level', () => {
    const lines: string[] = [];
    const log = createJournalLog('sponsor', { underSystemd: true, write: (l) => lines.push(l) });
    log.info('started');
    log.warn('slow');
    log.error('failed');
    expect(lines).toEqual(['<6>[sponsor] started', '<4>[sponsor] slow', '<3>[sponsor] failed']);
  });

  it('puts the priority before the label, where journald looks for it', () => {
    const lines: string[] = [];
    createJournalLog('sponsor', { underSystemd: true, write: (l) => lines.push(l) }).error('x');
    expect(lines[0]?.startsWith('<3>')).toBe(true);
  });
});
