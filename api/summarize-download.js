// Robust coordinator: parses body even if req.body is empty, forces text-first,
// OCR only if no text, safe errors, optional SerpAPI enrichment.
export default async function handler(req, res) {
  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(200).end();

    // Parse JSON body robustly (handles undefined req.body on Vercel)
    const body = await readJson(req);

    // Normalized inputs
    const filename = saneString(body.filename) || "BizDoc_Summary";
    const language = saneString(body.language) || "eng";
    const text     = body.text != null ? String(body.text) : "";
    const pdfUrl   = body.pdfUrl != null ? String(body.pdfUrl) : "";
    const pdfDataUrl = body.pdfDataUrl != null ? String(body.pdfDataUrl) : "";

    const base = inferBaseUrl(req);

    // === TEXT-FIRST GUARANTEE ===
    if (text.trim().length > 0) {
      const analysis = await analyzeText({ base, text, title: filename });
      const withSources = await trySerpAugment(analysis, text);
      const pdfBytes = await buildPDF({ base, filename, analysis: withSources });
      return sendPDF(res, filename, pdfBytes);
    }

    // === OCR (base64) ===
    if (pdfDataUrl.startsWith("data:application/pdf;base64,")) {
      const ocrText = await ocrDataUrl({ base, pdfDataUrl, language });
      const analysis = await analyzeText({ base, text: ocrText, title: filename });
      const withSources = await trySerpAugment(analysis, ocrText);
      const pdfBytes = await buildPDF({ base, filename, analysis: withSources });
      return sendPDF(res, filename, pdfBytes);
    }

    // === OCR (URL) ===
    if (pdfUrl.trim().length > 0) {
      const u = pdfUrl.trim();
      if (!/^https?:\/\//i.test(u)) throw new Error("OCR error: Invalid or missing URL (http/https required)");
      const ocrText = await ocrUrl({ base, url: u, language });
      const analysis = await analyzeText({ base, text: ocrText, title: filename });
      const withSources = await trySerpAugment(analysis, ocrText);
      const pdfBytes = await buildPDF({ base, filename, analysis: withSources });
      return sendPDF(res, filename, pdfBytes);
    }

    throw new Error("No input provided: send 'text' or 'pdfUrl' or 'pdfDataUrl'.");
  } catch (e) {
    console.error("summarize-download error:", e);
    const debug = process.env.BIZDOC_DEBUG === "1";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).end(JSON.stringify(
      debug ? { ok:false, error:String(e?.message||e), stack:String(e?.stack||"") }
            : { ok:false, error:"internal_error" }
    ));
  }
}

/* ---------------- helpers ---------------- */

function saneString(v){ return (v==null)? "": String(v); }
function inferBaseUrl(req){ const host = req?.headers?.host || "bizdoc-min.vercel.app"; return `https://${host}`; }

async function readJson(req){
  if (typeof req.body === "string") return safeJSON(req.body);
  if (req.body && typeof req.body === "object") return req.body;
  let data=""; for await (const chunk of req) data += chunk;
  return safeJSON(data);
}
function safeJSON(s){ try { return JSON.parse(s); } catch { return {}; } }

function sendPDF(res, filename, bytes){
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi,"_")}.pdf"`);
  return res.status(200).send(Buffer.from(bytes));
}

async function ocrDataUrl({ base, pdfDataUrl, language }){
  const r = await fetch(`${base}/api/ocr-ocrspace`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ dataUrl: pdfDataUrl, language })
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(`OCR error: ${j?.error || r.statusText}`);
  return j?.text || j?.preview || "";
}
async function ocrUrl({ base, url, language }){
  const r = await fetch(`${base}/api/ocr-ocrspace`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ url, language })
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(`OCR error: ${j?.error || r.statusText}`);
  return j?.text || j?.preview || "";
}

async function analyzeText({ base, text, title }){
  const r = await fetch(`${base}/api/analyze`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ text, meta:{ title } })
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(`Analyze error: ${j?.error || r.statusText}`);
  return j;
}

async function buildPDF({ base, filename, analysis }){
  const r = await fetch(`${base}/api/download`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ type:"pdf", filename, analysis })
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok){
    let reason="download_failed";
    try { const j = JSON.parse(buf.toString("utf8")); reason = j?.error || reason; } catch{}
    throw new Error(`Download error: ${reason}`);
  }
  return buf;
}

async function trySerpAugment(analysis, text){
  const key = process.env.SERPAPI_KEY;
  if (!key || !text) return analysis;
  try {
    const s = await serpSearch(text.slice(0,200), 6, key);
    if (s?.results?.length){
      analysis.sources = Array.isArray(analysis.sources) ? analysis.sources : [];
      const seen = new Set(analysis.sources.map(x => x && x.url).filter(Boolean));
      for (const r of s.results){
        if (r?.url && !seen.has(r.url)){
          analysis.sources.push({ title:r.title, url:r.url });
          seen.add(r.url);
        }
      }
    }
  } catch(e){ console.error("Serp enrichment error:", e); }
  return analysis;
}

async function serpSearch(q, num, apiKey){
  const url = "https://serpapi.com/search.json?" + new URLSearchParams({
    q, engine:"google", num:String(num||6), api_key:apiKey
  });
  const r = await fetch(url);
  const j = await r.json().catch(()=> null);
  const results = Array.isArray(j?.organic_results)
    ? j.organic_results.slice(0, num||6).map(x => ({ title:x.title, url:x.link, snippet:x.snippet }))
    : [];
  return { ok:true, results };
}
