// Job checkpoints and orphaned job state (VER-629): a job saves itself as 'running' while it
// works, a job whose tab was reloaded or closed shows up as 'interrupted' with what its last
// checkpoint saved, and the service worker cleans up after a job tab that went away.
// The scenarios are spread into SCENARIOS in run.mjs and use the fake x.com's mutation hold.
import { openExtensionPage, storage, waitFor } from './launch.mjs';
import { ME } from './fake-x.mjs';

const xPage = env => env.context.pages().find(page => page.url().startsWith('https://x.com/'));

// Mutations past `after` wait until release() is called.
function holdMutations(state, after) {
  let release;
  state.misbehave.hold = { after, released: new Promise(resolve => { release = resolve; }) };
  return () => { state.misbehave.hold = null; release(); };
}

async function history(env) {
  return (await storage(env.worker, ['jobHistory'])).jobHistory || [];
}

async function jobTab(env, url = 'https://x.com/*') {
  return env.worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    const key = `jobTab_${tab.id}`;
    return { id: tab.id, autoDiscardable: tab.autoDiscardable, registered: !!(await chrome.storage.session.get([key]))[key] };
  }, url);
}

async function startQuickClean(env, action) {
  const popup = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
  await popup.waitForFunction(() => document.getElementById('accountCard')?.dataset.state === 'ready', null, { timeout: 20000 });
  await popup.evaluate(() => { const box = document.getElementById('apiMode'); if (!box.checked) box.click(); });
  await popup.evaluate(id => document.getElementById(id).click(), { delete: 'startDelete' }[action]);
  await popup.waitForFunction(() => document.getElementById('confirmDialog')?.open, null, { timeout: 10000 });
  await popup.evaluate(() => document.getElementById('confirmStart').click());
  return popup;
}

async function startSelectedDelete(env) {
  const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
  await panel.waitForFunction(() => !document.getElementById('startScan').disabled, null, { timeout: 20000 });
  await panel.evaluate(() => {
    document.querySelector('input[name="previewType"][value="tweets"]').click();
    const box = document.getElementById('previewApi');
    if (!box.checked) box.click();
    document.getElementById('startScan').click();
  });
  await panel.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState')?.textContent || '') && !document.getElementById('deleteSelected').disabled, null, { timeout: 90000 });
  await panel.evaluate(() => document.getElementById('deleteSelected').click());
  await panel.waitForFunction(() => document.getElementById('deleteDialog')?.open, null, { timeout: 10000 });
  await panel.evaluate(() => document.getElementById('confirmDelete').click());
  return panel;
}

// Waits until the held mutation arrived and the checkpoint before it is on disk; returns it.
async function heldCheckpoint(env, state, after, ignore = null) {
  await waitFor(() => state.mutations > after, { timeout: 90000, label: 'job to reach the held mutation' });
  const entry = await waitFor(async () => (await history(env)).find(job => job.status === 'running' && job.total > 0 && job.id !== ignore),
    { timeout: 10000, label: 'running checkpoint in jobHistory' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const latest = (await history(env)).find(job => job.id === entry.id);
  const record = (await storage(env.worker, [`job_${entry.id}`]))[`job_${entry.id}`];
  return { entry: latest, record };
}

// Reload the job's tab mid-job, then open `page` (popup or history) and check the result.
function reloadScenario(name, start, page) {
  return {
    name: `checkpoint: ${name}`,
    state: { own: 15 },
    async run(env, state) {
      holdMutations(state, 10);
      const opener = await start(env);
      const cp = await heldCheckpoint(env, state, 10);
      const before = await jobTab(env);
      // X's in-page navigations report 'loading' too; they must not release a live job's tab.
      await xPage(env).evaluate(() => history.replaceState({}, '', location.pathname + '?spa'));
      await new Promise(resolve => setTimeout(resolve, 1000));
      const afterSpa = await jobTab(env);
      await opener.close();
      await xPage(env).reload();
      const after = await waitFor(async () => { const tab = await jobTab(env); return tab.autoDiscardable && tab; },
        { timeout: 10000, label: 'autoDiscardable restored after reload' }).catch(() => jobTab(env));
      const view = await openExtensionPage(env.context, env.extensionId, page);
      const job = await waitFor(async () => (await history(env)).find(j => j.id === cp.entry.id && j.status !== 'running'),
        { timeout: 20000, label: 'interrupted job' }).catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 500));
      const all = await history(env);
      const record = (await storage(env.worker, [`job_${cp.entry.id}`]))[`job_${cp.entry.id}`];
      await view.close();
      return [
        ['a checkpoint was saved as running before the reload', cp.entry.status === 'running' && cp.record?.status === 'running' && cp.record.backup.tweets.length === cp.entry.total, cp.entry],
        ['the job tab was registered and not discardable while running', before.registered && before.autoDiscardable === false, before],
        ['an in-page navigation keeps the live job tab protected', afterSpa.registered && afterSpa.autoDiscardable === false, afterSpa],
        ['one interrupted job, nothing left running', job?.status === 'interrupted' && all.filter(j => j.id === cp.entry.id).length === 1 && !all.some(j => j.status === 'running'), all],
        ['total and counts come from the last checkpoint', job?.total === cp.entry.total && JSON.stringify(job?.counts) === JSON.stringify(cp.entry.counts) && cp.entry.total >= 1 && cp.entry.total <= 10, { job, cp: cp.entry }],
        ['completedAt is the checkpoint time', job?.completedAt === cp.entry.checkpointAt, { completedAt: job?.completedAt, checkpointAt: cp.entry.checkpointAt }],
        ['the saved backup holds the checkpoint records', record?.status === 'interrupted' && record.backup.tweets.length === cp.entry.total && record.backup.tweets.every(t => t.url?.includes('/status/')), record && { status: record.status, rows: record.backup.tweets.length }],
        ['the reload gave the tab back to Memory Saver', after.autoDiscardable === true && !after.registered, after],
        ['posts deleted before the hold stay deleted', state.tweets.length === 5, state.tweets.length]
      ];
    }
  };
}

