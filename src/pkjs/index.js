var Clay = require('@rebble/clay');
var messageKeys = require('message_keys');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
var OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
var BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
var FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
var OPENMETEO_GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
var OPENMETEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
var NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
var TIMELINE_URL = 'https://timeline-api.getpebble.com/v1/user/pins/';

var REGION_FALLBACKS = {
  'central europe': { lat: 50.0, lon: 15.0 },
  'northern europe': { lat: 62.0, lon: 10.0 },
  'southern europe': { lat: 40.0, lon: 16.0 },
  'western europe': { lat: 48.0, lon: 0.0 },
  'eastern europe': { lat: 50.0, lon: 30.0 },
  'central america': { lat: 13.0, lon: -85.0 },
  'north america': { lat: 45.0, lon: -100.0 },
  'south america': { lat: -15.0, lon: -60.0 },
  'southeast asia': { lat: 5.0, lon: 110.0 },
  'the middle east': { lat: 30.0, lon: 45.0 },
  'middle east': { lat: 30.0, lon: 45.0 },
  'northern africa': { lat: 25.0, lon: 10.0 },
  'southern africa': { lat: -25.0, lon: 25.0 },
  'eastern africa': { lat: 0.0, lon: 35.0 },
  'western africa': { lat: 12.0, lon: -5.0 },
  'the caribbean': { lat: 15.0, lon: -75.0 },
  'caribbean': { lat: 15.0, lon: -75.0 }
};
var DEFAULT_MODEL = 'moonshotai/kimi-k2.5';
var RESPONSE_CHUNK_CHARS = 600;
var MAX_SEARCH_RESULTS = 3;
var MAX_SCRAPE_CHARS = 4000;
var MAX_NOTES = 30;
var MAX_NOTE_CHARS = 240;
var MAX_SESSIONS = 20;
var STREAM_WATCHDOG_MS = 30000; // Wait longer before falling back from streaming to non-streaming

var conversationHistory = [];
var sendQueue = [];
var sending = false;
var activeRequests = [];
var requestGeneration = 0;
var pendingChoiceGeneration = 0;
var pendingChoicePrompt = null;
var pendingChoiceMessages = null;

function debugLog(message) {
  var line = new Date().toISOString() + ' ' + message;
  console.log(line);
  var existing = localStorage.getItem('DebugLog') || '';
  var combined = existing ? existing + ' | ' + line : line;
  var maxLength = 3500;
  if (combined.length > maxLength) {
    combined = combined.substring(combined.length - maxLength);
    var firstSeparator = combined.indexOf(' | ');
    if (firstSeparator !== -1) {
      combined = combined.substring(firstSeparator + 3);
    }
  }
  localStorage.setItem('DebugLog', combined);
}

function trackRequest(request, generation) {
  request._generation = generation;
  request._cancelled = false;
  activeRequests.push(request);
}

function untrackRequest(request) {
  for (var i = activeRequests.length - 1; i >= 0; i--) {
    if (activeRequests[i] === request) {
      activeRequests.splice(i, 1);
    }
  }
}

function requestIsCurrent(request) {
  return !request._cancelled && request._generation === requestGeneration;
}

function cancelActiveRequests() {
  debugLog('cancelActiveRequests active=' + activeRequests.length + ' generation=' + requestGeneration);
  requestGeneration++;
  for (var i = 0; i < activeRequests.length; i++) {
    activeRequests[i]._cancelled = true;
    try {
      activeRequests[i].abort();
    } catch (err) {
      console.log('Abort failed: ' + err.message);
    }
  }
  activeRequests = [];
  sendQueue = [];
  sendToWatch({ Status: 'Cancelled' });
}

function sendToWatch(dict) {
  sendQueue.push(dict);
  pumpSendQueue();
}

function showError(userMessage, detail) {
  if (detail) {
    debugLog('ERROR ' + userMessage + ': ' + detail);
  } else {
    debugLog('ERROR ' + userMessage);
  }
  sendToWatch({ Error: userMessage });
}

function pumpSendQueue() {
  if (sending || sendQueue.length === 0) {
    return;
  }

  sending = true;
  Pebble.sendAppMessage(sendQueue[0], function() {
    sendQueue.shift();
    sending = false;
    pumpSendQueue();
  }, function(e) {
    console.log('sendAppMessage failed: ' + JSON.stringify(e));
    sending = false;
    setTimeout(pumpSendQueue, 1000);
  });
}

function clip(text, maxLength) {
  text = String(text || '');
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength);
}

function sendAssistantReply(reply) {
  reply = String(reply || 'No response.');
  var chunks = [];
  for (var offset = 0; offset < reply.length; offset += RESPONSE_CHUNK_CHARS) {
    chunks.push(reply.substring(offset, offset + RESPONSE_CHUNK_CHARS));
  }
  if (chunks.length === 0) {
    chunks.push('No response.');
  }

  for (var i = 0; i < chunks.length; i++) {
    sendToWatch({
      Status: i === chunks.length - 1 ? 'Done' : 'Receiving...',
      AssistantResponse: chunks[i],
      ResponseChunkIndex: i,
      ResponseChunkDone: i === chunks.length - 1 ? 1 : 0
    });
  }
}

function getSetting(key, fallback) {
  var value = localStorage.getItem(key);
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return value;
}

function getBoolSetting(key, fallback) {
  var value = getSetting(key, fallback ? '1' : '0');
  return value === true || value === 1 || value === '1' || value === 'true';
}

function getScrapeAvailable() {
  return getBoolSetting('EnableScrape', false) && !!getSetting('FirecrawlApiKey', '');
}

function statsMonthKey() {
  var now = new Date();
  return now.getUTCFullYear() + '-' + ('0' + (now.getUTCMonth() + 1)).slice(-2);
}

function defaultMonthlyStats() {
  return {
    month: statsMonthKey(),
    messages: 0,
    searches: 0,
    usageCredits: 0,
    remainingCredits: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
}

function getMonthlyStats() {
  var currentMonth = statsMonthKey();
  try {
    var stats = JSON.parse(localStorage.getItem('MonthlyStats') || '{}');
    if (stats.month === currentMonth) {
      return stats;
    }
  } catch (err) {
  }
  return defaultMonthlyStats();
}

function saveMonthlyStats(stats) {
  localStorage.setItem('MonthlyStats', JSON.stringify(stats));
}

function addUsageStats(usage) {
  if (!usage) {
    return;
  }

  var stats = getMonthlyStats();
  stats.usageCredits += Number(usage.cost || 0);
  stats.promptTokens += Number(usage.prompt_tokens || 0);
  stats.completionTokens += Number(usage.completion_tokens || 0);
  stats.totalTokens += Number(usage.total_tokens || 0);
  saveMonthlyStats(stats);
  refreshRemainingCredits();
}

function incrementStat(key) {
  var stats = getMonthlyStats();
  stats[key] = Number(stats[key] || 0) + 1;
  saveMonthlyStats(stats);
}

function saveEditableStats(usedCredits, messages, searches) {
  var stats = getMonthlyStats();
  if (usedCredits !== undefined && String(usedCredits).trim() !== '') {
    stats.usageCredits = Number(usedCredits) || 0;
  }
  if (messages !== undefined && String(messages).trim() !== '') {
    stats.messages = Number(messages) || 0;
  }
  if (searches !== undefined && String(searches).trim() !== '') {
    stats.searches = Number(searches) || 0;
  }
  saveMonthlyStats(stats);
}

function formatCredits(value) {
  value = Number(value || 0);
  if (value < 0.01) {
    return value.toFixed(4);
  }
  return value.toFixed(2);
}

function buildStatsText() {
  var stats = getMonthlyStats();
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);
  var remaining = stats.remainingCredits === null || stats.remainingCredits === undefined ? 'unavailable' : formatCredits(stats.remainingCredits);
  return [
    'Used: ' + formatCredits(stats.usageCredits),
    'Remaining: ' + remaining,
    'Messages: ' + Number(stats.messages || 0),
    'Searches: ' + Number(stats.searches || 0),
    model
  ].join('\n');
}

function sendStatsToWatch() {
  sendToWatch({ StatsText: buildStatsText() });
}

function sendToolStatesToWatch() {
  sendToWatch({
    ToolStates: 'location=' + (getBoolSetting('EnableLocation', false) ? '1' : '0') +
      ';memory=' + (getBoolSetting('EnableMemory', true) ? '1' : '0') +
      ';calculator=' + (getBoolSetting('EnableCalculator', true) ? '1' : '0') +
      ';search=' + (getBoolSetting('EnableSearch', false) ? '1' : '0') +
      ';scrape=' + (getScrapeAvailable() ? '1' : '0') +
      ';weather=' + (getBoolSetting('EnableWeather', true) ? '1' : '0') +
      ';choice=' + (getBoolSetting('EnableChoice', true) ? '1' : '0')
  });
}

