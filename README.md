# Pebble AI Assistant

Pebble AI Assistant is a configurable Pebble watchapp for dictating prompts and reading streamed AI replies on your wrist. The phone-side PebbleKit JS app sends requests to a selected model through OpenRouter.

The app targets the `basalt`, `diorite`, and `emery` Pebble platforms.

## What It Does

- Dictates prompts through Pebble's built-in voice input.
- Streams compact assistant replies back to the watch.
- Keeps recent turns as conversation context and stores up to 20 conversations locally on the phone.
- Shows the five most recent saved conversations on the watch.
- Lets the model use enabled tools repeatedly, with independent calls executed in parallel when possible.
- Can add requested reminders and events to the user's Pebble timeline when Timeline is enabled.
- Shows OpenRouter usage and remaining credit balance on every home screen. Pebble Time 2 also shows monthly message and search counts plus the selected model. Monthly counters reset at the start of each UTC month; the remaining credit balance does not.

## Watch Controls

### Home

- `SELECT`: start dictation.
- `UP`: open tool settings.
- `DOWN`: open saved conversations.
- `BACK`: exit the app.

### Conversation

- `UP` / `DOWN`: scroll through the conversation.
- `SELECT`: dictate another prompt.
- `BACK`: cancel the active request, or return home when no request is active.

### Tool Settings

- `UP` / `DOWN`: move between tools.
- `SELECT`: enable or disable the selected tool.
- `BACK`: return to the previous screen.

The watch can toggle Location, Memory, Calculator, Search, Weather, Choice, Timeline, and Health. Firecrawl Scrape can only be configured from the phone settings.

### Saved Conversations

- `UP` / `DOWN`: scroll through saved conversations.
- `BACK`: return to the previous screen.

### Choice Prompts

- `UP` / `DOWN`: move between choices. The list scrolls to keep the selected option visible.
- `SELECT`: submit the selected choice.
- Select `Say your own`: dictate a custom answer.
- `BACK`: cancel the choice prompt.

Submitted choice questions and answers are added to the watch conversation before the assistant continues.

### Long Presses

These controls work outside choice prompts:

- Hold `SELECT`: clear the current conversation and start a new session.
- Hold `UP`: open tool settings.
- Hold `DOWN`: open saved conversations.

On supported touchscreen models, swipe vertically to scroll long conversation and saved-conversation screens. There is no touchscreen hold action.

Launching the app through Pebble Quick Launch starts dictation immediately.

## Configuration

Open the app settings from the gear in the Pebble phone app.

### OpenRouter

- `OpenRouter API Key`: required for assistant requests, usually beginning with `sk-or-v1-`.
- `Model`: accepts an OpenRouter model ID and defaults to `moonshotai/kimi-k2.5`.
- `Reasoning`: shows the model default and the controls advertised by OpenRouter for the saved model. Depending on the model, this may include disabled, provider-default enabled, or specific effort levels. Reasoning output is excluded from replies shown on the watch.

Reopen settings after changing the model to refresh its reasoning capabilities.

### Tools

- `Location`: disabled by default. Lets the model request the phone's current coordinates and an approximate place name.
- `Memory`: enabled by default. Lets the model add or replace persistent notes, which can also be edited in phone settings.
- `Calculator`: enabled by default. Supports arithmetic, compatible physical-unit conversions, and current currency conversion.
- `Brave Search`: disabled by default and requires a separate Brave Search API key.
- `Firecrawl Scrape`: disabled by default and requires a separate Firecrawl API key.
- `Weather`: enabled by default. Supports current and forecast weather for a requested place.
- `Choice`: enabled by default. Lets the model present selectable answers on the watch.
- `Timeline`: enabled by default. Lets the model add a pin when the user asks to schedule something.
- `Health`: disabled by default. Lets the model request supported watch-recorded Health data for an inclusive date range.

The phone settings also provide an extra system prompt, editable memory notes, editable saved conversations, monthly statistics, and a sanitized debug log.

## Privacy And Data

Dictated prompts, recent conversation context, enabled memory notes, extra system instructions, and tool results are sent to OpenRouter and the selected model. OpenRouter is also queried for model capabilities and, when an API key is configured, credit information.

Enabled tools may send data to other services:

- `Location`: the phone obtains its coordinates and sends them to Nominatim for reverse geocoding. The coordinates, reported accuracy, and approximate place name are then returned to the selected model through OpenRouter.
- `Brave Search`: search queries are sent to Brave Search using the configured API key. Up to three results are returned to the model.
- `Firecrawl Scrape`: requested page URLs are sent to Firecrawl using the configured API key. Readable page content is returned to the model and truncated to 4,000 characters.
- `Weather`: requested place names are sent to Open-Meteo for geocoding, and the resulting coordinates are sent to Open-Meteo for forecasts.
- `Calculator`: arithmetic and physical-unit conversions run locally. Currency codes are sent to Frankfurter for current reference rates; amounts are converted locally.
- `Timeline`: pin content is sent to Pebble's timeline API using the current user's timeline token.
- `Health`: requested steps, active time, distance, sleep, calories, and supported heart-rate aggregates are read from Pebble Health and returned to the selected model through OpenRouter. Ranges that include today also include available current heart rate and activity data. Availability depends on the watch and requested date range.

Choice prompts and memory changes are handled by the watch and phone app, but their results become part of the conversation sent to OpenRouter.

API keys, memory notes, saved conversations, statistics, settings, cached currency rates, cached model capabilities, and sanitized debug metadata are stored in the Pebble phone app's local storage. Saved conversations contain conversation text and can be viewed or edited in phone settings. Health access is disabled by default, and Health responses are informational rather than medical advice.

## Build And Test

Install dependencies and build the app with the Pebble SDK:

```sh
npm install
pebble build
```

Run the PebbleKit JS regression tests with:

```sh
npm test
```
