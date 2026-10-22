<p align="center">
  <img src="src/icons/logo.png" alt="Postscrub" width="128" height="128">
</p>

<h1 align="center">Postscrub</h1>

<p align="center"><strong>Scrub your social history.</strong> Review first, act in bulk, everything stays in your browser.</p>

Postscrub is a Chrome extension that cleans up your X account in bulk: delete posts and replies, remove likes and reposts, unfollow or follow back. You see exactly what will be removed before anything happens, every job keeps a local record you can export as CSV, and nothing is ever sent to a server of ours. There is none.

## Features

- **Preview & Select** in Chrome's side panel: scan posts, replies, reposts or the accounts you follow, filter by text and date, select exactly what goes.
- **Quick clean**: delete all posts, clear all likes, remove all reposts, bulk unfollow, follow back followers.
- **API mode** (default): Postscrub sends the same requests X's own site sends when you click, so jobs are fast and keep running in a background tab. If X refuses them, the job or scan stops and tells you why: start it again to retry the API, or turn API mode off to do it by clicking through the page.
- **Speed** for API mode, in the popup and side panel settings: Normal (the default) paces actions near the speed of clicking, and Careful waits twice as long between them. There is no faster setting. X publishes no limit for deleting, so neither speed is a promise that X will not limit or lock the account. Stop ends the pause between two actions within a second, and no pause is waited after the last item. Waits for X's rate limits and between list pages still check Stop every 15 seconds.
- **Works in any language** X is set to.
- **Safety first**: confirmation with the active account before every run, one job at a time, a stop button on the page, and an automatic stop when X reports a lock, a limit or suspected automation. Rate limits are waited out, not hammered.
- **Local job history** with every affected post or account, exportable as CSV.

## Install from source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `src` folder.
4. Open x.com signed in, then open Postscrub from the toolbar.

Chrome 116 or newer is required.

## How it works

Postscrub runs in the x.com tab you are signed in to:

- `src/inject/capture.js` records the request formats X's own page uses (operation ids, feature flags), because X changes them with every release.
- `src/worker/xapi.js` uses them to list and act on your items through X's web API, waiting out rate limits and stopping on anything that signals risk to the account.
- With API mode off, the click-through workers in `src/popup/popup.js` and `src/sidepanel/sidepanel.js` do the work through the page. They never take over from a refused API job on their own.

See [AGENTS.md](AGENTS.md) for the architecture, the X API details and the development workflow.

## Development

```bash
npm run check        # syntax-check every JavaScript file
npm run test:e2e     # load the extension in Chromium against a simulated x.com
./package.sh         # build postscrub-v<version>.zip for the Chrome Web Store
```

End-to-end tests need Playwright and a Chromium build (`CHROMIUM_PATH` overrides the default location).

## Privacy

Postscrub has no backend, analytics, telemetry or accounts. It talks only to X, from your own browser, on your behalf. Job history and backups are stored locally in Chrome. See [PRIVACY.md](PRIVACY.md).

## Important

Bulk actions are permanent. Start with a small selection, keep the CSV record, and use Postscrub only on accounts you own or manage. You are responsible for complying with X's terms.

Postscrub is not affiliated with, endorsed by, or sponsored by X Corp.
