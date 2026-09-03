---
name: vorlyn-review
description: Use when a human has left feedback on a document in Vorlyn and it needs acting on — pulling the comments, applying suggested edits, uploading the revision, replying, resolving threads, and handling sign-off. Use this whenever the user mentions Vorlyn feedback, comments, reviewers, suggestions, or approval — including "what did the reviewer say", "address the comments on the spec", "did that get signed off", "someone reviewed the PRD", "check Vorlyn", or a bare document id after a review — even if they never say the word "review". Works over the Vorlyn MCP tools alone; no repo, CLI, or local files required.
---

# Acting on Vorlyn feedback

## Overview

Vorlyn is where humans read, comment on, and sign off the artifacts an agent writes. This skill covers the
**read half** of that loop: a document is already in Vorlyn, a human has been through it, and now the
feedback has to turn into an actual revision.

The loop, in the order that keeps it honest:

1. **Read** what was said — `get_feedback_bundle`
2. **Act** on each item — edit the source, and for suggested edits `accept_suggestion` / `reject_suggestion`
3. **Upload** the revision — `upload_document`
4. **Close** each thread — `reply_to_comment`, then `resolve_comment`
5. **Sign-off**, if the document is under review — `get_review_status`, `request_review`

Steps 3 and 4 are in that order deliberately. Replying "fixed" or resolving a thread before the new version
exists tells the reviewer something untrue, and they will find out on the next diff.

## First: is this repo CLI-linked?

**If the working directory (or the repo you are editing in) contains a `.vorlyn/` directory, the push step
belongs to the `vorlyn-sync` skill — use `vorlyn push`, not `upload_document`.** Both routes create the same
new version, but a linked repo has a manifest tracking which local file maps to which document, and pushing
around it desynchronizes that mapping. Everything else here — reading feedback, replying, resolving,
accepting suggestions, sign-off — still applies unchanged; only step 3 changes hands.

**Repo, but no `.vorlyn/` yet** — link it, don't fall back to `upload_document`. A repo with no manifest is
usually just a repo the `SessionStart` hook hasn't reached yet (auto-start disabled, or you moved into this
folder mid-session): run `vorlyn serve status || vorlyn serve start`, then `vorlyn link` (see the
`vorlyn-sync` skill's "Make sure there is somewhere to push to" section for the full reuse-vs-create
behavior — in short, it reuses an existing project matching the folder before ever creating one, and a
human-provisioned project always wins via `vorlyn link --project <id>`). Once linked, this becomes the
CLI-linked case above: use `vorlyn push`, not `upload_document`.

This skill otherwise assumes **nothing local exists**: no repo, no checkout, no `.vorlyn/`, no CLI. That is
the normal case for a hosted agent whose only view of the document is what the MCP tools return — if there
is no repo at all, none of the linking steps above apply and `upload_document` is the only route there is.

## Step 1 — Read the feedback

Two tools describe a document's review state, and they answer different questions:

| Tool                  | Answers                                                                                                                                                                                                   | Reach for it when                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `get_feedback_bundle` | _What did people actually say, and where?_ Every unresolved comment with its quoted text, anchor position, upvotes, reply thread, and any proposed replacement — plus a prompt-ready rendering of the lot | Almost always. This is the working document for a revision pass             |
| `get_review_status`   | _Where does sign-off stand?_ Derived status, who was asked to review, what verdicts landed, the org's approval gate, open-comment count                                                                   | You only need the verdict — "was this approved?" — and not the comment text |

The bundle already embeds a summary of sign-off status, so **start with `get_feedback_bundle` and only call
`get_review_status` when you need the full verdict history** (individual notes, which version each verdict
pinned to). Calling both by reflex is wasted context.

Two things in the bundle carry more signal than they look like they do:

- **`upvotes`** — items come back highest-upvote first. Multiple reviewers upvoting one comment is the
  closest thing to a priority signal Vorlyn has. Work top-down.
