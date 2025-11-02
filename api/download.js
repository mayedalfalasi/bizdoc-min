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
    const test = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function analysisToText(analysis) {
  if (!analysis || typeof analysis !== "object") return "No analysis provided.";
  const parts = [];

  if (analysis.executiveSummary) {
    parts.push("Executive Summary:");
    parts.push(analysis.executiveSummary);
    parts.push("");
  }

  if (Array.isArray(analysis.keyMetrics) && analysis.keyMetrics.length) {
    parts.push("Key Metrics:");
    for (const m of analysis.keyMetrics) {
      parts.push(`• ${m.label ?? "Metric"}: ${m.value ?? ""} ${m.unit ?? ""} ${m.note ? `— ${m.note}` : ""}`.trim());
    }
    parts.push("");
  }

  if (analysis.riskScores && typeof analysis.riskScores === "object") {
    parts.push("Risk Scores (1–5):");
    for (const [k,v] of Object.entries(analysis.riskScores)) {
      parts.push(`• ${k}: ${v}`);
    }
    parts.push("");
  }

  if (Array.isArray(analysis.opportunities) && analysis.opportunities.length) {
    parts.push("Opportunities:");
    for (const o of analysis.opportunities) parts.push(`• ${o}`);
    parts.push("");
  }

  if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
    parts.push("Recommendations:");
    for (const r of analysis.recommendations) parts.push(`• ${r.title ?? "Item"} — ${r.detail ?? ""}`);
    parts.push("");
  }

  if (analysis.trends && analysis.trends.narrative) {
    parts.push("Trends:");
    parts.push(analysis.trends.narrative);
    parts.push("");
  }

  return parts.join("\n").trim() || "No analysis fields found.";
}

export default async function handler(req, res) {
  try {
    cors(res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });

    const body = await readJson(req);
    const { type = "pdf", filename = "BizDoc_Report", analysis } = body || {};
    if (type !== "pdf") return res.status(400).json({ ok:false, error:"Only type='pdf' is supported" });
    if (!analysis || typeof analysis !== "object") {
      return res.status(400).json({ ok:false, error:"Provide 'analysis' object from /api/analyze" });
    }

    // Create PDF
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const titleFont = await pdf.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;  // Letter
    const pageHeight = 792;
    const margin = 56;
    const bodySize = 11;
    const titleSize = 16;
    const maxWidth = pageWidth - margin*2;

    let page = pdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    // Title
    const title = sanitize(filename).replace(/_/g, " ");
    page.drawText(title, { x: margin, y, size: titleSize, font: titleFont });
    y -= titleSize + 10;

    // Body from analysis
    const text = analysisToText(analysis);
    const lines = wrapText(font, text, bodySize, maxWidth);

    for (const line of lines) {
      if (y < margin + bodySize + 4) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      page.drawText(line, { x: margin, y, size: bodySize, font });
      y -= bodySize + 4;
    }

    const bytes = await pdf.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitize(filename)}.pdf"`);
    return res.status(200).end(Buffer.from(bytes));
  } catch (e) {
    // Always return JSON on error (so clients can see why)
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
