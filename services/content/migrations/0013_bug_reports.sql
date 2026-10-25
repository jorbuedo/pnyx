-- Bug reports: the index over the blobs in R2, so a report can be found without listing a bucket.
--
-- The body itself lives in R2 under `reports/<YYYY-MM-DD>/<id>.json.gz` (`bugReportKey`). This table
-- is the lookup, and it is deliberately thin: enough to search and to decide what to delete, never a
-- second copy of the report.
--
-- ⚠️ **Every column but `address`, `size_bytes` and `created_at_ms` is a CLAIM.** They are read out of
-- the signed body, so they are attributable to the signing address and nothing more — which is what a
-- bug report is. Only the address is proven (CIP-8 over the body digest, `src/bug-report.ts`).
--
-- `description` is truncated to 500 chars on the way in. The full text is in the blob; this is for
-- recognising a report in a list, not for reading it.
--
-- `identity`, `app_version` and `platform` are nullable because a report can legitimately carry none
-- of them — a signed-out reporter has no identity, and a manifest we could not parse yields nothing.
-- A parse failure keeps the blob and files the row with an empty description rather than dropping the
-- one artefact that explains why the app produced something unreadable, so these must not be NOT NULL.
CREATE TABLE IF NOT EXISTS bug_reports (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  address TEXT NOT NULL,
  identity TEXT,
  description TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  size_bytes INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

-- Newest first is how these get read, and it is also the order a retention sweep works in when R2
-- usage forces one.
CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports (created_at_ms DESC);

-- "Everything this reporter has filed" — the question asked when one person hits several bugs.
CREATE INDEX IF NOT EXISTS idx_bug_reports_address ON bug_reports (address, created_at_ms DESC);

-- Replay defence for the upload signature.
--
-- ⚠️ **Separate from `nonces`, which has the opposite lifecycle.** That table is server-*issued*
-- (`issue` then `consume`), so a nonce is valid because we minted it. Here the client mints its own
-- and the server's job is to refuse a repeat, which is an insert-or-conflict — reusing the other table
-- would mean either accepting nonces we never issued or adding a round trip before every upload.
--
-- Rows are pruned opportunistically past the retention window; the signed timestamp is what bounds
-- how long one matters, so the table cannot grow without bound even under abuse.
CREATE TABLE IF NOT EXISTS bug_report_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bug_report_nonces_seen ON bug_report_nonces (seen_at_ms);
