import { useState, useRef, useCallback } from "react";
import {
  SignedIn, SignedOut, SignIn, useUser, useClerk, useAuth, SignInButton
} from "@clerk/clerk-react";

const FREE_SCAN_LIMIT = 5;

// ── Field definitions ──────────────────────────────────────────────────────
const FIELDS = [
  { key: "accountDate",      label: "Account Date",       ai: true  },
  { key: "invoiceReceipt",   label: "Invoice / Receipt",  ai: true  },
  { key: "supplierName",     label: "Supplier Name",      ai: true  },
  { key: "expenseType",      label: "Expense Type",       ai: true  },
  { key: "vatablePurchase",  label: "VATable Purchase",   ai: true  },
  { key: "nonVAT",           label: "NonVAT",             ai: true  },
  { key: "inputVAT",         label: "Input VAT",          ai: true  },
  { key: "supplierCode",     label: "Supplier Code",      ai: false },
];

const SALES_FIELDS = [
  { key: "accountDate",    label: "Account Date",      ai: true  },
  { key: "invoiceReceipt", label: "Invoice / Receipt", ai: true  },
  { key: "customerName",   label: "Client Name",       ai: true  },
  { key: "salesType",      label: "Sales Type",        ai: true  },
  { key: "totalBilling",   label: "Total Billing",     ai: true  },
  { key: "vatableSales",   label: "VATable Sales",     ai: true  },
  { key: "vat",            label: "VAT",               ai: true  },
  { key: "customerCode",   label: "Client Code",       ai: false },
];

// Convert extracted text to title case e.g. "HAILCO PIPEWORKS" → "Hailco Pipeworks"
function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Apply title case to relevant text fields from AI extraction
function normalizeTitleCase(data) {
  const textFields = ["supplierName", "expenseType", "customerName", "salesType"];
  const result = { ...data };
  textFields.forEach(k => { if (result[k]) result[k] = toTitleCase(result[k]); });
  return result;
}

// Parse a PHP amount string to a number e.g. "PHP 1,234.56" → 1234.56
function parseAmount(str) {
  if (!str) return 0;
  const n = parseFloat(str.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}

// Auto-compute Total Expense = VATable + NonVAT, formatted as "PHP X.XX"
function computeTotalExpense(data) {
  const vatable = parseAmount(data.vatablePurchase);
  const nonvat  = parseAmount(data.nonVAT);
  if (!vatable && !nonvat) return "";
  const total = vatable + nonvat;
  return `PHP ${total.toFixed(2)}`;
}

// Auto-generate reference code from businessCode + invoiceReceipt + accountDate
function buildReferenceCode(bizCode, data) {
  const biz = (bizCode || "").trim();
  const or  = (data.invoiceReceipt || "").trim();
  const dt  = (data.accountDate || "").replace(/-/g, "").trim();
  const parts = [biz, or, dt].filter(Boolean);
  return parts.join("-");
}

// Build PDF page reference: <BusinessCode>-<PageNumber>
function buildPageRef(bizCode, pageNumber) {
  const biz = (bizCode || "").trim();
  return biz ? `${biz}-${pageNumber}` : `${pageNumber}`;
}

// Build filename: <BusinessCode><YYYYMMDD><HHmmss>
function buildFilename(bizCode, ext) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 5).replace(":", "");
  return `${(bizCode || "UNKNOWN").trim()}-${date}-${time}.${ext}`;
}

function toSalesCSV(bizCode, rows, isVatRegistered) {
  const header = [
    "Account Date", "Invoice / Receipt", "Client Name", "Sales Type",
    "Total Billing", "VATable Sales", "VAT",
    "Client Code", "Reference Code", "Business Code", "PDF Page"
  ];
  const lines = [
    header.join(","),
    ...rows.map((r, i) => {
      const pageNum = Math.ceil((i + 1) / 2);
      const pageRef = buildPageRef(bizCode, pageNum);
      const refCode = r.data.referenceCode || buildReferenceCode(bizCode, r.data);
      const q = v => `"${(v || "").replace(/"/g, '""')}"`;
      return [
        q(r.data.accountDate), q(r.data.invoiceReceipt), q(r.data.customerName  ), q(r.data.salesType),
        q(r.data.totalBilling), q(isVatRegistered ? r.data.vatableSales : ""), q(isVatRegistered ? r.data.vat : ""),
        q(r.data.customerCode), q(refCode), q(bizCode), q(pageRef)
      ].join(",");
    })
  ];
  return lines.join("\n");
}

function toCSV(bizCode, rows) {
  const header = [
    "Account Date", "Invoice / Receipt", "Supplier Name", "Expense Type",
    "VATable Purchase", "NonVAT", "Input VAT",
    "Total Expense", "Total Amount Due",
    "Supplier Code", "Reference Code", "Business Code", "PDF Page"
  ];
  const lines = [
    header.join(","),
    ...rows.map((r, i) => {
      const pageNum = Math.ceil((i + 1) / 2);
      const pageRef = buildPageRef(bizCode, pageNum);
      const refCode = r.data.referenceCode || buildReferenceCode(bizCode, r.data);
      const totalExpense = computeTotalExpense(r.data);
      const q = v => `"${(v || "").replace(/"/g, '""')}"`;
      return [
        q(r.data.accountDate), q(r.data.invoiceReceipt), q(r.data.supplierName), q(r.data.expenseType),
        q(r.data.vatablePurchase), q(r.data.nonVAT), q(r.data.inputVAT),
        q(totalExpense), q(r.data.totalAmountDue),
        q(r.data.supplierCode), q(refCode), q(bizCode), q(pageRef)
      ].join(",");
    })
  ];
  return lines.join("\n");
}

const ALL_KEYS = [...new Set([...FIELDS.map(f => f.key), ...SALES_FIELDS.map(f => f.key)])];
const EMPTY_DATA = () => Object.fromEntries(ALL_KEYS.map(k => [k, ""]));

// ── API helpers ────────────────────────────────────────────────────────────
async function extractReceiptData(base64, mediaType, token, isVatRegistered, entryType) {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ base64, mediaType, isVatRegistered, entryType })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Extraction failed");
  return json.data;
}

