// Cycle counts.
Object.assign(App, {
  // ─── CYCLE COUNTS ─────────────────────────────────────────────────────────

  async renderCycleCounts() {
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Cycle Counts</h2>
        <button class="btn btn-primary btn-sm" onclick="App.showCycleCountModal()">+ New Count</button>
      </div>
      <div id="cc-content"></div>`;
    await this.loadCycleCounts();
  },

  async loadCycleCounts() {
    const sessions = await this.api('GET','/warehouse/cycle-counts');
    const el = document.getElementById('cc-content');
    if (!el) return;
    const sc = { open:'badge-secondary', review:'badge-info', committed:'badge-success' };
    el.innerHTML = sessions.length===0 ? `
      <div class="empty-state">
        <p>No cycle count sessions yet.</p>
        <p style="font-size:13px;color:var(--text-muted)">Create a session → export as CSV → fill in counted quantities → import → review variances → commit adjustments.</p>
      </div>` : `
      <table class="table">
        <thead><tr><th>Session #</th><th>Branch</th><th>Scope</th><th>Items</th><th>Counted</th><th>Variances</th><th>Status</th><th>Date</th><th></th></tr></thead>
        <tbody>${sessions.map(s=>`
          <tr>
            <td><strong>${s.session_number}</strong></td>
            <td>${s.branch_name||'All Branches'}</td>
            <td><span class="badge badge-secondary">${s.scope_type}</span></td>
            <td>${s.item_count}</td>
            <td>${s.counted_count} / ${s.item_count}</td>
            <td>${s.variance_count>0?`<span class="badge badge-danger">${s.variance_count}</span>`:s.counted_count>0?'<span class="badge badge-success">0</span>':'—'}</td>
            <td><span class="badge ${sc[s.status]||'badge-secondary'}">${s.status}</span></td>
            <td style="color:var(--text-muted)">${this.fmtDate(s.created_at)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-sm btn-outline" onclick="App.viewCycleCount(${s.id})">Manage</button>
              <a class="btn btn-sm btn-secondary" href="/api/warehouse/cycle-counts/${s.id}/export" download>CSV</a>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  },

  async showCycleCountModal() {
    const branches = this.currentUser.branches || [];
    const [categories, bins] = await Promise.all([
      this.api('GET','/categories'),
      this.api('GET','/warehouse/bins'),
    ]);
    this.showModal(`
      <div class="modal" style="max-width:500px">
        <div class="modal-header">
          <span class="modal-title">New Cycle Count Session</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Branch / Location</label>
            <select id="cc-branch">
              <option value="">All Branches (Global)</option>
              ${branches.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Scope</label>
            <select id="cc-scope" onchange="App.toggleCcScope()">
              <option value="all">All Products</option>
              <option value="category">By Category</option>
              <option value="bin">By Bin</option>
            </select>
          </div>
          <div id="cc-scope-detail" style="display:none">
            <div class="form-group" id="cc-cat-grp"><label>Category</label>
              <select id="cc-cat">
                <option value="">Select…</option>
                ${categories.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" id="cc-bin-grp" style="display:none"><label>Bin</label>
              <select id="cc-bin">
                <option value="">Select…</option>
                ${bins.map(b=>`<option value="${b.id}">${b.bin_code}${b.zone_name?' — '+b.zone_name:''}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>Notes</label>
            <textarea id="cc-notes" rows="2" placeholder="Optional…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="cc-create-btn" onclick="App.saveCycleCount()">Create Session</button>
        </div>
      </div>`);
  },

  toggleCcScope() {
    const scope  = document.getElementById('cc-scope')?.value;
    const detail = document.getElementById('cc-scope-detail');
    if (!detail) return;
    if (scope==='all') { detail.style.display='none'; return; }
    detail.style.display='';
    document.getElementById('cc-cat-grp').style.display = scope==='category'?'':'none';
    document.getElementById('cc-bin-grp').style.display = scope==='bin'?'':'none';
  },

  async saveCycleCount() {
    const scope = document.getElementById('cc-scope').value;
    let scope_id = null;
    if (scope==='category') scope_id = document.getElementById('cc-cat').value||null;
    if (scope==='bin')      scope_id = document.getElementById('cc-bin').value||null;
    const data = {
      branch_id:  document.getElementById('cc-branch').value||null,
      scope_type: scope,
      scope_id,
      notes: document.getElementById('cc-notes').value.trim()||null,
    };
    const btn = document.getElementById('cc-create-btn');
    if (btn?.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    try {
      const session = await this.api('POST','/warehouse/cycle-counts',data);
      this.alert('Session created');
      this.closeModal();
      this.viewCycleCount(session.id);
    } catch(e) {
      this.alert(e.message,'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Create Session'; }
    }
  },

  async viewCycleCount(id) {
    const session = await this.api('GET',`/warehouse/cycle-counts/${id}`);
    const el = document.getElementById('cc-content');
    if (!el) return;
    const sc = { open:'badge-secondary', review:'badge-info', committed:'badge-success' };
    const counted   = session.items.filter(i=>i.counted_qty!==null).length;
    const variances = session.items.filter(i=>i.counted_qty!==null&&i.variance!==0).length;
    const uncounted = session.items.length - counted;
    // Uncounted lines can be committed as 0 (see commitCycleCount), so a
    // session with nothing counted-and-different may still have work to commit.
    const canCommit = session.status!=='committed' && (variances>0 || uncounted>0);
    this._ccSession = session;
    const uploads = session.uploads || [];

    el.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
        <button class="btn btn-sm btn-outline" onclick="App.loadCycleCounts()">← Back</button>
        <strong style="font-size:16px">${session.session_number}</strong>
        <span class="badge ${sc[session.status]||'badge-secondary'}">${session.status}</span>
        <span style="color:var(--text-muted);font-size:13px">${session.branch_name||'All Branches'} &bull; ${session.scope_type}</span>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-sm btn-outline" href="/api/warehouse/cycle-counts/${session.id}/export" download>⬇ Export CSV</a>
          ${session.status!=='committed'?`<label class="btn btn-sm btn-primary" style="cursor:pointer;margin:0" title="Import a scanner file (CSV or Excel). Each scanner's file can be imported separately — counts for the same item are added together.">⬆ Import Counts<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App.importCycleCountFile(${session.id},this)"></label>`:''}
          ${canCommit?`<button class="btn btn-sm btn-success" onclick="App.commitCycleCount(${session.id})">✓ Commit Adjustments</button>`:''}
        </div>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
        <div class="stat-card blue"><div class="stat-label">Total Lines</div><div class="stat-value">${session.items.length}</div></div>
        <div class="stat-card green"><div class="stat-label">Counted</div><div class="stat-value">${counted}</div></div>
        <div class="stat-card ${variances>0?'orange':'green'}"><div class="stat-label">Variances</div><div class="stat-value">${variances}</div></div>
        <div class="stat-card ${session.status==='committed'?'green':'purple'}"><div class="stat-label">Status</div><div class="stat-value" style="font-size:14px">${session.status}</div></div>
      </div>
      ${uploads.length?`
      <div class="card" style="margin-bottom:16px;padding:12px">
        <div style="font-weight:600;margin-bottom:8px">Imports (${uploads.filter(u=>!u.undone_at).length} active)</div>
        <table class="table" style="font-size:12px;margin:0">
          <thead><tr><th>#</th><th>Scanner / Counter</th><th>File</th><th>Mode</th><th style="text-align:right">Lines</th><th style="text-align:right">Total Qty</th><th>By</th><th>When</th><th></th></tr></thead>
          <tbody>${uploads.map(u=>`<tr style="${u.undone_at?'opacity:.5;text-decoration:line-through':''}">
            <td>${u.id}</td>
            <td>${this.escapeAttr(u.device_label||'—')}</td>
            <td>${this.escapeAttr(u.file_name||'—')}</td>
            <td>${u.mode==='add'?'Added':'Replaced'}</td>
            <td style="text-align:right">${u.line_count}</td>
            <td style="text-align:right">${u.total_qty}</td>
            <td>${this.escapeAttr(u.employee_name||'—')}</td>
            <td>${this.fmtDateTime(u.created_at)}</td>
            <td style="text-decoration:none">${u.undone_at?'Undone':session.status!=='committed'?`<button class="btn btn-sm btn-outline" onclick="App.undoCycleCountUpload(${session.id},${u.id})">Undo</button>`:''}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`:''}
      <table class="table" style="font-size:13px">
        <thead><tr>
          <th>SKU</th><th>Product</th><th>Category</th><th>Bin</th>
          <th style="text-align:right" title="System on-hand when the line was counted (when its count was imported or saved)">Expected</th>
          <th style="text-align:right">Counted</th>
          <th style="text-align:right">Variance</th>
        </tr></thead>
        <tbody>${session.items.map(i=>{
          const vStyle = i.variance>0?'color:#4caf50;font-weight:700':i.variance<0?'color:#f44336;font-weight:700':'';
          const editable = session.status!=='committed';
          return `<tr>
            <td><span class="badge badge-secondary">${i.sku}</span></td>
            <td>${i.product_name}</td>
            <td style="color:var(--text-muted)">${i.category_name||'—'}</td>
            <td>${i.bin_code||'—'}</td>
            <td style="text-align:right">${i.expected_at_count!=null&&Number(i.expected_at_count)!==Number(i.expected_qty)
              ?`<span title="On hand when this line was counted. It was ${i.expected_qty} when the count was created — stock moved in between, so the variance is measured against ${i.expected_at_count}." style="border-bottom:1px dotted var(--text-muted);cursor:help">${i.expected_at_count}</span>`
              :i.expected_qty}</td>
            <td style="text-align:right">${editable
              ?`<input type="number" min="0" value="${i.counted_qty!==null?i.counted_qty:''}" data-item-id="${i.id}" data-orig="${i.counted_qty!==null?i.counted_qty:''}"
                  style="width:70px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px;text-align:right"
                  placeholder="—">`
              :i.counted_qty!==null?i.counted_qty:'—'}</td>
            <td style="text-align:right;${vStyle}">${i.counted_qty!==null?(i.variance>0?'+':'')+i.variance:'—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      ${session.status!=='committed'?`
        <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
          <button class="btn btn-primary" onclick="App.saveCycleCountEdits(${session.id})">Save Counts</button>
          ${canCommit?`<button class="btn btn-success" onclick="App.commitCycleCount(${session.id})">Commit Adjustments</button>`:''}
        </div>`:''}`;
  },

  async saveCycleCountEdits(sessionId) {
    // Only lines whose box was changed — re-sending every count would pin
    // them all as manual entries, so undoing a scanner import later would
    // no longer take its counts back out.
    const items = [];
    document.querySelectorAll('[data-item-id]').forEach(inp => {
      const val = inp.value.trim();
      if (val!=='' && val!==inp.dataset.orig) items.push({ item_id: parseInt(inp.dataset.itemId), counted_qty: val });
    });
    if (!items.length) return this.alert('No changed counts to save','error');
    try {
      await this.api('POST',`/warehouse/cycle-counts/${sessionId}/import`,{ items, mode: 'replace', device_label: 'Entered on screen' });
      this.alert(`Saved ${items.length} count${items.length!==1?'s':''}`);
      this.viewCycleCount(sessionId);
    } catch(e) { this.alert(e.message,'error'); }
  },

  // Reads a scanner file (CSV, or Excel via _readImportFile — which also
  // handles quoted commas in product names) and shows what it matched before
  // anything is saved. Columns are found by header name, so the session's own
  // export (Item ID … Counted Qty) and a plain SKU/barcode + qty file both work.
  async importCycleCountFile(sessionId, inputEl) {
    const file = inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); }
    catch(e) { return this.alert(e.message,'error'); }
    const norm = h => String(h).toLowerCase().replace(/[^a-z0-9]/g,'');
    const find = names => parsed.headers.find(h => names.includes(norm(h)));
    const col = {
      item_id:     find(['itemid']),
      sku:         find(['sku','itemcode','productcode','itemnumber','partnumber']),
      barcode:     find(['barcode','upc','ean']),
      bin_code:    find(['bincode','bin','binlocation']),
      counted_qty: find(['countedqty','counted','count','qty','quantity','countqty']),
    };
    if (!col.counted_qty) return this.alert('The file needs a "Counted Qty" (or "Qty") column','error');
    if (!col.item_id && !col.sku && !col.barcode) return this.alert('The file needs an "Item ID", "SKU" or "Barcode" column','error');
    const rows = parsed.rows.map((r,i) => {
      const row = { line: i+2 };
      for (const k of Object.keys(col)) if (col[k]) row[k] = r[col[k]];
      return row;
    });
    if (!rows.length) return this.alert('No rows found in the file','error');
    let summary;
    try { summary = await this.api('POST',`/warehouse/cycle-counts/${sessionId}/import`,{ rows, dry_run: true }); }
    catch(e) { return this.alert(e.message,'error'); }
    this._ccImport = { sessionId, fileName: file.name, rows };

    let lastDevice = '';
    try { lastDevice = localStorage.getItem('pos_cc_device') || ''; } catch(e) {}
    const um = summary.unmatched || [];
    this.showModal(`
      <div class="modal" style="max-width:620px">
        <div class="modal-header"><span class="modal-title">Import Counts — ${this.escapeAttr(file.name)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="margin:0 0 10px"><strong>${summary.matched_rows}</strong> row${summary.matched_rows!==1?'s':''} matched to <strong>${summary.matched_items}</strong> count line${summary.matched_items!==1?'s':''}, total quantity <strong>${summary.total_qty}</strong>.${summary.skipped_blank?` <span style="color:var(--text-muted)">${summary.skipped_blank} row${summary.skipped_blank!==1?'s':''} with a blank Counted Qty skipped.</span>`:''}</p>
          ${um.length?`<div style="border:1px solid #f44336;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:12px;max-height:180px;overflow:auto">
            <strong style="color:#f44336">${um.length} row${um.length!==1?'s':''} won't be imported:</strong>
            <ul style="margin:6px 0 0;padding-left:18px">${um.slice(0,100).map(u=>`<li>Row ${u.line} — ${this.escapeAttr(u.ref)}: ${this.escapeAttr(u.reason)}</li>`).join('')}${um.length>100?`<li>…and ${um.length-100} more</li>`:''}</ul>
          </div>`:''}
          ${summary.duplicate_of?`<div style="border:1px solid #d97706;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:12px;color:#d97706"><strong>Already imported?</strong> These counts are identical to import #${summary.duplicate_of.id}${summary.duplicate_of.device_label?` (${this.escapeAttr(summary.duplicate_of.device_label)})`:''}. Adding them again would double them.</div>`:''}
          <div class="form-group"><label>Scanner / Counter</label><input id="cc-imp-device" value="${this.escapeAttr(lastDevice)}" placeholder="e.g. Scanner 2 — Aisles 5-8"></div>
          <div class="form-group" style="margin-bottom:0">
            <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;text-transform:none;margin-bottom:6px"><input type="radio" name="cc-imp-mode" value="add" checked style="margin-top:3px;width:auto;flex:0 0 auto"> <span style="text-align:left"><strong>Add to existing counts</strong> — use for each scanner's file. If an item was counted in several places, the quantities are added together.</span></label>
            <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;text-transform:none"><input type="radio" name="cc-imp-mode" value="replace" style="margin-top:3px;width:auto;flex:0 0 auto"> <span style="text-align:left"><strong>Replace counts</strong> for the items in this file — use for a recount.</span></label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" ${summary.matched_items?'':'disabled'} onclick="App._confirmCycleCountImport()">Import ${summary.matched_items} Count${summary.matched_items!==1?'s':''}</button>
        </div>
      </div>`);
  },

  async _confirmCycleCountImport(allowDuplicate) {
    const imp = this._ccImport;
    if (!imp) return;
    const device_label = document.getElementById('cc-imp-device')?.value.trim() || '';
    const mode = document.querySelector('input[name="cc-imp-mode"]:checked')?.value || 'add';
    try { localStorage.setItem('pos_cc_device', device_label); } catch(e) {}
    try {
      const r = await this.api('POST',`/warehouse/cycle-counts/${imp.sessionId}/import`,{ rows: imp.rows, mode, device_label, file_name: imp.fileName, allow_duplicate: !!allowDuplicate });
      this.closeModal();
      this._ccImport = null;
      this.alert(`Imported ${r.matched_items} count${r.matched_items!==1?'s':''} (total qty ${r.total_qty})${r.unmatched.length?` — ${r.unmatched.length} row${r.unmatched.length!==1?'s':''} skipped`:''}`, r.unmatched.length?'warning':'success');
      this.viewCycleCount(imp.sessionId);
    } catch(e) {
      if (/adding them again would double/.test(e.message) && confirm(`${e.message}.\n\nImport it anyway?`)) return this._confirmCycleCountImport(true);
      this.alert(e.message,'error');
    }
  },

  async undoCycleCountUpload(sessionId, uploadId) {
    if (!confirm(`Undo import #${uploadId}? Its counts are taken back out; other imports are kept.`)) return;
    try {
      await this.api('POST',`/warehouse/cycle-counts/${sessionId}/uploads/${uploadId}/undo`,{});
      this.alert(`Import #${uploadId} undone`);
      this.viewCycleCount(sessionId);
    } catch(e) { this.alert(e.message,'error'); }
  },

  commitCycleCount(sessionId) {
    const s = this._ccSession;
    if (!s || s.id!==sessionId) return;
    const counted = s.items.filter(i=>i.counted_qty!==null);
    const variances = counted.filter(i=>i.variance!==0).length;
    const uncounted = s.items.length - counted.length;
    const uncountedWithStock = s.items.filter(i=>i.counted_qty===null && i.expected_qty!==0).length; // as of creation; commit zeroes against today's on-hand
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">Commit ${s.session_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="margin:0 0 10px">${variances} counted line${variances!==1?'s':''} differ${variances===1?'s':''} from expected and will be adjusted.</p>
          ${uncounted?`<label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;text-transform:none;border:1px solid var(--border);border-radius:6px;padding:8px 10px">
            <input type="checkbox" id="cc-zero-uncounted" style="margin-top:3px;width:auto;flex:0 0 auto" onchange="document.getElementById('cc-commit-total').textContent=${variances}+(this.checked?${uncountedWithStock}:0)">
            <span style="text-align:left"><strong>Count the ${uncounted} uncounted line${uncounted!==1?'s':''} as 0</strong> — tick for a full or initial count, where anything not scanned wasn't found. ${uncountedWithStock} of them currently expect stock. Leave unticked to leave them unchanged.</span>
          </label>`:''}
          <p style="margin:12px 0 0"><strong>Adjustments to apply: <span id="cc-commit-total">${variances}</span></strong>. This can't be undone.</p>
          <p style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">Each variance is measured against the on-hand when that line's count was imported or saved, and added to today's stock — sales, receipts and transfers since then are kept.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" onclick="App._confirmCommitCycleCount(${sessionId})">Commit</button>
        </div>
      </div>`);
  },

  async _confirmCommitCycleCount(sessionId) {
    const zero_uncounted = !!document.getElementById('cc-zero-uncounted')?.checked;
    try {
      await this.api('PATCH',`/warehouse/cycle-counts/${sessionId}/commit`,{ zero_uncounted });
      this.closeModal();
      this.alert('Adjustments committed to inventory');
      this.viewCycleCount(sessionId);
    } catch(e) { this.alert(e.message,'error'); }
  },

});
