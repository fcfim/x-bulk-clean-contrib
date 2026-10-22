# Changelog

## Unreleased

### Added

- A Speed setting for API mode, in the popup and the side panel: Normal (the default) or Careful, which waits twice as long between actions. There is no faster option, and a stored value below Normal is still paced as Normal.
- Delete all posts can be limited by date: only posts before a chosen date, or keep the last N days. Only older posts are deleted and counted, in API and click mode; a post whose date cannot be read is skipped, never deleted. The confirmation names the range, an incomplete choice starts nothing, and the job history shows the range and how many newer posts were kept.
- Export selection (CSV) in Preview & Select: saves the selected items only, with the columns of the job history's CSV, a byte order mark and formulas kept as text. It deletes nothing and leaves the selection as it is.

### Fixed

- Stop during the pause between two API actions ends it within a second, with no further request, and a job no longer waits a pause after its last item.

## [0.1.0] - Unreleased

First release of Postscrub.

### Added

- API mode, on by default: lists and acts through the same requests X's own site sends, so jobs are faster and keep running in a background tab. Request formats are discovered at runtime from the page and X's current web bundle. When X refuses the API, the job or scan stops and says why; you start it again to retry the API, or turn API mode off to do it by clicking.
- Preview & Select scans through the API identify replies exactly, and selected items are acted on directly by id.
- Automatic handling of X's limits: waits out rate limits until X's reset time and slows down afterwards; stops at once on account locks, restricted sessions, suspensions, expired sessions, daily limits, the follow limit and anything X flags as automated.
- End-to-end tests that load the extension in Chromium against a simulated x.com.

### Fixed

- Deleting posts and replies works in every language X supports. Only the English "Delete" label was recognized, so on X in Portuguese and other languages posts were found but never deleted.
- Posts are no longer skipped after one missed click: elements are looked up again after X re-renders, and a post is retried up to three times.
- Jobs no longer stall or end early in a background tab: sleeps are timed by the service worker, the tab is kept from being discarded, and a hidden tab's empty cycles no longer count as the end of a list.
- Reply detection and X's error toasts are recognized in Portuguese, Spanish, French and German.
- CSV backups open correctly in spreadsheets: they start with a byte order mark, so Excel shows accents, and a cell that starts with =, +, -, @, a tab or a carriage return gets a leading ' so it is shown as text instead of evaluated. The download link is no longer revoked right after the click.
- In click mode, your posts are told apart by the account you confirmed when X's profile link is missing, and deleting or scanning posts and replies stops before any click when the tab is signed in to another account.
- A job that is stopping keeps its tab and its final record until that record is saved. Opening the popup or the history page meanwhile no longer turns it into an interrupted job with a partial backup.
- In click mode, unlikes, follows and unfollows are counted, and backed up, only once X shows them done. An action X refuses without a word is retried, not reported.
- Click mode stops with a reason when X's main column is missing, no longer scrolls a page a stray click moved to, and selected deletion stops at X's login form.
- A step that keeps failing stops the job, or the scan, with the error, instead of running on in silence. A lost extension context no longer makes a job loop without pauses, and an error while starting a job is no longer reported as a cooldown problem.
- The "found" count of Delete posts in click mode counts only your own posts, not the reposts it skips.
- The Preview panel says when its scan was lost (the X tab reloaded or left the page) and goes back to the setup, shows when an API scan is waiting out X's rate limit and when it resumes, and asks before "New scan" clears a review on screen.
- Pauses longer than 20 seconds, such as a pace slowed down after X's limits, now last their full length.
- API scans and jobs no longer request a list with a saved or built-in query id before X's page has had a chance to ask for it: they wait up to 8 seconds for the page's own request and use its id. Only ids taken from the page or X's web bundle are saved, a saved list id X answers with 404 is dropped, and a Preview scan whose list request X refuses names the operation, the HTTP status and where its id came from. This addresses "Find & delete replies" ending at once with HTTP 404 in API mode; the cause on the real X is not confirmed yet.