async function generatePDF(bizCode, receipts, filename, entryType) {
  if (!window.jspdf) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = 210, pageH = 297, margin = 10, gap = 4;
  const cellW = (pageW - margin * 2 - gap) / 2;
  const footerRowH = 13, colHeaderH = 8;
  const pages = [];
  for (let i = 0; i < receipts.length; i += 2) pages.push(receipts.slice(i, i + 2));

  const c1 = 55, c2 = 58, c3 = 38;
  const tr = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "—");
  const nc = s => (s || "").replace(/\u20b1/g, "PHP ");

  for (let p = 0; p < pages.length; p++) {
    if (p > 0) pdf.addPage();
    const group = pages[p];

    // ── Header: Business Code + page number only ──
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.setTextColor(0, 0, 0);
    pdf.text(bizCode || "—", margin, margin + 5);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8);
    pdf.text(`Page ${p + 1} of ${pages.length}`, pageW - margin, margin + 5, { align: "right" });
    pdf.setDrawColor(0); pdf.setLineWidth(0.3);
    pdf.line(margin, margin + 8, pageW - margin, margin + 8);

    // ── Layout ──
    const tableH = colHeaderH + group.length * footerRowH;
    const imgAreaY = margin + 12;
    const imgAreaH = pageH - imgAreaY - tableH - margin - 8;

    // ── Receipt images ──
    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const x = margin + i * (cellW + gap);
      pdf.setDrawColor(0); pdf.setLineWidth(0.2);
      pdf.rect(x, imgAreaY, cellW, imgAreaH);
      if (r.preview) {
        try {
          const imgData = await getImageDataURL(r.preview, r.file?.type || "image/jpeg");
          const imgFormat = (r.file?.type || "").includes("png") ? "PNG" : "JPEG";
          pdf.addImage(imgData, imgFormat, x + 0.5, imgAreaY + 0.5, cellW - 1, imgAreaH - 1, "", "FAST");
        } catch {}
      }
    }

    // ── Footer table ──
    const tableY = pageH - margin - tableH - 6;
    pdf.setDrawColor(0); pdf.setLineWidth(0.3);
    pdf.line(margin, tableY - 1, pageW - margin, tableY - 1);

    // Column headers
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(7); pdf.setTextColor(0, 0, 0);
    let hx = margin;
    pdf.text("REFERENCE CODE",                    hx, tableY + 5); hx += c1;
    pdf.text(entryType === "sales" ? "CLIENT" : "SUPPLIER", hx, tableY + 5); hx += c2;
    pdf.text(entryType === "sales" ? "SALES TYPE" : "CATEGORY", hx, tableY + 5); hx += c3;
    pdf.text(entryType === "sales" ? "TOTAL BILLING" : "TOTAL", hx, tableY + 5);
    pdf.setLineWidth(0.2);
    pdf.line(margin, tableY + colHeaderH - 1, pageW - margin, tableY + colHeaderH - 1);

    // Data rows
    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const rowY = tableY + colHeaderH + i * footerRowH;
      const refCode  = r.data.referenceCode || buildReferenceCode(bizCode, r.data);
      const supplier = entryType === "sales" ? (r.data.customerName || "—") : (r.data.supplierName || r.data.invoiceReceipt || "—");
      const category = entryType === "sales" ? (r.data.salesType || "—") : (r.data.expenseType || "—");
      const total    = entryType === "sales" ? (r.data.totalBilling || "—") : (r.data.totalAmountDue || computeTotalExpense(r.data) || "—");

      pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5); pdf.setTextColor(0, 0, 0);
      const supplierLines = pdf.splitTextToSize(supplier, c2 - 2).slice(0, 2);
      const categoryLines = pdf.splitTextToSize(category, c3 - 2).slice(0, 2);
      let rx = margin;
      pdf.text(tr(refCode, 30),   rx, rowY + 4); rx += c1;
      pdf.text(supplierLines,     rx, rowY + 4); rx += c2;
      pdf.text(categoryLines,     rx, rowY + 4); rx += c3;
      pdf.text(tr(nc(total), 18), rx, rowY + 4);

      if (i < group.length - 1) {
        pdf.setLineWidth(0.1); pdf.setDrawColor(180, 180, 180);
        pdf.line(margin, rowY + footerRowH, pageW - margin, rowY + footerRowH);
      }
    }

    pdf.setLineWidth(0.3); pdf.setDrawColor(0);
    pdf.line(margin, tableY + tableH - 1, pageW - margin, tableY + tableH - 1);

    // Page footer
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(120, 120, 120);
    pdf.text("Confidential — For accounting purposes only", pageW / 2, pageH - 4, { align: "center" });
  }
  const blob = new Blob([pdf.output("arraybuffer")], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.open(url, "_blank");
}

