import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const SESSION_DAYS = 30;
const USERNAME = /^[a-z0-9_]{3,24}$/;
const RESERVED = new Set(['scrxaper', 'teams', 'admin', 'system', 'owner', 'support', 'staff']);
const TEAMS = 'scrxaper';
const isPrivateAddress = (ip) => /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd]|fe80|::ffff:)/i.test(ip);

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages (sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient_id, id);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members (user_id);
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS group_messages_group ON group_messages (group_id, id);
CREATE TABLE IF NOT EXISTS group_invites (
  token_hash TEXT PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);`;

const sniffImage = (b) => {
  if (b.length < 30) return null;
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { mime: 'image/jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') return { mime: 'image/webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') return { mime: 'image/webp', w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (chunk === 'VP8X') return { mime: 'image/webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  return null;
};

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  const given = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(given, Buffer.from(hash, 'hex'));
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({
  dbPath = process.env.DB_PATH || './data/scrxaper.db',
  production = process.env.NODE_ENV === 'production',
  ownerUsername = process.env.OWNER_USERNAME,
  ownerPassword = process.env.OWNER_PASSWORD,
  allowPrivateWebhooks = process.env.ALLOW_PRIVATE_WEBHOOKS === '1',
  authLimit = 10,
  trustProxyHops = Number(process.env.TRUST_PROXY_HOPS) || 0,
  callRingMs = 40000,
  claimMinAgeMs = 3600e3,
  currency = process.env.CURRENCY_NAME || 'Sparks',
  aiKeySecret = process.env.AI_KEY_SECRET,
  uploadDir = process.env.UPLOAD_DIR || './data/uploads',
  groqBase = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
} = {}) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(schema);
  for (const [table, col, def] of [
    ['users', 'is_owner', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'is_system', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'birthday', 'TEXT'], ['users', 'birthday_year', 'INTEGER'],
    ['users', 'banned_at', 'INTEGER'], ['users', 'banned_reason', 'TEXT'], ['messages', 'kind', "TEXT NOT NULL DEFAULT 'text'"],
  ]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, webhook_url TEXT, webhook_secret TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS communities (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
      timeout_until INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS community_members_user ON community_members (user_id);
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'announcement')),
      topic TEXT NOT NULL DEFAULT '', read_only INTEGER NOT NULL DEFAULT 0, private INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0, UNIQUE (community_id, name)
    );
    CREATE TABLE IF NOT EXISTS channel_messages (
      id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_messages_channel ON channel_messages (channel_id, id);
    CREATE TABLE IF NOT EXISTS community_invites (
      token_hash TEXT PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_bans (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS mod_log (
      id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, bio TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT 'dark', accent TEXT, density TEXT NOT NULL DEFAULT 'comfortable', reduce_motion INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('frame', 'name_color', 'badge')), name TEXT NOT NULL,
      description TEXT NOT NULL, price INTEGER NOT NULL CHECK (price >= 0), value TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS inventory (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL REFERENCES items(id),
      acquired_at INTEGER NOT NULL, PRIMARY KEY (user_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS equipped (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES items(id),
      PRIMARY KEY (user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS sparks_ledger (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, delta INTEGER NOT NULL,
      reason TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (user_id, ref)
    );
    CREATE TABLE IF NOT EXISTS badges (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, badge_id TEXT NOT NULL REFERENCES badges(id),
      at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (user_id, badge_id)
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, key_enc TEXT,
      model TEXT NOT NULL DEFAULT 'openai/gpt-oss-120b', personality TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_conversations_user ON ai_conversations (user_id, updated_at);
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages (conversation_id, id);
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mutes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, target TEXT NOT NULL,
      PRIMARY KEY (user_id, kind, target)
    );
    CREATE TABLE IF NOT EXISTS community_roles (
      id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT, perms TEXT NOT NULL, UNIQUE (community_id, name)
    );
    CREATE TABLE IF NOT EXISTS tones (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, target TEXT NOT NULL, tone TEXT NOT NULL,
      PRIMARY KEY (user_id, kind, target)
    );
    CREATE TABLE IF NOT EXISTS ignores (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, ignored_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, ignored_id)
    );
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY, caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, callee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'ringing', video INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL
    );`);
  for (const table of ['messages', 'group_messages', 'channel_messages']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'attachment_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN attachment_id TEXT`);
  }
  if (!db.prepare('PRAGMA table_info(community_members)').all().some((c) => c.name === 'custom_role_id'))
    db.exec('ALTER TABLE community_members ADD COLUMN custom_role_id INTEGER REFERENCES community_roles(id) ON DELETE SET NULL');
  for (const [table, col, def] of [['communities', 'icon_id', 'TEXT'], ['communities', 'public', 'INTEGER NOT NULL DEFAULT 0'], ['groups', 'icon_id', 'TEXT'],
    ['groups', 'public', 'INTEGER NOT NULL DEFAULT 0'], ['groups', 'description', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  db.prepare("UPDATE calls SET state = 'ended', reason = 'server-restart', ended_at = ? WHERE state != 'ended'").run(Date.now());
  for (const [col, def] of [['avatar_id', 'TEXT'], ['banner_id', 'TEXT'], ['who_can_message', "TEXT NOT NULL DEFAULT 'everyone'"], ['previews', 'INTEGER NOT NULL DEFAULT 1'], ['dnd', 'INTEGER NOT NULL DEFAULT 0'], ['tone', "TEXT NOT NULL DEFAULT 'chime'"], ['volume', 'INTEGER NOT NULL DEFAULT 60'], ['plain', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare('PRAGMA table_info(profiles)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE profiles ADD COLUMN ${col} ${def}`);
  }
  mkdirSync(uploadDir, { recursive: true });
  const storeFile = (id, buf) => writeFileSync(path.join(uploadDir, id), buf);
  const removeFile = (id) => { if (id) { rmSync(path.join(uploadDir, id), { force: true }); db.prepare('DELETE FROM uploads WHERE id = ?').run(id); } };
  const seedItem = db.prepare('INSERT OR IGNORE INTO items (id, kind, name, description, price, value) VALUES (?, ?, ?, ?, ?, ?)');
  [['frame_ring', 'frame', 'Quiet ring', 'A thin ring around your avatar.', 60, 'ring'],
    ['frame_aurora', 'frame', 'Aurora halo', 'A soft glow in your accent colour.', 150, 'aurora'],
    ['name_sky', 'name_color', 'Sky name', 'Your name in pale sky blue.', 80, '#b7c9e6'],
    ['name_rose', 'name_color', 'Rose name', 'Your name in muted rose.', 80, '#e3a7bd'],
    ['badge_butterfly', 'badge', 'Butterfly', 'A cosmetic butterfly badge. Not an official badge.', 200, 'Butterfly']].forEach((i) => seedItem.run(...i));
  const seedBadge = db.prepare('INSERT OR IGNORE INTO badges (id, name, description) VALUES (?, ?, ?)');
  seedBadge.run('early', 'Early member', 'One of the first 100 people to join Scrxaper.');
  seedBadge.run('staff', 'Scrxaper staff', 'Runs this Scrxaper instance.');
  db.prepare("INSERT OR IGNORE INTO users (username, display_name, password_hash, created_at, is_system) VALUES (?, 'Scrxaper Teams', '!', ?, 1)").run(TEAMS, Date.now());
  const teamsId = db.prepare('SELECT id FROM users WHERE username = ?').get(TEAMS).id;

  if (ownerUsername || ownerPassword) {
    const name = String(ownerUsername ?? '').toLowerCase();
    if (!USERNAME.test(name) || String(ownerPassword ?? '').length < 12) throw new Error('OWNER_USERNAME must be a valid username and OWNER_PASSWORD at least 12 characters');
    db.prepare('UPDATE users SET is_owner = 0 WHERE username != ?').run(name);
    const hash = hashPassword(ownerPassword);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) db.prepare('UPDATE users SET is_owner = 1, password_hash = ? WHERE username = ?').run(hash, name);
    else db.prepare('INSERT INTO users (username, display_name, password_hash, created_at, is_owner) VALUES (?, ?, ?, ?, 1)').run(name, name, hash, Date.now());
    db.prepare("INSERT OR IGNORE INTO user_badges (user_id, badge_id, at, source) SELECT id, 'staff', ?, 'owner-config' FROM users WHERE username = ?").run(Date.now(), name);
  }
  db.prepare("DELETE FROM user_badges WHERE badge_id = 'staff' AND user_id NOT IN (SELECT id FROM users WHERE is_owner = 1)").run();

  const streams = new Map();
  const attempts = new Map();

  const push = (userId, event, data) => {
    for (const res of streams.get(userId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const clientIp = (req) => {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return (trustProxyHops && forwarded[forwarded.length - trustProxyHops]) || req.socket.remoteAddress;
  };
  const limited = (key, max = 10, windowMs = 15 * 60 * 1000) => {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.reset < now) { attempts.set(key, { count: 1, reset: now + windowMs }); return false; }
    return ++entry.count > max;
  };

  const sendJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
  });

  const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
  const sessionCookie = (value, maxAge) =>
    `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${production ? '; Secure' : ''}`;

  const currentUser = (req) => {
    const auth = req.headers.authorization;
    if (auth) {
      return auth.startsWith('Bot ') ? db.prepare(`SELECT u.id, u.username, u.display_name, 0 AS is_owner, 1 AS is_bot, NULL AS birthday
        FROM bots b JOIN users u ON u.id = b.user_id WHERE b.token_hash = ?`).get(sha(auth.slice(4))) ?? null : null;
    }
    const token = cookie(req, 'sid');
    if (!token) return null;
    return db.prepare(`SELECT u.id, u.username, u.display_name, u.is_owner, u.is_bot, u.birthday FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned_at IS NULL`).get(sha(token), Date.now()) ?? null;
  };

  const startSession = (res, userId, body) => {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
    sendJson(res, 200, body, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  };

  const findPeer = (me, username) => {
    const peer = db.prepare('SELECT id, username, display_name, is_system, is_bot FROM users WHERE username = ?').get(String(username ?? '').toLowerCase());
    if (!peer || peer.id === me.id) throw new HttpError(404, 'No such user');
    return peer;
  };
  const isBlocked = (a, b) => !!db.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a);

  const roleIn = (gid, uid) => db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(gid, uid)?.role;
  const needMember = (me, gid) => {
    const role = roleIn(Number(gid), me.id);
    if (!role) throw new HttpError(404, 'No such group');
    return role;
  };
  const needAdmin = (me, gid) => {
    if (needMember(me, gid) !== 'admin') throw new HttpError(403, 'Only group admins can do that.');
  };
  const pushGroup = (gid, event, data) => {
    for (const { user_id } of db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid)) if (!(event === 'message' && ignoredBy(user_id, data.from))) push(user_id, event, data);
  };
  const userNamed = (name) => {
    const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String(name ?? '').toLowerCase());
    if (!u) throw new HttpError(404, `No user called ${name}`);
    return u;
  };
  const MAX_GROUP = 100;
  const addMember = (gid, uid, role = 'member') => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(gid).n;
    if (count >= MAX_GROUP) throw new HttpError(409, 'This group is full.');
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(gid, uid, role, Date.now());
  };

  const notify = (userId, body, kind = 'text') => {
    const at = Date.now();
    const id = Number(db.prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?)').run(teamsId, userId, body, at, kind).lastInsertRowid);
    push(userId, 'message', { id, from: TEAMS, body, at, kind });
  };
  const audit = (actor, action, target, detail) =>
    db.prepare('INSERT INTO audit (actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?)').run(actor.id, action, target ?? null, detail ?? null, Date.now());

  const runBirthdays = (now = new Date()) => {
    const md = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const year = now.getUTCFullYear();
    const due = db.prepare('SELECT id, display_name FROM users WHERE birthday = ? AND (birthday_year IS NULL OR birthday_year < ?) AND banned_at IS NULL AND is_bot = 0').all(md, year);
    for (const u of due) {
      db.prepare('UPDATE users SET birthday_year = ? WHERE id = ?').run(year, u.id);
      notify(u.id, `Happy birthday, ${u.display_name}.`, 'card');
      notify(u.id, 'Everyone at Scrxaper Teams hopes you have a great day. Thanks for being here.');
    }
    return due.length;
  };
  runBirthdays();
  const birthdayTimer = setInterval(() => runBirthdays(), 3600e3);
  birthdayTimer.unref();

  const safeLookup = (host, opts, cb) => dns.lookup(host, opts, (err, addr, fam) => {
    if (err) return cb(err);
    const list = Array.isArray(addr) ? addr : [{ address: addr }];
    if (!allowPrivateWebhooks && list.some((a) => isPrivateAddress(a.address))) return cb(new Error('webhook address not allowed'));
    cb(null, addr, fam);
  });
  const deliver = (botId, event) => {
    const bot = db.prepare('SELECT webhook_url, webhook_secret FROM bots WHERE user_id = ?').get(botId);
    if (!bot?.webhook_url) return;
    const body = JSON.stringify(event);
    const url = new URL(bot.webhook_url);
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', timeout: 5000, lookup: safeLookup,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'X-Scrxaper-Signature': `sha256=${crypto.createHmac('sha256', bot.webhook_secret).update(body).digest('hex')}` },
    }, (r) => r.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', (err) => console.error(JSON.stringify({ level: 'warn', message: 'bot webhook failed', bot: botId, error: err.code ?? err.message })));
    req.end(body);
  };
  const ownedBot = (me, username) => {
    const bot = db.prepare('SELECT u.id FROM bots b JOIN users u ON u.id = b.user_id WHERE u.username = ? AND b.owner_id = ?').get(String(username ?? '').toLowerCase(), me.id);
    if (!bot || me.is_bot) throw new HttpError(404, 'No such bot');
    return bot;
  };
  const needOwner = (me) => { if (!me.is_owner) throw new HttpError(404, 'Not found'); };
  const countOf = (sql, ...args) => db.prepare(sql).get(...args).n;

  const RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  const ALL_PERMS = ['channels', 'invites', 'kick', 'timeout', 'delete_messages', 'log'];
  const BASE_PERMS = { member: [], moderator: ['kick', 'timeout', 'delete_messages', 'log'], admin: [...ALL_PERMS, 'ban', 'roles'], owner: [...ALL_PERMS, 'ban', 'roles'] };
  const loadMember = (cid, uid) => {
    const m = db.prepare(`SELECT cm.role, cm.timeout_until AS timeoutUntil, r.perms FROM community_members cm
      LEFT JOIN community_roles r ON r.id = cm.custom_role_id WHERE cm.community_id = ? AND cm.user_id = ?`).get(Number(cid), uid);
    return m && { ...m, perms: m.perms ? JSON.parse(m.perms) : [] };
  };
  const rankOf = (m) => Math.max(RANK[m.role], m.perms.length ? 1 : 0);
  const permsOf = (m) => [...new Set([...BASE_PERMS[m.role], ...m.perms])];
  const can = (m, perm) => permsOf(m).includes(perm);
  const needPerm = (m, perm) => { if (!can(m, perm)) throw new HttpError(403, 'You do not have permission to do that.'); };
  const needCMember = (me, cid) => {
    const m = loadMember(cid, me.id);
    if (!m) throw new HttpError(404, 'No such community');
    return m;
  };
  const needRole = (m, min) => {
    if (RANK[m.role] < RANK[min]) throw new HttpError(403, `Only ${min}s and above can do that.`);
  };
  const channelAccess = (me, channelId) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(channelId));
    if (!ch) throw new HttpError(404, 'No such channel');
    const m = needCMember(me, ch.community_id);
    if (ch.private && RANK[m.role] < 1) throw new HttpError(404, 'No such channel');
    return { ch, m };
  };
  const canPost = (ch, m) => !(ch.read_only || ch.kind === 'announcement') || RANK[m.role] >= RANK.admin;
  const pushChannel = (ch, event, data) => {
    for (const r of db.prepare('SELECT user_id, role FROM community_members WHERE community_id = ?').all(ch.community_id))
      if ((!ch.private || RANK[r.role] >= 1) && !(event === 'channel-message' && ignoredBy(r.user_id, data.from))) push(r.user_id, event, data);
  };
  const pushCommunity = (cid, extra = []) => {
    for (const { user_id } of db.prepare('SELECT user_id FROM community_members WHERE community_id = ?').all(cid)) push(user_id, 'community', { id: cid });
    extra.forEach((uid) => push(uid, 'community', { id: cid }));
  };
  const logMod = (cid, actor, action, target, detail) =>
    db.prepare('INSERT INTO mod_log (community_id, actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(cid, actor.id, action, target ?? null, detail ?? null, Date.now());
  const lowerRanked = (me, m, cid, username) => {
    const user = userNamed(username);
    const target = loadMember(cid, user.id);
    if (!target) throw new HttpError(404, 'That person is not in this community.');
    if (user.id === me.id) throw new HttpError(400, 'You cannot do that to yourself.');
    if (rankOf(target) >= rankOf(m)) throw new HttpError(403, 'You cannot act on someone of equal or higher rank.');
    return user;
  };
  const joinCommunity = (cid, uid) => db.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(cid, uid, 'member', Date.now());
  const reasonOf = (v) => String(v ?? '').trim().slice(0, 200);

  const aesKey = aiKeySecret && aiKeySecret.length >= 32 ? crypto.scryptSync(aiKeySecret, 'scrxaper-ai-v1', 32) : null;
  const encryptKey = (plain) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  };
  const decryptKey = (stored) => {
    try {
      const raw = Buffer.from(stored, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch { throw new HttpError(400, 'Your stored key can no longer be read. Please enter it again.'); }
  };
  const needHuman = (me) => { if (me.is_bot) throw new HttpError(403, 'Not available to bots.'); };
  const userAi = (me) => {
    needHuman(me);
    const row = db.prepare('SELECT key_enc, model, personality FROM ai_settings WHERE user_id = ?').get(me.id);
    if (!row?.key_enc || !aesKey) throw new HttpError(400, 'Add your Groq API key first.');
    return { key: decryptKey(row.key_enc), model: row.model, personality: row.personality };
  };
  const groq = async (key, route, body) => {
    let res;
    try {
      res = await fetch(`${groqBase}${route}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    } catch { throw new HttpError(502, 'Could not reach the AI provider.'); }
    if (res.status === 401) throw new HttpError(400, 'Groq rejected that API key.');
    if (res.status === 404) throw new HttpError(400, 'That model is not available.');
    if (res.status === 429) throw new HttpError(429, 'Groq rate limit or quota reached. Try again later.');
    if (!res.ok) throw new HttpError(502, 'The AI provider had a problem. Try again.');
    return res.json();
  };
  const ownConversation = (me, id) => {
    const conv = db.prepare('SELECT id, title FROM ai_conversations WHERE id = ? AND user_id = ?').get(Number(id), me.id);
    if (!conv) throw new HttpError(404, 'No such conversation');
    return conv;
  };
  const privacyOf = (uid) => {
    prefsOf(uid);
    const p = db.prepare('SELECT who_can_message AS whoCanMessage, previews, dnd FROM profiles WHERE user_id = ?').get(uid);
    return { whoCanMessage: p.whoCanMessage, previews: !!p.previews, dnd: !!p.dnd };
  };
  const canMessage = (senderId, peerId) => {
    const rule = privacyOf(peerId).whoCanMessage;
    if (rule === 'everyone') return true;
    if (db.prepare('SELECT 1 FROM messages WHERE sender_id = ? AND recipient_id = ?').get(peerId, senderId)) return true;
    if (rule === 'nobody') return false;
    return !!(db.prepare('SELECT 1 FROM group_members a JOIN group_members b ON a.group_id = b.group_id WHERE a.user_id = ? AND b.user_id = ?').get(senderId, peerId)
      || db.prepare('SELECT 1 FROM community_members a JOIN community_members b ON a.community_id = b.community_id WHERE a.user_id = ? AND b.user_id = ?').get(senderId, peerId));
  };
  const likePattern = (q) => `%${q.replace(/[!%_]/g, '!$&')}%`;
  const prefsOf = (uid) => {
    db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(uid);
    const p = db.prepare('SELECT theme, accent, density, reduce_motion AS reduceMotion, plain FROM profiles WHERE user_id = ?').get(uid);
    return { ...p, reduceMotion: !!p.reduceMotion, plain: !!p.plain };
  };
  const balanceOf = (uid) => countOf('SELECT COALESCE(SUM(delta), 0) AS n FROM sparks_ledger WHERE user_id = ?', uid);
  const award = (uid, delta, reason, ref) =>
    db.prepare('INSERT OR IGNORE INTO sparks_ledger (user_id, delta, reason, ref, at) VALUES (?, ?, ?, ?, ?)').run(uid, delta, reason, ref, Date.now()).changes === 1;
  const itemNamed = (id) => {
    const item = db.prepare('SELECT * FROM items WHERE id = ? AND active = 1').get(String(id ?? ''));
    if (!item) throw new HttpError(404, 'No such item');
    return item;
  };

  const avatarOf = (uid) => db.prepare('SELECT avatar_id AS id FROM profiles WHERE user_id = ?').get(uid)?.id ?? null;
  const ignoredBy = (uid, username) => !!db.prepare('SELECT 1 FROM ignores i JOIN users u ON u.id = i.ignored_id WHERE i.user_id = ? AND u.username = ?').get(uid, username);
  const callTimers = new Map();
  const callOf = (me, id) => {
    const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(Number(id));
    if (!c || (c.caller_id !== me.id && c.callee_id !== me.id)) throw new HttpError(404, 'No such call');
    return c;
  };
  const inCall = (uid) => !!db.prepare("SELECT 1 FROM calls WHERE state != 'ended' AND (caller_id = ? OR callee_id = ?) AND created_at > ?").get(uid, uid, Date.now() - 4 * 3600e3);
  const finishCall = (c, reason) => {
    clearTimeout(callTimers.get(c.id));
    callTimers.delete(c.id);
    const now = Date.now();
    db.prepare("UPDATE calls SET state = 'ended', reason = ?, ended_at = ? WHERE id = ? AND state != 'ended'").run(reason, now, c.id);
    const secs = c.answered_at ? Math.round((now - c.answered_at) / 1000) : 0;
    const text = c.answered_at ? `Call ended · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
      : { missed: 'Missed call', declined: 'Call declined' }[reason] ?? 'Call cancelled';
    const id = Number(db.prepare("INSERT INTO messages (sender_id, recipient_id, body, created_at, kind) VALUES (?, ?, ?, ?, 'call')").run(c.caller_id, c.callee_id, text, now).lastInsertRowid);
    const [from, to] = [c.caller_id, c.callee_id].map((uid) => db.prepare('SELECT username FROM users WHERE id = ?').get(uid).username);
    push(c.callee_id, 'message', { id, from, body: text, at: now, kind: 'call' });
    push(c.caller_id, 'message', { id, from, to, body: text, at: now, kind: 'call' });
    for (const uid of [c.caller_id, c.callee_id]) push(uid, 'call', { type: 'ended', id: c.id, reason });
  };
  const attachmentOf = (me, id) => {
    if (!id) return null;
    if (!db.prepare("SELECT 1 FROM uploads WHERE id = ? AND user_id = ? AND kind = 'attachment'").get(String(id), me.id)) throw new HttpError(400, 'That attachment is not available.');
    return String(id);
  };
  const canSeeAttachment = (me, id, ownerId) => ownerId === me.id
    || !!db.prepare('SELECT 1 FROM messages WHERE attachment_id = ? AND (sender_id = ? OR recipient_id = ?)').get(id, me.id, me.id)
    || !!db.prepare('SELECT 1 FROM group_messages x JOIN group_members gm ON gm.group_id = x.group_id AND gm.user_id = ? WHERE x.attachment_id = ?').get(me.id, id)
    || db.prepare('SELECT channel_id FROM channel_messages WHERE attachment_id = ?').all(id).some(({ channel_id: cid }) => {
      try { channelAccess(me, cid); return true; } catch { return false; }
    });
  const TONES = ['chime', 'drop', 'pluck', 'none'];
  const soundOf = (uid) => {
    prefsOf(uid);
    return { ...db.prepare('SELECT tone, volume FROM profiles WHERE user_id = ?').get(uid), overrides: db.prepare('SELECT kind, target, tone FROM tones WHERE user_id = ?').all(uid) };
  };
  const readBytes = (req, max) => new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) { req.resume(); return reject(new HttpError(413, 'That file is too large.')); }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'That file is too large.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const routes = {
    'POST /api/communities': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot create communities.');
      const { name, description } = await readJson(req);
      const title = String(name ?? '').trim().slice(0, 60);
      if (!title) throw new HttpError(400, 'Give the community a name.');
      if (countOf("SELECT COUNT(*) AS n FROM community_members WHERE user_id = ? AND role = 'owner'", me.id) >= 10) throw new HttpError(409, 'You can own up to 10 communities.');
      const id = tx(() => {
        const cid = Number(db.prepare('INSERT INTO communities (name, description, created_at) VALUES (?, ?, ?)').run(title, String(description ?? '').trim().slice(0, 300), Date.now()).lastInsertRowid);
        db.prepare("INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(cid, me.id, Date.now());
        db.prepare("INSERT INTO channels (community_id, name, kind, position) VALUES (?, 'general', 'text', 0)").run(cid);
        db.prepare("INSERT INTO channels (community_id, name, kind, read_only, position) VALUES (?, 'announcements', 'announcement', 1, 1)").run(cid);
        return cid;
      });
      sendJson(res, 201, { id });
    },

    'GET /api/communities': (req, res, me) => sendJson(res, 200, db.prepare(`SELECT c.id, c.name, c.icon_id AS icon, cm.role,
      (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS members
      FROM communities c JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ? ORDER BY c.id DESC`).all(me.id)),

    'GET /api/community': (req, res, me, url) => {
      const id = Number(url.searchParams.get('id'));
      const m = needCMember(me, id);
      sendJson(res, 200, {
        role: m.role, myPerms: permsOf(m),
        roles: db.prepare('SELECT id, name, color, perms FROM community_roles WHERE community_id = ? ORDER BY id').all(id).map((r) => ({ ...r, perms: JSON.parse(r.perms) })),
        community: db.prepare('SELECT id, name, description, public, icon_id AS icon FROM communities WHERE id = ?').get(id),
        channels: db.prepare('SELECT id, name, kind, topic, read_only AS readOnly, private FROM channels WHERE community_id = ? AND (private = 0 OR ?) ORDER BY position, id').all(id, RANK[m.role] >= 1 ? 1 : 0),
        members: db.prepare(`SELECT u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, cm.role, r.name AS customRole, cm.timeout_until > ? AS timedOut FROM community_members cm
          JOIN users u ON u.id = cm.user_id LEFT JOIN community_roles r ON r.id = cm.custom_role_id WHERE cm.community_id = ? ORDER BY u.username`).all(Date.now(), id)
          .map((r) => ({ ...r, timedOut: !!r.timedOut })).sort((a, b) => RANK[b.role] - RANK[a.role]),
      });
    },

    'POST /api/channels': async (req, res, me) => {
      const { community, name, kind = 'text', topic = '', readOnly = false, private: isPrivate = false } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'channels');
      const slug = String(name ?? '').toLowerCase().trim().replace(/\s+/g, '-');
      if (!/^[a-z0-9-]{1,30}$/.test(slug)) throw new HttpError(400, 'Channel names use letters, numbers and dashes (up to 30).');
      if (!['text', 'announcement'].includes(kind)) throw new HttpError(400, 'Unknown channel type.');
      if (countOf('SELECT COUNT(*) AS n FROM channels WHERE community_id = ?', community) >= 50) throw new HttpError(409, 'Channel limit reached.');
      try {
        const id = Number(db.prepare('INSERT INTO channels (community_id, name, kind, topic, read_only, private, position) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE community_id = ?))')
          .run(community, slug, kind, String(topic).slice(0, 200), readOnly ? 1 : 0, isPrivate ? 1 : 0, community).lastInsertRowid);
        logMod(community, me, 'create-channel', slug);
        pushCommunity(Number(community));
        sendJson(res, 201, { id });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'A channel with that name exists.');
        throw err;
      }
    },

    'GET /api/channel-messages': (req, res, me, url) => {
      const { ch, m } = channelAccess(me, url.searchParams.get('channel'));
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare(`SELECT x.id, u.username AS "from", u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, x.body, x.attachment_id AS attachment, x.created_at AS at
        FROM channel_messages x JOIN users u ON u.id = x.sender_id WHERE x.channel_id = ? AND x.id < ? AND x.sender_id NOT IN (SELECT ignored_id FROM ignores WHERE user_id = ?) ORDER BY x.id DESC LIMIT 50`).all(ch.id, before, me.id);
      sendJson(res, 200, { channel: { id: ch.id, name: ch.name, topic: ch.topic }, canPost: canPost(ch, m), canModerate: can(m, 'delete_messages'),
        messages: rows.reverse().map((r) => ({ ...r, mine: r.from === me.username })) });
    },

    'POST /api/channel-messages': async (req, res, me) => {
      const { channel, body, attachment } = await readJson(req);
      const { ch, m } = channelAccess(me, channel);
      if (!canPost(ch, m)) throw new HttpError(403, 'Only admins can post in this channel.');
      if (m.timeoutUntil > Date.now()) throw new HttpError(403, `You are timed out until ${new Date(m.timeoutUntil).toLocaleString()}.`);
      const text = String(body ?? '').trim();
      const att = attachmentOf(me, attachment);
      if ((!text && !att) || text.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      if (limited(`chan:${me.id}`, 20, 10000)) throw new HttpError(429, 'Slow down a little.');
      const at = Date.now();
      const id = Number(db.prepare('INSERT INTO channel_messages (channel_id, sender_id, body, created_at, attachment_id) VALUES (?, ?, ?, ?, ?)').run(ch.id, me.id, text, at, att).lastInsertRowid);
      pushChannel(ch, 'channel-message', { id, channel: ch.id, from: me.username, name: me.display_name, avatar: avatarOf(me.id), body: text, at, attachment: att });
      sendJson(res, 201, { id });
    },

    'POST /api/channel-message-delete': async (req, res, me) => {
      const { channel, id } = await readJson(req);
      const { ch, m } = channelAccess(me, channel);
      const msg = db.prepare('SELECT sender_id FROM channel_messages WHERE id = ? AND channel_id = ?').get(Number(id), ch.id);
      if (!msg) throw new HttpError(404, 'No such message');
      if (msg.sender_id !== me.id) { needPerm(m, 'delete_messages'); logMod(ch.community_id, me, 'delete-message', `#${ch.name}`, `message ${id}`); }
      db.prepare('DELETE FROM channel_messages WHERE id = ?').run(Number(id));
      pushChannel(ch, 'channel-delete', { channel: ch.id, id: Number(id) });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-invite': async (req, res, me) => {
      const { community } = await readJson(req);
      needPerm(needCMember(me, community), 'invites');
      const code = crypto.randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO community_invites (token_hash, community_id, expires_at) VALUES (?, ?, ?)').run(sha(code), Number(community), Date.now() + 7 * 864e5);
      sendJson(res, 201, { code, expiresInDays: 7 });
    },

    'POST /api/community-join': async (req, res, me) => {
      const { code } = await readJson(req);
      const invite = db.prepare('SELECT community_id FROM community_invites WHERE token_hash = ? AND expires_at > ?').get(sha(String(code ?? '')), Date.now());
      if (!invite || me.is_bot) throw new HttpError(404, 'That invite is invalid or expired.');
      if (db.prepare('SELECT 1 FROM community_bans WHERE community_id = ? AND user_id = ?').get(invite.community_id, me.id)) throw new HttpError(403, 'You cannot join this community.');
      joinCommunity(invite.community_id, me.id);
      pushCommunity(invite.community_id);
      sendJson(res, 200, { id: invite.community_id });
    },

    'POST /api/community-role': async (req, res, me) => {
      const { community, username, role } = await readJson(req);
      const m = needCMember(me, community);
      needRole(m, 'admin');
      if (!['member', 'moderator', 'admin'].includes(role) || RANK[role] >= RANK[m.role]) throw new HttpError(403, 'You can only grant roles below your own.');
      const user = lowerRanked(me, m, Number(community), username);
      db.prepare('UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?').run(role, Number(community), user.id);
      logMod(community, me, 'set-role', user.username, role);
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-kick': async (req, res, me) => {
      const { community, username, reason } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'kick');
      const user = lowerRanked(me, m, Number(community), username);
      db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(community), user.id);
      logMod(community, me, 'kick', user.username, reasonOf(reason));
      pushCommunity(Number(community), [user.id]);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-ban': async (req, res, me) => {
      const { community, username, reason } = await readJson(req);
      const m = needCMember(me, community);
      needRole(m, 'admin');
      const user = lowerRanked(me, m, Number(community), username);
      tx(() => {
        db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(community), user.id);
        db.prepare('INSERT OR REPLACE INTO community_bans (community_id, user_id, reason, at) VALUES (?, ?, ?, ?)').run(Number(community), user.id, reasonOf(reason), Date.now());
      });
      logMod(community, me, 'ban', user.username, reasonOf(reason));
      pushCommunity(Number(community), [user.id]);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-unban': async (req, res, me) => {
      const { community, username } = await readJson(req);
      needRole(needCMember(me, community), 'admin');
      const user = userNamed(username);
      db.prepare('DELETE FROM community_bans WHERE community_id = ? AND user_id = ?').run(Number(community), user.id);
      logMod(community, me, 'unban', user.username);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-timeout': async (req, res, me) => {
      const { community, username, minutes, reason } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'timeout');
      const mins = Math.min(Math.max(Number(minutes) || 0, 0), 10080);
      const user = lowerRanked(me, m, Number(community), username);
      db.prepare('UPDATE community_members SET timeout_until = ? WHERE community_id = ? AND user_id = ?').run(mins ? Date.now() + mins * 60000 : 0, Number(community), user.id);
      logMod(community, me, mins ? 'timeout' : 'clear-timeout', user.username, mins ? `${mins} min. ${reasonOf(reason)}` : '');
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-leave': async (req, res, me) => {
      const { community } = await readJson(req);
      if (needCMember(me, community).role === 'owner') throw new HttpError(400, 'Owners cannot leave. Delete the community instead.');
      db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(community), me.id);
      pushCommunity(Number(community), [me.id]);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-delete': async (req, res, me) => {
      const { community } = await readJson(req);
      if (needCMember(me, community).role !== 'owner') throw new HttpError(403, 'Only the owner can delete a community.');
      const ids = db.prepare('SELECT user_id FROM community_members WHERE community_id = ?').all(Number(community)).map((r) => r.user_id);
      db.prepare('DELETE FROM communities WHERE id = ?').run(Number(community));
      ids.forEach((uid) => push(uid, 'community', { id: Number(community) }));
      sendJson(res, 200, { ok: true });
    },

    'GET /api/community-log': (req, res, me, url) => {
      const id = Number(url.searchParams.get('id'));
      needPerm(needCMember(me, id), 'log');
      sendJson(res, 200, db.prepare(`SELECT l.action, l.target, l.detail, l.at, u.username AS actor FROM mod_log l JOIN users u ON u.id = l.actor_id
        WHERE l.community_id = ? ORDER BY l.id DESC LIMIT 50`).all(id));
    },

    'POST /api/upload': async (req, res, me, url) => {
      needHuman(me);
      const kind = url.searchParams.get('kind');
      if (!['avatar', 'banner', 'attachment', 'community-icon', 'group-icon'].includes(kind)) throw new HttpError(400, 'Unknown upload type.');
      if (limited(`upload:${kind}:${me.id}`, kind === 'attachment' ? 60 : 10, 3600e3)) throw new HttpError(429, 'Too many uploads. Try again later.');
      const maxBytes = (kind === 'attachment' ? 5 : kind === 'banner' ? 4 : 2) * 1024 * 1024;
      const body = await readBytes(req, maxBytes);
      const img = sniffImage(body);
      if (!img) throw new HttpError(400, 'Upload a PNG, JPEG, GIF or WebP image.');
      if (!(img.w >= 1 && img.h >= 1 && img.w <= 4096 && img.h <= 4096)) throw new HttpError(400, 'Images can be at most 4096 pixels on each side.');
      if (img.mime === 'image/gif' && body.length > maxBytes / 2) throw new HttpError(400, `GIFs must be under ${maxBytes / 2 / 1024 / 1024} MB.`);
      const id = crypto.randomBytes(16).toString('hex');
      if (kind === 'attachment') {
        storeFile(id, body);
        db.prepare('INSERT INTO uploads (id, user_id, kind, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, me.id, kind, img.mime, body.length, Date.now());
        return sendJson(res, 201, { id });
      }
      if (kind.endsWith('-icon')) {
        const target = Number(url.searchParams.get('id'));
        const table = kind === 'community-icon' ? 'communities' : 'groups';
        if (table === 'communities') needRole(needCMember(me, target), 'admin'); else needAdmin(me, target);
        const old = db.prepare(`SELECT icon_id AS id FROM ${table} WHERE id = ?`).get(target).id;
        storeFile(id, body);
        db.prepare('INSERT INTO uploads (id, user_id, kind, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, me.id, kind, img.mime, body.length, Date.now());
        db.prepare(`UPDATE ${table} SET icon_id = ? WHERE id = ?`).run(id, target);
        removeFile(old);
        return sendJson(res, 201, { id });
      }
      const column = kind === 'avatar' ? 'avatar_id' : 'banner_id';
      prefsOf(me.id);
      const previous = db.prepare(`SELECT ${column} AS id FROM profiles WHERE user_id = ?`).get(me.id).id;
      storeFile(id, body);
      db.prepare('INSERT INTO uploads (id, user_id, kind, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, me.id, kind, img.mime, body.length, Date.now());
      db.prepare(`UPDATE profiles SET ${column} = ? WHERE user_id = ?`).run(id, me.id);
      removeFile(previous);
      sendJson(res, 201, { id });
    },

    'POST /api/upload/delete': async (req, res, me) => {
      const { kind } = await readJson(req);
      if (!['avatar', 'banner'].includes(kind)) throw new HttpError(400, 'Unknown upload type.');
      const column = kind === 'avatar' ? 'avatar_id' : 'banner_id';
      prefsOf(me.id);
      const previous = db.prepare(`SELECT ${column} AS id FROM profiles WHERE user_id = ?`).get(me.id).id;
      db.prepare(`UPDATE profiles SET ${column} = NULL WHERE user_id = ?`).run(me.id);
      removeFile(previous);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/account/delete': async (req, res, me) => {
      if (me.is_bot || me.is_owner) throw new HttpError(403, 'This account cannot be deleted here.');
      const { password } = await readJson(req);
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.id);
      if (typeof password !== 'string' || !checkPassword(password, row.password_hash)) throw new HttpError(403, 'Wrong password.');
      if (countOf("SELECT COUNT(*) AS n FROM community_members WHERE user_id = ? AND role = 'owner'", me.id)) throw new HttpError(409, 'Delete the communities you own first.');
      const files = db.prepare('SELECT id FROM uploads WHERE user_id = ?').all(me.id);
      tx(() => {
        for (const { group_id: gid } of db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(me.id)) {
          db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, me.id);
          const next = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1').get(gid);
          if (!next) db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
          else if (!db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND role = 'admin'").get(gid))
            db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(gid, next.user_id);
        }
        db.prepare('UPDATE groups SET created_by = ? WHERE created_by = ?').run(teamsId, me.id);
        db.prepare('DELETE FROM users WHERE id IN (SELECT user_id FROM bots WHERE owner_id = ?)').run(me.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(me.id);
      });
      files.forEach(({ id }) => rmSync(path.join(uploadDir, id), { force: true }));
      for (const stream of streams.get(me.id) ?? []) stream.end();
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    },

    'GET /api/ai/settings': (req, res, me) => {
      needHuman(me);
      const row = db.prepare('SELECT key_enc, model, personality FROM ai_settings WHERE user_id = ?').get(me.id);
      sendJson(res, 200, { available: !!aesKey, hasKey: !!row?.key_enc, model: row?.model ?? 'openai/gpt-oss-120b', personality: row?.personality ?? '' });
    },

    'POST /api/ai/settings': async (req, res, me) => {
      needHuman(me);
      const { apiKey, model, personality } = await readJson(req);
      if (!aesKey) throw new HttpError(503, 'AI key storage is not configured on this server.');
      const name = String(model ?? '').trim();
      if (!/^[\w./:-]{1,100}$/.test(name)) throw new HttpError(400, 'Enter a model name.');
      let enc = db.prepare('SELECT key_enc FROM ai_settings WHERE user_id = ?').get(me.id)?.key_enc ?? null;
      if (apiKey) {
        const k = String(apiKey).trim();
        if (!/^\S{20,300}$/.test(k)) throw new HttpError(400, 'That does not look like an API key.');
        enc = encryptKey(k);
      }
      if (!enc) throw new HttpError(400, 'Add your Groq API key first.');
      db.prepare(`INSERT INTO ai_settings (user_id, key_enc, model, personality) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET key_enc = excluded.key_enc, model = excluded.model, personality = excluded.personality`)
        .run(me.id, enc, name, String(personality ?? '').trim().slice(0, 500));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/key/delete': (req, res, me) => {
      needHuman(me);
      db.prepare('UPDATE ai_settings SET key_enc = NULL WHERE user_id = ?').run(me.id);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/ai/models': async (req, res, me) => {
      const { key } = userAi(me);
      sendJson(res, 200, (await groq(key, '/models')).data.map((m) => m.id).sort());
    },

    'POST /api/ai/test': async (req, res, me) => {
      const { key, model } = userAi(me);
      const ids = (await groq(key, '/models')).data.map((m) => m.id);
      if (!ids.includes(model)) throw new HttpError(400, `The model ${model} is not available for this key.`);
      sendJson(res, 200, { ok: true, model });
    },

    'GET /api/ai/conversations': (req, res, me) => sendJson(res, 200,
      db.prepare('SELECT id, title FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').all(me.id)),

    'GET /api/ai/messages': (req, res, me, url) => {
      const conv = ownConversation(me, url.searchParams.get('conversation'));
      sendJson(res, 200, { conversation: conv, messages: db.prepare('SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id').all(conv.id) });
    },

    'POST /api/ai/rename': async (req, res, me) => {
      const { conversation, title } = await readJson(req);
      const conv = ownConversation(me, conversation);
      const t = String(title ?? '').trim().slice(0, 60);
      if (!t) throw new HttpError(400, 'Give the conversation a title.');
      db.prepare('UPDATE ai_conversations SET title = ? WHERE id = ?').run(t, conv.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/clear': async (req, res, me) => {
      db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(ownConversation(me, (await readJson(req)).conversation).id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/delete': async (req, res, me) => {
      db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(ownConversation(me, (await readJson(req)).conversation).id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/delete-all': (req, res, me) => {
      needHuman(me);
      db.prepare('DELETE FROM ai_conversations WHERE user_id = ?').run(me.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/chat': async (req, res, me) => {
      const { conversation, text, localTime } = await readJson(req);
      const message = String(text ?? '').trim();
      if (!message || message.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      const { key, model, personality } = userAi(me);
      if (limited(`ai:${me.id}`, 30, 60000)) throw new HttpError(429, 'Slow down a little.');
      const existing = conversation ? ownConversation(me, conversation) : null;
      const now = Date.now();
      const convId = existing?.id ?? Number(db.prepare('INSERT INTO ai_conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(me.id, message.slice(0, 40), now, now).lastInsertRowid);
      const userMsg = Number(db.prepare("INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(convId, message, now).lastInsertRowid);
      const history = db.prepare('SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20').all(convId).reverse();
      const system = 'You are Scrxaper Buddy, a small friendly flower-cloud creature inside the Scrxaper messaging app. Be warm, concise and honest. '
        + 'Do not claim to know anything about the user that they have not told you in this chat.'
        + (personality ? ` The user asked for this personality: ${personality}` : '')
        + (localTime ? ` The user's local time is ${String(localTime).slice(0, 40)}.` : '');
      try {
        const data = await groq(key, '/chat/completions', { model, messages: [{ role: 'system', content: system }, ...history] });
        const reply = String(data.choices?.[0]?.message?.content ?? '').slice(0, 20000);
        if (!reply) throw new HttpError(502, 'The AI provider returned an empty reply.');
        db.prepare("INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").run(convId, reply, Date.now());
        db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), convId);
        sendJson(res, 200, { conversation: convId, reply });
      } catch (err) {
        db.prepare('DELETE FROM ai_messages WHERE id = ?').run(userMsg);
        if (!existing) db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(convId);
        throw err;
      }
    },

    'GET /api/discover': (req, res, me, url) => {
      const p = likePattern(String(url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 50));
      const list = (table, memberTable, key) => db.prepare(`SELECT t.id, t.name, t.description, t.icon_id AS icon,
        (SELECT COUNT(*) FROM ${memberTable} WHERE ${key} = t.id) AS members,
        EXISTS (SELECT 1 FROM ${memberTable} WHERE ${key} = t.id AND user_id = ?) AS joined
        FROM ${table} t WHERE t.public = 1 AND (t.name LIKE ? ESCAPE '!' OR t.description LIKE ? ESCAPE '!') ORDER BY members DESC, t.id DESC LIMIT 30`)
        .all(me.id, p, p).map((r) => ({ ...r, joined: !!r.joined }));
      sendJson(res, 200, { communities: list('communities', 'community_members', 'community_id'), groups: list('groups', 'group_members', 'group_id') });
    },

    'POST /api/discover/join': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot join this way.');
      const { kind, id } = await readJson(req);
      if (kind === 'community') {
        const c = db.prepare('SELECT id FROM communities WHERE id = ? AND public = 1').get(Number(id));
        if (!c) throw new HttpError(404, 'No such community');
        if (db.prepare('SELECT 1 FROM community_bans WHERE community_id = ? AND user_id = ?').get(c.id, me.id)) throw new HttpError(403, 'You cannot join this community.');
        joinCommunity(c.id, me.id);
        pushCommunity(c.id);
      } else if (kind === 'group') {
        const g = db.prepare('SELECT id FROM groups WHERE id = ? AND public = 1').get(Number(id));
        if (!g) throw new HttpError(404, 'No such group');
        addMember(g.id, me.id);
        pushGroup(g.id, 'group', { id: g.id });
      } else throw new HttpError(400, 'Unknown type.');
      sendJson(res, 200, { id: Number(id) });
    },

    'POST /api/community-settings': async (req, res, me) => {
      const { community, description, public: isPublic } = await readJson(req);
      needRole(needCMember(me, community), 'admin');
      db.prepare('UPDATE communities SET description = ?, public = ? WHERE id = ?').run(String(description ?? '').trim().slice(0, 300), isPublic ? 1 : 0, Number(community));
      logMod(community, me, 'settings', isPublic ? 'public' : 'private');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-settings': async (req, res, me) => {
      const { group, description, public: isPublic } = await readJson(req);
      needAdmin(me, group);
      db.prepare('UPDATE groups SET description = ?, public = ? WHERE id = ?').run(String(description ?? '').trim().slice(0, 300), isPublic ? 1 : 0, Number(group));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ignore': async (req, res, me) => {
      const { username, ignored } = await readJson(req);
      const user = userNamed(username);
      if (user.id === me.id) throw new HttpError(400, 'You cannot ignore yourself.');
      if (ignored) {
        if (countOf('SELECT COUNT(*) AS n FROM ignores WHERE user_id = ?', me.id) >= 500) throw new HttpError(409, 'Your ignore list is full.');
        db.prepare('INSERT OR IGNORE INTO ignores (user_id, ignored_id) VALUES (?, ?)').run(me.id, user.id);
      } else db.prepare('DELETE FROM ignores WHERE user_id = ? AND ignored_id = ?').run(me.id, user.id);
      sendJson(res, 200, { ignored: !!ignored });
    },

    'GET /api/ice': (req, res) => sendJson(res, 200, { iceServers: [
      { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
      ...(process.env.TURN_URL ? [{ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }] : []),
    ] }),

    'POST /api/call/start': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot make calls.');
      const { to, video } = await readJson(req);
      const peer = findPeer(me, to);
      if (peer.is_system || peer.is_bot) throw new HttpError(403, 'You cannot call this account.');
      if (isBlocked(me.id, peer.id) || !canMessage(me.id, peer.id)) throw new HttpError(403, "This person isn't accepting calls from you.");
      if (limited(`call:${me.id}`, 20, 600000)) throw new HttpError(429, 'Too many calls. Try again shortly.');
      if (inCall(me.id) || inCall(peer.id)) throw new HttpError(409, 'Someone is already in a call.');
      const id = Number(db.prepare('INSERT INTO calls (caller_id, callee_id, video, created_at) VALUES (?, ?, ?, ?)').run(me.id, peer.id, video ? 1 : 0, Date.now()).lastInsertRowid);
      const timer = setTimeout(() => {
        const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
        if (c?.state === 'ringing') finishCall(c, 'missed');
      }, callRingMs);
      timer.unref();
      callTimers.set(id, timer);
      push(peer.id, 'call', { type: 'incoming', id, from: me.username, name: me.display_name, avatar: avatarOf(me.id), video: !!video });
      sendJson(res, 201, { id });
    },

    'POST /api/call/answer': async (req, res, me) => {
      const c = callOf(me, (await readJson(req)).call);
      if (c.callee_id !== me.id || c.state !== 'ringing') throw new HttpError(409, 'This call can no longer be answered.');
      clearTimeout(callTimers.get(c.id));
      db.prepare("UPDATE calls SET state = 'active', answered_at = ? WHERE id = ?").run(Date.now(), c.id);
      push(c.caller_id, 'call', { type: 'answered', id: c.id });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/call/decline': async (req, res, me) => {
      const c = callOf(me, (await readJson(req)).call);
      if (c.callee_id !== me.id || c.state !== 'ringing') throw new HttpError(409, 'This call can no longer be declined.');
      finishCall(c, 'declined');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/call/end': async (req, res, me) => {
      const c = callOf(me, (await readJson(req)).call);
      if (c.state !== 'ended') finishCall(c, c.state === 'ringing' && c.caller_id === me.id ? 'cancelled' : 'ended');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/call/signal': async (req, res, me) => {
      const { call, data } = await readJson(req);
      const c = callOf(me, call);
      if (c.state === 'ended') throw new HttpError(409, 'This call has ended.');
      if (JSON.stringify(data ?? null).length > 20000) throw new HttpError(413, 'Signal too large.');
      if (limited(`signal:${me.id}`, 600, 60000)) throw new HttpError(429, 'Slow down.');
      push(c.caller_id === me.id ? c.callee_id : c.caller_id, 'call', { type: 'signal', id: c.id, data });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/sound': async (req, res, me) => {
      const { tone, volume } = await readJson(req);
      const vol = Number(volume);
      if (!TONES.includes(tone) || !Number.isInteger(vol) || vol < 0 || vol > 100) throw new HttpError(400, 'Unknown tone or volume.');
      prefsOf(me.id);
      db.prepare('UPDATE profiles SET tone = ?, volume = ? WHERE user_id = ?').run(tone, vol, me.id);
      sendJson(res, 200, soundOf(me.id));
    },

    'POST /api/sound/override': async (req, res, me) => {
      const { kind, target, tone } = await readJson(req);
      const key = String(target ?? '').slice(0, 40);
      if (!['dm', 'group', 'channel'].includes(kind) || !key) throw new HttpError(400, 'Unknown target.');
      if (!tone || tone === 'default') db.prepare('DELETE FROM tones WHERE user_id = ? AND kind = ? AND target = ?').run(me.id, kind, key);
      else if (!TONES.includes(tone)) throw new HttpError(400, 'Unknown tone.');
      else db.prepare('INSERT OR REPLACE INTO tones (user_id, kind, target, tone) VALUES (?, ?, ?, ?)').run(me.id, kind, key, tone);
      sendJson(res, 200, soundOf(me.id));
    },

    'POST /api/community-roles': async (req, res, me) => {
      const { community, name, color, perms } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'roles');
      const title = String(name ?? '').trim().slice(0, 30);
      const list = [...new Set(Array.isArray(perms) ? perms : [])];
      if (!title || !list.length || list.some((p) => !ALL_PERMS.includes(p))) throw new HttpError(400, 'Name the role and pick permissions from the list.');
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'Colour must look like #c8d6e5.');
      if (countOf('SELECT COUNT(*) AS n FROM community_roles WHERE community_id = ?', Number(community)) >= 10) throw new HttpError(409, 'A community can have up to 10 custom roles.');
      try {
        const id = Number(db.prepare('INSERT INTO community_roles (community_id, name, color, perms) VALUES (?, ?, ?, ?)').run(Number(community), title, color || null, JSON.stringify(list)).lastInsertRowid);
        logMod(community, me, 'create-role', title, list.join(', '));
        pushCommunity(Number(community));
        sendJson(res, 201, { id });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'A role with that name exists.');
        throw err;
      }
    },

    'POST /api/community-role-delete': async (req, res, me) => {
      const { community, role } = await readJson(req);
      needPerm(needCMember(me, community), 'roles');
      db.prepare('DELETE FROM community_roles WHERE id = ? AND community_id = ?').run(Number(role), Number(community));
      logMod(community, me, 'delete-role', String(role));
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-custom-role': async (req, res, me) => {
      const { community, username, role } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'roles');
      const user = lowerRanked(me, m, Number(community), username);
      if (role !== null && !db.prepare('SELECT 1 FROM community_roles WHERE id = ? AND community_id = ?').get(Number(role), Number(community))) throw new HttpError(404, 'No such role');
      db.prepare('UPDATE community_members SET custom_role_id = ? WHERE community_id = ? AND user_id = ?').run(role === null ? null : Number(role), Number(community), user.id);
      logMod(community, me, 'assign-role', user.username, String(role));
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/privacy': async (req, res, me) => {
      const { whoCanMessage, previews, dnd } = await readJson(req);
      if (!['everyone', 'groups', 'nobody'].includes(whoCanMessage)) throw new HttpError(400, 'Unknown setting.');
      prefsOf(me.id);
      db.prepare('UPDATE profiles SET who_can_message = ?, previews = ?, dnd = ? WHERE user_id = ?').run(whoCanMessage, previews ? 1 : 0, dnd ? 1 : 0, me.id);
      sendJson(res, 200, privacyOf(me.id));
    },

    'POST /api/mute': async (req, res, me) => {
      const { kind, target, muted } = await readJson(req);
      const key = String(target ?? '').slice(0, 40);
      if (!['dm', 'group', 'community', 'channel'].includes(kind) || !key) throw new HttpError(400, 'Unknown mute target.');
      if (muted) {
        if (countOf('SELECT COUNT(*) AS n FROM mutes WHERE user_id = ?', me.id) >= 500) throw new HttpError(409, 'Too many muted conversations.');
        db.prepare('INSERT OR IGNORE INTO mutes (user_id, kind, target) VALUES (?, ?, ?)').run(me.id, kind, key);
      } else db.prepare('DELETE FROM mutes WHERE user_id = ? AND kind = ? AND target = ?').run(me.id, kind, key);
      sendJson(res, 200, { muted: !!muted });
    },

    'GET /api/search': (req, res, me, url) => {
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (q.length < 2 || q.length > 50) throw new HttpError(400, 'Search needs 2 to 50 characters.');
      const p = likePattern(q);
      const staffOnly = "(c.private = 0 OR cm.role != 'member')";
      sendJson(res, 200, {
        people: db.prepare("SELECT username, display_name AS name FROM users WHERE is_system = 0 AND banned_at IS NULL AND id != ? AND (username LIKE ? ESCAPE '!' OR display_name LIKE ? ESCAPE '!') LIMIT 20").all(me.id, p, p),
        groups: db.prepare("SELECT g.id, g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? WHERE g.name LIKE ? ESCAPE '!' LIMIT 20").all(me.id, p),
        communities: db.prepare("SELECT c.id, c.name FROM communities c JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ? WHERE c.name LIKE ? ESCAPE '!' LIMIT 20").all(me.id, p),
        channels: db.prepare(`SELECT c.id, c.name, co.name AS community FROM channels c JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = ?
          JOIN communities co ON co.id = c.community_id WHERE c.name LIKE ? ESCAPE '!' AND ${staffOnly} LIMIT 20`).all(me.id, p),
        messages: [
          ...db.prepare(`SELECT 'dm' AS kind, u.username AS target, u.display_name AS where_, m.body, m.created_at AS at FROM messages m
            JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
            WHERE (m.sender_id = ? OR m.recipient_id = ?) AND m.body LIKE ? ESCAPE '!' ORDER BY m.id DESC LIMIT 20`).all(me.id, me.id, me.id, p),
          ...db.prepare(`SELECT 'group' AS kind, CAST(x.group_id AS TEXT) AS target, g.name AS where_, x.body, x.created_at AS at FROM group_messages x
            JOIN group_members gm ON gm.group_id = x.group_id AND gm.user_id = ? JOIN groups g ON g.id = x.group_id
            WHERE x.body LIKE ? ESCAPE '!' ORDER BY x.id DESC LIMIT 20`).all(me.id, p),
          ...db.prepare(`SELECT 'channel' AS kind, CAST(x.channel_id AS TEXT) AS target, '#' || c.name || ' in ' || co.name AS where_, x.body, x.created_at AS at FROM channel_messages x
            JOIN channels c ON c.id = x.channel_id JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = ?
            JOIN communities co ON co.id = c.community_id WHERE x.body LIKE ? ESCAPE '!' AND ${staffOnly} ORDER BY x.id DESC LIMIT 20`).all(me.id, p),
        ].sort((a, b) => b.at - a.at).slice(0, 30),
      });
    },

    'POST /api/prefs': async (req, res, me) => {
      const { theme, accent, density, reduceMotion, plain } = await readJson(req);
      if (!['dark', 'light', 'system'].includes(theme) || !['comfortable', 'compact'].includes(density)) throw new HttpError(400, 'Unknown theme or density.');
      if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) throw new HttpError(400, 'Accent must be a hex colour like #b7c9e6.');
      prefsOf(me.id);
      db.prepare('UPDATE profiles SET theme = ?, accent = ?, density = ?, reduce_motion = ?, plain = ? WHERE user_id = ?').run(theme, accent || null, density, reduceMotion ? 1 : 0, plain ? 1 : 0, me.id);
      sendJson(res, 200, prefsOf(me.id));
    },

    'GET /api/profile': (req, res, me, url) => {
      const u = db.prepare('SELECT id, username, display_name FROM users WHERE username = ? AND is_system = 0').get(String(url.searchParams.get('user') || me.username).toLowerCase());
      if (!u) throw new HttpError(404, 'No such user');
      prefsOf(u.id);
      const p = db.prepare('SELECT bio, status, accent, avatar_id AS avatar, banner_id AS banner FROM profiles WHERE user_id = ?').get(u.id);
      sendJson(res, 200, { username: u.username, displayName: u.display_name, ...p,
        badges: db.prepare('SELECT b.id, b.name, b.description FROM user_badges ub JOIN badges b ON b.id = ub.badge_id WHERE ub.user_id = ? ORDER BY ub.at').all(u.id),
        cosmetics: db.prepare('SELECT i.kind, i.id, i.name, i.value FROM equipped e JOIN items i ON i.id = e.item_id WHERE e.user_id = ?').all(u.id) });
    },

    'POST /api/profile': async (req, res, me) => {
      const { bio, status, displayName } = await readJson(req);
      prefsOf(me.id);
      db.prepare('UPDATE profiles SET bio = ?, status = ? WHERE user_id = ?').run(String(bio ?? '').trim().slice(0, 200), String(status ?? '').trim().slice(0, 60), me.id);
      const name = String(displayName ?? '').trim().slice(0, 40);
      if (name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, me.id);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/shop': (req, res, me) => sendJson(res, 200, {
      currency, balance: balanceOf(me.id),
      items: db.prepare(`SELECT i.id, i.kind, i.name, i.description, i.price, i.value,
        EXISTS (SELECT 1 FROM inventory v WHERE v.user_id = ? AND v.item_id = i.id) AS owned,
        EXISTS (SELECT 1 FROM equipped e WHERE e.user_id = ? AND e.item_id = i.id) AS equipped FROM items i WHERE i.active = 1 ORDER BY i.price`)
        .all(me.id, me.id).map((r) => ({ ...r, owned: !!r.owned, equipped: !!r.equipped })),
      history: db.prepare('SELECT delta, reason, at FROM sparks_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(me.id),
    }),

    'POST /api/sparks/daily': (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot earn rewards.');
      const created = db.prepare('SELECT created_at FROM users WHERE id = ?').get(me.id).created_at;
      if (Date.now() - created < claimMinAgeMs) throw new HttpError(403, 'Daily rewards unlock an hour after you sign up.');
      if (!award(me.id, 10, 'Daily check-in', `daily:${new Date().toISOString().slice(0, 10)}`)) throw new HttpError(409, 'You already claimed today. Come back tomorrow.');
      sendJson(res, 200, { balance: balanceOf(me.id) });
    },

    'POST /api/shop/buy': async (req, res, me) => {
      const item = itemNamed((await readJson(req)).item);
      tx(() => {
        if (db.prepare('SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?').get(me.id, item.id)) throw new HttpError(409, 'You already own this.');
        if (balanceOf(me.id) < item.price) throw new HttpError(402, `Not enough ${currency}.`);
        award(me.id, -item.price, `Bought ${item.name}`, `buy:${item.id}`);
        db.prepare('INSERT INTO inventory (user_id, item_id, acquired_at) VALUES (?, ?, ?)').run(me.id, item.id, Date.now());
      });
      sendJson(res, 200, { balance: balanceOf(me.id) });
    },

    'POST /api/shop/equip': async (req, res, me) => {
      const item = itemNamed((await readJson(req)).item);
      if (!db.prepare('SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?').get(me.id, item.id)) throw new HttpError(403, 'You do not own this item.');
      db.prepare('INSERT OR REPLACE INTO equipped (user_id, kind, item_id) VALUES (?, ?, ?)').run(me.id, item.kind, item.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/shop/unequip': async (req, res, me) => {
      db.prepare('DELETE FROM equipped WHERE user_id = ? AND kind = ?').run(me.id, String((await readJson(req)).kind ?? ''));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/owner/sparks': async (req, res, me) => {
      needOwner(me);
      const { username, amount, reason } = await readJson(req);
      const user = userNamed(username);
      const delta = Number(amount);
      if (!Number.isInteger(delta) || !delta || Math.abs(delta) > 10000) throw new HttpError(400, 'Amount must be a non-zero whole number up to 10000.');
      if (balanceOf(user.id) + delta < 0) throw new HttpError(400, 'That would make the balance negative.');
      const why = reasonOf(reason) || 'Adjustment by Scrxaper Teams';
      award(user.id, delta, why, `owner:${crypto.randomUUID()}`);
      audit(me, 'sparks', user.username, `${delta}: ${why}`);
      sendJson(res, 200, { balance: balanceOf(user.id) });
    },

    'POST /api/birthday': async (req, res, me) => {
      const { month, day, clear } = await readJson(req);
      if (clear) { db.prepare('UPDATE users SET birthday = NULL WHERE id = ?').run(me.id); return sendJson(res, 200, { birthday: null }); }
      const d = new Date(Date.UTC(2000, Number(month) - 1, Number(day)));
      if (!Number.isInteger(Number(month)) || !Number.isInteger(Number(day)) || d.getUTCMonth() !== Number(month) - 1 || d.getUTCDate() !== Number(day)) throw new HttpError(400, 'That is not a valid date.');
      const birthday = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      db.prepare('UPDATE users SET birthday = ? WHERE id = ?').run(birthday, me.id);
      sendJson(res, 200, { birthday });
    },

    'POST /api/bots': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot create bots.');
      const { name, displayName } = await readJson(req);
      const username = String(name ?? '').toLowerCase();
      if (!USERNAME.test(username) || RESERVED.has(username)) throw new HttpError(400, 'Bot usernames are 3–24 characters: letters, numbers, underscore.');
      if (countOf('SELECT COUNT(*) AS n FROM bots WHERE owner_id = ?', me.id) >= 5) throw new HttpError(409, 'You can have up to 5 bots.');
      const token = `bot_${crypto.randomBytes(24).toString('base64url')}`;
      const secret = crypto.randomBytes(24).toString('hex');
      try {
        db.exec('BEGIN');
        const uid = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, created_at, is_bot) VALUES (?, ?, '!', ?, 1)").run(username, String(displayName ?? '').trim().slice(0, 40) || username, Date.now()).lastInsertRowid);
        db.prepare('INSERT INTO bots (user_id, owner_id, token_hash, webhook_secret) VALUES (?, ?, ?, ?)').run(uid, me.id, sha(token), secret);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That username is taken.');
        throw err;
      }
      sendJson(res, 201, { username, token, webhookSecret: secret });
    },

    'GET /api/bots': (req, res, me) => sendJson(res, 200, db.prepare(
      'SELECT u.username, u.display_name AS displayName, b.webhook_url AS webhookUrl FROM bots b JOIN users u ON u.id = b.user_id WHERE b.owner_id = ? ORDER BY u.id').all(me.id)),

    'POST /api/bots/webhook': async (req, res, me) => {
      const { bot, url } = await readJson(req);
      const target = ownedBot(me, bot);
      let value = null;
      if (url) {
        let parsed;
        try { parsed = new URL(String(url)); } catch { throw new HttpError(400, 'Enter a full URL.'); }
        if (!(parsed.protocol === 'https:' || (allowPrivateWebhooks && parsed.protocol === 'http:')) || String(url).length > 300) throw new HttpError(400, 'Webhook URLs must use https.');
        value = parsed.href;
      }
      db.prepare('UPDATE bots SET webhook_url = ? WHERE user_id = ?').run(value, target.id);
      sendJson(res, 200, { webhookUrl: value });
    },

    'POST /api/bots/token': async (req, res, me) => {
      const target = ownedBot(me, (await readJson(req)).bot);
      const token = `bot_${crypto.randomBytes(24).toString('base64url')}`;
      db.prepare('UPDATE bots SET token_hash = ? WHERE user_id = ?').run(sha(token), target.id);
      sendJson(res, 200, { token });
    },

    'POST /api/bots/delete': async (req, res, me) => {
      db.prepare('DELETE FROM users WHERE id = ?').run(ownedBot(me, (await readJson(req)).bot).id);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/owner/stats': (req, res, me) => {
      needOwner(me);
      const day = Date.now() - 864e5;
      sendJson(res, 200, {
        users: countOf('SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND is_bot = 0'),
        newUsers7d: countOf('SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND is_bot = 0 AND created_at > ?', Date.now() - 7 * 864e5),
        online: [...streams.values()].filter((set) => set.size).length,
        bots: countOf('SELECT COUNT(*) AS n FROM bots'),
        banned: countOf('SELECT COUNT(*) AS n FROM users WHERE banned_at IS NOT NULL'),
        groups: countOf('SELECT COUNT(*) AS n FROM groups'),
        messages: countOf('SELECT COUNT(*) AS n FROM messages WHERE sender_id != ?', teamsId) + countOf('SELECT COUNT(*) AS n FROM group_messages'),
        messages24h: countOf('SELECT COUNT(*) AS n FROM messages WHERE sender_id != ? AND created_at > ?', teamsId, day) + countOf('SELECT COUNT(*) AS n FROM group_messages WHERE created_at > ?', day),
        audit: db.prepare('SELECT a.action, a.target, a.detail, a.at, u.username AS actor FROM audit a JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 15').all(),
      });
    },

    'GET /api/owner/users': (req, res, me, url) => {
      needOwner(me);
      const q = `%${String(url.searchParams.get('q') ?? '').toLowerCase().replace(/[%_]/g, '')}%`;
      sendJson(res, 200, db.prepare(`SELECT username, display_name AS displayName, created_at AS createdAt, banned_at AS bannedAt, is_bot AS isBot
        FROM users WHERE is_system = 0 AND is_owner = 0 AND username LIKE ? ORDER BY id DESC LIMIT 50`).all(q));
    },

    'POST /api/owner/warn': async (req, res, me) => {
      needOwner(me);
      const { username, reason } = await readJson(req);
      const user = userNamed(username);
      const why = String(reason ?? '').trim().slice(0, 300);
      if (!why) throw new HttpError(400, 'A reason is required.');
      notify(user.id, `Official warning: ${why}. Repeated violations may lead to suspension.`);
      audit(me, 'warn', user.username, why);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/owner/ban': async (req, res, me) => {
      needOwner(me);
      const { username, reason } = await readJson(req);
      const user = userNamed(username);
      const why = String(reason ?? '').trim().slice(0, 300);
      if (!why) throw new HttpError(400, 'A reason is required.');
      if (db.prepare('SELECT 1 FROM users WHERE id = ? AND (is_owner = 1 OR is_system = 1)').get(user.id)) throw new HttpError(403, 'That account cannot be suspended.');
      notify(user.id, `Your account has been suspended: ${why}.`);
      db.prepare('UPDATE users SET banned_at = ?, banned_reason = ? WHERE id = ?').run(Date.now(), why, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      for (const stream of streams.get(user.id) ?? []) stream.end();
      audit(me, 'ban', user.username, why);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/owner/unban': async (req, res, me) => {
      needOwner(me);
      const user = userNamed((await readJson(req)).username);
      db.prepare('UPDATE users SET banned_at = NULL, banned_reason = NULL WHERE id = ?').run(user.id);
      notify(user.id, 'Your account has been restored. Welcome back.');
      audit(me, 'unban', user.username);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/owner/announce': async (req, res, me) => {
      needOwner(me);
      const text = String((await readJson(req)).text ?? '').trim().slice(0, 1000);
      if (!text) throw new HttpError(400, 'Write an announcement first.');
      const ids = db.prepare('SELECT id FROM users WHERE is_system = 0 AND is_bot = 0 AND banned_at IS NULL').all();
      ids.forEach(({ id }) => notify(id, text, 'announcement'));
      audit(me, 'announce', `${ids.length} users`, text);
      sendJson(res, 200, { sent: ids.length });
    },

    'POST /api/groups': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot create groups.');
      const { name, members = [] } = await readJson(req);
      const title = String(name ?? '').trim().slice(0, 60);
      if (!title) throw new HttpError(400, 'Give the group a name.');
      const others = [...new Set(members.map((m) => String(m).toLowerCase()))].filter((m) => m !== me.username).map(userNamed);
      db.exec('BEGIN');
      try {
        const gid = Number(db.prepare('INSERT INTO groups (name, created_by, created_at) VALUES (?, ?, ?)').run(title, me.id, Date.now()).lastInsertRowid);
        addMember(gid, me.id, 'admin');
        others.forEach((u) => addMember(gid, u.id));
        db.exec('COMMIT');
        others.forEach((u) => push(u.id, 'group', { id: gid }));
        sendJson(res, 201, { id: gid, name: title });
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },

    'GET /api/groups': (req, res, me) => sendJson(res, 200, db.prepare(`
      SELECT g.id, g.name, g.icon_id AS icon, g.public, gm.role, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS members,
        (SELECT body FROM group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS body
      FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? ORDER BY g.id DESC`).all(me.id)),

    'GET /api/group-messages': (req, res, me, url) => {
      const gid = Number(url.searchParams.get('group'));
      const role = needMember(me, gid);
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare(`SELECT m.id, u.username AS "from", u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, m.body, m.attachment_id AS attachment, m.created_at AS at
        FROM group_messages m JOIN users u ON u.id = m.sender_id WHERE m.group_id = ? AND m.id < ? AND m.sender_id NOT IN (SELECT ignored_id FROM ignores WHERE user_id = ?) ORDER BY m.id DESC LIMIT 50`).all(gid, before, me.id);
      const members = db.prepare(`SELECT u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? ORDER BY gm.role, u.username`).all(gid);
      sendJson(res, 200, { role, members, group: db.prepare('SELECT id, name, description, public, icon_id AS icon FROM groups WHERE id = ?').get(gid),
        messages: rows.reverse().map((r) => ({ ...r, mine: r.from === me.username })) });
    },

    'POST /api/group-messages': async (req, res, me) => {
      const { group, body, attachment } = await readJson(req);
      needMember(me, group);
      const text = String(body ?? '').trim();
      const att = attachmentOf(me, attachment);
      if ((!text && !att) || text.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      const at = Date.now();
      const id = Number(db.prepare('INSERT INTO group_messages (group_id, sender_id, body, created_at, attachment_id) VALUES (?, ?, ?, ?, ?)').run(group, me.id, text, at, att).lastInsertRowid);
      pushGroup(group, 'message', { id, group: Number(group), from: me.username, name: me.display_name, avatar: avatarOf(me.id), body: text, at, attachment: att });
      for (const { user_id } of db.prepare('SELECT m.user_id FROM group_members m JOIN bots b ON b.user_id = m.user_id WHERE m.group_id = ? AND m.user_id != ?').all(group, me.id))
        deliver(user_id, { type: 'message', scope: 'group', group: Number(group), id, from: me.username, fromName: me.display_name, body: text, at });
      if (me.is_bot && limited(`bot:${me.id}`, 60, 60000)) throw new HttpError(429, 'Slow down.');
      sendJson(res, 201, { id });
    },

    'POST /api/group-members': async (req, res, me) => {
      const { group, username } = await readJson(req);
      needAdmin(me, group);
      const user = userNamed(username);
      addMember(group, user.id);
      push(user.id, 'group', { id: group });
      pushGroup(group, 'group', { id: group });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-remove': async (req, res, me) => {
      const { group, username } = await readJson(req);
      needAdmin(me, group);
      const user = userNamed(username);
      if (user.id === me.id) throw new HttpError(400, 'Use Leave to remove yourself.');
      db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group, user.id);
      push(user.id, 'group', { id: group, removed: true });
      pushGroup(group, 'group', { id: group });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-leave': async (req, res, me) => {
      const { group } = await readJson(req);
      const role = needMember(me, group);
      db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group, me.id);
      const left = db.prepare('SELECT user_id, role FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1').get(group);
      if (!left) db.prepare('DELETE FROM groups WHERE id = ?').run(group);
      else if (role === 'admin' && !db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND role = 'admin'").get(group))
        db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(group, left.user_id);
      pushGroup(group, 'group', { id: group });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-invite': async (req, res, me) => {
      const { group } = await readJson(req);
      needAdmin(me, group);
      const code = crypto.randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO group_invites (token_hash, group_id, expires_at) VALUES (?, ?, ?)').run(sha(code), group, Date.now() + 7 * 864e5);
      sendJson(res, 201, { code, expiresInDays: 7 });
    },

    'POST /api/group-join': async (req, res, me) => {
      const { code } = await readJson(req);
      const invite = db.prepare('SELECT group_id FROM group_invites WHERE token_hash = ? AND expires_at > ?').get(sha(String(code ?? '')), Date.now());
      if (!invite) throw new HttpError(404, 'That invite is invalid or expired.');
      addMember(invite.group_id, me.id);
      pushGroup(invite.group_id, 'group', { id: invite.group_id });
      sendJson(res, 200, { id: invite.group_id });
    },

    'POST /api/register': async (req, res) => {
      if (limited(`reg:${clientIp(req)}`, authLimit)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const { username, displayName, password } = await readJson(req);
      const name = String(username ?? '').toLowerCase();
      if (!USERNAME.test(name) || RESERVED.has(name)) throw new HttpError(400, 'Usernames are 3–24 characters: letters, numbers, underscore.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
      const display = String(displayName ?? '').trim().slice(0, 40) || name;
      try {
        const { lastInsertRowid } = db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(name, display, hashPassword(password), Date.now());
        if (countOf('SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND is_bot = 0') <= 100)
          db.prepare("INSERT OR IGNORE INTO user_badges (user_id, badge_id, at, source) VALUES (?, 'early', ?, 'registration')").run(Number(lastInsertRowid), Date.now());
        startSession(res, Number(lastInsertRowid), { username: name, displayName: display });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That username is taken.');
        throw err;
      }
    },

    'POST /api/login': async (req, res) => {
      if (limited(`login:${clientIp(req)}`, authLimit)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const { username, password } = await readJson(req);
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').toLowerCase());
      const ok = user && !user.is_system && !user.is_bot && typeof password === 'string' && checkPassword(password, user.password_hash);
      if (!ok) throw new HttpError(401, 'Wrong username or password.');
      if (user.banned_at) throw new HttpError(403, `This account is suspended: ${user.banned_reason || 'no reason given'}.`);
      startSession(res, user.id, { username: user.username, displayName: user.display_name });
    },

    'POST /api/logout': async (req, res) => {
      const token = cookie(req, 'sid');
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    },

    'GET /api/me': (req, res, me) => sendJson(res, 200, { username: me.username, displayName: me.display_name, isOwner: !!me.is_owner, isBot: !!me.is_bot, birthday: me.birthday, avatar: avatarOf(me.id), ignored: db.prepare('SELECT u.username FROM ignores i JOIN users u ON u.id = i.ignored_id WHERE i.user_id = ?').all(me.id).map((r) => r.username), prefs: prefsOf(me.id), privacy: privacyOf(me.id), sound: soundOf(me.id), mutes: db.prepare('SELECT kind, target FROM mutes WHERE user_id = ?').all(me.id) }),

    'GET /api/conversations': (req, res, me) => {
      const rows = db.prepare(`
        SELECT u.username, u.display_name AS displayName, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, m.body, m.created_at AS at, m.sender_id = :me AS mine,
          (SELECT COUNT(*) FROM messages x WHERE x.sender_id = u.id AND x.recipient_id = :me AND x.read_at IS NULL) AS unread,
          EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = :me AND b.blocked_id = u.id) AS blocked
        FROM messages m JOIN users u ON u.id = CASE WHEN m.sender_id = :me THEN m.recipient_id ELSE m.sender_id END
        WHERE m.id IN (SELECT MAX(id) FROM messages WHERE sender_id = :me OR recipient_id = :me
                       GROUP BY CASE WHEN sender_id = :me THEN recipient_id ELSE sender_id END)
        ORDER BY m.id DESC`).all({ me: me.id });
      sendJson(res, 200, rows.map((r) => ({ ...r, mine: !!r.mine, blocked: !!r.blocked })));
    },

    'GET /api/messages': (req, res, me, url) => {
      const peer = findPeer(me, url.searchParams.get('with'));
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare(`
        SELECT id, sender_id = ? AS mine, body, kind, attachment_id AS attachment, created_at AS at FROM messages
        WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND id < ?
        ORDER BY id DESC LIMIT 50`).all(me.id, me.id, peer.id, peer.id, me.id, before);
      db.prepare('UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL').run(Date.now(), peer.id, me.id);
      sendJson(res, 200, { peer: { ...peer, avatar: avatarOf(peer.id) }, messages: rows.reverse().map((r) => ({ ...r, mine: !!r.mine })) });
    },

    'POST /api/messages': async (req, res, me) => {
      const { to, body, attachment } = await readJson(req);
      const peer = findPeer(me, to);
      const text = String(body ?? '').trim();
      const att = attachmentOf(me, attachment);
      if ((!text && !att) || text.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      if (peer.is_system) throw new HttpError(403, 'Scrxaper Teams sends notices only and does not read replies.');
      if (isBlocked(me.id, peer.id)) throw new HttpError(403, "You can't message this user.");
      if (!canMessage(me.id, peer.id)) throw new HttpError(403, "This person isn't accepting messages from you.");
      if (me.is_bot) {
        if (!db.prepare('SELECT 1 FROM messages WHERE sender_id = ? AND recipient_id = ?').get(peer.id, me.id)) throw new HttpError(403, 'Bots can only reply to people who messaged them first.');
        if (limited(`bot:${me.id}`, 60, 60000)) throw new HttpError(429, 'Slow down.');
      }
      const at = Date.now();
      const { lastInsertRowid } = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at, attachment_id) VALUES (?, ?, ?, ?, ?)')
        .run(me.id, peer.id, text, at, att);
      const id = Number(lastInsertRowid);
      push(peer.id, 'message', { id, from: me.username, body: text, at, attachment: att });
      push(me.id, 'message', { id, from: me.username, to: peer.username, body: text, at, attachment: att });
      if (peer.is_bot) deliver(peer.id, { type: 'message', scope: 'dm', id, from: me.username, fromName: me.display_name, body: text, at });
      sendJson(res, 201, { id, body: text, at, mine: true });
    },

    'POST /api/block': async (req, res, me) => {
      const { username, blocked } = await readJson(req);
      const peer = findPeer(me, username);
      if (blocked) db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(me.id, peer.id);
      else db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(me.id, peer.id);
      sendJson(res, 200, { blocked: !!blocked });
    },

    'GET /api/events': (req, res, me) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (!streams.has(me.id)) streams.set(me.id, new Set());
      streams.get(me.id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        streams.get(me.id)?.delete(res);
      });
    },
  };

  const serveStatic = async (res, pathname) => {
    const file = path.normalize(pathname === '/' ? '/index.html' : pathname);
    const full = path.join(publicDir, file);
    if (!full.startsWith(publicDir + path.sep)) throw new HttpError(404, 'Not found');
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'Content-Type': mime[path.extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch { throw new HttpError(404, 'Not found'); }
  };

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    try {
      if (url.pathname === '/healthz') {
        db.prepare('SELECT 1').get();
        return sendJson(res, 200, { status: 'ok' });
      }
      if (url.pathname.startsWith('/files/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        const viewer = currentUser(req);
        if (!viewer) throw new HttpError(401, 'Sign in required.');
        const id = url.pathname.slice(7);
        const file = /^[a-f0-9]{32}$/.test(id) && db.prepare('SELECT mime, kind, user_id AS owner FROM uploads WHERE id = ?').get(id);
        if (!file || (file.kind === 'attachment' && !canSeeAttachment(viewer, id, file.owner))) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=86400, immutable' });
        return res.end(readFileSync(path.join(uploadDir, id)));
      }
      if (url.pathname.startsWith('/api/')) {
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'Not found');
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'scrxaper' && !req.headers.authorization) throw new HttpError(403, 'Forbidden');
        const open = url.pathname === '/api/register' || url.pathname === '/api/login' || url.pathname === '/api/logout';
        const me = open ? null : currentUser(req);
        if (!open && !me) throw new HttpError(401, 'Sign in required.');
        return await handler(req, res, me, url);
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(JSON.stringify({ level: 'error', requestId, path: url.pathname, message: err.message }));
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong.' : err.message });
    }
  });

  const close = () => new Promise((resolve) => {
    clearInterval(birthdayTimer);
    for (const set of streams.values()) for (const res of set) res.end();
    server.close(() => { db.close(); resolve(); });
    server.closeAllConnections?.();
  });
  return { server, db, close, runBirthdays };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: `listening on ${port}` })));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}
