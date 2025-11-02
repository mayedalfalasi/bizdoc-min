export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok:false, error:"Use GET" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ ok:false, error:"OPENAI_API_KEY missing" });
    }

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: "Return a single word: OK" },
          { role: "user", content: "Say OK" }
        ]
      })
    });

    const ct = r.headers.get("content-type") || "";
    const raw = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok, status: r.status, contentType: ct, hasChoices: !!parsed?.choices,
      sample: parsed?.choices?.[0]?.message?.content || raw.slice(0,200)
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
