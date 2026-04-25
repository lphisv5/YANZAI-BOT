const SUPPORTED_MODELS = {
  // ---------- OpenRouter (ฟรี) ----------
  'elephant-alpha': { id: 'openrouter/elephant-alpha', provider: 'openrouter' },
  'llama-3.3-70b': { id: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  'gemma-4-31b': { id: 'google/gemma-4-31b-it:free', provider: 'openrouter' },
  'nemotron-3-super': { id: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'openrouter' },
  'gpt-oss-120b': { id: 'openai/gpt-oss-120b:free', provider: 'openrouter' },
  'qwen-3.6-plus': { id: 'qwen/qwen3.6-plus-preview:free', provider: 'openrouter' },
  'auto-free': { id: 'openrouter/free', provider: 'openrouter' },

  // แนะนำ
  'llama-groq':       { id: 'llama-3.3-70b-versatile', provider: 'groq' },
  'mixtral-groq':     { id: 'mixtral-8x7b-32768',      provider: 'groq' },
  'gemma-groq':       { id: 'gemma2-9b-it',            provider: 'groq' },
  'llama-3.1-groq':   { id: 'llama-3.1-70b-versatile', provider: 'groq' },
  // DeepSeek (Groq)
  'deepseek-r1-llama':   { id: 'deepseek-r1-distill-llama-70b', provider: 'groq' },
  'deepseek-r1-qwen':    { id: 'deepseek-r1-distill-qwen-32b',  provider: 'groq' },
  // Llama 3.2 series
  'llama-3.2-1b':        { id: 'llama-3.2-1b-preview',          provider: 'groq' },
  'llama-3.2-3b':        { id: 'llama-3.2-3b-preview',          provider: 'groq' },
  'llama-3.2-11b':       { id: 'llama-3.2-11b-text-preview',    provider: 'groq' },
  'llama-3.2-90b':       { id: 'llama-3.2-90b-text-preview',    provider: 'groq' },
  // Llama 3.1 405B (reasoning)
  'llama-3.1-405b':      { id: 'llama-3.1-405b-reasoning',      provider: 'groq' },
  // Qwen (Groq)
  'qwen-2.5-32b':        { id: 'qwen-2.5-32b',                  provider: 'groq' },
  'qwen-2.5-72b':        { id: 'qwen-2.5-72b',                  provider: 'groq' },
  'qwen-2.5-coder-32b':  { id: 'qwen-2.5-coder-32b',            provider: 'groq' },
  'qwq-32b':             { id: 'qwq-32b',                       provider: 'groq' }
};

const DEFAULT_MODEL = 'auto-free';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant. Answer clearly, accurately, and politely. Respond in the same language as the user. Provide detailed, high-quality responses.';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const REQUEST_TIMEOUT_MS = 120000;
const RATE_LIMIT_RETRY_MS = 4000;
const providerStatus = {
  groq:       { isRateLimited: false, resetAt: null },
  openrouter: { isRateLimited: false, resetAt: null }
};

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function jsonResponse(res, status, data) {
  res.status(status).json(data);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callProvider(provider, modelId, messages, apiKey) {
  const apiUrl = provider === 'groq' ? GROQ_API_URL : OPENROUTER_API_URL;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider !== 'groq' && process.env.VERCEL_URL) {
    headers['HTTP-Referer'] = `https://${process.env.VERCEL_URL}`;
    headers['X-Title'] = 'Discord Bot AI API';
  }

  const requestBody = {
    model: modelId,
    messages: messages,
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 4096
  };

  const response = await fetchWithTimeout(apiUrl, { method: 'POST', headers, body: JSON.stringify(requestBody) }, REQUEST_TIMEOUT_MS);

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after') || '60';
    const resetMs = parseInt(retryAfter) * 1000;
    providerStatus[provider].isRateLimited = true;
    providerStatus[provider].resetAt = Date.now() + resetMs;
    console.log(`[${provider.toUpperCase()}] Rate limited! Reset in ${retryAfter}s`);
    throw new Error(`RATE_LIMIT_${provider}`);
  }
  return response;
}

