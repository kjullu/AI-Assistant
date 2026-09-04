const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../../src/pkjs/config');
const textarea = require('../../src/pkjs/textarea');

function findByMessageKey(items, messageKey) {
  for (const item of items) {
    if (item.messageKey === messageKey) return item;
    if (item.items) {
      const found = findByMessageKey(item.items, messageKey);
      if (found) return found;
    }
  }
  return null;
}

test('editable multiline settings preserve line boundaries', () => {
  for (const messageKey of ['ExtraSystemPrompt', 'NotesMemoryText', 'OpenSessions']) {
    const item = findByMessageKey(config, messageKey);
    assert.ok(item, `${messageKey} should exist`);
    assert.equal(item.type, 'textarea', `${messageKey} should use a multiline editor`);
  }
});

test('multiline settings stay within the section padding', () => {
  assert.match(textarea.style, /width:100%;min-width:0;max-width:none/);
  assert.match(textarea.style, /margin-left:0/);
});

test('memory toggle and notes are adjacent in phone settings', () => {
  const section = config.find((item) =>
    item.type === 'section' &&
    item.items.some((child) => child.messageKey === 'EnableMemory')
  );
  const keys = section.items.map((item) => item.messageKey).filter(Boolean);

  assert.deepEqual(keys.slice(0, 2), ['EnableMemory', 'NotesMemoryText']);
});
