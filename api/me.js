// api/me.js — Returns current user's tier and scan counts
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
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const userId = session.sub;
  const month = new Date().toISOString().slice(0, 7);

  try {
    const [totalScans, monthlyScans, tier] = await Promise.all([
      kv.get(`user:${userId}:scans`),
      kv.get(`user:${userId}:scans:${month}`),
      kv.get(`user:${userId}:tier`),
    ]);

    const t = tier || "free";
    const total = Number(totalScans) || 0;
    const monthly = Number(monthlyScans) || 0;

    let scansUsed, scansLimit, scansLeft;
    if (t === "pro") {
      scansUsed = total; scansLimit = null; scansLeft = null;
    } else if (t === "basic") {
      scansUsed = monthly; scansLimit = 500; scansLeft = Math.max(0, 500 - monthly);
    } else {
      scansUsed = total; scansLimit = 100; scansLeft = Math.max(0, 100 - total);
    }

    return res.status(200).json({ tier: t, scansUsed, scansLimit, scansLeft });
  } catch (err) {
    console.error("Me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
