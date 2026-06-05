import 'dotenv/config';
import OpenAI from 'openai';

/*
 * Thin wrapper over the OpenAI-compatible LiteLLM endpoint (faculty proxy).
 * The same client/message format works with the locally hosted model.
 */

const baseURL = process.env.LITELLM_BASE_URL || 'http://localhost:8000/v1';
const apiKey  = process.env.LITELLM_API_KEY  || 'not-needed-for-local';

export const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

const client = new OpenAI({ baseURL, apiKey });

/** Single chat completion; returns the assistant message text (or ''). */
export async function callModel(messages, { temperature = 0 } = {}) {
    const response = await client.chat.completions.create({
        model: MODEL,
        messages,
        temperature,
    });
    return response.choices?.[0]?.message?.content ?? '';
}
