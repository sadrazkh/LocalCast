import type { Logger } from './kernel.js';
import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Keys whose values are redacted wherever they appear in log metadata. The auth key, the
 * DAV password and the pairing secret all pass through code paths that log context, and a
 * log file is exactly the place a secret survives longest.
 */
const REDACT = new Set([
  'secret',
  'secrethash',
  'password',
  'davpassword',
  'authkey',
  'token',
  'accesstoken',
  'refreshtoken',
  'edgesecret',
  'jwtsecret',
  'authorization',
  'dnsapitoken',
]);

function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

export function createLogger(level: LogLevel = 'info', sink: Console = console): Logger {
  const min = ORDER[level];

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = { t: new Date().toISOString(), level: lvl, msg, ...(meta ? redact(meta) : {}) };
    const write = lvl === 'error' || lvl === 'warn' ? sink.error : sink.log;
    write.call(sink, JSON.stringify(line));
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
