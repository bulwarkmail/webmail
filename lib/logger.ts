type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const COLORS: Record<LogLevel, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[34m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

type LogFormat = 'text' | 'json';

interface LogSettings {
  level?: string;
  format?: string;
}

// The config manager pushes the resolved logLevel / logFormat (admin config,
// then LOG_LEVEL / LOG_FORMAT, then default) here after every load and save.
// Kept on globalThis so every bundle that loads this module sees the same
// values, like the config manager singleton itself.
const SETTINGS_KEY = Symbol.for('bulwark.logger.settings');
type GlobalWithLogSettings = typeof globalThis & { [SETTINGS_KEY]?: LogSettings };
const g = globalThis as GlobalWithLogSettings;

/** Use these settings instead of LOG_LEVEL / LOG_FORMAT. */
export function configureLogger(settings: LogSettings): void {
  g[SETTINGS_KEY] = { ...settings };
}

function getLevel(): number {
  const configured = (g[SETTINGS_KEY]?.level ?? process.env.LOG_LEVEL)?.toLowerCase() as LogLevel | undefined;
  return configured && configured in LEVELS ? LEVELS[configured] : LEVELS.info;
}

function isJson(): boolean {
  const configured = (g[SETTINGS_KEY]?.format ?? process.env.LOG_FORMAT)?.toLowerCase() as LogFormat | undefined;
  return configured === 'json';
}

/** Whether log lines go out as JSON (LOG_FORMAT=json or the admin setting). */
export function isJsonLogFormat(): boolean {
  return isJson();
}

/**
 * Gets every logger.error call, with the stack of the call. The server's
 * error reporting sets it (lib/error-reporting/server.ts); without it errors
 * are only logged.
 */
export type ErrorSink = (message: string, extra: Record<string, unknown> | undefined, stack: string | undefined) => void;
const SINK_KEY = Symbol.for('bulwark.logger.errorSink');
type GlobalWithSink = typeof globalThis & { [SINK_KEY]?: ErrorSink };

export function setErrorSink(sink: ErrorSink | null): void {
  const target = globalThis as GlobalWithSink;
  if (sink) target[SINK_KEY] = sink;
  else delete target[SINK_KEY];
}

function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  if (level === 'error') {
    const sink = (globalThis as GlobalWithSink)[SINK_KEY];
    if (sink) {
      try {
        // Frames: log, logger.error, then the caller.
        sink(message, extra, new Error().stack);
      } catch {
        // reporting must not break logging
      }
    }
  }
  if (LEVELS[level] > getLevel()) return;

  if (isJson()) {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...extra,
    };
    const out = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') {
      console.error(out);
    } else {
      console.log(out);
    }
    return;
  }

  const color = COLORS[level];
  const tag = `${color}[${level.toUpperCase().padEnd(5)}]${RESET}`;
  const ts = new Date().toISOString();
  const suffix = extra && Object.keys(extra).length > 0
    ? ` ${COLORS.debug}${JSON.stringify(extra)}${RESET}`
    : '';

  if (level === 'error' || level === 'warn') {
    console.error(`${tag} ${ts} ${message}${suffix}`);
  } else {
    console.log(`${tag} ${ts} ${message}${suffix}`);
  }
}

export const logger = {
  error: (message: string, extra?: Record<string, unknown>) => log('error', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => log('warn', message, extra),
  info: (message: string, extra?: Record<string, unknown>) => log('info', message, extra),
  debug: (message: string, extra?: Record<string, unknown>) => log('debug', message, extra),
  request: (method: string, path: string, status: number, durationMs: number) =>
    log('info', `${method} ${path} ${status}`, { method, path, status, durationMs }),
};
