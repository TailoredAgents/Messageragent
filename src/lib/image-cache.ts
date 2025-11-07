import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function downloadToBuffer(url: string): Promise<{ data: Buffer; contentType?: string }> {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') ?? undefined;
  const arrayBuf = await res.arrayBuffer();
  return { data: Buffer.from(arrayBuf), contentType };
}

function pickExtension(contentType?: string): '.jpg' | '.jpeg' | '.png' | '.bin' {
  if (!contentType) return '.bin';
  const ct = contentType.toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('png')) return '.png';
  return '.bin';
}

export async function ensurePublicImageUrls(urls: string[]): Promise<string[]> {
  const toggle = String(process.env.ENABLE_IMAGE_REHOST ?? 'true')
    .toLowerCase()
    .trim();
  if (['0', 'false', 'no', 'off'].includes(toggle)) {
    // Rehosting disabled by env — return originals.
    return urls;
  }
  const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });

  const baseUrl = process.env.BASE_URL;

  const results: string[] = [];
  for (const url of urls) {
    if (!isHttpUrl(url)) {
      continue;
    }
    try {
      const { data, contentType } = await downloadToBuffer(url);
      const hash = createHash('sha256').update(data).digest('hex');
      const ext = pickExtension(contentType);
      const filename = `${hash}${ext}`;
      const filepath = path.join(uploadsDir, filename);
      try {
        await fs.access(filepath);
      } catch {
        await fs.writeFile(filepath, data);
      }

      // We serve /public under /assets/ (see fastify static config)
      const relative = `/assets/uploads/${filename}`;
      const absolute = baseUrl ? `${baseUrl.replace(/\/$/, '')}${relative}` : relative;
      results.push(absolute);
    } catch {
      // If rehosting fails, fall back to original URL
      results.push(url);
    }
  }
  return results;
}
