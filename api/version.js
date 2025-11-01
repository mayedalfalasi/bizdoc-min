export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF || "dev",
    deployedAt: new Date().toISOString(),
    env: process.env.VERCEL_ENV || "unknown"
  });
}
