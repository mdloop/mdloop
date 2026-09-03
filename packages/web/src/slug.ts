/**
 * Cosmetic-only slug for share/document URLs — never looked up or validated,
 * carries no authority. The token (or document id) preceding it is the only
 * thing the server checks.
 */
const COMBINING_MARKS = new RegExp(`[\\u0300-\\u036f]`, 'g');

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'document';
}
