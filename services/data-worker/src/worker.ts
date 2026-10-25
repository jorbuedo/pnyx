// pnyx-data — slow-changing Cardano reference data (DRep + stake-pool lists,
// later pricing). A Cron Trigger refreshes each blob and writes it to R2; the
// blobs are served to clients R2-DIRECT (public bucket custom domain), so a
// client read is NOT a Worker invocation — this Worker only ever runs on the
// cron (and a manual /refresh on its workers.dev URL for admin population).
//
// Blob shape: { updatedAt: ISO, data: <projected upstream JSON> }.
// `data` is a FIELD-PROJECTED subset of the upstream response — only the fields
// the app's parsers actually read (app/.../cardano-pool-drep/{drep,pool}.ts)
// — kept in the SAME nested shape as upstream, so the app parses `data`
// identically to a direct call. Upstream is huge (raw pool entries carry full
// per-epoch history + stats + social handles the app never reads); projecting
// cuts the blobs from tens of MB to a few hundred KB.

export interface Env {
  DATA: R2Bucket;
}

type Source = { readonly url: string; readonly project: (raw: unknown) => unknown };

// Mainnet only (the governance picker's real use case). Upstream = Yoroi Backend
// Zero (public, dev-lead approved) — the same endpoints the app called directly.
const SOURCES: Record<string, Source> = {
  dreps: { url: 'https://zero.yoroiwallet.com/dreps/active?page=1&pageSize=1000&order=desc', project: projectDreps },
  pools: { url: 'https://zero.yoroiwallet.com/cexplorer-pool-list?limit=100000&order=ranking', project: projectPools },
};

const CACHE_CONTROL = 'public, max-age=300'; // 5-min edge cache on the R2-direct reads

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// Keep only defined values (null is kept — it's meaningful for retiring_epoch);
// return undefined when nothing survives so the key is dropped by the parent.
const compact = (o: Record<string, unknown>): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length > 0 ? out : undefined;
};

// Project YBZ /dreps/active (array) → only the fields drep.ts reads.
export function projectDreps(raw: unknown): unknown {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((r) => {
    const e = asRecord(r);
    const meta = asRecord(e.metadata);
    const verified = e.metadataVerification === 'verified';
    const image = asRecord(meta.image);
    return (
      compact({
        id: e.id,
        from: e.from,
        metadataVerification: verified ? 'verified' : undefined,
        metadata: compact({
          givenName: meta.givenName, // string | {'@value': string} — copied as-is
          image: verified && typeof image.contentUrl === 'string' ? { contentUrl: image.contentUrl } : undefined,
        }),
        stake: e.stake,
        delegatorCount: e.delegatorCount,
        anchorUrl: e.anchorUrl,
        anchorHash: e.anchorHash,
      }) ?? {}
    );
  });
}

// Project YBZ /cexplorer-pool-list ({data:{data:[…]}}) → only the fields pool.ts
// reads, preserving the {data:{data:[…]}} wrapper the parser walks.
export function projectPools(raw: unknown): unknown {
  const rows = asRecord(asRecord(raw).data).data;
  const pickUpdate = (u: Record<string, unknown>) =>
    compact({ margin: u.margin, pledge: u.pledge, fixed_cost: u.fixed_cost });
  const data = (Array.isArray(rows) ? rows : []).map((r) => {
    const e = asRecord(r);
    const name = asRecord(e.pool_name);
    const update = asRecord(e.pool_update);
    const retire = asRecord(asRecord(e.pool_retire).active);
    const stats = asRecord(e.stats);
    const recent = asRecord(stats.recent);
    const lifetime = asRecord(stats.lifetime);
    const block0 = asRecord(asRecord(asRecord(asRecord(e.epochs)['0']).data).block);
    return (
      compact({
        pool_id: e.pool_id,
        pool_id_hash_raw: e.pool_id_hash_raw,
        pool_name: compact({
          ticker: name.ticker,
          name: name.name,
          description: name.description,
          homepage: name.homepage,
        }),
        pool_update: compact({ active: pickUpdate(asRecord(update.active)), live: pickUpdate(asRecord(update.live)) }),
        pool_retire: 'retiring_epoch' in retire ? { active: { retiring_epoch: retire.retiring_epoch } } : undefined,
        saturation: e.saturation,
        delegators: e.delegators,
        stats: compact({
          recent: typeof recent.roa === 'number' ? { roa: recent.roa } : undefined,
          lifetime: typeof lifetime.roa === 'number' ? { roa: lifetime.roa } : undefined,
        }),
        epochs: typeof block0.minted === 'number' ? { '0': { data: { block: { minted: block0.minted } } } } : undefined,
        live_stake: e.live_stake,
      }) ?? {}
    );
  });
  return { data: { data } };
}

const blobKey = (key: string) => `${key}.json`;

// ── Deep ADA→fiat daily history ──────────────────────────────────────────────
// A static-ish blob of daily ADA close prices per fiat, extending history past
// Kraken's live ~2-year OHLC-API window (old-tx fiat / full "ALL" charts / tax
// CSV in the app). Unlike the SOURCES blobs (fetch-and-replace), this one is
// INCREMENTAL: read the existing blob, pull only the new daily candles from the
// Kraken API since the last stored day, and merge. Bootstrap once from Kraken's
// downloadable OHLCVT archive (2018→); the cron maintains it from the API
// thereafter, so the archive is never needed again.
//
// Blob: { updatedAt, asset:'ADA', interval:'1d', fiats:{ USD:[[unixSec,close]], … } }
// The app reads it R2-direct and only touches `.fiats` (app/.../deep-ada-history.ts).

