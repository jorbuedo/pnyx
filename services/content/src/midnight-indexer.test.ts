import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchContractState } from './midnight-indexer.js';

const URL = 'https://midnight-preprod.blockfrost.io/api/v4/graphql';
const ADDRESS = '939be0fe45e42d9d9f442b6e936519d9c4331e43f7646835c4780556c34d771e';

const reply = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

const callOf = (fetchMock: ReturnType<typeof reply>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string> };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchContractState', () => {
  it('sends the project id as a header and leaves the url untouched', async () => {
    const fetchMock = reply({ data: { contractAction: { state: 'ab01' } } });
    vi.stubGlobal('fetch', fetchMock);

    const state = await fetchContractState({ url: URL, projectId: 'nightpreprodSECRET' }, ADDRESS);

    expect(state).toEqual(new Uint8Array([0xab, 0x01]));
    const { url, headers } = callOf(fetchMock);
    expect(headers.project_id).toBe('nightpreprodSECRET');
    // The whole point: a credential in the query string would travel into every log of this URL.
    expect(url).toBe(URL);
    expect(url).not.toContain('SECRET');
  });

  it('sends no auth header for an indexer that needs no key', async () => {
    const fetchMock = reply({ data: { contractAction: { state: '00' } } });
    vi.stubGlobal('fetch', fetchMock);

    await fetchContractState({ url: 'https://midnight-mainnet.pxkq.uk/api/v4/graphql' }, ADDRESS);

    expect(callOf(fetchMock).headers).not.toHaveProperty('project_id');
  });

  it('answers undefined for a contract with no actions yet', async () => {
    vi.stubGlobal('fetch', reply({ data: { contractAction: null } }));
    await expect(fetchContractState({ url: URL }, ADDRESS)).resolves.toBeUndefined();
  });

  it('throws on a refused request, so a login reports an outage rather than an unknown identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 })),
    );
    await expect(fetchContractState({ url: URL }, ADDRESS)).rejects.toThrow(/403/);
  });

  it('throws on a GraphQL error', async () => {
    vi.stubGlobal('fetch', reply({ errors: [{ message: 'bad address' }] }));
    await expect(fetchContractState({ url: URL }, ADDRESS)).rejects.toThrow(/bad address/);
  });
});
