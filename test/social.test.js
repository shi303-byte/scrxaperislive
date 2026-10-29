import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrx-s-'));
const H = { 'X-Requested-With': 'scrxaper' };

const boot = async (options = {}) => {
  const app = createApp({ dbPath: ':memory:', authLimit: 1000, uploadDir: dir, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...H, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const join = async (n) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: n, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
  const upload = async (qs, cookie) => { const r = await fetch(`${base}/api/upload?${qs}`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: PNG }); return { status: r.status, data: await r.json() }; };
  const stream = async (cookie) => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: ctrl.signal });
    const events = [];
    (async () => {
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString();
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
            const raw = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /event: (.+)/.exec(raw)?.[1]; const data = /data: (.+)/.exec(raw)?.[1];
            if (ev) events.push({ ev, data: JSON.parse(data) });
          }
        }
      } catch { /* closed */ }
    })();
    after(() => ctrl.abort());
    const wait = async (pred) => { for (let i = 0; i < 60; i++) { const f = events.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 25)); } throw new Error('event not received'); };
    return { events, wait };
  };
  return { call, join, upload, stream, app };
};
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('only public communities and groups appear in discovery, and joining respects bans', async () => {
  const { call, join } = await boot();
  const [own, vis, bad] = [await join('dora'), await join('vince'), await join('bram')];
  const cid = (await call('POST', '/api/communities', { name: 'Chess Club' }, own)).data.id;
  const gid = (await call('POST', '/api/groups', { name: 'Chess Chat' }, own)).data.id;
  assert.equal((await call('GET', '/api/discover?q=chess', null, vis)).data.communities.length, 0);
  assert.equal((await call('POST', '/api/discover/join', { kind: 'community', id: cid }, vis)).status, 404);
  assert.equal((await call('POST', '/api/community-settings', { community: cid, public: true }, vis)).status, 404);
  await call('POST', '/api/community-settings', { community: cid, description: 'Openings and endgames', public: true }, own);
  await call('POST', '/api/group-settings', { group: gid, description: 'Talk chess', public: true }, own);
  const found = (await call('GET', '/api/discover?q=chess', null, vis)).data;
  assert.equal(found.communities[0].members, 1);
  assert.equal(found.groups.length, 1);
  assert.equal((await call('GET', '/api/discover?q=openings', null, vis)).data.communities.length, 1);
  assert.equal((await call('GET', '/api/discover?q=%25', null, vis)).data.communities.length, 0);
  assert.equal((await call('POST', '/api/discover/join', { kind: 'community', id: cid }, vis)).status, 200);
  assert.equal((await call('POST', '/api/discover/join', { kind: 'group', id: gid }, vis)).status, 200);
  assert.equal((await call('GET', '/api/discover?q=chess', null, vis)).data.communities[0].joined, true);
  await call('POST', '/api/discover/join', { kind: 'community', id: cid }, bad);
  await call('POST', '/api/community-ban', { community: cid, username: 'bram' }, own);
  assert.equal((await call('POST', '/api/discover/join', { kind: 'community', id: cid }, bad)).status, 403);
});

test('communities and groups get icons set by admins, and profile pictures show up beside people', async () => {
  const { call, join, upload } = await boot();
  const [own, mem] = [await join('iris'), await join('jonas')];
  const cid = (await call('POST', '/api/communities', { name: 'Art' }, own)).data.id;
  const gid = (await call('POST', '/api/groups', { name: 'Doodles', members: ['jonas'] }, own)).data.id;
  const code = (await call('POST', '/api/community-invite', { community: cid }, own)).data.code;
  await call('POST', '/api/community-join', { code }, mem);
  assert.equal((await upload(`kind=community-icon&id=${cid}`, mem)).status, 403);
  assert.equal((await upload(`kind=group-icon&id=${gid}`, mem)).status, 403);
  const icon = (await upload(`kind=community-icon&id=${cid}`, own)).data.id;
  await upload(`kind=group-icon&id=${gid}`, own);
  assert.equal((await call('GET', '/api/communities', null, mem)).data[0].icon, icon);
  assert.ok((await call('GET', '/api/groups', null, mem)).data[0].icon);
  const pic = (await upload('kind=avatar', own)).data.id;
  await call('POST', '/api/group-messages', { group: gid, body: 'hi' }, own);
  await call('POST', '/api/messages', { to: 'jonas', body: 'hello' }, own);
  const channel = (await call('GET', `/api/community?id=${cid}`, null, own)).data.channels[0].id;
  await call('POST', '/api/channel-messages', { channel, body: 'yo' }, own);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, mem)).data.messages[0].avatar, pic);
  assert.equal((await call('GET', `/api/channel-messages?channel=${channel}`, null, mem)).data.messages[0].avatar, pic);
  assert.equal((await call('GET', '/api/conversations', null, mem)).data[0].avatar, pic);
  assert.equal((await call('GET', `/api/community?id=${cid}`, null, mem)).data.members.find((m) => m.username === 'iris').avatar, pic);
});