// Same as generatePDF but returns base64 string for emailing
async function generatePDFBase64(bizCode, receipts, entryType) {
  if (!window.jspdf) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      script.onload = resolve; script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = 210, pageH = 297, margin = 10, gap = 4;
  const cellW = (pageW - margin * 2 - gap) / 2;
  const footerRowH = 13, colHeaderH = 8;
  const pages = [];
  for (let i = 0; i < receipts.length; i += 2) pages.push(receipts.slice(i, i + 2));
  const c1 = 55, c2 = 58, c3 = 38;
  const tr = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "—");
  const nc = s => (s || "").replace(/\u20b1/g, "PHP ");
  for (let p = 0; p < pages.length; p++) {
    if (p > 0) pdf.addPage();
    const group = pages[p];
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.setTextColor(0,0,0);
    pdf.text(bizCode || "—", margin, margin + 5);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8);
    pdf.text(`Page ${p+1} of ${pages.length}`, pageW - margin, margin + 5, { align: "right" });
    pdf.setDrawColor(0); pdf.setLineWidth(0.3);
    pdf.line(margin, margin + 8, pageW - margin, margin + 8);
    const tableH = colHeaderH + group.length * footerRowH;
    const imgAreaY = margin + 12;
    const imgAreaH = pageH - imgAreaY - tableH - margin - 8;
    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const x = margin + i * (cellW + gap);
      pdf.setDrawColor(0); pdf.setLineWidth(0.2);
      pdf.rect(x, imgAreaY, cellW, imgAreaH);
      if (r.preview) {
        try {
          const imgData = await getImageDataURL(r.preview, r.file?.type || "image/jpeg");
          const imgFormat = (r.file?.type || "").includes("png") ? "PNG" : "JPEG";
          pdf.addImage(imgData, imgFormat, x+0.5, imgAreaY+0.5, cellW-1, imgAreaH-1, "", "FAST");
        } catch {}
      }
    }
    const tableY = pageH - margin - tableH - 6;
    pdf.setDrawColor(0); pdf.setLineWidth(0.3);
    pdf.line(margin, tableY - 1, pageW - margin, tableY - 1);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(7); pdf.setTextColor(0,0,0);
    let hx = margin;
    pdf.text("REFERENCE CODE", hx, tableY+5); hx += c1;
    pdf.text(entryType === "sales" ? "CLIENT" : "SUPPLIER", hx, tableY+5); hx += c2;
    pdf.text(entryType === "sales" ? "SALES TYPE" : "CATEGORY", hx, tableY+5); hx += c3;
    pdf.text(entryType === "sales" ? "TOTAL BILLING" : "TOTAL", hx, tableY+5);
    pdf.setLineWidth(0.2);
    pdf.line(margin, tableY+colHeaderH-1, pageW-margin, tableY+colHeaderH-1);
    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const rowY = tableY + colHeaderH + i * footerRowH;
      const refCode = r.data.referenceCode || buildReferenceCode(bizCode, r.data);
      const supplier = entryType === "sales" ? (r.data.customerName || "—") : (r.data.supplierName || "—");
      const category = entryType === "sales" ? (r.data.salesType || "—") : (r.data.expenseType || "—");
      const total = entryType === "sales" ? (r.data.totalBilling || "—") : (r.data.totalAmountDue || computeTotalExpense(r.data) || "—");
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5); pdf.setTextColor(0,0,0);
      const supplierLines = pdf.splitTextToSize(supplier, c2 - 2).slice(0, 2);
      const categoryLines = pdf.splitTextToSize(category, c3 - 2).slice(0, 2);
      let rx = margin;
      pdf.text(tr(refCode, 30),   rx, rowY+4); rx += c1;
      pdf.text(supplierLines,     rx, rowY+4); rx += c2;
      pdf.text(categoryLines,     rx, rowY+4); rx += c3;
      pdf.text(tr(nc(total), 18), rx, rowY+4);
      if (i < group.length - 1) { pdf.setLineWidth(0.1); pdf.setDrawColor(180,180,180); pdf.line(margin, rowY+footerRowH, pageW-margin, rowY+footerRowH); }
    }
    pdf.setLineWidth(0.3); pdf.setDrawColor(0);
    pdf.line(margin, tableY+tableH-1, pageW-margin, tableY+tableH-1);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(120,120,120);
    pdf.text("Confidential — For accounting purposes only", pageW/2, pageH-4, { align: "center" });
  }
  return btoa(pdf.output());
}

function getImageDataURL(src, type) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      resolve(canvas.toDataURL(type || "image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = src;
  });
}

// ── Small components ───────────────────────────────────────────────────────
const TAG = ({ children, color }) => (
  <span style={{
    fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
    padding: "2px 6px", borderRadius: 3, background: color + "22", color,
    border: `1px solid ${color}44`, fontFamily: "inherit"
  }}>{children}</span>
);

function FieldInput({ field, value, onChange, accentColor }) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label style={{
        display: "block", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
        textTransform: "uppercase", color: focused ? accentColor : "#999",
        marginBottom: 5, transition: "color 0.15s"
      }}>{field.label}</label>
      <input
        value={value || ""}
        onChange={e => onChange(e.target.value)}
        placeholder={field.ai ? "extracted from receipt" : "enter manually"}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: "100%", padding: "8px 12px", fontSize: 13,
          border: `1px solid ${focused ? accentColor : "#e5e2de"}`,
          borderRadius: 6, outline: "none", fontFamily: "inherit",
          background: field.ai ? "#fafafa" : "#fff", color: "#1a1a2e",
          transition: "border-color 0.15s",
          boxShadow: focused ? `0 0 0 3px ${accentColor}18` : "none"
        }}
      />
    </div>
  );
}

// ── Login screen ───────────────────────────────────────────────────────────
function LoginScreen() {
  return (
    <div style={{
      minHeight: "100vh", background: "#f4f3f0",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "'Lato', sans-serif"
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet" />
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 32, fontWeight: 700, color: "#1a1a2e", marginBottom: 6 }}>
          LedgerScan
        </div>
        <div style={{ fontSize: 13, color: "#999", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Receipt Processing
        </div>
      </div>
      <SignIn
        appearance={{
          elements: {
            rootBox: { boxShadow: "0 4px 24px rgba(0,0,0,0.08)", borderRadius: 12 },
            card: { borderRadius: 12, border: "1px solid #e5e2de" },
            headerTitle: { fontFamily: "'Playfair Display', serif", color: "#1a1a2e" },
            headerSubtitle: { color: "#999" },
            socialButtonsBlockButton: { border: "1px solid #e5e2de", borderRadius: 6 },
            formButtonPrimary: { background: "#1a1a2e", borderRadius: 6 },
            footerActionLink: { color: "#2a5298" }
          }
        }}
      />
    </div>
  );
}

// ── User avatar / menu ─────────────────────────────────────────────────────
function UserMenu() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 100, padding: "5px 12px 5px 5px", cursor: "pointer", color: "#fff"
        }}
      >
        {user?.imageUrl
          ? <img src={user.imageUrl} alt="" style={{ width: 26, height: 26, borderRadius: "50%", objectFit: "cover" }} />
          : <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#2a5298", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
              {user?.firstName?.[0] || user?.emailAddresses?.[0]?.emailAddress?.[0] || "?"}
            </div>
        }
        <span style={{ fontSize: 12, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {user?.firstName || user?.emailAddresses?.[0]?.emailAddress}
        </span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 100,
          background: "#fff", borderRadius: 8, border: "1px solid #e5e2de",
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 200, overflow: "hidden"
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0ece8" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e" }}>
              {user?.fullName || "User"}
            </div>
            <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>
              {user?.emailAddresses?.[0]?.emailAddress}
            </div>
          </div>
          <button
            onClick={() => signOut()}
            style={{
              width: "100%", padding: "10px 16px", textAlign: "left", background: "none",
              border: "none", fontSize: 13, color: "#b91c1c", cursor: "pointer",
              fontFamily: "inherit", transition: "background 0.15s"
            }}
            onMouseEnter={e => e.currentTarget.style.background = "#fef2f2"}
            onMouseLeave={e => e.currentTarget.style.background = "none"}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ── Business Code entry screen ─────────────────────────────────────────────
