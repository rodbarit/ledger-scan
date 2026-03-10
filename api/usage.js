// api/usage.js — LedgerScan admin usage stats
// Required env vars: KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_USER_ID
import { kv } from "@vercel/kv";

async function verifyClerkToken(token) {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (!payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  const session = await verifyClerkToken(token);
  if (!session || session.sub !== process.env.ADMIN_USER_ID) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const keys = await kv.keys("user:*:scans");

    const users = await Promise.all(
      keys.map(async (key) => {
        const userId = key.split(":")[1];
        const month = new Date().toISOString().slice(0, 7);
        const [scans, inputTokens, outputTokens, costMicro, costPhpCentavos, monthlyScans, tier, email] = await Promise.all([
          kv.get(`user:${userId}:scans`),
          kv.get(`user:${userId}:tokens:input`),
          kv.get(`user:${userId}:tokens:output`),
          kv.get(`user:${userId}:cost:micro`),
          kv.get(`user:${userId}:cost:php_centavos`),
          kv.get(`user:${userId}:scans:${month}`),
          kv.get(`user:${userId}:tier`),
          kv.get(`user:${userId}:email`),
        ]);
        return {
          userId,
          email: email || null,
          tier: tier || "free",
          scans: scans || 0,
          scansThisMonth: monthlyScans || 0,
          tokens: {
            input: inputTokens || 0,
            output: outputTokens || 0,
            total: (inputTokens || 0) + (outputTokens || 0),
          },
          cost: {
            usd: ((costMicro || 0) / 1_000_000).toFixed(6),
            php: ((costPhpCentavos || 0) / 100).toFixed(2),
          },
        };
      })
    );

    users.sort((a, b) => parseFloat(b.cost.usd) - parseFloat(a.cost.usd));

    const totalUsd = users.reduce((sum, u) => sum + parseFloat(u.cost.usd), 0);
    const totalPhp = users.reduce((sum, u) => sum + parseFloat(u.cost.php), 0);
    const totalScans = users.reduce((sum, u) => sum + Number(u.scans), 0);

    return res.status(200).json({
      summary: {
        totalUsers: users.length,
        totalScans,
        totalCost: { usd: totalUsd.toFixed(6), php: totalPhp.toFixed(2) },
      },
      users,
    });
  } catch (err) {
    console.error("Usage error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