function refreshRemainingCredits() {
  var apiKey = getSetting('OpenRouterApiKey', '');
  if (!apiKey) {
    sendStatsToWatch();
    return;
  }

  var request = new XMLHttpRequest();
  request.open('GET', OPENROUTER_CREDITS_URL, true);
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.timeout = 15000;

  request.onload = function() {
    if (request.status < 200 || request.status >= 300) {
      console.log('Credits unavailable: HTTP ' + request.status + ' ' + request.responseText);
      sendStatsToWatch();
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      if (json.data) {
        var totalCredits = Number(json.data.total_credits || 0);
        var totalUsage = Number(json.data.total_usage || 0);
        var stats = getMonthlyStats();
        stats.remainingCredits = totalCredits - totalUsage;
        saveMonthlyStats(stats);
        sendStatsToWatch();
      }
    } catch (err) {
      console.log('Credits parse failed: ' + err.message);
    }
  };

  request.onerror = function() {
    debugLog('Credits network error');
    sendStatsToWatch();
  };

  request.ontimeout = function() {
    debugLog('Credits request timed out');
    sendStatsToWatch();
  };

  request.send();
}

function setBoolSetting(key, value) {
  localStorage.setItem(key, value ? '1' : '0');
}

function toggleBoolSetting(key, fallback) {
  var value = !getBoolSetting(key, fallback);
  setBoolSetting(key, value);
  return value;
}

function getNotes() {
  try {
    var notes = JSON.parse(localStorage.getItem('NotesMemory') || '[]');
    return notes && notes.length !== undefined ? notes : [];
  } catch (err) {
    return [];
  }
}

function saveNotes(notes) {
  localStorage.setItem('NotesMemory', JSON.stringify(notes.slice(Math.max(0, notes.length - MAX_NOTES))));
}

function getSessions() {
  try {
    var sessions = JSON.parse(localStorage.getItem('SavedSessions') || '[]');
    return sessions && sessions.length !== undefined ? sessions : [];
  } catch (err) {
    return [];
  }
}

function saveSessions(sessions) {
  localStorage.setItem('SavedSessions', JSON.stringify(sessions.slice(Math.max(0, sessions.length - MAX_SESSIONS))));
}

function sessionsToText() {
  var sessions = getSessions();
  if (sessions.length === 0) {
    return 'No saved sessions yet.';
  }

  var lines = [];
  for (var i = 0; i < sessions.length; i++) {
    lines.push('Session ' + (i + 1));
    lines.push(sessions[i].createdAt);
    lines.push(sessions[i].summary || '(empty)');
    if (i !== sessions.length - 1) {
      lines.push('---');
    }
  }
  return lines.join('\n');
}

function sessionsToWatchText() {
  var sessions = getSessions();
  if (sessions.length === 0) {
    return 'No saved sessions yet.';
  }

  var lines = [];
  var watchCount = 5;
  var start = Math.max(0, sessions.length - watchCount);
  for (var i = start; i < sessions.length; i++) {
    lines.push('Session ' + (i + 1));
    lines.push(sessions[i].createdAt);
    lines.push(clip(sessions[i].summary || '(empty)', 300));
    if (i !== sessions.length - 1) {
      lines.push('---');
    }
  }
  return lines.join('\n');
}

function saveSessionsFromText(text) {
  var chunks = String(text || '').split('\n---\n');
  var sessions = [];
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i].replace(/^\s+|\s+$/g, '');
    if (!chunk || chunk === 'No saved sessions yet.') {
      continue;
    }
    var lines = chunk.split('\n');
    var header = lines[0] || '';
    var date = lines[1] || '';
    if (/^Session\s+\d+/i.test(header) && /^\d{4}-\d{2}-\d{2}T/.test(date)) {
      sessions.push({
        createdAt: date,
        summary: lines.slice(2).join('\n')
      });
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(header)) {
      sessions.push({
        createdAt: header,
        summary: lines.slice(1).join('\n')
      });
    }
  }
  saveSessions(sessions);
}

function saveCurrentSessionToConversationHistory() {
  var sessions = getSessions();
  var summary = conversationHistory.map(function(entry) {
    return entry.role + ':\n' + entry.content;
  }).join('\n');
  if (!summary) {
    return;
  }
  sessions.push({
    createdAt: new Date().toISOString(),
    summary: clip(summary, 1200)
  });
  saveSessions(sessions);
}

function notesToText() {
  var notes = getNotes();
  var lines = [];
  for (var i = 0; i < notes.length; i++) {
    lines.push(notes[i].text || '');
  }
  return lines.join('\n');
}

function saveNotesFromText(text) {
  var rawLines = String(text || '').split('\n');
  var notes = [];
  for (var i = 0; i < rawLines.length; i++) {
    var note = clip(rawLines[i], MAX_NOTE_CHARS).replace(/^\s+|\s+$/g, '');
    if (note) {
      notes.push({ text: note, createdAt: new Date().toISOString() });
    }
  }
  saveNotes(notes);
}

function appendNotesTo(notes, notesToAdd) {
  if (!notesToAdd) {
    return;
  }

  if (!(notesToAdd instanceof Array)) {
    notesToAdd = [notesToAdd];
  }

  for (var i = 0; i < notesToAdd.length; i++) {
    var text = clip(String(notesToAdd[i] || ''), MAX_NOTE_CHARS).replace(/^\s+|\s+$/g, '');
    if (text) {
      notes.push({ text: text, createdAt: new Date().toISOString() });
    }
  }
}

function addNotes(notesToAdd) {
  if (!notesToAdd) {
    return;
  }

  var notes = getNotes();
  appendNotesTo(notes, notesToAdd);
  saveNotes(notes);
}

function applyMemoryChanges(memory) {
  if (!memory) {
    return;
  }

  // Legacy/simple format: a single note string or array of strings appends only.
  if (typeof memory === 'string' || memory instanceof Array) {
    addNotes(memory);
    return;
  }

  if (typeof memory !== 'object') {
    return;
  }

  var notes = getNotes();

  if (memory.replace instanceof Array) {
    for (var i = 0; i < memory.replace.length; i++) {
      var op = memory.replace[i];
      if (!op || typeof op !== 'object') {
        continue;
      }
      var index = parseInt(op.index, 10);
      if (isNaN(index) || index < 0 || index >= notes.length) {
        debugLog('Memory replace ignored: invalid index ' + op.index);
        continue;
      }
      var text = clip(String(op.text || ''), MAX_NOTE_CHARS).replace(/^\s+|\s+$/g, '');
      if (!text) {
        debugLog('Memory replace ignored: empty text at index ' + index);
        continue;
      }
      notes[index] = { text: text, createdAt: new Date().toISOString() };
      debugLog('Memory replaced index ' + index);
    }
  }

  if (memory.add) {
    appendNotesTo(notes, memory.add);
  }

  saveNotes(notes);
}

function buildNotesContext() {
  if (!getBoolSetting('EnableMemory', true)) {
    return 'Persistent notes/memory disabled.';
  }

  var notes = getNotes();
  if (notes.length === 0) {
    return 'Persistent notes/memory: none yet.';
  }

  var lines = ['Persistent notes/memory available to you:'];
  for (var i = 0; i < notes.length; i++) {
    lines.push((i + 1) + '. ' + notes[i].text);
  }
  return lines.join('\n');
}

function settingValue(convertedSettings, rawSettings, name, numericKey) {
  if (rawSettings && rawSettings[name] !== undefined) {
    return rawSettings[name] && rawSettings[name].value !== undefined ? rawSettings[name].value : rawSettings[name];
  }
  if (convertedSettings && convertedSettings[name] !== undefined) {
    return convertedSettings[name];
  }
  if (convertedSettings && numericKey !== undefined && convertedSettings[numericKey] !== undefined) {
    return convertedSettings[numericKey];
  }
  return undefined;
}

