import { createHash, randomBytes } from "node:crypto";

export const CONFIRM_TTL_MS = 10 * 60_000;

export class ConfirmError extends Error {
  constructor(
    message: string,
    readonly check: string,
  ) {
    super(message);
    this.name = "ConfirmError";
  }
}

/** Key order independent, so the same payload always hashes the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

interface Pending<P> {
  payload: P;
  hash: string;
  expiresAt: number;
  used: boolean;
}

/**
 * Holds proposed writes until confirmed. A token is `<nonce>.<payload hash
 * prefix>`: single-use, expires after 10 minutes, and only ever executes the
 * payload it was issued for. Lives in memory, so restarting the server
 * cancels every pending proposal, which is the safe direction.
 */
export class ConfirmStore<P> {
  private readonly pending = new Map<string, Pending<P>>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(payload: P): { confirmToken: string; expiresAt: string } {
    this.sweep();
    const nonce = randomBytes(16).toString("hex");
    const hash = hashPayload(payload);
    const expiresAt = this.now() + CONFIRM_TTL_MS;
    this.pending.set(nonce, { payload, hash, expiresAt, used: false });
    return { confirmToken: `${nonce}.${hash.slice(0, 16)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Marks the token used before returning its payload, so a failed write cannot be retried with it. */
  consume(token: string): P {
    const [nonce, hashPrefix] = token.split(".");
    const entry = nonce ? this.pending.get(nonce) : undefined;
    if (!entry) {
      throw new ConfirmError("Unknown confirmToken.", "Propose the change again; tokens don't survive a server restart.");
    }
    if (entry.used) {
      throw new ConfirmError("This confirmToken has already been used.", "Each token runs once. Propose again if you need to repeat the change.");
    }
    if (this.now() > entry.expiresAt) {
      this.pending.delete(nonce!);
      throw new ConfirmError("This confirmToken has expired.", "Tokens last 10 minutes. Propose the change again and confirm the new preview.");
    }
    if (!hashPrefix || hashPrefix !== entry.hash.slice(0, 16) || hashPayload(entry.payload) !== entry.hash) {
      throw new ConfirmError("This confirmToken does not match the previewed change.", "Use the token exactly as the proposal returned it.");
    }
    entry.used = true;
    return entry.payload;
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, entry] of this.pending) if (entry.used || now > entry.expiresAt) this.pending.delete(nonce);
  }
}
