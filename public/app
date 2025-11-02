const form = document.getElementById('analyzeForm');
const fileInput = document.getElementById('file');
const instructionInput = document.getElementById('instruction');
const analyzeBtn = document.getElementById('analyzeBtn');
const downloadBtn = document.getElementById('downloadBtn');
const output = document.getElementById('output');
const statusEl = document.getElementById('status');

let lastPayload = null;

function setBusy(isBusy, msg='') {
  analyzeBtn.disabled = isBusy;
  downloadBtn.disabled = isBusy || !lastPayload;
  statusEl.textContent = msg;
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) { alert('Please choose a file'); return; }
  setBusy(true, 'Analyzing…');

  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (instructionInput.value.trim()) fd.append('instruction', instructionInput.value.trim());

    const resp = await fetch('/api/analyze', { method: 'POST', body: fd });
    const text = await resp.text();

    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    output.textContent = JSON.stringify({ status: resp.status, ok: resp.ok, body }, null, 2);

    if (resp.ok && body && body.ok && body.analysis) {
      lastPayload = {
        filenameBase: body.filenameBase || (file.name.replace(/\.[^.]+$/, '') || 'analysis'),
        analysis: body.analysis,
        charts: Array.isArray(body.charts) ? body.charts : []
      };
      downloadBtn.disabled = false;
      setBusy(false, 'Done.');
    } else {
      lastPayload = null;
      downloadBtn.disabled = true;
      setBusy(false, 'Analyze error.');
    }
  } catch (err) {
    output.textContent = JSON.stringify({ error: String(err) }, null, 2);
    lastPayload = null;
    downloadBtn.disabled = true;
    setBusy(false, 'Request failed.');
  }
});

downloadBtn?.addEventListener('click', async () => {
  if (!lastPayload) return;
  setBusy(true, 'Building PDF…');
  try {
    const resp = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastPayload)
    });
    const blob = await resp.blob();

    // If server errored with JSON, show it instead of downloading garbage
    if (!resp.ok && blob.type.includes('application/json')) {
      const text = await blob.text();
      output.textContent = JSON.stringify({ downloadStatus: resp.status, body: JSON.parse(text) }, null, 2);
      setBusy(false, 'Download failed.');
      return;
    }

    const cd = resp.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/i);
    const name = (m && m[1]) || (lastPayload.filenameBase || 'report') + '.pdf';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setBusy(false, 'PDF downloaded.');
  } catch (err) {
    output.textContent = JSON.stringify({ downloadError: String(err) }, null, 2);
    setBusy(false, 'Download failed.');
  }
});
