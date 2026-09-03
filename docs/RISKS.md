# Risks

Known ways this project can hurt someone — an operator, a contributor, or the maintainers. Kept
next to `docs/STATUS.md` (what exists) because a risk register that is not maintained alongside the
status doc becomes a list of things that were once frightening.

Rules for this file: every entry states the risk, why it is real rather than theoretical, and what
would close it. An entry gets deleted when it is closed, not marked "done" — `git log` is the
history. If a risk is accepted rather than closed, say so and say who benefits from the trade.

Last reviewed: 2026-09-01.

## Severe — a failure here is not recoverable by the operator

**A gate that measures nothing looks exactly like a gate that passes.** This is the failure mode
this project keeps hitting, and it deserves top billing because every instance of it was invisible
until someone went looking.

- Proven, twice, in one audit: `ci.yml` used `github.event.pull_request.commits + 1`, and the
  GitHub Actions expression language has no arithmetic operators, so the workflow never parsed and
  **no CI job in this repository had ever run** — every run presenting as a red X with zero jobs,
  zero duration and no log. Simultaneously, six dependency-cruiser rules and four coverage floors
  had been deleted elsewhere on the written grounds that "chevronly enforces it in its own CI." It
  did not.
- Closes with: treating a green check as unverified until you have seen it fail. Probe a boundary
  rule by introducing a violation. Check `gh run view <id> --json jobs` is non-empty. A glob that
  matches zero files must be deleted with a comment, never left dangling.
- **Status: open, permanently.** This is a practice, not a task.

**Tenant isolation is the product's worst-case failure** (CONSTITUTION Core Principle 1). It is
enforced in depth — RLS on every tenant table, composite `(id, org_id)` FKs because FK checks bypass
RLS, `withTenant()` as the only query path, a non-superuser `NOBYPASSRLS` login role asserted at
boot, and use-case guards on top — and proven by `features/tenant-isolation.feature` against a real
Postgres, never a mock. The residual risk is that a contributor adds a query path that bypasses
`withTenant`, or a plain FK where a composite one belongs. Closes with: keeping the isolation
feature test mandatory on every change touching data access (§8.3), and reviewing new repository
methods for the context argument specifically.

## High

**Anyone pinning a commit inherits its guarantees, good or bad.** Merging red silently degrades
every deployment built on that commit, and nobody finds out until they update. Closes with: never
merging red, and treating `main`'s gates as a promise made to whoever pins a commit next.

**Exported symbols are public API and it is easy to forget.** `ServerDeps`, `ServerExtension`,
`ExtensionContext`, the port interfaces and `createTestServer`'s signature are all consumed by
anyone self-hosting or integrating this repo. A "local refactor" of an export is a breaking change.
Closes with: saying "breaking" in the commit message and treating `ServerExtension` changes as
contract changes. Riskier once this repo is public and its integrators are strangers.

**Residue from a removed feature ships in the public core.** `0027_operator_admin.sql` creates
`operators` and `operator_audit_log` — a cross-org staff console a self-hoster can never use — and
`0028`/`0029` add an index and grants for the same feature. Accepted rather than closed: migrations
are never renumbered, and the cost of a second migration stream (a filename-prefix convention,
`schema_migrations` reconciliation for the already-applied `0027`, a second migrate entrypoint)
exceeds the cost of two inert tables. `migrate(pool, dir)` already takes a directory, so the door
is open if this kind of residue ever grows beyond two tables. Revisit if that happens, not before.

**Four packages carry no coverage floor** — `web`, `cli`, `jobs`, `shared`. Not a claim they are
untested; a claim nobody has settled what "enough" means for a React SPA, a thin CLI or process
wiring. The risk is that an unfloored package is where regressions accumulate unnoticed. Closes
with: picking a number per package from measured actuals, the same way the others were set.

## Closed, kept as a record

