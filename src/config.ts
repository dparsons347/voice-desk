import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OutcomeRules } from "./outcomes.js";

// Claude Desktop launches the server with an arbitrary cwd, so resolve paths
// from the package root rather than process.cwd().
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EnvSchema = z.object({
  GHL_PIT: z.string().min(1).optional(),
  GHL_LOCATION_ID: z.string().min(1).optional(),
  GHL_BASE_URL: z.url().default("https://services.leadconnectorhq.com"),
  GHL_API_VERSION: z.string().default("2021-07-28"),
  GHL_TIMEZONE: z.string().min(1).optional(),
  AUDIT_LOG_PATH: z.string().default("logs/audit.jsonl"),
  ABANDON_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(20),
  OUTCOME_CALLBACK_ACTION_IDS: z.string().default(""),
  BOOKING_CALENDAR_IDS: z.string().default(""),
  BOOKING_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(30),
  EXCLUDE_FROM_NUMBERS: z.string().default(""),
  DRY_RUN: z.enum(["true", "false"]).default("false"),
  // HighLevel allows 100 per 10 seconds per app and location; stay under it.
  RATE_LIMIT_PER_10S: z.coerce.number().int().min(1).max(100).default(80),
  SMS_FROM_NUMBER: z.string().min(1).optional(),
  SMS_CONSENT_FIELD: z.string().default("SMS Consent On Call"),
  BOOKING_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(60),
});

const idList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export interface Config {
  pit?: string;
  locationId?: string;
  baseUrl: string;
  apiVersion: string;
  timezone?: string;
  auditLogPath: string;
  /** Most requests allowed in any 10-second window. */
  rateLimitPer10s: number;
  /** Write tools log and return requests instead of sending them. */
  dryRun: boolean;
  sms: {
    /** Sender number; HighLevel uses the location default when unset. */
    fromNumber?: string;
    /** extractedData label holding the caller's answer to the texting question. */
    consentField: string;
  };
  /** Caller numbers left out of reports by default (the owner's own test calls). */
  excludeFromNumbers: string[];
  outcomeRules: OutcomeRules;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, envFile = resolve(PROJECT_ROOT, ".env")): Config {
  if (env === process.env && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  // Treat empty strings from .env.example-style files as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = EnvSchema.parse(cleaned);
  return {
    pit: parsed.GHL_PIT,
    locationId: parsed.GHL_LOCATION_ID,
    baseUrl: parsed.GHL_BASE_URL.replace(/\/+$/, ""),
    apiVersion: parsed.GHL_API_VERSION,
    timezone: parsed.GHL_TIMEZONE,
    auditLogPath: isAbsolute(parsed.AUDIT_LOG_PATH)
      ? parsed.AUDIT_LOG_PATH
      : resolve(PROJECT_ROOT, parsed.AUDIT_LOG_PATH),
    excludeFromNumbers: idList(parsed.EXCLUDE_FROM_NUMBERS),
    dryRun: parsed.DRY_RUN === "true",
    rateLimitPer10s: parsed.RATE_LIMIT_PER_10S,
    sms: { fromNumber: parsed.SMS_FROM_NUMBER, consentField: parsed.SMS_CONSENT_FIELD },
    outcomeRules: {
      abandonThresholdSeconds: parsed.ABANDON_THRESHOLD_SECONDS,
      callbackActionIds: new Set(idList(parsed.OUTCOME_CALLBACK_ACTION_IDS)),
      bookingCalendarIds: idList(parsed.BOOKING_CALENDAR_IDS),
      bookingLookaheadDays: parsed.BOOKING_LOOKAHEAD_DAYS,
      bookingGraceSeconds: parsed.BOOKING_GRACE_SECONDS,
    },
  };
}
