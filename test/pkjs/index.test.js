const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/pkjs/index.js'), 'utf8');

function createRuntime(settings = {}) {
  const listeners = {};
  const requests = [];
  const sentMessages = [];
  const timers = [];
  const storage = new Map(Object.entries({ OpenRouterApiKey: 'test-key', ...settings }));
  let claySettings = { converted: {}, raw: {} };
  let sendHandler = (dict, success) => success();

  function Clay(config) { this.config = config; }
  Clay.prototype.registerComponent = function() {};
  Clay.prototype.setSettings = function() {};
  Clay.prototype.generateUrl = function() { return 'https://config.invalid'; };
  Clay.prototype.getSettings = function(response, convert) {
    return convert === false ? claySettings.raw : claySettings.converted;
  };

  function FakeXHR() {
    this.headers = {};
    this.responseText = '';
    this.status = 0;
    this.readyState = 0;
    this.aborted = false;
    requests.push(this);
  }
  FakeXHR.prototype.open = function(method, url) {
    this.method = method;
    this.url = url;
  };
  FakeXHR.prototype.setRequestHeader = function(name, value) {
    this.headers[name] = value;
  };
  FakeXHR.prototype.send = function(body) {
    this.body = body;
    this.sent = true;
  };
  FakeXHR.prototype.abort = function() {
    this.aborted = true;
  };

  const context = {
    console: { log() {} },
    Date,
    XMLHttpRequest: FakeXHR,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    navigator: { geolocation: null },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
    require(name) {
      if (name === '@rebble/clay') return Clay;
      if (name === 'message_keys') return {};
      if (name === './config') return [];
      if (name === './textarea') return {};
      throw new Error(`Unexpected require: ${name}`);
    },
    Pebble: {
      addEventListener(name, callback) { listeners[name] = callback; },
      sendAppMessage(dict, success, failure) {
        sentMessages.push({ ...dict });
        sendHandler(dict, success, failure);
      },
      getTimelineToken(success) { success('timeline-token'); },
      getActiveWatchInfo() { return { firmware: { major: 4, minor: 41, patch: 1 } }; },
      openURL() {}
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'src/pkjs/index.js' });
  context.WATCH_RENDER_GAP_MS = 0;

  return {
    context,
    listeners,
    requests,
    sentMessages,
    storage,
    timers,
    setClaySettings(settings) { claySettings = settings; },
    setSendHandler(handler) { sendHandler = handler; }
  };
}

test('phone settings can reset the first-run notice on the watch', () => {
  const runtime = createRuntime();
  runtime.setClaySettings({
    converted: {},
    raw: { ResetFirstRunNotice: { value: true } }
  });

  runtime.listeners.webviewclosed({ response: 'saved' });

  assert.ok(runtime.sentMessages.some(message =>
    message.ResetFirstRunNotice === 1 && message.Status === 'Notice reset'));
});

function streamResponse(request, value) {
  const toolCalls = (value.toolCalls || []).map((call, index) => ({
    index,
    id: `call_test_${index}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) }
  }));
  const delta = {};
  if (value.reply) delta.content = value.reply;
  if (toolCalls.length) delta.tool_calls = toolCalls;
  request.status = 200;
  request.responseText = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n`;
  if (request.onprogress) request.onprogress();
  request.onload();
}

function streamTextResponse(request, content) {
  request.status = 200;
  request.responseText = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n`;
  if (request.onprogress) request.onprogress();
  request.onload();
}

function normalResponse(request, value) {
  const toolCalls = (value.toolCalls || []).map((call, index) => ({
    id: `call_test_${index}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) }
  }));
  request.status = 200;
  request.responseText = JSON.stringify({ choices: [{ message: { content: value.reply || null, tool_calls: toolCalls } }] });
  request.onload();
}

function prompt(runtime, text = 'hello', requestId = 1) {
  runtime.listeners.appmessage({ payload: { Prompt: text, RequestId: requestId } });
}

function modelRequests(runtime) {
  return runtime.requests.filter(request => request.url && request.url.includes('/chat/completions'));
}

test('rejects conversions between incompatible dimensions', () => {
  const runtime = createRuntime();
  assert.throws(
    () => runtime.context.runCalculatorTool({ value: 1, from: 'kg', to: 'm' }),
    /incompatible/
  );
});

test('reverse geocoding formats a precise street and locality address', () => {
  const runtime = createRuntime();
  const address = runtime.context.formatReverseGeocodeAddress({
    address: {
      house_number: '12',
      road: 'Example Road',
      postcode: '4500',
      municipality: 'Odsherred Municipality',
      state: 'Region Zealand',
      country: 'Denmark'
    }
  });

  assert.equal(address, 'Example Road 12, 4500 Odsherred Municipality, Denmark');
});

test('reverse geocoding retains a region fallback when no locality is available', () => {
  const runtime = createRuntime();
  const address = runtime.context.formatReverseGeocodeAddress({
    address: { state: 'Region Zealand', country: 'Denmark' }
  });

  assert.equal(address, 'Region Zealand, Denmark');
});

test('final answers stream as plain text without a JSON wrapper', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Say hello');
  streamTextResponse(modelRequests(runtime)[0], 'Hello from Pebble.');

  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'Hello from Pebble.'));
  assert.match(runtime.context.buildSystemPrompt(), /watch-friendly answer as plain text/);
});

test('message stats count completed answers instead of failed attempts', () => {
  const failedRuntime = createRuntime();
  prompt(failedRuntime, 'This will fail');
  const failedRequest = modelRequests(failedRuntime)[0];
  failedRequest.status = 500;
  failedRequest.responseText = 'failed';
  failedRequest.onload();
  assert.equal(failedRuntime.context.getMonthlyStats().messages, 0);

  const successfulRuntime = createRuntime();
  prompt(successfulRuntime, 'This will work');
  streamTextResponse(modelRequests(successfulRuntime)[0], 'Done.');
  assert.equal(JSON.parse(successfulRuntime.storage.get('MonthlyStats')).messages, 1);
});

test('a completed multi-round turn refreshes credits once', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Calculate two plus two');
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'calculator', arguments: { expression: '2+2' } }],
    reply: ''
  });
  streamTextResponse(modelRequests(runtime)[1], 'Four.');

  assert.equal(runtime.requests.filter(request => request.url === runtime.context.OPENROUTER_CREDITS_URL).length, 1);
});

test('search stats count successful results instead of failed attempts', () => {
  const failedRuntime = createRuntime({ EnableSearch: '1', BraveSearchApiKey: 'brave-key' });
  failedRuntime.context.braveSearch('failure', failedRuntime.context.requestGeneration, () => {});
  const failedRequest = failedRuntime.requests.at(-1);
  failedRequest.status = 500;
  failedRequest.responseText = 'failed';
  failedRequest.onload();
  assert.equal(failedRuntime.context.getMonthlyStats().searches, 0);

  const successfulRuntime = createRuntime({ EnableSearch: '1', BraveSearchApiKey: 'brave-key' });
  successfulRuntime.context.braveSearch('success', successfulRuntime.context.requestGeneration, () => {});
  const successfulRequest = successfulRuntime.requests.at(-1);
  successfulRequest.status = 200;
  successfulRequest.responseText = JSON.stringify({ web: { results: [] } });
  successfulRequest.onload();
  assert.equal(successfulRuntime.context.getMonthlyStats().searches, 1);
});

test('the system prompt advertises the Markdown supported by the watch', () => {
  const runtime = createRuntime();
  const promptText = runtime.context.buildSystemPrompt();
  assert.match(promptText, /renders light Markdown/);
  assert.match(promptText, /\*\*bold\*\*/);
  assert.match(promptText, /bullet or numbered lists/);
  assert.match(promptText, /`inline code`/);
  assert.match(promptText, /Avoid tables/);
});

test('the system prompt guides proactive memory and avoids unnecessary choice prompts', () => {
  const runtime = createRuntime({ EnableMemory: '1', EnableChoice: '1' });
  const promptText = runtime.context.buildSystemPrompt();

  assert.match(promptText, /save stable preferences and personal facts/i);
  assert.match(promptText, /Do not save temporary or sensitive information/i);
  assert.match(promptText, /Do not use Choice for ordinary factual questions/i);
  assert.match(promptText, /Do not include "Say your own"/i);
});

test('configured reasoning effort is sent but excluded from output', () => {
  const runtime = createRuntime({ ReasoningEffort: 'low' });
  prompt(runtime, 'Think briefly');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
});

test('model default omits the reasoning request parameter', () => {
  const runtime = createRuntime({ ReasoningEffort: 'default' });
  prompt(runtime, 'Use defaults');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  assert.equal(body.reasoning, undefined);
});

test('free model capability lookup prefers the exact model id', () => {
  const runtime = createRuntime();
  let capability;
  runtime.context.fetchReasoningCapability('vendor/model:free', result => { capability = result; });
  const request = runtime.requests.at(-1);
  request.status = 200;
  request.responseText = JSON.stringify({ data: [
    { id: 'vendor/model', reasoning: { supported_efforts: ['high'] } },
    { id: 'vendor/model:free', reasoning: { supported_efforts: ['low'] } }
  ] });
  request.onload();

  assert.equal(capability.id, 'vendor/model:free');
  assert.ok(runtime.storage.has('ModelCapability:v2:vendor/model:free'));
});

test('configured provider restricts OpenRouter routing', () => {
  const runtime = createRuntime({ OpenRouterProvider: 'deepinfra/turbo' });
  prompt(runtime, 'Use DeepInfra');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  assert.deepEqual(body.provider, { only: ['deepinfra/turbo'] });
});

test('automatic provider leaves OpenRouter routing unchanged', () => {
  const runtime = createRuntime({ OpenRouterProvider: 'auto' });
  prompt(runtime, 'Choose automatically');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  assert.equal(body.provider, undefined);
});

test('routing priority sorts OpenRouter providers by throughput', () => {
  const runtime = createRuntime({ OpenRouterSort: 'throughput' });
  prompt(runtime, 'Choose the fastest provider');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  assert.deepEqual(body.provider, { sort: 'throughput' });
});

test('routing priority works with a selected provider endpoint', () => {
  const runtime = createRuntime({
    OpenRouterProvider: 'deepinfra/turbo',
    OpenRouterSort: 'price'
  });
  prompt(runtime, 'Use the cheapest DeepInfra endpoint');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  assert.deepEqual(body.provider, {
    only: ['deepinfra/turbo'],
    sort: 'price'
  });
});

test('unknown routing priority leaves OpenRouter sorting unchanged', () => {
  const runtime = createRuntime({ OpenRouterSort: 'unexpected' });
  prompt(runtime, 'Use safe defaults');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  assert.equal(body.provider, undefined);
});

test('phone settings save the OpenRouter routing priority', () => {
  const runtime = createRuntime();
  runtime.setClaySettings({
    converted: {},
    raw: { OpenRouterSort: { value: 'latency' } }
  });

  runtime.listeners.webviewclosed({ response: 'saved' });

  assert.equal(runtime.storage.get('OpenRouterSort'), 'latency');
});

test('phone settings save OpenStreetMap independently from Location', () => {
  const runtime = createRuntime({ EnableLocation: '0', EnableOpenStreetMap: '0' });
  runtime.setClaySettings({
    converted: {},
    raw: { EnableOpenStreetMap: { value: true } }
  });
  runtime.listeners.webviewclosed({ response: 'saved' });
  assert.equal(runtime.storage.get('EnableOpenStreetMap'), '1');
  assert.equal(runtime.storage.get('EnableLocation'), '0');
});

