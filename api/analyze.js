import { cors } from "../utils/cors.js";

// Raw body reader (no Next.js parser)
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
  try {
    cors(res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"Method not allowed" });
    }

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

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
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
        model,
        temperature: 0.3,
        messages: [
          { role: "system", content: "Return only valid JSON." },
          { role: "user", content: prompt }
        ],
        // Ask OpenAI to emit a JSON object
        response_format: { type: "json_object" }
      })
    });

    const ct = resp.headers.get("content-type") || "";
    const raw = await resp.text();

    if (!resp.ok) {
      // Try to surface OpenAI's error body
      try {
        const errJ = JSON.parse(raw);
        return res.status(502).json({ ok:false, error: errJ?.error?.message || "OpenAI response error" });
      } catch {
        return res.status(502).json({ ok:false, error: "OpenAI response error: " + raw.slice(0, 200) });
      }
    }

    if (!ct.includes("application/json")) {
      return res.status(502).json({ ok:false, error:"OpenAI returned non-JSON content" });
    }

    let data;
    try { data = JSON.parse(raw); } catch (e) {
      return res.status(502).json({ ok:false, error:"OpenAI JSON parse error: " + (e?.message || String(e)) });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ ok:false, error:"Unexpected OpenAI response shape" });
    }

    let j;
    try { j = JSON.parse(content); }
    catch (e) {
      return res.status(502).json({ ok:false, error:"OpenAI returned non-JSON content" });
    }

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
    // Always return JSON on error
    return res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
}

// Force Node runtime + disable Next bodyParser
export const config = { runtime: "nodejs", api: { bodyParser: false } };
