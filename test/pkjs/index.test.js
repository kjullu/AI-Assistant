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
      throw new Error(`Unexpected require: ${name}`);
    },
    Pebble: {
      addEventListener(name, callback) { listeners[name] = callback; },
      sendAppMessage(dict, success, failure) {
        sentMessages.push({ ...dict });
        sendHandler(dict, success, failure);
      },
      getTimelineToken(success) { success('timeline-token'); },
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
  assert.ok(runtime.storage.has('ReasoningCapability:vendor/model:free'));
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
  assert.match(result, /Today: 13-21°C/);
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
    runtime.context.watchSafeText('Danish: æøå • 2× H100 “fast” €10–20 ≤ 5…\ufe0f'),
    'Danish: æøå • 2x H100 "fast" €10-20 <= 5...'
  );
});

test('watch text gives unsupported emoji and status symbols readable fallbacks', () => {
  const runtime = createRuntime();

  assert.equal(
    runtime.context.watchSafeText('✅ Ready ⚠\ufe0f Careful ❌ Failed 🚀🔥'),
    '[ok] Ready [!] Careful [x] Failed [emoji]'
  );
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

test('streaming waits for a low surrogate before sending an emoji fallback', () => {
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
    'Ready [emoji] now'
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