- **`anchorState`** — `anchored` means the quoted text was found in the current version and `location`
  points at it. `orphaned` means the text the comment was made on **no longer exists**, and no location is
  given on purpose. Read the whole document and work out what the comment now applies to, or ask. Do not
  guess where it moved: Vorlyn refuses to guess below 0.6 confidence, and an agent overriding that quietly is
  worse than the honest orphan.

If you have been away and the document may have moved under you, `get_document_status` is the cheap check
(seq + content hash, no body) and `get_diff` shows what changed between two versions. Fetch the full text
with `get_document` before editing regardless — you are producing a whole-file replacement, so you need the
current whole file.

## Step 2 — Suggested edit, or ordinary comment?

Every item in the bundle is one of two kinds, and they close through different tools. Conflating them is the
single easiest mistake to make here.

| The item                   | What it is                                                                                  | How it closes                              |
| -------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `proposedText` is non-null | A **suggested edit** — the reviewer wrote the exact replacement text for the anchored range | `accept_suggestion` or `reject_suggestion` |
| `proposedText` is null     | An **ordinary comment** — prose asking for something                                        | `reply_to_comment`, then `resolve_comment` |

`resolve_comment` is not how you answer a suggestion, and `accept_suggestion` returns `not_a_suggestion` on
a plain comment. Check `proposedText` before picking the verb.

### Accepting a suggestion changes nothing on its own

This is the mechanic most worth internalizing:

> **`accept_suggestion` records a decision. It does not edit the document, and it mints no version.**

Nothing in Vorlyn splices the proposed text into the source. Accepting flips the suggestion's outcome to
`accepted` and returns. Until an upload lands whose content actually matches the proposal at that location,
`get_feedback_bundle` keeps surfacing it as _accepted, not yet applied_ — and it is right to, because at
that point it genuinely hasn't been.

So accepting is always a two-part move:

```
accept_suggestion(comment_id)      →  decision recorded
   apply proposedText to the source yourself, at the anchored range
upload_document(document_id, content)  →  the change now exists
```

The link between the accepted suggestion and the version that fulfils it is discovered later and
automatically, by matching content — you do not report it and there is no field to set. Just make the upload
actually contain the proposed text.

Rejecting is the mirror image: terminal, and it changes nothing. **Say why in `reply_to_comment` before you
call `reject_suggestion`** — a bare rejection leaves the reviewer with an outcome and no reasoning, which
reads as dismissal.

Both verbs need document ownership or org admin. A `forbidden` here means the decision is not yours to make:
reply with your recommendation and leave it open for whoever owns the document.

## Step 3 — Upload the revision

One `upload_document` call carrying the **complete new markdown** — it is a whole-file replacement, never a
patch or a diff fragment. Pass the existing `document_id` so it appends a version rather than forking a
duplicate document.

Group a whole round of feedback into **one** upload. Comments re-anchor against the new text on every
version, and a comment that cannot re-anchor confidently is marked moved or orphaned — so uploading once per
comment shreds exactly the reviewer context you are trying to preserve.

Always send a `change_note`. The reviewer reads it before the diff; it is the difference between reviewing a
decision and reverse-engineering one.

Good:

- `"Split auth into SSO and API-key paths per Dana's comment — the old single flow hid a JIT-provisioning step"`
- `"Applied Sam's suggested rollback wording; dropped the batch-import requirement he flagged as dead"`
- `"Addressed the three anchoring comments; left the open question in §4 open on purpose, see my reply there"`

Not good — these tell the reviewer nothing the diff doesn't already show:

- `"updated doc"` / `"changes"` / `"wip"`
- `"Addressed feedback"` (which feedback, and how?)
- `"Accepted suggestion"` (which one, and did anything else move?)

If content is genuinely unchanged, the upload is a free no-op and comes back `deduplicated: true`. That is a
signal worth reading: it usually means the edit never actually got made.

## Step 4 — Close the threads

Now that the new version exists, answer each thread.

