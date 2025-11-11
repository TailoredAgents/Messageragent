import type { Runner } from '@openai/agents';
import { getLogger, type LoggerInstance } from './log.ts';

type ToolTelemetryLogger = Pick<LoggerInstance, 'info' | 'warn' | 'error'>;

type ToolInvocationState = {
  callId: string;
  toolName: string;
  agentName: string;
  startedAt: number;
  payload: unknown;
  context: unknown;
  toolCall: Record<string, unknown> | undefined;
};

const RUNNER_TELEMETRY_FLAG = Symbol.for('junkquote.runner.telemetry');

const FULL_MASK_KEYS = new Set([
  'psid',
  'messengerpsid',
  'token',
  'secret',
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'key',
  'password',
  'session',
  'cookie',
  'phone',
  'email',
  'to',
  'from',
]);

const SUMMARY_MASK_KEYS = new Set([
  'text',
  'body',
  'message',
  'content',
  'payload',
  'address',
  'attachments',
  'notes',
]);

export function attachToolTelemetry(
  runner: Runner,
  logger?: ToolTelemetryLogger,
): void {
  const runnerWithFlag = runner as Runner & {
    [RUNNER_TELEMETRY_FLAG]?: boolean;
  };
  if (runnerWithFlag[RUNNER_TELEMETRY_FLAG]) {
    return;
  }

  runnerWithFlag[RUNNER_TELEMETRY_FLAG] = true;

  const activeCalls = new Map<string, ToolInvocationState>();
  const log = buildLogger(logger ?? getLogger());

  runner.on('agent_tool_start', (runContext, agent, tool, details) => {
    const callId = resolveToolCallId(details.toolCall);
    const parsedArgs = deserialize(details.toolCall?.arguments);
    const sanitizedArgs = sanitizeData(parsedArgs, 'arguments');
    const sanitizedContext = sanitizeData(runContext.context);
    const sanitizedToolCall = sanitizeToolCall(details.toolCall);

    activeCalls.set(callId, {
      callId,
      agentName: agent.name,
      toolName: tool.name,
      startedAt: Date.now(),
      payload: sanitizedArgs,
      context: sanitizedContext,
      toolCall: sanitizedToolCall,
    });

    log.info('Tool invocation started', {
      callId,
      toolName: tool.name,
      agentName: agent.name,
      payload: sanitizedArgs,
      requestContext: sanitizedContext,
      toolCall: sanitizedToolCall,
    });
  });

  runner.on('agent_tool_end', (runContext, agent, tool, result, details) => {
    const callId = resolveToolCallId(details.toolCall);
    const callState = activeCalls.get(callId);
    const parsedResult = deserialize(result);
    const sanitizedResult = sanitizeData(parsedResult);
    const durationMs = callState ? Date.now() - callState.startedAt : undefined;
    const usage = summarizeUsage(runContext.usage);
    const errorMessage = detectToolError(result);

    const logPayload = {
      callId,
      toolName: tool.name,
      agentName: agent.name,
      durationMs,
      payload: callState?.payload,
      requestContext: callState?.context ?? sanitizeData(runContext.context),
      toolCall: callState?.toolCall ?? sanitizeToolCall(details.toolCall),
      openaiResponse: sanitizedResult,
      usage,
    };

    if (errorMessage) {
      log.error('Tool invocation errored', {
        ...logPayload,
        openaiError: sanitizeData(errorMessage, 'message'),
      });
    } else {
      log.info('Tool invocation completed', logPayload);
    }

    activeCalls.delete(callId);
  });
}

