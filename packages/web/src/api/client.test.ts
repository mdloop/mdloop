// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './client.js';

/**
 * The API-key wrappers are the only client calls whose response carries a
 * secret, so they get direct coverage of the wire contract: the path, the
 * method, the CSRF echo on mutations, and the fact that a non-2xx surfaces as
 * a typed `ApiError` code rather than a thrown fetch failure.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function noContent(): Response {
  return { ok: true, status: 204, json: () => Promise.resolve({}) } as unknown as Response;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  document.cookie = 'mdloop_csrf=csrf-token-value';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `init` the wrapper handed `fetch`, with headers narrowed to a record. */
function callInit(): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
} {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: (init.method ?? 'GET').toUpperCase(),
    headers: init.headers as Record<string, string>,
    body: init.body,
  };
}

describe('api.listApiKeys', () => {
  it('GETs /api-keys and returns the server list unfiltered', async () => {
    const keys = [
      {
        id: 'k1',
        userId: 'u1',
        name: 'Laptop',
        createdAt: '2026-08-01T00:00:00Z',
        lastUsedAt: null,
        revokedAt: null,
      },
    ];
    fetchMock.mockResolvedValue(jsonResponse({ keys }));

    await expect(api.listApiKeys()).resolves.toEqual({ keys });
    const call = callInit();
    expect(call.url).toBe('/api/api-keys');
    expect(call.method).toBe('GET');
    // Reads are CSRF-exempt server-side; the client must not send the header.
    expect(call.headers['x-csrf-token']).toBeUndefined();
  });
});

describe('api.createApiKey', () => {
  it('POSTs the name with the CSRF echo and returns the once-only key', async () => {
    const record = {
      id: 'k2',
      userId: 'u1',
      name: 'CI',
      createdAt: '2026-08-01T00:00:00Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    fetchMock.mockResolvedValue(jsonResponse({ key: 'mdloop_secret', record }, 201));

    await expect(api.createApiKey('CI')).resolves.toEqual({ key: 'mdloop_secret', record });
    const call = callInit();
    expect(call.url).toBe('/api/api-keys');
    expect(call.method).toBe('POST');
    expect(call.body).toBe(JSON.stringify({ name: 'CI' }));
    expect(call.headers['x-csrf-token']).toBe('csrf-token-value');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('surfaces a rejection as a typed ApiError carrying the server code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_name' }, 400));

    await expect(api.createApiKey('  ')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_name',
    });
    await expect(api.createApiKey('  ')).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a guest refusal to its own code, not a generic failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));
    await expect(api.createApiKey('x')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('api.revokeApiKey', () => {
  it('DELETEs the key and resolves on the 204', async () => {
    fetchMock.mockResolvedValue(noContent());

    await expect(api.revokeApiKey('k9')).resolves.toBeUndefined();
    const call = callInit();
    expect(call.url).toBe('/api/api-keys/k9');
    expect(call.method).toBe('DELETE');
    expect(call.headers['x-csrf-token']).toBe('csrf-token-value');
  });

  it('rejects with key_not_found when the key is already gone', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'key_not_found' }, 404));
    await expect(api.revokeApiKey('gone')).rejects.toMatchObject({
      status: 404,
      code: 'key_not_found',
    });
  });
});

describe('api.listPublicHubDocs', () => {
  it('GETs /public-hub/documents with no query string when called bare', async () => {
    const docs = [
      {
        id: 'p1',
        slug: 'onboarding',
        title: 'Onboarding',
        seq: 2,
        publishedAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-02T00:00:00Z',
      },
    ];
    fetchMock.mockResolvedValue(jsonResponse({ docs, nextCursor: null }));

    await expect(api.listPublicHubDocs()).resolves.toEqual({ docs, nextCursor: null });
    const call = callInit();
    expect(call.url).toBe('/api/public-hub/documents');
    expect(call.method).toBe('GET');
    expect(call.headers['x-csrf-token']).toBeUndefined();
  });

  it('encodes cursor and limit onto the query string when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [], nextCursor: null }));

    await api.listPublicHubDocs({ cursor: 'abc', limit: 10 });
    const call = callInit();
    expect(call.url).toBe('/api/public-hub/documents?cursor=abc&limit=10');
  });

  it('surfaces a 403 as a typed forbidden ApiError — the client-side signal that this org is not the hub home org', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));
    await expect(api.listPublicHubDocs()).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});

describe('api.publishToPublicHub', () => {
  it('POSTs the publish body with the CSRF echo and returns the published doc', async () => {
    const published = {
      id: 'p2',
      slug: 'runbook',
      title: 'Runbook',
      seq: 1,
      publishedAt: '2026-08-01T00:00:00Z',
    };
    fetchMock.mockResolvedValue(jsonResponse(published, 201));

    await expect(api.publishToPublicHub({ documentId: 'd1', slug: 'runbook' })).resolves.toEqual(
      published,
    );
    const call = callInit();
    expect(call.url).toBe('/api/public-hub/documents');
    expect(call.method).toBe('POST');
    expect(call.body).toBe(JSON.stringify({ documentId: 'd1', slug: 'runbook' }));
    expect(call.headers['x-csrf-token']).toBe('csrf-token-value');
  });

  it('rejects with invalid_slug for a malformed slug', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_slug' }, 400));
    await expect(
      api.publishToPublicHub({ documentId: 'd1', slug: 'Not A Slug' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_slug' });
  });
});

describe('api.unpublishFromPublicHub', () => {
  it('DELETEs by slug and resolves on the 204', async () => {
    fetchMock.mockResolvedValue(noContent());

    await expect(api.unpublishFromPublicHub('runbook')).resolves.toBeUndefined();
    const call = callInit();
    expect(call.url).toBe('/api/public-hub/documents/runbook');
    expect(call.method).toBe('DELETE');
    expect(call.headers['x-csrf-token']).toBe('csrf-token-value');
  });

  it('rejects with forbidden when the caller cannot unpublish', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));
    await expect(api.unpublishFromPublicHub('runbook')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});