**`reply_to_comment`** on everything you touched. Say what you did, in the thread where it was asked — a
reviewer scanning threads should not have to reconstruct your work from the diff. Reply even when you did
_not_ do what was asked; a disagreement stated in the thread is a conversation, an unexplained non-change is
an oversight.

**`resolve_comment`** only on threads that are genuinely finished. Resolving needs document ownership or org
admin — an `edit` share grant buys uploads and nothing else, so a `forbidden` here is expected and fine when
you are pushing to someone else's document. In that case reply and leave the thread open; the owner
resolves. Never treat `forbidden` as a reason to skip the reply too.

Leave open, deliberately, anything you could not settle: an orphaned comment you could not place, a question
you need the human to answer, a suggestion you declined. Open threads are how the human knows there is
something left for them.

## Step 5 — Sign-off

Sign-off is a separate axis from comments: a document can have zero open comments and still be unapproved.

| Tool                | Who calls it, realistically                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `get_review_status` | Anyone with access, any time. Safe read — use it to check whether a revision cleared the gate                                         |
| `request_review`    | You, on behalf of the document's owner, after a revision is uploaded and ready for another look                                       |
| `submit_review`     | **Almost never you.** This records _your own_ verdict, and only works if the API key's user personally holds an active review request |

`submit_review` is where an agent most often oversteps. There is no way to sign off on someone's behalf —
the call returns `not_a_reviewer` unless the acting user was personally asked. Legitimately calling it means
a human explicitly named this agent's user as a reviewer, which is a deliberate arrangement, not a default.
When in doubt, `request_review` and let a human hold the pen.

Two more things worth knowing:

- Verdicts pin to the version that was current when they were cast, so **a new upload reopens the question**.
  After uploading a revision to an approved document, expect to `request_review` again.
- Under a **hard** approval gate (visible as `gate` in `get_review_status`), approval is blocked while any
  comment is open. If a reviewer is waiting on you, closing the remaining threads is the unblocking move.

## Common mistakes

| Mistake                                                           | Why it hurts                                                                                    | Instead                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Treating `accept_suggestion` as if it applied the edit            | The document is unchanged and the bundle still shows it pending — the reviewer sees no progress | Accept, apply the text yourself, then `upload_document`   |
| Resolving threads before the revision is uploaded                 | Tells the reviewer it's fixed when it isn't; the next diff exposes it                           | Upload first, then reply, then resolve                    |
| One upload per comment addressed                                  | Every version re-anchors every comment; churn orphans the reviewer's own context                | One upload per round of feedback                          |
| Guessing where an orphaned comment now belongs                    | Vorlyn refused to guess below 0.6 confidence; a silent agent guess is a confident wrong answer  | Read the document, place it deliberately, or ask          |
| Calling `submit_review` to "approve" your own work                | Returns `not_a_reviewer`, and the intent is wrong — sign-off is the human's                     | `request_review`, then poll `get_review_status`           |
| Rejecting a suggestion with no reply                              | Reviewer gets an outcome with no reasoning                                                      | `reply_to_comment` with the why, then `reject_suggestion` |
| Skipping the reply because `resolve_comment` returned `forbidden` | The reply was the part that mattered; resolution is just bookkeeping the owner can do           | Always reply; let the owner resolve                       |
| Using `upload_document` in a repo that has `.vorlyn/`             | Desynchronizes the CLI's file→document mapping                                                  | Use `vorlyn push` — see the `vorlyn-sync` skill           |

## When calls fail

Every tool can return `rate_limited` with a `retryAfterSeconds` — back off for that long and resume; it is
never a reason to abandon the loop or switch strategy.

`document_not_found` doubles as "you do not have access" on purpose (Vorlyn refuses to confirm that a
document exists to someone who cannot read it), so treat it as _ask the human for access_, not _the id is
wrong_, when the id came from a trustworthy source.

Each tool's own description names the specific codes it can return, with what they mean — read it before
inventing a retry strategy.