function saveSettings(convertedSettings, rawSettings) {
  var apiKey = settingValue(convertedSettings, rawSettings, 'OpenRouterApiKey', messageKeys.OpenRouterApiKey);
  var model = settingValue(convertedSettings, rawSettings, 'OpenRouterModel', messageKeys.OpenRouterModel);
  var enableLocation = settingValue(convertedSettings, rawSettings, 'EnableLocation', messageKeys.EnableLocation);
  var enableMemory = settingValue(convertedSettings, rawSettings, 'EnableMemory', messageKeys.EnableMemory);
  var enableCalculator = settingValue(convertedSettings, rawSettings, 'EnableCalculator', messageKeys.EnableCalculator);
  var enableSearch = settingValue(convertedSettings, rawSettings, 'EnableSearch', messageKeys.EnableSearch);
  var enableWeather = settingValue(convertedSettings, rawSettings, 'EnableWeather', messageKeys.EnableWeather);
  var enableScrape = settingValue(convertedSettings, rawSettings, 'EnableScrape', messageKeys.EnableScrape);
  var enableChoice = settingValue(convertedSettings, rawSettings, 'EnableChoice', messageKeys.EnableChoice);
  var braveApiKey = settingValue(convertedSettings, rawSettings, 'BraveSearchApiKey', messageKeys.BraveSearchApiKey);
  var firecrawlApiKey = settingValue(convertedSettings, rawSettings, 'FirecrawlApiKey', messageKeys.FirecrawlApiKey);
  var extraSystemPrompt = settingValue(convertedSettings, rawSettings, 'ExtraSystemPrompt', messageKeys.ExtraSystemPrompt);
  var notesMemoryText = settingValue(convertedSettings, rawSettings, 'NotesMemoryText', messageKeys.NotesMemoryText);
  var sessionsText = settingValue(convertedSettings, rawSettings, 'OpenSessions', messageKeys.OpenSessions);
  var statsUsedCredits = settingValue(convertedSettings, rawSettings, 'StatsUsedCredits', messageKeys.StatsUsedCredits);
  var statsMessages = settingValue(convertedSettings, rawSettings, 'StatsMessages', messageKeys.StatsMessages);
  var statsSearches = settingValue(convertedSettings, rawSettings, 'StatsSearches', messageKeys.StatsSearches);

  if (apiKey !== undefined) {
    localStorage.setItem('OpenRouterApiKey', String(apiKey).trim());
  }
  if (model !== undefined && String(model).trim() !== '') {
    localStorage.setItem('OpenRouterModel', String(model).trim());
  }
  if (enableLocation !== undefined) {
    localStorage.setItem('EnableLocation', String(enableLocation ? 1 : 0));
  }
  if (enableMemory !== undefined) {
    localStorage.setItem('EnableMemory', String(enableMemory ? 1 : 0));
  }
  if (enableCalculator !== undefined) {
    localStorage.setItem('EnableCalculator', String(enableCalculator ? 1 : 0));
  }
  if (enableSearch !== undefined) {
    localStorage.setItem('EnableSearch', String(enableSearch ? 1 : 0));
  }
  if (enableWeather !== undefined) {
    localStorage.setItem('EnableWeather', String(enableWeather ? 1 : 0));
  }
  if (enableScrape !== undefined) {
    localStorage.setItem('EnableScrape', String(enableScrape ? 1 : 0));
  }
  if (enableChoice !== undefined) {
    localStorage.setItem('EnableChoice', String(enableChoice ? 1 : 0));
  }
  if (braveApiKey !== undefined) {
    localStorage.setItem('BraveSearchApiKey', String(braveApiKey).trim());
  }
  if (firecrawlApiKey !== undefined) {
    localStorage.setItem('FirecrawlApiKey', String(firecrawlApiKey).trim());
  }
  if (extraSystemPrompt !== undefined) {
    localStorage.setItem('ExtraSystemPrompt', String(extraSystemPrompt).trim());
  }
  if (notesMemoryText !== undefined) {
    saveNotesFromText(notesMemoryText);
  }
  if (sessionsText !== undefined) {
    saveSessionsFromText(sessionsText);
  }
  saveEditableStats(statsUsedCredits, statsMessages, statsSearches);
}

function buildSystemPrompt() {
  var searchAvailable = getBoolSetting('EnableSearch', false) && !!getSetting('BraveSearchApiKey', '');
  var scrapeAvailable = getScrapeAvailable();
  var weatherAvailable = getBoolSetting('EnableWeather', true);
  var memoryAvailable = getBoolSetting('EnableMemory', true);
  var calculatorAvailable = getBoolSetting('EnableCalculator', true);
  var locationAvailable = getBoolSetting('EnableLocation', false);
  var choiceAvailable = getBoolSetting('EnableChoice', true);

  var fields = ['"reply":"watch-friendly answer"', '"timeline":null'];
  if (searchAvailable) fields.push('"search":null');
  if (scrapeAvailable) fields.push('"scrape":null');
  if (weatherAvailable) fields.push('"weather":null');
  if (memoryAvailable) fields.push('"notes":null');
  if (calculatorAvailable) fields.push('"calc":null');
  if (locationAvailable) fields.push('"location":null');
  if (choiceAvailable) fields.push('"choice":null');

  var lines = [
    'You are a practical assistant for a Pebble smartwatch. Output only valid JSON in this exact shape, with no markdown: {' + fields.join(',') + '}. The user message is speech-to-text from a watch microphone, so it may contain errors, be ambiguous, or miss words. If you are unsure what they meant, ask a brief clarifying question. Keep replies compact and readable on a tiny screen. Use 24-hour time.',
    'Apply the provided current time, tool results, and notes/memory when relevant.',
    'Tool rules: request each enabled tool at most once per turn. After you receive the result, answer and set that tool field back to null.'
  ];

  if (searchAvailable) {
    lines.push('Brave Search tool: if current web info is needed, set search to a short query; otherwise keep it null.');
  }
  if (scrapeAvailable) {
    lines.push('Firecrawl scrape tool: if you need the full content of a specific web page, set scrape to the page URL; otherwise keep it null.');
  }
  if (weatherAvailable) {
    lines.push('Weather tool: if weather info is needed, set weather to {"place":"city or region name","timeframe":"now|today|tomorrow|+<hours>h|+<days>d"}. Accept named regions like states, countries, or broad areas such as "central Europe". The place must always be provided by you; never infer it from user location. If they did not name a place, ask them to and keep weather null.');
  }
  if (locationAvailable) {
    lines.push('Location tool: if the user asks about their location, nearby places, or asks "where am I", set location to true to receive coordinates and approximate place name; otherwise keep it null.');
  }

  if (choiceAvailable) {
    lines.push('Choice tool: if you need the user to pick from a small set of options, instead of asking open-ended, set choice to {"question":"short question","options":["option1","option2"]}. Keep options very short (under 30 chars each) and at most 7 options. The watch will display the question and options as a selectable menu. This is useful for ambiguous requests or when the user needs to narrow down what they want. After the user selects, answer and set choice back to null.');
  }

  lines.push('Timeline tool: if the user asks to add/schedule/remind/put something on the timeline, set timeline to {"title":"short title","time":"ISO-8601 UTC date-time","body":"details","durationMinutes":30,"reminderMinutes":10}. If time is ambiguous, ask a short clarifying question and keep timeline null.');

  if (memoryAvailable) {
    lines.push('Notes tool: add notes only for durable user preferences/facts or explicit "remember" requests. Use short note strings, or {"add":["new note"],"replace":[{"index":0,"text":"updated note"}]} to edit. Do not duplicate existing memory or store temporary facts. Notes are your memory; add important things.');
  }
  if (calculatorAvailable) {
    lines.push('Calculator tool: if exact arithmetic or conversion is needed, set calc to either {"expression":"2+2*10"} or {"value":12,"from":"eur","to":"dkk"}, then answer after the result is provided and set calc null.');
  }

  return lines.join(' ');
}

function buildMessages(contextText) {
  var messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'system', content: 'Current local time is ' + new Date().toString() + '.' }
  ];

  if (contextText) {
    messages.push({ role: 'system', content: contextText });
  }
  messages.push({ role: 'system', content: buildNotesContext() });

  var extra = getSetting('ExtraSystemPrompt', '');
  if (extra) {
    messages.push({ role: 'system', content: extra });
  }

  var start = Math.max(0, conversationHistory.length - 6);
  for (var i = start; i < conversationHistory.length; i++) {
    messages.push(conversationHistory[i]);
  }
  return messages;
}

function parseAssistantContent(content) {
  var text = String(content || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  var first = text.indexOf('{');
  var last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    text = text.substring(first, last + 1);
  }

  try {
    var parsed = JSON.parse(text);
    return {
      reply: String(parsed.reply || ''),
      timeline: parsed.timeline || null,
      search: parsed.search || null,
      scrape: parsed.scrape || null,
      notes: parsed.notes || null,
      calc: parsed.calc || null,
      weather: parsed.weather || null,
      location: parsed.location || null,
      choice: parsed.choice || null
    };
  } catch (err) {
    return {
      reply: String(content || ''),
      timeline: null,
      search: null,
      scrape: null,
      notes: null,
      calc: null,
      weather: null,
      location: null,
      choice: null
    };
  }
}

