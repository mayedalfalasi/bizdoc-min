import { PDFDocument, StandardFonts } from "pdf-lib";
import { cors } from "../utils/cors.js";

// ========= Config =========
export const config = { runtime: "nodejs", api: { bodyParser: false } };
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ========= Helpers =========
function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}
const sanitize = (s) => String(s||"BizDoc_Summary").replace(/[^\w\-]+/g,"_").slice(0,64) || "BizDoc_Summary";

async function runOCRUrl(url, language="eng") {
  if (!process.env.OCR_SPACE_API_KEY) throw new Error("Missing OCR_SPACE_API_KEY");
  const form = new URLSearchParams();
  form.append("url", url);
  form.append("language", language.toLowerCase());
  form.append("filetype", "PDF");
  form.append("isOverlayRequired", "false");
  form.append("detectOrientation", "true");
  form.append("scale", "true");
  form.append("OCREngine", "2");

  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST", headers: { apikey: process.env.OCR_SPACE_API_KEY }, body: form
  });
  const j = await r.json().catch(() => null);
  if (!j || j.IsErroredOnProcessing) {
    const msg = j?.ErrorMessage || j?.ErrorDetails || "OCR error";
    throw new Error(Array.isArray(msg)? msg.join("; ") : String(msg));
  }
  const text = j?.ParsedResults?.[0]?.ParsedText || "";
  if (!text) throw new Error("OCR produced no text");
  return text;
}

async function runOCRDataUrl(pdfDataUrl, language="eng") {
  if (!process.env.OCR_SPACE_API_KEY) throw new Error("Missing OCR_SPACE_API_KEY");
  const base64 = String(pdfDataUrl||"").split(",")[1] || "";
  if (!base64) throw new Error("Invalid pdfDataUrl (base64 missing)");
  const form = new URLSearchParams();
  form.append("base64Image", "data:application/pdf;base64," + base64);
  form.append("language", language.toLowerCase());
  form.append("filetype", "PDF");
  form.append("isOverlayRequired", "false");
  form.append("detectOrientation", "true");
  form.append("scale", "true");
  form.append("OCREngine", "2");

  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST", headers: { apikey: process.env.OCR_SPACE_API_KEY }, body: form
  });
  const j = await r.json().catch(() => null);
  if (!j || j.IsErroredOnProcessing) {
    const msg = j?.ErrorMessage || j?.ErrorDetails || "OCR error";
    throw new Error(Array.isArray(msg)? msg.join("; ") : String(msg));
  }
  const text = j?.ParsedResults?.[0]?.ParsedText || "";
  if (!text) throw new Error("OCR produced no text");
  return text;
}

async function webResearch(query, maxResults=5) {
  if (!process.env.TAVILY_API_KEY) return { query, results: [] };
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, search_depth:"advanced", max_results: maxResults })
  });
  const j = await r.json().catch(()=>null);
  const results = Array.isArray(j?.results) ? j.results.map(x => ({
    title: x.title, url: x.url, snippet: x.content?.slice(0,220) || ""
  })) : [];
  return { query, results };
}

async function quickChartPng(config) {
  // Use quickchart to render Chart.js PNG without native deps
  const url = "https://quickchart.io/chart";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ width: 800, height: 400, format: "png", version: "4", backgroundColor: "white", chart: config })
  });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!buf?.length) throw new Error("Chart render failed");
  return buf;
}

function buildBasicChartsFromAnalysis(analysis) {
  const charts = [];
  // Bar chart from keyMetrics (value)
  if (Array.isArray(analysis.keyMetrics) && analysis.keyMetrics.length) {
    const labels = analysis.keyMetrics.map(m => m.label ?? "");
    const data = analysis.keyMetrics.map(m => Number(m.value) || 0);
    charts.push({
      title: "Key Metrics",
      type: "bar",
      cfg: {
        type: "bar",
        data: { labels, datasets: [{ label: "Value", data }] },
        options: { responsive: true, plugins: { legend: { display: false }, title: { display: true, text: "Key Metrics" } } }
      }
    });
  }
  // Line chart from trends.kpis[0]
  const k0 = analysis?.trends?.kpis?.[0];
  if (k0 && Array.isArray(k0.points) && k0.points.length) {
    charts.push({
      title: k0.name || "Trend",
      type: "line",
      cfg: {
        type: "line",
        data: { labels: k0.points.map(p=>p.x), datasets: [{ label: k0.name || "Trend", data: k0.points.map(p=>Number(p.y)||0), fill:false }] },
        options: { responsive: true, plugins: { legend: { display: false }, title: { display: true, text: k0.name || "Trend" } } }
      }
    });
  }
  return charts;
}

