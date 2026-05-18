
const SUPPORTED_MODELS = {
  'elephant-alpha':   { id: 'openrouter/elephant-alpha',                   provider: 'openrouter' },
  'llama-3.3-70b':    { id: 'meta-llama/llama-3.3-70b-instruct:free',      provider: 'openrouter' },
  'gemma-4-31b':      { id: 'google/gemma-4-31b-it:free',                  provider: 'openrouter' },
  'nemotron-3-super': { id: 'nvidia/nemotron-3-super-120b-a12b:free',      provider: 'openrouter' },
  'gpt-oss-120b':     { id: 'openai/gpt-oss-120b:free',                    provider: 'openrouter' },
  'qwen-3.6-plus':    { id: 'qwen/qwen3.6-plus-preview:free',              provider: 'openrouter' },
  'auto-free':        { id: 'openrouter/free',                             provider: 'openrouter' },

  // ---------- Groq ----------
  'llama-groq':         { id: 'llama-3.3-70b-versatile',          provider: 'groq' },
  'mixtral-groq':       { id: 'mixtral-8x7b-32768',               provider: 'groq' },
  'gemma-groq':         { id: 'gemma2-9b-it',                     provider: 'groq' },
  'llama-3.1-groq':     { id: 'llama-3.1-70b-versatile',          provider: 'groq' },
  'deepseek-r1-llama':  { id: 'deepseek-r1-distill-llama-70b',    provider: 'groq' },
  'deepseek-r1-qwen':   { id: 'deepseek-r1-distill-qwen-32b',     provider: 'groq' },
  'llama-3.2-1b':       { id: 'llama-3.2-1b-preview',             provider: 'groq' },
  'llama-3.2-3b':       { id: 'llama-3.2-3b-preview',             provider: 'groq' },
  'llama-3.2-11b':      { id: 'llama-3.2-11b-text-preview',       provider: 'groq' },
  'llama-3.2-90b':      { id: 'llama-3.2-90b-text-preview',       provider: 'groq' },
  'llama-3.1-405b':     { id: 'llama-3.1-405b-reasoning',         provider: 'groq' },
  'qwen-2.5-32b':       { id: 'qwen-2.5-32b',                     provider: 'groq' },
  'qwen-2.5-72b':       { id: 'qwen-2.5-72b',                     provider: 'groq' },
  'qwen-2.5-coder-32b': { id: 'qwen-2.5-coder-32b',               provider: 'groq' },
  'qwq-32b':            { id: 'qwq-32b',                          provider: 'groq' },
};

const GROQ_MODEL_IDS = new Set(
  Object.values(SUPPORTED_MODELS)
    .filter(m => m.provider === 'groq')
    .map(m => m.id)
);

// Model fallback เมื่อต้อง cross-provider
const GROQ_FALLBACK_MODEL    = 'llama-3.3-70b-versatile';
const OR_FALLBACK_MODEL      = 'openrouter/free';

const DEFAULT_MODEL        = 'auto-free';
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful AI assistant. Answer clearly, accurately, and politely. ' +
  'Respond in the same language as the user. Provide detailed, high-quality responses.';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GROQ_API_URL       = 'https://api.groq.com/openai/v1/chat/completions';

const REQUEST_TIMEOUT_MS  = 120_000;
const RATE_LIMIT_RETRY_MS = 2_000;

// ─── In-memory rate-limit tracker (per serverless instance) ───────────────────
// BUG FIX #1: เพิ่ม helper isProviderReady() ที่ auto-clear เมื่อหมดเวลาแล้ว
const providerStatus = {
  groq:       { isRateLimited: false, resetAt: null },
  openrouter: { isRateLimited: false, resetAt: null },
};

function isProviderReady(provider) {
  const s = providerStatus[provider];
  if (!s.isRateLimited) return true;
  // หมดเวลาแล้ว → clear flag อัตโนมัติ
  if (Date.now() >= s.resetAt) {
    s.isRateLimited = false;
    s.resetAt = null;
    console.log(`[${provider.toUpperCase()}] Rate limit cleared (auto-reset)`);
    return true;
  }
  return false;
}

