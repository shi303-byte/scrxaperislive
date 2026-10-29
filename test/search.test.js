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
const join = async (name) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper' }, body: JSON.stringify({ username: name, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
const find = (cookie, q) => call('GET', `/api/search?q=${encodeURIComponent(q)}`, null, cookie);

test('search only returns messages from conversations the searcher is part of', async () => {
  const [al, bo, cy] = [await join('alma'), await join('bosco'), await join('cyril')];
  await call('POST', '/api/messages', { to: 'bosco', body: 'the pineapple plan' }, al);
  await call('POST', '/api/messages', { to: 'cyril', body: 'pineapple secrets' }, bo);
  assert.equal((await find(al, 'pineapple')).data.messages.length, 1);
  assert.equal((await find(cy, 'plan')).data.messages.length, 0);
  assert.equal((await find(cy, 'pineapple')).data.messages.length, 1);
  assert.equal((await find(al, 'x')).status, 400);
  assert.deepEqual((await find(al, 'bosc')).data.people.map((p) => p.username), ['bosco']);
});

test('group and community search respects membership and staff-only channels', async () => {
  const [own, mem, out] = [await join('owena'), await join('memphis'), await join('outi')];
  const gid = (await call('POST', '/api/groups', { name: 'Walkers', members: ['memphis'] }, own)).data.id;
  await call('POST', '/api/group-messages', { group: gid, body: 'kayak trip friday' }, own);
  assert.equal((await find(mem, 'kayak')).data.messages.length, 1);
  assert.equal((await find(out, 'kayak')).data.messages.length, 0);
  assert.equal((await find(out, 'walkers')).data.groups.length, 0);

  const cid = (await call('POST', '/api/communities', { name: 'Harbour' }, own)).data.id;
  const code = (await call('POST', '/api/community-invite', { community: cid }, own)).data.code;
  await call('POST', '/api/community-join', { code }, mem);
  const staff = (await call('POST', '/api/channels', { community: cid, name: 'staffroom', private: true }, own)).data.id;
  await call('POST', '/api/channel-messages', { channel: staff, body: 'budget for lanterns' }, own);
  const general = (await call('GET', `/api/community?id=${cid}`, null, own)).data.channels.find((c) => c.name === 'general').id;
  await call('POST', '/api/channel-messages', { channel: general, body: 'lanterns on saturday' }, own);
  assert.equal((await find(mem, 'lanterns')).data.messages.length, 1);
  assert.equal((await find(own, 'lanterns')).data.messages.length, 2);
  assert.equal((await find(mem, 'staffroom')).data.channels.length, 0);
  assert.equal((await find(own, 'staffroom')).data.channels.length, 1);
  assert.equal((await find(out, 'lanterns')).data.messages.length, 0);
});

test('wildcard characters in a query are treated literally', async () => {
  const [a, b] = [await join('wilma'), await join('wendell')];
  await call('POST', '/api/messages', { to: 'wendell', body: 'plain words only' }, a);
  assert.equal((await find(a, '%%')).data.messages.length, 0);
  assert.equal((await find(b, '__')).data.people.length, 0);
});

test('"who can message me" is enforced, with exceptions for replies and shared groups', async () => {
  const [pat, quin, rae] = [await join('patrice'), await join('quinn'), await join('raelyn')];
  assert.equal((await call('POST', '/api/privacy', { whoCanMessage: 'anyone' }, pat)).status, 400);
  await call('POST', '/api/privacy', { whoCanMessage: 'nobody', previews: false, dnd: true }, pat);
  assert.equal((await call('POST', '/api/messages', { to: 'patrice', body: 'hi' }, quin)).status, 403);
  assert.equal((await call('POST', '/api/messages', { to: 'quinn', body: 'hello first' }, pat)).status, 201);
  assert.equal((await call('POST', '/api/messages', { to: 'patrice', body: 'reply' }, quin)).status, 201);
  await call('POST', '/api/privacy', { whoCanMessage: 'groups', previews: true, dnd: false }, pat);
  assert.equal((await call('POST', '/api/messages', { to: 'patrice', body: 'stranger' }, rae)).status, 403);
  await call('POST', '/api/groups', { name: 'Shared', members: ['patrice'] }, rae);
  assert.equal((await call('POST', '/api/messages', { to: 'patrice', body: 'now we share a group' }, rae)).status, 201);
});

test('mutes and notification settings are saved and returned with the account', async () => {
  const c = await join('mina');
  await call('POST', '/api/mute', { kind: 'dm', target: 'someone', muted: true }, c);
  await call('POST', '/api/mute', { kind: 'channel', target: '3', muted: true }, c);
  await call('POST', '/api/mute', { kind: 'dm', target: 'someone', muted: false }, c);
  assert.equal((await call('POST', '/api/mute', { kind: 'bogus', target: 'x', muted: true }, c)).status, 400);
  const me = (await call('GET', '/api/me', null, c)).data;
  assert.deepEqual(me.mutes, [{ kind: 'channel', target: '3' }]);
  assert.deepEqual(me.privacy, { whoCanMessage: 'everyone', previews: true, dnd: false });
});
