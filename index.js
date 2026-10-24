/**
 * Bot de Discord para el AntiCheat de Roblox
 * ------------------------------------------------------------
 * - Servidor Express que recibe lotes de alertas desde Roblox (POST /alerts)
 *   protegido con una API key compartida.
 * - Convierte cada alerta en un embed (color y emoji según el tipo de check,
 *   avatar del jugador, enlace a su perfil) y lo manda al canal de alertas.
 * - Comandos slash: /estado, /alertas, /jugador
 *
 * Roblox -> POST https://TU-APP.onrender.com/alerts  (header x-api-key)
 */

const crypto = require('node:crypto');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  PermissionFlagsBits,
  escapeMarkdown,
} = require('discord.js');

// ================== CONFIGURACIÓN ==================
const { DISCORD_TOKEN, ALERT_CHANNEL_ID, GUILD_ID, API_KEY, PORT = 3000 } = process.env;
const DRY_RUN = process.env.DRY_RUN === '1';

const MAX_HISTORY = 300;           // alertas guardadas en memoria (se pierden al reiniciar)
const MAX_ALERTS_PER_REQUEST = 25; // tope por petición de Roblox
const EMBEDS_PER_MESSAGE = 10;     // límite de Discord
const MAX_REQUESTS_PER_MINUTE = 120;

if (!API_KEY) {
  console.error('Falta la variable API_KEY. Revisa .env.example');
  process.exit(1);
}
if (!DRY_RUN && (!DISCORD_TOKEN || !ALERT_CHANNEL_ID || !GUILD_ID)) {
  console.error('Faltan DISCORD_TOKEN, ALERT_CHANNEL_ID o GUILD_ID. Revisa .env.example');
  process.exit(1);
}

// Aspecto de cada tipo de alerta (el nombre coincide con el Name de cada check en Roblox)
const STYLE = {
  SpeedCheck: { color: 0xf39c12, emoji: '💨' },
  TeleportCheck: { color: 0x9b59b6, emoji: '🌀' },
  FlyCheck: { color: 0x3498db, emoji: '🕊️' },
  CollisionCheck: { color: 0xf1c40f, emoji: '💥' },
  'ACCIÓN': { color: 0xe74c3c, emoji: '🚨' },
};
const DEFAULT_STYLE = { color: 0x95a5a6, emoji: '⚠️' };

// ================== ESTADO EN MEMORIA ==================
const history = [];
const stats = { received: 0, lastSent: null };
const avatarCache = new Map();

// ================== UTILIDADES ==================
function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function authorized(req) {
  const provided = Buffer.from(String(req.get('x-api-key') ?? ''));
  const expected = Buffer.from(API_KEY);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

let windowStart = Date.now();
let windowCount = 0;
function rateLimited() {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  return ++windowCount > MAX_REQUESTS_PER_MINUTE;
}

// Valida y limpia una alerta que viene de Roblox (nunca confiar en la entrada)
function sanitizeAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = Number(raw.userId);
  if (!Number.isInteger(userId)) return null; // en Studio los userId pueden ser negativos
  return {
    userId,
    name: clip(raw.name, 40) || 'desconocido',
    kind: clip(raw.kind, 30) || 'Alerta',
    detail: clip(raw.detail, 900) || 'sin detalle',
  };
}

async function getAvatar(userId) {
  if (userId <= 0) return null;
  if (avatarCache.has(userId)) return avatarCache.get(userId);
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const json = await res.json();
      const url = json?.data?.[0]?.imageUrl ?? null;
      if (url) {
        avatarCache.set(userId, url);
        if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value);
        return url;
      }
    }
  } catch {
    // Sin avatar no pasa nada: el embed se manda igual
  }
  return null;
}

function buildEmbed(alert) {
  const style = STYLE[alert.kind] ?? DEFAULT_STYLE;
  const safeName = escapeMarkdown(alert.name);
  const player =
    alert.userId > 0
      ? `[${safeName}](https://www.roblox.com/users/${alert.userId}/profile)`
      : safeName;

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.emoji} ${alert.kind}`)
    .setDescription(escapeMarkdown(alert.detail))
    .addFields(
      { name: 'Jugador', value: player, inline: true },
      { name: 'UserId', value: `\`${alert.userId}\``, inline: true },
    )
    .setFooter({ text: `Servidor ${alert.server}` })
    .setTimestamp(new Date(alert.time));

  const avatar = avatarCache.get(alert.userId);
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

// ================== ENVÍO A DISCORD ==================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function deliver(alerts) {
  // Primero los avatares (una sola consulta por jugador distinto)
  const uniqueIds = [...new Set(alerts.map((a) => a.userId))];
  await Promise.all(uniqueIds.map(getAvatar));

  const embeds = alerts.map(buildEmbed);

  if (DRY_RUN) {
    console.log('[DRY_RUN] Embeds que se enviarían:');
    console.log(JSON.stringify(embeds.map((e) => e.toJSON()), null, 2));
    stats.lastSent = Date.now();
    return;
  }

  const channel = await client.channels.fetch(ALERT_CHANNEL_ID);
  for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
    await channel.send({
      embeds: embeds.slice(i, i + EMBEDS_PER_MESSAGE),
      allowedMentions: { parse: [] }, // nunca mencionar a nadie por un nombre raro
    });
  }
  stats.lastSent = Date.now();
}

// ================== SERVIDOR HTTP (lo que llama Roblox) ==================
const app = express();
app.use(express.json({ limit: '32kb' }));

