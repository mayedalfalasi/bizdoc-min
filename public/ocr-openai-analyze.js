document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("pdfInput");
  const btn = document.getElementById("analyzeBtn");
  const status = document.getElementById("status");

  btn.onclick = async () => {
    const f = input.files?.[0];
    if (!f) {
      alert("Please select a PDF file first.");
      return;
    }

    status.textContent = "Uploading and analyzing... please wait ⏳";

    const fd = new FormData();
    fd.append("file", f, f.name);
    fd.append("language", "eng");
    fd.append("filename", f.name.replace(/\.pdf$/i, "") + "_BizDoc");

    try {
      const res = await fetch("/api/upload-ocr-openai-download", {
        method: "POST",
        body: fd,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Server error");
      }

      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (fd.get("filename") || "BizDoc_Report") + ".pdf";
      a.click();
      URL.revokeObjectURL(a.href);

      status.textContent = "✅ Analysis complete — PDF downloaded.";
    } catch (err) {
      console.error("Upload error:", err);
      status.textContent = "❌ " + err.message;
      alert("Error: " + err.message);
    }
  };
});
