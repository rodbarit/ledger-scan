// api/extract.js — LedgerScan v2
// Required env vars: ANTHROPIC_API_KEY, CLERK_SECRET_KEY

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
  const session = await verifyClerkToken(token);
  if (!session) return res.status(401).json({ error: "Unauthorized. Please sign in." });

  const { base64, mediaType } = req.body || {};
  if (!base64 || !mediaType) return res.status(400).json({ error: "Missing base64 or mediaType" });

  const prompt = `You are an accounting assistant that extracts structured data from receipt images for Philippine BIR compliance.

Analyze the receipt and return ONLY a valid JSON object with these exact keys (no markdown, no extra text):

- "accountDate": the transaction date in YYYY-MM-DD format. 
  IMPORTANT date reading rules:
  - Philippine receipts commonly use M/DD/YYYY or MM/DD/YYYY format (month first, then day)
  - Example: "1/14/2025" or "1/14 2025" means January 14, 2025 → "2025-01-14"
  - Example: "12/3/2024" means December 3, 2024 → "2024-12-03"
  - For handwritten dates like "1/14 20__", the first number is the MONTH, second is the DAY
  - Never swap month and day — always treat the first number as month for Philippine receipts
  - If only 2 digits are written for year (e.g. "25"), assume 20XX → 2025
  - Look carefully at handwritten numbers — "1" and "7" can look similar, "5" and "6" can look similar

- "invoiceReceipt": the invoice or receipt number/reference (OR number) shown on the document
- "supplierName": the name of the business or establishment that issued the receipt (e.g. "Petron", "McDonald's", "SM Supermarket")
- "expenseType": the category of expense (e.g. "Meals & Entertainment", "Office Supplies", "Transportation", "Utilities", "Professional Services", "Gas", "Building Materials", etc.)
- "vatablePurchase": the VATable purchase amount (taxable base, BEFORE VAT is added), with currency symbol. ONLY include if the receipt explicitly shows a VATable/taxable amount. If not shown, use ""
- "nonVAT": the VAT-exempt or zero-rated purchase amount, with currency symbol. Use this when:
    (a) the receipt explicitly shows a NonVAT / VAT-exempt / zero-rated amount, OR
    (b) the receipt has no VAT breakdown at all (no VATable line, no VAT line) — in this case put the full purchase amount here
    If not applicable, use ""
- "inputVAT": the VAT amount (12% tax), ONLY if explicitly shown as a separate line on the receipt. If not shown, use ""
- "totalAmountDue": the final total amount actually paid, with currency symbol (e.g. "PHP 1,250.00"). This is the grand total printed on the receipt.
- "referenceCode": leave this as ""

Rules:
- VAT receipt: vatablePurchase = taxable base, inputVAT = 12% VAT, nonVAT = ""
- NonVAT receipt (no VAT breakdown): nonVAT = full amount, vatablePurchase = "", inputVAT = ""
- totalAmountDue is always the grand total the customer paid
- For fields that cannot be determined, use ""
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
