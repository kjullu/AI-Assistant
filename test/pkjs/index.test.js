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
  const content = JSON.stringify(value);
  request.status = 200;
  request.responseText = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n`;
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
  request.status = 200;
  request.responseText = JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] });
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
  assert.match(runtime.context.buildSystemPrompt(), /final watch-friendly answer as plain text/);
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

test('back-to-back JSON tool requests are parsed instead of shown as text', () => {
  const runtime = createRuntime();
  const parsed = runtime.context.parseAssistantContent(
    '{"toolCalls":[{"name":"location","arguments":{}}]}' +
    '{"toolCalls":[{"name":"weather","arguments":{"place":"current location","timeframe":"today"}}]}' +
    'Hvilken by eller sted vil du have vejret for?'
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(parsed.toolCalls)).map(call => call.name),
    ['location', 'weather']
  );
  assert.equal(parsed.reply, 'Hvilken by eller sted vil du have vejret for?');
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
  assert.deepEqual(JSON.parse(assistantCall.content), {
    toolCalls: [{ name: 'calculator', arguments: { value: 10, from: 'EUR', to: 'DKK' } }]
  });
  assert.equal(assistantCall.tool_calls, undefined);
  assert.equal(toolResult.role, 'user');
  assert.equal(toolResult.tool_call_id, undefined);
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
  assert.equal(followup.messages.at(-1).role, 'user');
  assert.match(followup.messages.at(-1).content, /Tool result for the preceding JSON request/);
  assert.match(followup.messages.at(-1).content, /steps=4321/);
  streamResponse(modelRequests(runtime)[1], { toolCalls: [], reply: 'You took 4,321 steps today.' });
  assert.ok(runtime.sentMessages.some(message =>
    message.AssistantResponse === '[tool] Health tool\nYou took 4,321 steps today.'));
});

test('Health instructions are included only when enabled', () => {
  assert.doesNotMatch(createRuntime().context.buildSystemPrompt(), /Health tool/);
  const promptText = createRuntime({ EnableHealth: '1' }).context.buildSystemPrompt();
  assert.match(promptText, /Health tool/);
  assert.match(promptText, /average\/minimum\/maximum heart rate/);
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
    message.AssistantResponse === '[tool] Calculator tool: 2+2\nFour.' && message.RequestId === 1));
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
    message.AssistantResponse === '[tool] Choice tool\n[tool] Choice tool\nA then B.'));
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
  const toolMessages = followupBody.messages.filter(message =>
    message.role === 'user' && /Tool result for the preceding JSON request/.test(message.content || ''));
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[0].content, /FIRST/);
  assert.match(toolMessages[1].content, /SECOND/);

  streamTextResponse(modelRequests(runtime)[1], 'Comparison complete.');
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse ===
    '[tool] Firecrawl Scrape tool: https://first.example\n' +
    '[tool] Firecrawl Scrape tool: https://second.example\nComparison complete.'));
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
    '[tool] Calculator tool: 2+2\n[tool] Calculator tool: 3+3\nFour and six.'));
});

test('completed tool calls retain the JSON text protocol in the next turn', () => {
  const runtime = createRuntime();
  prompt(runtime, 'What is two plus two?', 1);
  streamResponse(modelRequests(runtime)[0], {
    toolCalls: [{ name: 'calculator', arguments: { expression: '2+2' } }], reply: ''
  });
  streamTextResponse(modelRequests(runtime)[1], 'It is four.');

  prompt(runtime, 'What did you calculate?', 2);
  const nextTurn = JSON.parse(modelRequests(runtime)[2].body);
  const assistantToolCall = nextTurn.messages.find(message =>
    message.role === 'assistant' && /"toolCalls"/.test(message.content || ''));
  const toolResult = nextTurn.messages.find(message =>
    message.role === 'user' && /Tool result for the preceding JSON request/.test(message.content || ''));

  assert.equal(JSON.parse(assistantToolCall.content).toolCalls[0].name, 'calculator');
  assert.equal(nextTurn.messages.some(message => message.tool_calls || message.role === 'tool'), false);
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
  const toolMessages = followupBody.messages.filter(message =>
    message.role === 'user' && /Tool result for the preceding JSON request/.test(message.content || ''));
  assert.equal(toolMessages.length, 2);
  assert.ok(toolMessages.every(message => /SHARED/.test(message.content)));
  assert.ok(toolMessages.every(message => message.tool_call_id === undefined));
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

test('successful AppMessages leave time for the watch to render before the queue advances', () => {
  const runtime = createRuntime();
  const sends = [];
  runtime.context.WATCH_RENDER_GAP_MS = 150;
  runtime.setSendHandler((dict, success, failure) => sends.push({ dict, success, failure }));

  runtime.context.sendToWatch({ Status: 'First' });
  runtime.context.sendToWatch({ Status: 'Second' });
  sends[0].success();

  assert.equal(sends.length, 1);
  assert.equal(runtime.timers.length, 1);
  runtime.timers.shift()();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].dict.Status, 'Second');
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
