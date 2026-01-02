import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ActivityType,
  ChannelType,
  GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type VoiceState,
} from "discord.js";
import icy from "icy";
import type { IncomingMessage } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import { PassThrough, Transform, type TransformCallback } from "node:stream";
import type { Readable } from "node:stream";

type IcyHandle = {
  req: http.ClientRequest;
  res: IncomingMessage;
  audioStream: Readable;
  demuxer: IcyDemuxer | null;
};

type GuildSession = {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  streamUrl: string;

  connection: VoiceConnection;
  player: AudioPlayer;

  icy?: IcyHandle;
  currentTitle: string | null;

  restartAttempts: number;
  lastRetryNoticeAt: number;

  idleTimer?: NodeJS.Timeout;
  stopping: boolean;
};

type SendableChannel = {
  send: (options: { content: string }) => Promise<unknown>;
};

const PRESENCE_TITLE_MAX = 128;
const STREAM_OPEN_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

function log(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}

class IcyDemuxer extends Transform {
  private remainingAudio: number;
  private expectingMetadataLength = false;
  private remainingMetadata = 0;
  private metadataParts: Buffer[] = [];

  constructor(private metaint: number) {
    super();
    this.remainingAudio = metaint;
    log("[IcyDemuxer] creado con metaint:", metaint);
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;

      while (offset < chunk.length) {
        if (this.remainingAudio > 0) {
          const toCopy = Math.min(this.remainingAudio, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + toCopy));
          offset += toCopy;
          this.remainingAudio -= toCopy;

          if (this.remainingAudio === 0) {
            this.expectingMetadataLength = true;
          }

          continue;
        }

        if (this.expectingMetadataLength) {
          const lengthByte = chunk[offset];
          offset += 1;
          this.remainingMetadata = lengthByte * 16;
          this.expectingMetadataLength = false;

          if (this.remainingMetadata === 0) {
            this.remainingAudio = this.metaint;
          } else {
            this.metadataParts = [];
          }

          continue;
        }

        // leyendo metadata
        const toCopy = Math.min(this.remainingMetadata, chunk.length - offset);
        this.metadataParts.push(chunk.subarray(offset, offset + toCopy));
        offset += toCopy;
        this.remainingMetadata -= toCopy;

        if (this.remainingMetadata === 0) {
          const metadata = Buffer.concat(this.metadataParts);
          this.metadataParts = [];
          this.emit("metadata", metadata);
          this.remainingAudio = this.metaint;
        }
      }

      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

export class RadioManager {
  private sessions = new Map<string, GuildSession>();
  private lastPresenceAt = 0;
  private lastPresenceTitle: string | null = null;

  constructor(
    private client: Client,
    private idleDisconnectMinutes: number,
  ) {}

  public async play(
    interaction: ChatInputCommandInteraction,
    rawUrl: string,
  ): Promise<void> {
    // Defer lo más pronto posible (Discord da solo 3 segundos)
    try {
      await interaction.deferReply();
    } catch (err) {
      log("[play] deferReply falló (interacción expirada?):", err);
      return; // No podemos continuar si no podemos responder
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply(
        "Este comando solo funciona dentro de un servidor (no en DM).",
      ).catch(() => null);
      return;
    }

    const url = this.normalizeUrl(rawUrl);
    if (!url) {
      await interaction.editReply(
        "La URL configurada en `RADIO_STREAM_URL` es inválida. Debe ser http/https.",
      ).catch(() => null);
      return;
    }

    const member = interaction.member;
    if (!(member instanceof GuildMember)) {
      await interaction.editReply("No pude obtener tu estado de voz (intenta de nuevo).").catch(() => null);
      return;
    }

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.editReply(
        "Primero entra a un canal de voz y luego usa `/play`.",
      ).catch(() => null);
      return;
    }

