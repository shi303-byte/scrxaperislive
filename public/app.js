const $ = (id) => document.getElementById(id);
const state = { group: null, role: null, me: null, peer: null, blocked: false, registering: false, events: null };

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper' },
    body: options.body && JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function renderConversations(list) {
  const ul = $('conversations');
  ul.replaceChildren(...list.map((c) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-current', String(state.peer === c.username));
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: c.displayName });
    const snip = Object.assign(document.createElement('span'), { className: 'snippet', textContent: (c.mine ? 'You: ' : '') + c.body });
    btn.append(avatarEl(c.avatar, c.displayName, 36), name, snip);
    if (c.unread) btn.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: c.unread }));
    btn.addEventListener('click', () => openThread(c.username));
    li.append(btn);
    return li;
  }));
  $('list-empty').hidden = list.length > 0;
}

const refreshList = () => Promise.all([api('/api/conversations').then(renderConversations), refreshGroups(), refreshCommunities()]);

async function refreshGroups() {
  const groups = await api('/api/groups');
  $('groups').replaceChildren(...groups.map((g) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-current', String(state.group === g.id));
    btn.append(avatarEl(g.icon, g.name, 36, true), Object.assign(document.createElement('span'), { className: 'name', textContent: g.name }),
      Object.assign(document.createElement('span'), { className: 'snippet', textContent: `${g.members} members${g.body ? ' · ' + g.body : ''}` }));
    btn.addEventListener('click', () => openGroup(g.id));
    li.append(btn);
    return li;
  }));
}

async function openGroup(id) {
  $('thread-error').textContent = '';
  try {
    const data = await api(`/api/group-messages?group=${id}`);
    state.group = id; state.peer = null; state.channel = null; state.role = data.role; state.groupData = data;
    $('peer-pfp').replaceChildren(avatarEl(data.group.icon, data.group.name, 30, true));
    $('peer-name').textContent = `${data.group.name} · ${data.members.length} members`;
    $('messages').replaceChildren();
    data.messages.forEach((m) => appendMessage({ ...m, body: m.body }));
    $('composer').hidden = false; $('block').hidden = true; $('leave').hidden = false;
    $('add').hidden = $('invite').hidden = data.role !== 'admin';
    $('app').classList.add('reading');
    refreshGroups();
    $('composer').elements.body.focus();
  } catch (err) { $('thread-error').textContent = err.message; refreshGroups(); }
}

function appendMessage(m) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.mine ? ' mine' : '') + (m.kind && m.kind !== 'text' ? ` ${m.kind}` : '');
  el.dataset.id = m.id;
  const box = document.createElement('div');
  const openProfile = () => showProfile(m.from);
  if (!m.mine && m.name) box.append(Object.assign(document.createElement('strong'), { className: 'who', textContent: m.name, onclick: openProfile }));
  if (m.attachment) {
    const img = Object.assign(document.createElement('img'), { src: `/files/${m.attachment}`, alt: 'Image attachment', loading: 'lazy', className: 'shot' });
    img.addEventListener('load', () => el.scrollIntoView({ block: 'end' }));
    box.append(img);
  }
  if (m.body) box.append(document.createTextNode(m.body));
  box.append(Object.assign(document.createElement('time'), { textContent: timeOf(m.at) }));
  if (!m.mine && m.name) {
    el.classList.add('with-pfp');
    el.append(Object.assign(avatarEl(m.avatar, m.name, 32), { onclick: openProfile, style: 'cursor:pointer' }));
  }
  el.append(box);
  if (state.channel && (m.mine || state.canModerate)) {
    const del = Object.assign(document.createElement('button'), { className: 'del', type: 'button', textContent: 'Delete', ariaLabel: 'Delete message' });
    del.addEventListener('click', () => api('/api/channel-message-delete', { body: { channel: state.channel, id: m.id } }).catch((err) => { $('thread-error').textContent = err.message; }));
    box.prepend(del);
  }
  $('messages').append(el);
  el.scrollIntoView({ block: 'end' });
}

async function openThread(username) {
  $('thread-error').textContent = '';
  try {
    const { peer, messages } = await api(`/api/messages?with=${encodeURIComponent(username)}`);
    state.peer = peer.username; state.group = null; state.channel = null;
    $('add').hidden = $('invite').hidden = $('leave').hidden = true;
    $('peer-pfp').replaceChildren(avatarEl(peer.avatar, peer.display_name, 30));
    $('peer-name').textContent = peer.display_name;
    $('messages').replaceChildren();
    messages.forEach(appendMessage);
    $('composer').hidden = peer.username === 'scrxaper';
    $('block').hidden = peer.username === 'scrxaper';
    const convo = (await api('/api/conversations')).find((c) => c.username === peer.username);
    state.blocked = !!convo?.blocked;
    $('block').textContent = state.blocked ? 'Unblock' : 'Block';
    $('app').classList.add('reading');
    renderConversations(await api('/api/conversations'));
    $('composer').elements.body.focus();
  } catch (err) {
    $('thread-error').textContent = err.status === 404 ? `No user called “${username}”.` : err.message;
  }
}

function connectEvents() {
  state.events?.close();
  state.events = new EventSource('/api/events');
  state.events.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.from !== state.me) maybeNotify(m.group ? 'group' : 'dm', m.group ?? m.from, m.name ?? m.from, m.body);
    if (m.group) {
      if (m.group === state.group && !document.querySelector(`[data-id="${m.id}"]`)) appendMessage({ ...m, mine: m.from === state.me, body: m.body });
      return refreshGroups();
    }
    const peer = m.to ?? m.from;
    if (peer === state.peer && !document.querySelector(`[data-id="${m.id}"]`)) {
      appendMessage({ ...m, mine: m.from === state.me });
      if (m.from !== state.me) api(`/api/messages?with=${peer}`).then(refreshList);
    }
    refreshList();
  });
  const shown = (m) => ({ ...m, mine: m.from === state.me, body: m.body });
  state.events.addEventListener('call', (e) => onCallEvent(JSON.parse(e.data)));
  state.events.addEventListener('channel-message', (e) => {
    const m = JSON.parse(e.data);
    if (m.from !== state.me) maybeNotify('channel', m.channel, m.name, m.body);
    if (m.channel === state.channel && !document.querySelector(`[data-id="${m.id}"]`)) appendMessage(shown(m));
  });
  state.events.addEventListener('channel-delete', (e) => {
    const m = JSON.parse(e.data);
    if (m.channel === state.channel) document.querySelector(`[data-id="${m.id}"]`)?.remove();
  });
  state.events.addEventListener('community', () => {
    refreshCommunities();
    if (state.channel) openChannel(state.channel).catch(() => {});
  });
  state.events.addEventListener('group', (e) => {
    const g = JSON.parse(e.data);
    refreshGroups();
    if (g.id === state.group) openGroup(g.id).catch(() => {});
  });
  state.events.addEventListener('open', () => refreshList().catch(() => {}));
}

async function enterApp(me) {
  state.me = me.username;
  $('me').textContent = me.displayName;
  $('me-pfp').replaceChildren(avatarEl(me.avatar, me.displayName, 30));
  $('auth').hidden = true;
  state.isOwner = !!me.isOwner; state.birthday = me.birthday; state.prefs = me.prefs; applyPrefs(me.prefs);
  state.privacy = me.privacy; state.sound = me.sound; state.ignored = new Set(me.ignored ?? []); state.mutes = new Set((me.mutes ?? []).map((x) => `${x.kind}:${x.target}`));
  $('open-owner').hidden = !me.isOwner;
  $('app').hidden = false;
  await refreshList();
  connectEvents();
}

