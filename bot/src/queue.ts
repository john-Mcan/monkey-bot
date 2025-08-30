import type { Player, PlayerUpdate } from 'shoukaku';
import { logger } from './logger.js';

export interface QueuedTrackInfo {
  encoded: string;
  info: {
    title?: string;
    uri?: string;
    author?: string;
    sourceName?: string;
    length?: number;
  };
}

interface GuildQueueState {
  tracks: QueuedTrackInfo[];
  current?: QueuedTrackInfo;
  isProcessing: boolean;
  listenersAttached: boolean;
}

const guildIdToQueue: Map<string, GuildQueueState> = new Map();

export function getQueue(guildId: string): GuildQueueState {
  let q = guildIdToQueue.get(guildId);
  if (!q) {
    q = { tracks: [], isProcessing: false, listenersAttached: false } as GuildQueueState;
    guildIdToQueue.set(guildId, q);
  }
  return q!;
}

export function enqueueTracks(guildId: string, tracks: QueuedTrackInfo[]): number {
  const q = getQueue(guildId);
  for (const t of tracks) {
    if (t?.encoded) q.tracks.push(t);
  }
  return q.tracks.length;
}

export async function startIfIdle(guildId: string, player: Player): Promise<void> {
  const q = getQueue(guildId);
  if (q.isProcessing) return;
  if (q.current) return; // ya reproduciendo
  await playNext(guildId, player);
}

export async function skipCurrent(guildId: string, player: Player): Promise<boolean> {
  const q = getQueue(guildId);
  if (!q.current && q.tracks.length === 0) return false;

  try {
    const sessionId = player.node.sessionId;
    const url = `http://localhost:2333/v4/sessions/${sessionId}/players/${guildId}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': 'youshallnotpass',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encodedTrack: null }),
    });
    if (!res.ok) {
      const txt = await res.text();
      logger.warn({ status: res.status, txt }, 'Fallo al parar track actual');
    }
  } catch (e) {
    logger.warn({ e }, 'Error al parar track actual (skip)');
  }
  await playNext(guildId, player);
  return true;
}

export async function playNext(guildId: string, player: Player): Promise<void> {
  const q = getQueue(guildId);
  if (q.isProcessing) return;
  q.isProcessing = true;
  try {
    const next = q.tracks.shift();
    if (!next) {
      delete q.current;
      logger.info({ guildId }, 'Cola vacía, no hay más canciones');
      return;
    }
    q.current = next;
    await ensurePlayerConnected(player, 6000);

    const sessionId = player.node.sessionId;
    const url = `http://localhost:2333/v4/sessions/${sessionId}/players/${guildId}`;
    const playerInfo = await player.node.rest.getPlayer(guildId);
    const voice = playerInfo?.voice;
    if (!voice) throw new Error('No voice info al reproducir siguiente');

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': 'youshallnotpass',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        encodedTrack: next.encoded,
        volume: playerInfo?.volume ?? 100,
        paused: false,
        voice: {
          token: voice.token,
          endpoint: voice.endpoint,
          sessionId: voice.sessionId,
        },
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      logger.error({ status: res.status, txt }, 'Error al reproducir siguiente track');
      // intentar continuar con el siguiente para evitar atasco
      delete q.current;
      await playNext(guildId, player);
      return;
    }
    logger.info({ title: next.info?.title, uri: next.info?.uri }, 'Reproduciendo siguiente en cola');
  } finally {
    q.isProcessing = false;
  }
}

export function attachPlayerAutoNext(guildId: string, player: Player) {
  const q = getQueue(guildId);
  if (q.listenersAttached) return;

  const onEnd = async () => {
    try {
      await playNext(guildId, player);
    } catch (e) {
      logger.error({ e }, 'Error en auto-next al terminar track');
    }
  };

  const onUpdate = (data: PlayerUpdate) => {
    // podemos usar update para verificar conexión si se requiere
    return data;
  };

  player.on('end', onEnd as any);
  player.on('stuck', onEnd as any);
  player.on('exception', onEnd as any);
  player.on('update', onUpdate as any);

  q.listenersAttached = true;
}

async function ensurePlayerConnected(player: Player, timeoutMs: number) {
  const timeout = Date.now() + timeoutMs;
  try {
    const info = await player.node.rest.getPlayer(player.guildId);
    if (info?.voice && (info as any)?.state?.connected) return;
  } catch {}

  return new Promise<void>((resolve, reject) => {
    const onUpdate = (data: PlayerUpdate) => {
      if (data.state?.connected) {
        cleanup();
        resolve();
      }
    };
    function cleanup() {
      player.off('update', onUpdate as any);
    }
    function tick() {
      if (Date.now() > timeout) {
        cleanup();
        reject(new Error('Timeout esperando conexión de voz'));
      } else {
        player.node.rest.getPlayer(player.guildId)
          .then((info) => {
            if (info?.voice && (info as any)?.state?.connected) {
              cleanup();
              resolve();
            } else {
              setTimeout(tick, 250);
            }
          })
          .catch(() => setTimeout(tick, 250));
      }
    }
    player.on('update', onUpdate as any);
    tick();
  });
}


