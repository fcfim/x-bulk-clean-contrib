// Shared by the popup and the history page. Workers save their job as 'running' while they work
// (a checkpoint); a job left 'running' whose worker is gone (tab reloaded or closed, extension
// updated, browser crashed) is marked 'interrupted' here, keeping what its last checkpoint saved.

// Runs in each X tab; the popup passes its own readWorkerState, which returns the same fields.
function readJobState() {
  const X = window.__xCleaner;
  return X ? { jobId: X.jobId || null, running: !!X.interval } : null;
}

async function reconcileInterruptedJobs(probe = readJobState) {
  const { jobHistory } = await chrome.storage.local.get(['jobHistory']);
  const running = (Array.isArray(jobHistory) ? jobHistory : []).filter(job => job?.status === 'running');
  if (!running.length) return 0;

  // A job is alive only if a running worker with its id answers. A tab that cannot be read
  // (discarded, loading, closed) holds no live worker.
  const live = new Set();
  const tabs = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*'] });
  for (const tab of tabs) {
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probe });
      const state = result?.result;
      if (state?.running && state.jobId) live.add(state.jobId);
    } catch (_) {}
  }
  const stale = new Set(running.filter(job => !live.has(job.id)).map(job => job.id));
  if (!stale.size) return 0;

  // Read again: a worker may have written its final record while the tabs were checked.
  const keys = [...stale].map(id => `job_${id}`);
  const fresh = await chrome.storage.local.get(['jobHistory', ...keys]);
  const history = Array.isArray(fresh.jobHistory) ? fresh.jobHistory : [];
  const interrupt = job => {
    const completedAt = job.checkpointAt || job.startedAt || Date.now();
    return {
      ...job,
      status: 'interrupted',
      statusText: 'Interrupted: the X tab was closed or reloaded before the job finished',
      completedAt,
      durationMs: Math.max(0, completedAt - (job.startedAt || completedAt))
    };
  };
  const updates = {};
  let changed = 0;
  updates.jobHistory = history.map(job => {
    if (!job || !stale.has(job.id) || job.status !== 'running') return job;
    changed++;
    const record = fresh[`job_${job.id}`];
    if (record?.status === 'running') updates[`job_${job.id}`] = interrupt(record);
    return interrupt(job);
  });
  if (changed) await chrome.storage.local.set(updates);
  return changed;
}