Against this file's own rule (an entry gets deleted when it's closed): this one is worth keeping
because it's the "Severe" section's own thesis in miniature — a gate that had never run once
(`ci.yml`'s `fetch-depth` bug) started running, and the very first real run caught something a
laptop never would have.

**Twelve e2e tests failed in CI at phone and tablet viewports.** First visible 2026-08-28, when CI
ran for the first time: `e2e` reported 35 passed, 12 failed, and every failure was on the `[phone]`
or `[tablet]` Playwright project — desktop was green. Spread across `homepage`, `org-settings`,
`public-hub` and `viewer` specs, which pointed at one shared cause rather than twelve bugs.
Root-caused and fixed in `34c7e17`: shared Playwright fixtures were colliding across the
desktop/phone/tablet projects, which all exercised the same Postgres-backed org concurrently. Made
the responsive projects idempotent; verified 47/47 green, twice in a row with no reset.

## Moderate

**Trademark and naming were unresolved under the prior identifier, and partially addressed by the
move to `vorlyn` (2026-08-31).** Apache-2.0 was chosen partly for its explicit trademark
non-grant, which only helps if the mark is defensible. The project's first two identifiers ran
into exactly this problem:

- **`chevron` was an existing package on npm** <!-- brand-check:allow --> — an unrelated
  mustache-template CLI, v0.2.0. This was not hypothetical harm: `SELF_HOSTING.md` and `README.md`
  both opened with `npx chevron open ./my-project` <!-- brand-check:allow --> as the _first command
  a new user runs_, which would have fetched
  and executed that stranger's package. Both were fixed to build from source (2026-08-28), and
  nothing here was ever published — every package is `private: true`. <!-- brand-check:allow -->
- **"Chevron" is one of the largest corporate trademarks in existence.** <!-- brand-check:allow -->
  No USPTO TESS clearance
  search was ever done on it. The name had already moved once before landing there: an earlier
  candidate name ("diple") was checked against USPTO TESS and found live and actively maintained
  under an existing registration (Reg #6115493, Class 009), forcing the move to `chevron` <!-- brand-check:allow -->
  (technical identifier) / "Chevronly" (display name) before anything was ever published under the
  earlier name. <!-- brand-check:allow -->

**The move to `vorlyn`** closes the npm collision outright — `vorlyn` was free on the npm registry
at rename time — and an informal screen (npm, a web search for existing companies/apps/trademarks
under the name, and a domain-availability check) found no company, product, or registered mark
using it anywhere. That is _not_ the formal clearance this risk has always called for — it's the
same table-stakes check that would have caught the `chevron`/npm collision <!-- brand-check:allow -->,
just run before
publication this time instead of after. `vorlyn.com` is registered by an unrelated third party but
serves no live site (parked or inactive); `.dev`/`.io`/`.ai` are open. The earlier survivable-proof
lesson stands either way: catching a bad name has to happen before a public release, not after.

**The formal USPTO TESS/TMsearch pass (2026-09-01) found one live hit, exact match:** serial
99708139, standard-character word mark "VORLYN", filed 2026-03-17 by Nanjing Yongqing Electronic
Technology Co., Ltd. (China), published for opposition 2026-09-01. Class 007 only (vacuum cleaners
and parts — hoses, filters, bags, brushes, steam mops); no hit in Class 009 (software) or Class 042
(SaaS/computer services). Trademark rights are scoped to the registered class, and the same word
routinely coexists across unrelated classes with no likelihood-of-confusion problem (the standard
example: Delta airlines vs. Delta faucets) — on its face this shouldn't block software use of the
name. An attorney read was considered and deliberately declined (2026-09-01): the different-class
reasoning here isn't a close call requiring legal judgment — vacuum-cleaner parts and B2B
collaboration software share no goods, channels, or customers, which is the textbook case the
classification system exists for, not an edge case. The residual risk this doesn't cover
(common-law/unregistered use outside the federal registry) existed identically before this hit
surfaced and isn't specific to it.

Closes with: a formal USPTO clearance search (done, see above), then the registrar purchase, then
publication — in that order. Publishing first inverts the cost of every one of those steps.

**Update 2026-09-03: the sequencing above was inverted, deliberately.** `vorlyn` published to npm
as `0.1.0-beta.0` (see `packages/vorlyn/`) before the registrar purchase, not after. The beta is
disposable, `homepage` points at the GitHub repo (real, live) rather than a domain that doesn't
exist yet, and delaying the beta further buys no additional trademark safety beyond what the
formal clearance search above already covers. One real consequence: the npm namespace is now a
third public surface (alongside the GitHub repo and the domain-availability check) where `vorlyn`
is claimed and discoverable — doesn't change the clearance analysis, but raises the cost of ever
needing a name change, since more surfaces would have to move together.

**A near-identical competitor exists.** `markloop.io` is a live paid SaaS with substantially the
same loop: an agent uploads a document, humans review it, the agent reads feedback back over MCP.
Being open-source is a differentiator, not a moat. Relevant to positioning rather than to code;
noted here so it is not rediscovered as a surprise.

**Self-hosting was documented but unrehearsed, and a real fresh-clone-through-boot pass on
2026-08-30 found three genuine defects in the documented paths, all now fixed:**

- On 2026-08-30, one day before the `vorlyn` rename, `SELF_HOSTING.md` and `README.md` both opened
  with `npx chevron open ./my-project` <!-- brand-check:allow --> as the first command a new user
  would run. `chevron` is an existing, unrelated package on npm (a mustache-template CLI); <!-- brand-check:allow -->
  the command would have fetched and executed a stranger's code. Nothing here is
  published — every package is `private: true` — so the docs now build from source instead.
- The zero-install path (`vorlyn open`) crashed with `No built web SPA at .../packages/web/dist`
  because the documented build command, `pnpm typecheck`, only emits `.d.ts` files for
  `@vorlyn/web` (its `tsconfig.json` sets `emitDeclarationOnly`) — the actual bundle needs
  `vite build`, which only `pnpm build` (the root script) runs. The thrown error was already
  excellent and actionable; the docs telling the user to run the insufficient command were the bug.
- The real-instance path (`packages/api/src/selfhost-main.ts`) failed at boot with
  `VORLYN_BLOBS_BUCKET must be set under NODE_ENV=production`, because `.env.selfhost.example`
  sets `NODE_ENV=production` (correctly — it also controls `secureCookies`) with no bucket
  configured, and `storageFromEnv`'s production guard could not distinguish "forgot to configure
  storage" (a real misconfiguration in any real deployment) from "deliberately chose local disk with
  a persistent volume" (the legitimate self-hosted case). Fixed with an explicit
  `VORLYN_ALLOW_LOCAL_BLOB_STORAGE=true` opt-in rather than by weakening the guard or telling
  self-hosters to unset `NODE_ENV=production`, which would have silently disabled the `Secure`
  cookie flag — trading one bug for a worse one.

Both self-hosting paths (`vorlyn open` against an embedded PGlite instance, and
`selfhost-main.ts` against a real Postgres with `single-user` auth) were run to a genuine
`{"status":"ready"}` and a real SPA response, not just read. `pnpm verify` was green throughout;
none of the three defects were things any existing test could have caught, because none of them
were about code correctness — they were about whether the path a new user actually follows works.

**The Claude Code plugin never registered its own MCP server, found the same way — a real manual
test, not code review.** Installing `vorlyn-sync` and linking a repo started the local server and
linked the folder correctly, but the coding agent still had to work out the CLI/MCP wiring itself:
nothing in the plugin ever told Claude Code's own MCP client an endpoint existed, despite
`vorlyn-review`'s skill and `claude-plugin/README.md` both describing the read half as available
with "nothing else to do." Root cause: `hooks/vorlyn-ensure.sh` ensured the _server_ was running,
never that Claude Code _knew about it_, and a static plugin-declared MCP server (`.mcp.json`/
`mcpServers` in the plugin manifest) genuinely cannot carry a working bearer token — the token is
minted at first local boot, not at plugin-authoring time, and no Claude Code plugin config
mechanism pulls a dynamically discovered value at connect time. A safe, token-free alternative was
considered — trusting any loopback connection with no auth — and rejected: `vorlyn serve` binds one
fixed port pair machine-wide, so a real risk is a second OS user on a shared box (devbox, CI
runner) reaching another user's running instance with no proof of authorization at all; today's
`.vorlyn/credentials` file mode (`0600`) is the thing actually preventing that. Fixed by having the
hook run `claude mcp add` itself (`--scope local`, so the token lands in `~/.claude.json`, never a
committed `.mcp.json`), gated behind a cheap existence check so every session after the first repo
link costs nothing — the admin key is durable and never rotates, so one successful registration
stays valid indefinitely with no further hook involvement. Deliberately local-only: a remote/team
deployment's MCP URL isn't derivable from `.vorlyn/manifest.json` (its `endpoint` is the API base;
`SELF_HOSTING.md` is explicit that MCP is a second, separate process that can sit on a different
host/port entirely), so that path still ends in one manual `claude mcp add`, same as before.

**MCP OAuth ships inert.** ADR 0013's protected-resource path is code-complete but does nothing
until a deployment registers a Resource Indicator with its identity provider. The risk is a
maintainer reading the code and believing it is exercised. API keys are the working path.

## Low, but worth stating

**No cross-instance connection pooling.** `instances × DB_POOL_MAX` does not hold past a handful of
replicas; a transaction-mode pooler belongs in front for real horizontal scale-out. Low here
because it is an operator's decision on an operator's infrastructure, and `docs/STATUS.md` says so.

**`BlobUrlPort` is dead code end to end, and CONSTITUTION §4 currently overstates what's live.**
Two adapters, no production caller — the API proxies blob bytes directly, both directions,
rather than via the "short-lived signed URLs" §4 names as the storage security posture. Not a
believed-safe gap: proxying through the API is not less secure (the bucket still isn't public,
access still goes through the same auth/RLS-gated route), so this is a docs-vs-code mismatch to
close, not an open vulnerability. Closes with either wiring `BlobUrlPort` into a real caller, or
correcting §4's wording via ADR (§8.5) to describe the proxy path instead.

**Test flakiness is usually environmental.** Integration tests create an ephemeral database per run
and leak some on failure; at high machine load, unrelated files start failing. Check `uptime` and
count leftover `vorlyn_test_%` databases before investigating a scattered failure as a real
regression.
