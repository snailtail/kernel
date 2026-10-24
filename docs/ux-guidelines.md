# UX guidelines

Kernel must stay simple and guiding as it grows (#36). Every new feature answers these questions before it is
built, and the answers go in the issue.

## The checklist

1. **Can it be off?** Does it belong to a module (`server/src/core/modules.ts`)? A switched-off module must disappear
   everywhere: REST (404), MCP tools and prompts, search, OpenAPI, reports, menus and the command palette – checked
   in one place (the policy layer), not with scattered ifs. Switching off never deletes data.
2. **What is the minimal form?** Ask for as little as possible: the fields a newcomer needs (usually title,
   description, impact/urgency). Everything else goes behind "More details" and is optional on the server too – the
   server never requires a field the short form hides.
3. **What does guided mode say?** Every record has `next_steps` (purpose, phase, steps ticked off from the record
   itself) and the guide panel shows them. Hints explain *why* a field matters, in plain words.
4. **REST and MCP parity** (#35): every capability has both; the parity test covers record types.
5. **Traceable** (#57): every change is in the activity log and the audit trail, with a reason for sensitive ones.
6. **Secure by default** (#56): deny by default in the policy layer, untrusted text marked as such for agents,
   outbound requests through the SSRF-safe client, secrets encrypted and shown once.
7. **Quiet**: notifications are opt-in per channel with quiet defaults; nothing emails people by surprise.
8. **Accessible and responsive**: WCAG 2.1 AA (labels, focus, contrast, keyboard), works at 360 px wide.

## Copy

- Plain language, short sentences, sentence case for buttons and headings ("Log incident", not "Create Incident").
- Say what happens: "Resolve the problem" rather than "Submit".
- No unexplained acronyms; ITIL terms are fine when the guide or a hint explains them (impact vs urgency, known
  error, workaround, standard change).
- Errors say what to do next: "Give a reason for putting the incident on hold".
- Empty states explain what would appear and how to get it there.
- Dates and durations are relative where that helps ("due in 2 hours"), absolute on hover.
