import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrx-'));
const dbPath = path.join(dir, 'test.db');
let app, base;

const start = async () => {
  app = createApp({ dbPath });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
};

const call = async (method, url, body, cookie) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper', ...(cookie && { Cookie: cookie }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

const signUp = (username) => call('POST', '/api/register', { username, password: 'correct horse' });

before(start);
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('health check reports database connectivity', async () => {
  assert.equal((await call('GET', '/healthz')).data.status, 'ok');
});

test('registration rejects bad usernames, short passwords and duplicates', async () => {
  assert.equal((await call('POST', '/api/register', { username: 'a!', password: 'correct horse' })).status, 400);
  assert.equal((await call('POST', '/api/register', { username: 'okname', password: 'short' })).status, 400);
  assert.equal((await signUp('dupe')).status, 200);
  assert.equal((await signUp('dupe')).status, 409);
});

test('login gives the same error for unknown users and wrong passwords', async () => {
  await signUp('lena');
  const wrong = await call('POST', '/api/login', { username: 'lena', password: 'nope nope nope' });
  const unknown = await call('POST', '/api/login', { username: 'ghost', password: 'nope nope nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, unknown.data);
});

test('state-changing requests need the custom header', async () => {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('messages require a session and the sender comes from the session', async () => {
  assert.equal((await call('GET', '/api/conversations')).status, 401);
  const ana = await signUp('ana');
  const ben = await signUp('ben');
  const sent = await call('POST', '/api/messages', { to: 'ben', body: 'hi ben', sender_id: 999, from: 'ben' }, ana.cookie);
  assert.equal(sent.status, 201);
  const thread = await call('GET', '/api/messages?with=ana', null, ben.cookie);
  assert.equal(thread.data.messages.length, 1);
  assert.equal(thread.data.messages[0].mine, false);
  const list = await call('GET', '/api/conversations', null, ben.cookie);
  assert.equal(list.data[0].username, 'ana');
});

test('third parties cannot read a conversation', async () => {
  const eve = await signUp('eve');
  const res = await call('GET', '/api/messages?with=ana', null, eve.cookie);
  assert.equal(res.data.messages.length, 0);
});

test('blocking stops messages in both directions', async () => {
  const cy = await signUp('cyra');
  const di = await signUp('dina');
  await call('POST', '/api/block', { username: 'cyra', blocked: true }, di.cookie);
  assert.equal((await call('POST', '/api/messages', { to: 'dina', body: 'hey' }, cy.cookie)).status, 403);
  assert.equal((await call('POST', '/api/messages', { to: 'cyra', body: 'hey' }, di.cookie)).status, 403);
  await call('POST', '/api/block', { username: 'cyra', blocked: false }, di.cookie);
  assert.equal((await call('POST', '/api/messages', { to: 'dina', body: 'hey' }, cy.cookie)).status, 201);
});

test('logout revokes the session', async () => {
  const kim = await signUp('kim');
  await call('POST', '/api/logout', {}, kim.cookie);
  assert.equal((await call('GET', '/api/me', null, kim.cookie)).status, 401);
});

test('path traversal in static files is refused', async () => {
  const res = await fetch(base + '/..%2Fserver.js');
  assert.equal(res.status, 404);
});

test('accounts and messages survive a restart', async () => {
  await app.close();
  await start();
  const login = await call('POST', '/api/login', { username: 'ben', password: 'correct horse' });
  assert.equal(login.status, 200);
  const thread = await call('GET', '/api/messages?with=ana', null, login.cookie);
  assert.equal(thread.data.messages[0].body, 'hi ben');
});

test('groups: only members read and write, only admins manage', async () => {
  const gus = await signUp('gus');
  const hal = await signUp('hal');
  const ivy = await signUp('ivy');
  const made = await call('POST', '/api/groups', { name: 'Trip', members: ['hal'] }, gus.cookie);
  assert.equal(made.status, 201);
  const gid = made.data.id;
  assert.equal((await call('POST', '/api/group-messages', { group: gid, body: 'hello all' }, hal.cookie)).status, 201);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, ivy.cookie)).status, 404);
  assert.equal((await call('POST', '/api/group-messages', { group: gid, body: 'x' }, ivy.cookie)).status, 404);
  assert.equal((await call('POST', '/api/group-members', { group: gid, username: 'ivy' }, hal.cookie)).status, 403);
  assert.equal((await call('POST', '/api/group-members', { group: gid, username: 'ivy' }, gus.cookie)).status, 200);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, ivy.cookie)).data.messages.length, 1);
  await call('POST', '/api/group-remove', { group: gid, username: 'ivy' }, gus.cookie);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, ivy.cookie)).status, 404);
});

test('groups: invites join once valid, admin hands over on leave', async () => {
  const zed = await signUp('zed');
  const amy = await signUp('amy');
  const gid = (await call('POST', '/api/groups', { name: 'Club' }, zed.cookie)).data.id;
  assert.equal((await call('POST', '/api/group-invite', { group: gid }, amy.cookie)).status, 404);
  const { code } = (await call('POST', '/api/group-invite', { group: gid }, zed.cookie)).data;
  assert.equal((await call('POST', '/api/group-join', { code: 'bogus' }, amy.cookie)).status, 404);
  assert.equal((await call('POST', '/api/group-join', { code }, amy.cookie)).status, 200);
  await call('POST', '/api/group-leave', { group: gid }, zed.cookie);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, amy.cookie)).data.role, 'admin');
});
