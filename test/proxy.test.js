import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const boot = async (options) => {
  const app = createApp({ dbPath: ':memory:', authLimit: 2, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return (forwarded) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper', ...(forwarded && { 'X-Forwarded-For': forwarded }) },
    body: JSON.stringify({ username: 'nobody', password: 'wrong wrong wrong' }),
  }).then((r) => r.status);
};

test('behind a trusted proxy, visitors are rate limited individually and cannot spoof their address', async () => {
  const login = await boot({ trustProxyHops: 1 });
  assert.deepEqual([await login('spoofed, 10.0.0.1'), await login('other, 10.0.0.1'), await login('x, 10.0.0.1')], [401, 401, 429]);
  assert.equal(await login('spoofed, 10.0.0.2'), 401);
  assert.equal(await login('1.2.3.4, 10.0.0.1'), 429);
});

test('without a trusted proxy the forwarded header is ignored', async () => {
  const login = await boot({ trustProxyHops: 0 });
  assert.deepEqual([await login('a'), await login('b'), await login('c')], [401, 401, 429]);
});
