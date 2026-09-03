// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { ApiError, api } from '../api/client.js';
import type {
  CommentDto,
  DocumentDto,
  Me,
  OrgUserDto,
  ProjectTreeDto,
  ResolutionDto,
  ReviewDto,
  ThreadDto,
  VersionDto,
} from '../api/client.js';
import type * as markdownViewModule from './markdown-view.js';
import { Viewer } from './viewer.js';

/* Real MarkdownView for every test but one: a sentinel source throws, standing
   in for any render throw in the markdown pipeline (a diagram, a callout, a
   plugin) without having to construct one. */
vi.mock('./markdown-view.js', async () => {
  const actual = await vi.importActual<typeof markdownViewModule>('./markdown-view.js');
  return {
    MarkdownView: (props: markdownViewModule.MarkdownViewProps) => {
      if (props.source.includes('__BOOM__')) throw new Error('render exploded: secret content');
      return <actual.MarkdownView {...props} />;
    },
  };
});

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      getDocument: vi.fn(),
      getDocumentContent: vi.fn(),
      getVersionContent: vi.fn(),
      listThreads: vi.fn(),
      listVersions: vi.fn(),
      listOrgUsers: vi.fn(),
      listProjects: vi.fn(),
      listDocuments: vi.fn(),
      getProjectTree: vi.fn(),
      getReview: vi.fn(),
      getFeedbackBundle: vi.fn(),
      resolveComment: vi.fn(),
      createComment: vi.fn(),
      addReply: vi.fn(),
      editComment: vi.fn(),
      deleteComment: vi.fn(),
      uploadVersion: vi.fn(),
      requestReview: vi.fn(),
      revokeReviewRequest: vi.fn(),
      submitReviewVerdict: vi.fn(),
      listShares: vi.fn(),
      searchDocuments: vi.fn(),
      acceptSuggestion: vi.fn(),
    },
  };
});

// jsdom has no matchMedia or scrollIntoView — viewer.tsx checks
// `(pointer: coarse)` on mount, and scrolls the selected anchor mark into
// view, neither of which jsdom implements.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Element.prototype.scrollIntoView = vi.fn();
});

function doc(overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: 'd1',
    projectId: null,
    ownerId: 'owner1',
    title: 'My Document',
    currentVersionId: 'v2',
    archivedAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    myPermission: 'read',
    path: null,
    ...overrides,
  };
}

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'c1',
    documentId: 'd1',
    versionId: 'v2',
    authorId: 'u2',
    body: 'Please fix the wording here.',
    anchor: { type: 'text', exact: 'wording', prefix: '', suffix: '', start: 7, end: 14 },
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    viaApiKeyName: null,
    kind: 'comment',
    proposedText: null,
    suggestionOutcome: null,
    appliedVersionId: null,
    ...overrides,
  };
}

function thread(resolution: ResolutionDto, overrides: Partial<CommentDto> = {}): ThreadDto {
  return {
    comment: comment(overrides),
    replies: [],
    resolution,
    upvotes: { count: 0, mine: false },
    mentions: [],
  };
}

function review(overrides: Partial<ReviewDto> = {}): ReviewDto {
  return {
    status: 'in_review',
    gate: 'soft',
    openCommentCount: 0,
    requests: [],
    approvals: [],
    ...overrides,
  };
}

const me: Me = { userId: 'u1', orgId: 'org1', role: 'member' };
const SOURCE = 'Please fix the wording here. It reads oddly today.';

function projectTree(overrides: Partial<ProjectTreeDto> = {}): ProjectTreeDto {
  return {
    projectId: 'p1',
    tooLarge: false,
    documentCount: 0,
    documents: [],
    ...overrides,
  };
}

interface RenderOpts {
  meOverrides?: Partial<Me>;
  docOverrides?: Partial<DocumentDto>;
  threads?: ThreadDto[];
  reviewOverrides?: Partial<ReviewDto> | null;
  deepLinkCommentId?: string | null;
  versions?: VersionDto[];
  orgUsers?: OrgUserDto[];
  source?: string;
  projectTree?: ProjectTreeDto;
  onOpenDocument?: (id: string) => void;
}

