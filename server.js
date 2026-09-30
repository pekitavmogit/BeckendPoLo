require('dotenv').config();
const POLO = process.env.POLO_BOT_PATH || 'C:\\Users\\pekit\\OneDrive\\Desktop\\PoLoNewX';
// Fallback: lee el .env del bot para GROQ_API_KEY y TOKEN sin mostrarlos
try {
  const poloEnv = require('dotenv').parse(require('fs').readFileSync(require('path').join(POLO, '.env')));
  for (const [k, v] of Object.entries(poloEnv)) {
    if (!process.env[k] || process.env[k].startsWith('PEGA_AQUI')) process.env[k] = v;
  }
} catch {}
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

let corsMw;
try {
  corsMw = require('cors')();
} catch {
  // Sin el paquete cors (ej. corriendo dentro del bot): CORS manual minimo
  corsMw = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  };
}
app.use(corsMw);
app.use(express.json({ limit: '12mb' }));

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.TOKEN || process.env.DISCORD_BOT_TOKEN || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OWNER_ID = '1352424608862572597';
const REPORTS_CHANNEL_ID = '1463373340814086263';

async function discordFetch(url, options = {}) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error('discord-' + r.status);
    err.data = data;
    throw err;
  }
  return data;
}

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// Permisos Discord: 0x8 Administrator, 0x20 Manage Guild, owner flag
function canControl(g) {
  if (g.owner) return true;
  try {
    const p = BigInt(g.permissions || 0);
    return (p & 8n) === 8n || (p & 32n) === 32n;
  } catch {
    return false;
  }
}
function isPremiumUser(userId) {
  if (String(userId) === OWNER_ID) return true;
  const d = readJSON(path.join(POLO, 'data', 'premium.json'), { users: [] });
  return (d.users || []).includes(String(userId));
}

// POST /auth/exchange — intercambia code OAuth2 por datos de usuario
app.post('/auth/exchange', async (req, res) => {
  const { code, redirect_uri } = req.body || {};
  if (!code) return res.status(400).json({ error: 'missing-code' });
  if (!CLIENT_ID || !CLIENT_SECRET || String(CLIENT_SECRET).startsWith('PEGA_AQUI')) {
    console.error('Faltan DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET en backend/.env');
    return res.status(500).json({ error: 'server-misconfigured' });
  }
  try {
    const tokenData = await discordFetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect_uri || '',
      }),
    });
    if (!tokenData.access_token) {
      console.error('Discord no devolvio token:', tokenData);
      return res.status(401).json({ error: 'bad-code', detail: tokenData });
    }
    const user = await discordFetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    return res.json({
      id: user.id,
      username: user.username,
      global_name: user.global_name,
      avatar: user.avatar,
      sessionToken: tokenData.access_token,
    });
  } catch (e) {
    console.error('Error /auth/exchange:', e.data || e.message);
    return res.status(401).json({ error: 'exchange-failed', detail: e.data || e.message });
  }
});

// GET /api/me — usuario + flags owner/premium
app.get('/api/me', async (req, res) => {
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!userToken) return res.status(401).json({ error: 'no-token' });
  try {
    const user = await discordFetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    res.json({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      isOwner: String(user.id) === OWNER_ID,
      isPremium: isPremiumUser(user.id),
    });
  } catch (e) {
    res.status(401).json({ error: 'bad-token' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  let guildCount = null;
  if (BOT_TOKEN) {
    try {
      const g = await discordFetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      });
      guildCount = Array.isArray(g) ? g.length : null;
    } catch { /* sin acceso bot, usa mock */ }
  }
  res.json({
    ping: 40 + Math.floor(Math.random() * 20),
    ram: memMB,
    cpu: 5 + Math.floor(Math.random() * 15),
    commandsPerMin: 10 + Math.floor(Math.random() * 15),
    totalCmds: 1250,
    uptime: '99.9%',
    online: true,
    prefix: '!p',
    presence: '/help - polo.gg',
    guilds: guildCount,
  });
});

