# Fixtures

- `recorded/`: real HighLevel responses from test calls to a live Voice AI line, sanitised before
  being committed. Caller names, phone numbers, emails and street addresses are replaced
  (the caller is "Sam Rivera" on +1 555-555-0101), and the location and contact ids are replaced
  with readable fake ids. Agent, action, calendar and call ids are kept as recorded; they are
  opaque and useless without a token. The agent prompt is the line's public script.
  Outcome, follow-up and report tests run against these.
- `synthetic/`: hand-written responses in the documented shape, used only for paging and HTTP
  plumbing tests.
- `raw/` (gitignored): unsanitised output of `npm run probe:call-logs`. Never commit it.