function renderViewer(opts: RenderOpts = {}): void {
  const {
    meOverrides = {},
    docOverrides = {},
    threads = [],
    reviewOverrides,
    deepLinkCommentId = null,
    versions,
    source = SOURCE,
  } = opts;
  vi.mocked(api.getDocument).mockResolvedValue(doc(docOverrides));
  vi.mocked(api.getDocumentContent).mockResolvedValue(source);
  // filter === null also fetches the 'resolved' bucket in the background
  // (see viewer.tsx's resolvedThreads effect) — keep it empty so it never
  // duplicates the 'open' fixture threads by id.
  vi.mocked(api.listThreads).mockImplementation((_documentId, status) =>
    Promise.resolve(
      status === 'resolved'
        ? { threads: [], nextCursor: null, counts: { open: 0, resolved: 0 } }
        : {
            threads,
            nextCursor: null,
            counts: {
              open: threads.filter((t) => t.comment.status === 'open').length,
              resolved: 0,
            },
          },
    ),
  );
  vi.mocked(api.listVersions).mockResolvedValue({
    versions: versions ?? [
      {
        id: 'v2',
        seq: 2,
        source: 'web',
        createdBy: 'owner1',
        createdAt: '2026-07-01T00:00:00Z',
        purgedAt: null,
        viaApiKeyName: null,
        changeNote: null,
      },
    ],
    currentVersionId: 'v2',
  });
  vi.mocked(api.listOrgUsers).mockResolvedValue({ users: opts.orgUsers ?? [], nextCursor: null });
  vi.mocked(api.searchDocuments).mockResolvedValue({ hits: [], commentHits: [] });
  vi.mocked(api.listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(api.listDocuments).mockResolvedValue({ documents: [] });
  vi.mocked(api.getProjectTree).mockResolvedValue(opts.projectTree ?? projectTree());
  if (reviewOverrides === null) {
    vi.mocked(api.getReview).mockRejectedValue(new Error('no review access'));
  } else {
    vi.mocked(api.getReview).mockResolvedValue(review(reviewOverrides));
  }

  render(
    <Viewer
      documentId="d1"
      deepLinkCommentId={deepLinkCommentId}
      me={{ ...me, ...meOverrides }}
      dark={false}
      mode="light"
      setMode={vi.fn()}
      onBack={vi.fn()}
      {...(opts.onOpenDocument ? { onOpenDocument: opts.onOpenDocument } : {})}
    />,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Viewer — selected-anchor highlighting', () => {
  it('promotes every mark fragment of the selected anchor, not just the first', async () => {
    // An anchor crossing **bold** markup renders as multiple <mark>
    // elements (one per leaf: "Plain ", "bold", " tail text here." — see
    // anchors/highlight.ts's structural path). deepLinkCommentId selects
    // the thread on mount, exercising the same effect a rail/bubble click
    // does.
    renderViewer({
      source: 'Plain **bold** tail text here.',
      threads: [
        thread(
          { method: 'exact', confidence: 1, start: 0, end: 'Plain **bold** tail'.length },
          { id: 'c1' },
        ),
      ],
      deepLinkCommentId: 'c1',
    });
    await screen.findByText(/text here/);
    const marks = document.querySelectorAll('mark[data-comment-id="c1"]');
    expect(marks.length).toBeGreaterThan(1);
    for (const mark of marks) {
      expect(mark.className).toContain('anchor-mark--selected');
    }
  });
});

describe('Viewer — re-anchor confidence badge language (ADR 0003 §F.2)', () => {
  it('shows plain-language "Moved" text, not a percentage, for the 0.6-0.9 band', async () => {
    renderViewer({
      threads: [thread({ method: 'fuzzy', confidence: 0.75, start: 7, end: 14 })],
    });
    const badge = await screen.findByText('Moved — check this still fits');
    expect(badge.textContent).not.toMatch(/%/);
    expect(badge.title).toBe('Re-anchored on the current version · 75%');
  });

  it('renders no badge at all once confidence reaches 0.9', async () => {
    renderViewer({
      threads: [thread({ method: 'context', confidence: 0.92, start: 7, end: 14 })],
    });
    await screen.findByText(/reads oddly today/);
    expect(screen.queryByText(/Moved/)).toBeNull();
    expect(screen.queryByText(/re-anchored/i)).toBeNull();
  });
});

describe('Viewer — keyboard shortcuts popover (ADR 0003 §F.4)', () => {
  it('stays closed by default, costing no permanent rail space', async () => {
    renderViewer({
      threads: [thread({ method: 'exact', confidence: 1, start: 0, end: 6 })],
    });
    await screen.findByText(/reads oddly today/);
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('opens exactly one shortcuts popover from its trigger button', async () => {
    renderViewer({
      threads: [thread({ method: 'exact', confidence: 1, start: 0, end: 6 })],
    });
    await screen.findByText(/reads oddly today/);
    await userEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const popovers = await screen.findAllByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(popovers).toHaveLength(1);
    expect(popovers[0]?.textContent).toContain('walk comments');
  });
});

describe('Viewer — path breadcrumb (Phase 29)', () => {
  it('shows the folder trail above the title for a path-backed document', async () => {
    renderViewer({ docOverrides: { path: 'docs/specs/auth.md' } });
    const breadcrumb = await screen.findByTestId('breadcrumb');
    expect(breadcrumb.textContent).toContain('docs');
    expect(breadcrumb.textContent).toContain('specs');
    expect(breadcrumb.textContent).not.toContain('auth.md');
  });

  it('renders no breadcrumb for a document with no repo origin (path: null)', async () => {
    renderViewer({ docOverrides: { path: null } });
    await screen.findByText(/reads oddly today/);
    expect(screen.queryByTestId('breadcrumb')).toBeNull();
  });
});

describe('Viewer — quiet marks default for non-editing readers (ADR 0003 §F.5)', () => {
  it('applies viewer-content--quiet-marks for a read-only user before the rail opens', async () => {
    renderViewer({ docOverrides: { myPermission: 'read' } });
    const content = await screen.findByTestId('viewer-content');
    expect(content.className).toContain('viewer-content--quiet-marks');
  });

  it('removes the quiet-marks class once the rail is opened', async () => {
    renderViewer({ docOverrides: { myPermission: 'read' } });
    const content = await screen.findByTestId('viewer-content');
    expect(content.className).toContain('viewer-content--quiet-marks');
    await userEvent.click(screen.getByRole('button', { name: 'Show comments' }));
    await waitFor(() => {
      expect(content.className).not.toContain('viewer-content--quiet-marks');
    });
  });

  it('never applies quiet-marks for an editor', async () => {
    renderViewer({ docOverrides: { myPermission: 'edit' } });
    const content = await screen.findByTestId('viewer-content');
    expect(content.className).not.toContain('viewer-content--quiet-marks');
  });

  it('starts without quiet-marks when a mark is already selected via deep link', async () => {
    renderViewer({
      docOverrides: { myPermission: 'comment' },
      threads: [thread({ method: 'exact', confidence: 1, start: 0, end: 6 }, { id: 'c1' })],
      deepLinkCommentId: 'c1',
    });
    const content = await screen.findByTestId('viewer-content');
    await waitFor(() => {
      expect(content.className).not.toContain('viewer-content--quiet-marks');
    });
  });
});

describe('Viewer — single primary action in the header for read/comment users (ADR 0003 §F.6)', () => {
  it('makes "Add comment" primary when the user is not a pending reviewer', async () => {
    renderViewer({ docOverrides: { myPermission: 'comment' } });
    const addComment = await screen.findByRole('button', { name: /Add comment/ });
    expect(addComment.className).toContain('btn-primary');
  });

  it('makes the verdict action primary instead, for a requested reviewer with a pending verdict', async () => {
    renderViewer({
      docOverrides: { myPermission: 'comment' },
      reviewOverrides: {
        requests: [
          {
            id: 'r1',
            reviewerUserId: me.userId,
            reviewerName: 'Ada',
            reviewerEmail: 'ada@example.com',
            requestedBy: 'owner1',
            createdAt: '2026-07-01T00:00:00Z',
          },
        ],
      },
    });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve.className).toContain('btn-primary');
    const addComment = screen.getByRole('button', { name: /Add comment/ });
    expect(addComment.className).not.toContain('btn-primary');
  });

  it('never makes "Add comment" primary for an editor — owner/admin chrome is unchanged', async () => {
    renderViewer({ docOverrides: { myPermission: 'edit' } });
    const addComment = await screen.findByRole('button', { name: /Add comment/ });
    expect(addComment.className).not.toContain('btn-primary');
  });
});

describe('Viewer — Copy feedback hidden from guests', () => {
  it('shows Copy feedback for a regular member', async () => {
    renderViewer({ docOverrides: { myPermission: 'comment' } });
    await screen.findByRole('button', { name: /Add comment/ });
    expect(screen.getByRole('button', { name: /Copy feedback/ })).toBeDefined();
  });

  it('hides Copy feedback for a guest, even with open comments', async () => {
    renderViewer({
      meOverrides: { role: 'guest' },
      docOverrides: { myPermission: 'comment' },
      threads: [thread({ method: 'exact', confidence: 1, start: 0, end: 6 })],
      reviewOverrides: null,
    });
    await waitFor(() => {
      expect(api.getDocument).toHaveBeenCalled();
    });
    await screen.findByText(/1 open/);
    expect(screen.queryByRole('button', { name: /Copy feedback/ })).toBeNull();
  });
});

describe('Viewer — version notes (ADR 0003 §B)', () => {
  function versionsWithNote(): VersionDto[] {
    return [
      {
        id: 'v1',
        seq: 1,
        source: 'web',
        createdBy: 'owner1',
        createdAt: '2026-07-01T00:00:00Z',
        purgedAt: null,
        viaApiKeyName: null,
        changeNote: 'Reworked the intro',
      },
      {
        id: 'v2',
        seq: 2,
        source: 'web',
        createdBy: 'owner1',
        createdAt: '2026-07-02T00:00:00Z',
        purgedAt: null,
        viaApiKeyName: null,
        changeNote: null,
      },
    ];
  }

  it('appends the viewed version note to the read-only banner', async () => {
    vi.mocked(api.getVersionContent).mockResolvedValue('Earlier source.');
    renderViewer({ versions: versionsWithNote() });
    const chip = await screen.findByRole('button', { name: 'v1' });
    await userEvent.click(chip);
    // Scoped to the banner itself, not a bare substring match — clicking the
    // chip also opens its own Tooltip (versionTitle includes the same
    // change note), so a page-wide getByText(/Reworked the intro/) would now
    // match twice.
    const banner = await screen.findByText(/Viewing v1/);
    expect(banner.textContent).toContain('Reworked the intro');
  });

  it('sends the "what changed?" note through the version upload', async () => {
    vi.mocked(api.uploadVersion).mockResolvedValue({ document: doc() });
    renderViewer({ docOverrides: { myPermission: 'edit' } });
    await screen.findByTestId('version-upload-button');

    const input = screen.getByTestId('version-file-input');
    const file = new File(['# Next leg'], 'next.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = await screen.findByTestId('confirm-dialog');
    await userEvent.type(
      screen.getByPlaceholderText('e.g. Reworked the intro'),
      'Tightened the spec',
    );
    await userEvent.click(dialog.querySelector<HTMLButtonElement>('.btn-primary')!);

    await waitFor(() => {
      expect(api.uploadVersion).toHaveBeenCalledWith('d1', '# Next leg', 'Tightened the spec');
    });
  });
});

describe('Viewer — @mention highlight in the rail (ADR 0003 §C/§D)', () => {
  it('marks a stored @mention in the comment body, leaving a non-mention plain', async () => {
    const t: ThreadDto = {
      ...thread(
        { method: 'exact', confidence: 1, start: 7, end: 14 },
        {
          body: 'cc @JaneDoe and @ghost',
        },
      ),
      mentions: [{ userId: 'u2', displayName: 'Jane Doe' }],
    };
    renderViewer({ threads: [t] });

    const mark = await screen.findByTestId('mention');
    expect(mark.textContent).toBe('@JaneDoe');
    // @ghost never resolved to a mention, so it is not highlighted.
    expect(screen.getAllByTestId('mention')).toHaveLength(1);
  });
});

describe('Viewer — in-rail comment search (ADR 0003 §C)', () => {
  function manyThreads(): ThreadDto[] {
    return Array.from({ length: 9 }, (_, i) => ({
      ...thread(
        { method: 'exact', confidence: 1, start: 7, end: 14 },
        {
          id: `c${String(i)}`,
          body: i === 3 ? 'the banana section needs work' : `note number ${String(i)}`,
        },
      ),
      mentions: [],
    }));
  }

  it('shows the search box only once the rail is busy (> 8 threads)', async () => {
    renderViewer({ threads: [thread({ method: 'exact', confidence: 1, start: 7, end: 14 })] });
    await screen.findByText(/reads oddly today/);
    expect(screen.queryByLabelText('Search comments')).toBeNull();

    cleanup();
    renderViewer({ threads: manyThreads() });
    await screen.findByText(/reads oddly today/);
    expect(screen.getByLabelText('Search comments')).toBeDefined();
  });

  it('filters the loaded threads client-side as you type', async () => {
    renderViewer({ threads: manyThreads() });
    await screen.findByText('the banana section needs work');
    expect(screen.getByText('note number 1')).toBeDefined();

    await userEvent.type(screen.getByLabelText('Search comments'), 'banana');
    await waitFor(() => {
      expect(screen.queryByText('note number 1')).toBeNull();
    });
    expect(screen.getByText('the banana section needs work')).toBeDefined();
  });

  it('surfaces a count of matches that live outside the loaded threads', async () => {
    renderViewer({ threads: manyThreads() });
    await screen.findByText('the banana section needs work');
    // Set after render — renderViewer installs an empty default for searchDocuments.
    vi.mocked(api.searchDocuments).mockResolvedValue({
      hits: [],
      commentHits: [
        {
          commentId: 'resolved-1',
          documentId: 'd1',
          documentTitle: 'My Document',
          snippet: 'banana',
          anchor: { type: 'document' },
          versionId: 'v2',
          status: 'resolved',
          authorId: 'u2',
          createdAt: '2026-07-01T00:00:00Z',
          rank: 1,
        },
      ],
    });
    await userEvent.type(screen.getByLabelText('Search comments'), 'banana');
    expect(await screen.findByText(/1 more matching comment/)).toBeDefined();
  });
});

describe('Viewer — accepted-pending suggestion overlay (ADR 0007 decision 6)', () => {
  // SOURCE.slice(15, 22) === 'wording'.
  function acceptedPendingThread(overrides: Partial<CommentDto> = {}): ThreadDto {
    return thread(
      { method: 'exact', confidence: 1, start: 15, end: 22 },
      {
        id: 'c1',
        kind: 'suggestion',
        suggestionOutcome: 'accepted',
        appliedVersionId: null,
        proposedText: 'phrasing',
        ...overrides,
      },
    );
  }

  it('gets the accepted-pending mark class, not open/replied/resolved', async () => {
    renderViewer({ threads: [acceptedPendingThread()] });
    await screen.findByText(/reads oddly today/);
    const mark = document.querySelector('mark[data-comment-id="c1"]');
    expect(mark?.className).toContain('anchor-mark--accepted-pending');
    expect(mark?.className).not.toContain('anchor-mark--open');
    expect(mark?.className).not.toContain('anchor-mark--resolved');
  });

  it('an accepted-and-applied suggestion does not get the accepted-pending treatment', async () => {
    renderViewer({
      threads: [acceptedPendingThread({ id: 'c2', appliedVersionId: 'v2' })],
    });
    await screen.findByText(/reads oddly today/);
    const mark = document.querySelector('mark[data-comment-id="c2"]');
    expect(mark?.className).not.toContain('anchor-mark--accepted-pending');
  });

  it('a plain comment is unaffected', async () => {
    renderViewer({
      threads: [thread({ method: 'exact', confidence: 1, start: 15, end: 22 }, { id: 'c3' })],
    });
    await screen.findByText(/reads oddly today/);
    const mark = document.querySelector('mark[data-comment-id="c3"]');
    expect(mark?.className).toContain('anchor-mark--open');
    expect(mark?.className).not.toContain('anchor-mark--accepted-pending');
  });

  it('an open suggestion is unaffected', async () => {
    renderViewer({
      threads: [
        thread(
          { method: 'exact', confidence: 1, start: 15, end: 22 },
          { id: 'c4', kind: 'suggestion', suggestionOutcome: 'open', proposedText: 'phrasing' },
        ),
      ],
    });
    await screen.findByText(/reads oddly today/);
    const mark = document.querySelector('mark[data-comment-id="c4"]');
    expect(mark?.className).toContain('anchor-mark--open');
    expect(mark?.className).not.toContain('anchor-mark--accepted-pending');
  });

  it('clicking the mark expands an inline strike+insert overlay in the body, and clicking again collapses it', async () => {
    renderViewer({ threads: [acceptedPendingThread()] });
    await screen.findByText(/reads oddly today/);
    expect(document.querySelector('.anchor-suggestion-overlay')).toBeNull();

    const mark = document.querySelector('mark[data-comment-id="c1"]');
    expect(mark).not.toBeNull();
    fireEvent.click(mark!);

    const overlay = await waitFor(() => {
      const el = document.querySelector('.anchor-suggestion-overlay');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(overlay.querySelector('del')?.textContent).toBe('wording');
    expect(overlay.querySelector('ins')?.textContent).toBe('phrasing');

    // Clicking the (now re-rendered) mark again collapses it.
    const markAgain = document.querySelector('mark[data-comment-id="c1"]');
    fireEvent.click(markAgain!);
    await waitFor(() => {
      expect(document.querySelector('.anchor-suggestion-overlay')).toBeNull();
    });
  });

  it('the card toggle drives the same shared expand state as the body mark', async () => {
    renderViewer({ threads: [acceptedPendingThread()] });
    await screen.findByText(/reads oddly today/);

    const toggle = document.querySelector<HTMLElement>('.suggestion-status')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(document.querySelector('.anchor-suggestion-overlay')).not.toBeNull();
    });

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelector('.anchor-suggestion-overlay')).toBeNull();
    });
  });
});

