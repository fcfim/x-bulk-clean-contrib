# Changelog 📋

All notable changes are documented here. Releases before `1.4.0` are not reconstructed in detail.

## [Unreleased]

### Fixed 🐛

- 🌐 Deleting posts and replies now works when X is not in English. The Delete menu item was matched only by its English label, so with X in Portuguese ("Excluir") or other languages every post was counted as found but none was deleted. Known labels in common languages are matched, with a language-independent fallback (the red first item of the menu on your own posts).
- 🔁 Posts are no longer skipped after a single missed click. X re-renders the timeline after each deletion, so the worker now looks the post up again before acting and retries it up to three times before giving up.
- 🕒 Jobs keep running while the X tab is in the background. Chrome throttles timers in hidden tabs (to about one wake-up per minute after five minutes), which stalled jobs; sleeps are now timed by the extension's service worker, the job tab is kept from being discarded by Memory Saver, and a Web Lock keeps the tab from being frozen.
- 🙈 Jobs and Preview scans no longer end early as "Finished" while the X tab is hidden. A hidden tab is not rendered, so X drew no posts and the worker scrolled to the bottom, saw nothing and stopped; empty cycles in a hidden tab no longer count as the end, and the worker waits instead of scrolling past posts X has yet to draw.
- 💬 Reply detection and X error toasts also recognize Portuguese, Spanish, French and German wording.

## [1.4.0] - 2026-07-11 🚀

### Added ✨

- 🧭 Preview & Select in Chrome's Side Panel for tweets, replies, reposts, and Following accounts.
- 💬 Reply scan choices: **Replies only** or **Posts + replies** for one-pass manual review of standalone posts and possible orphan replies.
- 👥 Selected-only bulk unfollow, including profile photos, bios, search, confirmation, progress, local backup, and CSV export data.
- 🛡️ Active-account display, destructive-action confirmations, job locking, and an in-page progress overlay with stop control.
- 📦 Persistent job history with per-job details, individual CSV downloads, and a single **Download all CSV** export.
- ⚡ Performance mode for reducing media rendering while scans and cleanup jobs run.
- 🔗 Quick access to the GitHub repository from the popup header.

### Changed 🎨

- 🧩 Reworked popup, Side Panel, and History UI around safer review-first cleanup flows.
- ✨ Improved interaction feedback, accessibility focus states, reduced-motion support, and restrained state-transition animations.
- 🚪 The popup closes after a cleanup worker starts successfully.

### Fixed 🐛

- 🔓 Quick Clean actions now end an existing Preview session only after confirmation instead of becoming blocked by a stale preview lock.
- 🧠 Reply cleanup no longer needs a second main-profile scan; the Posts + replies mode keeps standalone items available for manual selection.
- ⏸️ Rate Limit Guard stops follow and unfollow jobs immediately when X reports a rate limit, avoids counting failed actions, and records the job as rate limited.
