import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const app = createApp({ dbPath: ':memory:', authLimit: 1000 });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
after(() => app.close());
const base = `http://127.0.0.1:${app.server.address().port}`;
const call = async (method, url, body, cookie) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper', ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};
const user = async (username) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper' }, body: JSON.stringify({ username, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];

async function setup() {
  const tag = Math.random().toString(36).slice(2, 7);
  const names = { own: `own${tag}`, adm: `adm${tag}`, mod: `mod${tag}`, mem: `mem${tag}`, out: `out${tag}` };
  const c = {};
  for (const [k, n] of Object.entries(names)) c[k] = await user(n);
  const id = (await call('POST', '/api/communities', { name: 'Club' }, c.own)).data.id;
  const code = (await call('POST', '/api/community-invite', { community: id }, c.own)).data.code;
  for (const k of ['adm', 'mod', 'mem']) await call('POST', '/api/community-join', { code }, c[k]);
  await call('POST', '/api/community-role', { community: id, username: names.adm, role: 'admin' }, c.own);
  await call('POST', '/api/community-role', { community: id, username: names.mod, role: 'moderator' }, c.own);
  const { channels } = (await call('GET', `/api/community?id=${id}`, null, c.own)).data;
  return { c, names, id, code, general: channels.find((x) => x.name === 'general').id, news: channels.find((x) => x.name === 'announcements').id };
}

test('non-members cannot see a community or its channels', async () => {
  const s = await setup();
  assert.equal((await call('GET', `/api/community?id=${s.id}`, null, s.c.out)).status, 404);
  assert.equal((await call('GET', `/api/channel-messages?channel=${s.general}`, null, s.c.out)).status, 404);
  assert.equal((await call('POST', '/api/channel-messages', { channel: s.general, body: 'hi' }, s.c.out)).status, 404);
});

test('members chat in text channels but only admins post in announcements or create channels', async () => {
  const s = await setup();
  assert.equal((await call('POST', '/api/channel-messages', { channel: s.general, body: 'hello' }, s.c.mem)).status, 201);
  assert.equal((await call('POST', '/api/channel-messages', { channel: s.news, body: 'hi' }, s.c.mem)).status, 403);
  assert.equal((await call('POST', '/api/channel-messages', { channel: s.news, body: 'news' }, s.c.adm)).status, 201);
  assert.equal((await call('POST', '/api/channels', { community: s.id, name: 'x' }, s.c.mod)).status, 403);
  assert.equal((await call('POST', '/api/channels', { community: s.id, name: 'Game Night' }, s.c.adm)).status, 201);
  assert.equal((await call('POST', '/api/channels', { community: s.id, name: 'Game Night' }, s.c.adm)).status, 409);
});

test('private channels are invisible to ordinary members', async () => {
  const s = await setup();
  const { data } = await call('POST', '/api/channels', { community: s.id, name: 'staff', private: true }, s.c.adm);
  const names = async (cookie) => (await call('GET', `/api/community?id=${s.id}`, null, cookie)).data.channels.map((x) => x.name);
  assert.ok(!(await names(s.c.mem)).includes('staff'));
  assert.ok((await names(s.c.mod)).includes('staff'));
  assert.equal((await call('GET', `/api/channel-messages?channel=${data.id}`, null, s.c.mem)).status, 404);
  assert.equal((await call('POST', '/api/channel-messages', { channel: data.id, body: 'x' }, s.c.mem)).status, 404);
});

test('roles cannot be escalated', async () => {
  const s = await setup();
  const { mem, mod, adm } = s.names;
  assert.equal((await call('POST', '/api/community-role', { community: s.id, username: mem, role: 'admin' }, s.c.mem)).status, 403);
  assert.equal((await call('POST', '/api/community-role', { community: s.id, username: mem, role: 'moderator' }, s.c.mod)).status, 403);
  assert.equal((await call('POST', '/api/community-role', { community: s.id, username: mem, role: 'admin' }, s.c.adm)).status, 403);
  assert.equal((await call('POST', '/api/community-role', { community: s.id, username: s.names.own, role: 'member' }, s.c.adm)).status, 403);
  assert.equal((await call('POST', '/api/community-role', { community: s.id, username: adm, role: 'member' }, s.c.mod)).status, 403);
  assert.equal((await call('POST', '/api/community-role', { community: s.id, username: mod, role: 'owner' }, s.c.own)).status, 403);
  assert.equal((await call('POST', '/api/community-role', { community: s.id, username: mem, role: 'moderator' }, s.c.adm)).status, 200);
});

test('kick, ban and timeout respect rank and are logged', async () => {
  const s = await setup();
  assert.equal((await call('POST', '/api/community-kick', { community: s.id, username: s.names.adm }, s.c.mod)).status, 403);
  assert.equal((await call('POST', '/api/community-timeout', { community: s.id, username: s.names.mem, minutes: 10 }, s.c.mod)).status, 200);
  assert.equal((await call('POST', '/api/channel-messages', { channel: s.general, body: 'x' }, s.c.mem)).status, 403);
  await call('POST', '/api/community-timeout', { community: s.id, username: s.names.mem, minutes: 0 }, s.c.mod);
  assert.equal((await call('POST', '/api/channel-messages', { channel: s.general, body: 'x' }, s.c.mem)).status, 201);
  assert.equal((await call('POST', '/api/community-ban', { community: s.id, username: s.names.mem }, s.c.mod)).status, 403);
  assert.equal((await call('POST', '/api/community-ban', { community: s.id, username: s.names.mem, reason: 'spam' }, s.c.adm)).status, 200);
  assert.equal((await call('GET', `/api/channel-messages?channel=${s.general}`, null, s.c.mem)).status, 404);
  assert.equal((await call('POST', '/api/community-join', { code: s.code }, s.c.mem)).status, 403);
  assert.equal((await call('GET', `/api/community-log?id=${s.id}`, null, s.c.mem)).status, 404);
  const log = (await call('GET', `/api/community-log?id=${s.id}`, null, s.c.mod)).data;
  assert.ok(log.some((l) => l.action === 'ban' && l.detail === 'spam'));
});

test('moderators delete others’ messages, members only their own; owners cannot leave', async () => {
  const s = await setup();
  const mine = (await call('POST', '/api/channel-messages', { channel: s.general, body: 'a' }, s.c.mem)).data.id;
  const other = (await call('POST', '/api/channel-messages', { channel: s.general, body: 'b' }, s.c.adm)).data.id;
  assert.equal((await call('POST', '/api/channel-message-delete', { channel: s.general, id: other }, s.c.mem)).status, 403);
  assert.equal((await call('POST', '/api/channel-message-delete', { channel: s.general, id: mine }, s.c.mem)).status, 200);
  assert.equal((await call('POST', '/api/channel-message-delete', { channel: s.general, id: other }, s.c.mod)).status, 200);
  assert.equal((await call('POST', '/api/community-leave', { community: s.id }, s.c.own)).status, 400);
  assert.equal((await call('POST', '/api/community-delete', { community: s.id }, s.c.adm)).status, 403);
  assert.equal((await call('POST', '/api/community-delete', { community: s.id }, s.c.own)).status, 200);
  assert.equal((await call('GET', `/api/community?id=${s.id}`, null, s.c.mem)).status, 404);
});
