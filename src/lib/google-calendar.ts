import process from 'node:process';

type AccessTokenState = {
  token: string;
  expiresAt: number;
};

let cachedToken: AccessTokenState | null = null;

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

async function refreshAccessToken(): Promise<AccessTokenState> {
  const clientId = getEnv('GOOGLE_CLIENT_ID');
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET');
  const refreshToken = getEnv('GOOGLE_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth env missing (client id/secret/refresh token).');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Google token refresh failed: ${res.status} ${res.statusText} ${detail}`,
    );
  }

  const body = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresIn = Math.max(60, Number(body.expires_in ?? 3600));
  const state: AccessTokenState = {
    token: body.access_token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };
  cachedToken = state;
  return state;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  const refreshed = await refreshAccessToken();
  return refreshed.token;
}

export function calendarFeatureEnabled(): boolean {
  const flag = String(process.env.ENABLE_GOOGLE_CALENDAR ?? 'false')
    .toLowerCase()
    .trim();
  return !['0', 'false', 'no', 'off', ''].includes(flag);
}

export function getCalendarConfig(): { id: string; timeZone: string } | null {
  const id = getEnv('GOOGLE_CALENDAR_ID');
  const tz = getEnv('GOOGLE_CALENDAR_TIMEZONE') ?? 'America/New_York';
  if (!id) return null;
  return { id, timeZone: tz };
}

export type BusyWindow = { start: string; end: string };

export async function queryFreeBusy(
  timeMinIso: string,
  timeMaxIso: string,
  calendarId: string,
  timeZone: string,
): Promise<BusyWindow[]> {
  const token = await getAccessToken();
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }], timeZone }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google freeBusy failed: ${res.status} ${res.statusText} ${detail}`);
  }

  const json = (await res.json()) as {
    calendars: Record<string, { busy?: Array<{ start: string; end: string }> }>;
  };
  return json.calendars?.[calendarId]?.busy ?? [];
}

export async function isWindowFree(
  timeMinIso: string,
  timeMaxIso: string,
  calendarId: string,
  timeZone: string,
): Promise<boolean> {
  const busy = await queryFreeBusy(timeMinIso, timeMaxIso, calendarId, timeZone);
  return busy.length === 0;
}

type CalendarEventInput = {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string | null;
  start: Date;
  end: Date;
  timeZone: string;
  eventId?: string;
  privateExtendedProps?: Record<string, string>;
};

export type CalendarEventInfo = {
  id: string;
  htmlLink?: string;
  iCalUID?: string;
  etag?: string;
};

function sanitizeEventId(seed?: string): string | undefined {
  if (!seed) return undefined;
  const cleaned = seed.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return cleaned.length > 0 ? cleaned.slice(0, 1024) : undefined;
}

export async function upsertCalendarEvent(
  input: CalendarEventInput,
): Promise<CalendarEventInfo> {
  const token = await getAccessToken();
  const eventId = sanitizeEventId(input.eventId);
  const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`;
  const body = {
    summary: input.summary,
    description: input.description,
    location: input.location ?? undefined,
    start: { dateTime: input.start.toISOString(), timeZone: input.timeZone },
    end: { dateTime: input.end.toISOString(), timeZone: input.timeZone },
    extendedProperties: input.privateExtendedProps
      ? { private: input.privateExtendedProps }
      : undefined,
  };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const attemptInsert = async () => {
    const url = new URL(baseUrl);
    if (eventId) {
      url.searchParams.set('eventId', eventId);
    }
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return res;
  };

  let res = await attemptInsert();
  if (res.status === 409 && eventId) {
    // Already exists — update instead.
    res = await fetch(`${baseUrl}/${eventId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Google event upsert failed: ${res.status} ${res.statusText} ${detail}`,
    );
  }

  const event = (await res.json()) as {
    id: string;
    htmlLink?: string;
    iCalUID?: string;
    etag?: string;
  };

  return {
    id: event.id,
    htmlLink: event.htmlLink,
    iCalUID: event.iCalUID,
    etag: event.etag,
  };
}
