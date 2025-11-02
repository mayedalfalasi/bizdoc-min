import { serpSearch } from "../utils/adapters/search-news.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { cors } from "../utils/cors.js";

export const config = { runtime: "nodejs", api: { bodyParser: false } };
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// -------------------- Utils --------------------
function readJson(req){
  return new Promise((resolve)=>{ let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ try{resolve(JSON.parse(b||"{}"))}catch{resolve({})} });});
}
const S = s=>String(s||"BizDoc_Summary").replace(/[^\w\-]+/g,"_").slice(0,64)||"BizDoc_Summary";
const isNum = (v)=> typeof v === "number" && isFinite(v);
const fmtInt = (v)=> isNum(v) ? new Intl.NumberFormat("en-US").format(v) : String(v ?? "");
const clamp = (v,min,max)=> Math.max(min, Math.min(max, v));

// -------------------- OCR --------------------
async function ocrUrl(url,lang="eng"){
  if(!process.env.OCR_SPACE_API_KEY) throw new Error("Missing OCR_SPACE_API_KEY");
  const form=new URLSearchParams();
  form.append("url",url); form.append("language",lang.toLowerCase());
  form.append("filetype","PDF"); form.append("isOverlayRequired","false");
  form.append("detectOrientation","true"); form.append("scale","true"); form.append("OCREngine","2");
  const r=await fetch("https://api.ocr.space/parse/image",{method:"POST",headers:{apikey:process.env.OCR_SPACE_API_KEY},body:form});
  const j=await r.json().catch(()=>null);
  if(!j || j.IsErroredOnProcessing) throw new Error(String(j?.ErrorMessage||j?.ErrorDetails||"OCR error"));
  const t=j?.ParsedResults?.[0]?.ParsedText || "";
  if(!t) throw new Error("OCR produced no text");
  return t;
}
async function ocrDataUrl(d,lang="eng"){
  if(!process.env.OCR_SPACE_API_KEY) throw new Error("Missing OCR_SPACE_API_KEY");
  const base64=String(d||"").split(",")[1]||"";
  if(!base64) throw new Error("Invalid pdfDataUrl");
  const form=new URLSearchParams();
  form.append("base64Image","data:application/pdf;base64,"+base64);
  form.append("language",lang.toLowerCase());
  form.append("filetype","PDF"); form.append("isOverlayRequired","false");
  form.append("detectOrientation","true"); form.append("scale","true"); form.append("OCREngine","2");
  const r=await fetch("https://api.ocr.space/parse/image",{method:"POST",headers:{apikey:process.env.OCR_SPACE_API_KEY},body:form});
  const j=await r.json().catch(()=>null);
  if(!j || j.IsErroredOnProcessing) throw new Error(String(j?.ErrorMessage||j?.ErrorDetails||"OCR error"));
  const t=j?.ParsedResults?.[0]?.ParsedText || "";
  if(!t) throw new Error("OCR produced no text");
  return t;
}

// -------------------- Research --------------------
async function research(query, maxResults=6){
  if(!process.env.TAVILY_API_KEY) return { query, results: [] };
  const r=await fetch("https://api.tavily.com/search",{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, search_depth:"advanced", max_results:maxResults })
  });
  const j=await r.json().catch(()=>null);
  const results = Array.isArray(j?.results) ? j.results.map(x=>({
    title: x.title, url: x.url, snippet: (x.content||"").slice(0,260)
  })) : [];
  return { query, results };
}

// -------------------- OpenAI --------------------
async function openaiJSON(messages, temperature=0.3){
  if(!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model: MODEL, temperature, response_format:{type:"json_object"}, messages })
  });
  const ct=r.headers.get("content-type")||""; const raw=await r.text();
  if(!r.ok){ try{ const j=JSON.parse(raw); throw new Error(j?.error?.message || "OpenAI error"); } catch{ throw new Error("OpenAI error: "+raw.slice(0,200)); } }
  if(!ct.includes("application/json")) throw new Error("OpenAI returned non-JSON content");
  const data=JSON.parse(raw); const content=data?.choices?.[0]?.message?.content;
  if(!content) throw new Error("Unexpected OpenAI response shape");
  try{ return JSON.parse(content); } catch{ throw new Error("OpenAI returned non-JSON content"); }
}