function safeEvalExpression(expression) {
  if (!/^[0-9+\-*/().,%\s]+$/.test(expression)) {
    throw new Error('Unsupported characters in expression');
  }
  var normalized = expression.replace(/%/g, '/100');
  /* eslint-disable no-new-func */
  return Function('return (' + normalized + ');')();
  /* eslint-enable no-new-func */
}

function unitFactor(unit) {
  var factors = {
    m: 1,
    meter: 1,
    meters: 1,
    km: 1000,
    kilometer: 1000,
    kilometers: 1000,
    cm: 0.01,
    mm: 0.001,
    ft: 0.3048,
    feet: 0.3048,
    foot: 0.3048,
    inch: 0.0254,
    inches: 0.0254,
    in: 0.0254,
    yd: 0.9144,
    yard: 0.9144,
    yards: 0.9144,
    mi: 1609.344,
    mile: 1609.344,
    miles: 1609.344,
    g: 1,
    gram: 1,
    grams: 1,
    kg: 1000,
    kilogram: 1000,
    kilograms: 1000,
    lb: 453.59237,
    lbs: 453.59237,
    pound: 453.59237,
    pounds: 453.59237,
    oz: 28.349523125,
    l: 1,
    liter: 1,
    liters: 1,
    ml: 0.001,
    cl: 0.01,
    dl: 0.1,
    gal: 3.785411784,
    gallon: 3.785411784,
    gallons: 3.785411784
  };
  return factors[String(unit || '').toLowerCase()];
}

function currencyRate(unit) {
  var rates = {
    dkk: 1,
    eur: 7.46,
    usd: 6.85,
    gbp: 8.75,
    sek: 0.68,
    nok: 0.64
  };
  return rates[String(unit || '').toLowerCase()];
}

function runCalculatorTool(calc) {
  if (!calc) {
    return null;
  }

  if (calc.expression) {
    var expressionResult = safeEvalExpression(String(calc.expression));
    return 'Calculator result: ' + calc.expression + ' = ' + expressionResult;
  }

  if (calc.value !== undefined && calc.from && calc.to) {
    var value = Number(calc.value);
    if (isNaN(value)) {
      throw new Error('Invalid numeric value for conversion');
    }

    var fromCurrency = currencyRate(calc.from);
    var toCurrency = currencyRate(calc.to);
    if (fromCurrency && toCurrency) {
      var dkkValue = value * fromCurrency;
      var currencyResult = dkkValue / toCurrency;
      return 'Calculator result: ' + value + ' ' + calc.from + ' = ' + currencyResult + ' ' + calc.to;
    }

    var fromFactor = unitFactor(calc.from);
    var toFactor = unitFactor(calc.to);
    if (!fromFactor || !toFactor) {
      throw new Error('Unsupported conversion units');
    }

    var baseValue = value * fromFactor;
    var converted = baseValue / toFactor;
    return 'Calculator result: ' + value + ' ' + calc.from + ' = ' + converted + ' ' + calc.to;
  }

  throw new Error('Unsupported calculator request');
}

function weatherCodeText(code) {
  var mapping = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Heavy thunderstorm with hail'
  };
  return mapping[code] || 'Unknown weather';
}

