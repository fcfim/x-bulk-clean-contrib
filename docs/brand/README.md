# Postscrub brand (proposal, not yet applied)

Chosen concept: **Swept Card** (judge totals: card 23.5, stroke 19, monogram 18, bubble 15). The other concepts are in `concepts/`.

The final mark is the Swept Card concept, refined to fix every weakness the judges raised. I rendered each change and checked it in 8x and 20x pixel zooms at 16px and 24px, on #ffffff, #f1f3f4, #3c3c3c and #202124, with deuteranopia and grayscale simulations.

What changed and why:
1. Stronger outline. The swept lower-right corner now has radius 64, centred at (48,48), against 24 on the other corners. At 16px the corner is now missing about 3.3px along the diagonal, against about 1.2px for the other corners, so the outline is clearly not a plain rounded square on any toolbar. Radius 72 was tested and rejected because it crowded the second line.
2. The swept corner now explains itself. The amber fragment's right end is cut by an arc with the same centre as the sweep (radius 54, which leaves an even 10-unit band). The line being removed now visibly follows the corner that is already gone, so the corner reads as "scrubbed" and not as a decorative leaf or bubble corner. The amber is also a different shape (rounded left end, swept right end), so colour-blind viewers and the one-colour version keep the meaning without relying on hue. The brand sheet includes a construction panel showing the 8-unit grid, a ghost of the removed corner, and both arcs.
3. Contrast for colour-blind and grayscale viewing. The amber is now #ffc23d: 2.2:1 against the tile and 1.6:1 against white. This sits between the two on purpose, so it stays separate from both in grayscale. Ink on it is 10.5:1.
4. Toolbar contrast. The mark green is now #179c72. It reaches at least 3:1 on all four toolbars (3.48 on #fff, 3.13 on #f1f3f4, 3.17 on #3c3c3c, 4.63 on #202124). The old green was 2.41:1 on the Chrome dark toolbar. White bars on it are 3.5:1, which meets the 3:1 rule for graphics.
5. Crispness. Bar corner radius dropped from 6 to 4, so the end columns render as solid white at 16px (rx 6 left them mint-tinted). The swept end, the card outline and the bar silhouettes still keep it from reading as a credit card at large sizes. Every straight edge sits on the 8-unit grid, so it lands on whole pixels at 16, 32 and 48px. The one edge that was soft at 24px (the kept fragment) is fixed by a 24px hint master, mark-24.svg, used only for icon24.png (Chrome accepts a 24 key in action.default_icon).
6. Wordmark. "Postscrub" is outlined from Inter Display (SIL OFL): "Post" in Medium and ink, "scrub" in Bold and brand green. Its cap height spans y32 to y80, exactly the mark's two lines. Because it is outlined, it renders the same everywhere and needs no font. A reverse file (#f7f7f6 and #4cc79a) and a one-colour green file come with it, and nothing relies on an in-SVG media query.
7. Ideas taken from the runners-up: from Scrub Stroke, the two-tone two-weight wordmark and a proper light/dark token pair; from Spark P, outline discipline and balanced toolbar contrast. No sparkle was used anywhere, so there is no "AI" reading. Nothing came from Gleam Bubble.

Constraints still met: there is no platform shape, bird, trash can or mascot. The mark uses 2 colours plus white with no gradients or text. The artwork sits inside 16..112 on viewBox 0 0 128 128; the rendered bounding boxes match exactly (icon128 is 16..112).

16px self-check: a solid 12x12px green card with a clearly rounder lower-right corner, a sharp 8x2px white top bar, one clear row, then a sharp 3px white fragment, a 1px gap and an amber fragment with a slightly soft swept right pixel. It reads on all four toolbars. Amber and white separate by hue and by luminance. Honest limit: at 16px it reads as "a card with a highlighted line"; the "being swept away" idea becomes explicit from 32px up.

## Usage