// Draft (pass 1)
async function draftPass(docText){
  const system = "You are a senior financial analyst. Output STRICT JSON only.";
  const user = `
DOCUMENT (first 50k):
---
${String(docText).slice(0,50000)}
---
Return JSON:
{
  "title": string,
  "executiveSummary": string,         // 120–180 words
  "keyFindings": string[],            // 6–10 crisp bullets
  "keyMetrics": [ { "label":string, "value":number, "unit":string, "note":string } ],
  "trends": { "narrative": string, "kpis": [ { "name":string, "points":[{"x":string,"y":number}] } ] },
  "risks": [ { "name":string, "level":"low|med|high", "rationale":string } ],
  "questions": string[]               // claims worth verifying
}`;
  return openaiJSON([{role:"system",content:system},{role:"user",content:user}]);
}

// Fact-check & refine (pass 2)
async function factCheckPass(docText, draft, researchPack){
  const system = "You are a rigorous fact-checker and editor. Output STRICT JSON only.";
  const user = `
DOCUMENT:
${String(docText).slice(0,50000)}

DRAFT:
${JSON.stringify(draft).slice(0,20000)}

RESEARCH:
${JSON.stringify(researchPack||{results:[]}).slice(0,20000)}

Goals:
1) Verify/correct key claims. Add inline citation numbers [n] that map to sources[].
2) Tighten writing; executive-ready tone.
3) Add riskScores and confidence.

Return JSON:
{
  "title": string,
  "executiveSummary": string, // include [n] citations where used
  "keyFindings": string[],
  "keyMetrics": [ { "label":string, "value":number, "unit":string, "note":string } ],
  "trends": { "narrative": string, "kpis": [ { "name":string, "points":[{"x":string,"y":number}] } ] },
  "riskScores": { "financialStability":1, "liquidity":1, "concentrationRisk":1, "compliance":1, "growthOutlook":1 },
  "sources": [ { "title":string, "url":string } ],
  "confidence": 0.0
}`;
  return openaiJSON([{role:"system",content:system},{role:"user",content:user}]);
}

// -------------------- Derived metrics & numeric QA --------------------
function normalizeUnit(u=""){
  const s=String(u).toLowerCase();
  if (s.includes("%")) return "%";
  if (/(aed|dirham|dhs|dh)/.test(s)) return "AED";
  if (/(usd|\$)/.test(s)) return "USD";
  return u || "";
}

function deriveMetrics(metrics){
  // Build a map for easy lookups (case-insensitive)
  const m = {};
  for (const x of (metrics||[])) {
    const key = String(x.label||"").toLowerCase();
    m[key] = x;
  }
  const out = [];

  const revenue = m["revenue"] || Object.values(m).find(v => /revenue/i.test(v.label||""));
  const grossProfit = m["gross profit"] || Object.values(m).find(v => /gross\s*profit/i.test(v.label||""));
  const operatingProfit = m["operating profit"] || Object.values(m).find(v => /(operating|op)\s*profit|ebit/i.test(v.label||""));
  const netProfit = m["net profit"] || Object.values(m).find(v => /net\s*(income|profit)/i.test(v.label||""));

  // Margins if we have base values
  if (revenue && isNum(revenue.value) && grossProfit && isNum(grossProfit.value) && revenue.value !== 0) {
    out.push({ label:"Gross Margin", value: (grossProfit.value / revenue.value), unit:"%", note:"Derived = Gross Profit / Revenue" });
  }
  if (revenue && isNum(revenue.value) && operatingProfit && isNum(operatingProfit.value) && revenue.value !== 0) {
    out.push({ label:"Operating Margin", value: (operatingProfit.value / revenue.value), unit:"%", note:"Derived = Operating Profit / Revenue" });
  }
  if (revenue && isNum(revenue.value) && netProfit && isNum(netProfit.value) && revenue.value !== 0) {
    out.push({ label:"Net Margin", value: (netProfit.value / revenue.value), unit:"%", note:"Derived = Net Profit / Revenue" });
  }
  return out;
}

