// Authenticated bug-report intake: verify a CIP-8 signature over the body, store the blob in
// R2, index it in D1.
//
// ## The Worker is a dumb sink, on purpose
//
// The body is one gzipped JSON document the app built (`report-bundle.ts` there). This module
// authenticates it, checks its size, stores it byte-for-byte, and pulls a handful of fields out
// for the index. It does not validate the report's *shape* beyond what the index needs: a
// malformed report from a key we can attribute is still evidence, and refusing it would
// discard the one artefact that explains why the app produced it.
//
// ⚠️ **Indexed fields are the reporter's claims, not verified facts.** `description`,
// `appVersion` and `platform` come out of the signed body, so they are attributable to the
// signing address and nothing more. Treat them as what somebody said, which is exactly what a
// bug report is.
//
// ## Ports, not bindings
//
// R2, D1 and the COSE verifier arrive as functions. That is what lets the whole decision path
// be tested without a Worker runtime or a real key — and the verifier in particular must be
// swappable, because a test that stubs "signature ok" and one that stubs "signature bad" are
// the two cases worth having.

import {
  checkSignedUploadEnvelope,
  type SignedUploadEnvelopeRejection,
  type SignedUploadFields,
  signedUploadPayload,
} from '@pnyx/crypto';

/** The domain tag this endpoint's signatures carry. Must match the app's constant exactly. */
export const BUG_REPORT_DOMAIN = 'pnyx-bug-report';

/** Hard ceiling on one stored body. The app enforces the same number before it uploads. */
export const MAX_BUG_REPORT_BYTES = 8 * 1024 * 1024;

/** How long a consumed nonce is remembered — the skew window, plus slack for a slow request. */
export const NONCE_RETENTION_MS = 10 * 60_000;

/** Longest description we copy into the index. The full text stays in the stored body. */
export const INDEXED_DESCRIPTION_CHARS = 500;

/** Header names carrying the signature envelope. Lowercase: `Headers.get` is case-insensitive. */
export const BUG_REPORT_HEADERS = {
  signature: 'x-pnyx-report-signature',
  key: 'x-pnyx-report-key',
  address: 'x-pnyx-report-address',
  timestamp: 'x-pnyx-report-timestamp',
  nonce: 'x-pnyx-report-nonce',
  digest: 'x-pnyx-report-digest',
} as const;

export type BugReportPorts = {
  /**
   * Verify a COSE_Sign1 as proof that the signer controls `addressHex` **and** signed exactly
   * `expectedPayload`.
   *
   * ⚠️ **Both halves, or this is an auth bypass.** `Cose.verifyDataForAddress` proves the
   * signature is valid over whatever the message carries and that the key owns the address —
   * never *what* was signed. Without the payload comparison, any signature that address ever
   * produced is accepted, and our identity key also signs the Koios and SteelSwap challenges.
   * See `packages/crypto/signed-upload.ts` and `cose-payload.ts`.
   */
  readonly verify: (params: {
    readonly signatureHex: string;
    readonly keyHex: string;
    readonly addressHex: string;
    readonly expectedPayload: string;
  }) => Promise<boolean>;
  /** Record a nonce; `false` when it was already present, which is a replay. */
  readonly claimNonce: (nonce: string, nowMs: number) => Promise<boolean>;
  /** Store the body verbatim. */
  readonly putBlob: (key: string, body: Uint8Array) => Promise<void>;
  /** Index the report. */
  readonly insertRow: (row: BugReportRow) => Promise<void>;
  /** Gunzip + parse the manifest for the indexed fields. `null` when it is not readable. */
  readonly readManifest: (body: Uint8Array) => Promise<Record<string, unknown> | null>;
  readonly now: () => number;
  readonly reportId: () => string;
};

export type BugReportRow = {
  readonly id: string;
  readonly r2Key: string;
  readonly address: string;
  /** From the signed body when present. `null` when the report carries none. */
  readonly identity: string | null;
  readonly description: string;
  readonly appVersion: string | null;
  readonly platform: string | null;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
};

/** Why an upload was refused. Each maps to one status and one log line. */
export type BugReportRejection =
  | SignedUploadEnvelopeRejection
  | 'missing-headers'
  | 'too-large'
  | 'empty'
  | 'replayed'
  | 'bad-signature';

/**
 * Pull the envelope out of the headers.
 *
 * `null` when anything is missing. Deliberately not partial: a request with four of six
 * headers is not a request to be repaired, and reporting which one is absent would help an
 * attacker enumerate the protocol more than it helps a client that has the spec.
 */
export const readEnvelopeHeaders = (
  headers: Headers,
): { readonly fields: SignedUploadFields; readonly signatureHex: string; readonly keyHex: string; readonly addressHex: string } | null => {
  const signatureHex = headers.get(BUG_REPORT_HEADERS.signature);
  const keyHex = headers.get(BUG_REPORT_HEADERS.key);
  const addressHex = headers.get(BUG_REPORT_HEADERS.address);
  const timestamp = headers.get(BUG_REPORT_HEADERS.timestamp);
  const nonce = headers.get(BUG_REPORT_HEADERS.nonce);
  const digest = headers.get(BUG_REPORT_HEADERS.digest);
  if (
    signatureHex === null ||
    keyHex === null ||
    addressHex === null ||
    timestamp === null ||
    nonce === null ||
    digest === null
  ) {
    return null;
  }
  const timestampMs = Number(timestamp);
  // `Number('')` is 0 and `Number('12abc')` is NaN; both fail the well-formed check downstream,
  // so this stays a parse and the rule lives in one place.
  return {
    fields: { domain: BUG_REPORT_DOMAIN, timestampMs, nonce, bodySha256Hex: digest.toLowerCase() },
    signatureHex,
    keyHex,
    addressHex,
  };
};