Other files, besides the ones listed in files:
- 24px hint master: ./mark-24.svg, rendered to icons/icon24.png
- One-colour marks: ./mark-mono-ink.svg and ./mark-mono-white.svg
- Wordmarks: ./wordmark-reverse.svg (dark backgrounds) and ./wordmark-green.svg (unknown or photographic backgrounds)
- Palette: ./palette.css
- Brand sheet HTML source: icons/brand-sheet.html
- Generators (edit the geometry in build.py, never by hand): ./tools/build.py, outline.py, brandsheet.mjs and compare.mjs. outline.py needs fontTools and uharfbuzz, which are installed in the scratchpad's pylib/ folder.
- Iterations: ./iter/

Manifest:
- "icons": {"16": icon16.png, "32": icon32.png, "48": icon48.png, "128": icon128.png}
- "action": {"default_icon": {"16": icon16.png, "24": icon24.png, "32": icon32.png}}
- Use icon24.png only at 24px. It comes from the hint master. Every other size uses mark.svg.
- The PNGs keep the transparent 16/128 padding, as the Chrome Web Store asks. Do not crop them.
- For the store's 440x280 promo tile, use wordmark.svg on #f7f7f6, or wordmark-reverse.svg on #121614.

Mark rules:
- Clear space is at least the 16-unit canvas padding, which is 1/8 of the mark's size.
- Minimum size is 16px.
- Never recolour the tile, add effects or outlines, rotate it, or mirror it. The sweep always sits lower-right.
- Use mark-mono-ink.svg or mark-mono-white.svg where only one colour is allowed. The swept end of the second fragment still marks what is selected for removal.
- On a background that is close to #179c72, use the mono white mark rather than the colour mark.

Wordmark rules:
- The text is outlined, so no font is needed.
- Use wordmark.svg on light surfaces (#f7f7f6, #ffffff) and wordmark-reverse.svg on dark surfaces (#121614, #1a1f1d, #202124). Keep the split as is: "Post" Medium, "scrub" Bold.
- In running text, write the name as "Postscrub" (capital P, one word).
- Tagline: "Scrub your social history."

UI colour roles. They make the icon's story match what the user sees:
- Green (--ps-primary) is for kept items, primary actions and focus.
- Amber (--ps-select) means "selected for removal". Use it for the row highlight (--ps-select-soft background plus a --ps-select-strong left edge), the checkbox fill and the selection-count chip (ink text on amber).
  - Amber is a fill only. Never use it for text, outlines or the only focus cue on light surfaces (1.6:1 on white).
  - Pair amber with a shape or icon cue too (a checkmark, a bold count), never colour alone.
- Red (--ps-danger) is only for the final destructive confirmation ("Delete 240 posts"), never for selection. That keeps amber calm and red rare.
- Light-theme buttons: white text on --ps-primary (5.3:1).
- Dark-theme buttons: --ps-on-primary (#0b1f18) on #4cc79a (8.1:1).
- --ps-brand (#179c72) is for the mark and large graphics. It is 3.5:1 on white, so it is fine for large display text but not for body text.
- The existing UI tokens map as: ink #1d1d1b and surface #f7f7f6 unchanged; green #16854a becomes --ps-primary #0f7a5e; red #c73d37 is unchanged as --ps-danger; blue #2878c8 becomes --ps-info #1f6fbf (#2878c8 was 4.25:1 on the surface, below AA).
- Theme switching: the CSS follows prefers-color-scheme, and data-theme="light" or data-theme="dark" on :root overrides it.

Font licence: the wordmark outlines come from Inter Display, under the SIL Open Font License, which allows using outlines in a logo.

Known limitation: sheet.png comes from the shared render tool, which shows only one wordmark (wordmark.svg, ink plus green). On its dark row, "Post" is therefore nearly invisible by design. brand-sheet.png shows the correct wordmark-reverse.svg on dark.

Still to do: the relayed user request to clone fcfim/postscrub was not done in this step.
