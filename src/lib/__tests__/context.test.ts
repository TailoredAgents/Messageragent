import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { fetchContextCandidates } from '../context.ts';
import { prisma } from '../prisma.ts';

vi.mock('../prisma.ts', () => ({
  prisma: {
    job: { findMany: vi.fn() },
    lead: { findMany: vi.fn() },
    customerAddress: { findMany: vi.fn() },
    conversation: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

const mockPrisma = prisma as unknown as {
  job: { findMany: ReturnType<typeof vi.fn> };
  lead: { findMany: ReturnType<typeof vi.fn> };
  customerAddress: { findMany: ReturnType<typeof vi.fn> };
};

const DAY_MS = 24 * 60 * 60 * 1000;

describe('fetchContextCandidates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-11-15T12:00:00Z'));
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.customerAddress.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns empty array when customer id missing without hitting the database', async () => {
    const result = await fetchContextCandidates(null, 'anything');
    expect(result).toEqual([]);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findMany).not.toHaveBeenCalled();
  });

  it('returns lead-based candidates when no jobs exist', async () => {
    mockPrisma.lead.findMany.mockResolvedValue([
      {
        id: 'lead-1',
        customerId: 'cust-1',
        address: '55 Oak Street Woodstock GA',
        updatedAt: new Date(Date.now() - DAY_MS),
        createdAt: new Date(Date.now() - 2 * DAY_MS),
        stateMetadata: { category: 'garage' },
      },
    ]);

    const result = await fetchContextCandidates(
      'cust-1',
      'need team back to oak street',
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('lead:lead-1');
    expect(result[0].source).toBe('lead');
  });

  it('prioritizes recent job whose address matches the query tokens', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([
      {
        id: 'addr-1',
        address: '123 Main Street',
        city: 'Woodstock',
        state: 'GA',
        zip: '30188',
      },
      {
        id: 'addr-2',
        address: '88 Fern Lane',
        city: 'Acworth',
        state: 'GA',
        zip: '30102',
      },
    ]);

    mockPrisma.job.findMany.mockResolvedValue([
      makeJob('job-rec', 1, '123 Main Street Woodstock GA', 'garage'),
      makeJob('job-old', 25, '88 Fern Lane Acworth GA', 'shed'),
    ]);

    const results = await fetchContextCandidates(
      'cust-1',
      'can you swing by 123 main st again?',
    );

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('job:job-rec');
    expect(results[0].addressId).toBe('addr-1');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('honors the requested limit when more candidates are available', async () => {
    mockPrisma.job.findMany.mockResolvedValue([
      makeJob('job-a', 2, '1 A St', 'attic'),
      makeJob('job-b', 3, '2 B St', 'garage'),
      makeJob('job-c', 4, '3 C St', 'shed'),
    ]);

    const results = await fetchContextCandidates('cust-1', 'st', 2);
    expect(results).toHaveLength(2);
    const ids = results.map((candidate) => candidate.id);
    expect(ids).toEqual(['job:job-a', 'job:job-b']);
  });
});

function makeJob(
  id: string,
  daysAgo: number,
  address: string,
  category: string,
) {
  const windowStart = new Date(Date.now() - daysAgo * DAY_MS);
  return {
    id,
    leadId: `lead-${id}`,
    customerId: 'cust-1',
    windowStart,
    windowEnd: new Date(windowStart.getTime() + 2 * 60 * 60 * 1000),
    status: 'completed',
    updatedAt: windowStart,
    createdAt: new Date(windowStart.getTime() - DAY_MS),
    lead: {
      id: `lead-${id}`,
      address,
      stateMetadata: { category },
    },
  };
}