test('watch toggles OpenStreetMap independently from Location', () => {
  const runtime = createRuntime({ EnableLocation: '0', EnableOpenStreetMap: '0' });
  runtime.listeners.appmessage({ payload: { ToggleOpenStreetMap: 1 } });
  assert.equal(runtime.storage.get('EnableOpenStreetMap'), '1');
  assert.equal(runtime.storage.get('EnableLocation'), '0');
  assert.ok(runtime.sentMessages.some(message => message.Status === 'OpenStreetMap on'));
  assert.ok(runtime.sentMessages.some(message => /openstreetmap=1/.test(message.ToolStates || '')));
});

test('provider options use exact endpoint tags and disambiguate variants', () => {
  const runtime = createRuntime();
  const options = JSON.parse(JSON.stringify(runtime.context.providerOptionsForEndpoints([
    { provider_name: 'DeepInfra', tag: 'deepinfra/turbo' },
    { provider_name: 'OpenAI', tag: 'openai' },
    { provider_name: 'DeepInfra', tag: 'deepinfra' },
    { provider_name: 'DeepInfra', tag: 'deepinfra' }
  ])));
  assert.deepEqual(options, [
    { label: 'Automatic (OpenRouter)', value: 'auto' },
    { label: 'DeepInfra: deepinfra', value: 'deepinfra' },
    { label: 'DeepInfra: deepinfra/turbo', value: 'deepinfra/turbo' },
    { label: 'OpenAI', value: 'openai' }
  ]);
});

test('provider endpoints are loaded with the API key and cached', () => {
  const runtime = createRuntime();
  let loaded;
  runtime.context.fetchProviderEndpoints('openai/gpt-oss-20b:free', endpoints => {
    loaded = endpoints;
  });
  const request = runtime.requests.at(-1);
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://openrouter.ai/api/v1/models/openai/gpt-oss-20b%3Afree/endpoints');
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  request.status = 200;
  request.responseText = JSON.stringify({
    data: {
      endpoints: [
        { provider_name: 'Groq', tag: 'groq' },
        { provider_name: 'Ignored without tag' }
      ]
    }
  });
  request.onload();
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), [{ provider_name: 'Groq', tag: 'groq' }]);
  assert.ok(runtime.storage.has('ProviderEndpoints:openai/gpt-oss-20b:free'));
});

test('reasoning options follow OpenRouter model capabilities', () => {
  const runtime = createRuntime();
  const gemini = {
    reasoning: {
      default_effort: 'medium',
      mandatory: false,
      supported_efforts: ['high', 'medium', 'low', 'minimal']
    },
    supported_parameters: ['reasoning', 'reasoning_effort']
  };
  const options = JSON.parse(JSON.stringify(runtime.context.reasoningOptionsForModel(gemini)));
  assert.deepEqual(options.map(option => option.value), ['default', 'none', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.context.reasoningOptionsForModel({ supported_parameters: [] }))),
    [{ label: 'Model default', value: 'default' }]
  );
});

test('enabled tools are sent as OpenAI-compatible function schemas', () => {
  const runtime = createRuntime();
  prompt(runtime, 'hello');
  const body = JSON.parse(modelRequests(runtime)[0].body);
  const weather = body.tools.find(tool => tool.function.name === 'weather');
  assert.equal(weather.type, 'function');
  assert.deepEqual(weather.function.parameters.required, ['place', 'timeframe']);
  assert.equal(weather.function.parameters.additionalProperties, false);
  assert.equal(body.tools.some(tool => tool.function.name === 'location'), false);
});

test('OpenStreetMap setting exposes one tool with nearby and directions actions', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1', EnableLocation: '0' });
  const mapTool = runtime.context.buildToolDefinitions().find(tool => tool.function.name === 'openstreetmap');
  assert.deepEqual(JSON.parse(JSON.stringify(mapTool.function.parameters.required)), ['action']);
  assert.deepEqual(JSON.parse(JSON.stringify(mapTool.function.parameters.properties.action.enum)), ['nearby_places', 'directions']);
  assert.equal(mapTool.function.parameters.properties.radiusMeters.type, 'number');
  assert.equal(mapTool.function.parameters.properties.destinationLatitude.type, 'number');
  assert.equal(mapTool.function.parameters.properties.origin.type, 'string');
  assert.equal(mapTool.function.parameters.properties.originLatitude.type, 'number');
  assert.equal(runtime.context.buildToolDefinitions().some(tool => tool.function.name === 'location'), false);
  assert.match(runtime.context.buildSystemPrompt(), /Opening hours may be missing or stale/);
  assert.match(runtime.context.buildSystemPrompt(), /walking, cycling, or driving directions/);
  assert.match(runtime.context.buildSystemPrompt(), /default to walking/);
  assert.deepEqual(Array.from(mapTool.function.parameters.properties.mode.enum), ['walking', 'cycling', 'driving']);
});

test('Location does not enable the OpenStreetMap tool', () => {
  const runtime = createRuntime({ EnableLocation: '1', EnableOpenStreetMap: '0' });
  const tools = runtime.context.buildToolDefinitions();
  assert.equal(tools.some(tool => tool.function.name === 'location'), true);
  assert.equal(tools.some(tool => tool.function.name === 'openstreetmap'), false);
});

test('OpenStreetMap dispatcher runs the requested action', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1', EnableLocation: '0' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  runtime.context.executeNamedTool({
    name: 'openstreetmap',
    arguments: { action: 'nearby_places', query: 'pharmacy' }
  }, runtime.context.requestGeneration, 1, 'test', () => {});
  assert.ok(runtime.requests.some(request => request.url && /nominatim\.openstreetmap\.org\/search/.test(request.url)));
});

test('OpenStreetMap dispatcher rejects an unknown action', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  let error;
  runtime.context.executeNamedTool({
    name: 'openstreetmap',
    arguments: { action: 'unknown' }
  }, runtime.context.requestGeneration, 1, 'test', (content, problem) => { error = problem; });
  assert.match(error, /action must be nearby_places or directions/);
});

test('streamed native tool-call fragments are assembled before execution', () => {
  const runtime = createRuntime();
  prompt(runtime, 'What is two plus two?');
  const request = modelRequests(runtime)[0];
  const chunks = [
    { index: 0, id: 'call_fragmented', type: 'function', function: { name: 'calcu', arguments: '{"expression":"2' } },
    { index: 0, function: { name: 'lator', arguments: '+2"}' } }
  ];
  request.status = 200;
  request.responseText = chunks.map(toolCall =>
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\n`
  ).join('') + 'data: [DONE]\n';
  request.onprogress();
  request.onload();

  const followup = JSON.parse(modelRequests(runtime)[1].body);
  const assistantCall = followup.messages.find(message => message.tool_calls);
  const toolResult = followup.messages.find(message => message.role === 'tool');
  assert.equal(assistantCall.tool_calls[0].id, 'call_fragmented');
  assert.equal(assistantCall.tool_calls[0].function.name, 'calculator');
  assert.deepEqual(JSON.parse(assistantCall.tool_calls[0].function.arguments), { expression: '2+2' });
  assert.equal(toolResult.tool_call_id, 'call_fragmented');
  assert.match(toolResult.content, /2\+2 = 4/);
});

test('malformed native tool arguments are returned as a matching tool error', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Calculate this');
  const request = modelRequests(runtime)[0];
  request.status = 200;
  request.responseText = `data: ${JSON.stringify({ choices: [{
    delta: { tool_calls: [{ index: 0, id: 'call_bad_json', type: 'function', function: { name: 'calculator', arguments: '{"expression":' } }] },
    finish_reason: 'tool_calls'
  }] })}\n\ndata: [DONE]\n`;
  request.onprogress();
  request.onload();

  const followup = JSON.parse(modelRequests(runtime)[1].body);
  const assistantCall = followup.messages.find(message => message.tool_calls);
  const toolResult = followup.messages.find(message => message.role === 'tool');
  assert.equal(assistantCall.tool_calls[0].id, 'call_bad_json');
  assert.equal(assistantCall.tool_calls[0].function.arguments, '{"expression":');
  assert.equal(toolResult.tool_call_id, 'call_bad_json');
  assert.match(toolResult.content, /Invalid JSON arguments/);
  assert.equal(runtime.requests.some(candidate => candidate.url && candidate.url.includes('frankfurter')), false);
});

test('mixed streamed content and tool calls keeps the content and skips execution', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Say something and calculate');
  const request = modelRequests(runtime)[0];
  request.status = 200;
  request.responseText = `data: ${JSON.stringify({ choices: [{
    delta: {
      content: 'I cannot complete that calculation.',
      tool_calls: [{ index: 0, id: 'call_mixed', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }]
    },
    finish_reason: 'tool_calls'
  }] })}\n\ndata: [DONE]\n`;
  request.onprogress();
  request.onload();

  assert.equal(modelRequests(runtime).length, 1);
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'I cannot complete that calculation.'));
  assert.match(runtime.storage.get('DebugLog'), /Mixed assistant content and tool calls/);
});

test('finish reasons are recorded for streamed and non-streaming responses', () => {
  const streamingRuntime = createRuntime();
  prompt(streamingRuntime, 'hello');
  const streaming = modelRequests(streamingRuntime)[0];
  streaming.status = 200;
  streaming.responseText = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n`;
  streaming.onprogress();
  streaming.onload();
  assert.match(streamingRuntime.storage.get('DebugLog'), /stream finish_reason=length/);

  const normalRuntime = createRuntime();
  normalRuntime.context.callModel([], [], normalRuntime.context.requestGeneration, () => {});
  const normal = modelRequests(normalRuntime)[0];
  normal.status = 200;
  normal.responseText = JSON.stringify({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] });
  normal.onload();
  assert.match(normalRuntime.storage.get('DebugLog'), /callModel finish_reason=stop/);
});

test('native tool rejection produces a compatibility error', () => {
  const runtime = createRuntime();
  const recognized = runtime.context.showModelToolCompatibilityError(
    404,
    '{"error":{"message":"No endpoints found that support tool use"}}'
  );
  assert.equal(recognized, true);
  assert.ok(runtime.sentMessages.some(message => /does not support tools/.test(message.Error || '')));
});