const hex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

/** SHA-256 of the received bytes, as lowercase hex. WebCrypto is available in Workers. */
export const sha256Hex = async (body: Uint8Array): Promise<string> => {
  // `body.slice()` gives an ArrayBuffer whose byteLength matches the view — a subarray of a
  // larger buffer would otherwise hash its backing store rather than the message.
  const digest = await crypto.subtle.digest('SHA-256', body.slice().buffer as ArrayBuffer);
  return hex(new Uint8Array(digest));
};

/** Take a string field off the parsed manifest, or `null`. Never a placeholder. */
const stringField = (source: Record<string, unknown> | null, path: readonly string[]): string | null => {
  let cursor: unknown = source;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' ? cursor : null;
};

/**
 * The R2 key for a report.
 *
 * Date-prefixed so a retention sweep can list and delete by day without reading the index —
 * which is the operation this whole feature is expected to need once R2 fills up.
 */
export const bugReportKey = (id: string, createdAtMs: number): string => {
  const day = new Date(createdAtMs).toISOString().slice(0, 10);
  return `reports/${day}/${id}.json.gz`;
};

/** Status for each refusal. 401 only for the signature itself; the rest are the client's shape. */
const statusFor = (rejection: BugReportRejection): number => {
  switch (rejection) {
    case 'bad-signature':
      return 401;
    case 'replayed':
      return 409;
    case 'too-large':
      return 413;
    case 'clock-skew':
      return 400;
    default:
      return 400;
  }
};

export type BugReportOutcome =
  | { readonly ok: true; readonly id: string; readonly status: 202 }
  | { readonly ok: false; readonly rejection: BugReportRejection; readonly status: number };

/**
 * Accept one bug report.
 *
 * Order is deliberate and is the cheap-first rule: headers, then size, then the envelope
 * (digest and clock, no key material), then the nonce, and only then the signature. An
 * ed25519 verify on a request whose digest already disagrees is work an isolate is billed for
 * on someone else's behalf.
 *
 * ⚠️ **The nonce is claimed before the signature is checked, and that is the safe order.** A
 * valid signature over a replayed nonce must fail, so the claim cannot come after; the cost is
 * that a garbage request burns a nonce row, which is bounded by the retention window and by
 * the rate limiter in front of this route.
 */
export const acceptBugReport = async (
  request: Request,
  ports: BugReportPorts,
): Promise<BugReportOutcome> => {
  const envelope = readEnvelopeHeaders(request.headers);
  if (envelope === null) return { ok: false, rejection: 'missing-headers', status: 400 };

  const buffer = await request.arrayBuffer();
  const body = new Uint8Array(buffer);
  if (body.byteLength === 0) return { ok: false, rejection: 'empty', status: 400 };
  if (body.byteLength > MAX_BUG_REPORT_BYTES) return { ok: false, rejection: 'too-large', status: 413 };

  const receivedBodySha256Hex = await sha256Hex(body);
  const now = ports.now();
  const envelopeRejection = checkSignedUploadEnvelope({
    fields: envelope.fields,
    receivedBodySha256Hex,
    serverNowMs: now,
  });
  if (envelopeRejection !== null) {
    return { ok: false, rejection: envelopeRejection, status: statusFor(envelopeRejection) };
  }

  const fresh = await ports.claimNonce(envelope.fields.nonce, now);
  if (!fresh) return { ok: false, rejection: 'replayed', status: 409 };

  const verified = await ports.verify({
    signatureHex: envelope.signatureHex,
    keyHex: envelope.keyHex,
    addressHex: envelope.addressHex,
    expectedPayload: signedUploadPayload(envelope.fields),
  });
  if (!verified) return { ok: false, rejection: 'bad-signature', status: 401 };

  const id = ports.reportId();
  const r2Key = bugReportKey(id, now);
  await ports.putBlob(r2Key, body);

  // Read *after* storing. If the manifest is unreadable the blob is still kept and still
  // indexed with an empty description — a report we cannot parse is the one most worth having,
  // and losing it to a strict index would be the wrong trade.
  const manifest = await ports.readManifest(body);
  await ports.insertRow({
    id,
    r2Key,
    address: envelope.addressHex,
    identity: stringField(manifest, ['context', 'identity']),
    description: (stringField(manifest, ['description']) ?? '').slice(0, INDEXED_DESCRIPTION_CHARS),
    appVersion: stringField(manifest, ['context', 'appVersion']),
    platform: stringField(manifest, ['context', 'platform']),
    sizeBytes: body.byteLength,
    createdAtMs: now,
  });

  return { ok: true, id, status: 202 };
};
