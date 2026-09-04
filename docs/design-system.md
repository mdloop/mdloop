# mdloop design system

Phase 4 visual system, retuned by the "Reading Room" pass (CONSTITUTION/PLAN
gate: documented here, tokens live in `packages/web/src/styles.css`).
Direction: track-and-relay vernacular — mdloop is the handoff between people
and agents. The app chrome is a warm **desk**; the document viewer is a
bright serif **sheet** raised one step off it — reading a document should
feel different from operating the app around it. Ink text, lane rules, one
blue action accent, amber attention signals carry through unchanged. One
reward moment marks a relay leg finished: a green finish sweep across a
thread the instant it resolves.

## Color tokens

| Token            | Value (light) | Role                                                |
| ---------------- | ------------- | --------------------------------------------------- |
| `--chalk`        | `#eceae3`     | The desk — app ground                               |
| `--chalk-raised` | `#fbfaf7`     | The sheet, cards, rows, inputs (inputs — see Forms) |
| `--ink`          | `#23211b`     | Primary text                                        |
| `--ink-soft`     | `#6b675d`     | Secondary text, metadata                            |
| `--lane`         | `#dcd9d0`     | Hairline rules, borders                             |
| `--lane-strong`  | `#c9c5b9`     | Interactive borders, default rail                   |
| `--mdloop`       | `#2456e6`     | The single action accent: buttons, focus, active    |
| `--signal`       | `#a04d08`     | Open-comment attention (amber, never red)           |
| `--resolved`     | `#15803d`     | Resolved state, the finish sweep                    |
| `--danger`       | `#b91c1c`     | Destructive actions only                            |

Dark theme keeps the same desk/sheet relationship — a warm charcoal ground
(`--chalk: #171614`) with the sheet one brightness step above it
(`--chalk-raised: #201f1b`), not a blue-black. Rules: one accent per surface.
Amber is reserved for "a human should look at this"; red only for
destruction. Project colors come from the fixed `PROJECT_COLORS` palette
(`project-form.tsx`) so they always read on the desk.

These same tokens carry outside the app bundle too: the WorkOS-hosted AuthKit
sign-in page (Phase 38.A) is branded from this exact table via the dashboard's
branding editor, not a copy invented separately — see
`docs/authkit-branding.md` for the field-by-field mapping and
`docs/authkit/authkit.css` for the supplemental CSS. AuthKit's layout stays
WorkOS's; only color, type, logo, and copy move.

## Typography

| Role      | Face                            | Usage                                           |
| --------- | ------------------------------- | ----------------------------------------------- |
| Display   | Archivo 700/800                 | Brand, lane titles, empty-state headings        |
| Body      | System stack                    | Prose, controls                                 |
| Doc prose | Charter system serif, 17px/1.75 | Document body + headings, on the sheet only     |
| Utility   | IBM Plex Mono / ui-monospace    | Filenames, counts, timestamps, section eyebrows |

Documents are files; anything that names or counts them is mono. Display face
appears only at shell level (brand, current lane) — never inside rows. Doc
prose (`--font-doc`, a zero-webfont serif stack) is scoped to
`.viewer-content` — it never leaks into app chrome, which stays sans
throughout.

## Signature: the sheet + the handoff finish sweep + legs

The document viewer's content sits on a raised sheet (`.viewer-content`):
`--chalk-raised` background, 1px `--lane` border, 10px radius, a soft double
shadow lifting it off the desk. Serif reading type at 17px/1.75 replaces the
sans body face inside it; the opening `h1` reads as a title block without a
rule beneath it — the sheet's own edge frames the document now. In Bubbles
mode, margin-note threads lose their card entirely (no border, no fill) and
read as annotations in the margin, colored only by the same open/resolved/
selected rail states list mode uses.

Resolving a thread — from the card, the `e` keyboard shortcut, or triage —
plays a single **finish sweep**: a soft green highlight sweeps once across
the card before it leaves the open list. It is the one reward moment in the
system; everything else stays quiet and functional.

