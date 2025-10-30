import { Buffer } from 'node:buffer';

import type { FastifyInstance } from 'fastify/types/instance';
import type { FastifyReply } from 'fastify/types/reply';
import type { FastifyRequest } from 'fastify/types/request';
import { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.ts';

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

      const leads = await prisma.lead.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          quotes: { orderBy: { createdAt: 'desc' } },
          jobs: { orderBy: { createdAt: 'desc' } },
        },
      });

      const approvals = await prisma.approval.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        include: { quote: { include: { lead: true } } },
      });

      const normalizedApprovals = approvals.map((approval) => ({
        ...approval,
        quote: {
          ...approval.quote,
          lineItemsJson: Array.isArray(approval.quote.lineItemsJson)
            ? (approval.quote.lineItemsJson as Array<{
                label: string;
                amount: number;
              }>)
            : [],
          discountsJson: Array.isArray(approval.quote.discountsJson)
            ? (approval.quote.discountsJson as Array<{
                label: string;
                amount: number;
              }>)
            : [],
        },
      }));

      const audits = await prisma.audit.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { lead: true },
      });

      const normalizedLeads = leads.map((lead) => ({
        ...lead,
        quotes: lead.quotes.map((quote) => ({
          ...quote,
          lineItemsJson: Array.isArray(quote.lineItemsJson)
            ? (quote.lineItemsJson as Array<{ label: string; amount: number }>)
            : [],
          discountsJson: Array.isArray(quote.discountsJson)
            ? (quote.discountsJson as Array<{ label: string; amount: number }>)
            : [],
          notesJson: Array.isArray(quote.notesJson)
            ? (quote.notesJson as string[])
            : [],
        })),
      }));

      const normalizedAudits = audits.map((audit) => ({
        ...audit,
        payload: (audit.payload ?? {}) as Prisma.JsonObject,
      }));

      return reply.view('/admin.ejs', {
        leads: normalizedLeads,
        approvals: normalizedApprovals,
        audits: normalizedAudits,
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
              lineItemsJson: Array.isArray(approval.quote.lineItemsJson)
                ? (approval.quote.lineItemsJson as Array<{
                    label: string;
                    amount: number;
                  }>)
                : [],
              discountsJson: Array.isArray(approval.quote.discountsJson)
                ? (approval.quote.discountsJson as Array<{
                    label: string;
                    amount: number;
                  }>)
                : [],
            },
          },
        });
      }

      const now = new Date();
      const status = decision === 'approve' ? 'approved' : 'denied';

      await prisma.approval.update({
        where: { id: approval.id },
        data: {
          status,
          approver: request.query.approver ?? 'owner',
          decidedAt: now,
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
            ...((approval.quote.lead.stateMetadata as Prisma.JsonObject) ??
              {}),
            owner_decided_at: now.toISOString(),
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
          } as Prisma.JsonObject,
        },
      });

      return reply.view('/approve.ejs', {
        approval: {
          ...approval,
          status,
          quote: {
            ...approval.quote,
            lineItemsJson: Array.isArray(approval.quote.lineItemsJson)
              ? (approval.quote.lineItemsJson as Array<{
                  label: string;
                  amount: number;
                }>)
              : [],
            discountsJson: Array.isArray(approval.quote.discountsJson)
              ? (approval.quote.discountsJson as Array<{
                  label: string;
                  amount: number;
                }>)
              : [],
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
