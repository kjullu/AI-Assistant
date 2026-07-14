module.exports = [
  {
    "type": "heading",
    "defaultValue": "AI Chat"
  },
  {
    "type": "text",
    "defaultValue": "Configure the AI provider, tools, memory, stats, and debug info."
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "OpenRouter"
      },
      {
        "type": "input",
        "messageKey": "OpenRouterApiKey",
        "label": "OpenRouter API Key",
        "attributes": {
          "placeholder": "sk-or-v1-..."
        }
      },
      {
        "type": "input",
        "messageKey": "OpenRouterModel",
        "defaultValue": "moonshotai/kimi-k2.5",
        "label": "Model",
        "attributes": {
          "placeholder": "moonshotai/kimi-k2.5"
        }
      }
    ]
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "Tools"
      },
      {
        "type": "toggle",
        "messageKey": "EnableLocation",
        "label": "Give AI Location",
        "defaultValue": false
      },
      {
        "type": "toggle",
        "messageKey": "EnableSearch",
        "label": "Enable Brave Search",
        "defaultValue": false
      },
      {
        "type": "toggle",
        "messageKey": "EnableCalculator",
        "label": "Enable Calculator",
        "defaultValue": true
      },
      {
        "type": "toggle",
        "messageKey": "EnableWeather",
        "label": "Enable Weather",
        "defaultValue": true
      },
      {
        "type": "input",
        "messageKey": "BraveSearchApiKey",
        "label": "Brave Search API Key",
        "attributes": {
          "placeholder": "Brave API key"
        }
      }
    ]
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "Prompt & Memory"
      },
      {
        "type": "toggle",
        "messageKey": "EnableMemory",
        "label": "Enable Memory",
        "defaultValue": true
      },
      {
        "type": "input",
        "messageKey": "ExtraSystemPrompt",
        "label": "Extra System Prompt",
        "description": "Optional system-level instructions added as a separate message.",
        "attributes": {
          "placeholder": "Example: Be terse and use Danish when I ask in Danish."
        }
      },
      {
        "type": "input",
        "messageKey": "NotesMemoryText",
        "label": "Memory Notes",
        "description": "One note per line. These are sent to the AI as memory.",
        "attributes": {
          "placeholder": "User prefers 24-hour time."
        }
      },
      {
        "type": "input",
        "messageKey": "OpenSessions",
        "label": "Saved Sessions",
        "description": "Last 20 sessions. Delete by editing this field and saving.",
        "attributes": {
          "placeholder": "No saved sessions yet."
        }
      }
    ]
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "Home Stats"
      },
      {
        "type": "input",
        "messageKey": "StatsUsedCredits",
        "label": "Used Credits This Month",
        "description": "Editable counter for the home screen. Set to 0 to reset.",
        "attributes": {
          "placeholder": "0"
        }
      },
      {
        "type": "input",
        "messageKey": "StatsMessages",
        "label": "Messages This Month",
        "description": "Editable counter for the home screen. Set to 0 to reset.",
        "attributes": {
          "placeholder": "0"
        }
      },
      {
        "type": "input",
        "messageKey": "StatsSearches",
        "label": "Searches This Month",
        "description": "Editable counter for the home screen. Set to 0 to reset.",
        "attributes": {
          "placeholder": "0"
        }
      }
    ]
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "Debug"
      },
      {
        "type": "input",
        "messageKey": "DebugLog",
        "label": "Debug Log",
        "description": "Copy this when reporting bugs. It is read-only-ish; saving may overwrite it until the next log line.",
        "attributes": {
          "placeholder": "No logs yet."
        }
      }
    ]
  },
  {
    "type": "submit",
    "defaultValue": "Save"
  }
];
