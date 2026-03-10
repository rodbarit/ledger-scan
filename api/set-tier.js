// api/set-tier.js — Set user tier (free / basic / pro)
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  const session = await verifyClerkToken(token);
  if (!session || session.sub !== process.env.ADMIN_USER_ID) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { userId, tier } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  if (!["free", "basic", "pro"].includes(tier)) return res.status(400).json({ error: "tier must be free, basic, or pro" });

  try {
    if (tier === "free") {
      await kv.del(`user:${userId}:tier`);
    } else {
      await kv.set(`user:${userId}:tier`, tier);
    }
    return res.status(200).json({ ok: true, userId, tier });
  } catch (err) {
    console.error("Set tier error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
