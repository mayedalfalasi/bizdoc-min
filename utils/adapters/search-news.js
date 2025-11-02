export async function serpSearch(q, num = 6) {
  if (!process.env.SERPAPI_KEY) return { ok: false, reason: "missing_config" };

  const url = "https://serpapi.com/search.json?" + new URLSearchParams({
    q,
    engine: "google",
    num: String(num),
    api_key: process.env.SERPAPI_KEY
  });

  const r = await fetch(url);
  const j = await r.json().catch(() => null);

  const results = Array.isArray(j?.organic_results)
    ? j.organic_results.slice(0, num).map(x => ({
        title: x.title,
        url: x.link,
        snippet: x.snippet
      }))
    : [];

  return { ok: true, results };
}