test('current-location weather uses phone coordinates without geocoding a place name', () => {
  const runtime = createRuntime({ EnableLocation: '1' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let result;
  let error;
  runtime.context.runWeatherTool(
    { place: 'current location', timeframe: 'today' },
    runtime.context.requestGeneration,
    (content, problem) => {
      result = content;
      error = problem;
    }
  );

  assert.equal(runtime.requests.some(request => request.url && request.url.includes('/search')), false);
  const forecast = runtime.requests.find(request => request.url && request.url.includes('/forecast'));
  assert.match(forecast.url, /latitude=55\.6761/);
  assert.match(forecast.url, /longitude=12\.5683/);
  forecast.status = 200;
  forecast.responseText = JSON.stringify({
    daily: {
      time: ['2026-08-22'],
      weather_code: [2],
      temperature_2m_max: [21.4],
      temperature_2m_min: [13.2],
      precipitation_sum: [0],
      precipitation_probability_max: [10]
    },
    daily_units: {
      temperature_2m_max: '°C',
      precipitation_sum: 'mm',
      precipitation_probability_max: '%'
    }
  });
  forecast.onload();

  assert.equal(error, null);
  assert.match(result, /Weather for Current location/);
  assert.match(result, /Today: high 21°C, low 13°C/);
});

test('current-location weather respects the Location setting', () => {
  const runtime = createRuntime({ EnableLocation: '0' });
  let error;
  runtime.context.runWeatherTool(
    { place: 'current location', timeframe: 'today' },
    runtime.context.requestGeneration,
    (content, problem) => { error = problem; }
  );
  assert.match(error, /Location access is disabled/);
  assert.equal(runtime.requests.length, 0);
});

test('tool activity says when weather uses current-location GPS', () => {
  const runtime = createRuntime();
  assert.equal(
    runtime.context.toolActivityLabel({ name: 'weather', arguments: { place: 'current location' } }),
    'Weather tool: current location'
  );
  assert.equal(
    runtime.context.toolActivityLabel({ name: 'location', arguments: {} }),
    'Location tool: phone GPS'
  );
  assert.equal(
    runtime.context.toolActivityLabel({ name: 'openstreetmap', arguments: { action: 'nearby_places', query: 'supermarket' } }),
    'OpenStreetMap tool: supermarket'
  );
  assert.equal(
    runtime.context.toolActivityLabel({ name: 'openstreetmap', arguments: { action: 'directions', destination: 'Burger King' } }),
    'OpenStreetMap tool: Burger King'
  );
});

test('nearby places searches around GPS and sorts OpenStreetMap results by distance', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1', EnableLocation: '0' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let result;
  let error;
  runtime.context.runNearbyPlacesTool(
    { query: 'supermarket', radiusMeters: 2000 },
    runtime.context.requestGeneration,
    (content, problem) => { result = content; error = problem; }
  );

  const request = runtime.requests.find(candidate => candidate.url && candidate.url.includes('nominatim.openstreetmap.org/search'));
  assert.match(request.url, /q=supermarket/);
  assert.match(request.url, /bounded=1/);
  assert.match(request.url, /extratags=1/);
  request.status = 200;
  request.responseText = JSON.stringify([
    { name: 'Far Shop', lat: '55.6810', lon: '12.5683', address: { road: 'Far Road', house_number: '9' }, extratags: {} },
    { name: 'Near Shop', lat: '55.6770', lon: '12.5683', address: { road: 'Near Road', house_number: '1', postcode: '1000', city: 'Copenhagen' }, extratags: { opening_hours: 'Mo-Su 07:00-22:00', phone: '+45 12345678' } }
  ]);
  request.onload();

  assert.equal(error, null);
  assert.ok(result.indexOf('Near Shop') < result.indexOf('Far Shop'));
  assert.match(result, /listed hours: Mo-Su 07:00-22:00/);
  assert.match(result, /Near Road 1, 1000 Copenhagen/);
  assert.match(result, /latitude 55\.6770, longitude 12\.5683/);
  assert.match(result, /phone: \+45 12345678/);
});

test('nearby places requires the OpenStreetMap setting', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '0', EnableLocation: '1' });
  let error;
  runtime.context.runNearbyPlacesTool({ query: 'pharmacy' }, runtime.context.requestGeneration, (content, problem) => { error = problem; });
  assert.match(error, /OpenStreetMap access disabled/);
  assert.equal(runtime.requests.length, 0);
});

test('directions routes from GPS to coordinates supplied by a nearby result', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1', EnableLocation: '0' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let result;
  let error;
  runtime.context.runDirectionsTool({
    destination: 'Burger King',
    destinationLatitude: 55.6800,
    destinationLongitude: 12.5750
  }, runtime.context.requestGeneration, (content, problem) => { result = content; error = problem; });

  assert.equal(runtime.requests.some(request => request.url && request.url.includes('nominatim.openstreetmap.org/search')), false);
  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  assert.match(route.url, /routing\.openstreetmap\.de\/routed-foot\/route\/v1\/driving\//);
  assert.match(route.url, /12\.5683,55\.6761;12\.575,55\.68/);
  assert.match(route.url, /steps=true&overview=false/);
  route.status = 200;
  route.responseText = JSON.stringify({
    code: 'Ok',
    routes: [{
      distance: 1234,
      duration: 480,
      legs: [{ steps: [
        { distance: 400, name: 'Main Street', maneuver: { type: 'depart', modifier: 'north' } },
        { distance: 800, name: 'King Road', maneuver: { type: 'turn', modifier: 'right' } },
        { distance: 0, name: '', maneuver: { type: 'arrive' } }
      ] }]
    }]
  });
  route.onload();

  assert.equal(error, null);
  assert.match(result, /Walking directions to Burger King: 1\.2 km, about 8 min/);
  assert.match(result, /Starting point: phone GPS/);
  assert.match(result, /Head north on Main Street for 400 m/);
  assert.match(result, /Turn right onto King Road for 800 m/);
  assert.match(result, /Route source: OSRM using © OpenStreetMap contributors data/);
});

test('directions resolves a named destination near the current location before routing', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1', EnableLocation: '0' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let result;
  runtime.context.runDirectionsTool({ destination: 'Burger King' }, runtime.context.requestGeneration, content => { result = content; });

  const search = runtime.requests.find(request => request.url && request.url.includes('nominatim.openstreetmap.org/search'));
  assert.match(search.url, /q=Burger%20King/);
  assert.doesNotMatch(search.url, /bounded=1/);
  search.status = 200;
  search.responseText = JSON.stringify([
    { lat: '55.6900', lon: '12.5800', display_name: 'Burger King, Relevant Road, Copenhagen, Denmark' },
    { lat: '55.6770', lon: '12.5690', display_name: 'Burger King Bus Stop, Closer Road, Copenhagen, Denmark' }
  ]);
  search.onload();

  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  assert.match(route.url, /12\.58,55\.69/);
  route.status = 200;
  route.responseText = JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 1200, duration: 360, legs: [{ steps: [] }] }]
  });
  route.onload();

  assert.match(result, /Destination: Burger King, Relevant Road, Copenhagen, Denmark/);
});

test('directions treats empty destination coordinates as absent and geocodes the destination', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };

  runtime.context.runDirectionsTool({
    destination: 'Burger King',
    destinationLatitude: null,
    destinationLongitude: ''
  }, runtime.context.requestGeneration, () => {});

  assert.ok(runtime.requests.some(request => request.url && request.url.includes('nominatim.openstreetmap.org/search')));
  assert.equal(runtime.requests.some(request => request.url && request.url.includes(';0,0')), false);
});

test('directions rejects an incomplete destination coordinate pair', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  let error;
  runtime.context.runDirectionsTool({
    destination: 'Burger King',
    destinationLatitude: 55.68
  }, runtime.context.requestGeneration, (content, problem) => { error = problem; });

  assert.match(error, /destination coordinates require both latitude and longitude/);
  assert.equal(runtime.requests.length, 0);
});

test('directions rejects whitespace and boolean coordinates before GPS or network access', () => {
  [
    { destinationLatitude: ' ', destinationLongitude: '\t' },
    { destinationLatitude: false, destinationLongitude: false },
    { originLatitude: ' ', originLongitude: '\t' },
    { originLatitude: false, originLongitude: false }
  ].forEach(coordinates => {
    const runtime = createRuntime({ EnableOpenStreetMap: '1' });
    runtime.context.navigator.geolocation = {
      getCurrentPosition() { throw new Error('GPS should not be used'); }
    };
    let error;
    runtime.context.runDirectionsTool({
      destination: 'Burger King',
      ...coordinates
    }, runtime.context.requestGeneration, (content, problem) => { error = problem; });

    assert.match(error, /coordinates are invalid/);
    assert.equal(runtime.requests.length, 0);
  });
});

test('directions accepts zero as a real coordinate', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  runtime.context.runDirectionsTool({
    originLatitude: 0,
    originLongitude: 0,
    destination: 'Equator route',
    destinationLatitude: 0,
    destinationLongitude: 1
  }, runtime.context.requestGeneration, () => {});

  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  assert.match(route.url, /\/0,0;1,0\?/);
});

test('directions treats current-location origin aliases as phone GPS', () => {
  ['current location', 'my location', 'my current location', 'Here.', 'current position', 'where I am', 'her'].forEach(origin => {
    const runtime = createRuntime({ EnableOpenStreetMap: '1' });
    runtime.context.navigator.geolocation = {
      getCurrentPosition(success) {
        success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
      }
    };
    runtime.context.runDirectionsTool({
      origin,
      destination: 'Burger King',
      destinationLatitude: 55.68,
      destinationLongitude: 12.575
    }, runtime.context.requestGeneration, () => {});

    assert.equal(runtime.requests.some(request => request.url && request.url.includes('nominatim.openstreetmap.org/search')), false);
    const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
    assert.match(route.url, /12\.5683,55\.6761;12\.575,55\.68/);
  });
});

test('directions geocodes an explicit named origin without using phone GPS', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1', EnableLocation: '0' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition() { throw new Error('GPS should not be used'); }
  };
  let result;
  runtime.context.runDirectionsTool({
    origin: 'Copenhagen Central Station',
    destination: 'Burger King',
    destinationLatitude: 55.6750,
    destinationLongitude: 12.5700
  }, runtime.context.requestGeneration, content => { result = content; });

  const originSearch = runtime.requests.find(request => request.url && /q=Copenhagen%20Central%20Station/.test(request.url));
  assert.ok(originSearch);
  originSearch.status = 200;
  originSearch.responseText = JSON.stringify([{
    lat: '55.6727',
    lon: '12.5648',
    display_name: 'Copenhagen Central Station, Bernstorffsgade, Copenhagen, Denmark'
  }]);
  originSearch.onload();

  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  assert.match(route.url, /12\.5648,55\.6727;12\.57,55\.675/);
  route.status = 200;
  route.responseText = JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 1000, duration: 300, legs: [{ steps: [] }] }]
  });
  route.onload();
  assert.match(result, /Starting point: Copenhagen Central Station, Bernstorffsgade, Copenhagen, Denmark/);
});

test('directions rejects invalid coordinates returned for a named origin', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  let error;
  runtime.context.runDirectionsTool({
    origin: 'Broken place',
    destination: 'Burger King',
    destinationLatitude: 55.675,
    destinationLongitude: 12.57
  }, runtime.context.requestGeneration, (content, problem) => { error = problem; });

  const originSearch = runtime.requests.find(request => request.url && request.url.includes('nominatim.openstreetmap.org/search'));
  originSearch.status = 200;
  originSearch.responseText = JSON.stringify([{ lat: 'not-a-number', lon: '12.5648', display_name: 'Broken place' }]);
  originSearch.onload();

  assert.match(error, /invalid coordinates/);
  assert.equal(runtime.requests.some(request => request.url && request.url.includes('routing.openstreetmap.de')), false);
});

test('directions rejects invalid coordinates returned for a named destination', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let error;
  runtime.context.runDirectionsTool({ destination: 'Broken place' }, runtime.context.requestGeneration,
    (content, problem) => { error = problem; });

  const search = runtime.requests.find(request => request.url && request.url.includes('nominatim.openstreetmap.org/search'));
  search.status = 200;
  search.responseText = JSON.stringify([{ lat: '95', lon: '12.57', display_name: 'Broken place' }]);
  search.onload();

  assert.match(error, /invalid coordinates for the destination/);
  assert.equal(runtime.requests.some(request => request.url && request.url.includes('routing.openstreetmap.de')), false);
});

