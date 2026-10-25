// Mint a circle invite on the sponsor host: build a proven `issueInvite` call with no device in it.
//
// **Why this exists.** A gated circle admits whoever holds an unspent invite, and a self-service
// attestor's whole output *is* an invite — so the moment the service can evaluate a Cardano
// predicate it also has to be able to put a commitment on chain. Until 2026-09-10 it could not: the
// founder pre-minted a pool on their phone and uploaded the secrets, which meant the service held
// usable codes and a circle whose pool ran dry answered `409` until its founder noticed.
//
// **Why a subprocess.** The device rail proves through `@pnyx/midnight-native`, a Rust static library
// with a JNI/Swift bridge — there is no Node binding, and writing one for this host would be a second
// implementation of a transcript that the compiler can silently move underneath us. `pnyx_txgen` is
// the same Rust, already gated by a prove+verify oracle (`tests/build_moderation_preimages.rs`), so
// running the binary is the one route that cannot drift from what devices prove.
//
// ⚠️ **This host still depends on nothing that a contract redeploy invalidates — except this.** The
// promise in `docs/SPONSOR_HOST.md` is that no contract module and no ZK artifact lives here, and the
// minting path breaks it deliberately: `issueInvite`'s three artifacts must match the compile the
// circles were deployed from. They are version-checked against the artifact manifest's digest at
// boot, so a stale mirror refuses rather than proving something no circle will accept.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inviteAuthoritySkHex } from './invite-authority.js';

const run = promisify(execFile);

/** How long a mint may take before it is reported as a failure rather than waited on. */
const MINT_TIMEOUT_MS = 180_000;

export type InviteMinterConfig = {
  /** The `pnyx_txgen` binary, pushed by `deploy/push-invite-minter.sh`. */
  readonly binary: string;
  /** A managed directory holding `zkir/issueInvite.bzkir` and `keys/issueInvite.{prover,verifier}`. */
  readonly artifactsDir: string;
  /** Where the KZG SRS lives — `MIDNIGHT_PP` for the child, so it is not read from `$HOME`. */
  readonly paramsDir: string;
  /** The deployment's invite-authority root, already parsed and length-checked. */
  readonly root: Uint8Array;
  /** The chain's own network id string (`preprod`), which the transaction is bound to. */
  readonly network: string;
  readonly log: (message: string) => void;
};

export type InviteMinter = {
  /**
   * Build a proven `issueInvite` transaction for one circle.
   *
   * `contractState` is the circle's *current* serialized ledger state — the transcript runs against
   * it, so a stale read produces a transaction the ledger rejects rather than a wrong answer.
   */
  mint(input: {
    readonly contentCircleId: string;
    readonly contractAddressHex: string;
    readonly contractState: Uint8Array;
    readonly commitmentHex: string;
    readonly active: boolean;
  }): Promise<Uint8Array>;
};

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * Everything the mint path needs on disk, checked once at boot.
 *
 * Checked eagerly and by name because the alternative is a founder's first self-service claim failing
 * with a Rust panic about a missing file, minutes after the box reported itself healthy. Absent →
 * the routes 404, which is the honest answer for a deployment that has not mirrored the artifacts.
 */
export const inviteMinterReady = (
  config: Pick<InviteMinterConfig, 'binary' | 'artifactsDir' | 'paramsDir'> & {
    /**
     * The template this sponsor funds. The mirrored artifacts must be the *same* compile.
     *
     * ⚠️ **This check exists because it has already gone wrong.** Artifacts were a contract behind
     * once before, and the failure mode is silent on both sides: a device proves against one compile
     * while the host proves against another, and every mint produces a transaction the circles reject
     * for a reason that names the ledger rather than the mirror. The digest is written beside the
     * artifacts by `deploy/push-invite-minter.sh`, so re-running the push is what fixes a mismatch.
     */
    readonly circleCodeDigest: string;
  },
):
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly string[] }
  | { readonly ok: false; readonly stale: { readonly mirrored: string; readonly configured: string } } => {
  const digestFile = path.join(config.artifactsDir, 'codeDigest');
  const needed = [
    config.binary,
    path.join(config.artifactsDir, 'zkir', 'issueInvite.bzkir'),
    path.join(config.artifactsDir, 'keys', 'issueInvite.prover'),
    path.join(config.artifactsDir, 'keys', 'issueInvite.verifier'),
    // K=13 for `issueInvite`, measured. Named rather than globbed so a mirror that fetched every SRS
    // *but* this one fails here instead of inside the prover.
    path.join(config.paramsDir, 'bls_midnight_2p13'),
    digestFile,
  ];
  const missing = needed.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) return { ok: false, missing };
  const mirrored = fs.readFileSync(digestFile, 'utf8').trim().toLowerCase();
  const configured = config.circleCodeDigest.trim().toLowerCase();
  return mirrored === configured ? { ok: true } : { ok: false, stale: { mirrored, configured } };
};

export const createInviteMinter = (config: InviteMinterConfig): InviteMinter => ({
  mint: async ({ contentCircleId, contractAddressHex, contractState, commitmentHex, active }) => {
    // The binary reads the state from a file rather than stdin, so one is written per call and
    // removed after. In a temp directory of its own: two concurrent mints for different circles must
    // not share a path, and a fixed name would have the second overwrite the first's input mid-read.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnyx-invite-'));
    const stateFile = path.join(dir, 'circle.contract_state');
    const startedAt = Date.now();
    try {
      fs.writeFileSync(stateFile, contractState);
      const { stdout } = await run(
        config.binary,
        [
          'issue-invite',
          config.artifactsDir,
          stateFile,
          contractAddressHex,
          inviteAuthoritySkHex(config.root, contentCircleId),
          commitmentHex,
          String(active),
          config.network,
          String(Math.floor(Date.now() / 1000) + 3600),
        ],
        {
          timeout: MINT_TIMEOUT_MS,
          // The proven transaction comes back as hex on stdout — ~10 KB today. Generous rather than
          // tight: a truncated read would be reported as malformed hex, which names nothing.
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, MIDNIGHT_PP: config.paramsDir },
        },
      );
      const hex = stdout.trim();
      if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error(`pnyx_txgen did not return a transaction (${hex.length} characters of output)`);
      }
      config.log(`minted an invite for circle ${contentCircleId} in ${Date.now() - startedAt}ms (${hex.length / 2} bytes)`);
      return fromHex(hex);
    } catch (error) {
      // The binary reports every refusal by panicking with a sentence — "not the invite authority",
      // "this circle has delegated to nobody" — and that sentence is on **stderr**, which an
      // `execFile` rejection carries but whose `message` is only "Command failed". Surfacing it is
      // the difference between a founder learning they never delegated and reading an exit code.
      const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr.trim() : '';
      const detail = stderr === '' ? (error instanceof Error ? error.message : String(error)) : stderr;
      config.log(`minting an invite for circle ${contentCircleId} failed after ${Date.now() - startedAt}ms: ${detail}`);
      throw new Error(`could not mint an invite: ${detail}`, { cause: error });
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // Not fatal — the next mint makes its own directory — but a temp tree that stops being
        // cleaned fills a 3 GB box eventually, and silence is how that goes unnoticed for weeks.
        config.log(`could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  },
});
