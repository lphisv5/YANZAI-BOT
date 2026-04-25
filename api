const SUPPORTED_MODELS = {
  'gpt-4o': { id: 'openai/gpt-4o' },
  'gpt-4-turbo': { id: 'openai/gpt-4-turbo-preview' },
  'claude-3.5-sonnet': { id: 'anthropic/claude-3.5-sonnet' },
  'claude-3-opus': { id: 'anthropic/claude-3-opus' },
  'deepseek-v3.1': { id: 'deepseek/deepseek-chat-v3.1' },
  'llama-3.3-70b': { id: 'meta-llama/llama-3.3-70b-instruct' },
  'qwen-max': { id: 'qwen/qwen-max' },
  'qwen-plus': { id: 'qwen/qwen-plus' },
  'mistral-large-2411': { id: 'mistralai/mistral-large-2411' },
  'gemini-2.0-flash': { id: 'google/gemini-2.0-flash-001' },
  'gemini-1.5-pro': { id: 'google/gemini-1.5-pro' },
  'command-r-plus': { id: 'cohere/command-r-plus-08-2024' },
  'mixtral-8x22b': { id: 'mistralai/mixtral-8x22b-instruct' },
  'grok-beta': { id: 'x-ai/grok-beta' }
};

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant with excellent memory and understanding. Answer clearly, accurately, and politely. Respond in the same language as the user. Provide detailed, high-quality responses.';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
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
      error: "Only GET method is allowed. Use: GET /api/chat?prompt=your+question&model=gpt-4o"
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
        error: "Missing 'prompt' parameter. Example: /api/chat?prompt=Hello%20world&model=gpt-4o"
      });
    }

    let modelId;
    if (SUPPORTED_MODELS[model]) {
      modelId = SUPPORTED_MODELS[model].id;
    } else {
      modelId = SUPPORTED_MODELS[DEFAULT_MODEL].id;
      model = DEFAULT_MODEL;
    }

    const systemPrompt = (system && typeof system === 'string' && system.trim()) 
      ? system.trim() 
      : DEFAULT_SYSTEM_PROMPT;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt.trim() }
    ];

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error('[API] OPENROUTER_API_KEY is not set');
      return jsonResponse(res, 500, {
        status: "error",
        generatedText: null,
        model: model,
        success: false,
        error: "Server configuration error: Missing API key"
      });
    }

    const requestBody = {
      model: modelId,
      messages: messages,
      temperature: 0.7,
      top_p: 0.9,
      frequency_penalty: 0,
      presence_penalty: 0
    };

    const upstreamHeaders = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    if (process.env.VERCEL_URL) {
      upstreamHeaders['HTTP-Referer'] = `https://${process.env.VERCEL_URL}`;
      upstreamHeaders['X-Title'] = 'Discord Bot AI API';
    }

    const response = await fetchWithTimeout(
      OPENROUTER_API_URL,
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
        error: "OpenRouter returned invalid response"
      });
    }

    if (!response.ok) {
      console.error('[API] OpenRouter error:', data);
      const errorMessage = data?.error?.message || 'OpenRouter API error';
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
