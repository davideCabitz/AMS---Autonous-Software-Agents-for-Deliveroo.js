/**
 * Create a namespaced logger controlled by LOG_NAMESPACES environment variable
 * @param {string} ns - Namespace name (e.g. 'nav', 'pddl', 'delivery')
 * @returns {{(message: any): void, warn: (message: any): void, error: (message: any): void}} Tagged logger with log/warn/error methods
 */
const raw     = process.env.LOG_NAMESPACES;
const ALL     = raw === undefined || raw.trim() === '*';
const ENABLED = ALL ? null : new Set(raw.split(',').map(s => s.trim()).filter(Boolean));

export function createLogger(ns) {
    const prefix = `[${ns}]`;
    const active  = ALL || ENABLED.has(ns);
    const log     = active ? (...a) => console.log(prefix, ...a) : () => {};
    log.warn  = (...a) => console.warn(prefix, ...a);
    log.error = (...a) => console.error(prefix, ...a);
    return log;
}