test('directions reports OSRM no-route responses clearly even with HTTP 400', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let error;
  runtime.context.runDirectionsTool({
    destination: 'Unreachable place',
    mode: 'driving',
    destinationLatitude: 55.68,
    destinationLongitude: 12.575
  }, runtime.context.requestGeneration, (content, problem) => { error = problem; });

  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  route.status = 400;
  route.responseText = JSON.stringify({ code: 'NoRoute', message: 'Impossible route' });
  route.onload();

  assert.equal(error, 'No driving route found to Unreachable place.');
});

test('directions distinguishes an OSRM endpoint that is not near a road', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let error;
  runtime.context.runDirectionsTool({
    destination: 'Off-road place',
    destinationLatitude: 55.68,
    destinationLongitude: 12.575
  }, runtime.context.requestGeneration, (content, problem) => { error = problem; });

  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  route.status = 400;
  route.responseText = JSON.stringify({ code: 'NoSegment' });
  route.onload();

  assert.match(error, /near a walkable path or road/);
});

test('directions rejects incomplete successful OSRM responses', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: 55.6761, longitude: 12.5683 } });
    }
  };
  let error;
  runtime.context.runDirectionsTool({
    destination: 'Broken route',
    destinationLatitude: 55.68,
    destinationLongitude: 12.575
  }, runtime.context.requestGeneration, (content, problem) => { error = problem; });

  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  route.status = 200;
  route.responseText = JSON.stringify({ code: 'Ok', routes: [{ legs: [{ steps: [] }] }] });
  route.onload();

  assert.match(error, /incomplete response/);
});

test('directions accepts explicit origin coordinates without GPS or origin geocoding', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1', EnableLocation: '0' });
  runtime.context.navigator.geolocation = {
    getCurrentPosition() { throw new Error('GPS should not be used'); }
  };
  let result;
  runtime.context.runDirectionsTool({
    origin: 'Central Station',
    originLatitude: 55.6727,
    originLongitude: 12.5648,
    destination: 'Burger King',
    destinationLatitude: 55.6750,
    destinationLongitude: 12.5700
  }, runtime.context.requestGeneration, content => { result = content; });

  assert.equal(runtime.requests.some(request => request.url && request.url.includes('nominatim.openstreetmap.org/search')), false);
  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  assert.match(route.url, /12\.5648,55\.6727;12\.57,55\.675/);
  route.status = 200;
  route.responseText = JSON.stringify({
    code: 'Ok',
    routes: [{ distance: 500, duration: 120, legs: [{ steps: [] }] }]
  });
  route.onload();
  assert.match(result, /Starting point: specified coordinates \(55\.6727, 12\.5648\)/);
  assert.doesNotMatch(result, /Starting point: Central Station/);
});

test('directions rejects an incomplete explicit origin coordinate pair', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  let error;
  runtime.context.runDirectionsTool({
    destination: 'Burger King',
    originLatitude: 55.6727
  }, runtime.context.requestGeneration, (content, problem) => { error = problem; });
  assert.match(error, /require both latitude and longitude/);
  assert.equal(runtime.requests.length, 0);
});

test('directions requires the OpenStreetMap setting', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '0', EnableLocation: '1' });
  let error;
  runtime.context.runDirectionsTool({ destination: 'Burger King' }, runtime.context.requestGeneration, (content, problem) => { error = problem; });
  assert.match(error, /OpenStreetMap access disabled/);
  assert.equal(runtime.requests.length, 0);
});

test('calculator fetches and caches current currency rates', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Convert ten euro to kroner');
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'calculator', arguments: { value: 10, from: 'EUR', to: 'DKK' } }],
    reply: ''
  });

  const currencyRequest = runtime.requests.find(request => request.url && request.url.includes('frankfurter'));
  assert.equal(currencyRequest.url, 'https://api.frankfurter.dev/v2/rate/EUR/DKK');
  currencyRequest.status = 200;
  currencyRequest.responseText = JSON.stringify({ date: '2026-07-19', base: 'EUR', quote: 'DKK', rate: 7.4834 });
  currencyRequest.onload();

  const followup = JSON.parse(modelRequests(runtime)[1].body);
  const assistantCall = followup.messages.at(-2);
  const toolResult = followup.messages.at(-1);
  assert.equal(assistantCall.role, 'assistant');
  assert.equal(assistantCall.content, null);
  assert.equal(assistantCall.tool_calls[0].function.name, 'calculator');
  assert.equal(toolResult.role, 'tool');
  assert.equal(toolResult.tool_call_id, assistantCall.tool_calls[0].id);
  assert.match(toolResult.content, /74\.834 DKK/);
  assert.ok(runtime.storage.has('CurrencyRate:EUR:DKK'));

  let cachedResult = '';
  runtime.context.runCalculatorToolAsync({ value: 2, from: 'EUR', to: 'DKK' }, runtime.context.requestGeneration, result => {
    cachedResult = result;
  });
  assert.match(cachedResult, /14\.9668 DKK/);
  assert.equal(runtime.requests.filter(request => request.url && request.url.includes('frankfurter')).length, 1);
});

test('Health tool requests watch data and resumes the model round', () => {
  const runtime = createRuntime({ EnableHealth: '1' });
  prompt(runtime, 'How many steps did I take?', 12);
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'health', arguments: { from: '2026-07-19', to: '2026-07-19' } }],
    reply: ''
  });

  assert.ok(runtime.sentMessages.some(message => message.HealthRequest === '2026-07-19|2026-07-19' && message.RequestId === 12));
  runtime.listeners.appmessage({
    payload: { HealthData: 'Watch Health data for today: steps=4321;', RequestId: 12 }
  });
  const followup = JSON.parse(modelRequests(runtime)[1].body);
  assert.equal(followup.messages.at(-1).role, 'tool');
  assert.ok(followup.messages.at(-1).tool_call_id);
  assert.match(followup.messages.at(-1).content, /steps=4321/);
  streamResponse(modelRequests(runtime)[1], { toolCalls: [], reply: 'You took 4,321 steps today.' });
  const historyChunk = runtime.sentMessages.find(message => message.AssistantResponse === '[tool] Health tool\n');
  const answerChunk = runtime.sentMessages.find(message => message.AssistantResponse === 'You took 4,321 steps today.');
  assert.equal(historyChunk.ResponseChunkIndex, 0);
  assert.equal(answerChunk.ResponseChunkIndex, 1);
});

test('Health instructions are included only when enabled', () => {
  assert.equal(createRuntime().context.buildToolDefinitions().some(tool => tool.function.name === 'health'), false);
  const promptText = createRuntime({ EnableHealth: '1' }).context.buildSystemPrompt();
  assert.match(promptText, /Use Health/);
  assert.match(promptText, /average\/minimum\/maximum heart rate/);
  assert.equal(createRuntime({ EnableHealth: '1' }).context.buildToolDefinitions().some(tool => tool.function.name === 'health'), true);
});

test('stream fallback can continue into a tool round', () => {
  const runtime = createRuntime();
  prompt(runtime);
  const streaming = modelRequests(runtime)[0];

  runtime.timers[0]();
  assert.equal(streaming.aborted, true);
  const fallback = modelRequests(runtime)[1];
  normalResponse(fallback, {
    toolCalls: [{ name: 'calculator', arguments: { expression: '2+2' } }],
    reply: ''
  });

  assert.equal(modelRequests(runtime).length, 3);
  streamResponse(modelRequests(runtime)[2], { toolCalls: [], reply: 'Four.' });
  assert.ok(runtime.sentMessages.some(message =>
    message.AssistantResponse === '[tool] Calculator tool: 2+2\n' && message.RequestId === 1));
  assert.ok(runtime.sentMessages.some(message =>
    message.AssistantResponse === 'Four.' && message.RequestId === 1));
});

test('choice answer resumes the turn with its original prompt', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Help me choose', 7);
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'choice', arguments: { question: 'Pick one', options: ['A', 'B'] } }],
    reply: ''
  });
  assert.ok(runtime.sentMessages.some(message => message.ChoiceQuestion === 'Pick one' && message.RequestId === 7));

  runtime.listeners.appmessage({ payload: { ChoiceAnswer: 'B', RequestId: 7 } });
  streamResponse(modelRequests(runtime)[1], { toolCalls: [], reply: 'You picked B.' });

  const sessions = JSON.parse(runtime.storage.get('SavedSessions'));
  assert.match(sessions[0].summary, /Help me choose/);
  assert.match(sessions[0].summary, /You picked B/);
});

test('cancelled choices cannot be resumed by delayed answers', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Choose', 4);
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'choice', arguments: { question: 'Pick', options: ['A', 'B'] } }],
    reply: ''
  });

  runtime.listeners.appmessage({ payload: { CancelRequest: 1, RequestId: 4 } });
  runtime.listeners.appmessage({ payload: { ChoiceAnswer: 'A', RequestId: 4 } });
  assert.equal(modelRequests(runtime).length, 1);
});

test('an unanswered choice times out and resumes the model round', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Choose for me', 14);
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'choice', arguments: { question: 'Pick', options: ['A', 'B'] } }],
    reply: ''
  });

  runtime.timers.at(-1)();

  const followup = JSON.parse(modelRequests(runtime)[1].body);
  assert.match(followup.messages.at(-1).content, /Choice prompt timed out/);
});

test('the same choice can be requested again in a later round', () => {
  const runtime = createRuntime();
  const choice = { name: 'choice', arguments: { question: 'Pick', options: ['A', 'B'] } };
  prompt(runtime, 'Choose twice', 5);
  streamResponse(modelRequests(runtime)[0], { toolCalls: [choice], reply: '' });
  runtime.listeners.appmessage({ payload: { ChoiceAnswer: 'A', RequestId: 5 } });
  streamResponse(modelRequests(runtime)[1], { toolCalls: [choice], reply: '' });

  assert.equal(runtime.sentMessages.filter(message => message.ChoiceQuestion === 'Pick').length, 2);
  runtime.listeners.appmessage({ payload: { ChoiceAnswer: 'B', RequestId: 5 } });
  streamResponse(modelRequests(runtime)[2], { toolCalls: [], reply: 'A then B.' });
  assert.ok(runtime.sentMessages.some(message =>
    message.AssistantResponse === '[tool] Choice tool\n[tool] Choice tool\n'));
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'A then B.'));
});

test('saved sessions round-trip Markdown dividers and session-like summary text', () => {
  const sessions = [
    {
      createdAt: '2026-08-29T08:00:00.000Z',
      summary: 'First summary\n---\nSession 99\n2026-01-01T00:00:00.000Z\nstill the first summary'
    },
    {
      createdAt: '2026-08-29T09:00:00.000Z',
      summary: 'Second summary'
    }
  ];
  const runtime = createRuntime({ SavedSessions: JSON.stringify(sessions) });

  const editableText = runtime.context.sessionsToText();
  runtime.context.saveSessionsFromText(editableText);

  assert.deepEqual(JSON.parse(runtime.storage.get('SavedSessions')), sessions);
});

