// Severity for a service whose only output is stdout.
//
// The sponsor host logs to journald through the unit's `StandardOutput=journal`, and everything it
// wrote arrived as PRIORITY=6 — a balance readout and a failed registration were indistinguishable,
// so `journalctl -p warning` returned nothing but systemd's own messages. That is not a cosmetic
// problem: the one line that explained a broken registration was buried among 392 info lines.
//
// journald reads a `<N>` syslog prefix off the start of a line and uses it as the priority
// (`SyslogLevelPrefix`, on by default), so severity needs no second stream and no log library — just
// the prefix. Emitting it only under systemd keeps a terminal run readable, which is where the
// `<3>` would otherwise be noise; systemd sets `JOURNAL_STREAM` for exactly this kind of decision.

export type LogLevel = 'error' | 'warn' | 'info';

/** syslog severities journald understands: 3 err, 4 warning, 6 info. */
export const SYSLOG_PRIORITY: Readonly<Record<LogLevel, number>> = { error: 3, warn: 4, info: 6 };

/**
 * One line, ready to `console.log`.
 *
 * Under systemd the level becomes a `<N>` prefix journald strips. Elsewhere it becomes a visible
 * tag, because a terminal reader has no journal to filter and needs the level in the text.
 *
 * ⚠️ **Only the first line of a multi-line message carries the priority** — journald treats each
 * newline as a new entry. Keep messages single-line (`explain()` joins a cause chain with `←` for
 * this reason).
 */
export const journalLine = (level: LogLevel, message: string, options: { readonly underSystemd: boolean }): string => {
  if (options.underSystemd) return `<${SYSLOG_PRIORITY[level]}>${message}`;
  return level === 'info' ? message : `${level.toUpperCase()} ${message}`;
};

/** Whether this process's stdout is a journald stream — set by systemd, absent under a plain shell. */
export const underSystemd = (env: Record<string, string | undefined>): boolean =>
  env.JOURNAL_STREAM !== undefined && env.JOURNAL_STREAM !== '';

export type LeveledLog = Readonly<Record<LogLevel, (message: string) => void>>;

/**
 * A logger that tags severity for journald and prefixes every line with `label`.
 *
 * `write` is injected so the tests do not assert on captured console output.
 */
export const createJournalLog = (
  label: string,
  options: { readonly underSystemd: boolean; readonly write?: (line: string) => void },
): LeveledLog => {
  const write = options.write ?? ((line: string) => console.log(line));
  const at = (level: LogLevel) => (message: string) =>
    write(journalLine(level, `[${label}] ${message}`, { underSystemd: options.underSystemd }));
  return { error: at('error'), warn: at('warn'), info: at('info') };
};
