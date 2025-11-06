import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let create: ReturnType<typeof vi.fn>;
let getClientSpy: ReturnType<typeof vi.spyOn> | undefined;
let emailModule: Awaited<typeof import('../email-content.ts')>;

describe('email-content', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.EMAIL_MODEL = 'test-email-model';

    create = vi.fn();
    const openaiModule = await import('../openai.ts');
    getClientSpy = vi
      .spyOn(openaiModule, 'getOpenAIClient')
      .mockReturnValue({
        responses: {
          create,
        },
      } as unknown as ReturnType<typeof openaiModule.getOpenAIClient>);

    emailModule = await import('../email-content.ts');
  });

  afterEach(() => {
    getClientSpy?.mockRestore();
  });

  it('generates booking confirmation email payload', async () => {
    create.mockResolvedValue({
      output_text: JSON.stringify({
        subject: 'Booking confirmed',
        text: 'Text email',
        html: '<p>Text email</p>',
      }),
    });

    const result = await emailModule.generateBookingConfirmationEmail({
      leadName: 'Alex',
      companyName: 'Junk Co',
      address: '123 Main St',
      windowStart: new Date('2025-05-01T15:00:00Z'),
      windowEnd: new Date('2025-05-01T17:00:00Z'),
      quoteTotal: 325,
      subtotal: 300,
      lineItems: [
        { label: 'Truck haul', amount: 250 },
        { label: 'Labor', amount: 50 },
      ],
      discounts: [{ label: 'Loyalty', amount: -25 }],
      notes: ['Customer will leave items curbside.'],
      disclaimer: 'Final price may change after onsite inspection.',
      followUpPhone: '555-1212',
      calendarUrl: 'https://example.com/cal.ics',
    });

    expect(result.subject).toBe('Booking confirmed');
    expect(result.text).toBe('Text email');
    expect(result.html).toBe('<p>Text email</p>');

    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0][0];
    expect(call.model).toBe('test-email-model');
    expect(call.input[1].content).toContain('Alex');
    expect(call.input[1].content).toContain('Final price may change');
  });

  it('generates reminder email payload', async () => {
    create.mockResolvedValue({
      output_text: JSON.stringify({
        subject: 'Reminder',
        text: 'Reminder text',
      }),
    });

    const result = await emailModule.generateReminderEmail({
      leadName: 'Sam',
      address: '123 Main St',
      windowStart: new Date('2025-05-02T15:00:00Z'),
      windowEnd: new Date('2025-05-02T17:00:00Z'),
      reminderPhone: '555-9999',
      additionalNotes: 'Crew will arrive in branded truck.',
    });

    expect(result.subject).toBe('Reminder');
    expect(result.text).toBe('Reminder text');

    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0][0];
    expect(call.input[1].content).toContain('Sam');
    expect(call.input[1].content).toContain('Crew will arrive');
  });

  it('throws when response lacks JSON', async () => {
    create.mockResolvedValue({
      output_text: 'not json',
    });

    await expect(
      emailModule.generateReminderEmail({
        windowStart: new Date(),
        windowEnd: new Date(Date.now() + 60 * 60 * 1000),
      }),
    ).rejects.toThrow(/invalid JSON/i);
  });
});
