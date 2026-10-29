import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../server.js';

const apps = [];
const boot = async (options) => {
  const app = createApp({ dbPath: ':memory:', ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  apps.push(app);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, auth) => {
    const headers = { 'Content-Type': 'application/json', ...(auth?.startsWith('Bot ') ? { Authorization: auth } : { 'X-Requested-With': 'scrxaper', ...(auth && { Cookie: auth }) }) };
    const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const signUp = (username) => call('POST', '/api/register', { username, password: 'correct horse' });
  return { app, call, signUp };
};
after(() => Promise.all(apps.map((a) => a.close())));

const owner = { ownerUsername: 'boss', ownerPassword: 'a-long-owner-pass' };

test('owner credentials come from the environment and unlock stats; others get 404', async () => {
  const { call, signUp } = await boot(owner);
  assert.equal((await call('POST', '/api/login', { username: 'boss', password: 'wrong wrong wrong' })).status, 401);
  const boss = await call('POST', '/api/login', { username: 'boss', password: 'a-long-owner-pass' });
  await signUp('mia');
  const stats = await call('GET', '/api/owner/stats', null, boss.cookie);
  assert.equal(stats.status, 200);
  assert.equal(stats.data.users, 2);
  const mia = await call('POST', '/api/login', { username: 'mia', password: 'correct horse' });
  assert.equal((await call('GET', '/api/owner/stats', null, mia.cookie)).status, 404);
  assert.equal((await call('POST', '/api/owner/ban', { username: 'boss', reason: 'x' }, mia.cookie)).status, 404);
});

test('weak owner password is refused at startup', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', ownerUsername: 'boss', ownerPassword: 'short' }));
});

test('Teams warns, suspends and restores; replies to Teams are refused', async () => {
  const { call, signUp } = await boot(owner);
  const boss = await call('POST', '/api/login', { username: 'boss', password: 'a-long-owner-pass' });
  const kai = await signUp('kai');
  assert.equal((await call('POST', '/api/owner/warn', { username: 'kai', reason: 'spam' }, boss.cookie)).status, 200);
  const thread = await call('GET', '/api/messages?with=scrxaper', null, kai.cookie);
  assert.match(thread.data.messages[0].body, /warning: spam/);
  assert.equal((await call('POST', '/api/messages', { to: 'scrxaper', body: 'hi' }, kai.cookie)).status, 403);
  await call('POST', '/api/owner/ban', { username: 'kai', reason: 'spam again' }, boss.cookie);
  assert.equal((await call('GET', '/api/me', null, kai.cookie)).status, 401);
  const login = await call('POST', '/api/login', { username: 'kai', password: 'correct horse' });
  assert.equal(login.status, 403);
  assert.match(login.data.error, /spam again/);
  await call('POST', '/api/owner/unban', { username: 'kai' }, boss.cookie);
  assert.equal((await call('POST', '/api/login', { username: 'kai', password: 'correct horse' })).status, 200);
});

test('announcements reach every active user and Teams cannot be logged into or registered', async () => {
  const { call, signUp } = await boot(owner);
  const boss = await call('POST', '/api/login', { username: 'boss', password: 'a-long-owner-pass' });
  const lou = await signUp('lou');
  assert.equal((await call('POST', '/api/owner/announce', { text: 'Groups are here.' }, boss.cookie)).data.sent, 2);
  assert.equal((await call('GET', '/api/messages?with=scrxaper', null, lou.cookie)).data.messages[0].kind, 'announcement');
  assert.equal((await signUp('scrxaper')).status, 400);
  assert.equal((await call('POST', '/api/login', { username: 'scrxaper', password: '!' })).status, 401);
});

test('birthday card and message are sent once per year', async () => {
  const { app, call, signUp } = await boot();
  const noa = await signUp('noa');
  assert.equal((await call('POST', '/api/birthday', { month: 2, day: 31 }, noa.cookie)).status, 400);
  await call('POST', '/api/birthday', { month: 6, day: 15 }, noa.cookie);
  assert.equal(app.runBirthdays(new Date(Date.UTC(2026, 5, 14))), 0);
  assert.equal(app.runBirthdays(new Date(Date.UTC(2026, 5, 15))), 1);
  assert.equal(app.runBirthdays(new Date(Date.UTC(2026, 5, 15, 20))), 0);
  const msgs = (await call('GET', '/api/messages?with=scrxaper', null, noa.cookie)).data.messages;
  assert.deepEqual(msgs.map((m) => m.kind), ['card', 'text']);
  assert.equal(app.runBirthdays(new Date(Date.UTC(2027, 5, 15))), 1);
});

test('bots authenticate with a token, post in groups they were added to, and receive signed webhooks', async () => {
  const { call, signUp } = await boot({ allowPrivateWebhooks: true });
  const received = new Promise((resolve) => {
    const sink = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { res.end(); sink.close(); resolve({ raw, sig: req.headers['x-scrxaper-signature'] }); });
    }).listen(0, '127.0.0.1');
    sink.on('listening', () => { received.port = sink.address().port; });
  });
  const uma = await signUp('uma');
  const bot = (await call('POST', '/api/bots', { name: 'echo_bot' }, uma.cookie)).data;
  assert.match(bot.token, /^bot_/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call('POST', '/api/bots/webhook', { bot: 'echo_bot', url: 'ftp://nope' }, uma.cookie)).status, 400);
  assert.equal((await call('POST', '/api/bots/webhook', { bot: 'echo_bot', url: `http://127.0.0.1:${received.port}/hook` }, uma.cookie)).status, 200);
  const gid = (await call('POST', '/api/groups', { name: 'Bots' }, uma.cookie)).data.id;
  assert.equal((await call('POST', '/api/group-messages', { group: gid, body: 'hi' }, `Bot ${bot.token}`)).status, 404);
  await call('POST', '/api/group-members', { group: gid, username: 'echo_bot' }, uma.cookie);
  assert.equal((await call('POST', '/api/group-messages', { group: gid, body: 'beep' }, `Bot ${bot.token}`)).status, 201);
  await call('POST', '/api/group-messages', { group: gid, body: 'ping' }, uma.cookie);
  const { raw, sig } = await received;
  assert.equal(JSON.parse(raw).body, 'ping');
  assert.equal(sig, `sha256=${crypto.createHmac('sha256', bot.webhookSecret).update(raw).digest('hex')}`);
  assert.equal((await call('GET', '/api/me', null, 'Bot bot_forged')).status, 401);
  assert.equal((await call('POST', '/api/messages', { to: 'uma', body: 'unsolicited' }, `Bot ${bot.token}`)).status, 403);
});

test('webhook URLs must be https unless private targets are explicitly allowed', async () => {
  const { call, signUp } = await boot();
  const vic = await signUp('vic');
  await call('POST', '/api/bots', { name: 'vic_bot' }, vic.cookie);
  assert.equal((await call('POST', '/api/bots/webhook', { bot: 'vic_bot', url: 'http://127.0.0.1/hook' }, vic.cookie)).status, 400);
  assert.equal((await call('POST', '/api/bots/webhook', { bot: 'vic_bot', url: 'https://example.com/hook' }, vic.cookie)).status, 200);
});
