// Which wallet process a submission goes to. The rules that matter are the refusals: a network this
// host does not hold must be a 400 before anything is accepted, and a misconfiguration must refuse the
// boot rather than silently serve a subset.
import { describe, expect, it } from 'vitest';
import { parseRoutingTable, requestedNetwork, routeFor } from './sponsor-routing.js';

/**
 * ⚠️ `null` means "no default", not "use the helper's default". A `string | undefined = 'preprod'`
 * parameter cannot express that — passing `undefined` explicitly still takes the default in JS — and the
 * two tests about a host with no default silently exercised one that had one.
 */
const table = (spec = 'preview:3401,preprod:3402,mainnet:3403', fallback: string | null = 'preprod') => {
  const parsed = parseRoutingTable(spec, fallback ?? undefined);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.table;
};

describe('parseRoutingTable', () => {
  it('reads a network per port, in order', () => {
    expect(table().routes).toEqual([
      { network: 'preview', port: 3401 },
      { network: 'preprod', port: 3402 },
      { network: 'mainnet', port: 3403 },
    ]);
    expect(table().fallback).toBe('preprod');
  });

  it('tolerates spacing and a trailing comma', () => {
    expect(table(' preview:3401 , preprod:3402 , ', 'preview').routes).toHaveLength(2);
  });

  // ⚠️ Two networks on one port would send a preview transaction to the preprod wallet — the exact
  // failure the router exists to prevent, and it would look like a working deployment.
  it('refuses a duplicated port', () => {
    const parsed = parseRoutingTable('preview:3401,preprod:3401', undefined);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('port 3401 twice');
  });

  it('refuses a duplicated network', () => {
    const parsed = parseRoutingTable('preview:3401,preview:3402', undefined);
    expect(parsed.ok === false && parsed.message).toContain("'preview' twice");
  });

  for (const bad of ['', 'preview', 'preview:', 'preview:abc', 'preview:0', 'preview:99999', 'a:1:2']) {
    it(`refuses ${JSON.stringify(bad)} rather than skipping it`, () => {
      expect(parseRoutingTable(bad, undefined).ok).toBe(false);
    });
  }

  // A default naming a network that is not deployed would send every un-networked call into a 400 that
  // reads as "the caller is wrong" when the host is.
  it('refuses a default that is not one of the configured networks', () => {
    const parsed = parseRoutingTable('preview:3401', 'mainnet');
    expect(parsed.ok === false && parsed.message).toContain('not one of preview');
  });

  it('accepts no default at all', () => {
    expect(table('preview:3401', null).fallback).toBeNull();
  });
});

describe('routeFor', () => {
  it('routes a named network to its own port', () => {
    const routed = routeFor(table(), 'preview');
    expect(routed.ok && routed.route.port).toBe(3401);
    expect(routed.ok && routed.defaulted).toBe(false);
  });

  /**
   * ⚠️ The whole point. Before the router, a preview transaction was accepted by the preprod wallet and
   * died inside `balanceTx` as `invalid network ID - expect 'preview' found 'preprod'` — minutes after
   * the caller was told `accepted`.
   */
  it('refuses a network this host does not hold, and names what it does', () => {
    const routed = routeFor(table('preprod:3402', 'preprod'), 'preview');
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.message).toContain("does not sponsor 'preview'");
    expect(routed.message).toContain('it sponsors preprod');
  });

  // A Worker deployed before this change carries no network; the box must not start refusing it.
  it('falls back for a request that names none, and says it did', () => {
    const routed = routeFor(table(), null);
    expect(routed.ok && routed.route.network).toBe('preprod');
    expect(routed.ok && routed.defaulted).toBe(true);
    const blank = routeFor(table(), '');
    expect(blank.ok && blank.defaulted).toBe(true);
  });

  it('refuses an un-networked request when there is no default', () => {
    const routed = routeFor(table('preview:3401', null), null);
    expect(routed.ok === false && routed.message).toContain('no default');
  });
});

describe('requestedNetwork', () => {
  it('prefers the header, because that is what the router reads without parsing the body', () => {
    expect(requestedNetwork('preview', 'preprod')).toBe('preview');
  });

  it('falls back to the body field', () => {
    expect(requestedNetwork(null, 'mainnet')).toBe('mainnet');
  });

  it('trims, and treats blank or non-string as absent', () => {
    expect(requestedNetwork('  preview  ', undefined)).toBe('preview');
    expect(requestedNetwork('   ', '  ')).toBeNull();
    expect(requestedNetwork(null, 42)).toBeNull();
    expect(requestedNetwork(null, undefined)).toBeNull();
  });
});