// -------------------- Charts (labeled axes, percent/currency aware) --------------------
function makeCharts(a){
  const charts = [];

  // Key Metrics bar chart
  if (Array.isArray(a.keyMetrics) && a.keyMetrics.length){
    const labels = a.keyMetrics.map(m => m.label || "");
    const data = a.keyMetrics.map(m => Number(m.value) || 0);
    // Guess unit: if any metric uses % we'll show percent; else show "Value"
    const hasPercent = a.keyMetrics.some(m => String(m.unit||"").includes("%") || /margin/i.test(m.label||""));
    const yTitle = hasPercent ? "%" : "Value";
    const percentMode = hasPercent;

    charts.push({
      title: "Key Metrics",
      cfg: {
        type: "bar",
        data: { labels, datasets: [{ label: "Value", data }] },
        options: {
          plugins: { legend: { display: false }, title: { display: true, text: "Key Metrics" } },
          scales: {
            x: { ticks: { autoSkip: true, maxRotation: 0 } },
            y: {
              beginAtZero: true,
              ticks: {
                callback: (v) => {
                  try {
                    if (percentMode) return v + "%";
                    return new Intl.NumberFormat("en-US").format(v);
                  } catch { return String(v); }
                }
              },
              title: { display: true, text: yTitle }
            }
          }
        }
      }
    });
  }

  // First KPI line chart
  const k0 = a?.trends?.kpis?.[0];
  if (k0 && Array.isArray(k0.points) && k0.points.length){
    const percentLike = /margin|rate|%/i.test(k0.name || "");
    charts.push({
      title: k0.name || "Trend",
      cfg: {
        type: "line",
        data: {
          labels: k0.points.map(p=>p.x),
          datasets: [{ label: k0.name || "Trend", data: k0.points.map(p=>Number(p.y)||0), fill:false }]
        },
        options: {
          plugins: { legend: { display: false }, title: { display: true, text: k0.name || "Trend" } },
          scales: {
            x: { ticks: { autoSkip: true, maxRotation: 0 }, title: { display: true, text: "Period" } },
            y: {
              beginAtZero: true,
              ticks: {
                callback: (v) => {
                  try {
                    if (percentLike) return v + "%";
                    return new Intl.NumberFormat("en-US").format(v);
                  } catch { return String(v); }
                }
              },
              title: { display: true, text: percentLike ? "%" : "Value" }
            }
          }
        }
      }
    });
  }
  return charts;
}

async function quickChartPng(cfg){
  const r = await fetch("https://quickchart.io/chart", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ width: 900, height: 420, format: "png", version: "4", backgroundColor: "white", chart: cfg })
  });
  return new Uint8Array(await r.arrayBuffer());
}

