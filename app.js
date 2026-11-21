/* The Actor’s HQ (formerly SAG Tracker) — SAG residual checks, team splits, bills & subscriptions.
 * Data lives in this browser (localStorage + IndexedDB for file scans).
 * Files and backups go to Google Drive through a Google Apps Script web app (see google-drive/Code.gs). */
(() => {
  'use strict';

  // ---------- utilities ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Round half away from zero so a charge and its reversal always cancel exactly (+31.775 -> 31.78, -31.775 -> -31.78).
  const round2 = (n) => { const x = Number(n) || 0; return (Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9)) / 100; };
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? 0 : Number(v));
  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = (n) => moneyFmt.format(Number(n) || 0);
  const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => toISO(new Date());
  const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (s) => (s ? parseISO(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const fmtShort = (s) => (s ? parseISO(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
  const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const sanitize = (s) => String(s).replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);

  const FREQS = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 months', yearly: 'Yearly', once: 'One-time' };
  const PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, semiannual: 1 / 6, yearly: 1 / 12, once: 0 };
  const PAY_METHODS = ['Venmo', 'Zelle', 'PayPal', 'Cash App', 'Apple Cash', 'Check', 'Direct deposit', 'Bank transfer', 'Wire transfer', 'Cash', 'Other'];
  const methodSelect = (attrs, current) => {
    const list = current && !PAY_METHODS.includes(current) ? [current, ...PAY_METHODS] : PAY_METHODS;
    return `<select ${attrs}><option value="" ${current ? '' : 'selected'}>Choose…</option>${list.map((x) => `<option value="${esc(x)}" ${x === current ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
  };
  const COLORS = ['#ef6c35', '#3567d6', '#1f9d63', '#9b51e0', '#d64545', '#b7791f'];
  const TONES = ['peach', 'lavender', 'mint', 'sky', 'butter', 'rose'];

  // Choices from the "earnings tracker" Google Form. New names typed in the app are remembered automatically.
  const WORK_TYPES = ['Stand In / Rehearsal Actor', 'Brand Ambassador', 'Voice Over', 'TV / Film', 'Stage / Theatre', 'Commercial', 'UGC', 'Modeling / Print'];
  const WORK_TONES = { 'Stand In / Rehearsal Actor': 'sky', 'Brand Ambassador': 'butter', 'Voice Over': 'lavender', 'TV / Film': 'peach', 'Stage / Theatre': 'rose', 'Commercial': 'mint', 'UGC': 'butter', 'Modeling / Print': 'sky' };
  // Your own payors, employers and project nicknames live in local-config.js on your computer (never published).
  const LOCAL = (typeof window !== 'undefined' && window.AHQ_LOCAL) || {};
  const PAYORS = [
    'Entertainment Partners', 'Cast & Crew Payroll', 'Media Services Processing, LLC (A Cast & Crew Company)', 'ABS Payroll', 'Payday, Inc.',
    'Team Services', 'Backstage Payroll Services, Inc.', 'Extreme Reach', 'Topsheet, Inc.', '(EP) / GEP Talent Services, LLC', 'Iyuno USA Inc. Network Corp. (DBA Wrapbook)',
    ...(LOCAL.payors || []),
  ];
  const EMPLOYERS = LOCAL.employers || [];
  const uniq = (arr) => { const seen = new Set(); return arr.filter((v) => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase())); };
  const PLUS = '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
  const ICONS = {
    bill: '<svg viewBox="0 0 24 24"><path d="M6 2h12a1 1 0 0 1 1 1v19l-3-2-2 2-2-2-2 2-2-2-3 2V3a1 1 0 0 1 1-1zm2 5v2h8V7zm0 4v2h8v-2zm0 4v2h5v-2z"/></svg>',
    subscription: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.7 6H22l-3.5 4-3.5-4h2.6A6 6 0 1 0 18 14.9l1.7 1.1A8 8 0 1 1 12 4z"/></svg>',
  };

  function addPeriod(iso, freq, anchorDay) {
    const d = parseISO(iso);
    if (freq === 'weekly' || freq === 'biweekly') { d.setDate(d.getDate() + (freq === 'weekly' ? 7 : 14)); return toISO(d); }
    const months = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 }[freq];
    if (!months) return null;
    const day = anchorDay || d.getDate();
    const t = new Date(d.getFullYear(), d.getMonth() + months, 1);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(day, last));
    return toISO(t);
  }

  // Storage that never crashes the app: falls back to memory if the browser blocks it (e.g. some phone browsers inside Google’s frame).
  const safeStore = (() => {
    try { const k = "__ahq_test"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); return window.localStorage; }
    catch (e) { const m = {}; window.__ahqMemoryOnly = true; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; }
  })();

  // ---------- state ----------
  const STORE_KEY = 'sag-tracker:v1';
  const defaultState = () => ({
    version: 1,
    settings: {
      team: [
        { id: 'agent', name: 'Agent', percent: 10, method: 'Zelle', color: COLORS[0] },
        { id: 'manager', name: 'Manager', percent: 10, method: 'Zelle', color: COLORS[1], company: '', email: '' },
      ],
      splitBase: 'gross',
      driveUrl: '',
      driveSecret: '',
      autoUpload: true,
      autoBackup: true,
      lastBackup: null,
      // accountant + automatic emails
      senderName: '',
      reviewMemberId: '', // whose commission is under review (Payout audit); left out of the accountant package
      projectAliases: {}, // other names for the same project, e.g. { 'code name': 'real title' }
      senderRole: 'Talent',
      accountantName: '',
      accountantEmail: '',
      ledger: true,
      emailAccountantChecks: true,
      emailAccountantPayments: true,
      emailReceipts: true,
      ledgerUrl: '',
      sharedFolderUrl: '',
      sharedWith: '',
      receiptSeq: 0,
      receiptYear: null,
    },
    checks: [],
    bills: [],
    outbox: [],
    outboxLog: [],
    rules: [],        // commission rules: who earns what %, on what, when
    evidence: [],     // payments found in bank / Venmo / Zelle history during the audit
    auditNotes: {},   // per person-year checklist + notes
    imports: [],      // history imports (so an import can be undone)
    audit: { rulesConfirmed: false },
  });

  function load() {
    try {
      const raw = safeStore.getItem(STORE_KEY);
      if (raw) return migrate(JSON.parse(raw));
    } catch (e) { console.error('Could not load saved data', e); }
    return defaultState();
  }
  function migrate(s) {
    const d = defaultState();
    const out = { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) }, checks: s.checks || [], bills: s.bills || [], outbox: s.outbox || [], outboxLog: s.outboxLog || [],
      evidence: s.evidence || [], auditNotes: s.auditNotes || {}, imports: s.imports || [], audit: { rulesConfirmed: false, ...(s.audit || {}) } };
    if (!Array.isArray(s.rules)) {
      out.rules = (out.settings.team || []).map((m) => ({ id: uid(), memberId: m.id, percent: num(m.percent), base: out.settings.splitBase || 'gross', from: '', to: '', workTypes: [], employers: '', note: '' }));
    }
    for (const m of out.settings.team) {
      if (m.email === undefined) m.email = '';
      if (m.company === undefined) m.company = '';
    }
    return out;
  }
  let state = load();
  function save() {
    state.updatedAt = new Date().toISOString();
    try { safeStore.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save — browser storage is full. Export a backup in Settings.', { error: true }); }
    scheduleBackup();
  }

  const ui = {
    view: 'dashboard',
    checkFilter: 'open',
    workFilter: '',
    checkSearch: '',
    billTab: 'all',
    reportTab: 'statement',
    stmt: { member: '', year: 'all', jobs: false },
    acctYear: 'all',
    calMonth: '',     // 'YYYY-MM' being viewed
    calDay: '',       // selected day (ISO)
    calShow: { due: true, paid: true, deposit: true, payout: true, earning: false },
    modal: null, // {type, id}
    pendingFiles: [],
  };

  // ---------- IndexedDB for file blobs (until they're in Drive) ----------
  const idb = (() => {
    let dbp;
    const open = () => (dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('sag-tracker-files', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('files', mode);
        const req = fn(t.objectStore('files'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      get: (k) => tx('readonly', (s) => s.get(k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
    };
  })();

  // ---------- Google Drive (via Apps Script web app) ----------
  const driveConfigured = () => !!(state.settings.driveUrl && state.settings.driveSecret);
  async function driveCall(action, payload = {}) {
    if (!driveConfigured()) throw new Error('Google Drive is not set up yet (Settings → Google Drive).');
    let res;
    try {
      res = await fetch(state.settings.driveUrl.trim(), {
        method: 'POST',
        body: JSON.stringify({ action, secret: state.settings.driveSecret, ...payload }),
      });
    } catch (e) {
      throw new Error('Could not reach Google Drive. Check your internet connection and the Web App URL.');
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error('Unexpected response from Google. Make sure the script is deployed as a Web App with access set to "Anyone".');
    }
    if (!data.ok) throw new Error(data.error || 'Google Drive request failed');
    return data;
  }
  const blobToBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  async function uploadFile(check, file) {
    const blob = await idb.get(file.id);
    if (!blob) { file.status = 'error'; file.error = 'Local copy missing'; save(); render(); throw new Error('Local copy of this file is missing.'); }
    file.status = 'uploading'; file.error = null; render();
    try {
      const ext = (file.name.match(/\.[^.]+$/) || [''])[0];
      const idx = check.files.indexOf(file);
      const base = [check.receivedDate, check.payer || 'SAG check', employerOf(check), check.workType, check.checkNumber && '#' + check.checkNumber].filter(Boolean).join(' - ');
      const name = sanitize(base) + (check.files.length > 1 ? ` (${idx + 1})` : '') + ext;
      const r = await driveCall('upload', {
        name, mimeType: file.type || 'application/octet-stream',
        year: (check.receivedDate || today()).slice(0, 4),
        data: await blobToBase64(blob),
      });
      Object.assign(file, { status: 'uploaded', driveId: r.id, driveUrl: r.url, driveName: name, uploadedAt: new Date().toISOString() });
      ledgerSync([{ check }], 1500);
      await idb.del(file.id);
    } catch (e) {
      file.status = 'error'; file.error = e.message;
      throw e;
    } finally { save(); render(); }
  }
  // ---------- attachments for projects (contracts) and write-offs (receipts) ----------
  async function stashFiles(files) {
    const out = [];
    for (const file of files) {
      const id = uid();
      try { await idb.put(id, file); out.push({ id, name: file.name, size: file.size, type: file.type, status: 'local', addedAt: new Date().toISOString() }); }
      catch (e) { toast(`Couldn’t store ${file.name}: ${e.message}`, { error: true }); }
    }
    return out;
  }
  async function uploadAttachment(file, { kind, year, sub, baseName }) {
    const blob = await idb.get(file.id);
    if (!blob) { file.status = 'error'; file.error = 'Local copy missing'; throw new Error('Local copy of this file is missing.'); }
    file.status = 'uploading'; file.error = null;
    try {
      const ext = (file.name.match(/\.[^.]+$/) || [''])[0];
      const name = sanitize(baseName || file.name.replace(/\.[^.]+$/, '')) + ext;
      const r = await driveCall('upload', { kind, sub, name, mimeType: file.type || 'application/octet-stream', year: String(year || today().slice(0, 4)), data: await blobToBase64(blob) });
      Object.assign(file, { status: 'uploaded', driveId: r.id, driveUrl: r.url, driveName: name, uploadedAt: new Date().toISOString() });
      await idb.del(file.id);
    } catch (e) { file.status = 'error'; file.error = e.message; throw e; }
  }
  async function uploadOwnerFiles(files, opts, label) {
    if (!driveConfigured()) return;
    let ok = 0;
    for (const [i, f] of files.entries()) {
      if (f.status !== 'local' && f.status !== 'error') continue;
      try { await uploadAttachment(f, { ...opts, baseName: files.length > 1 ? `${opts.baseName} (${i + 1})` : opts.baseName }); ok++; }
      catch (e) { toast(`Upload failed for ${f.name}: ${e.message}`, { error: true }); }
    }
    save(); render();
    if (ok) toast(`Saved ${ok} ${label}${ok > 1 ? 's' : ''} to Google Drive`);
  }
  async function openStoredFile(f) {
    if (f.driveUrl) { window.open(f.driveUrl, '_blank', 'noopener'); return; }
    const blob = await idb.get(f.id);
    if (!blob) return toast('That file isn’t on this device.', { error: true });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  }
  const fileChip = (f, owner, kind) => `<button type="button" class="file-chip" data-action="open-attachment" data-kind="${kind}" data-owner="${esc(owner)}" data-file="${esc(f.id)}" title="${esc(f.name)}">${f.type?.startsWith('image/') ? '🖼' : '📄'} ${esc(f.name.length > 28 ? f.name.slice(0, 26) + '…' : f.name)}${f.status === 'uploaded' ? '' : ' <span class="muted small">(on this device)</span>'}</button>`;

  // ---------- projects: contracts, fee splits by date, payment details ----------
  const APPLIES = [['', 'Sessions & residuals'], ['Sessions', 'Sessions only'], ['Residuals', 'Residuals only']];
  const projectById = (id) => (state.projects || []).find((p) => p.id === id);
  function feeSplitRows() {
    const rows = [];
    for (const p of state.projects || []) for (const s of p.splits || []) if (s.memberId && num(s.percent) > 0) rows.push({ project: p.title, projectId: p.id, ...s, payTypes: s.payTypes || '' });
    for (const r of state.rules || []) rows.push({ project: r.employers ? `Any job matching “${r.employers.split(',')[0].trim()}”${r.employers.includes(',') ? '…' : ''}` : 'All work', projectId: '', memberId: r.memberId, percent: r.percent, payTypes: r.payTypes?.[0] || '', from: r.from || '', to: r.to || '', method: memberById(r.memberId)?.method || '', payTo: memberById(r.memberId)?.email || '', takenOut: !!r.takenOutSessions, general: true, note: r.note });
    return rows.sort((a, b) => (a.from || '0000').localeCompare(b.from || '0000') || (memberById(a.memberId)?.name || '').localeCompare(memberById(b.memberId)?.name || ''));
  }
  function viewProjects() {
    const asOf = ui.splitsAsOf || '';
    const rows = feeSplitRows().filter((r) => !asOf || ((!r.from || r.from <= asOf) && (!r.to || r.to >= asOf)));
    const projects = [...(state.projects || [])].sort((a, b) => (b.bookedDate || '').localeCompare(a.bookedDate || ''));
    const t = today();
    return `
      <div class="page-head">
        <div><h1>Projects</h1><p>Every booking in one place: the signed contract, who gets what percentage and for which dates, where each payment goes, and any deadline.</p></div>
        ${addButton('add-project', 'Add a booked project')}
      </div>
      <div class="card">
        <div class="card-head"><h2>All fee splits</h2>
          <label class="inline small" style="gap:8px">In effect on <input type="date" data-splits-asof value="${esc(asOf)}" style="width:auto"> ${asOf ? '<button class="btn sm ghost" data-action="splits-asof-clear">Show all</button>' : ''}</label></div>
        <div class="card-body">${rows.length ? `<div class="table-wrap" style="padding:0"><table class="splits-table">
          <thead><tr><th>Person</th><th class="right">%</th><th>Project</th><th>Applies to</th><th>Dates</th><th>Paid via</th></tr></thead>
          <tbody>${rows.map((r) => `<tr ${r.projectId ? `class="clickable" data-action="edit-project" data-id="${r.projectId}"` : ''}>
            <td><div class="title">${esc(memberById(r.memberId)?.name || 'Former member')}</div>${r.takenOut ? '<div class="sub">Sessions taken out first</div>' : ''}</td>
            <td class="right num"><b>${num(r.percent)}%</b></td>
            <td>${esc(r.project)}${r.general ? ' <span class="pill" style="margin-left:4px">rule</span>' : ''}</td>
            <td>${esc((APPLIES.find(([k]) => k === r.payTypes) || APPLIES[0])[1])}</td>
            <td class="num" style="white-space:nowrap">${r.from ? fmtDate(r.from) : 'Any date'} → ${r.to ? fmtDate(r.to) : 'present'}</td>
            <td>${esc(r.method || '—')}${r.payTo ? `<div class="sub">${esc(r.payTo)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>
          <p class="muted small" style="margin:10px 0 0">All splits are a percentage of the <b>gross</b> amount. Project splits are used first; “rule” rows (from Payout audit) cover everything else.</p>`
          : '<div class="empty">No fee splits yet. Add a booked project, or a commission rule in Payout audit.</div>'}</div>
      </div>
      <div style="height:20px"></div>
      ${projects.length ? `<div class="grid project-grid">${projects.map((p) => {
        const overdue = p.deadline && p.deadline < t;
        return `<div class="card project-card">
          <div class="card-head"><div><h2>${esc(p.title)}</h2><div class="muted small">${[p.company, p.bookedDate ? 'Booked ' + fmtDate(p.bookedDate) : ''].filter(Boolean).map(esc).join(' · ')}</div></div>
            <button class="btn sm" data-action="edit-project" data-id="${p.id}">Edit</button></div>
          <div class="card-body stack">
            ${p.deadline ? `<div><span class="pill ${overdue ? 'red' : 'amber'}">Payment deadline ${fmtDate(p.deadline)}</span></div>` : ''}
            <div class="list">${(p.splits || []).filter((s) => s.memberId).map((s) => `<div class="list-item"><div class="grow"><div class="title">${esc(memberById(s.memberId)?.name || 'Former member')} · ${num(s.percent)}%</div>
              <div class="sub">${esc((APPLIES.find(([k]) => k === (s.payTypes || '')) || APPLIES[0])[1])} · ${s.from ? fmtDate(s.from) : 'any date'} → ${s.to ? fmtDate(s.to) : 'present'}${s.takenOut ? ' · sessions taken out first' : ''}</div></div>
              <div class="right small">${esc(s.method || '')}${s.payTo ? `<div class="muted">${esc(s.payTo)}</div>` : ''}</div></div>`).join('') || '<div class="muted small">No splits yet.</div>'}</div>
            <div><div class="field-label">Signed contract</div>${(p.files || []).length ? `<div class="row">${p.files.map((f) => fileChip(f, p.id, 'project')).join('')}</div>` : '<div class="muted small">No contract uploaded yet.</div>'}</div>
            ${p.paymentNotes ? `<div class="muted small">${esc(p.paymentNotes)}</div>` : ''}
          </div></div>`; }).join('')}</div>`
        : `<div class="card empty">No projects yet. When you book a job, add it here with the signed contract and the fee splits.<br><button class="btn primary" data-action="add-project">+ Add a booked project</button></div>`}`;
  }
  function projectFormHTML(m) {
    const p = m.id ? projectById(m.id) : null;
    if (m.id && !p) return null;
    if (!m.rows) m.rows = p ? JSON.parse(JSON.stringify(p.splits || [])) : state.settings.team.slice(0, 1).map((t) => ({ memberId: t.id, percent: 15, payTypes: '', from: today(), to: '', method: t.method || '', payTo: t.email || '', takenOut: false }));
    const v = m.values || p || { title: '', company: '', bookedDate: today(), match: '', deadline: '', paymentNotes: '', notes: '' };
    const memberOpts = (sel) => state.settings.team.map((t) => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    return `<form class="modal-card wide" data-form="project" autocomplete="off">
      <header><h2>${p ? 'Edit project' : 'Add a booked project'}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="grid2">
          <label><span>Project title <span class="req">*</span></span><input name="title" required value="${esc(v.title)}" placeholder="e.g. Big Animated Series & You S5"></label>
          <label>Production company / employer<input name="company" value="${esc(v.company)}" placeholder="e.g. Nickelodeon"></label>
          <label>Booked on<input type="date" name="bookedDate" value="${esc(v.bookedDate || '')}"></label>
          <label>Payment deadline <span class="muted" style="font-weight:400">(optional)</span><input type="date" name="deadline" value="${esc(v.deadline || '')}"></label>
        </div>
        <label>Words that identify this project on checks <span class="muted" style="font-weight:400">(optional, comma-separated — defaults to the title)</span><input name="match" value="${esc(v.match || '')}" placeholder="e.g. big animated, big anim"></label>
        <fieldset><legend>Fee splits</legend>
          <p class="muted small" style="margin:-4px 0 10px">Percent of the <b>gross</b>. Leave “to” blank for “to present”. Add a second row for the same person if the rate changes on a date.</p>
          <div class="stack" style="gap:10px">${m.rows.map((r, i) => `<div class="proj-split">
            <label>Person<select data-prow="${i}" data-pfield="memberId">${memberOpts(r.memberId)}</select></label>
            <label>%<input type="number" step="0.01" min="0" max="100" data-prow="${i}" data-pfield="percent" value="${esc(r.percent)}"></label>
            <label>Applies to<select data-prow="${i}" data-pfield="payTypes">${APPLIES.map(([k, l]) => `<option value="${k}" ${k === (r.payTypes || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label>From<input type="date" data-prow="${i}" data-pfield="from" value="${esc(r.from || '')}"></label>
            <label>To<input type="date" data-prow="${i}" data-pfield="to" value="${esc(r.to || '')}"></label>
            <label>Paid via${methodSelect(`data-prow="${i}" data-pfield="method"`, r.method || '')}</label>
            <label>Send to <span class="muted" style="font-weight:400">(email, @venmo, phone)</span><input data-prow="${i}" data-pfield="payTo" value="${esc(r.payTo || '')}" placeholder="e.g. @their-venmo"></label>
            <label class="inline small" style="align-self:end;padding-bottom:10px"><input type="checkbox" data-prow="${i}" data-pfield="takenOut" ${r.takenOut ? 'checked' : ''}> Sessions taken out first</label>
            <button type="button" class="icon-btn plain" data-action="proj-row-del" data-index="${i}" aria-label="Remove row" style="align-self:end;margin-bottom:8px">×</button>
          </div>`).join('')}</div>
          <button type="button" class="btn sm" data-action="proj-row-add" style="margin-top:10px">+ Add a person or rate</button>
        </fieldset>
        <div>
          <div class="field-label">Signed contract ${driveConfigured() ? '<span class="muted">· saves to Google Drive</span>' : ''}</div>
          <div class="scan-row">
            <label class="btn primary scan-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>Scan with camera<input type="file" id="file-camera" accept="image/*" capture="environment" hidden></label>
            <label class="dropzone"><input type="file" id="file-input" multiple accept="image/*,application/pdf" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l6 6v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm7 1.5V9h5.5zM11 12v3H8v2h3v3h2v-3h3v-2h-3v-3z"/></svg>Choose files<span class="dz-hint">or drag the contract here</span></label>
          </div>
          <div class="file-list" id="pending-files" style="margin-top:8px">${pendingFilesHTML()}</div>
          ${p && (p.files || []).length ? `<div class="row" style="margin-top:8px">${p.files.map((f) => fileChip(f, p.id, 'project')).join('')}</div>` : ''}
        </div>
        <label>Payment details / notes <span class="muted" style="font-weight:400">(optional)</span><textarea name="paymentNotes" rows="2" placeholder="e.g. Commission due within 10 days of each check; send receipt to manager">${esc(v.paymentNotes || '')}</textarea></label>
      </div>
      <footer>
        ${p ? `<button type="button" class="btn ghost danger" data-action="delete-project" data-id="${p.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">Save project</button>
      </footer>
    </form>`;
  }
  function captureProjectValues(form) {
    const f = form.elements;
    ui.modal.values = { title: f.title.value, company: f.company.value, bookedDate: f.bookedDate.value, deadline: f.deadline.value, match: f.match.value, paymentNotes: f.paymentNotes.value };
  }
  async function submitProjectForm(form) {
    form.querySelectorAll('[data-prow]').forEach((el) => { const r = ui.modal.rows[Number(el.dataset.prow)]; if (r) r[el.dataset.pfield] = el.type === 'checkbox' ? el.checked : el.value; });
    const f = form.elements;
    const title = f.title.value.trim();
    if (!title) return toast('Give the project a title.', { error: true });
    const splits = (ui.modal.rows || []).filter((r) => r.memberId && num(r.percent) > 0).map((r) => ({ ...r, percent: num(r.percent) }));
    for (const s of splits) if (s.from && s.to && s.to < s.from) return toast('One of the splits ends before it starts.', { error: true });
    const data = { title, company: f.company.value.trim(), bookedDate: f.bookedDate.value, deadline: f.deadline.value, match: f.match.value.trim(), paymentNotes: f.paymentNotes.value.trim(), splits };
    state.projects = state.projects || [];
    let p = ui.modal.id ? projectById(ui.modal.id) : null;
    if (p) Object.assign(p, data); else { p = { id: uid(), createdAt: new Date().toISOString(), files: [], ...data }; state.projects.push(p); }
    const added = await stashFiles(ui.pendingFiles.splice(0));
    p.files = [...(p.files || []), ...added];
    const n = reapplyRules();
    save(); closeModal(); render();
    toast(`${title} saved${n ? ` — recalculated ${n} checks` : ''}`);
    if (added.length && state.settings.autoUpload !== false) uploadOwnerFiles(p.files, { kind: 'contract', sub: sanitize(title), year: (p.bookedDate || today()).slice(0, 4), baseName: `${title} - signed contract` }, 'contract');
  }

  async function uploadPending(check) {
    const pending = check.files.filter((f) => f.status === 'local' || f.status === 'error');
    let ok = 0;
    for (const f of pending) {
      try { await uploadFile(check, f); ok++; } catch (e) { toast(`Upload failed for ${f.name}: ${e.message}`, { error: true }); }
    }
    if (ok) toast(`Saved ${ok} file${ok > 1 ? 's' : ''} to Google Drive`);
  }

  let backupTimer = null;
  let backingUp = false;
  function backupPayload() {
    const copy = JSON.parse(JSON.stringify(state));
    copy.settings.driveSecret = '';
    return JSON.stringify(copy, null, 1);
  }
  function scheduleBackup() {
    if (!state.settings.autoBackup || !driveConfigured()) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(() => backupNow(true), 5000);
  }
  // A brand-new copy (e.g. first open on your phone) must never overwrite the backup in Drive with nothing.
  const isEmptyState = () => !(state.checks?.length || state.evidence?.length || state.bills?.length || state.expenses?.length || state.projects?.length);
  let syncing = false, lastSyncTry = 0;
  // Pull the latest backup from Drive if it's newer than what this device has (keeps phone and Mac in step).
  async function syncFromDrive(manual) {
    if (!driveConfigured() || syncing) return false;
    if (!manual && Date.now() - lastSyncTry < 60000) return false;
    lastSyncTry = Date.now();
    syncing = true;
    try {
      const r = await driveCall('restore');
      if (!r.content) { if (manual) toast('No backup in Google Drive yet.'); return false; }
      const remote = JSON.parse(r.content);
      const rt = remote.updatedAt || r.updated || '';
      if (isEmptyState() || (rt && rt > (state.updatedAt || ''))) {
        const keep = { driveUrl: state.settings.driveUrl, driveSecret: state.settings.driveSecret };
        state = migrate(remote);
        Object.assign(state.settings, keep);
        safeStore.setItem(STORE_KEY, JSON.stringify(state));
        render();
        toast('Loaded your latest data from Google Drive');
        return true;
      }
      if (manual) toast('Already up to date');
      return false;
    } catch (e) { if (manual) toast(e.message, { error: true }); return false; }
    finally { syncing = false; }
  }
  async function backupNow(silent) {
    if (backingUp) return;
    if (isEmptyState()) { if (!silent) toast('Nothing to back up yet — your data will load from Drive first.'); return; }
    backingUp = true;
    try {
      await driveCall('backup', { content: backupPayload() });
      state.settings.lastBackup = new Date().toISOString();
      safeStore.setItem(STORE_KEY, JSON.stringify(state));
      renderDriveStatus();
      if (!silent) toast('Backed up to Google Drive');
      refreshSharedPages(); // keeps any "update automatically" private links current
    } catch (e) {
      if (!silent) toast(e.message, { error: true }); else console.warn('Auto-backup failed', e);
    } finally { backingUp = false; }
  }

  // ---------- domain helpers ----------
  const memberById = (id) => state.settings.team.find((m) => m.id === id);
  function memberTone(id) {
    const i = state.settings.team.findIndex((m) => m.id === id);
    if (i >= 0) return TONES[i % TONES.length];
    let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return TONES[h % TONES.length];
  }
  const checkById = (id) => state.checks.find((c) => c.id === id);
  const employerOf = (c) => c.employer || c.project || '';
  const checkLabel = (c) => `${esc(c.payer || 'SAG check')}${employerOf(c) ? ' · ' + esc(employerOf(c)) : ''}`;
  const workPill = (c) => (c.workType ? `<span class="pill" style="background:var(--${WORK_TONES[c.workType] || 'surface-2'});color:var(--${WORK_TONES[c.workType] ? WORK_TONES[c.workType] + '-ink' : 'muted'})">${esc(c.workType)}</span>` : '');
  const billById = (id) => state.bills.find((b) => b.id === id);
  const splitBaseAmount = (c) => (c.splitOn === 'net' && num(c.net) ? num(c.net) : num(c.gross));
  const takeHome = (c) => (num(c.net) || num(c.gross)) - sum(c.splits, (s) => s.amount);

  // A commission ("split") is one of: paid · owe (still owed) · research (unknown, from history) · deducted (agent/manager took it first) · notOwed
  const splitState = (s) => (s.paid ? 'paid' : s.resolution === 'research' ? 'research' : s.resolution === 'deducted' ? 'deducted' : s.resolution === 'notOwed' ? 'notOwed' : 'owe');
  const SETTLED = ['paid', 'deducted', 'notOwed'];
  function checkStatus(c) {
    if (!c.splits.length) return 'nosplit';
    const states = c.splits.map(splitState);
    if (states.includes('research')) return 'research';
    const done = states.filter((x) => SETTLED.includes(x)).length;
    return done === states.length ? 'paid' : states.includes('paid') ? 'partial' : 'open';
  }
  function unpaidSplits(memberId) {
    const out = [];
    for (const c of state.checks) for (const s of c.splits) if (splitState(s) === 'owe' && (!memberId || s.memberId === memberId)) out.push({ check: c, split: s });
    return out.sort((a, b) => a.check.receivedDate.localeCompare(b.check.receivedDate));
  }
  function allMembers() {
    const list = state.settings.team.map((m) => ({ ...m, former: false }));
    for (const c of state.checks) for (const s of c.splits) {
      if (!list.find((m) => m.id === s.memberId)) list.push({ id: s.memberId, name: s.name, former: true, color: '#8a90a0' });
    }
    return list;
  }
  function setSplitPaid(check, split, paid) {
    split.paid = paid;
    if (paid) {
      split.resolution = '';
      split.paidDate = split.paidDate || today();
      split.method = split.method || memberById(split.memberId)?.method || '';
    } else {
      split.paidDate = null;
    }
  }

  function restoreSplit(s, snap) {
    for (const k of Object.keys(s)) if (!(k in snap)) delete s[k];
    Object.assign(s, snap);
  }

  const billMonthly = (b) => (b.active ? num(b.amount) * (PER_MONTH[b.frequency] ?? 0) : 0);
  function billStatus(b) {
    if (!b.active) return { cls: '', label: 'Paused' };
    if (!b.nextDue) return { cls: 'green', label: 'Paid' };
    const d = daysBetween(today(), b.nextDue);
    if (d < 0) return { cls: 'red', label: `Overdue ${-d}d` };
    if (d === 0) return { cls: 'amber', label: 'Due today' };
    if (d <= 7) return { cls: 'amber', label: `Due in ${d}d` };
    return { cls: 'blue', label: `Due ${fmtShort(b.nextDue)}` };
  }
  function payBill(b) {
    const p = { id: uid(), date: today(), amount: num(b.amount), dueDate: b.nextDue, prevNextDue: b.nextDue };
    b.payments = b.payments || [];
    b.payments.unshift(p);
    b.nextDue = b.nextDue ? addPeriod(b.nextDue, b.frequency, b.anchorDay) : null;
    return p;
  }
  function undoBillPayment(b, paymentId) {
    const i = (b.payments || []).findIndex((p) => p.id === paymentId);
    if (i < 0) return;
    const [p] = b.payments.splice(i, 1);
    if (i === 0) b.nextDue = p.prevNextDue ?? b.nextDue; // only the latest payment rolls the due date back
  }

  // ---------- automations: ledger + emails (sent through the Apps Script, from your Gmail) ----------
  // Jobs wait in state.outbox so they survive reloads, can be undone, and retry if offline.
  const UNDO_MS = 8000;
  const isEmailJob = (j) => ['receipt', 'paymentNotice', 'checkEmail'].includes(j.type);

  function nextReceiptNo() {
    const s = state.settings;
    const yr = new Date().getFullYear();
    if (s.receiptYear !== yr) { s.receiptYear = yr; s.receiptSeq = 0; }
    s.receiptSeq = (s.receiptSeq || 0) + 1;
    return `R-${yr}-${String(s.receiptSeq).padStart(4, '0')}`;
  }
  function enqueue(job) {
    if (!driveConfigured()) return false;
    if (job.type.startsWith('ledger') && !state.settings.ledger) return false;
    state.outbox = state.outbox || [];
    if (job.key) state.outbox = state.outbox.filter((j) => j.key !== job.key);
    state.outbox.push({ id: uid(), attempts: 0, createdAt: Date.now(), sendAfter: Date.now(), ...job });
    return true;
  }
  function cancelJobs(pred) { state.outbox = (state.outbox || []).filter((j) => !pred(j)); }
  function ledgerSync(items, delay = UNDO_MS) {
    const seen = new Set();
    for (const { check, split } of items) {
      if (split) enqueue({ type: 'ledgerPayout', key: `lp:${check.id}:${split.memberId}`, checkId: check.id, memberId: split.memberId, sendAfter: Date.now() + delay });
      if (!seen.has(check.id)) { seen.add(check.id); enqueue({ type: 'ledgerCheck', key: `lc:${check.id}`, checkId: check.id, sendAfter: Date.now() + delay }); }
    }
    kickOutbox();
  }

  // Called right after splits are marked paid. One receipt per person, itemized.
  function paymentAutomations(items) {
    const s = state.settings;
    const groups = {};
    for (const it of items) (groups[it.split.memberId] ||= []).push(it);
    for (const [memberId, list] of Object.entries(groups)) {
      const receiptNo = nextReceiptNo();
      list.forEach(({ split }) => { split.receiptNo = receiptNo; split.receiptSentAt = null; split.accountantNotifiedAt = null; });
      const ref = list.map(({ check, split }) => ({ checkId: check.id, memberId: split.memberId }));
      const member = memberById(memberId);
      if (s.emailReceipts && driveConfigured()) {
        if (member?.email) enqueue({ type: 'receipt', key: `rc:${receiptNo}`, memberId, items: ref, receiptNo, sendAfter: Date.now() + UNDO_MS });
        else setTimeout(() => toast(`No email address for ${list[0].split.name} — add it in Settings to send receipts.`), 600);
      }
      if (s.emailAccountantPayments && s.accountantEmail) enqueue({ type: 'paymentNotice', key: `pn:${receiptNo}`, memberId, items: ref, receiptNo, sendAfter: Date.now() + UNDO_MS });
    }
    ledgerSync(items);
  }
  // Called right after splits are marked unpaid. Queued emails skip unpaid items on their own.
  function unpaidAutomations(items) {
    for (const { split } of items) {
      if (split.receiptSentAt) setTimeout(() => toast(`Heads up: ${split.name}’s receipt was already emailed.`), 600);
      else split.receiptNo = null;
    }
    ledgerSync(items);
  }

  const CHECK_HEADERS = ['ID', 'Deposit Date', 'Type of Work', 'Payor', 'Employer', 'Check #', 'Gross', 'Net', 'Team Total', 'You Keep', 'Payout Status', 'Scans', 'Notes', 'Last Updated'];
  const PAYOUT_HEADERS = ['ID', 'Paid Date', 'Paid To', 'Company', 'Percent', 'Amount', 'Paid Via', 'Receipt #', 'Check Deposit Date', 'Type of Work', 'Payor', 'Employer', 'Check #', 'Check Gross', 'Receipt Emailed'];
  const STATUS_TEXT = { paid: 'All paid', partial: 'Partly paid', open: 'Needs payout', nosplit: 'No split' };
  const ledgerCheckRow = (c) => ({
    sheet: 'Checks', id: c.id, headers: CHECK_HEADERS,
    row: [c.id, c.receivedDate, c.workType || '', c.payer || '', employerOf(c), c.checkNumber || '', num(c.gross), c.net === '' ? '' : num(c.net),
      round2(sum(c.splits, (x) => x.amount)), round2(takeHome(c)), STATUS_TEXT[checkStatus(c)],
      (c.files || []).filter((f) => f.driveUrl).map((f) => f.driveUrl).join('\n'), c.notes || '', new Date().toLocaleString('en-US')],
  });
  const ledgerPayoutRow = (c, sp) => ({
    sheet: 'Payouts', id: `${c.id}:${sp.memberId}`, headers: PAYOUT_HEADERS,
    row: [`${c.id}:${sp.memberId}`, sp.paidDate || '', sp.name, memberById(sp.memberId)?.company || '', num(sp.percent) / 100, num(sp.amount), sp.method || '', sp.receiptNo || '',
      c.receivedDate, c.workType || '', c.payer || '', employerOf(c), c.checkNumber || '', num(c.gross), sp.receiptSentAt ? new Date(sp.receiptSentAt).toLocaleString('en-US') : ''],
  });

  function jobItems(job) {
    return (job.items || []).map((i) => {
      const check = checkById(i.checkId);
      const split = check?.splits.find((x) => x.memberId === i.memberId);
      return check && split && split.paid && split.receiptNo === job.receiptNo ? { check, split } : null;
    }).filter(Boolean);
  }
  async function sendMail(to, mail) {
    await driveCall('sendEmail', { to, subject: mail.subject, html: mail.html, text: mail.text, senderName: state.settings.senderName || '' });
    return { log: { to, subject: mail.subject } };
  }
  async function runJob(job) {
    const s = state.settings;
    const now = new Date().toISOString();
    switch (job.type) {
      case 'ledgerCheck': {
        const c = checkById(job.checkId);
        if (!c) return;
        const r = await driveCall('ledgerUpsert', ledgerCheckRow(c));
        if (r.ledgerUrl) s.ledgerUrl = r.ledgerUrl;
        return;
      }
      case 'ledgerPayout': {
        const c = checkById(job.checkId);
        const sp = c?.splits.find((x) => x.memberId === job.memberId);
        if (c && sp && sp.paid) { const r = await driveCall('ledgerUpsert', ledgerPayoutRow(c, sp)); if (r.ledgerUrl) s.ledgerUrl = r.ledgerUrl; }
        else await driveCall('ledgerDelete', { sheet: 'Payouts', id: `${job.checkId}:${job.memberId}` });
        return;
      }
      case 'ledgerDelete':
        await driveCall('ledgerDelete', { sheet: job.sheet, id: job.rowId, prefix: job.prefix });
        return;
      case 'checkEmail': {
        const c = checkById(job.checkId);
        if (!c || !s.accountantEmail) return;
        const waiting = (c.files || []).some((f) => f.status === 'uploading' || (f.status === 'local' && s.autoUpload));
        if (waiting && (job.waits = (job.waits || 0) + 1) <= 18) return 'later'; // give scans up to ~3 min to reach Drive
        const r = await sendMail(s.accountantEmail, checkLoggedEmail(c));
        c.accountantNotifiedAt = now;
        return r;
      }
      case 'receipt': {
        const items = jobItems(job);
        if (!items.length) return;
        const member = memberById(job.memberId) || { name: items[0].split.name };
        if (!member.email) throw new Error(`No email address for ${member.name}`);
        const r = await sendMail(member.email, receiptEmail(member, items, job.receiptNo));
        items.forEach(({ split }) => { split.receiptSentAt = now; });
        ledgerSync(items, 0);
        return r;
      }
      case 'paymentNotice': {
        const items = jobItems(job);
        if (!items.length || !s.accountantEmail) return;
        const member = memberById(job.memberId) || { name: items[0].split.name };
        const r = await sendMail(s.accountantEmail, paymentNoticeEmail(member, items, job.receiptNo));
        items.forEach(({ split }) => { split.accountantNotifiedAt = now; });
        return r;
      }
    }
  }
  function jobLabel(j) {
    const m = j.memberId ? (memberById(j.memberId)?.name || 'team member') : '';
    const c = j.checkId ? checkById(j.checkId) : null;
    return {
      receipt: `Receipt ${j.receiptNo} to ${m}`,
      paymentNotice: `Accountant notice: paid ${m} (${j.receiptNo})`,
      checkEmail: `Accountant notice: new check${c ? ' from ' + (c.payer || 'SAG') : ''}`,
      ledgerCheck: 'Ledger update (check)',
      ledgerPayout: 'Ledger update (payout)',
      ledgerDelete: 'Ledger update (delete)',
    }[j.type] || j.type;
  }
  let outboxBusy = false;
  async function processOutbox() {
    if (outboxBusy || !driveConfigured() || !navigator.onLine) return;
    const due = (state.outbox || []).filter((j) => !j.failed && j.sendAfter <= Date.now());
    if (!due.length) return;
    outboxBusy = true;
    let changed = false;
    try {
      for (const job of due) {
        if (!state.outbox.includes(job)) continue; // cancelled meanwhile
        try {
          const r = await runJob(job);
          if (r === 'later') { job.sendAfter = Date.now() + 10000; continue; }
          state.outbox = state.outbox.filter((j) => j !== job);
          if (r?.log) {
            state.outboxLog = [{ ...r.log, at: new Date().toISOString() }, ...(state.outboxLog || [])].slice(0, 30);
            toast(`Emailed: ${r.log.subject}`);
          }
        } catch (e) {
          job.attempts++;
          job.error = e.message;
          job.sendAfter = Date.now() + Math.min(300000, 15000 * 2 ** job.attempts);
          if (job.attempts >= 5 || /No email address|Unknown action|Wrong secret|SECRET/.test(e.message)) {
            job.failed = true;
            toast(`Couldn’t send — ${jobLabel(job)}: ${e.message}`, { error: true });
          }
        }
        changed = true;
      }
    } finally {
      outboxBusy = false;
      if (changed) { save(); refreshOutboxUI(); }
    }
  }
  function kickOutbox() { setTimeout(processOutbox, 50); }
  function refreshOutboxUI() {
    const el = $('#outbox-status');
    if (el) el.innerHTML = outboxHTML();
    if (ui.modal && ui.modal.live) renderModal();
  }
  function outboxHTML() {
    const shown = (state.outbox || []).filter((j) => isEmailJob(j) || j.failed);
    const failed = shown.filter((j) => j.failed);
    const log = state.outboxLog || [];
    const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `
      ${shown.length ? `<h3 style="margin:4px 0 8px">Waiting to send</h3><div class="list">${shown.map((j) => `
        <div class="list-item"><div class="grow"><div class="title">${esc(jobLabel(j))}</div>
          <div class="sub">${j.failed ? 'Failed: ' + esc(j.error) : j.error ? 'Retrying — ' + esc(j.error) : j.sendAfter > Date.now() ? 'Sends in a few seconds' : 'Sending…'}</div></div>
          ${j.failed ? '<span class="pill red">Failed</span>' : '<span class="pill blue">Queued</span>'}</div>`).join('')}</div>
        ${failed.length ? '<div class="row" style="margin-top:10px"><button class="btn sm primary" data-action="retry-outbox">Retry failed</button><button class="btn sm ghost danger" data-action="clear-failed">Discard failed</button></div>' : ''}` : ''}
      ${log.length ? `<h3 style="margin:14px 0 8px">Recently sent</h3><div class="list">${log.slice(0, 8).map((l) => `
        <div class="list-item"><div class="grow"><div class="title">${esc(l.subject)}</div><div class="sub">To ${esc(l.to)} · ${when(l.at)}</div></div><span class="pill green">Sent</span></div>`).join('')}</div>`
        : shown.length ? '' : '<div class="muted small">No emails sent yet.</div>'}`;
  }

  // ----- email designs (inline styles so they render in Gmail / Apple Mail / Outlook) -----
  const EM = { bg: '#f3f3f7', card: '#ffffff', lav: '#e9e2ff', lavInk: '#5b3fd1', ink: '#111114', muted: '#8b8b98', soft: '#f4f4f8', mint: '#dff2e9', mintInk: '#237a55' };
  const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  function emailShell(o) {
    const s = state.settings;
    const initial = esc(((s.senderName || 'S').trim()[0] || 'S').toUpperCase());
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${EM.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(o.preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EM.bg};"><tr><td align="center" style="padding:32px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT};color:${EM.ink};">
  <tr><td style="padding:0 6px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="40" height="40" style="width:40px;height:40px;border-radius:20px;background-color:#f08aa8;background-image:linear-gradient(135deg,#ffd2a8 0%,#f08aa8 50%,#9a80ff 100%);color:#ffffff;font-weight:700;font-size:17px;text-align:center;line-height:40px;">${initial}</td>
      <td style="padding-left:12px;font-size:15px;font-weight:600;">${esc(s.senderName || '')}${s.senderRole ? `<span style="color:${EM.muted};font-weight:500;"> &middot; ${esc(s.senderRole)}</span>` : ''}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${EM.card};border-radius:28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="background:${EM.lav};border-radius:28px 28px 0 0;padding:28px 28px 26px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${EM.lavInk};">${esc(o.eyebrow)}</div>
        <div style="font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1.2;margin-top:6px;">${esc(o.title)}</div>
        ${o.subtitle ? `<div style="font-size:14px;color:#55556a;margin-top:6px;">${o.subtitle}</div>` : ''}
        ${o.panelBig ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;"><tr><td style="background:${EM.ink};border-radius:20px;padding:18px 20px;color:#ffffff;">
          <div style="font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.1;">${esc(o.panelBig)}</div>
          <div style="font-size:13px;color:#a7a6b2;margin-top:4px;">${o.panelSub || ''}</div></td></tr></table>` : ''}
      </td></tr>
      <tr><td style="padding:24px 28px 28px;font-size:14px;line-height:1.5;">${o.body}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:18px 10px 0;font-size:12px;color:${EM.muted};text-align:center;line-height:1.5;">${o.footer || ''}</td></tr>
</table></td></tr></table></body></html>`;
  }
  const emKV = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;">${rows.filter(Boolean).map(([k, v]) => `<tr><td style="padding:6px 0;color:${EM.muted};vertical-align:top;">${esc(k)}</td><td style="padding:6px 0 6px 12px;font-weight:600;text-align:right;vertical-align:top;">${v}</td></tr>`).join('')}</table>`;
  const emSection = (t) => `<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${EM.muted};margin:22px 0 10px;">${esc(t)}</div>`;
  const emButton = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:${EM.ink};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:999px;margin:6px 6px 0 0;">${esc(label)}</a>`;
  const emNote = (html, bg = EM.mint, ink = EM.mintInk) => `<div style="margin-top:20px;padding:14px 16px;border-radius:16px;background:${bg};color:${ink};font-size:13px;line-height:1.5;">${html}</div>`;
  const pctText = (c, sp) => `${num(sp.percent)}% of ${money(splitBaseAmount(c))} ${c.splitOn === 'net' && c.net ? 'net' : 'gross'}`;
  const checkMeta = (c) => [employerOf(c), c.employer && c.project, c.workType, c.payType, c.checkNumber && `#${c.checkNumber}`].filter(Boolean).join(' · ');
  const fromLine = () => { const s = state.settings; return `${s.senderName || 'Talent'}${s.senderRole ? ` (${s.senderRole})` : ''}`; };
  const toLine = (member) => `${member.name}${member.company ? ` — ${member.company}` : ''}`;
  const paidSummary = (items) => {
    const methods = uniq(items.map((i) => i.split.method).filter(Boolean)).join(', ') || '—';
    const dates = items.map((i) => i.split.paidDate).filter(Boolean).sort();
    return { methods, paidOn: fmtDate(dates[dates.length - 1] || today()), total: round2(sum(items, (i) => i.split.amount)) };
  };
  const itemCard = ({ check: c, split: sp }) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EM.soft};border-radius:16px;margin-bottom:8px;"><tr><td style="padding:14px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-weight:600;font-size:15px;">${esc(c.payer || 'SAG check')}</td>
        <td align="right" style="font-weight:700;font-size:15px;">${esc(money(sp.amount))}</td></tr>
        ${checkMeta(c) ? `<tr><td colspan="2" style="font-size:12px;color:${EM.muted};padding-top:2px;">${esc(checkMeta(c))}</td></tr>` : ''}
      </table>
      <div style="height:8px;"></div>
      ${emKV([['Deposit date', esc(fmtDate(c.receivedDate))], ['Percentage amount', esc(pctText(c, sp))], ['Dollar amount', esc(money(sp.amount))], ['Paid via', esc(sp.method || '—')], sp.paidDate && ['Paid on', esc(fmtDate(sp.paidDate))]])}
    </td></tr></table>`;
  const itemText = ({ check: c, split: sp }) => [
    `Deposit Date: ${fmtDate(c.receivedDate)}`,
    `Check: ${[c.payer || 'SAG check', checkMeta(c)].filter(Boolean).join(' · ')}`,
    `Percentage Amount: ${pctText(c, sp)}`,
    `Dollar Amount: ${money(sp.amount)}`,
    `PAID VIA: ${sp.method || '—'}`,
  ].join('\n');

  function receiptEmail(member, items, receiptNo) {
    const s = state.settings;
    const { methods, paidOn, total } = paidSummary(items);
    const body = `
      ${emKV([['From', esc(fromLine())], ['To', esc(toLine(member))], ['Issued', esc(fmtDate(today()))], ['Receipt #', esc(receiptNo)]])}
      ${emSection('Itemized payment')}
      ${items.map(itemCard).join('')}
      ${items.length > 1 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;"><tr><td style="font-weight:600;font-size:15px;">Total</td><td align="right" style="font-weight:700;font-size:17px;">${esc(money(total))}</td></tr></table>` : ''}
      ${emNote('This receipt confirms deposit of the above payment and the commission amount allocated to it.')}`;
    const html = emailShell({
      preheader: `${money(total)} commission paid via ${methods}`,
      eyebrow: 'Payment receipt / invoice',
      title: `Commission payment to ${member.name}`,
      subtitle: esc(`Receipt ${receiptNo} · Issued ${fmtDate(today())}`),
      panelBig: money(total),
      panelSub: esc(`Paid via ${methods} · ${paidOn}`),
      body,
      footer: esc(`Sent by ${s.senderName || 'your client'}. Please keep this receipt for your records.`),
    });
    const text = [
      'PAYMENT RECEIPT / INVOICE', '================================================', '',
      `From: ${fromLine()}`, `To: ${toLine(member)}`, `Issued: ${fmtDate(today())}`, `Receipt #: ${receiptNo}`, '',
      'ITEMIZED PAYMENT', '------------------------------', '',
      items.map(itemText).join('\n\n------------------------------\n\n'), '',
      '------------------------------',
      ...(items.length > 1 ? [`TOTAL: ${money(total)}`, ''] : ['']),
      'This receipt confirms deposit of the above payment and the commission amount allocated to it.',
    ].join('\n');
    return { subject: `Payment receipt ${receiptNo} — ${money(total)} from ${s.senderName || 'your client'}`, html, text };
  }

  function paymentNoticeEmail(member, items, receiptNo) {
    const s = state.settings;
    const { methods, paidOn, total } = paidSummary(items);
    const receiptTo = s.emailReceipts && member.email ? `A receipt (${receiptNo}) was emailed to ${member.name} at ${member.email}.` : `No receipt was emailed to ${member.name}.`;
    const body = `
      ${emKV([['Paid to', esc(toLine(member))], ['Paid via', esc(methods)], ['Paid on', esc(paidOn)], ['Receipt #', esc(receiptNo)], ['Total', esc(money(total))]])}
      ${emSection(items.length > 1 ? `Itemized (${items.length} checks)` : 'Check')}
      ${items.map(itemCard).join('')}
      ${emNote(esc(receiptTo), EM.soft, EM.ink)}
      ${s.ledgerUrl ? `<div style="margin-top:16px;">${emButton(s.ledgerUrl, 'Open the ledger')}</div>` : ''}`;
    const html = emailShell({
      preheader: `${member.name} was paid ${money(total)} via ${methods}`,
      eyebrow: 'Commission paid',
      title: `${member.name} was paid ${money(total)}`,
      subtitle: esc(`${s.accountantName ? `Hi ${s.accountantName}, here’s` : 'Here’s'} a record of a commission payment.`),
      panelBig: money(total),
      panelSub: esc(`Paid via ${methods} · ${paidOn}`),
      body,
      footer: esc(`Automatic notice from ${s.senderName || 'your client'} via The Actor’s HQ.`),
    });
    const text = [
      `COMMISSION PAID — ${member.name}`, '================================================', '',
      `Paid to: ${toLine(member)}`, `Paid via: ${methods}`, `Paid on: ${paidOn}`, `Receipt #: ${receiptNo}`, `Total: ${money(total)}`, '',
      items.map(itemText).join('\n\n'), '', receiptTo, s.ledgerUrl ? `\nLedger: ${s.ledgerUrl}` : '',
    ].join('\n');
    return { subject: `Commission paid: ${member.name} ${money(total)} via ${methods} (${receiptNo})`, html, text };
  }

  function checkLoggedEmail(c) {
    const s = state.settings;
    const scans = (c.files || []).filter((f) => f.driveUrl);
    const missing = (c.files || []).length - scans.length;
    const teamTotal = round2(sum(c.splits, (x) => x.amount));
    const body = `
      ${emKV([['Deposit date', esc(fmtDate(c.receivedDate))], ['Type of work', esc(c.workType || '—')], ['Payor', esc(c.payer || '—')], ['Employer', esc(employerOf(c) || '—')], ['Check #', esc(c.checkNumber || '—')], ['Gross amount', esc(money(c.gross))], ['Net amount', esc(c.net === '' ? '—' : money(c.net))]])}
      ${c.splits.length ? `${emSection('Commissions owed')}${emKV(c.splits.map((x) => [`${x.name} · ${num(x.percent)}%`, esc(money(x.amount))]))}` : ''}
      ${emSection('Check & statement scans')}
      ${scans.length ? scans.map((f, i) => emButton(f.driveUrl, scans.length > 1 ? `View scan ${i + 1}` : 'View scan')).join('') : `<div style="color:${EM.muted};">No scan attached.</div>`}
      ${missing > 0 ? `<div style="color:${EM.muted};font-size:12px;margin-top:8px;">${missing} file${missing > 1 ? 's are' : ' is'} still uploading and will appear in the shared folder.</div>` : ''}
      ${s.ledgerUrl ? `<div style="margin-top:14px;">${emButton(s.ledgerUrl, 'Open the ledger')}</div>` : ''}`;
    const html = emailShell({
      preheader: `${money(c.gross)} gross from ${c.payer || 'SAG'} — deposited ${fmtDate(c.receivedDate)}`,
      eyebrow: 'New SAG check logged',
      title: `${money(c.gross)} from ${c.payer || 'SAG check'}`,
      subtitle: esc(`${s.accountantName ? `Hi ${s.accountantName}, a` : 'A'} new check was deposited${employerOf(c) ? ` for ${employerOf(c)}` : ''}.`),
      panelBig: money(c.gross),
      panelSub: esc(`Gross${c.net !== '' ? ` · ${money(c.net)} net` : ''} · Team commissions ${money(teamTotal)}`),
      body,
      footer: esc(`Automatic notice from ${s.senderName || 'your client'} via The Actor’s HQ.`),
    });
    const text = [
      `NEW SAG CHECK LOGGED — ${money(c.gross)} from ${c.payer || 'SAG check'}`, '================================================', '',
      `Deposit Date: ${fmtDate(c.receivedDate)}`, `Type of Work: ${c.workType || '—'}`, `Payor: ${c.payer || '—'}`, `Employer: ${employerOf(c) || '—'}`,
      `Check #: ${c.checkNumber || '—'}`, `Gross: ${money(c.gross)}`, `Net: ${c.net === '' ? '—' : money(c.net)}`, '',
      ...c.splits.map((x) => `${x.name} (${num(x.percent)}%): ${money(x.amount)}`), '',
      scans.length ? `Scans:\n${scans.map((f) => f.driveUrl).join('\n')}` : 'No scan attached.', s.ledgerUrl ? `\nLedger: ${s.ledgerUrl}` : '',
    ].join('\n');
    return { subject: `New SAG check: ${money(c.gross)} from ${c.payer || 'SAG'} (${fmtDate(c.receivedDate)})`, html, text };
  }

  function sampleEmailData() {
    let found = null;
    for (const c of [...state.checks].sort((a, b) => b.receivedDate.localeCompare(a.receivedDate))) {
      const sp = c.splits.find((x) => x.paid);
      if (sp) { found = { check: c, split: sp }; break; }
    }
    if (!found) {
      const m = state.settings.team.find((x) => x.company) || state.settings.team[0] || { id: 'sample', name: 'Manager' };
      const check = { id: 'sample', receivedDate: today(), payer: 'Warner Bros. Television', employer: 'WARNER BROS. TELEVISION', workType: 'TV / Film', checkNumber: '000123', gross: 3000, net: 2400, splitOn: 'gross', files: [], notes: '',
        splits: [{ memberId: m.id, name: m.name, percent: 10, amount: 300, paid: true, paidDate: today(), method: m.method || 'Venmo' }] };
      found = { check, split: check.splits[0] };
    }
    const member = memberById(found.split.memberId) || { id: found.split.memberId, name: found.split.name };
    const receiptNo = found.split.receiptNo || `R-${new Date().getFullYear()}-0001`;
    return { member, items: [found], receiptNo, check: found.check };
  }
  function emailPreviewHTML(m) {
    const d = sampleEmailData();
    const s = state.settings;
    const tabs = {
      receipt: { label: 'Receipt to team member', to: d.member.email || `(${d.member.name}’s email)`, mail: receiptEmail(d.member, d.items, d.receiptNo) },
      payment: { label: 'Accountant: payment made', to: s.accountantEmail || '(accountant’s email)', mail: paymentNoticeEmail(d.member, d.items, d.receiptNo) },
      check: { label: 'Accountant: new check', to: s.accountantEmail || '(accountant’s email)', mail: checkLoggedEmail(d.check) },
    };
    const tab = tabs[m.tab] ? m.tab : 'receipt';
    const t = tabs[tab];
    return `<div class="modal-card wide">
      <header><h2>Email previews</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="seg" style="align-self:flex-start;flex-wrap:wrap">${Object.entries(tabs).map(([k, v]) => `<button class="${k === tab ? 'on' : ''}" data-action="preview-tab" data-value="${k}">${esc(v.label)}</button>`).join('')}</div>
        <div class="small"><span class="muted">To:</span> <strong>${esc(t.to)}</strong><br><span class="muted">Subject:</span> <strong>${esc(t.mail.subject)}</strong></div>
        <iframe class="email-frame" title="Email preview" srcdoc="${esc(t.mail.html)}"></iframe>
        <div class="muted small">${d.check.id === 'sample' ? 'Sample data shown. Once you’ve paid someone, previews use your latest real payment.' : 'Preview uses your most recent payment.'}</div>
      </div>
      <footer><button class="btn primary" data-action="close-modal">Done</button></footer>
    </div>`;
  }
  function receiptLine(c, sp) {
    if (!sp.paid) return '';
    const member = memberById(sp.memberId);
    const jobs = (state.outbox || []).filter((j) => j.type === 'receipt' && sp.receiptNo && j.receiptNo === sp.receiptNo);
    const failed = jobs.find((j) => j.failed);
    const queued = jobs.find((j) => !j.failed);
    let txt;
    if (sp.receiptSentAt) txt = `✓ Receipt ${esc(sp.receiptNo || '')} emailed ${new Date(sp.receiptSentAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    else if (failed) txt = `<span style="color:var(--rose-ink)">Receipt didn’t send: ${esc(failed.error)}</span>`;
    else if (queued) txt = `Receipt ${esc(sp.receiptNo)} sending shortly…`;
    else if (!driveConfigured()) txt = 'Set up Google Drive in Settings to email receipts';
    else if (!member?.email) txt = `No email for ${esc(sp.name)} — add one in Settings`;
    else txt = state.settings.emailReceipts ? 'No receipt sent' : 'Automatic receipts are off';
    const canSend = driveConfigured() && member?.email && !queued;
    return `<div class="receipt-line">${txt}${canSend ? ` · <button class="linklike" data-action="send-receipt" data-check="${c.id}" data-member="${esc(sp.memberId)}">${sp.receiptSentAt ? 'Resend' : 'Send receipt now'}</button>` : ''}</div>`;
  }

  // ---------- commission rules (the single source of truth for what's "owed") ----------
  const ruleWorkText = (r) => (r.workTypes?.length ? r.workTypes.join(', ') : 'All types of work');
  const ruleEmployers = (r) => String(r.employers || '').split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ruleDate = (r, c) => (r.dateBasis !== 'payment' && c.productionDate ? c.productionDate : c.receivedDate);
  function ruleMatches(r, c) {
    const d = ruleDate(r, c);
    if (r.from && d < r.from) return false;
    if (r.to && d > r.to) return false;
    if (r.workTypes?.length && !r.workTypes.includes(c.workType)) return false;
    if (r.payTypes?.length && c.payType && !r.payTypes.includes(c.payType)) return false;
    const emps = ruleEmployers(r);
    if (emps.length) {
      const hay = `${employerOf(c)} ${c.payer || ''} ${c.project || ''}`.toLowerCase();
      if (!emps.some((e) => hay.includes(e))) return false;
    }
    return num(r.percent) > 0;
  }
  // First matching rule per person wins (rules are listed most specific first).
  const isResidual = (c) => /resid/i.test(`${c.payType || ''} ${c.workType || ''}`);
  // Fee splits written on a project (Projects tab) become rules that win over the general ones.
  function projectRules() {
    const out = [];
    for (const p of state.projects || []) {
      const words = String(p.match || p.title || '').trim();
      if (!words) continue;
      (p.splits || []).forEach((s, i) => {
        if (!s.memberId || !(num(s.percent) > 0)) return;
        out.push({ id: `proj:${p.id}:${i}`, projectId: p.id, memberId: s.memberId, percent: num(s.percent), base: 'gross', from: s.from || '', to: s.to || '',
          dateBasis: 'work', payTypes: s.payTypes ? [s.payTypes] : [], workTypes: [], employers: words, takenOutSessions: !!s.takenOut, note: p.title });
      });
    }
    return out;
  }
  const allRules = () => [...projectRules(), ...(state.rules || [])];
  function splitsFromRules(c, resolution = 'research') {
    const out = [];
    for (const r of allRules()) {
      if (out.some((s) => s.memberId === r.memberId) || !ruleMatches(r, c)) continue;
      const m = memberById(r.memberId);
      const base = num(c.gross); // every split is calculated on the gross amount
      const res = r.takenOutSessions && !isResidual(c) ? 'deducted' : resolution;
      out.push({ memberId: r.memberId, name: m?.name || 'Former member', percent: num(r.percent), base: 'gross', amount: round2((base * num(r.percent)) / 100),
        paid: false, paidDate: null, method: '', resolution: res, ruleId: r.id });
    }
    return out;
  }
  // Recalculate every commission that hasn't been resolved yet (paid / took it first / not owed stay as they are).
  function reapplyRules() {
    let changed = 0;
    for (const c of state.checks) {
      if (!c.historical) continue;
      const keep = c.splits.filter((s) => splitState(s) !== 'research');
      const fresh = splitsFromRules(c).filter((f) => !keep.some((k) => k.memberId === f.memberId));
      const next = [...keep, ...fresh];
      if (JSON.stringify(next) !== JSON.stringify(c.splits)) { c.splits = next; changed++; }
    }
    return changed;
  }
  // ---------- recalculating unpaid commissions after a rule changes ----------
  // Only commissions nobody has settled yet change: paid, "took it first" and "not owed" are never touched.
  function planRecalc() {
    const changes = [];
    const unpaid = (list) => round2(sum(list.filter((x) => ['owe', 'research'].includes(splitState(x))), (x) => num(x.amount)));
    for (const c of state.checks) {
      let next;
      if (c.historical) {
        const keep = c.splits.filter((x) => splitState(x) !== 'research');
        const fresh = splitsFromRules(c).filter((f) => !keep.some((k) => k.memberId === f.memberId));
        next = [...keep, ...fresh];
      } else {
        const fresh = splitsFromRules(c, '');
        next = c.splits.flatMap((x) => {
          if (splitState(x) !== 'owe') return [x];
          const f = fresh.find((y) => y.memberId === x.memberId);
          if (!f) return x.ruleId ? [] : [x]; // a rule-made split whose rule no longer applies goes away; hand-made ones stay
          return [{ ...x, percent: f.percent, base: 'gross', amount: f.amount, ruleId: f.ruleId, ...(f.resolution === 'deducted' ? { resolution: 'deducted' } : {}) }];
        });
        for (const f of fresh) if (!next.some((y) => y.memberId === f.memberId)) next.push(f);
      }
      // compare only what matters (who, %, amount, status) so storage details never look like a change
      const sig = (list) => JSON.stringify(list.map((x) => [x.memberId, num(x.percent), round2(num(x.amount)), splitState(x)]).sort());
      if (sig(next) !== sig(c.splits)) changes.push({ c, next, before: unpaid(c.splits), after: unpaid(next) });
    }
    return changes;
  }
  async function offerRecalc(manual) {
    const ch = planRecalc();
    if (!ch.length) { if (manual) toast('Every unpaid commission already matches your rules'); return; }
    const before = round2(sum(ch, (x) => x.before)), after = round2(sum(ch, (x) => x.after));
    const logged = ch.filter((x) => !x.c.historical).length;
    const ok = await uiConfirm(`Update ${ch.length} check${ch.length > 1 ? 's' : ''} to match your rules?\n\nUnpaid commission on ${ch.length > 1 ? 'these checks' : 'this check'} goes from ${money(before)} to ${money(after)}${logged && ch.length > 1 ? ` (${logged} of them logged in the app)` : ''}. Anything already paid, taken out first or marked not owed stays exactly as it is.`);
    if (!ok) { toast(manual ? 'Nothing changed.' : 'Rule saved — checks not changed. You can update them any time from Commission rules.'); return; }
    for (const x of ch) x.c.splits = x.next;
    save(); render();
    toast(`Updated ${ch.length} check${ch.length > 1 ? 's' : ''}`);
  }
  const ruleSentence = (r) => [
    `${num(r.percent)}% of gross`,
    r.payTypes?.length ? `${r.payTypes[0].toLowerCase()} only` : 'sessions and residuals',
    !r.from && !r.to ? 'any date' : `${r.dateBasis === 'payment' ? 'paid' : 'work done'} ${r.from ? 'from ' + fmtDate(r.from) : 'up'}${r.to ? ' to ' + fmtDate(r.to) : ' onward'}`,
    r.workTypes?.length ? r.workTypes.join(', ') : '',
    r.employers ? `only ${r.employers}` : '',
    r.takenOutSessions ? 'session cut taken out before I’m paid' : '',
  ].filter(Boolean).join(' · ');
  function viewRules() {
    const rules = state.rules || [];
    const proj = projectRules();
    const people = [...state.settings.team, ...allMembers().filter((m) => m.former && rules.some((r) => r.memberId === m.id))];
    const ruleRow = (r) => `<div class="list-item" data-action="edit-rule" data-id="${r.id}"><div class="grow"><div class="title">${esc(r.note || `${num(r.percent)}% commission`)}</div><div class="sub">${esc(ruleSentence(r))}</div></div><div class="right"><span class="amt">${num(r.percent)}%</span></div></div>`;
    const projRow = (r) => `<div class="list-item" data-action="edit-project" data-id="${esc(r.projectId)}"><div class="grow"><div class="title">${esc(r.note)} <span class="pill">Project</span></div><div class="sub">${esc(ruleSentence({ ...r, employers: '' }))} · set on the project</div></div><div class="right"><span class="amt">${num(r.percent)}%</span></div></div>`;
    return `
      <div class="page-head">
        <div><h1>Commission rules</h1><p>What each person earns from your checks. Every rule is a percentage of the gross amount. Tap a rule to change it.</p></div>
        <button class="btn white" data-action="add-rule">+ Add rule</button>
      </div>
      <div class="grid" style="max-width:860px">
        ${people.map((m) => {
          const mine = rules.filter((r) => r.memberId === m.id), mp = proj.filter((r) => r.memberId === m.id);
          return `<div class="card"><div class="card-head" style="gap:12px">${avatar(m)}<div style="flex:1"><h2 style="margin:0">${esc(m.name)}</h2>${m.company ? `<div class="muted small">${esc(m.company)}</div>` : ''}</div>${m.former ? '<span class="pill">Former</span>' : ''}</div>
            <div class="card-body stack">
              ${mine.length || mp.length ? `<div class="list">${mine.map(ruleRow).join('')}${mp.map(projRow).join('')}</div>` : '<div class="muted small">No rules yet — nothing is counted as owed to them.</div>'}
              ${m.former ? '' : `<div class="row"><button class="btn sm" data-action="add-rule" data-member="${esc(m.id)}">+ Add rule for ${esc(m.name)}</button></div>`}
            </div></div>`;
        }).join('')}
        <div class="card"><div class="card-head"><h2>How rules work</h2></div><div class="card-body stack">
          <ul class="small muted" style="margin:0;padding-left:18px;line-height:1.6">
            <li>A split written on a project (Projects tab) wins over these rules for that project.</li>
            <li>If someone’s rate changed, end the old rule on the last day and add a new one starting the next day.</li>
            <li>After you change a rule, the app shows which unpaid commissions would change and asks before updating them. Paid ones never change.</li>
          </ul>
          <div class="row"><button class="btn" data-action="reapply-rules">Check unpaid commissions against these rules</button></div>
        </div></div>
      </div>`;
  }

  function ruleFormHTML(m) {
    const r = m.id ? (state.rules || []).find((x) => x.id === m.id) : { memberId: m.memberId || state.settings.team[0]?.id, percent: '', base: state.settings.splitBase || 'gross', from: '', to: '', workTypes: [], employers: '', note: '' };
    if (!r) return null;
    const works = uniq([...WORK_TYPES, ...state.checks.map((x) => x.workType)]);
    return `<form class="modal-card" data-form="rule" autocomplete="off">
      <header><h2>${m.id ? 'Edit' : 'Add'} commission rule</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="callout" style="background:var(--lavender);color:var(--text)">Write down the deal as it actually was, ideally straight from the signed agreement. If a rate changed, or someone only covered certain work, add a separate rule for each period or type of work.</div>
        <div class="grid2">
          <label>Team member<select name="memberId">${state.settings.team.map((t) => `<option value="${esc(t.id)}" ${t.id === r.memberId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
          <label><span>Commission % <span class="req">*</span></span><input name="percent" type="number" step="0.01" min="0" max="100" required value="${esc(r.percent)}" placeholder="e.g. 10"></label>
          <label>Calculated on<input value="Gross amount (all splits use gross)" disabled></label>
          <label>Role / note<input name="note" value="${esc(r.note || '')}" placeholder="e.g. Commercial agent"></label>
          <label>Starting<input name="from" type="date" value="${esc(r.from || '')}"></label>
          <label>Ending (leave blank if ongoing)<input name="to" type="date" value="${esc(r.to || '')}"></label>
          <label>Those dates are about<select name="dateBasis"><option value="work" ${r.dateBasis !== 'payment' ? 'selected' : ''}>When the work was done</option><option value="payment" ${r.dateBasis === 'payment' ? 'selected' : ''}>When I was paid</option></select></label>
          <label>Applies to<select name="payTypes"><option value="" ${!r.payTypes?.length ? 'selected' : ''}>Sessions and residuals</option><option value="Sessions" ${r.payTypes?.length === 1 && r.payTypes[0] === 'Sessions' ? 'selected' : ''}>Sessions only</option><option value="Residuals" ${r.payTypes?.length === 1 && r.payTypes[0] === 'Residuals' ? 'selected' : ''}>Residuals only</option></select></label>
        </div>
        <div class="muted small" style="margin-top:-6px">Most deals cover work done while that person represented you, so “when the work was done” is the usual choice. Entries with no work date fall back to the payment date.</div>
        <div>
          <div class="field-label">Only on these types of work <span class="muted">(choose none = all work)</span></div>
          <div class="choice-pills">${works.map((w) => `<label class="choice"><input type="checkbox" name="workTypes" value="${esc(w)}" ${r.workTypes?.includes(w) ? 'checked' : ''}><span>${esc(w)}</span></label>`).join('')}</div>
        </div>
        <label class="inline"><input type="checkbox" name="takenOutSessions" ${r.takenOutSessions ? 'checked' : ''}> Their cut on <b>session</b> checks is taken out before the check reaches me (common for agents). Residuals stay owed.</label>
        <label>Only on these employers, payors or projects <span class="muted" style="font-weight:400">(optional, separate with commas — e.g. jobs this person booked)</span><input name="employers" value="${esc(r.employers || '')}" placeholder="e.g. Warner Bros, Nickelodeon"></label>
      </div>
      <footer>
        ${m.id ? `<button type="button" class="btn ghost danger" data-action="delete-rule" data-id="${r.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">Save rule</button>
      </footer>
    </form>`;
  }
  function submitRuleForm(form) {
    const f = form.elements;
    const data = {
      memberId: f.memberId.value, percent: num(f.percent.value), base: 'gross', note: f.note.value.trim(),
      from: f.from.value || '', to: f.to.value || '', employers: f.employers.value.trim(),
      dateBasis: f.dateBasis.value, payTypes: f.payTypes.value ? [f.payTypes.value] : [], takenOutSessions: !!f.takenOutSessions?.checked,
      workTypes: [...form.querySelectorAll('input[name="workTypes"]:checked')].map((x) => x.value),
    };
    if (data.from && data.to && data.to < data.from) return toast('The end date is before the start date.', { error: true });
    state.rules = state.rules || [];
    if (ui.modal.id) Object.assign(state.rules.find((x) => x.id === ui.modal.id), data);
    else state.rules.push({ id: uid(), ...data });
    state.audit.rulesConfirmed = false;
    save(); closeModal(); render();
    toast('Rule saved');
    offerRecalc();
  }

  // ---------- importing past checks ----------
  const IMPORT_FIELDS = [
    ['receivedDate', 'Deposit / applied date', true], ['gross', 'Gross amount', true], ['net', 'Net amount'], ['productionDate', 'Work / production date'],
    ['payer', 'Payor'], ['employer', 'Employer'], ['project', 'Project / show'], ['workType', 'Type of work'], ['payType', 'Sessions or residuals'],
    ['checkNumber', 'Check number'], ['reference', 'Reference / report number'], ['files', 'Scan / statement links'], ['notes', 'Notes'],
    ['legacyTotal', 'Old tracker: total owed to team'],
  ];
  const GUESS = {
    receivedDate: [/deposit|applied/i, /check date|date (paid|received|issued)|^date$/i, /date/i],
    productionDate: [/production date|work date|session date|perform/i],
    gross: [/gross/i, /^amount$|check amount|total/i],
    net: [/\bnet\b/i],
    payer: [/payor|payer/i, /paid by|payroll/i],
    employer: [/employer/i, /studio|client|company/i],
    project: [/^project( name)?$|^show$|^title$|^production$/i],
    workType: [/type of work|work type|project type/i, /category/i],
    payType: [/^type$|payment type|earnings type|session.*residual/i],
    checkNumber: [/check\s*(#|no|num)/i],
    reference: [/^number$|reference|\bref\b|report (no|num|#)/i],
    files: [/scan|statement/i, /upload|attachment|file|link/i],
    notes: [/note|memo|description/i],
    legacyTotal: [/total (owed|commission)|commissions?$|owed|team (split|cut)/i],
  };
  const normPayType = (v) => { const s = String(v ?? '').trim(); return /resid/i.test(s) ? 'Residuals' : /session|original|initial/i.test(s) ? 'Sessions' : s; };
  function parseCSV(text) {
    const first = text.split(/\r?\n/)[0] || '';
    const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => String(v).trim()));
  }
  async function loadXLSX() {
    if (window.XLSX) return window.XLSX;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('Couldn’t load the Excel reader (needs internet). You can also save the file as CSV and import that.'));
      document.head.appendChild(s);
    });
    return window.XLSX;
  }
  async function readTable(file) {
    if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const sheets = wb.SheetNames.map((n) => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }).filter((r) => r.some((v) => String(v).trim())) }));
      return sheets.filter((s) => s.rows.length > 1);
    }
    return [{ name: file.name, rows: parseCSV(await file.text()) }];
  }
  function parseDateAny(v) {
    if (v instanceof Date && !isNaN(v)) return toISO(v);
    if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return toISO(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
    const s = String(v ?? '').trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; if (+m[1] > 12) return `${y}-${pad(+m[2])}-${pad(+m[1])}`; return `${y}-${pad(+m[1])}-${pad(+m[2])}`; }
    const d = new Date(s);
    return isNaN(d) ? null : toISO(d);
  }
  function parseMoney(v) {
    if (typeof v === 'number') return round2(v);
    const s = String(v ?? '').replace(/[$,\s]/g, '');
    if (!s || s === '-') return null;
    const n = parseFloat(s.replace(/[()]/g, ''));
    return isNaN(n) ? null : round2(/^\(.*\)$/.test(s) ? -n : n);
  }
  function guessMapping(headers) {
    const map = {};
    const used = new Set();
    for (let tier = 0; tier < 3; tier++) {
      for (const [field] of IMPORT_FIELDS) {
        if (map[field] !== undefined) continue;
        const re = GUESS[field]?.[tier];
        if (!re) continue;
        const idx = headers.findIndex((h, i) => !used.has(i) && re.test(String(h)));
        if (idx >= 0) { map[field] = idx; used.add(idx); }
      }
    }
    // A column named after a team member = what the old tracker said that person was owed
    const legacy = {};
    for (const m of state.settings.team) {
      const idx = headers.findIndex((h, i) => !used.has(i) && new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(h)));
      if (idx >= 0) { legacy[m.id] = idx; used.add(idx); }
    }
    for (const [field] of IMPORT_FIELDS) if (map[field] === undefined) map[field] = -1;
    return { map, legacy };
  }
  function buildImport(d) {
    const { map, legacy } = d.mapping;
    const col = (row, f) => (map[f] >= 0 ? row[map[f]] : '');
    const seen = new Set();
    const keyOf = (r) => (r.reference ? `ref:${r.reference}` : `${r.receivedDate}|${round2(r.gross)}|${r.checkNumber || ''}|${r.payer || ''}|${r.project || ''}`);
    const existing = new Set(state.checks.map(keyOf));
    return d.rows.map((row, i) => {
      const receivedDate = parseDateAny(col(row, 'receivedDate'));
      const gross = parseMoney(col(row, 'gross'));
      const net = parseMoney(col(row, 'net'));
      if (!receivedDate || (gross == null && net == null)) return { i, skip: 'Missing a date or amount' };
      const wtRaw = String(col(row, 'workType') ?? '').trim();
      const rec = {
        receivedDate, gross: gross ?? net, net: net ?? '',
        productionDate: parseDateAny(col(row, 'productionDate')) || '',
        payer: String(col(row, 'payer') ?? '').trim(), employer: String(col(row, 'employer') ?? '').trim(),
        project: String(col(row, 'project') ?? '').trim(),
        workType: WORK_TYPES.find((w) => w.toLowerCase() === wtRaw.toLowerCase()) || wtRaw,
        payType: normPayType(col(row, 'payType')),
        reference: String(col(row, 'reference') ?? '').trim(),
        checkNumber: String(col(row, 'checkNumber') ?? '').trim(), notes: String(col(row, 'notes') ?? '').trim(),
        links: String(col(row, 'files') ?? '').match(/https?:\/\/[^\s,]+/g) || [],
        legacyTotal: parseMoney(col(row, 'legacyTotal')),
        legacyByMember: Object.fromEntries(Object.entries(legacy).filter(([, idx]) => idx >= 0).map(([id, idx]) => [id, parseMoney(row[idx])]).filter(([, v]) => v != null)),
      };
      const key = keyOf(rec);
      if (existing.has(key)) return { i, rec, skip: 'Already in the app' };
      // Without a reference number, identical lines can still be real (e.g. three equal session fees on one day) — keep them, but count them.
      if (seen.has(key) && rec.reference) return { i, rec, skip: 'Repeated in this file' };
      seen.add(key);
      return { i, rec };
    });
  }
  async function startImport(file) {
    try {
      const sheets = await readTable(file);
      if (!sheets.length) throw new Error('That file looks empty.');
      ui.importData = { fileName: file.name, sheets, sheet: 0 };
      selectImportSheet(0);
      openModal({ type: 'importHistory' });
    } catch (e) { toast(e.message, { error: true }); }
  }
  function selectImportSheet(i) {
    const d = ui.importData;
    d.sheet = i;
    const rows = d.sheets[i].rows;
    let h = rows.findIndex((r) => r.filter((v) => String(v).trim()).length >= 2);
    if (h < 0) h = 0;
    d.headers = rows[h].map((v, j) => String(v).trim() || `Column ${j + 1}`);
    d.rows = rows.slice(h + 1);
    d.mapping = guessMapping(d.headers);
  }
  function importHTML() {
    const d = ui.importData;
    if (!d) return null;
    const results = buildImport(d);
    const ok = results.filter((r) => !r.skip);
    const skipped = results.filter((r) => r.skip);
    const reasons = {};
    skipped.forEach((r) => { reasons[r.skip] = (reasons[r.skip] || 0) + 1; });
    const years = uniq(ok.map((r) => r.rec.receivedDate.slice(0, 4))).sort();
    const opt = (sel) => `<option value="-1">— not in file —</option>${d.headers.map((h, j) => `<option value="${j}" ${sel === j ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    return `<div class="modal-card wide">
      <header><div><h2>Import past checks</h2><div class="muted small" style="margin-top:4px">${esc(d.fileName)} · ${d.rows.length} rows</div></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        ${d.sheets.length > 1 ? `<label>Which tab?<select data-import-sheet>${d.sheets.map((s, i) => `<option value="${i}" ${i === d.sheet ? 'selected' : ''}>${esc(s.name)} (${s.rows.length - 1} rows)</option>`).join('')}</select></label>` : ''}
        <fieldset><legend>Match your columns</legend>
          <div class="grid2">${IMPORT_FIELDS.map(([f, label, req]) => `<label><span>${label}${req ? ' <span class="req">*</span>' : ''}</span><select data-import-map="${f}">${opt(d.mapping.map[f])}</select></label>`).join('')}</div>
          ${state.settings.team.length ? `<div class="field-label" style="margin-top:14px">Old tracker: amount owed to each person <span class="muted">(only for comparison — never used as the real owed amount)</span></div>
          <div class="grid2">${state.settings.team.map((m) => `<label>${esc(m.name)}<select data-import-legacy="${esc(m.id)}">${opt(d.mapping.legacy[m.id] ?? -1)}</select></label>`).join('')}</div>` : ''}
        </fieldset>
        <div class="row">
          <span class="pill green">${ok.length} entr${ok.length === 1 ? 'y' : 'ies'} ready</span>
          ${Object.entries(reasons).map(([k, n]) => `<span class="pill amber">${n} skipped · ${esc(k)}</span>`).join('')}
          ${years.length ? `<span class="pill">${years[0]}${years.length > 1 ? '–' + years[years.length - 1] : ''}</span><span class="pill">${money(sum(ok, (r) => r.rec.gross))} gross</span>` : ''}
        </div>
        ${ok.length ? `<div class="table-wrap" style="padding:0;max-height:260px;overflow:auto"><table>
          <thead><tr><th>Paid</th><th>Work date</th><th>Employer / project</th><th>Type</th><th class="right">Gross</th><th class="right">Net</th><th class="right">Old tracker owed</th></tr></thead>
          <tbody>${ok.slice(0, 50).map(({ rec: r }) => `<tr><td class="num" style="white-space:nowrap">${fmtDate(r.receivedDate)}</td><td class="num muted" style="white-space:nowrap">${r.productionDate ? fmtDate(r.productionDate) : '—'}</td>
            <td><div class="title">${esc(r.employer || r.payer || '—')}</div><div class="sub">${esc([r.project, r.payer && r.payer !== r.employer ? 'via ' + r.payer : ''].filter(Boolean).join(' · '))}</div></td>
            <td><div>${esc(r.workType || '—')}</div>${r.payType ? `<div class="sub">${esc(r.payType)}</div>` : ''}</td>
            <td class="right num" style="${r.gross < 0 ? 'color:var(--rose-ink)' : ''}">${money(r.gross)}</td><td class="right num">${r.net === '' ? '—' : money(r.net)}</td>
            <td class="right num">${r.legacyTotal != null ? money(r.legacyTotal) : Object.keys(r.legacyByMember).length ? money(sum(Object.values(r.legacyByMember), (x) => x)) : '—'}</td></tr>`).join('')}</tbody>
        </table></div>${ok.length > 50 ? `<div class="muted small">Showing the first 50 of ${ok.length}.</div>` : ''}` : '<div class="empty">Nothing to import yet. Check that the deposit date and amount columns are matched above.</div>'}
        ${ok.some((r) => r.rec.gross < 0) ? `<div class="callout" style="background:var(--peach);color:var(--peach-ink)"><strong>${ok.filter((r) => r.rec.gross < 0).length} negative lines</strong> (${money(sum(ok.filter((r) => r.rec.gross < 0), (r) => r.rec.gross))}) are reversals or corrections. They’re imported too, so the commission on them subtracts and totals stay accurate.</div>` : ''}
        <div class="callout" style="background:var(--lavender);color:var(--text)">Imported checks are marked as <strong>past checks</strong>. Each person's commission is worked out from your <strong>commission rules</strong> and starts as <em>Needs research</em> until you confirm what really happened. No emails or receipts are sent for imported checks.</div>
      </div>
      <footer><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="do-import" ${ok.length ? '' : 'disabled'}>Import ${ok.length} entr${ok.length === 1 ? 'y' : 'ies'}</button></footer>
    </div>`;
  }
  function doImport() {
    const d = ui.importData;
    const ok = buildImport(d).filter((r) => !r.skip);
    const batch = uid();
    for (const { rec } of ok) {
      const c = {
        id: uid(), createdAt: new Date().toISOString(), historical: true, importBatch: batch,
        receivedDate: rec.receivedDate, gross: rec.gross, net: rec.net, payer: rec.payer, employer: rec.employer, workType: rec.workType,
        productionDate: rec.productionDate, project: rec.project, payType: rec.payType, reference: rec.reference,
        checkNumber: rec.checkNumber, notes: rec.notes, splitOn: state.settings.splitBase,
        files: rec.links.map((url, i) => ({ id: uid(), name: `Scan ${i + 1}`, status: 'uploaded', driveUrl: url, type: '', size: 0, addedAt: new Date().toISOString() })),
        legacy: rec.legacyTotal != null || Object.keys(rec.legacyByMember).length ? { total: rec.legacyTotal, byMember: rec.legacyByMember } : null,
      };
      c.splits = splitsFromRules(c);
      state.checks.push(c);
    }
    state.imports.push({ id: batch, at: new Date().toISOString(), fileName: d.fileName, count: ok.length });
    ui.importData = null;
    save(); closeModal();
    go('audit');
    toast(`Imported ${ok.length} past entr${ok.length === 1 ? 'y' : 'ies'}`);
  }

  // ---------- payout audit ----------
  const AUDIT_SOURCES = [
    ['venmo', 'Venmo statements', 'Venmo app → Me → ⚙︎ → Statements (monthly CSV). Search the person’s name.'],
    ['zelle', 'Bank statements / Zelle history', 'Online banking → Statements, or Zelle → Activity. Zelle shows up on your checking statement.'],
    ['checks', 'Cancelled checks', 'Your bank keeps images of cashed checks. Search by payee or amount.'],
    ['paypal', 'PayPal / Cash App', 'PayPal → Activity → Statements; Cash App → Activity → Export.'],
    ['statements', 'Their statements to you', 'If checks went to them first, their payout statements show the commission they kept.'],
    ['ask', 'Ask them for their records', 'They track what they received for their own taxes. Ask for a list by year.'],
    ['tax', '1099s & tax returns', 'Any 1099-NEC you filed, or commissions listed on your Schedule C, give a yearly total to match against.'],
  ];
  const auditKey = (memberId, year) => `${memberId}|${year}`;
  function cellSplits(memberId, year) {
    const out = [];
    for (const c of state.checks) {
      if (!(c.receivedDate || '').startsWith(String(year))) continue;
      const s = c.splits.find((x) => x.memberId === memberId);
      if (s) out.push({ check: c, split: s });
    }
    return out.sort((a, b) => a.check.receivedDate.localeCompare(b.check.receivedDate));
  }
  function stats(items) {
    const t = { total: 0, paid: 0, owe: 0, research: 0, deducted: 0, notOwed: 0, n: items.length, nResearch: 0, legacy: 0, legacyDiff: 0 };
    for (const { check: c, split: s } of items) {
      const st = splitState(s);
      t[st] += num(s.amount);
      if (st !== 'notOwed') t.total += num(s.amount);
      if (st === 'research') t.nResearch++;
      const lg = c.legacy?.byMember?.[s.memberId];
      if (lg != null) { t.legacy += lg; if (Math.abs(lg - s.amount) > 0.99) t.legacyDiff++; }
    }
    for (const k of ['total', 'paid', 'owe', 'research', 'deducted', 'notOwed', 'legacy']) t[k] = round2(t[k]);
    return t;
  }
  const auditYears = () => uniq(state.checks.map((c) => (c.receivedDate || '').slice(0, 4)).filter(Boolean)).sort().reverse();
  const auditMembers = () => allMembers().filter((m) => !m.former || state.checks.some((c) => c.splits.some((s) => s.memberId === m.id)));
  const evidenceAllocated = (e) => round2(sum(state.checks.flatMap((c) => c.splits.filter((s) => s.evidenceId === e.id)), (s) => s.amount));
  function legacyMismatches() {
    const list = [];
    for (const c of state.checks) {
      if (!c.legacy) continue;
      const calc = round2(sum(c.splits, (s) => s.amount));
      if (c.legacy.total != null && Math.abs(c.legacy.total - calc) > 0.99) list.push({ c, calc, said: c.legacy.total });
      else for (const s of c.splits) { const lg = c.legacy.byMember?.[s.memberId]; if (lg != null && Math.abs(lg - s.amount) > 0.99) { list.push({ c, calc, said: c.legacy.total ?? sum(Object.values(c.legacy.byMember), (x) => x) }); break; } }
    }
    return list;
  }
  function nextStep() {
    const hist = state.checks.filter((c) => c.historical);
    if (!state.rules?.length || !state.rules.some((r) => num(r.percent) > 0)) return { title: 'Write down each person’s deal', text: 'Before any number counts as “owed”, add a commission rule for each person: the rate, gross or net, which work, and when it started. Find the signed agreements or emails where you agreed to it.', action: 'add-rule', label: 'Add a commission rule' };
    if (!hist.length) return { title: 'Bring in your past checks', text: 'Import the spreadsheet of checks you’ve received (your old tracker or the Google Form responses). Download it as CSV or Excel first.', action: 'pick-import', label: 'Import past checks' };
    if (!state.audit.rulesConfirmed) return { title: 'Confirm the commission rules', text: 'Look over each rule against the signed agreements. Every “owed” amount comes from these rules, so they have to be right before you chase payments.', action: 'confirm-rules', label: 'These rules are right' };
    const mism = legacyMismatches();
    if (mism.length && !state.audit.mismatchReviewed) return { title: `${mism.length} check${mism.length > 1 ? 's' : ''} don’t match your old tracker`, text: 'Your old tracker’s owed amount is different from what the rules calculate. For each one, decide which is right. If the rule is wrong, fix the rule. If the old tracker was wrong, the rules win.', action: 'review-mismatch', label: 'I’ve reviewed these' };
    for (const y of [...auditYears()].reverse()) {
      for (const m of auditMembers()) {
        const t = stats(cellSplits(m.id, y));
        if (t.nResearch) return { title: `Next: ${m.name} · ${y}`, text: `${t.nResearch} commission${t.nResearch > 1 ? 's' : ''} (${money(t.research)}) still need research. Work oldest year first: pull ${y}’s payment history, log what you find, then auto-match.`, action: 'open-cell', member: m.id, year: y, label: `Open ${m.name} · ${y}` };
      }
    }
    const owe = unpaidSplits();
    if (owe.length) return { title: 'Research done — settle what’s still owed', text: `${money(sum(owe, (o) => o.split.amount))} is confirmed unpaid. Pay it from Team Payouts. Receipts and accountant emails go out as usual.`, href: '#team', label: 'Go to Team Payouts' };
    return { title: 'Everything is accounted for', text: 'Download the audit and send it to your accountant to check against your tax returns and any 1099s.', action: 'export-audit', label: 'Download audit (CSV)' };
  }
  function viewAudit() {
    const years = auditYears();
    const members = auditMembers();
    const all = members.flatMap((m) => years.flatMap((y) => cellSplits(m.id, y)));
    const t = stats(all);
    const resolvedPct = t.total ? Math.round(((t.total - t.research) / t.total) * 100) : 0;
    const step = nextStep();
    const mism = legacyMismatches();
    return `
      <div class="page-head">
        <div><div class="eyebrow">History &amp; audit</div><h1>Payout audit</h1><p>Rebuild what you earned and what you owe each person, one year at a time, with proof for every number.</p></div>
        <div class="row"><label class="btn white" style="flex-direction:row;color:var(--text);font-size:14px">Import past checks<input type="file" id="import-history-file" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" hidden></label><label class="btn white" style="flex-direction:row;color:var(--text);font-size:14px">Load prepared data<input type="file" id="import-pack-file" accept="application/json,.json" hidden></label><label class="btn white" style="flex-direction:row;color:var(--text);font-size:14px">Import payments<input type="file" id="import-pay-file" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" hidden></label>${addButton('add-evidence', 'Log a payment I found')}</div>
      </div>
      <section class="hero coach">
        <div class="orb" aria-hidden="true"></div>
        <div class="eyebrow-dark">Your coach · next step</div>
        <h2>${esc(step.title)}</h2>
        <p class="coach-text">${esc(step.text)}</p>
        <div class="hero-panel">
          <div class="grow"><div class="big">${t.total ? resolvedPct + '%' : '—'}</div><div class="sub">${t.total ? `of ${money(t.total)} in commissions accounted for · ${money(t.research)} still to research` : 'No commissions calculated yet'}</div>
            ${t.total ? `<div class="meter dark" style="margin-top:10px"><span style="width:${resolvedPct}%"></span></div>` : ''}</div>
          ${step.href ? `<a class="btn" href="${step.href}">${esc(step.label)}</a>` : step.action === 'pick-import' ? `<label class="btn" style="flex-direction:row;color:#111114;font-size:14px">${esc(step.label)}<input type="file" id="import-history-file-2" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" hidden></label>`
            : `<button class="btn" data-action="${step.action}" ${step.member ? `data-member="${esc(step.member)}" data-year="${step.year}"` : ''}>${esc(step.label)}</button>`}
        </div>
      </section>

      ${balancePanel()}
      <div style="height:16px"></div>
      <div class="grid tiles">
        <div class="card tile"><div class="label">Commissions (all years)</div><div class="value">${money(t.total)}</div><div class="sub">${t.n} commissions · based on your rules</div></div>
        <div class="card tile"><div class="label">Confirmed paid</div><div class="value" style="color:var(--mint-ink)">${money(t.paid)}</div><div class="sub">${money(t.deducted)} taken out by agent/manager</div></div>
        <div class="card tile owed"><div class="label">Needs research</div><div class="value" style="color:var(--lavender-ink)">${money(t.research)}</div><div class="sub">${t.nResearch} commission${t.nResearch === 1 ? '' : 's'}</div></div>
        <div class="card tile ${t.owe ? 'warn' : ''}"><div class="label">Confirmed still owed</div><div class="value">${money(t.owe)}</div><div class="sub">Calculated, not from the old tracker</div></div>
      </div>

      <div class="grid dash">
        <div class="grid">
          <div class="card">
            <div class="card-head"><h2>Year by person</h2><span class="muted small">Click a box to work on it</span></div>
            <div class="card-body">${years.length && members.length ? `<div class="table-wrap" style="padding:0"><table class="audit-grid">
              <thead><tr><th>Year</th>${members.map((m) => `<th>${esc(m.name)}</th>`).join('')}</tr></thead>
              <tbody>${years.map((y) => `<tr><td class="year">${y}</td>${members.map((m) => auditCell(m, y)).join('')}</tr>`).join('')}</tbody>
            </table></div>` : '<div class="empty">Import your past checks to see each year here.</div>'}</div>
          </div>
          ${mism.length ? `<div class="card"><div class="card-head"><h2>Old tracker vs. your rules</h2><span class="pill amber">${mism.length} don’t match</span></div>
            <div class="card-body"><p class="muted small" style="margin-top:0">The “owed” amount in your old tracker is different from what your commission rules calculate. Open each one to decide which is right.</p><div class="list">${mism.slice(0, 12).map(({ c, calc, said }) => `
              <div class="list-item" data-action="open-check" data-id="${c.id}"><div class="grow"><div class="title">${checkLabel(c)}</div><div class="sub">${fmtDate(c.receivedDate)} · ${money(c.gross)} gross</div></div>
              <div class="right"><div class="small muted">Old tracker ${money(said)}</div><div class="amt">Rules ${money(calc)}</div></div></div>`).join('')}</div>
              ${mism.length > 12 ? `<div class="muted small" style="margin-top:8px">…and ${mism.length - 12} more. Use the CSV export to see them all.</div>` : ''}</div></div>` : ''}
        </div>
        <div class="grid">
          ${rulesCard()}
          ${fiveCard()}
          ${evidenceCard()}
          <div class="card"><div class="card-head"><h2>For your accountant</h2></div><div class="card-body stack">
            <p class="muted small" style="margin:0">Every commission with its status and proof. Good for 1099s and for checking against past tax returns.</p>
            <div class="row"><button class="btn primary" data-action="open-reports" data-tab="accountant">Open accountant package</button><button class="btn" data-action="open-reports" data-tab="statement">Payment statement</button></div>
            <div class="row"><button class="btn" data-action="export-audit">Download detail (CSV)</button><button class="btn" data-action="export-audit-summary">Summary by year (CSV)</button></div>
            ${state.imports.length ? `<h3 style="margin-top:6px">Imports</h3><div class="list">${state.imports.map((im) => `<div class="list-item"><div class="grow"><div class="title">${esc(im.fileName)}</div><div class="sub">${im.count} entries · ${new Date(im.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div></div><button class="btn sm ghost danger" data-action="undo-import" data-id="${im.id}">Undo import</button></div>`).join('')}</div>` : ''}
          </div></div>
        </div>
      </div>
      <div style="height:16px"></div>
      ${claimsCard()}`;
  }
  function auditCell(m, y) {
    const t = stats(cellSplits(m.id, y));
    if (!t.n) return '<td><span class="muted">—</span></td>';
    let pill;
    if (t.nResearch) pill = `<span class="pill purple">${money(t.research)} to research</span>`;
    else if (t.owe) pill = `<span class="pill red">${money(t.owe)} still owed</span>`;
    else pill = '<span class="pill green">✓ Settled</span>';
    return `<td><button class="audit-cell" data-action="open-cell" data-member="${esc(m.id)}" data-year="${y}">
      <span class="amt">${money(t.total)}</span>${pill}${(() => { const n = cellSplits(m.id, y).filter(({ check, split }) => isPossibleFive(check, split)).length; return n ? `<span class="small" style="color:var(--peach-ink)">⚑ ${n} possible 5%</span>` : ''; })()}${t.legacyDiff ? `<span class="small" style="color:var(--peach-ink)">${t.legacyDiff} differ from old tracker</span>` : ''}</button></td>`;
  }
  function rulesCard() {
    const rules = state.rules || [];
    return `<div class="card"><div class="card-head"><h2>Commission rules</h2>${rules.length ? (state.audit.rulesConfirmed ? '<span class="pill green">Confirmed</span>' : '<span class="pill amber">Not confirmed</span>') : ''}</div>
      <div class="card-body stack">
        <p class="muted small" style="margin:0">These decide what each person is owed. Nothing from the old tracker is trusted until it matches a rule.</p>
        ${rules.length ? `<div class="list">${rules.map((r) => { const m = memberById(r.memberId); return `
          <div class="list-item" data-action="edit-rule" data-id="${r.id}">${avatar(m || { id: r.memberId, name: '?', former: true })}
            <div class="grow"><div class="title">${esc(m?.name || 'Former member')} · ${num(r.percent)}% of ${r.base === 'net' ? 'net' : 'gross'}${r.note ? ` <span class="muted" style="font-weight:500">· ${esc(r.note)}</span>` : ''}</div>
            <div class="sub">${r.dateBasis === 'payment' ? 'Paid ' : 'Work done '}${r.from ? fmtDate(r.from) : 'any time'} → ${r.to ? fmtDate(r.to) : 'now'} · ${r.payTypes?.length ? esc(r.payTypes[0]) + ' only · ' : ''}${esc(ruleWorkText(r))}${r.employers ? ` · only ${esc(r.employers)}` : ''}</div></div></div>`; }).join('')}</div>`
          : `<div class="muted">No rules yet. Add one for each person, with a separate rule for each rate or period.</div>`}
        <div class="row"><a class="btn sm" href="#rules">Open rules page</a><button class="btn sm primary" data-action="add-rule">+ Add rule</button>${rules.length ? `<button class="btn sm" data-action="reapply-rules">Recalculate unresolved</button>${state.audit.rulesConfirmed ? '' : '<button class="btn sm" data-action="confirm-rules">These rules are right</button>'}` : ''}</div>
      </div></div>`;
  }
  function evidenceCard() {
    const ev = [...(state.evidence || [])].sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="card"><div class="card-head"><h2>Payments you found</h2><span class="muted small">${ev.length}</span></div>
      <div class="card-body stack">
        <p class="muted small" style="margin:0">Every payment you find in Venmo, Zelle, bank or check history. Log it here, then auto-match it to the commissions it covered.</p>
        ${ev.length ? `<div class="list">${ev.slice(0, 8).map(evidenceRow).join('')}</div>${ev.length > 8 ? `<div class="muted small">…and ${ev.length - 8} more (shown inside each person-year).</div>` : ''}` : ''}
        <div class="row"><button class="btn sm primary" data-action="add-evidence">+ Log a payment I found</button><label class="btn sm" style="flex-direction:row;color:var(--text)">Import payments (CSV)<input type="file" id="import-pay-file-2" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" hidden></label>${ev.length ? `<button class="btn sm" data-action="match-all">Match payments to jobs</button>` : ''}</div>
      </div></div>`;
  }
  function evidenceRow(e) {
    const used = evidenceAllocated(e);
    const left = round2(e.amount - used);
    return `<div class="list-item">${avatar(memberById(e.memberId) || { id: e.memberId, name: '?', former: true })}
      <div class="grow"><div class="title">${money(e.amount)} to ${esc(memberById(e.memberId)?.name || 'former member')}</div>
      <div class="sub">${fmtDate(e.date)} · ${esc(e.method || '—')}${e.kind ? ' · ' + KIND_LABEL[e.kind] : ''}${e.reference ? ' · ' + esc(e.reference) : ''}</div>${e.memo ? `<div class="sub" style="font-style:italic">“${esc(e.memo)}”</div>` : ''}</div>
      ${left <= 0.99 ? '<span class="pill green">Matched</span>' : used ? `<span class="pill amber">${money(left)} unmatched</span>` : '<span class="pill">Not matched</span>'}
      <button class="btn sm" data-action="open-match" data-id="${e.id}">Match to…</button>
      <button class="icon-btn plain" title="Delete" data-action="delete-evidence" data-id="${e.id}">×</button></div>`;
  }
  function evidenceFormHTML(m) {
    return `<form class="modal-card" data-form="evidence" autocomplete="off">
      <header><h2>Log a payment you found</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="grid2">
          <label>Paid to<select name="memberId">${state.settings.team.map((t) => `<option value="${esc(t.id)}" ${t.id === m.memberId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
          <label><span>Amount <span class="req">*</span></span><input name="amount" type="number" step="0.01" min="0" required placeholder="0.00"></label>
          <label><span>Date sent <span class="req">*</span></span><input name="date" type="date" required value="${m.year ? '' : today()}"></label>
          <label>How<input name="method" list="method-list" placeholder="Venmo, Zelle, check…"></label>
        </div>
        <label>Reference <span class="muted" style="font-weight:400">(transaction ID, check #, or the memo)</span><input name="reference" placeholder="Optional"></label>
        <label>Where you found it<input name="notes" placeholder="e.g. Chase statement, March 2022"></label>
        <label class="inline"><input type="checkbox" name="autoMatch" checked> Auto-match it to the oldest unpaid commissions</label>
      </div>
      <datalist id="method-list">${PAY_METHODS.map((x) => `<option value="${x}">`).join('')}</datalist>
      <footer><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">Save payment</button></footer>
    </form>`;
  }
  function addEvidence(data, match) {
    const e = { id: uid(), createdAt: new Date().toISOString(), ...data };
    state.evidence.push(e);
    const r = match ? autoMatch(e.memberId) : { matched: 0, amt: 0 };
    save();
    toast(`Logged ${money(e.amount)}${r.matched ? ` — matched to ${r.matched} commission${r.matched > 1 ? 's' : ''} (${money(r.amt)})` : match ? ' — no commissions it could cover yet' : ''}`);
  }
  // Oldest-first: each payment covers the oldest unresolved commissions deposited on or before the payment date.
  function autoMatch(memberId) {
    const open = [];
    for (const c of [...state.checks].sort((a, b) => a.receivedDate.localeCompare(b.receivedDate))) {
      const s = c.splits.find((x) => x.memberId === memberId);
      if (s && ['research', 'owe'].includes(splitState(s))) open.push({ c, s });
    }
    let matched = 0, amt = 0;
    for (const e of state.evidence.filter((x) => x.memberId === memberId).sort((a, b) => a.date.localeCompare(b.date))) {
      let remaining = round2(e.amount - evidenceAllocated(e));
      for (const o of open) {
        if (o.s.paid) continue;
        if (o.c.receivedDate > e.date || o.s.amount > remaining + 0.99) break;
        Object.assign(o.s, { paid: true, resolution: '', paidDate: e.date, method: e.method || '', evidenceId: e.id, matchedBy: 'auto' });
        remaining = round2(remaining - o.s.amount);
        matched++; amt += o.s.amount;
      }
    }
    return { matched, amt: round2(amt) };
  }
  // ---------- payments found: CSV import (Venmo-aware), memo-aware matching, balance ----------
  const PAY_FIELDS = [['date', 'Date sent', true], ['amount', 'Amount', true], ['memo', 'Memo / note'], ['direction', 'Direction (paid / received)'], ['category', 'Type / category']];
  const PAY_GUESS = {
    date: [/^date$|datetime|date sent|date paid/i, /date/i],
    amount: [/amount \(total\)|^amount$/i, /amount|total/i],
    memo: [/memo|note|description/i],
    direction: [/direction|^from$/i],
    category: [/^type$|category/i],
  };
  // memo keyword -> how that project is named in the earnings report
  const PROJECT_KEYS = LOCAL.projectKeys || [];
  const kindFromText = (cat, memo) => {
    const s = `${cat || ''} ${memo || ''}`;
    if (/not commission/i.test(s)) return 'skip';
    if (/back-?pay|outstanding|catch ?up|pre-20\d\d|balance/i.test(s)) return 'backpay';
    if (/residual|res fee|quarter|\bq[1-4]\b/i.test(s)) return 'residual';
    if (/unclear/i.test(s)) return 'unclear';
    return 'session';
  };
  const KIND_LABEL = { session: 'Session / gig', residual: 'Residual fee', backpay: 'Back-pay', unclear: 'Unclear' };
  async function startPayImport(file) {
    try {
      const sheets = await readTable(file);
      if (!sheets.length) throw new Error('That file looks empty.');
      const rows = sheets[0].rows;
      let h = rows.findIndex((r) => r.filter((v) => String(v).trim()).length >= 2);
      if (h < 0) h = 0;
      const headers = rows[h].map((v, j) => String(v).trim() || `Column ${j + 1}`);
      const map = {}; const used = new Set();
      for (let tier = 0; tier < 2; tier++) for (const [f] of PAY_FIELDS) {
        if (map[f] !== undefined) continue;
        const re = PAY_GUESS[f][tier]; if (!re) continue;
        const idx = headers.findIndex((x, i) => !used.has(i) && re.test(x));
        if (idx >= 0) { map[f] = idx; used.add(idx); }
      }
      PAY_FIELDS.forEach(([f]) => { if (map[f] === undefined) map[f] = -1; });
      const guessMember = state.settings.team.find((m) => new RegExp(m.name, 'i').test(file.name)) || memberById(amendMemberId()) || state.settings.team[0];
      ui.payImport = { fileName: file.name, headers, rows: rows.slice(h + 1), map, memberId: guessMember?.id };
      openModal({ type: 'payImport' });
    } catch (e) { toast(e.message, { error: true }); }
  }
  function buildPayImport(d) {
    const col = (row, f) => (d.map[f] >= 0 ? row[d.map[f]] : '');
    const existing = new Set(state.evidence.map((e) => `${e.memberId}|${e.date}|${round2(e.amount)}|${(e.memo || e.reference || '').slice(0, 40)}`));
    return d.rows.map((row, i) => {
      const date = parseDateAny(col(row, 'date'));
      const rawAmt = String(col(row, 'amount') ?? '').trim();
      const amt = parseMoney(rawAmt);
      if (!date || amt == null || amt === 0) return { i, skip: 'No date or amount' };
      const memo = String(col(row, 'memo') ?? '').trim();
      const dir = String(col(row, 'direction') ?? '');
      const kind = kindFromText(col(row, 'category'), memo);
      if (/^\+/.test(rawAmt) || /receiv|incoming|paid you/i.test(dir) || kind === 'skip') return { i, skip: 'Money received (not a payment to them)' };
      const rec = { date, amount: Math.abs(amt), memo, kind };
      if (existing.has(`${d.memberId}|${date}|${rec.amount}|${memo.slice(0, 40)}`)) return { i, rec, skip: 'Already logged' };
      return { i, rec };
    });
  }
  function payImportHTML() {
    const d = ui.payImport; if (!d) return null;
    const res = buildPayImport(d); const ok = res.filter((r) => !r.skip); const sk = res.filter((r) => r.skip);
    const reasons = {}; sk.forEach((r) => { reasons[r.skip] = (reasons[r.skip] || 0) + 1; });
    const byKind = {}; ok.forEach(({ rec }) => { byKind[rec.kind] = (byKind[rec.kind] || 0) + rec.amount; });
    const opt = (sel) => `<option value="-1">— not in file —</option>${d.headers.map((h, j) => `<option value="${j}" ${sel === j ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    return `<div class="modal-card wide">
      <header><div><h2>Import payments you made</h2><div class="muted small" style="margin-top:4px">${esc(d.fileName)} · ${d.rows.length} rows</div></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <label>These are payments to<select data-payimport-member>${state.settings.team.map((m) => `<option value="${esc(m.id)}" ${m.id === d.memberId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <fieldset><legend>Match your columns</legend><div class="grid2">${PAY_FIELDS.map(([f, label, req]) => `<label><span>${label}${req ? ' <span class="req">*</span>' : ''}</span><select data-payimport-map="${f}">${opt(d.map[f])}</select></label>`).join('')}</div></fieldset>
        <div class="row"><span class="pill green">${ok.length} payments · ${money(sum(ok, (r) => r.rec.amount))}</span>
          ${Object.entries(byKind).map(([k, v]) => `<span class="pill">${KIND_LABEL[k]} ${money(v)}</span>`).join('')}
          ${Object.entries(reasons).map(([k, n]) => `<span class="pill amber">${n} skipped · ${esc(k)}</span>`).join('')}</div>
        ${ok.length ? `<div class="table-wrap" style="padding:0;max-height:260px;overflow:auto"><table><thead><tr><th>Date</th><th class="right">Amount</th><th>Type</th><th>Memo</th></tr></thead><tbody>
          ${ok.slice(0, 80).map(({ rec: r }) => `<tr><td class="num" style="white-space:nowrap">${fmtDate(r.date)}</td><td class="right num">${money(r.amount)}</td><td>${KIND_LABEL[r.kind]}</td><td class="small">${esc(r.memo)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Nothing to import. Check that the date and amount columns are matched.</div>'}
        <label class="inline"><input type="checkbox" id="payimport-match" checked> Match them to commissions after importing (by job name first, then oldest first)</label>
        <div class="callout" style="background:var(--lavender);color:var(--text)">Payments are logged as <strong>payments found</strong> with their memo. They count toward the balance even if they can't be matched to a specific job. You can delete any of them later.</div>
      </div>
      <footer><button type="button" class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="do-pay-import" ${ok.length ? '' : 'disabled'}>Import ${ok.length} payments</button></footer>
    </div>`;
  }
  function doPayImport() {
    const d = ui.payImport; const ok = buildPayImport(d).filter((r) => !r.skip); const batch = uid();
    const method = /venmo/i.test(d.fileName) ? 'Venmo' : '';
    for (const { rec } of ok) state.evidence.push({ id: uid(), createdAt: new Date().toISOString(), memberId: d.memberId, date: rec.date, amount: rec.amount, method, memo: rec.memo, reference: '', notes: `Imported from ${d.fileName}`, kind: rec.kind, importBatch: batch });
    const doMatch = $('#payimport-match')?.checked;
    const r = doMatch ? runMatching(d.memberId) : { smart: 0, fifo: 0, amt: 0 };
    ui.payImport = null; save(); closeModal(); render();
    toast(`Imported ${ok.length} payments${doMatch ? ` — matched ${r.smart + r.fifo} commissions (${r.smart} by job name)` : ''}`);
  }
  // Payments whose memo names a job are matched to that job's commissions first (amounts must add up within $1).
  function smartMatch(memberId) {
    const openFor = () => state.checks.flatMap((c) => { const s = c.splits.find((x) => x.memberId === memberId); return s && ['research', 'owe'].includes(splitState(s)) && s.amount > 0 ? [{ c, s }] : []; });
    let matched = 0, amt = 0;
    const evs = state.evidence.filter((e) => e.memberId === memberId && (e.kind || 'session') === 'session' && (e.memo || e.reference)).sort((a, b) => a.date.localeCompare(b.date));
    for (const e of evs) {
      const remaining = round2(e.amount - evidenceAllocated(e)); if (remaining < 1) continue;
      const memo = e.memo || e.reference;
      const keys = PROJECT_KEYS.filter(([m]) => m.test(memo)).map(([, p]) => p);
      if (!keys.length) continue;
      const cands = openFor().filter(({ c }) => c.receivedDate <= e.date && daysBetween(c.receivedDate, e.date) <= 540 && keys.some((p) => p.test(`${c.project || ''} ${employerOf(c)} ${c.payer || ''}`)))
        .sort((a, b) => b.c.receivedDate.localeCompare(a.c.receivedDate)).slice(0, 14);
      let best = null;
      const rec = (start, chosen, total) => {
        if (best) return;
        if (chosen.length && Math.abs(total - remaining) <= 1) { best = [...chosen]; return; }
        if (chosen.length >= 5 || total > remaining + 1) return;
        for (let i = start; i < cands.length && !best; i++) { chosen.push(cands[i]); rec(i + 1, chosen, total + cands[i].s.amount); chosen.pop(); }
      };
      rec(0, [], 0);
      if (best) for (const o of best) { Object.assign(o.s, { paid: true, resolution: '', paidDate: e.date, method: e.method || '', evidenceId: e.id, matchedBy: 'name' }); matched++; amt += o.s.amount; }
    }
    return { matched, amt: round2(amt) };
  }
  // ---------- hand-matching one payment to the exact jobs it covered ----------
  function openMatchPicker(evId) {
    const e = state.evidence.find((x) => x.id === evId); if (!e) return;
    const sel = state.checks.filter((c) => c.splits.some((s) => s.memberId === e.memberId && s.evidenceId === e.id)).map((c) => c.id);
    const memo = e.memo || e.reference || '';
    const key = PROJECT_KEYS.find(([m]) => m.test(memo));
    const guess = key ? (memo.match(key[0]) || [''])[0] : '';
    openModal({ type: 'matchPicker', evId, sel, q: guess, allDates: false, showTaken: true, back: ui.modal && ui.modal.type !== 'matchPicker' ? ui.modal : null });
  }
  function matchPickerHTML(m) {
    const e = state.evidence.find((x) => x.id === m.evId); if (!e) return null;
    const member = memberById(e.memberId) || { id: e.memberId, name: 'Former member', former: true };
    const sel = new Set(m.sel);
    const q = String(m.q || '').trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const all = state.checks.flatMap((c) => { const s = c.splits.find((x) => x.memberId === e.memberId); return s ? [{ c, s }] : []; });
    const rows = all.filter(({ c, s }) => {
      if (sel.has(c.id)) return true;
      const stt = splitState(s);
      if (stt === 'notOwed' || stt === 'deducted') return false;
      if (s.evidenceId && !m.showTaken) return false;
      if (stt === 'paid' && !s.evidenceId) return false;
      if (!m.allDates && (c.receivedDate > e.date || daysBetween(c.receivedDate, e.date) > 730)) return false;
      if (terms.length) { const hay = `${c.project || ''} ${employerOf(c)} ${c.payer || ''} ${c.checkNumber || ''} ${c.reference || ''} ${c.workType || ''} ${c.payType || ''} ${c.receivedDate} ${num(s.amount).toFixed(2)}`.toLowerCase(); if (!terms.every((t) => hay.includes(t))) return false; }
      return true;
    }).sort((a, b) => (sel.has(b.c.id) - sel.has(a.c.id)) || b.c.receivedDate.localeCompare(a.c.receivedDate));
    const shown = rows.slice(0, 150);
    const chosen = all.filter(({ c }) => sel.has(c.id));
    const total = round2(sum(chosen, ({ s }) => s.amount));
    const diff = round2(e.amount - total);
    const evLabel = (id) => { const x = state.evidence.find((v) => v.id === id); return x ? `${money(x.amount)} on ${fmtShort(x.date)}` : 'another payment'; };
    return `<div class="modal-card wide">
      <header><div><h2>Match ${money(e.amount)} to jobs</h2><div class="muted small">${esc(member.name)} · ${fmtDate(e.date)} · ${esc(e.method || '')}${e.memo ? ` · “${esc(e.memo)}”` : ''}</div></div>
        <button type="button" class="icon-btn" data-action="close-match" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="callout" style="background:var(--lavender);color:var(--text)">Tick the jobs this payment covered. A job matched to another payment can be moved here — that payment just gets that much back as “not matched.” Matching never changes the balance; it only shows which jobs are paid.</div>
        <div class="row" style="flex-wrap:wrap;gap:10px">
          <input id="match-search" value="${esc(m.q || '')}" placeholder="Search project, employer, check #, amount…" style="flex:1;min-width:220px" aria-label="Search jobs">
          <label class="inline"><input type="checkbox" data-action="match-toggle" data-field="allDates" ${m.allDates ? 'checked' : ''}> Any date</label>
          <label class="inline"><input type="checkbox" data-action="match-toggle" data-field="showTaken" ${m.showTaken ? 'checked' : ''}> Include jobs matched to other payments</label>
        </div>
        <div class="muted small">${m.allDates ? 'Showing jobs from any date.' : 'Showing jobs deposited up to 2 years before this payment.'} ${rows.length} job${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? `, first ${shown.length} shown — search to narrow it down` : ''}.</div>
        <div class="list" style="max-height:46vh;overflow:auto">${shown.length ? shown.map(({ c, s }) => {
          const on = sel.has(c.id);
          const other = s.evidenceId && s.evidenceId !== e.id;
          return `<label class="list-item pick" style="cursor:pointer"><input type="checkbox" data-match-pick="${c.id}" ${on ? 'checked' : ''}>
            <div class="grow"><div class="title">${esc(projectName(c))}</div>
              <div class="sub">${fmtDate(c.receivedDate)} · ${esc(c.payType || c.workType || '')}${c.productionDate ? ` · work ${fmtShort(c.productionDate)}` : ''} · ${money(c.gross)} gross${c.reference ? ' · #' + esc(c.reference) : ''}</div>
              ${other ? `<div class="sub" style="color:var(--peach-ink)">Now matched to ${esc(evLabel(s.evidenceId))}${on ? ' — will move here' : ''}</div>` : ''}${isPossibleFive(c, s) ? ` ${fiveFlag(c, s)}` : ''}</div>
            <div class="amt">${money(s.amount)}</div></label>`; }).join('') : '<div class="empty">No jobs match. Try “Any date” or a shorter search.</div>'}</div>
      </div>
      <footer>
        <div class="grow small"><strong>${chosen.length}</strong> job${chosen.length === 1 ? '' : 's'} · ${money(total)} of ${money(e.amount)} ·
          ${Math.abs(diff) <= 0.99 ? '<span style="color:var(--mint-ink)">✓ adds up</span>' : diff > 0 ? `<span style="color:var(--peach-ink)">${money(diff)} left unmatched</span>` : `<span style="color:var(--rose-ink)">${money(-diff)} more than the payment</span>`}</div>
        ${chosen.length ? '<button type="button" class="btn ghost" data-action="match-clear">Clear</button>' : ''}
        <button type="button" class="btn ghost" data-action="close-match">Cancel</button>
        <button type="button" class="btn primary" data-action="match-save">Save matches</button>
      </footer>
    </div>`;
  }
  function saveMatchPicker() {
    const m = ui.modal; const e = state.evidence.find((x) => x.id === m.evId); if (!e) return;
    const sel = new Set(m.sel);
    let added = 0, removed = 0, moved = 0;
    for (const c of state.checks) {
      const s = c.splits.find((x) => x.memberId === e.memberId); if (!s) continue;
      if (sel.has(c.id)) {
        if (s.evidenceId === e.id) continue;
        if (s.evidenceId) moved++;
        Object.assign(s, { paid: true, resolution: '', paidDate: e.date, method: e.method || '', evidenceId: e.id, manualMatch: true, matchedBy: 'manual' });
        added++;
      } else if (s.evidenceId === e.id) { setResolution(c, s, 'research'); delete s.manualMatch; removed++; }
    }
    e.manualMatch = true;
    save();
    const back = m.back; ui.modal = null;
    if (back) openModal(back); else closeModal();
    render();
    toast(`Saved — ${added} job${added === 1 ? '' : 's'} matched${moved ? ` (${moved} moved from other payments)` : ''}${removed ? `, ${removed} unmatched` : ''}`);
  }
  function closeMatchPicker() { const back = ui.modal?.back; ui.modal = null; if (back) openModal(back); else closeModal(); }
  function runMatching(memberId) {
    const a = smartMatch(memberId); const b = autoMatch(memberId);
    return { smart: a.matched, fifo: b.matched, amt: round2(a.amt + b.amt) };
  }
  function balanceFor(memberId) {
    let commission = 0, deducted = 0, paidNoProof = 0, n = 0;
    for (const c of state.checks) {
      const s = c.splits.find((x) => x.memberId === memberId); if (!s) continue;
      const st = splitState(s); if (st === 'notOwed') continue;
      n++; commission += s.amount;
      if (st === 'deducted') deducted += s.amount;
      if (st === 'paid' && !s.evidenceId) paidNoProof += s.amount;
    }
    const ev = state.evidence.filter((e) => e.memberId === memberId);
    const found = sum(ev, (e) => e.amount);
    const unmatched = sum(ev, (e) => Math.max(0, e.amount - evidenceAllocated(e)));
    const r = (x) => round2(x);
    return { n, commission: r(commission), deducted: r(deducted), found: r(found), unmatched: r(unmatched), paidNoProof: r(paidNoProof), balance: r(commission - deducted - found), payments: ev.length };
  }
  function balancePanel() {
    const rows = auditMembers().map((m) => ({ m, b: balanceFor(m.id) })).filter(({ b }) => b.n || b.payments);
    if (!rows.length) return '';
    const claimed = state.audit.claimed || {};
    return `<div class="card"><div class="card-head"><h2>Where it stands</h2><span class="muted small">Commission per your rules − taken out first − payments found</span></div>
      <div class="card-body"><div class="table-wrap" style="padding:0"><table>
        <thead><tr><th>Person</th><th class="right">Commission (rules)</th><th class="right">Taken out first</th><th class="right">Payments found</th><th class="right">Balance</th><th>Amount being claimed</th></tr></thead>
        <tbody>${rows.map(({ m, b }) => {
          const cl = claimed[m.id];
          return `<tr><td><div class="title">${esc(m.name)}</div><div class="sub">${b.n} commissions · ${b.payments} payments</div></td>
            <td class="right num">${money(b.commission)}</td><td class="right num">${money(b.deducted)}</td>
            <td class="right num">${money(b.found)}${b.unmatched > 0.99 ? `<div class="sub">${money(b.unmatched)} not matched to a job</div>` : ''}</td>
            <td class="right num" style="font-weight:700;color:${b.balance > 0.99 ? 'var(--rose-ink)' : 'var(--mint-ink)'}">${b.balance < -0.99 ? 'Overpaid ' + money(-b.balance) : money(b.balance)}</td>
            <td><input type="number" step="0.01" min="0" placeholder="e.g. 34332.89" value="${cl ?? ''}" data-claimed="${esc(m.id)}" style="max-width:150px">
              ${cl != null && cl !== '' ? `<div class="sub" style="color:var(--peach-ink)">Difference: ${money(round2(num(cl) - b.balance))}</div>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        ${rows.some(({ b }) => b.paidNoProof > 0.99) ? `<p class="muted small" style="margin:10px 0 0">Some commissions are marked paid without a logged payment (${money(sum(rows, (r) => r.b.paidNoProof))}). They are not subtracted above, so nothing is counted twice.</p>` : ''}
        ${(() => { const p = fiveProjects().filter((x) => x.decision !== 'fifteen'); const d = round2(sum(p, (x) => x.commission - x.atFive)); return p.length ? `<p class="small" style="margin:10px 0 0;color:var(--peach-ink)">⚑ ${p.length} project${p.length === 1 ? '' : 's'} could be 5% instead of 15%. If all were, ${esc(reviewName())}’s balance would be up to ${money(d)} lower. See “Possible 5% projects.”</p>` : ''; })()}
        <p class="muted small" style="margin:6px 0 0">The balance changes only when your commission rules or your logged payments change. Matching payments to jobs is shown in each person-year, but it doesn't change this total.</p>
      </div></div>`;
  }

  // ---------- possible 5% (unsigned 12/4/23 amendment: 5% on NEW projects the manager secured) ----------
  // Everything stays at 15%. This only flags commissions whose project first appears on/after the amendment date,
  // so you can decide project by project. Residuals on older projects are never flagged.
  const AMEND_DATE = '2023-12-04';
  const PROJECT_STOP = new Set(['the', 'of', 'a', 'an', 'tv', 'series', 'season', 'episode', 'episodes', 'ep', 'residual', 'residuals', 'session', 'sessions', 'inc', 'llc']);
  const projectKey = (c) => {
    const raw = String(c.project || employerOf(c) || c.payer || '').toLowerCase().replace(/[^a-z\s]/g, ' ');
    const key = raw.split(/\s+/).filter((w) => w && !PROJECT_STOP.has(w)).join(' ');
    // Same project under different names (Settings → projectAliases: { 'other name': 'main name' })
    for (const [from, to] of Object.entries({ ...(LOCAL.projectAliases || {}), ...(state.settings.projectAliases || {}) })) if (new RegExp(`\b${from.replace(/[^a-z\s]/g, ' ').trim().replace(/\s+/g, '\s+')}\b`).test(key)) return to;
    return key;
  };
  const projectName = (c) => c.project || employerOf(c) || c.payer || 'Unknown project';
  const amendMemberId = () => (memberById(state.settings.reviewMemberId) ? state.settings.reviewMemberId : '');
  const reviewName = () => memberById(amendMemberId())?.name || 'They';
  function projectStarts() {
    const m = {};
    for (const c of state.checks) {
      const k = projectKey(c); if (!k) continue;
      const d = c.productionDate || c.receivedDate || '';
      if (d && (!m[k] || d < m[k])) m[k] = d;
    }
    return m;
  }
  let _starts = null, _startsSig = '';
  function startsCached() {
    const sig = state.checks.length + '|' + (state.checks[state.checks.length - 1]?.id || '');
    if (!_starts || sig !== _startsSig) { _starts = projectStarts(); _startsSig = sig; }
    return _starts;
  }
  function isPossibleFive(c, s) {
    if (!s || s.memberId !== amendMemberId() || num(s.percent) <= 5) return false;
    const k = projectKey(c); if (!k) return false;
    return (startsCached()[k] || '') >= AMEND_DATE;
  }
  const fiveDecision = (c) => (state.audit.five || {})[projectKey(c)] || 'undecided';
  const FIVE_LABELS = { undecided: 'Undecided', five: 'They secured it → 5%', fifteen: 'Stays 15%' };
  const fiveFlag = (c, s) => (isPossibleFive(c, s) ? `<span class="pill amber" title="New project since 12/4/23 — could be 5% under the proposed amendment (${esc(FIVE_LABELS[fiveDecision(c)])})">⚑ Possible 5%</span>` : '');
  function fiveProjects() {
    const mid = amendMemberId(); if (!mid) return [];
    const by = {};
    for (const c of state.checks) {
      const s = c.splits.find((x) => x.memberId === mid);
      if (!isPossibleFive(c, s)) continue;
      const k = projectKey(c);
      const p = by[k] || (by[k] = { key: k, name: projectName(c), start: startsCached()[k], gross: 0, commission: 0, n: 0 });
      p.gross += num(c.gross); p.commission += num(s.amount); p.n++;
    }
    return Object.values(by).map((p) => {
      const pct = num(c0(p.key)?.percent) || 15;
      return { ...p, gross: round2(p.gross), commission: round2(p.commission), atFive: round2((p.commission * 5) / pct), decision: (state.audit.five || {})[p.key] || 'undecided' };
    }).sort((a, b) => b.commission - a.commission);
  }
  function c0(key) { const mid = amendMemberId(); for (const c of state.checks) if (projectKey(c) === key) { const s = c.splits.find((x) => x.memberId === mid); if (s) return s; } return null; }
  function fiveCard() {
    const all = fiveProjects();
    if (!all.length) return '';
    const f = ui.fiveFilter || 'all';
    const list = f === 'all' ? all : all.filter((p) => p.decision === f);
    const save5 = round2(sum(all.filter((p) => p.decision !== 'fifteen'), (p) => p.commission - p.atFive));
    const confirmed5 = round2(sum(all.filter((p) => p.decision === 'five'), (p) => p.commission - p.atFive));
    const counts = { all: all.length, undecided: 0, five: 0, fifteen: 0 }; all.forEach((p) => counts[p.decision]++);
    return `<div class="card"><div class="card-head"><h2>⚑ Possible 5% projects</h2><span class="pill amber">${all.length}</span></div>
      <div class="card-body stack">
        <p class="muted small" style="margin:0">Everything is counted at 15%. These projects first show up on or after Dec 4, 2023, so they <em>could</em> be 5% if ${esc(reviewName())} secured them under the proposed (unsigned) amendment. Residuals on older projects stay 15% either way.</p>
        <div class="row">${['all', 'undecided', 'five', 'fifteen'].map((k) => `<button class="btn sm ${f === k ? 'primary' : ''}" data-action="five-filter" data-filter="${k}">${k === 'all' ? 'All' : FIVE_LABELS[k].replace('They secured it → ', '')} · ${counts[k]}</button>`).join('')}</div>
        ${list.length ? `<div class="list">${list.map((p) => `<div class="list-item"><div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">Starts ${fmtDate(p.start)} · ${p.n} line${p.n === 1 ? '' : 's'} · ${money(p.gross)} gross · ${money(p.commission)} at 15% vs ${money(p.atFive)} at 5%</div></div>
          <select data-five="${esc(p.key)}" style="width:auto" aria-label="Rate for ${esc(p.name)}">${Object.entries(FIVE_LABELS).map(([k, l]) => `<option value="${k}" ${p.decision === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}</div>` : '<div class="muted small">None in this filter.</div>'}
        <p class="muted small" style="margin:0">If every flagged project not marked “Stays 15%” were 5%, the balance would be <strong>${money(save5)}</strong> lower${confirmed5 ? ` (${money(confirmed5)} from the ones you marked 5%)` : ''}. The balance above still uses 15%.</p>
      </div></div>`;
  }

  // ---------- someone else's records (e.g. a manager's own "unpaid checks" list) ----------
  // Kept completely separate: never changes your commissions, payments, or balance. Only compared against them.
  const CLAIM_GUESS = {
    checkNo: /check ?#|check no|^no\.?$|^number$/i, date: /check date|^date$/i, memo: /^memo|description|job|project/i,
    gross: /^gross/i, due: /amount due|^due$|commission|owed/i, status: /payment status|^payment$|^status/i, note: /date completed|note/i,
  };
  async function importClaims(file) {
    try {
      const sheets = await readTable(file);
      const rows = sheets[0]?.rows || [];
      const h = rows.findIndex((r) => r.filter((v) => String(v).trim()).length >= 3);
      if (h < 0) throw new Error('That file looks empty.');
      const headers = rows[h].map((v) => String(v).trim());
      const idx = {};
      for (const [f, re] of Object.entries(CLAIM_GUESS)) idx[f] = headers.findIndex((x) => !/^my records/i.test(x) && re.test(x));
      if (idx.due < 0 || idx.memo < 0) throw new Error('Couldn’t find the “Amount due” and “Memo” columns.');
      const get = (r, f) => (idx[f] >= 0 ? String(r[idx[f]] ?? '').trim() : '');
      const items = [], notes = [];
      for (const r of rows.slice(h + 1)) {
        const memo = get(r, 'memo'); if (!memo) continue;
        if (/^total\b|^handwritten/i.test(memo)) { if (/^handwritten/i.test(memo)) notes.push(memo); continue; }
        const dueRaw = get(r, 'due'); const due = parseMoney(dueRaw);
        if (due == null || !/\d/.test(dueRaw)) { notes.push([memo, dueRaw, get(r, 'note')].filter(Boolean).join(' — ')); continue; }
        items.push({ id: uid(), checkNo: get(r, 'checkNo'), date: parseDateAny(get(r, 'date')) || '', memo, gross: parseMoney(get(r, 'gross')) || 0, due: round2(due), status: get(r, 'status'), note: get(r, 'note') });
      }
      if (!items.length) throw new Error('No rows with an amount due were found.');
      const mid = amendMemberId() || state.settings.team[0]?.id;
      state.claims = state.claims || {};
      state.claims[mid] = { fileName: file.name, at: new Date().toISOString(), items, notes };
      save(); render();
      toast(`Saved ${items.length} rows as ${memberById(mid)?.name || 'their'}’s records — kept separate from yours`);
    } catch (e) { toast(e.message, { error: true }); }
  }
  const claimTotal = (cl) => round2(sum(cl.items, (x) => x.due));
  // What YOUR records say about one of their rows.
  function compareClaim(memberId, it) {
    const memoKeys = PROJECT_KEYS.filter(([m]) => m.test(it.memo)).map(([, p]) => p);
    let best = null;
    for (const c of state.checks) {
      if (!it.gross || Math.abs(num(c.gross) - it.gross) > 0.02 || !it.date || !c.receivedDate) continue;
      const gap = Math.abs(daysBetween(c.receivedDate, it.date)); if (gap > 60) continue;
      const proj = `${c.project || ''} ${employerOf(c)}`;
      const score = gap - (memoKeys.some((p) => p.test(proj)) ? 100 : 0);
      if (!best || score < best.score) best = { c, score };
    }
    const c = best?.c; const s = c?.splits.find((x) => x.memberId === memberId);
    const ev = s?.evidenceId ? state.evidence.find((e) => e.id === s.evidenceId) : null;
    const no = String(it.checkNo || '').replace(/\D/g, '');
    const named = no.length >= 5 ? state.evidence.filter((e) => e.memberId === memberId && `${e.memo || ''} ${e.reference || ''}`.includes(no)) : [];
    let verdict = 'none', text = 'No payment found in your records';
    const guessed = ev && !s.manualMatch && s.matchedBy !== 'name' && s.matchedBy !== 'manual';
    if (ev && !guessed) { verdict = 'paid'; text = `Your payment of ${money(ev.amount)} on ${fmtShort(ev.date)} is matched to this job${s.matchedBy === 'name' ? ' by job name' : ' (by you)'}${ev.memo ? ` — “${ev.memo}”` : ''}`; }
    else if (named.length) {
      const got = round2(sum(named, (e) => e.amount));
      verdict = got + 0.99 < it.due ? 'partial' : 'paid';
      text = `Your Venmo memo names this check: ${named.map((e) => `${money(e.amount)} on ${fmtShort(e.date)}`).join(' + ')}${verdict === 'partial' ? ` — ${money(round2(it.due - got))} less than she lists` : ''}`;
    }
    else if (s && splitState(s) === 'paid' && !s.evidenceId) { verdict = 'paid'; text = 'Marked paid in your records (no payment linked)'; }
    else if (s && splitState(s) === 'deducted') { verdict = 'paid'; text = 'Your records say the commission was taken out first'; }
    if (verdict === 'none' && /paid \$/i.test(it.note)) { verdict = 'partial'; text = 'Partly paid — she notes it herself'; }
    if (verdict === 'none' && guessed) { verdict = 'guess'; text = `Only an oldest-first guess put your ${money(ev.amount)} payment of ${fmtShort(ev.date)} here${ev.memo ? ` (“${ev.memo}”)` : ''} — not proof. Use Match to… on the right payment.`; }
    const job = c ? `${fmtShort(c.receivedDate)} · ${esc(projectName(c))} · ${money(c.gross)}` : 'Not found in your SAG report';
    return { verdict, text, job, five: c && s ? isPossibleFive(c, s) : false };
  }
  function claimsCard() {
    const entries = Object.entries(state.claims || {}).filter(([, cl]) => cl?.items?.length);
    const importBtn = `<label class="btn sm" style="flex-direction:row;color:var(--text)">${entries.length ? 'Replace with a new file' : 'Import their records (CSV)'}<input type="file" id="import-claims-file" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv" hidden></label>`;
    if (!entries.length) return `<div class="card"><div class="card-head"><h2>Their records</h2></div><div class="card-body stack">
      <p class="muted small" style="margin:0">Got a list from someone on your team of what they say is unpaid? Import it here. It's kept separate and only compared against your records — it never changes your numbers.</p><div class="row">${importBtn}</div></div></div>`;
    return entries.map(([mid, cl]) => {
      const name = memberById(mid)?.name || 'Former member';
      const rows = cl.items.map((it) => ({ it, cmp: compareClaim(mid, it) }));
      const tot = claimTotal(cl);
      const paidAmt = round2(sum(rows.filter((r) => r.cmp.verdict === 'paid'), (r) => r.it.due));
      const pill = { paid: '<span class="pill green">Your records: paid</span>', partial: '<span class="pill amber">Partly paid</span>', guess: '<span class="pill">Guess only</span>', none: '<span class="pill">Not found</span>' };
      const claimed = state.audit.claimed?.[mid];
      return `<div class="card"><div class="card-head"><h2>${esc(name)}’s records</h2><span class="pill purple">Theirs, not yours</span></div>
        <div class="card-body stack">
          <p class="muted small" style="margin:0">From “${esc(cl.fileName)}”, imported ${new Date(cl.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. Read-only and kept apart from your records: it never changes your commissions, payments or balance.</p>
          <div class="row"><span class="pill">They list ${money(tot)} unpaid</span><span class="pill green">${money(paidAmt)} of it shows paid in your records</span><span class="pill">${money(round2(tot - paidAmt))} not settled by your records yet</span></div>
          <div class="table-wrap" style="padding:0;overflow-x:auto"><table class="claims-table">
            <thead><tr><th>Their row</th><th class="right">They say due</th><th>Their status</th><th>What your records show</th></tr></thead>
            <tbody>${rows.map(({ it, cmp }) => `<tr>
              <td><div class="title">${esc(it.memo)}</div><div class="sub">${it.checkNo ? '#' + esc(it.checkNo) + ' · ' : ''}${it.date ? fmtDate(it.date) : ''}${it.gross ? ' · ' + money(it.gross) + ' gross' : ''}</div></td>
              <td class="right num">${money(it.due)}</td>
              <td><div class="small">${esc(it.status || '—')}</div>${it.note ? `<div class="sub">${esc(it.note)}</div>` : ''}</td>
              <td>${pill[cmp.verdict]}${cmp.five ? ' <span class="pill amber">⚑ Possible 5%</span>' : ''}<div class="sub">${esc(cmp.text)}</div><div class="sub">Your job: ${cmp.job}</div></td></tr>`).join('')}</tbody>
          </table></div>
          ${cl.notes?.length ? `<div><div class="field-label">Also on their sheet (not itemized)</div><ul class="small muted" style="margin:0;padding-left:18px">${cl.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
          <p class="muted small" style="margin:0">“Your records: paid” counts only real proof: a payment matched by job name or by you, a Venmo memo naming the check number, or a status you set. Oldest-first auto-matches show as “Guess only” and don't count. For a lump payment that covered several of these (like one Venmo for several checks), use <strong>Match to…</strong> on that payment and the rows here update.</p>
          <div class="row">${claimed == null || claimed === '' ? `<button class="btn sm" data-action="claims-to-claimed" data-member="${esc(mid)}">Use ${money(tot)} as “amount being claimed”</button>` : ''}${importBtn}<button class="btn sm ghost danger" data-action="remove-claims" data-member="${esc(mid)}">Remove their records</button></div>
        </div></div>`;
    }).join('');
  }

  function setResolution(c, s, val) {
    if (val === 'paid') Object.assign(s, { paid: true, resolution: '', paidDate: s.paidDate || '', method: s.method || '' });
    else Object.assign(s, { paid: false, paidDate: null, evidenceId: null, matchedBy: null, manualMatch: false, resolution: val === 'owe' ? '' : val });
  }
  const resolutionSelect = (c, s) => `<select class="res-select st-${splitState(s)}" data-resolve-check="${c.id}" data-resolve-member="${esc(s.memberId)}" aria-label="Status">
    ${['research', 'paid', 'deducted', 'notOwed', 'owe'].map((k) => `<option value="${k}" ${splitState(s) === k ? 'selected' : ''}>${RES_LABELS[k]}</option>`).join('')}</select>`;
  function auditCellHTML(m) {
    const member = memberById(m.memberId) || { id: m.memberId, name: 'Former member', former: true };
    const items = cellSplits(m.memberId, m.year);
    const t = stats(items);
    const key = auditKey(m.memberId, m.year);
    const notes = state.auditNotes[key] || { sources: {}, notes: '' };
    const ev = state.evidence.filter((e) => e.memberId === m.memberId && (e.date.startsWith(m.year) || items.some(({ split }) => split.evidenceId === e.id)))
      .sort((a, b) => a.date.localeCompare(b.date));
    const tip = t.nResearch
      ? `Start with one question: in ${m.year}, did any checks go to ${member.name} first, with them keeping their cut before sending you the rest? If so, mark those “Agent/manager took it first.” For everything else, pull your ${m.year} Venmo / bank history, search “${member.name}”, log each payment below, then press Auto-match.`
      : t.owe ? `${money(t.owe)} is confirmed unpaid for ${m.year}. Pay it from Team Payouts when you’re ready, or record it here if you find proof it was paid.`
      : `${m.year} is settled for ${member.name}. Nice work.`;
    return `<div class="modal-card wide">
      <header><div class="row" style="flex-wrap:nowrap">${avatar(member)}<div><h2>${esc(member.name)} · ${m.year}</h2><div class="muted small">${t.n} commission${t.n === 1 ? '' : 's'} · ${money(t.total)} total</div></div></div>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="row"><span class="pill green">Paid ${money(t.paid)}</span><span class="pill purple">Research ${money(t.research)}</span><span class="pill">Taken first ${money(t.deducted)}</span><span class="pill red">Still owed ${money(t.owe)}</span>${t.legacyDiff ? `<span class="pill amber">Old tracker said ${money(t.legacy)}</span>` : ''}</div>
        <div class="callout" style="background:var(--lavender);color:var(--text)"><strong>Coach:</strong> ${esc(tip)}</div>
        <fieldset><legend>Where to look for ${m.year}</legend>
          <div class="sources">${AUDIT_SOURCES.map(([k, label, help]) => `<label class="source"><input type="checkbox" data-audit-source="${k}" data-key="${esc(key)}" ${notes.sources?.[k] ? 'checked' : ''}><span><strong>${label}</strong><br><span class="muted small">${esc(help)}</span></span></label>`).join('')}</div>
          <label style="margin-top:12px">Notes for this year<textarea rows="2" data-audit-notes="${esc(key)}" placeholder="e.g. They say they have records through 2022 — asked on Nov 20">${esc(notes.notes || '')}</textarea></label>
        </fieldset>
        <fieldset><legend>Payments you found to ${esc(member.name)}</legend>
          ${ev.length ? `<div class="list">${ev.map(evidenceRow).join('')}</div>` : `<div class="muted small">None logged for ${m.year} yet.</div>`}
          <div class="ev-inline">
            <input type="date" id="ev-date" aria-label="Date sent"><input type="number" step="0.01" min="0" id="ev-amount" placeholder="Amount" aria-label="Amount">
            <input id="ev-method" list="method-list" placeholder="Venmo, Zelle…" aria-label="Method"><input id="ev-ref" placeholder="Reference (optional)" aria-label="Reference">
            <button class="btn sm primary" data-action="add-evidence-inline" data-member="${esc(m.memberId)}">Add</button>
          </div>
          <div class="row" style="margin-top:10px"><button class="btn sm" data-action="auto-match" data-member="${esc(m.memberId)}">Auto-match ${esc(member.name)}’s payments</button><span class="muted small">Pays off the oldest commissions first, using only payments made after each check was deposited.</span></div>
        </fieldset>
        <fieldset><legend>Commissions in ${m.year}</legend>
          ${t.nResearch ? `<div class="row" style="margin-bottom:10px"><span class="muted small">Set every “Needs research” to</span><select id="bulk-res" style="width:auto">${['deducted', 'notOwed', 'owe', 'paid'].map((k) => `<option value="${k}">${RES_LABELS[k]}</option>`).join('')}</select><button class="btn sm" data-action="bulk-resolve" data-member="${esc(m.memberId)}" data-year="${m.year}">Apply</button></div>` : ''}
          ${items.some(({ check, split }) => isPossibleFive(check, split)) ? `<label class="inline" style="margin-bottom:10px"><input type="checkbox" data-action="cell-five-only" ${ui.cellFiveOnly ? 'checked' : ''}> Show only ⚑ possible 5%</label>` : ''}
          ${items.filter(({ check, split }) => !ui.cellFiveOnly || isPossibleFive(check, split)).map(({ check: c, split: s }) => {
            const lg = c.legacy?.byMember?.[s.memberId];
            const evi = s.evidenceId ? state.evidence.find((e) => e.id === s.evidenceId) : null;
            return `<div class="audit-row">
              <div><div class="title">${fmtDate(c.receivedDate)} · ${esc(c.payer || 'SAG check')}</div><div class="sub">${esc(checkMeta(c))}${c.productionDate ? ` · work ${fmtShort(c.productionDate)}` : ''} · ${num(s.percent)}% of ${money(c.gross)}</div>
                ${isPossibleFive(c, s) ? `<div style="margin-top:4px">${fiveFlag(c, s)} <span class="small muted">${esc(FIVE_LABELS[fiveDecision(c)])}</span></div>` : ''}
                ${lg != null && Math.abs(lg - s.amount) > 0.99 ? `<div class="small" style="color:var(--peach-ink)">Old tracker said ${money(lg)}</div>` : ''}</div>
              <div class="amt">${money(s.amount)}</div>
              <div>${resolutionSelect(c, s)}
                ${s.paid ? `<div class="paid-fields" style="margin-top:6px"><input type="date" value="${esc(s.paidDate || '')}" data-split-field="paidDate" data-check="${c.id}" data-member="${esc(s.memberId)}" aria-label="Date paid"><input list="method-list" value="${esc(s.method || '')}" placeholder="Method" data-split-field="method" data-check="${c.id}" data-member="${esc(s.memberId)}" aria-label="Method"></div>
                  ${evi ? `<div class="small muted" style="margin-top:4px">Proof: ${money(evi.amount)} on ${fmtDate(evi.date)}${evi.reference ? ' · ' + esc(evi.reference) : ''}</div>` : '<div class="small" style="color:var(--peach-ink);margin-top:4px">No proof logged yet</div>'}` : ''}
              </div>
            </div>`;
          }).join('')}
        </fieldset>
      </div>
      <datalist id="method-list">${PAY_METHODS.map((x) => `<option value="${x}">`).join('')}</datalist>
      <footer><button class="btn primary" data-action="close-modal">Done</button></footer>
    </div>`;
  }
  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function downloadCSV(name, rows) {
    const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }
  function exportAudit() {
    const rows = [['Year', 'Team Member', 'Company', 'Deposit Date', 'Payor', 'Employer', 'Type of Work', 'Check #', 'Gross', 'Net', 'Percent', 'Calculated On', 'Commission', 'Status', 'Paid Date', 'Paid Via', 'Proof Amount', 'Proof Date', 'Proof Reference', 'Old Tracker Said', 'Past Check?', 'Possible 5%', '5% Decision']];
    for (const c of [...state.checks].sort((a, b) => a.receivedDate.localeCompare(b.receivedDate))) {
      for (const s of c.splits) {
        const e = s.evidenceId ? state.evidence.find((x) => x.id === s.evidenceId) : null;
        rows.push([c.receivedDate.slice(0, 4), s.name, memberById(s.memberId)?.company || '', c.receivedDate, c.payer || '', employerOf(c), c.workType || '', c.checkNumber || '', num(c.gross), c.net === '' ? '' : num(c.net),
          num(s.percent), s.base || c.splitOn || 'gross', num(s.amount), RES_LABELS[splitState(s)], s.paidDate || '', s.method || '', e ? e.amount : '', e ? e.date : '', e ? e.reference || '' : '',
          c.legacy?.byMember?.[s.memberId] ?? '', c.historical ? 'Yes' : 'No', isPossibleFive(c, s) ? 'Yes' : '', isPossibleFive(c, s) ? FIVE_LABELS[fiveDecision(c)] : '']);
      }
    }
    downloadCSV(`sag-payout-audit-detail-${today()}.csv`, rows);
  }
  function exportAuditSummary() {
    const rows = [['Year', 'Team Member', 'Commissions', 'Paid', 'Taken Out First', 'Not Owed', 'Needs Research', 'Still Owed', 'Payments Found (by date sent)']];
    for (const y of [...auditYears()].reverse()) for (const m of auditMembers()) {
      const t = stats(cellSplits(m.id, y));
      const found = round2(sum(state.evidence.filter((e) => e.memberId === m.id && e.date.startsWith(y)), (e) => e.amount));
      if (t.n || found) rows.push([y, m.name, t.total, t.paid, t.deducted, t.notOwed, t.research, t.owe, found]);
    }
    downloadCSV(`sag-payout-audit-summary-${today()}.csv`, rows);
  }
  async function startFresh() {
    if (!await uiConfirm('Start fresh?\n\nThis deletes ALL numbers: every check, bill, payout, payment found, email history and the receipt counter, and sets everyone’s commission % to blank.\n\nKept: team names, emails and companies, your accountant, and your Google Drive connection.\n\nFiles already in Google Drive are not touched. This can’t be undone, so download a backup first if you might want anything back.')) return;
    if (await uiPrompt('Type START FRESH to confirm') !== 'START FRESH') return toast('Nothing was deleted.');
    for (const c of state.checks) for (const f of c.files || []) if (f.status !== 'uploaded') idb.del(f.id).catch(() => {});
    Object.assign(state, { checks: [], bills: [], evidence: [], auditNotes: {}, imports: [], outbox: [], outboxLog: [], rules: [], claims: {}, expenses: [], audit: { rulesConfirmed: false } });
    state.settings.team.forEach((m) => { m.percent = 0; });
    Object.assign(state.settings, { receiptSeq: 0, receiptYear: null });
    save(); render();
    toast('Fresh start — all numbers cleared');
  }

  // ---------- toast ----------
  function toast(msg, opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (opts.error ? ' error' : '');
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (opts.undo) {
      const b = document.createElement('button');
      b.textContent = 'Undo';
      b.onclick = () => { opts.undo(); el.remove(); };
      el.appendChild(b);
    }
    $('#toast-root').appendChild(el);
    setTimeout(() => el.remove(), opts.error ? 7000 : opts.undo ? 7500 : 4500);
  }

  // ---------- rendering ----------
  function render() {
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === ui.view));
    const main = $('#main');
    const views = { dashboard: viewDashboard, checks: viewChecks, team: viewTeam, rules: viewRules, audit: viewAudit, projects: viewProjects, bills: viewBills, writeoffs: viewWriteoffs, calendar: viewCalendar, reports: viewReports, settings: viewSettings };
    // Keep focus/caret in the checks search box while typing
    const active = document.activeElement;
    const keepSearch = active && active.id === 'check-search' ? active.selectionStart : null;
    main.innerHTML = (views[ui.view] || viewDashboard)();
    if (keepSearch != null) { const s = $('#check-search'); s.focus(); s.setSelectionRange(keepSearch, keepSearch); }
    renderDriveStatus();
    if (ui.modal && ui.modal.live) renderModal();
  }
  function renderDriveStatus() {
    const on = driveConfigured();
    const last = on && state.settings.lastBackup
      ? ' · backed up ' + new Date(state.settings.lastBackup).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '';
    if (window.__ahqMemoryOnly) { $('#drive-status').innerHTML = `<span class="ribbon-text">This browser won’t let the app save on this device, so it loads from Google Drive each time${on ? '' : ' — enter your Drive password in Settings'}.</span>${on ? '' : ' <a class="ribbon-link" href="#settings">Settings ›</a>'}`; return; }
    if (!on && state.settings.driveUrl && !state.settings.driveSecret) { $('#drive-status').innerHTML = '<span class="ribbon-text">Enter your Drive password to load your data on this device.</span> <a class="ribbon-link" href="#settings">Go to Settings ›</a>'; return; }
    $('#drive-status').innerHTML = on
      ? `<span class="ribbon-text"><span class="dot on"></span>Google Drive connected${esc(last)}.</span> <a class="ribbon-link" href="#settings">Drive settings ›</a>`
      : `<span class="ribbon-text">Your data is saved only in this browser until Google Drive is connected.</span> <a class="ribbon-link" href="#settings">Set up Google Drive ›</a>`;
  }
  // ---------- appearance: Day / Night / Automatic (per browser) ----------
  const THEME_KEY = 'ahq-theme';
  function getThemePref() { try { const t = safeStore.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } }
  function effectiveTheme() { const p = getThemePref(); return p !== 'auto' ? p : (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  function applyTheme(pref) {
    try { if (pref === 'auto') safeStore.removeItem(THEME_KEY); else safeStore.setItem(THEME_KEY, pref); } catch (e) {}
    if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
    else document.documentElement.removeAttribute('data-theme');
    syncThemeButton();
  }
  function syncThemeButton() {
    const b = document.querySelector('.theme-toggle'); if (!b) return;
    const night = effectiveTheme() === 'dark';
    const label = night ? 'Switch to Day mode' : 'Switch to Night mode';
    b.title = label; b.setAttribute('aria-label', label); b.classList.toggle('is-night', night);
  }
  if (window.matchMedia) { try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getThemePref() === 'auto') syncThemeButton(); }); } catch (e) {} }
  function closeMenu() { const d = $('#globalnav'); if (d) { d.classList.remove('menu-open'); document.body.classList.remove('menu-locked'); d.querySelector('.nav-toggle')?.setAttribute('aria-expanded', 'false'); } }
  const CHAPTERS = [
    ['checks', 'SAG Checks', 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM6 9h7v2H6zm0 4h10v2H6z'],
    ['team', 'Team Payouts', 'M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1a4.2 4.2 0 0 1 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z'],
    ['audit', 'Payout audit', 'M9 2h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v6.1a6 6 0 0 0-2-.1V6h-2v1H8V6H6v14h5.3a6 6 0 0 0 1.2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V3a1 1 0 0 1 1-1zm1 2v1h4V4zm7 9a4 4 0 0 1 3.3 6.3l2.2 2.2-1.4 1.4-2.2-2.2A4 4 0 1 1 17 13zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
    ['projects', 'Projects', 'M10 3h4a2 2 0 0 1 2 2v1h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4V5a2 2 0 0 1 2-2zm0 2v1h4V5zm-6 7v7h16v-7h-6v2h-4v-2z'],
    ['bills', 'Bills & Subs', 'M6 2h12a1 1 0 0 1 1 1v19l-3-2-3 2-3-2-3 2-2-1.3V3a1 1 0 0 1 1-1zm2 5v2h8V7zm0 4v2h8v-2zm0 4v2h5v-2z'],
    ['writeoffs', 'Write-offs', 'M4 3h16v18l-2.7-1.6L14.7 21 12 19.4 9.3 21l-2.6-1.6L4 21zm4 4v2h8V7zm0 4v2h8v-2zm0 4v2h5v-2z'],
    ['calendar', 'Calendar', 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14zM7 11h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2z'],
    ['reports', 'Reports', 'M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm8 1.5V8h4.5zM8 12v6h2v-6zm3.5-2v8h2v-8zM15 14v4h2v-4z'],
    ['settings', 'Settings', 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.3 7.3 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.3 7.3 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.3 7.3 0 0 0 1.7 1L11 21h4l.4-2.7a7.3 7.3 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 3.5-3.5 3.5 3.5 0 0 1-3.5 3.5z'],
  ];
  function chapterNav() {
    const overdue = state.bills.filter((b) => b.active && b.nextDue && b.nextDue < today()).length;
    const owed = unpaidSplits().length;
    const badge = { team: owed ? `${owed} to pay` : '', bills: overdue ? `${overdue} overdue` : '' };
    const open = !!ui.chaptersOpen;
    const hiddenAlerts = CHAPTERS.slice(4).filter(([v]) => badge[v]).length; // shortcuts past the first row on phones
    return `<div class="chapterwrap ${open ? 'open' : ''}">
      <nav class="chapternav" id="chapternav" aria-label="Sections">${CHAPTERS.map(([v, l, d], i) => `<a href="#${v}" class="chapter" style="--i:${i}"><span class="chapter-icon"><svg viewBox="0 0 24 24"><path d="${d}"/></svg></span><span class="chapter-label">${esc(l)}</span>${badge[v] ? `<span class="chapter-badge">${esc(badge[v])}</span>` : ''}</a>`).join('')}</nav>
      <button type="button" class="chapter-toggle" data-action="toggle-chapters" aria-expanded="${open}" aria-controls="chapternav">
        <span class="ct-label">${open ? 'Less' : 'More'}</span>${!open && hiddenAlerts ? `<span class="ct-dot" aria-label="${hiddenAlerts} needs attention"></span>` : ''}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 9.3 12 13.9l4.6-4.6L18 10.7l-6 6-6-6z"/></svg>
      </button>
    </div>`;
  }

  const avatar = (m) => { const t = m.former ? null : memberTone(m.id); return `<div class="avatar" style="background:var(--${t || 'surface-3'});color:var(--${t ? t + '-ink' : 'muted'})">${esc((m.name || '?')[0].toUpperCase())}</div>`; };
  const addButton = (action, label, extra = '') => `<span class="add-wrap">${label ? `<span>${label}</span>` : ''}<button class="add-btn" data-action="${action}" ${extra} title="${esc(label || 'Add')}" aria-label="${esc(label || 'Add')}">${PLUS}</button></span>`;
  function weekStrip() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const t = today();
    const days = Array.from({ length: 7 }, (_, i) => toISO(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `<div class="week">${days.map((d, i) => {
      const bills = state.bills.filter((b) => b.active && b.nextDue === d).length;
      const checks = state.checks.filter((c) => c.receivedDate === d).length;
      const names = state.bills.filter((b) => b.active && b.nextDue === d).map((b) => b.name);
      return `<div title="${esc(fmtDate(d))}${names.length ? ' — due: ' + esc(names.join(', ')) : ''}${checks ? ` — ${checks} check${checks > 1 ? 's' : ''} received` : ''}">
        <div class="dow" style="${d === t ? 'color:var(--text);font-weight:600' : ''}">${dows[i]}</div>
        <div class="day ${d === t ? 'today' : d < t ? 'past' : ''}">${parseISO(d).getDate()}</div>
        <div class="dots">${bills ? '<i class="bill"></i>' : ''}${checks ? '<i class="check"></i>' : ''}</div>
      </div>`;
    }).join('')}</div>`;
  }
  const statusPill = (st) => ({
    paid: '<span class="pill green">All paid</span>',
    partial: '<span class="pill amber">Partly paid</span>',
    open: '<span class="pill amber">Needs payout</span>',
    nosplit: '<span class="pill">No split</span>',
    research: '<span class="pill purple">Needs research</span>',
  }[st]);
  const RES_LABELS = { paid: 'Paid', owe: 'Still owed', research: 'Needs research', deducted: 'Agent/manager took it first', notOwed: 'Not owed' };
  const splitChips = (c) => `<div class="chips">${c.splits.map((s) => {
    const st = splitState(s);
    if (st === 'research' || st === 'deducted' || st === 'notOwed') {
      return `<button class="chip ${st === 'research' ? 'research' : 'settled'}" data-action="open-check" data-id="${c.id}" title="${RES_LABELS[st]} — open to update">
        <span class="box">${st === 'research' ? '?' : '–'}</span>${esc(s.name)} ${money(s.amount)}</button>`;
    }
    return `<button class="chip ${s.paid ? 'paid' : 'unpaid'}" data-action="toggle-split" data-check="${c.id}" data-member="${esc(s.memberId)}"
        title="${s.paid ? `Paid ${s.paidDate ? fmtDate(s.paidDate) : '(date unknown)'}${s.method ? ' via ' + esc(s.method) : ''} — click to mark unpaid` : 'Click to mark paid'}">
        <span class="box">${s.paid ? '✓' : ''}</span>${esc(s.name)} ${money(s.amount)}
      </button>`;
  }).join('')}</div>`;
  function filesBadge(c) {
    if (!c.files?.length) return '<span class="muted small">—</span>';
    const up = c.files.filter((f) => f.status === 'uploaded').length;
    const err = c.files.some((f) => f.status === 'error');
    const cls = err ? 'red' : up === c.files.length ? 'green' : 'amber';
    return `<span class="pill ${cls}" title="${up} of ${c.files.length} in Google Drive">${up === c.files.length ? 'In Drive' : err ? 'Upload failed' : 'Not in Drive'} · ${c.files.length}</span>`;
  }

  // ----- Dashboard -----
  function viewDashboard() {
    const yr = String(new Date().getFullYear());
    const ytd = state.checks.filter((c) => (c.receivedDate || '').startsWith(yr));
    const owed = unpaidSplits();
    const t = today();
    const bills = state.bills.filter((b) => b.active && b.nextDue);
    const overdue = bills.filter((b) => b.nextDue < t);
    const upcoming = bills.filter((b) => daysBetween(t, b.nextDue) <= 14).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    const monthly = sum(state.bills, billMonthly);
    const members = allMembers();

    const owedTotal = sum(owed, (o) => o.split.amount);
    const owedPeople = new Set(owed.map((o) => o.split.name));
    const hour = new Date().getHours();
    return `
      <div class="page-head">
        <div><div class="eyebrow">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}</h1></div>
        <div class="row"><button class="btn white" data-action="add-bill">+ Bill</button>${addButton('add-check', 'Scan SAG check')}</div>
      </div>
      ${chapterNav()}
      <section class="hero">
        <div class="orb" aria-hidden="true"></div>
        <h2>${owed.length ? 'Your team is waiting on a payout' : state.checks.length ? 'Everyone on your team is paid up' : 'Log your first SAG check to get started'}</h2>
        <div class="hero-panel">
          <div class="grow">
            <div class="big">${money(owedTotal)}</div>
            <div class="sub">${owed.length ? `Owed to ${[...owedPeople].join(', ')} · ${owed.length} split${owed.length === 1 ? '' : 's'}` : 'Nothing owed right now'}</div>
          </div>
          ${owed.length ? '<a class="btn" href="#team">Pay team</a>' : '<button class="btn" data-action="add-check">Add a check</button>'}
        </div>
      </section>
      <div class="grid tiles">
        <div class="card tile"><div class="label">SAG received ${yr}</div><div class="value">${money(sum(ytd, (c) => c.gross))}</div><div class="sub">${ytd.length} check${ytd.length === 1 ? '' : 's'} · ${money(sum(ytd, (c) => num(c.net) || num(c.gross)))} net</div></div>
        <div class="card tile owed"><div class="label">Owed to team</div><div class="value">${money(sum(owed, (o) => o.split.amount))}</div><div class="sub">${owed.length} unpaid split${owed.length === 1 ? '' : 's'}</div></div>
        <div class="card tile ${overdue.length ? 'warn' : ''}"><div class="label">Bills overdue</div><div class="value">${overdue.length}</div><div class="sub">${overdue.length ? money(sum(overdue, (b) => b.amount)) + ' total' : 'You’re all caught up'}</div></div>
        <div class="card tile"><div class="label">Bills &amp; subs / month</div><div class="value">${money(monthly)}</div><div class="sub">${state.bills.filter((b) => b.active).length} active</div></div>
      </div>
      <div class="grid dash">
        <div class="grid">
          <div class="card">
            <div class="card-head"><h2>This week</h2><div class="legend"><span><i style="background:var(--peach-ink)"></i>Bill due</span><span><i style="background:var(--mint-ink)"></i>Check received</span></div></div>
            <div class="card-body">${weekStrip()}</div>
          </div>
          <div class="card">
            <div class="card-head"><h2>SAG income · ${yr}</h2><span class="muted small">Gross by month</span></div>
            <div class="card-body chart">${incomeChart(yr)}</div>
          </div>
          ${workBreakdown(yr)}
          <div class="card">
            <div class="card-head"><h2>Recent checks</h2><a href="#checks" class="small">View all</a></div>
            <div class="card-body">${recentChecks()}</div>
          </div>
        </div>
        <div class="grid">
          <div class="card">
            <div class="card-head"><h2>Team payouts due</h2><a href="#team" class="small">Details</a></div>
            <div class="card-body"><div class="list">
              ${members.map((m, i) => {
                const items = unpaidSplits(m.id);
                if (m.former && !items.length) return '';
                const amt = sum(items, (o) => o.split.amount);
                return `<div class="list-item">${avatar(m)}
                  <div class="grow"><div class="title">${esc(m.name)}</div><div class="sub">${items.length ? `${items.length} check${items.length > 1 ? 's' : ''} unpaid` : 'All paid up'}</div></div>
                  <div class="amt" style="${amt ? 'color:var(--peach-ink)' : ''}">${money(amt)}</div>
                  ${items.length ? `<button class="btn sm" data-action="pay-all-member" data-member="${esc(m.id)}">Mark paid</button>` : ''}
                </div>`;
              }).join('')}
            </div></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Bills due soon</h2><a href="#bills" class="small">All bills</a></div>
            <div class="card-body">
              ${upcoming.length ? `<div class="list">${upcoming.map(billListItem).join('')}</div>`
                : `<div class="empty">${state.bills.length ? 'Nothing due in the next 14 days.' : 'Add your bills and subscriptions to see what’s due.'}${state.bills.length ? '' : '<br><button class="btn" data-action="add-bill">+ Add a bill</button>'}</div>`}
            </div>
          </div>
        </div>
      </div>`;
  }
  function billListItem(b) {
    const st = billStatus(b);
    const tone = b.kind === 'subscription' ? 'lavender' : 'sky';
    return `<div class="list-item">
      <div class="icon-tile" style="background:var(--${tone});color:var(--${tone}-ink)">${ICONS[b.kind] || ICONS.bill}</div>
      <div class="grow"><div class="title">${esc(b.name)}</div><div class="sub">${money(b.amount)}${b.autopay ? ' · Autopay' : ''}</div></div>
      <span class="pill ${st.cls}">${st.label}</span>
      <button class="btn sm primary" data-action="pay-bill" data-id="${b.id}">Paid</button>
    </div>`;
  }
  function incomeChart(yr) {
    const months = Array.from({ length: 12 }, (_, i) => sum(state.checks.filter((c) => (c.receivedDate || '').startsWith(`${yr}-${pad(i + 1)}`)), (c) => c.gross));
    const max = Math.max(...months, 1);
    const curMonth = String(new Date().getFullYear()) === yr ? new Date().getMonth() : -1;
    const W = 600, H = 190, top = 14, bottom = 24, left = 4;
    const bw = (W - left) / 12;
    const labels = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (!months.some(Boolean)) return `<div class="empty">No checks logged for ${yr} yet.<br><button class="btn" data-action="add-check">+ Add your first check</button></div>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="SAG income by month">
      <line class="grid-line" x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}"/>
      <text class="axis" x="${W}" y="10" text-anchor="end">max ${esc(money(max))}</text>
      ${months.map((v, i) => {
        const h = v ? Math.max(3, ((H - top - bottom) * v) / max) : 0;
        const x = left + i * bw + bw * 0.18;
        return `<g><title>${names[i]}: ${esc(money(v))}</title>
          ${h ? `<rect class="bar ${i === curMonth ? 'current' : ''}" x="${x}" y="${H - bottom - h}" width="${bw * 0.64}" height="${h}" rx="8"/>` : ''}
          <text class="axis" x="${x + bw * 0.32}" y="${H - 7}" text-anchor="middle">${labels[i]}</text></g>`;
      }).join('')}
    </svg>`;
  }
  function workBreakdown(yr) {
    const ytd = state.checks.filter((c) => (c.receivedDate || '').startsWith(yr));
    if (!ytd.length) return '';
    const groups = {};
    for (const c of ytd) { const k = c.workType || 'Not set'; (groups[k] ||= { gross: 0, n: 0 }); groups[k].gross += num(c.gross); groups[k].n++; }
    const rows = Object.entries(groups).sort((a, b) => b[1].gross - a[1].gross);
    const max = Math.max(...rows.map(([, g]) => g.gross), 1);
    return `<div class="card">
      <div class="card-head"><h2>By type of work · ${yr}</h2><span class="muted small">Gross</span></div>
      <div class="card-body stack" style="gap:12px">${rows.map(([k, g]) => {
        const tone = WORK_TONES[k];
        return `<div>
          <div class="row" style="justify-content:space-between;margin-bottom:6px"><span style="font-weight:600">${esc(k)} <span class="muted small" style="font-weight:500">· ${g.n} check${g.n > 1 ? 's' : ''}</span></span><span class="num" style="font-weight:600">${money(g.gross)}</span></div>
          <div class="meter"><span style="width:${Math.max(2, (g.gross / max) * 100)}%;background:var(--${tone ? tone + '-ink' : 'muted'})"></span></div>
        </div>`;
      }).join('')}</div>
    </div>`;
  }
  function recentChecks() {
    const list = [...state.checks].sort((a, b) => b.receivedDate.localeCompare(a.receivedDate)).slice(0, 5);
    if (!list.length) return `<div class="empty">When a SAG check comes in the mail, log it here.<br><button class="btn primary" data-action="add-check">+ Scan SAG check</button></div>`;
    return `<div class="list">${list.map((c) => `
      <div class="list-item" data-action="open-check" data-id="${c.id}">
        <div class="icon-tile" style="background:var(--mint);color:var(--mint-ink)"><svg viewBox="0 0 24 24"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM6 9h7v2H6zm0 4h10v2H6z"/></svg></div>
        <div class="grow"><div class="title">${checkLabel(c)}</div>
        <div class="sub">${fmtDate(c.receivedDate)}${c.workType ? ' · ' + esc(c.workType) : ''}${c.checkNumber ? ' · #' + esc(c.checkNumber) : ''}</div></div>
        ${statusPill(checkStatus(c))}
        <div class="amt">${money(c.gross)}</div>
      </div>`).join('')}</div>`;
  }

  // ----- SAG Checks -----
  function viewChecks() {
    const counts = {
      all: state.checks.length,
      open: state.checks.filter((c) => ['open', 'partial'].includes(checkStatus(c))).length,
      paid: state.checks.filter((c) => checkStatus(c) === 'paid').length,
      research: state.checks.filter((c) => checkStatus(c) === 'research').length,
    };
    return `
      <div class="page-head">
        <div><h1>SAG Checks</h1><p>Log each residual check as it arrives, then mark off each person’s cut once you’ve paid them.</p></div>
        ${addButton('add-check', 'Scan SAG check')}
      </div>
      <div class="toolbar">
        <div class="seg">
          ${[['open', 'Needs payout'], ...(counts.research ? [['research', 'Needs research']] : []), ['paid', 'All paid'], ['all', 'All']].map(([k, l]) => `<button class="${ui.checkFilter === k ? 'on' : ''}" data-action="check-filter" data-value="${k}">${l} <span class="muted">${counts[k]}</span></button>`).join('')}
        </div>
        <select id="work-filter" class="pill-select" aria-label="Type of work">
          <option value="">All types of work</option>
          ${uniq([...WORK_TYPES, ...state.checks.map((c) => c.workType)]).map((w) => `<option value="${esc(w)}" ${ui.workFilter === w ? 'selected' : ''}>${esc(w)}</option>`).join('')}
        </select>
        <input type="search" id="check-search" placeholder="Search payor, employer, check #…" value="${esc(ui.checkSearch)}">
      </div>
      <div class="card">${checksTable()}</div>`;
  }
  function checksTable() {
    const q = ui.checkSearch.trim().toLowerCase();
    let list = [...state.checks].sort((a, b) => b.receivedDate.localeCompare(a.receivedDate) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (ui.checkFilter === 'open') list = list.filter((c) => ['open', 'partial'].includes(checkStatus(c)));
    if (ui.checkFilter === 'paid') list = list.filter((c) => checkStatus(c) === 'paid');
    if (ui.checkFilter === 'research') list = list.filter((c) => checkStatus(c) === 'research');
    if (ui.workFilter) list = list.filter((c) => c.workType === ui.workFilter);
    if (q) list = list.filter((c) => [c.payer, employerOf(c), c.workType, c.checkNumber, c.notes].some((v) => String(v || '').toLowerCase().includes(q)));
    if (!list.length) {
      return `<div class="empty">${state.checks.length ? (ui.checkFilter === 'open' && !q && !ui.workFilter ? 'Everyone’s been paid. 🎉' : 'No checks match.') : 'No checks yet.'}
        ${state.checks.length ? '' : '<br><button class="btn primary" data-action="add-check">+ Scan SAG check</button>'}</div>`;
    }
    return `<div class="table-wrap"><table>
      <thead><tr><th>Deposited</th><th>Payor / employer</th><th>Type of work</th><th>Check #</th><th class="right">Gross</th><th class="right">Net</th><th>Team split</th><th>Scan</th><th>Status</th></tr></thead>
      <tbody>${list.map((c) => `
        <tr class="clickable" data-action="open-check" data-id="${c.id}">
          <td class="num" style="white-space:nowrap">${fmtDate(c.receivedDate)}</td>
<td><div class="title">${esc(employerOf(c) || c.payer || '—')}</div><div class="sub">${esc([c.employer && c.project, c.payer && c.payer !== employerOf(c) ? 'via ' + c.payer : '', c.payType].filter(Boolean).join(' · '))}</div></td>          <td><div class="title">${esc(c.payer || '—')}</div><div class="sub">${esc(employerOf(c))}</div></td>
          <td>${workPill(c) || '<span class="muted small">—</span>'}</td>
          <td class="num" style="white-space:nowrap">${c.checkNumber ? esc(c.checkNumber) : '<span class="muted">—</span>'}</td>
          <td class="right num">${money(c.gross)}</td>
          <td class="right num">${c.net ? money(c.net) : '<span class="muted">—</span>'}</td>
          <td>${c.splits.length ? splitChips(c) : '<span class="muted small">—</span>'}</td>
          <td>${filesBadge(c)}</td>
          <td>${statusPill(checkStatus(c))}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  }

  // ----- Team -----
  function viewTeam() {
    const yr = String(new Date().getFullYear());
    const members = allMembers();
    return `
      <div class="page-head">
        <div><h1>Team Payouts</h1><p>What you owe ${esc(state.settings.team.map((m) => m.name).join(', ').replace(/, ([^,]*)$/, ' and $1'))}, and what you’ve already paid them.</p></div>
        <div class="row" style="gap:8px;flex-wrap:wrap"><a class="btn white" href="#rules">Commission rules</a><a class="btn white" href="#settings">Edit team</a></div>
      </div>
      <div class="grid team-grid">
        ${members.map((m) => {
          const tone = m.former ? 'surface-3' : memberTone(m.id);
          const unpaid = unpaidSplits(m.id);
          const paid = [];
          for (const c of state.checks) for (const s of c.splits) if (s.paid && s.memberId === m.id) paid.push({ check: c, split: s });
          paid.sort((a, b) => (b.split.paidDate || '').localeCompare(a.split.paidDate || ''));
          if (m.former && !unpaid.length && !paid.length) return '';
          const paidYtd = sum(paid.filter((p) => (p.split.paidDate || '').startsWith(yr)), (p) => p.split.amount);
          return `<div class="member-card" style="background:var(--${tone})">
            <div class="member-head">${avatar(m)}<div class="grow"><h2>${esc(m.name)}</h2><div class="muted small">${m.former ? 'Former team member' : `Usually paid by ${esc(m.method || '—')}`}</div></div>
              ${m.former ? '' : `<span class="pill white">${num(m.percent)}%</span>`}</div>
            <div>
              <div class="owed-box">
                <div class="muted small">Currently owed</div>
                <div class="big" style="${unpaid.length ? `color:var(--${m.former ? 'text' : tone + '-ink'})` : ''}">${money(sum(unpaid, (o) => o.split.amount))}</div>
                <div class="stats"><span class="pill">Paid ${yr} · <span class="num">${money(paidYtd)}</span></span>
                  <span class="pill">All-time · <span class="num">${money(sum(paid, (p) => p.split.amount))}</span></span></div>
              </div>
              ${unpaid.length ? `
                <div class="row" style="justify-content:space-between;margin-bottom:10px"><h3 style="margin:0">Unpaid</h3><button class="btn sm primary" data-action="pay-all-member" data-member="${esc(m.id)}">Mark all paid</button></div>
                <div class="list">${unpaid.map(({ check: c, split: s }) => `
                  <div class="list-item">
                    <div class="grow" style="cursor:pointer" data-action="open-check" data-id="${c.id}"><div class="title">${checkLabel(c)}</div><div class="sub">Deposited ${fmtDate(c.receivedDate)} · ${num(s.percent)}% of ${money(splitBaseAmount(c))}</div></div>
                    <div class="amt">${money(s.amount)}</div>
                    <button class="btn sm primary" data-action="toggle-split" data-check="${c.id}" data-member="${esc(s.memberId)}">Paid</button>
                  </div>`).join('')}</div>` : '<span class="pill white">✓ All paid up</span>'}
              ${paid.length ? `
                <h3 style="margin-top:18px">Recent payments</h3>
                <div class="list">${paid.slice(0, 6).map(({ check: c, split: s }) => `
                  <div class="list-item">
                    <div class="grow" style="cursor:pointer" data-action="open-check" data-id="${c.id}"><div class="title">${checkLabel(c)}</div><div class="sub">Paid ${fmtDate(s.paidDate)}${s.method ? ' via ' + esc(s.method) : ''}</div></div>
                    <div class="num">${money(s.amount)}</div>
                  </div>`).join('')}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  // ----- Bills -----
  // ---------- reports: a payment statement for one team member, and a package for the accountant ----------
  // Statement = only what you paid that person (and, if you choose, the jobs each payment is PROVEN to cover).
  // It never includes balances, 5% flags, notes, their records, other people, or personal bills.
  function memberPayments(mid) {
    const rows = [];
    for (const e of state.evidence || []) {
      if (e.memberId !== mid) continue;
      const jobs = state.checks.flatMap((c) => c.splits.filter((s) => s.memberId === mid && s.evidenceId === e.id && (s.manualMatch || s.matchedBy === 'name' || s.matchedBy === 'manual')).map((s) => ({ c, s })));
      rows.push({ date: e.date, amount: num(e.amount), method: e.method || '', memo: e.memo || e.reference || '', source: 'Logged payment', jobs });
    }
    for (const c of state.checks) {
      if (c.historical) continue;
      const s = c.splits.find((x) => x.memberId === mid && x.paid && x.paidDate && !x.evidenceId);
      if (s) rows.push({ date: s.paidDate, amount: num(s.amount), method: s.method || '', memo: `Commission on ${c.payer || 'SAG check'}${employerOf(c) ? ' · ' + employerOf(c) : ''}${c.checkNumber ? ' #' + c.checkNumber : ''}`, source: 'Team payout', jobs: [{ c, s }] });
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }
  const yearsOf = (dates) => [...new Set(dates.filter(Boolean).map((d) => d.slice(0, 4)))].sort().reverse();
  function stmtData() {
    const members = state.settings.team.filter((m) => memberPayments(m.id).length || m.id === amendMemberId());
    const mid = ui.stmt.member && memberById(ui.stmt.member) ? ui.stmt.member : (amendMemberId() || members[0]?.id || state.settings.team[0]?.id);
    const all = memberPayments(mid);
    const rows = ui.stmt.year === 'all' ? all : all.filter((r) => r.date.startsWith(ui.stmt.year));
    return { mid, member: memberById(mid), members, all, rows, years: yearsOf(all.map((r) => r.date)) };
  }
  // Every report table sits in its own side-scroller so narrow screens never squeeze numbers into one-letter columns.
  const scrollTables = (html) => html.replace(/<table class="stmt-table/g, '<div class="table-scroll"><table class="stmt-table').replace(/<\/table>/g, '</table></div>');
  function statementHTML(d) {
    const s = state.settings; const m = d.member || { name: 'Team member' };
    const byYear = {}; d.rows.forEach((r) => { (byYear[r.date.slice(0, 4)] ||= []).push(r); });
    const total = round2(sum(d.rows, (r) => r.amount));
    const period = ui.stmt.year === 'all' ? (d.rows.length ? `${fmtDate(d.rows[0].date)} to ${fmtDate(d.rows[d.rows.length - 1].date)}` : 'No payments yet') : `Calendar year ${ui.stmt.year}`;
    return scrollTables(`<div class="statement printable">
      <div class="stmt-head">
        <div><div class="eyebrow">Payment statement</div><h2>Payments from ${esc(s.senderName || 'me')} to ${esc(m.name)}${m.company ? ` (${esc(m.company)})` : ''}</h2>
          <div class="muted small">${esc(period)} · As of ${fmtDate(today())}</div></div>
        <div class="stmt-total"><div class="muted small">Total paid</div><div class="value">${money(total)}</div><div class="muted small">${d.rows.length} payment${d.rows.length === 1 ? '' : 's'}</div></div>
      </div>
      ${d.rows.length ? Object.keys(byYear).sort().map((y) => `
        <h3 class="stmt-year">${y} <span class="muted small">${byYear[y].length} payment${byYear[y].length === 1 ? '' : 's'} · ${money(round2(sum(byYear[y], (r) => r.amount)))}</span></h3>
        <table class="stmt-table"><thead><tr><th>Date</th><th>Method</th><th>Note / what it was for</th><th class="right">Amount</th></tr></thead><tbody>
          ${byYear[y].map((r) => `<tr><td class="num" style="white-space:nowrap">${fmtDate(r.date)}</td><td>${esc(r.method || '—')}</td><td>${esc(r.memo || '—')}
            ${ui.stmt.jobs && r.jobs.length ? `<div class="stmt-jobs">${r.jobs.map(({ c, s: sp }) => `<div>${esc(projectName(c))} · ${fmtShort(c.receivedDate)} · ${money(c.gross)} gross · ${num(sp.percent)}% = ${money(sp.amount)}</div>`).join('')}</div>` : ''}</td>
            <td class="right num">${money(r.amount)}</td></tr>`).join('')}
        </tbody></table>`).join('') : '<p class="muted">No payments to show for this period.</p>'}
      <p class="muted small stmt-foot">This statement lists payments only. It is not an accounting of amounts owed.${ui.stmt.jobs ? ' Jobs are shown only where the payment was matched to that job by name or by hand.' : ''}</p>
    </div>`);
  }
  function accountantData() {
    const y = ui.acctYear;
    const inY = (d) => y === 'all' || (d || '').startsWith(y);
    const earn = {}; const logged = {};
    for (const c of state.checks) {
      const yr = (c.receivedDate || '').slice(0, 4); if (!yr || !inY(c.receivedDate)) continue;
      const t = c.historical ? earn : logged;
      const r = (t[yr] ||= { gross: 0, net: 0, n: 0, sessions: 0, residuals: 0 });
      r.gross += num(c.gross); r.net += num(c.net); r.n++;
      if (/resid/i.test(c.payType || c.workType || '')) r.residuals += num(c.gross); else r.sessions += num(c.gross);
    }
    const comm = {}; // key member|year
    const add = (mid, yr, field, amt) => { const k = `${mid}|${yr}`; const r = (comm[k] ||= { mid, yr, paid: 0, deducted: 0, n: 0 }); r[field] += amt; if (field === 'paid') r.n++; };
    for (const m of allMembers()) for (const p of memberPayments(m.id)) if (inY(p.date)) add(m.id, p.date.slice(0, 4), 'paid', p.amount);
    for (const c of state.checks) for (const s of c.splits) if (splitState(s) === 'deducted' && inY(c.receivedDate)) add(s.memberId, c.receivedDate.slice(0, 4), 'deducted', num(s.amount));
    const commRows = Object.values(comm).map((r) => ({ ...r, name: memberById(r.mid)?.name || allMembers().find((m) => m.id === r.mid)?.name || 'Former member', paid: round2(r.paid), deducted: round2(r.deducted) }))
      .sort((a, b) => b.yr.localeCompare(a.yr) || a.name.localeCompare(b.name));
    const acting = state.bills.filter((b) => b.acting);
    const expRows = acting.map((b) => { const pays = (b.payments || []).filter((p) => inY(p.date)); return { b, paid: round2(sum(pays, (p) => num(p.amount))), n: pays.length, yearly: round2(billMonthly(b) * 12) }; });
    const owed = acting.filter((b) => b.active && b.nextDue && b.nextDue < today());
    const allYears = yearsOf([...state.checks.map((c) => c.receivedDate), ...(state.evidence || []).map((e) => e.date), ...state.bills.flatMap((b) => (b.payments || []).map((p) => p.date))]);
    const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, gross: round2(v.gross), net: round2(v.net), sessions: round2(v.sessions), residuals: round2(v.residuals) }]));
    return { earn: r2(earn), logged: r2(logged), commRows, expRows, owed, allYears };
  }
  // Residual commission per person × quarter for the accountant (leaves out the person under review).
  function acctQuarterly() {
    const skip = amendMemberId();
    const years = yearsOf(state.checks.filter(isResidual).map((c) => c.receivedDate)).filter((y) => ui.acctYear === 'all' || y === ui.acctYear);
    const out = [];
    for (const yr of years) for (const r of teamQuarterly(yr, 'residuals')) if (r.id !== skip && r.year.due > 0.004) out.push({ yr, ...r });
    return out.sort((a, b) => b.yr.localeCompare(a.yr) || a.name.localeCompare(b.name));
  }
  function accountantHTML(a) {
    const s = state.settings;
    const yrs = (o) => Object.keys(o).sort().reverse();
    const label = ui.acctYear === 'all' ? 'All years' : `Tax year ${ui.acctYear}`;
    return scrollTables(`<div class="statement printable">
      <div class="stmt-head"><div><div class="eyebrow">Accountant package</div><h2>${esc(s.senderName || 'Acting income')} — acting income, commissions and expenses</h2><div class="muted small">${esc(label)} · Prepared ${fmtDate(today())} from The Actor’s HQ</div></div></div>

      <h3 class="stmt-year">1. Acting income (SAG-AFTRA earnings report)</h3>
      ${yrs(a.earn).length ? `<table class="stmt-table"><thead><tr><th>Year</th><th class="right">Sessions</th><th class="right">Residuals</th><th class="right">Total gross</th><th class="right">Lines</th></tr></thead><tbody>
        ${yrs(a.earn).map((y) => `<tr><td>${y}</td><td class="right num">${money(a.earn[y].sessions)}</td><td class="right num">${money(a.earn[y].residuals)}</td><td class="right num"><b>${money(a.earn[y].gross)}</b></td><td class="right num">${a.earn[y].n}</td></tr>`).join('')}
      </tbody></table><p class="muted small">Gross amounts as reported to the SAG-AFTRA plans, by the date each was applied. Reversals are included as negative lines. Compare with W-2s from the payroll companies.</p>` : '<p class="muted">No SAG-AFTRA report imported.</p>'}
      ${yrs(a.logged).length ? `<h3 class="stmt-year">Checks logged in the app</h3><table class="stmt-table"><thead><tr><th>Year</th><th class="right">Gross</th><th class="right">Net deposited</th><th class="right">Checks</th></tr></thead><tbody>
        ${yrs(a.logged).map((y) => `<tr><td>${y}</td><td class="right num">${money(a.logged[y].gross)}</td><td class="right num">${money(a.logged[y].net)}</td><td class="right num">${a.logged[y].n}</td></tr>`).join('')}</tbody></table>
        <p class="muted small">These may overlap with the earnings report above for the same jobs. Don't add the two together.</p>` : ''}

      <h3 class="stmt-year">2. Commissions paid to agents and managers</h3>
      ${a.commRows.length ? `<table class="stmt-table"><thead><tr><th>Year</th><th>Paid to</th><th class="right">Paid by you</th><th class="right">Kept by agent/manager from checks</th><th>1099-NEC?</th></tr></thead><tbody>
        ${a.commRows.map((r) => `<tr><td>${r.yr}</td><td>${esc(r.name)}</td><td class="right num">${money(r.paid)}${r.n ? ` <span class="muted small">(${r.n})</span>` : ''}</td><td class="right num">${r.deducted ? money(r.deducted) : '—'}</td><td>${r.paid >= 600 ? '<span class="pill amber">Ask — $600+ paid</span>' : '—'}</td></tr>`).join('')}
      </tbody></table><p class="muted small">"Paid by you" counts only payments you logged (Venmo, Zelle, checks, Team Payouts). Ask whether a 1099-NEC was required for any person paid $600 or more in a year.</p>` : '<p class="muted">No commission payments logged.</p>'}

      <h3 class="stmt-year">2b. Quarterly residual commissions — owed vs. paid</h3>
      ${(() => { const rows = acctQuarterly(); if (!rows.length) return '<p class="muted">No residual commissions in this period.</p>';
        const cell = (x) => !x.due ? '<span class="muted">—</span>' : `${money(x.due)}<div class="small">${x.open > 0.99 ? `<span class="tq-open">${money(x.open)} open</span>` : '<span class="tq-ok">✓ paid</span>'}</div>`;
        return `<table class="stmt-table acct-q"><thead><tr><th>Year</th><th>Owed to</th><th class="right">Q1 · Jan–Mar</th><th class="right">Q2 · Apr–Jun</th><th class="right">Q3 · Jul–Sep</th><th class="right">Q4 · Oct–Dec</th><th class="right">Year</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td>${r.yr}</td><td>${esc(r.name)}</td>${r.q.map((x) => `<td class="right num">${cell(x)}</td>`).join('')}<td class="right num"><b>${cell(r.year)}</b></td></tr>`).join('')}
        </tbody></table><p class="muted small">Commission owed on residual checks, grouped by the quarter each check was applied (some agents bill residual commission quarterly). “Paid” means a logged payment covers it; “open” means no payment is logged yet. Commission already taken out of session checks isn’t included. Commission under review with an attorney isn’t listed.</p>`; })()}

      <h3 class="stmt-year">3. Acting expenses (bills and subscriptions marked acting-related)</h3>
      ${a.expRows.length ? `<table class="stmt-table"><thead><tr><th>Expense</th><th>Category</th><th>How often</th><th class="right">Paid ${ui.acctYear === 'all' ? '(all logged)' : 'in ' + ui.acctYear}</th><th class="right">Yearly cost</th></tr></thead><tbody>
        ${a.expRows.map((r) => `<tr><td>${esc(r.b.name)}</td><td>${esc(r.b.category || '—')}</td><td>${esc(FREQS[r.b.frequency] || '')}</td><td class="right num">${money(r.paid)}${r.n ? ` <span class="muted small">(${r.n})</span>` : ''}</td><td class="right num">${money(r.yearly)}</td></tr>`).join('')}
      </tbody></table><p class="muted small">Personal bills are left out. Your accountant decides what's deductible.</p>` : '<p class="muted">No bills are marked acting-related yet.</p>'}

      <h3 class="stmt-year">4. Amounts owed now (acting)</h3>
      ${a.owed.length ? `<table class="stmt-table"><thead><tr><th>Item</th><th>Due since</th><th class="right">Amount</th></tr></thead><tbody>
        ${a.owed.map((b) => `<tr><td>${esc(b.name)}</td><td>${fmtDate(b.nextDue)}</td><td class="right num">${money(b.amount)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing overdue.</p>'}
      ${amendMemberId() ? '<p class="muted small">Commission claimed by a former or current manager is under review and is not listed here.</p>' : ''}

      <h3 class="stmt-year">5. Tax write-offs (with receipts)</h3>
      ${(() => { const list = expensesFor(ui.acctYear); if (!list.length) return '<p class="muted">No write-offs logged for this period.</p>';
        const byCat = {}; list.forEach((e) => { byCat[e.category || 'Other'] = round2((byCat[e.category || 'Other'] || 0) + num(e.amount)); });
        return `<table class="stmt-table"><thead><tr><th>Date</th><th>Where / who</th><th>Category</th><th>What it was for</th><th>Receipt</th><th class="right">Amount</th></tr></thead><tbody>
          ${list.map((e) => `<tr><td class="num" style="white-space:nowrap">${fmtDate(e.date)}</td><td>${esc(e.vendor || '—')}</td><td>${esc(e.category || 'Other')}</td><td>${esc(e.notes || '—')}</td>
            <td>${(e.files || []).length ? e.files.map((f, i) => f.driveUrl ? `<a href="${esc(f.driveUrl)}" target="_blank" rel="noopener">Receipt${e.files.length > 1 ? ' ' + (i + 1) : ''}</a>` : '<span class="muted">not uploaded</span>').join(' · ') : '<span class="muted">none</span>'}</td>
            <td class="right num">${money(e.amount)}</td></tr>`).join('')}
          <tr><td colspan="5"><b>Total</b> · ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${money(v)}`).join(' · ')}</td><td class="right num"><b>${money(round2(sum(list, (e) => num(e.amount))))}</b></td></tr>
        </tbody></table><p class="muted small">Receipt links open the scan in Google Drive (shared with you view-only).</p>`; })()}

      <h3 class="stmt-year">6. Source files</h3>
      <ul class="small" style="margin:0;padding-left:18px"><li>SAG-AFTRA earnings report (earnings.csv)</li><li>Venmo history and payments sheet</li><li>W-2s / 1099s from payroll companies (Entertainment Partners, Cast &amp; Crew, etc.) — bring separately</li><li>Bank statements for deposits and any check or Zelle payments</li></ul>
    </div>`);
  }
  function viewReports() {
    const tab = ['accountant', 'quarterly'].includes(ui.reportTab) ? ui.reportTab : 'statement';
    let body;
    if (tab === 'quarterly') {
      body = quarterlyHTML();
    } else if (tab === 'statement') {
      const d = stmtData();
      body = `<div class="card no-print"><div class="card-body stack">
          <div class="callout" style="background:var(--lavender);color:var(--text)"><strong>Live in your app only.</strong> This updates as you log payments, but nobody else can see it. To share it, save a dated PDF and have your lawyer look it over first. It shows payments only: no balances, 5% flags, notes, their records, other team members or personal bills.</div>
          <div class="row" style="flex-wrap:wrap;gap:12px">
            <label style="min-width:180px">Statement for<select data-stmt="member">${state.settings.team.map((m) => `<option value="${esc(m.id)}" ${m.id === d.mid ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
            <label style="min-width:150px">Period<select data-stmt="year"><option value="all" ${ui.stmt.year === 'all' ? 'selected' : ''}>All payments</option>${d.years.map((y) => `<option value="${y}" ${ui.stmt.year === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
            <label class="inline" style="align-self:flex-end;padding-bottom:10px"><input type="checkbox" data-stmt="jobs" ${ui.stmt.jobs ? 'checked' : ''}> Show which jobs each payment covered (proven matches only)</label>
          </div>
          <div class="row"><button class="btn primary" data-action="print-report">Save as PDF / Print</button><button class="btn" data-action="stmt-csv">Download CSV</button></div>
        </div></div>
        ${shareCardHTML('statement')}
        ${statementHTML(d)}`;
    } else {
      const a = accountantData();
      body = `<div class="card no-print"><div class="card-body stack">
          <div class="callout" style="background:var(--lavender);color:var(--text)">Everything your accountant needs for acting income, commissions paid and acting expenses. It leaves out the commission review (balances, 5% flags, their records, your notes) and all personal bills.</div>
          <div class="row" style="flex-wrap:wrap;gap:12px">
            <label style="min-width:150px">Year<select data-acct="year"><option value="all" ${ui.acctYear === 'all' ? 'selected' : ''}>All years</option>${a.allYears.map((y) => `<option value="${y}" ${ui.acctYear === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
          </div>
          <div class="row"><button class="btn primary" data-action="print-report">Save as PDF / Print</button><button class="btn" data-action="acct-csv">Download spreadsheets (CSV)</button></div>
        </div></div>
        ${shareCardHTML('accountant')}
        ${accountantHTML(a)}`;
    }
    return `<div class="page-head no-print"><div><h1>Reports</h1><p>A payment statement you can share, and a package for your accountant.</p></div></div>
      <div class="toolbar no-print"><div class="seg">${[['statement', 'Payment statement'], ['accountant', 'Accountant package'], ['quarterly', 'Quarterly payouts']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-action="report-tab" data-value="${k}">${l}</button>`).join('')}</div></div>
      ${body}`;
  }
  // ---------- private links: a read-only copy of a report, served by your Drive helper ----------
  // Nothing is shared until you click Publish. Each link has its own long random key; "Turn off" kills it.
  const sharedCfg = () => (state.settings.shared ||= {});
  function sharedPageId(kind) { return kind === 'accountant' ? 'accountant' : `statement-${stmtData().mid}`; }
  function pageCSS() {
    let css = '';
    for (const sh of document.styleSheets) { try { css += [...sh.cssRules].map((r) => r.cssText).join('\n'); } catch (e) {} }
    return css;
  }
  function sharedPageHTML(kind, opts = {}) {
    const keep = { stmt: { ...ui.stmt }, acctYear: ui.acctYear };
    let body, title;
    try {
      if (kind === 'accountant') { ui.acctYear = 'all'; body = accountantHTML(accountantData()); title = 'Accountant package'; }
      else { ui.stmt = { member: opts.member || ui.stmt.member, year: 'all', jobs: !!opts.jobs }; const d = stmtData(); body = statementHTML(d); title = `Payment statement — ${d.member?.name || ''}`; }
    } finally { ui.stmt = keep.stmt; ui.acctYear = keep.acctYear; }
    const star = '<svg viewBox="0 0 24 24"><path d="M12 2.6l2.85 5.95 6.55.9-4.78 4.55 1.2 6.5L12 17.35 6.18 20.5l1.2-6.5L2.6 9.45l6.55-.9z"/></svg>';
    const when = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><style>${pageCSS()}</style></head>
<body class="shared"><div class="share-bar"><span class="logo" aria-hidden="true">${star}</span><span class="share-name">The Actor’s HQ</span><span class="spacer"></span><span class="share-when">Updated ${esc(when)}</span></div>
<main class="share-main">${body}</main>
<footer class="share-foot">Shared privately by ${esc(state.settings.senderName || 'the sender')}. Read-only. Please don’t forward this link.</footer></body></html>`;
  }
  async function publishShared(kind, { newKey = false, silent = false } = {}) {
    const cfg = sharedCfg(); const id = sharedPageId(kind);
    const prev = cfg[id] || {};
    const html = sharedPageHTML(kind, { member: prev.member || stmtData().mid, jobs: kind === 'accountant' ? false : (prev.jobs ?? ui.stmt.jobs) });
    const r = await driveCall('publish', { page: id, html, newKey });
    cfg[id] = { ...prev, kind, url: r.url, at: new Date().toISOString(), member: kind === 'accountant' ? '' : (prev.member || stmtData().mid), jobs: kind === 'accountant' ? false : (prev.jobs ?? ui.stmt.jobs) };
    save(); if (!silent) { render(); toast(newKey ? 'New link made — the old one no longer works' : 'Private link updated'); }
  }
  async function refreshSharedPages() {
    const cfg = state.settings.shared || {};
    for (const [id, c] of Object.entries(cfg)) {
      if (!c?.url || !c.auto) continue;
      try {
        const html = sharedPageHTML(c.kind, { member: c.member, jobs: c.jobs });
        await driveCall('publish', { page: id, html });
        c.at = new Date().toISOString();
      } catch (e) { console.warn('Shared page refresh failed', e); }
    }
    save();
  }
  function shareCardHTML(kind) {
    const id = sharedPageId(kind); const c = sharedCfg()[id];
    const who = kind === 'accountant' ? 'your accountant' : (stmtData().member?.name || 'this person');
    const on = !!c?.url;
    return `<div class="card no-print"><div class="card-head"><h2>Private link</h2>${on ? '<span class="pill green">On</span>' : '<span class="pill">Off</span>'}</div>
      <div class="card-body stack">
        <p class="muted small" style="margin:0">A read-only web page of the report below, in the same design as this app, for ${esc(who)}. It isn’t listed anywhere — only people you give the link to can open it. It’s served from your own Google Drive helper, and you can turn it off at any time.</p>
        ${!driveConfigured() ? '<div class="muted small">Connect Google Drive in Settings first.</div>' : on ? `
          <div class="share-url"><input readonly value="${esc(c.url)}" aria-label="Private link" onclick="this.select()"><button class="btn sm primary" data-action="share-copy" data-kind="${kind}">Copy link</button></div>
          <div class="muted small">Last updated ${new Date(c.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${kind !== 'accountant' ? ` · ${c.jobs ? 'shows which jobs each payment covered' : 'payments only'}` : ''}</div>
          <label class="inline"><input type="checkbox" data-share-auto="${kind}" ${c.auto ? 'checked' : ''}> Update it automatically after each backup</label>
          <div class="row"><button class="btn sm" data-action="share-publish" data-kind="${kind}">Update now</button><button class="btn sm" data-action="share-newkey" data-kind="${kind}">Make a new link</button><button class="btn sm danger" data-action="share-off" data-kind="${kind}">Turn off link</button></div>`
          : `<div class="row"><button class="btn primary" data-action="share-publish" data-kind="${kind}">Create private link</button></div>`}
      </div></div>`;
  }
  // ---------- quarterly residual commissions (some agents bill residuals by quarter) ----------
  const quarterOf = (d) => Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
  function quarterlyData(mid, year) {
    const q = [1, 2, 3, 4].map((n) => ({ n, gross: 0, due: 0, paid: 0, taken: 0, open: 0, lines: 0 }));
    for (const c of state.checks) {
      if (!isResidual(c) || !(c.receivedDate || '').startsWith(year)) continue;
      const s = c.splits.find((x) => x.memberId === mid); if (!s) continue;
      const st = splitState(s); if (st === 'notOwed') continue;
      const r = q[quarterOf(c.receivedDate) - 1];
      r.gross += num(c.gross); r.due += num(s.amount); r.lines++;
      if (st === 'paid') r.paid += num(s.amount); else if (st === 'deducted') r.taken += num(s.amount); else r.open += num(s.amount);
    }
    return q.map((r) => ({ ...r, gross: round2(r.gross), due: round2(r.due), paid: round2(r.paid), taken: round2(r.taken), open: round2(r.open) }));
  }
  // All-team view: each person × quarter for one year (what was due, what's paid, what's still open).
  function teamQuarterly(year, scope) {
    const rows = {};
    for (const c of state.checks) {
      if (!(c.receivedDate || '').startsWith(year)) continue;
      if (scope === 'residuals' && !isResidual(c)) continue;
      const qi = quarterOf(c.receivedDate) - 1;
      for (const s of c.splits) {
        const st = splitState(s); if (st === 'notOwed' || st === 'deducted') continue;
        const r = (rows[s.memberId] ||= { name: memberById(s.memberId)?.name || s.name || 'Former member', q: [0, 1, 2, 3].map(() => ({ due: 0, paid: 0, open: 0 })) });
        const cell = r.q[qi]; cell.due += num(s.amount);
        if (st === 'paid') cell.paid += num(s.amount); else cell.open += num(s.amount);
      }
    }
    const list = Object.entries(rows).map(([id, r]) => ({ id, ...r, q: r.q.map((x) => ({ due: round2(x.due), paid: round2(x.paid), open: round2(x.open) })) }));
    list.forEach((r) => { r.year = r.q.reduce((a, x) => ({ due: round2(a.due + x.due), paid: round2(a.paid + x.paid), open: round2(a.open + x.open) }), { due: 0, paid: 0, open: 0 }); });
    return list.sort((a, b) => b.year.due - a.year.due);
  }
  function teamQuarterlyHTML() {
    const years = yearsOf(state.checks.map((c) => c.receivedDate));
    const year = years.includes(ui.tqYear) ? ui.tqYear : years[0];
    const scope = ui.tqScope === 'residuals' ? 'residuals' : 'all';
    if (!year) return '';
    const list = teamQuarterly(year, scope);
    const totals = [0, 1, 2, 3].map((i) => list.reduce((a, r) => ({ due: round2(a.due + r.q[i].due), paid: round2(a.paid + r.q[i].paid), open: round2(a.open + r.q[i].open) }), { due: 0, paid: 0, open: 0 }));
    const yt = totals.reduce((a, x) => ({ due: round2(a.due + x.due), paid: round2(a.paid + x.paid), open: round2(a.open + x.open) }), { due: 0, paid: 0, open: 0 });
    const cell = (x) => !x.due ? '<span class="muted">—</span>' : `<div class="tq-due">${money(x.due)}</div><div class="tq-sub">${x.open > 0.99 ? `<span class="tq-open">${money(x.open)} open</span>` : '<span class="tq-ok">✓ settled</span>'}</div>`;
    return `<div class="statement printable">
        <div class="stmt-head"><div><div class="eyebrow">Team payouts by quarter</div><h2>${year} · everyone</h2>
          <div class="muted small">What each person was owed from checks applied in each quarter${scope === 'residuals' ? ' — residual checks only' : ''}. Commission already taken out of checks (like an agent’s cut on sessions) isn’t counted.</div></div>
          <div class="stmt-total"><div class="muted small">Still open for ${year}</div><div class="value">${money(yt.open)}</div><div class="muted small">${money(yt.due)} owed · ${money(yt.paid)} paid</div></div></div>
        <div class="row no-print" style="gap:10px;flex-wrap:wrap;margin:6px 0 4px">
          <div class="seg">${[['all', 'All commissions'], ['residuals', 'Residuals only']].map(([k, l]) => `<button class="${scope === k ? 'on' : ''}" data-action="tq-scope" data-value="${k}">${l}</button>`).join('')}</div>
          <select data-tq="year" style="width:auto" aria-label="Year">${years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        </div>
        ${list.length ? `<div class="table-wrap" style="padding:0"><table class="tq-table">
          <thead><tr><th>Person</th>${['Q1 · Jan–Mar', 'Q2 · Apr–Jun', 'Q3 · Jul–Sep', 'Q4 · Oct–Dec'].map((h) => `<th class="right">${h}</th>`).join('')}<th class="right">${year}</th></tr></thead>
          <tbody>${list.map((r) => `<tr class="clickable" data-action="tq-person" data-id="${esc(r.id)}"><td><div class="title">${esc(r.name)}</div></td>${r.q.map((x) => `<td class="right">${cell(x)}</td>`).join('')}<td class="right">${cell(r.year)}</td></tr>`).join('')}
            <tr class="tq-total"><td><b>Everyone</b></td>${totals.map((x) => `<td class="right">${cell(x)}</td>`).join('')}<td class="right">${cell(yt)}</td></tr></tbody>
        </table></div>
        <p class="muted small stmt-foot">“Open” means no logged payment covers it yet. Tap a person to see their quarters in detail below.</p>`
          : '<p class="muted">No team commissions in this year.</p>'}
      </div>`;
  }
  function quarterlyHTML() {
    return teamQuarterlyHTML() + '<div style="height:20px"></div>' + personQuarterlyHTML();
  }
  function personQuarterlyHTML() {
    const members = state.settings.team.filter((m) => state.checks.some((c) => isResidual(c) && c.splits.some((s) => s.memberId === m.id)));
    const mid = members.find((m) => m.id === ui.qMember)?.id || members[0]?.id;
    const years = yearsOf(state.checks.filter((c) => isResidual(c)).map((c) => c.receivedDate));
    const year = years.includes(ui.qYear) ? ui.qYear : years[0];
    if (!mid || !year) return '<div class="card empty">No residual commissions yet. Add a commission rule (Payout audit) or project split that covers residuals.</div>';
    const q = quarterlyData(mid, year);
    const tot = q.reduce((a, r) => ({ gross: a.gross + r.gross, due: a.due + r.due, paid: a.paid + r.paid, open: a.open + r.open }), { gross: 0, due: 0, paid: 0, open: 0 });
    const range = (n) => ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'][n - 1];
    return `<div class="card no-print"><div class="card-body"><div class="row" style="gap:12px;flex-wrap:wrap">
        <label style="min-width:170px">Person<select data-q="member">${members.map((m) => `<option value="${esc(m.id)}" ${m.id === mid ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <label style="min-width:130px">Year<select data-q="year">${years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      </div></div></div>
      <div class="statement printable">
        <div class="stmt-head"><div><div class="eyebrow">Quarterly residual commissions</div><h2>${esc(memberById(mid)?.name || '')} · ${year}</h2><div class="muted small">Commission on residual checks, grouped by the quarter each check was applied. Session commissions taken out of checks aren’t included.</div></div>
          <div class="stmt-total"><div class="muted small">Still owed for ${year}</div><div class="value">${money(round2(tot.open))}</div><div class="muted small">${money(round2(tot.due))} due · ${money(round2(tot.paid))} paid</div></div></div>
        <div class="q-grid">${q.map((r) => `<div class="q-card ${r.open > 0.99 ? 'open' : r.due ? 'done' : ''}">
          <div class="q-name">Q${r.n} <span class="muted small">${range(r.n)}</span></div>
          <div class="q-due">${money(r.due)}</div>
          <div class="muted small">${r.lines} residual line${r.lines === 1 ? '' : 's'} · ${money(r.gross)} gross</div>
          <div class="q-status">${!r.due ? '<span class="pill">Nothing due</span>' : r.open > 0.99 ? `<span class="pill red">${money(r.open)} not settled</span>` : '<span class="pill green">Settled</span>'}</div>
        </div>`).join('')}</div>
        <p class="muted small stmt-foot">“Not settled” means no matching payment is logged yet (Payout audit → Match to… or Log a payment). Mark a quarter’s commissions paid there once you pay the invoice.</p>
      </div>`;
  }

  // ---------- tax write-offs with receipts ----------
  const EXPENSE_CATS = ['Hair & makeup', 'Wardrobe & costumes', 'Headshots & reels', 'Classes & coaching', 'Casting sites & subscriptions', 'Union dues', 'Agent / manager commissions', 'Travel & mileage', 'Meals (business)', 'Equipment & home studio', 'Phone & internet', 'Theater / film tickets (research)', 'Other'];
  function expenseYears() { return yearsOf([...(state.expenses || []).map((e) => e.date), today()]); }
  function expensesFor(year) { return (state.expenses || []).filter((e) => year === 'all' || (e.date || '').startsWith(year)).sort((a, b) => b.date.localeCompare(a.date)); }
  function viewWriteoffs() {
    const years = expenseYears();
    const year = ui.woYear && (ui.woYear === 'all' || years.includes(ui.woYear)) ? ui.woYear : years[0];
    const list = expensesFor(year);
    const byCat = {}; list.forEach((e) => { byCat[e.category || 'Other'] = round2((byCat[e.category || 'Other'] || 0) + num(e.amount)); });
    const total = round2(sum(list, (e) => num(e.amount)));
    const missing = list.filter((e) => !(e.files || []).length).length;
    const notUploaded = list.filter((e) => (e.files || []).some((f) => f.status !== 'uploaded')).length;
    return `
      <div class="page-head">
        <div><h1>Write-offs</h1><p>Track business expenses and keep the receipt with each one. Your accountant decides what’s deductible — you just keep the proof.</p></div>
        ${addButton('add-expense', 'Add an expense')}
      </div>
      <div class="toolbar"><div class="seg">${[...years.map((y) => [y, y]), ['all', 'All years']].map(([k, l]) => `<button class="${year === k ? 'on' : ''}" data-action="wo-year" data-value="${k}">${l}</button>`).join('')}</div></div>
      <div class="grid tiles">
        <div class="card tile"><div class="label">Total ${year === 'all' ? '' : year}</div><div class="value">${money(total)}</div><div class="sub">${list.length} expense${list.length === 1 ? '' : 's'}</div></div>
        <div class="card tile ${missing ? 'warn' : ''}"><div class="label">Missing a receipt</div><div class="value">${missing}</div><div class="sub">${missing ? 'Add a photo or PDF' : 'All have receipts'}</div></div>
        <div class="card tile"><div class="label">Receipts in Drive</div><div class="value">${list.length - notUploaded}</div><div class="sub">${notUploaded ? `${notUploaded} only on this device` : driveConfigured() ? 'All backed up' : 'Connect Drive in Settings'}</div></div>
        <div class="card tile"><div class="label">Biggest category</div><div class="value" style="font-size:22px">${Object.keys(byCat).length ? esc(Object.entries(byCat).sort((a, b) => b[1] - a[1])[0][0]) : '—'}</div><div class="sub">${Object.keys(byCat).length ? money(Object.entries(byCat).sort((a, b) => b[1] - a[1])[0][1]) : ''}</div></div>
      </div>
      <div class="grid dash">
        <div class="card"><div class="card-head"><h2>Expenses</h2><div class="row">${notUploaded && driveConfigured() ? '<button class="btn sm" data-action="wo-upload-all">Upload receipts to Drive</button>' : ''}<button class="btn sm" data-action="wo-csv">Download (CSV)</button></div></div>
          <div class="card-body">${list.length ? `<div class="list">${list.map((e) => `<div class="list-item" data-action="edit-expense" data-id="${e.id}">
              <div class="grow"><div class="title">${esc(e.vendor || e.category || 'Expense')}</div><div class="sub">${fmtDate(e.date)} · ${esc(e.category || 'Other')}${e.notes ? ' · ' + esc(e.notes) : ''}</div>
                ${(e.files || []).length ? `<div class="row" style="margin-top:6px">${e.files.map((f) => fileChip(f, e.id, 'expense')).join('')}</div>` : '<div class="sub" style="color:var(--rose-ink)">No receipt yet</div>'}</div>
              <div class="amt">${money(e.amount)}</div></div>`).join('')}</div>`
            : '<div class="empty">No expenses for this period yet.<br><button class="btn primary" data-action="add-expense">+ Add an expense</button></div>'}</div></div>
        <div class="card"><div class="card-head"><h2>By category</h2></div><div class="card-body">${Object.keys(byCat).length ? `<div class="list">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="list-item"><div class="grow">${esc(k)}</div><div class="amt">${money(v)}</div></div>`).join('')}</div>` : '<div class="muted small">Nothing yet.</div>'}
          <p class="muted small" style="margin:12px 0 0">Your accountant sees this list, with links to every receipt, in the Accountant package (Reports) and its private link.</p></div></div>
      </div>`;
  }
  function expenseFormHTML(m) {
    const e = m.id ? (state.expenses || []).find((x) => x.id === m.id) : { date: today(), vendor: '', category: '', amount: '', notes: '', files: [] };
    if (!e) return null;
    return `<form class="modal-card" data-form="expense" autocomplete="off">
      <header><h2>${m.id ? 'Edit expense' : 'Add an expense'}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div>
          <div class="field-label">Receipt ${driveConfigured() ? '<span class="muted">· saves to Google Drive</span>' : ''}</div>
          <div class="scan-row">
            <label class="btn primary scan-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>Scan receipt<input type="file" id="file-camera" accept="image/*" capture="environment" hidden></label>
            <label class="dropzone"><input type="file" id="file-input" multiple accept="image/*,application/pdf" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l6 6v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm7 1.5V9h5.5zM11 12v3H8v2h3v3h2v-3h3v-2h-3v-3z"/></svg>Choose file<span class="dz-hint">or drag it here</span></label>
          </div>
          <div class="file-list" id="pending-files" style="margin-top:8px">${pendingFilesHTML()}</div>
          ${(e.files || []).length ? `<div class="row" style="margin-top:8px">${e.files.map((f) => fileChip(f, e.id, 'expense')).join('')}</div>` : ''}
        </div>
        <div class="grid2">
          <label><span>Date <span class="req">*</span></span><input type="date" name="date" required value="${esc(e.date)}"></label>
          <label><span>Amount <span class="req">*</span></span><input name="amount" type="number" step="0.01" min="0" inputmode="decimal" required value="${esc(e.amount)}" placeholder="0.00"></label>
          <label>Where / who<input name="vendor" value="${esc(e.vendor)}" placeholder="e.g. Nail salon, Backstage"></label>
          <label>Category<input name="category" list="exp-cats" value="${esc(e.category)}" placeholder="Pick or type"></label>
        </div>
        <datalist id="exp-cats">${EXPENSE_CATS.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        <label>What it was for <span class="muted" style="font-weight:400">(helps your accountant)</span><input name="notes" value="${esc(e.notes)}" placeholder="e.g. Nails for Verizon commercial shoot 7/22"></label>
      </div>
      <footer>
        ${m.id ? `<button type="button" class="btn ghost danger" data-action="delete-expense" data-id="${e.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </footer>
    </form>`;
  }
  async function submitExpenseForm(form) {
    const f = form.elements;
    const data = { date: f.date.value || today(), amount: round2(num(f.amount.value)), vendor: f.vendor.value.trim(), category: f.category.value.trim() || 'Other', notes: f.notes.value.trim() };
    state.expenses = state.expenses || [];
    let e = ui.modal.id ? state.expenses.find((x) => x.id === ui.modal.id) : null;
    if (e) Object.assign(e, data); else { e = { id: uid(), createdAt: new Date().toISOString(), files: [], ...data }; state.expenses.push(e); }
    const added = await stashFiles(ui.pendingFiles.splice(0));
    e.files = [...(e.files || []), ...added];
    save(); closeModal(); render();
    toast(`${money(data.amount)} saved`);
    if (added.length) uploadOwnerFiles(e.files, expenseUploadOpts(e), 'receipt');
  }
  const expenseUploadOpts = (e) => ({ kind: 'receipt', year: (e.date || today()).slice(0, 4), baseName: `${e.date} - ${e.vendor || e.category || 'receipt'} - ${num(e.amount).toFixed(2)}` });
  function expenseCSV(year) {
    const rows = [['Date', 'Where / who', 'Category', 'Amount', 'What it was for', 'Receipt links']];
    for (const e of expensesFor(year)) rows.push([e.date, e.vendor, e.category, num(e.amount), e.notes, (e.files || []).map((f) => f.driveUrl || `${f.name} (only on the owner’s device)`).join(' ; ')]);
    rows.push(['', '', 'Total', round2(sum(expensesFor(year), (e) => num(e.amount))), '', '']);
    downloadCSV(`write-offs-${year}-${today()}.csv`, rows);
  }

  function stmtCSV() {
    const d = stmtData(); const m = d.member || { name: 'member' };
    const rows = [['Date', 'Paid to', 'Method', 'Note / what it was for', 'Amount', ...(ui.stmt.jobs ? ['Jobs covered (proven matches)'] : [])]];
    for (const r of d.rows) rows.push([r.date, m.name, r.method, r.memo, r.amount, ...(ui.stmt.jobs ? [r.jobs.map(({ c, s }) => `${projectName(c)} ${c.receivedDate} gross ${num(c.gross)} x ${num(s.percent)}% = ${num(s.amount)}`).join('; ')] : [])]);
    rows.push(['', '', '', 'Total', round2(sum(d.rows, (r) => r.amount))]);
    downloadCSV(`payment-statement-${m.name.toLowerCase().replace(/\W+/g, '-')}-${ui.stmt.year}-${today()}.csv`, rows);
  }
  function acctCSV() {
    const a = accountantData(); const tag = `${ui.acctYear}-${today()}`;
    const rows = [['Section', 'Year', 'Name', 'Category', 'Sessions', 'Residuals', 'Gross / Paid', 'Net / Kept from checks', 'Count', 'Note']];
    for (const [y, v] of Object.entries(a.earn).sort()) rows.push(['Income (SAG-AFTRA report)', y, '', '', v.sessions, v.residuals, v.gross, '', v.n, 'Gross as reported to the plans']);
    for (const [y, v] of Object.entries(a.logged).sort()) rows.push(['Checks logged in app', y, '', '', '', '', v.gross, v.net, v.n, 'May overlap the SAG-AFTRA report']);
    for (const r of [...a.commRows].reverse()) rows.push(['Commissions paid', r.yr, r.name, '', '', '', r.paid, r.deducted || '', r.n, r.paid >= 600 ? 'Ask about 1099-NEC' : '']);
    for (const r of acctQuarterly()) r.q.forEach((x, i) => { if (x.due) rows.push(['Residual commission by quarter', r.yr, r.name, `Q${i + 1}`, '', '', x.due, '', '', x.open > 0.99 ? `${x.open} still open (no payment logged)` : 'paid']); });
    for (const r of a.expRows) rows.push(['Acting expense', ui.acctYear === 'all' ? 'all' : ui.acctYear, r.b.name, r.b.category || '', '', '', r.paid, '', r.n, `${FREQS[r.b.frequency] || ''}; yearly cost ${r.yearly}`]);
    for (const b of a.owed) rows.push(['Owed now', '', b.name, b.category || '', '', '', num(b.amount), '', '', `Due since ${b.nextDue}`]);
    for (const e of expensesFor(ui.acctYear)) rows.push(['Tax write-off', (e.date || '').slice(0, 4), e.vendor || '', e.category || '', '', '', num(e.amount), '', '', `${e.date}; ${e.notes || ''}; receipt: ${(e.files || []).map((f) => f.driveUrl || 'not uploaded').join(' ; ') || 'none'}`]);
    downloadCSV(`accountant-package-${tag}.csv`, rows);
  }

  // ---------- calendar: bills due, bills paid, deposits, team payouts (calendar or list) ----------
  const CAL_KINDS = {
    due: { label: 'Bill due', tone: 'peach' },
    overdue: { label: 'Overdue', tone: 'rose' },
    paid: { label: 'Bill paid', tone: 'sky' },
    deposit: { label: 'Deposit', tone: 'mint' },
    payout: { label: 'Team payout', tone: 'lavender' },
    earning: { label: 'SAG report line', tone: 'butter' },
  };
  const CAL_FILTERS = [['deposit', 'Deposits'], ['due', 'Acting bills due'], ['paid', 'Acting bills paid'], ['payout', 'Team payouts'], ['earning', 'SAG report history']];
  const calShowKey = (k) => (k === 'overdue' ? 'due' : k);
  function calEvents(from, to) {
    const out = []; const t = today();
    const inR = (d) => d && d >= from && d <= to;
    for (const b of state.bills) {
      if (!b.acting) continue; // personal bills & subscriptions stay off the calendar
      for (const p of b.payments || []) if (inR(p.date)) out.push({ date: p.date, kind: 'paid', title: b.name, sub: b.kind === 'subscription' ? 'Subscription' : 'Bill', amount: num(p.amount), action: 'bill-history', id: b.id });
      if (!b.active || !b.nextDue) continue;
      let d = b.nextDue, guard = 0;
      while (d && d <= to && guard++ < 500) {
        if (d >= from) out.push({ date: d, kind: d < t ? 'overdue' : 'due', title: b.name, sub: [b.autopay ? 'Autopay' : '', FREQS[b.frequency] || ''].filter(Boolean).join(' · '), amount: num(b.amount), action: 'edit-bill', id: b.id });
        if (b.frequency === 'once') break;
        d = addPeriod(d, b.frequency, b.anchorDay);
      }
    }
    for (const c of state.checks) {
      if (!inR(c.receivedDate) && !c.splits.some((s) => inR(s.paidDate))) continue;
      if (c.historical) {
        if (inR(c.receivedDate)) out.push({ date: c.receivedDate, kind: 'earning', title: projectName(c), sub: c.payType || '', amount: num(c.gross), action: 'open-check', id: c.id });
        continue;
      }
      if (inR(c.receivedDate)) out.push({ date: c.receivedDate, kind: 'deposit', title: c.payer || 'SAG check', sub: [employerOf(c), c.checkNumber ? '#' + c.checkNumber : ''].filter(Boolean).join(' · '), amount: c.net !== '' && num(c.net) ? num(c.net) : num(c.gross), action: 'open-check', id: c.id });
      for (const s of c.splits) if (s.paid && inR(s.paidDate)) out.push({ date: s.paidDate, kind: 'payout', title: `Paid ${s.name}`, sub: s.method || '', amount: num(s.amount), action: 'open-check', id: c.id });
    }
    for (const e of state.evidence || []) if (inR(e.date)) out.push({ date: e.date, kind: 'payout', title: `Paid ${memberById(e.memberId)?.name || 'team member'}`, sub: [e.method, e.memo].filter(Boolean).join(' · '), amount: num(e.amount), action: '', id: '' });
    const order = { overdue: 0, due: 1, deposit: 2, paid: 3, payout: 4, earning: 5 };
    return out.filter((e) => ui.calShow[calShowKey(e.kind)]).sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || b.amount - a.amount);
  }
  const calTone = (k) => CAL_KINDS[k].tone;
  const calAttrs = (e) => (e.action ? `data-action="${e.action}" data-id="${esc(e.id)}"` : '');
  function calChip(e) {
    const tn = calTone(e.kind);
    return `<button type="button" class="cal-chip" style="--t:var(--${tn});--ti:var(--${tn}-ink)" ${calAttrs(e)} title="${esc(`${CAL_KINDS[e.kind].label}: ${e.title} — ${money(e.amount)}`)}"><span>${esc(e.title)}</span><b>${money(e.amount)}</b></button>`;
  }
  function calRow(e) {
    const tn = calTone(e.kind);
    return `<div class="agenda-row ${e.action ? 'clickable' : ''}" ${calAttrs(e)}>
      <span class="cal-bar" style="background:var(--${tn}-ink)"></span>
      <div style="min-width:0"><div class="title">${esc(e.title)}</div><div class="sub">${esc(CAL_KINDS[e.kind].label)}${e.sub ? ' · ' + esc(e.sub) : ''}</div></div>
      <span class="pill" style="background:var(--${tn});color:var(--${tn}-ink)">${esc(CAL_KINDS[e.kind].label)}</span>
      <div class="amount num">${e.kind === 'deposit' || e.kind === 'earning' ? '+' : ''}${money(e.amount)}</div>
    </div>`;
  }
  function viewCalendar() {
    const t = today();
    const month = ui.calMonth || t.slice(0, 7);
    const [yy, mm] = month.split('-').map(Number);
    const first = new Date(yy, mm - 1, 1), last = new Date(yy, mm, 0);
    const mFrom = toISO(first), mTo = toISO(last);
    const mode = state.settings.calMode === 'list' ? 'list' : 'calendar';
    const gridStart = new Date(yy, mm - 1, 1 - first.getDay());
    const gridEnd = new Date(yy, mm - 1, last.getDate() + (6 - last.getDay()));
    const events = calEvents(toISO(gridStart), toISO(gridEnd));
    const inMonth = events.filter((e) => e.date >= mFrom && e.date <= mTo);
    const byDay = {}; events.forEach((e) => (byDay[e.date] ||= []).push(e));
    const tot = (k) => round2(sum(inMonth.filter((e) => calShowKey(e.kind) === k), (e) => e.amount));
    const title = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const sel = ui.calDay && ui.calDay >= toISO(gridStart) && ui.calDay <= toISO(gridEnd) ? ui.calDay : (t >= mFrom && t <= mTo ? t : '');
    const days = []; for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) days.push(toISO(d));
    const legend = CAL_FILTERS.map(([k, l]) => { const tn = CAL_KINDS[k].tone; return `<button type="button" class="cal-filter ${ui.calShow[k] ? '' : 'off'}" data-action="cal-filter" data-kind="${k}" aria-pressed="${ui.calShow[k] ? 'true' : 'false'}"><i class="cal-dot" style="background:var(--${tn}-ink)"></i>${l}</button>`; }).join('');
    const tiles = `<div class="grid tiles">
      <div class="card tile"><div class="label"><i class="cal-dot" style="background:var(--mint-ink)"></i> Deposits</div><div class="value" style="color:var(--mint-ink)">${money(tot('deposit'))}</div><div class="sub">${inMonth.filter((e) => e.kind === 'deposit').length} in ${esc(first.toLocaleDateString('en-US', { month: 'long' }))}</div></div>
      <div class="card tile"><div class="label"><i class="cal-dot" style="background:var(--peach-ink)"></i> Acting bills due</div><div class="value">${money(tot('due'))}</div><div class="sub">${inMonth.filter((e) => e.kind === 'overdue').length ? `<span style="color:var(--rose-ink)">${inMonth.filter((e) => e.kind === 'overdue').length} overdue</span>` : `${inMonth.filter((e) => e.kind === 'due').length} upcoming`}</div></div>
      <div class="card tile"><div class="label"><i class="cal-dot" style="background:var(--sky-ink)"></i> Acting bills paid</div><div class="value">${money(tot('paid'))}</div><div class="sub">${inMonth.filter((e) => e.kind === 'paid').length} payment${inMonth.filter((e) => e.kind === 'paid').length === 1 ? '' : 's'}</div></div>
      <div class="card tile"><div class="label"><i class="cal-dot" style="background:var(--lavender-ink)"></i> Team payouts</div><div class="value">${money(tot('payout'))}</div><div class="sub">${inMonth.filter((e) => e.kind === 'payout').length} sent</div></div>
    </div>`;
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const calendar = `<div class="card cal-card"><div class="cal-grid">
        ${dows.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
        ${days.map((d) => { const ev = byDay[d] || []; const out = d < mFrom || d > mTo;
          return `<div class="cal-cell ${out ? 'out' : ''} ${d === t ? 'today' : ''} ${d === sel ? 'sel' : ''}" data-action="cal-day" data-day="${d}" role="button" tabindex="0" aria-label="${esc(fmtDate(d))}, ${ev.length} item${ev.length === 1 ? '' : 's'}">
            <span class="cal-num">${parseISO(d).getDate()}</span>
            <div class="cal-chips">${ev.slice(0, 3).map(calChip).join('')}${ev.length > 3 ? `<span class="cal-more">+${ev.length - 3} more</span>` : ''}</div>
          </div>`; }).join('')}
      </div></div>
      ${sel ? `<div class="card"><div class="card-head"><h2>${esc(parseISO(sel).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</h2><span class="muted small">${(byDay[sel] || []).length} item${(byDay[sel] || []).length === 1 ? '' : 's'}</span></div>
        <div class="card-body">${(byDay[sel] || []).length ? `<div class="agenda">${byDay[sel].map(calRow).join('')}</div>` : '<div class="muted">Nothing on this day.</div>'}</div></div>` : ''}`;
    const groups = {}; inMonth.forEach((e) => (groups[e.date] ||= []).push(e));
    const list = Object.keys(groups).length ? `<div class="card"><div class="card-body agenda">${Object.keys(groups).sort().map((d) => `
        <div class="agenda-day ${d === t ? 'today' : ''}"><div class="agenda-date"><span>${esc(parseISO(d).toLocaleDateString('en-US', { weekday: 'short' }))}</span><b>${parseISO(d).getDate()}</b></div>
          <div class="agenda-items">${groups[d].map(calRow).join('')}</div></div>`).join('')}</div></div>`
      : `<div class="card empty">Nothing in ${esc(title)} with the filters you have on.<br><button class="btn primary" data-action="add-bill" data-acting="1">+ Add acting bill or subscription</button></div>`;
    return `
      <div class="page-head">
        <div><h1>Calendar</h1><p>Your acting business at a glance: deposits, team payouts, and acting-related bills and subscriptions. Personal bills stay off this calendar.</p></div>
        ${addButton('add-bill', 'Add acting bill or subscription', 'data-acting="1"')}
      </div>
      <div class="toolbar cal-toolbar">
        <div class="seg">${[['calendar', 'Calendar'], ['list', 'List']].map(([k, l]) => `<button class="${mode === k ? 'on' : ''}" data-action="cal-mode" data-value="${k}">${l}</button>`).join('')}</div>
        <div class="cal-nav"><button class="icon-btn" data-action="cal-month" data-step="-1" aria-label="Previous month">‹</button><h2>${esc(title)}</h2><button class="icon-btn" data-action="cal-month" data-step="1" aria-label="Next month">›</button>
          ${month !== t.slice(0, 7) ? '<button class="btn sm" data-action="cal-month" data-step="0">Today</button>' : ''}</div>
      </div>
      <div class="cal-legend">${legend}</div>
      ${state.bills.length && !state.bills.some((b) => b.acting) ? '<p class="muted small" style="margin:-6px 0 14px">No bills are marked acting-related yet. In Bills &amp; Subs, click <b>Personal</b> on any acting expense (union dues, casting sites, classes) to switch it to <b>Acting</b> and show it here.</p>' : ''}
      ${tiles}
      ${mode === 'calendar' ? calendar : list}`;
  }

  function viewBills() {
    const t = today();
    const active = state.bills.filter((b) => b.active);
    const monthlyBills = sum(state.bills.filter((b) => b.kind === 'bill'), billMonthly);
    const monthlySubs = sum(state.bills.filter((b) => b.kind === 'subscription'), billMonthly);
    const dueWeek = active.filter((b) => b.nextDue && daysBetween(t, b.nextDue) >= 0 && daysBetween(t, b.nextDue) <= 7);
    const overdue = active.filter((b) => b.nextDue && b.nextDue < t);
    let list = state.bills.filter((b) => ui.billTab === 'all' || (ui.billTab === 'acting' ? b.acting : b.kind === ui.billTab));
    list.sort((a, b) => (b.active - a.active) || (a.nextDue || '9999').localeCompare(b.nextDue || '9999') || a.name.localeCompare(b.name));
    return `
      <div class="page-head">
        <div><h1>Bills &amp; Subscriptions</h1><p>Mark each one paid when it goes out — the next due date rolls forward automatically.</p></div>
        <div class="row"><label class="btn white" style="flex-direction:row;color:var(--text);font-size:14px">Load prepared data<input type="file" id="import-pack-file" accept="application/json,.json" hidden></label>${addButton('add-bill', 'Add bill or subscription')}</div>
      </div>
      <div class="grid tiles">
        <div class="card tile"><div class="label">Bills / month</div><div class="value">${money(monthlyBills)}</div></div>
        <div class="card tile"><div class="label">Subscriptions / month</div><div class="value">${money(monthlySubs)}</div><div class="sub">${money(monthlySubs * 12)} / year</div></div>
        <div class="card tile owed"><div class="label">Due next 7 days</div><div class="value">${money(sum(dueWeek, (b) => b.amount))}</div><div class="sub">${dueWeek.length} item${dueWeek.length === 1 ? '' : 's'}</div></div>
        <div class="card tile ${overdue.length ? 'warn' : ''}"><div class="label">Overdue</div><div class="value">${overdue.length}</div><div class="sub">${overdue.length ? money(sum(overdue, (b) => b.amount)) : 'None'}</div></div>
      </div>
      <div class="toolbar"><div class="seg">
        ${[['all', 'All'], ['bill', 'Bills'], ['subscription', 'Subscriptions'], ['acting', 'Acting']].map(([k, l]) => `<button class="${ui.billTab === k ? 'on' : ''}" data-action="bill-tab" data-value="${k}">${l}</button>`).join('')}
      </div></div>
      ${list.length ? `<div>${list.map((b) => {
        const st = billStatus(b);
        const last = b.payments?.[0];
        const tone = b.kind === 'subscription' ? 'lavender' : 'sky';
        return `<div class="bill-row ${b.active ? '' : 'inactive'}">
          <div class="icon-tile" style="background:var(--${tone});color:var(--${tone}-ink)">${ICONS[b.kind] || ICONS.bill}</div>
          <div style="min-width:0"><div class="title">${esc(b.name)}</div><div class="sub">${b.acting ? '<span class="pill purple" style="padding:1px 8px;font-size:11px">Acting</span> ' : ''}${b.kind === 'subscription' ? 'Subscription' : 'Bill'}${b.category ? ' · ' + esc(b.category) : ''}${b.autopay ? ' · Autopay' : ''}${b.url ? ` · <a href="${esc(b.url)}" target="_blank" rel="noopener">Pay site</a>` : ''}</div></div>
          <div><div class="amount">${money(b.amount)}</div><div class="sub freq">${FREQS[b.frequency] || ''}</div></div>
          <div class="due"><span class="pill ${st.cls}">${st.label}</span>${b.nextDue ? `<div class="sub num">${fmtDate(b.nextDue)}</div>` : ''}</div>
          <div class="last">${last ? `<div class="sub">Last paid</div><div class="num" style="font-weight:500">${fmtDate(last.date)}</div><button class="linklike small" data-action="bill-history" data-id="${b.id}">History (${b.payments.length})</button>` : '<span class="sub">Not paid yet</span>'}</div>
          <div class="actions">
            ${b.active && b.nextDue ? `<button class="btn sm primary" data-action="pay-bill" data-id="${b.id}">Mark paid</button>` : ''}
            <button class="btn sm ${b.acting ? '' : 'ghost'}" data-action="toggle-acting" data-id="${b.id}" aria-pressed="${b.acting ? 'true' : 'false'}" title="${b.acting ? 'Acting-related: shows on the Calendar. Click to make it personal.' : 'Personal: not on the Calendar. Click to mark it acting-related.'}">${b.acting ? '✓ Acting' : 'Personal'}</button>
            <button class="btn sm" data-action="edit-bill" data-id="${b.id}">Edit</button>
          </div>
        </div>`;
      }).join('')}</div>`
        : `<div class="card empty">${state.bills.length ? 'Nothing in this tab.' : 'Track rent, utilities, phone, insurance, streaming, and more.'}<br><button class="btn primary" data-action="add-bill">+ Add bill or subscription</button></div>`}`;
  }

  // ----- Settings -----
  function viewSettings() {
    const s = state.settings;
    const totalPct = sum(s.team, (m) => m.percent);
    return `
      <div class="page-head"><div><h1>Settings</h1><p>Your team, your accountant, automatic emails, Google Drive and backups.</p></div></div>
      <div class="grid" style="max-width:820px">
        <div class="card">
          <div class="card-head"><h2>Appearance</h2></div>
          <div class="card-body stack">
            <div class="seg">${[['auto', 'Automatic'], ['light', 'Day'], ['dark', 'Night']].map(([k, l]) => `<button class="${getThemePref() === k ? 'on' : ''}" data-action="set-theme" data-value="${k}">${l}</button>`).join('')}</div>
            <p class="muted small" style="margin:0">Automatic follows your Mac’s light or dark setting. You can also switch with the moon / sun button in the top bar. Saved in this browser only.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Team &amp; default split</h2><div class="row" style="gap:8px"><a class="btn sm" href="#rules">Commission rules</a><button class="btn sm" data-action="add-member">+ Add person</button></div></div>
          <div class="card-body stack">
            <p class="muted small" style="margin:0">These percentages are filled in automatically for each new check (you can still change them per check). Changing them here doesn’t change checks you’ve already logged.</p>
            <div class="stack" style="gap:10px">${s.team.map((m) => `
              <div class="member-row">
                ${avatar(m)}
                <label>Name<input data-member-field="name" data-member="${esc(m.id)}" value="${esc(m.name)}"></label>
                <label>Company<input data-member-field="company" data-member="${esc(m.id)}" value="${esc(m.company || '')}" placeholder="e.g. Bright Talent Management"></label>
                <label>Email (for receipts)<input type="email" data-member-field="email" data-member="${esc(m.id)}" value="${esc(m.email || '')}" placeholder="name@example.com"></label>
                <label>Percent<input type="number" step="0.01" min="0" max="100" data-member-field="percent" data-member="${esc(m.id)}" value="${esc(m.percent)}"></label>
                <label>Usually paid by${methodSelect(`data-member-field="method" data-member="${esc(m.id)}" aria-label="How ${esc(m.name)} is usually paid"`, m.method || '')}</label>
                <button class="icon-btn plain" title="Remove ${esc(m.name)}" aria-label="Remove ${esc(m.name)}" data-action="remove-member" data-member="${esc(m.id)}">×</button>
              </div>`).join('')}</div>
            <div class="row" style="justify-content:space-between">
              <div class="muted">Team total: <strong class="num">${round2(totalPct)}%</strong> · you keep ${round2(100 - totalPct)}%</div>
              <label class="inline">Split based on
                <select data-setting="splitBase" style="width:auto"><option value="gross" ${s.splitBase === 'gross' ? 'selected' : ''}>Gross amount</option><option value="net" ${s.splitBase === 'net' ? 'selected' : ''}>Net (check) amount</option></select>
              </label>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Accountant &amp; automatic emails</h2>${driveConfigured() && s.accountantEmail ? '<span class="pill green">On</span>' : '<span class="pill">Needs setup</span>'}</div>
          <div class="card-body stack">
            ${driveConfigured() ? '' : '<div class="callout" style="background:var(--peach);color:var(--peach-ink)">Emails and the ledger are sent from your own Gmail and Google Drive through your Google helper script. Set up Google Drive below first.</div>'}
            <div class="grid2">
              <label>Your name (on receipts)<input data-setting="senderName" value="${esc(s.senderName)}" placeholder="Your name"></label>
              <label>Your role<input data-setting="senderRole" value="${esc(s.senderRole)}" placeholder="Talent"></label>
              <label>Accountant’s name<input data-setting="accountantName" value="${esc(s.accountantName)}" placeholder="First name"></label>
              <label>Accountant’s email<input type="email" data-setting="accountantEmail" value="${esc(s.accountantEmail)}" placeholder="accountant@example.com"></label>
            </div>
            <label style="max-width:420px">Commission under review <span class="muted" style="font-weight:400">(gets the Payout audit tools; left out of the accountant package)</span>
              <select data-setting="reviewMemberId"><option value="">Nobody</option>${s.team.map((m) => `<option value="${esc(m.id)}" ${m.id === s.reviewMemberId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
            <div class="stack" style="gap:10px">
              <label class="inline"><input type="checkbox" data-setting="ledger" ${s.ledger ? 'checked' : ''}> Keep a Google Sheet ledger of every check and payout</label>
              <label class="inline"><input type="checkbox" data-setting="emailAccountantChecks" ${s.emailAccountantChecks ? 'checked' : ''}> Email my accountant when I log a new check (with links to the scans)</label>
              <label class="inline"><input type="checkbox" data-setting="emailAccountantPayments" ${s.emailAccountantPayments ? 'checked' : ''}> Email my accountant when I pay someone on my team</label>
              <label class="inline"><input type="checkbox" data-setting="emailReceipts" ${s.emailReceipts ? 'checked' : ''}> Email a payment receipt to each person I pay</label>
            </div>
            <p class="muted small" style="margin:0">Emails wait about 8 seconds after you mark someone paid, so <strong>Undo</strong> still cancels them. Paying several checks at once with “Mark all paid” sends one itemized receipt. If the app is closed before an email goes out, it sends the next time you open the app.</p>
            <div class="row">
              <button class="btn primary" data-action="share-accountant" ${driveConfigured() ? '' : 'disabled'}>${s.sharedWith ? `Shared with ${esc(s.sharedWith)} · share again` : 'Share scans &amp; ledger with accountant'}</button>
              <button class="btn" data-action="preview-emails">Preview emails</button>
              ${s.ledgerUrl ? `<a class="btn" href="${esc(s.ledgerUrl)}" target="_blank" rel="noopener">Open ledger</a>` : ''}
              <button class="btn ghost" data-action="sync-ledger" ${driveConfigured() && s.ledger ? '' : 'disabled'} title="Re-send every check and payout to the ledger">Sync ledger</button>
            </div>
            <div id="outbox-status">${outboxHTML()}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Google Drive</h2>${driveConfigured() ? '<span class="pill green">Connected</span>' : '<span class="pill">Not set up</span>'}</div>
          <div class="card-body stack">
            <div class="callout">
              <strong>One-time setup (about 5 minutes):</strong>
              <ol>
                <li>Go to <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a> while signed in to the Google account you want files in.</li>
                <li>Delete the sample code and paste in everything from <code>google-drive/Code.gs</code> (in this app’s folder).</li>
                <li>On the line <code>const SECRET = ...</code>, change the value to a password you make up, and paste the same password below.</li>
                <li>Click <strong>Deploy → New deployment</strong>, choose type <strong>Web app</strong>, set <em>Execute as</em>: <strong>Me</strong> and <em>Who has access</em>: <strong>Anyone</strong>, then click Deploy and approve the permissions.</li>
                <li>Copy the <strong>Web app URL</strong> into the box below and click <strong>Test connection</strong>.</li>
                <li><strong>Already set this up before?</strong> Paste the newest <code>Code.gs</code> over the old code, then <strong>Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy</strong> and approve the new Gmail and Google Sheets permissions. The URL stays the same.</li>
              </ol>
              Scans are saved in <code>My Drive / The Actor’s HQ / SAG Checks / &lt;year&gt;</code>.
            </div>
            <label>Web app URL <span class="muted" style="font-weight:400">(or paste your phone setup link)</span><input data-setting="driveUrl" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(s.driveUrl)}"></label>
            <label>Secret password (same as in the script)<input type="password" data-setting="driveSecret" value="${esc(s.driveSecret)}" autocomplete="off"></label>
            <label class="inline"><input type="checkbox" data-setting="autoUpload" ${s.autoUpload ? 'checked' : ''}> Upload check scans to Drive automatically when I add them</label>
            <label class="inline"><input type="checkbox" data-setting="autoBackup" ${s.autoBackup ? 'checked' : ''}> Back up my data to Drive automatically after changes</label>
            <div class="row">
              <button class="btn" data-action="test-drive">Test connection</button>
              <button class="btn" data-action="backup-now" ${driveConfigured() ? '' : 'disabled'}>Back up to Drive now</button>
              <button class="btn" data-action="restore-drive" ${driveConfigured() ? '' : 'disabled'}>Restore from Drive…</button>
              <button class="btn" data-action="retry-uploads" ${driveConfigured() ? '' : 'disabled'}>Upload any files not yet in Drive</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Use on your phone</h2>${s.shared?.app?.url ? '<span class="pill green">On</span>' : ''}</div>
          <div class="card-body stack">
            <p class="muted small" style="margin:0">Open The Actor’s HQ on your iPhone, scan checks and receipts with the camera, and see the same data as here. It’s served from your own Google Drive helper; you enter your Drive password once on the phone and it syncs through your Drive backup.</p>
            ${!driveConfigured() ? '<div class="muted small">Connect Google Drive above first.</div>' : s.shared?.app?.url ? `
              <div class="share-url"><input readonly value="${esc(s.shared.app.url)}" aria-label="Phone link" onclick="this.select()"><button class="btn sm primary" data-action="phone-copy">Copy link</button></div>
              <ol class="small" style="margin:0;padding-left:18px;color:var(--muted)"><li>Send yourself this link (Messages, email or AirDrop) and open it on your iPhone in Safari.</li><li>Tap <b>Share → Add to Home Screen</b> so it opens like an app.</li><li>In the phone app, go to <b>Settings → Google Drive</b>, type your password and tap <b>Test connection</b>. Your data loads from Drive.</li></ol>
              <div class="muted small">Phone app last updated ${new Date(s.shared.app.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Click Update after app changes so the phone gets them too.</div>
              <div class="row"><button class="btn sm" data-action="phone-publish">Update phone app</button><button class="btn sm" data-action="phone-sync">Check for newer data now</button><button class="btn sm danger" data-action="phone-off">Turn off phone link</button></div>`
              : '<div class="row"><button class="btn primary" data-action="phone-publish">Create phone link</button></div>'}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Home-screen app</h2>${s.homeUrl ? '<span class="pill green">On</span>' : ''}</div>
          <div class="card-body stack">
            <p class="muted small" style="margin:0">The version with its own icon (the white shooting star), hosted on GitHub Pages. It holds no data — it loads yours from your Google Drive helper after you enter your Drive password on the phone.</p>
            <label>App address<input data-setting="homeUrl" placeholder="https://yourname.github.io/actors-hq/" value="${esc(s.homeUrl || '')}"></label>
            ${s.homeUrl && s.driveUrl ? `<div class="row"><button class="btn sm primary" data-action="home-copy">Copy phone setup link</button></div>
              <ol class="small" style="margin:0;padding-left:18px;color:var(--muted)"><li>Send yourself the setup link (Messages or Notes).</li><li>On your iPhone, open the app address in Safari and tap <b>Share → Add to Home Screen</b>.</li><li>Open the new icon → <b>Settings → Google Drive</b>: paste the setup link into <b>Web app URL</b> and type your Drive password. Your data loads in a few seconds.</li></ol>` : ''}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Backup file</h2></div>
          <div class="card-body stack">
            <p class="muted small" style="margin:0">Your data is stored in this browser on this computer. Keep a backup — especially before clearing browser data or switching computers.</p>
            <div class="row">
              <button class="btn" data-action="export-json">Download backup (.json)</button>
              <label class="btn" style="flex-direction:row;color:var(--text);font-size:14px">Import backup…<input type="file" accept="application/json,.json" id="import-file" hidden></label>
              <span class="spacer" style="flex:1"></span>
              <button class="btn ghost danger" data-action="start-fresh" title="Delete every number but keep your team, accountant and Google Drive set up">Start fresh</button>
              <button class="btn ghost danger" data-action="reset-all">Erase all data</button>
            </div>
          </div>
        </div>
      </div>
      <datalist id="method-list">${PAY_METHODS.map((m) => `<option value="${m}">`).join('')}</datalist>`;
  }

  // ---------- modals ----------
  function openModal(modal) { ui.modal = modal; renderModal(); }
  // ---------- in-page confirm / prompt (native pop-ups are blocked in some browsers, like Claude's) ----------
  function uiDialog({ message, input = false }) {
    return new Promise((resolve) => {
      let root = document.getElementById('dialog-root');
      if (!root) { root = document.createElement('div'); root.id = 'dialog-root'; document.body.appendChild(root); }
      const text = String(message ?? '');
      const cut = text.indexOf('\n\n');
      const title = cut > -1 ? text.slice(0, cut) : text;
      const rest = cut > -1 ? text.slice(cut + 2) : '';
      const danger = /delete|erase|remove|turn off|discard|replace everything|start fresh/i.test(title);
      root.innerHTML = `<div class="dlg-overlay"><div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
        <div class="dlg-title" id="dlg-title">${esc(title).replace(/\n/g, '<br>')}</div>
        ${rest ? `<div class="dlg-msg">${esc(rest).replace(/\n/g, '<br>')}</div>` : ''}
        ${input ? '<input class="dlg-input" autocomplete="off" spellcheck="false">' : ''}
        <div class="dlg-btns"><button type="button" class="btn" data-dlg="cancel">Cancel</button><button type="button" class="btn primary ${danger ? 'dlg-danger' : ''}" data-dlg="ok">${input ? 'OK' : danger ? 'Yes, continue' : 'OK'}</button></div>
      </div></div>`;
      const inp = root.querySelector('.dlg-input');
      const done = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(input ? null : false); }
        else if (e.key === 'Enter' && (input || document.activeElement?.dataset?.dlg !== 'cancel')) { e.preventDefault(); e.stopPropagation(); done(input ? inp.value : true); }
      };
      document.addEventListener('keydown', onKey, true);
      root.querySelector('[data-dlg="ok"]').addEventListener('click', (e) => { e.stopPropagation(); done(input ? inp.value : true); });
      root.querySelector('[data-dlg="cancel"]').addEventListener('click', (e) => { e.stopPropagation(); done(input ? null : false); });
      setTimeout(() => { const el = inp || root.querySelector('[data-dlg="ok"]'); if (el) el.focus(); }, 0);
    });
  }
  const uiConfirm = (message) => uiDialog({ message });
  const uiPrompt = (message) => uiDialog({ message, input: true });

  function closeModal() {
    ui.modal = null; ui.pendingFiles = [];
    $('#modal-root').innerHTML = '';
  }
  function renderModal() {
    const m = ui.modal;
    if (!m) return;
    const builders = { expenseForm: expenseFormHTML, projectForm: projectFormHTML, matchPicker: matchPickerHTML, payImport: payImportHTML, ruleForm: ruleFormHTML, importHistory: importHTML, evidenceForm: evidenceFormHTML, auditCell: auditCellHTML, emailPreview: emailPreviewHTML, checkForm: checkFormHTML, checkDetail: checkDetailHTML, billForm: billFormHTML, billHistory: billHistoryHTML };
    const html = builders[m.type](m);
    if (!html) { closeModal(); return; }
    $('#modal-root').innerHTML = `<div class="overlay" data-overlay>${html}</div>`;
    if (m.type === 'checkForm') updateSplitPreview($('form[data-form="check"]'));
    if (m.type === 'matchPicker' && m.focusSearch) { const i = $('#match-search'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } m.focusSearch = false; }
  }

  // Rows for the check form. New checks are filled from your rules (project splits first); edits keep what was saved.
  function formSplitRows(c) {
    const fromRules = !c.id && allRules().length ? splitsFromRules(c, '') : null;
    const rows = (c.splits || []).map((s) => ({ memberId: s.memberId, name: s.name, percent: s.percent, takenOut: splitState(s) === 'deducted' }));
    for (const m of state.settings.team) {
      if (rows.find((r) => r.memberId === m.id)) continue;
      const rr = fromRules?.find((s) => s.memberId === m.id);
      rows.push({ memberId: m.id, name: m.name, percent: fromRules ? (rr ? rr.percent : 0) : (c.id ? 0 : m.percent), takenOut: rr ? rr.resolution === 'deducted' : false });
    }
    return rows;
  }
  // Re-fill untouched split rows from the rules as the project / pay type / employer / date change.
  function refillSplitsFromRules(form) {
    if (!form || ui.modal?.id || !allRules().length) return;
    const probe = { gross: num(form.gross.value), net: form.net.value, receivedDate: form.receivedDate.value || today(), productionDate: '', payer: form.payer.value, employer: form.employer.value,
      project: form.project?.value || '', payType: form.querySelector('input[name="payType"]:checked')?.value || '', workType: form.querySelector('input[name="workType"]:checked')?.value || '' };
    const sp = splitsFromRules(probe, '');
    form.querySelectorAll('input[name="pct"]').forEach((inp) => {
      if (inp.dataset.touched) return;
      const s = sp.find((x) => x.memberId === inp.dataset.member);
      inp.value = s ? s.percent : 0;
      const box = form.querySelector(`input[name="takenout"][data-member="${CSS.escape(inp.dataset.member)}"]`);
      if (box && !box.dataset.touched) box.checked = !!(s && s.resolution === 'deducted');
    });
  }
  function checkFormHTML(m) {
    const c = m.id ? checkById(m.id) : { receivedDate: today(), payer: '', employer: '', workType: '', checkNumber: '', gross: '', net: '', notes: '', splitOn: state.settings.splitBase, splits: [], files: [] };
    if (!c) return null;
    const payors = uniq([...state.checks.map((x) => x.payer), ...PAYORS]);
    const employers = uniq([...state.checks.map((x) => employerOf(x)), ...EMPLOYERS]);
    const works = uniq([...WORK_TYPES, ...state.checks.map((x) => x.workType)]);
    const existingFiles = (c.files || []).length;
    return `<form class="modal-card wide" data-form="check" autocomplete="off">
      <header><h2>${m.id ? 'Edit check' : 'Scan SAG check'}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div>
          <div class="field-label">Check &amp; statement scan ${driveConfigured() && state.settings.autoUpload ? '<span class="muted">· saves to Google Drive</span>' : ''}</div>
          <div class="scan-row">
            <label class="btn primary scan-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>Scan with camera<input type="file" id="file-camera" accept="image/*" capture="environment" hidden></label>
            <label class="dropzone" id="dropzone">
              <input type="file" id="file-input" multiple accept="image/*,application/pdf" hidden>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l6 6v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm7 1.5V9h5.5zM11 12v3H8v2h3v3h2v-3h3v-2h-3v-3z"/></svg>Choose files<span class="dz-hint">or drag them here</span>
            </label>
          </div>
          <div id="scan-status" class="scan-status">${m.id ? '' : 'Snap the check and stub — the details below fill in automatically. You can still type or fix anything.'}</div>
          <div class="file-list" id="pending-files" style="margin-top:8px">${pendingFilesHTML()}</div>
          ${existingFiles ? `<div class="muted small" style="margin-top:6px">${existingFiles} file${existingFiles > 1 ? 's' : ''} already attached. New files are added to them.</div>` : ''}
        </div>
        <div>
          <div class="field-label">Type of work</div>
          <div class="choice-pills" role="radiogroup">
            ${works.map((w) => `<label class="choice"><input type="radio" name="workType" value="${esc(w)}" ${c.workType === w ? 'checked' : ''}><span>${esc(w)}</span></label>`).join('')}
          </div>
        </div>
        <div class="grid2">
          <label>Project<input name="project" list="project-list" value="${esc(c.project || '')}" placeholder="e.g. Big Animated Series"></label>
          <div><div class="field-label" style="margin-bottom:6px">Pay type</div><div class="seg">${[['Sessions', 'Session'], ['Residuals', 'Residual']].map(([v, l]) => `<label class="seg-radio"><input type="radio" name="payType" value="${v}" ${(c.payType || (isResidual(c) ? 'Residuals' : 'Sessions')) === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
          <label>Check number<input name="checkNumber" value="${esc(c.checkNumber)}" placeholder="Your answer"></label>
          <label><span>Deposit date <span class="req">*</span></span><input type="date" name="receivedDate" required value="${esc(c.receivedDate)}"></label>
          <label>Payor<input name="payer" list="payor-list" value="${esc(c.payer)}" placeholder="Pick or type a payor"></label>
          <label>Employer<input name="employer" list="employer-list" value="${esc(employerOf(c))}" placeholder="Pick or type an employer"></label>
          <label><span>Gross amount <span class="req">*</span></span><input name="gross" type="number" step="0.01" min="0" inputmode="decimal" required value="${esc(c.gross)}" placeholder="0.00"></label>
          <label>Net amount<input name="net" type="number" step="0.01" min="0" inputmode="decimal" value="${esc(c.net)}" placeholder="0.00"></label>
        </div>
        <datalist id="project-list">${uniq([...(state.projects || []).map((p) => p.title), ...state.checks.slice(-400).map((x) => x.project)]).filter(Boolean).map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        <datalist id="payor-list">${payors.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        <datalist id="employer-list">${employers.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        <fieldset>
          <legend>Team split</legend>
          <div class="row" style="justify-content:space-between;margin-bottom:4px">
            <span class="muted small">${allRules().length && !m.id ? 'Filled from your fee splits (Projects and commission rules). ' : ''}Set someone to 0% to leave them off. Always calculated on the gross amount.</span>
            <input type="hidden" name="splitOn" value="gross">
          </div>
          <table class="split-edit"><tbody>
            ${formSplitRows(c).map((r) => `<tr>
              <td style="width:40%"><strong>${esc(r.name)}</strong></td>
              <td><div class="row" style="flex-wrap:nowrap"><input type="number" step="0.01" min="0" max="100" name="pct" data-member="${esc(r.memberId)}" data-name="${esc(r.name)}" value="${esc(r.percent)}"> %</div></td>
              <td><label class="inline small" title="Their cut was already taken out of this check before it reached you"><input type="checkbox" name="takenout" data-member="${esc(r.memberId)}" ${r.takenOut ? 'checked' : ''}> Taken out first</label></td>
              <td class="right num" data-split-amt="${esc(r.memberId)}" style="font-weight:600">$0.00</td>
            </tr>`).join('')}
          </tbody></table>
          <div class="split-summary" id="split-summary"></div>
        </fieldset>
        <label>Notes<textarea name="notes" rows="2" placeholder="Optional">${esc(c.notes)}</textarea></label>
      </div>
      <footer>
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">${m.id ? 'Save changes' : 'Save check'}</button>
      </footer>
    </form>`;
  }
  // ---------- Scan SAG check: read the photo on this device and fill in the form ----------
  // Uses Tesseract.js (open-source OCR) loaded from a public CDN. The image never leaves the device.
  const OCR_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
  let ocrLib = null, ocrWorker = null;
  function loadOCR() {
    if (ocrLib) return ocrLib;
    ocrLib = new Promise((res, rej) => {
      if (window.Tesseract) return res(window.Tesseract);
      const s = document.createElement('script'); s.src = OCR_SRC; s.async = true;
      s.onload = () => (window.Tesseract ? res(window.Tesseract) : rej(new Error('Text reader didn’t load')));
      s.onerror = () => { ocrLib = null; rej(new Error('Couldn’t load the text reader — check your internet connection.')); };
      document.head.appendChild(s);
    });
    return ocrLib;
  }
  async function imageForOCR(file) {
    // Downscale big phone photos and convert to grayscale with a little extra contrast: faster and more accurate.
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Couldn’t open that image')); i.src = url; });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
      return c; // resize only — extra contrast made the reader confuse digits (9 → 0)
    } finally { URL.revokeObjectURL(url); }
  }
  const MONEY_RE = /\$?\s*\*{0,}\s*(\d{1,3}(?:[,.\s]\d{3})*[.,]\d{2})\b/g;
  const toNum = (s) => { const t = String(s).replace(/\s/g, ''); const m = t.match(/^(.*)[.,](\d{2})$/); return m ? Number(m[1].replace(/[^\d]/g, '') + '.' + m[2]) : NaN; };
  function amountNear(lines, labelRe) {
    for (let i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      const after = lines[i].slice(lines[i].search(labelRe));
      const here = [...after.matchAll(MONEY_RE)].map((m) => toNum(m[1])).filter((n) => n > 0);
      if (here.length) return here[0];
      const next = [...(lines[i + 1] || '').matchAll(MONEY_RE)].map((m) => toNum(m[1])).filter((n) => n > 0);
      if (next.length) return next[0];
    }
    return null;
  }
  function parseISOish(s) {
    const m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; const mo = +m[1], d = +m[2]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 2000 && y < 2100) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
    const n = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
    if (n) { const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(n[1].slice(0, 3).toLowerCase()) + 1; return `${n[3]}-${String(mo).padStart(2, '0')}-${String(+n[2]).padStart(2, '0')}`; }
    return null;
  }
  function parseCheckText(text) {
    // Rejoin amounts the reader split apart after a "$" or check-protector stars, e.g. "$**9 80.12" → "$**980.12"
    text = String(text).replace(/(\$[\s*]*)(\d[\d,]*)\s+(\d[\d,]*[.,]\d{2})\b/g, '$1$2$3');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const flat = lines.join(' \n ');
    const lower = flat.toLowerCase();
    const out = {};
    // amounts
    const gross = amountNear(lines, /\b(gross|total\s+gross|gross\s+(pay|earnings|wages)|earnings)\b/i);
    const net = amountNear(lines, /\b(net\s*(pay|amount|check)?|pay\s+exactly|check\s+amount|amount\s+paid|this\s+amount)\b/i);
    const all = [...flat.matchAll(MONEY_RE)].map((m) => toNum(m[1])).filter((n) => n > 0 && n < 1e6);
    if (gross) out.gross = gross;
    if (net) out.net = net;
    if (out.gross && out.net && out.net > out.gross) [out.gross, out.net] = [out.net, out.gross]; // net can't be more than gross
    if (!out.gross && all.length) out.gross = Math.max(...all);
    if (!out.net && all.length > 1) { const cand = all.filter((n) => n < out.gross); if (cand.length) out.net = Math.max(...cand); }
    // check number
    const ck = flat.match(/\b(?:check|chk|cheque)\s*(?:no\.?|number|num|#)?\s*[:#]?\s*(\d{4,12})\b/i) || flat.match(/\bNo\.?\s*(\d{5,12})\b/);
    if (ck) out.checkNumber = ck[1];
    // check date (goes into notes; the deposit date stays the day you deposit it)
    const dl = lines.find((l) => /\b(check\s*date|date|pay\s*date|period\s*end)/i.test(l) && parseISOish(l));
    const dt = dl ? parseISOish(dl) : parseISOish(flat);
    if (dt) out.checkDate = dt;
    // pay type
    out.payType = /\bresid/i.test(flat) ? 'Residuals' : /\bsession|\bsession fee|\bscale\b|\bwages\b/i.test(flat) ? 'Sessions' : '';
    // payor / employer: match against names you've seen before
    const known = (list) => list.filter(Boolean).sort((a, b) => b.length - a.length);
    const findName = (list) => known(list).find((n) => { const k = n.toLowerCase().replace(/[.,()]/g, '').replace(/\b(inc|llc|corp|the)\b/g, '').replace(/\s+/g, ' ').trim(); return k.length > 3 && lower.replace(/[.,()]/g, '').includes(k); });
    out.payer = findName([...state.checks.slice(-500).map((x) => x.payer), ...PAYORS]) || (/(entertainment partners)/i.test(flat) ? 'Entertainment Partners' : /(cast\s*&?\s*crew)/i.test(flat) ? 'Cast & Crew Payroll' : '');
    out.employer = findName([...state.checks.slice(-500).map((x) => employerOf(x)), ...EMPLOYERS].filter((n) => n && n !== out.payer)) || (lines.find((l) => /\b(productions?|studios?|pictures|animation|films?)\b.*\b(inc|llc|corp)\b/i.test(l) && !(out.payer && l.toLowerCase().includes(out.payer.toLowerCase().slice(0, 8)))) || '').replace(/[^\w&.,'’ -]/g, '').trim();
    // project / production title
    const pl = flat.match(/\b(?:production|project|title|show|series|program)\s*(?:title|name)?\s*[:\-]\s*([^\n]{3,60})/i);
    const projects = known([...(state.projects || []).map((p) => p.title), ...state.checks.slice(-500).map((x) => x.project)]);
    out.project = (pl && pl[1].replace(/\s{2,}.*$/, '').trim()) || projects.find((p) => p.length > 3 && lower.includes(p.toLowerCase())) || '';
    return out;
  }
  function fillCheckForm(form, data) {
    const filled = [];
    const set = (name, val, label) => {
      const el = form.elements[name]; if (!el || val == null || val === '') return;
      if (el.value && !el.dataset.autofilled) return; // never overwrite what you typed
      el.value = val; el.dataset.autofilled = '1'; el.classList.add('autofilled'); filled.push(label);
    };
    set('gross', data.gross ? data.gross.toFixed(2) : '', 'gross');
    set('net', data.net ? data.net.toFixed(2) : '', 'net');
    set('checkNumber', data.checkNumber, 'check #');
    set('payer', data.payer, 'payor');
    set('employer', data.employer, 'employer');
    set('project', data.project, 'project');
    if (data.payType) { const r = form.querySelector(`input[name="payType"][value="${data.payType}"]`); if (r && !r.checked) { r.checked = true; filled.push('pay type'); } }
    if (data.checkDate && !/Check date:/.test(form.notes.value)) { form.notes.value = (form.notes.value ? form.notes.value + '\n' : '') + `Check date: ${fmtDate(data.checkDate)}`; filled.push('check date (in notes)'); }
    updateSplitPreview(form);
    return filled;
  }
  async function scanCheckImage(file) {
    const form = document.querySelector('form[data-form="check"]');
    const box = document.getElementById('scan-status');
    if (!form || !box || !file || !/^image\//.test(file.type || '')) return;
    const say = (html, cls = '') => { box.className = `scan-status ${cls}`; box.innerHTML = html; };
    say('<span class="scan-spin"></span> Getting the text reader ready…');
    try {
      const T = await loadOCR();
      const canvas = await imageForOCR(file);
      if (!ocrWorker) ocrWorker = await T.createWorker('eng', 1, { logger: (m) => { if (m.status === 'recognizing text' && document.getElementById('scan-status')) say(`<span class="scan-spin"></span> Reading the check… ${Math.round((m.progress || 0) * 100)}%`); } });
      say('<span class="scan-spin"></span> Reading the check…');
      const { data } = await ocrWorker.recognize(canvas);
      if (!document.body.contains(form)) return;
      window.__ahqLastScanText = data.text || ''; // kept only in this page, for troubleshooting
      const parsed = parseCheckText(data.text || '');
      const filled = fillCheckForm(form, parsed);
      if (filled.length) say(`<b>Filled ${filled.length} detail${filled.length === 1 ? '' : 's'} from the scan:</b> ${filled.join(', ')}. Highlighted fields came from the photo — please check them against the check.`, 'ok');
      else say('Couldn’t read the details clearly. Try a straight-on photo in good light, or type them in.', 'warn');
    } catch (e) { if (document.getElementById('scan-status')) say(esc(e.message || 'Couldn’t read that image.'), 'warn'); }
  }

  // ---------- confetti: a little celebration when a new check is saved ----------
  function celebrate() {
    try {
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const cv = document.createElement('canvas');
      cv.className = 'confetti-canvas'; cv.setAttribute('aria-hidden', 'true');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = window.innerWidth, H = window.innerHeight;
      cv.width = W * dpr; cv.height = H * dpr; document.body.appendChild(cv);
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      const colors = ['#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2', '#ffffff'];
      const N = Math.min(220, Math.round(W / 4) + 80);
      const parts = Array.from({ length: N }, (_, i) => {
        const fromLeft = i % 2 === 0; // two cannons from the bottom corners, plus a gentle shower
        const shower = i % 5 === 0;
        const a = shower ? Math.PI / 2 : (fromLeft ? -Math.PI / 3 : -Math.PI * 2 / 3) + (Math.random() - 0.5) * 0.6;
        const v = shower ? 1 + Math.random() * 2 : 9 + Math.random() * 9;
        return {
          x: shower ? Math.random() * W : (fromLeft ? -10 : W + 10), y: shower ? -20 - Math.random() * H * 0.3 : H * 0.85,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 6 + Math.random() * 7, h: 8 + Math.random() * 10,
          r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35, c: colors[(Math.random() * colors.length) | 0],
          shape: Math.random() < 0.18 ? 'circle' : Math.random() < 0.5 ? 'strip' : 'rect', tilt: Math.random() * 10, life: 0,
        };
      });
      const start = performance.now(); const DUR = 3200;
      (function frame(t) {
        const el = t - start; g.clearRect(0, 0, W, H);
        for (const p of parts) {
          p.life++; p.vy += 0.28; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.tilt += 0.12;
          const fade = el > DUR - 700 ? Math.max(0, (DUR - el) / 700) : 1;
          g.save(); g.globalAlpha = fade; g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c;
          const sx = Math.cos(p.tilt); // flutter
          if (p.shape === 'circle') { g.beginPath(); g.arc(0, 0, p.w / 2.4, 0, Math.PI * 2); g.fill(); }
          else if (p.shape === 'strip') g.fillRect(-p.w / 4, -p.h / 2, (p.w / 2) * sx, p.h);
          else g.fillRect(-p.w / 2, -p.h / 3, p.w * sx, p.h * 0.66);
          g.restore();
        }
        if (el < DUR) requestAnimationFrame(frame); else cv.remove();
      })(start);
    } catch (e) { /* never block saving */ }
  }

  function pendingFilesHTML() {
    return ui.pendingFiles.map((f, i) => `<div class="file-item"><span class="grow">📄 ${esc(f.name)}</span><span class="muted small">${fmtSize(f.size)}</span><button type="button" class="icon-btn plain" data-action="remove-pending" data-index="${i}">×</button></div>`).join('');
  }
  function updateSplitPreview(form) {
    if (!form) return;
    refillSplitsFromRules(form);
    const gross = num(form.gross.value), net = num(form.net.value);
    const base = gross;
    let owe = 0, taken = 0;
    form.querySelectorAll('input[name="pct"]').forEach((inp) => {
      const amt = round2((base * num(inp.value)) / 100);
      const out = form.querySelector(`input[name="takenout"][data-member="${CSS.escape(inp.dataset.member)}"]`)?.checked;
      if (out) taken += amt; else owe += amt;
      const cell = form.querySelector(`[data-split-amt="${CSS.escape(inp.dataset.member)}"]`);
      if (cell) cell.textContent = money(amt);
    });
    $('#split-summary').innerHTML = `<span>You owe the team <span class="num">${money(owe)}</span></span>${taken ? `<span class="muted">Already taken out: <span class="num">${money(taken)}</span></span>` : ''}<span>You keep <span class="num">${money(round2((net || gross) - owe))}</span> <span class="muted small">of ${net ? 'the check' : 'gross'}</span></span>`;
  }

  async function submitCheckForm(form) {
    const isEdit = !!ui.modal.id;
    const f = form.elements;
    const gross = round2(num(f.gross.value));
    const net = f.net.value === '' ? '' : round2(num(f.net.value));
    const splitOn = 'gross';
    const base = gross;
    const old = isEdit ? checkById(ui.modal.id) : null;
    const splits = [];
    form.querySelectorAll('input[name="pct"]').forEach((inp) => {
      const pct = num(inp.value);
      if (pct <= 0) return;
      const prev = old?.splits.find((s) => s.memberId === inp.dataset.member);
      const takenOut = !!form.querySelector(`input[name="takenout"][data-member="${CSS.escape(inp.dataset.member)}"]`)?.checked;
      splits.push({
        resolution: takenOut ? 'deducted' : (prev && prev.resolution !== 'deducted' ? prev.resolution : ''),
        memberId: inp.dataset.member,
        name: prev?.name || memberById(inp.dataset.member)?.name || inp.dataset.name,
        percent: pct,
        amount: round2((base * pct) / 100),
        paid: prev?.paid || false,
        paidDate: prev?.paidDate || null,
        method: prev?.method || '',
        receiptNo: prev?.receiptNo || null,
        receiptSentAt: prev?.receiptSentAt || null,
        accountantNotifiedAt: prev?.accountantNotifiedAt || null,
      });
    });
    const data = {
      receivedDate: f.receivedDate.value || today(),
      checkNumber: f.checkNumber.value.trim(),
      payer: f.payer.value.trim(),
      employer: f.employer.value.trim(),
      workType: form.querySelector('input[name="workType"]:checked')?.value || '',
      project: f.project.value.trim(),
      payType: form.querySelector('input[name="payType"]:checked')?.value || '',
      gross, net, splitOn, splits,
      notes: f.notes.value.trim(),
    };
    let check;
    if (isEdit) {
      check = Object.assign(old, data);
    } else {
      check = { id: uid(), createdAt: new Date().toISOString(), files: [], ...data };
      state.checks.push(check);
    }
    const newFiles = ui.pendingFiles.splice(0);
    for (const file of newFiles) {
      const id = uid();
      try {
        await idb.put(id, file);
        check.files.push({ id, name: file.name, size: file.size, type: file.type, status: 'local', addedAt: new Date().toISOString() });
      } catch (e) { toast(`Couldn’t store ${file.name}: ${e.message}`, { error: true }); }
    }
    save();
    closeModal();
    render();
    toast(isEdit ? 'Check updated' : `Check saved — ${splits.length ? money(sum(splits, (s) => s.amount)) + ' to pay out' : 'no team split'}`);
    if (!isEdit) celebrate();
    if (newFiles.length && driveConfigured() && state.settings.autoUpload) uploadPending(check);
    ledgerSync([{ check }, ...(isEdit ? check.splits.filter((x) => x.paid).map((split) => ({ check, split })) : [])], 1500);
    if (!isEdit && state.settings.emailAccountantChecks && state.settings.accountantEmail
      && enqueue({ type: 'checkEmail', key: `ce:${check.id}`, checkId: check.id, sendAfter: Date.now() + 4000 })) save();
  }

  function checkDetailHTML(m) {
    const c = checkById(m.id);
    if (!c) return null;
    const st = checkStatus(c);
    return `<div class="modal-card wide">
      <header><div><h2>${checkLabel(c)}</h2><div style="margin-top:4px">${statusPill(st)}</div></div>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="detail-grid">
          <div><div class="k">Deposited</div><div class="v">${fmtDate(c.receivedDate)}</div></div>
          <div><div class="k">Check #</div><div class="v">${esc(c.checkNumber || '—')}</div></div>
          <div><div class="k">Type of work</div><div class="v">${esc(c.workType || '—')}</div></div>
          <div><div class="k">Gross</div><div class="v num">${money(c.gross)}</div></div>
          <div><div class="k">Net</div><div class="v num">${c.net ? money(c.net) : '—'}</div></div>
          <div><div class="k">You keep</div><div class="v num">${money(takeHome(c))}</div></div>
        </div>
        ${c.notes ? `<div class="callout" style="background:var(--surface-2)">${esc(c.notes)}</div>` : ''}
        <fieldset>
          <legend>Team payouts <span class="muted small" style="font-weight:500">· split on ${c.splitOn === 'net' && c.net ? 'net' : 'gross'}</span></legend>
          ${c.splits.length ? c.splits.map((s, i) => `
            <div class="split-row">
              <div class="row" style="flex-wrap:nowrap">${avatar({ id: s.memberId, name: s.name, former: !memberById(s.memberId) })}<div><strong>${esc(s.name)}</strong><div class="muted small">${num(s.percent)}%</div></div></div>
              <div class="num" style="font-weight:700">${money(s.amount)}</div>
              <div>${c.historical || ['research', 'deducted', 'notOwed'].includes(splitState(s)) ? resolutionSelect(c, s) : s.paid
                ? `<button class="chip paid" data-action="toggle-split" data-check="${c.id}" data-member="${esc(s.memberId)}" title="Click to mark unpaid"><span class="box">✓</span>Paid</button>`
                : `<button class="btn sm primary" data-action="toggle-split" data-check="${c.id}" data-member="${esc(s.memberId)}">Mark paid</button>`}</div>
              <div class="paid-fields">${s.paid ? `
                <input type="date" value="${esc(s.paidDate || '')}" data-split-field="paidDate" data-check="${c.id}" data-member="${esc(s.memberId)}" aria-label="Date paid">
                <input list="method-list" value="${esc(s.method || '')}" placeholder="Method" data-split-field="method" data-check="${c.id}" data-member="${esc(s.memberId)}" aria-label="Payment method">`
                : `<span class="muted small">${splitState(s) === 'owe' ? 'Not paid yet' : RES_LABELS[splitState(s)]}</span>`}</div>
              ${c.historical ? (c.legacy?.byMember?.[s.memberId] != null && Math.abs(c.legacy.byMember[s.memberId] - s.amount) > 0.99 ? `<div class="receipt-line" style="color:var(--peach-ink)">Old tracker said ${money(c.legacy.byMember[s.memberId])}. Your rules say ${money(s.amount)}.</div>` : '') : receiptLine(c, s)}
            </div>`).join('') : '<div class="muted">No team split on this check.</div>'}
        </fieldset>
        <fieldset>
          <legend>Check &amp; statement scans</legend>
          <div class="file-list">
            ${(c.files || []).map((f) => `<div class="file-item">
              <span class="grow">📄 ${esc(f.name)}</span>
              ${f.status === 'uploaded' ? `<span class="pill green">In Drive</span><a class="btn sm" href="${esc(f.driveUrl)}" target="_blank" rel="noopener">Open</a>`
                : f.status === 'uploading' ? '<span class="pill blue">Uploading…</span>'
                : `<span class="pill ${f.status === 'error' ? 'red' : 'amber'}" title="${esc(f.error || '')}">${f.status === 'error' ? 'Upload failed' : 'Only on this computer'}</span>
                   <button class="btn sm" data-action="view-local" data-check="${c.id}" data-file="${f.id}">View</button>
                   <button class="btn sm primary" data-action="upload-file" data-check="${c.id}" data-file="${f.id}" ${driveConfigured() ? '' : 'disabled title="Set up Google Drive in Settings first"'}>Save to Drive</button>`}
              <button class="icon-btn plain" title="Remove from app" data-action="remove-file" data-check="${c.id}" data-file="${f.id}">×</button>
            </div>`).join('') || '<div class="muted small">No scan attached.</div>'}
          </div>
          <label class="btn sm" style="flex-direction:row;color:var(--text);margin-top:8px;width:max-content">+ Attach file<input type="file" multiple accept="image/*,application/pdf" data-attach="${c.id}" hidden></label>
        </fieldset>
      </div>
      <footer>
        <button class="btn ghost danger" data-action="delete-check" data-id="${c.id}">Delete</button>
        <span class="spacer"></span>
        <button class="btn" data-action="edit-check" data-id="${c.id}">Edit</button>
        <button class="btn primary" data-action="close-modal">Done</button>
      </footer>
      <datalist id="method-list">${PAY_METHODS.map((x) => `<option value="${x}">`).join('')}</datalist>
    </div>`;
  }

  function billFormHTML(m) {
    const b = m.id ? billById(m.id) : { name: '', kind: m.kind || 'bill', amount: '', frequency: 'monthly', nextDue: today(), category: '', autopay: false, url: '', notes: '', active: true, acting: !!m.acting };
    if (!b) return null;
    const cats = [...new Set(['Union dues', 'Casting sites', 'Headshots & reels', 'Classes & coaching', 'Agent / manager', 'Home studio & gear', 'Housing', 'Utilities', 'Phone & Internet', 'Insurance', 'Car', 'Credit card', 'Loan', 'Streaming', 'Software', 'Health & Fitness', ...state.bills.map((x) => x.category).filter(Boolean)])];
    return `<form class="modal-card" data-form="bill" autocomplete="off">
      <header><h2>${m.id ? 'Edit' : 'Add'} ${b.kind === 'subscription' ? 'subscription' : 'bill'}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="seg" style="align-self:flex-start">
          <button type="button" class="${b.kind !== 'subscription' ? 'on' : ''}" data-action="bill-kind" data-value="bill">Bill</button>
          <button type="button" class="${b.kind === 'subscription' ? 'on' : ''}" data-action="bill-kind" data-value="subscription">Subscription</button>
        </div>
        <input type="hidden" name="kind" value="${esc(b.kind)}">
        <label>Name<input name="name" required value="${esc(b.name)}" placeholder="${b.kind === 'subscription' ? 'e.g. Actors Access, Backstage' : 'e.g. SAG-AFTRA dues, Rent, Car insurance'}"></label>
        <div class="grid2">
          <label>Amount<input name="amount" type="number" step="0.01" min="0" inputmode="decimal" required value="${esc(b.amount)}" placeholder="0.00"></label>
          <label>How often<select name="frequency">${Object.entries(FREQS).map(([k, l]) => `<option value="${k}" ${b.frequency === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Next due date<input name="nextDue" type="date" value="${esc(b.nextDue || '')}"></label>
          <label>Category<input name="category" list="cat-list" value="${esc(b.category)}" placeholder="Optional"></label>
        </div>
        <datalist id="cat-list">${cats.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        <label>Website to pay (optional)<input name="url" type="url" value="${esc(b.url)}" placeholder="https://"></label>
        <label>Notes<textarea name="notes" rows="2">${esc(b.notes)}</textarea></label>
        <label class="inline"><input type="checkbox" name="acting" ${b.acting ? 'checked' : ''}> Acting-related (union dues, casting sites, classes, reels…) — shows on the Calendar</label>
        <label class="inline"><input type="checkbox" name="autopay" ${b.autopay ? 'checked' : ''}> On autopay</label>
        <label class="inline"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> Active (uncheck if you cancelled it)</label>
      </div>
      <footer>
        ${m.id ? `<button type="button" class="btn ghost danger" data-action="delete-bill" data-id="${b.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </footer>
    </form>`;
  }
  function submitBillForm(form) {
    const f = form.elements;
    const data = {
      name: f.name.value.trim(),
      kind: f.kind.value,
      amount: round2(num(f.amount.value)),
      frequency: f.frequency.value,
      nextDue: f.nextDue.value || null,
      category: f.category.value.trim(),
      url: f.url.value.trim(),
      notes: f.notes.value.trim(),
      autopay: f.autopay.checked,
      active: f.active.checked,
      acting: f.acting.checked,
    };
    data.anchorDay = data.nextDue ? parseISO(data.nextDue).getDate() : null;
    if (ui.modal.id) Object.assign(billById(ui.modal.id), data);
    else state.bills.push({ id: uid(), createdAt: new Date().toISOString(), payments: [], ...data });
    save(); closeModal(); render();
    toast(`${data.name} saved`);
  }
  function billHistoryHTML(m) {
    const b = billById(m.id);
    if (!b) return null;
    return `<div class="modal-card">
      <header><h2>${esc(b.name)} — payments</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="muted">Total paid: <strong class="num">${money(sum(b.payments || [], (p) => p.amount))}</strong></div>
        <div class="list">${(b.payments || []).map((p, i) => `
          <div class="list-item"><div class="grow"><div class="title">${fmtDate(p.date)}</div><div class="sub">${p.dueDate ? 'For due date ' + fmtDate(p.dueDate) : ''}</div></div>
            <div class="num">${money(p.amount)}</div>
            ${i === 0 ? `<button class="btn sm ghost" data-action="undo-bill-payment" data-id="${b.id}" data-payment="${p.id}">Undo</button>` : ''}
          </div>`).join('') || '<div class="empty">No payments yet.</div>'}</div>
      </div>
      <footer><button class="btn primary" data-action="close-modal">Close</button></footer>
    </div>`;
  }

  // ---------- actions ----------
  function addFilesToCheck(check, fileList) {
    const files = [...fileList];
    (async () => {
      for (const file of files) {
        const id = uid();
        await idb.put(id, file);
        check.files.push({ id, name: file.name, size: file.size, type: file.type, status: 'local', addedAt: new Date().toISOString() });
      }
      save(); render();
      if (driveConfigured() && state.settings.autoUpload) uploadPending(check);
    })().catch((e) => toast(e.message, { error: true }));
  }

  const actions = {
    'close-modal': () => closeModal(),
    // ----- payout audit -----
    'add-rule': (d) => openModal({ type: 'ruleForm', memberId: d.member }),
    'edit-rule': (d) => openModal({ type: 'ruleForm', id: d.id }),
    'delete-rule': async (d) => {
      if (!await uiConfirm('Delete this rule? Commissions that still need research will be recalculated without it.')) return;
      state.rules = state.rules.filter((r) => r.id !== d.id);
      state.audit.rulesConfirmed = false;
      save(); closeModal(); render();
      toast('Rule deleted');
      offerRecalc();
    },
    'reapply-rules': () => offerRecalc(true),
    'confirm-rules': async () => {
      if (!await uiConfirm('Do these rules match the actual agreements (rate, gross vs. net, dates, and which work)? Every “owed” amount comes from them.')) return;
      state.audit.rulesConfirmed = true;
      state.rules.filter((r) => !r.to && !r.workTypes?.length && !r.employers).forEach((r) => { const m = memberById(r.memberId); if (m) m.percent = num(r.percent); });
      save(); render();
    },
    'five-filter': (d) => { ui.fiveFilter = d.filter; render(); },
    'cell-five-only': () => { ui.cellFiveOnly = !ui.cellFiveOnly; renderModal(); },
    'review-mismatch': () => { state.audit.mismatchReviewed = true; save(); render(); },
    'do-import': () => doImport(),
    'undo-import': async (d) => {
      const im = state.imports.find((x) => x.id === d.id);
      const checks = state.checks.filter((c) => c.importBatch === d.id);
      const touched = checks.filter((c) => c.splits.some((s) => splitState(s) !== 'research')).length;
      if (!await uiConfirm(`Remove the ${checks.length} checks imported from “${im?.fileName}”?${touched ? `\n\n${touched} of them have commissions you already updated, and that work will be lost too.` : ''}`)) return;
      state.checks = state.checks.filter((c) => c.importBatch !== d.id);
      state.imports = state.imports.filter((x) => x.id !== d.id);
      save(); render();
      toast('Import removed');
    },
    'open-cell': (d) => openModal({ type: 'auditCell', memberId: d.member, year: d.year, live: true }),
    'add-evidence': (d) => openModal({ type: 'evidenceForm', memberId: d.member }),
    'add-evidence-inline': (d) => {
      const date = $('#ev-date').value, amount = round2(num($('#ev-amount').value));
      if (!date || !amount) return toast('Enter the date and amount you found.', { error: true });
      addEvidence({ memberId: d.member, date, amount, method: $('#ev-method').value.trim(), reference: $('#ev-ref').value.trim(), notes: '' }, false);
      render();
    },
    'claims-to-claimed': (d) => { const cl = state.claims?.[d.member]; if (!cl) return; state.audit.claimed = state.audit.claimed || {}; state.audit.claimed[d.member] = claimTotal(cl); save(); render(); },
    'remove-claims': async (d) => { if (!await uiConfirm('Remove their records from the app? Your own records are not affected.')) return; delete state.claims[d.member]; save(); render(); },
    'toggle-acting': (d) => { const b = billById(d.id); if (!b) return; b.acting = !b.acting; save(); render(); toast(b.acting ? `${b.name} is acting-related — it shows on the Calendar` : `${b.name} is personal — it's off the Calendar`); },
    'share-publish': async (d) => {
      const id = sharedPageId(d.kind); const first = !sharedCfg()[id]?.url;
      if (first) {
        const who = d.kind === 'accountant' ? 'your accountant' : (stmtData().member?.name || 'this person');
        const what = d.kind === 'accountant' ? 'acting income by year, commissions paid per person, residual commission by quarter, acting expenses and the SAG-AFTRA dues owed (no commission review, no personal bills)' : `only your payments to ${who}${ui.stmt.jobs ? ', plus the jobs each payment is proven to cover' : ''} (no balances, 5% flags, notes or other people)`;
        if (!await uiConfirm(`Create a private link for ${who}?\n\nIt will show ${what}.\n\nAnyone who has the link can open it, so share it only with ${who}.${d.kind !== 'accountant' ? '\n\nTip: since the commission question is with your lawyer, consider having them look at this page before you send the link.' : ''}`)) return;
      }
      try { await publishShared(d.kind); } catch (e) { toast(/Unknown action/.test(e.message) ? 'Update your Drive helper first: paste the new Code.gs into Apps Script and deploy a new version.' : e.message, { error: true }); }
    },
    'share-newkey': async (d) => { if (!await uiConfirm('Make a new link? The current link will stop working, and you’ll need to send the new one.')) return; try { await publishShared(d.kind, { newKey: true }); } catch (e) { toast(e.message, { error: true }); } },
    'share-off': async (d) => {
      if (!await uiConfirm('Turn off this link? Anyone who has it will see “This link isn’t active.”')) return;
      const id = sharedPageId(d.kind);
      try { await driveCall('unpublish', { page: id }); delete sharedCfg()[id]; save(); render(); toast('Link turned off'); } catch (e) { toast(e.message, { error: true }); }
    },
    'phone-publish': async () => {
      try {
        const [idx, js] = await Promise.all([fetch('index.html', { cache: 'no-store' }).then((r) => r.text()), fetch('app.js', { cache: 'no-store' }).then((r) => r.text())]);
        const localCfg = await fetch('local-config.js', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        if (!/id="main"/.test(idx) || js.length < 1000 || !/href="styles\.css/.test(idx) || !/src="app\.js/.test(idx)) throw new Error('Couldn’t read the app files.');
        const html = idx
          .replace(/<script src="local-config\.js"><\/script>[^\n]*/, "")
          .replace(/<link rel="stylesheet" href="styles\.css(\?[^"]*)?">/, () => `<style>${pageCSS()}</style>`)
          .replace(/<script src="app\.js(\?[^"]*)?"><\/script>/, () => `<script>window.AHQ_HELPER_URL = ${JSON.stringify(state.settings.driveUrl.trim())};</script><script src="__AHQ_JS_SRC__"></script>`);
        // The app code goes up as its own file; the helper serves it at ?asset=js (keeps the page under Google's size limit).
        const r = await driveCall('publish', { page: 'app', html, js: (localCfg ? localCfg + '\n' : '') + js });
        state.settings.shared = state.settings.shared || {};
        state.settings.shared.app = { kind: 'app', url: r.url, at: new Date().toISOString() };
        save(); render(); toast('Phone app is ready — copy the link to your phone');
      } catch (e) { toast(/Unknown action/.test(e.message) ? 'Update your Drive helper first: paste the new Code.gs and deploy a new version.' : `Couldn’t build the phone app: ${e.message}`, { error: true }); }
    },
    'home-copy': async () => {
      // The Drive helper address rides after the # so it never reaches GitHub's servers; the password is never in the link.
      const u = `${state.settings.homeUrl.replace(/#.*$/, '')}#connect=${encodeURIComponent(state.settings.driveUrl.trim())}`;
      try { await navigator.clipboard.writeText(u); toast('Setup link copied — send it to your phone'); } catch (e) { await uiDialog({ message: `Copy this link and send it to your phone:\n\n${u}` }); }
    },
    'phone-copy': async () => { const u = state.settings.shared?.app?.url; if (!u) return; try { await navigator.clipboard.writeText(u); toast('Link copied — send it to your phone'); } catch (e) { toast('Select the link and press ⌘C to copy it'); } },
    'phone-sync': () => syncFromDrive(true),
    'phone-off': async () => {
      if (!await uiConfirm('Turn off the phone link?\n\nThe phone app will stop opening until you create a new link. Your data stays safe here and in Drive.')) return;
      try { await driveCall('unpublish', { page: 'app' }); delete state.settings.shared.app; save(); render(); toast('Phone link turned off'); } catch (e) { toast(e.message, { error: true }); }
    },
    'share-copy': async (d) => { const c = sharedCfg()[sharedPageId(d.kind)]; if (!c?.url) return; try { await navigator.clipboard.writeText(c.url); toast('Link copied'); } catch (e) { toast('Select the link and press ⌘C to copy it'); } },
    'toggle-chapters': (d, el) => {
      // Toggle in place (no re-render) so the open/close animation plays smoothly.
      ui.chaptersOpen = !ui.chaptersOpen;
      const wrap = el.closest('.chapterwrap'); if (!wrap) return;
      wrap.classList.toggle('open', ui.chaptersOpen);
      el.setAttribute('aria-expanded', String(ui.chaptersOpen));
      el.querySelector('.ct-label').textContent = ui.chaptersOpen ? 'Less' : 'More';
      el.querySelector('.ct-dot')?.remove();
    },
    'toggle-theme': () => applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'),
    'set-theme': (d) => { applyTheme(d.value); render(); },
    'toggle-menu': () => { const d = $('#globalnav'); const open = !d.classList.contains('menu-open'); d.classList.toggle('menu-open', open); document.body.classList.toggle('menu-locked', open); d.querySelector('.nav-toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false'); },
    'report-tab': (d) => { ui.reportTab = d.value; render(); },
    'tq-scope': (d) => { ui.tqScope = d.value; render(); },
    'tq-person': (d) => { ui.qMember = d.id; ui.qYear = ui.tqYear || ui.qYear; render(); setTimeout(() => document.querySelectorAll('.statement')[1]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); },
    'open-reports': (d) => { ui.reportTab = d.tab || 'statement'; go('reports'); },
    'print-report': () => window.print(),
    'stmt-csv': () => stmtCSV(),
    'acct-csv': () => acctCSV(),
    'cal-mode': (d) => { state.settings.calMode = d.value; save(); render(); },
    'cal-filter': (d) => { ui.calShow[d.kind] = !ui.calShow[d.kind]; render(); },
    'cal-day': (d) => { ui.calDay = d.day; render(); },
    'cal-month': (d) => {
      const step = Number(d.step);
      if (!step) { ui.calMonth = ''; ui.calDay = ''; render(); return; }
      const [y, m] = (ui.calMonth || today().slice(0, 7)).split('-').map(Number);
      const nd = new Date(y, m - 1 + step, 1);
      ui.calMonth = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}`; ui.calDay = ''; render();
    },
    'open-match': (d) => openMatchPicker(d.id),
    'match-toggle': (d) => { ui.modal[d.field] = !ui.modal[d.field]; renderModal(); },
    'match-clear': () => { ui.modal.sel = []; renderModal(); },
    'match-save': () => saveMatchPicker(),
    'close-match': () => closeMatchPicker(),
    'delete-evidence': async (d) => {
      const e = state.evidence.find((x) => x.id === d.id);
      if (!e) return;
      const linked = state.checks.flatMap((c) => c.splits.filter((s) => s.evidenceId === e.id).map((s) => ({ c, s })));
      if (!await uiConfirm(`Delete this ${money(e.amount)} payment?${linked.length ? `\n\n${linked.length} commission${linked.length > 1 ? 's' : ''} matched to it will go back to “Needs research”.` : ''}`)) return;
      linked.forEach(({ s }) => setResolution(null, s, 'research'));
      state.evidence = state.evidence.filter((x) => x.id !== d.id);
      save(); render();
    },
    'auto-match': (d) => {
      const r = runMatching(d.member); r.matched = r.smart + r.fifo;
      save(); render();
      toast(r.matched ? `Matched ${r.matched} commission${r.matched > 1 ? 's' : ''} (${money(r.amt)})` : 'Nothing new to match. Log more payments, or check the dates and amounts.');
    },
    'do-pay-import': () => doPayImport(),
    'match-all': () => {
      const ids = uniq(state.evidence.map((e) => e.memberId));
      let smart = 0, fifo = 0, amt = 0;
      ids.forEach((id) => { const r = runMatching(id); smart += r.smart; fifo += r.fifo; amt += r.amt; });
      save(); render();
      toast(smart + fifo ? `Matched ${smart + fifo} commissions (${smart} by job name, ${fifo} oldest-first), ${money(amt)}` : 'Nothing new to match yet. Add commission rules and import your past checks first.');
    },
    'bulk-resolve': async (d) => {
      const val = $('#bulk-res').value;
      const items = cellSplits(d.member, d.year).filter(({ split }) => splitState(split) === 'research');
      if (!items.length || !await uiConfirm(`Set ${items.length} commission${items.length > 1 ? 's' : ''} to “${RES_LABELS[val]}”?`)) return;
      items.forEach(({ check, split }) => setResolution(check, split, val));
      save(); render();
    },
    'export-audit': () => exportAudit(),
    'export-audit-summary': () => exportAuditSummary(),
    'start-fresh': () => startFresh(),
    'preview-emails': () => openModal({ type: 'emailPreview', tab: 'receipt' }),
    'preview-tab': (d) => { ui.modal.tab = d.value; renderModal(); },
    'send-receipt': async (d) => {
      const c = checkById(d.check);
      const sp = c?.splits.find((x) => x.memberId === d.member);
      const member = memberById(d.member);
      if (!sp || !sp.paid || !member?.email) return;
      if (!await uiConfirm(`Email a payment receipt for ${money(sp.amount)} to ${member.name} at ${member.email}?`)) return;
      if (!sp.receiptNo) sp.receiptNo = nextReceiptNo();
      enqueue({ type: 'receipt', key: `rc:${sp.receiptNo}`, memberId: sp.memberId, items: [{ checkId: c.id, memberId: sp.memberId }], receiptNo: sp.receiptNo });
      save(); render(); kickOutbox();
    },
    'retry-outbox': () => {
      (state.outbox || []).forEach((j) => { if (j.failed) Object.assign(j, { failed: false, attempts: 0, error: null, sendAfter: Date.now() }); });
      save(); refreshOutboxUI(); kickOutbox();
    },
    'clear-failed': async () => {
      if (!await uiConfirm('Discard the emails and ledger updates that failed? They won’t be sent.')) return;
      cancelJobs((j) => j.failed);
      save(); refreshOutboxUI();
    },
    'share-accountant': async (d, el) => {
      const s = state.settings;
      if (!s.accountantEmail || !/^\S+@\S+\.\S+$/.test(s.accountantEmail)) return toast('Enter your accountant’s email first.', { error: true });
      if (!await uiConfirm(`Share with ${s.accountantEmail} (view only)?\n\n• Your “SAG Checks” folder in Google Drive (all check & statement scans)\n• The “The Actor’s HQ Ledger” spreadsheet\n\nYour backups and bills are NOT shared.`)) return;
      el.disabled = true; el.textContent = 'Sharing…';
      try {
        const r = await driveCall('shareWithAccountant', { email: s.accountantEmail });
        Object.assign(s, { ledgerUrl: r.ledgerUrl, sharedFolderUrl: r.folderUrl, sharedWith: s.accountantEmail });
        save(); render();
        toast(`Shared with ${s.accountantEmail}`);
      } catch (e) { toast(e.message, { error: true }); el.disabled = false; el.textContent = 'Share scans & ledger with accountant'; }
    },
    'sync-ledger': () => {
      if (!state.settings.ledger) return toast('Turn on the ledger first.', { error: true });
      const items = [];
      for (const c of state.checks) { items.push({ check: c }); for (const split of c.splits) if (split.paid) items.push({ check: c, split }); }
      ledgerSync(items, 0); save(); refreshOutboxUI();
      toast(`Syncing ${state.checks.length} checks to the ledger…`);
    },
    'add-check': () => { ui.pendingFiles = []; openModal({ type: 'checkForm' }); },
    'edit-check': (d) => { ui.pendingFiles = []; openModal({ type: 'checkForm', id: d.id }); },
    'open-check': (d) => openModal({ type: 'checkDetail', id: d.id, live: true }),
    'check-filter': (d) => { ui.checkFilter = d.value; render(); },
    'toggle-split': (d) => {
      const c = checkById(d.check);
      const s = c?.splits.find((x) => x.memberId === d.member);
      if (!s) return;
      const before = { ...s };
      const documenting = s.resolution === 'research'; // recording a past payment — no receipts or emails
      setSplitPaid(c, s, !s.paid);
      if (documenting) ledgerSync([{ check: c, split: s }]);
      else if (s.paid) paymentAutomations([{ check: c, split: s }]); else unpaidAutomations([{ check: c, split: s }]);
      save(); render();
      const emailing = s.paid && (state.outbox || []).some((j) => isEmailJob(j) && j.receiptNo === s.receiptNo);
      toast(s.paid ? `${s.name} marked paid ${money(s.amount)}${emailing ? ' — emails go out in a few seconds' : ''}` : `${s.name} marked unpaid`, {
        undo: () => { restoreSplit(s, before); ledgerSync([{ check: c, split: s }], 0); save(); render(); },
      });
    },
    'pay-all-member': async (d) => {
      const items = unpaidSplits(d.member);
      if (!items.length) return;
      const name = items[0].split.name;
      const total = sum(items, (o) => o.split.amount);
      if (!await uiConfirm(`Mark all ${items.length} unpaid split${items.length > 1 ? 's' : ''} for ${name} as paid today?\n\nTotal: ${money(total)}`)) return;
      const before = items.map((o) => ({ s: o.split, snap: { ...o.split } }));
      items.forEach((o) => setSplitPaid(o.check, o.split, true));
      paymentAutomations(items);
      save(); render();
      toast(`${name} marked paid ${money(total)}`, { undo: () => { before.forEach((b) => restoreSplit(b.s, b.snap)); ledgerSync(items, 0); save(); render(); } });
    },
    'delete-check': async (d) => {
      const c = checkById(d.id);
      if (!c || !await uiConfirm('Delete this check from the app? Files already in Google Drive stay there.')) return;
      for (const f of c.files || []) if (f.status !== 'uploaded') await idb.del(f.id).catch(() => {});
      state.checks = state.checks.filter((x) => x.id !== d.id);
      cancelJobs((j) => j.checkId === d.id || (j.items || []).some((i) => i.checkId === d.id));
      enqueue({ type: 'ledgerDelete', key: `ldc:${d.id}`, sheet: 'Checks', rowId: d.id });
      enqueue({ type: 'ledgerDelete', key: `ldp:${d.id}`, sheet: 'Payouts', prefix: `${d.id}:` });
      kickOutbox();
      save(); closeModal(); render();
      toast('Check deleted');
    },
    'upload-file': async (d) => {
      const c = checkById(d.check);
      const f = c?.files.find((x) => x.id === d.file);
      if (!f) return;
      try { await uploadFile(c, f); toast('Saved to Google Drive'); } catch (e) { toast(e.message, { error: true }); }
    },
    'view-local': async (d) => {
      const blob = await idb.get(d.file);
      if (!blob) return toast('Local copy not found', { error: true });
      window.open(URL.createObjectURL(blob), '_blank');
    },
    'remove-file': async (d) => {
      const c = checkById(d.check);
      const f = c?.files.find((x) => x.id === d.file);
      if (!f) return;
      if (!await uiConfirm(f.status === 'uploaded' ? `Remove "${f.name}" from this check? It stays in your Google Drive.` : `Remove "${f.name}"? It hasn’t been saved to Drive, so it will be gone.`)) return;
      c.files = c.files.filter((x) => x.id !== d.file);
      await idb.del(d.file).catch(() => {});
      save(); render();
    },
    'add-expense': () => { ui.pendingFiles = []; openModal({ type: 'expenseForm' }); },
    'edit-expense': (d) => { ui.pendingFiles = []; openModal({ type: 'expenseForm', id: d.id }); },
    'delete-expense': async (d) => {
      const e = (state.expenses || []).find((x) => x.id === d.id); if (!e) return;
      if (!await uiConfirm(`Delete this ${money(e.amount)} expense?\n\nReceipts already in Google Drive stay there.`)) return;
      state.expenses = state.expenses.filter((x) => x.id !== d.id); save(); closeModal(); render(); toast('Expense deleted');
    },
    'wo-year': (d) => { ui.woYear = d.value; render(); },
    'wo-csv': () => expenseCSV(ui.woYear || expenseYears()[0]),
    'wo-upload-all': async () => { for (const e of state.expenses || []) await uploadOwnerFiles(e.files || [], expenseUploadOpts(e), 'receipt'); },
    'add-project': () => { ui.pendingFiles = []; openModal({ type: 'projectForm' }); },
    'edit-project': (d) => { ui.pendingFiles = []; openModal({ type: 'projectForm', id: d.id }); },
    'proj-row-add': (d, el) => { captureProjectValues(el.closest('form')); const last = ui.modal.rows[ui.modal.rows.length - 1]; ui.modal.rows.push({ memberId: last?.memberId || state.settings.team[0]?.id, percent: '', payTypes: '', from: '', to: '', method: memberById(last?.memberId)?.method || '', payTo: '', takenOut: false }); renderModal(); },
    'proj-row-del': (d, el) => { captureProjectValues(el.closest('form')); ui.modal.rows.splice(Number(d.index), 1); renderModal(); },
    'delete-project': async (d) => {
      const p = projectById(d.id); if (!p) return;
      if (!await uiConfirm(`Delete ${p.title}?\n\nIts fee splits are removed. Contract files already in Google Drive stay there.`)) return;
      state.projects = state.projects.filter((x) => x.id !== d.id); const n = reapplyRules(); save(); closeModal(); render(); toast(`Project deleted${n ? ` — recalculated ${n} checks` : ''}`);
    },
    'splits-asof-clear': () => { ui.splitsAsOf = ''; render(); },
    'open-attachment': (d) => {
      const list = d.kind === 'project' ? projectById(d.owner)?.files : (state.expenses || []).find((x) => x.id === d.owner)?.files;
      const f = (list || []).find((x) => x.id === d.file); if (f) openStoredFile(f);
    },
    'remove-pending': (d) => { ui.pendingFiles.splice(Number(d.index), 1); $('#pending-files').innerHTML = pendingFilesHTML(); },
    'retry-uploads': async () => {
      const checks = state.checks.filter((c) => (c.files || []).some((f) => f.status !== 'uploaded'));
      if (!checks.length) return toast('All files are already in Google Drive');
      for (const c of checks) await uploadPending(c);
    },

    'add-bill': (d) => openModal({ type: 'billForm', kind: d.kind, acting: d.acting === '1' }),
    'edit-bill': (d) => openModal({ type: 'billForm', id: d.id }),
    'bill-tab': (d) => { ui.billTab = d.value; render(); },
    'bill-kind': (d, el) => {
      const form = el.closest('form');
      form.kind.value = d.value;
      form.querySelectorAll('[data-action="bill-kind"]').forEach((b) => b.classList.toggle('on', b === el));
      const h = form.querySelector('h2');
      h.textContent = h.textContent.replace(/bill|subscription/, d.value);
    },
    'pay-bill': (d) => {
      const b = billById(d.id);
      if (!b) return;
      const p = payBill(b);
      save(); render();
      toast(`${b.name} paid${b.nextDue ? ` — next due ${fmtShort(b.nextDue)}` : ''}`, { undo: () => { undoBillPayment(b, p.id); save(); render(); } });
    },
    'bill-history': (d) => openModal({ type: 'billHistory', id: d.id, live: true }),
    'undo-bill-payment': (d) => { const b = billById(d.id); undoBillPayment(b, d.payment); save(); render(); },
    'delete-bill': async (d) => {
      const b = billById(d.id);
      if (!b || !await uiConfirm(`Delete ${b.name} and its payment history?`)) return;
      state.bills = state.bills.filter((x) => x.id !== d.id);
      save(); closeModal(); render();
    },

    'add-member': async () => {
      const name = await uiPrompt('Name of the new team member?');
      if (!name || !name.trim()) return;
      state.settings.team.push({ id: uid(), name: name.trim(), percent: 10, method: 'Zelle', email: '', company: '', color: COLORS[state.settings.team.length % COLORS.length] });
      save(); render();
    },
    'remove-member': async (d) => {
      const m = memberById(d.member);
      if (!m || !await uiConfirm(`Remove ${m.name} from the team? Checks already logged keep their split for ${m.name}.`)) return;
      state.settings.team = state.settings.team.filter((x) => x.id !== d.member);
      save(); render();
    },
    'test-drive': async (d, el) => {
      el.disabled = true; el.textContent = 'Testing…';
      try {
        const r = await driveCall('ping');
        if (r.ledgerUrl) state.settings.ledgerUrl = r.ledgerUrl;
        save();
        toast('Connected to Google Drive ✓');
        await syncFromDrive(false);
        if (r.folderUrl && await uiConfirm('Connected! Open The Actor’s HQ folder in Google Drive?')) window.open(r.folderUrl, '_blank');
        render();
        backupNow(true);
      } catch (e) { toast(e.message, { error: true }); el.disabled = false; el.textContent = 'Test connection'; }
    },
    'backup-now': () => backupNow(false),
    'restore-drive': async () => {
      try {
        const r = await driveCall('restore');
        if (!r.content) return toast('No backup found in Google Drive yet.', { error: true });
        const data = JSON.parse(r.content);
        if (!await uiConfirm(`Replace everything in this app with the Drive backup from ${r.updated ? new Date(r.updated).toLocaleString() : 'Google Drive'}?\n\n${data.checks?.length || 0} checks, ${data.bills?.length || 0} bills.`)) return;
        applyImport(data);
      } catch (e) { toast(e.message, { error: true }); }
    },
    'export-json': () => {
      const blob = new Blob([backupPayload()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sag-tracker-backup-${today()}.json`;
      a.click();
    },
    'reset-all': async () => {
      if (!await uiConfirm('Erase ALL checks, bills and settings from this browser? This cannot be undone (files already in Google Drive are not touched).')) return;
      if (await uiPrompt('Type ERASE to confirm') !== 'ERASE') return;
      state = defaultState(); save(); render();
    },
  };
  // ---------- data pack: adds prepared audit data WITHOUT replacing bills, settings or anything already here ----------
  function packSummary(p) {
    return [p.checks?.length ? `${p.checks.length} past check lines` : '', p.evidence?.length ? `${p.evidence.length} payments found` : '', p.rules?.length ? `${p.rules.length} commission rule${p.rules.length === 1 ? '' : 's'}` : '',
      ...(p.bills || []).map((b) => `bill: ${b.name} — ${money(b.amount)}${b.nextDue ? `, due ${fmtDate(b.nextDue)}` : ''}`),
      ...Object.values(p.claims || {}).map((c) => `their records (${c.items.length} rows, kept separate)`)].filter(Boolean).join('\n• ');
  }
  function mergePack(p) {
    // match people by name so ids line up with this app's team
    const idMap = {};
    for (const pm of p.team || []) {
      let m = state.settings.team.find((t) => t.id === pm.id || t.name.trim().toLowerCase() === pm.name.trim().toLowerCase());
      if (!m) { m = { ...pm }; state.settings.team.push(m); }
      idMap[pm.id] = m.id;
    }
    const mid = (id) => idMap[id] || id;
    let nRules = 0, nChecks = 0, nEv = 0;
    state.rules = state.rules || [];
    for (const r of p.rules || []) {
      const rr = { ...r, memberId: mid(r.memberId) };
      if (state.rules.some((x) => x.memberId === rr.memberId && num(x.percent) === num(rr.percent) && (x.from || '') === (rr.from || '') && (x.employers || '') === (rr.employers || ''))) continue;
      state.rules.push({ ...rr, id: uid() }); nRules++;
    }
    const haveBatch = new Set(state.imports.map((i) => i.id));
    for (const im of p.imports || []) if (!haveBatch.has(im.id)) state.imports.push(im);
    const haveCheck = new Set(state.checks.map((c) => c.id));
    for (const c of p.checks || []) {
      if (haveCheck.has(c.id) || haveBatch.has(c.importBatch)) continue;
      state.checks.push({ ...c, splits: c.splits.map((s) => ({ ...s, memberId: mid(s.memberId) })) }); nChecks++;
    }
    const haveEv = new Set(state.evidence.map((e) => e.id));
    for (const e of p.evidence || []) { if (haveEv.has(e.id)) continue; state.evidence.push({ ...e, memberId: mid(e.memberId) }); nEv++; }
    state.claims = state.claims || {};
    for (const [k, v] of Object.entries(p.claims || {})) state.claims[mid(k)] = v;
    let nBills = 0;
    for (const b of p.bills || []) {
      if (state.bills.some((x) => x.id === b.id || (x.name.trim().toLowerCase() === b.name.trim().toLowerCase() && num(x.amount) === num(b.amount)))) continue;
      state.bills.push({ payments: [], ...b }); nBills++;
    }
    if (nBills && !(p.checks?.length || p.evidence?.length || p.rules?.length)) { save(); render(); toast(`Added ${nBills} bill${nBills === 1 ? '' : 's'}`); return; }
    state.audit.rulesConfirmed = false;
    save(); render();
    toast(`Added ${nChecks} check lines, ${nEv} payments and ${nRules} rule${nRules === 1 ? '' : 's'}${nChecks || nEv || nRules ? '' : ' — it was already loaded'}`);
  }
  function loadPackFile(file) {
    file.text().then(async (txt) => {
      const data = JSON.parse(txt);
      if (data.kind !== 'sag-tracker-pack') throw new Error('That isn’t a prepared data file. To restore a full backup, use Settings → Import backup.');
      if (!await uiConfirm(`Add this prepared data to your app?\n\n• ${packSummary(data)}\n\nYour bills, settings and anything already here stay as they are.${data.note ? `\n\n${data.note}` : ''}`)) return;
      mergePack(data);
    }).catch((err) => toast(err.message, { error: true }));
  }
  function applyImport(data) {
    if (!data || !Array.isArray(data.checks) || !Array.isArray(data.bills)) throw new Error('That file isn’t an Actor’s HQ backup.');
    const keep = { driveUrl: state.settings.driveUrl, driveSecret: state.settings.driveSecret };
    state = migrate(data);
    Object.assign(state.settings, keep);
    save(); render();
    toast(`Restored ${state.checks.length} checks and ${state.bills.length} bills`);
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-overlay]')) { closeModal(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn({ ...el.dataset }, el);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'check') submitCheckForm(form).catch((err) => toast(err.message, { error: true }));
    if (form.dataset.form === 'bill') submitBillForm(form);
    if (form.dataset.form === 'rule') submitRuleForm(form);
    if (form.dataset.form === 'project') submitProjectForm(form).catch((err) => toast(err.message, { error: true }));
    if (form.dataset.form === 'expense') submitExpenseForm(form).catch((err) => toast(err.message, { error: true }));
    if (form.dataset.form === 'evidence') {
      const f = form.elements;
      addEvidence({ memberId: f.memberId.value, date: f.date.value, amount: round2(num(f.amount.value)), method: f.method.value.trim(), reference: f.reference.value.trim(), notes: f.notes.value.trim() }, f.autoMatch.checked);
      closeModal(); render();
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'check-search') { ui.checkSearch = t.value; render(); return; }
    if (t.id === 'match-search' && ui.modal?.type === 'matchPicker') { ui.modal.q = t.value; ui.modal.focusSearch = true; renderModal(); return; }
    const form = t.closest('form[data-form="check"]');
    if (form) { if (t.name === 'pct' || t.name === 'takenout') t.dataset.touched = '1'; if (t.dataset.autofilled) { delete t.dataset.autofilled; t.classList.remove('autofilled'); } updateSplitPreview(form); }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'work-filter') { ui.workFilter = t.value; render(); return; }
    if ((t.id === 'import-history-file' || t.id === 'import-history-file-2') && t.files[0]) { startImport(t.files[0]); t.value = ''; return; }
    if (t.id === 'import-claims-file' && t.files[0]) { importClaims(t.files[0]); t.value = ''; return; }
    if ((t.id === 'import-pay-file' || t.id === 'import-pay-file-2') && t.files[0]) { startPayImport(t.files[0]); t.value = ''; return; }
    if (t.dataset.payimportMap) { ui.payImport.map[t.dataset.payimportMap] = Number(t.value); renderModal(); return; }
    if (t.dataset.payimportMember !== undefined) { ui.payImport.memberId = t.value; renderModal(); return; }
    if (t.dataset.matchPick && ui.modal?.type === 'matchPicker') { const id = t.dataset.matchPick; ui.modal.sel = t.checked ? [...new Set([...ui.modal.sel, id])] : ui.modal.sel.filter((x) => x !== id); renderModal(); return; }
    if (t.dataset.shareAuto) { const c = sharedCfg()[sharedPageId(t.dataset.shareAuto)]; if (c) { c.auto = t.checked; save(); toast(t.checked ? 'This link will update after each backup' : 'Automatic updates off — use “Update now”'); } return; }
    if (t.dataset.stmt) { const k = t.dataset.stmt; ui.stmt[k] = t.type === 'checkbox' ? t.checked : t.value; if (k === 'member') ui.stmt.year = 'all'; render(); return; }
    if (t.dataset.acct) { ui.acctYear = t.value; render(); return; }
    if (t.dataset.prow !== undefined && ui.modal?.type === 'projectForm') { const r = ui.modal.rows[Number(t.dataset.prow)]; if (r) r[t.dataset.pfield] = t.type === 'checkbox' ? t.checked : t.value; return; }
    if (t.dataset.tq) { ui.tqYear = t.value; render(); return; }
    if (t.dataset.q) { if (t.dataset.q === 'member') ui.qMember = t.value; else ui.qYear = t.value; render(); return; }
    if (t.dataset.splitsAsof !== undefined) { ui.splitsAsOf = t.value; render(); return; }
    if (t.dataset.five) { state.audit.five = state.audit.five || {}; if (t.value === 'undecided') delete state.audit.five[t.dataset.five]; else state.audit.five[t.dataset.five] = t.value; save(); render(); return; }
    if (t.dataset.claimed) { state.audit.claimed = state.audit.claimed || {}; if (t.value === '') delete state.audit.claimed[t.dataset.claimed]; else state.audit.claimed[t.dataset.claimed] = round2(num(t.value)); save(); render(); return; }
    if (t.dataset.importMap) { ui.importData.mapping.map[t.dataset.importMap] = Number(t.value); renderModal(); return; }
    if (t.dataset.importLegacy) { ui.importData.mapping.legacy[t.dataset.importLegacy] = Number(t.value); renderModal(); return; }
    if (t.dataset.importSheet !== undefined) { selectImportSheet(Number(t.value)); renderModal(); return; }
    if (t.dataset.resolveCheck) {
      const c = checkById(t.dataset.resolveCheck);
      const s = c?.splits.find((x) => x.memberId === t.dataset.resolveMember);
      if (s) { setResolution(c, s, t.value); if (!c.historical) ledgerSync([{ check: c, split: s }], 1500); save(); render(); }
      return;
    }
    if (t.dataset.auditSource) {
      const n = (state.auditNotes[t.dataset.key] ||= { sources: {}, notes: '' });
      n.sources = n.sources || {};
      n.sources[t.dataset.auditSource] = t.checked;
      save(); return;
    }
    if (t.dataset.auditNotes) { (state.auditNotes[t.dataset.auditNotes] ||= { sources: {}, notes: '' }).notes = t.value; save(); return; }
    if (t.id === 'file-input' || t.id === 'file-camera') {
      const files = [...t.files]; ui.pendingFiles.push(...files); t.value = ''; $('#pending-files').innerHTML = pendingFilesHTML();
      if (t.closest('form[data-form="check"]')) { const img = files.find((f) => /^image\//.test(f.type || '')); if (img) scanCheckImage(img); }
      return;
    }
    if (t.name === 'takenout' && t.closest('form[data-form="check"]')) { t.dataset.touched = '1'; updateSplitPreview(t.closest('form')); return; }
    if (t.dataset.attach) { const c = checkById(t.dataset.attach); if (c) addFilesToCheck(c, t.files); return; }
    if (t.id === 'import-pack-file' && t.files[0]) { loadPackFile(t.files[0]); t.value = ''; return; }
    if (t.id === 'import-file' && t.files[0]) {
      t.files[0].text().then(async (txt) => {
        const data = JSON.parse(txt);
        if (data.kind === 'sag-tracker-pack') { if (await uiConfirm(`Add this prepared data to your app?\n\n• ${packSummary(data)}\n\nYour bills, settings and anything already here stay as they are.`)) mergePack(data); return; }
        if (await uiConfirm(`Replace everything in this app with this backup?\n\n${data.checks?.length || 0} checks, ${data.bills?.length || 0} bills.`)) applyImport(data);
      }).catch((err) => toast(err.message, { error: true }));
      t.value = '';
      return;
    }
    if (t.dataset.memberField) {
      const m = memberById(t.dataset.member);
      if (!m) return;
      const field = t.dataset.memberField;
      m[field] = field === 'percent' ? num(t.value) : t.value.trim();
      save(); render();
      return;
    }
    if (t.dataset.setting) {
      const key = t.dataset.setting;
      state.settings[key] = t.type === 'checkbox' ? t.checked : t.value.trim();
      // Pasting the whole phone setup link (…#connect=…) into the Web app URL box works too.
      if (key === 'driveUrl') { const mm = /#connect=(.+)$/.exec(state.settings.driveUrl); if (mm) { try { state.settings.driveUrl = decodeURIComponent(mm[1]); } catch (e) {} } }
      save(); render();
      return;
    }
    if (t.dataset.splitField) {
      const c = checkById(t.dataset.check);
      const s = c?.splits.find((x) => x.memberId === t.dataset.member);
      if (s) { s[t.dataset.splitField] = t.value; ledgerSync([{ check: c, split: s }], 1500); save(); render(); }
    }
  });

  // drag & drop onto the dropzone in the check form
  document.addEventListener('dragover', (e) => {
    const z = e.target.closest?.('#dropzone');
    if (z) { e.preventDefault(); z.classList.add('drag'); }
  });
  document.addEventListener('dragleave', (e) => { e.target.closest?.('#dropzone')?.classList.remove('drag'); });
  document.addEventListener('drop', (e) => {
    const z = e.target.closest?.('#dropzone');
    if (!z) return;
    e.preventDefault();
    z.classList.remove('drag');
    const dropped = [...e.dataTransfer.files];
    ui.pendingFiles.push(...dropped);
    $('#pending-files').innerHTML = pendingFilesHTML();
    const img = dropped.find((f) => /^image\//.test(f.type || '')); if (img && z.closest('form[data-form="check"]')) scanCheckImage(img);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.modal) closeModal();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.cal-cell')) { e.preventDefault(); e.target.click(); }
  });

  // Page switching that doesn't depend on the browser following "#page" links.
  // (Inside Google's frame — the phone app — those links do nothing, so the app switches pages itself.)
  const VIEWS = ['dashboard', 'checks', 'team', 'rules', 'audit', 'projects', 'bills', 'writeoffs', 'calendar', 'reports', 'settings'];
  // Sections fade up as they scroll into view. Only runs when you open a page (not on every small update),
  // so editing things never makes the screen flash.
  let revealObserver = null;
  function setupReveal() {
    try {
      if (revealObserver) revealObserver.disconnect();
      if (!('IntersectionObserver' in window) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
      const main = $('#main'); if (!main) return;
      const picks = main.querySelectorAll('.page-head, .chapterwrap, .hero, .toolbar, .cal-legend, .grid.tiles > .card, .card, .statement, .bill-row, .agenda-day');
      const els = [];
      for (const el of picks) { if (el.parentElement.closest('.reveal')) continue; el.classList.add('reveal'); els.push(el); }
      const vh = window.innerHeight || 800;
      let shown = 0;
      revealObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          en.target.classList.add('in');
          revealObserver.unobserve(en.target);
        }
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
      for (const el of els) {
        const top = el.getBoundingClientRect().top;
        if (top < vh) el.style.transitionDelay = `${Math.min(shown++ * 60, 360)}ms`; // first screen: quick cascade
        revealObserver.observe(el);
      }
      // Safety net: never leave anything invisible.
      setTimeout(() => main.querySelectorAll('.reveal:not(.in)').forEach((el) => { if (el.getBoundingClientRect().top < (window.innerHeight || 800)) el.classList.add('in'); }), 1500);
    } catch (e) { document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in')); }
  }
  function showView(v) {
    ui.view = VIEWS.includes(v) ? v : 'dashboard';
    closeModal(); closeMenu(); syncThemeButton();
    render();
    try { window.scrollTo(0, 0); } catch (e) {}
    setupReveal();
  }
  function go(v) {
    const view = VIEWS.includes(v) ? v : 'dashboard';
    try { if (location.hash !== '#' + view) history.pushState(null, '', '#' + view); } catch (e) {}
    showView(view);
  }
  function route() {
    let v = 'dashboard';
    try { v = location.hash.replace('#', '') || 'dashboard'; } catch (e) {}
    showView(v);
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  // Catch clicks on in-app links (href="#view") before the browser tries to follow them.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    const v = a.getAttribute('href').slice(1);
    if (!VIEWS.includes(v)) return;
    e.preventDefault();
    go(v);
  }, true);
  window.addEventListener('online', kickOutbox);
  setInterval(processOutbox, 4000);
  kickOutbox();
  route();
  // Phone copy: it knows where your Drive helper is; you only type the password once.
  try {
    const mm = /^#connect=(.+)$/.exec(location.hash || '');
    if (mm) {
      const u = decodeURIComponent(mm[1]);
      if (/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) { state.settings.driveUrl = u; safeStore.setItem(STORE_KEY, JSON.stringify(state)); renderDriveStatus(); }
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) {}
  if (window.AHQ_HELPER_URL && !state.settings.driveUrl) { state.settings.driveUrl = window.AHQ_HELPER_URL; try { safeStore.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} renderDriveStatus(); }
  syncFromDrive(false);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromDrive(false); });
})();
