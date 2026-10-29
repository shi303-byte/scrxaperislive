import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrx-up-'));
const app = createApp({ dbPath: ':memory:', authLimit: 1000, uploadDir: dir });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${app.server.address().port}`;
const H = { 'X-Requested-With': 'scrxaper' };

const call = async (method, url, body, cookie) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...H, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const upload = async (kind, bytes, cookie) => {
  const res = await fetch(`${base}/api/upload?kind=${kind}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: bytes });
  return { status: res.status, data: await res.json() };
};
const join = async (name) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: name, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
const withWidth = (w) => { const b = Buffer.from(PNG); b.writeUInt32BE(w, 16); return b; };

test('real images upload, and only signed-in users can fetch them', async () => {
  const c = await join('uma');
  const up = await upload('avatar', PNG, c);
  assert.equal(up.status, 201);
  const profile = (await call('GET', '/api/profile', null, c)).data;
  assert.equal(profile.avatar, up.data.id);
  const file = await fetch(`${base}/files/${up.data.id}`, { headers: { Cookie: c } });
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/files/${up.data.id}`)).status, 401);
  assert.equal((await upload('banner', GIF, c)).status, 201);
});

test('anything that is not a real image of sane size is rejected', async () => {
  const c = await join('vic');
  assert.equal((await upload('avatar', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), c)).status, 400);
  assert.equal((await upload('avatar', Buffer.from('hello world, definitely not an image at all'), c)).status, 400);
  assert.equal((await upload('avatar', withWidth(5000), c)).status, 400);
  assert.equal((await upload('avatar', Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), c)).status, 413);
  assert.equal((await upload('logo', PNG, c)).status, 400);
});

test('replacing or removing an image deletes the old file', async () => {
  const c = await join('wes');
  const first = (await upload('avatar', PNG, c)).data.id;
  const second = (await upload('avatar', GIF, c)).data.id;
  assert.ok(!fs.existsSync(path.join(dir, first)));
  assert.ok(fs.existsSync(path.join(dir, second)));
  await call('POST', '/api/upload/delete', { kind: 'avatar' }, c);
  assert.ok(!fs.existsSync(path.join(dir, second)));
  assert.equal((await call('GET', '/api/profile', null, c)).data.avatar, null);
});

test('file URLs cannot escape the upload folder', async () => {
  const c = await join('xia');
  for (const p of ['/files/..%2Fserver.js', '/files/../server.js', '/files/not-an-id']) assert.equal((await fetch(base + p, { headers: { Cookie: c } })).status, 404);
});

test('deleting an account needs the password and removes its data and files', async () => {
  const [a, b] = [await join('yan'), await join('zoe')];
  await call('POST', '/api/messages', { to: 'zoe', body: 'hello' }, a);
  const gid = (await call('POST', '/api/groups', { name: 'Duo', members: ['zoe'] }, a)).data.id;
  const file = (await upload('avatar', PNG, a)).data.id;
  assert.equal((await call('POST', '/api/account/delete', { password: 'wrong' }, a)).status, 403);
  await call('POST', '/api/communities', { name: 'Mine' }, a);
  assert.equal((await call('POST', '/api/account/delete', { password: 'correct horse' }, a)).status, 409);
  const mine = (await call('GET', '/api/communities', null, a)).data[0].id;
  await call('POST', '/api/community-delete', { community: mine }, a);
  assert.equal((await call('POST', '/api/account/delete', { password: 'correct horse' }, a)).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, file)));
  assert.equal((await call('GET', '/api/me', null, a)).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'yan', password: 'correct horse' })).status, 401);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, b)).data.role, 'admin');
  assert.equal((await call('GET', '/api/conversations', null, b)).data.length, 0);
});
