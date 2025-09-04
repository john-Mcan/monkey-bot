import { Shoukaku, Connectors } from 'shoukaku';
import type { NodeOption, Player } from 'shoukaku';
import { Client } from 'discord.js';
import { logger } from './logger.js';

export function createShoukaku(client: Client) {
  const host = process.env.LAVALINK_HOST || 'localhost';
  const port = process.env.LAVALINK_PORT || '2333';
  const secure = (process.env.LAVALINK_SECURE || 'false') === 'true';
  const host2 = process.env.LAVALINK_YT_HOST || host;
  const port2 = process.env.LAVALINK_YT_PORT || '2334';
  const secure2 = (process.env.LAVALINK_YT_SECURE || 'false') === 'true';
  const nodes: NodeOption[] = [
    {
      name: 'yt-dlp',
      url: `${host}:${port}`,
      auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
      secure,
      group: 'primary'
    },
    {
      name: 'yt-plugin',
      url: `${host2}:${port2}`,
      auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
      secure: secure2,
      group: 'fallback'
    }
  ];

  const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
    moveOnDisconnect: true,
    resume: true,
    resumeTimeout: 60,
    reconnectTries: Infinity,
    restTimeout: 10000,
    nodeResolver: (map) => {
      // preferir el grupo primary (yt-dlp); si está saturado o falla, usar fallback (plugin oficial)
      const candidates = Array.from(map.values());
      const primaries = candidates.filter(n => n.group === 'primary');
      const fallbacks = candidates.filter(n => n.group === 'fallback');
      const pick = (arr: any[]) => arr.sort((a, b) => (a.penalties ?? 0) - (b.penalties ?? 0))[0];
      return pick(primaries) || pick(fallbacks) || candidates[0];
    }
  });

  shoukaku.on('ready', (name) => logger.info({ name }, '[Lavalink] Node listo'));
  shoukaku.on('error', (name, error) => logger.error({ name, error }, '[Lavalink] Error de nodo'));
  shoukaku.on('close', (name, code, reason) => logger.warn({ name, code, reason }, '[Lavalink] Conexión cerrada'));
  shoukaku.on('disconnect', (name, count) => logger.warn({ name, count }, '[Lavalink] Desconectado'));

  return shoukaku;
}

export type { Player };