test('parallel scrape results retain requested order', () => {
  const runtime = createRuntime({ EnableScrape: '1', FirecrawlApiKey: 'fc-test' });
  prompt(runtime, 'Compare two pages');
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [
      { name: 'scrape', arguments: { url: 'https://first.example' } },
      { name: 'scrape', arguments: { url: 'https://second.example' } }
    ],
    reply: ''
  });

  assert.deepEqual(
    runtime.sentMessages.filter(message => message.ToolActivity).map(message => message.ToolActivity),
    ['Firecrawl Scrape tool: https://first.example', 'Firecrawl Scrape tool: https://second.example']
  );
  const activityMessages = runtime.sentMessages.filter(message => message.ToolActivity);
  assert.equal(activityMessages[0].Status, undefined);
  assert.equal(activityMessages[1].Status, undefined);
  assert.equal(runtime.sentMessages.filter(message =>
    /^(Starting tool|Using |Searching|Scraping|Getting )/.test(message.Status || '')).length, 0);

  const scrapes = runtime.requests.filter(request => request.url && request.url.includes('firecrawl'));
  assert.equal(scrapes.length, 2);
  scrapes[1].status = 200;
  scrapes[1].responseText = JSON.stringify({ success: true, data: { markdown: 'SECOND' } });
  scrapes[1].onload();
  assert.equal(modelRequests(runtime).length, 1);
  scrapes[0].status = 200;
  scrapes[0].responseText = JSON.stringify({ success: true, data: { markdown: 'FIRST' } });
  scrapes[0].onload();

  const followupBody = JSON.parse(modelRequests(runtime)[1].body);
  const toolMessages = followupBody.messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[0].content, /FIRST/);
  assert.match(toolMessages[1].content, /SECOND/);

  streamTextResponse(modelRequests(runtime)[1], 'Comparison complete.');
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse ===
    '[tool] Firecrawl Scrape tool: https://first.example\n' +
    '[tool] Firecrawl Scrape tool: https://second.example\n'));
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'Comparison complete.'));
});

test('the same tool can run in consecutive rounds', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Calculate twice');
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'calculator', arguments: { expression: '2+2' } }], reply: ''
  });
  streamResponse(modelRequests(runtime)[1], {
    toolCalls: [{ name: 'calculator', arguments: { expression: '3+3' } }], reply: ''
  });
  streamResponse(modelRequests(runtime)[2], { toolCalls: [], reply: 'Four and six.' });
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse ===
    '[tool] Calculator tool: 2+2\n[tool] Calculator tool: 3+3\n'));
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'Four and six.'));
});

test('completed native tool calls and results are retained in the next turn', () => {
  const runtime = createRuntime();
  prompt(runtime, 'What is two plus two?', 1);
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'calculator', arguments: { expression: '2+2' } }], reply: ''
  });
  streamTextResponse(modelRequests(runtime)[1], 'It is four.');

  prompt(runtime, 'What did you calculate?', 2);
  const nextTurn = JSON.parse(modelRequests(runtime)[2].body);
  const assistantToolCall = nextTurn.messages.find(message => message.role === 'assistant' && message.tool_calls);
  const toolResult = nextTurn.messages.find(message => message.role === 'tool');

  assert.equal(assistantToolCall.tool_calls[0].function.name, 'calculator');
  assert.equal(toolResult.tool_call_id, assistantToolCall.tool_calls[0].id);
  assert.match(toolResult.content, /2\+2 = 4/);
  assert.ok(nextTurn.messages.some(message => message.role === 'assistant' && message.content === 'It is four.'));
});

test('identical calls in one batch share one tool execution', () => {
  const runtime = createRuntime({ EnableScrape: '1', FirecrawlApiKey: 'fc-test' });
  prompt(runtime, 'Read it twice');
  const call = { name: 'scrape', arguments: { url: 'https://same.example' } };
  streamResponse(modelRequests(runtime)[0], { toolCalls: [call, call], reply: '' });

  const scrapes = runtime.requests.filter(request => request.url && request.url.includes('firecrawl'));
  assert.equal(scrapes.length, 1);
  scrapes[0].status = 200;
  scrapes[0].responseText = JSON.stringify({ success: true, data: { markdown: 'SHARED' } });
  scrapes[0].onload();
  const followupBody = JSON.parse(modelRequests(runtime)[1].body);
  const toolMessages = followupBody.messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.ok(toolMessages.every(message => /SHARED/.test(message.content)));
  assert.notEqual(toolMessages[0].tool_call_id, toolMessages[1].tool_call_id);
});

test('tool execution stops after five rounds', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Keep calculating');
  for (let i = 0; i < 5; i++) {
    streamResponse(modelRequests(runtime)[i], {
      toolCalls: [{ name: 'calculator', arguments: { expression: `${i}+1` } }], reply: ''
    });
  }
  assert.equal(modelRequests(runtime).length, 6);
  streamResponse(modelRequests(runtime)[5], {
    toolCalls: [{ name: 'calculator', arguments: { expression: '99+1' } }], reply: ''
  });
  assert.equal(modelRequests(runtime).length, 6);
  assert.ok(runtime.sentMessages.some(message => /tool-call limit/.test(message.AssistantResponse || '')));
});

test('completed turns update one saved session record', () => {
  const runtime = createRuntime();
  prompt(runtime, 'First question', 1);
  streamResponse(modelRequests(runtime)[0], { toolCalls: [], reply: 'First answer.' });
  prompt(runtime, 'Second question', 2);
  streamResponse(modelRequests(runtime)[1], { toolCalls: [], reply: 'Second answer.' });

  const sessions = JSON.parse(runtime.storage.get('SavedSessions'));
  assert.equal(sessions.length, 1);
  assert.match(sessions[0].summary, /First question/);
  assert.match(sessions[0].summary, /Second question/);
});

test('a failed model request keeps the user message as context for the next turn', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Keep this question', 1);
  const failed = modelRequests(runtime)[0];
  failed.status = 429;
  failed.responseText = '{"error":{"message":"Rate limited"}}';
  failed.onload();

  prompt(runtime, 'Continue', 2);
  const nextMessages = JSON.parse(modelRequests(runtime)[1].body).messages;
  assert.ok(nextMessages.some(message =>
    message.role === 'user' && message.content === 'Keep this question'));
  assert.ok(nextMessages.some(message =>
    message.role === 'assistant' &&
    message.content === '[You did not respond because of an error: OpenRouter failed (429).]'));
  assert.equal(
    nextMessages.filter(message => message.role === 'user').at(-1).content,
    'Continue'
  );

  const sessions = JSON.parse(runtime.storage.get('SavedSessions'));
  assert.match(sessions[0].summary, /Keep this question/);
  assert.match(sessions[0].summary, /You did not respond because of an error/);
});

test('a failed follow-up keeps completed tool context for the next turn', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Calculate two plus two', 1);
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'calculator', arguments: { expression: '2+2' } }],
    reply: ''
  });
  const failed = modelRequests(runtime)[1];
  failed.status = 429;
  failed.responseText = '{"error":{"message":"Rate limited"}}';
  failed.onload();

  prompt(runtime, 'Continue', 2);
  const nextMessages = JSON.parse(modelRequests(runtime)[2].body).messages;
  assert.ok(nextMessages.some(message => message.role === 'assistant' && message.tool_calls));
  assert.ok(nextMessages.some(message => message.role === 'tool' && /result.*4/.test(message.content)));
  assert.ok(nextMessages.some(message =>
    message.role === 'assistant' &&
    message.content === '[You did not respond because of an error: OpenRouter failed (429).]'));
});

test('cancelling a request does not let an in-flight send drop the cancellation message', () => {
  const runtime = createRuntime();
  const sends = [];
  runtime.context.currentRequestId = 9;
  runtime.setSendHandler((dict, success, failure) => sends.push({ dict, success, failure }));

  runtime.context.sendToWatch({ Status: 'Old' }, 9);
  runtime.context.sendToWatch({ Status: 'Queued old' }, 9);
  runtime.context.cancelActiveRequests(true, 9);
  assert.equal(sends.length, 1);

  sends[0].success();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].dict.Status, 'Cancelled');
});

test('successful render AppMessages leave time for the watch before the queue advances', () => {
  const runtime = createRuntime();
  const sends = [];
  runtime.context.WATCH_RENDER_GAP_MS = 150;
  runtime.setSendHandler((dict, success, failure) => sends.push({ dict, success, failure }));

  runtime.context.sendToWatch({ AssistantResponse: 'First' });
  runtime.context.sendToWatch({ Status: 'Second' });
  sends[0].success();

  assert.equal(sends.length, 1);
  assert.equal(runtime.timers.length, 1);
  runtime.timers.shift()();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].dict.Status, 'Second');
});

test('successful non-render AppMessages advance the queue immediately', () => {
  const runtime = createRuntime();
  const sends = [];
  runtime.context.WATCH_RENDER_GAP_MS = 150;
  runtime.setSendHandler((dict, success, failure) => sends.push({ dict, success, failure }));

  runtime.context.sendToWatch({ StatsText: 'First' });
  runtime.context.sendToWatch({ Status: 'Second' });
  sends[0].success();

  assert.equal(runtime.timers.length, 0);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].dict.Status, 'Second');
});

test('tool history and reply text use separate response chunks', () => {
  const runtime = createRuntime();

  runtime.context.sendAssistantReply('Answer', 7, 'Calculator tool: 2+2');

  assert.deepEqual(runtime.sentMessages.map(message => ({
    text: message.AssistantResponse,
    index: message.ResponseChunkIndex,
    done: message.ResponseChunkDone
  })), [
    { text: '[tool] Calculator tool: 2+2\n', index: 0, done: 0 },
    { text: 'Answer', index: 1, done: 1 }
  ]);
});

test('watch text replaces common missing font glyphs without stripping supported text', () => {
  const runtime = createRuntime();

  assert.equal(
    runtime.context.watchSafeText('Danish: æøå • 2× H100 “fast” €10–20 ≤ 5…'),
    'Danish: æøå • 2x H100 "fast" €10-20 <= 5...'
  );
});

test('watch text preserves emoji status symbols and newly supported emoji', () => {
  const runtime = createRuntime();

  assert.equal(
    runtime.context.watchSafeText('✅ Ready ⚠\ufe0f Careful ❌ Failed 🚀🔥'),
    '✅ Ready ⚠\ufe0f Careful ❌ Failed 🚀🔥'
  );
});

test('watch text preserves old and new emoji without a fixed whitelist', () => {
  const runtime = createRuntime();

  assert.equal(
    runtime.context.watchSafeText('😃 👍 🎉 💩 👋'),
    '😃 👍 🎉 💩 👋'
  );
});

test('watch text preserves emoji selectors, joiners, modifiers, flags and keycaps', () => {
  const runtime = createRuntime();
  const text = '❤️ 👩🏽‍💻 🏳️‍🌈 🇩🇰 1️⃣ 🫠 ☑️ ✔️ ❎';

  assert.equal(runtime.context.watchSafeText(text), text);
});

test('complete replies keep emoji pairs intact at AppMessage chunk boundaries', () => {
  const runtime = createRuntime();
  runtime.context.RESPONSE_CHUNK_CHARS = 8;
  const reply = '1234567🚀🔥 next 🫠';

  runtime.context.sendAssistantReply(reply, 7);

  const chunks = runtime.sentMessages.map(message => message.AssistantResponse);
  assert.equal(chunks.join(''), reply);
  assert.ok(chunks.every(chunk => chunk.length <= 8));
  for (const chunk of chunks) {
    assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk);
  }
});

