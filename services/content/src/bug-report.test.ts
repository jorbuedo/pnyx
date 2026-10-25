import { signedUploadPayload } from '@pnyx/crypto';
import { describe, expect, it } from 'vitest';
import {
  acceptBugReport,
  BUG_REPORT_DOMAIN,
  BUG_REPORT_HEADERS,
  type BugReportPorts,
  type BugReportRow,
  bugReportKey,
  MAX_BUG_REPORT_BYTES,
  readEnvelopeHeaders,
  sha256Hex,
} from './bug-report.js';

const NOW = 1_757_000_000_000;

const gzJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

type Harness = {
  readonly ports: BugReportPorts;
  readonly rows: BugReportRow[];
  readonly blobs: Map<string, Uint8Array>;
  readonly verifyCalls: { expectedPayload: string; addressHex: string }[];
};

const harness = (over: Partial<BugReportPorts> = {}): Harness => {
  const rows: BugReportRow[] = [];
  const blobs = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  const verifyCalls: { expectedPayload: string; addressHex: string }[] = [];
  const ports: BugReportPorts = {
    verify: async (p) => {
      verifyCalls.push({ expectedPayload: p.expectedPayload, addressHex: p.addressHex });
      return true;
    },
    claimNonce: async (nonce) => {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    },
    putBlob: async (key, body) => {
      blobs.set(key, body);
    },
    insertRow: async (row) => {
      rows.push(row);
    },
    readManifest: async (body) => JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>,
    now: () => NOW,
    reportId: () => 'report-1',
    ...over,
  };
  return { ports, rows, blobs, verifyCalls };
};

const manifest = {
  description: 'it broke after tapping send',
  context: { identity: 'pnyx_id1abc', appVersion: '1.2.3', platform: 'android' },
};

const request = async (
  body: Uint8Array,
  over: Partial<Record<keyof typeof BUG_REPORT_HEADERS, string>> = {},
): Promise<Request> => {
  const digest = await sha256Hex(body);
  const headers = new Headers({
    [BUG_REPORT_HEADERS.signature]: 'aa',
    [BUG_REPORT_HEADERS.key]: 'bb',
    [BUG_REPORT_HEADERS.address]: 'cc',
    [BUG_REPORT_HEADERS.timestamp]: String(NOW),
    [BUG_REPORT_HEADERS.nonce]: 'nonce_0123456789abcdef',
    [BUG_REPORT_HEADERS.digest]: digest,
  });
  for (const [name, value] of Object.entries(over)) {
    headers.set(BUG_REPORT_HEADERS[name as keyof typeof BUG_REPORT_HEADERS], value);
  }
  return new Request('https://pnyx.test/bug-report', { method: 'POST', headers, body: body.slice() });
};

