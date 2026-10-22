# 0002. In API mode, the replies list is read from X's own page

Status: accepted (VER-899, 2026-10-22)

## Context

Preview & Select lists replies in API mode with `UserTweetsAndReplies` ("UTR"). Until this change the extension sent that GET itself from the X tab (`worker/xapi.js`, `pages()`), with X's public bearer, the `ct0` CSRF token and the operation's query id and features. It did not send `x-client-transaction-id`, a per-request header that X's obfuscated web code makes.

A real account reported the scan stopping at once with "HTTP 404" (VER-624). The research note on VER-624 (https://linear.app/versortech/issue/VER-624#comment-da587174) found:

- C1: X answers UTR without `x-client-transaction-id` with 404 and an empty body, with the current query id, features and auth. The same request with the header, sent by X's own page, succeeds. The other lists Postscrub uses (`UserTweets`, `Likes`, `Following`, ...) still answer without it.
- C2: the header is made by X's page code for each request, from material in the page. Making one outside X's code means reproducing or extracting that code.

The project's rules forbid forging or extracting session-binding signatures or signing keys. The owner decided that making, copying or replaying this header falls under the same rule.

## Decision

The owner chose option (c) of the research note:

1. In API mode, the replies list comes only from the responses to X's own page requests at `/<me>/with_replies`. X's page sends its own `x-client-transaction-id`. Postscrub never makes, copies, replays or records that header, or any other signature. Deleting the selected replies still uses `DeleteTweet` by id, unchanged.
2. The scan scrolls the page, as the click scan does, so that X's page asks for each next page.
3. This is always the path for replies in API mode, not a fallback. The extension never sends a UTR request itself: `pages('UserTweetsAndReplies')` throws `passive_only` before any wait or request, and UTR is no longer in the client's built-in ids, variables or field toggles.

How it works:

- **Arming.** The side panel writes `xbcPassiveScan = { id, until }` in the X tab's `sessionStorage`, then loads `/<me>/with_replies` again, even when the tab already shows it. `sessionStorage` is shared by the page's world and the extension's isolated world, and it survives the reload. The first page's response therefore arrives while the tab is armed. The running scan pushes `until` about 30 s ahead at every step. Finish, Stop, reset and the start of a selected deletion remove the key. A scan that died disarms by itself within about 30 s.
- **Capture** (`inject/capture.js`, page world, `document_start`). For a GET of `/i/api/graphql/<id>/UserTweetsAndReplies`, and only while armed:
  - fetch: the page gets the same Response, or the same rejection; a `clone()` of the body is read before the page can read its own;
  - XHR: a one-shot `loadend` listener reads `responseText` (or the JSON `response`).

  Each response becomes a record `{ seq, at, status, userId, cursor, body, rateReset, rateRemaining, unreadable? }`, where `userId` and `cursor` come from the request's `variables`. Request headers are never recorded. Records are held in a closure queue of at most 40; extra ones are counted as `overflow`. Unarmed, nothing is read, and queued records are dropped: on the next response or drain, or by a check every 5 s once the arm has lapsed.
- **Handoff.** The scan dispatches `xbc:passive-drain` on the document. capture.js answers synchronously with one `xbc:passive-record` event per record (a JSON string as `detail`, since objects do not cross worlds), then `{ overflow }` if any were dropped. The scan accepts records only during its own drain. `<html data-xbc-capture="2">` tells the scan that capture.js runs in the tab. Bodies never go to the DOM or to any storage.
- **Scan** (`startPassiveScan` in `sidepanel/sidepanel.js`).
  - Before listing, it stops if: the tab is signed in to another account; the page is not `/<me>/with_replies`; capture.js is absent (the user is told to reload the tab); or the arm is missing or expired.
  - Every 1.5 s it refreshes the arm and drains. Each record is handled as follows:
    - another account's record is ignored, and counted;
    - a 429, or error code 88/143, stops the scan naming X's rate limit and its reset time;
    - any other non-200 stops it with "X refused its own request for your replies (HTTP n)";
    - a 200 without `data`, or an unreadable body, also stops it;
    - otherwise the body goes through the client's `parsePage` and the existing classification: a reply is `definite`, a standalone post is listed only in the Posts + replies scope.
  - It scrolls only when it is not paused, the tab is visible and no new response came in that step. In a hidden tab it neither scrolls nor counts towards an end, and it asks the user to keep the tab visible.
- **Ending.** "Scan complete" only when X ended the list:
  - either the page received `TimelineTerminateTimeline` (Bottom);
  - or its last page held no posts and, at the bottom, the page asked nothing more for 6 visible steps.

  In both cases the first page (no cursor) must have been read, and no response may have had gaps (`errors[]` or an unknown instruction), or the scan ends "with gaps" instead. Other endings are stops with a reason, and the items found stay reviewable:
  - after a page that still had posts, the page stopped asking for 6 visible steps at the bottom;
  - nothing arrived within 20 s of visible waiting;
  - responses overflowed the queue.
- **Cooldowns.** A refused page response writes no `xbcApiCooldown` key: the request was X's page's, not Postscrub's, and its limits are X's page's to handle.

## Alternatives rejected

- **Making or replaying the header.** Generating `x-client-transaction-id` outside X's code, or copying the page's value into Postscrub's own requests, means reproducing or extracting X's signing code. The owner vetoed it as evasion, under the rule against forging session-binding signatures.
- **A DOM-only scan.** The click scan already exists (API mode off). It cannot tell replies apart exactly: it guesses from "Replying to" and the thread line. The API scan was meant to fix that.
- **Keeping the extension's own request.** The scan would keep failing with HTTP 404 on real accounts. Without the header, waiting for the page's query id (VER-624's first fix) does not help.

## Limits

- The scan needs the X tab open, rendered and visible, and it scrolls it. It does not run in a background tab, unlike the other API lists and every deletion. A hidden tab pauses the scan; it does not end it.
- Pagination is X's page's. If the page stops loading, the scan stops and says so. It never calls the list complete without X's end of timeline, or without an empty last page followed by silence at the bottom. X's real responses can carry instruction types the parser does not know; such a scan ends "with gaps", never "complete".
- Any script in X's page can see the drain and record events, and so the bodies the page already received. A script could also send fake record events during a drain. Records are accepted only from the scan's own account, during its own drain. The selected items are still reviewed and confirmed before deletion, and deletion acts only on the account's own posts.
- While armed, every UTR response of that tab is read, including another profile's replies if the user navigates there. The scan stops on any route change and ignores records for another user id. The arm expires within about 30 s of the scan ending or dying.
- Validation against real X belongs to the user before release (VER-624): the simulated X stands in for X's page and its header.

## Evidence

Simulated X (`test/e2e/fake-x.mjs`):

- the page sends a stand-in `x-client-transaction-id` on its own requests;
- X answers UTR without it with 404 and an empty body, before any forced response;
- `/me/with_replies` draws its timeline and asks for the next page with the response's cursor when scrolled near the bottom.

Browser scenarios in `test/e2e/run.mjs` (`preview: replies only`, `preview: posts + replies …`, `replies passive: …`):

- every reply listed across pages read from the page, with zero extension UTR requests, then deleted by `DeleteTweet`;
- standalone posts in the Posts + replies scope;
- the first page kept when the tab was already on the Replies page;
- an honest stop when the page never asks;
- 404 and 429 page responses;
- Stop mid-scan;
- no read without an arm;
- account and route mismatches;
- the fake's refusal itself.

The eleven scenarios that exercise the extension fail on `494ed8b` and pass with this change; the fake's own refusal check is independent of the extension. Synthetic checks (`--api-limits`, `passive:`) cover the end rules, gaps, other accounts' records, hidden tabs, Pause, Stop, overflow, the checks before listing and the client's `passive_only` refusal.
