import { z } from "zod";

// Loose by design: only `id` is required, and unknown keys are kept so a new
// field is passed through rather than dropped. Confirmed against live
// responses on 2026-10-21 (fixtures/recorded/):
// - duration is seconds.
// - transcript is one string, but the speaker labels differ between agents
//   ("bot:"/"human:" on one, "Agent:"/"User:" on another), so never parse it
//   for logic.
// - extractedData is keyed by the contact field's display label, which is
//   whatever the account named the field ("Caller Business Name", "email").
// - executedCallActions items carry actionId, actionType, actionName,
//   executedAt and triggerReceivedAt; actionParameters is not returned.
// - agentTransferOccurred is returned but not documented.

export const ExecutedCallActionSchema = z.looseObject({
  actionId: z.string().nullish(),
  actionName: z.string().nullish(),
  actionType: z.string().nullish(),
  actionParameters: z.unknown().optional(),
  executedAt: z.string().nullish(),
  triggerReceivedAt: z.string().nullish(),
});

export const CallLogSchema = z.looseObject({
  id: z.string(),
  agentId: z.string().nullish(),
  contactId: z.string().nullish(),
  createdAt: z.string().nullish(),
  duration: z.number().nullish(),
  executedCallActions: z.array(ExecutedCallActionSchema).nullish(),
  extractedData: z.record(z.string(), z.unknown()).nullish(),
  fromNumber: z.string().nullish(),
  isAgentDeleted: z.boolean().nullish(),
  messageId: z.string().nullish(),
  summary: z.string().nullish(),
  transcript: z.string().nullish(),
  translation: z.unknown().optional(),
  trialCall: z.boolean().nullish(),
  agentTransferOccurred: z.boolean().nullish(),
});

export const CallLogListSchema = z.looseObject({
  callLogs: z.array(CallLogSchema),
  page: z.number().nullish(),
  pageSize: z.number().nullish(),
  total: z.number().nullish(),
});

export type CallLog = z.infer<typeof CallLogSchema>;
export type CallLogList = z.infer<typeof CallLogListSchema>;