Version chips read **"v3"**, not "Version 3", everywhere a version number is
user-facing (version strip, diff headers, triage banners, viewing-state
labels, tooltips). API fields and ids are unaffected — this is a display
rename only.

(Decided 2026-08-04, label finalized 2026-08-05: previously named **legs**,
echoing the relay metaphor end to end — retired because it tied the UI's vocabulary to a specific
product identity that was still unsettled at the time; "Leg n" reads as unexplained slang once that
metaphor no longer holds. An intermediate
"Version n" spelling was considered and rejected as too wide for the
version-strip's repeated chip UI — "v3" wins on both compactness and
familiarity, matching git/semver tag conventions. Implemented 2026-08-05 in
`viewer.tsx`, `version-strip.tsx`, `diff-view.tsx`, `triage-panel.tsx`,
`error-boundary.tsx`, `api/client.ts` comments, and their tests.)

Every document row still carries a 3px left rail in its project color
(`border-left` on `.doc-row`); unfiled rows show the neutral rail. Sidebar
lanes echo the color as a 10px chip. The login screen's faint vertical lane
markings are the only decorative use of the motif outside the sheet and the
sweep.

## Signals

Comment rollups render as mono chips: `N open` (amber wash) when open
comments exist, `✓ resolved` (green, no wash) when all are resolved, nothing
when a document has no comments. Project lanes in the sidebar sum open counts
into an amber pill.

Comment filter chips (Open/Mine/Orphans/Resolved) are a toggleable button
group — `role="group"`, `aria-pressed` per chip, one or none active — and
live on the comment surface itself, not the app chrome above it:
the sticky first row of the rail in List mode, a slim right-aligned toolbar
above the bubbles row in Bubbles mode.

The minimap is the single overview signal for a document's comments: per-
thread ticks (open/replied/resolved/orphan, fraction-of-source position,
clickable) with a comment-density layer folded in behind them — one
background segment per outline section, opacity scaled by open-comment
count, dimmed as a group so the ticks stay dominant. Same convention in both
List and Bubbles mode.

## Layout

232px fixed sidebar (lanes: All / Unfiled / projects / Archived), topbar
ordered brand → page title/controls (incl. a labeled Upload button on home)
→ search → identity menu + theme toggle. The identity menu (avatar
trigger, `.thread-avatar`-style disc when there's a name to initial, a
generic mark otherwise) replaces the old bare role string + Sign out
button — it holds the non-interactive role line, an admin-only Settings
item (Phase 39.A — was two separate Org settings/Billing items), and
Sign out. The whole content column is the drop target
(dashed overlay on dragover), not a permanent dropzone
block. The document viewer follows the same rule: the whole `.viewer-body`
is a drop target for shipping a new leg, and a drop routes through the same
confirm-with-note dialog as the file picker and paste paths rather than
uploading instantly. Document rows flow into a second column when the viewport fits two
≥420px tracks (`.doc-list` auto-fill grid, `.content-inner` capped at
1160px); group headers span the full width, and narrow viewports fall back
to the single manifest column. Row
actions fold into a single ⋯ (kebab) button that reveals on hover/focus-within
(always visible on coarse pointers) and opens a menu — Archive/Delete, plus
a "Move to" section listing Unfiled and each project (current location
marked, non-clickable); the archived view trims this to Restore/Delete
only. The whole row still opens the document; the row checkbox and the
select-all head row (shown only once a selection is active) are unchanged.
Bulk bar floats fixed at the bottom, never reflowing the list. The All lane
groups loaded documents by project (`.doc-group-header`: lane chip + name +
mono count), ordered by each group's most recent activity — Unfiled/project
lanes stay flat. Single column under 720px; the sidebar becomes an off-canvas
lane drawer (Phase 39.F) rather than disappearing — opened from a header
trigger (`.app-header-lane-trigger`, CSS-hidden at ≥720px), backdrop-
dismissible, closes on Escape or on selecting a lane. See "Responsive" below.

