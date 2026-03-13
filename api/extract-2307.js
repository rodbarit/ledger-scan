// api/extract-2307.js — LedgerScan Form 2307 extraction
// Required env vars: ANTHROPIC_API_KEY, CLERK_SECRET_KEY, KV_REST_API_URL, KV_REST_API_TOKEN
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

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  const session = token ? await verifyClerkToken(token) : null;

  // Tier-based scan limits: free = 100 lifetime, basic = 500/month, pro = unlimited
  if (session) {
    const userId = session.sub;
    try {
      const tier = await kv.get(`user:${userId}:tier`);
      if (tier === "pro") {
        // unlimited — no check
      } else if (tier === "basic") {
        const month = new Date().toISOString().slice(0, 7);
        const monthlyScans = (await kv.get(`user:${userId}:scans:${month}`)) || 0;
        if (monthlyScans >= 200) {
          return res.status(429).json({ error: "Monthly limit of 200 scans reached. Resets on the 1st of next month." });
        }
      } else {
        // free tier — 100 lifetime
        const totalScans = (await kv.get(`user:${userId}:scans`)) || 0;
        if (totalScans >= 100) {
          return res.status(429).json({ error: "You've used all 100 free scans. Upgrade to Basic (₱499/mo) or Pro (₱999/mo) to continue." });
        }
      }
    } catch (e) {
      console.error("KV limit check error:", e);
    }
  }

  const { base64, mediaType, userEmail } = req.body || {};
  if (!base64 || !mediaType) return res.status(400).json({ error: "Missing base64 or mediaType" });

  const prompt = `You are an accounting assistant that extracts structured data from Philippine BIR Form 2307 (Certificate of Creditable Withholding Tax at Source).

Analyze the form image and return ONLY a valid JSON object with these exact keys (no markdown, no extra text):

- "periodFrom": the "Period From" date in YYYY-MM-DD format (start of the quarter covered)
- "periodTo": the "Period To" date in YYYY-MM-DD format (end of the quarter covered)
- "payeeTin": always return ""
- "payeeName": the actual name written or typed directly below the printed label "Payee's Name" — this is the company or individual name filled in on the form. Do NOT return a label, heading, or checkbox description.
- "payorTin": always return ""
- "payorName": the actual name written or typed directly below the printed label "Withholding Agent's/Payor's Name" — this is the company or individual name filled in on the form. Do NOT return checkbox labels, taxpayer classifications, or category descriptions (e.g. "Top 5,000 Individual", "Top 1,000 Private Corporations", "Government", "Large Taxpayer" are classifications — not names).
- "atcCode": the Alphanumeric Tax Code (ATC) shown on the form, e.g. "WC160"
- "month1Income": the income payment amount for the 1st month of the quarter (numeric string only, no currency symbol or commas, e.g. "33464.51"). Use "" if blank.
- "month2Income": the income payment amount for the 2nd month of the quarter. Use "" if blank.
- "month3Income": the income payment amount for the 3rd month of the quarter. Use "" if blank.
- "total": the total income payments for the quarter (numeric string only, no currency symbol or commas)
- "taxWithheld": the total tax withheld for the quarter (numeric string only, no currency symbol or commas)

Rules:
- For dates, Philippine forms commonly use MM/DD/YYYY format — always treat the first number as month
- For numeric amounts, strip currency symbols and commas — return just the number (e.g. "33,464.51" → "33464.51")
- If a field cannot be read or is not present, use ""
- Return ONLY the JSON object, no other text`;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
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

    if (!extracted) return res.status(422).json({ error: "Could not parse Form 2307 data from image." });

    // Track usage for signed-in users
    if (session) {
      const userId = session.sub;
      const inputTokens = anthropicData.usage?.input_tokens || 0;
      const outputTokens = anthropicData.usage?.output_tokens || 0;
      const usdToPhp = parseFloat(process.env.USD_TO_PHP || "56");
      const costUSD = (inputTokens / 1_000_000) * 3.00 + (outputTokens / 1_000_000) * 15.00;
      const costMicro = Math.round(costUSD * 1_000_000);
      const costPhpCentavos = Math.round(costUSD * usdToPhp * 100);
      try {
        const month = new Date().toISOString().slice(0, 7);
        const monthlyKey = `user:${userId}:scans:${month}`;
        const pipe = kv.pipeline();
        pipe.incr(`user:${userId}:scans`);
        pipe.incrby(`user:${userId}:tokens:input`, inputTokens);
        pipe.incrby(`user:${userId}:tokens:output`, outputTokens);
        pipe.incrby(`user:${userId}:cost:micro`, costMicro);
        pipe.incrby(`user:${userId}:cost:php_centavos`, costPhpCentavos);
        pipe.incr(monthlyKey);
        pipe.expire(monthlyKey, 60 * 60 * 24 * 35);
        if (userEmail) pipe.set(`user:${userId}:email`, userEmail);
        await pipe.exec();
      } catch (e) {
        console.error("KV tracking error:", e);
      }
    }

    return res.status(200).json({ data: extracted });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
