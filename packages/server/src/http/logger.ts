// Structured logging with an allowlist by construction (ADR-0019): entries carry only an event name and scalar
// fields chosen by the code, never request bodies, query strings, file contents, cell values or error messages.

export type LogValue = string | number | boolean;

export interface Logger {
  info(event: string, fields?: Readonly<Record<string, LogValue>>): void;
  error(event: string, fields?: Readonly<Record<string, LogValue>>): void;
}

/** One JSON object per line, written to `write` (stderr by default in the CLI). */
export function createLogger(write: (line: string) => void, now: () => Date = () => new Date()): Logger {
  const emit = (
    level: 'info' | 'error',
    event: string,
    fields: Readonly<Record<string, LogValue>> = {},
  ): void => {
    write(JSON.stringify({ time: now().toISOString(), level, event, ...fields }));
  };
  return {
    info: (event, fields) => {
      emit('info', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
  };
}
