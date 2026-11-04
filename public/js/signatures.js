// Signature pad, approval dialog, saved approval signature editor.
Object.assign(App, {
  // ─── Signature pad (canvas-ID-parameterized) ───────────────────────────
  // No canvas/signature infrastructure existed anywhere in this app before
  // the rental checkpoint feature — a minimal pointer/touch-driven drawing
  // surface, saved as a PNG data URL and decoded server-side
  // (routes/rentals.js's uploadSignature helper). Parameterized by canvas
  // ID (rather than one hardcoded canvas + one flat boolean) since a single
  // modal can now hold two or three of these at once (customer + guard at
  // Issue, guard at Return).
  _sigPadHtml(canvasId, label, hint) {
    return `<div class="form-group" style="margin-bottom:12px">
      <label>${label} <span style="font-weight:400;color:var(--text-muted)">(${hint})</span></label>
      <canvas id="${canvasId}" width="416" height="140" style="border:1px solid var(--border);border-radius:6px;width:100%;touch-action:none;cursor:crosshair;background:#fff"></canvas>
      <div style="display:flex;justify-content:flex-end;margin-top:4px">
        <button type="button" class="btn btn-secondary btn-sm" onclick="App._sigPadClear('${canvasId}')">Clear</button>
      </div>
    </div>`;
  },

  _sigPadPos(canvas, evt) {
    const rect = canvas.getBoundingClientRect();
    const point = evt.touches ? evt.touches[0] : evt;
    return { x: (point.clientX - rect.left) * (canvas.width / rect.width), y: (point.clientY - rect.top) * (canvas.height / rect.height) };
  },

  _sigPadStart(canvasId, evt) {
    evt.preventDefault();
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    this._sigPads[canvasId] = this._sigPads[canvasId] || {};
    this._sigPads[canvasId].drawing = true;
    const { x, y } = this._sigPadPos(canvas, evt);
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(x, y);
  },

  _sigPadMove(canvasId, evt) {
    const state = this._sigPads[canvasId];
    if (!state?.drawing) return;
    evt.preventDefault();
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const { x, y } = this._sigPadPos(canvas, evt);
    const ctx = canvas.getContext('2d');
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
    state.hasDrawn = true;
  },

  _sigPadEnd(canvasId) {
    const state = this._sigPads[canvasId];
    if (state) state.drawing = false;
  },

  _sigPadClear(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    if (this._sigPads[canvasId]) this._sigPads[canvasId].hasDrawn = false;
  },

  _sigPadInit(canvasId) {
    this._sigPads = this._sigPads || {};
    this._sigPads[canvasId] = { drawing: false, hasDrawn: false };
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.addEventListener('mousedown', e => this._sigPadStart(canvasId, e));
    canvas.addEventListener('mousemove', e => this._sigPadMove(canvasId, e));
    window.addEventListener('mouseup', () => this._sigPadEnd(canvasId));
    canvas.addEventListener('touchstart', e => this._sigPadStart(canvasId, e));
    canvas.addEventListener('touchmove', e => this._sigPadMove(canvasId, e));
    canvas.addEventListener('touchend', () => this._sigPadEnd(canvasId));
  },

  _sigPadHasDrawn(canvasId) { return !!this._sigPads?.[canvasId]?.hasDrawn; },

  _sigPadDataUrl(canvasId) { return document.getElementById(canvasId)?.toDataURL('image/png'); },

  // ─── Approval dialog with saved or drawn signature ───────────────
  // Shared Approve dialog (POs, purchase requests, Special Projects). The
  // approver signs once: their signature is saved (employees.
  // approval_signature) and every later approval shows it and applies it with
  // one click; "Draw a new signature" replaces it. `approve(signature)` makes
  // the approval call — `signature` is a newly drawn PNG data URL, or
  // undefined to use the saved one (lib/signatures.js resolveApprovalSignature).
  async _showApprovalDialog({ title, intro = '', context = '', approveLabel = 'Approve', approve }) {
    let saved = null;
    try { saved = (await this.api('GET', '/employees/me/signature')).approval_signature; } catch (e) {}
    this._approval = { approve, drawing: !saved };
    const me = this.currentUser ? `${this.currentUser.first_name} ${this.currentUser.last_name}` : '';
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">${title}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${intro ? `<p style="font-size:13px;color:var(--text-muted);margin-top:0">${intro}</p>` : ''}
          ${context}
          <div id="approval-saved" style="display:${saved ? '' : 'none'}">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Your signature will be applied to the approved document${me ? ` as <strong>${this.escapeAttr(me)}</strong>` : ''}:</div>
            ${saved ? `<div style="border:1px solid var(--border);border-radius:6px;background:#fff;padding:8px;text-align:center"><img src="${this.escapeAttr(saved)}" alt="Your signature" style="max-height:90px;max-width:100%"></div>` : ''}
            <button type="button" class="btn btn-sm btn-outline" style="margin-top:8px" onclick="App._approvalDrawNew()">Draw a new signature</button>
          </div>
          <div id="approval-draw" style="display:${saved ? 'none' : ''}">
            <p style="font-size:12px;color:var(--text-muted);margin-top:0">${saved ? 'Your new signature replaces the saved one for this and future approvals.' : "Draw your signature once — it's saved and applied automatically to your future approvals."}</p>
            ${this._sigPadHtml('approval-sig', 'Your Signature', 'sign to approve')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" id="approval-btn" onclick="App._approvalConfirm()">${approveLabel}</button>
        </div>
      </div>`);
    this._sigPadInit('approval-sig');
  },

  _approvalDrawNew() {
    document.getElementById('approval-saved').style.display = 'none';
    document.getElementById('approval-draw').style.display = '';
    this._approval.drawing = true;
  },

  async _approvalConfirm() {
    const a = this._approval;
    if (!a) return;
    if (a.drawing && !this._sigPadHasDrawn('approval-sig')) { this.alert('Draw your signature to approve', 'error'); return; }
    const btn = document.getElementById('approval-btn');
    if (btn) btn.disabled = true;
    try {
      await a.approve(a.drawing ? this._sigPadDataUrl('approval-sig') : undefined);
    } catch (e) {
      if (btn) btn.disabled = false;
      this.alert(e.message, 'error');
    }
  },

  // Approved-by signature shown on a document's in-app view.
  _approvalSigImg(path, label = 'Approver signature') {
    if (!path) return '';
    return `<div style="margin-top:6px"><img src="${this.escapeAttr(path)}" alt="${label}" style="max-height:56px;max-width:220px;background:#fff;border:1px solid var(--border);border-radius:4px;padding:2px 6px"></div>`;
  },

  // ─── Saved approval signature editor ─────────────────────────────
  _signaturePreviewHtml(sig) {
    return sig
      ? `<div style="border:1px solid var(--border);border-radius:6px;background:#fff;padding:8px;text-align:center"><img src="${this.escapeAttr(sig)}" alt="Saved signature" style="max-height:90px;max-width:100%"></div>`
      : `<div style="border:1px dashed var(--border);border-radius:6px;padding:14px;text-align:center;font-size:13px;color:var(--text-muted)">No signature saved yet — you'll be asked to draw one at your first approval, or add it now.</div>`;
  },

  _editMySignature() {
    this._showSignatureEditor({
      title: 'Your approval signature',
      save: async dataUrl => { await this.api('PUT', '/employees/me/signature', { signature: dataUrl }); this.alert('Signature saved — it will be applied to your approvals'); this.showMyProfile(); },
    });
  },

  async _removeMySignature() {
    if (!confirm('Remove your saved signature? You\'ll be asked to draw one at your next approval. Documents already approved keep theirs.')) return;
    try { await this.api('DELETE', '/employees/me/signature'); this.alert('Signature removed'); this.showMyProfile(); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // Draw-or-upload editor (secondary modal). save(dataUrl) stores it.
  _showSignatureEditor({ title, intro = '', save }) {
    this._sigEditor = { save, mode: 'draw', upload: null };
    this.showSecondaryModal(`
      <div class="modal" style="max-width:500px">
        <div class="modal-header"><span class="modal-title">${this.escapeAttr(title)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${intro ? `<p style="font-size:13px;color:var(--text-muted);margin-top:0">${intro}</p>` : ''}
          <div style="display:flex;gap:6px;margin-bottom:12px">
            <button type="button" class="btn btn-sm btn-primary" id="sig-mode-draw" onclick="App._sigEditorMode('draw')">Draw it</button>
            <button type="button" class="btn btn-sm btn-outline" id="sig-mode-upload" onclick="App._sigEditorMode('upload')">Upload a picture</button>
          </div>
          <div id="sig-editor-draw">${this._sigPadHtml('sig-editor-pad', 'Signature', 'sign with the mouse, a stylus or your finger')}</div>
          <div id="sig-editor-upload" style="display:none">
            <p style="font-size:12px;color:var(--text-muted);margin-top:0">Sign in dark ink on plain white paper, take a photo or scan, and choose it here (PNG or JPEG). It's cropped to the signature automatically.</p>
            <input type="file" id="sig-editor-file" accept="image/png,image/jpeg,image/webp" onchange="App._sigEditorLoadFile(this.files[0])">
            <label style="display:flex;gap:8px;align-items:center;font-weight:400;text-transform:none;margin-top:10px">
              <input type="checkbox" id="sig-editor-clean" checked style="width:auto" onchange="App._sigEditorProcess()"> Remove the paper background (keeps just the ink)
            </label>
            <div id="sig-editor-preview" style="margin-top:10px"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-success" id="sig-editor-save" onclick="App._sigEditorSave()">Save Signature</button>
        </div>
      </div>`);
    this._sigPadInit('sig-editor-pad');
  },

  _sigEditorMode(mode) {
    this._sigEditor.mode = mode;
    document.getElementById('sig-editor-draw').style.display = mode === 'draw' ? '' : 'none';
    document.getElementById('sig-editor-upload').style.display = mode === 'upload' ? '' : 'none';
    document.getElementById('sig-mode-draw').className = `btn btn-sm ${mode === 'draw' ? 'btn-primary' : 'btn-outline'}`;
    document.getElementById('sig-mode-upload').className = `btn btn-sm ${mode === 'upload' ? 'btn-primary' : 'btn-outline'}`;
  },

  _sigEditorLoadFile(file) {
    const ed = this._sigEditor;
    ed.upload = null;
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { this.alert('Choose a PNG or JPEG picture', 'error'); return; }
    if (file.size > 15 * 1024 * 1024) { this.alert('That picture is too large — use one under 15 MB', 'error'); return; }
    const img = new Image();
    img.onload = () => { ed.image = img; URL.revokeObjectURL(img.src); this._sigEditorProcess(); };
    img.onerror = () => this.alert("That picture couldn't be opened", 'error');
    img.src = URL.createObjectURL(file);
  },

  // Scales the picture down, optionally turns light (paper) pixels
  // transparent, and crops to the ink, so it sits cleanly on documents.
  _sigEditorProcess() {
    const ed = this._sigEditor;
    const img = ed?.image;
    const box = document.getElementById('sig-editor-preview');
    if (!img || !box) return;
    const scale = Math.min(1, 1200 / img.naturalWidth, 600 / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const clean = document.getElementById('sig-editor-clean')?.checked;
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (clean) {
        // Paper → transparent; ink → solid, with a soft edge so lines aren't jagged.
        const a = lum >= 200 ? 0 : lum <= 120 ? 255 : Math.round(255 * (200 - lum) / 80);
        px[i + 3] = Math.min(px[i + 3], a);
      }
      if (px[i + 3] > 40 && (!clean || lum < 200)) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) { box.innerHTML = '<div style="color:var(--danger);font-size:13px">No signature found in that picture — use dark ink on white paper, or untick Remove the paper background.</div>'; ed.upload = null; return; }
    ctx.putImageData(data, 0, 0);
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1; out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    ed.upload = out.toDataURL('image/png');
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">How it will look on documents:</div>
      <div style="border:1px solid var(--border);border-radius:6px;background:#fff;padding:8px;text-align:center"><img src="${ed.upload}" alt="Signature preview" style="max-height:90px;max-width:100%"></div>`;
  },

  async _sigEditorSave() {
    const ed = this._sigEditor;
    if (!ed) return;
    let dataUrl;
    if (ed.mode === 'draw') {
      if (!this._sigPadHasDrawn('sig-editor-pad')) return this.alert('Draw the signature first', 'error');
      dataUrl = this._sigPadDataUrl('sig-editor-pad');
    } else {
      if (!ed.upload) return this.alert('Choose a picture of the signature first', 'error');
      dataUrl = ed.upload;
    }
    const btn = document.getElementById('sig-editor-save');
    if (btn) btn.disabled = true;
    try { await ed.save(dataUrl); this.closeSecondaryModal(); this._sigEditor = null; }
    catch (e) { if (btn) btn.disabled = false; this.alert(e.message, 'error'); }
  },

  // Employees screen: an editor sets or removes a staff member's signature.
  async _loadEmployeeSignature(empId) {
    const box = document.getElementById('ef-sig-box');
    if (!box) return;
    let sig = null, canSign = false;
    try { ({ approval_signature: sig, can_sign: canSign } = await this.api('GET', `/employees/${empId}/signature`)); } catch (e) { box.innerHTML = `<div style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(e.message)}</div>`; return; }
    if (!document.getElementById('ef-sig-box')) return;
    if (!canSign) {
      box.innerHTML = `<div style="font-size:12px;color:var(--text-muted)">Only employees with approval permissions (purchase orders, purchase requests, payment requests, Special Projects or commissions) keep a signature — this employee's security group has none.${sig ? ' A signature saved earlier is no longer used:' : ''}</div>
        ${sig ? `<div style="border:1px solid var(--border);border-radius:6px;background:#fff;padding:6px;text-align:center;margin-top:6px"><img src="${this.escapeAttr(sig)}" alt="Saved signature" style="max-height:70px;max-width:100%"></div>
        <div style="margin-top:6px"><button type="button" class="btn btn-sm btn-outline" onclick="App._removeEmployeeSignature(${empId})">Remove</button></div>` : ''}`;
      return;
    }
    box.innerHTML = `${sig ? `<div style="border:1px solid var(--border);border-radius:6px;background:#fff;padding:6px;text-align:center"><img src="${this.escapeAttr(sig)}" alt="Saved signature" style="max-height:70px;max-width:100%"></div>` : '<div style="font-size:12px;color:var(--text-muted)">None saved — they\'ll be asked to draw one at their first approval.</div>'}
      <div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" class="btn btn-sm btn-outline" onclick="App._editEmployeeSignature(${empId})">${sig ? 'Replace' : 'Add signature'}</button>
        ${sig ? `<button type="button" class="btn btn-sm btn-outline" onclick="App._removeEmployeeSignature(${empId})">Remove</button>` : ''}
      </div>`;
  },

  _editEmployeeSignature(empId) {
    this._showSignatureEditor({
      title: 'Employee approval signature',
      intro: "This is applied whenever this employee approves something. Only add the employee's own signature, with their agreement.",
      save: async dataUrl => { await this.api('PUT', `/employees/${empId}/signature`, { signature: dataUrl }); this.alert('Signature saved'); this._loadEmployeeSignature(empId); },
    });
  },

  async _removeEmployeeSignature(empId) {
    if (!confirm("Remove this employee's saved signature? Documents they've already approved keep theirs.")) return;
    try { await this.api('DELETE', `/employees/${empId}/signature`); this._loadEmployeeSignature(empId); }
    catch (e) { this.alert(e.message, 'error'); }
  },
});