function buildLogger(logger: ToolTelemetryLogger) {
  const emit = (
    level: 'info' | 'warn' | 'error',
    msg: string,
    payload: Record<string, unknown>,
  ) => {
    const entry = {
      event: 'runner_tool_trace',
      msg,
      ...payload,
      timestamp: new Date().toISOString(),
    };
    if (typeof logger[level] === 'function') {
      logger[level](entry);
      return;
    }
    getLogger()[level](entry);
  };

  return {
    info: (msg: string, payload: Record<string, unknown>) =>
      emit('info', msg, payload),
    warn: (msg: string, payload: Record<string, unknown>) =>
      emit('warn', msg, payload),
    error: (msg: string, payload: Record<string, unknown>) =>
      emit('error', msg, payload),
  };
}

function resolveToolCallId(toolCall: Record<string, unknown> | undefined) {
  if (toolCall) {
    if (typeof toolCall.callId === 'string') {
      return toolCall.callId;
    }
    if (typeof toolCall.id === 'string') {
      return toolCall.id;
    }
    if (typeof (toolCall as { call_id?: string }).call_id === 'string') {
      return (toolCall as { call_id: string }).call_id;
    }
  }
  return `call_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function sanitizeToolCall(
  toolCall: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!toolCall) {
    return undefined;
  }

  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolCall)) {
    if (key === 'arguments') {
      clone[key] = sanitizeData(deserialize(value), key);
    } else {
      clone[key] = sanitizeData(value, key);
    }
  }
  return clone;
}

function deserialize(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function sanitizeData(value: unknown, parentKey?: string): unknown {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeData(entry, parentKey));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = sanitizeData(nestedValue, key);
    }
    return result;
  }

  const normalizedKey = parentKey?.toLowerCase() ?? '';

  if (typeof value === 'string') {
    if (isUrlKey(normalizedKey)) {
      return summarizeUrl(value);
    }
    if (shouldFullyMask(normalizedKey)) {
      return `[redacted:${normalizedKey || 'value'}]`;
    }
    if (shouldSummarize(normalizedKey)) {
      return summarizeString(value, normalizedKey);
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    if (shouldFullyMask(normalizedKey)) {
      return `[redacted:${normalizedKey || 'value'}]`;
    }
  }

  return value;
}

function shouldFullyMask(key: string): boolean {
  if (!key) {
    return false;
  }
  if (FULL_MASK_KEYS.has(key)) {
    return true;
  }
  return key.includes('secret') || key.includes('token');
}

function shouldSummarize(key: string): boolean {
  if (!key) {
    return false;
  }
  if (SUMMARY_MASK_KEYS.has(key)) {
    return true;
  }
  return key.includes('text') || key.includes('message');
}

function isUrlKey(key: string): boolean {
  return Boolean(key && key.includes('url'));
}

function summarizeString(value: string, key?: string): string {
  const condensed = value.replace(/\s+/g, ' ').trim();
  if (condensed.length === 0) {
    return '[masked-empty]';
  }

  const snippet = condensed.slice(0, 48);
  const suffix = condensed.length > 48 ? '…' : '';
  return `[masked:${key ?? 'value'} len=${condensed.length} snippet="${snippet}${suffix}"]`;
}

function summarizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.length > 32 ? `${parsed.pathname.slice(0, 32)}…` : parsed.pathname;
    return `[masked:url host=${parsed.host} path=${path || '/'}]`;
  } catch {
    return summarizeString(value, 'url');
  }
}

function summarizeUsage(usage: unknown):
  | {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  | undefined {
  if (
    !usage ||
    typeof usage !== 'object' ||
    typeof (usage as { requests?: number }).requests === 'undefined'
  ) {
    return undefined;
  }

  const snapshot = usage as {
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };

  return {
    requests: snapshot.requests ?? 0,
    inputTokens: snapshot.inputTokens ?? 0,
    outputTokens: snapshot.outputTokens ?? 0,
    totalTokens: snapshot.totalTokens ?? 0,
  };
}

function detectToolError(rawResult: unknown): string | undefined {
  if (typeof rawResult !== 'string') {
    return undefined;
  }
  const trimmed = rawResult.trim();
  return trimmed.startsWith('An error occurred while running the tool')
    ? trimmed
    : undefined;
}
