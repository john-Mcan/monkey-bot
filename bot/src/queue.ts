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
  // reintentos de recuperación/re-resolución si falla la reproducción
  retries?: number;
  lastError?: string;
}

export type LoopMode = 'off' | 'track' | 'queue';

interface GuildQueueState {
  tracks: QueuedTrackInfo[];
  current?: QueuedTrackInfo;
  isProcessing: boolean;
  listenersAttached: boolean;
  loopMode: LoopMode;
  shuffle: boolean;
  skippedCount?: number;
  failedCount?: number;
}

const guildIdToQueue: Map<string, GuildQueueState> = new Map();

export function getQueue(guildId: string): GuildQueueState {
  let q = guildIdToQueue.get(guildId);
  if (!q) {
    q = { tracks: [], isProcessing: false, listenersAttached: false, loopMode: 'off', shuffle: false } as GuildQueueState;
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
    // limpiar current inmediatamente para evitar condición de carrera con el evento 'end'
    delete q.current;
    const res = await patchPlayer(player, guildId, { encodedTrack: null });
    if (!res.ok) {
      const txt = await res.text();
      logger.warn({ status: res.status, txt }, 'Fallo al parar track actual');
    }
  } catch (e) {
    logger.warn({ e }, 'Error al parar track actual (skip)');
  }
  return true;
}

