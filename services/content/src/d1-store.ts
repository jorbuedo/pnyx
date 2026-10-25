// ContentStore backed by Cloudflare D1 (services/content/migrations/0001_init.sql).
// Selected in server.ts / the Worker when a D1 binding is present. Invariants are DB
// constraints rather than application logic, so they cannot be bypassed by a new call site:
//   vote-once             → votes PRIMARY KEY (proposal_id, subject)
//   persona-unique/circle → UNIQUE INDEX (circle_id, persona COLLATE NOCASE)
// tally + memberCount are derived at read (COUNT), never stored, never drift.
//
// Semantics mirror the JSON store (store.ts) exactly — the same store.contract.test.ts
// runs against both: join checks already-joined before persona-taken; circles/proposals
// list newest-first; posts oldest-first; backlog ordered circle→membership→proposal→vote.
import type { D1Database } from '@cloudflare/workers-types';
import { isDmPolicy } from './dm-consent.js';
import { dmRetentionCutoffs } from './dm-retention.js';
import type {
  ChainBacklogItem,
  ChainRef,
  Circle,
  ContentStore,
  Device,
  DmMessage,
  Membership,
  Proposal,
} from './store.js';

/**
 * D1 returns BLOB columns as ArrayBuffer in the Workers runtime but as Uint8Array under some
 * drivers, so every read normalises. Writes go out as Uint8Array, which both accept.
 */
const bytesOf = (value: ArrayBuffer | Uint8Array): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);
const blobOf = (value: Uint8Array): Uint8Array => value;

type DmMessageRow = {
  id: string;
  conv_id: string;
  sender: string;
  recipient: string;
  ciphertext: ArrayBuffer | Uint8Array;
  created_at: string;
  permit_jti?: string | null;
};
type DmWelcomeRow = {
  id: string;
  conv_id: string;
  sender: string;
  recipient: string;
  welcome: ArrayBuffer | Uint8Array;
  ratchet_tree: ArrayBuffer | Uint8Array;
  created_at: string;
  permit_jti?: string | null;
};

const dmMessageOf = (r: DmMessageRow): DmMessage => ({
  id: r.id,
  convId: r.conv_id,
  sender: r.sender,
  recipient: r.recipient,
  ciphertext: bytesOf(r.ciphertext),
  createdAt: r.created_at,
  ...(r.permit_jti === null || r.permit_jti === undefined ? {} : { permitJti: r.permit_jti }),
});

export type D1StoreOptions = {
  readonly db: D1Database;
  readonly random?: () => string;
  readonly now?: () => string;
};

type ChainCols = {
  chain_status: string | null;
  chain_tx_id: string | null;
  chain_seq_id: string | null;
  chain_error: string | null;
};

// Reconstruct the optional ChainRef from flattened columns (chain_seq_id ↔ ChainRef.chainId).
const toChain = (r: ChainCols): ChainRef | undefined => {
  if (r.chain_status === null) return undefined;
  const chain: ChainRef = { status: r.chain_status as ChainRef['status'] };
  return {
    ...chain,
    ...(r.chain_tx_id !== null ? { txId: r.chain_tx_id } : {}),
    ...(r.chain_seq_id !== null ? { chainId: r.chain_seq_id } : {}),
    ...(r.chain_error !== null ? { error: r.chain_error } : {}),
  };
};

// The four chain columns as a bind tuple (INSERT/UPDATE order matches the SQL below).
const chainBind = (chain: ChainRef): [string, string | null, string | null, string | null] => [
  chain.status,
  chain.txId ?? null,
  chain.chainId ?? null,
  chain.error ?? null,
];

