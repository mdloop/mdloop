import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureMdloopDir } from './mdloop-dir.js';
import {
  assertEndpointTrusted,
  assertTransportSafe,
  endpointOrigin,
  EndpointRefusedError,
  endpointTrustPath,
  pinTrustedOrigin,
  readTrustedOrigin,
} from './endpoint-trust.js';

describe('endpoint trust', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-trust-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  describe('transport guard', () => {
    it('allows https to any host', () => {
      expect(() => {
        assertTransportSafe('https://mdloop.example.com/mcp');
      }).not.toThrow();
    });

    it.each([
      'http://localhost:3001/mcp',
      'http://localhost/mcp',
      'http://127.0.0.1:3001/mcp',
      'http://[::1]:3001/mcp',
    ])('allows plain http to loopback: %s', (endpoint) => {
      expect(() => {
        assertTransportSafe(endpoint);
      }).not.toThrow();
    });

    it('refuses plain http to a non-loopback host', () => {
      expect(() => {
        assertTransportSafe('http://evil.example.com/mcp');
      }).toThrow(EndpointRefusedError);
      expect(() => {
        assertTransportSafe('http://evil.example.com/mcp');
      }).toThrow(/Refusing to send your API key/);
    });

    it('refuses a host that merely looks like loopback', () => {
      expect(() => {
        assertTransportSafe('http://localhost.evil.example.com/mcp');
      }).toThrow(EndpointRefusedError);
    });

    it('refuses a non-http scheme outright', () => {
      expect(() => {
        assertTransportSafe('file:///etc/passwd');
      }).toThrow(EndpointRefusedError);
    });

    it('refuses a malformed URL rather than crashing', () => {
      expect(() => {
        assertTransportSafe('not a url');
      }).toThrow(/not a valid URL/);
    });
  });

  describe('origin', () => {
    it('is scheme + host + port, dropping the path', () => {
      expect(endpointOrigin('https://mdloop.example.com:8443/mcp')).toBe(
        'https://mdloop.example.com:8443',
      );
    });

    it('distinguishes ports on the same host', () => {
      expect(endpointOrigin('http://localhost:3001/mcp')).not.toBe(
        endpointOrigin('http://localhost:3002/mcp'),
      );
    });
  });

  describe('trust on first use', () => {
    it('trusts and pins the first endpoint a folder ever sees', async () => {
      await expect(
        assertEndpointTrusted(folder, 'https://mdloop.example.com/mcp'),
      ).resolves.toBeUndefined();
      expect(await readTrustedOrigin(folder)).toBeUndefined();

      await pinTrustedOrigin(folder, endpointOrigin('https://mdloop.example.com/mcp'));
      expect(await readTrustedOrigin(folder)).toBe('https://mdloop.example.com');
    });

    it('allows the unchanged origin repeatedly, including a different path', async () => {
      await pinTrustedOrigin(folder, 'https://mdloop.example.com');
      await expect(
        assertEndpointTrusted(folder, 'https://mdloop.example.com/mcp'),
      ).resolves.toBeUndefined();
      await expect(
        assertEndpointTrusted(folder, 'https://mdloop.example.com/mcp'),
      ).resolves.toBeUndefined();
      await expect(
        assertEndpointTrusted(folder, 'https://mdloop.example.com/other/path'),
      ).resolves.toBeUndefined();
    });

    it('refuses a silently-changed origin, naming both sides and the way out', async () => {
      await pinTrustedOrigin(folder, 'https://mdloop.example.com');
      await expect(
        assertEndpointTrusted(folder, 'https://attacker.example.net/mcp'),
      ).rejects.toBeInstanceOf(EndpointRefusedError);
      await expect(
        assertEndpointTrusted(folder, 'https://attacker.example.net/mcp'),
      ).rejects.toThrow(
        /changed from https:\/\/mdloop\.example\.com to https:\/\/attacker\.example\.net/,
      );
      await expect(
        assertEndpointTrusted(folder, 'https://attacker.example.net/mcp'),
      ).rejects.toThrow(/endpoint-trust\.json/);
    });

    it('allows a same-host, different-port move for a loopback endpoint (the local daemon port is dynamic and legitimately changes across restarts)', async () => {
      await pinTrustedOrigin(folder, 'http://localhost:3001');
      // Never pinned in the first place (pinTrustedOrigin is a no-op for a
      // loopback origin), so nothing to compare against — a different local
      // port is simply never refused.
      expect(await readTrustedOrigin(folder)).toBeUndefined();
      await expect(
        assertEndpointTrusted(folder, 'http://localhost:9999/mcp'),
      ).resolves.toBeUndefined();
    });

    it('still refuses a same-host, different-port move for a remote endpoint', async () => {
      await pinTrustedOrigin(folder, 'https://mdloop.example.com:8443');
      await expect(
        assertEndpointTrusted(folder, 'https://mdloop.example.com:9999/mcp'),
      ).rejects.toBeInstanceOf(EndpointRefusedError);
    });

    it('never pins or compares a loopback origin at all', async () => {
      await pinTrustedOrigin(folder, 'http://127.0.0.1:3001');
      expect(await readTrustedOrigin(folder)).toBeUndefined();
      await expect(
        assertEndpointTrusted(folder, 'http://127.0.0.1:54321/mcp'),
      ).resolves.toBeUndefined();
    });

    it('applies the scheme guard before the pin comparison', async () => {
      await pinTrustedOrigin(folder, 'http://evil.example.com');
      await expect(assertEndpointTrusted(folder, 'http://evil.example.com/mcp')).rejects.toThrow(
        /Refusing to send your API key/,
      );
    });

    it('re-trusts once the pin file is deleted', async () => {
      await pinTrustedOrigin(folder, 'https://mdloop.example.com');
      await rm(endpointTrustPath(folder));
      await expect(
        assertEndpointTrusted(folder, 'https://elsewhere.example.com/mcp'),
      ).resolves.toBeUndefined();
    });

    it('rewriting the same pin is a no-op', async () => {
      await pinTrustedOrigin(folder, 'https://mdloop.example.com');
      const before = await readFile(endpointTrustPath(folder), 'utf8');
      await pinTrustedOrigin(folder, 'https://mdloop.example.com');
      expect(await readFile(endpointTrustPath(folder), 'utf8')).toBe(before);
    });

    it('refuses rather than silently re-trusting when the pin file is corrupt', async () => {
      await ensureMdloopDir(folder);
      await writeFile(endpointTrustPath(folder), '{"nope":1}');
      await expect(readTrustedOrigin(folder)).rejects.toBeInstanceOf(EndpointRefusedError);
    });
  });
});
