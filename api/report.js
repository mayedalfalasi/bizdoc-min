// api/report.js
export const config = { runtime: "nodejs" };
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function addWrappedText(page, text, x, y, maxWidth, font, size, leading=1.2) {
  const words = text.split(/\s+/);
  let line = "", lines = [];
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth) {
      if (line) lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  let yy = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: yy, size, font, color: rgb(0,0,0) });
    yy -= size * leading;
  }
  return yy;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST (application/json)" });
    const body = await new Promise((r) => {
      let data = ""; req.on("data", c => data += c); req.on("end", () => r(data));
    });
    const { command, parsed, title = "BizDoc Analysis" } = JSON.parse(body || "{}");
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595.28, 841.89]); // A4
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    let x = 50, y = 790;

    page.drawText(title, { x, y, size: 20, font: bold }); y -= 28;
    page.drawText(`Command: ${command || "custom"}`, { x, y, size: 11, font }); y -= 18;

    const asPretty = JSON.stringify(parsed, null, 2);
    y = addWrappedText(page, asPretty, x, y, 495, font, 10, 1.25);

    const bytes = await pdf.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="bizdoc-report.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(bytes));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "REPORT_FAILED" });
  }
}
