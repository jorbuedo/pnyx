// The /.well-known association files are data, not code, so nothing type-checks them and a
// placeholder can sit live indefinitely: `ANDROID_SHA256_FINGERPRINT` shipped in assetlinks.json for
// a week after the real key existed, and Google's verifier rejected every statement for it, which
// silently disables the passkey rail (`webcredentials:`) on a release build.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wellKnownDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', '.well-known');
const read = (file: string) => readFileSync(path.join(wellKnownDir, file), 'utf8');

/** Uppercase, colon-separated, 32 bytes — the only form Google's verifier accepts. */
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** The release keystore's cert (`docs/ANDROID_SIGNING.md`). Public by design: it goes into this file. */
const RELEASE_FINGERPRINT = '89:28:62:99:6A:F7:EC:6C:9F:7A:85:FD:B3:FA:0D:39:E0:F1:E5:6D:0A:90:4F:2F:10:CC:6C:E1:95:05:3D:BE';

type AssetLink = {
  relation: string[];
  target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
};

describe('assetlinks.json', () => {
  const raw = read('assetlinks.json');
  const statements = JSON.parse(raw) as AssetLink[];

  it('carries no unfilled placeholder', () => {
    expect(raw).not.toContain('ANDROID_SHA256_FINGERPRINT');
  });

  it('states a real fingerprint for every package', () => {
    expect(statements.length).toBeGreaterThan(0);
    for (const { target } of statements) {
      expect(target.namespace).toBe('android_app');
      expect(target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
      for (const fingerprint of target.sha256_cert_fingerprints) {
        expect(fingerprint).toMatch(FINGERPRINT);
      }
    }
  });

  it('delegates login credentials to the release package, which is what the passkey rail needs', () => {
    const release = statements.find((s) => s.target.package_name === 'uk.pxkq.pnyx');
    expect(release).toBeDefined();
    expect(release?.relation).toContain('delegate_permission/common.get_login_creds');
    expect(release?.relation).toContain('delegate_permission/common.handle_all_urls');
    expect(release?.target.sha256_cert_fingerprints).toContain(RELEASE_FINGERPRINT);
  });
});

describe('apple-app-site-association', () => {
  // ⚠️ APPLE_TEAM_ID is still a placeholder here, deliberately: there is no Apple Developer account
  // yet, so the Team ID does not exist to fill in. Assert the shape, not the absence of the
  // placeholder — tighten this to match assetlinks.json once an iOS build is possible.
  const aasa = JSON.parse(read('apple-app-site-association')) as {
    applinks: { details: { appIDs: string[] }[] };
    webcredentials: { apps: string[] };
  };

  it('binds the same bundle ids for links and web credentials', () => {
    const appIDs = aasa.applinks.details.flatMap((d) => d.appIDs);
    expect(appIDs).toEqual(aasa.webcredentials.apps);
    for (const appID of appIDs) {
      expect(appID).toMatch(/\.uk\.pxkq\.pnyx(\.\w+)?$/);
    }
  });
});