// A reconciliation while Stop writes the final record (VER-819): the worker's final write is held in
// the tab, a history page or the popup reconciles meanwhile with its own write held (each with its
// own liveness probe), and the final write is released first. The job must stay live while
// finishing, so nothing overwrites its final record.
function finishingScenario(name, start, { page = 'history/history.html', probe = null } = {}) {
  return {
    name: `checkpoint: ${name}`,
    state: { own: 15 },
    async run(env, state) {
      const release = holdMutations(state, 10);
      const opener = await start(env);
      const cp = await heldCheckpoint(env, state, 10);
      await opener.close();
      // Opened while the job runs, so its own reconciliation on load finds it live.
      const view = await openExtensionPage(env.context, env.extensionId, page);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await view.evaluate(id => {
        const area = chrome.storage.local, set = area.set.bind(area);
        window.__held = [];
        area.set = (items, ...rest) => Object.keys(items || {}).includes(`job_${id}`)
          ? new Promise(resolve => window.__held.push(() => resolve(set(items, ...rest))))
          : set(items, ...rest);
      }, cp.entry.id);
      // The worker runs in the tab's isolated world, as executeScript does: hold its final write, then Stop.
      const inTab = which => env.worker.evaluate(async which => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        const funcs = {
          holdAndStop: () => {
            const area = chrome.storage.local, set = area.set.bind(area);
            window.__xbcHeld = [];
            area.set = (items, ...rest) => Object.entries(items || {}).some(([key, value]) => key.startsWith('job_') && value?.status && value.status !== 'running')
              ? new Promise(resolve => window.__xbcHeld.push(() => resolve(set(items, ...rest))))
              : set(items, ...rest);
            window.__xCleanerStop();
          },
          heldCount: () => window.__xbcHeld?.length || 0,
          resume: () => { window.__xbcHeld.splice(0).forEach(resume => resume()); }
        };
        const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: funcs[which] });
        return result?.result;
      }, which);
      await inTab('holdAndStop');
      const held = await waitFor(async () => (await inTab('heldCount')) > 0, { timeout: 10000, label: 'final write held' }).catch(() => false);
      const during = await jobTab(env);
      await view.evaluate(probe => { window.__reconciled = null; reconcileInterruptedJobs(probe ? window[probe] : undefined).then(n => { window.__reconciled = n; }); }, probe);
      const reconciliation = await waitFor(() => view.evaluate(() => (window.__held.length ? 'held a write' : window.__reconciled === null ? null : `changed ${window.__reconciled}`)),
        { timeout: 10000, label: 'reconciliation to finish or write' }).catch(() => 'no answer');
      await inTab('resume');
      await waitFor(async () => (await storage(env.worker, [`job_${cp.entry.id}`]))[`job_${cp.entry.id}`]?.status === 'stopped',
        { timeout: 10000, label: 'final record written' }).catch(() => null);
      await view.evaluate(() => { window.__held.splice(0).forEach(resume => resume()); });
      release();
      await new Promise(resolve => setTimeout(resolve, 1500));
      const all = await history(env);
      const job = all.find(j => j.id === cp.entry.id);
      const record = (await storage(env.worker, [`job_${cp.entry.id}`]))[`job_${cp.entry.id}`];
      const after = await jobTab(env);
      await view.close();
      return [
        ['a checkpoint was saved, then the final write was held after Stop', cp.entry.status === 'running' && held === true, { cp: cp.entry.status, held }],
        ['the tab stays protected while the final record is written', during.registered && during.autoDiscardable === false, during],
        ['a reconciliation meanwhile leaves the finishing job alone', reconciliation === 'changed 0', reconciliation],
        ['the final record stands with the full backup', job?.status === 'stopped' && record?.status === 'stopped' && record.backup.tweets.length === job.total && job.total >= cp.entry.total && all.filter(j => j.id === cp.entry.id).length === 1, { job: job && [job.status, job.total], record: record && [record.status, record.backup.tweets.length] }],
        ['the tab is released once the record is written', after.autoDiscardable === true && !after.registered, after]
      ];
    }
  };
}

