import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel, EmbedBuilder } from 'discord.js';
import type { Interaction } from 'discord.js';
import { logger } from './logger.js';
import type { Player, PlayerUpdate } from 'shoukaku';
import { createShoukaku } from './shoukaku.js';
import { attachPlayerAutoNext, enqueueTracks, getQueue, skipCurrent, startIfIdle, setPaused, stopPlayback, seekTo, setVolume, setLoop, toggleShuffle, removeAt, getQueuePreview, initializeAnnouncementFunction } from './queue.js';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

const token = getEnv('DISCORD_TOKEN');
const clientId = getEnv('DISCORD_CLIENT_ID');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember, Partials.Channel],
});

const shoukaku = createShoukaku(client);

// Inicializar la función de anuncio en queue.ts para evitar dependencias circulares
initializeAnnouncementFunction(sendPlayerAnnouncement);

// Función helper para crear botones de acción del player
export function createPlayerActionButtons(guildId: string, includeNext: boolean = true): ActionRowBuilder<ButtonBuilder>[] {
  const queue = getQueue(guildId);
  const player = shoukaku.players.get(guildId);
  
  const buttons: ButtonBuilder[] = [];

  // Botón Play/Pause
  if (player) {
    const playPauseBtn = new ButtonBuilder()
      .setCustomId('mb:toggle-pause')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⏯️');
    buttons.push(playPauseBtn);
  }

  // Botón Next (solo si hay canciones en cola)
  if (includeNext && queue.tracks.length > 0) {
    const nextBtn = new ButtonBuilder()
      .setCustomId('mb:next')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⏭️');
    buttons.push(nextBtn);
  }

  // Botón Stop
  const stopBtn = new ButtonBuilder()
    .setCustomId('mb:stop')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('⏹️');
  buttons.push(stopBtn);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  return [row];
}