// GET /api/guilds — SOLO donde el usuario es admin/owner, con/sin PoLo
app.get('/api/guilds', async (req, res) => {
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    let userGuilds = [];
    if (userToken) {
      userGuilds = await discordFetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${userToken}` },
      });
    }
    const controllable = (Array.isArray(userGuilds) ? userGuilds : []).filter(canControl);
    let botGuildIds = new Set();
    if (BOT_TOKEN) {
      try {
        const botGuilds = await discordFetch('https://discord.com/api/v10/users/@me/guilds', {
          headers: { Authorization: `Bot ${BOT_TOKEN}` },
        });
        botGuildIds = new Set((botGuilds || []).map((g) => g.id));
      } catch { /* ignora */ }
    }
    // memberCount best-effort (max 30 para no rate-limitear)
    const counts = {};
    if (BOT_TOKEN) {
      const withPolo = controllable.filter((g) => botGuildIds.has(g.id)).slice(0, 30);
      await Promise.allSettled(
        withPolo.map(async (g) => {
          try {
            const d = await discordFetch(`https://discord.com/api/v10/guilds/${g.id}?with_counts=true`, {
              headers: { Authorization: `Bot ${BOT_TOKEN}` },
            });
            counts[g.id] = d.approximate_member_count || 0;
          } catch {}
        })
      );
    }
    const guilds = controllable.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      isOwner: !!g.owner,
      memberCount: counts[g.id] || 0,
      hasPolo: botGuildIds.size ? botGuildIds.has(g.id) : true,
    }));
    return res.json({ guilds });
  } catch (e) {
    console.error('Error /api/guilds:', e.data || e.message);
    return res.status(401).json({ error: 'guilds-failed' });
  }
});

// Verifica que el dueno del token sea admin/owner del guild gid
async function requireGuildAdmin(userToken, gid) {
  if (!userToken) return false;
  try {
    const guilds = await discordFetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const g = (Array.isArray(guilds) ? guilds : []).find((x) => x.id === gid);
    return g ? canControl(g) : false;
  } catch {
    return false;
  }
}

// GET /api/commands — comandos reales del bot (escanea PoLoNewX/commands)
app.get('/api/commands', (req, res) => {
  try {
    const dir = path.join(POLO, 'commands');
    const files = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js')) files.push(p);
      }
    })(dir);
    const cmds = [];
    for (const f of files) {
      try {
        const src = fs.readFileSync(f, 'utf8');
        const name = (src.match(/\.setName\(\s*['"]([^'"]+)['"]/) || [])[1];
        if (!name || cmds.some((c) => c.name === name)) continue;
        const desc = (src.match(/\.setDescription\(\s*['"]([^'"]+)['"]/) || [])[1] || '';
        const cat = /mod|ban|kick|mute|warn|purge|lock|slowmode/i.test(f) ? 'mod'
          : /play|music|skip|queue|volumen/i.test(f) ? 'music'
          : /meme|8ball|poll|gif|fun|aki|afk|angry|bite|blush|bonk|cheer|clap|cry|cuddle|dance/i.test(f) ? 'fun' : 'util';
        cmds.push({ name, desc: desc.slice(0, 120), cat });
      } catch {}
    }
    cmds.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ commands: cmds });
  } catch (e) {
    res.status(500).json({ error: 'scan-failed' });
  }
});

// GET /api/staff — true si es owner o tiene el rol STAFF del server oficial
app.get('/api/staff', async (req, res) => {
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!userToken || !BOT_TOKEN) return res.json({ isStaff: false });
  try {
    const me = await discordFetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (String(me.id) === OWNER_ID) return res.json({ isStaff: true });
    const member = await discordFetch(
      `https://discord.com/api/v10/guilds/1463373339002146947/members/${me.id}`,
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );
    res.json({ isStaff: (member.roles || []).includes('1548077785694609428') });
  } catch {
    res.json({ isStaff: false });
  }
});

// GET /api/guilds/:id/channels — canales de texto (para el selector, sin escribir IDs)
app.get('/api/guilds/:id/channels', async (req, res) => {
  const gid = req.params.id;
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await requireGuildAdmin(userToken, gid))) return res.status(403).json({ error: 'not-guild-admin' });
  if (!BOT_TOKEN) return res.status(500).json({ error: 'no-bot-token' });
  try {
    const all = await discordFetch(`https://discord.com/api/v10/guilds/${gid}/channels`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    const channels = (Array.isArray(all) ? all : [])
      .filter((c) => c.type === 0 || c.type === 2)
      .map((c) => ({ id: c.id, name: c.name, kind: c.type }))
      .sort((a, b) => (a.kind - b.kind) || (a.name || '').localeCompare(b.name || ''));
    res.json({ channels });
  } catch (e) {
    res.status(400).json({ error: 'channels-failed', detail: '¿PoLo está en ese servidor?' });
  }
});

