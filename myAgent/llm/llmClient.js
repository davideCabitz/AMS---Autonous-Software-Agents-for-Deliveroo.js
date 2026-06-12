import 'dotenv/config';
import OpenAI from 'openai';
import { createLogger } from '../utils/logger.js';

/*
 * Thin wrapper over the OpenAI-compatible LiteLLM endpoint (faculty proxy).
 * The same client/message format works with the locally hosted model.
 */

const baseURL = process.env.LITELLM_BASE_URL || 'http://localhost:8000/v1';
const apiKey  = process.env.LITELLM_API_KEY  || 'not-needed-for-local';

export const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';
// Optional second model to try if the primary keeps getting content-filtered
// (e.g. a non-Azure model that isn't behind gpt-4o's content policy).
const FALLBACK_MODEL = process.env.LOCAL_MODEL_FALLBACK || '';

// Bound every request: the default SDK timeout is 10 minutes, and one stalled
// proxy call would wedge the serialized ACTION directive lane for that long.
const client = new OpenAI({ baseURL, apiKey, timeout: 90_000, maxRetries: 1 });
const log = createLogger('llm');

/** True for Azure OpenAI's content-management-policy 400 (a flaky false-positive,
 *  NOT a connection/VPN error — those are left to surface unchanged). */
function isContentPolicy(err) {
    const msg = err?.message ?? '';
    return err?.status === 400 &&
        /content[\s_-]*polic|content management|ContentPolicyViolation/i.test(msg);
}

/**
 * Single chat completion; returns the assistant message text (or '').
 * On a content-policy 400 (non-deterministic Azure filter) it retries once, then
 * falls back to LOCAL_MODEL_FALLBACK if configured. Connection errors are NOT
 * retried here — they surface so a missing VPN is obvious.
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
