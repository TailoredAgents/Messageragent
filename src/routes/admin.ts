import { Buffer } from 'node:buffer';

import type { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify/types/reply';
import type { FastifyRequest } from 'fastify/types/request';
import { JobStatus, LeadStage, Prisma, QuoteStatus } from '@prisma/client';
import {
  addDays,
  format,
  formatDistanceToNow,
  startOfDay,
  subDays,
} from 'date-fns';

import { prisma } from '../lib/prisma.ts';

type JsonRecord = Record<string, unknown>;
type StageTone = 'warm' | 'cool' | 'success' | 'neutral';
type MetricDeltaTone = 'positive' | 'negative' | 'neutral';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const stageOrder: LeadStage[] = [
  'awaiting_photos',
  'clarifying',
  'quoting',
  'awaiting_owner',
  'scheduling',
  'booked',
  'reminding',
  'done',
];

const stageMeta: Record<
  LeadStage,
  { label: string; caption: string; tone: StageTone; nextAction: string; trend: string }
> = {
  awaiting_photos: {
    label: 'Awaiting Photos',
    caption: 'Collect address and at least one photo set.',
    tone: 'warm',
    nextAction: 'Send photo reminder with quick replies.',
    trend: 'Focus: confirm curbside for 10% off.',
  },
  clarifying: {
    label: 'Clarifying Details',
    caption: 'Agent is asking follow-up questions.',
    tone: 'warm',
    nextAction: 'Confirm volume class and hazards.',
    trend: 'Keep response time under 5 minutes.',
  },
  quoting: {
    label: 'Quoting',
    caption: 'Pricing tool ready to finalize estimate.',
    tone: 'cool',
    nextAction: 'Call price tool before sharing totals.',
    trend: 'Re-check photos for low confidence.',
  },
  awaiting_owner: {
    label: 'Owner Review',
    caption: 'Quote needs approval before sending.',
    tone: 'warm',
    nextAction: 'Approve or adjust high-cap quotes.',
    trend: 'Keep approvals under 30 minutes.',
  },
  scheduling: {
    label: 'Scheduling',
    caption: 'Pickup windows proposed to customer.',
    tone: 'cool',
    nextAction: 'Confirm selected window and book job.',
    trend: 'Offer two slots inside the 24h window.',
  },
  booked: {
    label: 'Booked',
    caption: 'Job locked in and crew assigned.',
    tone: 'success',
    nextAction: 'Prep crew notes and photo attachments.',
    trend: 'Monitor reminders for no-shows.',
  },
  reminding: {
    label: 'Reminder Ready',
    caption: 'Countdown to the 24h messenger reminder.',
    tone: 'cool',
    nextAction: 'Verify reminder time and contact info.',
    trend: 'Confirm phone saved for day-of contact.',
  },
  done: {
    label: 'Closed',
    caption: 'Job complete - archive or upsell referral.',
    tone: 'neutral',
    nextAction: 'Log crew notes and request review.',
    trend: 'Track repeat customers separately.',
  },
};

function formatCurrency(value: number): string {
  return currencyFormatter.format(Math.max(value, 0));
}

function decimalToNumber(
  value: Prisma.Decimal | number | string | null | undefined,
): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  return Number(value);
}

function toRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 6);
}

function toMoneyEntries(
  value: unknown,
): Array<{ label: string; amount: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as JsonRecord;
      const label =
        typeof record.label === 'string' ? record.label : undefined;
      const amount = decimalToNumber(
        record.amount as Prisma.Decimal | number | string | undefined,
      );
      if (!label) {
        return null;
      }
      return { label, amount };
    })
    .filter(
      (entry): entry is { label: string; amount: number } => entry !== null,
    );
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function extractFlagStrings(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map(humanizeKey)
      .slice(0, 4);
  }
  if (typeof value === 'object') {
    return Object.entries(value as JsonRecord)
      .filter(([, flagValue]) => Boolean(flagValue))
      .map(([flagKey]) => humanizeKey(flagKey))
      .slice(0, 4);
  }
  return [];
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function getGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 11) {
    return 'Good morning';
  }
  if (hour < 16) {
    return 'Good afternoon';
  }
  if (hour < 21) {
    return 'Good evening';
  }
  return 'Welcome back';
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'pending_approval':
      return 'Pending Approval';
    case 'approved':
      return 'Approved';
    case 'denied':
      return 'Denied';
    case 'sent':
      return 'Sent';
    case 'accepted':
      return 'Accepted';
    default:
      return humanizeKey(status);
  }
}

