// api/extract.js — LedgerScan v2
// Required env vars: ANTHROPIC_API_KEY, CLERK_SECRET_KEY

async function verifyClerkToken(token) {
  if (!token) return null;
  try {
    // Clerk JWTs are standard JWTs - decode and check expiry
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // Decode base64url payload
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    // Check it's a Clerk token
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

  // Auth check
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  const session = await verifyClerkToken(token);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized. Please sign in." });
  }

  const { base64, mediaType } = req.body || {};
  if (!base64 || !mediaType) return res.status(400).json({ error: "Missing base64 or mediaType" });

  const prompt = `You are an accounting assistant that extracts structured data from receipt images.

Analyze the receipt and return ONLY a valid JSON object with these exact keys (no markdown, no extra text):

- "accountDate": the transaction date in YYYY-MM-DD format
- "invoiceReceipt": the invoice or receipt number/reference shown on the document
- "expenseType": the category of expense (e.g. "Meals & Entertainment", "Office Supplies", "Transportation", "Utilities", "Professional Services", etc.)
- "totalExpense": the final total amount including taxes, with currency symbol (e.g. "PHP 1,250.00")
- "vatablePurchase": the VATable purchase amount before VAT, with currency symbol. ONLY include if explicitly shown on the receipt. If not shown, use ""
- "inputVAT": the VAT amount ONLY if explicitly shown on the receipt. If not shown, use ""

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
