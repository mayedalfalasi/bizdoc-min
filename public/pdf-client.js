import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Generate a simple PDF using only built-in fonts (Helvetica).

 */
export async function generateClientPDF(data = {}) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 portrait
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const title = data.title || "BizDoc Mini Report";
  const body =
    data.body || "Generated with default Helvetica (no custom fonts).";

  const { width, height } = page.getSize();

  page.drawText(title, {
    x: 50,
    y: height - 80,
    size: 24,
    font: helvetica,
    color: rgb(0, 0, 0),
  });

  page.drawText(body, {
    x: 50,
    y: height - 120,
    size: 12,
    font: helvetica,
    color: rgb(0, 0, 0),
    lineHeight: 14,
    maxWidth: width - 100,
  });

  const bytes = await pdfDoc.save();
  return bytes; // Uint8Array
}
