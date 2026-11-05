// Customers → Assign Salespeople: tick from a list or upload a sheet, review, apply, undo.
Object.assign(App, {
  async renderCustomerAssign() {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
    const [people, categories] = await Promise.all([
      this.api('GET', '/sales-targets/salespeople').catch(() => []),
      this.api('GET', '/customer-categories').catch(() => []),
    ]);
    if (this.section !== 'customers') return;
    const esc = v => this.escapeAttr(v ?? '');
    const options = people.map(p => `<option value="${p.id}">${esc(`${p.first_name} ${p.last_name}`.trim())}</option>`).join('');
    this._csa = { people, selected: new Set(), allMatching: false, total: 0, shown: 0, seq: 0, loading: false };
    c.innerHTML = `
      <div class="section-header" style="gap:16px;flex-wrap:wrap">
        <h2>Assign Salespeople</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-secondary btn-sm" onclick="App.renderCustomers()">← Customers</button>
          <button class="btn btn-secondary btn-sm" onclick="App.showCustomerAssignHistory()">History</button>
          <button class="btn btn-secondary btn-sm" onclick="App._csaDownload()" title="Customers matching the filters below, with their salesperson. Edit it and upload it again.">⬇ Download Sheet</button>
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0;text-transform:none;letter-spacing:normal" title="A CSV or Excel file with a customer number or name, and a Salesperson column">⬆ Upload Sheet<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App._csaUploadFile(this)"></label>
        </div>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:-6px 0 12px">A customer's new POS sales, rentals, work orders and layaways go to their salesperson. Past sales aren't changed.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <input type="text" id="csa-search" placeholder="Search name, number, phone or email…" style="flex:1 1 260px;max-width:380px">
        <select id="csa-type" style="width:auto"><option value="">All Types</option><option value="credit">Credit</option><option value="cash">Cash</option></select>
        <select id="csa-category" style="width:auto"><option value="">All Categories</option>${categories.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select>
        <select id="csa-current" style="width:auto"><option value="">Any Salesperson</option><option value="none">No Salesperson</option>${options}</select>
        <span id="csa-count" style="font-size:13px;color:var(--text-muted);margin-left:auto"></span>
      </div>
      <div class="card" style="padding:10px 14px;margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <strong id="csa-selected" style="font-size:13px">0 selected</strong>
        <button class="btn btn-outline btn-sm" id="csa-all" style="display:none" onclick="App._csaSelectAllMatching()"></button>
        <button class="btn btn-outline btn-sm" id="csa-clear" style="display:none" onclick="App._csaClear()">Clear</button>
        <span style="margin-left:auto;font-size:13px">Assign to</span>
        <select id="csa-to" style="width:auto"><option value="">Choose…</option>${options}<option value="none">None (remove)</option></select>
        <button class="btn btn-primary btn-sm" onclick="App._csaReview()">Review</button>
      </div>
      <div class="card"><div class="table-wrap" id="csa-table" style="max-height:60vh;overflow-y:auto" onscroll="if(this.scrollTop+this.clientHeight>=this.scrollHeight-400)App._csaMore()"></div></div>`;
    let timer;
    const search = document.getElementById('csa-search');
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this._csaLoad(), 250); });
    for (const id of ['csa-type', 'csa-category', 'csa-current']) document.getElementById(id).addEventListener('change', () => this._csaLoad());
    await this._csaLoad();
  },

  _csaFilter() {
    const val = id => document.getElementById(id)?.value || '';
    return { search: val('csa-search').trim(), type: val('csa-type'), category_id: val('csa-category'), salesperson_id: val('csa-current') };
  },

  _csaQueryString(filter = this._csaFilter()) {
    return Object.entries(filter).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  },

  // Changing the filters starts a new selection, so nothing out of sight stays ticked.
  async _csaLoad() {
    const s = this._csa;
    const seq = ++s.seq;
    s.selected = new Set(); s.allMatching = false;
    const { rows, total } = await this.api('GET', `/customers?active=1&paged=1&offset=0${this._csaQueryString()}`);
    if (seq !== s.seq || !document.getElementById('csa-table')) return;
    s.total = total; s.shown = rows.length;
    document.getElementById('csa-count').textContent = `${total.toLocaleString()} customer${total === 1 ? '' : 's'}`;
    document.getElementById('csa-table').innerHTML = !rows.length ? '<div class="empty-state"><p>No customers found</p></div>' : `<table class="sticky-table">
      <thead><tr><th style="width:36px"><input type="checkbox" id="csa-shown" style="width:auto" title="Tick everyone shown" onchange="App._csaToggleShown(this.checked)"></th><th>Customer #</th><th>Name</th><th>Type</th><th>Phone</th><th>City</th><th>Salesperson</th></tr></thead>
      <tbody id="csa-tbody">${this._csaRowsHtml(rows)}</tbody></table>`;
    this._csaPaint();
  },

  async _csaMore() {
    const s = this._csa;
    if (!s || s.loading || s.shown >= s.total) return;
    const seq = s.seq;
    s.loading = true;
    try {
      const { rows } = await this.api('GET', `/customers?active=1&paged=1&offset=${s.shown}${this._csaQueryString()}`);
      if (seq !== s.seq) return;
      s.shown = rows.length ? s.shown + rows.length : s.total;
      document.getElementById('csa-tbody')?.insertAdjacentHTML('beforeend', this._csaRowsHtml(rows));
    } finally { s.loading = false; }
  },

  _csaRowsHtml(rows) {
    const s = this._csa;
    const esc = v => this.escapeAttr(v ?? '');
    return rows.map(c => `<tr>
      <td><input type="checkbox" class="csa-row" data-id="${c.id}" style="width:auto" ${s.allMatching || s.selected.has(c.id) ? 'checked' : ''} ${s.allMatching ? 'disabled' : ''} onchange="App._csaToggle(${c.id},this.checked)"></td>
      <td style="font-family:monospace;font-size:12px">${esc(c.customer_number)}</td>
      <td class="fw-600">${esc(`${c.first_name || ''} ${c.last_name || ''}`.trim())}</td>
      <td>${esc(c.customer_type)}</td>
      <td>${esc(c.phone) || '—'}</td>
      <td style="color:var(--text-muted)">${esc(c.city) || '—'}</td>
      <td>${esc(this._csaPersonName(c.salesperson_id)) || '<span style="color:var(--text-muted)">—</span>'}</td>
    </tr>`).join('');
  },

  _csaPersonName(id) {
    if (!id) return '';
    const p = this._csa.people.find(x => x.id === id);
    return p ? `${p.first_name} ${p.last_name}`.trim() : `Employee #${id}`;
  },

  _csaToggle(id, on) {
    if (on) this._csa.selected.add(id); else this._csa.selected.delete(id);
    this._csaPaint();
  },

  _csaToggleShown(on) {
    document.querySelectorAll('.csa-row').forEach(box => {
      box.checked = on;
      const id = Number(box.dataset.id);
      if (on) this._csa.selected.add(id); else this._csa.selected.delete(id);
    });
    this._csaPaint();
  },

  _csaSelectAllMatching() {
    this._csa.allMatching = true;
    document.querySelectorAll('.csa-row').forEach(box => { box.checked = true; box.disabled = true; });
    this._csaPaint();
  },

  _csaClear() {
    const s = this._csa;
    s.selected = new Set(); s.allMatching = false;
    document.querySelectorAll('.csa-row').forEach(box => { box.checked = false; box.disabled = false; });
    const head = document.getElementById('csa-shown');
    if (head) { head.checked = false; head.disabled = false; }
    this._csaPaint();
  },

  _csaPaint() {
    const s = this._csa;
    const count = s.allMatching ? s.total : s.selected.size;
    document.getElementById('csa-selected').textContent = `${count.toLocaleString()} selected`;
    const all = document.getElementById('csa-all');
    const offerAll = !s.allMatching && s.total > 0 && s.selected.size > 0 && s.selected.size < s.total;
    all.style.display = offerAll ? '' : 'none';
    all.textContent = `Select all ${s.total.toLocaleString()} matching`;
    document.getElementById('csa-clear').style.display = count ? '' : 'none';
    const head = document.getElementById('csa-shown');
    if (head && s.allMatching) { head.checked = true; head.disabled = true; }
  },

  _csaReview() {
    const s = this._csa;
    const to = document.getElementById('csa-to').value;
    if (!s.allMatching && !s.selected.size) return this.alert('Tick at least one customer', 'error');
    if (!to) return this.alert('Choose who to assign them to', 'error');
    const body = { salesperson_id: to };
    if (s.allMatching) body.filter = this._csaFilter(); else body.customer_ids = [...s.selected];
    return this._csaPreview(body);
  },

  async _csaUploadFile(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); } catch (e) { return this.alert(e.message, 'error'); }
    const norm = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
    const find = names => parsed.headers.find(h => names.includes(norm(h)));
    const numberCol = find(['customernumber', 'customerno', 'customer', 'accountnumber', 'account', 'number']);
    const nameCol = find(['customername', 'name']);
    const personCol = find(['salesperson', 'salesrep', 'rep', 'assignedto']);
    if (!numberCol && !nameCol) return this.alert('The file needs a "Customer Number" or "Customer Name" column', 'error');
    if (!personCol) return this.alert('The file needs a "Salesperson" column', 'error');
    const rows = parsed.rows.map((r, i) => ({ line: i + 2, customer: (numberCol && r[numberCol]) || (nameCol && r[nameCol]) || '', salesperson: r[personCol] }));
    if (!rows.length) return this.alert('No rows found in the file', 'error');
    return this._csaPreview({ rows, file_name: file.name });
  },

  async _csaPreview(body) {
    let p;
    try { p = await this.api('POST', '/customer-salespeople/preview', body); }
    catch (e) { return this.alert(e.message, 'error'); }
    this._csaPending = { ...body, expected_changes: p.changes };
    const esc = v => this.escapeAttr(v ?? '');
    const list = (title, rows, count, line, open) => !count ? '' : `<details ${open ? 'open' : ''} style="margin-top:8px;font-size:12px"><summary style="cursor:pointer">${title} (${count.toLocaleString()})</summary>
      <ul style="margin:6px 0 0;padding-left:18px;max-height:160px;overflow:auto">${rows.map(r => `<li>${line(r)}</li>`).join('')}${count > rows.length ? `<li>…and ${(count - rows.length).toLocaleString()} more</li>` : ''}</ul></details>`;
    const who = r => `${esc(r.name)} <span style="color:var(--text-muted)">${esc(r.number)}</span>`;
    const row = (label, n) => `<tr><td>${label}</td><td style="text-align:right;font-weight:600">${n.toLocaleString()}</td></tr>`;
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">Review Assignments${body.file_name ? ` — ${esc(body.file_name)}` : ''}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <table style="width:100%;font-size:13px"><tbody>
            ${row('New assignments', p.assign)}
            ${row('Moving from another salesperson', p.move)}
            ${row('Assignment removed', p.remove)}
            ${p.kept ? row('Already with another salesperson, staying there', p.kept) : ''}
            ${row('Already assigned to that person, no change', p.unchanged)}
            ${p.blank ? row('Salesperson left blank, no change', p.blank) : ''}
            ${p.unmatched_count ? row('<span style="color:#f44336">Can\'t be used</span>', p.unmatched_count) : ''}
          </tbody></table>
          ${list('Can\'t be used', p.unmatched, p.unmatched_count, u => `Row ${u.line} — ${esc(u.ref)}: ${esc(u.reason)}`, true)}
          ${list('Moving', p.lists.move, p.move, r => `${who(r)}: ${esc(r.from_name)} → ${esc(r.to_name)}`, true)}
          ${list('Staying with their current salesperson', p.lists.kept, p.kept, r => `${who(r)}: stays with ${esc(r.from_name)}, not ${esc(r.to_name)}`)}
          ${list('New assignments', p.lists.assign, p.assign, r => `${who(r)} → ${esc(r.to_name)}`)}
          ${list('Removed', p.lists.remove, p.remove, r => `${who(r)}: was ${esc(r.from_name)}`)}
          ${p.kept || p.move ? `<label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;text-transform:none;margin-top:12px"><input type="checkbox" id="csa-replace" style="width:auto;margin-top:3px" ${body.replace ? 'checked' : ''} onchange="App._csaToggleReplace(this.checked)"><span><strong>Replace existing assignments</strong> — move customers who already have a different salesperson.</span></label>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="csa-apply" ${p.changes ? '' : 'disabled'} onclick="App._csaApply()">Apply ${p.changes.toLocaleString()} Change${p.changes === 1 ? '' : 's'}</button>
        </div>
      </div>`);
  },

  _csaToggleReplace(on) {
    const { expected_changes, ...body } = this._csaPending;
    return this._csaPreview({ ...body, replace: on });
  },

  async _csaApply() {
    const btn = document.getElementById('csa-apply');
    if (btn) btn.disabled = true;
    try {
      const r = await this.api('POST', '/customer-salespeople/apply', this._csaPending);
      this.closeModal();
      this.alert(`${r.changes.toLocaleString()} customer${r.changes === 1 ? '' : 's'} updated. You can undo this from History.`);
      await this._csaLoad();
    } catch (e) {
      if (btn) btn.disabled = false;
      this.alert(e.message, 'error');
    }
  },

  _csaDownload() {
    window.location.href = `/api/customer-salespeople/export?x=1${this._csaQueryString()}`;
  },

  async showCustomerAssignHistory() {
    const batches = await this.api('GET', '/customer-salespeople/batches');
    const esc = v => this.escapeAttr(v ?? '');
    const source = b => b.source === 'file' ? `Sheet: ${esc(b.file_name)}` : b.source === 'form' ? 'Customer form' : 'List';
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">Assignment History</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${!batches.length ? '<div class="empty-state"><p>No assignments yet.</p></div>' : `<div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Source</th><th>By</th><th style="text-align:right">Customers</th><th></th></tr></thead>
            <tbody>${batches.map(b => `<tr>
              <td style="white-space:nowrap">${this.fmtDateTime(b.created_at)}</td>
              <td>${source(b)}</td>
              <td>${esc(b.employee_name) || '—'}</td>
              <td style="text-align:right">${Number(b.change_count).toLocaleString()}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn btn-outline btn-sm" onclick="App._csaBatchDetail(${b.id})">View</button>
                ${b.undone_at ? `<span style="font-size:12px;color:var(--text-muted)" title="${esc(b.undone_by_name)}">Undone</span>` : `<button class="btn btn-secondary btn-sm" onclick="App._csaUndoBatch(${b.id},${b.change_count})">Undo</button>`}
              </td></tr>`).join('')}</tbody></table></div>`}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  async _csaBatchDetail(id) {
    const rows = await this.api('GET', `/customer-salespeople/batches/${id}`);
    const esc = v => this.escapeAttr(v ?? '');
    this.showModal(`
      <div class="modal" style="max-width:700px">
        <div class="modal-header"><span class="modal-title">Assignment Changes</span><button class="modal-close">✕</button></div>
        <div class="modal-body"><div class="table-wrap" style="max-height:60vh;overflow:auto"><table>
          <thead><tr><th>Customer #</th><th>Customer</th><th>From</th><th>To</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td style="font-family:monospace;font-size:12px">${esc(r.customer_number)}</td><td>${esc(r.customer_name)}</td><td>${esc(r.old_name) || '—'}</td><td>${esc(r.new_name) || '—'}</td></tr>`).join('')}</tbody>
        </table></div>${rows.length >= 500 ? '<p style="font-size:12px;color:var(--text-muted)">Showing the first 500.</p>' : ''}</div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.showCustomerAssignHistory()">Back</button></div>
      </div>`);
  },

  async _csaUndoBatch(id, count) {
    if (!confirm(`Put these ${Number(count).toLocaleString()} customer(s) back to the salesperson they had before? Any changed again since are left as they are. Sales already made aren't changed.`)) return;
    try {
      const r = await this.api('POST', `/customer-salespeople/batches/${id}/undo`, {});
      this.alert(`${r.restored.toLocaleString()} put back${r.skipped ? `, ${r.skipped.toLocaleString()} left because they changed again since` : ''}`);
      await this.showCustomerAssignHistory();
      if (document.getElementById('csa-table')) await this._csaLoad();
    } catch (e) { this.alert(e.message, 'error'); }
  },
});
