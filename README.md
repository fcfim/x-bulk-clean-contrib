<p align="center">
  <img src="src/icons/logo.png" alt="X Bulk Clean logo" width="160" height="160">
</p>

<h1 align="center">X Bulk Clean</h1>

<p align="center">
  <a href="https://github.com/agmmnn/x-bulk-clean">github.com/agmmnn/x-bulk-clean</a>
</p>

**X Bulk Clean** is a Chrome extension for quickly cleaning up your X account. Bulk delete tweets, replies, reposts, and likes, or mass unfollow accounts without managing items one by one. It runs directly in your browser for a simple, fast, and privacy-friendly cleanup experience.

## Features

- Delete posts and replies
- Preview tweets, replies, or reposts in Chrome's side panel and choose exactly what to delete or remove
- Filter scanned results by text and date, then select all, none, or invert the selection
- Remove likes and reposts
- Follow followers or verified followers
- Bulk unfollow accounts
- Show the currently active X account before an action starts
- Confirm the account and action before every automated run
- Monitor or stop an active job from an on-page status panel
- Prevent overlapping cleanup jobs
- Keep persistent, account-aware job history with dates, times, counts, and affected records
- Review, export, or remove individual jobs from the full history page
- Export activity backups as CSV
- Optional performance mode that reduces tweet-media rendering during automated runs
- No analytics, payment service, or external backend

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left corner).
5. Select the `src` folder inside the cloned repository.
6. Sign in to X, open the extension, and choose an action.

Preview & Select mode requires Chrome 116 or newer.

## Development & Packaging

To bundle the extension into a clean ZIP archive ready for the Chrome Web Store:
1. Make the packaging script executable (if not already): `chmod +x package.sh`
2. Run `./package.sh` in the project root.
3. This creates a release-ready `x-bulk-clean-v<version>.zip` excluding git metadata, documentation, and editor files.

## Important safety notes

Bulk actions are destructive and may be difficult or impossible to reverse. Export a CSV backup first, test with a small account or a small set of items, and keep the X tab visible while an action is running. X can change its interface or impose rate limits at any time, which may interrupt an action.

Use the extension only on accounts you own or are authorized to manage. You are responsible for complying with X's terms and applicable rules.

## Privacy

X Bulk Clean operates on the active X page. It does not include analytics, licensing, payment processing, or an external service. See [PRIVACY.md](PRIVACY.md) for details.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Released under the [MIT License](LICENSE).

Interface icons are based on [Lucide](https://lucide.dev/) and covered by the notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

X Bulk Clean is not affiliated with, endorsed by, or sponsored by X Corp.
