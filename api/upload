export const config = { api: { bodyParser: false }, runtime: "nodejs" };
import formidable from "formidable";
import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";

// CORS
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
}

function looksPrintable(txt) {
  // crude heuristic: >90% printable
  const printables = (txt.match(/[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
  return printables / Math.max(1, txt.length) > 0.9;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

  const form = formidable({ multiples: false, maxFileSize: 20 * 1024 * 1024 }); // 20MB
  form.parse(req, async (err, fields, files) => {
    try {
      if (err) return res.status(400).json({ ok:false, error:String(err?.message||err) });
      const file = files.file || files.upload || Object.values(files)[0];
      if (!file) return res.status(400).json({ ok:false, error:"No file uploaded" });

      const filepath = Array.isArray(file) ? file[0].filepath : file.filepath;
      const origName = Array.isArray(file) ? file[0].originalFilename : file.originalFilename;
      const mimetype = Array.isArray(file) ? file[0].mimetype : file.mimetype;
      const ext = String(path.extname(origName || "") || "").toLowerCase();

      let detected = "unknown";
      let extracted = "";

      // Prefer MIME if present
      if (mimetype?.startsWith("text/")) {
        const txt = await fs.readFile(filepath, "utf-8");
        detected = mimetype;
        extracted = txt;
      }
      else if (ext === ".txt") {
        const txt = await fs.readFile(filepath, "utf-8");
        detected = "text/plain (by ext)";
        extracted = txt;
      }
      else if (
        mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        ext === ".docx"
      ) {
        const buf = await fs.readFile(filepath);
        const out = await mammoth.extractRawText({ buffer: buf });
        detected = "docx";
        extracted = out.value || "";
      }
      else if (mimetype === "application/pdf" || ext === ".pdf") {
        detected = "pdf";
        extracted = "[PDF uploaded; OCR not enabled in this endpoint]";
      }
      else {
        // No helpful MIME/ext → try read as UTF-8 and check printability
        try {
          const raw = await fs.readFile(filepath);
          let txt = "";
          try { txt = raw.toString("utf-8"); } catch { /* ignore */ }
          if (txt && looksPrintable(txt)) {
            detected = "text/plain (heuristic)";
            extracted = txt;
          } else {
            detected = mimetype || "binary/unknown";
            extracted = "[Unsupported type, treating as binary]";
          }
        } catch {
          detected = mimetype || "binary/unknown";
          extracted = "[Unsupported type, treating as binary]";
        }
      }

      return res.status(200).json({
        ok: true,
        detected,
        filename: (fields.filename || "bizdoc").toString(),
        title: (fields.title || "BizDoc Analysis").toString(),
        body: extracted.slice(0, 12000) // safety cap
      });
    } catch (e) {
      return res.status(500).json({ ok:false, error:String(e?.message||e) });
    }
  });
}
