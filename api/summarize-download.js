import { PDFDocument, StandardFonts } from "pdf-lib";
import { cors } from "../utils/cors.js";
export const config = { runtime: "nodejs", api: { bodyParser: false } };
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function readJson(req){ return new Promise(r=>{ let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ try{r(JSON.parse(b||"{}"))}catch{r({})} });}); }
const S = s=>String(s||"BizDoc_Summary").replace(/[^\w\-]+/g,"_").slice(0,64)||"BizDoc_Summary";

async function ocrUrl(url,lang="eng"){ const f=new URLSearchParams();
  if(!process.env.OCR_SPACE_API_KEY) throw new Error("Missing OCR_SPACE_API_KEY");
  f.append("url",url); f.append("language",lang.toLowerCase()); f.append("filetype","PDF");
  f.append("isOverlayRequired","false"); f.append("detectOrientation","true"); f.append("scale","true"); f.append("OCREngine","2");
  const r=await fetch("https://api.ocr.space/parse/image",{method:"POST",headers:{apikey:process.env.OCR_SPACE_API_KEY},body:f});
  const j=await r.json().catch(()=>null); if(!j||j.IsErroredOnProcessing) throw new Error(String(j?.ErrorMessage||j?.ErrorDetails||"OCR error"));
  const t=j?.ParsedResults?.[0]?.ParsedText||""; if(!t) throw new Error("OCR produced no text"); return t;
}
async function ocrDataUrl(d,lang="eng"){ const f=new URLSearchParams(); const b=String(d||"").split(",")[1]||"";
  if(!process.env.OCR_SPACE_API_KEY) throw new Error("Missing OCR_SPACE_API_KEY");
  if(!b) throw new Error("Invalid pdfDataUrl");
  f.append("base64Image","data:application/pdf;base64,"+b); f.append("language",lang.toLowerCase()); f.append("filetype","PDF");
  f.append("isOverlayRequired","false"); f.append("detectOrientation","true"); f.append("scale","true"); f.append("OCREngine","2");
  const r=await fetch("https://api.ocr.space/parse/image",{method:"POST",headers:{apikey:process.env.OCR_SPACE_API_KEY},body:f});
  const j=await r.json().catch(()=>null); if(!j||j.IsErroredOnProcessing) throw new Error(String(j?.ErrorMessage||j?.ErrorDetails||"OCR error"));
  const t=j?.ParsedResults?.[0]?.ParsedText||""; if(!t) throw new Error("OCR produced no text"); return t;
}
async function research(q,maxResults=6){
  if(!process.env.TAVILY_API_KEY) return {query:q,results:[]};
  const r=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.TAVILY_API_KEY}`},body:JSON.stringify({query:q,search_depth:"advanced",max_results:maxResults})});
  const j=await r.json().catch(()=>null); const res=Array.isArray(j?.results)? j.results.map(x=>({title:x.title,url:x.url,snippet:(x.content||"").slice(0,260)})):[];
  return {query:q,results:res};
}
async function openai(messages,temperature=0.3){
  if(!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,temperature,response_format:{type:"json_object"},messages})});
  const ct=r.headers.get("content-type")||""; const raw=await r.text(); if(!r.ok){try{const j=JSON.parse(raw); throw new Error(j?.error?.message||"OpenAI error");}catch{throw new Error("OpenAI error: "+raw.slice(0,200));}}
  if(!ct.includes("application/json")) throw new Error("OpenAI returned non-JSON content");
  const data=JSON.parse(raw); const content=data?.choices?.[0]?.message?.content; if(!content) throw new Error("Unexpected OpenAI shape");
  try{ return JSON.parse(content);}catch{ throw new Error("OpenAI returned non-JSON content");}
}
function wrap(font,text,size,maxW){ const words=String(text||"").replace(/\r/g,"").split(/\s+/); const out=[]; let line=""; for(const w of words){ const t=line?line+" "+w:w; if(font.widthOfTextAtSize(t,size)<=maxW) line=t; else{ if(line) out.push(line); line=w; } } if(line) out.push(line); return out; }
async function chartPng(cfg){ const r=await fetch("https://quickchart.io/chart",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({width:900,height:420,format:"png",version:"4",backgroundColor:"white",chart:cfg})}); return new Uint8Array(await r.arrayBuffer()); }

function calcRatiosFromDocText(t){ // naive heuristics if numbers exist; kept simple to avoid heavy parsing
  // You can later replace with proper table extraction
  return []; // placeholder; the LLM pass will supply structured metrics anyway
}

function makeCharts(a){
  const charts=[];
  if(Array.isArray(a.keyMetrics)&&a.keyMetrics.length){
    charts.push({title:"Key Metrics", cfg:{type:"bar", data:{labels:a.keyMetrics.map(m=>m.label||""), datasets:[{label:"Value", data:a.keyMetrics.map(m=>Number(m.value)||0)}]}, options:{plugins:{legend:{display:false},title:{display:true,text:"Key Metrics"}}}}});
  }
  const k0=a?.trends?.kpis?.[0]; if(k0?.points?.length){ charts.push({title:k0.name||"Trend", cfg:{type:"line", data:{labels:k0.points.map(p=>p.x), datasets:[{label:k0.name||"Trend", data:k0.points.map(p=>Number(p.y)||0), fill:false}]}, options:{plugins:{legend:{display:false},title:{display:true,text:k0.name||"Trend"}}}}}); }
  return charts;
}

async function draftPass(docText){
  const system="You are a senior financial analyst. Output STRICT JSON only.";
  const user=`DOCUMENT (first 50k):
