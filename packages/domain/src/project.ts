/** Project display colors: lowercase hex, mirrors the DB check constraint. */
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export function isValidProjectColor(color: string): boolean {
  return COLOR_PATTERN.test(color);
}

export const MAX_PROJECT_NAME_LENGTH = 120;

export function isValidProjectName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PROJECT_NAME_LENGTH;
}

export const MAX_DOCUMENT_TITLE_LENGTH = 200;

export function isValidDocumentTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_DOCUMENT_TITLE_LENGTH;
}