const DEEP_ADA_KEY = 'deep-ada-history';
const KRAKEN_PAIRS: Record<string, string> = { USD: 'ADAUSD', EUR: 'ADAEUR', GBP: 'ADAGBP', AUD: 'ADAAUD' };
const DAY = 86400;

type DeepFiats = Record<string, Array<[number, number]>>;

async function readDeepFiats(env: Env): Promise<DeepFiats> {
  const obj = await env.DATA.get(blobKey(DEEP_ADA_KEY));
  if (obj === null) return {};
  try {
    const parsed = asRecord(JSON.parse(await obj.text()));
    const fiats = asRecord(parsed.fiats);
    const out: DeepFiats = {};
    for (const k of Object.keys(fiats)) if (Array.isArray(fiats[k])) out[k] = fiats[k] as Array<[number, number]>;
    return out;
  } catch {
    return {};
  }
}

// Kraken OHLC (`[time,o,h,l,c,vwap,volume,count]`) → `[unixSec, close]` rows.
async function fetchKrakenDaily(pair: string, sinceSec: number): Promise<Array<[number, number]>> {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440${sinceSec > 0 ? `&since=${sinceSec}` : ''}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`kraken ${pair} ${r.status}`);
  const body = asRecord(await r.json());
  if (Array.isArray(body.error) && body.error.length > 0) throw new Error(`kraken ${pair} ${body.error.join(',')}`);
  const result = asRecord(body.result);
  const key = Object.keys(result).find((k) => k !== 'last');
  const rows = key !== undefined ? result[key] : undefined;
  if (!Array.isArray(rows)) return [];
  const out: Array<[number, number]> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const ts = Number(row[0]);
    const close = Number(row[4]);
    if (Number.isFinite(ts) && Number.isFinite(close)) out.push([ts, close]);
  }
  return out;
}

const mergeDaily = (existing: Array<[number, number]>, fresh: Array<[number, number]>): Array<[number, number]> => {
  const byTs = new Map<number, number>();
  for (const [ts, c] of existing) byTs.set(ts, c);
  for (const [ts, c] of fresh) byTs.set(ts, c); // fresh wins (a day's final close can revise)
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]);
};

async function refreshDeepAda(env: Env): Promise<string> {
  const fiats = await readDeepFiats(env);
  for (const [fiat, pair] of Object.entries(KRAKEN_PAIRS)) {
    const existing = fiats[fiat] ?? [];
    const lastTs = existing.length > 0 ? (existing[existing.length - 1]?.[0] ?? 0) : 0;
    // Step back a day so `since` (exclusive-ish) re-includes the last stored day.
    const since = lastTs > 0 ? lastTs - DAY : 0;
    try {
      fiats[fiat] = mergeDaily(existing, await fetchKrakenDaily(pair, since));
    } catch {
      // Keep the existing series for this fiat; the next cron retries.
    }
  }
  const blob = JSON.stringify({ updatedAt: new Date().toISOString(), asset: 'ADA', interval: '1d', fiats });
  await env.DATA.put(blobKey(DEEP_ADA_KEY), blob, {
    httpMetadata: { contentType: 'application/json', cacheControl: CACHE_CONTROL },
  });
  return blob;
}

async function refresh(env: Env, key: string): Promise<string> {
  const src = SOURCES[key];
  if (!src) throw new Error(`refresh: unknown source ${key}`);
  const upstream = await fetch(src.url, { headers: { accept: 'application/json' } });
  if (!upstream.ok) throw new Error(`${key} upstream ${upstream.status}`);
  const data = src.project(await upstream.json());
  const blob = JSON.stringify({ updatedAt: new Date().toISOString(), data });
  await env.DATA.put(blobKey(key), blob, {
    httpMetadata: { contentType: 'application/json', cacheControl: CACHE_CONTROL },
  });
  return blob;
}

const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

export default {
  // Cron: refresh every blob so the R2-direct reads stay warm.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    for (const key of Object.keys(SOURCES)) {
      try {
        await refresh(env, key);
      } catch {
        // Best-effort: the previous blob still serves; the next cron retries.
      }
    }
    // Incremental deep-ADA refresh (merges the day's new Kraken candles).
    try {
      await refreshDeepAda(env);
    } catch {
      // Best-effort; the previous blob still serves.
    }
  },

  // Admin-only surface (workers.dev): /health and manual /refresh?key=… to
  // populate a blob without waiting for the cron. Client READS never hit this —
  // they read the R2 bucket's public custom domain directly.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '');
    if (path === '' || path === 'health') return new Response('ok');
    if (path === 'refresh') {
      const key = url.searchParams.get('key') ?? '';
      if (!(key in SOURCES)) return json('{"error":"unknown key"}', 404);
      try {
        return json(await refresh(env, key));
      } catch (e) {
        return json(`{"error":${JSON.stringify(String(e))}}`, 502);
      }
    }
    if (path === 'refresh-deep-ada') {
      try {
        return json(await refreshDeepAda(env));
      } catch (e) {
        return json(`{"error":${JSON.stringify(String(e))}}`, 502);
      }
    }
    return json('{"error":"not found"}', 404);
  },
};
