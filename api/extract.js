// api/extract.js — v2 with Clerk authentication
// Env vars needed: ANTHROPIC_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN, CLERK_SECRET_KEY

const DAILY_LIMIT = 20;

// ── Verify Clerk session token ─────────────────────────────────────────────
async function verifyClerkToken(token) {
  if (!token) return null;
  try {
    const res = await fetch("https://api.clerk.com/v1/tokens/verify", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CLERK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token })
    });
    if (!res.ok) return null;
    return await res.json(); // returns session/user info
  } catch {
    return null;
  }
}

// ── Vercel KV helpers ──────────────────────────────────────────────────────
async function kvGet(key) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
  });
  return (await res.json()).result ?? null;
}

async function kvIncr(key) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/incr/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
  });
  return (await res.json()).result;
}

async function kvExpireAt(key, ts) {
  await fetch(`${process.env.KV_REST_API_URL}/expireat/${key}/${ts}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
  });
}

function getMidnightUTC() {
  const now = new Date();
  return Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).getTime() / 1000);
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── Auth check ──
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  const session = await verifyClerkToken(token);

  if (!session) {
    return res.status(401).json({ error: "Unauthorized. Please sign in." });
  }

  const userId = session.sub || session.user_id || "unknown";

  // ── Rate limit per user (not just IP) ──
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rateLimitKey = `rl:user:${userId}:${today}`;

  try {
    const current = await kvGet(rateLimitKey);
    const count = current ? parseInt(current, 10) : 0;
    if (count >= DAILY_LIMIT) {
      return res.status(429).json({
        error: `Daily limit reached. You can process up to ${DAILY_LIMIT} receipts per day. Try again tomorrow.`,
        remaining: 0
      });
    }
    const newCount = await kvIncr(rateLimitKey);
    if (newCount === 1) await kvExpireAt(rateLimitKey, getMidnightUTC());
    res.setHeader("X-RateLimit-Remaining", DAILY_LIMIT - newCount);
  } catch (kvErr) {
    console.error("KV error:", kvErr.message);
  }

  // ── Extract receipt data ──
  const { base64, mediaType } = req.body || {};
  if (!base64 || !mediaType) return res.status(400).json({ error: "Missing base64 or mediaType" });

  const prompt = `You are an accounting assistant that extracts structured data from receipt images.

Analyze the receipt and return ONLY a valid JSON object with these exact keys (no markdown, no extra text):

- "accountDate": the transaction date in YYYY-MM-DD format
- "invoiceReceipt": the invoice or receipt number/reference shown on the document
- "expenseType": the category of expense (e.g. "Meals & Entertainment", "Office Supplies", "Transportation", "Utilities", "Professional Services", etc.)
- "totalExpense": the final total amount including taxes, with currency symbol (e.g. "PHP 1,250.00")
- "vatablePurchase": the VATable purchase amount before VAT, with currency symbol. If not shown, calculate as totalExpense / 1.12 for PH VAT. If VAT-exempt, use "0"
- "inputVAT": the VAT amount shown or calculated (12% of vatablePurchase for PH), with currency symbol

For fields that cannot be determined, use "".
Return ONLY the JSON object.`;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt }
          ]
        }]
      })
    });

    if (!anthropicRes.ok) {
      console.error("Anthropic error:", await anthropicRes.text());
      return res.status(502).json({ error: "AI extraction failed. Please try again." });
    }

    const anthropicData = await anthropicRes.json();
    const text = (anthropicData.content || []).map(b => b.text || "").join("");

    let extracted = null;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) extracted = JSON.parse(match[0]);
    } catch {}

    if (!extracted) return res.status(422).json({ error: "Could not parse receipt data from image." });

    return res.status(200).json({ data: extracted });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
