# 🎵 Monkey Bot - Discord Music Bot

Un bot de Discord que reproduce música desde YouTube usando Lavalink y LavaSrc.

## 📋 Características

- 🎵 Reproducción de música desde YouTube (yt-dlp como nodo primario)
- 🔍 Búsqueda por texto (`/play nombre de canción`)
- 🔗 Reproducción directa de URLs de YouTube
- 📚 Soporte de playlists de YouTube (detecta `list=` y encola todas las pistas)
- 🔁 Fallback entre nodos: plugin oficial de YouTube como respaldo para playlists/búsqueda
- 🛡️ Reintentos por pista “difícil”: re-resolución y cambio dinámico de nodo solo para esa pista
- 📊 Comandos de diagnóstico (`/status`, `/nowplaying`)
- 🎚️ Controles de reproducción: pause, resume, seek, stop, volume
- 🔁 Loop (track/queue) y 🔀 Shuffle
- 🗑️ Remove por índice y vista de `queue`
- 🔄 Reconexión automática
- ⚡ API REST directa para máxima confiabilidad
- ⏭️ Botón "Next" y comando `/next` para saltar a la siguiente canción

## 🛠️ Requisitos

- **Node.js** 18+ y **npm**
- **Docker** y **Docker Compose**
- **Git** (para clonar el repositorio)

### Verificar Instalaciones

```bash
# Verificar Node.js
node --version
npm --version

# Verificar Docker
docker --version
docker-compose --version
```

## 📦 Instalación

### 1. Clonar el Repositorio

```bash
git clone <url-del-repositorio>
cd monkey-bot
```

### 2. Instalar Dependencias del Bot

```bash
cd bot
npm install
```

### 3. Configurar Variables de Entorno

Crea un archivo `.env` en el directorio `bot/`:

```env
DISCORD_TOKEN=tu_token_de_discord_aqui
DISCORD_CLIENT_ID=tu_client_id_de_discord
DISCORD_GUILD_ID=tu_guild_id_para_desarrollo
# Opcional: configurar nodos si cambias los puertos/hosts
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_YT_HOST=localhost
LAVALINK_YT_PORT=2334
```

#### Obtener las Credenciales de Discord:

1. Ve a https://discord.com/developers/applications
2. Crea una nueva aplicación
3. Ve a "Bot" y copia el token
4. Ve a "General Information" y copia el Application ID
5. Para desarrollo local, obtén el Guild ID de tu servidor

## 🚀 Inicio Manual

### Paso 1: Iniciar Lavalink (Docker)

```bash
# Navegar al directorio de infraestructura
cd infra

# Iniciar los contenedores (yt-dlp en 2333 y youtube-plugin en 2334)
docker-compose up -d

# Verificar que estén funcionando
docker-compose logs lavalink --tail=20
docker-compose logs lavalink-youtube --tail=20
```

**Espera a que aparezca:**
```
Lavalink is ready to accept connections
```

### Paso 2: Verificar Lavalink

```bash
# Ver estado de los contenedores
docker ps

# Ver logs recientes (ambos nodos)
docker-compose logs lavalink --tail=10
docker-compose logs lavalink-youtube --tail=10
```

### Paso 3: Iniciar el Bot

```bash
# Navegar al directorio del bot
cd ../bot

# Compilar el proyecto
npm run build

# Iniciar el bot
npm start
```

### Paso 4: Verificar el Bot

El bot debería mostrar estos mensajes:

```
Bot listo
[Lavalink] Node listo
Slash commands registrados (scoped a guild)
Slash commands registrados
```

## 🎮 Uso

### Comandos Disponibles

