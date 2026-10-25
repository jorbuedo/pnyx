// The early refusal. What matters is the *direction* of the check: absence of the name is proof and
// presence is not — so this pins both, including that the guard never claims more than it can.
import { describe, expect, it } from 'vitest';
import { guardNetwork } from './sponsor-network-guard.js';

const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

/** The shape a real serialized transaction has: a tag, opaque bytes, then the network id as text. */
const tx = (network: string) =>
  bytesOf(`midnight:transaction[v9](signature[v1],proof,embedded-fr[v1]):d ${network}  `);

describe('guardNetwork', () => {
  it('passes a transaction that names this network', () => {
    expect(guardNetwork(tx('preview'), 'preview')).toEqual({ ok: true });
    expect(guardNetwork(tx('mainnet'), 'mainnet')).toEqual({ ok: true });
  });

  /**
   * ⚠️ The case that cost an hour: a preview transaction sent to the preprod sponsor. It used to be
   * accepted with a 202 and refused inside `balanceTx`, where nobody could see it.
   */
  it('refuses a foreign transaction and names both networks', () => {
    const verdict = guardNetwork(tx('preview'), 'preprod');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain('this sponsor holds preprod');
    expect(verdict.message).toContain('these name preview');
  });

  it('refuses without guessing when no network is recognisable', () => {
    const verdict = guardNetwork(bytesOf('midnight:transaction[v9](...): '), 'preprod');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain('not a preprod transaction');
    expect(verdict.message).not.toContain('these name');
  });

  // `preprod` and `preview` share a prefix and `mainnet` appears in neither, so the three have to be
  // told apart by the whole word or the guard would pass everything.
  it('tells the three networks apart', () => {
    expect(guardNetwork(tx('preprod'), 'preview').ok).toBe(false);
    expect(guardNetwork(tx('preview'), 'mainnet').ok).toBe(false);
    expect(guardNetwork(tx('mainnet'), 'preprod').ok).toBe(false);
  });

  /**
   * ⚠️ A network id this module does not list is accepted unchecked. A host configured for a new
   * network must not refuse all of its own traffic because this list is behind — the ledger still
   * checks at balance time.
   */
  it('checks nothing for a network it does not know', () => {
    expect(guardNetwork(tx('preview'), 'devnet-7')).toEqual({ ok: true });
  });

  // Stated so nobody upgrades this into a claim it cannot make: presence is not proof.
  it('passes bytes that merely contain the name, which is the limit of what it can tell', () => {
    expect(guardNetwork(bytesOf('a payload mentioning preview for other reasons'), 'preview')).toEqual({ ok: true });
  });
});
