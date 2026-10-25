// Circuit-artifact manifest + serving. The routes mirror the R2 bucket layout exactly, so
// EXPO_PUBLIC_ARTIFACTS_URL can point at either. Uses the real
// contract/managed/circle compile output; skips loudly if it is absent (a missing compile artifact is
// not a regression).
//
// Artifacts are keyed by the compiled contract, not by a deployment: a circle's verifier keys must be
// servable before its contract exists (docs/CONTRACT_MIGRATION.md).
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractCodeDigest } from '@pnyx/chain-client/sponsorship';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ArtifactService, createArtifactService } from './artifacts.js';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

const managedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../contract/managed/circle');
const TARGET = 'circle';
const HAVE_MANAGED = existsSync(managedDir);
const d = HAVE_MANAGED ? describe : describe.skip;
if (!HAVE_MANAGED) {
  console.warn(`SKIP artifacts.test: ${managedDir} missing — run \`bun run compile:contract\``);
}

d('createArtifactService', () => {
  let service: ArtifactService;
  beforeAll(() => {
    service = createArtifactService(managedDir, TARGET);
  });

  it('lists the compiled forum circuits with size + sha256 per artifact', () => {
    const m = service.manifest();
    expect(m.target).toBe(TARGET);
    // The digest is over the verifier keys, so it identifies the compiled code.
    expect(m.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    // Every circuit `circle.compact` exports must be present with all three artifact kinds. Voting
    // moved to `proposal.compact` — a separate target — when proposals became their own contracts
    // (`docs/BOUNDED_STATE_ARCHITECTURE.md` §10), so `castVote`/`revealVote` are not served here.
    for (const circuit of ['setInvite', 'addModerator', 'join', 'setMember', 'leaveCircle']) {
      const c = m.circuits[circuit];
      expect(c, `circuit ${circuit}`).toBeDefined();
      for (const kind of ['bzkir', 'prover', 'verifier'] as const) {
        expect(c?.[kind].size).toBeGreaterThan(0);
        expect(c?.[kind].sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // Prover keys dwarf verifier keys — a sanity check the files aren't swapped.
      expect(c?.prover.size).toBeGreaterThan(Number(c?.verifier.size));
    }
  });

  it('memoizes the manifest (same object across calls)', () => {
    expect(service.manifest()).toBe(service.manifest());
  });

  // The load-bearing equality of the sponsorship policy: the sponsor recognises a circle by hashing the
  // verifier keys the chain carries in `operations`, and it is configured with the digest THIS service
  // publishes. If the two computations ever drift, the sponsor stops paying for every circle at once —
  // and the reason would look like an unrelated contract rather than a hashing difference. So the two
  // are checked against each other over the real compiled keys, through both production functions.
  it('publishes the same code digest the sponsor derives from a deployed contract', () => {
    const m = service.manifest();
    const asDeployedState = {
      // Deliberately not in manifest order: `operations()` returns the ledger map's iteration order.
      operations: () => Object.keys(m.circuits).reverse(),
      operation: (name: string | Uint8Array) => {
        const file = service.filePath(String(name), 'verifier');
        return file === undefined ? undefined : { verifierKey: new Uint8Array(readFileSync(file)) };
      },
    };
    expect(contractCodeDigest(asDeployedState)).toBe(m.codeDigest);
  });

  it('resolves a valid (circuit, kind) to an existing path and rejects unknown/traversal input', () => {
    expect(service.filePath('join', 'prover')).toContain('keys/join.prover');
    expect(service.filePath('join', 'bzkir')).toContain('zkir/join.bzkir');
    expect(service.filePath('join', 'nonsense')).toBeUndefined();
    expect(service.filePath('nonesuch', 'prover')).toBeUndefined();
    // Path traversal: the circuit is validated against the known set, so this never resolves.
    expect(service.filePath('../../../../etc/passwd', 'prover')).toBeUndefined();
  });

  it('discovers + serves KZG SRS params by K from the params dir (with hashes)', () => {
    // Fake SRS cache so the test is deterministic + doesn't depend on the real ~/.cache download.
    const paramsDir = mkdtempSync(path.join(tmpdir(), 'pnyx-srs-'));
    const srs14 = Buffer.from('fake-srs-2p14');
    writeFileSync(path.join(paramsDir, 'bls_midnight_2p14'), srs14);
    writeFileSync(path.join(paramsDir, 'bls_midnight_2p15'), Buffer.from('fake-srs-2p15'));
    writeFileSync(path.join(paramsDir, 'unrelated-file'), 'ignore me');

    const withParams = createArtifactService(managedDir, TARGET, paramsDir);
    const m = withParams.manifest();
    expect(Object.keys(m.params).sort()).toEqual(['14', '15']);
    expect(m.params['14']?.size).toBe(srs14.length);
    expect(m.params['14']?.sha256).toBe(createHash('sha256').update(srs14).digest('hex'));
    expect(withParams.paramsPath('14')).toBe(path.join(paramsDir, 'bls_midnight_2p14'));
    expect(withParams.paramsPath('99')).toBeUndefined();
    expect(withParams.paramsPath('../etc')).toBeUndefined();
  });

  it('has empty params when no params dir is provided', () => {
    expect(service.manifest().params).toEqual({});
    expect(service.paramsPath('14')).toBeUndefined();
  });
});

d('GET /chain/artifacts routes', () => {
  type Handler = (r: Request) => Promise<Response>;
  const makeHandler = async (artifacts: Record<string, ArtifactService> | undefined): Promise<Handler> => {
    const keys = await createJwtKeys();
    const store = createContentStore();
    return createHandler({
      auth: {
        domain: 'pnyx.test',
        network: 'undeployed',
        nonces: createNonceStore(),
        jwt: { privateKey: keys.privateKey, issuer: 'https://pnyx-content-service', audience: 'pnyx', ttlSeconds: 3600 },
      },
      publicJwk: keys.publicJwk,
      store,
      devAuth: true,
      chain: disabledChainMirror,
      notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
      ...(artifacts ? { artifacts } : {}),
    });
  };
  const get = (h: Handler, p: string) => h(new Request(`http://svc${p}`));

  it('serves the manifest and a file, and 404s an unknown circuit', async () => {
    const h = await makeHandler({circle: createArtifactService(managedDir, TARGET)});
    const manifestRes = await get(h, '/chain/artifacts/circle/manifest.json');
    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as {
      target: string;
      codeDigest: string;
      circuits: Record<string, { verifier: { size: number } }>;
    };
    expect(manifest.target).toBe(TARGET);
    expect(manifest.circuits.join).toBeDefined();

    const fileRes = await get(h, '/chain/artifacts/circle/join.verifier');
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    // The served file must match the size the manifest advertised for it.
    expect(bytes.length).toBe(manifest.circuits.join?.verifier.size);

    // Two distinct failures, and they answer differently on purpose: a target this deployment does
    // not serve is a configuration answer (503), an unknown circuit within a served target is a
    // not-found (404).
    expect((await get(h, '/chain/artifacts/nonesuch/manifest.json')).status).toBe(503);
    expect((await get(h, '/chain/artifacts/circle/nosuchcircuit.prover')).status).toBe(404);
  });

  it('serves an SRS file by K and 404s an unavailable K', async () => {
    const paramsDir = mkdtempSync(path.join(tmpdir(), 'pnyx-srs-route-'));
    const srs = Buffer.from('fake-srs-bytes-2p14')
    writeFileSync(path.join(paramsDir, 'bls_midnight_2p14'), srs);
    const h = await makeHandler({circle: createArtifactService(managedDir, TARGET, paramsDir)});

    const res = await get(h, '/chain/artifacts/params/bls_midnight_2p14');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(srs.length);

    expect((await get(h, '/chain/artifacts/params/bls_midnight_2p99')).status).toBe(404);
  });

  it('503s when the chain (and thus artifacts) is disabled', async () => {
    const h = await makeHandler(undefined);
    expect((await get(h, '/chain/artifacts/circle/manifest.json')).status).toBe(503);
    expect((await get(h, '/chain/artifacts/circle/castVote.verifier')).status).toBe(503);
    expect((await get(h, '/chain/artifacts/params/bls_midnight_2p14')).status).toBe(503);
  });
});