function setMode(registering) {
  state.registering = registering;
  $('display-field').hidden = !registering;
  $('auth-form').querySelector('button').textContent = registering ? 'Create account' : 'Log in';
  $('auth-toggle').textContent = registering ? 'Have an account? Log in' : 'New here? Create an account';
  $('auth-form').elements.password.autocomplete = registering ? 'new-password' : 'current-password';
}

$('auth-toggle').addEventListener('click', () => setMode(!state.registering));
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('auth-error').textContent = '';
  try {
    enterApp(await api(state.registering ? '/api/register' : '/api/login', { body: f }));
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
});

$('new-chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const to = e.target.elements.to.value.trim().toLowerCase();
  if (to) openThread(to).then(() => { e.target.reset(); });
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.elements.body;
  const body = input.value.trim();
  if (!body && !state.pending) return;
  $('thread-error').textContent = '';
  try {
    await (state.channel ? api('/api/channel-messages', { body: { channel: state.channel, body, attachment: state.pending } })
      : state.group ? api('/api/group-messages', { body: { group: state.group, body, attachment: state.pending } }) : api('/api/messages', { body: { to: state.peer, body, attachment: state.pending } }));
    input.value = '';
    state.pending = null;
    $('attach-note').hidden = true;
  } catch (err) {
    $('thread-error').textContent = err.message;
  }
});

$('block').addEventListener('click', async () => {
  state.blocked = !state.blocked;
  await api('/api/block', { body: { username: state.peer, blocked: state.blocked } });
  $('block').textContent = state.blocked ? 'Unblock' : 'Block';
  refreshList();
});

$('new-group').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  if (!name) return;
  const g = await api('/api/groups', { body: { name } });
  e.target.reset();
  openGroup(g.id);
});
const act = (path, extra) => api(path, { body: { group: state.group, ...extra } }).catch((err) => { $('thread-error').textContent = err.message; });
$('add').addEventListener('click', () => { const u = prompt('Username to add'); if (u) act('/api/group-members', { username: u.trim() }); });
$('invite').addEventListener('click', async () => {
  const r = await act('/api/group-invite');
  if (r) prompt('Invite code (valid 7 days). Share it; they paste it into “Join with code”.', r.code);
});
$('leave').addEventListener('click', async () => { if (confirm('Leave this group?')) { await act('/api/group-leave'); state.group = null; $('composer').hidden = true; $('peer-name').textContent = 'Select a conversation'; $('leave').hidden = $('add').hidden = $('invite').hidden = true; $('messages').replaceChildren(); refreshGroups(); } });
$('back').addEventListener('click', () => { $('app').classList.remove('reading'); });

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { body: {} });
  state.events?.close();
  location.reload();
});

api('/api/me').then(enterApp).catch(() => { $('auth').hidden = false; });

const h = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const panel = $('panel');
const show = (...nodes) => { $('panel-body').replaceChildren(...nodes); if (!panel.open) panel.showModal(); };
$('panel-close').addEventListener('click', () => panel.close());
const field = (name, placeholder, extra = {}) => h('input', { name, placeholder, ariaLabel: placeholder, autocomplete: 'off', ...extra });
const form = (onSubmit, ...kids) => {
  const f = h('form', {}, ...kids);
  f.addEventListener('submit', (e) => { e.preventDefault(); onSubmit(Object.fromEntries(new FormData(f))).catch((err) => alert(err.message)); });
  return f;
};

$('join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = e.target.elements.code.value.trim();
  try {
    const { id } = await api('/api/group-join', { body: { code } });
    e.target.reset();
    openGroup(id);
  } catch {
    try {
      const { id } = await api('/api/community-join', { body: { code } });
      e.target.reset();
      refreshCommunities();
      showCommunity(id);
    } catch (err) { $('thread-error').textContent = err.message; }
  }
});

$('open-me').addEventListener('click', () => {
  const [mm, dd] = (state.birthday ?? '').split('-');
  show(h('h2', {}, 'Your profile'), h('h3', {}, 'Birthday'),
    h('p', { className: 'empty' }, 'Optional. Only Scrxaper Teams uses it, to send you a card on the day. It is not shown to anyone else.'),
    form(async (v) => { const r = await api('/api/birthday', { body: { month: v.month, day: v.day } }); state.birthday = r.birthday; panel.close(); },
      field('month', 'Month (1–12)', { type: 'number', min: 1, max: 12, value: mm ? Number(mm) : '', required: true }),
      field('day', 'Day', { type: 'number', min: 1, max: 31, value: dd ? Number(dd) : '', required: true }),
      h('button', { className: 'primary', type: 'submit' }, 'Save')),
    h('button', { className: 'link', type: 'button', onclick: async () => { await api('/api/birthday', { body: { clear: true } }); state.birthday = null; panel.close(); } }, 'Remove birthday'),
    h('h3', {}, 'Delete account'),
    h('p', { className: 'empty' }, 'Permanently deletes your account, your messages, your uploads and your buddy chats. Groups you leave hand over to another member. You must delete communities you own first.'),
    form(async (v) => { if (confirm('Delete your account for good?')) { await api('/api/account/delete', { body: { password: v.password } }); location.reload(); } },
      field('password', 'Your password', { type: 'password', required: true, autocomplete: 'current-password' }), h('button', { className: 'primary', type: 'submit' }, 'Delete my account')));
});

async function showBots(created) {
  const bots = await api('/api/bots');
  show(h('h2', {}, 'Your bots'),
    h('p', { className: 'empty' }, 'A bot is an account your own program controls. Send its token as “Authorization: Bot <token>”. Messages in its groups and DMs are POSTed to your https webhook, signed with X-Scrxaper-Signature (HMAC-SHA256).'),
    ...(created ? [h('h3', {}, 'Save these now. They are shown once.'), h('code', {}, `Token: ${created.token}`), h('code', {}, `Webhook secret: ${created.webhookSecret}`)] : []),
    ...bots.map((b) => h('div', { className: 'row' }, h('span', {}, `${b.displayName} (@${b.username})`, h('br'), h('small', {}, b.webhookUrl || 'No webhook set')),
      h('span', {},
        h('button', { className: 'link', type: 'button', onclick: async () => { const url = prompt('Webhook URL (https). Leave empty to clear.', b.webhookUrl || ''); if (url !== null) { await api('/api/bots/webhook', { body: { bot: b.username, url } }).catch((e) => alert(e.message)); showBots(); } } }, 'Webhook'),
        h('button', { className: 'link', type: 'button', onclick: async () => { if (confirm('Replace the token? The old one stops working.')) { const r = await api('/api/bots/token', { body: { bot: b.username } }); show(h('h2', {}, 'New token'), h('code', {}, r.token)); } } }, 'New token'),
        h('button', { className: 'link', type: 'button', onclick: async () => { if (confirm(`Delete ${b.username}?`)) { await api('/api/bots/delete', { body: { bot: b.username } }); showBots(); } } }, 'Delete')))),
    h('h3', {}, 'Create a bot'),
    form(async (v) => showBots(await api('/api/bots', { body: { name: v.name, displayName: v.displayName } })), field('name', 'Bot username', { required: true }), field('displayName', 'Display name'), h('button', { className: 'primary', type: 'submit' }, 'Create')));
}
$('open-bots').addEventListener('click', () => showBots());

