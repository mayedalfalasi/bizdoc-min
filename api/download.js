import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { cors } from "../utils/cors.js";

function wrapText(text, maxChars = 95) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = (line ? line + " " : "") + w;
    if (t.length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines;
}

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

async function callAnalyze(body, req) {
  const origin = (req.headers["x-forwarded-proto"] && req.headers["x-forwarded-host"])
    ? `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"]}`
    : "";
  const url = origin ? `${origin}/api/analyze` : "/api/analyze";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ text: body.text, meta: body.meta || {} })
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error(j?.error || "Analyze failed");
  return j;
}

async function ensureOpenAIAnalysis(body, req) {
  if (body.analysis && typeof body.analysis === "object") {
    if (body.analysis.model !== "openai" || (body.analysis.confidence || 0) < 0.8) {
      throw new Error("LLM-only mode: analysis must be from OpenAI (confidence ≥ 0.8).");
    }
    return body.analysis;
  }
  if (!body.text) {
    throw new Error("Provide { text } or { analysis } with model='openai'.");
  }
  const a = await callAnalyze(body, req);
  if (a.model !== "openai" || (a.confidence || 0) < 0.8) {
    throw new Error("LLM-only mode: analysis must be from OpenAI (confidence ≥ 0.8).");
  }
  return a;
}

function drawHeader(page, font, title) {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 40, y: height - 80, width: width - 80, height: 50, color: rgb(0.95,0.97,1) });
  page.drawText("BizDoc Intelligence Report", { x: 55, y: height - 52, size: 18, font, color: rgb(0.1,0.1,0.18) });
  page.drawText(title || "Automated Document Analysis", { x: 55, y: height - 72, size: 11, font, color: rgb(0.3,0.3,0.4) });
  // Fixed badge: OpenAI only
  page.drawText("Model: OpenAI (LLM enabled)", { x: width - 230, y: height - 52, size: 9, font, color: rgb(0.25,0.45,0.9) });
}

function drawSectionTitle(page, font, text, y) {
  page.drawText(text, { x: 55, y, size: 12, font, color: rgb(0.1,0.1,0.18) });
  page.drawLine({ start: {x:55, y: y-3}, end: {x:555, y: y-3}, thickness: 1, color: rgb(0.85,0.88,0.95) });
  return y - 18;
}

function drawParagraph(page, font, text, y, size=10, leading=14) {
  const lines = wrapText(text, 95);
  let yy = y;
  for (const ln of lines) {
    page.drawText(ln, { x: 55, y: yy, size, font, color: rgb(0.15,0.15,0.17) });
    yy -= leading;
  }
  return yy - 6;
}

function drawKeyMetricsTable(page, font, metrics, y) {
  let yy = y;
  const header = ["Metric", "Value", "Unit", "Note"];
  const rows = (metrics || []).map(m => [m.label, (m.value ?? "—").toString(), m.unit || "", m.note || ""]);
  const x0 = 55, x1 = 220, x2 = 340, x3 = 400, x4 = 555;
  const rowH = 16;
  page.drawRectangle({ x: x0-5, y: yy-4, width: (x4-x0)+5, height: 20, color: rgb(0.95,0.95,0.98) });
  page.drawText(header[0], { x:x0, y: yy, size:10, font });
  page.drawText(header[1], { x:x1, y: yy, size:10, font });
  page.drawText(header[2], { x:x2, y: yy, size:10, font });
  page.drawText(header[3], { x:x3, y: yy, size:10, font });
  yy -= rowH;
  for (const r of rows) {
    page.drawText(r[0], { x:x0, y: yy, size:10, font });
    page.drawText(r[1], { x:x1, y: yy, size:10, font });
    page.drawText(r[2], { x:x2, y: yy, size:10, font });
    page.drawText(r[3], { x:x3, y: yy, size:10, font, color: rgb(0.25,0.25,0.35) });
    yy -= rowH;
  }
  return yy - 6;
}

