export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = req.body || {};
    const inputUrl = body.url;
    const language = (body.language || (Array.isArray(body.languages) ? body.languages[0] : "") || "eng").toLowerCase();

    if (!inputUrl || !/^https?:\/\//i.test(inputUrl)) {
      return res.status(400).json({ ok:false, error:"Invalid or missing URL" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) return res.status(500).json({ ok:false, error:"Missing OCR_SPACE_API_KEY in environment" });

    const form = new URLSearchParams();
    form.append("url", inputUrl);
    form.append("language", language);   // single code only
    form.append("filetype", "PDF");
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2");

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: apiKey },
      body: form
    });

    const data = await resp.json().catch(() => null);

    if (!data || data.IsErroredOnProcessing) {
      const msgs = [];
      if (data?.ErrorMessage) msgs.push(data.ErrorMessage);
      if (data?.ErrorDetails) msgs.push(data.ErrorDetails);
      return res.status(502).json({ ok:false, error: msgs.length ? msgs : "OCR processing error" });
    }

    const pr = data.ParsedResults?.[0];
    const text = pr?.ParsedText || "";
    if (!text) return res.status(502).json({ ok:false, error:"No text returned from OCR" });

    return res.status(200).json({
      ok: true,
      source: "ocr",
      language,
      textLength: text.length,
      preview: text.slice(0, 2000) // bigger buffer for analysis
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error: err.message });
  }
}