describe('acceptBugReport', () => {
  it('stores the body verbatim and indexes what the manifest claims', async () => {
    const h = harness();
    const body = gzJson(manifest);
    const outcome = await acceptBugReport(await request(body), h.ports);

    expect(outcome).toEqual({ ok: true, id: 'report-1', status: 202 });
    expect(h.blobs.get(bugReportKey('report-1', NOW))).toEqual(body);
    expect(h.rows[0]).toMatchObject({
      id: 'report-1',
      address: 'cc',
      identity: 'pnyx_id1abc',
      description: 'it broke after tapping send',
      appVersion: '1.2.3',
      platform: 'android',
      sizeBytes: body.byteLength,
    });
  });

  // ⚠️ The whole point of the protocol. `Cose.verifyDataForAddress` never looks at what was
  // signed, so the canonical string has to reach the verifier and be compared — if this
  // regressed, a signature the same identity key made for Koios or SteelSwap would
  // authenticate an upload here.
  it('asks the verifier for exactly the canonical string as the signed payload', async () => {
    const h = harness();
    const body = gzJson(manifest);
    await acceptBugReport(await request(body), h.ports);

    expect(h.verifyCalls[0]?.expectedPayload).toBe(
      signedUploadPayload({
        domain: BUG_REPORT_DOMAIN,
        timestampMs: NOW,
        nonce: 'nonce_0123456789abcdef',
        bodySha256Hex: await sha256Hex(body),
      }),
    );
    expect(h.verifyCalls[0]?.expectedPayload).toContain(BUG_REPORT_DOMAIN);
  });

  it('refuses a bad signature and stores nothing', async () => {
    const h = harness({ verify: async () => false });
    const outcome = await acceptBugReport(await request(gzJson(manifest)), h.ports);

    expect(outcome).toEqual({ ok: false, rejection: 'bad-signature', status: 401 });
    expect(h.blobs.size).toBe(0);
    expect(h.rows).toEqual([]);
  });

  it('refuses a body that is not the one signed', async () => {
    const h = harness();
    const outcome = await acceptBugReport(await request(gzJson(manifest), { digest: 'a'.repeat(64) }), h.ports);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.rejection).toBe('body-digest-mismatch');
    expect(h.blobs.size).toBe(0);
  });

  // A valid signature over a nonce already used must fail, which is why the claim happens
  // before the verify rather than after it.
  it('refuses a replay of an already-seen nonce', async () => {
    const h = harness();
    const body = gzJson(manifest);
    expect((await acceptBugReport(await request(body), h.ports)).ok).toBe(true);
    const second = await acceptBugReport(await request(body), h.ports);

    expect(second).toEqual({ ok: false, rejection: 'replayed', status: 409 });
    expect(h.rows).toHaveLength(1);
  });

  it('never reaches the signature check when the nonce is spent', async () => {
    const h = harness({ claimNonce: async () => false });
    await acceptBugReport(await request(gzJson(manifest)), h.ports);

    expect(h.verifyCalls).toEqual([]);
  });

  it('refuses a body over the ceiling without hashing it into the store', async () => {
    const h = harness();
    const body = new Uint8Array(MAX_BUG_REPORT_BYTES + 1);
    const outcome = await acceptBugReport(await request(body), h.ports);

    expect(outcome).toEqual({ ok: false, rejection: 'too-large', status: 413 });
    expect(h.blobs.size).toBe(0);
  });

  it('refuses an empty body rather than filing a report with nothing in it', async () => {
    const h = harness();
    const outcome = await acceptBugReport(await request(new Uint8Array(0)), h.ports);

    expect(outcome.ok === false && outcome.rejection).toBe('empty');
  });

  it('refuses a request missing any envelope header', async () => {
    const h = harness();
    const req = await request(gzJson(manifest));
    req.headers.delete(BUG_REPORT_HEADERS.nonce);
    const outcome = await acceptBugReport(req, h.ports);

    expect(outcome).toEqual({ ok: false, rejection: 'missing-headers', status: 400 });
  });

  it('refuses a clock too far out in either direction', async () => {
    const h = harness();
    const far = String(NOW + 6 * 60_000);
    const outcome = await acceptBugReport(await request(gzJson(manifest), { timestamp: far }), h.ports);

    expect(outcome.ok === false && outcome.rejection).toBe('clock-skew');
  });

  // ⚠️ A report we cannot parse is the one most worth having. Losing it to a strict index
  // would discard the artefact that explains why the app produced something unparseable.
  it('keeps and indexes a report whose manifest will not parse', async () => {
    const h = harness({ readManifest: async () => null });
    const outcome = await acceptBugReport(await request(gzJson(manifest)), h.ports);

    expect(outcome.ok).toBe(true);
    expect(h.blobs.size).toBe(1);
    expect(h.rows[0]).toMatchObject({ description: '', identity: null, appVersion: null, platform: null });
  });

  it('keeps a missing manifest field null rather than inventing a placeholder', async () => {
    const h = harness({ readManifest: async () => ({ description: 'x' }) });
    await acceptBugReport(await request(gzJson(manifest)), h.ports);

    expect(h.rows[0]).toMatchObject({ identity: null, appVersion: null, platform: null });
  });
});

describe('readEnvelopeHeaders', () => {
  it('normalises the digest to lowercase, so a client casing it differently still verifies', async () => {
    const headers = new Headers({
      [BUG_REPORT_HEADERS.signature]: 'aa',
      [BUG_REPORT_HEADERS.key]: 'bb',
      [BUG_REPORT_HEADERS.address]: 'cc',
      [BUG_REPORT_HEADERS.timestamp]: String(NOW),
      [BUG_REPORT_HEADERS.nonce]: 'nonce_0123456789abcdef',
      [BUG_REPORT_HEADERS.digest]: 'A'.repeat(64),
    });

    expect(readEnvelopeHeaders(headers)?.fields.bodySha256Hex).toBe('a'.repeat(64));
  });

  it('stamps this endpoint domain rather than trusting a client-supplied one', () => {
    // A domain the caller could choose is not a domain separator — it would let a signature
    // minted for one endpoint name be presented at another.
    const headers = new Headers({
      [BUG_REPORT_HEADERS.signature]: 'aa',
      [BUG_REPORT_HEADERS.key]: 'bb',
      [BUG_REPORT_HEADERS.address]: 'cc',
      [BUG_REPORT_HEADERS.timestamp]: String(NOW),
      [BUG_REPORT_HEADERS.nonce]: 'nonce_0123456789abcdef',
      [BUG_REPORT_HEADERS.digest]: 'a'.repeat(64),
    });

    expect(readEnvelopeHeaders(headers)?.fields.domain).toBe(BUG_REPORT_DOMAIN);
  });
});

describe('bugReportKey', () => {
  it('prefixes by day, so a retention sweep can delete without reading the index', () => {
    expect(bugReportKey('abc', Date.UTC(2026, 8, 8, 13, 0, 0))).toBe('reports/2026-09-08/abc.json.gz');
  });
});