async function showOwner(query = '') {
  const [s, users] = await Promise.all([api('/api/owner/stats'), api(`/api/owner/users?q=${encodeURIComponent(query)}`)]);
  const tiles = [['Users', s.users], ['New (7 days)', s.newUsers7d], ['Online now', s.online], ['Messages', s.messages], ['Messages (24h)', s.messages24h], ['Groups', s.groups], ['Bots', s.bots], ['Suspended', s.banned]];
  const act = (path, label, withReason) => async (u) => {
    const reason = withReason ? prompt(`${label} @${u}. Reason (the user will see it):`) : '';
    if (withReason && !reason) return;
    await api(path, { body: { username: u, reason } }).catch((e) => alert(e.message));
    showOwner(query);
  };
  show(h('h2', {}, 'Owner dashboard'),
    h('div', { className: 'stats' }, ...tiles.map(([k, v]) => h('div', {}, h('b', {}, String(v)), h('span', {}, k)))),
    h('h3', {}, 'Announce to everyone'),
    form(async (v) => { const r = await api('/api/owner/announce', { body: { text: v.text } }); alert(`Sent to ${r.sent} users.`); showOwner(query); }, field('text', 'What’s new?', { required: true }), h('button', { className: 'primary', type: 'submit' }, 'Send')),
    h('h3', {}, 'Users'),
    form(async (v) => showOwner(v.q), field('q', 'Search username', { value: query }), h('button', { className: 'link', type: 'submit' }, 'Search')),
    ...users.map((u) => h('div', { className: 'row' }, h('span', {}, `@${u.username}${u.isBot ? ' (bot)' : ''}`, h('br'), h('small', {}, u.bannedAt ? 'Suspended' : `Joined ${new Date(u.createdAt).toLocaleDateString()}`)),
      h('span', {}, h('button', { className: 'link', type: 'button', onclick: () => act('/api/owner/warn', 'Warn', true)(u.username) }, 'Warn'),
        u.bannedAt ? h('button', { className: 'link', type: 'button', onclick: () => act('/api/owner/unban', 'Restore')(u.username) }, 'Restore')
          : h('button', { className: 'link', type: 'button', onclick: () => act('/api/owner/ban', 'Suspend', true)(u.username) }, 'Suspend')))),
    h('h3', {}, 'Recent actions'),
    ...s.audit.map((a) => h('div', { className: 'row' }, h('span', {}, `${a.actor}: ${a.action} ${a.target ?? ''}`, h('br'), h('small', {}, a.detail ?? '')), h('small', {}, new Date(a.at).toLocaleString()))));
}
$('open-owner').addEventListener('click', () => showOwner());

async function refreshCommunities() {
  const list = await api('/api/communities');
  $('communities').replaceChildren(...list.map((c) => {
    const btn = h('button', { type: 'button' }, avatarEl(c.icon, c.name, 36, true), h('span', { className: 'name', textContent: c.name }), h('span', { className: 'snippet', textContent: `Community · ${c.members} members` }));
    btn.addEventListener('click', () => showCommunity(c.id));
    return h('li', {}, btn);
  }));
}

async function openChannel(id) {
  $('thread-error').textContent = '';
  try {
    const d = await api(`/api/channel-messages?channel=${id}`);
    state.channel = id; state.group = null; state.peer = null; state.canModerate = d.canModerate;
    $('peer-name').textContent = `# ${d.channel.name}${d.channel.topic ? ` · ${d.channel.topic}` : ''}`;
    $('messages').replaceChildren();
    d.messages.forEach((m) => appendMessage({ ...m, body: m.body }));
    $('composer').hidden = !d.canPost;
    $('block').hidden = $('add').hidden = $('invite').hidden = $('leave').hidden = true;
    $('app').classList.add('reading');
  } catch (err) {
    state.channel = null;
    $('composer').hidden = true;
    $('thread-error').textContent = err.message;
  }
}

const RANKS = { member: 0, moderator: 1, admin: 2, owner: 3 };
async function showCommunity(id) {
  const d = await api(`/api/community?id=${id}`).catch(() => null);
  if (!d) return panel.open && panel.close();
  const mine = Math.max(RANKS[d.role], d.myPerms.length ? 1 : 0);
  const act = (path, extra) => api(path, { body: { community: id, ...extra } }).then(() => showCommunity(id)).catch((e) => alert(e.message));
  const link = (label, onclick) => h('button', { className: 'link', type: 'button', onclick }, label);
  const memberTools = (m) => {
    if (m.username === state.me || RANKS[m.role] >= mine || mine < 1) return [];
    const tools = [link('Timeout', () => { const v = prompt('Minutes (0 clears)', '10'); if (v !== null) act('/api/community-timeout', { username: m.username, minutes: v }); }),
      link('Kick', () => { if (confirm(`Remove @${m.username}?`)) act('/api/community-kick', { username: m.username, reason: prompt('Reason (logged)') ?? '' }); })];
    if (mine >= 2) tools.push(link('Role', () => { const r = prompt('New role: member, moderator or admin', m.role); if (r) act('/api/community-role', { username: m.username, role: r.trim().toLowerCase() }); }),
      link('Ban', () => { if (confirm(`Ban @${m.username}?`)) act('/api/community-ban', { username: m.username, reason: prompt('Reason (logged)') ?? '' }); }));
    if (RANKS[d.role] >= 2 && d.roles.length) tools.push(link('Custom role', () => {
      const n = prompt(`Role (${d.roles.map((r) => r.name).join(', ')}). Leave empty to clear.`, m.customRole ?? '');
      if (n === null) return;
      const r = d.roles.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
      if (n.trim() && !r) return alert('No such role');
      act('/api/community-custom-role', { username: m.username, role: r ? r.id : null });
    }));
    return tools;
  };
  show(h('h2', {}, avatarEl(d.community.icon, d.community.name, 32, true), ' ', d.community.name), h('p', { className: 'empty' }, d.community.description || 'No description yet.'),
    h('h3', {}, 'Channels'),
    ...d.channels.map((c) => h('div', { className: 'row' }, link(`# ${c.name}`, () => { panel.close(); openChannel(c.id); }),
      h('small', {}, [c.kind === 'announcement' && 'announcements', c.readOnly && 'read-only', c.private && 'staff only'].filter(Boolean).join(' · ') || c.topic))),
    ...(mine >= 2 ? [form((v) => act('/api/channels', { name: v.name, private: !!v.private, readOnly: !!v.readOnly }), field('name', 'New channel name', { required: true }),
      h('label', {}, h('input', { type: 'checkbox', name: 'private' }), ' staff only'), h('label', {}, h('input', { type: 'checkbox', name: 'readOnly' }), ' read-only'),
      h('button', { className: 'primary', type: 'submit' }, 'Add'))] : []),
    h('h3', {}, `Members (${d.members.length})`),
    ...d.members.map((m) => h('div', { className: 'row' }, avatarEl(m.avatar, m.name, 28), h('span', { style: 'flex:1' }, `${m.name} (@${m.username})`, h('br'), h('small', {}, m.role + (m.customRole ? ` · ${m.customRole}` : '') + (m.timedOut ? ' · timed out' : ''))), h('span', {}, ...memberTools(m)))),
    ...(RANKS[d.role] >= 2 ? [h('h3', {}, 'Custom roles'),
      ...d.roles.map((r) => h('div', { className: 'row' }, h('span', {}, r.name, h('br'), h('small', {}, r.perms.join(', '))), link('Delete', () => act('/api/community-role-delete', { role: r.id })))),
      form((v) => act('/api/community-roles', { name: v.name, perms: PERMS.filter((p) => v[p]) }), field('name', 'New role name', { required: true }),
        ...PERMS.map((p) => h('label', {}, h('input', { type: 'checkbox', name: p }), p.replace('_', ' '))), h('button', { className: 'primary', type: 'submit' }, 'Create role'))] : []),
    ...(RANKS[d.role] >= 2 ? [h('h3', {}, 'Community profile'),
      form((v) => act('/api/community-settings', { description: v.description, public: !!v.public }), field('description', 'Short description', { value: d.community.description ?? '' }),
        h('label', {}, h('input', { type: 'checkbox', name: 'public', checked: !!d.community.public }), ' Show in Discover'), h('button', { className: 'primary', type: 'submit' }, 'Save')),
      h('label', {}, 'Icon ', iconInput(`community-icon&id=${id}`, () => showCommunity(id)))] : []),
    h('h3', {}, 'Manage'),
    h('div', { className: 'row' },
      ...(mine >= 2 ? [link('Invite code', async () => { const r = await api('/api/community-invite', { body: { community: id } }); prompt('Invite code (valid 7 days). Paste it into “Join with an invite code”.', r.code); })] : []),
      ...(mine >= 1 ? [link('Moderation log', async () => {
        const log = await api(`/api/community-log?id=${id}`);
        show(h('h2', {}, 'Moderation log'), ...(log.length ? log.map((l) => h('div', { className: 'row' }, h('span', {}, `${l.actor}: ${l.action} ${l.target ?? ''}`, h('br'), h('small', {}, l.detail ?? '')), h('small', {}, new Date(l.at).toLocaleString()))) : [h('p', { className: 'empty' }, 'Nothing has been logged yet.')]), link('Back', () => showCommunity(id)));
      })] : []),
      mine === 3 ? link('Delete community', async () => { if (confirm('Delete this community and all its messages?')) { await act('/api/community-delete', {}); panel.close(); refreshCommunities(); } })
        : link('Leave', async () => { if (confirm('Leave this community?')) { await act('/api/community-leave', {}); panel.close(); refreshCommunities(); } })));
}

