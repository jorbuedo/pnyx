// Every branch here is a way somebody else's contract could have been believed as yours.
import { describe, expect, it } from 'vitest';
import { refuseContractAddress, refuseContractTemplate } from './identity-contract-check.js';

const OURS = '3353f472500686e5a0551947f338a5a44f9388f446ddb389e15be7e4f14fd174';

describe('refuseContractAddress', () => {
  it('accepts a 64-hex address in either case', () => {
    expect(refuseContractAddress(OURS)).toBeUndefined();
    expect(refuseContractAddress(OURS.toUpperCase())).toBeUndefined();
  });

  it('refuses an absent one rather than falling back to a configured address', () => {
    // There is no address to fall back to: one contract per identity.
    expect(refuseContractAddress(undefined)).toMatch(/must name/);
    expect(refuseContractAddress('')).toMatch(/must name/);
  });

  it('refuses anything that is not an address', () => {
    expect(refuseContractAddress('nope')).toMatch(/64 hex/);
    expect(refuseContractAddress(`${OURS}00`)).toMatch(/64 hex/);
  });
});

describe('refuseContractTemplate', () => {
  it('accepts our own template, case-insensitively', () => {
    expect(refuseContractTemplate({ digest: OURS, expected: OURS })).toBeUndefined();
    expect(refuseContractTemplate({ digest: OURS.toUpperCase(), expected: OURS })).toBeUndefined();
  });

  it('refuses a contract built from anything else — the rule that stops a forged authPub', () => {
    expect(refuseContractTemplate({ digest: '99'.repeat(32), expected: OURS })).toMatch(/not built from/);
  });

  // An unset expectation is '' and so is a digest we failed to read, so without this the two compare
  // equal and every contract is accepted.
  it('refuses when nothing is configured, even against an empty digest', () => {
    expect(refuseContractTemplate({ digest: '', expected: undefined })).toMatch(/no identity template/);
    expect(refuseContractTemplate({ digest: '', expected: '' })).toMatch(/no identity template/);
  });

  it('refuses an unreadable digest against a configured template', () => {
    expect(refuseContractTemplate({ digest: '', expected: OURS })).toMatch(/could not be read/);
  });
});
