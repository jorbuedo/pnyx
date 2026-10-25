import { describe, expect, it } from 'vitest';
import { circleTemplate } from './circle-template.js';

const CURRENT = '58875eb9b3e339a27c134fa920fce433c0da4fd6536eec0ba6e5809d7155fb3c';
const OLD = '28ba8ebf0044571c00000000000000000000000000000000000000000000aaaa';

describe('circleTemplate', () => {
  it('recognises a circle built from the compile this deployment speaks', () => {
    expect(circleTemplate({ codeDigest: CURRENT, currentDigest: CURRENT })).toBe('current');
  });

  it('flags a circle whose contract holds an older compile', () => {
    expect(circleTemplate({ codeDigest: OLD, currentDigest: CURRENT })).toBe('outdated');
  });

  // The sponsor compares case-insensitively; disagreeing with it would badge a circle it funds as
  // broken, or the reverse.
  it('compares case-insensitively, as the sponsor does', () => {
    expect(circleTemplate({ codeDigest: CURRENT.toUpperCase(), currentDigest: CURRENT })).toBe('current');
  });

  // Each of these is "we have not looked", not "it is fine" — a circle that never settled has no
  // contract, and an unconfigured deployment has nothing to compare against.
  it.each([
    ['no digest resolved yet', { currentDigest: CURRENT }],
    ['an empty stored digest', { codeDigest: '', currentDigest: CURRENT }],
    ['no configured digest', { codeDigest: CURRENT }],
    ['an empty configured digest', { codeDigest: CURRENT, currentDigest: '' }],
  ])('reports unknown for %s rather than assuming current', (_label, input) => {
    expect(circleTemplate(input)).toBe('unknown');
  });
});