$('new-community').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  if (!name) return;
  try {
    const { id } = await api('/api/communities', { body: { name } });
    e.target.reset();
    await refreshCommunities();
    showCommunity(id);
  } catch (err) { $('thread-error').textContent = err.message; }
});

const resolveTheme = (t) => (t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t);
function applyPrefs(p) {
  if (!p) return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(p.theme);
  root.dataset.density = p.density;
  root.dataset.motion = p.reduceMotion ? 'reduced' : 'full';
  root.dataset.glass = p.plain ? 'off' : 'on';
  if (p.accent) root.style.setProperty('--accent', p.accent); else root.style.removeProperty('--accent');
}

async function showStudio() {
  const [shop, profile] = await Promise.all([api('/api/shop'), api('/api/profile')]);
  const p = state.prefs ?? { theme: 'dark', density: 'comfortable', accent: null, reduceMotion: false };
  const reload = () => showStudio().catch((e) => alert(e.message));
  const select = (name, value, options) => h('select', { name, ariaLabel: name, value }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  const read = (f) => { const v = Object.fromEntries(new FormData(f)); return { theme: v.theme, density: v.density, accent: v.useAccent ? v.accent : null, reduceMotion: !!v.reduceMotion, plain: !!v.plain }; };
  const look = form(async (v) => { state.prefs = await api('/api/prefs', { body: read(look) }); applyPrefs(state.prefs); },
    h('label', {}, 'Theme ', select('theme', p.theme, [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']])),
    h('label', {}, 'Density ', select('density', p.density, [['comfortable', 'Comfortable'], ['compact', 'Compact']])),
    h('label', {}, h('input', { type: 'checkbox', name: 'useAccent', checked: !!p.accent }), ' Accent ', h('input', { type: 'color', name: 'accent', value: p.accent || '#c8d6e5', style: 'width:44px;padding:0' })),
    h('label', {}, h('input', { type: 'checkbox', name: 'reduceMotion', checked: p.reduceMotion }), ' Reduce motion'),
    h('label', {}, h('input', { type: 'checkbox', name: 'plain', checked: !!p.plain }), ' Solid panels (turn off glass blur)'),
    h('button', { className: 'primary', type: 'submit' }, 'Save'));
  look.classList.add('stack');
  look.addEventListener('input', () => applyPrefs(read(look)));
  const about = form(async (v) => { await api('/api/profile', { body: v }); reload(); },
    field('displayName', 'Display name', { value: profile.displayName }), field('status', 'Status', { value: profile.status, maxLength: 60 }),
    h('textarea', { name: 'bio', placeholder: 'Bio', ariaLabel: 'Bio', maxLength: 200, value: profile.bio }), h('button', { className: 'primary', type: 'submit' }, 'Save profile'));
  about.classList.add('stack');
  const preview = (it) => {
    const s = h('div', { className: `swatch ${it.kind === 'frame' ? it.value : ''}` }, it.kind === 'frame' ? 'You' : it.kind === 'badge' ? it.value : profile.displayName.slice(0, 8));
    if (it.kind === 'name_color') s.style.color = it.value;
    return s;
  };
  const action = (it) => (!it.owned ? h('button', { className: 'primary', type: 'button', onclick: async () => { await api('/api/shop/buy', { body: { item: it.id } }).catch((e) => alert(e.message)); reload(); } }, `${it.price} ${shop.currency}`)
    : h('button', { className: 'link', type: 'button', onclick: async () => { await api(it.equipped ? '/api/shop/unequip' : '/api/shop/equip', { body: { item: it.id, kind: it.kind } }); reload(); } }, it.equipped ? 'Unequip' : 'Equip'));
  const sendImage = (kind) => h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', ariaLabel: `Upload ${kind}`, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = await fetch(`/api/upload?kind=${kind}`, { method: 'POST', headers: { 'X-Requested-With': 'scrxaper', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!r.ok) alert((await r.json()).error);
    api('/api/me').then((m) => $('me-pfp').replaceChildren(avatarEl(m.avatar, m.displayName, 30)));
    reload();
  } });
  const dropImage = (kind, has) => has ? h('button', { className: 'link', type: 'button', onclick: async () => { await api('/api/upload/delete', { body: { kind } }); reload(); } }, `Remove ${kind}`) : '';
  const frame = profile.cosmetics.find((c) => c.kind === 'frame');
  const card = h('div', { className: 'profile-card' },
    h('div', { className: 'banner', style: profile.banner ? `background-image:url(/files/${profile.banner})` : '' }),
    profile.avatar ? h('img', { className: `avatar ${frame?.value ?? ''}`, src: `/files/${profile.avatar}`, alt: 'Your avatar', width: 64, height: 64 }) : h('div', { className: `avatar ${frame?.value ?? ''}` }, profile.displayName.slice(0, 1).toUpperCase()),
    h('div', { className: 'card-actions' }, h('label', {}, 'Avatar ', sendImage('avatar')), dropImage('avatar', profile.avatar), h('label', {}, 'Banner ', sendImage('banner')), dropImage('banner', profile.banner)),
    h('p', { className: 'empty' }, 'PNG, JPEG, GIF or WebP. Avatars up to 2 MB, banners up to 4 MB, at most 4096 px. GIFs may be animated; they cannot be paused by Reduce motion yet.'));
  const sound = form(async (v) => { state.sound = await api('/api/sound', { body: { tone: v.tone, volume: Number(v.volume) } }); },
    h('label', {}, 'Message sound ', select('tone', state.sound?.tone ?? 'chime', [['chime', 'Chime'], ['drop', 'Drop'], ['pluck', 'Pluck'], ['none', 'Silent']])),
    h('label', {}, 'Volume ', h('input', { type: 'range', name: 'volume', min: 0, max: 100, value: state.sound?.volume ?? 60 })),
    h('button', { className: 'link', type: 'button', onclick: () => playTone(sound.elements.tone.value, Number(sound.elements.volume.value)) }, 'Play preview'),
    h('button', { className: 'primary', type: 'submit' }, 'Save'));
  sound.classList.add('stack');
  const privacy = form(async (v) => { state.privacy = await api('/api/privacy', { body: { whoCanMessage: v.who, previews: !!v.previews, dnd: !!v.dnd } }); },
    h('label', {}, 'Who can start a chat with you ', select('who', state.privacy?.whoCanMessage ?? 'everyone', [['everyone', 'Everyone'], ['groups', 'People who share a group or community'], ['nobody', 'Nobody new']])),
    h('label', {}, h('input', { type: 'checkbox', name: 'previews', checked: state.privacy?.previews ?? true }), ' Show message text in desktop notifications'),
    h('label', {}, h('input', { type: 'checkbox', name: 'dnd', checked: !!state.privacy?.dnd }), ' Do not disturb'),
    h('button', { className: 'primary', type: 'submit' }, 'Save'),
    typeof Notification === 'undefined' ? '' : h('button', { className: 'link', type: 'button', onclick: async () => { alert(`Notifications: ${await Notification.requestPermission()}`); } }, 'Enable desktop notifications'));
  privacy.classList.add('stack');
  show(h('h2', {}, 'Studio'), h('h3', {}, 'Appearance'), look, h('h3', {}, 'Profile'), about,
    h('h3', {}, 'Sounds'), sound, h('h3', {}, 'Privacy and notifications'), privacy, h('h3', {}, 'Avatar and banner'), card, h('h3', {}, 'Badges'), ...(profile.badges.length ? profile.badges.map((b) => h('span', { className: 'chip', title: b.description }, b.name)) : [h('p', { className: 'empty' }, 'No badges yet.')]),
    h('h3', {}, `${shop.currency}: ${shop.balance}`),
    h('p', { className: 'empty' }, `Earn ${shop.currency} with a daily check-in. Cosmetics never unlock features, and they are always labelled as cosmetic.`),
    h('button', { className: 'primary', type: 'button', onclick: async () => { await api('/api/sparks/daily', { body: {} }).catch((e) => alert(e.message)); reload(); } }, 'Claim daily reward'),
    h('h3', {}, 'Shop'),
    ...shop.items.map((it) => h('div', { className: 'item' }, preview(it), h('div', {}, h('strong', {}, it.name), h('p', {}, it.description), h('p', {}, it.kind.replace('_', ' '))), action(it))));
}
$('open-studio').addEventListener('click', () => showStudio().catch((e) => alert(e.message)));

document.addEventListener('visibilitychange', () => { document.documentElement.dataset.paused = String(document.hidden); });

const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
const mascot = () => svg(`<svg class="mascot" viewBox="0 0 72 72" role="img" aria-label="Scrxaper Buddy"><g class="sway">
  <g fill="#b7c9e6" opacity=".55"><ellipse cx="36" cy="12" rx="8" ry="11"/><ellipse cx="14" cy="30" rx="11" ry="8"/><ellipse cx="58" cy="30" rx="11" ry="8"/></g>
  <circle cx="36" cy="42" r="22" fill="#e8f1ff"/><circle cx="20" cy="50" r="12" fill="#e8f1ff"/><circle cx="52" cy="50" r="12" fill="#e8f1ff"/>
  <g fill="#1a1d24"><ellipse cx="28" cy="42" rx="4" ry="5.5"/><ellipse cx="44" cy="42" rx="4" ry="5.5"/></g>
  <g class="shine" fill="#fff" style="transform-origin:36px 42px"><circle cx="29.4" cy="40" r="1.4"/><circle cx="45.4" cy="40" r="1.4"/></g></g></svg>`);

function renderMarkdown(text) {
  const root = document.createElement('div');
  text.split(/```/).forEach((part, i) => {
    if (i % 2) { const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = part.replace(/^[\w+-]*\n/, ''); pre.append(code); root.append(pre); return; }
    part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).forEach((seg) => {
      if (/^`[^`]+`$/.test(seg)) root.append(Object.assign(document.createElement('code'), { textContent: seg.slice(1, -1) }));
      else if (/^\*\*[^*]+\*\*$/.test(seg)) root.append(Object.assign(document.createElement('strong'), { textContent: seg.slice(2, -2) }));
      else root.append(document.createTextNode(seg));
    });
  });
  return root;
}

