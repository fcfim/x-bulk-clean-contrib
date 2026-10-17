# Chrome Web Store listing — Postscrub

## Store listing

**Name**
Postscrub

**Short description** (max 132 characters)
Bulk clean up your X history: delete posts and replies, remove likes and reposts, manage follows. Review first, runs locally.

**Detailed description**
Postscrub cleans up your X account in bulk, and you stay in control the whole time.

Review first. Scan your posts, replies, reposts or the accounts you follow in Chrome's side panel, filter by text and date, and select exactly what goes. Or run a quick clean of everything.

Fast, and it keeps working while you do something else. Postscrub sends the same requests X's own site sends when you click, so a cleanup keeps running in a background tab.

Careful with your account. Postscrub waits out X's rate limits instead of hammering them, and stops immediately if X reports a lock, a limit or suspected automation.

Private by design. No servers, no analytics, no accounts. Postscrub talks only to X, from your own browser. Every job keeps a local record of what was removed, exportable as CSV.

Features:
- Delete posts and replies, in any language X is set to
- Remove likes and reposts
- Unfollow accounts, or follow back your followers
- Preview & Select with search, date filters and bulk selection
- Confirmation with the active account before every run, and a stop button on the page
- Local job history with CSV export

Bulk actions are permanent. Start with a small selection and keep the CSV record.

Postscrub is not affiliated with, endorsed by, or sponsored by X Corp.

**Category**
Productivity

## Permission justifications

- **scripting, activeTab, tabs**: run the cleanup in your signed-in X tab and find that tab.
- **storage, unlimitedStorage**: keep preferences, job history and backups locally; histories of large accounts exceed the default quota.
- **sidePanel**: Preview & Select.
- **Host x.com, twitter.com**: the only sites Postscrub acts on.
- **Host abs.twimg.com**: read the version of X's web app the tab loaded, to use its current request formats.

## Single purpose

Bulk cleanup of the user's own X account, with review before any destructive action.
