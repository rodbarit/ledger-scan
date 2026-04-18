// api/usage.js — LedgerScan admin usage stats
// Required env vars: KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_USER_ID, CLERK_SECRET_KEY
import { kv } from "./_kv.js";

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

async function getAllClerkUsers() {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY env var is not set");
  }
  const users = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(`https://api.clerk.com/v1/users?limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Clerk /v1/users returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    // Clerk has historically returned a raw array; some API versions wrap in {data, total_count}
    const batch = Array.isArray(json) ? json : (json.data || []);
    if (!batch.length) break;
    users.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return users;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  const session = await verifyClerkToken(token);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing session token" });
  }
  if (!process.env.ADMIN_USER_ID) {
    return res.status(500).json({ error: "Server misconfigured: ADMIN_USER_ID not set" });
  }
  if (session.sub !== process.env.ADMIN_USER_ID) {
    return res.status(403).json({ error: `Forbidden: signed-in user is not the admin (got ${session.sub.slice(0, 12)}…)` });
  }

  try {
    const month = new Date().toISOString().slice(0, 7);

    // Get all Clerk users and KV data in parallel
    const [clerkUsers, kvKeys] = await Promise.all([
      getAllClerkUsers(),
      kv.keys("user:*:scans"),
    ]);

    // Build set of userIds that have KV scan data
    const kvUserIds = new Set(kvKeys.map(k => k.split(":")[1]));

    // Merge: start from Clerk users (source of truth), enrich with KV data
    const users = await Promise.all(
      clerkUsers.map(async (cu) => {
        const userId = cu.id;
        const email = cu.email_addresses?.[0]?.email_address || null;
        const createdAt = cu.created_at ? new Date(cu.created_at).toISOString().slice(0, 10) : null;

        if (!kvUserIds.has(userId)) {
          // Signed up but never scanned — fetch only tier
          const tier = await kv.get(`user:${userId}:tier`);
          return {
            userId, email, createdAt,
            tier: tier || "free",
            scans: 0, scansThisMonth: 0,
            tokens: { input: 0, output: 0, total: 0 },
            cost: { usd: "0.000000", php: "0.00" },
          };
        }

        const [scans, inputTokens, outputTokens, costMicro, costPhpCentavos, monthlyScans, tier] = await Promise.all([
          kv.get(`user:${userId}:scans`),
          kv.get(`user:${userId}:tokens:input`),
          kv.get(`user:${userId}:tokens:output`),
          kv.get(`user:${userId}:cost:micro`),
          kv.get(`user:${userId}:cost:php_centavos`),
          kv.get(`user:${userId}:scans:${month}`),
          kv.get(`user:${userId}:tier`),
        ]);

        return {
          userId, email, createdAt,
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
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