const greeting = () => { const hr = new Date().getHours(); return hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
const buddy = { conv: null };

async function showBuddy(note) {
  const s = await api('/api/ai/settings');
  if (!s.available) return show(h('h2', {}, 'Buddy'), mascot(), h('p', { className: 'empty' }, 'The AI buddy is switched off on this server because AI_KEY_SECRET is not set. Ask the person who runs it to set it.'));
  if (!s.hasKey) return showBuddySetup(s, note);
  const convs = await api('/api/ai/conversations');
  const log = h('div', { className: 'buddy-log', role: 'log', ariaLive: 'polite' });
  const say = (role, content) => {
    const bubble = h('div', { className: `msg${role === 'user' ? ' mine' : ''}` });
    bubble.append(role === 'user' ? document.createTextNode(content) : renderMarkdown(content));
    if (role !== 'user') bubble.append(h('button', { className: 'copy', type: 'button', onclick: () => navigator.clipboard?.writeText(content) }, 'Copy'));
    log.append(bubble); bubble.scrollIntoView({ block: 'end' });
  };
  const open = async (id) => {
    buddy.conv = id; log.replaceChildren();
    if (id) (await api(`/api/ai/messages?conversation=${id}`)).messages.forEach((m) => say(m.role, m.content));
    else say('assistant', `${greeting()}, ${$('me').textContent}. I'm your buddy. What's on your mind?`);
  };
  const picker = h('select', { ariaLabel: 'Conversation' }, h('option', { value: '' }, 'New conversation'), ...convs.map((c) => h('option', { value: c.id, selected: String(c.id) === String(buddy.conv) }, c.title)));
  picker.addEventListener('change', () => open(picker.value ? Number(picker.value) : null));
  const err = h('p', { className: 'error', role: 'alert' });
  const composer = form(async (v) => {
    const text = v.text.trim(); if (!text) return;
    err.textContent = ''; say('user', text); composer.elements.text.value = '';
    try {
      const r = await api('/api/ai/chat', { body: { conversation: buddy.conv, text, localTime: new Date().toLocaleString() } });
      buddy.conv = r.conversation; say('assistant', r.reply);
    } catch (e) { err.textContent = `${e.message} Your message was not saved. Send it again to retry.`; }
  }, field('text', 'Message your buddy', { required: true, maxLength: 4000 }), h('button', { className: 'primary', type: 'submit' }, 'Send'));
  const cmd = (label, fn) => h('button', { className: 'link', type: 'button', onclick: fn }, label);
  show(h('h2', {}, 'Buddy'), mascot(), h('div', { className: 'buddy-chat' },
    h('div', { className: 'buddy-bar' }, picker,
      cmd('Rename', async () => { if (!buddy.conv) return; const t = prompt('New title'); if (t) { await api('/api/ai/rename', { body: { conversation: buddy.conv, title: t } }); showBuddy(); } }),
      cmd('Clear', async () => { if (buddy.conv && confirm('Clear this conversation?')) { await api('/api/ai/clear', { body: { conversation: buddy.conv } }); open(buddy.conv); } }),
      cmd('Delete', async () => { if (buddy.conv && confirm('Delete this conversation?')) { await api('/api/ai/delete', { body: { conversation: buddy.conv } }); buddy.conv = null; showBuddy(); } }),
      cmd('Settings', () => showBuddySetup(s))),
    log, err, composer));
  open(buddy.conv);
  if (note) err.textContent = note;
}

function showBuddySetup(s, note) {
  const msg = h('p', { className: 'error', role: 'alert' }, note || '');
  const f = form(async (v) => {
    msg.textContent = '';
    try {
      await api('/api/ai/settings', { body: { apiKey: v.apiKey, model: v.model, personality: v.personality } });
      await api('/api/ai/test', { body: {} });
      showBuddy();
    } catch (e) { msg.textContent = e.message; }
  }, field('apiKey', s.hasKey ? 'New API key (leave blank to keep the current one)' : 'Groq API key', { type: 'password', required: !s.hasKey, autocomplete: 'off' }),
    field('model', 'Model', { value: s.model, required: true }),
    h('textarea', { name: 'personality', placeholder: 'Optional personality, e.g. “short, dry humour”', ariaLabel: 'Personality', maxLength: 500, value: s.personality }),
    h('button', { className: 'primary', type: 'submit' }, 'Save and test connection'));
  f.classList.add('stack');
  show(h('h2', {}, 'Your buddy'), mascot(),
    h('p', { className: 'empty' }, 'Buddy’s replies come from Groq, an outside AI provider. What you type in a buddy chat, plus your chosen personality and your local time, is sent to Groq with your own API key. Nothing else about your account is sent. Scrxaper stores your key encrypted on the server and never shows it again. Groq handles that text under its own terms, so these chats are not private from Groq.'),
    f, msg,
    ...(s.hasKey ? [h('div', { className: 'buddy-bar' },
      h('button', { className: 'link', type: 'button', onclick: async () => { await api('/api/ai/key/delete', { body: {} }); showBuddy(); } }, 'Remove my key'),
      h('button', { className: 'link', type: 'button', onclick: async () => { if (confirm('Delete every buddy conversation?')) { await api('/api/ai/delete-all', { body: {} }); buddy.conv = null; showBuddy(); } } }, 'Delete all conversations'),
      h('button', { className: 'link', type: 'button', onclick: () => showBuddy() }, 'Back'))] : []));
}
$('open-buddy').addEventListener('click', () => showBuddy().catch((e) => alert(e.message)));

function maybeNotify(kind, target, title, body) {
  ping(kind, target);
  const p = state.privacy;
  if (typeof Notification === 'undefined' || !p || p.dnd || !document.hidden || Notification.permission !== 'granted' || state.mutes?.has(`${kind}:${target}`)) return;
  new Notification(title, { body: p.previews ? String(body).slice(0, 120) : 'New message', tag: `${kind}:${target}` });
}

const muteKey = () => (state.channel ? `channel:${state.channel}` : state.group ? `group:${state.group}` : state.peer ? `dm:${state.peer}` : null);
const syncThread = () => {
  const k = muteKey();
  $('mute').hidden = !k;
  $('tone').hidden = !k;
  $('call-audio').hidden = $('call-video').hidden = !(state.peer && state.peer !== 'scrxaper');
  $('ginfo').hidden = !state.group;
  $('mute').textContent = k && state.mutes?.has(k) ? 'Unmute' : 'Mute';
  document.querySelector('.thread').classList.toggle('active', !!k);
};
new MutationObserver(syncThread).observe($('peer-name'), { childList: true, characterData: true, subtree: true });
$('mute').addEventListener('click', async () => {
  const k = muteKey();
  if (!k) return;
  const [kind, target] = k.split(':');
  const muted = !state.mutes.has(k);
  await api('/api/mute', { body: { kind, target, muted } });
  if (muted) state.mutes.add(k); else state.mutes.delete(k);
  syncThread();
});

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = e.target.elements.q.value.trim();
  if (q.length < 2) return;
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const row = (title, sub, fn) => h('div', { className: 'row' }, h('button', { className: 'link', type: 'button', onclick: () => { panel.close(); fn(); } }, title), h('small', {}, sub));
    const openers = { dm: (m) => openThread(m.target), group: (m) => openGroup(Number(m.target)), channel: (m) => openChannel(Number(m.target)) };
    const section = (title, rows) => (rows.length ? [h('h3', {}, title), ...rows] : []);
    const all = [...section('People', r.people.map((p) => row(p.name, `@${p.username}`, () => openThread(p.username)))),
      ...section('Groups', r.groups.map((g) => row(`# ${g.name}`, 'Group', () => openGroup(g.id)))),
      ...section('Communities', r.communities.map((c) => row(c.name, 'Community', () => showCommunity(c.id)))),
      ...section('Channels', r.channels.map((c) => row(`# ${c.name}`, c.community, () => openChannel(c.id)))),
      ...section('Messages', r.messages.map((m) => row(m.body.slice(0, 90), `${m.where_} · ${new Date(m.at).toLocaleDateString()}`, () => openers[m.kind](m))))];
    show(h('h2', {}, `Results for “${q}”`), ...(all.length ? all : [h('p', { className: 'empty' }, 'Nothing found in the places you can see.')]));
  } catch (err) { $('thread-error').textContent = err.message; }
});

