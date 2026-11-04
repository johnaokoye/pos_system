// Branches and assessment badges.
Object.assign(App, {
  // ─── Branches ─────────────────────────────────────────────
  async renderBranches() {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const branches = await this.api('GET', '/branches?include_inactive=1');
    if (this.section !== 'branches') return;
    c.innerHTML = `
      <div class="section-header">
        <h2>Branch Management</h2>
        <button class="btn btn-primary" onclick="App.showBranchForm()">+ Add Branch</button>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Branch Name</th><th>Location</th><th>Phone</th><th>Manager</th><th>Currency</th><th>Price Tier</th><th>Employees</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              ${branches.length ? branches.map(b => `
                <tr>
                  <td class="fw-600">${b.branch_code}</td>
                  <td class="fw-600">${b.name}</td>
                  <td>${[b.city, b.state].filter(Boolean).join(', ') || '-'}</td>
                  <td>${b.phone||'-'}</td>
                  <td>${b.manager||'-'}</td>
                  <td>${b.currency ? `<span class="badge-pill badge-purple">${b.currency}</span>` : '<span style="color:var(--text-muted);font-size:12px">Global</span>'}</td>
                  <td>${b.price_tier_percent ? `<span class="badge-pill ${b.price_tier_percent > 0 ? 'badge-info' : 'badge-warning'}">${b.price_tier_percent > 0 ? '+' : ''}${b.price_tier_percent}%</span>` : '<span style="color:var(--text-muted);font-size:12px">—</span>'}</td>
                  <td><span class="badge-pill badge-info">${b.employee_count} staff</span></td>
                  <td><span class="badge-pill ${b.active ? 'badge-success' : 'badge-danger'}">${b.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <button class="btn btn-sm btn-secondary" onclick="App.showBranchForm(${b.id})">Edit</button>
                    <button class="btn btn-sm btn-outline" onclick="App.manageBranchStaff(${b.id})">Staff</button>
                  </td>
                </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No branches configured</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  async showBranchForm(id) {
    let b = {};
    if (id) b = await this.api('GET', `/branches/${id}`);
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit' : 'New'} Branch</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>Branch Name *</label><input id="bf-name" value="${this.escapeAttr(b.name)}"></div>
            <div class="form-group"><label>Manager</label><input id="bf-manager" value="${b.manager||''}"></div>
          </div>
          <div class="form-group"><label>Address</label><input id="bf-addr" value="${b.address||''}"></div>
          <div class="input-row-3">
            <div class="form-group"><label>City</label><input id="bf-city" value="${b.city||''}"></div>
            <div class="form-group"><label>State</label><input id="bf-state" value="${b.state||''}"></div>
            <div class="form-group"><label>ZIP</label><input id="bf-zip" value="${b.zip||''}"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Phone</label><input id="bf-phone" value="${b.phone||''}"></div>
            <div class="form-group"><label>Email</label><input id="bf-email" value="${b.email||''}"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Currency <span style="color:var(--text-muted);font-weight:400;font-size:11px">(leave blank to use global default)</span></label>
              <select id="bf-currency">${this.currencyOptions(b.currency||'', true)}</select>
            </div>
            <div class="form-group"><label>Price Tier % <span style="color:var(--text-muted);font-weight:400;font-size:11px">(+/- adjusts every retail item's price at this branch)</span></label>
              <input id="bf-price-tier" type="number" step="0.01" value="${b.price_tier_percent || 0}">
            </div>
          </div>
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-weight:normal;font-size:13px;text-transform:none;margin:4px 0 12px">
            <input type="checkbox" id="bf-closed-grace" ${b.closed_day_grace ? 'checked' : ''} style="width:16px;height:16px;margin-top:2px;flex-shrink:0">
            <span><strong>Closed on Sundays &amp; public holidays</strong><br><span style="color:var(--text-muted);font-size:12px">A rental due back on a closed day can be returned by ${this.escapeAttr((this.settings && this.settings.closed_day_return_by) || '08:00')} the next open day with no late charge. Holidays are listed in Settings → Rental Returns.</span></span>
          </label>
          <div class="input-row">
            ${id ? `<div class="form-group"><label>Status</label><select id="bf-active"><option value="1" ${b.active?'selected':''}>Active</option><option value="0" ${!b.active?'selected':''}>Inactive</option></select></div>` : '<div class="form-group"></div>'}
            <div class="form-group"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveBranch(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveBranch(id) {
    const data = {
      name: document.getElementById('bf-name').value.trim(),
      manager: document.getElementById('bf-manager').value.trim(),
      address: document.getElementById('bf-addr').value.trim(),
      city: document.getElementById('bf-city').value.trim(),
      state: document.getElementById('bf-state').value.trim(),
      zip: document.getElementById('bf-zip').value.trim(),
      phone: document.getElementById('bf-phone').value.trim(),
      email: document.getElementById('bf-email').value.trim(),
      currency: document.getElementById('bf-currency').value || null,
      price_tier_percent: parseFloat(document.getElementById('bf-price-tier').value) || 0,
      closed_day_grace: document.getElementById('bf-closed-grace').checked ? 1 : 0,
    };
    if (id) data.active = parseInt(document.getElementById('bf-active').value);
    if (!data.name) { this.alert('Branch name required', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/branches/${id}`, data);
      else await this.api('POST', '/branches', data);
      this.closeModal();
      this.alert('Branch saved');
      this.renderBranches();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async manageBranchStaff(branchId) {
    const [branch, available] = await Promise.all([
      this.api('GET', `/branches/${branchId}`),
      this.api('GET', `/branches/${branchId}/available-employees`),
    ]);
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">Staff - ${branch.name}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="card-header"><span class="card-title">Assigned Staff</span></div>
          <div class="table-wrap" style="margin-bottom:16px">
            <table>
              <thead><tr><th>Employee</th><th>Security Group</th><th>Default</th><th></th></tr></thead>
              <tbody id="branch-staff">
                ${branch.employees.length ? branch.employees.map(e => `
                  <tr id="bstaff-${e.id}">
                    <td class="fw-600">${e.first_name} ${e.last_name} <small style="color:var(--text-muted)">(${e.username})</small></td>
                    <td>${e.security_group_name ? `<span class="badge-pill badge-purple">${e.security_group_name}</span>` : '<span style="color:var(--text-muted)">None</span>'}</td>
                    <td>${e.is_default ? '<span class="badge-pill badge-success">Default</span>' : '-'}</td>
                    <td><button class="btn btn-sm btn-danger" onclick="App.removeFromBranch(${branchId},${e.id})">Remove</button></td>
                  </tr>`).join('') : '<tr><td colspan="4" class="empty-state">No staff assigned</td></tr>'}
              </tbody>
            </table>
          </div>
          ${available.length ? `
            <div class="card-header"><span class="card-title">Add Staff</span></div>
            <div class="input-row" style="align-items:flex-end">
              <div class="form-group" style="flex:1"><label>Employee</label>
                <select id="add-emp-sel">
                  ${available.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name} (${e.username})</option>`).join('')}
                </select>
              </div>
              <button class="btn btn-primary" style="margin-bottom:14px" onclick="App.addToBranch(${branchId})">Assign</button>
            </div>` : '<p style="font-size:13px;color:var(--text-muted)">All employees are already assigned to this branch.</p>'}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Done</button></div>
      </div>`);
  },

  async addToBranch(branchId) {
    const emp_id = document.getElementById('add-emp-sel').value;
    if (!emp_id) return;
    try {
      await this.api('POST', `/branches/${branchId}/employees`, { employee_id: emp_id });
      this.alert('Employee assigned');
      this.manageBranchStaff(branchId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async removeFromBranch(branchId, empId) {
    try {
      await this.api('DELETE', `/branches/${branchId}/employees/${empId}`);
      document.getElementById(`bstaff-${empId}`)?.remove();
      this.alert('Employee removed from branch');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Admin > Assessment (training badges) ────────────────
  // Per-employee training progress: one badge per business process they've
  // taken all the way through at least once, gold trophy once every process
  // their security group gives them access to is done. All derived server-
  // side from real records — see routes/assessment.js for what "completed"
  // means for each process.
  // SVG paths (not emoji — tills without an emoji font render those as
  // empty boxes), keyed by routes/assessment.js process key.
  _asmtIcons: {
    pos_sale: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1.003 1.003 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
    return: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
    retail_quote: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    special_project: 'M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z',
    rental_agreement: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6l-3 3-4.3-4.3C.6 7.1 1 10.1 3 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.4-.4.4-1 0-1.4z',
    work_order: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z',
    layaway: 'M20 6h-2.18c.11-.31.18-.65.18-1a2.996 2.996 0 0 0-5.5-1.65l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v6z',
    account_payment: 'M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    drawer_close: 'M20 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V8h16v2zM6 14h2v2H6zm4 0h6v2h-6z',
    purchase_request: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    purchase_order: 'M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4l16-.02V7z',
    branch_transfer: 'M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
    cycle_count: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
  },
  _asmtTrophyPath: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 15.9V19H7v2h10v-2h-4v-3.1a5.01 5.01 0 0 0 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
  _asmtIcon(key, size = 22) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${this._asmtIcons[key] || this._asmtTrophyPath}"/></svg>`;
  },
  _asmtTrophy(size) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${this._asmtTrophyPath}"/></svg>`;
  },

  async renderAssessment() {
    const c = document.getElementById('content');
    if (!this._asmtView) this._asmtView = { since: '', search: '', filter: 'all' };
    if (!c.querySelector('#asmt-root')) c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try {
      data = await this.api('GET', `/assessment${this._asmtView.since ? `?since=${this._asmtView.since}` : ''}`);
    } catch (e) {
      if (this.section === 'assessment') c.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`;
      return;
    }
    if (this.section !== 'assessment') return;
    this._asmtData = data;
    const esc = v => this.escapeAttr(v);
    const staff = data.employees.filter(e => e.applicable_count > 0);
    const gold = staff.filter(e => e.gold).length;
    const earned = staff.reduce((n, e) => n + e.badges_earned, 0);
    const possible = staff.reduce((n, e) => n + e.applicable_count, 0);
    const avg = possible ? Math.round(earned / possible * 100) : 0;
    const v = this._asmtView;

    c.innerHTML = `<div id="asmt-root">
      <div class="section-header">
        <h2>Training Assessment</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          <input placeholder="Search staff…" value="${esc(v.search)}" style="width:180px;margin:0" oninput="App._asmtView.search=this.value;App._renderAssessmentCards()">
          <select style="width:auto;margin:0" onchange="App._asmtView.filter=this.value;App._renderAssessmentCards()">
            <option value="all" ${v.filter === 'all' ? 'selected' : ''}>All staff</option>
            <option value="training" ${v.filter === 'training' ? 'selected' : ''}>Still in training</option>
            <option value="gold" ${v.filter === 'gold' ? 'selected' : ''}>Gold trophy holders</option>
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);white-space:nowrap">Count from
            <input type="date" value="${esc(v.since)}" style="width:auto;margin:0" onchange="App._asmtView.since=this.value;App.renderAssessment()">
          </label>
          ${v.since ? `<button class="btn btn-sm btn-secondary" onclick="App._asmtView.since='';App.renderAssessment()">All time</button>` : ''}
        </div>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat-card"><div class="stat-label">Staff assessed</div><div class="stat-value">${staff.length}</div><div class="stat-sub">active employees</div></div>
        <div class="stat-card orange"><div class="stat-label">Gold trophies</div><div class="stat-value" style="display:flex;align-items:center;gap:6px"><span style="color:#d4a017;display:inline-flex">${this._asmtTrophy(24)}</span>${gold}</div><div class="stat-sub">completed every process</div></div>
        <div class="stat-card green"><div class="stat-label">Badges earned</div><div class="stat-value">${earned}</div><div class="stat-sub">of ${possible} possible</div></div>
        <div class="stat-card blue"><div class="stat-label">Average progress</div><div class="stat-value">${avg}%</div></div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:-6px 0 14px">
        A badge is earned the first time someone takes a process all the way to the end. Only processes their security group gives them access to count toward the gold trophy.
        ${v.since ? `Counting work finished on or after <strong>${esc(this.fmtDate(String(v.since).slice(0, 10)))}</strong>.` : 'Counting all history — set “Count from” to your training start date to assess only the training period.'}
        Click any badge to see the records behind it.
      </div>
      <div id="asmt-cards" class="asmt-grid"></div>
    </div>`;
    this._renderAssessmentCards();
  },

  _renderAssessmentCards() {
    const el = document.getElementById('asmt-cards');
    const data = this._asmtData;
    if (!el || !data) return;
    const esc = v => this.escapeAttr(v);
    const v = this._asmtView;
    const q = (v.search || '').toLowerCase();
    const rows = data.employees
      .filter(e => e.applicable_count > 0)
      .filter(e => !q || `${e.name} ${e.username} ${e.security_group_name || ''} ${e.branch_name || ''}`.toLowerCase().includes(q))
      .filter(e => v.filter === 'gold' ? e.gold : v.filter === 'training' ? !e.gold : true)
      .sort((a, b) => (b.gold - a.gold) || (b.badges_earned / b.applicable_count - a.badges_earned / a.applicable_count) || a.name.localeCompare(b.name));
    if (!rows.length) { el.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><p>No staff match these filters</p></div>'; return; }
    el.innerHTML = rows.map(e => {
      const pct = Math.round(e.badges_earned / e.applicable_count * 100);
      const applicable = data.processes.filter(p => e.results[p.key].applicable);
      const extra = data.processes.filter(p => !e.results[p.key].applicable && e.results[p.key].completed > 0);
      const badge = p => {
        const r = e.results[p.key];
        const state = r.completed > 0 ? 'done' : r.started > 0 ? 'progress' : 'todo';
        const count = r.completed > 0 ? r.completed : r.started > 0 ? r.started : 0;
        const tip = state === 'done' ? `${p.label}: completed ${r.completed}× — first ${this.fmtDate(this._utcDate(r.first_completed_at))}`
          : state === 'progress' ? `${p.label}: ${r.started} started, none finished yet` : `${p.label}: not attempted yet — ${p.description}`;
        return `<button class="asmt-badge ${state === 'done' ? '' : state}" title="${esc(tip)}" onclick="App.showAssessmentDetail(${e.id},'${p.key}')">
          <div class="medal">${this._asmtIcon(p.key)}${count ? `<span class="count">${count > 99 ? '99+' : count}</span>` : ''}</div>
          <div class="lbl">${esc(p.label)}</div>
        </button>`;
      };
      return `<div class="asmt-card ${e.gold ? 'gold' : ''}">
        <div class="asmt-head">
          <div>
            <div class="asmt-name">${esc(e.name)}</div>
            <div class="asmt-sub">${esc(e.username)} · ${esc(e.security_group_name || 'No group')}${e.branch_name ? ` · ${esc(e.branch_name)}` : ''}</div>
          </div>
          <div class="asmt-trophy ${e.gold ? '' : 'locked'}" title="${e.gold ? 'Gold trophy — every process completed' : `Gold trophy unlocks at ${e.applicable_count}/${e.applicable_count} badges`}">${this._asmtTrophy(36)}</div>
        </div>
        <div class="asmt-progress"><div style="width:${pct}%"></div></div>
        <div class="asmt-pct">${e.badges_earned} of ${e.applicable_count} badges · ${pct}%${e.gold ? ' · <strong style="color:#b8860b">Gold trophy earned</strong>' : ''}</div>
        <div class="asmt-badges">${applicable.map(badge).join('')}</div>
        ${extra.length ? `<div class="asmt-na">Also completed (outside their role): ${extra.map(p => esc(p.label)).join(', ')}</div>` : ''}
      </div>`;
    }).join('');
  },

  async showAssessmentDetail(employeeId, processKey) {
    const emp = this._asmtData?.employees.find(e => e.id === employeeId);
    const since = this._asmtView?.since;
    let data;
    try { data = await this.api('GET', `/assessment/${employeeId}/${processKey}${since ? `?since=${since}` : ''}`); }
    catch (e) { return this.alert(e.message, 'error'); }
    const esc = v => this.escapeAttr(v);
    const r = emp?.results[processKey] || {};
    const p = data.process;
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title" style="display:flex;align-items:center;gap:8px">${this._asmtIcon(p.key, 20)} ${esc(p.label)} — ${esc(emp?.name || '')}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;margin-bottom:10px"><strong>To earn this badge:</strong> ${esc(p.description)}</p>
          <p style="font-size:13px;margin-bottom:14px">${r.completed > 0
            ? `<span class="badge-pill badge-success">Earned</span> Completed ${r.completed}× — first on ${esc(this.fmtDate(this._utcDate(r.first_completed_at)))}, most recently ${esc(this.fmtDate(this._utcDate(r.last_completed_at)))}.`
            : r.started > 0 ? `<span class="badge-pill badge-warning">In progress</span> Started ${r.started}, none taken all the way through yet.`
            : '<span class="badge-pill" style="background:var(--bg);color:var(--text-muted)">Not attempted</span> No records yet.'}
            ${r.applicable === false ? '<br><span style="font-size:12px;color:var(--text-muted)">Their security group doesn’t include this process, so it doesn’t count toward their trophy.</span>' : ''}</p>
          <div class="table-wrap" style="max-height:50vh;overflow:auto">
            <table>
              <thead><tr><th>Reference</th><th>Status</th><th>Started</th><th>Completed</th></tr></thead>
              <tbody>${data.records.length ? data.records.map(x => `<tr>
                <td class="fw-600">${esc(x.ref)}</td>
                <td>${x.is_completed ? `<span class="badge-pill badge-success">${esc(String(x.status).replace(/_/g, ' '))}</span>` : `<span class="badge-pill badge-warning">${esc(String(x.status).replace(/_/g, ' '))}</span>`}</td>
                <td>${x.started_at ? esc(this.fmtDate(this._utcDate(x.started_at))) : '-'}</td>
                <td>${x.completed_at ? esc(this.fmtDate(this._utcDate(x.completed_at))) : '—'}</td>
              </tr>`).join('') : '<tr><td colspan="4" class="empty-state">No records</td></tr>'}</tbody>
            </table>
          </div>
          ${data.records.length === 50 ? '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">Showing the 50 most recent.</div>' : ''}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

});
