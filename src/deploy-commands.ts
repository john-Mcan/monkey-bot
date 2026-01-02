import { REST, Routes } from "discord.js";
import { env } from "./env";
import { commandsJson } from "./commands";

async function main() {
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

  console.log(
    `[deploy:commands] Registrando comandos en guild ${env.DEV_GUILD_ID}...`,
  );

  await rest.put(
    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DEV_GUILD_ID),
    { body: commandsJson },
  );

  console.log("[deploy:commands] OK");
}

main().catch((err) => {
  console.error("[deploy:commands] Error:", err);
  process.exitCode = 1;
});


