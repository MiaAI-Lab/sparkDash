import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OverseerPage } from './OverseerPage';

let cleanup = () => {};
afterEach(() => { act(() => cleanup()); vi.unstubAllGlobals(); });
const base = {
  enabled: true, state: 'observing', checkedAt: Date.now(), pollMs: 5000, error: null,
  units: [{ id: 'a', name: 'GB10 Alpha', models: ['fixture-model'] }, { id: 'b', name: 'GB10 Beta', models: [] }],
  sources: [{ sparkId: 'a', state: 'readable', count: 0 }], signals: { upload: 'Upload-capable action' },
  events: [], summary: { actions: 0, flagged: 0, high: 0 },
};
const event = (id: number, sparkId = 'a', signals: string[] = []) => ({ id: String(id), timestamp: Date.now(), sparkId, model: 'fixture-model', kind: 'execution', stage: 'process exited', severity: signals.length ? 'review' : 'recorded', signals, destinations: ['sink.example'], fingerprint: 'a'.repeat(24), exitCode: 0 });
async function render(data: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => data }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); cleanup = () => { root.unmount(); host.remove(); };
  await act(async () => root.render(<OverseerPage />)); return host;
}
async function select(host: HTMLElement, index: number, value: string) {
  await act(async () => { const el = host.querySelectorAll('select')[index]; el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
it('shows explicit disabled/no-blocking state and unavailable totals, never an all-clear', async () => {
  const host = await render({ ...base, enabled: false, state: 'disabled', checkedAt: null, summary: null });
  expect(host.textContent).toContain('Spark Overseer'); expect(host.textContent).toContain('Disabled by default');
  expect(host.textContent).toContain('Observe only'); expect(host.textContent).toContain('0 model tokens');
  expect(host.textContent).toContain('Unavailable'); expect(host.textContent).toContain('Spark Overseer');
});
it('separates source coverage from resident models and does not invent coverage for a second unit', async () => {
  const host = await render(base);
  expect(host.textContent).toContain('GB10 Beta'); expect(host.textContent).toContain('not instrumented');
  expect(host.textContent).toContain('Resident model telemetry: fixture-model'); expect(host.textContent).toContain('not verified process attribution');
});
it('filters by unit/severity, escapes labels and exposes stage, not a transfer verdict', async () => {
  const host = await render({ ...base, events: [event(1, 'a', ['upload']), { ...event(2, 'b'), model: '<script>not executable</script>' }] });
  expect(host.querySelector('script')).toBeNull(); expect(host.querySelectorAll('.ovr-event')).toHaveLength(2);
  await select(host, 0, 'a'); expect(host.querySelectorAll('.ovr-event')).toHaveLength(1);
  await select(host, 2, 'high'); expect(host.querySelectorAll('.ovr-event')).toHaveLength(0);
  expect(host.textContent).toContain('No records match these filters.');
});
it('clamps pagination when a refreshed source shrinks', async () => {
  const host = await render({ ...base, events: Array.from({ length: 31 }, (_, i) => event(i)) });
  await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Next')!.click(); });
  expect(host.textContent).toContain('Page 2 of 3');
  vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...base, events: [event(40)] }) } as Response);
  await act(async () => { host.querySelector<HTMLButtonElement>('.ovr-heading button')!.click(); });
  expect(host.querySelectorAll('.ovr-event')).toHaveLength(1); expect(host.textContent).not.toContain('Page 2');
});
it('failed refresh is visible, does not zero previous data, and permits retry', async () => {
  const host = await render({ ...base, events: [event(1)] });
  vi.mocked(fetch).mockRejectedValue(Error('fixture outage'));
  await act(async () => { host.querySelector<HTMLButtonElement>('.ovr-heading button')!.click(); });
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Previous records are not a current safety assessment');
  expect(host.querySelectorAll('.ovr-event')).toHaveLength(1);
  expect(host.querySelector<HTMLButtonElement>('.ovr-heading button')!.disabled).toBe(false);
});