// GET /api/guilds/:id/config — bienvenida, niveles, IA, seguridad, tickets, economia, youtube
app.get('/api/guilds/:id/config', async (req, res) => {
  const gid = req.params.id;
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await requireGuildAdmin(userToken, gid))) return res.status(403).json({ error: 'not-guild-admin' });
  const welcome = readJSON(path.join(POLO, 'data', 'welcome.json'), { servers: {} });
  const levels = readJSON(path.join(POLO, 'data', 'levels.json'), { users: {}, configs: {} });
  const ai = readJSON(path.join(POLO, 'data', 'ai-config.json'), {});
  const sec = readJSON(path.join(POLO, 'data', 'security-config.json'), { guilds: {} });
  const srv = readJSON(path.join(POLO, 'database', 'serverConfig.json'), {});
  const eco = readJSON(path.join(POLO, 'database', 'config.json'), {});
  const yt = readJSON(path.join(POLO, 'youtubeConfig.json'), {});
  const scfg = readJSON(path.join(POLO, 'data', 'server-config.json'), { configs: {} });
  const sanc = readJSON(path.join(POLO, 'data', 'sanction-config.json'), {});
  const inv = readJSON(path.join(POLO, 'invites-config.json'), {});
  const counter = readJSON(path.join(POLO, 'data', 'counterConfig.json'), {});
  const bump = readJSON(path.join(POLO, 'bumpConfig.json'), {});
  const joinroles = readJSON(path.join(POLO, 'data', 'joinroles.json'), {});
  // imagen de bienvenida como dataURL (solo si pesa < 400KB)
  let welcomeImg = null;
  try {
    const wp = welcome.servers?.[gid]?.imagePath;
    if (wp && fs.existsSync(wp) && fs.statSync(wp).size < 400 * 1024) {
      const ext = path.extname(wp).toLowerCase() === '.jpg' || path.extname(wp).toLowerCase() === '.jpeg' ? 'jpeg' : 'png';
      welcomeImg = `data:image/${ext};base64,` + fs.readFileSync(wp).toString('base64');
    }
  } catch {}
  res.json({
    welcome: welcome.servers?.[gid] || { channelId: null, mensaje: 'Bienvenido {usuario} a {servidor}' },
    levels: levels.configs?.[gid] || { levelChannel: null, mensaje: null, rewards: [] },
    ai: ai[gid] || { enabled: true, channelIds: [], prompt: null },
    security: sec.guilds?.[gid] || { enabled: false },
    tickets: srv[gid]?.ticket || { panelTitle: '', panelDesc: '', staffRoles: [] },
    economy: eco[gid] || { workCooldownSeconds: eco.workCooldownSeconds ?? 7, workMax: eco.workMax ?? 40, economyChannelId: eco.economyChannelId || null },
    youtube: yt[gid] || [],
    welcomeImage: welcomeImg,
    hasWelcomeImage: !!(welcome.servers?.[gid]?.imagePath && fs.existsSync(welcome.servers[gid].imagePath)),
    logs: scfg.configs?.[gid] || { logChannel: null, logLevel: 2 },
    modlog: sanc[gid] || { channelId: null },
    invites: { channelId: inv[gid] || null },
    counter: counter[gid] || { channelId: null },
    bump: bump[gid] || { mensaje: '', canalId: null, activo: false },
    joinroles: joinroles[gid] || [],
  });
});

