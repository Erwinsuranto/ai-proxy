/* Provider Management UX regressions (compact cards + manual-only refresh).
 *
 * Static + pure-render assertions (this project's Admin-UI test style):
 *  - compact card markup / no stacked stat rows (renderProviderCardHTML),
 *  - card still carries ALL information the operator needs,
 *  - provider search stays a LOCAL filter over loaded data (no network),
 *  - the Providers tab is excluded from the 30s polling timer,
 *  - Refresh button: loading label, double-click guard, click-triggered
 *    fetch only, "Last refresh" advances solely on success,
 *  - a failed manual refresh keeps the previously rendered data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stopServer, request } from './setup';
import { __test } from '../src/admin/dashboard';

const renderCard = (__test as Record<string, (p: unknown) => string>).renderProviderCardHTML;

const PROVIDER = {
  id: 'justwoker',
  name: 'JustWoker',
  enabled: true,
  apiKeyCount: 3,
  cooldown: { active: false },
  models: [
    { model: 'claude-opus-5', priority: 1, enabled: true },
    { model: 'glm-x', priority: 2, enabled: false },
  ],
};
const PROVIDER_OFF = { ...PROVIDER, id: 'kie-ai', name: 'Kie.ai', enabled: false };

let JS = '';
let CSS = '';
let HTML = '';

beforeAll(async () => {
  await startServer({});
  const [js, css, html] = await Promise.all([
    request('GET', '/admin/dashboard.js'),
    request('GET', '/admin/styles.css'),
    request('GET', '/admin'),
  ]);
  JS = String(js.data);
  CSS = String(css.data);
  HTML = String(html.data);
}, 30_000);

afterAll(async () => { await stopServer(); });

/** Slice of the served bundle around `needle` (throws if missing). */
function slice(needle: string, span = 1200): string {
  const i = JS.indexOf(needle);
  if (i === -1) throw new Error(`anchor not found in dashboard.js: ${needle}`);
  return JS.slice(i, i + span);
}

