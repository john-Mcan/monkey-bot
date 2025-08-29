import { Shoukaku, Connectors } from 'shoukaku';
import type { NodeOption, Player } from 'shoukaku';
import { Client } from 'discord.js';
import { logger } from './logger.js';

export function createShoukaku(client: Client) {
  const host = process.env.LAVALINK_HOST || 'localhost';
  const port = process.env.LAVALINK_PORT || '2333';
  const secure = (process.env.LAVALINK_SECURE || 'false') === 'true';
  const nodes: NodeOption[] = [
    {
      name: 'local',
      url: `${host}:${port}`,
      auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
      secure,
    },
  ];

  const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
    moveOnDisconnect: true,
    resume: true,
    resumeTimeout: 60,
    reconnectTries: Infinity,
    restTimeout: 10000,
  });

  shoukaku.on('ready', (name) => logger.info({ name }, '[Lavalink] Node listo'));
  shoukaku.on('error', (name, error) => logger.error({ name, error }, '[Lavalink] Error de nodo'));
  shoukaku.on('close', (name, code, reason) => logger.warn({ name, code, reason }, '[Lavalink] Conexión cerrada'));
  shoukaku.on('disconnect', (name, count) => logger.warn({ name, count }, '[Lavalink] Desconectado'));

  return shoukaku;
}

export type { Player };


