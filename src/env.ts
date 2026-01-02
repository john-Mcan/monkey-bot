import "dotenv/config";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Falta variable de entorno obligatoria: ${name}`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return null;
  return value;
}

export const env = {
  DISCORD_TOKEN: requiredEnv("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: requiredEnv("DISCORD_CLIENT_ID"),
  DEV_GUILD_ID: requiredEnv("DEV_GUILD_ID"),
  IDLE_DISCONNECT_MINUTES: numberEnv("IDLE_DISCONNECT_MINUTES", 5),
};

export const getRadioStreamUrl = (): string | null => optionalEnv("RADIO_STREAM_URL");