describe('Viewer — edit vs manage split (ADR 0008, ADR 0014)', () => {
  it('gives an edit grantee both the upload and the share affordance — edit inherits share by lattice (ADR 0014)', async () => {
    // Not the owner (ownerId is 'owner1', me is 'u1') and not an admin — the
    // exact actor ADR 0008 created, now also a `canShare` holder since
    // ADR 0014 made `edit` inherit `share`.
    renderViewer({ docOverrides: { myPermission: 'edit' } });
    await screen.findByTestId('version-upload-button');
    expect(screen.getByRole('button', { name: 'Share this document' })).toBeDefined();
  });

  it('gives a share-level grantee the share affordance but not the upload one', async () => {
    renderViewer({ docOverrides: { myPermission: 'share' } });
    await screen.findByRole('button', { name: 'Share this document' });
    expect(screen.queryByTestId('version-upload-button')).toBeNull();
  });

  it('gives the document owner both', async () => {
    renderViewer({ docOverrides: { myPermission: 'edit', ownerId: me.userId } });
    await screen.findByTestId('version-upload-button');
    expect(screen.getByRole('button', { name: 'Share this document' })).toBeDefined();
  });

  it('gives an org admin both, without owning the document', async () => {
    renderViewer({
      meOverrides: { role: 'admin' },
      docOverrides: { myPermission: 'edit' },
    });
    await screen.findByTestId('version-upload-button');
    expect(screen.getByRole('button', { name: 'Share this document' })).toBeDefined();
  });

  it('gives a comment-level user neither', async () => {
    renderViewer({ docOverrides: { myPermission: 'comment' } });
    await screen.findByRole('button', { name: /Add comment/ });
    expect(screen.queryByTestId('version-upload-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share this document' })).toBeNull();
  });
});

