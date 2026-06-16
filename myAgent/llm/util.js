/**
 * Shared LLM-layer utilities.
 */

/**
 * Race a promise against a timeout, rejecting with a tagged error on expiry.
 * The rejection value is ['timeout'] when no tag is given, or ['timeout', tag]
 * when one is — matching the historical per-call-site shapes exactly.
 * @param {Promise} promise - Promise to race
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [tag] - Optional tag included in the timeout rejection value
 * @returns {Promise} Resolves with the promise result or rejects with the timeout tuple
 */
export function withTimeout(promise, ms, tag) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(tag === undefined ? ['timeout'] : ['timeout', tag]), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
