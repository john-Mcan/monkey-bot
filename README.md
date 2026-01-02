# 🎵 Bot Radio DS

Bot de Discord para reproducir streams de radio en canales de voz. Desarrollado en TypeScript con discord.js y @discordjs/voice.

## Características

- **Comandos slash** (`/play`, `/radio`) para invocar al bot
- **Reproducción de streams** MP3/AAC desde URLs configuradas
- **Metadata ICY** - Muestra el título de la canción actual en el estado del bot
- **Auto-desconexión** - Se desconecta si el canal queda vacío por X minutos
- **Reconexión automática** - Reintenta si el stream falla
- **Mensajes de contexto** - Informa en el canal de texto sobre el estado de reproducción

## Requisitos

- Node.js 18+
- Token de bot de Discord con permisos de voz
- FFmpeg (incluido vía `ffmpeg-static`)

## Instalación

```bash
npm install
```

## Configuración

Crea un archivo `.env` en la raíz del proyecto:

```env
# Obligatorias
DISCORD_TOKEN=tu_token_de_discord
DISCORD_CLIENT_ID=tu_client_id
DEV_GUILD_ID=id_del_servidor_de_desarrollo
RADIO_STREAM_URL=https://tu-stream-de-radio.com/stream.mp3

# Opcionales
IDLE_DISCONNECT_MINUTES=5
```

### Variables de entorno

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `DISCORD_TOKEN` | Token del bot de Discord | ✅ |
| `DISCORD_CLIENT_ID` | Client ID de la aplicación de Discord | ✅ |
| `DEV_GUILD_ID` | ID del servidor donde se registran los comandos | ✅ |
| `RADIO_STREAM_URL` | URL del stream de radio a reproducir | ✅ |
| `IDLE_DISCONNECT_MINUTES` | Minutos antes de desconectarse si no hay usuarios (default: 5) | ❌ |

## Uso

### Registrar comandos slash

```bash
npm run deploy:commands
```

### Desarrollo

```bash
npm run dev
```

### Producción

```bash
npm run build
npm start
```

## Comandos de Discord

| Comando | Descripción |
|---------|-------------|
| `/play` | Une al bot a tu canal de voz y reproduce la radio |
| `/radio` | Alias de `/play` |

## Estructura del proyecto

```
monkey-bot/
├── src/
│   ├── index.ts              # Punto de entrada
│   ├── env.ts                # Configuración de variables de entorno
│   ├── commands.ts           # Definición de comandos slash
│   ├── deploy-commands.ts    # Script para registrar comandos
│   ├── radio/
│   │   └── RadioManager.ts   # Lógica de reproducción y voz
│   └── types/
│       └── icy.d.ts          # Tipos para la librería icy
├── dist/                     # Código compilado
├── package.json
├── tsconfig.json
└── .env
```

## Tecnologías

- **TypeScript** - Lenguaje de programación
- **discord.js** - Librería para interactuar con la API de Discord
- **@discordjs/voice** - Conexiones de voz de Discord
- **@discordjs/opus** - Codificación de audio Opus
- **ffmpeg-static** - FFmpeg embebido para transcoding
- **icy** - Parser de metadata ICY para streams de radio

---

## Licencia

**© 2026 - Todos los derechos reservados**

Este proyecto se proporciona **únicamente con fines educativos y de aprendizaje**.

### Términos de uso

✅ **Permitido:**
- Estudiar el código fuente para aprender
- Usar como referencia educativa
- Ejecutar localmente para propósitos de aprendizaje personal

❌ **Prohibido:**
- Copiar, redistribuir o publicar el código sin autorización expresa
- Usar el código en proyectos comerciales o públicos
- Crear trabajos derivados sin permiso del autor
- Remover o modificar este aviso de licencia

Para solicitar permisos de uso, contacta al autor: contacto@johnmcan.dev

---

*Bot Radio DS - Proyecto educativo*