function parseTimeframe(timeframe) {
  var tf = String(timeframe || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  if (tf === 'now' || tf === 'current') {
    return { type: 'current' };
  }
  if (tf === 'today') {
    return { type: 'daily', offset: 0 };
  }
  if (tf === 'tomorrow') {
    return { type: 'daily', offset: 1 };
  }

  var hourMatch = tf.match(/^\+(\d+)h$/);
  if (hourMatch) {
    return { type: 'hourly', offset: Number(hourMatch[1]) };
  }

  var dayMatch = tf.match(/^\+(\d+)d$/);
  if (dayMatch) {
    return { type: 'daily', offset: Number(dayMatch[1]) };
  }

  return { type: 'current' };
}

function findHourlyIndex(hourly, targetDate) {
  var times = hourly && hourly.time ? hourly.time : [];
  if (!times.length) {
    return -1;
  }
  var target = targetDate.getTime();
  var bestIndex = 0;
  var bestDiff = Infinity;
  for (var i = 0; i < times.length; i++) {
    var t = new Date(times[i]).getTime();
    var diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function formatWeatherResult(place, data, timeframe) {
  var tf = parseTimeframe(timeframe);
  var locationName = place || 'Current location';
  var lines = ['Weather for ' + locationName];

  if (tf.type === 'current' && data.current) {
    var current = data.current;
    lines.push('Now: ' + Math.round(current.temperature_2m) + data.current_units.temperature_2m + ', ' + weatherCodeText(current.weather_code));
    lines.push('Feels like ' + Math.round(current.apparent_temperature) + data.current_units.apparent_temperature);
    lines.push('Wind ' + Math.round(current.wind_speed_10m) + data.current_units.wind_speed_10m + ', humidity ' + current.relative_humidity_2m + data.current_units.relative_humidity_2m);
    if (current.precipitation > 0) {
      lines.push('Precipitation ' + current.precipitation + data.current_units.precipitation);
    }
    return lines.join('\n');
  }

  if (tf.type === 'daily' && data.daily) {
    var daily = data.daily;
    var index = Math.max(0, Math.min(tf.offset, daily.time.length - 1));
    var dayLabel = tf.offset === 0 ? 'Today' : (tf.offset === 1 ? 'Tomorrow' : daily.time[index]);
    lines.push(dayLabel + ': ' + Math.round(daily.temperature_2m_min[index]) + '-' + Math.round(daily.temperature_2m_max[index]) + data.daily_units.temperature_2m_max + ', ' + weatherCodeText(daily.weather_code[index]));
    lines.push('Rain chance ' + daily.precipitation_probability_max[index] + data.daily_units.precipitation_probability_max);
    if (daily.precipitation_sum[index] > 0) {
      lines.push('Precipitation ' + daily.precipitation_sum[index] + data.daily_units.precipitation_sum);
    }
    return lines.join('\n');
  }

  if (tf.type === 'hourly' && data.hourly) {
    var target = new Date();
    target.setTime(target.getTime() + tf.offset * 60 * 60 * 1000);
    var hIndex = findHourlyIndex(data.hourly, target);
    if (hIndex === -1) {
      return lines.join('\n') + '\nForecast unavailable for requested time.';
    }
    var hourTime = new Date(data.hourly.time[hIndex]);
    lines.push('At ' + hourTime.getHours() + ':00: ' + Math.round(data.hourly.temperature_2m[hIndex]) + data.hourly_units.temperature_2m + ', ' + weatherCodeText(data.hourly.weather_code[hIndex]));
    lines.push('Rain chance ' + data.hourly.precipitation_probability[hIndex] + data.hourly_units.precipitation_probability + ', humidity ' + data.hourly.relative_humidity_2m[hIndex] + data.hourly_units.relative_humidity_2m);
    return lines.join('\n');
  }

  return lines.join('\n') + '\nWeather data unavailable.';
}

function resolvePlaceCoordinates(place, generation, callback) {
  function fail(error) {
    var fallback = REGION_FALLBACKS[place.toLowerCase()];
    if (fallback) {
      callback(null, fallback.lat, fallback.lon, place + ' (representative)');
      return;
    }
    callback(error, null, null, null);
  }

  var geoRequest = new XMLHttpRequest();
  trackRequest(geoRequest, generation);
  geoRequest.open('GET', OPENMETEO_GEO_URL + '?name=' + encodeURIComponent(place) + '&count=1', true);
  geoRequest.setRequestHeader('Accept', 'application/json');
  geoRequest.timeout = 30000;

  geoRequest.onload = function() {
    untrackRequest(geoRequest);
    if (!requestIsCurrent(geoRequest)) {
      return;
    }
    if (geoRequest.status < 200 || geoRequest.status >= 300) {
      fail('Geocoding failed (' + geoRequest.status + ').');
      return;
    }

    try {
      var geoJson = JSON.parse(geoRequest.responseText);
      var results = geoJson.results || [];
      if (results.length === 0) {
        fail('Could not find place: ' + place);
        return;
      }
      var result = results[0];
      var resolvedPlace = result.name + (result.country ? ', ' + result.country : '');
      callback(null, result.latitude, result.longitude, resolvedPlace);
    } catch (err) {
      fail('Bad geocoding response.');
    }
  };

  geoRequest.onerror = function() {
    untrackRequest(geoRequest);
    if (!requestIsCurrent(geoRequest)) {
      return;
    }
    fail('Geocoding network error.');
  };

  geoRequest.ontimeout = function() {
    untrackRequest(geoRequest);
    if (!requestIsCurrent(geoRequest)) {
      return;
    }
    fail('Geocoding timed out.');
  };

  geoRequest.send();
}

function runWeatherTool(weather, generation, callback) {
  if (!weather) {
    callback(null, 'No weather request.');
    return;
  }

  if (!getBoolSetting('EnableWeather', true)) {
    callback(null, 'Weather tool disabled.');
    return;
  }

  var place = weather.place ? String(weather.place).replace(/^\s+|\s+$/g, '') : '';
  var timeframe = weather.timeframe || 'now';
  sendToWatch({ Status: 'Getting weather...' });

  function doFetch(lat, lon, resolvedPlace) {
    sendToWatch({ Status: 'Getting weather...' });
    var request = new XMLHttpRequest();
    trackRequest(request, generation);
    var url = OPENMETEO_FORECAST_URL +
      '?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m' +
      '&hourly=temperature_2m,relative_humidity_2m,weather_code,precipitation_probability' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max' +
      '&timezone=auto&forecast_days=7';

    request.open('GET', url, true);
    request.setRequestHeader('Accept', 'application/json');
    request.timeout = 30000;

    request.onload = function() {
      untrackRequest(request);
      if (!requestIsCurrent(request)) {
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        callback(null, 'Weather service failed (' + request.status + ').');
        return;
      }

      try {
        var json = JSON.parse(request.responseText);
        var result = formatWeatherResult(resolvedPlace, json, timeframe);
        callback(result, null);
      } catch (err) {
        callback(null, 'Bad weather response.');
      }
    };

    request.onerror = function() {
      untrackRequest(request);
      if (!requestIsCurrent(request)) {
        return;
      }
      callback(null, 'Weather network error.');
    };

    request.ontimeout = function() {
      untrackRequest(request);
      if (!requestIsCurrent(request)) {
        return;
      }
      callback(null, 'Weather request timed out.');
    };

    request.send();
  }

  if (!place) {
    callback(null, 'No place provided for weather lookup.');
    return;
  }

  resolvePlaceCoordinates(place, generation, function(error, lat, lon, resolvedPlace) {
    if (error) {
      callback(null, error);
      return;
    }
    doFetch(lat, lon, resolvedPlace);
  });
}

function extractReplyFromPartialJson(content) {
  var marker = '"reply"';
  var markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    return '';
  }

  var i = markerIndex + marker.length;
  while (i < content.length && (content.charAt(i) === ' ' || content.charAt(i) === '\t' || content.charAt(i) === '\n' || content.charAt(i) === '\r')) {
    i++;
  }
  if (i >= content.length || content.charAt(i) !== ':') {
    return '';
  }
  i++;
  while (i < content.length && (content.charAt(i) === ' ' || content.charAt(i) === '\t' || content.charAt(i) === '\n' || content.charAt(i) === '\r')) {
    i++;
  }
  if (i >= content.length || content.charAt(i) !== '"') {
    return '';
  }
  i++;

  var result = '';
  var escaped = false;
  for (; i < content.length; i++) {
    var ch = content.charAt(i);
    if (escaped) {
      switch (ch) {
        case 'n':
          result += '\n';
          break;
        case 't':
          result += '\t';
          break;
        case 'r':
          result += '\r';
          break;
        case 'b':
          result += '\b';
          break;
        case 'f':
          result += '\f';
          break;
        case '\\':
          result += '\\';
          break;
        case '/':
          result += '/';
          break;
        case '"':
          result += '"';
          break;
        case 'u':
          if (i + 4 < content.length) {
            var hex = content.substring(i + 1, i + 5);
            var code = parseInt(hex, 16);
            if (!isNaN(code)) {
              result += String.fromCharCode(code);
              i += 4;
              break;
            }
          }
          return result;
        default:
          result += ch;
      }
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      break;
    } else {
      result += ch;
    }
  }

  return result;
}

function sendAssistantDelta(delta, chunkIndex, done) {
  sendToWatch({
    Status: done ? 'Done' : 'Receiving...',
    AssistantResponse: delta,
    ResponseChunkIndex: chunkIndex,
    ResponseChunkDone: done ? 1 : 0
  });
}

function reverseGeocode(lat, lon, generation, callback) {
  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  var url = NOMINATIM_REVERSE_URL +
    '?lat=' + encodeURIComponent(lat) +
    '&lon=' + encodeURIComponent(lon) +
    '&format=json&zoom=10&addressdetails=1';

  request.open('GET', url, true);
  request.setRequestHeader('Accept', 'application/json');
  request.setRequestHeader('User-Agent', 'PebbleAIAssistant/1.0');
  request.timeout = 15000;

  request.onload = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      callback(null);
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      var address = json.address || {};
      var city = address.city || address.town || address.village || address.suburb || address.hamlet || '';
      var region = address.state || address.county || address.region || address.province || '';
      var country = address.country || '';
      var parts = [];
      if (city) parts.push(city);
      if (region) parts.push(region);
      if (country) parts.push(country);
      var placeName = parts.length > 0 ? parts.join(', ') : (json.display_name || null);
      callback(placeName);
    } catch (err) {
      callback(null);
    }
  };

  request.onerror = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null);
  };

  request.ontimeout = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null);
  };

  request.send();
}

function runLocationTool(generation, callback) {
  if (!getBoolSetting('EnableLocation', false)) {
    callback(null, 'Location access disabled.');
    return;
  }

  if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
    callback(null, 'Location unavailable on this phone.');
    return;
  }

  sendToWatch({ Status: 'Getting location...' });
  navigator.geolocation.getCurrentPosition(function(pos) {
    if (generation !== requestGeneration) {
      return;
    }
    var lat = pos.coords.latitude;
    var lon = pos.coords.longitude;
    var accuracy = Math.round(pos.coords.accuracy || 0);
    reverseGeocode(lat, lon, generation, function(placeName) {
      if (generation !== requestGeneration) {
        return;
      }
      var context = 'Current location: latitude ' + lat + ', longitude ' + lon + ', accuracy about ' + accuracy + ' meters.';
      if (placeName) {
        context += ' Approximate place: ' + placeName + '.';
      }
      callback(context, null);
    });
  }, function(err) {
    if (generation !== requestGeneration) {
      return;
    }
    callback(null, 'Unable to get location: ' + (err.message || 'unknown error') + '.');
  }, {
    enableHighAccuracy: false,
    maximumAge: 10 * 60 * 1000,
    timeout: 10000
  });
}

function callModel(messages, generation, callback) {
  var apiKey = getSetting('OpenRouterApiKey', '');
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);

  debugLog('callModel start model=' + model + ' generation=' + generation + ' messages=' + messages.length);

  if (!apiKey) {
    showError('Open settings and add OpenRouter key.', 'Missing OpenRouter API key');
    return;
  }

  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  request.open('POST', OPENROUTER_URL, true);
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.setRequestHeader('HTTP-Referer', 'https://repebble.com/');
  request.setRequestHeader('X-Title', 'Pebble AI Chat');
  request.timeout = 60000;

  request.onload = function() {
    untrackRequest(request);
    debugLog('callModel onload status=' + request.status + ' current=' + requestIsCurrent(request) + ' len=' + (request.responseText || '').length);
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      showError('OpenRouter failed (' + request.status + ').', clip(request.responseText, 500));
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      addUsageStats(json.usage);
      var content = json.choices[0].message.content;
      debugLog('callModel content len=' + String(content || '').length + ' prefix=' + clip(content, 180));
      callback(parseAssistantContent(content));
    } catch (err) {
      showError('Bad AI response.', err.message);
    }
  };

  request.onerror = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    showError('Check internet connection.', 'Network error contacting OpenRouter');
  };

  request.ontimeout = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    showError('OpenRouter timed out.', 'OpenRouter request timed out');
  };

  request.send(JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.2
  }));
}

