import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** scripts/gen-docs/src -> repo root. */
export const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Generated reference docs (`pnpm gen:docs`), committed and drift-checked.
 *
 * ONE output location: this repository has no website and no separate
 * publishing build, so a single committed file under `docs/` is both the
 * artifact and the thing a reader opens — no second copy to keep in sync.
 *
 * Until 2026-08-28 these constants pointed at a `website/` directory that
 * does not exist here — so `pnpm gen:docs` and `pnpm docs:check` both
 * crashed on a path that could never resolve. Neither was wired into
 * `verify` or CI, which is the only reason it went unnoticed.
 */
export const REFERENCE_DIR = path.join(REPO_ROOT, 'docs/reference');