export function checkpointScenarios() {
  return [
    reloadScenario('reloading the tab mid Quick Clean leaves one interrupted job', env => startQuickClean(env, 'delete'), 'popup/popup.html'),
    reloadScenario('reloading the tab mid selected deletion leaves one interrupted job', startSelectedDelete, 'history/history.html'),
    {
      name: 'checkpoint: a live job is left running and its final record replaces the checkpoint',
      state: { own: 15 },
      async run(env, state) {
        const staleAt = Date.now() - 60000;
        const stale = { id: 'stale-job', action: 'delete', account: { username: ME.screen }, startedAt: staleAt - 30000, checkpointAt: staleAt, durationMs: 30000, status: 'running', statusText: 'Running', total: 3, counts: { tweets: 3, replies: 0, unliked: 0, unreposted: 0, follows: 0, unfollows: 0 } };
        const staleRows = [0, 1, 2].map(i => ({ id: `7${i}`, url: `/me/status/7${i}`, action: 'deleted' }));
        await env.worker.evaluate(({ stale, staleRows }) => chrome.storage.local.set({ jobHistory: [stale], 'job_stale-job': { ...stale, backup: { tweets: staleRows, replies: [], unliked: [], unreposted: [], follows: [], unfollows: [] } } }), { stale, staleRows });
        // A second X tab with no worker: the live job is in the other one.
        const other = await env.context.newPage();
        await other.goto('https://x.com/home?other');
        const release = holdMutations(state, 10);
        const popup = await startQuickClean(env, 'delete');
        const cp = await heldCheckpoint(env, state, 10, 'stale-job');
        await popup.close();
        const view = await openExtensionPage(env.context, env.extensionId, 'history/history.html');
        const staleAfter = await waitFor(async () => (await history(env)).find(j => j.id === 'stale-job' && j.status !== 'running'),
          { timeout: 20000, label: 'stale job reconciled' }).catch(() => null);
        const liveDuring = (await history(env)).find(j => j.id === cp.entry.id);
        const liveRecordDuring = (await storage(env.worker, [`job_${cp.entry.id}`]))[`job_${cp.entry.id}`];
        const staleRecord = (await storage(env.worker, ['job_stale-job']))['job_stale-job'];
        release();
        const final = await waitFor(async () => (await history(env)).find(j => j.id === cp.entry.id && j.status !== 'running'),
          { timeout: 60000, label: 'live job to finish' }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const all = await history(env);
        const record = (await storage(env.worker, [`job_${cp.entry.id}`]))[`job_${cp.entry.id}`];
        await view.close();
        return [
          ['the dead job is interrupted with its checkpoint values', staleAfter?.status === 'interrupted' && staleAfter.total === 3 && staleAfter.completedAt === staleAt && staleRecord?.status === 'interrupted' && staleRecord.backup.tweets.length === 3, { staleAfter, staleRecord: staleRecord?.status }],
          ['the live job in another tab stays running', liveDuring?.status === 'running' && liveRecordDuring?.status === 'running', liveDuring],
          ['the final record replaces the checkpoint', final?.status === 'completed' && final.total === 15 && record?.status === 'completed' && record.backup.tweets.length === 15 && !('checkpointAt' in final), final],
          ['one entry per job and nothing running', all.length === 2 && all.filter(j => j.id === cp.entry.id).length === 1 && !all.some(j => j.status === 'running'), all.map(j => [j.id, j.status])],
          ['all posts deleted', state.tweets.length === 0, state.tweets.length]
        ];
      }
    },
    {
      name: 'checkpoint: Stop after a checkpoint records one stopped job',
      state: { own: 15 },
      async run(env, state) {
        const release = holdMutations(state, 10);
        const popup = await startQuickClean(env, 'delete');
        const cp = await heldCheckpoint(env, state, 10);
        await popup.close();
        await env.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__xCleanerStop() });
        });
        release();
        const job = await waitFor(async () => (await history(env)).find(j => j.id === cp.entry.id && j.status !== 'running'),
          { timeout: 20000, label: 'stopped job' }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const all = await history(env);
        const record = (await storage(env.worker, [`job_${cp.entry.id}`]))[`job_${cp.entry.id}`];
        const tab = await jobTab(env);
        return [
          ['a checkpoint was saved before Stop', cp.entry.status === 'running', cp.entry],
          ['Stop writes one stopped record over the checkpoint', job?.status === 'stopped' && all.length === 1 && record?.status === 'stopped' && record.backup.tweets.length === job.total && job.total >= cp.entry.total, { all, record: record?.status }],
          ['the tab is discardable again', tab.autoDiscardable === true && !tab.registered, tab]
        ];
      }
    },
    {
      name: 'checkpoint: closing a tab clears job keys only for the job tab',
      state: { own: 0 },
      async run(env) {
        const jobPage = await env.context.newPage();
        await jobPage.goto('https://x.com/home?job');
        const previewPage = await env.context.newPage();
        await previewPage.goto('https://x.com/home?preview');
        const ids = await env.worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({ url: ['https://x.com/*'] });
          return { job: tabs.find(t => t.url.endsWith('?job')).id, preview: tabs.find(t => t.url.endsWith('?preview')).id };
        });
        await env.worker.evaluate(ids => chrome.storage.local.set({ activeAction: 'delete', activeTabId: ids.job, startTime: Date.now(), actionStats: { deleted: 1 }, activePreviewSession: { tabId: ids.preview, type: 'tweets' } }), ids);
        await previewPage.close();
        await waitFor(async () => !(await storage(env.worker, ['activePreviewSession'])).activePreviewSession, { timeout: 5000, label: 'preview session cleared' }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 500));
        const afterPreview = await storage(env.worker, ['activeAction', 'activeTabId', 'startTime', 'actionStats', 'activePreviewSession']);
        await jobPage.close();
        const afterJob = await waitFor(async () => { const s = await storage(env.worker, ['activeAction', 'activeTabId', 'startTime', 'actionStats']); return Object.keys(s).length === 0 && s; },
          { timeout: 5000, label: 'job keys cleared' }).catch(() => storage(env.worker, ['activeAction', 'activeTabId', 'startTime', 'actionStats']));
        return [
          ['closing another tab keeps the job keys and still clears its preview session', afterPreview.activeAction === 'delete' && afterPreview.activeTabId === ids.job && afterPreview.startTime && afterPreview.actionStats && !afterPreview.activePreviewSession, afterPreview],
          ['closing the job tab clears activeAction, activeTabId, startTime and actionStats', Object.keys(afterJob).length === 0, afterJob]
        ];
      }
    },
    finishingScenario('a reconciliation during Stop in Quick Clean never overwrites the final record', env => startQuickClean(env, 'delete')),
    finishingScenario('a reconciliation during Stop in selected deletion never overwrites the final record', startSelectedDelete),
    finishingScenario('a reconciliation from the popup during Stop never overwrites the final record', env => startQuickClean(env, 'delete'), { page: 'popup/popup.html', probe: 'readWorkerState' }),
    {
      name: 'checkpoint: an entry left running takes the final record that landed after it',
      state: { own: 0 },
      async run(env) {
        const at = Date.now() - 60000;
        const counts = { tweets: 2, replies: 0, unliked: 0, unreposted: 0, follows: 0, unfollows: 0 };
        const entry = { id: 'done-job', action: 'delete', account: { username: ME.screen }, startedAt: at - 20000, checkpointAt: at - 10000, durationMs: 10000, status: 'running', statusText: 'Running', total: 1, counts: { ...counts, tweets: 1 } };
        const { checkpointAt, ...rest } = entry;
        const final = { ...rest, completedAt: at, durationMs: 20000, status: 'completed', statusText: 'Finished — 2 deleted via API', total: 2, counts };
        const rows = [0, 1].map(i => ({ id: `8${i}`, url: `/me/status/8${i}`, action: 'deleted' }));
        await env.worker.evaluate(({ entry, final, rows }) => chrome.storage.local.set({ jobHistory: [entry], 'job_done-job': { ...final, backup: { tweets: rows, replies: [], unliked: [], unreposted: [], follows: [], unfollows: [] } } }), { entry, final, rows });
        const view = await openExtensionPage(env.context, env.extensionId, 'history/history.html');
        const job = await waitFor(async () => (await history(env)).find(j => j.id === 'done-job' && j.status !== 'running'),
          { timeout: 20000, label: 'entry reconciled' }).catch(() => null);
        const record = (await storage(env.worker, ['job_done-job']))['job_done-job'];
        await view.close();
        return [
          ['the entry takes the final record, without the backup', job?.status === 'completed' && job.total === 2 && job.completedAt === at && Object.keys(counts).every(key => job.counts?.[key] === counts[key]) && !('backup' in job) && !('checkpointAt' in job), job],
          ['the final record is untouched', record?.status === 'completed' && record.backup.tweets.length === 2, record && record.status]
        ];
      }
    }
  ];
}
