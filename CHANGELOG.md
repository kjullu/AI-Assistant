# 0.3.3-DEV - NOT OUT YET (Can change the 0.x.y depending on the size)


# 0.3.2

- Require confirmation before clearing a conversation, with a safe return to the existing chat.
- Start dictation automatically after confirming a new session.
- Show each tool call on its own line in the watch conversation before the final response.
- Preserve tool calls and results as context for later conversation turns.
- Move new-session vibration feedback to when the confirmation opens.

# 0.3.1
- Return tool results to the model with standard tool roles and matching call IDs instead of user messages.
- Remove the touchscreen hold gesture for clearing conversations to prevent accidental activation.
- Fix tool and choice navigation keeping selected rows or their context headers off-screen.
- Show submitted choice questions and answers in the watch conversation.
- Show remaining credits, messages, and searches on Pebble Time and Pebble 2 while keeping full Home Stats on Pebble Time 2.
- Clarify Home Stats platform visibility and automatic monthly resets in phone settings.
- Reduce the gap between the home title and statistics on all watch sizes.
- Align in-chat status messages with the final assistant text position.

# 0.3.0

- Add a choice tool with watch-based navigation, cancellation, and dictation for custom answers.
- Add an opt-in Firecrawl tool for scraping readable content from web pages.
- Support weather lookups using locations instead of only city names.
- Convert location lookup into an on-demand tool and return failures to the model without halting.
- Include tool instructions and JSON fields in the system prompt only when each tool is enabled.
- Support repeated, ordered tool-call rounds with parallel execution and streaming fallback handling.
- Improve cancellation and message delivery with request IDs, bounded retries, preserved queues, and stale-choice protection.
- Add a Timeline toggle to phone and watch settings.
- Update one saved session record per conversation instead of creating one for every turn.
- Fetch current currency rates from Frankfurter and reject incompatible unit conversions.
- Protect privacy by removing conversation content, queries, and URLs from persistent logs and updating related documentation.
- Fix tool-setting navigation that could leave selected rows off-screen or behind the scroll indicator.
- Add an opt-in Health tool for activity, sleep, calorie, and heart-rate data over inclusive date ranges.
- Return final assistant answers as plain text while reserving JSON for tool requests.
- Add model-aware reasoning controls using capabilities reported by OpenRouter.

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