// POST /api/guilds/:id/config — guarda seccion (requiere Bearer; IA prompt solo premium)
app.post('/api/guilds/:id/config', async (req, res) => {
  const gid = req.params.id;
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let userId = null;
  if (userToken) {
    try {
      const me = await discordFetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      userId = me.id;
    } catch {
      return res.status(401).json({ error: 'bad-token' });
    }
  }
  const { section, data } = req.body || {};
  if (!(await requireGuildAdmin(userToken, gid))) return res.status(403).json({ error: 'not-guild-admin' });
  try {
    if (section === 'welcome') {
      const fp = path.join(POLO, 'data', 'welcome.json');
      const j = readJSON(fp, { servers: {} });
      j.servers[gid] = {
        channelId: data.channelId || null,
        mensaje: (data.mensaje || '').slice(0, 1000),
        imagePath: j.servers[gid]?.imagePath || null,
      };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'levels') {
      const fp = path.join(POLO, 'data', 'levels.json');
      const j = readJSON(fp, { users: {}, configs: {} });
      j.configs[gid] = {
        levelChannel: data.levelChannel || null,
        mensaje: (data.mensaje || '').slice(0, 500),
        removePreviousRole: !!data.removePreviousRole,
        rewards: Array.isArray(data.rewards) ? data.rewards.slice(0, 10) : (j.configs[gid]?.rewards || []),
      };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'ai') {
      if (data.prompt && !isPremiumUser(userId)) {
        return res.status(403).json({ error: 'premium-only' });
      }
      const fp = path.join(POLO, 'data', 'ai-config.json');
      const j = readJSON(fp, {});
      j[gid] = {
        enabled: data.enabled !== false,
        channelIds: Array.isArray(data.channelIds) ? data.channelIds.slice(0, 5) : (j[gid]?.channelIds || []),
        prompt: ('prompt' in data) ? (String(data.prompt || '').slice(0, 1500) || null) : (j[gid]?.prompt || null),
      };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'security') {
      const fp = path.join(POLO, 'data', 'security-config.json');
      const j = readJSON(fp, { defaults: {}, guilds: {} });
      j.guilds = j.guilds || {};
      j.guilds[gid] = { ...(j.guilds[gid] || {}), ...data };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'tickets') {
      const fp = path.join(POLO, 'database', 'serverConfig.json');
      const j = readJSON(fp, {});
      j[gid] = j[gid] || {};
      j[gid].ticket = {
        ...(j[gid].ticket || {}),
        panelTitle: String(data.panelTitle || '').slice(0, 100),
        panelDesc: String(data.panelDesc || '').slice(0, 1000),
        panelChannelId: String(data.panelChannelId || '').replace(/\D/g, '').slice(0, 20) || null,
        staffRoles: Array.isArray(data.staffRoles) ? data.staffRoles.slice(0, 5) : [],
      };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'tickets_send') {
      const srv = readJSON(path.join(POLO, 'database', 'serverConfig.json'), {});
      const t = srv[gid]?.ticket || {};
      const channelId = String(data.panelChannelId || t.panelChannelId || '').replace(/\D/g, '');
      if (!BOT_TOKEN) return res.status(500).json({ error: 'no-bot-token' });
      if (!channelId) return res.status(400).json({ error: 'missing-channel' });
      try {
        await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              color: 0xff0000,
              title: t.panelTitle || 'OPEN TICKET',
              description: t.panelDesc || 'Pulsa el botón para abrir un ticket privado con el Staff.',
              image: t.panelImage ? { url: t.panelImage } : undefined,
            }],
            components: [{
              type: 1,
              components: [{ type: 2, custom_id: 'crear_ticket', label: 'Abrir Ticket', style: 4, emoji: { id: '1541186340505387179', name: 'StaffEmojiPolo' } }],
            }],
          }),
        });
        return res.json({ ok: true });
      } catch (e) {
        console.error('Error publicando panel:', e.data || e.message);
        return res.status(400).json({ error: 'send-failed', detail: 'Revisa que el canal exista y PoLo pueda escribir' });
      }
    }
    if (section === 'economy') {
      const fp = path.join(POLO, 'database', 'config.json');
      const j = readJSON(fp, {});
      j[gid] = {
        ...(j[gid] || {}),
        workCooldownSeconds: Math.max(1, Math.min(3600, Number(data.workCooldownSeconds) || 7)),
        workMax: Math.max(1, Math.min(100000, Number(data.workMax) || 40)),
        economyChannelId: data.economyChannelId || null,
      };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'youtube_add') {
      const fp = path.join(POLO, 'youtubeConfig.json');
      const j = readJSON(fp, {});
      j[gid] = j[gid] || [];
      if (j[gid].length >= 10) return res.status(400).json({ error: 'max-alerts' });
      j[gid].push({
        youtubeChannelId: String(data.youtubeChannelId || ''),
        youtubeChannelTitle: String(data.youtubeChannelTitle || ''),
        announceChannelId: String(data.announceChannelId || ''),
        mentionRoleId: String(data.mentionRoleId || ''),
        message: String(data.message || '').slice(0, 500),
      });
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'youtube_remove') {
      const fp = path.join(POLO, 'youtubeConfig.json');
      const j = readJSON(fp, {});
      j[gid] = (j[gid] || []).filter((a) => a.youtubeChannelId !== data.youtubeChannelId);
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'welcome_image') {
      const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(data.image || '');
      if (!m) return res.status(400).json({ error: 'bad-image' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'too-big' });
      const ext = m[1] === 'png' ? 'png' : 'jpg';
      const dir = path.join(POLO, 'data', 'welcome-images');
      fs.mkdirSync(dir, { recursive: true });
      for (const e of ['png', 'jpg', 'jpeg']) {
        try { fs.unlinkSync(path.join(dir, `${gid}.${e}`)); } catch {}
      }
      const full = path.join(dir, `${gid}.${ext}`);
      fs.writeFileSync(full, buf);
      const fp = path.join(POLO, 'data', 'welcome.json');
      const j = readJSON(fp, { servers: {} });
      j.servers[gid] = j.servers[gid] || { channelId: null, mensaje: 'Bienvenido {usuario} a {servidor}', imagePath: null };
      j.servers[gid].imagePath = full;
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'logs') {
      const fp = path.join(POLO, 'data', 'server-config.json');
      const j = readJSON(fp, { configs: {} });
      j.configs[gid] = {
        logChannel: String(data.logChannel || '').replace(/\D/g, '') || null,
        logLevel: Math.max(0, Math.min(5, Number(data.logLevel) || 0)),
      };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'modlog') {
      const fp = path.join(POLO, 'data', 'sanction-config.json');
      const j = readJSON(fp, {});
      j[gid] = { channelId: String(data.channelId || '').replace(/\D/g, '') || null };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'invites') {
      const fp = path.join(POLO, 'invites-config.json');
      const j = readJSON(fp, {});
      const ch = String(data.channelId || '').replace(/\D/g, '');
      if (ch) j[gid] = ch; else delete j[gid];
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'counter') {
      const fp = path.join(POLO, 'data', 'counterConfig.json');
      const j = readJSON(fp, {});
      j[gid] = { ...(j[gid] || {}), channelId: String(data.channelId || '').replace(/\D/g, '') || null };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'bump') {
      const fp = path.join(POLO, 'bumpConfig.json');
      const j = readJSON(fp, {});
      j[gid] = {
        ...(j[gid] || {}),
        mensaje: String(data.mensaje || '').slice(0, 1000),
        canalId: String(data.canalId || '').replace(/\D/g, '') || null,
        activo: !!data.activo,
      };
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    if (section === 'joinroles') {
      const fp = path.join(POLO, 'data', 'joinroles.json');
      const j = readJSON(fp, {});
      const ids = (Array.isArray(data.roleIds) ? data.roleIds : String(data.roleIds || '').split(','))
        .map((x) => String(x).replace(/\D/g, '')).filter(Boolean).slice(0, 5);
      j[gid] = ids;
      writeJSON(fp, j);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'bad-section' });
  } catch (e) {
    console.error('Error guardando config:', e.message);
    return res.status(500).json({ error: 'save-failed' });
  }
});

