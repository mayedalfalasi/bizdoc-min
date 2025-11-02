import { PDFDocument, StandardFonts } from "pdf-lib";
import { cors } from "../utils/cors.js";

export const config = { runtime: "nodejs", api: { bodyParser: false } };

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}

function sanitize(name) {
  return String(name || "BizDoc_Report").replace(/[^\w\-]+/g, "_").slice(0, 64) || "BizDoc_Report";
}

function wrapText(font, text, size, maxWidth) {
  const words = String(text || "").replace(/\r/g, "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(t, size) <= maxWidth) line = t;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function analysisToText(analysis) {
  if (!analysis || typeof analysis !== "object") return "No analysis provided.";
  const parts = [];
  if (analysis.executiveSummary) { parts.push("Executive Summary:", analysis.executiveSummary, ""); }
  if (Array.isArray(analysis.keyMetrics) && analysis.keyMetrics.length) {
    parts.push("Key Metrics:");
    for (const m of analysis.keyMetrics) parts.push(`• ${m.label ?? "Metric"}: ${m.value ?? ""} ${m.unit ?? ""} ${m.note ? "— "+m.note : ""}`.trim());
    parts.push("");
  }
  if (analysis.riskScores && typeof analysis.riskScores === "object") {
    parts.push("Risk Scores (1–5):");
    for (const [k,v] of Object.entries(analysis.riskScores)) parts.push(`• ${k}: ${v}`);
    parts.push("");
  }
  if (Array.isArray(analysis.opportunities) && analysis.opportunities.length) {
    parts.push("Opportunities:"); for (const o of analysis.opportunities) parts.push(`• ${o}`); parts.push("");
  }
  if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
    parts.push("Recommendations:"); for (const r of analysis.recommendations) parts.push(`• ${r.title ?? "Item"} — ${r.detail ?? ""}`); parts.push("");
  }
  if (analysis.trends?.narrative) { parts.push("Trends:", analysis.trends.narrative, ""); }
  return parts.join("\n").trim() || "No analysis fields found.";
}

async function runOCR(url, language) {
  if (!process.env.OCR_SPACE_API_KEY) throw new Error("Missing OCR_SPACE_API_KEY");
  const form = new URLSearchParams();
  form.append("url", url);
  form.append("language", (language || "eng").toLowerCase()); // OCR.space expects single code
  form.append("filetype", "PDF");
  form.append("isOverlayRequired", "false");
  form.append("detectOrientation", "true");
  form.append("scale", "true");
  form.append("OCREngine", "2");

  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: process.env.OCR_SPACE_API_KEY },
    body: form
  });
  const data = await r.json().catch(() => null);
  if (!data || data.IsErroredOnProcessing) {
    const msg = data?.ErrorMessage || data?.ErrorDetails || "OCR processing error";
    throw new Error(Array.isArray(msg) ? msg.join("; ") : String(msg));
  }
  const text = data?.ParsedResults?.[0]?.ParsedText || "";
  if (!text) throw new Error("No text returned from OCR");
  return text;
}

async function analyzeText(text, meta) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const prompt = `
You are a senior financial/business analyst. Return a STRICT JSON object with:
- executiveSummary (120–180 words)
- keyMetrics: array of {label,value,unit,note}
- riskScores: {financialStability, liquidity, concentrationRisk, compliance, growthOutlook} (1–5)
- opportunities: 3 bullets
- recommendations: 3 {title,detail}
- entities {companies, investors, regulators, people}
- dates: []
- amounts: []
- trends { narrative, kpis:[{name:"Revenue", points:[{x:"Q1",y:number}]}] }

Analyze:
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
      response_format: { type: "json_object" }
    })
  });

  const ct = resp.headers.get("content-type") || "";
  const raw = await resp.text();
  if (!resp.ok) {
    try { const j = JSON.parse(raw); throw new Error(j?.error?.message || "OpenAI error"); }
    catch { throw new Error("OpenAI error: " + raw.slice(0,200)); }
  }
  if (!ct.includes("application/json")) throw new Error("OpenAI returned non-JSON content");
  let data; try { data = JSON.parse(raw); } catch (e) { throw new Error("OpenAI JSON parse error: " + e?.message); }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Unexpected OpenAI response");
  try { return JSON.parse(content); } catch { throw new Error("OpenAI returned non-JSON content"); }
}

async function buildPdf(filename, analysis) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612, pageHeight = 792, margin = 56, bodySize = 11, titleSize = 16;
  const maxWidth = pageWidth - margin*2;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const title = sanitize(filename).replace(/_/g, " ");
  page.drawText(title, { x: margin, y, size: titleSize, font: bold });
  y -= titleSize + 10;

  const text = analysisToText(analysis);
  const lines = wrapText(font, text, bodySize, maxWidth);
  for (const line of lines) {
    if (y < margin + bodySize + 4) { page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
    page.drawText(line, { x: margin, y, size: bodySize, font });
    y -= bodySize + 4;
  }
  return await pdf.save();
}

export default async function handler(req, res) {
  try {
    cors(res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });

    const body = await readJson(req);
    const { url, language = "eng", filename = "BizDoc_Pipeline" } = body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ ok:false, error:"Provide a valid 'url' to a PDF" });

    // 1) OCR
    const text = await runOCR(url, language);

    // 2) Analyze
    const analysis = await analyzeText(text, { source: url });

    // 3) PDF
    const bytes = await buildPdf(filename, analysis);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitize(filename)}.pdf"`);
    return res.status(200).end(Buffer.from(bytes));
  } catch (e) {
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
