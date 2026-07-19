# 0.3.0-DEV - NOT OUT YET

- Add choice tool for presenting multiple-choice questions on the watch with UP/DOWN to navigate, SELECT to pick, BACK to cancel, and a "Say your own" option that opens dictation.
- Weather tool can now accept location instead of just city.
- Only include tool explanations and JSON fields in the system prompt when the tool is enabled.
- Convert location from system prompt to an actual tool that the model can request.
- Make location lookup fail gracefully by returning an error message to the model instead of halting.
- Add repeated, ordered tool-call rounds with parallel execution for independent calls.
- Add request IDs to prevent cancelled response chunks from reaching newer conversations.
- Add bounded AppMessage retries and preserve queued messages during cancellation.
- Fix streaming fallback tool calls and stale choice continuations.
- Add a Timeline toggle to phone and watch settings.
- Update one saved session record per conversation instead of saving every turn as a new session.
- Reject conversions between incompatible unit types and label built-in currency rates as approximate.
- Remove conversation content, queries, and URLs from persistent debug logs.
- Add focused regression tests for request, tool, choice, session, and queue behavior.
- Update privacy and control documentation.

# Changelog 0.2.0

- Support replacing existing notes via structured memory tool
- Streaming responses + tool calls
- Weather integration
- Vibrate after first streamed token
- Search fix
- UI update
- Remove duplicate UTC time system prompt
- Tool fixes
- Cleanup

# 0.1.1.1

- Quick little fix of a dum system prompt

# 0.1.1

- Streaming fallback bug fix␍
- Cancel queue clearing␍
- AppMessage size/safety improvements␍
- More robust JSON parsing␍
- Local time in system prompt␍
- 30-second streaming watchdog␍
- Reasoning trace awareness␍
- Internal history → conversationHistory rename

# 0.1.0

First release!
