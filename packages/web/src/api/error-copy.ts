/**
 * One place that turns an API error code into a sentence a person can read.
 *
 * The API answers a failure with `{ error: '<code>' }` and the client re-throws
 * it as `ApiError` (client.ts). Before this module every surface either invented
 * its own local `codeToMessage` (org-settings, the operator console — two
 * near-identical copies that had already drifted) or gave up and rendered the
 * raw code as `Request failed: seat_cap_reached`, which is an internal
 * identifier leaking into the UI.
 *
 * Distinct from `upload-precheck.ts`'s `UPLOAD_ERROR_COPY`, which is not the
 * same concern wearing a different hat: those are sentence *fragments*
 * completing "<filename> …" in a per-file rejection list. These are whole
 * sentences for a banner. The few upload codes appear in both, worded for their
 * own grammar; neither map is derivable from the other.
 */

import { ApiError } from './client.js';

/** Shown when a code isn't mapped and the call site named no better fallback. */
const GENERIC = 'Something went wrong — try again.';

/**
 * Code → sentence. Codes are the server's own (`{ error: … }` payloads across
 * `packages/api`); an unmapped one is not a bug here, it just falls back.
 *
 * House style: say what happened and what to do about it, never name the check
 * that fired. Nothing in here may quote org data — these strings are static.
 */
export const API_ERROR_COPY: Readonly<Record<string, string>> = {
  // --- session / access ---
  unauthenticated: 'Your session has expired — sign in again.',
  csrf: 'Your session has expired — refresh the page and try again.',
  bad_origin: 'Your session has expired — refresh the page and try again.',
  forbidden: 'You do not have access to do that.',
  guest_forbidden: 'Guest access does not include that.',
  not_operator: 'That account is not an operator.',
  cannot_remove_self: 'You cannot remove yourself.',

  // --- not found / gone ---
  not_found: 'That could not be found.',
  document_not_found: 'That document could not be found.',
  project_not_found: 'That project could not be found.',
  comment_not_found: 'That comment could not be found.',
  version_not_found: 'That version could not be found.',
  org_not_found: 'Org could not be found.',
  organization_not_found: 'Org could not be found.',
  no_version: 'This document has no content yet.',
  key_not_found: 'That API key is already gone — refresh to see the current list.',
  version_purged: 'That version was purged by the retention policy — its content is gone.',
  invalid_token: 'That link is no longer valid.',

  // --- review, suggestions, comments ---
  suggestion_not_open: 'This suggestion was already resolved — refresh to see its outcome.',
  not_a_reviewer: 'You are not a requested reviewer on this version.',
  reviewer_has_no_access: 'That person does not have access to this document.',
  open_comments_block_approval: 'Open comments have to be resolved before this can be approved.',
  invalid_anchor: 'That selection could not be anchored — try selecting it again.',

  // --- sharing, seats, org admin ---
  seat_cap_reached: 'Your plan is out of seats — upgrade to invite more.',
  // Renamed from `edit_not_grantable_by_link` (ADR 0014) — now covers both
  // `share` and `edit`, neither of which a forwardable link can carry.
  permission_not_grantable_by_link:
    "Share and edit access can't be given to a link, only a named person.",
  // Delegation cap (ADR 0014): a `share`/`edit` grantee asked for a grant
  // above their own held level.
  grant_exceeds_own_permission: "You can't grant a permission higher than your own.",
  // Guests are capped at read/comment regardless of grant (CONSTITUTION §9) —
  // covers both `edit` (ADR 0008) and `share` (ADR 0014) requests.
  guest_edit_forbidden: 'Guests can only be given read or comment access.',
  invalid_email: 'Not a valid email address.',
  invalid_tier: 'Not a valid tier.',
  invalid_provisioning_mode: 'Not a valid provisioning mode.',
  name_mismatch: "Typed name didn't match — purge cancelled.",
  invalid_color: 'Not a valid color.',
  sharing_requires_paid_tier: 'Sharing needs a paid plan — upgrade to share this document.',
  wrong_sharing_mode: 'This org shares documents a different way — check the sharing settings.',
  sso_requires_enterprise_tier: 'Single sign-on requires the Enterprise plan.',
  user_id_required: 'Pick a person to share with first.',

  // --- sign-in (packages/app/src/use-cases/sign-in.ts, surfaced via
  // /api/auth/callback's ?authError= redirect, Phase 38.C) ---
  disposable_email: 'That email provider is not accepted — try a work or personal address.',
  invite_not_found: "That invite link isn't valid.",
  invite_expired: 'That invite has expired — ask an admin to send a new one.',
  invite_already_used: 'That invite was already used.',
  invite_revoked: 'That invite was revoked.',
  sso_connection_not_found: 'Single sign-on is not set up for this organization.',
  not_allowlisted: "Your email is not on this organization's allowlist.",

  // --- uploads and quota (whole-sentence wording; see the note up top) ---
  file_too_large: 'That file is over the 500KB limit.',
  empty_file: 'That file is empty.',
  invalid_title: 'That name is not valid.',
  binary_signature_detected: 'That looks like a binary file, not markdown.',
  control_byte_detected: 'That file contains binary data, not markdown text.',
  replacement_char_density_exceeded: 'That file is not readable as text — is it a binary file?',
  invalid_utf8: 'That file is not valid UTF-8 text.',
  path_taken: 'Another document already uses that path — rename or move it first.',
  doc_cap_exceeded:
    'This org is at its document limit — upgrade, or delete some documents to free up room.',
  project_doc_cap_exceeded:
    'This project is at its document limit — upgrade, or move documents to another project.',
  version_cap_exceeded:
    'This document is at its version limit — older versions age out automatically, or upgrade for a higher ceiling.',

  // --- misc ---
  invalid_name: 'That name is not valid.',
  diff_too_large: 'These versions are too large to compare as rendered markdown.',
  invalid_request: 'That request was not valid.',
  internal: 'Something went wrong on our side — try again.',
};

export interface ErrorCopyOptions {
  /**
   * Used for anything unmapped and for non-`ApiError` throws (network, parse).
   * Say what the user was trying to do — "Could not send the invite." beats a
   * generic apology when the surrounding UI doesn't already make it obvious.
   */
  fallback?: string | undefined;
  /**
   * Per-surface rewordings, checked before {@link API_ERROR_COPY}. The operator
   * console needs these: `seat_cap_reached` means "upgrade your plan" to a
   * customer admin and "raise that org's tier" to an operator looking at
   * somebody else's org.
   */
  overrides?: Readonly<Record<string, string>> | undefined;
}

/** Copy for one API error code. */
export function apiErrorCopy(code: string, options: ErrorCopyOptions = {}): string {
  return options.overrides?.[code] ?? API_ERROR_COPY[code] ?? options.fallback ?? GENERIC;
}

/**
 * Copy for anything a rejected API call threw: an `ApiError` resolves through
 * the map, anything else (offline, DNS, a non-JSON body) gets the fallback —
 * a raw `Error.message` is never shown, since it can carry a URL or content.
 */
export function errorCopy(error: unknown, options: ErrorCopyOptions = {}): string {
  if (error instanceof ApiError) return apiErrorCopy(error.code, options);
  return options.fallback ?? GENERIC;
}
