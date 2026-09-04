/**
 * Email validation utilities. Relocated out of `billing.ts` in the S4
 * billing-removal spike: both functions were misfiled there (`isValidEmail`
 * was already explicitly commented "Phase 18 guest sharing", not billing)
 * and neither has anything to do with a payment provider — they're generic
 * string checks two unrelated use-cases (`guest-sharing.ts`, `sign-in.ts`)
 * depend on.
 */

/** Cheap shape check for an email address (Phase 18 guest sharing). */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Disposable-email guard for free signup (abuse control, PLAN Phase 13).
 * Deliberately a short static list of the highest-volume providers — a
 * speed bump for drive-by abuse, not an arms race; the per-IP signup rate
 * limit and email verification (WorkOS OTP) carry the real weight.
 */
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  'discard.email',
  'dispostable.com',
  'fakeinbox.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'mailinator.com',
  'maildrop.cc',
  'mintemail.com',
  'mohmal.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.dev',
  'tempmailo.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .toLowerCase()
    .trim();
  return DISPOSABLE_DOMAINS.has(domain);
}
