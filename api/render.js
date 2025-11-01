// api/render.js
export const config = { runtime: "nodejs" };

import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const { content, format, filename = "bizdoc-analysis" } = await readJson(req);
    if (!content || typeof content !== "string" || content.trim().length < 2) {
      return res.status(400).json({ ok: false, error: "Missing content" });
    }
    if (!["pdf", "docx"].includes(format)) {
      return res.status(400).json({ ok: false, error: "format must be 'pdf' or 'docx'" });
    }

    if (format === "pdf") {
      const bytes = await makePdf(content);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitize(filename)}.pdf"`);
      return res.status(200).end(Buffer.from(bytes));
    } else {
      const bytes = await makeDocx(content);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${sanitize(filename)}.docx"`);
      return res.status(200).end(Buffer.from(bytes));
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e?.message || "render error" });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); }
    });
  });
}

function sanitize(name) {
  return String(name).replace(/[^\w\-]+/g, "_").slice(0, 64) || "bizdoc-analysis";
}

// -------- PDF ----------
async function makePdf(text) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const margin = 56; // 0.78"
  const pageWidth = 612;  // US Letter width (pt)
  const pageHeight = 792; // US Letter height (pt)
  const maxWidth = pageWidth - margin * 2;
  let page = pdf.addPage([pageWidth, pageHeight]);

  // Title
  let y = pageHeight - margin;
  const title = "BizDoc — Analysis";
  page.drawText(title, { x: margin, y, size: 16, font, });
  y -= 26;

  // Wrap body
  const lines = wrapText(text.replace(/\r/g, ""), font, fontSize, maxWidth);
  for (const line of lines) {
    if (y < margin + 20) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    page.drawText(line, { x: margin, y, size: fontSize, font });
    y -= fontSize + 4;
  }

  return await pdf.save();
}

function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.flatMap(l => l.split("\n")); // keep manual breaks too
}

// -------- DOCX ----------
async function makeDocx(text) {
  const heading = new Paragraph({
    text: "BizDoc — Analysis",
    heading: HeadingLevel.HEADING_2,
    spacing: { after: 240 }
  });

  const paragraphs = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) =>
      new Paragraph({
        children: [new TextRun({ text: line || " ", size: 24 })],
        spacing: { after: 120 }
      })
    );

  const doc = new Document({
    sections: [{ properties: {}, children: [heading, ...paragraphs] }]
  });

  return await Packer.toBuffer(doc);
}
