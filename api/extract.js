// api/extract.js — LedgerScan v2
// Required env vars: ANTHROPIC_API_KEY, CLERK_SECRET_KEY, KV_REST_API_URL, KV_REST_API_TOKEN
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  const session = token ? await verifyClerkToken(token) : null;
  // Guests (no token) allowed — free scan limit enforced client-side

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

  const { base64, mediaType, isVatRegistered, entryType, userEmail } = req.body || {};
  if (!base64 || !mediaType) return res.status(400).json({ error: "Missing base64 or mediaType" });

  let prompt;

  if (entryType === "sales") {
    const salesRules = isVatRegistered
      ? `Rules (VAT-Registered Entity — Sales):
- Extract what was sold from the receipt/invoice
- totalBilling = total amount charged to the customer (including VAT), with currency symbol
- vatableSales = taxable base (ex-VAT), with currency symbol
- vat = 12% output VAT amount, with currency symbol
- For fields that cannot be determined, use ""
- Return ONLY the JSON object, no other text`
      : `Rules (Non-VAT Entity — Sales):
- totalBilling = full amount charged to the customer, with currency symbol
- vatableSales = "" (non-VAT entity does not charge VAT)
- vat = "" (non-VAT entity does not charge VAT)
- For fields that cannot be determined, use ""
- Return ONLY the JSON object, no other text`;

    prompt = `You are an accounting assistant that extracts structured data from sales receipts/invoices for Philippine BIR compliance.

Analyze the receipt/invoice and return ONLY a valid JSON object with these exact keys (no markdown, no extra text):

- "accountDate": the transaction date in YYYY-MM-DD format.
  IMPORTANT date reading rules:
  - Philippine receipts commonly use M/DD/YYYY or MM/DD/YYYY format (month first, then day)
  - Example: "1/14/2025" means January 14, 2025 → "2025-01-14"
  - Never swap month and day — always treat the first number as month for Philippine receipts
  - If only 2 digits are written for year (e.g. "25"), assume 20XX → 2025

- "invoiceReceipt": the invoice or receipt number/reference (OR number) shown on the document
- "customerName": the name of the client or buyer shown on the receipt/invoice. If not shown, use ""
- "salesType": the category of what was sold (e.g. "Merchandise", "Services", "Food & Beverage", "Construction Materials", etc.)
- "totalBilling": see rules below
- "vatableSales": see rules below
- "vat": see rules below
- "customerCode": leave this as ""
- "referenceCode": leave this as ""

${salesRules}`;
  } else {
    const vatRules = isVatRegistered
      ? `Rules (VAT-Registered Entity — can claim Input VAT):
- VAT receipt: vatablePurchase = taxable base (ex-VAT), inputVAT = 12% VAT amount, nonVAT = ""
- NonVAT receipt (no VAT breakdown): nonVAT = full amount, vatablePurchase = "", inputVAT = ""
- totalAmountDue is always the grand total the customer paid
- For fields that cannot be determined, use ""
- Return ONLY the JSON object, no other text`
      : `Rules (Non-VAT Entity — CANNOT claim Input VAT):
- ALL receipts (VAT or NonVAT): nonVAT = full amount paid, vatablePurchase = "", inputVAT = "", totalAmountDue = ""
  Example: receipt shows PHP 892.86 taxable + PHP 107.14 VAT → nonVAT = "PHP 1,000.00", vatablePurchase = "", inputVAT = "", totalAmountDue = ""
  Example: receipt shows PHP 500 with no VAT → nonVAT = "PHP 500.00", vatablePurchase = "", inputVAT = "", totalAmountDue = ""
- For fields that cannot be determined, use ""
- Return ONLY the JSON object, no other text`;

    prompt = `You are an accounting assistant that extracts structured data from receipt images for Philippine BIR compliance.

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
- "vatablePurchase": see rules below
- "nonVAT": the VAT-exempt or zero-rated purchase amount, with currency symbol. See rules below.
- "inputVAT": the VAT amount (12% tax). See rules below.
- "totalAmountDue": the final total amount actually paid, with currency symbol (e.g. "PHP 1,250.00"). This is the grand total printed on the receipt.
- "referenceCode": leave this as ""

${vatRules}`;
  }

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

    // Track usage for signed-in users
    if (session) {
      const userId = session.sub;
      const inputTokens = anthropicData.usage?.input_tokens || 0;
      const outputTokens = anthropicData.usage?.output_tokens || 0;
      const usdToPhp = parseFloat(process.env.USD_TO_PHP || "56");
      const costUSD = (inputTokens / 1_000_000) * 3.00 + (outputTokens / 1_000_000) * 15.00;
      const costMicro = Math.round(costUSD * 1_000_000); // microdollars
      const costPhpCentavos = Math.round(costUSD * usdToPhp * 100); // centavos
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
        pipe.expire(monthlyKey, 60 * 60 * 24 * 35); // auto-expire after 35 days
        pipe.set(`user:${userId}:lastUsed`, Date.now());
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
