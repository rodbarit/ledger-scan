import { useState, useRef, useCallback } from "react";
import {
  SignedIn, SignedOut, SignIn, useUser, useClerk
} from "@clerk/clerk-react";

// ── Field definitions ──────────────────────────────────────────────────────
const FIELDS = [
  { key: "accountDate",     label: "Account Date",      ai: true  },
  { key: "invoiceReceipt",  label: "Invoice / Receipt",  ai: true  },
  { key: "expenseType",     label: "Expense Type",       ai: true  },
  { key: "totalExpense",    label: "Total Expense",      ai: true  },
  { key: "vatablePurchase", label: "VATable Purchase",   ai: true  },
  { key: "inputVAT",        label: "Input VAT",          ai: true  },
  { key: "referenceCode",   label: "Reference Code",     ai: false },
  { key: "businessCode",    label: "Business Code",      ai: false },
  { key: "supplierCode",    label: "Supplier Code",      ai: false },
];
const ALL_KEYS = FIELDS.map(f => f.key);
const EMPTY_DATA = () => Object.fromEntries(ALL_KEYS.map(k => [k, ""]));

// ── API helpers ────────────────────────────────────────────────────────────
async function extractReceiptData(base64, mediaType, token) {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ base64, mediaType })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Extraction failed");
  return json.data;
}

function toCSV(rows) {
  const header = FIELDS.map(f => f.label);
  const lines = [header.join(","), ...rows.map(r =>
    ALL_KEYS.map(k => `"${(r[k] || "").replace(/"/g, '""')}"`).join(",")
  )];
  return lines.join("\n");
}

