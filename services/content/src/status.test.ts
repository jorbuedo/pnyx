import { describe, expect, it } from 'vitest';
import { type Component, collectStatus, prefersHtml, renderStatusHtml, worstState } from './status.js';

const at = () => new Date('2026-08-15T18:00:00.000Z');
const component = (state: Component['state'], detail: string | null = null): Component => ({ state, detail });

describe('worstState', () => {
  it('reports the worst component, not the first or the last', () => {
    expect(worstState(['ok', 'failing', 'ok'])).toBe('failing');
    expect(worstState(['ok', 'degraded', 'starting'])).toBe('degraded');
  });

  // `unknown` means "this deployment has no such component". Ranking it above `ok` would paint a
  // sponsor-less stack as unhealthy; ranking it as `ok` would claim a health nobody observed.
  it('lets unknown lose to every real state, including ok', () => {
    expect(worstState(['unknown', 'ok'])).toBe('ok');
    expect(worstState(['unknown'])).toBe('unknown');
    expect(worstState(['unknown', 'degraded'])).toBe('degraded');
  });

  it('treats starting as worse than ok but better than degraded', () => {
    expect(worstState(['ok', 'starting'])).toBe('starting');
    expect(worstState(['starting', 'degraded'])).toBe('degraded');
  });
});

describe('collectStatus', () => {
  it('rolls the components up and stamps the check time', async () => {
    const report = await collectStatus(
      {
        sponsor: async () => component('ok'),
        store: async () => component('degraded', 'slow'),
      },
      at,
    );
    expect(report.status).toBe('degraded');
    expect(report.checkedAt).toBe('2026-08-15T18:00:00.000Z');
    expect(report.components.store?.detail).toBe('slow');
  });

  // A status page that 500s because one check threw is the failure mode this endpoint exists to avoid.
  it('turns a thrown probe into a failing component rather than a failed report', async () => {
    const report = await collectStatus(
      {
        sponsor: async () => {
          throw new Error('socket hang up');
        },
        store: async () => component('ok'),
      },
      at,
    );
    expect(report.status).toBe('failing');
    expect(report.components.sponsor?.detail).toContain('socket hang up');
    expect(report.components.store?.state).toBe('ok');
  });
});

describe('renderStatusHtml', () => {
  it('escapes a detail string, which carries upstream error text verbatim', async () => {
    const report = await collectStatus({ sponsor: async () => component('failing', '<script>alert(1)</script>') }, at);
    const html = renderStatusHtml(report);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('makes no external request — it has to render while the thing it describes is broken', async () => {
    const html = renderStatusHtml(await collectStatus({ store: async () => component('ok') }, at));
    expect(html).not.toMatch(/<(script|link|img)\b/);
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});

describe('prefersHtml', () => {
  it('is true for a browser and false for a checker', () => {
    expect(prefersHtml('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(true);
    expect(prefersHtml('application/json')).toBe(false);
    expect(prefersHtml(null)).toBe(false);
  });
});
