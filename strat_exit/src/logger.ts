/**
 * Simple timestamped logger.
 */

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (msg: string, ...args: unknown[]) =>
    console.log(`[${ts()}] [INFO]  ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`[${ts()}] [WARN]  ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[${ts()}] [ERROR] ${msg}`, ...args),
  signal: (msg: string, ...args: unknown[]) =>
    console.log(`[${ts()}] [SIGNAL] ${msg}`, ...args),
};