export const createD1ContentStore = (options: D1StoreOptions): ContentStore => {
  const { db } = options;
  const random = options.random ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  type CircleRow = {
    id: string;
    name: string;
    description: string;
    author: string;
    created_at: string;
    founder_leaf: string | null;
    founder_subject: string | null;
    display_char: string | null;
    is_open: number;
    code_digest: string | null;
    member_count: number;
  } & ChainCols;
  const CIRCLE_SELECT =
    'SELECT c.id, c.name, c.description, c.author, c.created_at, c.founder_leaf, c.founder_subject, c.display_char, c.is_open, c.code_digest, ' +
    'c.chain_status, c.chain_tx_id, c.chain_seq_id, c.chain_error, ' +
    '(SELECT COUNT(*) FROM memberships m WHERE m.circle_id = c.id) AS member_count FROM circles c';
  const toCircle = (r: CircleRow): Circle => {
    // Bound once: calling `toChain(r)` twice leaves TS unable to narrow the second call, which is
    // what `exactOptionalPropertyTypes` rejects — an optional prop must be absent, not undefined.
    const chain = toChain(r);
    return {
      id: r.id,
    name: r.name,
      description: r.description,
      author: r.author,
      createdAt: r.created_at,
      memberCount: r.member_count,
      // NOT NULL with a default in the schema, so this is never absent — `!== 0` rather than a
      // truthiness check because SQLite hands integers back, not booleans.
      isOpen: r.is_open !== 0,
      ...(chain === undefined ? {} : { chain }),
      // NULL means never settled, or settled before this was recorded — not "no moderator".
      ...(r.founder_leaf !== null ? { founderLeaf: r.founder_leaf } : {}),
      ...(r.founder_subject !== null ? { founderSubject: r.founder_subject } : {}),
      ...(r.display_char !== null ? { displayChar: r.display_char } : {}),
      // NULL is "not determined yet", so it stays absent rather than becoming a claim about which
      // template the contract came from.
      ...(r.code_digest !== null ? { codeDigest: r.code_digest } : {}),
    };
  };

  type ProposalRow = { id: string; circle_id: string; title: string; body: string; author: string; created_at: string; yes: number; no: number } & ChainCols;
  const PROPOSAL_SELECT =
    'SELECT p.id, p.circle_id, p.title, p.body, p.author, p.created_at, p.chain_status, p.chain_tx_id, p.chain_seq_id, p.chain_error, ' +
    "COALESCE(SUM(CASE WHEN v.value = 'yes' THEN 1 ELSE 0 END), 0) AS yes, " +
    "COALESCE(SUM(CASE WHEN v.value = 'no' THEN 1 ELSE 0 END), 0) AS no " +
    'FROM proposals p LEFT JOIN votes v ON v.proposal_id = p.id';
  const toProposal = (r: ProposalRow): Proposal => {
    const chain = toChain(r);
    return {
      id: r.id,
      circleId: r.circle_id,
      title: r.title,
      body: r.body,
      author: r.author,
      createdAt: r.created_at,
      tally: { yes: Number(r.yes), no: Number(r.no) },
      ...(chain === undefined ? {} : { chain }),
    };
  };

  const membershipExists = async (circleId: string, subject: string): Promise<boolean> =>
    (await db.prepare('SELECT 1 FROM memberships WHERE circle_id = ? AND subject = ?').bind(circleId, subject).first()) !==
    null;

  const personaTaken = async (circleId: string, persona: string): Promise<boolean> =>
    (await db
      .prepare('SELECT 1 FROM memberships WHERE circle_id = ? AND persona = ? COLLATE NOCASE')
      .bind(circleId, persona)
      .first()) !== null;

  const doJoin = async (input: {
    circleId: string;
    subject: string;
    persona: string;
    disclosed: boolean;
  }): Promise<Membership | 'already-joined' | 'persona-taken'> => {
    const { circleId, subject, persona, disclosed } = input;
    if (await membershipExists(circleId, subject)) return 'already-joined';
    if (await personaTaken(circleId, persona)) return 'persona-taken';
    const joinedAt = now();
    await db
      .prepare('INSERT INTO memberships (circle_id, subject, persona, disclosed, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(circleId, subject, persona, disclosed ? 1 : 0, joinedAt)
      .run();
    return { persona, disclosed, joinedAt };
  };

  return {
    listCircles: async () => {
      const { results } = await db.prepare(`${CIRCLE_SELECT} ORDER BY c.created_at DESC, c.rowid DESC`).all<CircleRow>();
      return results.map(toCircle);
    },
    getCircle: async (id) => {
      const row = await db.prepare(`${CIRCLE_SELECT} WHERE c.id = ?`).bind(id).first<CircleRow>();
      return row ? toCircle(row) : undefined;
    },
    createCircle: async ({ name, description, subject, persona, disclosed, isOpen }) => {
      const id = random();
      const createdAt = now();
      await db
        .prepare('INSERT INTO circles (id, name, description, author, created_at, is_open) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, name, description, persona, createdAt, isOpen ? 1 : 0)
        .run();
      await doJoin({ circleId: id, subject, persona, disclosed });
      return { id, name, description, author: persona, createdAt, memberCount: 1, isOpen };
    },
    join: async (input) => doJoin(input),
    leave: async (circleId, subject) => {
      // `changes` distinguishes a removal from a no-op; a blind DELETE would report a stranger's
      // leave as a success and the route would answer 200 to someone who was never in the circle.
      const result = await db
        .prepare('DELETE FROM memberships WHERE circle_id = ? AND subject = ?')
        .bind(circleId, subject)
        .run();
      return result.meta.changes > 0 ? 'left' : 'not-a-member';
    },
    getMembership: async (circleId, subject) => {
      const r = await db
        .prepare(
          'SELECT persona, disclosed, joined_at, chain_status, chain_tx_id, chain_seq_id, chain_error FROM memberships WHERE circle_id = ? AND subject = ?',
        )
        .bind(circleId, subject)
        .first<{ persona: string; disclosed: number; joined_at: string } & ChainCols>();
      if (!r) return undefined;
      const chain = toChain(r);
      return { persona: r.persona, disclosed: !!r.disclosed, joinedAt: r.joined_at, ...(chain ? { chain } : {}) };
    },
    listProposals: async (circleId) => {
      const { results } = await db
        .prepare(`${PROPOSAL_SELECT} WHERE p.circle_id = ? GROUP BY p.id ORDER BY p.created_at DESC, p.rowid DESC`)
        .bind(circleId)
        .all<ProposalRow>();
      return results.map(toProposal);
    },
    getProposal: async (id) => {
      const row = await db.prepare(`${PROPOSAL_SELECT} WHERE p.id = ? GROUP BY p.id`).bind(id).first<ProposalRow>();
      return row ? toProposal(row) : undefined;
    },
    createProposal: async ({ circleId, title, body, author }) => {
      const id = random();
      const createdAt = now();
      await db
        .prepare('INSERT INTO proposals (id, circle_id, title, body, author, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, circleId, title, body, author, createdAt)
        .run();
      return { id, circleId, title, body, author, createdAt, tally: { yes: 0, no: 0 } };
    },
    castVote: async ({ proposalId, subject, value }) => {
      const proposal = await db.prepare('SELECT id FROM proposals WHERE id = ?').bind(proposalId).first();
      if (!proposal) throw new Error(`no such proposal: ${proposalId}`);
      const inserted = await db
        .prepare('INSERT INTO votes (proposal_id, subject, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING subject')
        .bind(proposalId, subject, value, now())
        .first();
      if (inserted === null) return 'already-voted';
      const updated = await db.prepare(`${PROPOSAL_SELECT} WHERE p.id = ? GROUP BY p.id`).bind(proposalId).first<ProposalRow>();
      // The proposal existed (checked above) and the vote just inserted, so this is present.
      return toProposal(updated as ProposalRow);
    },
    hasVoted: async (proposalId, subject) =>
      (await db.prepare('SELECT 1 FROM votes WHERE proposal_id = ? AND subject = ?').bind(proposalId, subject).first()) !==
      null,
    listPosts: async (circleId) => {
      const { results } = await db
        .prepare(
          'SELECT id, circle_id, parent_id, channel_id, body, author, created_at FROM posts WHERE circle_id = ? ORDER BY created_at ASC, rowid ASC',
        )
        .bind(circleId)
        .all<{
          id: string;
          circle_id: string;
          parent_id: string | null;
          channel_id: string | null;
          body: string;
          author: string;
          created_at: string;
        }>();
      return results.map((r) => ({
        id: r.id,
        circleId: r.circle_id,
        ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
        ...(r.channel_id !== null ? { channelId: r.channel_id } : {}),
        body: r.body,
        author: r.author,
        createdAt: r.created_at,
      }));
    },
    getPost: async (id) => {
      const r = await db
        .prepare('SELECT id, circle_id, parent_id, channel_id, body, author, created_at FROM posts WHERE id = ?')
        .bind(id)
        .first<{
          id: string;
          circle_id: string;
          parent_id: string | null;
          channel_id: string | null;
          body: string;
          author: string;
          created_at: string;
        }>();
      if (!r) return undefined;
      return {
        id: r.id,
        circleId: r.circle_id,
        ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
        ...(r.channel_id !== null ? { channelId: r.channel_id } : {}),
        body: r.body,
        author: r.author,
        createdAt: r.created_at,
      };
    },
    createPost: async ({ circleId, parentId, channelId, body, author }) => {
      const id = random();
      const createdAt = now();
      await db
        .prepare(
          'INSERT INTO posts (id, circle_id, parent_id, channel_id, body, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, circleId, parentId ?? null, channelId ?? null, body, author, createdAt)
        .run();
      return {
        id,
        circleId,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(channelId !== undefined ? { channelId } : {}),
        body,
        author,
        createdAt,
      };
    },
    listChannels: async (circleId) => {
      const { results } = await db
        .prepare(
          'SELECT id, circle_id, name, description, created_by, created_at FROM channels WHERE circle_id = ? ORDER BY created_at ASC, rowid ASC',
        )
        .bind(circleId)
        .all<{
          id: string;
          circle_id: string;
          name: string;
          description: string | null;
          created_by: string;
          created_at: string;
        }>();
      return results.map((r) => ({
        id: r.id,
        circleId: r.circle_id,
        name: r.name,
        ...(r.description !== null ? { description: r.description } : {}),
        createdBy: r.created_by,
        createdAt: r.created_at,
      }));
    },
    createChannel: async ({ circleId, name, description, createdBy }) => {
      // Checked rather than caught: the unique index would raise a driver error whose text is the
      // constraint's, and turning that back into 'name-taken' means string-matching D1's message.
      const existing = await db
        .prepare('SELECT id FROM channels WHERE circle_id = ? AND name = ?')
        .bind(circleId, name)
        .first<{ id: string }>();
      if (existing) {
        return 'name-taken';
      }
      const id = random();
      const createdAt = now();
      await db
        .prepare(
          'INSERT INTO channels (id, circle_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(id, circleId, name, description ?? null, createdBy, createdAt)
        .run();
      return { id, circleId, name, ...(description === undefined ? {} : { description }), createdBy, createdAt };
    },
    updateChannel: async ({ circleId, channelId, name, description }) => {
      // Scoped by circle in the SELECT, so another circle's channel reads as absent rather than
      // becoming renameable by whoever founded this one.
      const existing = await db
        .prepare('SELECT id, circle_id, name, description, created_by, created_at FROM channels WHERE id = ? AND circle_id = ?')
        .bind(channelId, circleId)
        .first<{
          id: string;
          circle_id: string;
          name: string;
          description: string | null;
          created_by: string;
          created_at: string;
        }>();
      if (!existing) {
        return 'not-found';
      }
      if (name !== undefined && name !== existing.name) {
        // Same reason as createChannel: checked rather than caught, because the unique index raises a
        // driver error whose text is the constraint's.
        const taken = await db
          .prepare('SELECT id FROM channels WHERE circle_id = ? AND name = ?')
          .bind(circleId, name)
          .first<{ id: string }>();
        if (taken) {
          return 'name-taken';
        }
      }
      const nextName = name ?? existing.name;
      // `null` clears, `undefined` leaves the stored value alone.
      const nextDescription = description === undefined ? existing.description : description;
      await db
        .prepare('UPDATE channels SET name = ?, description = ? WHERE id = ? AND circle_id = ?')
        .bind(nextName, nextDescription, channelId, circleId)
        .run();
      return {
        id: existing.id,
        circleId: existing.circle_id,
        name: nextName,
        ...(nextDescription === null ? {} : { description: nextDescription }),
        createdBy: existing.created_by,
        createdAt: existing.created_at,
      };
    },
    setCircleCodeDigest: async (circleId, codeDigest) => {
      await db.prepare('UPDATE circles SET code_digest = ? WHERE id = ?').bind(codeDigest, circleId).run();
    },
    setCircleDisplayChar: async (circleId, displayChar) => {
      await db.prepare('UPDATE circles SET display_char = ? WHERE id = ?').bind(displayChar, circleId).run();
    },
    getCircleInvitePolicy: async (circleId) => {
      const row = await db
        .prepare('SELECT authority_commitment, updated_at FROM circle_invite_policies WHERE circle_id = ?')
        .bind(circleId)
        .first<{ authority_commitment: string | null; updated_at: string }>();
      if (row === null) return undefined;
      // A second read rather than a join: the rules are a set of up to `MAX_INVITE_RULES` rows and a
      // join would repeat the policy per rule for a caller that wants both shapes anyway.
      const { results } = await db
        .prepare('SELECT kind, param FROM circle_invite_rules WHERE circle_id = ? ORDER BY kind')
        .bind(circleId)
        .all<{ kind: string; param: string | null }>();
      return {
        rules: results.map((r) => ({ kind: r.kind, param: r.param })),
        authorityCommitment: row.authority_commitment,
        updatedAt: row.updated_at,
      };
    },
    setCircleInvitePolicy: async (circleId, rules, authorityCommitment) => {
      // ⚠️ **Delete then insert, in one batch.** The rule set is edited as a set, so an upsert that
      // merged would leave a rule the founder deleted still gating the circle — and D1 batches run in
      // one implicit transaction, so a circle is never briefly ungated between the two.
      await db.batch([
        db
          .prepare(
            'INSERT INTO circle_invite_policies (circle_id, kind, param, authority_commitment, updated_at) VALUES (?, ?, ?, ?, ?) ' +
              'ON CONFLICT (circle_id) DO UPDATE SET authority_commitment = excluded.authority_commitment, ' +
              'updated_at = excluded.updated_at',
          )
          // `kind`/`param` are the pre-0016 columns, kept NOT NULL on `kind` by the original schema.
          // Written once with a marker rather than dropped: SQLite rewrites the whole table for a
          // DROP COLUMN, and nothing reads them after 0016.
          .bind(circleId, 'rules', null, authorityCommitment, new Date().toISOString()),
        db.prepare('DELETE FROM circle_invite_rules WHERE circle_id = ?').bind(circleId),
        ...rules.map((r) =>
          db
            .prepare('INSERT INTO circle_invite_rules (circle_id, kind, param) VALUES (?, ?, ?)')
            .bind(circleId, r.kind, r.param),
        ),
      ]);
    },
    clearCircleInvitePolicy: async (circleId) => {
      await db.batch([
        db.prepare('DELETE FROM circle_invite_rules WHERE circle_id = ?').bind(circleId),
        db.prepare('DELETE FROM circle_invite_policies WHERE circle_id = ?').bind(circleId),
      ]);
    },
    reserveCircleInvite: async (circleId, invite, claimant) => {
      // ⚠️ **One conditional write, and the unique index is what makes it safe.** Reading "does this
      // wallet hold one?" and then inserting is two statements, and Workers run many isolates: two
      // requests from the same wallet would both read no and both mint. `INSERT OR IGNORE` against
      // `idx_circle_invites_one_per_claimant` lets exactly one of them insert, and the loser gets
      // `changes: 0` — before either has spent anything on chain.
      const result = await db
        .prepare(
          'INSERT OR IGNORE INTO circle_invites (circle_id, commitment, secret, chain_status, claimed_by, claimed_at, created_at) ' +
            "VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        )
        .bind(circleId, invite.commitment, invite.secret, claimant, new Date().toISOString(), new Date().toISOString())
        .run();
      return (result.meta?.changes ?? 0) > 0 ? 'reserved' : 'already-claimed';
    },
    confirmCircleInvite: async (circleId, commitment) => {
      await db
        .prepare("UPDATE circle_invites SET chain_status = 'confirmed' WHERE circle_id = ? AND commitment = ?")
        .bind(circleId, commitment)
        .run();
    },
    releaseCircleInvite: async (circleId, commitment) => {
      // `chain_status = 'pending'` in the predicate, not just in the caller: a confirmed commitment is
      // on chain, and a delete that raced a settlement callback would drop the only record of a live
      // invite.
      await db
        .prepare("DELETE FROM circle_invites WHERE circle_id = ? AND commitment = ? AND chain_status = 'pending'")
        .bind(circleId, commitment)
        .run();
    },
    getClaimedCircleInvite: async (circleId, claimant) => {
      const row = await db
        .prepare('SELECT commitment, secret, chain_status FROM circle_invites WHERE circle_id = ? AND claimed_by = ?')
        .bind(circleId, claimant)
        .first<{ commitment: string; secret: string; chain_status: string }>();
      return row === null ? undefined : { commitment: row.commitment, secret: row.secret, chainStatus: row.chain_status };
    },
    setCircleFounder: async (circleId, founderLeaf, founderSubject) => {
      await db
        .prepare('UPDATE circles SET founder_leaf = ?, founder_subject = ? WHERE id = ?')
        .bind(founderLeaf, founderSubject, circleId)
        .run();
    },
    setCircleChain: async (circleId, chain) => {
      await db
        .prepare('UPDATE circles SET chain_status = ?, chain_tx_id = ?, chain_seq_id = ?, chain_error = ? WHERE id = ?')
        .bind(...chainBind(chain), circleId)
        .run();
    },
    setMembershipChain: async (circleId, subject, chain) => {
      await db
        .prepare(
          'UPDATE memberships SET chain_status = ?, chain_tx_id = ?, chain_seq_id = ?, chain_error = ? WHERE circle_id = ? AND subject = ?',
        )
        .bind(...chainBind(chain), circleId, subject)
        .run();
    },
    setProposalChain: async (proposalId, chain) => {
      await db
        .prepare('UPDATE proposals SET chain_status = ?, chain_tx_id = ?, chain_seq_id = ?, chain_error = ? WHERE id = ?')
        .bind(...chainBind(chain), proposalId)
        .run();
    },
    setVoteChain: async (proposalId, subject, chain) => {
      await db
        .prepare(
          'UPDATE votes SET chain_status = ?, chain_tx_id = ?, chain_seq_id = ?, chain_error = ? WHERE proposal_id = ? AND subject = ?',
        )
        .bind(...chainBind(chain), proposalId, subject)
        .run();
    },
    getVoteChain: async (proposalId, subject) => {
      const r = await db
        .prepare('SELECT chain_status, chain_tx_id, chain_seq_id, chain_error FROM votes WHERE proposal_id = ? AND subject = ?')
        .bind(proposalId, subject)
        .first<ChainCols>();
      return r ? toChain(r) : undefined;
    },
    listChainBacklog: async () => {
      const backlog: ChainBacklogItem[] = [];
      const circles = await db
        .prepare("SELECT id FROM circles WHERE chain_status = 'failed' ORDER BY rowid ASC")
        .all<{ id: string }>();
      for (const c of circles.results) backlog.push({ kind: 'circle', circleId: c.id });

      const memberships = await db
        .prepare("SELECT circle_id, subject FROM memberships WHERE chain_status = 'failed' ORDER BY rowid ASC")
        .all<{ circle_id: string; subject: string }>();
      for (const m of memberships.results) backlog.push({ kind: 'membership', circleId: m.circle_id, subject: m.subject });

      // Proposal author is a persona label; recover the subject via the circle's membership
      // (personas are unique per circle). Proposals whose author isn't a current member are skipped.
      const proposals = await db
        .prepare(
          "SELECT p.id AS proposal_id, p.circle_id, m.subject AS author_subject FROM proposals p " +
            "JOIN memberships m ON m.circle_id = p.circle_id AND m.persona = p.author COLLATE NOCASE " +
            "WHERE p.chain_status = 'failed' ORDER BY p.rowid ASC",
        )
        .all<{ proposal_id: string; circle_id: string; author_subject: string }>();
      for (const p of proposals.results)
        backlog.push({ kind: 'proposal', circleId: p.circle_id, proposalId: p.proposal_id, authorSubject: p.author_subject });

      const votes = await db
        .prepare(
          "SELECT v.proposal_id, v.subject, v.value, p.circle_id FROM votes v JOIN proposals p ON p.id = v.proposal_id " +
            "WHERE v.chain_status = 'failed' ORDER BY v.rowid ASC",
        )
        .all<{ proposal_id: string; subject: string; value: 'yes' | 'no'; circle_id: string }>();
      for (const v of votes.results)
        backlog.push({ kind: 'vote', circleId: v.circle_id, proposalId: v.proposal_id, subject: v.subject, value: v.value });

      return backlog;
    },
    registerDevice: async (subject, { fcmToken, platform }) => {
      await db
        .prepare(
          'INSERT INTO devices (fcm_token, subject, platform, registered_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT (fcm_token) DO UPDATE SET subject = excluded.subject, platform = excluded.platform, registered_at = excluded.registered_at',
        )
        .bind(fcmToken, subject, platform, now())
        .run();
    },
    listDevices: async (subject) => {
      const { results } = await db
        .prepare('SELECT fcm_token, platform, registered_at FROM devices WHERE subject = ? ORDER BY rowid ASC')
        .bind(subject)
        .all<{ fcm_token: string; platform: string; registered_at: string }>();
      return results.map<Device>((r) => ({ fcmToken: r.fcm_token, platform: r.platform, registeredAt: r.registered_at }));
    },
    removeDevice: async (fcmToken) => {
      await db.prepare('DELETE FROM devices WHERE fcm_token = ?').bind(fcmToken).run();
    },
    listMemberSubjects: async (circleId) => {
      const { results } = await db
        .prepare('SELECT subject FROM memberships WHERE circle_id = ?')
        .bind(circleId)
        .all<{ subject: string }>();
      return results.map((r) => r.subject);
    },
    findSubjectByPersona: async (circleId, persona) => {
      const r = await db
        .prepare('SELECT subject FROM memberships WHERE circle_id = ? AND persona = ? COLLATE NOCASE')
        .bind(circleId, persona)
        .first<{ subject: string }>();
      return r?.subject;
    },

    // ── Direct messages (migration 0003_dm.sql) ──
    publishDmKeyPackages: async (subject, packages) => {
      let added = 0;
      for (const { id, keyPackage } of packages) {
        // INSERT OR IGNORE gives idempotency from the PRIMARY KEY, so a client re-uploading its
        // pool cannot duplicate rows or resurrect an already-claimed package.
        const result = await db
          .prepare('INSERT OR IGNORE INTO dm_key_packages (id, subject, package, created_at) VALUES (?, ?, ?, ?)')
          .bind(id, subject, blobOf(keyPackage), now())
          .run();
        if ((result.meta?.changes ?? 0) > 0) added += 1;
      }
      return added;
    },
    countDmKeyPackages: async (subject) => {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM dm_key_packages WHERE subject = ? AND claimed_at IS NULL')
        .bind(subject)
        .first<{ n: number }>();
      return Number(r?.n ?? 0);
    },
    retireAllDmKeyPackages: async (subject) => {
      const result = await db
        .prepare('DELETE FROM dm_key_packages WHERE subject = ? AND claimed_at IS NULL')
        .bind(subject)
        .run();
      return Number(result.meta?.changes ?? 0);
    },
    retireDmKeyPackages: async (subject, ids) => {
      if (ids.length === 0) return 0;
      // `claimed_at IS NULL` is load-bearing: a claimed row is the tombstone that stops
      // INSERT OR IGNORE from resurrecting a spent single-use init key.
      const placeholders = ids.map(() => '?').join(', ');
      const result = await db
        .prepare(
          `DELETE FROM dm_key_packages WHERE subject = ? AND claimed_at IS NULL AND id IN (${placeholders})`,
        )
        .bind(subject, ...ids)
        .run();
      return Number(result.meta?.changes ?? 0);
    },
    claimDmKeyPackage: async (subject, claimedBy) => {
      // Claim by conditional UPDATE, not SELECT-then-UPDATE: two concurrent adds of the same peer
      // would otherwise both read the same row and reuse a single-use init key. `changes` tells us
      // whether we won.
      const claimedAt = now();
      // ⚠️ **Newest first, not oldest.** FIFO is the prekey convention, but here it means handing out
      // the *most likely dead* package: a reinstalled device leaves its old public halves published
      // with the private ones gone, so the oldest unclaimed rows are exactly the orphans, and every
      // peer claiming one sealed a Welcome that could never be opened. Order does not affect
      // single-use safety — the conditional UPDATE below is what guarantees that — so the tie-break is
      // free to favour liveness. The retention cap deletes the same batch from the other end
      // (`dm-retention.ts`).
      const target = await db
        .prepare(
          'SELECT id, package, created_at FROM dm_key_packages WHERE subject = ? AND claimed_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .bind(subject)
        .first<{ id: string; package: ArrayBuffer | Uint8Array; created_at: string }>();
      if (!target) return undefined;
      const claim = await db
        .prepare('UPDATE dm_key_packages SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL')
        .bind(claimedAt, claimedBy, target.id)
        .run();
      if ((claim.meta?.changes ?? 0) === 0) return undefined;
      return { id: target.id, subject, keyPackage: bytesOf(target.package), createdAt: target.created_at };
    },
    appendDmMessage: async ({ id, convId, sender, recipient, ciphertext, permitJti }) => {
      const createdAt = now();
      await db
        .prepare(
          'INSERT INTO dm_messages (id, conv_id, sender, recipient, ciphertext, created_at, permit_jti) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, convId, sender, recipient, blobOf(ciphertext), createdAt, permitJti ?? null)
        .run();
      return { id, convId, sender, recipient, ciphertext, createdAt, ...(permitJti === undefined ? {} : { permitJti }) };
    },
    // ⚠️ The `(sender = ? OR recipient = ?)` predicate is the fix for D3-era read leakage: a conv_id
    // is a hash of two public ids, so filtering on it alone served any pair's traffic to anyone.
    listDmMessages: async (convId, subject, since) => {
      const { results } = since
        ? await db
            .prepare(
              'SELECT id, conv_id, sender, recipient, ciphertext, created_at, permit_jti FROM dm_messages WHERE conv_id = ? AND (sender = ? OR recipient = ?) AND created_at > ? ORDER BY created_at',
            )
            .bind(convId, subject, subject, since)
            .all<DmMessageRow>()
        : await db
            .prepare(
              'SELECT id, conv_id, sender, recipient, ciphertext, created_at, permit_jti FROM dm_messages WHERE conv_id = ? AND (sender = ? OR recipient = ?) ORDER BY created_at',
            )
            .bind(convId, subject, subject)
            .all<DmMessageRow>();
      return results.map(dmMessageOf);
    },
    readDmPolicy: async (subject) => {
      const row = await db.prepare('SELECT policy FROM dm_policy WHERE subject = ?').bind(subject).first<{
        policy: string;
      }>();
      return isDmPolicy(row?.policy) ? row.policy : undefined;
    },
    writeDmPolicy: async (subject, policy, atIso) => {
      await db
        .prepare(
          'INSERT INTO dm_policy (subject, policy, updated_at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at',
        )
        .bind(subject, policy, atIso)
        .run();
    },
    revokeDmPermit: async (jti, atIso, expiresAtIso) => {
      await db
        .prepare(
          'INSERT INTO dm_permit_revocations (jti, revoked_at, expires_at) VALUES (?, ?, ?) ON CONFLICT(jti) DO UPDATE SET revoked_at = excluded.revoked_at, expires_at = excluded.expires_at',
        )
        .bind(jti, atIso, expiresAtIso)
        .run();
    },
    readDmPermitRevocation: async (jti) => {
      const row = await db
        .prepare('SELECT revoked_at FROM dm_permit_revocations WHERE jti = ?')
        .bind(jti)
        .first<{ revoked_at: string }>();
      return row?.revoked_at;
    },
    clearDmPermitRevocation: async (jti) => {
      await db.prepare('DELETE FROM dm_permit_revocations WHERE jti = ?').bind(jti).run();
    },
    blockDmPeer: async (subject, peer, atIso) => {
      await db
        .prepare('INSERT OR IGNORE INTO dm_blocks (subject, peer, created_at) VALUES (?, ?, ?)')
        .bind(subject, peer, atIso)
        .run();
    },
    unblockDmPeer: async (subject, peer) => {
      await db.prepare('DELETE FROM dm_blocks WHERE subject = ? AND peer = ?').bind(subject, peer).run();
    },
    isDmPeerBlocked: async (subject, peer) => {
      const row = await db
        .prepare('SELECT 1 AS hit FROM dm_blocks WHERE subject = ? AND peer = ?')
        .bind(subject, peer)
        .first<{ hit: number }>();
      return row !== null && row !== undefined;
    },
    listDmBlocks: async (subject) => {
      const { results } = await db
        .prepare('SELECT peer, created_at FROM dm_blocks WHERE subject = ? ORDER BY created_at DESC')
        .bind(subject)
        .all<{ peer: string; created_at: string }>();
      return results.map((r) => ({ peer: r.peer, createdAt: r.created_at }));
    },
    countRecentDmClaims: async (subject, claimedBy, sinceIso) => {
      const row = await db
        .prepare(
          'SELECT COUNT(*) AS n FROM dm_key_packages WHERE subject = ? AND claimed_by = ? AND claimed_at > ?',
        )
        .bind(subject, claimedBy, sinceIso)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    listDmConversations: async (subject) => {
      const { results } = await db
        .prepare(
          `SELECT conv_id,
                  MAX(created_at) AS last_message_at,
                  MAX(CASE WHEN sender = ? THEN recipient ELSE sender END) AS peer
             FROM dm_messages
            WHERE sender = ? OR recipient = ?
            GROUP BY conv_id
            ORDER BY last_message_at DESC`,
        )
        .bind(subject, subject, subject)
        .all<{ conv_id: string; last_message_at: string; peer: string }>();
      return results.map((r) => ({ convId: r.conv_id, peer: r.peer, lastMessageAt: r.last_message_at }));
    },
    putDmWelcome: async ({ id, convId, sender, recipient, welcome, ratchetTree, permitJti }) => {
      const createdAt = now();
      // ⚠️ **Upsert, because the id is derived from the conversation.** The client names a Welcome
      // `<convId>-welcome`, and a conversation id is a hash of the two parties — so a second invite
      // to the same peer reuses the id. A plain INSERT hit the `id` primary key, threw, and the
      // route had no answer for it: the sender saw a 500 and read it as "can't reach", with no way
      // to ever start that conversation again while the first Welcome sat unacked.
      //
      // Replacing is also the correct semantics, not just the survivable one: a re-sent Welcome is
      // for a freshly built group, and the pending row must be the one the recipient can actually
      // join. This is what the in-memory store has always done (`dmWelcomes.set`), which is why the
      // contract tests passed while only D1 threw.
      await db
        .prepare(
          `INSERT INTO dm_welcomes (id, conv_id, sender, recipient, welcome, ratchet_tree, created_at, permit_jti)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
                conv_id = excluded.conv_id,
                sender = excluded.sender,
                recipient = excluded.recipient,
                welcome = excluded.welcome,
                ratchet_tree = excluded.ratchet_tree,
                created_at = excluded.created_at,
                permit_jti = excluded.permit_jti`,
        )
        .bind(id, convId, sender, recipient, blobOf(welcome), blobOf(ratchetTree), createdAt, permitJti ?? null)
        .run();
      return {
        id,
        convId,
        sender,
        recipient,
        welcome,
        ratchetTree,
        createdAt,
        ...(permitJti === undefined ? {} : { permitJti }),
      };
    },
    ackDmWelcomes: async (recipient, ids) => {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(', ');
      const result = await db
        .prepare(`DELETE FROM dm_welcomes WHERE recipient = ? AND id IN (${placeholders})`)
        .bind(recipient, ...ids)
        .run();
      return Number(result.meta?.changes ?? 0);
    },
    ackDmMessages: async (recipient, ids) => {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(', ');
      const result = await db
        .prepare(`DELETE FROM dm_messages WHERE recipient = ? AND id IN (${placeholders})`)
        .bind(recipient, ...ids)
        .run();
      return Number(result.meta?.changes ?? 0);
    },
    listDmWelcomes: async (recipient) => {
      const { results } = await db
        .prepare(
          'SELECT id, conv_id, sender, recipient, welcome, ratchet_tree, created_at, permit_jti FROM dm_welcomes WHERE recipient = ? ORDER BY created_at',
        )
        .bind(recipient)
        .all<DmWelcomeRow>();
      return results.map((r) => ({
        id: r.id,
        convId: r.conv_id,
        sender: r.sender,
        recipient: r.recipient,
        welcome: bytesOf(r.welcome),
        ratchetTree: bytesOf(r.ratchet_tree),
        createdAt: r.created_at,
        ...(r.permit_jti === null || r.permit_jti === undefined ? {} : { permitJti: r.permit_jti }),
      }));
    },
    sweepDmRetention: async (policy, nowMs) => {
      const cutoffs = dmRetentionCutoffs(policy, nowMs);
      const changed = (result: {meta?: {changes?: number} | null}): number => Number(result.meta?.changes ?? 0);

      const welcomes = await db
        .prepare('DELETE FROM dm_welcomes WHERE created_at < ?')
        .bind(cutoffs.welcomesBefore)
        .run();
      const messages = await db
        .prepare('DELETE FROM dm_messages WHERE created_at < ?')
        .bind(cutoffs.messagesBefore)
        .run();
      const expired = await db
        .prepare('DELETE FROM dm_key_packages WHERE claimed_at IS NULL AND created_at < ?')
        .bind(cutoffs.unclaimedBefore)
        .run();

      /**
       * The per-subject cap, as one statement.
       *
       * `ROW_NUMBER()` over each subject's unclaimed packages **newest first** numbers the ones to
       * keep 1..cap; everything numbered past the cap is the older surplus. Doing it in SQL rather
       * than by reading the pool out and deleting ids keeps the sweep O(1) statements regardless of
       * how many subjects have over-published — which, for a table that reached 406 unclaimed rows
       * across an unknown number of subjects, is the difference between one query and hundreds.
       */
      const overCap = await db
        .prepare(
          `DELETE FROM dm_key_packages WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (PARTITION BY subject ORDER BY created_at DESC) AS rank
               FROM dm_key_packages WHERE claimed_at IS NULL
             ) WHERE rank > ?
           )`,
        )
        .bind(policy.unclaimedPerSubject)
        .run();

      // The row stays — it is the tombstone — and only its bytes go. `length(package) > 0` keeps the
      // count honest across repeated sweeps: without it every run would re-report the same rows.
      const tombstones = await db
        .prepare(
          "UPDATE dm_key_packages SET package = X'' WHERE claimed_at IS NOT NULL AND claimed_at < ? AND length(package) > 0",
        )
        .bind(cutoffs.tombstonesClaimedBefore)
        .run();

      return {
        welcomesDeleted: changed(welcomes),
        messagesDeleted: changed(messages),
        unclaimedExpired: changed(expired),
        unclaimedOverCap: changed(overCap),
        tombstonesBlanked: changed(tombstones),
      };
    },
  };
};