| Comando | Descripción | Ejemplo |
|---------|-------------|---------|
| `/play` | Reproducir canción | `/play falling in reverse` |
| `/pause` | Pausar reproducción | `/pause` |
| `/resume` | Reanudar reproducción | `/resume` |
| `/seek` | Saltar a posición (mm:ss o segundos) | `/seek 1:30` |
| `/stop` | Detener y limpiar cola | `/stop` |
| `/volume` | Cambiar volumen (0-150) | `/volume 100` |
| `/loop` | Cambiar modo loop | `/loop track` |
| `/shuffle` | Alternar aleatorio | `/shuffle` |
| `/remove` | Eliminar por índice (desde 1) | `/remove 3` |
| `/queue` | Mostrar la cola | `/queue` |
| `/next` | Saltar a la siguiente canción en cola | `/next` |
| `/status` | Ver estado del reproductor | `/status` |
| `/nowplaying` | Ver canción actual | `/nowplaying` |

### Ejemplos de Uso

```bash
# Buscar por texto
/play falling in reverse

# URL directa de YouTube
/play https://www.youtube.com/watch?v=dQw4w9WgXcQ

# Playlist de YouTube (se detecta automáticamente y se encola completa)
/play https://www.youtube.com/watch?v=jeiHpmP9zeU&list=RDjeiHpmP9zeU&start_radio=1

# Saltar a la siguiente (si hay más en cola)
/next

# Ver estado
/status

# Ver canción actual
/nowplaying
```

## 🔧 Configuración Avanzada

### Lavalink

El archivo `infra/lavalink/application.yml` contiene la configuración de Lavalink:

```yaml
lavalink:
  server:
    password: youshallnotpass
    sources:
      youtube: false  # LavaSrc/yt-dlp maneja YouTube (nodo primario)
      # ... otras fuentes
```

#### YouTube restringido (cookies con yt-dlp)

Para reproducir enlaces de YouTube que requieren inicio de sesión, edad o están limitados por región, habilitamos `yt-dlp` con cookies:

1. En tu navegador (perfil con acceso a YouTube), exporta cookies a formato Netscape. Puedes usar la extensión "Get cookies.txt LOCALLY".
2. Guarda el archivo como `infra/lavalink/cookies/youtube.txt`.
3. Montamos `infra/lavalink/cookies/youtube.txt` dentro del contenedor en `/opt/Lavalink/cookies/youtube.txt` mediante `docker-compose`.
4. Reinicia los contenedores de Lavalink:

```bash
cd infra
docker-compose down && docker-compose up -d
```

La imagen instala `yt-dlp` y `ffmpeg`, y montamos `cookies/youtube.txt` en `/opt/Lavalink/cookies/youtube.txt`. Por estabilidad mantenemos los args por defecto del plugin; si un enlace “difícil” falla, el bot lo reintenta en el otro nodo (plugin oficial). Si necesitas forzar cookies vía yt‑dlp (menos estable), puedes añadir `customLoadArgs/customPlaybackArgs` en `infra/lavalink/application.yml` apuntando a ese archivo.

#### Doble nodo (estado actual)

- `lavalink` (puerto 2333): LavaSrc + yt-dlp, buffers ampliados (`bufferDurationMs=1200`, `frameBufferDurationMs=15000`) y JVM 1GB.
- `lavalink-youtube` (puerto 2334): plugin oficial de YouTube, adecuado para playlists/búsquedas más suaves.
- El bot prioriza `yt-dlp` y cae a `youtube-plugin` según el caso; además, por pista fallida cambia de nodo cuando conviene.

### Bot

El archivo `bot/src/index.ts` contiene la lógica principal del bot y la detección de playlists/fallback entre nodos.

#### Configuración de Comandos

Los comandos slash se registran automáticamente al iniciar el bot.

#### Playlists y Cola

- Si envías una URL que contiene el parámetro `list=` (p. ej. `https://www.youtube.com/watch?v=...&list=...`), el bot detecta la playlist y encola todas las pistas. Para maximizar compatibilidad, intenta resolver primero la playlist con el nodo de plugin oficial; si falla, recurre a estrategias de búsqueda.
- Comandos útiles: `loop` (off/track/queue), `shuffle`, `remove`, `queue` y `next`.
- Cuando hay más de una canción en la cola, el bot mostrará un botón **Next** en la respuesta de `/play` para saltar a la siguiente pista.
- También puedes usar el comando `/next` para saltar sin necesidad del botón.

