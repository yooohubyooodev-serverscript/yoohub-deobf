(function () {
  'use strict';
  const LURAPH_HEADER = /This file was protected using Luraph Obfuscator v(\d+)(?:\.(\d+))?/;
  const LURAPH_VM_SHAPE = /\[\d+\]=(bit32|buffer|string|table|math)\.\w+/;

  function detectLuraph(source) {
    const m = LURAPH_HEADER.exec(source.slice(0, 500));
    if (m) return { label: 'Luraph v' + m[1], confidence: m[1] === '15' ? 1 : 0.35 };
    const h = source.trimStart().slice(0, 2000);
    if (h.startsWith('return setmetatable({') && (LURAPH_VM_SHAPE.test(h) || source.slice(0, 200000).includes('LPH')))
      return { label: 'Luraph v15 (shape)', confidence: 0.8 };
    return { label: 'ไม่พบลายเซ็น Luraph', confidence: 0 };
  }

  const $ = (id) => document.getElementById(id);
  let lastOutput = '', pollTimer = null;

  function setStatus(t, k) { $('status').textContent = t; $('status').className = 'status ' + (k || 'idle'); }
  function setResult(t, empty) {
    lastOutput = t || '';
    $('result').textContent = t || '—';
    $('result').classList.toggle('empty', !!empty || !t);
    $('btnCopy').disabled = !t;
    $('btnDownload').disabled = !t;
  }

  $('fileInput').addEventListener('change', () => {
    const f = $('fileInput').files && $('fileInput').files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { $('source').value = String(r.result || ''); setStatus('โหลด: ' + f.name, 'ok'); };
    r.readAsText(f);
  });
  $('btnClear').onclick = () => {
    if (pollTimer) clearInterval(pollTimer);
    $('source').value = ''; $('fileInput').value = ''; setResult('', true); setStatus('ล้างแล้ว', 'idle');
  };

  $('btnDetect').onclick = () => {
    const src = $('source').value;
    if (!src.trim()) return setStatus('ยังไม่มีโค้ด', 'err');
    const d = detectLuraph(src);
    setResult(['Detect (เบราว์เซอร์)', 'ประเภท: ' + d.label, 'ความมั่นใจ: ' + Math.round(d.confidence * 100) + '%'].join('\n'), false);
    setStatus(d.confidence >= 0.5 ? 'พบ: ' + d.label : 'ไม่ชัดเจน', d.confidence >= 0.5 ? 'ok' : 'err');
  };

  async function pollJob(id) {
    if (pollTimer) clearInterval(pollTimer);
    const t0 = Date.now();
    const tick = async () => {
      try {
        const res = await fetch('/api/job/' + id);
        const data = await res.json();
        const sec = Math.round((Date.now() - t0) / 1000);
        if (data.status === 'queued' || data.status === 'sent_to_worker') {
          setStatus('รอ worker... (' + sec + 's) ' + data.status, 'run');
          setResult('jobId: ' + id + '\nstatus: ' + data.status, false);
          return;
        }
        clearInterval(pollTimer); pollTimer = null;
        if (data.status === 'done' && data.verified) {
          setResult(data.output || '', false);
          setStatus('สำเร็จ (ยืนยันจาก Server 1 แล้ว) ' + sec + 's', 'ok');
        } else {
          setResult(data.error || data.log || 'error', false);
          setStatus('ไม่สำเร็จ', 'err');
        }
      } catch (e) {
        clearInterval(pollTimer); pollTimer = null;
        setStatus('โพลไม่สำเร็จ', 'err');
        setResult(String(e.message || e), false);
      }
    };
    await tick();
    pollTimer = setInterval(tick, 2000);
  }

  $('btnSubmit').onclick = async () => {
    const src = $('source').value;
    if (!src.trim()) return setStatus('ยังไม่มีโค้ด', 'err');
    if (pollTimer) clearInterval(pollTimer);
    setStatus('ส่งไป Server 1...', 'run');
    const options = {};
    if ($('fastMode').checked) options.noDevirt = true;
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src, options }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      setStatus('สร้าง job แล้ว รอ Server 2...', 'run');
      await pollJob(data.jobId);
    } catch (e) {
      setStatus('ส่งไม่สำเร็จ', 'err');
      setResult(String(e.message || e), false);
    }
  };

  $('btnCopy').onclick = async () => {
    if (!lastOutput) return;
    try { await navigator.clipboard.writeText(lastOutput); setStatus('คัดลอกแล้ว', 'ok'); } catch { setStatus('คัดลอกไม่ได้', 'err'); }
  };
  $('btnDownload').onclick = () => {
    if (!lastOutput) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lastOutput], { type: 'text/plain' }));
    a.download = 'deobfuscated.lua';
    a.click();
  };

  fetch('/api/health').then(r => r.json()).then(d => {
    const w = $('badgeWeb'), k = $('badgeWorker');
    if (d && d.ok) {
      w.textContent = 'Server 1: พร้อม';
      w.className = 'badge ok';
      if (d.workerConfigured) {
        k.textContent = 'Worker: ตั้งค่าแล้ว';
        k.className = 'badge ok';
      } else {
        k.textContent = 'Worker: ยังไม่ตั้ง WORKER_URL';
        k.className = 'badge warn';
      }
      setStatus(d.workerConfigured ? 'พร้อมส่งงาน' : 'ยังไม่มี Worker — ตั้ง WORKER_URL บน Render', d.workerConfigured ? 'ok' : 'idle');
    }
  }).catch(() => {});
})();
