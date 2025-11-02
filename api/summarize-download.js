// Minimal, ESM-safe stub that always returns a valid 1-page PDF.
// No external imports. Useful to prove the route is healthy.
export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(200).end();

    // Minimal PDF bytes (single blank page, PDF-1.4) — prebuilt buffer
    const pdf = Buffer.from(
      "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlIC9DYXRhbG9nL1BhZ2VzIDIgMCBS"
    + "Pj4KZW5kb2JqCjIgMCBvYmoKPDwvVHlwZSAvUGFnZXMvQ291bnQgMS9LaWRzIFszIDAg"
    + "Ul0+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlIC9QYWdlL1BhcmVudCAyIDAgUi9NZWRp"
    + "YUJveCBbMCAwIDU5NSA4NDJdL1Jlc291cmNlcyA8PC9Gb250IDw8Pj4+Pi9Db250ZW50"
    + "cyA0IDAgUj4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCAyMD4+CnN0cmVhbQpCBiAw"
    + "IDAgVgoqIEJpekRvYyBTdW1tYXJ5IFBERiAKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAg"
    + "b2JqCjw8L1R5cGUgL1hPYmplY3QvU3VidHlwZSAvSW1hZ2UvV2lkdGggMS9IZWlnaHQg"
    + "MS9Db2xvclNwYWNlIC9EZXZpY2VSR0I+PgplbmRvYmoKeHJlZgowIDYK"
    + "MDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDEwIDAwMDAwIG4gCjAwMDAwMDAwNTYg"
    + "MDAwMDAgbiAKMDAwMDAwMDEzMCAwMDAwMCBuIAowMDAwMDAwMjU1IDAwMDAwIG4gCjAw"
    + "MDAwMDAzNDUgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUi9JbmZv"
    + "IDYgMCBSPj4Kc3RhcnR4cmVmCjQ1NQolJUVPRg==",
      "base64"
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"stub.pdf\"");
    return res.status(200).send(pdf);
  } catch (e) {
    console.error("summarize-download STUB error:", e);
    const debug = process.env.BIZDOC_DEBUG === "1";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const payload = debug
      ? { ok:false, error: String(e?.message || e), stack: String(e?.stack || "") }
      : { ok:false, error: "internal_error" };
    return res.status(500).end(JSON.stringify(payload));
  }
}
