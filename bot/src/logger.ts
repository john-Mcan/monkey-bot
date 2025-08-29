import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger = isProd
  ? pino({ level: process.env.LOG_LEVEL || 'info' })
  : pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: { target: 'pino-pretty' },
    });


