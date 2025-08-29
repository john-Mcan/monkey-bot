# 🎵 Monkey Bot - Discord Music Bot

Un bot de Discord que reproduce música desde YouTube usando Lavalink y LavaSrc.

## 📋 Características

- 🎵 Reproducción de música desde YouTube
- 🔍 Búsqueda por texto (`/play nombre de canción`)
- 🔗 Reproducción directa de URLs de YouTube
- 📊 Comandos de diagnóstico (`/status`, `/nowplaying`)
- 🎚️ Control de reproducción básico
- 🔄 Reconexión automática
- ⚡ API REST directa para máxima confiabilidad

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

# Iniciar los contenedores
docker-compose up -d

# Verificar que esté funcionando
docker-compose logs lavalink
```

**Espera a que aparezca:**
```
Lavalink is ready to accept connections
```

### Paso 2: Verificar Lavalink

```bash
# Ver estado de los contenedores
docker ps

# Ver logs recientes
docker-compose logs lavalink --tail=10
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
| `/status` | Ver estado del reproductor | `/status` |
| `/nowplaying` | Ver canción actual | `/nowplaying` |

### Ejemplos de Uso

```bash
# Buscar por texto
/play falling in reverse

# URL directa de YouTube
/play https://www.youtube.com/watch?v=dQw4w9WgXcQ

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
      youtube: false  # LavaSrc maneja YouTube
      # ... otras fuentes
```

### Bot

El archivo `bot/src/index.ts` contiene la lógica principal del bot.

#### Configuración de Comandos

Los comandos slash se registran automáticamente al iniciar el bot.

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
# Verificar conexión con Lavalink
curl -H "Authorization: youshallnotpass" http://localhost:2333/version

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
