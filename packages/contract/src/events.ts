import { z } from 'zod';
import { printJobSchema } from './api.js';
import { edgeStateSchema } from './netedge.js';

/**
 * Server-sent events on `GET /api/v1/events`.
 *
 * SSE rather than WebSocket: every message here travels server→client only, SSE reconnects
 * itself with `Last-Event-ID`, and it survives the tsnet and Funnel proxy paths without the
 * upgrade dance.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('print-job'), job: printJobSchema }),
  z.object({
    type: z.literal('connection'),
    /** What the coloured dot shows. Deliberately coarse: no transport detail. */
    state: edgeStateSchema,
  }),
  z.object({
    type: z.literal('device'),
    deviceId: z.string(),
    status: z.enum(['pending', 'active', 'revoked']),
  }),
  z.object({
    type: z.literal('folder'),
    folderId: z.string(),
    available: z.boolean(),
    lastIndexedAt: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal('upload'),
    uploadId: z.string(),
    receivedBytes: z.number().int(),
    totalBytes: z.number().int(),
    status: z.enum(['active', 'complete', 'aborted']),
  }),
  /** Sent every 20s so intermediaries do not close an idle stream. */
  z.object({ type: z.literal('heartbeat'), at: z.number().int() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const SSE_HEARTBEAT_MS = 20_000;
