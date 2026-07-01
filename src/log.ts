/**
 * Tiny structured logger. JSON per line so systemd's `journalctl` +
 * jq work naturally. Pino would be nicer but the daemon budget is
 * "one package, small, obvious" — this is 20 lines of console.log.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(fields: Record<string, unknown> | string, msg?: string): void;
  info(fields: Record<string, unknown> | string, msg?: string): void;
  warn(fields: Record<string, unknown> | string, msg?: string): void;
  error(fields: Record<string, unknown> | string, msg?: string): void;
}

export function createLogger(minLevel: Level = 'info'): Logger {
  const threshold = LEVEL_ORDER[minLevel];

  const emit = (level: Level, fields: Record<string, unknown> | string, msg?: string) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record: Record<string, unknown> = { level, ts: new Date().toISOString() };
    if (typeof fields === 'string') {
      record.msg = fields;
    } else {
      Object.assign(record, fields);
      if (msg) record.msg = msg;
    }
    const line = JSON.stringify(record);
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };

  return {
    debug: (fields, msg) => emit('debug', fields, msg),
    info:  (fields, msg) => emit('info',  fields, msg),
    warn:  (fields, msg) => emit('warn',  fields, msg),
    error: (fields, msg) => emit('error', fields, msg),
  };
}
