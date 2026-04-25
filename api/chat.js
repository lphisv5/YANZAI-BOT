const SUPPORTED_MODELS = {
  'elephant-alpha': { id: 'openrouter/elephant-alpha', provider: 'openrouter' },
  'llama-3.3-70b': { id: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  'gemma-4-31b': { id: 'google/gemma-4-31b-it:free', provider: 'openrouter' },
  'nemotron-3-super': { id: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'openrouter' },
  'gpt-oss-120b': { id: 'openai/gpt-oss-120b:free', provider: 'openrouter' },
  'qwen-3.6-plus': { id: 'qwen/qwen3.6-plus-preview:free', provider: 'openrouter' },
  'auto-free': { id: 'openrouter/free', provider: 'openrouter' },
  
  'llama-groq': { id: 'llama-3.3-70b-versatile', provider: 'groq' },
  'mixtral-groq': { id: 'mixtral-8x7b-32768', provider: 'groq' },
  'gemma-groq': { id: 'gemma2-9b-it', provider: 'groq' },
  'llama-3.1-groq': { id: 'llama-3.1-70b-versatile', provider: 'groq' }
};

const DEFAULT_MODEL = 'auto-free';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant. Answer clearly, accurately, and politely. Respond in the same language as the user. Provide detailed, high-quality responses.';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const REQUEST_TIMEOUT_MS = 120000;

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

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return jsonResponse(res, 405, { 
      status: "error",
      generatedText: null,
      model: null,
      success: false,
      error: "Only GET method is allowed"
    });
  }

  try {
    let { prompt, model = DEFAULT_MODEL, system = null } = req.query;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return jsonResponse(res, 400, {
        status: "error",
        generatedText: null,
        model: null,
        success: false,
        error: "Missing 'prompt' parameter"
      });
    }

    let modelConfig = SUPPORTED_MODELS[model];
    if (!modelConfig) {
      modelConfig = SUPPORTED_MODELS[DEFAULT_MODEL];
      model = DEFAULT_MODEL;
    }

    const { id: modelId, provider } = modelConfig;
    
    let apiUrl, apiKey;
    
    if (provider === 'groq') {
      apiUrl = GROQ_API_URL;
      apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        return jsonResponse(res, 500, {
          status: "error",
          generatedText: null,
          model: model,
          success: false,
          error: "Missing GROQ_API_KEY environment variable"
        });
      }
    } else {
      apiUrl = OPENROUTER_API_URL;
      apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return jsonResponse(res, 500, {
          status: "error",
          generatedText: null,
          model: model,
          success: false,
          error: "Missing OPENROUTER_API_KEY environment variable"
        });
      }
    }

    const systemPrompt = (system && typeof system === 'string' && system.trim()) 
      ? system.trim() 
      : DEFAULT_SYSTEM_PROMPT;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt.trim() }
    ];

    const requestBody = {
      model: modelId,
      messages: messages,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 4096
    };

    const upstreamHeaders = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    if (provider !== 'groq' && process.env.VERCEL_URL) {
      upstreamHeaders['HTTP-Referer'] = `https://${process.env.VERCEL_URL}`;
      upstreamHeaders['X-Title'] = 'Discord Bot AI API';
    }

    const response = await fetchWithTimeout(
      apiUrl,
      { method: 'POST', headers: upstreamHeaders, body: JSON.stringify(requestBody) },
      REQUEST_TIMEOUT_MS
    );

    let data;
    try {
      data = await response.json();
    } catch (error) {
      return jsonResponse(res, 502, {
        status: "error",
        generatedText: null,
        model: model,
        success: false,
        error: `${provider.toUpperCase()} returned invalid response`
      });
    }

    if (!response.ok) {
      console.error(`[API] ${provider} error:`, data);
      const errorMessage = data?.error?.message || data?.error || `${provider} API error`;
      return jsonResponse(res, response.status === 402 ? 402 : 502, {
        status: "error",
        generatedText: null,
        model: model,
        success: false,
        error: errorMessage
      });
    }

    const reply = data?.choices?.[0]?.message?.content || null;
    
    if (!reply) {
      return jsonResponse(res, 500, {
        status: "error",
        generatedText: null,
        model: model,
        success: false,
        error: "No reply from AI model"
      });
    }

    return jsonResponse(res, 200, {
      status: "ok",
      generatedText: reply.trim(),
      model: model,
      provider: provider,
      success: true
    });

  } catch (error) {
    console.error('[API] Error:', error);
    
    if (error?.name === 'AbortError') {
      return jsonResponse(res, 504, {
        status: "error",
        generatedText: null,
        model: null,
        success: false,
        error: "Request timeout - AI took too long to respond (120 seconds)"
      });
    }
    
    return jsonResponse(res, 500, {
      status: "error",
      generatedText: null,
      model: null,
      success: false,
      error: "Internal server error: " + (error.message || "Unknown error")
    });
  }
}
