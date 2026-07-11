var Clay = require('@rebble/clay');
var messageKeys = require('message_keys');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
var OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
var BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
var TIMELINE_URL = 'https://timeline-api.getpebble.com/v1/user/pins/';
var DEFAULT_MODEL = 'moonshotai/kimi-k2.5';
var RESPONSE_CHUNK_CHARS = 600;
var MAX_SEARCH_RESULTS = 3;
var MAX_NOTES = 30;
var MAX_NOTE_CHARS = 240;
var MAX_SESSIONS = 20;
var STREAM_WATCHDOG_MS = 30000; // Wait longer before falling back from streaming to non-streaming

var conversationHistory = [];
var sendQueue = [];
var sending = false;
var activeRequests = [];
var requestGeneration = 0;

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
      ';search=' + (getBoolSetting('EnableSearch', false) ? '1' : '0')
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

function saveSessionsFromText(text) {
  var chunks = String(text || '').split('\n---\n');
  var sessions = [];
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i].replace(/^\s+|\s+$/g, '');
    if (!chunk || chunk === 'No saved sessions yet.') {
      continue;
    }
    var lines = chunk.split('\n');
    if (lines.length >= 2) {
      sessions.push({
        createdAt: lines[0].replace(/^Session\s+\d+\s+\|\s+/, ''),
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

function addNotes(notesToAdd) {
  if (!notesToAdd) {
    return;
  }

  if (!(notesToAdd instanceof Array)) {
    notesToAdd = [notesToAdd];
  }

  var notes = getNotes();
  for (var i = 0; i < notesToAdd.length; i++) {
    var text = clip(notesToAdd[i], MAX_NOTE_CHARS).replace(/^\s+|\s+$/g, '');
    if (text) {
      notes.push({ text: text, createdAt: new Date().toISOString() });
    }
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
  var braveApiKey = settingValue(convertedSettings, rawSettings, 'BraveSearchApiKey', messageKeys.BraveSearchApiKey);
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
  if (braveApiKey !== undefined) {
    localStorage.setItem('BraveSearchApiKey', String(braveApiKey).trim());
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
  var prompt = [
    'You are a practical assistant for a Pebble watch. Replies must be useful, compact, and readable on a tiny screen. Do not use markdown, write in plain text.',
    'Return only valid JSON in this shape: {"reply":"watch answer","timeline":null,"search":null,"notes":null,"calc":null}.',
    'Use 24-hour time. Use the provided current time, location context, search results, and notes/memory when relevant.',
    'Search tool: if current web info is needed and search is available, return {"reply":"Searching...","timeline":null,"search":"short query","notes":null}. Request search at most once; after results are provided, answer and set search null.',
    'Timeline tool: if the user asks to add/schedule/remind/put something on the timeline, set timeline to {"title":"short title","time":"ISO-8601 UTC date-time","body":"details","durationMinutes":30,"reminderMinutes":10}. If time is ambiguous, ask a short clarifying question and keep timeline null.',
    'Notes tool: add notes only for durable user preferences/facts or explicit "remember" requests. Put short note strings in notes. Do not duplicate existing memory or store temporary facts. The notes are your database; add things you think are important.',
    'Calculator tool: if exact arithmetic or conversion is needed and calculator is available, return calc as either {"expression":"2+2*10"} or {"value":12,"from":"eur","to":"dkk"}. After the result is provided, answer and set calc null.'
  ].join(' ');
  var extra = getSetting('ExtraSystemPrompt', '');
  if (extra) {
    prompt += ' User extra instructions: \"' + extra + '\"';
  }
  return prompt;
}

function buildMessages(prompt, contextText, searchResultsText, calculatorResultsText) {
  var messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'system', content: 'Current local time is ' + new Date().toString() + '.' }
  ];

  if (contextText) {
    messages.push({ role: 'system', content: contextText });
  }
  messages.push({ role: 'system', content: buildNotesContext() });
  if (searchResultsText) {
    messages.push({ role: 'system', content: searchResultsText });
  }
  if (calculatorResultsText) {
    messages.push({ role: 'system', content: calculatorResultsText });
  }

  var start = Math.max(0, conversationHistory.length - 6);
  for (var i = start; i < conversationHistory.length; i++) {
    messages.push(conversationHistory[i]);
  }
  messages.push({ role: 'user', content: prompt });
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
      notes: parsed.notes || null,
      calc: parsed.calc || null
    };
  } catch (err) {
    return {
      reply: String(content || ''),
      timeline: null,
      search: null,
      notes: null,
      calc: null
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

function getLocationContext(generation, callback) {
  if (!getBoolSetting('EnableLocation', false)) {
    callback('Location access disabled.');
    return;
  }

  if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
    callback('Location unavailable on this phone.');
    return;
  }

  sendToWatch({ Status: 'Getting location...' });
  navigator.geolocation.getCurrentPosition(function(pos) {
    if (generation !== requestGeneration) {
      return;
    }
    callback('User location: latitude ' + pos.coords.latitude + ', longitude ' + pos.coords.longitude +
      ', accuracy about ' + Math.round(pos.coords.accuracy || 0) + ' meters.');
  }, function(err) {
    if (generation !== requestGeneration) {
      return;
    }
    callback('Location requested but unavailable: ' + err.message + '.');
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
    var finalReply = parsed.reply || extractReplyFromPartialJson(fullContent) || 'No response.';
    debugLog('stream final replyLen=' + finalReply.length + ' search=' + !!parsed.search + ' notes=' + !!parsed.notes + ' prefix=' + clip(finalReply, 180));
    if (!fullContent || finalReply === 'No response.') {
      startNonStreamingFallback('empty-final');
      return;
    }

    if (!sentAnyChunk) {
      sendAssistantDelta(finalReply, 0, true);
      sentAnyChunk = true;
    } else {
      var missingText = finalReply.substring(sentReplyLength);
      if (missingText) {
        sendAssistantDelta(missingText, chunkIndex++, false);
      }
      sendAssistantDelta('', chunkIndex, true);
    }

    parsed.reply = finalReply;
    callback(parsed, true);
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

function finishAssistantTurn(prompt, parsed, alreadySent) {
  var reply = parsed.reply || 'No response.';
  debugLog('finishAssistantTurn alreadySent=' + alreadySent + ' replyLen=' + reply.length + ' prefix=' + clip(reply, 180));
  conversationHistory.push({ role: 'user', content: prompt });
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
      addNotes(parsed.notes);
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
  getLocationContext(generation, function(locationContext) {
    var searchAvailable = getBoolSetting('EnableSearch', false) && !!getSetting('BraveSearchApiKey', '');
    debugLog('context ready searchAvailable=' + searchAvailable + ' locationContext=' + clip(locationContext, 120));
    var contextText = locationContext + '\nSearch available: ' + (searchAvailable ? 'yes, request search with the search field when needed.' : 'no.') ;
    var firstMessages = buildMessages(prompt, contextText, null, null);

    if (!searchAvailable) {
      callModelStream(firstMessages, generation, function(parsed, alreadySent) {
        if (parsed.search) {
          braveSearch(String(parsed.search), generation, function(searchResultsText, searchError) {
            if (searchError) {
              showError(searchError, 'Search query: ' + parsed.search);
              return;
            }
            sendToWatch({ Status: 'Thinking...' });
            var secondMessages = buildMessages(prompt, contextText, searchResultsText, null);
            callModelStream(secondMessages, generation, function(finalParsed, finalAlreadySent) {
              finishAssistantTurn(prompt, finalParsed, finalAlreadySent);
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
            var calculatorMessages = buildMessages(prompt, contextText, null, calculatorResultsText);
            callModel(calculatorMessages, generation, function(finalParsed) {
              finishAssistantTurn(prompt, finalParsed, false);
            });
          } catch (err) {
            showError('Calculator failed.', err.message);
          }
          return;
        }
        finishAssistantTurn(prompt, parsed, alreadySent);
      });
      return;
    }

    callModel(firstMessages, generation, function(parsed) {
      if (parsed.search) {
        braveSearch(String(parsed.search), generation, function(searchResultsText, searchError) {
          if (searchError) {
            showError(searchError, 'Search query: ' + parsed.search);
            return;
          }
          sendToWatch({ Status: 'Thinking...' });
          var secondMessages = buildMessages(prompt, contextText, searchResultsText, null);
          callModelStream(secondMessages, generation, function(finalParsed, alreadySent) {
            finishAssistantTurn(prompt, finalParsed, alreadySent);
          });
        });
      } else if (parsed.calc) {
        if (!getBoolSetting('EnableCalculator', true)) {
          showError('Calculator disabled.', 'Model requested calculator tool while disabled');
          return;
        }
        try {
          var calculatorResultsText = runCalculatorTool(parsed.calc);
          debugLog('calculator tool result=' + calculatorResultsText);
          var calculatorMessages = buildMessages(prompt, contextText, null, calculatorResultsText);
          callModel(calculatorMessages, generation, function(finalParsed) {
            finishAssistantTurn(prompt, finalParsed, false);
          });
        } catch (err) {
          showError('Calculator failed.', err.message);
        }
      } else {
        finishAssistantTurn(prompt, parsed, false);
      }
    });
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

  if (e.payload && e.payload.OpenSessions) {
    sendToWatch({ OpenSessions: sessionsToText() });
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
    BraveSearchApiKey: getSetting('BraveSearchApiKey', ''),
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