app.get('/', (_req, res) => res.type('text/plain').send('AntiCheat bot OK'));
app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.post('/alerts', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (rateLimited()) return res.status(429).json({ error: 'too_many_requests' });

  const body = req.body ?? {};
  if (!Array.isArray(body.alerts) || body.alerts.length === 0) {
    return res.status(400).json({ error: 'alerts debe ser un arreglo con al menos 1 elemento' });
  }

  const jobId = String(body.jobId ?? '').slice(0, 8);
  const server = jobId || 'Studio';
  const now = Date.now();

  const alerts = body.alerts
    .slice(0, MAX_ALERTS_PER_REQUEST)
    .map(sanitizeAlert)
    .filter(Boolean)
    .map((a) => ({ ...a, server, time: now }));

  if (alerts.length === 0) {
    return res.status(400).json({ error: 'ninguna alerta válida' });
  }

  history.push(...alerts);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  stats.received += alerts.length;

  // Responder rápido a Roblox; el envío a Discord ocurre aparte
  res.status(202).json({ accepted: alerts.length });
  deliver(alerts).catch((err) => console.error('Error enviando a Discord:', err));
});

// JSON mal formado u otros errores de Express
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'json_invalido' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'demasiado_grande' });
  console.error(err);
  res.status(500).json({ error: 'error_interno' });
});

// ================== COMANDOS SLASH ==================
const adminOnly = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName('estado')
    .setDescription('Estado del bot y resumen de alertas')
    .setDefaultMemberPermissions(adminOnly),
  new SlashCommandBuilder()
    .setName('alertas')
    .setDescription('Últimas alertas recibidas')
    .addIntegerOption((o) =>
      o.setName('cantidad').setDescription('Cuántas mostrar (1-15)').setMinValue(1).setMaxValue(15),
    )
    .setDefaultMemberPermissions(adminOnly),
  new SlashCommandBuilder()
    .setName('jugador')
    .setDescription('Historial de alertas de un jugador')
    .addStringOption((o) =>
      o.setName('busqueda').setDescription('Nombre o UserId').setRequired(true),
    )
    .setDefaultMemberPermissions(adminOnly),
].map((c) => c.toJSON());

function alertLine(a) {
  const style = STYLE[a.kind] ?? DEFAULT_STYLE;
  return (
    `<t:${Math.floor(a.time / 1000)}:R> ${style.emoji} **${escapeMarkdown(a.kind)}** · ` +
    `${escapeMarkdown(a.name)} (\`${a.userId}\`)\n> ${escapeMarkdown(clip(a.detail, 110))}`
  );
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const ephemeral = { flags: MessageFlags.Ephemeral };

  if (interaction.commandName === 'estado') {
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🟢 Estado del AntiCheat')
      .addFields(
        { name: 'Tiempo activo', value: `${Math.round(process.uptime() / 60)} min`, inline: true },
        { name: 'Latencia Discord', value: `${client.ws.ping} ms`, inline: true },
        { name: 'Alertas recibidas', value: String(stats.received), inline: true },
        { name: 'En memoria', value: String(history.length), inline: true },
        {
          name: 'Último envío',
          value: stats.lastSent ? `<t:${Math.floor(stats.lastSent / 1000)}:R>` : 'ninguno aún',
          inline: true,
        },
      );
    return interaction.reply({ embeds: [embed], ...ephemeral });
  }

  if (interaction.commandName === 'alertas') {
    const count = interaction.options.getInteger('cantidad') ?? 8;
    const last = history.slice(-count).reverse();
    if (last.length === 0) {
      return interaction.reply({ content: 'Todavía no hay alertas guardadas.', ...ephemeral });
    }
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`Últimas ${last.length} alertas`)
      .setDescription(clip(last.map(alertLine).join('\n\n'), 4000));
    return interaction.reply({ embeds: [embed], ...ephemeral });
  }

  if (interaction.commandName === 'jugador') {
    const query = interaction.options.getString('busqueda').trim().toLowerCase();
    const matches = history.filter(
      (a) => String(a.userId) === query || a.name.toLowerCase().includes(query),
    );
    if (matches.length === 0) {
      return interaction.reply({
        content: `Sin alertas guardadas para «${clip(query, 40)}».`,
        ...ephemeral,
      });
    }

    const counts = {};
    for (const a of matches) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    const summary = Object.entries(counts)
      .sort((x, y) => y[1] - x[1])
      .map(([kind, n]) => `${(STYLE[kind] ?? DEFAULT_STYLE).emoji} ${escapeMarkdown(kind)}: **${n}**`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`Historial: ${clip(query, 40)}`)
      .setDescription(clip(`${summary}\n\n${matches.slice(-8).reverse().map(alertLine).join('\n\n')}`, 4000))
      .setFooter({ text: `${matches.length} alertas en memoria` });
    return interaction.reply({ embeds: [embed], ...ephemeral });
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot conectado como ${c.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    // Comandos de servidor: aparecen al instante (los globales tardan)
    await rest.put(Routes.applicationGuildCommands(c.user.id, GUILD_ID), { body: commands });
    console.log('Comandos slash registrados.');
  } catch (err) {
    console.error('No se pudieron registrar los comandos:', err);
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch((err) => {
    console.error('Error en comando:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Ocurrió un error.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
});

client.on(Events.Error, (err) => console.error('Error del cliente de Discord:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

// ================== ARRANQUE ==================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor HTTP escuchando en el puerto ${PORT}${DRY_RUN ? ' (DRY_RUN)' : ''}`);
});

if (!DRY_RUN) {
  client.login(DISCORD_TOKEN).catch((err) => {
    console.error('No se pudo iniciar sesión en Discord:', err.message);
    process.exit(1);
  });
}