#### Reintentos por pista “difícil”

- Si una pista dentro de una playlist falla (stuck/exception o no inicia), el bot reintenta así:
  1) Re-resuelve en el nodo actual.
  2) Si sigue fallando, intenta resolver en el otro nodo y mueve el player solo para esa pista.
  3) Si tras 2 intentos no hay éxito, salta a la siguiente pista sin afectar el resto de la cola.

## 🛑 Detención

### Detener el Bot

```bash
# En la terminal donde corre el bot, presiona:
Ctrl + C
```

### Detener Lavalink

```bash
# Desde el directorio infra
cd infra
docker-compose down
```

### Detener Todo

```bash
# Detener contenedores
docker-compose down

# Si hay procesos de Node.js corriendo
pkill -f "node.*monkey-bot"
```

## 🔍 Solución de Problemas

### Problema: "Lavalink no se conecta"

```bash
# Verificar que Docker esté corriendo
docker ps

# Ver logs de Lavalink
docker-compose logs lavalink

# Verificar puerto 2333
netstat -an | grep 2333
```

### Problema: "Bot no responde comandos"

```bash
# Verificar token de Discord en .env
cat bot/.env

# Ver logs del bot
# (desde el directorio bot)
npm start
```

### Problema: "Canción no se reproduce"

```bash
# Verificar conexión con Lavalink (ambos nodos)
curl -H "Authorization: youshallnotpass" http://localhost:2333/version
curl -H "Authorization: youshallnotpass" http://localhost:2334/version

# Ver estado del player
/status (en Discord)
```

### Problema: "Error de autenticación en YouTube"

Algunas canciones requieren autenticación de YouTube. El bot detectará automáticamente este error y te informará.

**Canciones que funcionan:**
- Música libre de derechos de autor
- Canciones populares sin restricciones
- Contenido público de YouTube

**Canciones que pueden requerir autenticación:**
- Canciones con restricciones de derechos de autor
- Contenido regional
- Música con gestión de derechos

### Stuttering / microcortes

- Ya aplicamos buffers mayores y aumentamos memoria de la JVM a 1GB.
- Si persisten cortes:
  - Verifica red/CPU del host (cable recomendado).
  - Ajusta `playerUpdateInterval` (7–10) en `application.yml`.
  - Usa el nodo `lavalink-youtube` para enlaces no restringidos, y deja `yt-dlp` como fallback.

## 📁 Estructura del Proyecto

```
monkey-bot/
├── bot/                    # Código del bot de Discord
│   ├── src/
│   │   ├── index.ts       # Lógica principal del bot
│   │   ├── logger.ts      # Sistema de logging
│   │   └── shoukaku.ts    # Cliente de Lavalink
│   ├── package.json
│   ├── tsconfig.json
│   └── .env              # Variables de entorno (crear)
├── infra/                 # Infraestructura Docker
│   ├── docker-compose.yml
│   ├── Dockerfile.lavalink
│   └── lavalink/
│       └── application.yml
├── PLAN.md               # Documentación del proyecto
└── README.md            # Este archivo
```

## 🤝 Contribución

1. Fork el proyecto
2. Crea una rama para tu feature (`git checkout -b feature/nueva-funcionalidad`)
3. Commit tus cambios (`git commit -am 'Agrega nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Abre un Pull Request

## 📄 Licencia

Este proyecto está bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para más detalles.

## 🙋‍♂️ Soporte

Si tienes problemas:

1. Revisa la sección de Solución de Problemas
2. Verifica los logs de Docker y del bot
3. Asegúrate de que todas las dependencias estén instaladas
4. Verifica que los puertos estén disponibles

---

**¡Disfruta tu bot de música!** 🎵✨
