import { prisma } from './prisma.ts';

export type AttachmentSource = 'messenger' | 'sms' | 'unknown';

const ATTACHMENT_HISTORY_LIMIT = 6;

function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function recordLeadAttachments(
  leadId: string,
  urls: string[],
  source: AttachmentSource,
): Promise<string[]> {
  const sanitized = Array.from(
    new Set(
      urls
        .filter((url) => typeof url === 'string')
        .map((url) => url.trim())
        .filter((url) => url.length > 0 && isHttpsUrl(url)),
    ),
  );

  if (sanitized.length === 0) {
    return listRecentAttachments(leadId);
  }

  await prisma.leadAttachment.createMany({
    data: sanitized.map((url) => ({
      leadId,
      url,
      source,
    })),
    skipDuplicates: true,
  });

  return listRecentAttachments(leadId);
}

export async function listRecentAttachments(
  leadId: string,
  limit: number = ATTACHMENT_HISTORY_LIMIT,
): Promise<string[]> {
  const records = await prisma.leadAttachment.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return records.map((record) => record.url);
}