function callModelStream(messages, generation, callback) {
  var apiKey = getSetting('OpenRouterApiKey', '');
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);

  debugLog('callModelStream start model=' + model + ' generation=' + generation + ' messages=' + messages.length);

  if (!apiKey) {
    showError('Open settings and add OpenRouter key.', 'Missing OpenRouter API key');
    return;
  }

  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  var processedLength = 0;
  var pendingLine = '';
  var fullContent = '';
  var sentReplyLength = 0;
  var chunkIndex = 0;
  var sentAnyChunk = false;
  var fallbackStarted = false;
  var streamWatchdog = null;

  function startNonStreamingFallback(reason) {
    if (fallbackStarted || !requestIsCurrent(request)) {
      return;
    }

    fallbackStarted = true;
    debugLog('stream fallback to non-stream reason=' + reason + ' responseLen=' + (request.responseText || '').length + ' fullContentLen=' + fullContent.length);
    untrackRequest(request);
    request._cancelled = true;
    try {
      request.abort();
    } catch (err) {
      debugLog('stream abort before fallback failed: ' + err.message);
    }
    var fallbackGeneration = ++requestGeneration;
    callModel(messages, fallbackGeneration, function(retryParsed) {
      if (fallbackGeneration !== requestGeneration) {
        return;
      }
      callback(retryParsed, false);
    });
  }

  function processSseLine(line) {
    line = line.replace(/^\s+|\s+$/g, '');
    if (line.indexOf('data:') !== 0) {
      return;
    }

    var data = line.substring(5).replace(/^\s+|\s+$/g, '');
    if (!data || data === '[DONE]') {
      return;
    }

    try {
      var json = JSON.parse(data);
      if (json.usage) {
        addUsageStats(json.usage);
        debugLog('stream usage total=' + json.usage.total_tokens + ' cost=' + json.usage.cost);
      }
      var delta = json.choices && json.choices[0] && json.choices[0].delta;
      var contentDelta = delta && delta.content ? delta.content : '';
      var reasoningDelta = delta && (delta.reasoning || delta.reasoning_content || delta.thinking) ? String(delta.reasoning || delta.reasoning_content || delta.thinking) : '';
      if (!contentDelta && !reasoningDelta) {
        return;
      }

      if (reasoningDelta) {
        debugLog('stream reasoning delta len=' + reasoningDelta.length);
      }
      fullContent += contentDelta;
      debugLog('stream delta len=' + contentDelta.length + ' full=' + fullContent.length);
      if (streamWatchdog) {
        clearTimeout(streamWatchdog);
        streamWatchdog = null;
      }
      var replySoFar = extractReplyFromPartialJson(fullContent);
      if (replySoFar.length > sentReplyLength) {
        var newText = replySoFar.substring(sentReplyLength);
        sendAssistantDelta(newText, chunkIndex++, false);
        sentAnyChunk = true;
        sentReplyLength = replySoFar.length;
      }
    } catch (err) {
      console.log('Could not parse stream line: ' + err.message);
    }
  }

  function processNewText() {
    var newText = request.responseText.substring(processedLength);
    processedLength = request.responseText.length;
    pendingLine += newText;

    var lines = pendingLine.split('\n');
    pendingLine = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      processSseLine(lines[i]);
    }
  }

  request.open('POST', OPENROUTER_URL, true);
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('Accept', 'text/event-stream');
  request.setRequestHeader('Cache-Control', 'no-cache');
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.setRequestHeader('HTTP-Referer', 'https://repebble.com/');
  request.setRequestHeader('X-Title', 'Pebble AI Chat');
  request.timeout = 60000;

  request.onprogress = function() {
    if (!requestIsCurrent(request)) {
      return;
    }
    processNewText();
  };

  request.onreadystatechange = function() {
    if (request.readyState === 3 && requestIsCurrent(request)) {
      processNewText();
    }
  };

  request.onload = function() {
    if (streamWatchdog) {
      clearTimeout(streamWatchdog);
      streamWatchdog = null;
    }
    untrackRequest(request);
    if (fallbackStarted) {
      return;
    }
    debugLog('callModelStream onload status=' + request.status + ' current=' + requestIsCurrent(request) + ' responseLen=' + (request.responseText || '').length + ' fullContentLen=' + fullContent.length);
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      showError('OpenRouter failed (' + request.status + ').', clip(request.responseText, 500));
      return;
    }

    processNewText();
    if (pendingLine) {
      processSseLine(pendingLine);
      pendingLine = '';
    }

    var parsed = parseAssistantContent(fullContent);
    var finalReply = parsed.reply || extractReplyFromPartialJson(fullContent);
    if (!finalReply && !parsed.search && !parsed.scrape && !parsed.calc && !parsed.weather && !parsed.location) {
      finalReply = 'No response.';
    }
    debugLog('stream final replyLen=' + String(finalReply || '').length + ' search=' + !!parsed.search + ' scrape=' + !!parsed.scrape + ' notes=' + !!parsed.notes + ' prefix=' + clip(finalReply, 180));
    if (!fullContent || (finalReply === 'No response.' && !parsed.search && !parsed.scrape && !parsed.calc && !parsed.weather && !parsed.location)) {
      startNonStreamingFallback('empty-final');
      return;
    }

    if (finalReply && !sentAnyChunk) {
      sendAssistantDelta(finalReply, 0, true);
      sentAnyChunk = true;
    } else if (sentAnyChunk) {
      var missingText = finalReply.substring(sentReplyLength);
      if (missingText) {
        sendAssistantDelta(missingText, chunkIndex++, false);
      }
      sendAssistantDelta('', chunkIndex, true);
    }

    parsed.reply = finalReply || '';
    callback(parsed, sentAnyChunk);
  };

  request.onerror = function() {
    if (streamWatchdog) {
      clearTimeout(streamWatchdog);
      streamWatchdog = null;
    }
    untrackRequest(request);
    if (!requestIsCurrent(request) || fallbackStarted) {
      return;
    }
    showError('Check internet connection.', 'Network error contacting OpenRouter');
  };

  request.ontimeout = function() {
    if (streamWatchdog) {
      clearTimeout(streamWatchdog);
      streamWatchdog = null;
    }
    untrackRequest(request);
    if (!requestIsCurrent(request) || fallbackStarted) {
      return;
    }
    startNonStreamingFallback('stream-timeout');
  };

  streamWatchdog = setTimeout(function() {
    if (!sentAnyChunk && !fullContent) {
      startNonStreamingFallback('no-stream-after-' + STREAM_WATCHDOG_MS + 'ms');
    }
  }, STREAM_WATCHDOG_MS);

  request.send(JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.2,
    stream: true
  }));
}

function braveSearch(query, generation, callback) {
  var apiKey = getSetting('BraveSearchApiKey', '');
  debugLog('braveSearch start query=' + query + ' generation=' + generation);
  if (!getBoolSetting('EnableSearch', false) || !apiKey) {
    callback(null, 'Search unavailable. Add Brave key in settings.');
    return;
  }

  sendToWatch({ Status: 'Searching...' });
  incrementStat('searches');
  sendStatsToWatch();
  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  request.open('GET', BRAVE_SEARCH_URL + '?count=' + MAX_SEARCH_RESULTS + '&q=' + encodeURIComponent(query), true);
  request.setRequestHeader('Accept', 'application/json');
  request.setRequestHeader('X-Subscription-Token', apiKey);
  request.timeout = 30000;

  request.onload = function() {
    untrackRequest(request);
    debugLog('braveSearch onload status=' + request.status + ' current=' + requestIsCurrent(request));
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      callback(null, 'Brave Search failed (' + request.status + ').');
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      var results = json.web && json.web.results ? json.web.results : [];
      var lines = ['Web search results for: ' + query];
      for (var i = 0; i < results.length && i < MAX_SEARCH_RESULTS; i++) {
        lines.push((i + 1) + '. ' + (results[i].title || 'Untitled'));
        lines.push('URL: ' + (results[i].url || ''));
        lines.push('Snippet: ' + (results[i].description || ''));
      }
      if (results.length === 0) {
        lines.push('No results found.');
      }
      callback(lines.join('\n'), null);
    } catch (err) {
      callback(null, 'Bad search response.');
    }
  };

  request.onerror = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null, 'Search network error.');
  };

  request.ontimeout = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null, 'Search timed out.');
  };

  request.send();
}