function markRateLimited(provider, retryAfterSeconds) {
  const resetMs = (parseInt(retryAfterSeconds, 10) || 60) * 1000;
  providerStatus[provider].isRateLimited = true;
  providerStatus[provider].resetAt = Date.now() + resetMs;
  console.log(`[${provider.toUpperCase()}] Rate limited — reset in ${retryAfterSeconds}s`);
}

// ─── CORS ────────────────────────────────────────────────────────────────────
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function jsonResponse(res, status, data) {
  return res.status(status).json(data);
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Resolve model ID for a given provider ───────────────────────────────────
// BUG FIX #2: แก้ fallback logic ที่เดิมใช้ modelId.includes('groq') ซึ่งไม่มีวัน match
function resolveModelId(originalModelId, targetProvider) {
  if (targetProvider === 'groq') {
    // ถ้า model นั้น Groq รองรับอยู่แล้ว → ใช้เลย
    if (GROQ_MODEL_IDS.has(originalModelId)) return originalModelId;
    // ไม่รองรับ → fallback
    console.log(`[MODEL] "${originalModelId}" not native to Groq → fallback to ${GROQ_FALLBACK_MODEL}`);
    return GROQ_FALLBACK_MODEL;
  }
  if (targetProvider === 'openrouter') {
    // OpenRouter ใช้ model ตามที่ config ระบุ ยกเว้นกรณี model เป็น Groq-only format
    if (GROQ_MODEL_IDS.has(originalModelId)) {
      console.log(`[MODEL] Groq-only model "${originalModelId}" on OpenRouter → fallback to ${OR_FALLBACK_MODEL}`);
      return OR_FALLBACK_MODEL;
    }
    return originalModelId;
  }
  return originalModelId;
}

// ─── Call provider ────────────────────────────────────────────────────────────
async function callProvider(provider, modelId, messages, apiKey) {
  const apiUrl  = provider === 'groq' ? GROQ_API_URL : OPENROUTER_API_URL;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
  };

  if (provider === 'openrouter') {
    const referer = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://yanz-api.vercel.app';
    headers['HTTP-Referer'] = referer;
    headers['X-Title']      = 'YANZ AI API';
  }

  const requestBody = {
    model:       modelId,
    messages,
    temperature: 0.7,
    top_p:       0.9,
    max_tokens:  4096,
  };

  const response = await fetchWithTimeout(
    apiUrl,
    { method: 'POST', headers, body: JSON.stringify(requestBody) },
    REQUEST_TIMEOUT_MS
  );

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after') || '60';
    markRateLimited(provider, retryAfter);
    throw new Error(`RATE_LIMIT_${provider.toUpperCase()}`);
  }

  return response;
}

// ─── Build ordered provider list ─────────────────────────────────────────────
// BUG FIX #3: ใช้ isProviderReady() แทน .isRateLimited ตรงๆ
function getAvailableProviders(preferredProvider, groqKey, openrouterKey) {
  const available = [];
  if (groqKey       && isProviderReady('groq'))       available.push({ provider: 'groq',       apiKey: groqKey });
  if (openrouterKey && isProviderReady('openrouter')) available.push({ provider: 'openrouter', apiKey: openrouterKey });

  // เอา preferred provider ขึ้นก่อนเสมอ
  const prefIdx = available.findIndex(p => p.provider === preferredProvider);
  if (prefIdx > 0) {
    const [pref] = available.splice(prefIdx, 1);
    available.unshift(pref);
  }
  return available;
}

// ─── Parse conversation param (multi-turn) ───────────────────────────────────
// NEW: รองรับ ?conversation=<base64-encoded JSON array>
function parseConversation(conversationParam) {
  if (!conversationParam) return null;
  try {
    const decoded = Buffer.from(conversationParam, 'base64').toString('utf8');
    const parsed  = JSON.parse(decoded);
    if (!Array.isArray(parsed)) return null;
    // validate shape
    return parsed.filter(m =>
      m && typeof m === 'object' &&
      ['user', 'assistant', 'system'].includes(m.role) &&
      typeof m.content === 'string' && m.content.trim()
    );
  } catch {
    return null;
  }
}

