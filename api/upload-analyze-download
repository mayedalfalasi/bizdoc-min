import { cors } from "../utils/cors.js";
import { getBaseUrl } from "../utils/baseUrl.js";

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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
    const ct = (req.headers["content-type"] || "").toLowerCase();
    const language = (req.headers["x-language"] || "eng").toString().toLowerCase();
    const filename = (req.headers["x-filename"] || "Uploaded").toString();

    if (!ct.includes("application/pdf")) {
      return res.status(400).json({ ok:false, error:"Send PDF body with Content-Type: application/pdf" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) return res.status(500).json({ ok:false, error:"Missing OCR_SPACE_API_KEY in environment" });

    const pdfBuf = await readRaw(req);
    if (!pdfBuf?.length) return res.status(400).json({ ok:false, error:"Empty PDF body" });

    // ===== 1) OCR.Space: upload the PDF as a file =====
    const form = new FormData();
    // NOTE: Blob is available on Node 18+/Vercel runtimes
    form.append("file", new Blob([pdfBuf], { type: "application/pdf" }), filename.endsWith(".pdf") ? filename : filename + ".pdf");
    form.append("language", language);     // single code (eng/ara)
    form.append("filetype", "PDF");
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2");

    const ocrResp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: apiKey },
      body: form
    });

    const ocrParsed = await safeJson(ocrResp);
    if (!ocrParsed.ok) {
      return res.status(502).json({ ok:false, step:"ocr", error: ocrParsed.error, body: ocrParsed.raw?.slice(0,200) });
    }
    const data = ocrParsed.data;
    if (data.IsErroredOnProcessing) {
      const msgs = [];
      if (data.ErrorMessage) msgs.push(data.ErrorMessage);
      if (data.ErrorDetails) msgs.push(data.ErrorDetails);
      return res.status(502).json({ ok:false, step:"ocr", error: msgs.length ? msgs : "OCR processing error" });
    }
    const text = data.ParsedResults?.[0]?.ParsedText || "";
    if (!text) return res.status(502).json({ ok:false, step:"ocr", error:"No text returned from OCR" });

    const base = process.env.PUBLIC_BASE_URL || getBaseUrl(req);

    // ===== 2) Analyze =====
    const aResp = await fetch(`${base}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, meta: { source: "upload", language, filename } })
    });
    if (!aResp.ok) {
      const t = await aResp.text();
      return res.status(502).json({ ok:false, step:"analyze", status: aResp.status, error: t.slice(0,200) });
    }
    const aParsed = await safeJson(aResp);
    if (!aParsed.ok || !aParsed.data?.ok) {
      return res.status(502).json({ ok:false, step:"analyze", error: aParsed.error || aParsed.data?.error || "Analyze failed" });
    }

    // ===== 3) Download PDF =====
    const dResp = await fetch(`${base}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "pdf",
        filename: filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "BizDoc_Report",
        analysis: aParsed.data.analysis
      })
    });

    const dCT = dResp.headers.get("content-type") || "";
    if (!dResp.ok || !dCT.includes("application/pdf")) {
      const txt = await dResp.text();
      return res.status(502).json({
        ok:false, step:"download", status: dResp.status,
        error: "Download endpoint did not return a PDF",
        body: txt.slice(0,200)
      });
    }

    // Pipe PDF back
    res.statusCode = 200;
    for (const [k,v] of dResp.headers.entries()) res.setHeader(k, v);
    const arr = await dResp.arrayBuffer();
    return res.end(Buffer.from(arr));
  } catch (err) {
    return res.status(500).json({ ok:false, error: err.message });
  }
}