function jobStatusLabel(status: JobStatus): string {
  switch (status) {
    case 'booked':
      return 'Booked';
    case 'tentative':
      return 'Tentative';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return humanizeKey(status);
  }
}

function jobStatusClass(status: JobStatus): 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'booked':
    case 'completed':
      return 'success';
    case 'tentative':
      return 'warning';
    default:
      return 'danger';
  }
}

function determineActivityTone(action: string):
  | 'info'
  | 'success'
  | 'warning'
  | 'danger' {
  if (action.includes('error') || action.includes('failed')) {
    return 'danger';
  }
  if (action.includes('approval') || action.includes('needs_owner')) {
    return 'warning';
  }
  if (action.includes('scheduled') || action.includes('booked')) {
    return 'success';
  }
  return 'info';
}

function buildPayloadSnippet(payload: JsonRecord): string {
  const snippetSource: JsonRecord = { ...payload };
  if (Array.isArray(snippetSource.attachments)) {
    snippetSource.attachments = `${(snippetSource.attachments as unknown[]).length} attachments`;
  }
  const serialized = JSON.stringify(snippetSource);
  return serialized.length > 140
    ? `${serialized.slice(0, 140)}...`
    : serialized;
}

function unauthorized(reply: FastifyReply) {
  reply.header('WWW-Authenticate', 'Basic realm="Admin Area"');
  return reply.code(401).send('Unauthorized');
}

function requireAdminPassword(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const requiredPassword = process.env.ADMIN_PASSWORD;
  if (!requiredPassword) {
    return true;
  }

  const header = request.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    unauthorized(reply);
    return false;
  }

  const base64Credentials = header.split(' ')[1] ?? '';
  const decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [, password] = decoded.split(':');

  if (password !== requiredPassword) {
    unauthorized(reply);
    return false;
  }
  return true;
}