function BizCodeScreen({ onConfirm }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [value, setValue] = useState("");
  const [vatRegistered, setVatRegistered] = useState(null);
  const [entryType, setEntryType] = useState(null);

  return (
    <div style={{
      minHeight: "100vh", background: "#f4f3f0",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "'Lato', sans-serif"
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet" />
      <div style={{ width: 400 }} className="biz-screen-width">
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 30, fontWeight: 700, color: "#1a1a2e" }}>LedgerScan</div>
          <div style={{ fontSize: 12, color: "#999", letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 4 }}>Receipt Processing</div>
        </div>

        <div style={{ background: "#fff", borderRadius: 12, padding: 36, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", border: "1px solid #e5e2de" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a2e", marginBottom: 6 }}>Enter Business Code</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 24, lineHeight: 1.5 }}>
            All receipts in this session will be filed under this business code.
          </div>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#666", display: "block", marginBottom: 8 }}>
            Business Code <span style={{ color: "#c0392b" }}>*</span>
          </label>
          <input
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && value.trim() && vatRegistered !== null && entryType !== null && onConfirm(value.trim(), vatRegistered, entryType)}
            placeholder="e.g. PH-OP"
            style={{
              width: "100%", padding: "12px 14px", fontSize: 15, borderRadius: 8,
              border: "1.5px solid #ddd", outline: "none", marginBottom: 24,
              letterSpacing: "0.08em", fontFamily: "inherit", boxSizing: "border-box",
              transition: "border-color 0.15s"
            }}
            onFocus={e => e.target.style.borderColor = "#1a1a2e"}
            onBlur={e => e.target.style.borderColor = "#ddd"}
          />

          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#666", display: "block", marginBottom: 10 }}>
            VAT-Registered Entity <span style={{ color: "#c0392b" }}>*</span>
          </label>
          <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
            {[{ label: "Yes", val: true }, { label: "No", val: false }].map(({ label, val }) => (
              <button
                key={label}
                type="button"
                onClick={() => setVatRegistered(val)}
                style={{
                  flex: 1, padding: "10px", borderRadius: 8, border: `1.5px solid ${vatRegistered === val ? "#1a1a2e" : "#ddd"}`,
                  background: vatRegistered === val ? "#1a1a2e" : "#fff",
                  color: vatRegistered === val ? "#fff" : "#555",
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                  fontFamily: "inherit", transition: "all 0.15s"
                }}
              >{label}</button>
            ))}
          </div>

          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#666", display: "block", marginBottom: 10 }}>
            Entry Type <span style={{ color: "#c0392b" }}>*</span>
          </label>
          <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
            {[{ label: "Expenses", val: "expenses" }, { label: "Sales", val: "sales" }].map(({ label, val }) => (
              <button
                key={val}
                type="button"
                onClick={() => setEntryType(val)}
                style={{
                  flex: 1, padding: "10px", borderRadius: 8, border: `1.5px solid ${entryType === val ? "#1a1a2e" : "#ddd"}`,
                  background: entryType === val ? "#1a1a2e" : "#fff",
                  color: entryType === val ? "#fff" : "#555",
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                  fontFamily: "inherit", transition: "all 0.15s"
                }}
              >{label}</button>
            ))}
          </div>

          <button
            onClick={() => value.trim() && vatRegistered !== null && entryType !== null && onConfirm(value.trim(), vatRegistered, entryType)}
            style={{
              width: "100%", padding: "13px", borderRadius: 8, border: "none",
              background: value.trim() && vatRegistered !== null && entryType !== null ? "#1a1a2e" : "#e5e2de",
              color: value.trim() && vatRegistered !== null && entryType !== null ? "#fff" : "#aaa",
              fontSize: 14, fontWeight: 700, cursor: value.trim() && vatRegistered !== null && entryType !== null ? "pointer" : "default",
              fontFamily: "inherit", letterSpacing: "0.06em", transition: "all 0.2s"
            }}
          >
            Start Processing →
          </button>
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 12, color: "#aaa" }}>
          {user
            ? <>{user.emailAddresses?.[0]?.emailAddress} · <button onClick={() => signOut()} style={{ background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: 0 }}>Sign out</button></>
            : <SignInButton mode="modal"><button style={{ background: "none", border: "none", color: "#2a5298", cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: 0 }}>Sign in for unlimited scans</button></SignInButton>
          }
        </div>
      </div>
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────────────────
function Dashboard() {
  const { isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const [bizCode, setBizCode] = useState("");
  const [isVatRegistered, setIsVatRegistered] = useState(null);
  const [entryType, setEntryType] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [globalError, setGlobalError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [showSignUp, setShowSignUp] = useState(false);
  const [freeScans, setFreeScans] = useState(() => parseInt(localStorage.getItem("freeScans") || "0"));
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminData, setAdminData] = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);

  const isAdmin = isSignedIn && user?.id === import.meta.env.VITE_ADMIN_USER_ID;

  const loadAdminData = async () => {
    setAdminLoading(true);
    try {
      const token = await getToken() ?? "";
      const res = await fetch("/api/usage", { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      setAdminData(json);
    } catch (e) {
      console.error("Admin fetch error:", e);
    } finally {
      setAdminLoading(false);
    }
  };
  const fileRef = useRef();

  const freeScansLeft = Math.max(0, FREE_SCAN_LIMIT - freeScans);

  // Show business code entry screen first
  if (!bizCode) return <BizCodeScreen onConfirm={(biz, vat, type) => { setBizCode(biz); setIsVatRegistered(vat); setEntryType(type); }} />;

  const processFiles = async (files) => {
    if (!isSignedIn && freeScans >= FREE_SCAN_LIMIT) {
      setShowSignUp(true);
      return;
    }
    setGlobalError(null);
    const newItems = Array.from(files).map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f, preview: URL.createObjectURL(f),
      status: "pending", error: null, data: EMPTY_DATA()
    }));
    setReceipts(prev => [...prev, ...newItems]);
    setExpandedId(newItems[0]?.id ?? null);
    const token = await getToken() ?? "";
    for (const item of newItems) {
      if (!isSignedIn && freeScans >= FREE_SCAN_LIMIT) {
        setShowSignUp(true);
        setReceipts(prev => prev.filter(r => r.id !== item.id));
        break;
      }
      setReceipts(prev => prev.map(r => r.id === item.id ? { ...r, status: "processing" } : r));
      try {
        const base64 = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(item.file);
        });
        const raw = await extractReceiptData(base64, item.file.type || "image/jpeg", token, isVatRegistered, entryType);
        const extracted = normalizeTitleCase(raw);
        if (!isSignedIn) {
          const next = freeScans + 1;
          localStorage.setItem("freeScans", next);
          setFreeScans(next);
        }
        setReceipts(prev => prev.map(r => r.id === item.id
          ? { ...r, status: "done", data: { ...EMPTY_DATA(), ...extracted } } : r));
      } catch (e) {
        if (e.message?.toLowerCase().includes("daily limit")) setGlobalError(e.message);
        setReceipts(prev => prev.map(r => r.id === item.id ? { ...r, status: "error", error: e.message } : r));
      }
    }
  };

  const onDrop = (e) => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); };
  const updateField = (id, key, value) =>
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, data: { ...r.data, [key]: value } } : r));
  const removeReceipt = (id) => { setReceipts(prev => prev.filter(r => r.id !== id)); if (expandedId === id) setExpandedId(null); };

  const done = receipts.filter(r => r.status === "done");
  const doneCount = done.length;
  const processingCount = receipts.filter(r => r.status === "processing").length;

  const downloadCSV = () => {
    if (!doneCount) return;
    const csv = entryType === "sales" ? toSalesCSV(bizCode, done, isVatRegistered) : toCSV(bizCode, done);
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = buildFilename(bizCode, "csv");
    a.click();
  };

  const downloadPDF = async () => {
    if (!doneCount) return;
    setGeneratingPDF(true);
    try { await generatePDF(bizCode, done, buildFilename(bizCode, "pdf"), entryType); }
    catch (e) { setGlobalError("PDF generation failed. Please try again."); }
    finally { setGeneratingPDF(false); }
  };

  const sendEmail = async () => {
    if (!doneCount) return;
    setSendingEmail(true);
    try {
      // Generate PDF as base64
      const pdfBase64 = await generatePDFBase64(bizCode, done, entryType);
      const csvContent = toCSV(bizCode, done);
      const csvBase64 = btoa(unescape(encodeURIComponent(csvContent)));
      const filename = buildFilename(bizCode, "");
      const email = user?.emailAddresses?.[0]?.emailAddress;
      const token = await getToken() ?? "";
      const res = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ to: email, bizCode, filename, pdfBase64, csvBase64 })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to send");
      setGlobalError(null);
      alert(`✓ Files sent to ${email}`);
    } catch (e) {
      setGlobalError("Email failed: " + e.message);
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f4f3f0", fontFamily: "'Lato', sans-serif", color: "#1a1a2e" }}>
      <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet" />

      {/* Lightbox */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 2000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20
        }}>
          <div onClick={e => e.stopPropagation()} style={{ position: "relative", maxWidth: "95vw", maxHeight: "92vh" }}>
            <img src={lightbox} alt="Receipt" style={{
              maxWidth: "100%", maxHeight: "88vh", borderRadius: 8,
              boxShadow: "0 8px 40px rgba(0,0,0,0.5)", display: "block"
            }} />
            <button onClick={() => setLightbox(null)} style={{
              position: "absolute", top: -14, right: -14, width: 32, height: 32,
              borderRadius: "50%", background: "#fff", border: "none", fontSize: 18,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)", fontWeight: 700, color: "#333"
            }}>×</button>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="topbar-pad" style={{
        background: "#1a1a2e", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 56, borderBottom: "3px solid #2a5298"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div className="topbar-brand" style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700 }}>LedgerScan</div>
          <div style={{ width: 1, height: 20, background: "#2a5298" }} />
          <div style={{ fontSize: 13, color: "#7eb8f7", fontWeight: 700, letterSpacing: "0.06em" }}>{bizCode}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 4, background: entryType === "sales" ? "#166534" : "#1e3a5f", color: entryType === "sales" ? "#86efac" : "#7eb8f7", border: `1px solid ${entryType === "sales" ? "#16a34a44" : "#2a529844"}` }}>
              {entryType === "sales" ? "Sales" : "Expenses"}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 4, background: isVatRegistered ? "#3b1f00" : "#2d1f00", color: isVatRegistered ? "#fbbf24" : "#f87171", border: `1px solid ${isVatRegistered ? "#d9770644" : "#ef444444"}` }}>
              {isVatRegistered ? "VAT" : "Non-VAT"}
            </span>
          </div>
        </div>
        <div className="topbar-actions" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {processingCount > 0 && (
            <div style={{ fontSize: 12, color: "#7eb8f7", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>◌</span>
              Processing {processingCount}...
            </div>
          )}
          {receipts.length > 0 && <span style={{ fontSize: 12, color: "#8899bb" }}>{doneCount}/{receipts.length} ready</span>}
          <button onClick={downloadPDF} disabled={doneCount === 0 || generatingPDF} style={{
            background: doneCount > 0 && !generatingPDF ? "#c0392b" : "#2a3050",
            color: doneCount > 0 && !generatingPDF ? "#fff" : "#4a5070",
            border: "none", borderRadius: 4, padding: "8px 16px", fontSize: 12,
            fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 && !generatingPDF ? "pointer" : "not-allowed",
            letterSpacing: "0.06em", textTransform: "uppercase"
          }}>{generatingPDF ? "⟳ Building..." : "↓ PDF"}</button>
          <button onClick={downloadCSV} disabled={doneCount === 0} style={{
            background: doneCount > 0 ? "#2a5298" : "#2a3050",
            color: doneCount > 0 ? "#fff" : "#4a5070",
            border: "none", borderRadius: 4, padding: "8px 16px", fontSize: 12,
            fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 ? "pointer" : "not-allowed",
            letterSpacing: "0.06em", textTransform: "uppercase"
          }}>↓ CSV</button>
          <button onClick={sendEmail} disabled={doneCount === 0 || sendingEmail} style={{
            background: doneCount > 0 && !sendingEmail ? "#15803d" : "#2a3050",
            color: doneCount > 0 && !sendingEmail ? "#fff" : "#4a5070",
            border: "none", borderRadius: 4, padding: "8px 16px", fontSize: 12,
            fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 && !sendingEmail ? "pointer" : "not-allowed",
            letterSpacing: "0.06em", textTransform: "uppercase"
          }}>{sendingEmail ? "⟳ Sending..." : "✉ Email"}</button>
          {isAdmin && (
            <button onClick={() => { setShowAdmin(true); loadAdminData(); }} style={{
              background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 4, padding: "6px 12px", fontSize: 11, fontWeight: 700,
              color: "#fbbf24", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.06em"
            }}>⚙ Admin</button>
          )}
          {isSignedIn
            ? <UserMenu />
            : <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: freeScansLeft <= 1 ? "#f87171" : "#7eb8f7" }}>
                  {freeScansLeft} free scan{freeScansLeft !== 1 ? "s" : ""} left
                </span>
                <SignInButton mode="modal">
                  <button style={{ background: "#2a5298", color: "#fff", border: "none", borderRadius: 4, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    Sign In
                  </button>
                </SignInButton>
              </div>
          }
        </div>
      </div>

      {/* Sub-bar */}
      <div className="subbar-pad" style={{ background: "#eeecea", borderBottom: "1px solid #dddad6", display: "flex", gap: 20, alignItems: "center", fontSize: 11 }}>
        <span style={{ color: "#888" }}>Field type:</span>
        <TAG color="#2a5298">AI extracted</TAG>
        <TAG color="#b45309">Manual entry</TAG>
        <button onClick={() => { setBizCode(""); setReceipts([]); }} style={{
          marginLeft: "auto", background: "none", border: "1px solid #ccc", borderRadius: 4,
          padding: "3px 12px", fontSize: 11, color: "#888", cursor: "pointer"
        }}>← Change Business Code</button>
        <span className="subbar-right" style={{ color: "#aaa", fontSize: 11 }}>
          {isSignedIn ? `Signed in as ${user?.emailAddresses?.[0]?.emailAddress}` : "Guest session"}
        </span>
      </div>

      <div className="page-pad" style={{ maxWidth: 1300, margin: "0 auto" }}>
        {globalError && (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: "#b91c1c", display: "flex", justifyContent: "space-between" }}>
            <span>⚠ {globalError}</span>
            <button onClick={() => setGlobalError(null)} style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer" }}>×</button>
          </div>
        )}

        {/* Upload zone */}
        <div
          onDrop={onDrop}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onClick={() => fileRef.current.click()}
          className="upload-zone"
          style={{
            border: `2px dashed ${dragging ? "#2a5298" : "#c8c4be"}`,
            background: dragging ? "#eef3fb" : "#fff"
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 10 }}>📂</div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Upload Receipt Images</div>
          <div style={{ fontSize: 12, color: "#999" }}>Drag & drop or click to browse · JPG, PNG, WEBP · Multiple files</div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => processFiles(e.target.files)} />
        </div>

        {/* Disclaimer */}
        <div style={{
          background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8,
          padding: "10px 16px", marginBottom: 20,
          display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12, color: "#92400e"
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
          <span>
            <strong>AI Disclaimer:</strong> AI can make mistakes, especially with handwritten receipts.
            Always double-check extracted fields by tapping the receipt thumbnail to view the original image.
          </span>
        </div>

        {receipts.length === 0 && (
          <div style={{ textAlign: "center", color: "#bbb", fontSize: 13, marginTop: 40, fontStyle: "italic" }}>
            No receipts uploaded yet.
          </div>
        )}

        {receipts.map((r, idx) => {
          const isExpanded = expandedId === r.id;
          const statusStyles = {
            pending:    { bg: "#f3f4f6", color: "#6b7280", label: "Queued" },
            processing: { bg: "#eff6ff", color: "#2a5298", label: "Scanning..." },
            done:       { bg: "#f0fdf4", color: "#15803d", label: "Complete" },
            error:      { bg: "#fef2f2", color: "#b91c1c", label: "Error" },
          }[r.status];
          return (
            <div key={r.id} style={{
              background: "#fff", borderRadius: 8, marginBottom: 12,
              border: "1px solid #e5e2de",
              boxShadow: isExpanded ? "0 4px 20px rgba(0,0,0,0.08)" : "0 1px 4px rgba(0,0,0,0.04)",
              overflow: "hidden", animation: "fadeIn 0.3s ease forwards",
              animationDelay: `${idx * 0.04}s`, opacity: 0
            }}>
              <div onClick={() => setExpandedId(isExpanded ? null : r.id)} className="card-row" style={{
                display: "flex", alignItems: "center",
                cursor: "pointer", background: isExpanded ? "#f8f7f5" : "#fff",
                borderBottom: isExpanded ? "1px solid #e5e2de" : "none", transition: "background 0.15s"
              }}>
                <img
                  src={r.preview} alt=""
                  onClick={e => { e.stopPropagation(); setLightbox(r.preview); }}
                  style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e2de", flexShrink: 0, cursor: "zoom-in" }}
                  title="Tap to view receipt"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", marginBottom: 2 }}>{r.data.supplierName || r.data.invoiceReceipt || r.file.name}</div>
                  <div style={{ fontSize: 12, color: "#999", display: "flex", gap: 16 }}>
                    {r.data.accountDate && <span>📅 {r.data.accountDate}</span>}
                    {r.data.totalAmountDue && <span>💰 {r.data.totalAmountDue}</span>}
                    {r.data.expenseType && <span>🏷 {r.data.expenseType}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, fontWeight: 700, background: statusStyles.bg, color: statusStyles.color, letterSpacing: "0.05em", textTransform: "uppercase" }}>{statusStyles.label}</span>
                  <span style={{ color: "#bbb", fontSize: 12, display: "inline-block", transform: isExpanded ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}>▾</span>
                  <button onClick={e => { e.stopPropagation(); removeReceipt(r.id); }} style={{ background: "none", border: "1px solid #e5e2de", color: "#bbb", cursor: "pointer", fontSize: 14, borderRadius: 4, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "#fca5a5"; e.currentTarget.style.color = "#b91c1c"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e2de"; e.currentTarget.style.color = "#bbb"; }}
                  >×</button>
                </div>
              </div>
              {isExpanded && (
                <div className="card-body">
                  {r.status === "processing" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                      {ALL_KEYS.map(k => (
                        <div key={k}>
                          <div style={{ height: 10, width: "40%", background: "#f0f0f0", borderRadius: 3, marginBottom: 8 }} />
                          <div style={{ height: 36, background: "linear-gradient(90deg,#f0f0f0,#e8e8e8,#f0f0f0)", backgroundSize: "200% 100%", borderRadius: 4, animation: "shimmer 1.5s infinite" }} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#2a5298", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                          <span>AI Extracted Fields</span><div style={{ flex: 1, height: 1, background: "#dbeafe" }} />
                        </div>
                        <div className="fields-grid">
                          {entryType === "sales"
                            ? SALES_FIELDS.filter(f => f.ai && (isVatRegistered !== false || (f.key !== "vatableSales" && f.key !== "vat"))).map(f => (
                                <FieldInput key={f.key} field={f} value={r.data[f.key]} onChange={v => updateField(r.id, f.key, v)} accentColor="#2a5298" />
                              ))
                            : FIELDS.filter(f => f.ai && (isVatRegistered !== false || f.key !== "inputVAT")).map(f => (
                                <FieldInput key={f.key} field={f} value={r.data[f.key]} onChange={v => updateField(r.id, f.key, v)} accentColor="#2a5298" />
                              ))
                          }
                          {entryType !== "sales" && (
                            <>
                              {/* Total Expense — auto-computed from VATable + NonVAT */}
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                                  Total Expense
                                  <span style={{ fontSize: 9, background: "#dcfce7", color: "#15803d", padding: "1px 6px", borderRadius: 3, fontWeight: 600, letterSpacing: "0.05em" }}>COMPUTED</span>
                                </div>
                                <div style={{ padding: "8px 12px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, fontSize: 13, color: "#15803d", fontWeight: 600 }}>
                                  {computeTotalExpense(r.data) || <span style={{ color: "#d1d5db", fontWeight: 400 }}>VATable + NonVAT</span>}
                                </div>
                              </div>
                              {/* Total Amount Due — AI extracted */}
                              <FieldInput
                                field={{ key: "totalAmountDue", label: "Total Amount Due", ai: true }}
                                value={r.data.totalAmountDue}
                                onChange={v => updateField(r.id, "totalAmountDue", v)}
                                accentColor="#2a5298"
                              />
                            </>
                          )}
                          {/* Reference Code — auto-built but editable */}
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                              Reference Code
                              <span style={{ fontSize: 9, background: "#dbeafe", color: "#2a5298", padding: "1px 6px", borderRadius: 3, fontWeight: 600, letterSpacing: "0.05em" }}>AUTO</span>
                            </div>
                            <input
                              value={r.data.referenceCode || buildReferenceCode(bizCode, r.data)}
                              onChange={e => updateField(r.id, "referenceCode", e.target.value)}
                              style={{ width: "100%", padding: "8px 12px", fontSize: 13, borderRadius: 6, border: "1px solid #e5e2de", outline: "none", background: "#fafafa", fontFamily: "inherit" }}
                              onFocus={e => { if (!r.data.referenceCode) updateField(r.id, "referenceCode", buildReferenceCode(bizCode, r.data)); e.target.style.borderColor = "#2a5298"; }}
                              onBlur={e => e.target.style.borderColor = "#e5e2de"}
                            />
                          </div>
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#b45309", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                          <span>Manual Entry Fields</span><div style={{ flex: 1, height: 1, background: "#fde68a" }} />
                        </div>
                        <div className="fields-grid">
                          {(entryType === "sales" ? SALES_FIELDS : FIELDS).filter(f => !f.ai).map(f => (
                            <FieldInput key={f.key} field={f} value={r.data[f.key]} onChange={v => updateField(r.id, f.key, v)} accentColor="#b45309" />
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {receipts.length > 0 && (
          <div className="export-bar" style={{ marginTop: 20, background: "#fff", borderRadius: 8, border: "1px solid #e5e2de", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, color: "#666" }}>
              <strong style={{ color: "#1a1a2e" }}>{doneCount}</strong> of <strong style={{ color: "#1a1a2e" }}>{receipts.length}</strong> receipts processed
              {doneCount > 0 && <span style={{ marginLeft: 16, color: "#15803d" }}>✓ Ready to export</span>}
              {doneCount > 0 && <span style={{ marginLeft: 16, color: "#888", fontSize: 12 }}>PDF: {Math.ceil(doneCount / 2)} page{Math.ceil(doneCount / 2) !== 1 ? "s" : ""}</span>}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={downloadPDF} disabled={doneCount === 0 || generatingPDF} style={{ background: doneCount > 0 && !generatingPDF ? "#c0392b" : "#f3f4f6", color: doneCount > 0 && !generatingPDF ? "#fff" : "#9ca3af", border: "none", borderRadius: 6, padding: "10px 20px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 && !generatingPDF ? "pointer" : "not-allowed" }}>
                {generatingPDF ? "⟳ Building..." : "↓ Download PDF"}
              </button>
              <button onClick={downloadCSV} disabled={doneCount === 0} style={{ background: doneCount > 0 ? "#1a1a2e" : "#f3f4f6", color: doneCount > 0 ? "#fff" : "#9ca3af", border: "none", borderRadius: 6, padding: "10px 20px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 ? "pointer" : "not-allowed" }}>
                ↓ Download CSV
              </button>
              <button onClick={sendEmail} disabled={doneCount === 0 || sendingEmail} style={{ background: doneCount > 0 && !sendingEmail ? "#15803d" : "#f3f4f6", color: doneCount > 0 && !sendingEmail ? "#fff" : "#9ca3af", border: "none", borderRadius: 6, padding: "10px 20px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 && !sendingEmail ? "pointer" : "not-allowed" }}>
                {sendingEmail ? "⟳ Sending..." : "✉ Email to Me"}
              </button>
            </div>
          </div>
        )}

        {doneCount > 0 && (
          <div style={{ marginTop: 24, background: "#fff", borderRadius: 8, border: "1px solid #e5e2de", overflow: "hidden" }}>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #f0ece8", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#666" }}>Data Preview</span>
              <span style={{ fontSize: 11, color: "#aaa" }}>— {doneCount} row{doneCount !== 1 ? "s" : ""}</span>
            </div>
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit", whiteSpace: "nowrap" }}>
                <thead>
                  <tr style={{ background: "#f8f7f5" }}>
                    {(entryType === "sales"
                      ? ["#", "Date", "Invoice/OR", "Client Name", "Sales Type", "Total Billing", ...(isVatRegistered ? ["VATable Sales", "VAT"] : []), "Client Code", "Ref Code"]
                      : ["#", "Date", "Invoice/OR", "Supplier", "Expense Type", "VATable", "NonVAT", ...(isVatRegistered ? ["Input VAT"] : []), "Total Expense", "Total Amt Due", "Supplier Code", "Ref Code"]
                    ).map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#888", borderBottom: "1px solid #e5e2de" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {done.map((r, i) => {
                    const refCode = r.data.referenceCode || buildReferenceCode(bizCode, r.data);
                    const cells = entryType === "sales"
                      ? [i + 1, r.data.accountDate, r.data.invoiceReceipt, r.data.customerName, r.data.salesType, r.data.totalBilling, ...(isVatRegistered ? [r.data.vatableSales, r.data.vat] : []), r.data.customerCode, refCode]
                      : [i + 1, r.data.accountDate, r.data.invoiceReceipt, r.data.supplierName, r.data.expenseType, r.data.vatablePurchase, r.data.nonVAT, ...(isVatRegistered ? [r.data.inputVAT] : []), computeTotalExpense(r.data), r.data.totalAmountDue, r.data.supplierCode, refCode];
                    return (
                      <tr key={r.id} style={{ borderBottom: "1px solid #f0ece8", background: i % 2 === 0 ? "#fff" : "#fafaf9" }}>
                        {cells.map((v, ci) => (
                          <td key={ci} style={{ padding: "7px 12px", color: v ? "#1a1a2e" : "#ccc", fontSize: 12 }}>{v || "—"}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      <style>{`
        @keyframes shimmer { 0% { background-position:200% 0 } 100% { background-position:-200% 0 } }
        @keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        * { box-sizing: border-box; }
        input::placeholder { color: #ccc; }

        .fields-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
        .page-pad { padding: 28px 40px; }
        .topbar-pad { padding: 0 40px; }
        .subbar-pad { padding: 8px 40px; }
        .card-row { display: flex; align-items: center; gap: 16px; padding: 14px 20px; }
        .card-body { padding: 20px 24px; }
        .export-bar { margin-top: 20px; padding: 16px 24px; background: #fff; border-radius: 8; border: 1px solid #e5e2de; display: flex; align-items: center; justify-content: space-between; }
        .upload-zone { border-radius: 8px; padding: 36px; text-align: center; cursor: pointer; margin-bottom: 28px; transition: all 0.2s; }
        .biz-screen-width { width: 400px; }

        @media (max-width: 640px) {
          .fields-grid { grid-template-columns: 1fr !important; gap: 12px !important; }
          .page-pad { padding: 16px !important; }
          .topbar-pad { padding: 0 16px !important; height: auto !important; flex-wrap: wrap; gap: 8px; padding-top: 10px !important; padding-bottom: 10px !important; }
          .subbar-pad { padding: 8px 16px !important; flex-wrap: wrap; gap: 8px; }
          .card-row { padding: 12px 14px !important; gap: 10px !important; }
          .card-body { padding: 14px 14px !important; }
          .upload-zone { padding: 24px 16px !important; margin-bottom: 16px !important; }
          .biz-screen-width { width: 100% !important; padding: 0 16px; }
          .export-bar { flex-direction: column !important; gap: 12px !important; align-items: stretch !important; }
          .export-bar > div:last-child { display: flex; flex-direction: column; gap: 8px; }
          .export-bar button { width: 100% !important; padding: 13px !important; font-size: 14px !important; }
          .topbar-actions { flex-wrap: wrap; gap: 8px !important; justify-content: flex-end; }
          .topbar-brand { font-size: 16px !important; }
          .subbar-right { display: none !important; }
        }
      `}</style>

      {/* Admin panel */}
      {showAdmin && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 800, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid #e5e2de" }}>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: "#1a1a2e" }}>Admin — Usage Stats</div>
              <button onClick={() => setShowAdmin(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#999" }}>×</button>
            </div>

            {adminLoading && <div style={{ padding: 40, textAlign: "center", color: "#888" }}>Loading...</div>}

            {!adminLoading && adminData && (
              <div style={{ padding: 24 }}>
                {/* Summary cards */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
                  {[
                    { label: "Total Users", value: adminData.summary.totalUsers },
                    { label: "Total Scans", value: adminData.summary.totalScans },
                    { label: "Total Cost (USD)", value: `$${adminData.summary.totalCost.usd}` },
                    { label: "Total Cost (PHP)", value: `₱${adminData.summary.totalCost.php}` },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: "#f8f7f5", borderRadius: 8, padding: "16px", border: "1px solid #e5e2de" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#999", marginBottom: 6 }}>{label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: "#1a1a2e" }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Per-user table */}
                <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid #e5e2de" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, whiteSpace: "nowrap" }}>
                    <thead>
                      <tr style={{ background: "#f8f7f5" }}>
                        {["User ID", "Plan", "This Month", "Total Scans", "Input Tokens", "Output Tokens", "Cost (USD)", "Cost (PHP)"].map(h => (
                          <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#888", borderBottom: "1px solid #e5e2de" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {adminData.users.map((u, i) => (
                        <tr key={u.userId} style={{ borderBottom: "1px solid #f0ece8", background: i % 2 === 0 ? "#fff" : "#fafaf9" }}>
                          <td style={{ padding: "9px 14px", color: "#666", fontFamily: "monospace", fontSize: 11 }}>{u.userId}</td>
                          <td style={{ padding: "9px 14px" }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: u.premium ? "#fef3c7" : "#f3f4f6", color: u.premium ? "#b45309" : "#6b7280" }}>
                              {u.premium ? "Premium" : "Free"}
                            </span>
                          </td>
                          <td style={{ padding: "9px 14px", fontWeight: 700, color: u.scansThisMonth >= 50 && !u.premium ? "#c0392b" : "#1a1a2e" }}>{u.scansThisMonth}{!u.premium && ` / 50`}</td>
                          <td style={{ padding: "9px 14px", color: "#555" }}>{Number(u.scans).toLocaleString()}</td>
                          <td style={{ padding: "9px 14px", color: "#555" }}>{u.tokens.input.toLocaleString()}</td>
                          <td style={{ padding: "9px 14px", color: "#555" }}>{u.tokens.output.toLocaleString()}</td>
                          <td style={{ padding: "9px 14px", color: "#15803d", fontWeight: 600 }}>${u.cost.usd}</td>
                          <td style={{ padding: "9px 14px", color: "#b45309", fontWeight: 600 }}>₱{u.cost.php}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sign-up modal for guests who hit the free limit */}
      {showSignUp && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 16, padding: 40, maxWidth: 400, width: "100%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#1a1a2e", marginBottom: 8 }}>
              You've used your {FREE_SCAN_LIMIT} free scans
            </div>
            <div style={{ fontSize: 13, color: "#888", marginBottom: 28, lineHeight: 1.6 }}>
              Sign up for free to keep scanning receipts with no interruptions.
            </div>
            <SignInButton mode="modal">
              <button style={{ width: "100%", padding: "13px", borderRadius: 8, border: "none", background: "#1a1a2e", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.06em", marginBottom: 12 }}>
                Sign Up — It's Free
              </button>
            </SignInButton>
            <button onClick={() => setShowSignUp(false)} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              Maybe later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────
export default function App() {
  return <Dashboard />;
}
