/**
 * How long undelivered DM state lives, and how large a key-package pool may get.
 *
 * ⚠️ **Everything in the DM tables was previously deleted only by the recipient.** A Welcome or a
 * message goes when its recipient acks it; an unclaimed key package goes when its owner retires it.
 * All three of those are the *device's* action, so a device that never comes back leaves its rows
 * there for ever — and a device that reinstalls cannot even name the packages it published, so it
 * cannot retire them (`docs/FOLLOW_UPS.md`). That is how 406 of 411 key packages came to be
 * unclaimed with nothing pruning them.
 *
 * ⚠️ **The pool is a liveness problem before it is a storage problem.** A reinstalled device loses
 * its private halves while the public halves stay published, so those rows are *claimable and dead*:
 * a peer claims one, seals a Welcome to it, and the invite dies on arrival on their side. The client
 * now retires the lot when it holds zero halves, but that only covers a device that reaches the code
 * — never an install that is simply gone. A server-side bound is the backstop, and it has to exist
 * here because nothing else can act for an absent device.
 *
 * @module
 */

/** The knobs, so a sweep's behaviour is one value object rather than constants read at each site. */
export type DmRetentionPolicy = {
  /** How long an unacked Welcome is kept. */
  readonly welcomeTtlMs: number;
  /** How long an unacked message is kept. */
  readonly messageTtlMs: number;
  /** How long an unclaimed key package is kept regardless of the cap. */
  readonly unclaimedTtlMs: number;
  /** How many unclaimed packages one subject may keep — newest survive. */
  readonly unclaimedPerSubject: number;
  /** How long a claimed package keeps its bytes before the tombstone is emptied. */
  readonly tombstoneBlobTtlMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The live policy.
 *
 * - **30 days for a Welcome or a message.** Both are *undelivered* content: the recipient's own device
 *   deletes them the moment it acks. Thirty days is a device being off, travelling or reinstalling —
 *   well past that, the honest reading is that it is not coming back. Deleting a Welcome is also the
 *   recoverable failure of the three: the thread's re-establish flow exists precisely to replace an
 *   invite that can no longer be opened.
 * - **40 unclaimed packages per subject.** Twice the client's `POOL_TARGET` of 20, so an in-flight
 *   refill against a full pool is never truncated, while a whole orphaned batch is evicted after the
 *   next one. Deleting the *oldest* surplus is what makes this a liveness fix: the orphans are always
 *   the old batch.
 * - **90 days for an unclaimed package** even under the cap. A dormant subject with 20 packages and no
 *   activity is under the cap for ever, and 20 dead packages is 20 invites that die on arrival.
 * - **7 days before a claimed tombstone loses its bytes.** The row itself is kept for ever — it is
 *   what stops `INSERT OR IGNORE` resurrecting a spent single-use init key — but `claimDmKeyPackage`
 *   only ever reads the bytes of an *unclaimed* row, so after a claim nothing will read them again.
 *   Seven days rather than zero so that a claim that has to be re-examined has a window in which to be.
 */
export const DM_RETENTION: DmRetentionPolicy = {
  welcomeTtlMs: 30 * DAY_MS,
  messageTtlMs: 30 * DAY_MS,
  unclaimedTtlMs: 90 * DAY_MS,
  unclaimedPerSubject: 40,
  tombstoneBlobTtlMs: 7 * DAY_MS,
};

/** The ISO-8601 boundaries a sweep compares against, so the SQL holds no date arithmetic. */
export type DmRetentionCutoffs = {
  readonly welcomesBefore: string;
  readonly messagesBefore: string;
  readonly unclaimedBefore: string;
  readonly tombstonesClaimedBefore: string;
};

/**
 * Turn a policy and an instant into the four boundaries.
 *
 * ISO-8601 strings because that is what the `created_at` / `claimed_at` columns hold, and their
 * lexicographic order is their chronological order — so the comparison stays a plain `<` and the
 * sweep needs no date functions in SQL, where D1's are not the same as SQLite's everywhere.
 *
 * ⚠️ `nowMs` is a parameter, never `Date.now()` inside: a retention rule whose boundary cannot be
 * pinned cannot be tested at its edges, which are the only interesting part of it.
 */
export const dmRetentionCutoffs = (policy: DmRetentionPolicy, nowMs: number): DmRetentionCutoffs => ({
  welcomesBefore: new Date(nowMs - policy.welcomeTtlMs).toISOString(),
  messagesBefore: new Date(nowMs - policy.messageTtlMs).toISOString(),
  unclaimedBefore: new Date(nowMs - policy.unclaimedTtlMs).toISOString(),
  tombstonesClaimedBefore: new Date(nowMs - policy.tombstoneBlobTtlMs).toISOString(),
});

/**
 * What one sweep did, counted per rule.
 *
 * ⚠️ **Per rule, not one total.** A sweep reporting a single number cannot be told apart from a sweep
 * where one rule silently stopped matching — which is exactly the failure this whole file exists
 * because of.
 */
export type DmRetentionOutcome = {
  readonly welcomesDeleted: number;
  readonly messagesDeleted: number;
  /** Unclaimed packages past {@link DmRetentionPolicy.unclaimedTtlMs}. */
  readonly unclaimedExpired: number;
  /** Unclaimed packages beyond {@link DmRetentionPolicy.unclaimedPerSubject}, oldest first. */
  readonly unclaimedOverCap: number;
  /** Claimed rows whose bytes were emptied; the rows themselves stay. */
  readonly tombstonesBlanked: number;
};

/** Whether a sweep changed anything — so a quiet run can be logged as quiet rather than as nothing. */
export const sweptSomething = (outcome: DmRetentionOutcome): boolean =>
  outcome.welcomesDeleted +
    outcome.messagesDeleted +
    outcome.unclaimedExpired +
    outcome.unclaimedOverCap +
    outcome.tombstonesBlanked >
  0;

/** Just enough of the store for the sweep, so the runner needs no `ContentStore` import cycle. */
export type DmRetentionSweeper = {
  sweepDmRetention(policy: DmRetentionPolicy, nowMs: number): Promise<DmRetentionOutcome>;
};

/** One structured line, so the sweep is legible in `wrangler tail` without a parser. */
export type DmRetentionLog = {
  readonly at: string;
  readonly cron: string;
  readonly level: 'info' | 'error';
  readonly origin: 'dm-retention';
  readonly message: string;
  readonly error?: string;
} & Partial<DmRetentionOutcome>;

/**
 * Run the sweep and say what happened, whichever way it went.
 *
 * ⚠️ **Extracted from the `scheduled` handler so it can be tested.** `worker.ts` cannot be imported by
 * a test — it pulls a `.wasm` module the bundler supplies — so anything left inside it is verified only
 * in production, which for a job that runs once a day and has no caller means "not verified".
 *
 * ⚠️ **Never throws.** A cron has nobody to report to, so a rejection would surface as a bare platform
 * error with none of the context. The failure becomes an `error` line instead, and the caller decides
 * nothing.
 */
export const runDmRetentionSweep = async (
  store: DmRetentionSweeper,
  policy: DmRetentionPolicy,
  event: {readonly scheduledTime: number; readonly cron: string},
  emit: (line: DmRetentionLog) => void,
): Promise<DmRetentionOutcome | undefined> => {
  const at = new Date(event.scheduledTime).toISOString();
  try {
    const outcome = await store.sweepDmRetention(policy, event.scheduledTime);
    emit({
      at,
      cron: event.cron,
      level: 'info',
      origin: 'dm-retention',
      // A quiet run says so rather than saying nothing: silence is how a job that stopped running
      // looks, and this one has no user to notice.
      message: sweptSomething(outcome) ? 'retention sweep removed rows' : 'retention sweep found nothing to do',
      ...outcome,
    });
    return outcome;
  } catch (error) {
    emit({
      at,
      cron: event.cron,
      level: 'error',
      origin: 'dm-retention',
      message: 'retention sweep failed',
      error: String(error),
    });
    return undefined;
  }
};