test('ignoring someone hides their group and channel messages from you only', async () => {
  const { call, join, stream } = await boot();
  const [me, noisy, other] = [await join('kira'), await join('loud'), await join('mara')];
  const gid = (await call('POST', '/api/groups', { name: 'Chat', members: ['loud', 'mara'] }, me)).data.id;
  await call('POST', '/api/group-messages', { group: gid, body: 'before' }, noisy);
  assert.equal((await call('POST', '/api/ignore', { username: 'kira', ignored: true }, me)).status, 400);
  await call('POST', '/api/ignore', { username: 'loud', ignored: true }, me);
  assert.deepEqual((await call('GET', '/api/me', null, me)).data.ignored, ['loud']);
  const mine = await stream(me); const hers = await stream(other);
  await new Promise((r) => setTimeout(r, 60));
  await call('POST', '/api/group-messages', { group: gid, body: 'after' }, noisy);
  await hers.wait((e) => e.ev === 'message' && e.data.body === 'after');
  assert.ok(!mine.events.some((e) => e.data.body === 'after'));
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, me)).data.messages.length, 0);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, other)).data.messages.length, 2);
  await call('POST', '/api/ignore', { username: 'loud', ignored: false }, me);
  assert.equal((await call('GET', `/api/group-messages?group=${gid}`, null, me)).data.messages.length, 2);
});

test('calls ring, relay signals only to the other person, record the outcome, and enforce rules', async () => {
  const { call, join, stream } = await boot();
  const [a, b, c] = [await join('nell'), await join('omar'), await join('pia')];
  const sa = await stream(a); const sb = await stream(b);
  await new Promise((r) => setTimeout(r, 60));
  const id = (await call('POST', '/api/call/start', { to: 'omar', video: true }, a)).data.id;
  const incoming = await sb.wait((e) => e.ev === 'call' && e.data.type === 'incoming');
  assert.equal(incoming.data.from, 'nell'); assert.equal(incoming.data.video, true);
  assert.equal((await call('POST', '/api/call/start', { to: 'pia' }, a)).status, 409);
  assert.equal((await call('POST', '/api/call/start', { to: 'nell' }, c)).status, 409);
  assert.equal((await call('POST', '/api/call/answer', { call: id }, a)).status, 409);
  assert.equal((await call('POST', '/api/call/signal', { call: id, data: { x: 1 } }, c)).status, 404);
  assert.equal((await call('POST', '/api/call/answer', { call: id }, b)).status, 200);
  await sa.wait((e) => e.ev === 'call' && e.data.type === 'answered');
  await call('POST', '/api/call/signal', { call: id, data: { sdp: 'offer' } }, a);
  assert.deepEqual((await sb.wait((e) => e.data.type === 'signal')).data.data, { sdp: 'offer' });
  assert.ok(!sa.events.some((e) => e.data.type === 'signal'));
  await call('POST', '/api/call/end', { call: id }, b);
  await sa.wait((e) => e.ev === 'call' && e.data.type === 'ended');
  const last = (await call('GET', '/api/messages?with=omar', null, a)).data.messages.at(-1);
  assert.equal(last.kind, 'call'); assert.match(last.body, /^Call ended · 0:0/);
  assert.equal((await call('POST', '/api/call/signal', { call: id, data: {} }, a)).status, 409);
});

test('declined, cancelled and unanswered calls are recorded; blocked people cannot call', async () => {
  const { call, join } = await boot({ callRingMs: 60 });
  const [a, b] = [await join('quill'), await join('rhea')];
  const msgs = async () => (await call('GET', '/api/messages?with=rhea', null, a)).data.messages.map((m) => m.body);
  const first = (await call('POST', '/api/call/start', { to: 'rhea' }, a)).data.id;
  await call('POST', '/api/call/decline', { call: first }, b);
  const second = (await call('POST', '/api/call/start', { to: 'rhea' }, a)).data.id;
  await call('POST', '/api/call/end', { call: second }, a);
  await call('POST', '/api/call/start', { to: 'rhea' }, a);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await msgs(), ['Call declined', 'Call cancelled', 'Missed call']);
  await call('POST', '/api/block', { username: 'quill', blocked: true }, b);
  assert.equal((await call('POST', '/api/call/start', { to: 'rhea' }, a)).status, 403);
  assert.equal((await call('POST', '/api/call/start', { to: 'scrxaper' }, a)).status, 403);
  assert.ok((await call('GET', '/api/ice', null, a)).data.iceServers.length >= 1);
});