const PERMS = ['channels', 'invites', 'kick', 'timeout', 'delete_messages', 'log'];

const NOTES = { chime: [[880, 0], [1318, 0.13]], drop: [[660, 0], [440, 0.11]], pluck: [[523, 0], [659, 0.09], [784, 0.18]] };
function playTone(name, volume) {
  const notes = NOTES[name];
  if (!notes || !volume || typeof AudioContext === 'undefined') return;
  try {
    playTone.ctx ??= new AudioContext();
    const ctx = playTone.ctx;
    ctx.resume?.();
    for (const [freq, at] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + at;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max((volume / 100) * 0.25, 0.0002), t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    }
  } catch {
    // Browsers refuse audio until the person has interacted with the page.
  }
}
function ping(kind, target) {
  const s = state.sound;
  if (!s || state.privacy?.dnd || state.mutes?.has(`${kind}:${target}`)) return;
  const own = s.overrides.find((o) => o.kind === kind && String(o.target) === String(target));
  playTone(own?.tone ?? s.tone, s.volume);
}
$('tone').addEventListener('click', async () => {
  const k = muteKey();
  if (!k) return;
  const [kind, target] = k.split(':');
  const find = (s) => s.overrides.find((o) => o.kind === kind && o.target === target)?.tone;
  const pick = prompt('Sound for this conversation: chime, drop, pluck, none, or default', find(state.sound) ?? 'default');
  if (pick === null) return;
  try {
    state.sound = await api('/api/sound/override', { body: { kind, target, tone: pick.trim().toLowerCase() } });
    playTone(find(state.sound) ?? state.sound.tone, state.sound.volume);
  } catch (err) { alert(err.message); }
});

