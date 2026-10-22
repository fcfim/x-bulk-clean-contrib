# Privacy

Postscrub does not collect, sell, or transmit personal data to its developers. It has no backend, analytics, telemetry, advertising or accounts.

## What it accesses

- **x.com and twitter.com**, only in your signed-in tab and only to perform the action you start. In API mode the extension sends the same requests X's own site sends when you click (listing your posts, likes or follows, deleting, unliking, unreposting, following or unfollowing), from your browser, with your existing X session. Your replies are the exception: X's page asks for that list itself, and Postscrub reads X's answers in the page (below). It never sends that request.
- **abs.twimg.com**, X's public content server, to read the version of X's web app your tab loaded. Postscrub reads it only to learn the current request formats; nothing is sent to it.
- A script that runs in the X page records the request formats and public settings X's page uses (operation ids, feature flags, the web app's public token and your account id). It does not record the content of requests, and it does not store your cookies or session.
- The same script reads the content of X's responses only during a Preview & Select scan of your replies in API mode, and only in that tab: X's answers to the page's own requests for a Replies page. They hold your posts and replies and the posts you replied to. If you open another profile's Replies page in that tab during the scan, X's answer for it can be read too; the scan then stops within a few seconds and discards anything that is not your account's. The script keeps the answers in the page's memory until the scan takes them, every 1.5 seconds while it runs, and hands them to the scan in the same tab through page events, which other scripts running in X's page could also see (they are answers X's page already received). If the scan ends or stops working they are dropped within about a minute. They are never stored or sent anywhere. To mark the scan, the tab's session storage holds a scan id and an expiry time, removed when the scan ends and otherwise expiring within about a minute; a copy of the tab made with Duplicate keeps that mark until it expires.

## What it stores

Preferences, job history, the records of affected posts and accounts, and the CSV backup data are stored locally in Chrome's extension storage until you remove jobs or clear the history. CSV exports are created locally and downloaded by your browser.

Preview scan results stay in the X tab and the side panel. X's answers read for a replies scan are not stored.

## Changes

If a future version introduces any data collection or external service, this document and the extension's permissions will be updated before release.
