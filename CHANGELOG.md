# Changelog 📋

All notable changes are documented here. Releases before `1.4.0` are not reconstructed in detail.

## [1.4.0] - 2026-07-11 🚀

### Added ✨

- 🧭 Preview & Select in Chrome's Side Panel for tweets, replies, reposts, and Following accounts.
- 💬 Reply scan choices: **Replies only** or **Posts + replies** for one-pass manual review of standalone posts and possible orphan replies.
- 👥 Selected-only bulk unfollow, including profile photos, bios, search, confirmation, progress, local backup, and CSV export data.
- 🛡️ Active-account display, destructive-action confirmations, job locking, and an in-page progress overlay with stop control.
- 📦 Persistent job history with per-job details, individual CSV downloads, and a single **Download all CSV** export.
- ⚡ Performance mode for reducing media rendering while scans and cleanup jobs run.

### Changed 🎨

- 🧩 Reworked popup, Side Panel, and History UI around safer review-first cleanup flows.
- ✨ Improved interaction feedback, accessibility focus states, reduced-motion support, and restrained state-transition animations.
- 🚪 The popup closes after a cleanup worker starts successfully.

### Fixed 🐛

- 🔓 Quick Clean actions now end an existing Preview session only after confirmation instead of becoming blocked by a stale preview lock.
- 🧠 Reply cleanup no longer needs a second main-profile scan; the Posts + replies mode keeps standalone items available for manual selection.
