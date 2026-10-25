import { describe, expect, it } from 'vitest';
import { accountFactsFrom, fetchAccountFacts } from './koios-account';

const reply = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

describe('accountFactsFrom', () => {
  it('maps delegation and balance', () => {
    expect(
      accountFactsFrom({
        status: 'registered',
        delegated_pool: 'pool1a',
        delegated_drep: 'drep1x',
        total_balance: '4200000',
      }),
    ).toEqual({
      registered: true,
      delegatedPool: 'pool1a',
      delegatedDrep: 'drep1x',
      controlledBalance: 4_200_000n,
    });
  });

  it('reads only "not registered" as unregistered', () => {
    expect(accountFactsFrom({ status: 'not registered' }).registered).toBe(false);
    for (const status of ['registered', 'delegated', 'rewards']) {
      expect(accountFactsFrom({ status }).registered).toBe(true);
    }
  });

  // A balance we failed to read and a balance of nothing are different facts; `accountSatisfies`
  // refuses the first with its own reason rather than telling a whale they are below threshold.
  it.each([null, '', 'lots', '1.5'])('keeps an unusable total_balance as null (%s)', (total_balance) => {
    expect(accountFactsFrom({ status: 'registered', total_balance }).controlledBalance).toBeNull();
  });

  it('keeps an omitted total_balance as null', () => {
    expect(accountFactsFrom({ status: 'registered' }).controlledBalance).toBeNull();
  });

  it('keeps a balance too large for a double exact', () => {
    expect(accountFactsFrom({ status: 'registered', total_balance: '9007199254740993' }).controlledBalance).toBe(
      9_007_199_254_740_993n,
    );
  });
});

describe('fetchAccountFacts', () => {
  it('returns the facts for a known account', async () => {
    const result = await fetchAccountFacts('https://koios.internal/api/v1', 'stake1x', reply([
      { status: 'registered', delegated_drep: 'drep1x', total_balance: '10' },
    ]));
    expect(result).toEqual({ ok: true, facts: { registered: true, delegatedPool: null, delegatedDrep: 'drep1x', controlledBalance: 10n } });
  });

  it('reports an empty array as a known-absent account, not an error', async () => {
    expect(await fetchAccountFacts('https://koios.internal/api/v1', 'stake1x', reply([]))).toEqual({
      ok: true,
      facts: null,
    });
  });

  // ⚠️ The distinction the whole module exists for: an outage must never be reported to a user as
  // a verdict about their wallet.
  it('reports a refusal as an error rather than an absent account', async () => {
    const result = await fetchAccountFacts('https://koios.internal/api/v1', 'stake1x', reply([], 429));
    expect(result).toEqual({ ok: false, error: 'koios 429' });
  });

  it('reports a transport failure as an error', async () => {
    const boom = (async () => {
      throw new Error('econnreset');
    }) as typeof fetch;
    const result = await fetchAccountFacts('https://koios.internal/api/v1', 'stake1x', boom);
    expect(result.ok).toBe(false);
  });

  it('reports an unreadable body as an error', async () => {
    const garbage = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    expect((await fetchAccountFacts('https://k/api/v1', 'stake1x', garbage)).ok).toBe(false);
  });

  it('does not double the slash when the configured url has a trailing one', async () => {
    let seen = '';
    const capture = (async (url: string) => {
      seen = url;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAccountFacts('https://koios.internal/api/v1/', 'stake1x', capture);
    expect(seen).toBe('https://koios.internal/api/v1/account_info');
  });
});
