# AI Assistant

Ask an AI model a question by speaking into your Pebble, then read the answer on your wrist as it streams in. The phone side of the app sends your prompt to a model of your choice through [OpenRouter](https://openrouter.ai).

The model can also use tools: it can search the web, check the weather, do unit and currency conversions, add pins to your Pebble timeline, read your Health data, or ask you to pick between options on the watch. You choose which tools are turned on.

![A conversation on a Pebble Time 2: the user says "Please say something smart." and the AI replies.](<images/store images/Emery - Pebble Time 2/pebble_screenshot2.png>)

Runs on Pebble Time, Pebble Time Steel, Pebble 2, and Pebble Time 2 (`basalt`, `diorite`, and `emery`).

## Install

Install it from [Rebble](https://apps.rebble.io/en_US/application/6a9aa1dc7739b60009445123) or [RePebble](https://apps.repebble.com/cf78a459465f436ab859ad27).

You need an [OpenRouter API key](https://openrouter.ai/keys), which usually starts with `sk-or-v1-`. Open the app settings from the gear in the Pebble phone app and paste it in. The default model is `moonshotai/kimi-k2.5`; any OpenRouter model ID works. Brave Search and Firecrawl Scrape each need their own API key.

Then open the app on the watch and press `SELECT` to start talking. Launching it through Quick Launch starts dictation straight away.

## Controls

| Button | Home | Conversation |
| --- | --- | --- |
| `SELECT` | Dictate a prompt | Dictate a follow-up |
| `UP` | Tool settings | Scroll up |
| `DOWN` | Saved conversations | Scroll down |
| `BACK` | Exit | Cancel the request, or go home |

Hold `SELECT` to start a new conversation, hold `UP` for tool settings, and hold `DOWN` for saved conversations. When the model asks you to choose, use `UP`/`DOWN` and `SELECT`, or pick `Say your own` to dictate an answer. On Pebble Time 2 you can also swipe to scroll.

The home screen shows your remaining OpenRouter credit and how many messages and searches you have used this month.

## Tools

| Tool | Default | What it does |
| --- | --- | --- |
| Memory | On | Keeps notes the model can add to; you can edit them in settings |
| Calculator | On | Arithmetic, unit conversion, and currency conversion |
| Weather | On | Current weather and forecasts for a place |
| Choice | On | Lets the model give you options to pick from on the watch |
| Timeline | On | Adds reminders and events to your Pebble timeline |
| Location | Off | Gives the model your phone's coordinates and a rough place name |
| Health | Off | Reads steps, sleep, heart rate, and similar data from Pebble Health |
| Brave Search | Off | Web search, needs a Brave Search API key |
| Firecrawl Scrape | Off | Reads web pages, needs a Firecrawl API key; phone settings only |

The phone settings also let you pick a provider and routing priority, set reasoning effort, add your own system prompt, and edit saved conversations. Reopen settings after changing the model so the provider and reasoning options refresh.

## Privacy

Your prompts, recent conversation, memory notes, extra system prompt, and tool results go to OpenRouter and the model you picked. Enabled tools also send data to other services:

- Location: coordinates go to Nominatim to look up a place name.
- Brave Search: search queries go to Brave.
- Firecrawl Scrape: page URLs go to Firecrawl.
- Weather: place names and coordinates go to Open-Meteo.
- Calculator: currency codes go to Frankfurter. Everything else runs on the phone.
- Timeline: pin content goes to Pebble's timeline API.
- Health: the requested Health data goes to the model. It is information, not medical advice.

API keys, memory notes, up to 20 saved conversations, statistics, and settings are stored locally in the Pebble phone app.

## Build and test

Build with the Pebble SDK:

```sh
npm install
pebble build
```

Run the PebbleKit JS tests:

```sh
npm test
```

`tools/replay_watch_stream.py` replays a recorded conversation against a running emulator and saves a screenshot of each state to `build/watch-replay/`:

```sh
.venv/bin/python tools/replay_watch_stream.py --phone localhost:PORT
```

Use the port printed by `pebble install --emulator ...`. Add `--no-captures` to run it at full speed without screenshots.
