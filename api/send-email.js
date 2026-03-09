// api/send-email.js — LedgerScan v2
// Sends PDF + CSV to the logged-in user's email via Gmail SMTP
// Required env vars: GMAIL_USER, GMAIL_APP_PASSWORD, CLERK_SECRET_KEY

import nodemailer from "nodemailer";

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

  // Auth check
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  const session = await verifyClerkToken(token);
  if (!session) return res.status(401).json({ error: "Unauthorized. Please sign in." });

  const { to, bizCode, filename, pdfBase64, csvBase64 } = req.body || {};
  if (!to || !pdfBase64 || !csvBase64) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const pdfFilename = `${filename || bizCode}.pdf`;
  const csvFilename = `${filename || bizCode}.csv`;

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail({
      from: `LedgerScan <${process.env.GMAIL_USER}>`,
      to,
      subject: `LedgerScan Export — ${bizCode}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">LedgerScan Export</h2>
          <p>Your receipt export for business code <strong>${bizCode}</strong> is attached.</p>
          <ul>
            <li>📄 <strong>${pdfFilename}</strong> — Receipt PDF</li>
            <li>📊 <strong>${csvFilename}</strong> — Data CSV</li>
          </ul>
          <p style="color: #888; font-size: 12px;">
            Confidential — For accounting purposes only.<br/>
            This email was sent from LedgerScan Receipt Processing.
          </p>
        </div>
      `,
      attachments: [
        {
          filename: pdfFilename,
          content: Buffer.from(pdfBase64, "base64"),
          contentType: "application/pdf"
        },
        {
          filename: csvFilename,
          content: Buffer.from(csvBase64, "base64"),
          contentType: "text/csv"
        }
      ]
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Email handler error:", err);
    return res.status(500).json({ error: "Failed to send email. Please try again." });
  }
}