async function analyzeWithOpenAI(text, researchPack) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const researchNote = researchPack?.results?.length
    ? `You have ${researchPack.results.length} external research items with titles, URLs, and snippets. Use them to fact-check critical claims. Cite with [n] that maps to Sources section.`
    : `No external research available. Answer based only on the provided document.`;

  const system = `You are a senior analyst. Output STRICT JSON only. Be accurate, concise, and professional.`;
  const user = `
DOCUMENT (first 50k chars):
---
${String(text).slice(0,50000)}
---

RESEARCH:
${JSON.stringify(researchPack || {results:[]}).slice(0,20000)}

Return JSON with:
- title: string
- executiveSummary: 120-180 words
- keyFindings: array of short bullet strings
- keyMetrics: array of {label, value, unit, note}
- riskScores: {financialStability, liquidity, concentrationRisk, compliance, growthOutlook} (1–5)
- trends: { narrative, kpis:[{name, points:[{x, y}]}] }
- sources: array of {title, url} (use research items you relied on; empty if none)
Guidelines: ${researchNote}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  const ct = r.headers.get("content-type") || "";
  const raw = await r.text();
  if (!r.ok) {
    try { const j = JSON.parse(raw); throw new Error(j?.error?.message || "OpenAI error"); }
    catch { throw new Error("OpenAI error: " + raw.slice(0,200)); }
  }
  if (!ct.includes("application/json")) throw new Error("OpenAI returned non-JSON content");
  const data = JSON.parse(raw);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Unexpected OpenAI response shape");
  try { return JSON.parse(content); } catch { throw new Error("OpenAI returned non-JSON content"); }
}

async function buildPdf(filename, analysis, chartPngs) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageW=612, pageH=792, M=56, line=14, h1=18, h2=14, body=11;
  const maxW = pageW - 2*M;
  let page = pdf.addPage([pageW,pageH]);
  let y = pageH - M;

  const drawText = (txt, size=body, f=font) => {
    const words = String(txt||"").replace(/\r/g,"").split(/\s+/);
    let current=""; 
    for (const w of words) {
      const t = current? current+" "+w : w;
      if (f.widthOfTextAtSize(t, size) <= maxW) current = t;
      else { page.drawText(current, {x:M,y, size, font:f}); y -= line; current = w; if (y < M+2*line) { page = pdf.addPage([pageW,pageH]); y = pageH - M; } }
    }
    if (current) { page.drawText(current, {x:M,y, size, font:f}); y -= line; }
  };
  const section = (title) => { page.drawText(title,{x:M,y, size:h1, font:bold}); y -= line*1.6; };

  // Title
  page.drawText(filename.replace(/_/g," "), {x:M, y, size: h1, font: bold}); y -= line*1.6;

  // Executive Summary
  section("Executive Summary");
  drawText(analysis.executiveSummary, body, font);

  // Key Findings
  if (Array.isArray(analysis.keyFindings) && analysis.keyFindings.length) {
    section("Key Findings");
    for (const fnd of analysis.keyFindings) { drawText("• "+fnd, body, font); }
  }

  // Charts
  if (chartPngs?.length) {
    section("Charts");
    for (const {title, png} of chartPngs) {
      // Title
      page.drawText(title, {x:M, y, size:h2, font:bold}); y -= line*1.2;
      // Image
      const img = await pdf.embedPng(png);
      const iw = img.width, ih = img.height;
      const targetW = Math.min(maxW, 520);
      const scale = targetW/iw;
      const targetH = ih*scale;
      if (y - targetH < M) { page = pdf.addPage([pageW,pageH]); y = pageH - M; }
      page.drawImage(img, { x:M, y: y - targetH, width: targetW, height: targetH });
      y -= targetH + line;
    }
  }

  // Sources
  if (Array.isArray(analysis.sources) && analysis.sources.length) {
    section("Sources");
    analysis.sources.forEach((s, i) => {
      drawText(`[${i+1}] ${s.title} — ${s.url}`, body, font);
    });
  }

  return await pdf.save();
}

// ========= Handler =========
export default async function handler(req, res) {
  try {
    cors(res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });

    const body = await readJson(req);
    const { text, pdfUrl, pdfDataUrl, research=false, filename="BizDoc_Summary", language="eng" } = body || {};

    // 1) Acquire document text
    let docText = "";
    if (text && typeof text === "string") {
      docText = text;
    } else if (pdfUrl && /^https?:\/\//i.test(pdfUrl)) {
      docText = await runOCRUrl(pdfUrl, language);
    } else if (pdfDataUrl && pdfDataUrl.startsWith("data:application/pdf;base64,")) {
      docText = await runOCRDataUrl(pdfDataUrl, language);
    } else {
      return res.status(400).json({ ok:false, error:"Provide 'text' OR 'pdfUrl' OR 'pdfDataUrl'." });
    }

    // 2) Optional web research pack
    const researchPack = research
      ? await webResearch(`Verify facts & context for: ${docText.slice(0,400)}`, 5)
      : { results: [] };

    // 3) OpenAI analysis (structured)
    const analysis = await analyzeWithOpenAI(docText, researchPack);

    // 4) Charts (bar/line) → QuickChart PNGs
    const chartDefs = buildBasicChartsFromAnalysis(analysis);
    const chartPngs = [];
    for (const c of chartDefs) {
      const png = await quickChartPng(c.cfg);
      chartPngs.push({ title: c.title, png });
    }

    // 5) Build & return PDF
    const bytes = await buildPdf(sanitize(filename), analysis, chartPngs);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitize(filename)}.pdf"`);
    return res.status(200).end(Buffer.from(bytes));
  } catch (e) {
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
