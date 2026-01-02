import { SlashCommandBuilder } from "discord.js";

const playCommand = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Llama al bot a tu canal de voz y reproduce la radio configurada");

const radioCommand = new SlashCommandBuilder()
  .setName("radio")
  .setDescription("Alias de /play (reproduce la radio configurada)");

export const commands = [playCommand, radioCommand];
export const commandsJson = commands.map((c) => c.toJSON());


