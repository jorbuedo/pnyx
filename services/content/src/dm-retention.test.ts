import { describe, expect, it } from 'vitest';
import {
  DM_RETENTION,
  type DmRetentionLog,
  type DmRetentionOutcome,
  dmRetentionCutoffs,
  runDmRetentionSweep,
  sweptSomething,
} from './dm-retention.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

const outcome = (over: Partial<DmRetentionOutcome> = {}): DmRetentionOutcome => ({
  welcomesDeleted: 0,
  messagesDeleted: 0,
  unclaimedExpired: 0,
  unclaimedOverCap: 0,
  tombstonesBlanked: 0,
  ...over,
});

describe('dmRetentionCutoffs', () => {
  it('places each boundary its own window behind the given instant', () => {
    const cutoffs = dmRetentionCutoffs(DM_RETENTION, NOW);
    expect(cutoffs.welcomesBefore).toBe('2026-08-02T12:00:00.000Z');
    expect(cutoffs.messagesBefore).toBe('2026-08-02T12:00:00.000Z');
    expect(cutoffs.unclaimedBefore).toBe('2026-06-03T12:00:00.000Z');
    expect(cutoffs.tombstonesClaimedBefore).toBe('2026-08-25T12:00:00.000Z');
  });

  it('is a pure function of its arguments, so an edge can be pinned', () => {
    expect(dmRetentionCutoffs(DM_RETENTION, NOW)).toEqual(dmRetentionCutoffs(DM_RETENTION, NOW));
  });

  it('produces strings whose lexicographic order is their chronological order', () => {
    // What lets the sweep compare `created_at` with a plain `<` and hold no date arithmetic in SQL.
    const older = dmRetentionCutoffs(DM_RETENTION, NOW - 1000).welcomesBefore;
    const newer = dmRetentionCutoffs(DM_RETENTION, NOW).welcomesBefore;
    expect(older < newer).toBe(true);
  });
});

describe('DM_RETENTION', () => {
  it('caps a pool above the client refill target, so a full refill is never truncated', () => {
    // `POOL_TARGET` in app/src/services/dm-enrol.ts is 20; a cap at or below it would delete
    // packages the client had just published and leave the pool permanently churning.
    expect(DM_RETENTION.unclaimedPerSubject).toBeGreaterThan(20);
  });

  it('expires an unclaimed package eventually, cap or no cap', () => {
    // A dormant subject sits under the cap for ever, and a dead package under the cap is still an
    // invite that dies on arrival.
    expect(DM_RETENTION.unclaimedTtlMs).toBeGreaterThan(0);
  });

  it('keeps undelivered content long enough for a device to come back from a trip', () => {
    expect(DM_RETENTION.welcomeTtlMs).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
    expect(DM_RETENTION.messageTtlMs).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });
});

describe('sweptSomething', () => {
  it('is false for a sweep that found nothing', () => {
    expect(sweptSomething(outcome())).toBe(false);
  });

  it('is true when any single rule matched', () => {
    // Each one separately, or a rule could stop counting and the roll-up would still read as busy.
    expect(sweptSomething(outcome({ welcomesDeleted: 1 }))).toBe(true);
    expect(sweptSomething(outcome({ messagesDeleted: 1 }))).toBe(true);
    expect(sweptSomething(outcome({ unclaimedExpired: 1 }))).toBe(true);
    expect(sweptSomething(outcome({ unclaimedOverCap: 1 }))).toBe(true);
    expect(sweptSomething(outcome({ tombstonesBlanked: 1 }))).toBe(true);
  });
});

describe('runDmRetentionSweep', () => {
  const event = { scheduledTime: NOW, cron: '17 4 * * *' };

  it('reports what each rule removed', async () => {
    const lines: DmRetentionLog[] = [];
    const result = await runDmRetentionSweep(
      { sweepDmRetention: async () => outcome({ welcomesDeleted: 2, unclaimedOverCap: 7 }) },
      DM_RETENTION,
      event,
      (line) => lines.push(line),
    );

    expect(result).toEqual(outcome({ welcomesDeleted: 2, unclaimedOverCap: 7 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      origin: 'dm-retention',
      message: 'retention sweep removed rows',
      at: '2026-09-01T12:00:00.000Z',
      cron: '17 4 * * *',
      welcomesDeleted: 2,
      unclaimedOverCap: 7,
    });
  });

  it('says a quiet run was quiet rather than saying nothing', async () => {
    // Silence is exactly how a job that stopped running looks, and a cron has no user to notice.
    const lines: DmRetentionLog[] = [];
    await runDmRetentionSweep({ sweepDmRetention: async () => outcome() }, DM_RETENTION, event, (line) =>
      lines.push(line),
    );
    expect(lines[0]?.message).toBe('retention sweep found nothing to do');
    expect(lines[0]?.level).toBe('info');
  });

  it('turns a failure into an error line instead of throwing at a caller that does not exist', async () => {
    const lines: DmRetentionLog[] = [];
    const result = await runDmRetentionSweep(
      {
        sweepDmRetention: async () => {
          throw new Error('D1_ERROR: no such table');
        },
      },
      DM_RETENTION,
      event,
      (line) => lines.push(line),
    );

    expect(result).toBeUndefined();
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toBe('retention sweep failed');
    // The reason survives: a bare platform error would carry none of this.
    expect(lines[0]?.error).toContain('no such table');
  });

  it('passes the scheduled instant through, never a clock of its own', async () => {
    // What makes the boundaries reproducible: a sweep that read `Date.now()` could not be replayed.
    let seen: number | undefined;
    await runDmRetentionSweep(
      {
        sweepDmRetention: async (_policy, nowMs) => {
          seen = nowMs;
          return outcome();
        },
      },
      DM_RETENTION,
      event,
      () => {},
    );
    expect(seen).toBe(NOW);
  });
});
