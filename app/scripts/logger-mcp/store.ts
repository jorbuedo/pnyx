/**
 * In-memory ring buffer for log entries streamed from the wallet runtime.
 *
 * @module
 */

export type LogEntry = {
  source: string
  level: string
  message: string
  metadata: Record<string, unknown>
  timestamp: number
}

export type LogFilter = {
  since?: number | undefined
  until?: number | undefined
  level?: string | undefined
  source?: string | undefined
  originPrefix?: string | undefined
  messageSubstr?: string | undefined
  limit?: number | undefined
}

export type LogSummary = {
  total: number
  byLevel: Record<string, number>
  bySource: Record<string, number>
  topOrigins: ReadonlyArray<{origin: string; count: number}>
  timeRange: {first: number; last: number} | null
}

const DEFAULT_CAP = 5_000
const DEFAULT_READ_LIMIT = 200
const TOP_ORIGINS = 20

export type LogStore = {
  push(entry: LogEntry): void
  pushBatch(entries: ReadonlyArray<LogEntry>): void
  read(filter?: LogFilter): LogEntry[]
  clear(): void
  summary(): LogSummary
}

export const createLogStore = (cap: number = DEFAULT_CAP): LogStore => {
  let buffer: LogEntry[] = []

  const push = (entry: LogEntry): void => {
    buffer.push(entry)
    if (buffer.length > cap) buffer.splice(0, buffer.length - cap)
  }

  return {
    push,

    pushBatch(entries) {
      for (const e of entries) push(e)
    },

    read(filter = {}) {
      const {since, until, level, source, originPrefix, messageSubstr, limit = DEFAULT_READ_LIMIT} = filter
      const levels = level
        ? level
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null

      const result: LogEntry[] = []
      for (let i = buffer.length - 1; i >= 0 && result.length < limit; i -= 1) {
        const e = buffer[i]
        if (e === undefined) continue
        if (since !== undefined && e.timestamp < since) continue
        if (until !== undefined && e.timestamp > until) continue
        if (levels && !levels.includes(e.level)) continue
        if (source && e.source !== source) continue
        if (originPrefix) {
          const origin = typeof e.metadata.origin === 'string' ? e.metadata.origin : ''
          if (!origin.startsWith(originPrefix)) continue
        }
        if (messageSubstr && !e.message.includes(messageSubstr)) continue
        result.push(e)
      }
      return result.reverse()
    },

    clear() {
      buffer = []
    },

    summary() {
      if (buffer.length === 0) {
        return {total: 0, byLevel: {}, bySource: {}, topOrigins: [], timeRange: null}
      }
      const byLevel: Record<string, number> = {}
      const bySource: Record<string, number> = {}
      const byOrigin: Record<string, number> = {}
      for (const e of buffer) {
        byLevel[e.level] = (byLevel[e.level] ?? 0) + 1
        bySource[e.source] = (bySource[e.source] ?? 0) + 1
        const origin = typeof e.metadata.origin === 'string' ? e.metadata.origin : '<none>'
        byOrigin[origin] = (byOrigin[origin] ?? 0) + 1
      }
      const topOrigins = Object.entries(byOrigin)
        .map(([origin, count]) => ({origin, count}))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_ORIGINS)
      const first = buffer[0]
      const last = buffer[buffer.length - 1]
      return {
        total: buffer.length,
        byLevel,
        bySource,
        topOrigins,
        timeRange: first && last ? {first: first.timestamp, last: last.timestamp} : null,
      }
    },
  }
}