describe('Viewer — full-surface drop zone', () => {
  function filesDataTransfer(files: File[]): Record<string, unknown> {
    return { dataTransfer: { types: ['Files'], files } };
  }

  it('dropping a file onto the viewer body opens the confirm dialog, and confirming ships it', async () => {
    vi.mocked(api.uploadVersion).mockResolvedValue({ document: doc() });
    renderViewer({ docOverrides: { myPermission: 'edit' } });
    const body = await screen.findByTestId('viewer-body');

    const file = new File(['# Next leg'], 'next.md', { type: 'text/markdown' });
    fireEvent.dragEnter(body, filesDataTransfer([file]));
    fireEvent.drop(body, filesDataTransfer([file]));

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('next.md');
    await userEvent.click(dialog.querySelector<HTMLButtonElement>('.btn-primary')!);

    await waitFor(() => {
      expect(api.uploadVersion).toHaveBeenCalledWith('d1', '# Next leg', null);
    });
  });

  it('shows the drop overlay with viewer-specific copy while dragging over the body', async () => {
    renderViewer({ docOverrides: { myPermission: 'edit' } });
    const body = await screen.findByTestId('viewer-body');
    expect(screen.queryByTestId('dropzone')).toBeNull();
    fireEvent.dragEnter(body, filesDataTransfer([]));
    expect(screen.getByTestId('dropzone')).toBeDefined();
    expect(screen.getByText('Drop to ship a new version')).toBeDefined();
  });

  it('never shows the drop overlay for a read-only viewer', async () => {
    renderViewer({ docOverrides: { myPermission: 'read' } });
    const body = await screen.findByTestId('viewer-body');
    fireEvent.dragEnter(body, filesDataTransfer([]));
    expect(screen.queryByTestId('dropzone')).toBeNull();
  });
});

