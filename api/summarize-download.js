// ESM-safe, no top-level return. Coordinator that uses your existing APIs.
export default async function handler(req, res) {
  try {
    // ---- CORS & preflight ----
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(200).end();

    // ---- Parse body safely ----
    const body = typeof req.body === "string" ? safeJSON(req.body) : (req.body || {});
    const { text, pdfUrl, pdfDataUrl, language = "eng", filename = "BizDoc_Summary" } = body;

    const base = inferBaseUrl(req); // https://<host>

    // ---- Step 1: Get doc text (direct or OCR) ----
    const docText = await getDocText({ base, text, pdfUrl, pdfDataUrl, language });

    // ---- Step 2: Analyze via your existing /api/analyze ----
    const analysis = await analyzeText({ base, text: docText, title: filename });

    // ---- Step 3: Optional: SerpAPI enrichment (safe, no-throw) ----
    const serpKey = process.env.SERPAPI_KEY;
    if (serpKey) {
      try {
        const serp = await serpSearch(docText.slice(0, 200), 6, serpKey);
        if (serp?.results?.length) {
          analysis.sources = Array.isArray(analysis.sources) ? analysis.sources : [];
          const seen = new Set(analysis.sources.map(s => s && s.url).filter(Boolean));
          for (const r of serp.results) {
            if (r && r.url && !seen.has(r.url)) {
              analysis.sources.push({ title: r.title, url: r.url });
              seen.add(r.url);
            }
          }
        }
      } catch (e) {
        console.error("SerpAPI enrichment error:", e);
      }
    }

    // ---- Step 4: Render PDF via your existing /api/download ----
    const pdfBytes = await buildPDF({ base, filename, analysis });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeFilename(filename)}.pdf"`
    );
    return res.status(200).send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error("summarize-download error:", e);
    const debug = process.env.BIZDOC_DEBUG === "1";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const payload = debug
      ? { ok: false, error: String(e?.message || e), stack: String(e?.stack || "") }
      : { ok: false, error: "internal_error" };
    return res.status(500).end(JSON.stringify(payload));
  }
}

/* -------------------- helpers (local, no imports) -------------------- */

function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }

function inferBaseUrl(req) {
  const host = req?.headers?.host || "bizdoc-min.vercel.app";
  const proto = "https"; // Vercel functions are behind TLS
  return `${proto}://${host}`;
}

function sanitizeFilename(name) {
  return String(name || "BizDoc_Summary").replace(/[^a-z0-9._-]/gi, "_");
}

async function getDocText({ base, text, pdfUrl, pdfDataUrl, language }) {
  // 1) If text is provided (non-empty), use it and skip OCR entirely
  if (typeof text === "string" && text.trim().length > 0) {
    return String(text);
  }

  // 2) If a DataURL is provided, OCR that (no URL required)
  if (typeof pdfDataUrl === "string" && pdfDataUrl.startsWith("data:application/pdf;base64,")) {
    const r = await fetch(`${base}/api/ocr-ocrspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: pdfDataUrl, language: language || "eng" })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OCR error: ${j?.error || r.statusText}`);
    return j?.text || j?.preview || "";
  }

  // 3) If a URL is provided, validate and OCR it
  if (typeof pdfUrl === "string" && pdfUrl.trim().length > 0) {
    const u = pdfUrl.trim();
    const isHttp = /^https?:\/\//i.test(u);
    const isPdf = /\.pdf(\?|#|$)/i.test(u) || u.toLowerCase().endsWith(".pdf");
    if (!isHttp) throw new Error("OCR error: Invalid or missing URL (must start with http/https)");
    // not strictly required, but helpful to catch image/docx links
    if (!isPdf) console.warn("Note: pdfUrl does not end with .pdf — OCR may still work if the server sends a PDF mime-type.");

    const r = await fetch(`${base}/api/ocr-ocrspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: u, language: language || "eng" })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OCR error: ${j?.error || r.statusText}`);
    return j?.text || j?.preview || "";
  }

  // 4) Nothing valid provided → clear, actionable error (no 500)
  throw new Error("No input provided: send 'text' or 'pdfUrl' (http/https) or 'pdfDataUrl' (base64).");
}

  if (pdfUrl) {
    const r = await fetch(`${base}/api/ocr-ocrspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: pdfUrl, language })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OCR error: ${j?.error || r.statusText}`);
    return j?.text || j?.preview || "";
  }

  throw new Error("No input provided: send 'text' or 'pdfUrl' or 'pdfDataUrl'.");
}

async function analyzeText({ base, text, title }) {
  const r = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, meta: { title } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Analyze error: ${j?.error || r.statusText}`);
  return j;
}

async function buildPDF({ base, filename, analysis }) {
  const r = await fetch(`${base}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "pdf",
      filename,
      analysis
    })
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) {
    let reason = "download_failed";
    try {
      const j = JSON.parse(buf.toString("utf8"));
      reason = j?.error || reason;
    } catch {}
    throw new Error(`Download error: ${reason}`);
  }
  return buf;
}

async function serpSearch(q, num, apiKey) {
  const url = "https://serpapi.com/search.json?" + new URLSearchParams({
    q, engine: "google", num: String(num || 6), api_key: apiKey
  });
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  const results = Array.isArray(j?.organic_results)
    ? j.organic_results.slice(0, num || 6).map(x => ({
        title: x.title,
        url: x.link,
        snippet: x.snippet
      }))
    : [];
  return { ok: true, results };
}