function firecrawlScrape(url, generation, callback) {
  var apiKey = getSetting('FirecrawlApiKey', '');
  debugLog('firecrawlScrape start url=' + url + ' generation=' + generation);
  if (!getBoolSetting('EnableScrape', false) || !apiKey) {
    callback(null, 'Scrape unavailable. Add Firecrawl key in settings.');
    return;
  }

  sendToWatch({ Status: 'Scraping...' });
  incrementStat('searches');
  sendStatsToWatch();
  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  request.open('POST', FIRECRAWL_SCRAPE_URL, true);
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.timeout = 30000;

  request.onload = function() {
    untrackRequest(request);
    debugLog('firecrawlScrape onload status=' + request.status + ' current=' + requestIsCurrent(request));
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      callback(null, 'Firecrawl scrape failed (' + request.status + ').');
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      if (!json.success || !json.data) {
        callback(null, 'Firecrawl scrape returned no content.');
        return;
      }
      var title = json.data.metadata && json.data.metadata.title ? json.data.metadata.title : '';
      var markdown = String(json.data.markdown || '');
      var lines = ['Scraped page: ' + url];
      if (title) {
        lines.push('Title: ' + title);
      }
      if (markdown) {
        if (markdown.length > MAX_SCRAPE_CHARS) {
          markdown = markdown.substring(0, MAX_SCRAPE_CHARS) + '\n... (truncated)';
        }
        lines.push(markdown);
      } else {
        lines.push('No readable content found.');
      }
      callback(lines.join('\n'), null);
    } catch (err) {
      callback(null, 'Bad scrape response.');
    }
  };

  request.onerror = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null, 'Scrape network error.');
  };

  request.ontimeout = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null, 'Scrape timed out.');
  };

  request.send(JSON.stringify({ url: url, formats: ['markdown'] }));
}

function finishAssistantTurn(prompt, toolEntries, parsed, alreadySent) {
  var reply = parsed.reply || 'No response.';
  debugLog('finishAssistantTurn alreadySent=' + alreadySent + ' replyLen=' + reply.length + ' prefix=' + clip(reply, 180));
  conversationHistory.push({ role: 'user', content: prompt });
  if (toolEntries) {
    for (var j = 0; j < toolEntries.length; j++) {
      conversationHistory.push(toolEntries[j]);
    }
  }
  conversationHistory.push({ role: 'assistant', content: reply });
  if (conversationHistory.length > 12) {
    conversationHistory = conversationHistory.slice(conversationHistory.length - 12);
  }

  if (!alreadySent) {
    sendAssistantReply(reply);
  }

  if (parsed.timeline) {
    addTimelinePin(parsed.timeline);
  }

  if (parsed.notes) {
    if (getBoolSetting('EnableMemory', true)) {
      applyMemoryChanges(parsed.notes);
    }
  }

  saveCurrentSessionToConversationHistory();
  sendStatsToWatch();
}

function callOpenRouter(prompt) {
  requestGeneration++;
  var generation = requestGeneration;
  debugLog('callOpenRouter promptLen=' + String(prompt || '').length + ' generation=' + generation);
  incrementStat('messages');
  sendStatsToWatch();
  sendToWatch({ Status: 'Thinking...' });

  var searchAvailable = getBoolSetting('EnableSearch', false) && !!getSetting('BraveSearchApiKey', '');
  var scrapeAvailable = getScrapeAvailable();
  var weatherAvailable = getBoolSetting('EnableWeather', true);
  debugLog('context ready searchAvailable=' + searchAvailable + ' scrapeAvailable=' + scrapeAvailable + ' weatherAvailable=' + weatherAvailable);
  var contextText =
    'Search available: ' + (searchAvailable ? 'yes, request Brave Search with the search field when needed.' : 'no.') +
    '\nScrape available: ' + (scrapeAvailable ? 'yes, request Firecrawl scrape with the scrape field when needed.' : 'no.') +
    '\nWeather available: ' + (weatherAvailable ? 'yes, request weather with the weather field when needed.' : 'no.') +
    '\nChoice/ask/question available: ' + (getBoolSetting('EnableChoice', true) ? 'yes, request choice when you need the user to pick from options.' : 'no.');

  var baseMessages = buildMessages(contextText);
  var userMessage = { role: 'user', content: prompt };
  var firstMessages = baseMessages.concat([userMessage]);

  callModelStream(firstMessages, generation, function(parsed, alreadySent) {
    if (parsed.search) {
      var searchRequest = { role: 'assistant', content: JSON.stringify({ search: parsed.search }) };
      braveSearch(String(parsed.search), generation, function(searchResultsText, searchError) {
        if (searchError) {
          showError(searchError, 'Search query: ' + parsed.search);
          return;
        }
        sendToWatch({ Status: 'Thinking...' });
        var searchResultEntry = { role: 'tool', content: searchResultsText };
        var secondMessages = baseMessages.concat([userMessage, searchRequest, searchResultEntry]);
        callModelStream(secondMessages, generation, function(finalParsed, finalAlreadySent) {
          finishAssistantTurn(prompt, [searchRequest, searchResultEntry], finalParsed, finalAlreadySent);
        });
      });
      return;
    }

    if (parsed.scrape) {
      var scrapeRequest = { role: 'assistant', content: JSON.stringify({ scrape: parsed.scrape }) };
      firecrawlScrape(String(parsed.scrape), generation, function(scrapeResultsText, scrapeError) {
        if (scrapeError) {
          showError(scrapeError, 'Scrape URL: ' + parsed.scrape);
          return;
        }
        sendToWatch({ Status: 'Thinking...' });
        var scrapeResultEntry = { role: 'tool', content: scrapeResultsText };
        var scrapeMessages = baseMessages.concat([userMessage, scrapeRequest, scrapeResultEntry]);
        callModelStream(scrapeMessages, generation, function(finalParsed, finalAlreadySent) {
          finishAssistantTurn(prompt, [scrapeRequest, scrapeResultEntry], finalParsed, finalAlreadySent);
        });
      });
      return;
    }

    if (parsed.weather) {
      var weatherRequest = { role: 'assistant', content: JSON.stringify({ weather: parsed.weather }) };
      runWeatherTool(parsed.weather, generation, function(weatherResultsText, weatherError) {
        if (weatherError) {
          showError(weatherError, 'Weather request: ' + JSON.stringify(parsed.weather));
          return;
        }
        sendToWatch({ Status: 'Thinking...' });
        var weatherResultEntry = { role: 'tool', content: weatherResultsText };
        var weatherMessages = baseMessages.concat([userMessage, weatherRequest, weatherResultEntry]);
        callModelStream(weatherMessages, generation, function(finalParsed, finalAlreadySent) {
          finishAssistantTurn(prompt, [weatherRequest, weatherResultEntry], finalParsed, finalAlreadySent);
        });
      });
      return;
    }

    if (parsed.location) {
      var locationRequest = { role: 'assistant', content: JSON.stringify({ location: true }) };
      runLocationTool(generation, function(locationResultsText, locationError) {
        var locationResultEntry;
        if (locationError) {
          locationResultEntry = { role: 'tool', content: 'Location result: ' + locationError };
        } else {
          locationResultEntry = { role: 'tool', content: locationResultsText };
        }
        sendToWatch({ Status: 'Thinking...' });
        var locationMessages = baseMessages.concat([userMessage, locationRequest, locationResultEntry]);
        callModelStream(locationMessages, generation, function(finalParsed, finalAlreadySent) {
          finishAssistantTurn(prompt, [locationRequest, locationResultEntry], finalParsed, finalAlreadySent);
        });
      });
      return;
    }

    if (parsed.calc) {
      if (!getBoolSetting('EnableCalculator', true)) {
        showError('Calculator disabled.', 'Model requested calculator tool while disabled');
        return;
      }
      try {
        var calculatorResultsText = runCalculatorTool(parsed.calc);
        debugLog('calculator tool result=' + calculatorResultsText);
        var calcRequest = { role: 'assistant', content: JSON.stringify({ calc: parsed.calc }) };
        var calcResultEntry = { role: 'tool', content: calculatorResultsText };
        sendToWatch({ Status: 'Calculating...' });
        var calculatorMessages = baseMessages.concat([userMessage, calcRequest, calcResultEntry]);
        callModelStream(calculatorMessages, generation, function(finalParsed, finalAlreadySent) {
          finishAssistantTurn(prompt, [calcRequest, calcResultEntry], finalParsed, finalAlreadySent);
        });
      } catch (err) {
        showError('Calculator failed.', err.message);
      }
      return;
    }

    if (parsed.choice) {
      if (!getBoolSetting('EnableChoice', true)) {
        showError('Choice prompts disabled.', 'Model requested choice tool while disabled');
        return;
      }
      var choiceQuestion = String(parsed.choice.question || 'Choose');
      var choiceOptions = (parsed.choice.options || []).slice(0, 7);
      if (choiceOptions.length === 0) {
        choiceOptions = ['Yes', 'No'];
      }
      sendToWatch({ Status: 'Choose', ChoiceQuestion: choiceQuestion, ChoiceOptions: choiceOptions.join('\n') });
      pendingChoiceGeneration = generation;
      pendingChoicePrompt = prompt;
      var assistantWithChoice = { role: 'assistant', content: JSON.stringify({ reply: parsed.reply || '', choice: parsed.choice }) };
      pendingChoiceMessages = baseMessages.concat([userMessage, assistantWithChoice]);
      return;
    }

    finishAssistantTurn(prompt, [], parsed, alreadySent);
  });
}

