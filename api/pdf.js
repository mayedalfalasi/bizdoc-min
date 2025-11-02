export const config = { runtime: "nodejs" };
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export default async function handler(req, res) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const text = "BizDoc — It works!";
  const size = 24;
  const { width, height } = page.getSize();
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (width - w) / 2, y: height - 150, size, font, color: rgb(0,0,0) });
  const bytes = await pdf.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="bizdoc.pdf"');
  res.status(200).send(Buffer.from(bytes));
}
