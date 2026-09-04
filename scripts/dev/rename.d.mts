// Hand-written types for the plain-JS `pnpm rename` script, so its one piece of
// real logic (`replaceAllForms` — see that function's comment) can be imported
// and unit-tested with full type checking instead of an untyped escape hatch.

export interface IdentifierForms {
  readonly lower: string;
  readonly title: string;
  readonly upper: string;
}

export function buildForms(identifier: string): IdentifierForms;

export function replaceAllForms(
  content: string,
  fromForms: IdentifierForms,
  toForms: IdentifierForms,
): string;
