# AuthKit branding

Status: repo side ready 2026-08-11 (Phase 38.A); dashboard application is a manual step only a human with
WorkOS Dashboard access can do — the same "code ships, dashboard step is a fast-follow" shape as
ADR 0013's MCP OAuth protected-resource path (`docs/adr/0013-mcp-oauth-protected-resource.md`),
which is likewise code-complete but inert until a deployment does its own manual dashboard step.

## Why this file exists

CONSTITUTION.md §2 pins auth to WorkOS AuthKit hosted — decided over building our own login UI (see
`docs/adr/` for the ones that _did_ need a deviation; this one didn't). Investigation for Phase 38 found
WorkOS offers exactly two modes: the hosted page, or headless APIs where you build everything. Hosted wins
here (least auth code to own, and passkeys/MFA/social stay dashboard toggles instead of builds), but
"hosted" doesn't have to mean "looks like WorkOS." AuthKit's branding editor covers logo, favicon, four
colors in light and dark, corner radius, font, layout, copy, legal links, and custom CSS — this document is
the version-controlled record of exactly what to enter, since **the dashboard itself has no history and no
diff**. Without this file, the values live only in one person's memory of what they clicked.

## Where to apply this

WorkOS Dashboard → your AuthKit environment → **Branding**. (Staging always uses the WorkOS domain
regardless of these settings — production only, per WorkOS's own docs.)

## Values

Every value below is taken directly from `packages/web/src/styles.css`'s `:root` and dark-mode blocks — see
`docs/design-system.md`'s color table for the same tokens with their app-side roles. Nothing here is
invented for AuthKit specifically.

| Dashboard field   | Light                   | Dark      | Source token                          |
| ----------------- | ----------------------- | --------- | ------------------------------------- |
| Page background   | `#eceae3`               | `#171614` | `--chalk`                             |
| Button background | `#2456e6`               | `#6690ff` | `--mdloop`                            |
| Button text       | `#ffffff`               | `#0c1220` | `--on-mdloop`                         |
| Link              | `#1a41b3`               | `#a9c1ff` | `--mdloop-ink`                        |
| Corner radius     | `6px`                   | `6px`     | `--radius`                            |
| Font              | Archivo                 | Archivo   | `--font-display`                      |
| Layout            | Centered, single column | (same)    | matches `.login-card` in `styles.css` |

Archivo is already loaded for the app itself via the Google Fonts `<link>` in `packages/web/index.html`,
and AuthKit's font field draws from the same Google Fonts catalog, so this is a direct match, not an
approximation.

**Logo**: `docs/authkit/logo-light.svg` for the light slot, `docs/authkit/logo-dark.svg` for the dark slot
(if the dashboard offers two; if only one, use whichever reads correctly against `#eceae3`/`#171614` — the
mark's own colors are already resolved per-theme in each file, unlike `components/mdloop-mark.tsx`'s
`var(--mdloop)`/`var(--ink)`, which only resolve inside our own app's CSS). Both are the same wordless
logomark used as the app favicon — WorkOS's "logo" slot in the branding editor sits above the sign-in form
without app chrome around it, so there's no room for the "mdloop" wordmark the way the in-app `.login-card`
`<h1>` pairs `<MdloopMark>` with text; the mark alone is the right asset here.

**Favicon**: `packages/web/public/favicon.svg` — already exists, already the resolved-color version of the
same mark, reused as-is. If the dashboard's favicon uploader rejects SVG (some older uploaders want raster),
export a 512×512 PNG from it in any vector tool using the same two colors (`#2456e6`, `#23211b`) — do
not regenerate the mark from scratch.

**Custom CSS**: paste `docs/authkit/authkit.css` into the Custom CSS field. Its own header comment explains
scope and the two documented selector hooks (`data-hak-page`, `data-method`) versus the parts that need
verifying against the live preview, since WorkOS doesn't publish a full class-name contract.

**Copy** (page title / sign-in link text — exact field labels vary by dashboard version):

- Sign-in page title: "Sign in to mdloop"
- Tagline / subtitle, if a field exists for one: "Publish. Review. Revise. Repeat." — same line as
  `packages/web/src/components/login-screen.tsx`'s `.login-tagline`.
- "Last used" sign-in badge: leave enabled — matches the app's general house style of surfacing helpful
  state rather than hiding it.

**Legal links**: point at the website's terms/privacy pages once they exist (`website/` — Phase 32, ADR
0012). Until then, leave unset rather than pointing at a placeholder URL.

## What deliberately isn't set

**Custom domain (`auth.<domain>`) is not part of this pass.** It is a **$99/mo** WorkOS add-on
(`workos.com/pricing`, confirmed 2026-08-11) and covers two things together: the AuthKit page's URL, and
the domain the Magic Auth code/link emails send from. Both are blocked on the same prerequisite — the
`mdloop.md` registrar purchase, still open (see the "Open threads" section of `CLAUDE.md`). Until that
lands:

- The AuthKit page itself is fully branded per this document, but its URL stays `api.workos.com/...`.
- The email carrying the sign-in code is still sent from a WorkOS address, not ours.

State this plainly to anyone asking why the URL bar doesn't say mdloop — it's a known, tracked gap, not an
oversight. Once the domain exists: add the DNS records WorkOS's custom-domain setup asks for, flip the
custom domain on in the dashboard, account for its $99/mo cost, and update this
file's status line.

## Verifying the result

After entering the values above:

1. Open the real sign-in flow (`/api/auth/login` from a logged-out session) in both light and dark —
   `packages/web`'s `ThemeToggle` controls which one your browser is in when you click through.
2. Our dark palette is warm-neutral (`--chalk` dark is `#171614`, not a cool blue-black). If AuthKit's own
   dark-mode rendering assumes a cooler ground and `--mdloop` at `#6690ff` reads oddly against it, adjust
   the dark button/link values in the dashboard and record the deviation — and the reason — in this file's
   table above, so the next person doesn't "fix" it back to a value that was already tried and rejected.
3. Screenshot both states and drop them in this doc (below) so future drift is visible without having to
   re-run the whole flow to check.

<!-- Screenshots go here once captured against the live dashboard. -->

## Keeping this file honest

If a dashboard value or CSS selector is changed ad hoc (a hotfix at go-live, a WorkOS UI change that broke
a selector), update this file and `docs/authkit/authkit.css` in the same sitting — this doc is the
CLAUDE.md-mandated "docs that travel with changes" entry for AuthKit branding specifically. A value that's
right in the dashboard but wrong here is worse than not having this file at all, since it will be trusted.