function normalizeTimeline(timeline) {
  var title = clip(timeline.title || 'AI Timeline Item', 64);
  var body = clip(timeline.body || title, 512);
  var time = new Date(timeline.time);
  var now = new Date();

  if (!timeline.time || isNaN(time.getTime())) {
    throw new Error('Missing timeline time.');
  }

  if (time.getTime() < now.getTime() - (2 * 24 * 60 * 60 * 1000)) {
    throw new Error('Timeline time is too far in the past.');
  }

  var duration = parseInt(timeline.durationMinutes, 10);
  if (isNaN(duration) || duration < 0) {
    duration = 30;
  }

  var id = 'ai-chat-' + now.getTime() + '-' + Math.floor(Math.random() * 100000);
  var pin = {
    id: id,
    time: time.toISOString(),
    duration: duration,
    layout: {
      type: 'genericPin',
      title: title,
      tinyIcon: 'system://images/TIMELINE_CALENDAR',
      body: body
    },
    createNotification: {
      layout: {
        type: 'genericNotification',
        title: 'Timeline Added',
        tinyIcon: 'system://images/NOTIFICATION_FLAG',
        body: title
      }
    }
  };

  var reminderMinutes = parseInt(timeline.reminderMinutes, 10);
  if (!isNaN(reminderMinutes) && reminderMinutes > 0) {
    var reminderTime = new Date(time.getTime() - reminderMinutes * 60 * 1000);
    if (reminderTime.getTime() > now.getTime()) {
      pin.reminders = [{
        time: reminderTime.toISOString(),
        layout: {
          type: 'genericReminder',
          title: title,
          tinyIcon: 'system://images/ALARM_CLOCK'
        }
      }];
    }
  }

  return pin;
}

function addTimelinePin(timeline) {
  var pin;
  try {
    pin = normalizeTimeline(timeline);
  } catch (err) {
    console.log('Timeline pin not added: ' + err.message);
    return;
  }

  Pebble.getTimelineToken(function(token) {
    var request = new XMLHttpRequest();
    request.open('PUT', TIMELINE_URL + encodeURIComponent(pin.id), true);
    request.setRequestHeader('Content-Type', 'application/json');
    request.setRequestHeader('X-User-Token', token);
    request.timeout = 30000;

    request.onload = function() {
      if (request.status < 200 || request.status >= 300) {
        console.log('Timeline error ' + request.status + ': ' + request.responseText);
      }
    };

    request.onerror = function() {
      console.log('Timeline network error');
    };

    request.ontimeout = function() {
      console.log('Timeline timed out');
    };

    request.send(JSON.stringify(pin));
  }, function(error) {
    console.log('No timeline token: ' + clip(error, 80));
  });
}

Pebble.addEventListener('ready', function() {
  console.log('PebbleKit JS ready');
  sendStatsToWatch();
  sendToolStatesToWatch();
  refreshRemainingCredits();
});

Pebble.addEventListener('appmessage', function(e) {
  if (e.payload && e.payload.RefreshStats) {
    sendStatsToWatch();
    refreshRemainingCredits();
    return;
  }

  if (e.payload && e.payload.ToggleLocation) {
    var locationEnabled = toggleBoolSetting('EnableLocation', false);
    sendToWatch({ Status: locationEnabled ? 'Location on' : 'Location off' });
    sendToolStatesToWatch();
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.ToggleMemory) {
    var memoryEnabled = toggleBoolSetting('EnableMemory', true);
    sendToWatch({ Status: memoryEnabled ? 'Memory on' : 'Memory off' });
    sendToolStatesToWatch();
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.ToggleCalculator) {
    var calculatorEnabled = toggleBoolSetting('EnableCalculator', true);
    sendToWatch({ Status: calculatorEnabled ? 'Calculator on' : 'Calculator off' });
    sendToolStatesToWatch();
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.ToggleSearch) {
    var searchEnabled = toggleBoolSetting('EnableSearch', false);
    sendToWatch({ Status: searchEnabled ? 'Search on' : 'Search off' });
    sendToolStatesToWatch();
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.ToggleWeather) {
    var weatherEnabled = toggleBoolSetting('EnableWeather', true);
    sendToWatch({ Status: weatherEnabled ? 'Weather on' : 'Weather off' });
    sendToolStatesToWatch();
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.ToggleChoice) {
    var choiceEnabled = toggleBoolSetting('EnableChoice', true);
    sendToWatch({ Status: choiceEnabled ? 'Choice on' : 'Choice off' });
    sendToolStatesToWatch();
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.OpenSessions) {
    sendToWatch({ OpenSessions: sessionsToWatchText() });
    return;
  }

  if (e.payload && e.payload.CancelRequest) {
    cancelActiveRequests();
    return;
  }

  if (e.payload && e.payload.ClearSession) {
    cancelActiveRequests();
    conversationHistory = [];
    sendToWatch({ Status: 'New session' });
    return;
  }

  var prompt = e.payload && e.payload.Prompt;
  if (prompt) {
    callOpenRouter(prompt);
  }

  var choiceAnswer = e.payload && e.payload.ChoiceAnswer;
  if (choiceAnswer !== undefined) {
    debugLog('ChoiceAnswer=' + String(choiceAnswer) + ' pending=' + !!pendingChoiceMessages);
    if (pendingChoiceMessages) {
      var answer = String(choiceAnswer || '');
      if (!answer) {
        answer = 'The user said their own answer.';
      }
      var choiceToolResult = { role: 'tool', content: 'User selected: ' + answer };
      var followMessages = pendingChoiceMessages.concat([choiceToolResult]);
      callModelStream(followMessages, pendingChoiceGeneration, function(finalParsed, finalAlreadySent) {
        finishAssistantTurn(pendingChoicePrompt, [{ role: 'assistant', content: JSON.stringify({ choice: { answer: answer } }) }, choiceToolResult], finalParsed, finalAlreadySent);
      });
      pendingChoiceGeneration = 0;
      pendingChoicePrompt = null;
      pendingChoiceMessages = null;
    }
    return;
  }

  var choiceCancel = e.payload && e.payload.ChoiceCancel;
  if (choiceCancel) {
    debugLog('ChoiceCancel pending=' + !!pendingChoiceMessages);
    if (pendingChoiceMessages) {
      var cancelResult = { role: 'tool', content: 'User cancelled the choice prompt.' };
      var cancelMessages = pendingChoiceMessages.concat([cancelResult]);
      callModelStream(cancelMessages, pendingChoiceGeneration, function(finalParsed, finalAlreadySent) {
        finishAssistantTurn(pendingChoicePrompt, [{ role: 'assistant', content: JSON.stringify({ choice: null }) }, cancelResult], finalParsed, finalAlreadySent);
      });
      pendingChoiceGeneration = 0;
      pendingChoicePrompt = null;
      pendingChoiceMessages = null;
    }
    return;
  }
});

Pebble.addEventListener('showConfiguration', function() {
  var stats = getMonthlyStats();
  clay.setSettings({
    NotesMemoryText: notesToText(),
    OpenSessions: sessionsToText(),
    StatsUsedCredits: String(stats.usageCredits || 0),
    StatsMessages: String(stats.messages || 0),
    StatsSearches: String(stats.searches || 0),
    ExtraSystemPrompt: getSetting('ExtraSystemPrompt', ''),
    OpenRouterApiKey: getSetting('OpenRouterApiKey', ''),
    OpenRouterModel: getSetting('OpenRouterModel', DEFAULT_MODEL),
    EnableLocation: getBoolSetting('EnableLocation', false),
    EnableMemory: getBoolSetting('EnableMemory', true),
    EnableCalculator: getBoolSetting('EnableCalculator', true),
    EnableSearch: getBoolSetting('EnableSearch', false),
    EnableScrape: getBoolSetting('EnableScrape', false),
    EnableWeather: getBoolSetting('EnableWeather', true),
    EnableChoice: getBoolSetting('EnableChoice', true),
    BraveSearchApiKey: getSetting('BraveSearchApiKey', ''),
    FirecrawlApiKey: getSetting('FirecrawlApiKey', ''),
    DebugLog: localStorage.getItem('DebugLog') || ''
  });
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) {
    return;
  }

  var convertedSettings = clay.getSettings(e.response);
  var rawSettings = clay.getSettings(e.response, false);
  saveSettings(convertedSettings, rawSettings);
  sendToWatch({ Status: 'Settings saved' });
  sendToolStatesToWatch();
  sendStatsToWatch();
  refreshRemainingCredits();
});
