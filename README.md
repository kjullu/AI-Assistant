# Pebble AI Chat

A vibe-coded Pebble watchapp that lets you dictate AI prompts and read replies on your wrist with a model on OpenRouter. It works, there's no much more to say ¯\\\_(ツ)\_/¯

## What It Does

- Press `SELECT` on the watch to dictate a prompt.
- PebbleKit JS sends the prompt to OpenRouter from the Pebble phone app.
- The model and OpenRouter API key are configured from the Pebble phone app settings gear.
- If the assistant returns a timeline request, the phone app pushes a Pebble timeline pin for the current user.

## Configure

Open the app settings in the Pebble phone app and set:

- `OpenRouter API Key`: your OpenRouter key, usually `sk-or-v1-...`.
- `Model`: any OpenRouter model id, default `moonshotai/kimi-k2.5`.

## Privacy & Data

This app sends your dictated prompts to OpenRouter (and from there to the selected model). Optional features also send data to third parties:

- `Location`: when enabled, your device location is included in the prompt and can be used for local weather.
- `Brave Search`: when enabled, search queries are sent to Brave Search using your API key.
- `Timeline`: when enabled, timeline pins are pushed through Pebble's timeline API.
- `Calculator`: when enabled, lets the model call a calculator.
- `Weather`: when enabled, lets the model look up weather forecasts for a place and time via Open-Meteo.

No keys or prompts are stored in this repository; all credentials live in the Pebble phone app's local storage.

## Build

```sh
npm install
pebble build
```
