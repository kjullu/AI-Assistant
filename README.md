# Pebble AI Chat

A vibe-coded Pebble watchapp that lets you dictate AI prompts and read replies on your wrist with a model on OpenRouter. It works; there's not much more to say ¯\\\_(ツ)\_/¯

## What It Does

- Press `SELECT` on the watch to dictate a prompt.
- PebbleKit JS sends the prompt to OpenRouter from the Pebble phone app.
- The model and OpenRouter API key are configured from the Pebble phone app settings gear.
- The assistant can use enabled tools repeatedly and in any order, including reading several pages in parallel.
- If Timeline is enabled, requested reminders and events are pushed to the current user's Pebble timeline.

## Watch Controls

- `SELECT`: dictate a prompt, choose a menu option, or toggle a setting.
- `BACK`: cancel the active request, close the current screen, or exit from home.
- Long `SELECT`: clear the current conversation.
- Long `UP`: open tool settings.
- Long `DOWN`: open saved sessions.

## Configure

Open the app settings in the Pebble phone app and set:

- `OpenRouter API Key`: your OpenRouter key, usually `sk-or-v1-...`.
- `Model`: any OpenRouter model id, default `moonshotai/kimi-k2.5`.

Search and scraping require their own Brave Search and Firecrawl API keys. Tools can also be toggled from the watch.

## Privacy & Data

This app sends dictated prompts, recent conversation context, enabled memory notes, and tool results to OpenRouter and the selected model. Enabled tools may also send data to third parties:

- `Location`: when requested by the model, phone coordinates are obtained and sent to Nominatim for an approximate place name before the result is returned to the model.
- `Brave Search`: when enabled, search queries are sent to Brave Search using your API key.
- `Firecrawl Scrape`: when enabled, page URLs are sent to Firecrawl using your API key to fetch readable page content.
- `Timeline`: when enabled, requested pin content is pushed through Pebble's timeline API.
- `Calculator`: when enabled, lets the model call a calculator.
- `Weather`: when enabled, requested place names are sent to Open-Meteo for geocoding and forecasts.

API keys, memory notes, saved sessions, statistics, settings, and sanitized debug metadata are stored in the Pebble phone app's local storage. Nothing is stored in this repository. Saved sessions contain conversation text and can be viewed or edited in settings.

## Build

```sh
npm install
pebble build
```

Run the focused PebbleKit JS regression tests with:

```sh
npm test
```
