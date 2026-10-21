# voice-desk

An MCP server that lets Claude audit a HighLevel Voice AI receptionist. It finds the calls that
went wrong and helps fix them. Reading is free. Anything that texts a caller or changes the agent
is previewed first and needs your explicit approval.

An AI receptionist's failures are quiet. It tells a caller "you're booked" when nothing is on the
calendar. A caller asks for a callback and nobody calls. Those calls never show up in a dashboard;
they just become revenue you didn't get. voice-desk is built to surface them.

## What it caught on a real line

These came from the first week of test calls to a live sales line, and each one is now a test case
built from the recorded response:

- **HighLevel doesn't record bookings on the call log.** When the agent books an appointment, the
  call's `executedCallActions` is empty, so a booked call looks identical to one where nothing
  happened. voice-desk confirms bookings against the calendar instead.
- **The agent said "you're booked" before booking.** It confirmed the time mid-call and only made
  the booking after saying goodbye. A caller who hung up at "thanks for calling" would have had a
  slot that didn't exist. The prompt was fixed using `propose_agent_change`.
- **One booking, two calls.** A dropped 23-second call and the redial that booked were both
  credited with the same appointment. Bookings are now attributed to exactly one call.
- **An agent claimed a booking it never made.** On a separate agent, the AI summary said
  "appointment set", but no booking action ran. `calls_needing_followup` flags this as
  `claimed_booking`.

## How it fits together

```
Caller ──> HighLevel Voice AI agent ──> books / triggers callback workflow / captures fields
                    │
                    └─ call logs, calendar, contacts, agent config
                                   │  HighLevel API v2 (Private Integration Token)
                    voice-desk (TypeScript, stdio)
                    ├─ read tools ── outcomes derived from actions + calendar, never the AI summary
                    ├─ write tools ─ propose → preview → your approval → execute_confirmed
                    └─ audit log (JSONL, redacted), read retry with backoff, no write retries
                                   │
                         Claude Desktop / Claude Code
```

## Quick start

1. `npm install && npm run build`
2. In your HighLevel sub-account, go to **Settings → Private Integrations** and create a token with
   `voice-ai-dashboard.readonly`, `voice-ai-agents.readonly`, `voice-ai-agent-goals.readonly` and
   `calendars/events.readonly`. For the write tools, also add `contacts.readonly`,
   `conversations/message.write`, `voice-ai-agents.write` and `voice-ai-agent-goals.write`.
3. `cp .env.example .env`. Set `GHL_PIT` and `GHL_LOCATION_ID`, and keep `DRY_RUN=true` to start.
4. `npm run probe:call-logs` makes one request and prints the raw response, to check the token works.
5. Ask Claude to run `get_agent_config`. Copy your booking calendar id into `BOOKING_CALENDAR_IDS`,
   and the id of any "call me back" workflow action into `OUTCOME_CALLBACK_ACTION_IDS`.
