import { cors } from "../utils/cors.js";
import { getBaseUrl } from "../utils/baseUrl.js";

async function safeJson(resp) {
  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text();
  if (ct.includes("application/json")) {
    try { return { ok: true, data: JSON.parse(text), raw: text }; }
    catch (e) { return { ok: false, error: `JSON parse error: ${e.message}`, raw: text }; }
  }
  return { ok: false, error: `Non-JSON response (status ${resp.status})`, raw: text };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  try {
    const { url, language = "eng", filename = "BizDoc_Report", meta = {} } = req.body || {};
    if (!url) return res.status(400).json({ ok:false, error:"Provide 'url' to OCR" });

    const base = process.env.PUBLIC_BASE_URL || getBaseUrl(req);

    // 1) OCR
    const ocrResp = await fetch(`${base}/api/ocr-ocrspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, language })
    });
    if (!ocrResp.ok) {
      const t = await ocrResp.text();
      return res.status(502).json({ ok:false, step:"ocr", status: ocrResp.status, error: t.slice(0,200) });
    }
    const ocrParsed = await safeJson(ocrResp);
    if (!ocrParsed.ok) {
      return res.status(502).json({ ok:false, step:"ocr", error: ocrParsed.error, body: ocrParsed.raw?.slice(0,200) });
    }
    if (!ocrParsed.data?.ok) {
      return res.status(502).json({ ok:false, step:"ocr", error: ocrParsed.data?.error || "OCR failed" });
    }
    const text = ocrParsed.data.preview || "";

    // 2) Analyze
    const analyzeResp = await fetch(`${base}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, meta: { ...meta, sourceUrl: url, language } })
    });
    if (!analyzeResp.ok) {
      const t = await analyzeResp.text();
      return res.status(502).json({ ok:false, step:"analyze", status: analyzeResp.status, error: t.slice(0,200) });
    }
    const analyzeParsed = await safeJson(analyzeResp);
    if (!analyzeParsed.ok) {
      return res.status(502).json({ ok:false, step:"analyze", error: analyzeParsed.error, body: analyzeParsed.raw?.slice(0,200) });
    }
    if (!analyzeParsed.data?.ok) {
      return res.status(502).json({ ok:false, step:"analyze", error: analyzeParsed.data?.error || "Analyze failed" });
    }

    // 3) Download PDF
    const dlResp = await fetch(`${base}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "pdf", filename, analysis: analyzeParsed.data.analysis })
    });

    if (!dlResp.ok || !(dlResp.headers.get("content-type") || "").includes("application/pdf")) {
      const txt = await dlResp.text();
      return res.status(502).json({
        ok:false, step:"download", status: dlResp.status,
        error: "Download endpoint did not return a PDF",
        body: txt.slice(0,200)
      });
    }

    res.statusCode = 200;
    for (const [k, v] of dlResp.headers.entries()) res.setHeader(k, v);
    const arr = await dlResp.arrayBuffer();
    return res.end(Buffer.from(arr));
  } catch (err) {
    return res.status(500).json({ ok:false, error: err.message });
  }
}

export const config = { runtime: "nodejs" };