function drawBullets(page, font, arr, y, size=10, leading=14) {
  let yy = y;
  for (const item of arr || []) {
    const text = typeof item === "string" ? item : (item.title ? `${item.title}: ${item.detail || ""}` : JSON.stringify(item));
    const lines = wrapText(text, 90);
    page.drawText("•", { x: 55, y: yy, size, font });
    page.drawText(lines[0], { x: 70, y: yy, size, font });
    yy -= leading;
    for (const extra of lines.slice(1)) {
      page.drawText(extra, { x: 70, y: yy, size, font });
      yy -= leading;
    }
  }
  return yy - 4;
}

function drawRiskBars(page, font, scores, y) {
  const items = [
    ["Financial Stability", scores.financialStability],
    ["Liquidity", scores.liquidity],
    ["Concentration Risk", scores.concentrationRisk],
    ["Compliance", scores.compliance],
    ["Growth Outlook", scores.growthOutlook],
  ];
  let yy = y;
  const x0 = 55, xBar = 220, barW = 300, barH = 10;
  for (const [label, valRaw] of items) {
    const val = Math.max(1, Math.min(5, Number(valRaw || 0)));
    page.drawText(label, { x: x0, y: yy, size:10, font });
    page.drawRectangle({ x: xBar, y: yy-2, width: barW, height: barH, color: rgb(0.95,0.95,0.95) });
    const w = (val/5) * barW;
    page.drawRectangle({ x: xBar, y: yy-2, width: w, height: barH, color: rgb(0.25,0.45,0.9) });
    page.drawText(String(val), { x: xBar + barW + 8, y: yy, size:10, font, color: rgb(0.15,0.2,0.3) });
    yy -= 18;
  }
  return yy - 2;
}

function drawFooter(page, font, analysis) {
  page.drawLine({ start:{x:55,y:50}, end:{x:555,y:50}, thickness: 1, color: rgb(0.9,0.9,0.95) });
  const ts = new Date(analysis.generatedAt || Date.now()).toISOString();
  page.drawText(`Generated by BizDoc AI • ${ts} • v${analysis.version || "-"}`, { x: 55, y: 35, size: 9, font, color: rgb(0.35,0.35,0.45) });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  try {
    const body = await readJson(req);
    const analysis = await ensureOpenAIAnalysis(body, req); // <- require OpenAI

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage([612, 792]);
    let y = 742;

    drawHeader(page, font, analysis?.input?.meta?.title || "Document");

    y = drawSectionTitle(page, font, "Executive Summary", 680);
    y = drawParagraph(page, font, analysis.executiveSummary || "No summary.", y);

    y = drawSectionTitle(page, font, "Key Metrics", y);
    y = drawKeyMetricsTable(page, font, analysis.keyMetrics || [], y - 4);

    y = drawSectionTitle(page, font, "Entities", y);
    const ents = analysis.entities || {};
    const entsText = [
      `Companies: ${(ents.companies||[]).join(", ") || "—"}`,
      `Investors: ${(ents.investors||[]).join(", ") || "—"}`,
      `Regulators: ${(ents.regulators||[]).join(", ") || "—"}`,
      `People: ${(ents.people||[]).join(", ") || "—"}`
    ].join("  |  ");
    y = drawParagraph(page, font, entsText, y);

    y = drawSectionTitle(page, font, "Risk & Outlook (1=Low, 5=High)", y);
    y = drawRiskBars(page, font, analysis.riskScores || {}, y - 2);

    y = drawSectionTitle(page, font, "Trends", y);
    y = drawParagraph(page, font, analysis.trends?.narrative || "—", y);

    y = drawSectionTitle(page, font, "Recommendations", y);
    y = drawBullets(page, font, analysis.recommendations || [], y);

    drawFooter(page, font, analysis);

    const bytes = await pdfDoc.save();
    const filename = (body.filename || "BizDoc_Report") + ".pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(Buffer.from(bytes));
  } catch (err) {
    res.status(424).json({ ok:false, error: String(err?.message || err), needsOpenAI: true });
  }
}

export const config = { runtime: "nodejs", api: { bodyParser: false } } } };
