export interface Io {
  println: (line: string) => void;
  errln: (line: string) => void;
}

/**
 * User-facing CLI output. Root eslint bans `console.*` repo-wide
 * (`no-console`); a CLI legitimately has a lot of stdout/stderr traffic, so
 * route through process.stdout/stderr directly rather than scattering
 * disable comments everywhere.
 */
export function println(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function errln(line: string): void {
  process.stderr.write(`${line}\n`);
}

export const stdio: Io = { println, errln };
