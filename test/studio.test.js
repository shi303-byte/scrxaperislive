import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const boot = async (options = {}) => {
  const app = createApp({ dbPath: ':memory:', authLimit: 1000, claimMinAgeMs: 0, ownerUsername: 'boss', ownerPassword: 'a-long-owner-pass', ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper', ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const join = async (name) => (await call('POST', '/api/register', { username: name, password: 'correct horse' })).cookie;
  const boss = (await call('POST', '/api/login', { username: 'boss', password: 'a-long-owner-pass' })).cookie;
  return { call, join, boss };
};

test('appearance preferences are validated, saved and returned with the account', async () => {
  const { call, join } = await boot();
  const c = await join('ada');
  assert.equal((await call('POST', '/api/prefs', { theme: 'neon', density: 'compact' }, c)).status, 400);
  assert.equal((await call('POST', '/api/prefs', { theme: 'dark', density: 'compact', accent: 'url(javascript:1)' }, c)).status, 400);
  await call('POST', '/api/prefs', { theme: 'light', density: 'compact', accent: '#3A4A63', reduceMotion: true }, c);
  const me = (await call('GET', '/api/me', null, c)).data.prefs;
  assert.deepEqual(me, { theme: 'light', accent: '#3A4A63', density: 'compact', reduceMotion: true, plain: false });
});

test('daily Sparks are claimable once a day and only after the account is old enough', async () => {
  const strict = await boot({ claimMinAgeMs: 3600e3 });
  assert.equal((await strict.call('POST', '/api/sparks/daily', {}, await strict.join('newbie'))).status, 403);
  const { call, join } = await boot();
  const c = await join('bea');
  assert.equal((await call('POST', '/api/sparks/daily', {}, c)).data.balance, 10);
  assert.equal((await call('POST', '/api/sparks/daily', {}, c)).status, 409);
  assert.equal((await call('GET', '/api/shop', null, c)).data.balance, 10);
});

test('purchases need funds, cannot double-spend, and equipping needs ownership', async () => {
  const { call, join, boss } = await boot();
  const c = await join('cal');
  assert.equal((await call('POST', '/api/shop/buy', { item: 'name_sky' }, c)).status, 402);
  assert.equal((await call('POST', '/api/owner/sparks', { username: 'cal', amount: 100 }, c)).status, 404);
  assert.equal((await call('POST', '/api/owner/sparks', { username: 'cal', amount: 100 }, boss)).data.balance, 100);
  assert.equal((await call('POST', '/api/owner/sparks', { username: 'cal', amount: -500 }, boss)).status, 400);
  const results = await Promise.all([call('POST', '/api/shop/buy', { item: 'name_sky' }, c), call('POST', '/api/shop/buy', { item: 'name_sky' }, c)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await call('GET', '/api/shop', null, c)).data.balance, 20);
  assert.equal((await call('POST', '/api/shop/equip', { item: 'name_rose' }, c)).status, 403);
  await call('POST', '/api/shop/equip', { item: 'name_sky' }, c);
  assert.equal((await call('GET', '/api/profile', null, c)).data.cosmetics[0].id, 'name_sky');
  await call('POST', '/api/shop/unequip', { kind: 'name_color' }, c);
  assert.equal((await call('GET', '/api/profile', null, c)).data.cosmetics.length, 0);
});

test('badges come from rules, and cosmetic badges never appear as earned or staff badges', async () => {
  const { call, join, boss } = await boot();
  const c = await join('dee');
  await call('POST', '/api/owner/sparks', { username: 'dee', amount: 300 }, boss);
  await call('POST', '/api/shop/buy', { item: 'badge_butterfly' }, c);
  await call('POST', '/api/shop/equip', { item: 'badge_butterfly' }, c);
  const mine = (await call('GET', '/api/profile', null, c)).data;
  assert.deepEqual(mine.badges.map((b) => b.id), ['early']);
  assert.equal(mine.cosmetics[0].kind, 'badge');
  const staff = (await call('GET', '/api/profile?user=boss', null, c)).data;
  assert.ok(staff.badges.some((b) => b.id === 'staff'));
  assert.equal((await call('GET', '/api/profile?user=scrxaper', null, c)).status, 404);
});

test('profile text is length-limited and the display name updates', async () => {
  const { call, join } = await boot();
  const c = await join('eli');
  await call('POST', '/api/profile', { bio: 'x'.repeat(500), status: 'hi', displayName: 'Eli R' }, c);
  const p = (await call('GET', '/api/profile', null, c)).data;
  assert.equal(p.bio.length, 200);
  assert.equal(p.displayName, 'Eli R');
});
