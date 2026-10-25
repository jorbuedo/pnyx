-- Single-use SIWM login nonces, D1-backed (Worker isolates don't share memory).
-- Strong consistency (D1, not KV) so a nonce issued on one isolate is consumable
-- on another and cannot be replayed. Rows are pruned on issue + expire by TTL.
CREATE TABLE nonces (
  nonce     TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL   -- epoch ms
);