describe('Viewer — API error copy', () => {
  function filesDataTransfer(files: File[]): Record<string, unknown> {
    return { dataTransfer: { types: ['Files'], files } };
  }

  it('shows readable copy for a failed action, never the raw error code', async () => {
    vi.mocked(api.uploadVersion).mockRejectedValue(new ApiError(403, 'version_cap_exceeded'));
    renderViewer({ docOverrides: { myPermission: 'edit' } });
    const body = await screen.findByTestId('viewer-body');

    const file = new File(['# Next leg'], 'next.md', { type: 'text/markdown' });
    fireEvent.dragEnter(body, filesDataTransfer([file]));
    fireEvent.drop(body, filesDataTransfer([file]));
    const dialog = await screen.findByTestId('confirm-dialog');
    await userEvent.click(dialog.querySelector<HTMLButtonElement>('.btn-primary')!);

    expect(
      await screen.findByText(
        'This document is at its version limit — older versions age out automatically, or upgrade for a higher ceiling.',
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Request failed/)).toBeNull();
    expect(screen.queryByText(/version_cap_exceeded/)).toBeNull();
  });

  it('keeps the suggestion-gate wording now that it comes from the shared map', async () => {
    vi.mocked(api.acceptSuggestion).mockRejectedValue(new ApiError(409, 'suggestion_not_open'));
    renderViewer({
      // Owner, so accept/reject render at all (canManage).
      docOverrides: { ownerId: 'u1' },
      threads: [
        thread(
          { method: 'exact', confidence: 1, start: 7, end: 14 },
          { kind: 'suggestion', proposedText: 'phrasing', suggestionOutcome: 'open' },
        ),
      ],
    });
    await userEvent.click(await screen.findByRole('button', { name: /Accept/ }));
    expect(
      await screen.findByText('This suggestion was already resolved — refresh to see its outcome.'),
    ).toBeDefined();
  });
});

