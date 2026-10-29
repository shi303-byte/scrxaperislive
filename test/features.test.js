import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrx-f-'));
const app = createApp({ dbPath: ':memory:', authLimit: 1000, uploadDir: dir });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${app.server.address().port}`;
const H = { 'X-Requested-With': 'scrxaper' };
const call = async (method, url, body, cookie) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...H, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const join = async (name) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: name, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
const attach = async (cookie) => (await (await fetch(`${base}/api/upload?kind=attachment`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: PNG })).json()).id;
const file = (id, cookie) => fetch(`${base}/files/${id}`, { headers: cookie ? { Cookie: cookie } : {} });

test('direct-message images are visible only to the two people in the chat', async () => {
  const [ann, ben, cat] = [await join('anneke'), await join('benedict'), await join('catrin')];
  const id = await attach(ann);
  assert.equal((await file(id, ben)).status, 404);
  assert.equal((await call('POST', '/api/messages', { to: 'benedict', attachment: 'f'.repeat(32) }, ann)).status, 400);
  assert.equal((await call('POST', '/api/messages', { to: 'anneke', attachment: id }, ben)).status, 400);
  assert.equal((await call('POST', '/api/messages', { to: 'benedict', body: '', attachment: id }, ann)).status, 201);
  assert.equal((await file(id, ben)).status, 200);
  assert.equal((await file(id, ann)).status, 200);
  assert.equal((await file(id, cat)).status, 404);
  assert.equal((await file(id)).status, 401);
  assert.equal((await call('GET', '/api/messages?with=anneke', null, ben)).data.messages[0].attachment, id);
  assert.equal((await call('POST', '/api/messages', { to: 'benedict', body: '' }, ann)).status, 400);
});

test('group and channel images follow membership and staff-only rules', async () => {
  const [own, mem, out] = [await join('ottilie'), await join('merrick'), await join('ulrich')];
  const gid = (await call('POST', '/api/groups', { name: 'Pics', members: ['merrick'] }, own)).data.id;
  const g = await attach(own);
  await call('POST', '/api/group-messages', { group: gid, attachment: g }, own);
  assert.equal((await file(g, mem)).status, 200);
  assert.equal((await file(g, out)).status, 404);

  const cid = (await call('POST', '/api/communities', { name: 'Gallery' }, own)).data.id;
  const code = (await call('POST', '/api/community-invite', { community: cid }, own)).data.code;
  await call('POST', '/api/community-join', { code }, mem);
  const staff = (await call('POST', '/api/channels', { community: cid, name: 'staff', private: true }, own)).data.id;
  const general = (await call('GET', `/api/community?id=${cid}`, null, own)).data.channels.find((c) => c.name === 'general').id;
  const s = await attach(own); const p = await attach(own);
  await call('POST', '/api/channel-messages', { channel: staff, attachment: s }, own);
  await call('POST', '/api/channel-messages', { channel: general, attachment: p }, own);
  assert.equal((await file(s, mem)).status, 404);
  assert.equal((await file(p, mem)).status, 200);
  assert.equal((await file(p, out)).status, 404);
});

test('attachments must be real images and uploads are rate limited per kind', async () => {
  const c = await join('rhoda');
  const bad = await fetch(`${base}/api/upload?kind=attachment`, { method: 'POST', headers: { ...H, Cookie: c }, body: Buffer.from('<html>not an image at all, sorry</html>') });
  assert.equal(bad.status, 400);
});

test('sound settings are validated and per-conversation overrides can be set and cleared', async () => {
  const c = await join('sonia');
  assert.equal((await call('POST', '/api/sound', { tone: 'siren', volume: 50 }, c)).status, 400);
  assert.equal((await call('POST', '/api/sound', { tone: 'drop', volume: 150 }, c)).status, 400);
  await call('POST', '/api/sound', { tone: 'drop', volume: 35 }, c);
  await call('POST', '/api/sound/override', { kind: 'dm', target: 'pal', tone: 'none' }, c);
  assert.deepEqual((await call('GET', '/api/me', null, c)).data.sound, { tone: 'drop', volume: 35, overrides: [{ kind: 'dm', target: 'pal', tone: 'none' }] });
  await call('POST', '/api/sound/override', { kind: 'dm', target: 'pal', tone: 'default' }, c);
  assert.equal((await call('GET', '/api/me', null, c)).data.sound.overrides.length, 0);
});

test('custom roles grant only the listed permissions, within the rank rules', async () => {
  const names = ['rowan', 'helga', 'ivor', 'mabel', 'quin'];
  const c = {}; for (const n of names) c[n] = await join(`${n}cr`);
  const cid = (await call('POST', '/api/communities', { name: 'Roles' }, c.rowan)).data.id;
  const code = (await call('POST', '/api/community-invite', { community: cid }, c.rowan)).data.code;
  for (const n of names.slice(1)) await call('POST', '/api/community-join', { code }, c[n]);
  const u = (n) => `${n}cr`;
  await call('POST', '/api/community-role', { community: cid, username: u('quin'), role: 'moderator' }, c.rowan);

  assert.equal((await call('POST', '/api/community-roles', { community: cid, name: 'Helper', perms: ['kick'] }, c.helga)).status, 403);
  assert.equal((await call('POST', '/api/community-roles', { community: cid, name: 'Bad', perms: ['ban'] }, c.rowan)).status, 400);
  assert.equal((await call('POST', '/api/community-roles', { community: cid, name: 'Bad', perms: [] }, c.rowan)).status, 400);
  const role = (await call('POST', '/api/community-roles', { community: cid, name: 'Helper', color: '#c8d6e5', perms: ['kick', 'log'] }, c.rowan)).data.id;
  assert.equal((await call('POST', '/api/community-roles', { community: cid, name: 'Helper', perms: ['kick'] }, c.rowan)).status, 409);
  assert.equal((await call('POST', '/api/community-custom-role', { community: cid, username: u('helga'), role }, c.ivor)).status, 403);
  assert.equal((await call('POST', '/api/community-custom-role', { community: cid, username: u('helga'), role }, c.rowan)).status, 200);

  assert.equal((await call('POST', '/api/community-kick', { community: cid, username: u('quin') }, c.helga)).status, 403);
  assert.equal((await call('POST', '/api/community-timeout', { community: cid, username: u('mabel'), minutes: 5 }, c.helga)).status, 403);
  assert.equal((await call('POST', '/api/community-ban', { community: cid, username: u('mabel') }, c.helga)).status, 403);
  assert.equal((await call('POST', '/api/community-invite', { community: cid }, c.helga)).status, 403);
  assert.equal((await call('POST', '/api/community-role', { community: cid, username: u('mabel'), role: 'moderator' }, c.helga)).status, 403);
  assert.equal((await call('GET', `/api/community-log?id=${cid}`, null, c.helga)).status, 200);
  const view = (await call('GET', `/api/community?id=${cid}`, null, c.helga)).data;
  assert.deepEqual(view.myPerms.sort(), ['kick', 'log']);
  assert.equal(view.members.find((m) => m.username === u('helga')).customRole, 'Helper');
  assert.equal((await call('POST', '/api/community-kick', { community: cid, username: u('mabel') }, c.helga)).status, 200);

  await call('POST', '/api/community-role-delete', { community: cid, role }, c.rowan);
  assert.equal((await call('POST', '/api/community-kick', { community: cid, username: u('ivor') }, c.helga)).status, 403);
});

test('the app is installable: manifest and service worker are served correctly', async () => {
  const m = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  for (const i of manifest.icons) assert.equal((await fetch(base + i.src)).status, 200);
});
