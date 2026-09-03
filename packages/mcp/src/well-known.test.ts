import { describe, expect, it } from 'vitest';
import { bearerChallengeHeader, protectedResourceMetadata } from './well-known.js';

describe('protectedResourceMetadata', () => {
  it('shapes RFC 9728 protected-resource metadata around the resource and issuer', () => {
    expect(protectedResourceMetadata('https://mcp.vorlyn.test', 'https://auth.workos.com')).toEqual(
      {
        resource: 'https://mcp.vorlyn.test',
        authorization_servers: ['https://auth.workos.com'],
        bearer_methods_supported: ['header'],
      },
    );
  });
});

describe('bearerChallengeHeader', () => {
  it('points at the well-known metadata path under the given resource', () => {
    expect(bearerChallengeHeader('https://mcp.vorlyn.test')).toBe(
      'Bearer error="unauthorized", resource_metadata="https://mcp.vorlyn.test/.well-known/oauth-protected-resource"',
    );
  });
});