describe('Viewer — document render resilience', () => {
  it('keeps the page usable and shows the source when the document cannot render', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderViewer({ source: '__BOOM__ the document body text' });

    expect(
      await screen.findByText(
        "This document couldn't be displayed — here is its source. Commenting is unavailable until it renders.",
      ),
    ).toBeDefined();
    // The words are still there…
    expect(screen.getByRole('alert').textContent).toContain('the document body text');
    // …and so is everything around them: this used to blank the whole SPA down
    // to the reload prompt, taking the rail and header with it.
    expect(screen.getByText('My Document')).toBeDefined();
    expect(screen.getByTestId('viewer-body')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    spy.mockRestore();
  });
});

describe('Viewer — document switcher (Phase 33.E)', () => {
  function siblingDocs() {
    return [
      {
        id: 'd1',
        title: 'My Document',
        path: 'docs/my-document.md',
        openCommentCount: 0,
        reviewStatus: 'draft' as const,
      },
      {
        id: 'd2',
        title: 'Sibling Doc',
        path: 'docs/sibling-doc.md',
        openCommentCount: 2,
        reviewStatus: 'in_review' as const,
      },
    ];
  }

  it('renders the sibling tree, not a flat title-only list, and marks the current document', async () => {
    renderViewer({
      docOverrides: { projectId: 'p1' },
      projectTree: projectTree({ documentCount: 2, documents: siblingDocs() }),
      onOpenDocument: vi.fn(),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'My Document' }));

    // The embedded tree renders the sibling's open-comment chip — a flat
    // title-only list (the old listDocuments-backed switcher) never showed
    // this signal at all.
    expect(await screen.findByText('Sibling Doc')).toBeDefined();
    expect(screen.getByText('2 open')).toBeDefined();
  });

  it('opens a sibling document via onOpenDocument and closes the popover', async () => {
    const onOpenDocument = vi.fn();
    renderViewer({
      docOverrides: { projectId: 'p1' },
      projectTree: projectTree({ documentCount: 2, documents: siblingDocs() }),
      onOpenDocument,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'My Document' }));
    await userEvent.click(await screen.findByText('Sibling Doc'));

    expect(onOpenDocument).toHaveBeenCalledWith('d2');
    expect(screen.queryByText('Sibling Doc')).toBeNull();
  });

  it('closes on Escape', async () => {
    renderViewer({
      docOverrides: { projectId: 'p1' },
      projectTree: projectTree({ documentCount: 2, documents: siblingDocs() }),
      onOpenDocument: vi.fn(),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'My Document' }));
    expect(await screen.findByText('Sibling Doc')).toBeDefined();

    fireEvent.keyDown(window.document, { key: 'Escape' });
    expect(screen.queryByText('Sibling Doc')).toBeNull();
  });

  it('shows an honest too-large fallback instead of an empty or broken tree', async () => {
    renderViewer({
      docOverrides: { projectId: 'p1' },
      projectTree: projectTree({ documentCount: 2_500, tooLarge: true, documents: [] }),
      onOpenDocument: vi.fn(),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'My Document' }));

    expect(await screen.findByText(/2500 documents — too many to browse here/)).toBeDefined();
  });

  it('does not offer the switcher at all for a single-document project', async () => {
    renderViewer({
      docOverrides: { projectId: 'p1' },
      projectTree: projectTree({ documentCount: 1, documents: [siblingDocs()[0]!] }),
      onOpenDocument: vi.fn(),
    });
    await screen.findByText('My Document');
    expect(screen.queryByRole('button', { name: 'My Document' })).toBeNull();
  });
});
