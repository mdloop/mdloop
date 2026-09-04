import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mdloopDir, ensureMdloopDir } from './mdloop-dir.js';

const TRUST_FILENAME = 'endpoint-trust.json';

/** `.mdloop/endpoint-trust.json` — local and gitignored, never committed. */
export interface EndpointTrust {
  trustedOrigin: string;
}

export function endpointTrustPath(folder: string): string {
  return path.join(mdloopDir(folder), TRUST_FILENAME);
}

/**
 * Refusal to talk to an endpoint at all. Distinct from a connection failure:
 * nothing was attempted and no credential left the machine.
 */
export class EndpointRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointRefusedError';
  }
}

/**
 * Loopback is the one place plaintext `http://` stays legal: `make dev` serves
 * the MCP endpoint on `http://localhost:3001/mcp`, which is also the CLI's own
 * default. Traffic never leaves the machine, so there is nothing to intercept.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopback(hostname: string): boolean {
  // URL.hostname strips the brackets from an IPv6 literal, but be tolerant.
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return LOOPBACK_HOSTNAMES.has(bare.toLowerCase());
}

function parseEndpoint(endpoint: string): URL {
  try {
    return new URL(endpoint);
  } catch {
    throw new EndpointRefusedError(
      `Refusing to connect: "${endpoint}" in .mdloop/manifest.json is not a valid URL.`,
    );
  }
}

/** scheme + host + port, the unit this CLI pins and compares. */
export function endpointOrigin(endpoint: string): string {
  return parseEndpoint(endpoint).origin;
}

/**
 * Is this endpoint the local embedded/daemon instance rather than a remote
 * or team server? Moved here (from `open.ts`, where it used to be private)
 * because both the daemon-attach guard (`open.ts`, `serve.ts`) and the
 * trust-pin bypass just below need it, and it must have exactly one
 * definition.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Scheme guard. `.mdloop/manifest.json` is committed and shared by design, so
 * its `endpoint` is attacker-reachable through any poisoned commit — and the
 * CLI sends the developer's API key there as a bearer token. Plaintext to
 * anything but loopback is refused before a socket is opened.
 */
export function assertTransportSafe(endpoint: string): void {
  const url = parseEndpoint(endpoint);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return;
  throw new EndpointRefusedError(
    `Refusing to send your API key to ${endpoint} over ${url.protocol.replace(':', '')} — ` +
      'only https:// endpoints are allowed (plain http:// is permitted for localhost only). ' +
      'Check the "endpoint" field in .mdloop/manifest.json.',
  );
}

export async function readTrustedOrigin(folder: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(endpointTrustPath(folder), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).trustedOrigin !== 'string'
  ) {
    throw new EndpointRefusedError(
      `Refusing to connect: ${endpointTrustPath(folder)} is unreadable. Delete it to re-trust the manifest's endpoint.`,
    );
  }
  return (parsed as EndpointTrust).trustedOrigin;
}

/**
 * Idempotent: rewrites only when the pin is absent or (post-check) unchanged.
 * A no-op for a local endpoint — see `assertEndpointTrusted`'s doc comment
 * for why local origins are never pinned in the first place.
 */
export async function pinTrustedOrigin(folder: string, origin: string): Promise<void> {
  if (isLocalEndpoint(origin)) return;
  if ((await readTrustedOrigin(folder)) === origin) return;
  await ensureMdloopDir(folder);
  const trust: EndpointTrust = { trustedOrigin: origin };
  await writeFile(endpointTrustPath(folder), `${JSON.stringify(trust, null, 2)}\n`, 'utf8');
}

/**
 * Trust on first use, SSH-host-key style (hardening pass 2026-07-30). The
 * first successful connect from a folder pins the
 * endpoint's origin locally; every later run compares against that pin and
 * refuses outright if the committed manifest has been repointed underneath
 * the developer. There is deliberately no `--force` for this: `--force`
 * overrides a version conflict, which is a data question, not "send my
 * credential somewhere new". Re-trusting is a manual, visible act — delete
 * the pin file.
 *
 * **Local endpoints are exempt from the pin comparison entirely.** The
 * threat this guards against is a committed `manifest.json` silently
 * repointed to an attacker's remote host; a `127.0.0.1`/`localhost` endpoint
 * is not attacker-controllable the same way, and since the local daemon's
 * port is now OS-assigned (`packages/cli/src/local-instance.ts`) rather than
 * fixed, its origin legitimately changes on every restart — pinning it would
 * make every `mdloop serve` restart look like a same-severity event as a
 * real remote-host swap. The scheme guard above (`assertTransportSafe`)
 * still applies to local endpoints; only the origin-pin comparison is
 * skipped.
 */
export async function assertEndpointTrusted(folder: string, endpoint: string): Promise<void> {
  assertTransportSafe(endpoint);
  if (isLocalEndpoint(endpoint)) return;
  const origin = endpointOrigin(endpoint);
  const pinned = await readTrustedOrigin(folder);
  if (pinned !== undefined && pinned !== origin) {
    throw new EndpointRefusedError(
      `Refusing to connect: the endpoint in .mdloop/manifest.json changed from ${pinned} to ${origin} since this folder was last used.\n` +
        'Your API key would be sent to the new host. If you did not expect this change, do NOT proceed — check who changed the manifest.\n' +
        `If the change is expected, delete ${endpointTrustPath(folder)} and run the command again.`,
    );
  }
}