---
${String(docText).slice(0,50000)}
---
Return JSON:
{"title":string,"executiveSummary":string,"keyFindings":string[],"keyMetrics":[{"label":string,"value":number,"unit":string,"note":string}],"trends":{"narrative":string,"kpis":[{"name":string,"points":[{"x":string,"y":number}]}]},"risks":[{"name":string,"level":"low|med|high","rationale":string}],"questions":string[]}`;
  return openai([{role:"system",content:system},{role:"user",content:user}]);
}
async function factCheckPass(docText,draft,researchPack){
  const system="You are a rigorous fact-checker and editor. Output STRICT JSON only.";
  const user=`DOCUMENT:
${String(docText).slice(0,50000)}
DRAFT:
${JSON.stringify(draft).slice(0,20000)}
RESEARCH:
${JSON.stringify(researchPack||{results:[]}).slice(0,20000)}
Goal: verify/correct, add [n] inline citations mapped to sources[], tighten writing, add riskScores and confidence.
Return JSON:
{"title":string,"executiveSummary":string,"keyFindings":string[],"keyMetrics":[{"label":string,"value":number,"unit":string,"note":string}],"trends":{"narrative":string,"kpis":[{"name":string,"points":[{"x":string,"y":number}]}]},"riskScores":{"financialStability":1,"liquidity":1,"concentrationRisk":1,"compliance":1,"growthOutlook":1},"sources":[{"title":string,"url":string}],"confidence":0.0}`;
  return openai([{role:"system",content:system},{role:"user",content:user}]);
}

async function buildPdf(filename,a,chartPngs){
  const pdf=await PDFDocument.create(); const normal=await pdf.embedFont(StandardFonts.Helvetica); const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const W=612,H=792,M=56; const line=14,h1=18,h2=14,body=11; const maxW=W-2*M; let page=pdf.addPage([W,H]); let y=H-M;
  const draw=t=>{ for(const L of wrap(normal,t,body,maxW)){ if(y<M+line*2){ page=pdf.addPage([W,H]); y=H-M; } page.drawText(L,{x:M,y,size:body,font:normal}); y-=line; } };
  const section=title=>{ if(y<M+line*3){ page=pdf.addPage([W,H]); y=H-M; } page.drawText(title,{x:M,y,size:h1,font:bold}); y-=line*1.6; };
  page.drawText(filename.replace(/_/g," "),{x:M,y,size:h1,font:bold}); y-=line*1.6;
  section("Executive Summary"); draw(a.executiveSummary||"");
  if(Array.isArray(a.keyFindings)&&a.keyFindings.length){ section("Key Findings"); a.keyFindings.forEach(f=>draw("• "+f)); }
  if(Array.isArray(a.keyMetrics)&&a.keyMetrics.length){ section("Key Metrics"); a.keyMetrics.forEach(m=>draw(`${m.label||"Metric"}: ${m.value??""} ${m.unit??""}${m.note? " — "+m.note:""}`)); }
  if(a?.trends?.narrative){ section("Trends"); draw(a.trends.narrative); }
  if(chartPngs?.length){ section("Charts"); for(const c of chartPngs){ page.drawText(c.title,{x:M,y,size:h2,font:bold}); y-=line*1.2; const img=await pdf.embedPng(c.png); const iw=img.width, ih=img.height; const tw=Math.min(maxW,520); const s=tw/iw; const th=ih*s; if(y-th<M){ page=pdf.addPage([W,H]); y=H-M; } page.drawImage(img,{x:M,y:y-th,width:tw,height:th}); y-=th+line; } }
  if(a?.riskScores && typeof a.riskScores==="object"){ section("Risk Scores (1–5)"); for(const [k,v] of Object.entries(a.riskScores)) draw(`• ${k}: ${v}`); }
  if(Array.isArray(a.sources)&&a.sources.length){ section("Sources"); a.sources.forEach((s,i)=>draw(`[${i+1}] ${s.title} — ${s.url}`)); }
  if(typeof a.confidence==="number"){ if(y<M+line*2){ page=pdf.addPage([W,H]); y=H-M; } y-=line; page.drawText(`Confidence: ${Math.round(a.confidence*100)}%`,{x:M,y,size:body,font:normal}); y-=line; }
  return await pdf.save();
}

export default async function handler(req,res){
  try{
    cors(res); if(req.method==="OPTIONS") return res.status(200).end();
    if(req.method!=="POST") return res.status(405).json({ok:false,error:"Use POST"});
    const { text, pdfUrl, pdfDataUrl, filename="BizDoc_Summary", language="eng" } = await readJson(req) || {};
    let docText=""; 
    if(typeof text==="string"&&text.trim()) docText=text;
    else if(pdfUrl && /^https?:\/\//i.test(pdfUrl)) docText=await ocrUrl(pdfUrl,language);
    else if(pdfDataUrl && pdfDataUrl.startsWith("data:application/pdf;base64,")) docText=await ocrDataUrl(pdfDataUrl,language);
    else return res.status(400).json({ok:false,error:"Provide 'text' OR 'pdfUrl' OR 'pdfDataUrl'."});

    // ALWAYS-ON research (no checkbox)
    const rpack = await research(`Verify and benchmark key claims and industry context for: ${docText.slice(0,400)}`, 6);

    // Two-pass LLM
    const draft = await draftPass(docText);
    const refined = await factCheckPass(docText, draft, rpack);

    // Charts
    const defs = makeCharts(refined);
    const pngs = []; for(const d of defs){ pngs.push({title:d.title, png: await chartPng(d.cfg)}); }

    // PDF
    const bytes = await buildPdf(S(filename), refined, pngs);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${S(filename)}.pdf"`);
    return res.status(200).end(Buffer.from(bytes));
  }catch(e){
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
