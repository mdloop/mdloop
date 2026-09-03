/**
 * Baseline load test against the local e2e harness (no AWS needed).
 *
 * Start the target first:
 *   pnpm typecheck && LOAD_TEST=1 node packages/api/dist/e2e-main.js
 * Then:
 *   k6 run scripts/load/k6-baseline.js
 *
 * What it measures (the request-diet work, under concurrency):
 *  - GET /overview            one-payload home screen, keyset paging
 *  - GET  documents/:id/content   ETag revalidation (304 path)
 *  - GET  documents/:id/comments  thread list + lazy re-anchoring cache
 *  - POST comments / replies      write path
 *  - POST documents/:id/versions  upload → first thread read = re-anchor spike
 *
 * Thresholds are intentionally loose first-run gates; tighten after the
 * first baseline is recorded.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

const reanchorSpike = new Trend('reanchor_first_read_ms');

export const options = {
  scenarios: {
    readers: {
      executor: 'constant-vus',
      exec: 'reader',
      vus: 20,
      duration: '2m',
    },
    commenters: {
      executor: 'constant-vus',
      exec: 'commenter',
      vus: 5,
      duration: '2m',
    },
    uploader: {
      executor: 'constant-vus',
      exec: 'uploader',
      vus: 1,
      duration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:overview}': ['p(95)<300'],
    'http_req_duration{name:content}': ['p(95)<200'],
    'http_req_duration{name:threads}': ['p(95)<400'],
    'http_req_duration{name:comment}': ['p(95)<400'],
    reanchor_first_read_ms: ['p(95)<2000'],
  },
};

function docBody(seq) {
  const sections = [];
  for (let i = 0; i < 30; i++) {
    sections.push(
      `## Section ${i}\n\nParagraph ${i} of revision ${seq}: the exporter batches writes and retries with backoff. Line unique-${i}-marker stays anchored.`,
    );
  }
  return `# Load target v${seq}\n\n${sections.join('\n\n')}\n`;
}

/** One login for the whole run: e2e loopback auth, cookie shared via setup. */
export function setup() {
  const jar = http.cookieJar();
  const r1 = http.get(`${BASE}/auth/login`, { redirects: 0 });
  const r2 = http.get(r1.headers.Location, { redirects: 0 });
  check(r2, {
    'login sets session': (r) => String(r.headers['Set-Cookie'] || '').includes('vorlyn_session'),
  });
  const cookies = jar.cookiesForURL(`${BASE}/`);
  const session = cookies.vorlyn_session[0];

  const up = http.post(
    `${BASE}/documents`,
    JSON.stringify({ title: 'load-target.md', content: docBody(1) }),
    { headers: { 'content-type': 'application/json' } },
  );
  check(up, { 'seed upload 201': (r) => r.status === 201 });
  const documentId = up.json().document.id;

  // Seed comments across the document so thread reads and re-anchoring
  // have real work to do.
  for (let i = 0; i < 25; i++) {
    const marker = `unique-${i}-marker`;
    const body = docBody(1);
    const start = body.indexOf(marker);
    http.post(
      `${BASE}/documents/${documentId}/comments`,
      JSON.stringify({
        body: `seed comment ${i}`,
        anchor: {
          type: 'text',
          exact: marker,
          prefix: body.slice(Math.max(0, start - 32), start),
          suffix: body.slice(start + marker.length, start + marker.length + 32),
          start,
          end: start + marker.length,
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  return { documentId, session };
}

function auth(data) {
  const jar = http.cookieJar();
  jar.set(BASE, 'vorlyn_session', data.session);
}

export function reader(data) {
  auth(data);
  const o = http.get(`${BASE}/overview`, { tags: { name: 'overview' } });
  check(o, { 'overview 200': (r) => r.status === 200 });

  const c1 = http.get(`${BASE}/documents/${data.documentId}/content`, {
    tags: { name: 'content' },
  });
  const etag = c1.headers.Etag;
  if (etag) {
    const c2 = http.get(`${BASE}/documents/${data.documentId}/content`, {
      headers: { 'if-none-match': etag },
      tags: { name: 'content' },
    });
    check(c2, { 'etag revalidates 304': (r) => r.status === 304 });
  }

  const t = http.get(`${BASE}/documents/${data.documentId}/comments?status=open`, {
    tags: { name: 'threads' },
  });
  check(t, { 'threads 200': (r) => r.status === 200 });
  sleep(0.3);
}

export function commenter(data) {
  auth(data);
  const r = http.post(
    `${BASE}/documents/${data.documentId}/comments`,
    JSON.stringify({ body: `load comment ${Date.now()}`, anchor: { type: 'document' } }),
    {
      headers: { 'content-type': 'application/json' },
      tags: { name: 'comment' },
      responseCallback: http.expectedStatuses(201, 403),
    },
  );
  // The e2e org is free-tier: after 100 comments the cap answers 403
  // comment_cap_exceeded by design — both outcomes are correct behavior.
  check(r, {
    'comment 201 or capped 403': (x) =>
      x.status === 201 || (x.status === 403 && x.json().error === 'comment_cap_exceeded'),
  });
  sleep(1);
}

let uploadSeq = 1;
export function uploader(data) {
  auth(data);
  uploadSeq += 1;
  const up = http.post(
    `${BASE}/documents/${data.documentId}/versions`,
    JSON.stringify({ content: docBody(uploadSeq) }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'upload' } },
  );
  check(up, { 'upload ok': (r) => r.status === 200 });

  // First thread read after a new version pays the re-anchor cost — measure it.
  const t0 = Date.now();
  const t = http.get(`${BASE}/documents/${data.documentId}/comments?status=open`, {
    tags: { name: 'reanchor' },
  });
  reanchorSpike.add(Date.now() - t0);
  check(t, { 'post-upload threads 200': (r) => r.status === 200 });
  sleep(10);
}
