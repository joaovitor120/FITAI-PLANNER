const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-latest'
].filter(Boolean);

function hasGeminiKey() {
  return Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
}

async function publicHfText({ systemPrompt, userPrompt }) {
  const body = {
    inputs: `${systemPrompt}\n\n${userPrompt}`,
    parameters: { max_new_tokens: 500, temperature: 0.4, return_full_text: false }
  };

  const endpoints = [
    'https://router.huggingface.co/hf-inference/models/google/flan-t5-large',
    'https://router.huggingface.co/hf-inference/models/google/flan-t5-base'
  ];

  let lastErr = null;
  for (const url of endpoints) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const data = await res.json();
      const text = Array.isArray(data) ? data?.[0]?.generated_text : data?.generated_text;
      if (!text || !String(text).trim()) throw new Error('HF_EMPTY');
      return String(text).trim();
    }

    const t = await res.text().catch(() => '');
    lastErr = new Error(`HF_HTTP_${res.status}:${t.slice(0, 200)}`);
  }

  throw lastErr || new Error('HF_UNAVAILABLE');
}

async function geminiText({ systemPrompt, userPrompt, temperature = 0.4, maxOutputTokens = 700 }) {
  const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

  if (key) {
    let lastErr = null;
    for (const model of MODEL_CANDIDATES) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature, maxOutputTokens }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
        if (!text) throw new Error('GEMINI_EMPTY');
        return text;
      }

      const errText = await res.text().catch(() => '');
      lastErr = new Error(`GEMINI_HTTP_${res.status}:${model}:${errText.slice(0, 200)}`);
      if (res.status !== 404) break;
    }

    const msg = String(lastErr?.message || '');
    if (!msg.includes('GEMINI_HTTP_429') && !msg.includes('GEMINI_HTTP_403') && !msg.includes('GEMINI_HTTP_404')) {
      throw lastErr || new Error('GEMINI_NO_MODEL_AVAILABLE');
    }
  }

  return publicHfText({ systemPrompt, userPrompt });
}

async function geminiJson({ systemPrompt, userPrompt, schemaHint }) {
  const prompt = `${userPrompt}\n\nRetorne APENAS JSON válido, sem markdown. Estrutura esperada: ${schemaHint}`;
  const raw = await geminiText({ systemPrompt, userPrompt: prompt, temperature: 0.2, maxOutputTokens: 900 });

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) throw new Error('AI_JSON_PARSE');
  return JSON.parse(raw.slice(start, end + 1));
}

module.exports = { hasGeminiKey, geminiText, geminiJson, publicHfText };
