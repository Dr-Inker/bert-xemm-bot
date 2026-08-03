import pino from 'pino';

/** Exported so tests can prove credentials are removed before serialization. */
export const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'bert-xemm-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: [
      'apiKey',
      'apiSecret',
      'candidateApiKey',
      '*.apiKey',
      '*.apiSecret',
      'headers["x-api-key"]',
      'req.headers["x-api-key"]',
    ],
    censor: '[REDACTED]',
  },
};

export const logger = pino(loggerOptions);

export type Logger = typeof logger;