test('older and unknown firmware keep readable emoji fallbacks', () => {
  const runtime = createRuntime();
  for (const firmware of [undefined, { major: 3, minor: 99 },
    { major: 4, minor: 9, patch: 184 }, { major: 4, minor: 29 }]) {
    runtime.context.Pebble.getActiveWatchInfo = () => ({ firmware });
    assert.equal(runtime.context.watchSafeText('✅ Pass ❌ Fail ⚠️ Careful 🚀🔥 😃'),
      '[ok] Pass [x] Fail [!] Careful [emoji] 😃');
  }
  delete runtime.context.Pebble.getActiveWatchInfo;
  assert.equal(runtime.context.watchSafeText('🚀'), '[emoji]');
  runtime.context.Pebble.getActiveWatchInfo = () => { throw new Error('No watch'); };
  assert.equal(runtime.context.watchSafeText('🚀'), '[emoji]');
});

test('expanded emoji start at firmware 4.30 and remain enabled in future versions', () => {
  const runtime = createRuntime();
  for (const firmware of [{ major: 4, minor: 30 }, { major: 4, minor: 41 },
    { major: 5, minor: 0 }]) {
    runtime.context.Pebble.getActiveWatchInfo = () => ({ firmware });
    assert.equal(runtime.context.watchSafeText('✅❌🚀🔥🫠'), '✅❌🚀🔥🫠');
  }
});

test('clip never leaves half an emoji in a summary, option or tool label', () => {
  const runtime = createRuntime();
  assert.equal(runtime.context.clip('abc🚀def', 4), 'abc');
  assert.equal(runtime.context.clip('abc🚀def', 5), 'abc🚀');
  assert.equal(runtime.context.clip('🚀', 0), '');
  assert.equal(runtime.context.clip('🚀', 1), '');
});

test('a one-unit chunk setting still makes progress without splitting emoji', () => {
  const runtime = createRuntime();
  runtime.context.RESPONSE_CHUNK_CHARS = 1;
  runtime.context.sendAssistantReply('🚀🔥', 7);
  assert.deepEqual(runtime.sentMessages.map(message => message.AssistantResponse), ['🚀', '🔥']);
});

test('complete replies are normalized before response chunking', () => {
  const runtime = createRuntime();
  runtime.context.RESPONSE_CHUNK_CHARS = 8;

  runtime.context.sendAssistantReply('A… 8× H100', 7, 'Math ≥ 1');

  assert.equal(
    runtime.sentMessages.map(message => message.AssistantResponse).join(''),
    '[tool] Math >= 1\nA... 8x H100'
  );
  assert.ok(runtime.sentMessages.slice(1).every(message => message.AssistantResponse.length <= 8));
});

test('streamed reply chunks are normalized at the watch boundary', () => {
  const runtime = createRuntime();
  runtime.context.currentRequestId = 7;
  runtime.context.requestGeneration = 3;

  runtime.context.sendAssistantDelta('1× B200 ± ≠', 0, false, 3);

  assert.equal(runtime.sentMessages[0].AssistantResponse, '1x B200 +/- !=');
});

test('streaming waits for a low surrogate before sending a new emoji', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Use an emoji');
  const request = modelRequests(runtime)[0];
  request.status = 200;
  request.responseText = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Ready \ud83d' } }] })}\n\n`;
  request.onprogress();

  assert.deepEqual(
    runtime.sentMessages.filter(message => message.AssistantResponse).map(message => message.AssistantResponse),
    ['Ready ']
  );

  request.responseText += `data: ${JSON.stringify({ choices: [{ delta: { content: '\ude80 now' } }] })}\n\ndata: [DONE]\n`;
  request.onprogress();
  request.onload();

  assert.equal(
    runtime.sentMessages.filter(message => message.AssistantResponse).map(message => message.AssistantResponse).join(''),
    'Ready 🚀 now'
  );
});

test('an in-flight message from a cancelled request is not retried', () => {
  const runtime = createRuntime();
  const sends = [];
  runtime.context.currentRequestId = 9;
  runtime.setSendHandler((dict, success, failure) => sends.push({ dict, success, failure }));
  runtime.context.sendToWatch({ Status: 'Old' }, 9);
  runtime.context.cancelActiveRequests(false, 9);

  sends[0].failure({});
  assert.equal(runtime.timers.length, 0);
  assert.equal(sends.length, 1);
});

test('AppMessage retries stop after three failures and unblock the queue', () => {
  const runtime = createRuntime();
  const sends = [];
  runtime.setSendHandler((dict, success, failure) => sends.push({ dict, success, failure }));
  runtime.context.sendToWatch({ Status: 'First' });
  runtime.context.sendToWatch({ Status: 'Second' });

  sends[0].failure({});
  runtime.timers.shift()();
  sends[1].failure({});
  runtime.timers.shift()();
  sends[2].failure({});

  assert.equal(sends.length, 4);
  assert.equal(sends[3].dict.Status, 'Second');
});

test('changing the clock does not regenerate timestamps in existing history', () => {
  const runtime = createRuntime({ ExtraSystemPrompt: 'Answer in Danish.' });
  const history = [
    { role: 'user', content: 'What is 6 times 7?', localTime: 'Current local time is the original turn time.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'calc', type: 'function', function: { name: 'calculator', arguments: '{"expression":"6*7"}' } }] },
    { role: 'tool', tool_call_id: 'calc', content: '42' },
    { role: 'assistant', content: '42' }
  ];
  runtime.context.conversationHistory = history;
  const NativeDate = Date;
  runtime.context.Date = class extends NativeDate {
    constructor() { super('2026-10-17T08:00:00Z'); }
  };
  const first = JSON.parse(JSON.stringify(runtime.context.buildMessages()));
  runtime.context.Date = class extends NativeDate {
    constructor() { super('2026-10-17T08:01:00Z'); }
  };
  const second = JSON.parse(JSON.stringify(runtime.context.buildMessages()));
  assert.deepEqual(first, second);
  assert.equal(second.at(-5).content, history[0].localTime);
  assert.deepEqual(second.slice(-4), history.map(({ localTime, ...message }) => message));
  assert.ok(second.every(message => !('localTime' in message)));
  assert.ok(second.some(message => message.content === 'Answer in Danish.'));
});

test('outgoing requests keep time directly before the new question and omit availability chatter', () => {
  const runtime = createRuntime({ EnableSearch: '1', BraveSearchApiKey: 'test-key', EnableScrape: '1', FirecrawlApiKey: 'test-key' });
  prompt(runtime, 'What is the latest news?');
  const payload = JSON.parse(modelRequests(runtime)[0].body);
  assert.match(payload.messages.at(-2).content, /^Current local time is /);
  assert.deepEqual(payload.messages.at(-1), { role: 'user', content: 'What is the latest news?' });
  assert.equal(payload.messages.filter(message => message.role === 'user').length, 1);
  assert.doesNotMatch(JSON.stringify(payload.messages), /Search available:|Scrape available:|Weather available:|Choice available:|Use Brave Search|Use Firecrawl scrape|through Frankfurter/);
  assert.ok(payload.tools.some(tool => tool.function.name === 'search'));
  assert.ok(payload.tools.some(tool => tool.function.name === 'scrape'));
  assert.match(payload.tools.find(tool => tool.function.name === 'calculator').function.description, /exact arithmetic.*current currency/);
  assert.match(payload.messages[0].content, /do not call the Location tool first/);
  assert.match(payload.messages[0].content, /untrusted data/);
});

test('consecutive turns retain the complete previous request and response prefix', () => {
  const runtime = createRuntime();
  prompt(runtime, 'First question', 1);
  const first = JSON.parse(modelRequests(runtime)[0].body).messages;
  streamResponse(modelRequests(runtime)[0], { reply: 'First answer' });
  prompt(runtime, 'Second question', 2);
  const second = JSON.parse(modelRequests(runtime)[1].body).messages;
  assert.deepEqual(second.slice(0, first.length), first);
  assert.deepEqual(second[first.length], { role: 'assistant', content: 'First answer' });
  streamResponse(modelRequests(runtime)[1], { reply: 'Second answer' });
  prompt(runtime, 'Third question', 3);
  const third = JSON.parse(modelRequests(runtime)[2].body).messages;
  assert.deepEqual(third.slice(0, second.length), second);
  assert.deepEqual(third[second.length], { role: 'assistant', content: 'Second answer' });
  assert.equal(third.filter(message => /^Current local time is /.test(message.content || '')).length, 3);
  assert.ok(third.every(message => !('localTime' in message)));
});

test('tool rounds preserve the full request prefix and its timestamp', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Calculate 6 times 7');
  const first = JSON.parse(modelRequests(runtime)[0].body).messages;
  streamResponse(modelRequests(runtime)[0], { toolCalls: [{ name: 'calculator', arguments: { expression: '6*7' } }] });
  const second = JSON.parse(modelRequests(runtime)[1].body).messages;
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(second.filter(message => /^Current local time is /.test(message.content || '')).length, 1);
  assert.equal(second.at(-1).role, 'tool');
  assert.match(second.at(-1).content, /42/);
  streamResponse(modelRequests(runtime)[1], { reply: '42' });
  prompt(runtime, 'Now multiply that by two', 2);
  const nextTurn = JSON.parse(modelRequests(runtime)[2].body).messages;
  assert.deepEqual(nextTurn.slice(0, second.length), second);
  assert.deepEqual(nextTurn[second.length], { role: 'assistant', content: '42' });
  assert.equal(nextTurn.filter(message => /^Current local time is /.test(message.content || '')).length, 2);
});

test('directions use the FOSSGIS profile for the requested travel mode', () => {
  for (const [mode, profile, label] of [['cycling', 'routed-bike', 'Cycling'], ['driving', 'routed-car', 'Driving'], [' Walking ', 'routed-foot', 'Walking']]) {
    const runtime = createRuntime({ EnableOpenStreetMap: '1' });
    let result;
    runtime.context.runDirectionsTool({
      destination: 'Park', mode,
      originLatitude: 55.6761, originLongitude: 12.5683,
      destinationLatitude: 55.68, destinationLongitude: 12.575
    }, runtime.context.requestGeneration, content => { result = content; });
    const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
    assert.match(route.url, new RegExp('/' + profile + '/route/v1/driving/'));
    route.status = 200;
    route.responseText = JSON.stringify({ code: 'Ok', routes: [{ distance: 500, duration: 300, legs: [{ steps: [] }] }] });
    route.onload();
    assert.match(result, new RegExp('^' + label + ' directions to Park'));
  }
});

test('directions reject an unknown travel mode before GPS or network access', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  let gpsUsed = false;
  runtime.context.navigator.geolocation = { getCurrentPosition() { gpsUsed = true; } };
  let error;
  runtime.context.runDirectionsTool({ destination: 'Park', mode: 'transit' },
    runtime.context.requestGeneration, (content, problem) => { error = problem; });
  assert.equal(error, 'Directions mode must be walking, cycling, or driving.');
  assert.equal(gpsUsed, false);
  assert.equal(runtime.requests.length, 0);
});

