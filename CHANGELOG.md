# Changelog

## [0.1.0] - Unreleased

First release of Postscrub.

### Added

- API mode, on by default: lists and acts through the same requests X's own site sends, so jobs are faster and keep running in a background tab. Request formats are discovered at runtime from the page and X's current web bundle. Falls back to clicking through the page when X refuses the API.
- Preview & Select scans through the API identify replies exactly, and selected items are acted on directly by id.
- Automatic handling of X's limits: waits out rate limits until X's reset time and slows down afterwards; stops at once on account locks, restricted sessions, suspensions, expired sessions, daily limits, the follow limit and anything X flags as automated.
- End-to-end tests that load the extension in Chromium against a simulated x.com.

### Fixed

- Deleting posts and replies works in every language X supports. Only the English "Delete" label was recognized, so on X in Portuguese and other languages posts were found but never deleted.
- Posts are no longer skipped after one missed click: elements are looked up again after X re-renders, and a post is retried up to three times.
- Jobs no longer stall or end early in a background tab: sleeps are timed by the service worker, the tab is kept from being discarded, and a hidden tab's empty cycles no longer count as the end of a list.
- Reply detection and X's error toasts are recognized in Portuguese, Spanish, French and German.