// ─── /api/models helper ───────────────────────────────────────────────────────
function buildModelsPayload() {
  return Object.entries(SUPPORTED_MODELS).map(([alias, cfg]) => ({
    alias,
    modelId:  cfg.id,
    provider: cfg.provider,
  }));
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // BUG FIX #4: ตรวจ method ก่อนทุกอย่าง
  if (req.method !== 'GET') {
    return jsonResponse(res, 405, {
      status: 'error', success: false,
      error:  'Only GET method is supported',
      generatedText: null, model: null,
    });
  }

  // ─── ?models shortcut ───────────────────────────────────────────────────────
  if (req.query.models !== undefined) {
    return jsonResponse(res, 200, {
      status:  'ok',
      success: true,
      version: '2.0.0',
      models:  buildModelsPayload(),
      default: DEFAULT_MODEL,
    });
  }

  const startTime = Date.now();

  try {
    const {
      prompt,
      model        = DEFAULT_MODEL,
      system       = null,
      conversation = null,   // NEW
    } = req.query;

    // ─── Validate prompt ──────────────────────────────────────────────────────
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return jsonResponse(res, 400, {
        status: 'error', success: false,
        error:  "Missing or empty 'prompt' parameter",
        tip:    "Usage: /api/chat?prompt=Hello",
        generatedText: null, model: null,
      });
    }

    // ─── Resolve model config ─────────────────────────────────────────────────
    let resolvedModelKey = typeof model === 'string' && SUPPORTED_MODELS[model] ? model : DEFAULT_MODEL;
    const modelConfig    = SUPPORTED_MODELS[resolvedModelKey];
    const { id: modelId, provider: preferredProvider } = modelConfig;

    // ─── API keys ─────────────────────────────────────────────────────────────
    const groqKey       = process.env.GROQ_API_KEY       || null;
    const openrouterKey = process.env.OPENROUTER_API_KEY || null;

    // BUG FIX #5: ถ้าไม่มี key เลย ให้ error ชัดเจน
    if (!groqKey && !openrouterKey) {
      console.error('[API] No API keys configured');
      return jsonResponse(res, 503, {
        status: 'error', success: false,
        error:  'API service not configured. No provider keys found.',
        generatedText: null, model: resolvedModelKey,
      });
    }

    // ─── Build messages ───────────────────────────────────────────────────────
    const systemPrompt = (system && typeof system === 'string' && system.trim())
      ? system.trim()
      : DEFAULT_SYSTEM_PROMPT;

    let messages;
    const parsedConversation = parseConversation(conversation);

    if (parsedConversation && parsedConversation.length > 0) {
      // Multi-turn: ใส่ system prompt + history + prompt ล่าสุด
      const hasSystemInHistory = parsedConversation[0]?.role === 'system';
      messages = [
        ...(hasSystemInHistory ? [] : [{ role: 'system', content: systemPrompt }]),
        ...parsedConversation,
        { role: 'user', content: prompt.trim() },
      ];
    } else {
      // Single-turn ปกติ
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: prompt.trim() },
      ];
    }

    // ─── Provider loop ────────────────────────────────────────────────────────
    const available = getAvailableProviders(preferredProvider, groqKey, openrouterKey);

    if (available.length === 0) {
      const resets = [];
      if (providerStatus.groq.resetAt)
        resets.push(`Groq: ${Math.ceil((providerStatus.groq.resetAt - Date.now()) / 1000)}s`);
      if (providerStatus.openrouter.resetAt)
        resets.push(`OpenRouter: ${Math.ceil((providerStatus.openrouter.resetAt - Date.now()) / 1000)}s`);

      return jsonResponse(res, 429, {
        status: 'error', success: false,
        error:  `All AI providers are rate limited. Reset in: ${resets.join(', ')}`,
        generatedText: null, model: resolvedModelKey,
      });
    }

    let httpResponse = null;
    let usedProvider = null;
    let usedModelId  = null;
    let lastError    = null;
    let isFallback   = false;

    for (const { provider, apiKey } of available) {
      // BUG FIX #2 (applied): ใช้ resolveModelId แทน logic เดิมที่ผิด
      const currentModelId = resolveModelId(modelId, provider);

      if (provider !== preferredProvider) isFallback = true;

      try {
        console.log(`[API] Trying ${provider} | model: ${currentModelId}`);
        httpResponse  = await callProvider(provider, currentModelId, messages, apiKey);
        usedProvider  = provider;
        usedModelId   = currentModelId;
        break;
      } catch (err) {
        lastError = err;
        if (err.message?.startsWith('RATE_LIMIT_')) {
          console.log(`[${provider}] Rate limited — trying next provider...`);
          await new Promise(r => setTimeout(r, RATE_LIMIT_RETRY_MS));
          continue;
        }
        // timeout หรือ network error → ลอง provider ถัดไป
        console.error(`[${provider}] Error:`, err.message);
      }
    }

    // ─── No successful response ───────────────────────────────────────────────
    if (!httpResponse) {
      const isRateLimit = lastError?.message?.startsWith('RATE_LIMIT_');
      return jsonResponse(res, isRateLimit ? 429 : 502, {
        status: 'error', success: false,
        error:  isRateLimit
          ? 'All providers are rate limited. Please try again in a moment.'
          : 'Failed to reach any AI provider. Please try again.',
        generatedText: null, model: resolvedModelKey,
      });
    }

    if (!httpResponse.ok) {
      let errBody = '';
      try { errBody = await httpResponse.text(); } catch { /* ignore */ }
      console.error(`[${usedProvider}] HTTP ${httpResponse.status}:`, errBody.slice(0, 200));
      return jsonResponse(res, 502, {
        status: 'error', success: false,
        error:  `Provider returned HTTP ${httpResponse.status}. Please try again.`,
        generatedText: null, model: resolvedModelKey,
      });
    }

    // ─── Parse response ───────────────────────────────────────────────────────
    // BUG FIX #6: safe JSON parse ด้วย content-type check ก่อน
    let data;
    try {
      const contentType = httpResponse.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const raw = await httpResponse.text();
        console.error(`[${usedProvider}] Unexpected content-type: ${contentType}`, raw.slice(0, 200));
        return jsonResponse(res, 502, {
          status: 'error', success: false,
          error:  'Provider returned non-JSON response',
          generatedText: null, model: resolvedModelKey,
        });
      }
      data = await httpResponse.json();
    } catch (e) {
      return jsonResponse(res, 502, {
        status: 'error', success: false,
        error:  'Failed to parse provider response as JSON',
        generatedText: null, model: resolvedModelKey,
      });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply || typeof reply !== 'string' || !reply.trim()) {
      console.error(`[${usedProvider}] Empty reply:`, JSON.stringify(data).slice(0, 300));
      return jsonResponse(res, 500, {
        status: 'error', success: false,
        error:  'AI model returned an empty response',
        generatedText: null, model: resolvedModelKey,
      });
    }

    // ─── Success ──────────────────────────────────────────────────────────────
    return jsonResponse(res, 200, {
      status:        'ok',
      success:       true,
      version:       '2.0.0',
      generatedText: reply.trim(),
      model:         resolvedModelKey,
      modelId:       usedModelId,
      provider:      usedProvider,
      fallback:      isFallback,
      responseTimeMs: Date.now() - startTime,
    });

  } catch (error) {
    console.error('[API] Unhandled error:', error);
    if (error?.name === 'AbortError') {
      return jsonResponse(res, 504, {
        status: 'error', success: false,
        error:  'Request timed out (120 seconds). Try a shorter prompt.',
        generatedText: null, model: null,
      });
    }
    return jsonResponse(res, 500, {
      status: 'error', success: false,
      error:  'Internal server error: ' + (error?.message || 'Unknown'),
      generatedText: null, model: null,
    });
  }
}
