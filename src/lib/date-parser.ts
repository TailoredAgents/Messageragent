import { DateTime } from 'luxon';

import { getOpenAIClient } from './openai.ts';

const DATETIME_MODEL =
  process.env.DATETIME_MODEL ?? process.env.AGENT_MODEL ?? 'gpt-4.1-mini';

type ParsedResult = {
  normalized_iso: string | null;
  notes?: string | null;
  confidence?: number;
};

export async function resolvePreferredDateTime(
  phrase: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const trimmed = phrase.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const client = getOpenAIClient();
    const response = await client.responses.create({
      model: DATETIME_MODEL,
      input: [
        {
          role: 'system',
          content:
            'You convert natural language scheduling requests into ISO 8601 datetimes. ' +
            'Return a timestamp within the provided timezone. If the phrase is ambiguous, pick the soonest future interpretation.',
        },
        {
          role: 'user',
          content: `Current time in ${timeZone}: ${DateTime.fromJSDate(now)
            .setZone(timeZone)
            .toISO()}. Phrase: "${trimmed}". Respond with JSON.`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'datetime_parse',
          schema: {
            type: 'object',
            properties: {
              normalized_iso: { type: ['string', 'null'] },
              notes: { type: ['string', 'null'], default: null },
              confidence: { type: 'number', default: 0.5 },
            },
            required: ['normalized_iso'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    });

    const jsonContent = response.output?.[0]?.content?.find(
      (item) => item.type === 'output_json',
    );
    if (!jsonContent || jsonContent.type !== 'output_json') {
      return null;
    }

    const parsed = JSON.parse(jsonContent.json) as ParsedResult;
    if (!parsed.normalized_iso) {
      return null;
    }

    const dt = DateTime.fromISO(parsed.normalized_iso, { zone: timeZone });
    if (!dt.isValid) {
      return null;
    }

    const jsDate = dt.toJSDate();
    if (jsDate.getTime() < now.getTime()) {
      return null;
    }
    return jsDate;
  } catch (error) {
    console.warn('[DateParser] Failed to resolve preferred date', error);
    return null;
  }
}