In the viewer, Share is a popover anchored to its own trigger in the
document header's right cluster — not a rail-top render in List mode and a
separate fixed floating card in Bubbles mode. One location, same
`doc-switcher-menu`/search-results footprint (absolute, right-aligned below
the button, chalk-raised, lane border, shadow), in both modes.

## Forms

Every `<input>`/`<select>`/`<textarea>` gets a correct default look from a zero-specificity
`:where()` rule in `styles.css` (Phase 39/40 field normalization) — no class required: 13px type,
`7px var(--space-2)` padding, `1px solid var(--lane-strong)` border, `var(--radius)`,
`--chalk-raised` background (see the color-token table above).

| Piece              | Rule                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default field      | `:where(input, select, textarea)` (minus checkbox/radio/file/etc.) — element default, not a class. A new field needs no markup to look right.                             |
| `.field--compact`  | 5px vertical padding instead of 7px. Rail rows, inline filter selects, reply boxes — anywhere a field sits in a dense row rather than a form block.                       |
| Horizontal padding | Tokenized (`--space-2`).                                                                                                                                                  |
| Vertical padding   | A literal pixel value (7px default, 5px compact), not a token — the vertical rhythm a field wants doesn't land cleanly on the 4/8/12/16/20 `--space-*` scale.             |
| Excluded           | Checkboxes/radios keep native chrome + `accent-color` (see `.doc-check`); file inputs are always a `hidden` element behind a `.btn` trigger. Neither gets the sheet look. |

Three recorded deviations, not oversights:

- `.topbar-search` (and `.admin-org-search`) uses `--chalk`, not `--chalk-raised` — it's header
  chrome sitting on the desk, not a sheet/card raised off it.
- Selects keep native `appearance` — no hand-drawn caret. Every other property matches the default
  field.
- Fields don't yet meet the Responsive section's `pointer: coarse` ≥44px target below — a known
  follow-up, not fixed in this pass.

## Responsive

A system rule (Phase 39.F), not tribal knowledge picked up file by file — every screen in the app is
expected to hold to this contract, and the settings/admin rail (Phase 39.A) and Shell's lane sidebar
(Phase 39.F) both implement it identically:

| Width                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥1080px                          | Full layout: sidebar/rail + content together, tables render every column, meters inline.                                                                                                                                                                                                                                                                                                                            |
| 900–1079px                       | Same layout; a `DataTable` sheds its lowest-value columns (the `shed` column flag) rather than compressing everything to fit.                                                                                                                                                                                                                                                                                       |
| 720–899px (iPad portrait ≈768px) | Sidebar/rail still shown — a tablet has room for it. Content itself goes single-column.                                                                                                                                                                                                                                                                                                                             |
| <720px                           | Single column throughout. The sidebar/rail is no longer a permanent element: Shell's lane nav becomes an off-canvas drawer (backdrop-dismissible slide-in, opened from a header trigger); the settings/admin rail becomes a drill-down (a section index, tap a section, back to the index) — chosen over a drawer there because it preserves the rail's group headings, which a horizontal tab strip would flatten. |

Two rules that apply to every full-height overlay panel in the app, present or future (the mobile
lane drawer, the comment rail's bottom sheet, the settings rail's drill-down):

- **Use `dvh`, never bare `vh`, for a panel's height.** Mobile Safari's dynamic toolbar makes `vh`
  lie about how much vertical space is actually available — `60dvh` on the comment rail's bottom
  sheet is the reference implementation (`styles.css`).
- **`@media (pointer: coarse)` keeps hover-revealed controls visible and every touch target ≥44px.**
  A control whose only affordance is a `:hover` reveal (row kebab menus, etc.) is invisible on touch;
  this query is how the app already handles that everywhere it applies, and any new hover-revealed
  control must follow the same rule rather than reinventing a one-off fix.

## Interaction

- Focus: 2px `--mdloop` outline, visible on every interactive element.
- Motion: 120ms border/background transitions only; `prefers-reduced-motion`
  collapses all animation.
- Destructive delete asks for confirmation and names the retention window.
- Errors are `role="alert"` banners that say what failed per file.