// Función para enviar anuncios al canal de voz actual
export async function sendPlayerAnnouncement(
  guildId: string, 
  embedData: { title: string; description?: string; fields?: Array<{name: string, value: string, inline?: boolean}> }, 
  includeNext: boolean = true
): Promise<void> {
  try {
    const player = shoukaku.players.get(guildId);
    if (!player) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    // Buscar el canal de voz donde está el bot
    const voiceChannel = guild.channels.cache.find(
      (channel) => channel.type === 2 && // VoiceChannel
        channel.members?.has(client.user?.id || '')
    );

    if (!voiceChannel) return;

    // Buscar un canal de texto asociado o el primer canal de texto disponible
    let textChannel: TextChannel | null = null;
    
    // Intentar encontrar un canal de texto con nombre similar al canal de voz
    const similarTextChannel = guild.channels.cache.find(
      (channel) => channel.type === 0 && // TextChannel
        channel.name.includes(voiceChannel.name)
    ) as TextChannel;

    if (similarTextChannel) {
      textChannel = similarTextChannel;
    } else {
      // Si no, usar el primer canal de texto donde el bot pueda enviar mensajes
      textChannel = guild.channels.cache.find(
        (channel) => channel.type === 0 && // TextChannel
          channel.permissionsFor(client.user!)?.has('SendMessages')
      ) as TextChannel;
    }

    if (textChannel) {
      const embed = new EmbedBuilder()
        .setTitle(embedData.title)
        .setColor(0x7289DA); // Discord blurple color

      // Solo agregar autor si tenemos iconURL
      const iconURL = client.user?.displayAvatarURL();
      if (iconURL) {
        embed.setAuthor({ 
          name: 'MonkeyBot', 
          iconURL: iconURL
        });
        // Forzar ancho mínimo con un thumbnail
        embed.setThumbnail(iconURL);
      } else {
        embed.setAuthor({ name: 'MonkeyBot' });
      }

      if (embedData.description) {
        embed.setDescription(embedData.description);
      } else if (embedData.fields && embedData.fields.length > 0) {
        // Agregar espacio entre título y campos
        embed.setDescription('\u200B');
      }

      if (embedData.fields && embedData.fields.length > 0) {
        embed.addFields(embedData.fields);
      }

      const components = createPlayerActionButtons(guildId, includeNext);
      await textChannel.send({
        embeds: [embed],
        components
      });
    }
  } catch (error) {
    logger.error({ error, guildId }, 'Error enviando anuncio del player');
  }
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = [
    {
      name: 'ping',
      description: 'Respuesta de latencia',
    },
    {
      name: 'play',
      description: 'Reproducir una canción por URL o búsqueda',
      options: [
        {
          name: 'query',
          description: 'URL de YouTube o texto a buscar',
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: 'pause',
      description: 'Pausa la reproducción actual',
    },
    {
      name: 'resume',
      description: 'Reanuda la reproducción',
    },
    {
      name: 'seek',
      description: 'Salta a una posición (mm:ss o segundos)',
      options: [
        {
          name: 'pos',
          description: 'Posición destino (mm:ss o segundos)',
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: 'stop',
      description: 'Detiene la reproducción y limpia la cola',
    },
    {
      name: 'volume',
      description: 'Cambia el volumen (0-150)',
      options: [
        {
          name: 'value',
          description: 'Volumen 0-150',
          type: 4, // INTEGER
          required: true,
        },
      ],
    },
    {
      name: 'loop',
      description: 'Configura el modo de loop',
      options: [
        {
          name: 'mode',
          description: 'off | track | queue',
          type: 3,
          required: true,
          choices: [
            { name: 'off', value: 'off' },
            { name: 'track', value: 'track' },
            { name: 'queue', value: 'queue' },
          ],
        },
      ],
    },
    {
      name: 'shuffle',
      description: 'Alterna el modo aleatorio de la cola',
    },
    {
      name: 'remove',
      description: 'Elimina una canción de la cola por índice (desde 1)',
      options: [
        {
          name: 'index',
          description: 'Índice de la canción a eliminar (desde 1)',
          type: 4,
          required: true,
        },
      ],
    },
    {
      name: 'queue',
      description: 'Muestra la cola de reproducción',
    },
    {
      name: 'leave',
      description: 'Salir del canal de voz',
    },
    {
      name: 'next',
      description: 'Saltar a la siguiente canción en cola',
    },
    {
      name: 'status',
      description: 'Ver estado del reproductor',
    },
    {
      name: 'nowplaying',
      description: 'Ver qué está sonando actualmente',
    },
  ];
  const devGuildId = process.env.DEV_GUILD_ID;
  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body: commands });
    logger.info({ devGuildId }, 'Slash commands registrados (scoped a guild)');
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    logger.info('Slash commands registrados (globales)');
  }
}

client.once('ready', async () => {
  logger.info({ user: client.user?.tag }, 'Bot listo');
  try {
    await registerCommands();
    logger.info('Slash commands registrados');
  } catch (err) {
    logger.error({ err }, 'Error registrando slash commands');
  }
});

client.on('interactionCreate', async (interaction: Interaction) => {
  // Manejo de botones
  if (interaction.isButton()) {
    if (!interaction.guildId) return;
    const player = shoukaku.players.get(interaction.guildId);
    
    // Botón "Next"
    if (interaction.customId === 'mb:next') {
      if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
      const q = getQueue(interaction.guildId);
      if (q.tracks.length === 0) return interaction.reply({ content: 'ℹ️ No hay más canciones en cola.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const ok = await skipCurrent(interaction.guildId, player);
      if (ok) {
        await interaction.editReply('⏭️ Saltando a la siguiente...');
        // Desencadenar siguiente explícitamente para evitar esperar evento
        const q = getQueue(interaction.guildId);
        if (!q.isProcessing) {
          await startIfIdle(interaction.guildId, player);
        }
      } else {
        await interaction.editReply('ℹ️ No hay siguiente canción.');
      }
      return;
    }

    // Botón Play/Pause Toggle
    if (interaction.customId === 'mb:toggle-pause') {
      if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      
      try {
        // Obtener estado actual del player
        const playerInfo = await player.node.rest.getPlayer(interaction.guildId);
        const isCurrentlyPaused = playerInfo?.paused || false;
        const newPausedState = !isCurrentlyPaused;
        
        const ok = await setPaused(interaction.guildId, player, newPausedState);
        if (ok) {
          await interaction.editReply(newPausedState ? '⏸️ Pausado.' : '▶️ Reanudado.');
        } else {
          await interaction.editReply('❌ No se pudo cambiar el estado.');
        }
      } catch (e) {
        logger.error({ e }, 'Error en toggle pause button');
        await interaction.editReply('❌ Error al cambiar el estado.');
      }
      return;
    }

    // Botón Stop
    if (interaction.customId === 'mb:stop') {
      if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const ok = await stopPlayback(interaction.guildId, player);
      await interaction.editReply(ok ? '⏹️ Reproducción detenida y cola limpia.' : '❌ No se pudo detener.');
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'ping') {
    await interaction.reply(`Pong!`);
  }
  // Controles básicos
  if (interaction.commandName === 'pause' || interaction.commandName === 'resume') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const player = shoukaku.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
    const paused = interaction.commandName === 'pause';
    await interaction.deferReply({ ephemeral: true });
    const ok = await setPaused(interaction.guildId, player, paused);
    await interaction.editReply(ok ? (paused ? '⏸️ Pausado.' : '▶️ Reanudado.') : '❌ No se pudo cambiar el estado.');
    return;
  }
  if (interaction.commandName === 'seek') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const player = shoukaku.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
    const raw = interaction.options.get('pos', true).value as string;
    let ms = 0;
    if (/^\d{1,2}:\d{2}$/.test(raw)) {
      const parts = raw.split(':');
      const minutes = parseInt(parts[0] ?? '0', 10);
      const seconds = parseInt(parts[1] ?? '0', 10);
      ms = ((Number.isFinite(minutes) ? minutes : 0) * 60 + (Number.isFinite(seconds) ? seconds : 0)) * 1000;
    } else if (/^\d+$/.test(raw)) {
      ms = parseInt(raw, 10) * 1000;
    } else {
      return interaction.reply({ content: 'Formato inválido. Usa mm:ss o segundos.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const ok = await seekTo(interaction.guildId, player, ms);
    await interaction.editReply(ok ? `⏩ Avanzado a ${raw}.` : '❌ No se pudo hacer seek.');
    return;
  }
  if (interaction.commandName === 'stop') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const player = shoukaku.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const ok = await stopPlayback(interaction.guildId, player);
    await interaction.editReply(ok ? '⏹️ Reproducción detenida y cola limpia.' : '❌ No se pudo detener.');
    return;
  }
  if (interaction.commandName === 'volume') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const player = shoukaku.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
    const value = interaction.options.get('value', true).value as number;
    await interaction.deferReply({ ephemeral: true });
    const ok = await setVolume(interaction.guildId, player, value);
    await interaction.editReply(ok ? `🔊 Volumen: ${Math.max(0, Math.min(150, Math.floor(value)))}%` : '❌ No se pudo cambiar el volumen.');
    return;
  }
  if (interaction.commandName === 'loop') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const mode = interaction.options.get('mode', true).value as 'off' | 'track' | 'queue';
    setLoop(interaction.guildId, mode);
    await interaction.reply({ content: `🔁 Loop: ${mode}`, ephemeral: true });
    return;
  }
  if (interaction.commandName === 'shuffle') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const on = toggleShuffle(interaction.guildId);
    await interaction.reply({ content: on ? '🔀 Shuffle activado.' : '➡️ Shuffle desactivado.', ephemeral: true });
    return;
  }
  if (interaction.commandName === 'remove') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const index1 = interaction.options.get('index', true).value as number;
    const removed = removeAt(interaction.guildId, index1 - 1);
    await interaction.reply({ content: removed ? `🗑️ Eliminado: ${removed.info?.title || 'Desconocido'}` : '❌ Índice inválido.', ephemeral: true });
    return;
  }
  if (interaction.commandName === 'queue') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const q = getQueuePreview(interaction.guildId, 10);
    const lines = [] as string[];
    if (q.current) lines.push(`▶️ ${q.current.info?.title || 'Desconocido'} (${q.current.info?.author || ''})`);
    q.upcoming.forEach((t, i) => lines.push(`${i + 1}. ${t.info?.title || 'Desconocido'} (${t.info?.author || ''})`));
    const suffix = q.total > q.upcoming.length ? `\n... y ${q.total - q.upcoming.length} más` : '';
    await interaction.reply({ content: lines.length ? `${lines.join('\n')}${suffix}\nLoop: ${q.loopMode} | Shuffle: ${q.shuffle ? 'on' : 'off'}` : '📭 Cola vacía.' });
    return;
  }
  if (interaction.commandName === 'leave') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      await shoukaku.leaveVoiceChannel(interaction.guildId);
      await interaction.editReply('Salí del canal de voz.');
    } catch (err) {
      await interaction.editReply('No pude salir del canal o no estaba conectado.');
    }
    return;
  }
  if (interaction.commandName === 'play') {
    if (!interaction.guild || !interaction.guildId) {
      return interaction.reply({ content: 'Este comando solo funciona en servidores.', ephemeral: true });
    }
    const member = interaction.member;
    // @ts-expect-error - GuildMember typing at runtime
    const voiceId = member?.voice?.channelId as string | undefined;
    if (!voiceId) {
      return interaction.reply({ content: 'Debes estar en un canal de voz.', ephemeral: true });
    }
    const query = interaction.options.get('query', true).value as string;
    await interaction.deferReply();
    try {
      // VERIFICAR SI YA HAY UNA CONEXIÓN EXISTENTE
      let player = shoukaku.players.get(interaction.guildId);

      if (!player) {
        logger.info('Creando nueva conexión de voz...');
        player = await shoukaku.joinVoiceChannel({
          guildId: interaction.guildId,
          channelId: voiceId,
          shardId: interaction.guild.shardId,
          deaf: true,
        });
        logger.info({ node: player.node.name }, 'Player creado en nodo');
      } else {
        logger.info('Usando conexión de voz existente...');
        // Verificar que el player esté en el canal correcto
        const currentChannelId = (player as any).connection?.channelId;
        if (currentChannelId !== voiceId) {
          logger.info('Moviendo player a nuevo canal de voz...');
          await player.move(voiceId);
        }
      }

      const node = player.node;
      // Esperar a que se complete el handshake de voz con Discord → Lavalink
      await waitForPlayerConnected(player, 6000);
      // Adjuntar auto-next si no está
      attachPlayerAutoNext(interaction.guildId, player);
      
      // Determinar el tipo de búsqueda para LavaSrc
      let search: string;
      const isUrl = /^https?:\/\//i.test(query);
      
      let playlistUrlCandidate: string | undefined;
      if (isUrl) {
        try {
          const url = new URL(query);
          const hostname = url.hostname.toLowerCase();
          
          // Manejar diferentes plataformas directamente con LavaSrc
          if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            // Si es una playlist o tiene parámetro list=, forzar URL de playlist
            const listParam = url.searchParams.get('list');
            if (listParam && !url.pathname.startsWith('/playlist')) {
              playlistUrlCandidate = `https://www.youtube.com/playlist?list=${listParam}`;
              search = playlistUrlCandidate;
            } else {
              // Para URLs de YouTube, usar la URL directa - LavaSrc/Lavalink la manejará
              search = query;
            }
          } else if (hostname.includes('spotify.com')) {
            search = query; // LavaSrc puede manejar Spotify si está configurado
          } else {
            // Para otras URLs, intentar directamente
            search = query;
          }
        } catch (error) {
          // Si falla el parseo de URL, tratar como búsqueda de texto
          search = `ytsearch:${query}`;
        }
      } else {
        // Para búsquedas de texto, usar ytsearch
        search = `ytsearch:${query}`;
      }
      
      logger.info({ originalQuery: query, search, isUrl }, 'Iniciando búsqueda');

      // AGREGAR MÁS DEBUGGING PARA LAVASRC
      logger.info({
        nodeName: node.name,
        nodeState: node.state,
        nodeStats: node.stats
      }, 'Estado del nodo antes de búsqueda');

      let res = await node.rest.resolve(search);
      const tracksCount = res?.loadType === 'playlist' ? (res.data as any)?.tracks?.length :
                         res?.loadType === 'search' ? (res.data as any)?.length :
                         res?.data ? 1 : 0;

      logger.info({
        search,
        loadType: res?.loadType,
        tracksCount,
        dataType: typeof res?.data,
        hasData: !!res?.data,
        dataKeys: res?.data ? Object.keys(res.data) : []
      }, 'Resultado de búsqueda detallado');
      
      // FALLBACKS MEJORADOS PARA LAVASRC
      if (!res || res.loadType === 'empty' || res.loadType === 'error') {
        logger.warn({ original: search, loadType: res?.loadType, error: res?.data }, 'Búsqueda inicial falló, intentando fallbacks');

        // PRIORIDAD PLAYLIST: si detectamos lista, intentar en nodo fallback (plugin oficial) antes de degradar a búsquedas
        if (playlistUrlCandidate && shoukaku.nodes.size > 1) {
          const fallbackNode = Array.from(shoukaku.nodes.values()).find(n => n.name === 'yt-plugin');
          if (fallbackNode) {
            logger.info({ node: fallbackNode.name, playlistUrlCandidate }, 'Intentando resolver playlist en nodo fallback primero');
            try {
              res = await fallbackNode.rest.resolve(playlistUrlCandidate);
            } catch (e) {
              logger.warn({ e }, 'Fallo resolviendo playlist en nodo fallback');
            }
          }
        }

        // Si aún no hay resultados, intentar con ytsearch directo
        if (!res || res.loadType === 'empty' || res.loadType === 'error') {
          const fallback1 = `ytsearch:${query}`;
          logger.info({ fallback1 }, 'Intentando primer fallback');
          res = await node.rest.resolve(fallback1);
        }

        // SEGUNDO FALLBACK: Si es URL, extraer ID de YouTube
        if ((!res || res.loadType === 'empty' || res.loadType === 'error') && isUrl) {
          const ytIdMatch = query.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          if (ytIdMatch) {
            const fallback2 = `https://www.youtube.com/watch?v=${ytIdMatch[1]}`;
            logger.info({ fallback2 }, 'Intentando segundo fallback con URL directa');
            res = await node.rest.resolve(fallback2);
          }
        }

        // TERCER FALLBACK: Buscar solo el ID de YouTube
        if ((!res || res.loadType === 'empty' || res.loadType === 'error') && isUrl) {
          const ytIdMatch = query.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          if (ytIdMatch) {
            const fallback3 = `ytsearch:${ytIdMatch[1]}`;
            logger.info({ fallback3 }, 'Intentando tercer fallback con ytsearch:ID');
            res = await node.rest.resolve(fallback3);
          }
        }

        // ÚLTIMO FALLBACK: si seguimos sin resultados, probar en el nodo fallback (plugin oficial)
        if ((!res || res.loadType === 'empty' || res.loadType === 'error') && shoukaku.nodes.size > 1) {
          const fallbackNode = Array.from(shoukaku.nodes.values()).find(n => n.name === 'yt-plugin');
          if (fallbackNode) {
            logger.info({ node: fallbackNode.name }, 'Intentando resolver en nodo fallback');
            try {
              res = await fallbackNode.rest.resolve(search);
            } catch (e) {
              logger.warn({ e }, 'Fallo resolviendo en nodo fallback');
            }
          }
        }
      }
      if (!res || res.loadType === 'empty' || res.loadType === 'error') {
        logger.warn({ res }, 'Resolver sin resultados (tras reintento)');
        await interaction.editReply('No se encontraron resultados.');
        return;
      }
      // Preparar encolado (soporta playlists)
      let tracksToQueue: any[] = [];
      if (res.loadType === 'track' && res.data) tracksToQueue = [res.data];
      else if (res.loadType === 'search' && Array.isArray(res.data) && res.data[0]) tracksToQueue = [res.data[0]];
      else if (res.loadType === 'playlist' && Array.isArray((res as any).data?.tracks)) tracksToQueue = (res as any).data.tracks;

      if (!tracksToQueue.length) {
        logger.warn({ res }, 'Sin pista(s) encolables');
        await interaction.editReply('No pude seleccionar pistas válidas.');
        return;
      }

      const mapped = tracksToQueue.map((t: any) => ({
        encoded: t.encoded,
        info: {
          title: t.info?.title,
          uri: t.info?.uri,
          author: t.info?.author,
          sourceName: t.info?.sourceName,
          length: t.info?.length,
        },
      }));

      const totalAfter = enqueueTracks(interaction.guildId, mapped);
      await startIfIdle(interaction.guildId, player);

      const q = getQueue(interaction.guildId);
      const isPlaylist = tracksToQueue.length > 1 || res.loadType === 'playlist';
      const first = mapped[0] as typeof mapped[number];

      // Crear embed mejorado para anunciar canción/playlist agregada
      let embedData: { title: string; description?: string; fields?: Array<{name: string, value: string, inline?: boolean}> };
      
      if (isPlaylist) {
        // Para playlist, mensaje simple como pidió el usuario
        embedData = {
          title: `📚 Playlist agregada - ${mapped.length} canciones añadidas a la cola`
        };
      } else {
        // Para canción individual, mostrar más detalles
        const queuePosition = q.tracks.length;
        embedData = {
          title: `🎵 ${first?.info?.title || 'Pista desconocida'}`,
          fields: [
            { name: '👤 Artista', value: first?.info?.author || 'Desconocido', inline: true },
            { name: '⏱️ Duración', value: first?.info?.length ? formatTime(first.info.length) : 'Desconocida', inline: true }
          ]
        };
        
        if (queuePosition > 0) {
          embedData.fields?.push({ name: '📋 Posición en cola', value: `${queuePosition + 1}`, inline: true });
        }
      }

      // Crear botones de acción usando la función helper
      const components = createPlayerActionButtons(interaction.guildId, true);

      const embed = new EmbedBuilder()
        .setTitle(embedData.title)
        .setColor(0x7289DA);

      // Solo agregar autor si tenemos iconURL
      const iconURL = client.user?.displayAvatarURL();
      if (iconURL) {
        embed.setAuthor({ 
          name: 'MonkeyBot', 
          iconURL: iconURL
        });
        // Forzar ancho mínimo con un thumbnail
        embed.setThumbnail(iconURL);
      } else {
        embed.setAuthor({ name: 'MonkeyBot' });
      }

      if (embedData.description) {
        embed.setDescription(embedData.description);
      } else if (embedData.fields && embedData.fields.length > 0) {
        // Agregar espacio entre título y campos
        embed.setDescription('\u200B');
      }

      if (embedData.fields && embedData.fields.length > 0) {
        embed.addFields(embedData.fields);
      }

      await interaction.editReply({
        embeds: [embed],
        components,
      });
    } catch (err) {
      logger.error({ 
        err,
        guildId: interaction.guildId,
        voiceChannelId: voiceId,
        query: query
      }, 'Error en /play');
      await interaction.editReply('❌ Error al reproducir la pista. Inténtalo de nuevo.');
    }
  }

  // Comando status
  if (interaction.commandName === 'status') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });

    await interaction.deferReply();

    try {
      // Verificar si hay un player activo
      const player = shoukaku.players.get(interaction.guildId);

      if (!player) {
        return interaction.editReply('❌ No hay ningún reproductor activo en este servidor.');
      }

      // Obtener información del player
      const playerInfo = await player.node.rest.getPlayer(interaction.guildId);
      const nodeStats = player.node.stats;

      const statusMessage = `
🎵 **Estado del Reproductor:**

**Conexión:**
• Estado: ${(playerInfo as any)?.state?.connected ? '✅ Conectado' : '❌ Desconectado'}
• Ping: ${(playerInfo as any)?.state?.ping || 0}ms
• Canal de voz: ${playerInfo?.voice ? '✅ Conectado' : '❌ No conectado'}

**Reproducción:**
• Track actual: ${playerInfo?.track ? '✅ Reproduciendo' : '❌ Nada sonando'}
• Volumen: ${playerInfo?.volume || 0}%
• Pausado: ${playerInfo?.paused ? '✅ Sí' : '❌ No'}

**Estadísticas del Nodo:**
• Players activos: ${nodeStats?.players || 0}
• Players reproduciendo: ${nodeStats?.playingPlayers || 0}
• CPU: ${nodeStats?.cpu?.lavalinkLoad ? (nodeStats.cpu.lavalinkLoad * 100).toFixed(1) : 0}%
• Memoria: ${nodeStats?.memory?.used ? Math.round(nodeStats.memory.used / 1024 / 1024) : 0}MB
      `;

      await interaction.editReply(statusMessage);

    } catch (error) {
      logger.error({ error }, 'Error obteniendo estado del reproductor');
      await interaction.editReply('❌ Error al obtener el estado del reproductor.');
    }
  }

  // Comando nowplaying
  if (interaction.commandName === 'nowplaying') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });

    await interaction.deferReply();

    try {
      // Verificar si hay un player activo
      const player = shoukaku.players.get(interaction.guildId);

      if (!player) {
        return interaction.editReply('❌ No hay ningún reproductor activo en este servidor.');
      }

      // Obtener información del player
      const playerInfo = await player.node.rest.getPlayer(interaction.guildId);

      if (!playerInfo?.track) {
        return interaction.editReply('❌ No hay ninguna canción reproduciéndose actualmente.');
      }

      const track = playerInfo.track;
      const position = (playerInfo as any)?.state?.position || 0;
      const duration = track.info?.length || 0;

      // Crear barra de progreso
      const progressBar = createProgressBar(position, duration);

      const nowPlayingMessage = `
🎵 **Reproduciendo Ahora:**

**${track.info?.title || 'Título desconocido'}**
👤 **Artista:** ${track.info?.author || 'Desconocido'}
🎯 **Fuente:** ${track.info?.sourceName || 'Desconocida'}

⏱️ **Progreso:** ${formatTime(position)} / ${formatTime(duration)}
${progressBar}

🔗 **Enlace:** ${track.info?.uri || 'No disponible'}
      `;

      await interaction.editReply(nowPlayingMessage);

    } catch (error) {
      logger.error({ error }, 'Error obteniendo información de reproducción actual');
      await interaction.editReply('❌ Error al obtener información de la canción actual.');
    }
  }

  // Comando next
  if (interaction.commandName === 'next') {
    if (!interaction.guildId) return interaction.reply({ content: 'Solo en servidores.', ephemeral: true });
    const player = shoukaku.players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ No hay reproductor activo.', ephemeral: true });
    const q = getQueue(interaction.guildId);
    if (q.tracks.length === 0) return interaction.reply({ content: 'ℹ️ No hay más canciones en cola.', ephemeral: true });
    await interaction.deferReply();
    const ok = await skipCurrent(interaction.guildId, player);
    if (ok) {
      await interaction.editReply('⏭️ Saltando a la siguiente...');
      const q = getQueue(interaction.guildId);
      if (!q.isProcessing) {
        await startIfIdle(interaction.guildId, player);
      }
    } else {
      await interaction.editReply('ℹ️ No hay siguiente canción.');
    }
  }
});