describe('provider cards — compact layout (A)', () => {
  const card = () => renderCard(PROVIDER);

  it('renders stats inline (no stacked value-over-label rows)', () => {
    const h = card();
    expect(h).not.toMatch(/<br\s*\/?>/);
    expect(h).toContain('provider-stat__value');
    expect(h).toContain('provider-stat__label');
    // value and label are siblings — compact single-line chips
    expect(h).toMatch(/provider-stat__value[^<]*<\/span>\s*<span class="provider-stat__label"/);
  });

  it('served CSS tightens card padding, avatar and typography', () => {
    expect(CSS).toMatch(/\.provider-card__avatar \{[^}]*width: 28px/);
    expect(CSS).toMatch(/\.provider-stat__icon \{[^}]*width: 22px/);
    expect(CSS).toMatch(/\.provider-card__name \{ font-size: 13px/);
    expect(CSS).toContain('padding: 12px var(--space-3) var(--space-3)');
    expect(CSS).toMatch(/\.providers-list \{[\s\S]*?gap: var\(--space-3\)/);
  });

  it('uses a denser desktop grid with preserved mobile responsiveness', () => {
    // 4 columns on very wide screens, 1 column (full width) on phones
    expect(CSS).toContain('@media (min-width: 1500px) { .providers-list { grid-template-columns: repeat(4, minmax(0, 1fr)); } }');
    expect(CSS).toContain('@media (max-width: 720px)  { .providers-list { grid-template-columns: 1fr; } }');
    // action buttons stay tappable on touch screens
    expect(CSS).toContain('.provider-card__actions .btn { min-height: 40px; }');
  });
});

describe('provider cards — information stays complete (A)', () => {
  it('enabled card shows every required field + actions', () => {
    const h = renderCard(PROVIDER);
    expect(h).toContain('JustWoker');                    // name
    expect(h).toContain('id: justwoker');                // id
    expect(h).toContain('ENABLED');                      // enabled state
    expect(h).toContain('Models');                       // model count label
    expect(h).toContain('API Keys');                     // key count label
    expect(h).toContain('Requests');                     // request count label
    expect(h).toContain('1 of 2');                       // routable status line
    expect(h).toContain('models routable');
    expect(h).toContain('Manage API Keys');              // action
    expect(h).toContain('data-toggle="justwoker"');      // enable/disable action
    expect(h).toContain('Disable');
    expect(h).toContain('▾ 2 models');                   // model count / toggle
    expect(h).toContain('data-provider-search="justwoker justwoker"');
  });

  it('disabled card shows DISABLED badge and Enable action', () => {
    const h = renderCard(PROVIDER_OFF);
    expect(h).toContain('DISABLED');
    expect(h).toContain('>Enable<');
    expect(h).toContain('id: kie-ai');
  });
});

describe('provider search — stays local, no network (D)', () => {
  it('search input filters rendered cards client-side', () => {
    const handler = slice(`globalSearch.addEventListener('input'`, 700);
    expect(handler).toContain("this.activeTab === 'providers'");
    expect(handler).toContain('filterProviderCards');
    const fn = slice('filterProviderCards(query) {', 700);
    expect(fn).toContain('dataset.providerSearch');
    expect(fn).toContain('includes(query)');
  });

  it('search handlers never fetch, refresh or poll', () => {
    const handler = slice(`globalSearch.addEventListener('input'`, 700);
    for (const banned of ['apiJSON', 'fetch(', 'refreshActive', 'loadProvidersForManagement', 'setInterval']) {
      expect(handler).not.toContain(banned);
    }
  });
});

describe('manual-only refresh (B) — no auto polling on Provider Management', () => {
  it('30s polling timer skips the providers tab', () => {
    expect(JS).toMatch(/this\.activeTab === 'combos' \|\| this\.activeTab === 'providers'\)\s*\n\s*return/);
  });

  it('cooldown countdown is display-only (no auto refetch on expiry)', () => {
    const ticking = slice('function tickCooldownCountdowns', 1400);
    expect(ticking).not.toContain('loadProvidersForManagement');
    expect(JS).not.toContain('cooldownRefreshQueued');
    expect(ticking).toContain('press Refresh');
  });

  it('no setInterval ever triggers a providers load', () => {
    expect(JS).not.toMatch(/setInterval\([\s\S]{0,120}loadProvidersForManagement/);
  });
});

describe('Refresh button behavior (B)', () => {
  it('clicking Refresh triggers a data fetch for the providers tab', () => {
    expect(JS).toContain("this.elts.refreshBtn.addEventListener('click', () => this.refreshActive(true))");
    expect(HTML).toContain('id="refresh-btn"');
    const active = slice('async refreshActive', 5000);
    expect(active).toContain("case 'providers'");
    const load = slice('async loadProvidersForManagement', 2400);
    expect(load).toContain("'/admin/providers'");
    expect(load).toContain('/admin/usage/providers');
  });

  it('double-click cannot fire duplicate requests (in-flight + disabled guard)', () => {
    const active = slice('async refreshActive', 5000);
    expect(active).toMatch(/if \(this\.refreshInFlight\)\s*\n\s*return;/);
    expect(active).toContain('this.refreshInFlight = true;');
    expect(active).toContain('refreshBtn.disabled = true');
    expect(active).toContain('this.refreshInFlight = false;');
    expect(active).toContain('refreshBtn.disabled = false');
  });

  it('shows a brief loading state on the button and then restores it', () => {
    const active = slice('async refreshActive', 5000);
    expect(active).toContain("classList.add('is-loading')");
    expect(active).toContain("'Refreshing…'");
    expect(active).toContain("textContent = 'Refresh'");
    expect(active).toMatch(/\}\s*finally \{/);
    expect(CSS).toContain('.btn.is-loading');
  });

  it('failed refresh keeps the previous data visible with a clear error', () => {
    const load = slice('async loadProvidersForManagement', 2400);
    expect(load).toContain("const hadData = this.providersCache.length > 0");
    expect(load).toContain("getAttribute('data-state') === 'loaded'");
    expect(load).toContain('showing the previous data');
    expect(load).toContain("showError('Failed to refresh providers'");
    // skeletons (which would wipe old cards) only paint when nothing is shown yet
    expect(load).toContain('if (!hadData)');
  });

  it('"Last refresh" advances only after a successful providers fetch', () => {
    const active = slice('async refreshActive', 5000);
    expect(active).toMatch(/if \(this\.activeTab !== 'providers' \|\| this\.providersLoadOk\)\s*\n\s*this\.markRefreshed\(\)/);
    const load = slice('async loadProvidersForManagement', 2400);
    expect(load).toContain('this.providersLoadOk = false;');
    expect(load).toContain('this.providersLoadOk = true;');
    // false is assigned on the failure path BEFORE the true-on-success line
    expect(load.indexOf('providersLoadOk = false')).toBeLessThan(load.lastIndexOf('providersLoadOk = true'));
  });
});