$('attach').addEventListener('click', () => $('attach-file').click());
$('attach-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('thread-error').textContent = '';
  const res = await fetch('/api/upload?kind=attachment', { method: 'POST', headers: { 'X-Requested-With': 'scrxaper', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('thread-error').textContent = data.error || 'Upload failed.'; return; }
  state.pending = data.id;
  Object.assign($('attach-note'), { hidden: false, textContent: `${file.name.slice(0, 18)} · remove` });
});
$('attach-note').addEventListener('click', () => { state.pending = null; $('attach-note').hidden = true; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function avatarEl(id, name, size = 36, icon = false) {
  const node = id
    ? Object.assign(document.createElement('img'), { src: `/files/${id}`, alt: '', loading: 'lazy' })
    : Object.assign(document.createElement('span'), { textContent: String(name ?? '?').replace(/^#\s*/, '').slice(0, 1).toUpperCase() });
  node.className = `pfp${icon ? ' icon' : ''}`;
  node.style.setProperty('--s', `${size}px`);
  return node;
}

function iconInput(query, done) {
  return h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', ariaLabel: 'Upload icon', onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = await fetch(`/api/upload?kind=${query}`, { method: 'POST', headers: { 'X-Requested-With': 'scrxaper', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!r.ok) alert((await r.json()).error);
    await refreshList();
    done();
  } });
}

async function showProfile(username) {
  const p = await api(`/api/profile?user=${encodeURIComponent(username)}`).catch(() => null);
  if (!p) return;
  const ignored = state.ignored.has(p.username);
  const frame = p.cosmetics.find((c) => c.kind === 'frame');
  const tint = p.cosmetics.find((c) => c.kind === 'name_color');
  const name = h('strong', {}, p.displayName);
  if (tint) name.style.color = tint.value;
  const avatar = avatarEl(p.avatar, p.displayName, 64);
  if (frame) avatar.classList.add(frame.value);
  show(h('div', { className: 'profile-card' }, h('div', { className: 'banner', style: p.banner ? `background-image:url(/files/${p.banner})` : '' }),
      h('div', { style: 'padding:0 14px' }, Object.assign(avatar, { style: 'margin-top:-32px;position:relative;border:3px solid var(--bg);--s:64px' }), h('div', {}, name, ' ', h('small', { className: 'empty' }, `@${p.username}`)),
        p.status ? h('p', {}, p.status) : '', p.bio ? h('p', { className: 'empty' }, p.bio) : '',
        ...p.badges.map((b) => h('span', { className: 'chip', title: b.description }, b.name)),
        ...p.cosmetics.filter((c) => c.kind === 'badge').map((c) => h('span', { className: 'chip', title: 'Cosmetic' }, c.value)))),
    ...(p.username === state.me ? [] : [h('div', { className: 'buddy-bar', style: 'margin-top:12px' },
      h('button', { className: 'primary', type: 'button', onclick: () => { panel.close(); openThread(p.username); } }, 'Message'),
      h('button', { className: 'link', type: 'button', onclick: async () => {
        await api('/api/ignore', { body: { username: p.username, ignored: !ignored } });
        if (ignored) state.ignored.delete(p.username); else state.ignored.add(p.username);
        showProfile(username);
      } }, ignored ? 'Stop ignoring' : 'Ignore'))]),
    ...(ignored ? [h('p', { className: 'empty' }, 'You will not see this person’s group or channel messages. Direct messages still arrive, without alerts.')] : []));
}

function showGroupInfo() {
  const d = state.groupData;
  if (!d) return;
  const admin = d.role === 'admin';
  const act = (path, extra) => api(path, { body: { group: state.group, ...extra } }).then(() => openGroup(state.group).then(showGroupInfo)).catch((e) => alert(e.message));
  show(h('h2', {}, avatarEl(d.group.icon, d.group.name, 32, true), ' ', d.group.name), h('p', { className: 'empty' }, d.group.description || 'No description yet.'),
    ...(admin ? [form((v) => act('/api/group-settings', { description: v.description, public: !!v.public }), field('description', 'Short description', { value: d.group.description ?? '' }),
      h('label', {}, h('input', { type: 'checkbox', name: 'public', checked: !!d.group.public }), ' Show in Discover'), h('button', { className: 'primary', type: 'submit' }, 'Save')),
      h('label', {}, 'Icon ', iconInput(`group-icon&id=${state.group}`, () => openGroup(state.group).then(showGroupInfo)))] : []),
    h('h3', {}, `Members (${d.members.length})`),
    ...d.members.map((m) => h('div', { className: 'row' }, avatarEl(m.avatar, m.name, 28), h('span', { style: 'flex:1' }, `${m.name} (@${m.username})`, h('br'), h('small', {}, m.role)),
      h('span', {}, h('button', { className: 'link', type: 'button', onclick: () => showProfile(m.username) }, 'Profile'),
        admin && m.username !== state.me ? h('button', { className: 'link', type: 'button', onclick: () => { if (confirm(`Remove @${m.username}?`)) act('/api/group-remove', { username: m.username }); } }, 'Remove') : ''))));
}
$('ginfo').addEventListener('click', showGroupInfo);

async function showDiscover(q = '') {
  const r = await api(`/api/discover?q=${encodeURIComponent(q)}`);
  const card = (kind, it) => h('div', { className: 'row discover' }, avatarEl(it.icon, it.name, 40, true),
    h('span', { style: 'flex:1' }, h('strong', {}, it.name), h('br'), h('small', {}, `${it.members} members${it.description ? ` · ${it.description}` : ''}`)),
    h('button', { className: it.joined ? 'link' : 'primary', type: 'button', onclick: async () => {
      if (!it.joined) await api('/api/discover/join', { body: { kind, id: it.id } }).catch((e) => alert(e.message));
      await refreshList();
      panel.close();
      if (kind === 'community') showCommunity(it.id); else openGroup(it.id);
    } }, it.joined ? 'Open' : 'Join'));
  show(h('h2', {}, 'Discover'), h('p', { className: 'empty' }, 'Public communities and groups. Admins choose whether theirs appears here.'),
    form((v) => showDiscover(v.q), field('q', 'Search by name or description', { value: q }), h('button', { className: 'primary', type: 'submit' }, 'Search')),
    h('h3', {}, 'Communities'), ...(r.communities.length ? r.communities.map((c) => card('community', c)) : [h('p', { className: 'empty' }, 'No public communities match.')]),
    h('h3', {}, 'Groups'), ...(r.groups.length ? r.groups.map((g) => card('group', g)) : [h('p', { className: 'empty' }, 'No public groups match.')]));
}
$('open-discover').addEventListener('click', () => showDiscover().catch((e) => alert(e.message)));

/* Calls */
const call = { id: null, peer: null, pc: null, local: null, screen: null, ring: null, queue: [], incoming: false, video: false, videoSender: null };
const sendSignal = (data) => api('/api/call/signal', { body: { call: call.id, data } }).catch(() => {});
const callStatus = (text) => { $('call-status').textContent = text; };

function startRinging() {
  stopRinging();
  const s = state.sound;
  const own = s?.overrides.find((o) => o.kind === 'dm' && o.target === call.peer);
  const tone = own?.tone ?? s?.tone ?? 'chime';
  if (!s || state.privacy?.dnd || tone === 'none') return;
  playTone(tone, s.volume);
  call.ring = setInterval(() => playTone(tone, s.volume), 1800);
}
function stopRinging() { clearInterval(call.ring); call.ring = null; }

function cleanupCall() {
  stopRinging();
  call.pc?.close();
  [call.local, call.screen].forEach((stream) => stream?.getTracks().forEach((t) => t.stop()));
  Object.assign(call, { id: null, peer: null, pc: null, local: null, screen: null, queue: [], incoming: false, videoSender: null });
  $('call').hidden = true;
  $('remote-video').srcObject = $('local-video').srcObject = null;
  Object.assign($('call-mic'), { textContent: 'Mute' });
  Object.assign($('call-cam'), { textContent: 'Camera off' });
  Object.assign($('call-share'), { textContent: 'Share screen' });
}

async function prepareCall(video, attach = true) {
  const { iceServers } = await api('/api/ice');
  try { call.local = await navigator.mediaDevices.getUserMedia({ audio: true, video }); }
  catch (err) { if (!video) throw err; call.local = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  $('local-video').srcObject = call.local;
  const pc = new RTCPeerConnection({ iceServers });
  call.pc = pc;
  const remote = new MediaStream();
  $('remote-video').srcObject = remote;
  if (attach) {
    call.local.getAudioTracks().forEach((t) => pc.addTrack(t, call.local));
    call.videoSender = pc.addTransceiver(call.local.getVideoTracks()[0] ?? 'video', { direction: 'sendrecv' }).sender;
  }
  pc.ontrack = (e) => remote.addTrack(e.track);
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') callStatus('Connected');
    if (pc.connectionState === 'failed') { callStatus('Connection failed. A TURN server may be needed on this network.'); }
  };
  $('call-cam').hidden = !call.local.getVideoTracks().length;
}

function openCallScreen(name, avatar, status, incoming) {
  $('call-name').textContent = name;
  $('call-pfp').replaceChildren(avatarEl(avatar, name, 40));
  $('call-accept').hidden = !incoming;
  $('call-share').hidden = !navigator.mediaDevices?.getDisplayMedia;
  callStatus(status);
  $('call').hidden = false;
}

async function startCall(video) {
  if (call.id || !state.peer) return;
  const peerName = $('peer-name').textContent;
  try {
    await prepareCall(video);
    const r = await api('/api/call/start', { body: { to: state.peer, video } });
    Object.assign(call, { id: r.id, peer: state.peer, video });
    openCallScreen(peerName, null, 'Ringing…', false);
    startRinging();
  } catch (err) {
    cleanupCall();
    $('thread-error').textContent = err.name === 'NotAllowedError' || err.name === 'NotFoundError' ? 'Allow microphone access (and a camera for video) to call.' : err.message;
  }
}

async function onSignal(data) {
  if (!call.pc) return;
  if (data.description) {
    await call.pc.setRemoteDescription(data.description);
    for (const c of call.queue.splice(0)) await call.pc.addIceCandidate(c).catch(() => {});
    if (data.description.type === 'offer') {
      for (const t of call.pc.getTransceivers()) {
        const isAudio = t.receiver.track.kind === 'audio';
        await t.sender.replaceTrack(isAudio ? call.local.getAudioTracks()[0] : call.local.getVideoTracks()[0] ?? null);
        t.direction = 'sendrecv';
        if (!isAudio) call.videoSender = t.sender;
      }
      await call.pc.setLocalDescription(await call.pc.createAnswer());
      sendSignal({ description: call.pc.localDescription });
    }
  } else if (data.candidate) {
    if (call.pc.remoteDescription) call.pc.addIceCandidate(data.candidate).catch(() => {}); else call.queue.push(data.candidate);
  }
}

function onCallEvent(m) {
  if (m.type === 'incoming') {
    if (call.id) return;
    Object.assign(call, { id: m.id, peer: m.from, incoming: true, video: m.video });
    openCallScreen(m.name, m.avatar, m.video ? 'Incoming video call' : 'Incoming call', true);
    startRinging();
    maybeNotify('dm', m.from, m.name, 'Incoming call');
  } else if (m.id !== call.id) return;
  else if (m.type === 'answered') {
    stopRinging();
    callStatus('Connecting…');
    call.pc.createOffer().then(async (o) => { await call.pc.setLocalDescription(o); sendSignal({ description: call.pc.localDescription }); });
  } else if (m.type === 'signal') onSignal(m.data).catch(() => {});
  else if (m.type === 'ended') cleanupCall();
}

$('call-audio').addEventListener('click', () => startCall(false));
$('call-video').addEventListener('click', () => startCall(true));
$('call-accept').addEventListener('click', async () => {
  stopRinging();
  try {
    await prepareCall(call.video, false);
    $('call-accept').hidden = true;
    callStatus('Connecting…');
    await api('/api/call/answer', { body: { call: call.id } });
  } catch (err) {
    await api('/api/call/decline', { body: { call: call.id } }).catch(() => {});
    cleanupCall();
    $('thread-error').textContent = 'Allow microphone access to answer calls.';
  }
});
$('call-end').addEventListener('click', async () => {
  const path = call.incoming && !$('call-accept').hidden ? '/api/call/decline' : '/api/call/end';
  await api(path, { body: { call: call.id } }).catch(() => {});
  cleanupCall();
});
$('call-mic').addEventListener('click', () => {
  const tracks = call.local?.getAudioTracks() ?? [];
  const on = !tracks[0]?.enabled;
  tracks.forEach((t) => { t.enabled = on; });
  $('call-mic').textContent = on ? 'Mute' : 'Unmute';
});
$('call-cam').addEventListener('click', () => {
  const tracks = call.local?.getVideoTracks() ?? [];
  const on = !tracks[0]?.enabled;
  tracks.forEach((t) => { t.enabled = on; });
  $('call-cam').textContent = on ? 'Camera off' : 'Camera on';
});
async function stopShare() {
  if (!call.screen) return;
  call.screen.getTracks().forEach((t) => t.stop());
  call.screen = null;
  await call.videoSender?.replaceTrack(call.local?.getVideoTracks()[0] ?? null);
  $('local-video').srcObject = call.local;
  $('call-share').textContent = 'Share screen';
}
$('call-share').addEventListener('click', async () => {
  if (call.screen) return stopShare();
  try { call.screen = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch { return; }
  const track = call.screen.getVideoTracks()[0];
  await call.videoSender.replaceTrack(track);
  track.onended = stopShare;
  $('local-video').srcObject = call.screen;
  $('call-share').textContent = 'Stop sharing';
});
