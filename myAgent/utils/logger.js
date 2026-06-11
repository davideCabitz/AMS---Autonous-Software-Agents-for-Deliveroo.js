/**
 * Centralised logging. Each module calls createLogger('namespace') once and gets
 * a tagged log/warn/error interface. Which namespaces actually print is controlled
 * by the LOG_NAMESPACES environment variable:
 *
 *   LOG_NAMESPACES=*           → everything (default when unset)
 *   LOG_NAMESPACES=pddl,nav    → only those two namespaces
 *   LOG_NAMESPACES=            → silent run
 *
 * warn/error are always emitted regardless of the filter (they signal problems).
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
