import { cors } from "../utils/cors.js";

// Raw body reader (works with edge cases)
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: "OpenAI not configured. Set OPENAI_API_KEY in Vercel env.",
        needsOpenAI: true
      });
    }

    const body = await readJson(req);
    const { text = "", meta = {} } = body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ ok:false, error:"Please provide 'text' string." });
    }

    const prompt = `
You are a senior financial/business analyst. Return a STRICT JSON object with these keys:
- executiveSummary (120–180 words, English, rigorous, concise)
- keyMetrics: array of {label, value, unit, note}
- riskScores: {financialStability, liquidity, concentrationRisk, compliance, growthOutlook} each 1–5
- opportunities: 3 short bullet strings
- recommendations: 3 items of {title, detail}
- entities: {companies, investors, regulators, people} (arrays of strings)
- dates: array of strings found in the text
- amounts: array of strings (USD where applicable) found in the text
- trends: { narrative: string, kpis: [ {name:"Revenue", points:[{x:"Q1",y:number},...]} ] }

Analyze this text:
---
${String(text).slice(0, 40000)}
---`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: "Return only valid JSON." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(502).json({ ok:false, error: data?.error?.message || "OpenAI response error" });
    }

    let j;
    try { j = JSON.parse(data.choices[0].message.content); }
    catch { return res.status(502).json({ ok:false, error:"OpenAI returned non-JSON content" }); }

    // Assemble a strict LLM-only payload
    const out = {
      ok: true,
      model: "openai",
      version: "2025.10.29",
      generatedAt: new Date().toISOString(),
      input: { meta, bytes: text.length },
      executiveSummary: j.executiveSummary,
      keyMetrics: Array.isArray(j.keyMetrics) ? j.keyMetrics : [],
      riskScores: j.riskScores || {},
      opportunities: Array.isArray(j.opportunities) ? j.opportunities : [],
      recommendations: Array.isArray(j.recommendations) ? j.recommendations : [],
      entities: j.entities || { companies:[], investors:[], regulators:[], people:[] },
      dates: Array.isArray(j.dates) ? j.dates : [],
      amounts: Array.isArray(j.amounts) ? j.amounts : [],
      trends: j.trends || { narrative:"", kpis:[] },
      confidence: 0.9
    };

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
}

export const config = { runtime: "nodejs", api: { bodyParser: false } } };