function getAvailableProviders(preferredProvider, groqKey, openrouterKey) {
  const available = [];
  if (groqKey && !providerStatus.groq.isRateLimited)
    available.push({ provider: 'groq', apiKey: groqKey });
  if (openrouterKey && !providerStatus.openrouter.isRateLimited)
    available.push({ provider: 'openrouter', apiKey: openrouterKey });

  const prefIndex = available.findIndex(p => p.provider === preferredProvider);
  if (prefIndex > 0) {
    const [pref] = available.splice(prefIndex, 1);
    available.unshift(pref);
  }
  return available;
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return jsonResponse(res, 405, {
      status: "error", generatedText: null, model: null, success: false,
      error: "Only GET method is allowed"
    });
  }

  try {
    let { prompt, model = DEFAULT_MODEL, system = null } = req.query;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return jsonResponse(res, 400, {
        status: "error", generatedText: null, model: null, success: false,
        error: "Missing 'prompt' parameter"
      });
    }

    let modelConfig = SUPPORTED_MODELS[model];
    if (!modelConfig) {
      modelConfig = SUPPORTED_MODELS[DEFAULT_MODEL];
      model = DEFAULT_MODEL;
    }
    const { id: modelId, provider: preferredProvider } = modelConfig;

    const groqKey = process.env.GROQ_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    const systemPrompt = (system && typeof system === 'string' && system.trim()) 
      ? system.trim() : DEFAULT_SYSTEM_PROMPT;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt.trim() }
    ];

    let available = getAvailableProviders(preferredProvider, groqKey, openrouterKey);
    if (available.length === 0) {
      const resets = [];
      if (providerStatus.groq.resetAt) resets.push(`Groq: ${Math.ceil((providerStatus.groq.resetAt - Date.now())/1000)}s`);
      if (providerStatus.openrouter.resetAt) resets.push(`OpenRouter: ${Math.ceil((providerStatus.openrouter.resetAt - Date.now())/1000)}s`);
      return jsonResponse(res, 429, {
        status: "error", generatedText: null, model: model, success: false,
        error: `All AI providers rate limited. Reset in: ${resets.join(', ')}. Please try again later.`
      });
    }

    let response = null;
    let usedProvider = null;
    let usedModelId = null;
    let lastError = null;

    for (const providerInfo of available) {
      const currentProvider = providerInfo.provider;
      let currentModelId = modelId;
      if (currentProvider === 'groq' && !modelId.includes('groq') && !modelId.includes('llama') && !modelId.includes('mixtral') && !modelId.includes('gemma') && !modelId.includes('qwen') && !modelId.includes('deepseek')) {
        currentModelId = 'llama-3.3-70b-versatile';
      } else if (currentProvider === 'openrouter' && modelId.includes('groq')) {
        currentModelId = 'openrouter/free';
      }

      try {
        console.log(`[API] Trying ${currentProvider} with model: ${currentModelId}`);
        response = await callProvider(currentProvider, currentModelId, messages, providerInfo.apiKey);
        usedProvider = currentProvider;
        usedModelId = currentModelId;
        break;
      } catch (err) {
        lastError = err;
        if (err.message?.includes('RATE_LIMIT')) {
          console.log(`[${currentProvider}] Rate limited, switching...`);
          await new Promise(r => setTimeout(r, RATE_LIMIT_RETRY_MS));
          continue;
        }
        console.error(`[${currentProvider}] Error:`, err);
      }
    }

    if (!response || !response.ok) {
      if (lastError?.message?.includes('RATE_LIMIT')) {
        return jsonResponse(res, 429, {
          status: "error", generatedText: null, model: model, success: false,
          error: "All providers rate limited. Try again in a minute."
        });
      }
      return jsonResponse(res, 502, {
        status: "error", generatedText: null, model: model, success: false,
        error: "AI service error. Please try again."
      });
    }

    let data;
    try {
      data = await response.json();
    } catch(e) {
      return jsonResponse(res, 502, {
        status: "error", generatedText: null, model: model, success: false,
        error: "Invalid response from AI provider"
      });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) {
      return jsonResponse(res, 500, {
        status: "error", generatedText: null, model: model, success: false,
        error: "No reply from AI model"
      });
    }

    return jsonResponse(res, 200, {
      status: "ok",
      generatedText: reply.trim(),
      model: model,
      provider: usedProvider,
      fallback: usedProvider !== preferredProvider,
      success: true
    });

  } catch (error) {
    console.error('[API] Error:', error);
    if (error?.name === 'AbortError') {
      return jsonResponse(res, 504, {
        status: "error", generatedText: null, model: null, success: false,
        error: "Request timeout (120 seconds)"
      });
    }
    return jsonResponse(res, 500, {
      status: "error", generatedText: null, model: null, success: false,
      error: "Internal server error: " + (error.message || "Unknown")
    });
  }
}