async function generatePDF(receipts) {
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
  const pageW = 210, pageH = 297, margin = 10, footerH = 18, headerH = 14;
  const cols = 2, rows = 2;
  const cellW = (pageW - margin * 2 - 6) / cols;
  const cellH = (pageH - margin * 2 - headerH - footerH - 6) / rows;
  const pages = [];
  for (let i = 0; i < receipts.length; i += 4) pages.push(receipts.slice(i, i + 4));

  for (let p = 0; p < pages.length; p++) {
    if (p > 0) pdf.addPage();
    const group = pages[p];
    pdf.setFillColor(26, 26, 46);
    pdf.rect(margin, margin, pageW - margin * 2, headerH, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(11); pdf.setFont("helvetica", "bold");
    pdf.text("LedgerScan — Receipt Archive", margin + 4, margin + 8);
    pdf.setFontSize(8); pdf.setFont("helvetica", "normal");
    pdf.setTextColor(160, 180, 220);
    const dateStr = new Date().toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
    pdf.text(`Page ${p + 1} of ${pages.length}  ·  ${dateStr}`, pageW - margin - 4, margin + 8, { align: "right" });

    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const col = i % cols, row = Math.floor(i / cols);
      const x = margin + col * (cellW + 6);
      const y = margin + headerH + 4 + row * (cellH + 6);
      pdf.setDrawColor(220, 218, 214); pdf.setLineWidth(0.3);
      pdf.rect(x, y, cellW, cellH);
      if (r.preview) {
        try {
          const imgData = await getImageDataURL(r.preview, r.file?.type || "image/jpeg");
          const imgFormat = (r.file?.type || "").includes("png") ? "PNG" : "JPEG";
          pdf.addImage(imgData, imgFormat, x + 1, y + 1, cellW - 2, cellH - footerH - 2, "", "FAST");
        } catch {}
      }
      const fy = y + cellH - footerH;
      pdf.setFillColor(26, 26, 46);
      pdf.rect(x, fy, cellW, footerH, "F");
      const colW4 = cellW / 4;
      pdf.setFontSize(6.5); pdf.setFont("helvetica", "bold"); pdf.setTextColor(160, 180, 220);
      pdf.text("REF CODE", x + 2, fy + 4.5);
      pdf.text("SUPPLIER", x + colW4 + 2, fy + 4.5);
      pdf.text("CATEGORY", x + colW4 * 2 + 2, fy + 4.5);
      pdf.text("TOTAL", x + colW4 * 3 + 2, fy + 4.5);
      pdf.setFont("helvetica", "normal"); pdf.setTextColor(255, 255, 255); pdf.setFontSize(7);
      const tr = (s, n) => s.length > n ? s.slice(0, n) + "…" : s;
      pdf.text(tr(r.data.referenceCode || "—", 10), x + 2, fy + 11);
      pdf.text(tr(r.data.supplierCode || r.data.invoiceReceipt || "—", 10), x + colW4 + 2, fy + 11);
      pdf.text(tr(r.data.expenseType || "—", 10), x + colW4 * 2 + 2, fy + 11);
      pdf.text(tr(r.data.totalExpense || "—", 10), x + colW4 * 3 + 2, fy + 11);
    }
    pdf.setFontSize(7); pdf.setTextColor(180, 180, 180); pdf.setFont("helvetica", "normal");
    pdf.text("Confidential — For accounting purposes only", pageW / 2, pageH - 5, { align: "center" });
  }
  pdf.save(`receipts-${new Date().toISOString().slice(0, 10)}.pdf`);
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
          Receipt Processing v2.0
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

// ── Main app (only shown when signed in) ──────────────────────────────────
function Dashboard() {
  const { user } = useUser();
  const [receipts, setReceipts] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [globalError, setGlobalError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const fileRef = useRef();

  const processFiles = useCallback(async (files) => {
    setGlobalError(null);
    const newItems = Array.from(files).map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f, preview: URL.createObjectURL(f),
      status: "pending", error: null, data: EMPTY_DATA()
    }));
    setReceipts(prev => [...prev, ...newItems]);
    setExpandedId(newItems[0]?.id ?? null);

    // Get Clerk session token to authenticate API calls
    const token = await window.__clerk_session?.getToken() ?? "";

    for (const item of newItems) {
      setReceipts(prev => prev.map(r => r.id === item.id ? { ...r, status: "processing" } : r));
      try {
        const base64 = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(item.file);
        });
        const extracted = await extractReceiptData(base64, item.file.type || "image/jpeg", token);
        setReceipts(prev => prev.map(r => r.id === item.id
          ? { ...r, status: "done", data: { ...EMPTY_DATA(), ...extracted } } : r));
      } catch (e) {
        if (e.message?.toLowerCase().includes("daily limit")) setGlobalError(e.message);
        setReceipts(prev => prev.map(r => r.id === item.id ? { ...r, status: "error", error: e.message } : r));
      }
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const updateField = (id, key, value) =>
    setReceipts(prev => prev.map(r => r.id === id ? { ...r, data: { ...r.data, [key]: value } } : r));

  const removeReceipt = (id) => {
    setReceipts(prev => prev.filter(r => r.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const downloadCSV = () => {
    const done = receipts.filter(r => r.status === "done");
    if (!done.length) return;
    const blob = new Blob([toCSV(done.map(r => r.data))], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `receipts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const downloadPDF = async () => {
    const done = receipts.filter(r => r.status === "done");
    if (!done.length) return;
    setGeneratingPDF(true);
    try { await generatePDF(done); }
    catch (e) { setGlobalError("PDF generation failed. Please try again."); }
    finally { setGeneratingPDF(false); }
  };

  const doneCount = receipts.filter(r => r.status === "done").length;
  const processingCount = receipts.filter(r => r.status === "processing").length;

  return (
    <div style={{ minHeight: "100vh", background: "#f4f3f0", fontFamily: "'Lato', sans-serif", color: "#1a1a2e" }}>
      <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet" />

      {/* Top bar */}
      <div style={{
        background: "#1a1a2e", color: "#fff", padding: "0 40px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 56, borderBottom: "3px solid #2a5298"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700 }}>LedgerScan</div>
          <div style={{ width: 1, height: 20, background: "#2a5298" }} />
          <div style={{ fontSize: 11, color: "#8899bb", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Receipt Processing v2.0
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
            fontFamily: "inherit", fontWeight: 700,
            cursor: doneCount > 0 && !generatingPDF ? "pointer" : "not-allowed",
            letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.2s"
          }}>{generatingPDF ? "⟳ Building..." : "↓ PDF"}</button>
          <button onClick={downloadCSV} disabled={doneCount === 0} style={{
            background: doneCount > 0 ? "#2a5298" : "#2a3050",
            color: doneCount > 0 ? "#fff" : "#4a5070",
            border: "none", borderRadius: 4, padding: "8px 16px", fontSize: 12,
            fontFamily: "inherit", fontWeight: 700,
            cursor: doneCount > 0 ? "pointer" : "not-allowed",
            letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.2s"
          }}>↓ CSV</button>
          <UserMenu />
        </div>
      </div>

      {/* Legend */}
      <div style={{ background: "#eeecea", borderBottom: "1px solid #dddad6", padding: "8px 40px", display: "flex", gap: 20, alignItems: "center", fontSize: 11 }}>
        <span style={{ color: "#888" }}>Field type:</span>
        <TAG color="#2a5298">AI extracted</TAG>
        <TAG color="#b45309">Manual entry</TAG>
        <span style={{ marginLeft: "auto", color: "#aaa", fontSize: 11 }}>
          Signed in as {user?.emailAddresses?.[0]?.emailAddress} · 20 scans/day
        </span>
      </div>

      <div style={{ padding: "28px 40px", maxWidth: 1300, margin: "0 auto" }}>
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
          style={{
            border: `2px dashed ${dragging ? "#2a5298" : "#c8c4be"}`,
            borderRadius: 8, padding: "36px", textAlign: "center",
            cursor: "pointer", marginBottom: 28, transition: "all 0.2s",
            background: dragging ? "#eef3fb" : "#fff"
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 10 }}>📂</div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Upload Receipt Images</div>
          <div style={{ fontSize: 12, color: "#999" }}>Drag & drop or click to browse · JPG, PNG, WEBP · Multiple files</div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => processFiles(e.target.files)} />
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
              <div onClick={() => setExpandedId(isExpanded ? null : r.id)} style={{
                display: "flex", alignItems: "center", gap: 16, padding: "14px 20px",
                cursor: "pointer", background: isExpanded ? "#f8f7f5" : "#fff",
                borderBottom: isExpanded ? "1px solid #e5e2de" : "none", transition: "background 0.15s"
              }}>
                <img src={r.preview} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e2de", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", marginBottom: 2 }}>{r.data.invoiceReceipt || r.file.name}</div>
                  <div style={{ fontSize: 12, color: "#999", display: "flex", gap: 16 }}>
                    {r.data.accountDate && <span>📅 {r.data.accountDate}</span>}
                    {r.data.totalExpense && <span>💰 {r.data.totalExpense}</span>}
                    {r.data.expenseType && <span>🏷 {r.data.expenseType}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 4, fontWeight: 700, background: statusStyles.bg, color: statusStyles.color, letterSpacing: "0.05em", textTransform: "uppercase" }}>{statusStyles.label}</span>
                  <span style={{ color: "#bbb", fontSize: 12, display: "inline-block", transform: isExpanded ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}>▾</span>
                  <button onClick={e => { e.stopPropagation(); removeReceipt(r.id); }} style={{ background: "none", border: "1px solid #e5e2de", color: "#bbb", cursor: "pointer", fontSize: 14, borderRadius: 4, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "#fca5a5"; e.currentTarget.style.color = "#b91c1c"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e2de"; e.currentTarget.style.color = "#bbb"; }}
                  >×</button>
                </div>
              </div>

              {isExpanded && (
                <div style={{ padding: "20px 24px" }}>
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
                          <span>AI Extracted Fields</span>
                          <div style={{ flex: 1, height: 1, background: "#dbeafe" }} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                          {FIELDS.filter(f => f.ai).map(f => <FieldInput key={f.key} field={f} value={r.data[f.key]} onChange={v => updateField(r.id, f.key, v)} accentColor="#2a5298" />)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#b45309", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                          <span>Manual Entry Fields</span>
                          <div style={{ flex: 1, height: 1, background: "#fde68a" }} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                          {FIELDS.filter(f => !f.ai).map(f => <FieldInput key={f.key} field={f} value={r.data[f.key]} onChange={v => updateField(r.id, f.key, v)} accentColor="#b45309" />)}
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
          <div style={{ marginTop: 20, padding: "16px 24px", background: "#fff", borderRadius: 8, border: "1px solid #e5e2de", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 13, color: "#666" }}>
              <strong style={{ color: "#1a1a2e" }}>{doneCount}</strong> of <strong style={{ color: "#1a1a2e" }}>{receipts.length}</strong> receipts processed
              {doneCount > 0 && <span style={{ marginLeft: 16, color: "#15803d" }}>✓ Ready to export</span>}
              {doneCount > 0 && <span style={{ marginLeft: 16, color: "#888", fontSize: 12 }}>PDF: {Math.ceil(doneCount / 4)} page{Math.ceil(doneCount / 4) !== 1 ? "s" : ""}</span>}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={downloadPDF} disabled={doneCount === 0 || generatingPDF} style={{ background: doneCount > 0 && !generatingPDF ? "#c0392b" : "#f3f4f6", color: doneCount > 0 && !generatingPDF ? "#fff" : "#9ca3af", border: "none", borderRadius: 6, padding: "10px 20px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 && !generatingPDF ? "pointer" : "not-allowed", transition: "all 0.2s" }}>
                {generatingPDF ? "⟳ Building..." : "↓ Download PDF"}
              </button>
              <button onClick={downloadCSV} disabled={doneCount === 0} style={{ background: doneCount > 0 ? "#1a1a2e" : "#f3f4f6", color: doneCount > 0 ? "#fff" : "#9ca3af", border: "none", borderRadius: 6, padding: "10px 20px", fontSize: 13, fontFamily: "inherit", fontWeight: 700, cursor: doneCount > 0 ? "pointer" : "not-allowed", transition: "all 0.2s" }}>
                ↓ Download CSV
              </button>
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
      `}</style>
    </div>
  );
}

// ── Root: show login or dashboard ──────────────────────────────────────────
export default function App() {
  return (
    <>
      <SignedOut><LoginScreen /></SignedOut>
      <SignedIn><Dashboard /></SignedIn>
    </>
  );
}
