// The rule behind the sponsor host's one-word verdict. What is worth asserting is that the aggregate
// cannot hide a component — the defect it was written to fix.
import { describe, expect, it } from 'vitest';
import { hostState, isServing, networkState } from './sponsor-host-state.js';

const answered = (status: string) => ({ httpStatus: 200, body: { status } });
const unreachable = { httpStatus: null, body: null };

describe('networkState', () => {
  // ⚠️ The bug this exists for: a wallet that is degraded answers 200, so counting statuses called it ok.
  it('takes the wallet at its word, not at its HTTP status', () => {
    expect(networkState(answered('degraded'))).toBe('degraded');
    expect(networkState(answered('starting'))).toBe('starting');
    expect(networkState(answered('failing'))).toBe('failing');
    expect(networkState(answered('ok'))).toBe('ok');
  });

  it('falls back to the status only when the answer carries no word', () => {
    expect(networkState({ httpStatus: 200, body: null })).toBe('ok');
    expect(networkState({ httpStatus: 200, body: { status: 'who knows' } })).toBe('ok');
    expect(networkState({ httpStatus: 503, body: null })).toBe('failing');
    expect(networkState(unreachable)).toBe('failing');
  });
});

describe('hostState', () => {
  it('reports the worst network, never the average', () => {
    expect(hostState([answered('ok'), answered('ok')])).toBe('ok');
    expect(hostState([answered('ok'), answered('degraded'), answered('ok')])).toBe('degraded');
    expect(hostState([answered('degraded'), unreachable])).toBe('failing');
    expect(hostState([answered('ok'), answered('starting')])).toBe('starting');
  });

  // The 2026-08-28 reading: three networks, one refusing every call, and a page that said `ok`.
  it('never calls a host healthy while one of its networks is not', () => {
    expect(hostState([answered('ok'), answered('ok'), answered('failing')])).not.toBe('ok');
  });

  // An empty aggregate defaulting to healthy is the same defect one level up.
  it('reports nothing-behind-it as failing rather than healthy', () => {
    expect(hostState([])).toBe('failing');
  });
});

describe('isServing', () => {
  // `degraded` is serving badly; `starting` is not serving at all, and folding them together is what
  // would let a caller send bytes to a wallet that cannot take them.
  it.each([
    ['ok', true],
    ['degraded', true],
    ['starting', false],
    ['failing', false],
  ] as const)('%s → %s', (state, expected) => {
    expect(isServing(state)).toBe(expected);
  });
});