function createProgressBar(current: number, total: number, length: number = 20): string {
  if (total === 0) return '▬'.repeat(length);

  const progress = Math.round((current / total) * length);
  const filled = '█'.repeat(progress);
  const empty = '▬'.repeat(length - progress);

  return `${filled}${empty}`;
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function waitForPlayerConnected(player: Player, timeoutMs: number) {
  const timeout = Date.now() + timeoutMs;
  
  // Si ya está conectado, resolver inmediatamente
  try {
    const playerInfo = await player.node.rest.getPlayer(player.guildId);
    if (playerInfo?.voice && (playerInfo as any)?.state?.connected) {
      logger.info('Player ya está conectado, continuando...');
      return;
    }
  } catch (error) {
    // Continuar con la espera si hay error obteniendo estado
  }
  
  return new Promise<void>((resolve, reject) => {
    const onUpdate = (data: PlayerUpdate) => {
      if (data.state?.connected) {
        cleanup();
        resolve();
      }
    };
    
    function tick() {
      if (Date.now() > timeout) {
        cleanup();
        reject(new Error('Timeout esperando conexión de voz'));
      } else {
        // Verificar estado del player
        player.node.rest.getPlayer(player.guildId)
          .then(info => {
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
    
    function cleanup() {
      player.off('update', onUpdate as any);
    }
    
    player.on('update', onUpdate as any);
    tick();
  });
}

client.login(token).catch((err) => {
  logger.error({ err }, 'Error al iniciar sesión en Discord');
  process.exit(1);
});