export async function playNext(guildId: string, player: Player): Promise<void> {
  const q = getQueue(guildId);
  if (q.isProcessing) return;
  q.isProcessing = true;
  try {
    let next: QueuedTrackInfo | undefined;
    if (q.tracks.length > 0) {
      if (q.shuffle) {
        const idx = Math.floor(Math.random() * q.tracks.length);
        next = q.tracks.splice(idx, 1)[0];
      } else {
        next = q.tracks.shift();
      }
    }
    if (!next) {
      delete q.current;
      logger.info({ guildId }, 'Cola vacía, no hay más canciones');
      return;
    }
    q.current = next;
    await ensurePlayerConnected(player, 6000);

    const playerInfo = await player.node.rest.getPlayer(guildId);
    const voice = playerInfo?.voice;
    if (!voice) throw new Error('No voice info al reproducir siguiente');
    const played = await attemptPlayEncoded(guildId, player, next, voice, playerInfo?.volume ?? 100);
    if (!played) {
      // intentar re-resolver y reintentar
      await retryOrSkipCurrent(guildId, player, 'patch_failed');
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

  const onEnd = async (data?: any) => {
    try {
      const reason = (data as any)?.reason as string | undefined;
      const ended = q.current;

      // Solo reencolar en FINISHED; en STOPPED/REPLACED/CLEANUP no reencolar
      if (ended && reason === 'FINISHED') {
        if (q.loopMode === 'track') {
          q.tracks.unshift(ended);
        } else if (q.loopMode === 'queue') {
          q.tracks.push(ended);
        }
      }
      // Siempre limpiar current al finalizar
      delete q.current;

      // Avanzar sólo si FINISHED o STOPPED (skip manual) o CLEANUP, pero no en REPLACED (ya se puso otro track)
      if (reason !== 'REPLACED') {
        await playNext(guildId, player);
      }
    } catch (e) {
      logger.error({ e }, 'Error en auto-next al terminar track');
    }
  };

  const onFail = async (data?: any) => {
    try {
      logger.warn({ event: (data as any)?.type, err: (data as any)?.exception, guildId }, 'Evento de fallo de reproducción');
      await retryOrSkipCurrent(guildId, player, 'event_fail');
    } catch (e) {
      logger.error({ e }, 'Error manejando falla de track');
    }
  };

  const onUpdate = (data: PlayerUpdate) => {
    // podemos usar update para verificar conexión si se requiere
    return data;
  };

  player.on('end', onEnd as any);
  player.on('stuck', onFail as any);
  player.on('exception', onFail as any);
  player.on('update', onUpdate as any);

  q.listenersAttached = true;
}

async function attemptPlayEncoded(
  guildId: string,
  player: Player,
  track: QueuedTrackInfo,
  voice: { token: string; endpoint: string; sessionId: string },
  volume: number
): Promise<boolean> {
  try {
    const res = await patchPlayer(player, guildId, {
      encodedTrack: track.encoded,
      volume,
      paused: false,
      voice: {
        token: voice.token,
        endpoint: voice.endpoint,
        sessionId: voice.sessionId,
      },
    });
    if (!res.ok) {
      const txt = await res.text();
      logger.warn({ status: res.status, txt, title: track.info?.title, uri: track.info?.uri }, 'No se pudo iniciar reproducción con encoded actual');
      return false;
    }
    return true;
  } catch (e) {
    logger.warn({ e, title: track.info?.title, uri: track.info?.uri }, 'Excepción al intentar iniciar reproducción');
    return false;
  }
}

function extractYouTubeId(uri?: string): string | undefined {
  if (!uri) return undefined;
  const m = uri.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m?.[1];
}

async function resolveReplacementTrack(player: Player, t: QueuedTrackInfo): Promise<QueuedTrackInfo | undefined> {
  try {
    const id = extractYouTubeId(t.info?.uri);
    const queries: string[] = [];
    if (id) {
      queries.push(`https://www.youtube.com/watch?v=${id}`);
      queries.push(`ytsearch:${id}`);
    }
    const title = t.info?.title?.trim();
    const author = t.info?.author?.trim();
    if (title && author) queries.push(`ytsearch:${title} ${author}`);
    if (title) queries.push(`ytsearch:${title}`);

    for (const q of queries) {
      const res = await player.node.rest.resolve(q);
      if (!res) continue;
      if (res.loadType === 'track' && res.data) {
        const nt = res.data as any;
        return { encoded: nt.encoded, info: nt.info } as QueuedTrackInfo;
      }
      if (res.loadType === 'search' && Array.isArray(res.data) && res.data[0]) {
        const nt = res.data[0] as any;
        return { encoded: nt.encoded, info: nt.info } as QueuedTrackInfo;
      }
      if (res.loadType === 'playlist' && Array.isArray((res as any).data?.tracks) && (res as any).data.tracks[0]) {
        const nt = (res as any).data.tracks[0] as any;
        return { encoded: nt.encoded, info: nt.info } as QueuedTrackInfo;
      }
    }
  } catch (e) {
    logger.warn({ e }, 'Fallo resolviendo reemplazo de track');
  }
  return undefined;
}

async function retryOrSkipCurrent(guildId: string, player: Player, reason: string): Promise<void> {
  const q = getQueue(guildId);
  if (q.isProcessing) return;
  q.isProcessing = true;
  try {
    const current = q.current;
    if (!current) {
      await playNext(guildId, player);
      return;
    }
    current.retries = (current.retries ?? 0) + 1;
    logger.info({ title: current.info?.title, retries: current.retries, reason }, 'Intento de recuperación de track fallido');

    if ((current.retries ?? 0) > 2) {
      logger.warn({ title: current.info?.title, uri: current.info?.uri }, 'Track fallido tras múltiples reintentos, saltando');
      delete q.current;
      await playNext(guildId, player);
      return;
    }

    await ensurePlayerConnected(player, 6000);
    const playerInfo = await player.node.rest.getPlayer(guildId);
    const voice = playerInfo?.voice;
    if (!voice) throw new Error('No voice info al reintentar');

    const replacement = await resolveReplacementTrack(player, current);
    if (!replacement) {
      logger.warn({ title: current.info?.title }, 'No se pudo encontrar reemplazo para el track, avanzando');
      delete q.current;
      await playNext(guildId, player);
      return;
    }

    // Actualizar track actual con el reemplazo y reintentar
    current.encoded = replacement.encoded;
    current.info = replacement.info || current.info;

    const played = await attemptPlayEncoded(guildId, player, current, voice, playerInfo?.volume ?? 100);
    if (!played) {
      // Si sigue fallando, intentar inmediatamente siguiente
      logger.warn({ title: current.info?.title }, 'Reintento fallido, avanzando a siguiente');
      delete q.current;
      await playNext(guildId, player);
      return;
    }
    logger.info({ title: current.info?.title }, 'Reproduciendo tras re-resolución');
  } finally {
    q.isProcessing = false;
  }
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

async function patchPlayer(player: Player, guildId: string, body: Record<string, unknown>) {
  const sessionId = player.node.sessionId;
  const url = `http://localhost:2333/v4/sessions/${sessionId}/players/${guildId}`;
  return fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': 'youshallnotpass',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export async function setPaused(guildId: string, player: Player, paused: boolean): Promise<boolean> {
  try {
    const res = await patchPlayer(player, guildId, { paused });
    return res.ok;
  } catch (e) {
    logger.error({ e }, 'Error al pausar/reanudar');
    return false;
  }
}

export async function stopPlayback(guildId: string, player: Player): Promise<boolean> {
  try {
    const q = getQueue(guildId);
    q.tracks = [];
    delete q.current;
    const res = await patchPlayer(player, guildId, { encodedTrack: null });
    return res.ok;
  } catch (e) {
    logger.error({ e }, 'Error al detener reproducción');
    return false;
  }
}

export async function seekTo(guildId: string, player: Player, positionMs: number): Promise<boolean> {
  try {
    const res = await patchPlayer(player, guildId, { position: Math.max(0, Math.floor(positionMs)) });
    return res.ok;
  } catch (e) {
    logger.error({ e }, 'Error al hacer seek');
    return false;
  }
}

export async function setVolume(guildId: string, player: Player, volume: number): Promise<boolean> {
  try {
    const vol = Math.max(0, Math.min(150, Math.floor(volume)));
    const res = await patchPlayer(player, guildId, { volume: vol });
    return res.ok;
  } catch (e) {
    logger.error({ e }, 'Error al cambiar volumen');
    return false;
  }
}

export function setLoop(guildId: string, mode: LoopMode) {
  const q = getQueue(guildId);
  q.loopMode = mode;
}

export function toggleShuffle(guildId: string): boolean {
  const q = getQueue(guildId);
  q.shuffle = !q.shuffle;
  return q.shuffle;
}

export function removeAt(guildId: string, index: number): QueuedTrackInfo | undefined {
  const q = getQueue(guildId);
  if (Number.isNaN(index) || index < 0 || index >= q.tracks.length) return undefined;
  return q.tracks.splice(index, 1)[0];
}

export function getQueuePreview(guildId: string, limit: number = 10) {
  const q = getQueue(guildId);
  const upcoming = q.tracks.slice(0, limit);
  return {
    current: q.current,
    upcoming,
    total: q.tracks.length,
    loopMode: q.loopMode,
    shuffle: q.shuffle,
  };
}