// -------------------- PDF (header/footer, aligned tables, charts, citations) --------------------
async function buildPdf(filename, a, chartPngs){
  const pdf=await PDFDocument.create();
  const normal=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);

  const W=612, H=792, M=56, LINE=14, H1=18, H2=14, BODY=11, MAXW=W-2*M;
  let page=pdf.addPage([W,H]), y=H-M, pageNo=1;

  const wrap=(txt,size=BODY,font=normal)=>{
    const words=String(txt||"").replace(/\r/g,"").split(/\s+/);
    const out=[]; let line="";
    for(const w of words){
      const t=line?line+" "+w:w;
      if(font.widthOfTextAtSize(t,size)<=MAXW) line=t;
      else{ if(line) out.push(line); line=w; }
    }
    if(line) out.push(line);
    return out;
  };
  const header=()=>{
    page.drawText(filename.replace(/_/g," "),{x:M,y:H-M+22,size:10,font:bold});
    const d=new Date().toISOString().slice(0,10);
    page.drawText(d,{x:W-M-80,y:H-M+22,size:10,font:normal});
  };
  const footer=()=>{ page.drawText(`Page ${pageNo}`,{x:W-M-60,y:M-18,size:10,font:normal}); };
  const ensure=(rows=2)=>{ if(y < M + rows*LINE){ page=pdf.addPage([W,H]); y=H-M; pageNo++; header(); footer(); } };
  const line = ()=>{ ensure(2); page.drawLine({ start:{x:M,y:y-6}, end:{x:W-M,y:y-6}, thickness:1 }); y -= LINE; };
  const section=(title)=>{ ensure(3); page.drawText(title,{x:M,y,size:H1,font:bold}); y -= LINE*1.6; };
  const draw=(txt,size=BODY,font=normal)=>{ for(const L of wrap(txt,size,font)){ ensure(2); page.drawText(L,{x:M,y,size,font}); y-=LINE; } };

  // First header/footer
  header(); footer();

  // Title
  page.drawText(filename.replace(/_/g," "),{x:M,y,size:H1,font:bold}); y -= LINE*1.6;
  line();

  // Executive Summary
  section("Executive Summary");
  draw(a.executiveSummary || "");

  // Key Findings
  if (Array.isArray(a.keyFindings) && a.keyFindings.length){
    section("Key Findings");
    a.keyFindings.forEach(f=> draw("• " + f));
  }

  // Key Metrics table (+ Derived)
  const derived = deriveMetrics(a.keyMetrics || []);
  const allMetrics = [...(a.keyMetrics||[]), ...derived];
  if (allMetrics.length){
    section("Key Metrics");
    const labelX = M, valueX = M + 280, unitX = W - M - 80;
    for (const m of allMetrics){
      ensure(2);
      const unit = normalizeUnit(m.unit);
      let valTxt = fmtInt(m.value);
      if (unit === "%") valTxt = isNum(m.value) ? (m.value*100).toFixed(1) : String(m.value);
      page.drawText(String(m.label || "Metric"), { x: labelX, y, size: BODY, font: normal });
      page.drawText(valTxt, { x: valueX, y, size: BODY, font: bold });
      page.drawText(String(unit || ""), { x: unitX, y, size: BODY, font: normal });
      y -= LINE;
      if (m.note) draw("  – " + m.note);
    }
    line();
  }

  // Trends
  if (a?.trends?.narrative) {
    section("Trends");
    draw(a.trends.narrative);
  }

    // Merge Serp sources into refined.sources (dedupe by URL, fully guarded)
    try {
      refined = refined || {};
      refined.sources = Array.isArray(refined.sources) ? refined.sources : [];
      const extra = Array.isArray(serp?.results) ? serp.results.map(x => ({ title: x.title, url: x.url })) : [];
      const seen = new Set(refined.sources.map(s => s && s.url).filter(Boolean));
      for (const s of extra) {
        if (s && s.url && !seen.has(s.url)) { refined.sources.push(s); seen.add(s.url); }
      }
    } catch(_) {}
      const seen = new Set(refined.sources.map(s=>s.url));
      for (const s of serp.results) {
        if (s.url && !seen.has(s.url)) { refined.sources.push({ title: s.title, url: s.url }); seen.add(s.url); }
      }
    }

  // Charts
  if (Array.isArray(chartPngs) && chartPngs.length){
    section("Charts");
    for (const c of chartPngs){
      ensure(18);
      page.drawText(c.title, { x:M, y, size:H2, font: bold }); y -= LINE*1.2;
      const img = await pdf.embedPng(c.png);
      const iw=img.width, ih=img.height, TW=Math.min(MAXW,520), S=TW/iw, TH=ih*S;
      if (y - TH < M){ page=pdf.addPage([W,H]); y=H-M; pageNo++; header(); footer(); }
      page.drawImage(img,{ x:M, y:y-TH, width:TW, height:TH }); y -= TH + LINE;
    }
    line();
  }

  // Risk Scores
  if (a.riskScores && typeof a.riskScores === "object"){
    section("Risk Scores (1–5)");
    for (const [k,v] of Object.entries(a.riskScores)) draw(`• ${k}: ${v}`);
    line();
  }

  // Sources
  if (Array.isArray(a.sources) && a.sources.length){
    section("Sources");
    a.sources.forEach((s,i)=> draw(`[${i+1}] ${s.title} — ${s.url}`));
  }

  // Confidence (avoid 0%)
  if (typeof a.confidence === "number"){
    ensure(2);
    const pct = clamp(Math.round(a.confidence * 100), 5, 100);
    draw(`Confidence: ${pct}%`);
  }

  return await pdf.save();
}

// -------------------- Handler --------------------
export default async function handler(req,res){
  try{
    cors(res);
    if (req.method==="OPTIONS") return res.status(200).end();
    if (req.method!=="POST") return res.status(405).json({ok:false,error:"Use POST"});

    const { text, pdfUrl, pdfDataUrl, filename="BizDoc_Summary", language="eng" } = await readJson(req) || {};
    // Acquire text
    let docText="";
    if (typeof text === "string" && text.trim()) docText = text;
    else if (pdfUrl && /^https?:\/\//i.test(pdfUrl)) docText = await ocrUrl(pdfUrl, language);
    else if (pdfDataUrl && pdfDataUrl.startsWith("data:application/pdf;base64,")) docText = await ocrDataUrl(pdfDataUrl, language);
    else return res.status(400).json({ ok:false, error:"Provide 'text' OR 'pdfUrl' OR 'pdfDataUrl'." });

    // Always-on research
    const serp = await serpSearch(docText.slice(0,120), 6).catch(()=>({ok:false}));
    const rpack = await research(`Verify and benchmark key claims for: ${docText.slice(0,400)}`, 6);

    // Two-pass LLM
    const draft = await draftPass(docText);
    const refined = await factCheckPass(docText, draft, rpack);

    // Charts
    const defs = makeCharts(refined);
    const pngs = [];
    for (const d of defs) pngs.push({ title:d.title, png: await quickChartPng(d.cfg) });

    // Build PDF
    const bytes = await buildPdf(S(filename), refined, pngs);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${S(filename)}.pdf"`);
    return res.status(200).end(Buffer.from(bytes));
  } catch (e) {
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
