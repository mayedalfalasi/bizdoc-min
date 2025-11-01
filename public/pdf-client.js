async function fileToText(file) {
  if (!file) return "";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") {
    const buf = await file.arrayBuffer();
    let bin = "", bytes = new Uint8Array(buf), chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  if (ext === "txt" || ext === "docx") return await file.text();
  throw new Error("Unsupported file type: " + ext);
}

async function analyzeAndDownload() {
  const file = document.getElementById("fileInput").files[0];
  const text = document.getElementById("docText").value.trim();
  const status = document.getElementById("status");

  let payload;
  if (file) {
    const data = await fileToText(file);
    payload = { text: data, meta: { filename: file.name, mime: file.type }, filename: file.name.replace(/\.[^/.]+$/, "") };
  } else if (text) {
    payload = { text, meta: { title: "Pasted Text" }, filename: "BizDoc_Report" };
  } else {
    return alert("Please upload or paste a document.");
  }

  status.textContent = "Analyzing with OpenAI and generating PDF...";
  const res = await fetch("/api/download", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    let msg = "PDF generation failed.";
    try { const j = await res.json(); if (j.needsOpenAI) msg = "OpenAI not configured. Add OPENAI_API_KEY in Vercel."; else if (j.error) msg = j.error; } catch {}
    status.textContent = "❌ " + msg;
    return;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: (payload.filename || "BizDoc_Report") + ".pdf" });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  status.textContent = "✅ OpenAI report downloaded.";
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnDownload").addEventListener("click", analyzeAndDownload);
});
