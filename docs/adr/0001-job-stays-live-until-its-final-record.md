# 0001. A job stays live until its final record is written

Status: accepted (VER-819, 2026-10-21)

## Context

Jobs save themselves as `running` while they work (checkpoints, VER-629). When the popup or the history page opens, `reconcileInterruptedJobs` (`src/shared/jobs.js`) marks a `running` job as `interrupted` if no X tab answers that a worker with that job id is running. Three probes answer that question: `readJobState` in `jobs.js`, `readWorkerState` in the popup, and the tab check in `background.js`.

Both workers cleared `X.interval` before writing their final record. They also told the service worker that the job had ended (`setJobRunning(false)`) before that write. So during the write:

- every probe saw a dead job;
- a reconciliation could read the last checkpoint and write it back as `interrupted` over the final record and its full backup;
- the tab went back to Memory Saver mid-write.

A reconciliation could also find a history entry still `running` whose `job_<id>` record was already final. It then marked the entry `interrupted`, and the entry and the record disagreed.

## Decision

1. A worker counts as live while `X.interval` is set or `X.finishing > 0`. All three probes use that rule.
2. `stopAll` (popup) and `stop` (side panel) raise `X.finishing` before clearing the interval. They lower it in `finally`, after the final record is written, so a failed write cannot leave a job live forever. The count handles a second stop while the first is still writing.
3. `setJobRunning(false)` runs when `X.finishing` returns to zero, so the tab stays protected until the final record lands.
4. A new job does not start in a tab whose previous job is still finishing.
5. When the re-read `job_<id>` is already final, reconciliation copies it, without the backup, into the history entry instead of interrupting the entry.

## Limits

- `chrome.storage` has no transactions. Two writers that read and rewrite `jobHistory` at the same time can still lose one update. This decision narrows the window for a finishing job; it does not make writes atomic.
- A worker that dies while writing (tab closed or reloaded) is gone either way. Its job is reconciled from the last checkpoint, as before.

## Evidence

Scenarios in `test/e2e/checkpoint.mjs`:

- a reconciliation during Stop, for Quick Clean and for selected deletion;
- an entry left `running` with a final record.

All three fail on `5bc7891` and pass with this change. On `5bc7891`, the final `stopped` record was overwritten by the checkpoint, marked `interrupted` with 10 of 15 posts, and the tab was released before the final write.