test('directions accept destination coordinates without a destination name', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  let result;
  let error;
  runtime.context.runDirectionsTool({
    originLatitude: 55.6761, originLongitude: 12.5683,
    destinationLatitude: 55.68, destinationLongitude: 12.575
  }, runtime.context.requestGeneration, (content, problem) => { result = content; error = problem; });
  assert.equal(error, undefined);
  const route = runtime.requests.find(request => request.url && request.url.includes('routing.openstreetmap.de'));
  assert.ok(route.sent);
  route.status = 200;
  route.responseText = JSON.stringify({ code: 'Ok', routes: [{ distance: 500, duration: 300, legs: [{ steps: [] }] }] });
  route.onload();
  assert.match(result, /^Walking directions to coordinates \(55\.68, 12\.575\)/);
});

test('back-to-back Nominatim lookups are spaced at least one second apart', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  const clock = useFakeClock(runtime, 10000);
  runtime.context.runDirectionsTool({ origin: 'Station', destination: 'Park' },
    runtime.context.requestGeneration, () => {});
  const originSearch = runtime.requests.find(request => /q=Station/.test(request.url || ''));
  assert.ok(originSearch.sent);
  originSearch.status = 200;
  originSearch.responseText = JSON.stringify([{ lat: '55.67', lon: '12.56', display_name: 'Station' }]);
  originSearch.onload();

  const destinationSearch = runtime.requests.find(request => /q=Park/.test(request.url || ''));
  assert.ok(destinationSearch);
  assert.equal(destinationSearch.sent, undefined);
  assert.equal(runtime.timers.length, 1);
  clock.now = 11000;
  runtime.timers.shift()();
  assert.equal(destinationSearch.sent, true);
});

function useFakeClock(runtime, start) {
  const clock = { now: start };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  runtime.context.Date = FakeDate;
  return clock;
}

function queueLookup(runtime, label) {
  const request = new runtime.context.XMLHttpRequest();
  request.open('GET', 'https://nominatim.openstreetmap.org/search?q=' + label);
  runtime.context.trackRequest(request, runtime.context.requestGeneration);
  runtime.context.sendRateLimited(request, 'nominatim', null, () => {});
  return request;
}

test('a late queue timer still sends only one request per second', () => {
  const runtime = createRuntime({});
  const clock = useFakeClock(runtime, 10000);
  const sendTimes = [];
  const first = queueLookup(runtime, 'a');
  assert.equal(first.sent, true);
  const second = queueLookup(runtime, 'b');
  const third = queueLookup(runtime, 'c');
  for (const request of [second, third]) {
    const send = request.send;
    request.send = function() { sendTimes.push(clock.now); send.call(this); };
  }

  clock.now = 13000;
  runtime.timers.shift()();
  assert.deepEqual(sendTimes, [13000]);
  assert.equal(third.sent, undefined);
  assert.equal(runtime.timers.length, 1);
  clock.now = 14000;
  runtime.timers.shift()();
  assert.deepEqual(sendTimes, [13000, 14000]);
});

test('cancelled queued requests do not delay later lookups', () => {
  const runtime = createRuntime({});
  const clock = useFakeClock(runtime, 10000);
  queueLookup(runtime, 'first');
  for (let i = 0; i < 5; i++) {
    const request = queueLookup(runtime, 'cancelled' + i);
    request._cancelled = true;
  }
  clock.now = 11000;
  runtime.timers.shift()();
  assert.equal(runtime.timers.length, 0);
  const fresh = queueLookup(runtime, 'fresh');
  assert.equal(fresh.sent, true);
});

test('turning OpenStreetMap off while GPS is pending stops the lookup', () => {
  const runtime = createRuntime({ EnableOpenStreetMap: '1' });
  let deliverPosition;
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) { deliverPosition = success; }
  };
  let error;
  runtime.context.runNearbyPlacesTool({ query: 'supermarket' },
    runtime.context.requestGeneration, (content, problem) => { error = problem; });
  runtime.context.localStorage.setItem('EnableOpenStreetMap', '0');
  deliverPosition({ coords: { latitude: 55.6761, longitude: 12.5683 } });

  assert.equal(runtime.requests.some(request => request.sent), false);
  assert.match(error, /OpenStreetMap access was disabled/);
});

function streamVoice(runtime, sampleValues) {
  runtime.listeners.audiostreamstart({ sampleRate: 16000, format: 'pcm16le' });
  const samples = new Int16Array(sampleValues);
  runtime.listeners.audiostream({ data: samples.buffer });
}

function audioModelInfo(runtime, model, modalities) {
  runtime.storage.set('ModelCapability:v2:' + model, JSON.stringify({
    fetchedAt: Date.now(),
    model: { id: model, supported_parameters: [], input_modalities: modalities }
  }));
}

test('a recording goes to the speech model as WAV and the transcript goes back', () => {
  const runtime = createRuntime({ VoiceInput: 'openrouter' });
  const samples = Array.from({ length: 8000 }, (_, i) => (i % 200) - 100);
  streamVoice(runtime, samples);
  runtime.listeners.appmessage({ payload: { VoiceEnd: 1 } });
  assert.equal(runtime.requests.length, 0, 'waits for audiostreamstop before sending');
  runtime.listeners.audiostreamstop({});

  const request = runtime.requests[0];
  assert.equal(request.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'elevenlabs/scribe-v2');
  assert.equal(body.input_audio.format, 'wav');

  const wav = Buffer.from(body.input_audio.data, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.length, 44 + samples.length * 2);
  for (let i = 0; i < samples.length; i += 997) {
    assert.equal(wav.readInt16LE(44 + i * 2), samples[i]);
  }

  request.status = 200;
  request.responseText = JSON.stringify({ text: ' Send a demo message.\n', usage: { cost: 0.001 } });
  request.onload();
  assert.ok(runtime.sentMessages.some(message => message.VoiceTranscript === 'Send a demo message.'));
});