    if (
      voiceChannel.type !== ChannelType.GuildVoice &&
      voiceChannel.type !== ChannelType.GuildStageVoice
    ) {
      await interaction.editReply("Ese canal no es compatible para reproducir audio.").catch(() => null);
      return;
    }

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const perms = me ? voiceChannel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak)) {
      await interaction.editReply(
        "No tengo permisos para **Conectar** y **Hablar** en ese canal de voz.",
      ).catch(() => null);
      return;
    }

    const guildId = guild.id;
    const existing = this.sessions.get(guildId);

    // Verificar si la sesión existente sigue válida
    const connectionDestroyed =
      existing &&
      existing.connection.state.status === VoiceConnectionStatus.Destroyed;

    const needsNewConnection =
      !existing ||
      existing.voiceChannelId !== voiceChannel.id ||
      existing.stopping ||
      connectionDestroyed;

    if (existing && needsNewConnection) {
      log("[play] deteniendo sesión anterior (destroyed:", connectionDestroyed, ")...");
      await this.stop(guildId);
    }

    const session =
      this.sessions.get(guildId) ??
      this.createSession({
        guildId,
        voiceChannelId: voiceChannel.id,
        textChannelId: interaction.channelId,
        streamUrl: url,
        adapterCreator: guild.voiceAdapterCreator,
      });

    // Actualiza contexto (por si ejecutan /play desde otro canal de texto)
    session.textChannelId = interaction.channelId;
    session.voiceChannelId = voiceChannel.id;
    session.streamUrl = url;
    session.stopping = false;
    session.restartAttempts = 0;

    await interaction.editReply(
      `Reproduciendo en **${voiceChannel.name}**.`,
    ).catch(() => null);

    await this.startOrReplaceStream(session);
    await this.refreshIdleTimer(session);
  }

  public onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const guildId = newState.guild.id;
    const session = this.sessions.get(guildId);
    if (!session || session.stopping) return;

    const touchedChannelId = oldState.channelId ?? newState.channelId;
    if (!touchedChannelId) return;

    if (touchedChannelId !== session.voiceChannelId) return;
    void this.refreshIdleTimer(session);
  }

  public async shutdown(): Promise<void> {
    const guildIds = [...this.sessions.keys()];
    await Promise.all(guildIds.map((id) => this.stop(id)));
  }

  private createSession(params: {
    guildId: string;
    voiceChannelId: string;
    textChannelId: string;
    streamUrl: string;
    adapterCreator: unknown;
  }): GuildSession {
    log("[createSession] uniendo a canal de voz:", params.voiceChannelId);

    const connection = joinVoiceChannel({
      channelId: params.voiceChannelId,
      guildId: params.guildId,
      adapterCreator: params.adapterCreator as never,
      selfDeaf: true,
    });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    connection.subscribe(player);

    const session: GuildSession = {
      guildId: params.guildId,
      voiceChannelId: params.voiceChannelId,
      textChannelId: params.textChannelId,
      streamUrl: params.streamUrl,
      connection,
      player,
      currentTitle: null,
      restartAttempts: 0,
      lastRetryNoticeAt: 0,
      stopping: false,
    };

    // Escuchar cambios de estado de la conexión
    connection.on("stateChange", (oldState, newState) => {
      log("[connection] stateChange:", oldState.status, "->", newState.status);

      // Si la conexión fue destruida externamente (ej: alguien desconectó al bot)
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        log("[connection] conexión destruida externamente, limpiando sesión...");
        if (!session.stopping) {
          session.stopping = true;
          this.closeIcy(session);
          this.sessions.delete(params.guildId);
          this.syncPresence();
        }
      }

      // Si se desconectó, intentar reconectar o limpiar
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        log("[connection] desconectado, verificando si es recuperable...");

        // Intentar reconectar si es posible
        Promise.race([
          new Promise<boolean>((resolve) => {
            // Esperar a que vuelva a Ready o se destruya
            const onStateChange = (
              _: { status: VoiceConnectionStatus },
              ns: { status: VoiceConnectionStatus },
            ) => {
              if (ns.status === VoiceConnectionStatus.Ready) {
                connection.off("stateChange", onStateChange);
                resolve(true);
              } else if (ns.status === VoiceConnectionStatus.Destroyed) {
                connection.off("stateChange", onStateChange);
                resolve(false);
              }
            };
            connection.on("stateChange", onStateChange);
          }),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]).then((recovered) => {
          if (!recovered && !session.stopping) {
            log("[connection] no se pudo reconectar, limpiando sesión...");
            void this.stop(params.guildId);
          }
        });
      }
    });

    connection.on("error", (err) => {
      log("[connection] error:", err.message);
    });

    player.on("error", (err) => {
      log("[player] error:", err.message);
      void this.handleStreamFailure(session, `Error de reproducción: ${err.message}`);
    });

    player.on("stateChange", (oldState, newState) => {
      log("[player] stateChange:", oldState.status, "->", newState.status);
      if (session.stopping) return;
      if (
        oldState.status !== AudioPlayerStatus.Idle &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        void this.handleStreamFailure(session, "El stream se detuvo/terminó.");
      }
    });

    this.sessions.set(params.guildId, session);
    return session;
  }

  private async waitForConnectionReady(
    connection: VoiceConnection,
    timeoutMs: number,
  ): Promise<boolean> {
    // Si ya está Ready, retornar inmediatamente
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      log("[waitForConnectionReady] ya está Ready");
      return true;
    }

    // Si está Destroyed o es un estado terminal malo, fallar
    if (connection.state.status === VoiceConnectionStatus.Destroyed) {
      log("[waitForConnectionReady] conexión destruida");
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        log("[waitForConnectionReady] timeout esperando Ready");
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onStateChange = (
        _oldState: { status: VoiceConnectionStatus },
        newState: { status: VoiceConnectionStatus },
      ) => {
        log("[waitForConnectionReady] state:", newState.status);
        if (newState.status === VoiceConnectionStatus.Ready) {
          cleanup();
          resolve(true);
        } else if (newState.status === VoiceConnectionStatus.Destroyed) {
          cleanup();
          resolve(false);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        connection.off("stateChange", onStateChange);
      };

      connection.on("stateChange", onStateChange);
    });
  }

  private async startOrReplaceStream(session: GuildSession): Promise<void> {
    log("[startOrReplaceStream] iniciando...");
    this.closeIcy(session);

    // Esperar a que la conexión de voz esté lista
    const ready = await this.waitForConnectionReady(session.connection, 30_000);
    if (!ready) {
      log("[startOrReplaceStream] conexión no llegó a Ready");
      await this.sendText(
        session,
        "No pude conectar al canal de voz (timeout). Intenta de nuevo.",
      );
      await this.stop(session.guildId);
      return;
    }

    log("[startOrReplaceStream] conexión Ready, abriendo stream...");

    let icyHandle: IcyHandle;
    try {
      icyHandle = await this.openIcyStream(session.streamUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("[startOrReplaceStream] error abriendo stream:", msg);
      await this.sendText(session, `No pude abrir el stream: ${msg}`);
      await this.stop(session.guildId);
      return;
    }

    session.icy = icyHandle;
    log("[startOrReplaceStream] stream abierto, configurando metadata listener...");

    // Metadata ICY (si existe demuxer)
    if (icyHandle.demuxer) {
      icyHandle.demuxer.on("metadata", (metadata: Buffer) => {
        try {
          const parsed = icy.parse(metadata);
          const title = (parsed.StreamTitle ?? "").trim();
          log("[metadata] título:", title || "(vacío)");
          if (!title) return;
          if (title === session.currentTitle) return;
          session.currentTitle = title;
          this.setPresenceThrottled(title);
        } catch (e) {
          log("[metadata] error parseando:", e);
        }
      });
    }

    // Crear el recurso de audio
    log("[startOrReplaceStream] creando AudioResource...");

    // Usamos un PassThrough para evitar que el stream se cierre prematuramente
    const audioPassThrough = new PassThrough();

    icyHandle.audioStream.on("error", (err) => {
      log("[audioStream] error:", err.message);
      audioPassThrough.destroy(err);
    });

    icyHandle.audioStream.on("close", () => {
      log("[audioStream] close");
    });

    icyHandle.audioStream.on("end", () => {
      log("[audioStream] end");
      audioPassThrough.end();
    });

    icyHandle.audioStream.pipe(audioPassThrough);

    const resource = createAudioResource(audioPassThrough, {
      inputType: StreamType.Arbitrary,
    });

    log("[startOrReplaceStream] reproduciendo...");
    session.player.play(resource);

    // Presencia base si no llega metadata
    if (!session.currentTitle) {
      this.setPresenceThrottled("Radio");
    }
  }

  private async handleStreamFailure(
    session: GuildSession,
    reason: string,
  ): Promise<void> {
    if (session.stopping) return;

    const maxRetries = 5;
    session.restartAttempts += 1;

    log("[handleStreamFailure]", reason, `intento ${session.restartAttempts}/${maxRetries}`);

    const now = Date.now();
    if (now - session.lastRetryNoticeAt > 15_000) {
      session.lastRetryNoticeAt = now;
      await this.sendText(
        session,
        `${reason}\nReintentando (${session.restartAttempts}/${maxRetries})...`,
      );
    }

    if (session.restartAttempts >= maxRetries) {
      await this.sendText(
        session,
        "No pude mantener el stream activo. Me desconecto.",
      );
      await this.stop(session.guildId);
      return;
    }

    await new Promise((r) => setTimeout(r, 3_000));
    await this.startOrReplaceStream(session);
  }

  private openIcyStream(url: string, redirectDepth = 0): Promise<IcyHandle> {
    log("[openIcyStream] abriendo:", url, "redirect depth:", redirectDepth);

    return new Promise((resolve, reject) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        reject(new Error("URL inválida"));
        return;
      }

      const protocol = parsedUrl.protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        reject(new Error(`Protocolo no soportado: ${protocol}`));
        return;
      }

      const lib = protocol === "https:" ? https : http;
      let settled = false;

      const req = lib.get(
        parsedUrl,
        {
          headers: {
            "User-Agent": "monkey-bot/0.1 (discord radio bot)",
            "Icy-MetaData": "1",
            Accept: "*/*",
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          log("[openIcyStream] respuesta status:", status);

          // Redirects comunes
          if (
            [301, 302, 303, 307, 308].includes(status) &&
            typeof res.headers.location === "string"
          ) {
            if (redirectDepth >= MAX_REDIRECTS) {
              res.resume();
              res.destroy();
              if (!settled) {
                settled = true;
                reject(new Error("Demasiados redirects abriendo el stream"));
              }
              return;
            }

            const nextUrl = new URL(res.headers.location, parsedUrl).toString();
            log("[openIcyStream] siguiendo redirect a:", nextUrl);
            res.resume();
            res.destroy();
            this.openIcyStream(nextUrl, redirectDepth + 1).then(resolve, reject);
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            res.destroy();
            if (!settled) {
              settled = true;
              reject(new Error(`HTTP ${status}`));
            }
            return;
          }

          // Leer headers ICY
          const metaintRaw = res.headers["icy-metaint"];
          const metaintStr = Array.isArray(metaintRaw) ? metaintRaw[0] : metaintRaw;
          const metaint = Number.parseInt(String(metaintStr ?? ""), 10);

          log("[openIcyStream] icy-metaint:", metaintRaw, "->", metaint);
          log("[openIcyStream] content-type:", res.headers["content-type"]);

          if (Number.isFinite(metaint) && metaint > 0) {
            const demuxer = new IcyDemuxer(metaint);

            res.on("error", (err) => {
              log("[openIcyStream] res error:", err.message);
              demuxer.destroy(err);
            });

            res.pipe(demuxer);

            if (!settled) {
              settled = true;
              resolve({ req, res, audioStream: demuxer, demuxer });
            }
            return;
          }

          // Si el server no entrega icy-metaint, reproducimos sin metadata
          log("[openIcyStream] sin icy-metaint, reproduciendo sin metadata");
          if (!settled) {
            settled = true;
            resolve({ req, res, audioStream: res, demuxer: null });
          }
        },
      );

      const timeout = setTimeout(() => {
        log("[openIcyStream] timeout!");
        if (!settled) {
          settled = true;
          req.destroy();
          reject(new Error("Timeout abriendo stream"));
        }
      }, STREAM_OPEN_TIMEOUT_MS);

      req.on("error", (err) => {
        log("[openIcyStream] req error:", err.message);
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      req.on("response", () => {
        clearTimeout(timeout);
      });
    });
  }

  private closeIcy(session: GuildSession): void {
    const handle = session.icy;
    session.icy = undefined;
    if (!handle) return;

    log("[closeIcy] cerrando stream...");

    try {
      handle.audioStream.removeAllListeners();
      handle.audioStream.destroy();
    } catch {
      // ignore
    }
    try {
      handle.res.removeAllListeners();
      handle.res.destroy();
    } catch {
      // ignore
    }
    try {
      handle.req.destroy();
    } catch {
      // ignore
    }
  }

  private async refreshIdleTimer(session: GuildSession): Promise<void> {
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) return;

    const channel = await guild.channels
      .fetch(session.voiceChannelId)
      .catch(() => null);

    if (!channel || !channel.isVoiceBased()) return;

    const listeners = channel.members.filter((m) => !m.user.bot).size;
    const isEmpty = listeners === 0;

    if (!isEmpty) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = undefined;
      }
      return;
    }

    if (session.idleTimer) return;

    const ms = Math.max(1, this.idleDisconnectMinutes) * 60_000;

    await this.sendText(
      session,
      `No hay usuarios escuchando. Si nadie vuelve en ${this.idleDisconnectMinutes} min, me desconecto.`,
    );

    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      void this.disconnectIfStillEmpty(session);
    }, ms);
  }

  private async disconnectIfStillEmpty(session: GuildSession): Promise<void> {
    if (session.stopping) return;
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) return;

    const channel = await guild.channels
      .fetch(session.voiceChannelId)
      .catch(() => null);
    if (!channel || !channel.isVoiceBased()) return;

    const listeners = channel.members.filter((m) => !m.user.bot).size;
    if (listeners > 0) return;

    await this.sendText(session, "No hay usuarios escuchando, ¡hasta pronto!");
    await this.stop(session.guildId);
  }

  private async stop(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) return;

    log("[stop] deteniendo sesión para guild:", guildId);
    session.stopping = true;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }

    this.closeIcy(session);

    try {
      session.player.stop(true);
    } catch {
      // ignore
    }

    try {
      session.connection.destroy();
    } catch {
      // ignore
    }

    this.sessions.delete(guildId);
    this.syncPresence();
  }

  private async sendText(session: GuildSession, content: string): Promise<void> {
    if (!session.textChannelId) return;
    const channel =
      this.client.channels.cache.get(session.textChannelId) ??
      (await this.client.channels.fetch(session.textChannelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return;
    if (typeof (channel as unknown as Partial<SendableChannel>).send !== "function") return;
    await (channel as unknown as SendableChannel).send({ content }).catch(() => null);
  }

  private setPresenceThrottled(title: string): void {
    const now = Date.now();
    const normalized = title.trim();
    if (!normalized) return;
    if (this.lastPresenceTitle === normalized && now - this.lastPresenceAt < 30_000) {
      return;
    }
    if (now - this.lastPresenceAt < 10_000) return;
    this.lastPresenceAt = now;
    this.lastPresenceTitle = normalized;

    const name =
      normalized.length > PRESENCE_TITLE_MAX
        ? normalized.slice(0, PRESENCE_TITLE_MAX - 1) + "…"
        : normalized;

    log("[presence] actualizando a:", name);

    this.client.user?.setPresence({
      activities: [{ name, type: ActivityType.Listening }],
      status: "online",
    });
  }

  private syncPresence(): void {
    const anySession = [...this.sessions.values()].find(
      (s) => !s.stopping && s.player.state.status === AudioPlayerStatus.Playing,
    );

    if (!anySession) {
      this.lastPresenceTitle = null;
      this.client.user?.setPresence({
        activities: [{ name: "Mirando fandoms.io", type: ActivityType.Playing }],
        status: "online",
      });
      return;
    }

    if (anySession.currentTitle) {
      this.setPresenceThrottled(anySession.currentTitle);
      return;
    }

    this.setPresenceThrottled("Radio");
  }

  private normalizeUrl(raw: string): string | null {
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.toString();
    } catch {
      return null;
    }
  }
}
