// The relay's correlation logic. Every case here is one the Durable Object cannot be tested for —
// `WebSocketPair` does not exist outside the Workers runtime — which is why the core is separate.
import { describe, expect, it, vi } from 'vitest';
import {
  agentFromHeaders,
  createRelayCore,
  DEFAULT_REPLY_TIMEOUT_MS,
  isNotification,
  parseEnvelope,
  type RelayEnvelope,
  walletOfflineFrame,
} from './mcp-relay.js';

const sent: RelayEnvelope[] = [];
const core = (opts: { connected?: boolean; timeoutMs?: number } = {}) => {
  sent.length = 0;
  return createRelayCore({
    send: (envelope) => {
      if (opts.connected === false) return false;
      sent.push(envelope);
      return true;
    },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
};

describe('framing', () => {
  it('treats a frame with no id as a notification', () => {
    expect(isNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true);
    expect(isNotification({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(false);
    // id 0 is a legal JSON-RPC id and must not be mistaken for absent.
    expect(isNotification({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).toBe(false);
  });

  it('refuses anything that is not our envelope', () => {
    expect(parseEnvelope('not json')).toBeUndefined();
    expect(parseEnvelope('null')).toBeUndefined();
    expect(parseEnvelope('{"frame":{}}')).toBeUndefined();
    expect(parseEnvelope('{"relayId":"1","frame":{}}')).toBeUndefined();
    expect(parseEnvelope('{"relayId":1.5,"frame":{}}')).toBeUndefined();
    expect(parseEnvelope('{"relayId":-1,"frame":{}}')).toBeUndefined();
    expect(parseEnvelope('{"relayId":1}')).toBeUndefined();
    expect(parseEnvelope('{"relayId":1,"frame":{"ok":true}}')).toEqual({ relayId: 1, frame: { ok: true } });
  });
});

describe('a request and its reply', () => {
  it('assigns its own relay id and passes the agent frame through untouched', async () => {
    const c = core();
    const frame = { jsonrpc: '2.0', id: 'agent-1', method: 'tools/list' };
    const reply = c.request(frame);
    expect(sent).toHaveLength(1);
    // Ours, not the agent's — two agents on one pairing would otherwise race for each other's replies.
    expect(sent[0]?.relayId).toBe(1);
    expect(sent[0]?.frame).toEqual(frame);
    c.onWalletMessage(JSON.stringify({ relayId: 1, frame: { jsonrpc: '2.0', id: 'agent-1', result: {} } }));
    await expect(reply).resolves.toEqual({ jsonrpc: '2.0', id: 'agent-1', result: {} });
    expect(c.pendingCount()).toBe(0);
  });

  it('keeps concurrent requests apart', async () => {
    const c = core();
    const a = c.request({ jsonrpc: '2.0', id: 'a', method: 'tools/list' });
    const b = c.request({ jsonrpc: '2.0', id: 'b', method: 'tools/list' });
    expect(c.pendingCount()).toBe(2);
    // Answered out of order on purpose: the relay id is what pairs them, not arrival order.
    c.onWalletMessage(JSON.stringify({ relayId: 2, frame: { id: 'b' } }));
    c.onWalletMessage(JSON.stringify({ relayId: 1, frame: { id: 'a' } }));
    await expect(a).resolves.toEqual({ id: 'a' });
    await expect(b).resolves.toEqual({ id: 'b' });
  });

  // The reason the relay assigns its own id, made into a test. A first version of this file only used
  // string agent ids, so a mutation that correlated on the agent's `id` survived — two agents (or one
  // replaying) sharing a numeric id would have raced for each other's replies.
  it('keeps two requests apart even when the agent reuses one numeric id', async () => {
    const c = core();
    const first = c.request({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const second = c.request({ jsonrpc: '2.0', id: 5, method: 'tools/call' });
    expect(sent.map((e) => e.relayId)).toEqual([1, 2]);
    expect(c.pendingCount()).toBe(2);

    c.onWalletMessage(JSON.stringify({ relayId: 1, frame: { id: 5, result: 'first' } }));
    await expect(first).resolves.toEqual({ id: 5, result: 'first' });
    // The second must still be waiting: settling it here would hand one agent the other's answer.
    expect(c.pendingCount()).toBe(1);

    c.onWalletMessage(JSON.stringify({ relayId: 2, frame: { id: 5, result: 'second' } }));
    await expect(second).resolves.toEqual({ id: 5, result: 'second' });
  });

  it('answers a notification immediately, with nothing to wait for', async () => {
    const c = core();
    await expect(c.request({ jsonrpc: '2.0', method: 'notifications/initialized' })).resolves.toBeUndefined();
    expect(c.pendingCount()).toBe(0);
  });

  it('drops an unparseable or unclaimed reply instead of failing every other waiter', async () => {
    const c = core();
    const pending = c.request({ jsonrpc: '2.0', id: 'a', method: 'tools/list' });
    c.onWalletMessage('garbage');
    c.onWalletMessage(JSON.stringify({ relayId: 999, frame: { id: 'late' } }));
    expect(c.pendingCount()).toBe(1);
    c.onWalletMessage(JSON.stringify({ relayId: 1, frame: { id: 'a' } }));
    await expect(pending).resolves.toEqual({ id: 'a' });
  });
});

describe('the wallet not being there', () => {
  it('answers offline when there is no socket at all', async () => {
    const c = core({ connected: false });
    await expect(c.request({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).resolves.toMatchObject({
      id: 7,
      error: { code: -32001 },
    });
    expect(c.pendingCount()).toBe(0);
  });

  it('fails waiters under the AGENT id when the socket closes mid-request', async () => {
    const c = core();
    const pending = c.request({ jsonrpc: '2.0', id: 'agent-9', method: 'tools/call' });
    c.onWalletGone();
    // Under the agent's id, not the relay's: replying under the relay id would answer a request the
    // client never sent.
    await expect(pending).resolves.toEqual(walletOfflineFrame({ id: 'agent-9' }));
    expect(c.pendingCount()).toBe(0);
  });

  it('times out rather than holding the agent open for ever', async () => {
    vi.useFakeTimers();
    try {
      const c = core({ timeoutMs: 1000 });
      const pending = c.request({ jsonrpc: '2.0', id: 'slow', method: 'tools/call' });
      vi.advanceTimersByTime(1000);
      await expect(pending).resolves.toMatchObject({ id: 'slow', error: { code: -32002 } });
      expect(c.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits long enough for a human to approve on the phone', () => {
    // A tool call can need an approval tap and a proof; too short turns that into a failed call the
    // agent retries, which is how a user gets asked twice.
    expect(DEFAULT_REPLY_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('agent attribution', () => {
  const agent = { pairingId: 'pair-1', label: 'Claude Code' };

  it('carries the agent on a request, so the wallet can tell two of them apart', async () => {
    const c = core();
    const reply = c.request({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, agent);
    expect(sent[0]?.agent).toEqual(agent);
    c.onWalletMessage(JSON.stringify({ relayId: sent[0]?.relayId, frame: { jsonrpc: '2.0', id: 7, result: {} } }));
    await reply;
  });

  it('carries it on a NOTIFICATION too', async () => {
    // `notifications/initialized` has no id, and an agent whose first frame arrived unattributed would
    // be handled under the wrong permissions.
    const c = core();
    await c.request({ jsonrpc: '2.0', method: 'notifications/initialized' }, agent);
    expect(sent[0]?.agent).toEqual(agent);
  });

  it('omits the field entirely when the relay could not attribute the call', async () => {
    // Absent, never a placeholder: a pairing id invented here would key permissions on a value nothing
    // verified, which is worse than the wallet knowing it does not know.
    const c = core();
    const reply = c.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(sent[0]).not.toHaveProperty('agent');
    c.onWalletMessage(JSON.stringify({ relayId: sent[0]?.relayId, frame: { jsonrpc: '2.0', id: 1, result: {} } }));
    await reply;
  });

  it('ignores an agent the WALLET puts on a reply — attribution only travels outward', async () => {
    // The reply direction has no use for it, and honouring one here would let the far end of the socket
    // assert who a call came from.
    const c = core();
    const reply = c.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, agent);
    const raw = JSON.stringify({
      relayId: sent[0]?.relayId,
      frame: { jsonrpc: '2.0', id: 2, result: {} },
      agent: { pairingId: 'other', label: 'x' },
    });
    expect(parseEnvelope(raw)).not.toHaveProperty('agent');
    c.onWalletMessage(raw);
    await reply;
  });

  it('keeps one agent’s frames from being attributed to another on the shared object', async () => {
    const c = core();
    const other = { pairingId: 'pair-2', label: 'Another agent' };
    const a = c.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, agent);
    const b = c.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, other);
    expect(sent.map((e) => e.agent?.pairingId)).toEqual(['pair-1', 'pair-2']);
    // Same client-chosen id on both: the relay's own id is what separates them.
    expect(sent[0]?.relayId).not.toBe(sent[1]?.relayId);
    for (const e of sent) c.onWalletMessage(JSON.stringify({ relayId: e.relayId, frame: { jsonrpc: '2.0', id: 1, result: {} } }));
    await Promise.all([a, b]);
  });
});

describe('agentFromHeaders — the spoofing boundary', () => {
  const headers = (map: Record<string, string>) => ({ get: (n: string) => map[n] ?? null });

  it('reads what the Worker set', () => {
    expect(agentFromHeaders(headers({ 'x-pnyx-pairing-id': 'p1', 'x-pnyx-pairing-label': 'Claude Code' }))).toEqual({
      pairingId: 'p1',
      label: 'Claude Code',
    });
  });

  it('is undefined with no pairing id — never a placeholder', () => {
    expect(agentFromHeaders(headers({}))).toBeUndefined();
    expect(agentFromHeaders(headers({ 'x-pnyx-pairing-id': '' }))).toBeUndefined();
    // A label alone attributes nothing, and inventing an id from it would key permissions on a name.
    expect(agentFromHeaders(headers({ 'x-pnyx-pairing-label': 'Claude Code' }))).toBeUndefined();
  });

  it('accepts a missing label, because the id is what identifies', () => {
    expect(agentFromHeaders(headers({ 'x-pnyx-pairing-id': 'p1' }))).toEqual({ pairingId: 'p1', label: '' });
  });
});