test('base64 encoding matches Node for every padding length', () => {
  const runtime = createRuntime();
  for (const length of [0, 1, 2, 3, 4, 5, 20000]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 37) & 255);
    assert.equal(runtime.context.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('a cancelled voice recording is never transcribed', () => {
  const runtime = createRuntime({ VoiceInput: 'openrouter' });
  streamVoice(runtime, new Array(8000).fill(5));
  runtime.listeners.appmessage({ payload: { VoiceEnd: 0 } });
  runtime.listeners.audiostreamstop({});
  assert.equal(runtime.requests.length, 0);
});

test('a too short voice recording reports that nothing was heard', () => {
  const runtime = createRuntime({ VoiceInput: 'openrouter' });
  streamVoice(runtime, new Array(100).fill(5));
  runtime.listeners.audiostreamstop({});
  runtime.listeners.appmessage({ payload: { VoiceEnd: 1 } });
  assert.equal(runtime.requests.length, 0);
  assert.ok(runtime.sentMessages.some(message => message.VoiceFailed === "Didn't catch that"));
});

test('tool states tell the watch which speech-to-text to use', () => {
  const runtime = createRuntime({ VoiceInput: 'openrouter' });
  runtime.context.sendToolStatesToWatch();
  assert.match(runtime.sentMessages.at(-1).ToolStates, /;voice=1;direct=0$/);
  runtime.storage.set('VoiceInput', 'pebble');
  runtime.context.sendToolStatesToWatch();
  assert.match(runtime.sentMessages.at(-1).ToolStates, /;voice=0;direct=0$/);
});

test('with an audio-capable model the recording goes straight to the chat model', () => {
  const runtime = createRuntime({ VoiceInput: 'openrouter', OpenRouterModel: 'google/gemini-3.8-flash' });
  audioModelInfo(runtime, 'google/gemini-3.8-flash', ['text', 'audio']);
  streamVoice(runtime, new Array(8000).fill(9));
  runtime.listeners.audiostreamstop({});
  runtime.listeners.appmessage({ payload: { VoiceEnd: 1 } });

  assert.equal(runtime.requests.length, 0, 'no transcription request');
  assert.ok(runtime.sentMessages.some(message => message.VoiceTranscript === '(Voice message)'));

  runtime.listeners.appmessage({ payload: { Prompt: '(Voice message)', RequestId: 1 } });
  const chat = runtime.requests.at(-1);
  assert.equal(chat.url, 'https://openrouter.ai/api/v1/chat/completions');
  const user = JSON.parse(chat.body).messages.at(-1);
  assert.equal(user.role, 'user');
  assert.equal(user.content[1].type, 'input_audio');
  assert.equal(user.content[1].input_audio.format, 'wav');
  assert.equal(runtime.context.conversationHistory.at(-1).content, '(Voice message)');
});

test('choice answers and non-audio models still use the speech model', () => {
  const runtime = createRuntime({ VoiceInput: 'openrouter', OpenRouterModel: 'google/gemini-3.8-flash' });
  audioModelInfo(runtime, 'google/gemini-3.8-flash', ['text', 'audio']);
  streamVoice(runtime, new Array(8000).fill(9));
  runtime.listeners.audiostreamstop({});
  runtime.listeners.appmessage({ payload: { VoiceEnd: 2 } });
  assert.equal(runtime.requests.at(-1).url, 'https://openrouter.ai/api/v1/audio/transcriptions');

  const textOnly = createRuntime({ VoiceInput: 'openrouter', OpenRouterModel: 'openai/gpt-6.1-sol' });
  audioModelInfo(textOnly, 'openai/gpt-6.1-sol', ['text', 'image']);
  streamVoice(textOnly, new Array(8000).fill(9));
  textOnly.listeners.audiostreamstop({});
  textOnly.listeners.appmessage({ payload: { VoiceEnd: 1 } });
  assert.equal(textOnly.requests.at(-1).url, 'https://openrouter.ai/api/v1/audio/transcriptions');

  const toggledOff = createRuntime({ VoiceInput: 'openrouter', VoiceDirect: '0', OpenRouterModel: 'google/gemini-3.8-flash' });
  audioModelInfo(toggledOff, 'google/gemini-3.8-flash', ['text', 'audio']);
  streamVoice(toggledOff, new Array(8000).fill(9));
  toggledOff.listeners.audiostreamstop({});
  toggledOff.listeners.appmessage({ payload: { VoiceEnd: 1 } });
  assert.equal(toggledOff.requests.at(-1).url, 'https://openrouter.ai/api/v1/audio/transcriptions');
});

function meterRun(runtime, amplitudes) {
  const levels = [];
  runtime.setSendHandler((dict, success) => {
    if (dict.VoiceLevel !== undefined) levels.push(dict.VoiceLevel);
    success({});
  });
  runtime.listeners.audiostreamstart({ sampleRate: 16000, format: 'pcm16le' });
  for (const amp of amplitudes) {
    const chunk = new Int16Array(1600).map((_, i) => (i % 2 ? amp : -amp));
    runtime.listeners.audiostream({ data: chunk.buffer });
  }
  runtime.listeners.audiostreamstop({});
  return levels;
}

test('voice meter fills for quiet and loud speakers, stays low in silence', () => {
  const quiet = meterRun(createRuntime(), Array(30).fill(300));
  assert.ok(quiet[quiet.length - 1] >= 90, 'quiet voice fills the meter: ' + quiet.slice(-3));

  const loud = meterRun(createRuntime(), Array(30).fill(8000));
  assert.ok(loud[loud.length - 1] >= 90, 'loud voice fills the meter: ' + loud.slice(-3));

  const silent = meterRun(createRuntime(), Array(30).fill(40));
  assert.equal(silent[silent.length - 1], 0);

  const noise = meterRun(createRuntime(), Array(30).fill(120));
  assert.ok(noise[noise.length - 1] > 0, 'wind/room noise still shows');
});

test('one tap does not shrink the meter for speech after it', () => {
  const runtime = createRuntime();
  const levels = meterRun(runtime, [...Array(20).fill(800), 30000, ...Array(5).fill(800)]);
  assert.ok(levels[levels.length - 1] >= 85, 'speech after a tap: ' + levels.slice(-6));
});

test('the meter forgets a loud last recording within about a second', () => {
  const runtime = createRuntime();
  meterRun(runtime, Array(40).fill(20000));
  const levels = meterRun(runtime, Array(15).fill(400));
  assert.ok(levels[levels.length - 1] >= 90, 'adapted: ' + levels.slice(-4));
});

test('tool states carry the response vibration setting', () => {
  const runtime = createRuntime({});
  runtime.context.sendToolStatesToWatch();
  assert.match(runtime.sentMessages.at(-1).ToolStates, /;vibe=3;/);
  runtime.storage.set('ResponseVibration', 'off');
  runtime.context.sendToolStatesToWatch();
  assert.match(runtime.sentMessages.at(-1).ToolStates, /;vibe=0;/);
});

test('trimming history keeps each retained user timestamp and the existing message budget', () => {
  const runtime = createRuntime();
  for (let i = 0; i < 15; i++) {
    prompt(runtime, 'Question ' + i, i + 1);
    streamResponse(modelRequests(runtime).at(-1), { reply: 'Answer ' + i });
  }
  const history = runtime.context.conversationHistory;
  assert.equal(history.length, runtime.context.MAX_HISTORY_MESSAGES);
  assert.equal(history[0].role, 'user');
  const messages = JSON.parse(JSON.stringify(runtime.context.buildMessages()));
  for (const entry of history.filter(message => message.role === 'user')) {
    const index = messages.findIndex(message => message.role === 'user' && message.content === entry.content);
    assert.ok(index > 0);
    assert.deepEqual(messages[index - 1], { role: 'system', content: entry.localTime });
  }
  const sessions = runtime.context.sessionsToText();
  assert.doesNotMatch(sessions, /Current local time is/);
});

function weatherRequest(runtime, timeframe = 'now') {
  runtime.context.navigator.geolocation = {
    getCurrentPosition(success) { success({ coords: { latitude: 55, longitude: 12 } }); }
  };
  let result;
  let error;
  runtime.context.runWeatherTool({ place: 'current location', timeframe }, runtime.context.requestGeneration,
    (content, problem) => { result = content; error = problem; });
  const request = runtime.requests.find(request => request.url.includes('/forecast'));
  return {
    request,
    respond(data) {
      request.status = 200;
      request.responseText = JSON.stringify(data);
      request.onload();
      assert.equal(error, null);
      return result;
    }
  };
}

function detailedWeather() {
  return {
    timezone: 'Asia/Tokyo', utc_offset_seconds: 32400,
    current: { time: '2026-11-07T00:15', temperature_2m: 17.2, apparent_temperature: 15.4,
      weather_code: 2, relative_humidity_2m: 73, wind_speed_10m: 12.4, wind_direction_10m: 315, precipitation: 0.5 },
    daily: { time: ['2026-11-07', '2026-11-08', '2026-11-09'], temperature_2m_max: [21, 22, 23],
      temperature_2m_min: [12, 13, 14], weather_code: [2, 3, 61], precipitation_probability_max: [70, 40, 90],
      precipitation_sum: [2.5, 1, 4], uv_index_max: [4.5, 3, 2],
      sunrise: ['2026-11-07T06:12', '2026-11-08T06:13', '2026-11-09T06:14'],
      sunset: ['2026-11-07T16:40', '2026-11-08T16:39', '2026-11-09T16:38'] },
    hourly: { time: ['2026-11-07T00:00', '2026-11-07T01:00', '2026-11-07T02:00', '2026-11-07T03:00', '2026-11-07T04:00'],
      temperature_2m: [17, 16, 15, 14, 13], weather_code: [0, 1, 2, 3, 61],
      apparent_temperature: [16, 15, 14, 13, 12], relative_humidity_2m: [73, 74, 75, 76, 77],
      precipitation_probability: [10, 20, 30, 40, 50], precipitation: [0, 0.1, 0.2, 0.3, 0.4],
      wind_speed_10m: [10, 11, 12, 13, 14], wind_direction_10m: [0, 45, 315, 270, 180], uv_index: [0, 0, 0, 0, 0] }
  };
}

for (const [setting, language, imperial] of [
  ['metric', 'en-US', false], ['imperial', 'da-DK', true],
  ['automatic', 'en-US', false], ['automatic', 'en-LR', false], ['automatic', 'my-MM', false],
  ['automatic', 'da-DK', false], ['automatic', 'en-GB', false], ['automatic', 'en', false],
  ['automatic', undefined, false], ['automatic', 'en-us', false], ['automatic', 'my_Mm', false],
  ['automatic', 'en-Latn-US', false], ['automatic', 'us', false], [undefined, 'en-US', false]
]) {
  test(`weather units ${setting}, locale ${language}`, () => {
    const runtime = createRuntime({ EnableLocation: '1', ...(setting ? { WeatherUnits: setting } : {}) });
    runtime.context.navigator.language = language;
    const params = new URL(weatherRequest(runtime).request.url).searchParams;
    assert.equal(params.get('temperature_unit'), imperial ? 'fahrenheit' : 'celsius');
    assert.equal(params.get('wind_speed_unit'), imperial ? 'mph' : 'kmh');
    assert.equal(params.get('precipitation_unit'), imperial ? 'inch' : 'mm');
    assert.equal(params.get('timezone'), 'auto');
    assert.ok(params.get('current').split(',').includes('wind_direction_10m'));
    for (const field of ['apparent_temperature', 'wind_direction_10m', 'uv_index', 'precipitation_probability']) {
      assert.ok(params.get('hourly').split(',').includes(field));
    }
    for (const field of ['sunrise', 'sunset', 'uv_index_max']) assert.ok(params.get('daily').split(',').includes(field));
  });
}

test('weather units persist from Clay raw and converted settings and reopen', () => {
  const runtime = createRuntime();
  runtime.context.saveSettings({}, { WeatherUnits: { value: 'imperial' } });
  assert.equal(runtime.storage.get('WeatherUnits'), 'imperial');
  let settings;
  runtime.context.clay.setSettings = value => { settings = value; };
  runtime.context.openConfiguration('test-model', {}, []);
  assert.equal(settings.WeatherUnits, 'imperial');
  runtime.context.saveSettings({ WeatherUnits: 'metric' }, {});
  assert.equal(runtime.storage.get('WeatherUnits'), 'metric');
  runtime.context.saveSettings({}, {});
  assert.equal(runtime.storage.get('WeatherUnits'), 'metric');
  runtime.context.saveSettings({ WeatherUnits: 'invalid' }, {});
  assert.equal(runtime.storage.get('WeatherUnits'), 'metric');
});

for (const timeframe of ['now', 'today']) {
  test(`weather ${timeframe} includes current conditions and local daily details`, () => {
    const runtime = createRuntime({ EnableLocation: '1' });
    const result = weatherRequest(runtime, timeframe).respond(detailedWeather());
    for (const text of ['Asia/Tokyo', '17°C', 'Partly cloudy', 'feels like 15°C', 'humidity 73%',
      'wind 12km/h', 'from 315° NW', 'precip 0.5mm', 'high 21°C', 'low 12°C',
      'precip chance 70%', 'UV max 4.5', 'sunrise 06:12', 'sunset 16:40']) assert.ok(result.includes(text), text);
    assert.doesNotMatch(result, /NaN|undefined/);
  });
}

test('weather uses returned imperial units for all measurements', () => {
  const runtime = createRuntime({ EnableLocation: '1', WeatherUnits: 'imperial' });
  const data = detailedWeather();
  data.current_units = { temperature_2m: '°F', apparent_temperature: '°F', wind_speed_10m: 'mph', precipitation: 'inch' };
  data.daily_units = { temperature_2m_max: '°F', temperature_2m_min: '°F', precipitation_sum: 'inch' };
  const result = weatherRequest(runtime).respond(data);
  assert.match(result, /17°F/);
  assert.match(result, /wind 12mph/);
  assert.match(result, /precip 0.5inch/);
  assert.match(result, /high 21°F, low 12°F/);
  assert.match(result, /precip 2.5inch/);
  assert.doesNotMatch(result, /°C|km\/h|mm/);
});

test('hour offsets use destination local time with surrounding hourly details', () => {
  const runtime = createRuntime({ EnableLocation: '1' });
  const result = weatherRequest(runtime, '+2h').respond(detailedWeather());
  assert.match(result, /2026-11-07 02:00 \(requested\): 15°C, Partly cloudy/);
  for (const time of ['01:00', '03:00', '04:00']) assert.ok(result.includes(time));
  assert.match(result, /precip chance 30%/);
  assert.match(result, /UV 0/);
  assert.match(result, /from 315° NW/);
  assert.equal(result.split('\n').length, 5);
});

test('multi-day forecasts give one line per day and single-day offsets retain their meaning', () => {
  const runtime = createRuntime({ EnableLocation: '1' });
  const result = weatherRequest(runtime, 'next 3d').respond(detailedWeather());
  assert.equal(result.split('\n').length, 4);
  assert.match(result, /2026-11-08: high 22°C, low 13°C, Overcast, precip chance 40%.*sunrise 06:13, sunset 16:39/);
  const single = weatherRequest(createRuntime({ EnableLocation: '1' }), '+2d').respond(detailedWeather());
  assert.equal(single.split('\n').length, 2);
  assert.match(single, /2026-11-09: high 23°C/);
});

for (const timeframe of ['now', 'today', 'next 3d', '+2h', '+99h', '+99d']) {
  test(`weather tolerates missing fields for ${timeframe}`, () => {
    const runtime = createRuntime({ EnableLocation: '1' });
    const result = weatherRequest(runtime, timeframe).respond({ current: { temperature_2m: null }, daily: { time: [] }, hourly: { time: [] } });
    assert.match(result, /unavailable/);
    assert.doesNotMatch(result, /NaN|undefined|null/);
  });
}

test('weather out-of-range offsets never substitute the final available forecast', () => {
  for (const timeframe of ['+99h', '+99d']) {
    const runtime = createRuntime({ EnableLocation: '1' });
    assert.match(weatherRequest(runtime, timeframe).respond(detailedWeather()), /unavailable/);
  }
});


test('weather settings default to Celsius and reopen legacy automatic as metric', () => {
  const config = require('../../src/pkjs/config');
  const section = config.find(item => item.items && item.items.some(child => child.messageKey === 'WeatherUnits'));
  const setting = section.items.find(item => item.messageKey === 'WeatherUnits');
  assert.equal(setting.defaultValue, 'metric');
  assert.deepEqual(setting.options.map(option => option.value), ['metric', 'imperial']);
  for (const stored of [undefined, 'automatic']) {
    const runtime = createRuntime(stored ? { WeatherUnits: stored } : {});
    let reopened;
    runtime.context.clay.setSettings = settings => { reopened = settings; };
    runtime.context.openConfiguration('test-model', {}, []);
    assert.equal(reopened.WeatherUnits, 'metric');
  }
});
