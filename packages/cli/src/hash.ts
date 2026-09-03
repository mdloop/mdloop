import { createHash } from 'node:crypto';

/** sha256 of raw bytes, formatted as the manifest's `sha256:<hex>` convention. */
export function sha256Hex(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