// GET /api/reports — ultimos reportes del bot
app.get('/api/reports', (req, res) => {
  const j = readJSON(path.join(POLO, 'data', 'bug-reports.json'), { lastId: 0, reports: [] });
  const list = (j.reports || []).slice(-20).reverse().map((r) => ({
    id: r.id,
    user: r.userTag || r.userId,
    reason: r.bug,
    guild: r.guildName || '',
    severity: r.severity,
    status: r.status,
  }));
  res.json({ reports: list });
});

// POST /api/reports — crea reporte = mismo formato que /report del bot + envia embed
app.post('/api/reports', async (req, res) => {
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let reporter = { id: 'dashboard', tag: 'dashboard' };
  if (userToken) {
    try {
      const me = await discordFetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      reporter = { id: me.id, tag: me.username };
    } catch {}
  }
  const { bug, severity, note, guildId, guildName } = req.body || {};
  if (!bug || !severity) return res.status(400).json({ error: 'missing-fields' });
  const fp = path.join(POLO, 'data', 'bug-reports.json');
  const j = readJSON(fp, { lastId: 0, reports: [] });
  const entry = {
    id: (j.lastId || 0) + 1,
    bug: String(bug).slice(0, 1000),
    severity,
    note: note ? String(note).slice(0, 500) : null,
    userId: reporter.id,
    userTag: reporter.tag,
    avatarURL: null,
    guildId: guildId || null,
    guildName: guildName || 'dashboard',
    timestamp: Date.now(),
    status: 'pending',
  };
  j.lastId = entry.id;
  j.reports.push(entry);
  writeJSON(fp, j);
  // Envia embed al canal + DM owner via REST (best-effort)
  if (BOT_TOKEN) {
    const embed = {
      title: `🐛 Reporte #${entry.id} [${severity}]`,
      description: entry.bug + (entry.note ? `\n\n📝 ${entry.note}` : ''),
      color: severity === 'severe' ? 0xd64545 : 0x2f7fe0,
      fields: [
        { name: 'Reportado por', value: `${reporter.tag} (${reporter.id})` },
        { name: 'Servidor', value: entry.guildName },
      ],
      timestamp: new Date().toISOString(),
    };
    try {
      await discordFetch(`https://discord.com/api/v10/channels/${REPORTS_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch (e) { console.error('No se pudo enviar al canal:', e.data || e.message); }
  }
  res.json({ ok: true, id: entry.id });
});

// POST /api/ai/chat — mini-chat con la misma IA del bot (Groq, mismo prompt + rol del server)
app.post('/api/ai/chat', async (req, res) => {
  if (!GROQ_KEY) return res.status(500).json({ error: 'no-groq-key' });
  const { message, guildId, history } = req.body || {};
  if (!message) return res.status(400).json({ error: 'missing-message' });
  try {
    const { default: Groq } = await import('groq-sdk').catch(() => ({ default: null }));
    const GroqCls = Groq || require('groq-sdk');
    const groq = new GroqCls({ apiKey: GROQ_KEY });
    let serverPrompt = '';
    if (guildId) {
      const ai = readJSON(path.join(POLO, 'data', 'ai-config.json'), {});
      if (ai[guildId]?.prompt) serverPrompt = ai[guildId].prompt;
    }
    const system = 'Eres PoLo, un oso polar asistente del dashboard de PoLo. Respondes en español, breve y util. Ayudas a configurar el bot y el dashboard.' +
      (serverPrompt ? `\n\n[ROL DE ESTE SERVIDOR]: ${serverPrompt}` : '');
    const msgs = [{ role: 'system', content: system }];
    for (const h of (history || []).slice(-8)) {
      if (h.role && h.content) msgs.push({ role: h.role, content: String(h.content).slice(0, 1000) });
    }
    msgs.push({ role: 'user', content: String(message).slice(0, 1000) });
    const out = await groq.chat.completions.create({
      messages: msgs,
      model: 'openai/gpt-oss-120b',
      temperature: 0.5,
      max_tokens: 400,
    });
    res.json({ reply: out.choices?.[0]?.message?.content || '...' });
  } catch (e) {
    console.error('Error IA:', e.message);
    res.status(500).json({ error: 'ai-failed' });
  }
});

app.get('/api/activity', (req, res) => {
  res.json({
    activity: { labels: ['00h', '06h', '12h', '18h', '24h'], values: [12, 30, 45, 28, 50] },
    growth: { labels: ['Lun', 'Mar', 'Mie', 'Jue', 'Vie'], values: [5, 8, 12, 15, 20] },
    top: [{ name: 'help', uses: 320 }, { name: 'play', uses: 210 }],
    events: [{ tag: 'INFO', text: 'Sesión iniciada en el panel' }],
  });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: [{ level: 'info', message: 'Panel listo' }] });
});

app.post('/api/command', (req, res) => {
  res.json({ reply: 'Comando recibido (solo lectura en esta fase): ' + (req.body?.input || '') });
});
app.post('/api/commands/toggle', (req, res) => res.json({ ok: true }));
app.post('/api/moderation', (req, res) => res.json({ ok: true }));
app.post('/api/settings', (req, res) => res.json({ ok: true }));
app.post('/api/announce', (req, res) => res.json({ ok: true }));
app.post('/api/clear', (req, res) => res.json({ ok: true }));
app.post('/api/backup', (req, res) => res.json({ ok: true }));
app.post('/api/update', (req, res) => res.json({ ok: true }));

function startServer(port) {
  const p = port || process.env.DASHBOARD_PORT || PORT;
  return app.listen(p, () => {
    console.log(`PoLo dashboard backend en http://localhost:${p}`);
    if (!CLIENT_SECRET || String(CLIENT_SECRET).startsWith('PEGA_AQUI')) console.log('AVISO: falta DISCORD_CLIENT_SECRET en backend/.env');
  });
}
if (require.main === module) startServer();

// Exportado para correr dentro del bot (PoLoNewX lo requiere con DASHBOARD_API=1)
module.exports = { app, startServer };
