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
  let sendHandler = (dict, success) => success();

  function Clay() {}
  Clay.prototype.setSettings = function() {};
  Clay.prototype.generateUrl = function() { return 'https://config.invalid'; };
  Clay.prototype.getSettings = function() { return {}; };

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

  return {
    context,
    listeners,
    requests,
    sentMessages,
    storage,
    timers,
    setSendHandler(handler) { sendHandler = handler; }
  };
}

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

test('final answers stream as plain text without a JSON wrapper', () => {
  const runtime = createRuntime();
  prompt(runtime, 'Say hello');
  streamTextResponse(modelRequests(runtime)[0], 'Hello from Pebble.');

  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'Hello from Pebble.'));
  assert.match(runtime.context.buildSystemPrompt(), /final watch-friendly answer as plain text/);
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
  assert.match(followup.messages.at(-1).content, /74\.834 DKK/);
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
  assert.match(followup.messages.at(-1).content, /steps=4321/);
  streamResponse(modelRequests(runtime)[1], { toolCalls: [], reply: 'You took 4,321 steps today.' });
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'You took 4,321 steps today.'));
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
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'Four.' && message.RequestId === 1));
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
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'A then B.'));
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
  const resultsMessage = followupBody.messages[followupBody.messages.length - 1].content;
  assert.ok(resultsMessage.indexOf('FIRST') < resultsMessage.indexOf('SECOND'));
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
  assert.ok(runtime.sentMessages.some(message => message.AssistantResponse === 'Four and six.'));
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
  assert.equal((followupBody.messages.at(-1).content.match(/SHARED/g) || []).length, 2);
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