export async function adminRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin',
    async (request, reply) => {
      if (!requireAdminPassword(request, reply)) {
        return;
      }

      const now = new Date();
      const [leadsRaw, approvalsRaw, auditsRaw] = await Promise.all([
        prisma.lead.findMany({
          orderBy: { updatedAt: 'desc' },
          include: {
            quotes: { orderBy: { createdAt: 'desc' } },
            jobs: { orderBy: { windowStart: 'asc' } },
          },
        }),
        prisma.approval.findMany({
          where: { status: 'pending' },
          orderBy: { createdAt: 'asc' },
          include: { quote: { include: { lead: true } } },
        }),
        prisma.audit.findMany({
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      const attachmentsByLead = new Map<string, string[]>();
      const auditRecords = auditsRaw.map((audit) => {
        const payload = toRecord(audit.payload);
        const attachments = toStringArray((payload as JsonRecord).attachments);
        if (audit.leadId && attachments.length > 0) {
          const existing = attachmentsByLead.get(audit.leadId) ?? [];
          const merged = [...existing, ...attachments].slice(0, 6);
          attachmentsByLead.set(audit.leadId, merged);
        }
        return {
          id: audit.id,
          leadId: audit.leadId,
          actor: audit.actor,
          action: audit.action,
          payload,
          attachments,
          createdAt: audit.createdAt,
        };
      });

      const leadsNormalized = leadsRaw.map((lead) => {
        const stageInfo = stageMeta[lead.stage];
        const quotes = lead.quotes.map((quote) => {
          const total = decimalToNumber(quote.total);
          const confidence = decimalToNumber(quote.confidence);
          return {
            id: quote.id,
            total,
            totalDisplay: formatCurrency(total),
            confidence,
            confidenceDisplay: formatConfidence(confidence),
            status: quote.status,
            statusLabel: quoteStatusLabel(quote.status),
            needsApproval: quote.needsApproval,
            lineItems: toMoneyEntries(quote.lineItemsJson),
            discounts: toMoneyEntries(quote.discountsJson),
            notes: toStringArray(quote.notesJson),
            createdAt: quote.createdAt,
            updatedAt: quote.updatedAt,
          };
        });

        const attachments = attachmentsByLead.get(lead.id) ?? [];
        const contactParts: string[] = [];
        if (lead.phone) {
          contactParts.push(lead.phone);
        }
        if (lead.email) {
          contactParts.push(lead.email);
        }
        if (lead.messengerPsid) {
          contactParts.push(`Messenger ${lead.messengerPsid.slice(-6)}`);
        }
        if (contactParts.length === 0) {
          contactParts.push('No contact info yet');
        }

        const jobs = lead.jobs.map((job) => {
          const statusClass = jobStatusClass(job.status);
          const windowLabel = `${format(
            job.windowStart,
            'EEE, MMM d @ p',
          )} - ${format(job.windowEnd, 'p')}`;
          return {
            id: job.id,
            windowStart: job.windowStart,
            windowEnd: job.windowEnd,
            status: job.status,
            statusLabel: jobStatusLabel(job.status),
            statusClass,
            reminderStatus: job.reminderSentAt
              ? `Reminder sent ${formatDistanceToNow(job.reminderSentAt, {
                  addSuffix: true,
                })}`
              : job.reminderScheduledAt
              ? `Reminder set for ${format(
                  job.reminderScheduledAt,
                  'MMM d, p',
                )}`
              : 'Reminder not scheduled',
            windowLabel,
            windowLabelShort: format(job.windowStart, 'EEE, MMM d'),
            windowRelative: formatDistanceToNow(job.windowStart, {
              addSuffix: true,
            }),
            address: lead.address,
          };
        });

        return {
          id: lead.id,
          displayName: lead.name ?? 'Messenger Lead',
          channel: lead.channel,
          channelLabel: lead.channel === 'messenger' ? 'Messenger' : 'SMS',
          stage: lead.stage,
          stageLabel: stageInfo.label,
          stageTone: stageInfo.tone,
          stageCaption: stageInfo.caption,
          nextAction: stageInfo.nextAction,
          updatedAt: lead.updatedAt,
          updatedAgo: formatDistanceToNow(lead.updatedAt, { addSuffix: true }),
          createdAt: lead.createdAt,
          address: lead.address,
          contactSummary: contactParts.join(' | '),
          attachments: attachments.slice(0, 3),
          quotes,
          latestQuote: quotes[0] ?? null,
          jobs,
        };
      });

      const leadLookup = new Map(leadsNormalized.map((lead) => [lead.id, lead]));
      const allQuotes = leadsNormalized.flatMap((lead) => lead.quotes);
      const jobsWithLead = leadsNormalized.flatMap((lead) =>
        lead.jobs.map((job) => ({
          ...job,
          leadName: lead.displayName,
        })),
      );

      const photoGallery = auditRecords
        .flatMap((audit) => {
          if (!audit.leadId) {
            return [];
          }
          const lead = leadLookup.get(audit.leadId);
          if (!lead || audit.attachments.length === 0) {
            return [];
          }
          return audit.attachments.map((url) => ({
            url,
            leadName: lead.displayName,
            stageLabel: stageMeta[lead.stage].label,
            capturedAgo: formatDistanceToNow(audit.createdAt, {
              addSuffix: true,
            }),
          }));
        })
        .slice(0, 12);

      const activityFeed = auditRecords
        .map((audit) => {
          const lead = audit.leadId ? leadLookup.get(audit.leadId) : null;
          const summary = lead
            ? `${lead.displayName} | ${stageMeta[lead.stage].label}`
            : '';
          return {
            id: audit.id,
            timeAgo: formatDistanceToNow(audit.createdAt, { addSuffix: true }),
            timestamp: format(audit.createdAt, 'MMM d, yyyy @ h:mm a'),
            actor: audit.actor,
            actionLabel: humanizeKey(audit.action),
            summary,
            payloadSnippet: buildPayloadSnippet(audit.payload),
            badgeTone: determineActivityTone(audit.action),
          };
        })
        .slice(0, 12);

      const approvalsQueue = approvalsRaw.map((approval) => {
        const quote = approval.quote;
        const lead = approval.quote.lead;
        const total = decimalToNumber(quote.total);
        const confidence = decimalToNumber(quote.confidence);
        const flags = extractFlagStrings(quote.flagsJson);
        const riskLevel =
          flags.length > 0 || confidence < 0.75
            ? flags.length > 0
              ? 'risk'
              : 'warning'
            : 'info';
        return {
          id: approval.id,
          quoteId: shortId(quote.id),
          leadName: lead.name ?? 'Messenger Lead',
          address: lead.address ?? 'Address pending',
          totalDisplay: formatCurrency(total),
          submittedAgo: formatDistanceToNow(approval.createdAt, {
            addSuffix: true,
          }),
          token: approval.token,
          flags,
          riskLevel,
          confidenceCopy: `Confidence ${formatConfidence(confidence)}`,
        };
      });

      const pendingApprovalsCount = approvalsQueue.length;
      const approvalsConfidenceAvg =
        approvalsQueue.length > 0
          ? Math.round(
              approvalsQueue.reduce((sum, current) => {
                const value = Number.parseInt(
                  current.confidenceCopy.replace(/\D/g, '') || '0',
                  10,
                );
                return sum + value;
              }, 0) / approvalsQueue.length,
            )
          : 0;

      const totalLeads = leadsNormalized.length;
      const activeLeads = leadsNormalized.filter(
        (lead) => lead.stage !== 'done',
      ).length;
      const newLeadsToday = leadsNormalized.filter(
        (lead) => lead.createdAt >= startOfDay(now),
      ).length;
      const successStatuses: QuoteStatus[] = ['approved', 'accepted'];
      const revenue30d = allQuotes.reduce((sum, quote) => {
        if (
          successStatuses.includes(quote.status) &&
          quote.updatedAt >= subDays(now, 30)
        ) {
          return sum + quote.total;
        }
        return sum;
      }, 0);
      const averageQuote =
        allQuotes.length > 0
          ? allQuotes.reduce((sum, quote) => sum + quote.total, 0) /
            allQuotes.length
          : 0;
      const convertedQuotes = allQuotes.filter((quote) =>
        successStatuses.includes(quote.status),
      ).length;
      const conversionRate =
        allQuotes.length > 0
          ? Math.round((convertedQuotes / allQuotes.length) * 100)
          : 0;
      const bookedJobsCount = jobsWithLead.filter(
        (job) => job.status === 'booked',
      ).length;

      const upcomingJobs = jobsWithLead
        .filter((job) => {
          const withinWeek = job.windowStart <= addDays(now, 7);
          const upcoming = job.windowEnd >= now;
          return withinWeek && upcoming;
        })
        .sort(
          (first, second) =>
            first.windowStart.getTime() - second.windowStart.getTime(),
        )
        .slice(0, 6);

      const stageCounts = new Map<LeadStage, number>();
      stageOrder.forEach((stage) => stageCounts.set(stage, 0));
      leadsNormalized.forEach((lead) => {
        stageCounts.set(
          lead.stage,
          (stageCounts.get(lead.stage) ?? 0) + 1,
        );
      });

      const stageBreakdown = stageOrder.map((stage) => {
        const meta = stageMeta[stage];
        const count = stageCounts.get(stage) ?? 0;
        const percent =
          totalLeads > 0 ? (count / totalLeads) * 100 : 0;
        return {
          key: stage,
          label: meta.label,
          caption: meta.caption,
          tone: meta.tone,
          count,
          percent,
          trendLabel: meta.trend,
        };
      });

      const pipelineRows = leadsNormalized
        .sort(
          (first, second) =>
            second.updatedAt.getTime() - first.updatedAt.getTime(),
        )
        .slice(0, 10)
        .map((lead) => ({
          leadId: lead.id,
          displayName: lead.displayName,
          channelLabel: lead.channelLabel,
          stageLabel: lead.stageLabel,
          stageClass: lead.stageTone,
          updatedAgo: lead.updatedAgo,
          address: lead.address ?? 'Address pending',
          attachments: lead.attachments,
          nextAction: lead.nextAction,
          contactSummary: lead.contactSummary,
          quoteSummary: lead.latestQuote
            ? {
                totalDisplay: lead.latestQuote.totalDisplay,
                statusLabel: lead.latestQuote.statusLabel,
                confidence: lead.latestQuote.confidenceDisplay,
                needsApproval: lead.latestQuote.needsApproval,
              }
            : null,
        }));

      const metricsCards = [
        {
          key: 'leads',
          label: 'Active Leads',
          hint: `${totalLeads.toLocaleString('en-US')} total in CRM`,
          value: activeLeads.toLocaleString('en-US'),
          deltaLabel:
            newLeadsToday > 0
              ? `+${newLeadsToday} new today`
              : 'No new submissions yet',
          deltaTone: (newLeadsToday > 0
            ? 'positive'
            : 'neutral') satisfies MetricDeltaTone,
        },
        {
          key: 'approvals',
          label: 'Approvals Pending',
          hint:
            approvalsQueue.length > 0
              ? `Avg confidence ${approvalsConfidenceAvg}%`
              : 'Under-cap quotes auto approve',
          value: pendingApprovalsCount.toString(),
          deltaLabel:
            approvalsQueue.length > 0
              ? `Oldest ${approvalsQueue[0].submittedAgo}`
              : 'Owner queue is clear',
          deltaTone: (approvalsQueue.length > 0
            ? 'neutral'
            : 'positive') satisfies MetricDeltaTone,
        },
        {
          key: 'jobs',
          label: 'Upcoming Pickups',
          hint: 'Scheduled within 7 days',
          value: upcomingJobs.length.toString(),
          deltaLabel:
            upcomingJobs.length > 0
              ? `Next ${upcomingJobs[0].windowRelative}`
              : 'Send windows to lock the week',
          deltaTone: (upcomingJobs.length > 0
            ? 'positive'
            : 'neutral') satisfies MetricDeltaTone,
        },
        {
          key: 'revenue',
          label: '30-Day Revenue',
          hint: `${convertedQuotes} wins | ${successStatuses.length} statuses`,
          value: formatCurrency(revenue30d),
          deltaLabel: `Conversion ${conversionRate}%`,
          deltaTone: (conversionRate >= 40
            ? 'positive'
            : 'neutral') satisfies MetricDeltaTone,
        },
      ];

      const summary = {
        greeting: getGreeting(now),
        headline: 'Pipeline overview at a glance',
        subheadline:
          'Monitor approvals, bookings, and reminders without leaving Messenger.',
        refreshRelative: formatDistanceToNow(now, { addSuffix: true }),
        refreshExact: format(now, 'MMM d, yyyy @ h:mm a'),
        activeLeadTally: activeLeads,
        bookedJobTally: bookedJobsCount,
        totalLeadTally: totalLeads,
        newLeadsToday,
        conversionRate: `${conversionRate}%`,
        averageQuoteValue: formatCurrency(averageQuote),
      };

      return reply.view('layout.ejs', {
        pageTitle: 'Operations Dashboard',
        subtitle: 'Messenger-first JunkQuote agent command center',
        tenantLabel: process.env.TENANT_LABEL ?? 'JunkQuote Agent',
        adminUserLabel: 'Owner',
        pendingApprovals: pendingApprovalsCount,
        extraStylesheets: [],
        bodyTemplate: 'admin/dashboard.ejs',
        summary,
        metricsCards,
        stageBreakdown,
        approvalsQueue,
        pipelineRows,
        upcomingJobs,
        activityFeed,
        photoGallery,
      });
    },
  );

  fastify.get(
    '/api/approve/:token',
    async (
      request: FastifyRequest<{
        Params: { token: string };
        Querystring: { decision?: 'approve' | 'deny'; approver?: string };
      }>,
      reply,
    ) => {
      const approval = await prisma.approval.findUnique({
        where: { token: request.params.token },
        include: { quote: { include: { lead: true } } },
      });

      if (!approval) {
        return reply.code(404).send('Approval token not found.');
      }

      const decision = request.query.decision;

      if (!decision) {
        return reply.view('/approve.ejs', {
          approval: {
            ...approval,
            quote: {
              ...approval.quote,
              lineItemsJson: toMoneyEntries(approval.quote.lineItemsJson),
              discountsJson: toMoneyEntries(approval.quote.discountsJson),
            },
          },
        });
      }

      const nowDecision = new Date();
      const status = decision === 'approve' ? 'approved' : 'denied';

      await prisma.approval.update({
        where: { id: approval.id },
        data: {
          status,
          approver: request.query.approver ?? 'owner',
          decidedAt: nowDecision,
        },
      });

      await prisma.quote.update({
        where: { id: approval.quoteId },
        data: {
          status: status === 'approved' ? 'approved' : 'denied',
          needsApproval: false,
        },
      });

      await prisma.lead.update({
        where: { id: approval.quote.leadId },
        data: {
          stage: status === 'approved' ? 'scheduling' : 'awaiting_photos',
          stateMetadata: {
            ...toRecord(approval.quote.lead.stateMetadata),
            owner_decided_at: nowDecision.toISOString(),
            owner_decision: status,
          },
        },
      });

      await prisma.audit.create({
        data: {
          leadId: approval.quote.leadId,
          actor: 'owner',
          action: 'quote_approval_decision',
          payload: {
            approval_id: approval.id,
            decision: status,
          },
        },
      });

      return reply.view('/approve.ejs', {
        approval: {
          ...approval,
          status,
          quote: {
            ...approval.quote,
            lineItemsJson: toMoneyEntries(approval.quote.lineItemsJson),
            discountsJson: toMoneyEntries(approval.quote.discountsJson),
          },
        },
        message:
          status === 'approved'
            ? 'Quote approved. Customer can be scheduled.'
            : 'Quote denied. Agent will re-engage customer.',
      });
    },
  );
}
