export const config = {
  api: { bodyParser: false, responseLimit: false },
};

import Busboy from 'busboy';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/* ---------- helpers ---------- */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    const files = [];
    busboy.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => files.push({
        fieldname: name,
        filename: info.filename,
        contentType: info.mimeType,
        buffer: Buffer.concat(chunks),
      }));
    });
    busboy.on('field', (n, v) => { fields[n] = v; });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files }));
    req.pipe(busboy);
  });
}

function isPDF(f) {
  return /pdf/i.test(f.contentType) || (f.filename || '').toLowerCase().endsWith('.pdf');
}

function getOCRKey() {
  return process.env.OCR_SPACE_KEY || process.env.OCRSPACE_API_KEY || '';
}

async function ocrWithOCRSpace(buffer, { language = 'eng' } = {}) {
  const apiKey = getOCRKey();
  if (!apiKey) throw new Error('Missing OCR_SPACE_KEY (or OCRSPACE_API_KEY) in production env');

  const form = new FormData();
  form.append('apikey', apiKey);
  form.append('language', language);
  form.append('isOverlayRequired', 'false');
  form.append('OCREngine', '2');
  form.append('scale', 'true');
  form.append('file', new Blob([buffer]), 'upload.pdf');

  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`OCR HTTP ${res.status}`);
  const json = await res.json();
  if (json?.IsErroredOnProcessing) throw new Error(`OCR error: ${json?.ErrorMessage || 'Unknown'}`);

  return (json?.ParsedResults || [])
    .map(r => r?.ParsedText || '')
    .join('\n')
    .trim();
}

async function analyzeWithOpenAI(text, originalFilename = 'document.pdf') {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY in production env');

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are a precise, structured business document analyst." },
      { role: "user", content:
`You are BizDoc. Analyze the OCR text and return a concise structured JSON:

Fields:
- title (string)
- executive_summary (string, <=120 words)
- key_findings (array of {label, detail})
- kpis (array of {name, value, unit?}) if present
- risk_flags (array of strings) if any
- suggestions (array of strings) if any
- source_filename (string)

OCR_TEXT_START
${text.slice(0, 45000)}
OCR_TEXT_END
Original file: ${originalFilename}`
      }
    ]
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`OpenAI HTTP ${res.status} ${t}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '{}';

  let analysis;
  try {
    const match = raw.match(/\{[\s\S]*\}$/m) || raw.match(/\{[\s\S]*?\}/m);
    analysis = JSON.parse(match ? match[0] : raw);
  } catch {
    analysis = {
      title: "BizDoc Analysis",
      executive_summary: raw.slice(0, 600),
      key_findings: [], kpis: [], risk_flags: [], suggestions: [],
      source_filename: originalFilename,
    };
  }

  // normalize
  analysis.title ||= "BizDoc Analysis";
  analysis.executive_summary ||= "Analysis generated from OCR text.";
  analysis.key_findings ||= [];
  analysis.kpis ||= [];
  analysis.risk_flags ||= [];
  analysis.suggestions ||= [];
  analysis.source_filename ||= originalFilename;
  return analysis;
}

async function renderPDF(analysis) {
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const margin = 50;
  let y = page.getHeight() - margin;

  const write = (text, size = 11, gap = 14) => {
    const maxWidth = page.getWidth() - margin * 2;
    const lines = font.splitTextIntoLines(text, { fontSize: size, maxWidth });
    for (const line of lines) {
      if (y < margin + 40) { page = pdf.addPage([595.28, 841.89]); y = page.getHeight() - margin; }
      page.drawText(line, { x: margin, y, size, font, color: rgb(0,0,0) });
      y -= gap;
    }
  };

  write(analysis.title, 18, 22);
  if (analysis.source_filename) write(`Source: ${analysis.source_filename}`, 9, 12);
  y -= 6;

  write('Executive Summary', 13, 16);
  write(analysis.executive_summary || '—', 11, 14); y -= 6;

  if (analysis.key_findings.length) {
    write('Key Findings', 13, 16);
    analysis.key_findings.forEach(k => write(`• ${k.label}: ${k.detail}`)); y -= 6;
  }
  if (analysis.kpis.length) {
    write('KPIs', 13, 16);
    analysis.kpis.forEach(k => write(`• ${k.name}: ${k.value}${k.unit ? ' ' + k.unit : ''}`)); y -= 6;
  }
  if (analysis.risk_flags.length) {
    write('Risk Flags', 13, 16);
    analysis.risk_flags.forEach(r => write(`• ${r}`)); y -= 6;
  }
  if (analysis.suggestions.length) {
    write('Suggestions', 13, 16);
    analysis.suggestions.forEach(s => write(`• ${s}`));
  }

  return Buffer.from(await pdf.save());
}

/* ---------- main ---------- */
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({ ok:false, error:'Method not allowed' }); }

    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('multipart/form-data')) {
      return res.status(400).json({ ok:false, error:'Upload a PDF via multipart/form-data' });
    }

    const { fields, files } = await parseMultipart(req);
    const file = files?.[0];
    const language = (fields.language || 'eng').trim();
    const outName = (fields.filename || 'BizDoc_Report').trim();

    if (!file) return res.status(400).json({ ok:false, error:'No file uploaded' });
    if (!isPDF(file)) return res.status(400).json({ ok:false, error:'Only PDF files are supported' });
    if (file.buffer.length > 5 * 1024 * 1024) return res.status(413).json({ ok:false, error:'File too large. Max 5 MB' });

    const ocrText = await ocrWithOCRSpace(file.buffer, { language });
    if (!ocrText) return res.status(422).json({ ok:false, error:'OCR returned no text' });

    const analysis = await analyzeWithOpenAI(ocrText, file.filename || 'upload.pdf');
    const pdfBuf = await renderPDF(analysis);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}.pdf"`);
    return res.status(200).send(pdfBuf);

  } catch (err) {
    console.error('upload-ocr-openai-download error:', err);
    return res.status(500).json({ ok:false, error: err.message || 'internal_error' });
  }
}
