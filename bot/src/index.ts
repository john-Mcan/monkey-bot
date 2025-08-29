import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import type { Interaction } from 'discord.js';
import { logger } from './logger.js';
import type { Player, PlayerUpdate } from 'shoukaku';
import { createShoukaku } from './shoukaku.js';

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
      name: 'leave',
      description: 'Salir del canal de voz',
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
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'ping') {
    await interaction.reply(`Pong!`);
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
      
      // Determinar el tipo de búsqueda para LavaSrc
      let search: string;
      const isUrl = /^https?:\/\//i.test(query);
      
      if (isUrl) {
        try {
          const url = new URL(query);
          const hostname = url.hostname.toLowerCase();
          
          // Manejar diferentes plataformas directamente con LavaSrc
          if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            // Para URLs de YouTube, usar la URL directa - LavaSrc la manejará
            search = query;
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

        // PRIMER FALLBACK: Intentar con ytsearch directo
        const fallback1 = `ytsearch:${query}`;
        logger.info({ fallback1 }, 'Intentando primer fallback');
        res = await node.rest.resolve(fallback1);

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
      }
      if (!res || res.loadType === 'empty' || res.loadType === 'error') {
        logger.warn({ res }, 'Resolver sin resultados (tras reintento)');
        await interaction.editReply('No se encontraron resultados.');
        return;
      }
      let track = undefined as any;
      if (res.loadType === 'track') track = res.data;
      else if (res.loadType === 'search') track = res.data?.[0];
      else if (res.loadType === 'playlist') track = res.data.tracks?.[0];

      if (!track) {
        logger.warn({ res }, 'Sin pista seleccionable');
        await interaction.editReply('No pude seleccionar una pista válida.');
        return;
      }

      logger.info({ 
        trackTitle: track.info?.title, 
        trackUri: track.info?.uri,
        trackLength: track.info?.length,
        trackEncoded: track.encoded?.substring(0, 50) + '...'
      }, 'Intentando reproducir pista');

      try {
        // Verificar que el player esté conectado antes de reproducir
        const playerInfo = await player.node.rest.getPlayer(interaction.guildId);
        logger.info({
          playerInfo,
          trackEncodedLength: track.encoded?.length,
          guildId: interaction.guildId,
          voiceChannelId: voiceId
        }, 'Estado del player antes de reproducir');
        
        // Asegurarse de que la conexión esté completamente estable
        if (!playerInfo?.voice || !(playerInfo as any)?.state?.connected) {
          logger.info('Player no conectado, esperando conexión...');
          await waitForPlayerConnected(player, 5000);
        } else {
          // Pequeña espera para asegurar estabilidad
          await new Promise((r) => setTimeout(r, 500));
        }
        
        logger.info({ trackEncoded: track.encoded?.substring(0, 50), trackTitle: track.info?.title }, 'Enviando pista para reproducción');

        // Agregar debugging adicional antes de intentar reproducir
        logger.info({
          trackEncoded: track.encoded?.substring(0, 100),
          trackInfo: track.info,
          playerGuildId: player.guildId,
          nodeName: player.node.name
        }, 'Debug info antes de playTrack');

        // SOLUCIÓN DEFINITIVA: API REST DIRECTA DE LAVALINK
        logger.info('Usando API REST directa de Lavalink...');

        // Obtener información de la sesión actual
        const sessionId = player.node.sessionId;

        // Obtener información de voz actual del player
        const currentPlayerInfo = await player.node.rest.getPlayer(interaction.guildId);
        const voiceInfo = currentPlayerInfo?.voice;

        if (!voiceInfo) {
          throw new Error('No se pudo obtener información de voz del player');
        }

        // URL para crear/actualizar player
        const playerUrl = `http://localhost:2333/v4/sessions/${sessionId}/players/${interaction.guildId}`;

        logger.info({
          sessionId,
          voiceInfo,
          playerUrl,
          trackEncodedLength: track.encoded?.length
        }, 'Preparando solicitud a Lavalink API');

        // Crear player y reproducir en un solo paso
        const createAndPlayResponse = await fetch(playerUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': 'youshallnotpass',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            encodedTrack: track.encoded,  // Usar encodedTrack en lugar de track
            volume: 100,
            paused: false,
            voice: {
              token: voiceInfo.token,
              endpoint: voiceInfo.endpoint,
              sessionId: voiceInfo.sessionId
            }
          })
        });

        if (createAndPlayResponse.ok) {
          const responseData = await createAndPlayResponse.json();
          logger.info({ responseData, trackTitle: track.info?.title }, 'Pista enviada exitosamente via API REST directa');

          // Esperar un poco para que Lavalink procese el track
          await new Promise((r) => setTimeout(r, 2000));

          // Verificar el estado después de enviar el track
          const updatedPlayerInfo = await player.node.rest.getPlayer(interaction.guildId);
          logger.info({
            updatedPlayerInfo,
            hasTrack: !!updatedPlayerInfo?.track,
            trackTitle: updatedPlayerInfo?.track?.info?.title
          }, 'Estado del player después de enviar track via API REST');

          if (!updatedPlayerInfo?.track) {
            logger.warn('Track no encontrado después de enviar via API REST, intentando reconectar...');

            // Intentar forzar una actualización del player usando encodedTrack
            const forceUpdateUrl = `http://localhost:2333/v4/sessions/${sessionId}/players/${interaction.guildId}`;
            const forceResponse = await fetch(forceUpdateUrl, {
              method: 'PATCH',
              headers: {
                'Authorization': 'youshallnotpass',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                encodedTrack: track.encoded,
                volume: 100,
                paused: false,
                voice: voiceInfo
              })
            });

            if (forceResponse.ok) {
              logger.info('Track reenviado exitosamente después de reconexión');
            } else {
              logger.error({ status: forceResponse.status }, 'Error al reenviar track después de reconexión');
            }

            logger.info('Reintentando envío de track después de reconexión');
          }

        } else {
          const errorText = await createAndPlayResponse.text();
          logger.error({
            status: createAndPlayResponse.status,
            errorText,
            trackEncoded: track.encoded?.substring(0, 50)
          }, 'Error en API REST directa');

          // MEJOR MANEJO DE ERRORES PARA URLs PROBLEMÁTICAS
          if (createAndPlayResponse.status === 400) {
            logger.warn({ errorText }, 'URL rechazada por Lavalink (posiblemente privada o eliminada)');

            // Verificar si es un error de autenticación de YouTube
            if (errorText.includes('Please sign in') || errorText.includes('sign in')) {
              await interaction.editReply(`❌ **Esta canción requiere autenticación de YouTube**\n\nEsta canción tiene restricciones de derechos de autor y requiere una cuenta de YouTube para reproducirla.\n\n🔄 **Prueba con otra canción** o **busca una versión alternativa**.\n\n💡 **Ejemplos que funcionan:**\n• \`/play falling in reverse\`\n• \`/play linkin park numb\`\n• \`/play imagine dragons\``);
            } else {
              await interaction.editReply(`❌ No se puede reproducir esta URL. Puede estar privada, eliminada o tener restricciones de derechos de autor.\n\nPrueba con otra canción o URL.`);
            }
            return;
          }

          throw new Error(`API REST directa falló: ${createAndPlayResponse.status} - ${errorText}`);
        }
        
      } catch (e) {
        logger.error({ 
          error: e, 
          trackTitle: track.info?.title,
          playerState: (player as any).state,
          nodeStats: player.node.stats
        }, 'Error al intentar reproducir pista');
        
        // Intentar reconectar y reproducir de nuevo
        try {
          logger.info('Reintentando reproducción tras error...');
          await new Promise((r) => setTimeout(r, 1500));
          
          // Verificar conexión del player nuevamente
          await waitForPlayerConnected(player, 5000);

          // SEGUNDO INTENTO: API REST DIRECTA CON RECONEXIÓN
          logger.info('Segundo intento: API REST directa con nueva conexión...');

          // Obtener información de voz actualizada
          const updatedPlayerInfo = await player.node.rest.getPlayer(interaction.guildId);
          const updatedVoiceInfo = updatedPlayerInfo?.voice;

          if (!updatedVoiceInfo) {
            throw new Error('No se pudo obtener información de voz actualizada');
          }

          const retrySessionId = player.node.sessionId;
          const retryPlayerUrl = `http://localhost:2333/v4/sessions/${retrySessionId}/players/${interaction.guildId}`;

          // Intentar con la información de voz actualizada
          const retryResponse = await fetch(retryPlayerUrl, {
            method: 'PATCH',
            headers: {
              'Authorization': 'youshallnotpass',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              encodedTrack: track.encoded,
              volume: 100,
              paused: false,
              voice: {
                token: updatedVoiceInfo.token,
                endpoint: updatedVoiceInfo.endpoint,
                sessionId: updatedVoiceInfo.sessionId
              }
            })
          });

          if (retryResponse.ok) {
            const retryResponseData = await retryResponse.json();
            logger.info({ retryResponseData, trackTitle: track.info?.title }, 'Segundo intento exitoso via API REST directa');
          } else {
            const retryErrorText = await retryResponse.text();
            logger.error({
              status: retryResponse.status,
              retryErrorText,
              trackEncoded: track.encoded?.substring(0, 50)
            }, 'Error en segundo intento con API REST');
            throw new Error(`Segundo intento falló: ${retryResponse.status} - ${retryErrorText}`);
          }
        } catch (retryError) {
          logger.error({ retryError }, 'Falló el segundo intento de reproducción');
          throw retryError;
        }
      }
      
      await interaction.editReply(`🎵 Reproduciendo: **${track.info?.title || 'Pista desconocida'}**`);
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


