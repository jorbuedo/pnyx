// The one URL to open when something looks wrong.
//
// The origin is the only host the app talks to, and it is also the only host that can still answer when
// the sponsor box is down — so the aggregate lives here rather than on the box. A probe that fails to
// load tells you nothing; one that loads and says `sponsor: unreachable` tells you where to look.
//
// Every component reports its own state and the roll-up is the worst of them, so a caller never has to
// know the rules. The sponsor's own roll-up is passed through rather than recomputed: it is the only
// party that can see its wallet, and second-guessing it here would put the thresholds in two places.

/**
 * `unknown` is not a failure — it is "this deployment has no such component", which is the honest answer
 * for a sponsor-less stack (the pre-VPS composition, and every test one). It must not be alarming, and it
 * must not be reported as healthy either.
 */
export type ComponentState = 'ok' | 'starting' | 'degraded' | 'failing' | 'unknown';

/** Worst-wins order. `unknown` sits below `ok` because it says nothing about health. */
const SEVERITY: Record<ComponentState, number> = { unknown: 0, ok: 1, starting: 2, degraded: 3, failing: 4 };

export const isComponentState = (value: unknown): value is ComponentState =>
  typeof value === 'string' && value in SEVERITY;

export const worstState = (states: readonly ComponentState[]): ComponentState =>
  states.reduce<ComponentState>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'unknown');

/**
 * A component's contribution to the page.
 *
 * **`detail` is the whole payload, and it is public.** There is deliberately no field for a
 * component's raw report: this endpoint is unauthenticated, and passing an upstream body through
 * untouched is how the sponsor's DUST and NIGHT balances reached it on the first deploy. A probe that
 * wants to say more says it in `detail`, having decided what is safe to say.
 */
export type Component = {
  readonly state: ComponentState;
  /** One line someone can act on, or null when there is nothing to say. */
  readonly detail: string | null;
};

export type StatusReport = {
  readonly status: ComponentState;
  readonly checkedAt: string;
  readonly components: Readonly<Record<string, Component>>;
};

export type StatusProbes = Readonly<Record<string, () => Promise<Component>>>;

/**
 * Run every probe and roll the results up.
 *
 * Probes run concurrently and a thrown probe becomes `failing` rather than failing the report: a status
 * page that 500s because one check threw is the failure mode this exists to avoid.
 */
export const collectStatus = async (probes: StatusProbes, now: () => Date): Promise<StatusReport> => {
  const names = Object.keys(probes);
  const results = await Promise.all(
    names.map(async (name): Promise<Component> => {
      try {
        return await (probes[name] as () => Promise<Component>)();
      } catch (error) {
        return { state: 'failing', detail: `probe threw: ${error instanceof Error ? error.message : String(error)}` };
      }
    }),
  );
  const components = Object.fromEntries(names.map((name, i) => [name, results[i] as Component]));
  return {
    status: worstState(results.map((c) => c.state)),
    checkedAt: now().toISOString(),
    components,
  };
};

const STATE_COLOR: Record<ComponentState, string> = {
  ok: '#1f9d55',
  starting: '#8a6d3b',
  degraded: '#b7791f',
  failing: '#c53030',
  unknown: '#718096',
};

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c] as string,
  );

/**
 * A page with no external requests of any kind — it has to render on a phone, on a bad connection, while
 * the thing it describes is broken.
 */
export const renderStatusHtml = (report: StatusReport): string => {
  const rows = Object.entries(report.components)
    .map(([name, c]) => {
      const detail = c.detail === null ? '' : `<div class="detail">${escapeHtml(c.detail)}</div>`;
      return `<tr><th>${escapeHtml(name)}</th><td><span class="pill" style="background:${STATE_COLOR[c.state]}">${c.state}</span>${detail}</td></tr>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pnyx status — ${report.status}</title>
<style>
:root{color-scheme:light dark;--fg:#111;--bg:#fff;--line:#e2e8f0;--muted:#4a5568}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--bg:#16181d;--line:#2d3340;--muted:#a0aec0}}
body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:44rem;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 .25rem}
.when{color:var(--muted);font-size:.85rem;margin:0 0 1.5rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.7rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{width:8rem;font-weight:600}
.pill{display:inline-block;padding:.1rem .55rem;border-radius:999px;color:#fff;font-size:.8rem;font-weight:600}
.detail{color:var(--muted);font-size:.85rem;margin-top:.35rem;overflow-wrap:anywhere}
pre{background:rgba(127,127,127,.12);padding:1rem;border-radius:6px;overflow-x:auto;font-size:.8rem}
</style></head>
<body><main>
<h1>Pnyx status: <span class="pill" style="background:${STATE_COLOR[report.status]}">${report.status}</span></h1>
<p class="when">checked ${escapeHtml(report.checkedAt)}</p>
<table>${rows}</table>
<details><summary>Full report</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details>
</main></body></html>`;
};

/** `Accept` asks for HTML — a browser did, a checker did not. */
export const prefersHtml = (accept: string | null): boolean => accept !== null && accept.includes('text/html');
