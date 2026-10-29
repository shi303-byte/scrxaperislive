import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';

const GOOD = 'gsk_good_key_1234567890abcdef';
let lastChat = null;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const key = (req.headers.authorization ?? '').replace('Bearer ', '');
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (key === 'gsk_bad_key_1234567890abcdef') return reply(401, {});
    if (key === 'gsk_limited_key_1234567890abc') return reply(429, {});
    if (req.url === '/models') return reply(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-test' }] });
    lastChat = JSON.parse(raw);
    reply(200, { choices: [{ message: { content: 'Hello from the fake provider' } }] });
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.on('listening', r));
after(() => fake.close());
const groqBase = `http://127.0.0.1:${fake.address().port}`;

const boot = async (options = {}) => {
  const app = createApp({ dbPath: ':memory:', authLimit: 1000, aiKeySecret: 's'.repeat(40), groqBase, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper', ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: res.status, text: await res.clone().text(), data: await res.json() };
  };
  const join = async (name) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper' }, body: JSON.stringify({ username: name, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
  return { app, call, join };
};

test('keys cannot be stored when the server has no encryption secret', async () => {
  const { call, join } = await boot({ aiKeySecret: undefined });
  const c = await join('ann');
  assert.equal((await call('GET', '/api/ai/settings', null, c)).data.available, false);
  assert.equal((await call('POST', '/api/ai/settings', { apiKey: GOOD, model: 'llama-test' }, c)).status, 503);
});

test('the key is stored encrypted and never returned to the browser', async () => {
  const { app, call, join } = await boot();
  const c = await join('bob');
  assert.equal((await call('POST', '/api/ai/settings', { apiKey: 'short', model: 'llama-test' }, c)).status, 400);
  assert.equal((await call('POST', '/api/ai/settings', { apiKey: GOOD, model: 'llama-test' }, c)).status, 200);
  const settings = await call('GET', '/api/ai/settings', null, c);
  assert.equal(settings.data.hasKey, true);
  assert.ok(!settings.text.includes(GOOD));
  const stored = app.db.prepare('SELECT key_enc FROM ai_settings').get().key_enc;
  assert.ok(!stored.includes(GOOD) && !Buffer.from(stored, 'base64').includes(GOOD));
  assert.equal((await call('POST', '/api/ai/settings', { model: 'openai/gpt-oss-120b' }, c)).status, 200);
  assert.equal((await call('GET', '/api/ai/models', null, c)).data.includes('llama-test'), true);
});

test('connection test validates the key and the chosen model', async () => {
  const { call, join } = await boot();
  const c = await join('cat');
  await call('POST', '/api/ai/settings', { apiKey: GOOD, model: 'llama-test' }, c);
  assert.equal((await call('POST', '/api/ai/test', {}, c)).status, 200);
  await call('POST', '/api/ai/settings', { model: 'gone-model' }, c);
  assert.equal((await call('POST', '/api/ai/test', {}, c)).status, 400);
  await call('POST', '/api/ai/settings', { apiKey: 'gsk_bad_key_1234567890abcdef', model: 'llama-test' }, c);
  assert.match((await call('POST', '/api/ai/test', {}, c)).data.error, /rejected/);
});

test('chat stores real replies, sends local time, keeps conversations private', async () => {
  const { call, join } = await boot();
  const c = await join('dan');
  assert.equal((await call('POST', '/api/ai/chat', { text: 'hi' }, c)).status, 400);
  await call('POST', '/api/ai/settings', { apiKey: GOOD, model: 'llama-test', personality: 'dry humour' }, c);
  const first = await call('POST', '/api/ai/chat', { text: 'Hello buddy', localTime: 'Tuesday 21:05' }, c);
  assert.equal(first.data.reply, 'Hello from the fake provider');
  assert.equal(lastChat.model, 'llama-test');
  assert.match(lastChat.messages[0].content, /21:05/);
  assert.match(lastChat.messages[0].content, /dry humour/);
  const id = first.data.conversation;
  await call('POST', '/api/ai/chat', { conversation: id, text: 'And again' }, c);
  assert.deepEqual((await call('GET', `/api/ai/messages?conversation=${id}`, null, c)).data.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  const eve = await join('eve');
  assert.equal((await call('GET', `/api/ai/messages?conversation=${id}`, null, eve)).status, 404);
  assert.equal((await call('POST', '/api/ai/chat', { conversation: id, text: 'x' }, eve)).status, 400);
  await call('POST', '/api/ai/rename', { conversation: id, title: 'Chat one' }, c);
  assert.equal((await call('GET', '/api/ai/conversations', null, c)).data[0].title, 'Chat one');
});

test('provider failures never produce a fake reply or leave stray messages', async () => {
  const { call, join } = await boot();
  const c = await join('fay');
  await call('POST', '/api/ai/settings', { apiKey: 'gsk_limited_key_1234567890abc', model: 'llama-test' }, c);
  const limited = await call('POST', '/api/ai/chat', { text: 'hello' }, c);
  assert.equal(limited.status, 429);
  assert.match(limited.data.error, /rate limit/i);
  assert.equal((await call('GET', '/api/ai/conversations', null, c)).data.length, 0);
  const down = await boot({ groqBase: 'http://127.0.0.1:1' });
  const d = await down.join('gus');
  await down.call('POST', '/api/ai/settings', { apiKey: GOOD, model: 'llama-test' }, d);
  assert.equal((await down.call('POST', '/api/ai/chat', { text: 'hello' }, d)).status, 502);
  assert.equal((await down.call('GET', '/api/ai/conversations', null, d)).data.length, 0);
});

test('users can remove the key and delete all stored conversations', async () => {
  const { call, join } = await boot();
  const c = await join('hal');
  await call('POST', '/api/ai/settings', { apiKey: GOOD, model: 'llama-test' }, c);
  await call('POST', '/api/ai/chat', { text: 'hello' }, c);
  await call('POST', '/api/ai/delete-all', {}, c);
  assert.equal((await call('GET', '/api/ai/conversations', null, c)).data.length, 0);
  await call('POST', '/api/ai/key/delete', {}, c);
  assert.equal((await call('GET', '/api/ai/settings', null, c)).data.hasKey, false);
  assert.equal((await call('POST', '/api/ai/chat', { text: 'hello' }, c)).status, 400);
});
