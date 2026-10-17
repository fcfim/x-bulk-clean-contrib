# Privacy

Postscrub does not collect, sell, or transmit personal data to its developers. It has no backend, analytics, telemetry, advertising or accounts.

## What it accesses

- **x.com and twitter.com**, only in your signed-in tab and only to perform the action you start. In API mode the extension sends the same requests X's own site sends when you click (listing your posts, likes or follows, deleting, unliking, unreposting, following or unfollowing), from your browser, with your existing X session.
- **abs.twimg.com**, X's public content server, to read the version of X's web app your tab loaded. Postscrub reads it only to learn the current request formats; nothing is sent to it.
- A script that runs in the X page records the request formats and public settings X's page uses (operation ids, feature flags, the web app's public token and your account id). It does not record the content of requests or responses, and it does not store your cookies or session.

## What it stores

Preferences, job history, the records of affected posts and accounts, and the CSV backup data are stored locally in Chrome's extension storage until you remove jobs or clear the history. CSV exports are created locally and downloaded by your browser.

Preview scan results stay in the X tab and the side panel.

## Changes

If a future version introduces any data collection or external service, this document and the extension's permissions will be updated before release.
