// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as clientModule from '../api/client.js';
import { api } from '../api/client.js';
import type { Me, ReviewDto } from '../api/client.js';
import { ReviewControl } from './review-control.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof clientModule>('../api/client.js');
  return {
    ...actual,
    api: {
      getReview: vi.fn(),
      listOrgUsers: vi.fn(),
      listShares: vi.fn(),
      requestReview: vi.fn(),
      revokeReviewRequest: vi.fn(),
      submitReviewVerdict: vi.fn(),
    },
  };
});

const me: Me = { userId: 'u1', orgId: 'org1', role: 'member' };

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

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReviewControl — status chip', () => {
  it('renders nothing while there is no review to show', async () => {
    vi.mocked(api.getReview).mockRejectedValue(new Error('no access'));
    const { container } = render(<ReviewControl documentId="d1" me={me} canManage={false} />);
    await waitFor(() => {
      expect(api.getReview).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('carries the derived status as a chip modifier class', async () => {
    vi.mocked(api.getReview).mockResolvedValue(review({ status: 'changes_requested' }));
    render(<ReviewControl documentId="d1" me={me} canManage={false} />);
    const chip = await screen.findByTitle('Review status');
    expect(chip.className).toContain('review-chip--changes_requested');
  });
});

describe('ReviewControl — single primary action for a requested reviewer (ADR 0003 §F.6)', () => {
  it('marks Approve primary for a reviewer with no verdict yet, and reports pending upward', async () => {
    vi.mocked(api.getReview).mockResolvedValue(
      review({
        requests: [
          {
            id: 'r1',
            reviewerUserId: 'u1',
            reviewerName: 'Ada',
            reviewerEmail: 'ada@example.com',
            requestedBy: 'owner',
            createdAt: '2026-07-01T00:00:00Z',
          },
        ],
      }),
    );
    const onPendingVerdictChange = vi.fn();
    render(
      <ReviewControl
        documentId="d1"
        me={me}
        canManage={false}
        onPendingVerdictChange={onPendingVerdictChange}
      />,
    );
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve.className).toContain('btn-primary');
    await waitFor(() => {
      expect(onPendingVerdictChange).toHaveBeenLastCalledWith(true);
    });
  });

  it('drops Approve back to non-primary once the reviewer has already voted', async () => {
    vi.mocked(api.getReview).mockResolvedValue(
      review({
        status: 'approved',
        requests: [
          {
            id: 'r1',
            reviewerUserId: 'u1',
            reviewerName: 'Ada',
            reviewerEmail: 'ada@example.com',
            requestedBy: 'owner',
            createdAt: '2026-07-01T00:00:00Z',
          },
        ],
        approvals: [
          {
            id: 'a1',
            versionId: 'v1',
            reviewerUserId: 'u1',
            reviewerName: 'Ada',
            reviewerEmail: 'ada@example.com',
            verdict: 'approved',
            note: null,
            createdAt: '2026-07-01T00:00:00Z',
            viaApiKeyName: null,
          },
        ],
      }),
    );
    const onPendingVerdictChange = vi.fn();
    render(
      <ReviewControl
        documentId="d1"
        me={me}
        canManage={false}
        onPendingVerdictChange={onPendingVerdictChange}
      />,
    );
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve.className).not.toContain('btn-primary');
    await waitFor(() => {
      expect(onPendingVerdictChange).toHaveBeenLastCalledWith(false);
    });
  });

  it('reports no pending verdict for a signed-in user who is not a requested reviewer', async () => {
    vi.mocked(api.getReview).mockResolvedValue(review());
    const onPendingVerdictChange = vi.fn();
    render(
      <ReviewControl
        documentId="d1"
        me={me}
        canManage={false}
        onPendingVerdictChange={onPendingVerdictChange}
      />,
    );
    await waitFor(() => {
      expect(onPendingVerdictChange).toHaveBeenLastCalledWith(false);
    });
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
});
