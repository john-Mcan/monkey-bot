import ffmpegPath from "ffmpeg-static";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { env, getRadioStreamUrl } from "./env";
import { RadioManager } from "./radio/RadioManager";

if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const radio = new RadioManager(client, env.IDLE_DISCONNECT_MINUTES);

client.once(Events.ClientReady, (c) => {
  console.log(`[ready] Conectado como ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "play" && interaction.commandName !== "radio") return;

  const url = getRadioStreamUrl();
  if (!url) {
    await interaction.reply({
      content:
        "El bot no tiene configurada la radio.\nConfigura `RADIO_STREAM_URL` en tu `.env` y reinicia el bot.",
      ephemeral: true,
    }).catch(() => null);
    return;
  }

  try {
    await radio.play(interaction, url);
  } catch (err) {
    console.error("[interaction] error en play:", err);
    // Intentar responder si aún no se respondió
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Ocurrió un error al procesar el comando.",
        ephemeral: true,
      }).catch(() => null);
    }
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  radio.onVoiceStateUpdate(oldState, newState);
});

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal}`);
  try {
    await radio.shutdown();
  } finally {
    client.destroy();
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});


