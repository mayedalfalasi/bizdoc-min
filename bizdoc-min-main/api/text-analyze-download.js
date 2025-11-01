import { cors } from "../utils/cors.js";
import { getBaseUrl } from "../utils/baseUrl.js";

function readJson(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); }
    });
  });
}

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
    const { text = "", filename = "BizDoc_Text_Report", meta = {} } = await readJson(req);
    if (!text) return res.status(400).json({ ok:false, error:"Provide 'text' string" });

    const base = process.env.PUBLIC_BASE_URL || getBaseUrl(req);

    // 1) analyze
    const aResp = await fetch(`${base}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, meta })
    });
    if (!aResp.ok) {
      const t = await aResp.text();
      return res.status(502).json({ ok:false, step:"analyze", status: aResp.status, error: t.slice(0,200) });
    }
    const aParsed = await safeJson(aResp);
    if (!aParsed.ok) {
      return res.status(502).json({ ok:false, step:"analyze", error: aParsed.error, body: aParsed.raw?.slice(0,200) });
    }
    if (!aParsed.data?.ok) {
      return res.status(502).json({ ok:false, step:"analyze", error: aParsed.data?.error || "Analyze failed" });
    }

    // 2) download
    const dResp = await fetch(`${base}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "pdf", filename, analysis: aParsed.data.analysis })
    });

    const ct = dResp.headers.get("content-type") || "";
    if (!dResp.ok || !ct.includes("application/pdf")) {
      const txt = await dResp.text();
      return res.status(502).json({
        ok:false, step:"download", status: dResp.status,
        error: "Download endpoint did not return a PDF",
        body: txt.slice(0,200)
      });
    }

    res.statusCode = 200;
    for (const [k, v] of dResp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await dResp.arrayBuffer());
    return res.end(buf);
  } catch (err) {
    return res.status(500).json({ ok:false, error: err.message });
  }
}