6. Put your own phone number in `EXCLUDE_FROM_NUMBERS` so your test calls stay out of reports.
7. Add the server to Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`),
   then quit and reopen Claude Desktop:

   ```json
   {
     "mcpServers": {
       "voice-desk": { "command": "/absolute/path/to/node", "args": ["/absolute/path/to/voice-desk/dist/index.js"] }
     }
   }
   ```

   Use an absolute path to `node`; Claude Desktop does not use your shell's `PATH`. `.env` is read from
   the package root, so the working directory doesn't matter.
8. Ask: *"Who do I need to follow up with this week?"*
9. When you trust the previews, set `DRY_RUN=false` and restart Claude Desktop.

## Example

> **You:** Including my test calls, who do I need to follow up with this month?
>
> **Claude** (`calls_needing_followup`): Two callers asked for a callback on Oct 9 and haven't booked
> since. The Oct 21 call booked, and the 23-second call before it was a dropped line that redialled
> and booked, so neither needs anything.
>
> **You:** Text the Oct 9 caller.
>
> **Claude** (`propose_followup_sms`): I can't. On that call they said no to texts.
>
> **You:** Draft a follow-up for the Oct 21 caller instead.
>
> **Claude:** Here's the preview: to +1 555-555-0101, from the line's default number, 1 segment,
> consent "Yes". Nothing has been sent. Shall I send it?
>
> **You:** Send it.
>
> **Claude** (`execute_confirmed`): Sent.

## Tools

### Read (no confirmation)

| Tool | Inputs | Returns |
|---|---|---|
| `list_calls` | `since`, `until?`, `agentId?`, `outcome?`, `includeTrial?`, `includeExcluded?`, `limit?` | Calls newest first, each with a derived `outcome` and one-line `reason` |
| `get_call` | `callId` | Outcome, transcript, summary, extracted data, actions fired, contact, duration |
| `calls_needing_followup` | as `list_calls` | Calls a person should act on, each with a `kind` and reason |
| `call_outcome_report` | `since`, `until?`, `agentId?`, `includeTrial?`, `includeExcluded?` | Numbers only: outcomes, booking and lead-capture rates, median duration, actions fired, per-agent split |
| `get_agent_config` | `agentId?` | Prompt, greeting, actions with trigger prompts, and how voice-desk counts each action |
| `ping` | | Whether credentials are configured. Never calls HighLevel. |

### Write (two steps)

| Tool | What it does |
|---|---|
| `propose_followup_sms` | `contactId`, `callId`, `body`. Returns a preview and a `confirmToken`; sends nothing. Refuses if the caller didn't say yes to texts on that call, the call belongs to another contact, or the contact has Do Not Disturb on for SMS. |
| `propose_agent_change` | `agentId`, `promptEdits` (find/replace pairs; each `find` must match the live prompt exactly once) and/or `actionTriggerPrompts`. Returns a line diff and a `confirmToken`; changes nothing. |
| `execute_confirmed` | `confirmToken`. Performs exactly the previewed write. |

## Outcomes

Each call gets one outcome. The first matching rule wins:

| Outcome | Rule |
|---|---|
| `booked` | The Voice AI created an appointment for the caller's contact on a calendar in `BOOKING_CALENDAR_IDS`, during the call or within `BOOKING_GRACE_SECONDS` (default 60) after it. One appointment counts for one call: if the contact redialled, the later call gets it. |
| `callback_requested` | An action in `OUTCOME_CALLBACK_ACTION_IDS` fired |
| `abandoned` | Neither, and the call ran under `ABANDON_THRESHOLD_SECONDS` (default 20) |
| `no_action` | Neither, and the call ran at least that long |

Outcomes come from what the log and calendar show, never from the AI-written summary. A workflow
action can start anything, so it only counts as a callback when its id is configured. An unmapped
workflow that fired is named in the `reason` rather than counted silently. If the calendar can't be
read, the tool fails and names the missing scope, rather than reporting every booking as `no_action`.

## Follow-up

`calls_needing_followup` leaves out booked calls and hang-ups:

| Kind | When |
|---|---|
| `claimed_booking` | The summary says the caller was booked, but no appointment exists. They expect a call that isn't on the calendar. |
| `callback_owed` | The caller asked for a callback and the same contact hasn't booked since. |
| `no_action` | A real conversation ended with no booking or callback, and the contact hasn't booked since. |

## Safety

- **Previews before writes.** Write tools only propose. Claude has to show the preview and wait for
  your approval in a later message. A call transcript or other tool output can't approve anything.
- **Confirmation tokens** are single-use, expire after 10 minutes, and are bound to a hash of the
  payload. They live in memory, so restarting the server cancels anything pending.
- **Re-checked before writing.** For an SMS: the contact's number and Do Not Disturb status. For an
  agent change: the live prompt and actions. If anything changed since the preview, the write is refused.
- **Consent from the call itself.** A text is only proposed if the caller said yes to the texting
  question on that call (`SMS_CONSENT_FIELD`).
- **Writes are never retried.** A failed write returns the error and its token stays used. A
  multi-part agent change reports which parts were applied before the failure.
- **Reads retry** on 429, 5xx and network errors: 3 attempts, exponential backoff with full jitter,
  honouring `Retry-After`.
- **Audit log.** `logs/audit.jsonl` gets one line per HTTP request: time, tool, operation, status,
  latency and outcome. Phone numbers and message bodies are redacted.
- **`DRY_RUN=true`** logs each write and returns the request instead of sending it.
- **Clear errors.** Every failure says whether it's safe to retry and what to check. A missing scope
  error names the exact scope to add.
- **Your own calls** (`EXCLUDE_FROM_NUMBERS`) and trial calls are left out of every tool by default,
  and each response says how many were excluded.

## HighLevel API notes

Things the docs don't say, all confirmed against live responses:

- `locationId` is required in the query on call logs, agents and calendar events, even with a
  location-scoped Private Integration Token. Without it you get 400 or 403.
- A missing scope returns **401** "The token is not authorized for this scope", not 403.
- `executedCallActions` lists workflow triggers but not appointment bookings.
- Call log `duration` is in seconds. `transcript` is a single string, and its speaker labels vary by
  agent (`bot:`/`human:` on one, `Agent:`/`User:` on another). `extractedData` is keyed by each
  field's display label.
- Call logs include an undocumented `agentTransferOccurred` boolean.
- Appointments the agent books carry `createdBy.source: "voice_ai"`.
- If an extracted email already belongs to another contact, HighLevel silently skips saving it.
  Post-call notification emails create a contact for the recipient, so testing with the
  notification address triggers this.

## Limits

- One HighLevel location per server.
- No rate limiter yet. Reads back off on 429, but nothing throttles requests up front.
- `list_calls` and the report read at most 2,000 calls (40 pages) per request, and say when they stop early.

## Development

`npm test` runs the vitest suite. Every finding above has a test built from a sanitised real
response. `npm run smoke` spawns the built server over stdio. `npm run inspect` opens the MCP
Inspector. Fixtures are described in [`fixtures/README.md`](fixtures/README.md).

## License

MIT
