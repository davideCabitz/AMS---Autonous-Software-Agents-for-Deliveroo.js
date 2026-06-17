import 'dotenv/config';
import OpenAI from 'openai';
import { createLogger } from '../utils/logger.js';

/**
 * @typedef { {role: string, content: string} } ChatMessage
 */

const baseURL = process.env.LITELLM_BASE_URL || 'http://localhost:8000/v1';
const apiKey  = process.env.LITELLM_API_KEY  || 'not-needed-for-local';

/** @type {string} LLM model name (env-configurable) */
export const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

/** @type {string} Fallback model for content-policy failures (if set) */
const FALLBACK_MODEL = process.env.LOCAL_MODEL_FALLBACK || '';

/** @type {OpenAI} Client: 90s timeout, max 1 retry */
const client = new OpenAI({ baseURL, apiKey, timeout: 90_000, maxRetries: 1 });
const log = createLogger('llm');

/**
 * Whether an error is a retryable Azure content-policy 400
 * @param {Error} err - Error to inspect
 * @returns {boolean} True if a retryable content-policy violation
 */
function isContentPolicy(err) {
    const msg = err?.message ?? '';
    return err?.status === 400 &&
        /content[\s_-]*polic|content management|ContentPolicyViolation/i.test(msg);
}

/**
 * Call the LLM with a message history
 * @param {Array<ChatMessage>} messages - Chat history to send
 * @param {{temperature?: number}} options - Optional call parameters
 * @returns {Promise<string>} Assistant message text (empty string on error)
 */
export async function callModel(messages, { temperature = 0 } = {}) {
    const complete = async (model) => {
        const response = await client.chat.completions.create({ model, messages, temperature });
        return response.choices?.[0]?.message?.content ?? '';
    };

    try {
        return await complete(MODEL);
    } catch (err) {
        if (!isContentPolicy(err)) throw err;
        log.warn('content-policy 400 — retrying once...');
        try {
            return await complete(MODEL);
        } catch (err2) {
            if (!isContentPolicy(err2)) throw err2;
            if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) {
                log.warn(`content-policy persisted — falling back to ${FALLBACK_MODEL}`);
                return await complete(FALLBACK_MODEL);
            }
            throw err2;
        }
    }
}
