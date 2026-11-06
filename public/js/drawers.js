// Cash drawers, the POS drawer check, petty cash GL.
Object.assign(App, {
  // ─── CASH DRAWERS ─────────────────────────────────────────────────────────

  // Which drawer sessions the Cash Drawers screen shows and lets you close
  // and reconcile: 'all' (Reconcile All Drawers), 'own' (Close & Reconcile
  // Own Drawer) or null. Stored keys only — never inherited from the parent
  // drawers key every cashier holds. Mirrors drawerScope() in
  // lib/permissions.js.
  _drawerScope() {
    const p = this.currentUser?.permissions || {};
    return p.drawers_reconcile_all ? 'all' : p.drawers_close ? 'own' : null;
  },

  _canOpenDrawersScreen() {
    return !!this.currentUser?.permissions?.drawers_manage || !!this._drawerScope();
  },

  // Close / Reconcile on a session: anyone's with 'all', your own with 'own'.
  _canActOnDrawerSession(s) {
    const scope = this._drawerScope();
    return scope === 'all' || (scope === 'own' && s.employee_id == this.currentUser?.id);
  },

  async renderDrawers() {
    // Sessions needs a reconcile key; Manage Drawers (setup) needs drawers_manage.
    const tabs = [
      this._drawerScope() && { key: 'sessions', label: this._drawerScope() === 'all' ? 'Sessions' : 'My Sessions' },
      this.currentUser?.permissions?.drawers_manage && { key: 'manage', label: 'Manage Drawers' },
      this._pettyGlCanSee() && { key: 'petty-gl', label: 'Petty Cash Accounts' },
    ].filter(Boolean);
    this._drawerTabs = tabs.map(t => t.key);
    if (!this._drawerTabs.includes(this.drawerTab)) this.drawerTab = this._drawerTabs[0] || 'sessions';
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Cash Drawers</h2>
        <div id="drawer-hdr-actions"></div>
      </div>
      <div class="crm-tabs" id="drawer-tabs-nav">
        ${tabs.map(t => `<button class="crm-tab" onclick="App.switchDrawerTab('${t.key}')">${t.label}</button>`).join('')}
      </div>
      <div id="drawer-tab-content"></div>`;
    document.querySelectorAll('#drawer-tabs-nav .crm-tab').forEach((btn,i) => {
      btn.classList.toggle('active', this._drawerTabs[i] === this.drawerTab);
    });
    if (!tabs.length) { document.getElementById('drawer-tab-content').innerHTML = '<div class="empty-state"><p>You don\'t have access to drawer sessions or drawer setup.</p></div>'; return; }
    await this.renderDrawerTab();
  },

  switchDrawerTab(tab) {
    this.drawerTab = tab;
    document.querySelectorAll('#drawer-tabs-nav .crm-tab').forEach((btn,i) => {
      btn.classList.toggle('active', (this._drawerTabs || [])[i] === tab);
    });
    this.renderDrawerTab();
  },

  async renderDrawerTab() {
    if (this.drawerTab === 'sessions') await this.renderDrawerSessions();
    else if (this.drawerTab === 'petty-gl') await this.renderPettyCashGl();
    else await this.renderDrawerManage();
  },

  async renderDrawerSessions() {
    const el = document.getElementById('drawer-tab-content');
    if (!el) return;
    const hdr = document.getElementById('drawer-hdr-actions');
    if (hdr) hdr.innerHTML = '';
    // Local calendar day (not the UTC date — in Jamaica that rolls over at
    // 7 pm), sent as a UTC opened_at range to match CURRENT_TIMESTAMP.
    const localDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const toDbUtc = d => d.toISOString().replace('T', ' ').slice(0, 19);
    this._drawerDate = this._drawerDate || localDate(new Date());
    const dayStart = new Date(`${this._drawerDate}T00:00:00`);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    // Any session not yet reconciled — open, or closed without a count —
    // is listed on top regardless of when it was opened, so a drawer still
    // held from a previous day can always be found and released here.
    const [pending, daySessions] = await Promise.all([
      this.api('GET', '/drawers/sessions?unreconciled=1'),
      this.api('GET', `/drawers/sessions?from=${encodeURIComponent(toDbUtc(dayStart))}&to=${encodeURIComponent(toDbUtc(dayEnd))}`),
    ]);
    const pendingIds = new Set(pending.map(s => s.id));
    const history = daySessions.filter(s => !pendingIds.has(s.id));
    // Without Reconcile All Drawers the server returns only your own sessions.
    const ownOnly = this._drawerScope() !== 'all';
    const sc = { open:'badge-success', closed:'badge-warning', reconciled:'badge-info' };
    // opened_at is a UTC 'YYYY-MM-DD HH:MM:SS' with no zone marker.
    const parseUtc = v => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : `${String(v).replace(' ', 'T')}Z`);
    const todayStr = new Date().toDateString();
    const openedLabel = v => {
      if (!v) return '—';
      const d = parseUtc(v);
      const time = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      return d.toDateString() === todayStr ? time : `${d.toLocaleDateString([], { month:'short', day:'numeric' })}, ${time}`;
    };
    const table = rows => `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Drawer</th><th>Branch</th><th>Cashier</th><th>Float</th><th>Txns</th><th>Total Sales</th><th>Opened</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(s => {
          const stale = s.status === 'open' && parseUtc(s.opened_at).toDateString() !== todayStr;
          return `
          <tr>
            <td style="white-space:nowrap"><strong>${s.drawer_name||'—'}</strong></td>
            <td>${s.branch_name||'—'}</td>
            <td>${s.employee_name||'—'}</td>
            <td>$${this._n2(s.opening_float)}</td>
            <td><span class="badge badge-info">${s.tx_count}</span></td>
            <td><strong>$${this._n2(s.tx_total)}</strong></td>
            <td style="color:${stale?'var(--danger)':'var(--text-muted)'};font-size:12px">${openedLabel(s.opened_at)}${stale ? '<br><span class="badge-pill badge-danger" style="font-size:10px" title="Opened on a previous day and still holding this drawer">previous day</span>' : ''}</td>
            <td><span class="badge ${sc[s.status]||'badge-secondary'}">${s.status === 'closed' ? 'unreconciled' : s.status}</span></td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-sm btn-outline" onclick="App.viewDrawerReport(${s.id})">Report</button>
              ${s.status === 'reconciled' ? `<button class="btn btn-sm btn-outline" title="Email the reconciliation report as a PDF" onclick="App.emailDrawerReport(${s.id})">✉ Email</button>` : ''}
              ${this._canActOnDrawerSession(s) && s.status !== 'reconciled' ? `<button class="btn btn-sm btn-primary" onclick="App.showReconcileModal(${s.id})">Reconcile</button>` : ''}
              ${this._canActOnDrawerSession(s) && s.status === 'open' ? `<button class="btn btn-sm btn-secondary" onclick="App.closeDrawerSession(${s.id})">Close</button>` : ''}
            </td>
          </tr>`; }).join('')}
        </tbody>
      </table></div>`;
    el.innerHTML = `
      <div style="margin-bottom:22px">
        <h3 style="font-size:14px;margin:0 0 4px">Open &amp; Unreconciled <span class="badge badge-${pending.length ? 'warning' : 'secondary'}">${pending.length}</span></h3>
        ${ownOnly ? '<p style="font-size:12px;margin:0 0 6px"><strong>Showing your own drawer sessions only.</strong> Reconciling other cashiers\' drawers needs the Reconcile All Drawers permission.</p>' : ''}
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">Every session not yet reconciled, from any date. An <strong>open</strong> session holds its drawer until it's closed or reconciled; closing releases the drawer, reconciling finishes the session. <strong>Unreconciled</strong> sessions are closed but still need their count.</p>
        ${pending.length ? table(pending) : '<div class="empty-state" style="padding:14px"><p>All drawer sessions are reconciled.</p></div>'}
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <h3 style="font-size:14px;margin:0">Session History</h3>
        <label style="font-size:13px;font-weight:600">Opened on:</label>
        <input type="date" value="${this._drawerDate}" onchange="App._drawerDate=this.value;App.renderDrawerSessions()" style="width:auto;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px">
      </div>
      ${history.length === 0 ? '<div class="empty-state"><p>No reconciled sessions opened on this date.</p></div>' : table(history)}`;
  },

  async renderDrawerManage() {
    const el = document.getElementById('drawer-tab-content');
    if (!el) return;
    const hdr = document.getElementById('drawer-hdr-actions');
    if (hdr) hdr.innerHTML = '<button class="btn btn-primary btn-sm" onclick="App.showDrawerFormModal()">+ New Drawer</button>';
    const [drawers, branches] = await Promise.all([
      this.api('GET', '/drawers'),
      this.api('GET', '/branches'),
    ]);
    this._allBranches = branches;
    el.innerHTML = drawers.length === 0 ? '<div class="empty-state"><p>No drawers configured. Add drawers to enable drawer assignment at login.</p></div>' : `
      <table class="table">
        <thead><tr><th>Drawer Name</th><th>Branch</th><th>Access Control</th><th></th></tr></thead>
        <tbody>${drawers.map(d => `
          <tr>
            <td><strong>${d.name}</strong></td>
            <td>${d.branch_name||'—'}</td>
            <td><span id="drawer-access-summary-${d.id}" style="font-size:12px;color:var(--text-muted)">Loading…</span></td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-sm btn-outline" onclick="App.showDrawerAccessModal(${d.id},'${d.name.replace(/'/g,"\\'")}')">Access</button>
              <button class="btn btn-sm btn-outline" onclick="App.showDrawerFormModal(${d.id},'${d.name.replace(/'/g,"\\'")}',${d.branch_id})">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="App.deleteDrawer(${d.id})">Delete</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    // Load access summaries for each drawer
    drawers.forEach(d => this.loadDrawerAccessSummary(d.id));
  },

  showDrawerFormModal(id, name='', branchId='') {
    const branches = this._allBranches || [];
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit Drawer' : 'New Drawer'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Branch *</label>
            <select id="df-branch">
              <option value="">Select branch…</option>
              ${branches.map(b=>`<option value="${b.id}" ${b.id==branchId?'selected':''}>${b.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Drawer Name *</label>
            <input id="df-name" value="${name}" placeholder="e.g. Drawer 1, Register A">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveDrawer(${id||''})">Save</button>
        </div>
      </div>`);
  },

  async saveDrawer(id) {
    const branch_id = document.getElementById('df-branch').value;
    const name = document.getElementById('df-name').value.trim();
    if (!branch_id || !name) return this.alert('Branch and name are required','error');
    try {
      if (id) await this.api('PUT', `/drawers/${id}`, { branch_id, name });
      else await this.api('POST', '/drawers', { branch_id, name });
      this.closeModal();
      this.renderDrawerManage();
    } catch(e) { this.alert(e.message,'error'); }
  },

  async deleteDrawer(id) {
    if (!confirm('Delete this drawer?')) return;
    await this.api('DELETE', `/drawers/${id}`);
    this.renderDrawerManage();
  },

  async loadDrawerAccessSummary(drawerId) {
    try {
      const access = await this.api('GET', `/drawers/${drawerId}/access`);
      const el = document.getElementById(`drawer-access-summary-${drawerId}`);
      if (!el) return;
      if (!access.length) { el.textContent = 'Open (all employees)'; return; }
      const users = access.map(a => a.employee_name.split(' ')[0]).join(', ');
      el.textContent = `Restricted: ${users}`;
    } catch(e) {}
  },

  async showDrawerAccessModal(drawerId, drawerName) {
    const [access, employees] = await Promise.all([
      this.api('GET', `/drawers/${drawerId}/access`),
      this.api('GET', '/employees?active=1'),
    ]);
    const accessMap = {};
    access.forEach(a => { accessMap[a.employee_id] = a; });

    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <span class="modal-title">Access Control — ${drawerName}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
            If no employees are added, all employees can use this drawer.<br>
            Adding at least one employee restricts access to listed employees only.
          </p>
          <table class="table" style="margin-bottom:0">
            <thead><tr><th>Employee</th><th style="text-align:center">Can Use</th><th style="text-align:center">Can Reconcile</th><th></th></tr></thead>
            <tbody id="drawer-access-tbody">
              ${employees.map(e => {
                const a = accessMap[e.id];
                const checked = !!a;
                return `<tr id="dac-row-${e.id}">
                  <td>${e.first_name} ${e.last_name} <span style="font-size:11px;color:var(--text-muted)">${e.employee_number}</span></td>
                  <td style="text-align:center">
                    <input type="checkbox" id="dac-use-${e.id}" ${a?.can_use ? 'checked' : ''} onchange="App.updateDrawerAccess(${drawerId},${e.id})">
                  </td>
                  <td style="text-align:center">
                    <input type="checkbox" id="dac-rec-${e.id}" ${a?.can_reconcile ? 'checked' : ''} onchange="App.updateDrawerAccess(${drawerId},${e.id})">
                  </td>
                  <td style="text-align:right">
                    ${a ? `<button class="btn btn-sm btn-danger" onclick="App.removeDrawerAccess(${drawerId},${e.id})">Remove</button>` : ''}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Done</button>
        </div>
      </div>`);
    this._drawerAccessId = drawerId;
  },

  async updateDrawerAccess(drawerId, empId) {
    const canUse = document.getElementById(`dac-use-${empId}`)?.checked;
    const canRec  = document.getElementById(`dac-rec-${empId}`)?.checked;
    if (!canUse && !canRec) { await this.removeDrawerAccess(drawerId, empId); return; }
    try {
      await this.api('PUT', `/drawers/${drawerId}/access`, { employee_id: empId, can_use: canUse, can_reconcile: canRec });
      // Refresh the remove button for this row
      const row = document.getElementById(`dac-row-${empId}`);
      if (row) {
        const lastCell = row.querySelector('td:last-child');
        if (lastCell && !lastCell.querySelector('button')) {
          lastCell.innerHTML = `<button class="btn btn-sm btn-danger" onclick="App.removeDrawerAccess(${drawerId},${empId})">Remove</button>`;
        }
      }
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async removeDrawerAccess(drawerId, empId) {
    await this.api('DELETE', `/drawers/${drawerId}/access/${empId}`);
    const useEl = document.getElementById(`dac-use-${empId}`);
    if (useEl) useEl.checked = false;
    const recEl = document.getElementById(`dac-rec-${empId}`);
    if (recEl) recEl.checked = false;
    const row = document.getElementById(`dac-row-${empId}`);
    if (row) row.querySelector('td:last-child').innerHTML = '';
    this.loadDrawerAccessSummary(drawerId);
  },

  async closeDrawerSession(id) {
    if (!confirm('Close this drawer session?')) return;
    await this.api('PATCH', `/drawers/sessions/${id}/close`, {});
    this.alert('Session closed');
    if (this.currentDrawerSession?.id === id) {
      this.currentDrawerSession = null;
      this.updateDrawerBadge();
    }
    this.renderDrawerSessions();
  },

  // Drawer amounts: '$' in the base currency like the rest of the drawer
  // screens; a foreign currency shows its code (US$ 100.00).
  _drawerMoney(n, currency = null) {
    const v = Number(n) || 0;
    const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${v < 0 ? '-' : ''}${currency ? `${currency === 'USD' ? 'US$' : currency + ' '}` : '$'}${s}`;
  },

  _drawerVarianceHtml(v) {
    if (v == null) return '<span style="color:var(--text-muted)">—</span>';
    const style = v < 0 ? 'color:var(--danger)' : v > 0 ? 'color:var(--success)' : 'color:var(--text-muted)';
    return `<span style="${style}">${v >= 0 ? '+' : '-'}${this._drawerMoney(Math.abs(v)).replace('$', '')}</span>`;
  },

  // Overall over/short for the whole drawer: every counted tender's
  // variance plus the float's (lib/drawerReport.js summary).
  _drawerOverallHtml(sum, m) {
    if (sum.overall_variance == null) return `<p style="font-size:12px;color:var(--text-muted,#777);margin:8px 0 0">Overall variance shows once the drawer is reconciled.</p>`;
    const v = sum.overall_variance;
    const tone = v < 0 ? ['#fef2f2', '#fecaca', '#991b1b', 'Short'] : v > 0 ? ['#f0fdf4', '#bbf7d0', '#166534', 'Over'] : ['#f9fafb', '#e5e7eb', '#374151', 'Balanced'];
    return `<div style="margin-top:10px;padding:10px 12px;border:1px solid ${tone[1]};background:${tone[0]};border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="font-size:12px;color:#444">All tenders ${this._drawerVarianceHtml(sum.takings_variance)}${sum.float_variance != null ? ` &nbsp;+&nbsp; float ${this._drawerVarianceHtml(sum.float_variance)}` : ''}</div>
      <div style="font-size:15px;font-weight:700;color:${tone[2]}">Overall Variance: ${v > 0 ? '+' : v < 0 ? '−' : ''}${m(Math.abs(v))} <span style="font-size:12px;font-weight:600">(${tone[3]})</span></div>
    </div>`;
  },

  // The body of a drawer report (lib/drawerReport.js figures) — shared by
  // the on-screen report and the printed copy. With `actions`, petty cash
  // rows get a Void button for Reconcile All Drawers before reconciliation.
  _drawerReportBodyHtml(s, { actions = false } = {}) {
    const r = s.report, rec = s.reconciliation, esc = v => this.escapeAttr(v ?? ''), m = n => this._drawerMoney(n);
    const cash = r.tenders.find(t => t.key === 'cash');
    const sum = r.summary;
    const canVoid = actions && s.status !== 'reconciled' && this._drawerScope() === 'all';
    const tenderRows = r.tenders.filter(t => !t.uncounted || t.sales || t.key === 'available_credit').map(t => {
      const note = t.key === 'cash'
        ? [r.float.included_in_cash ? `incl. ${m(r.float.opening)} float` : 'float returned separately', r.payouts_total ? `less ${m(r.payouts_total)} petty cash` : ''].filter(Boolean).join(', ')
        : t.key === 'available_credit' ? 'store credit — no money in the drawer' : '';
      return `<tr>
        <td>${esc(t.label)}${note ? ` <small style="color:var(--text-muted,#777)">(${note})</small>` : ''}</td>
        <td style="text-align:center">${t.tx_count}</td>
        <td style="text-align:right"><strong>${m(t.sales)}</strong></td>
        <td style="text-align:right">${t.uncounted ? '—' : m(t.expected)}</td>
        <td style="text-align:right">${t.uncounted ? 'n/a' : t.counted != null ? m(t.counted) : '<span style="color:var(--text-muted,#777)">—</span>'}</td>
        <td style="text-align:right">${t.uncounted ? '—' : this._drawerVarianceHtml(t.variance)}</td>
      </tr>`;
    }).join('');
    const floatHtml = `
      <h3 style="font-size:13px;margin:14px 0 6px">Float</h3>
      <table class="table" style="margin-bottom:0"><thead><tr><th>Opening Float</th><th style="text-align:right">Returned</th><th style="text-align:right">Variance</th></tr></thead>
        <tbody><tr><td>${m(r.float.opening)}</td><td style="text-align:right">${r.float.included_in_cash ? '<span style="color:var(--text-muted,#777)">counted with cash</span>' : r.float.returned != null ? m(r.float.returned) : '—'}</td><td style="text-align:right">${this._drawerVarianceHtml(r.float.variance)}</td></tr></tbody></table>`;
    const payouts = s.payouts || [];
    const payoutsHtml = payouts.length ? `
      <h3 style="font-size:13px;margin:14px 0 6px">Petty Cash Paid Out</h3>
      <table class="table" style="margin-bottom:0"><thead><tr><th>Voucher #</th><th>Paid To</th><th>Reason</th><th>By</th><th style="text-align:right">Amount</th>${canVoid ? '<th></th>' : ''}</tr></thead>
        <tbody>${payouts.map(p => `<tr style="${p.voided_at ? 'opacity:0.55' : ''}">
          <td><strong>${esc(p.voucher_number)}</strong><div style="font-size:11px;color:var(--text-muted,#777)">${this.fmtDateTime(p.created_at)}</div></td>
          <td>${esc(p.paid_to) || '—'}</td>
          <td>${p.category_name ? `<span class="badge-pill badge-secondary" style="font-size:10px">${esc(p.category_name)}</span> ` : ''}${esc(p.reason)}${!p.voided_at && p.gl_status ? `<div style="font-size:11px;color:${p.gl_status === 'failed' ? 'var(--danger,#c00)' : 'var(--text-muted,#777)'}">${this._pettyGlLabel(p, s.status)}</div>` : ''}${p.voided_at ? `<div style="font-size:11px;color:var(--danger,#c00)">Voided by ${esc(p.voided_by_name) || '—'}: ${esc(p.void_reason)}</div>` : ''}</td>
          <td>${esc(p.employee_name) || '—'}</td>
          <td style="text-align:right">${p.voided_at ? '<s>' + m(p.amount) + '</s> VOID' : m(p.amount)}</td>
          ${canVoid ? `<td style="text-align:right">${p.voided_at ? '' : `<button class="btn btn-sm btn-secondary" onclick="App.voidDrawerPayout(${p.id}, ${s.id})">Void</button>`}</td>` : ''}
        </tr>`).join('')}
        <tr style="font-weight:600"><td colspan="4">Total paid out</td><td style="text-align:right">${m(r.payouts_total)}</td>${canVoid ? '<td></td>' : ''}</tr></tbody></table>` : '';
    const acctHtml = (s.account_payments || []).length ? `
      <h3 style="font-size:13px;margin:14px 0 6px">Customer Account Payments</h3>
      <table class="table" style="margin-bottom:0"><thead><tr><th>Payment #</th><th>Customer</th><th>Tender</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${s.account_payments.map(p => `<tr><td>${esc(p.payment_number)}</td><td>${esc(p.customer_name)}</td><td style="text-transform:capitalize">${esc(String(p.payment_method || '').replace(/_/g, ' '))}</td><td style="text-align:right">${m(p.amount)}</td></tr>`).join('')}</tbody></table>` : '';
    const denomHtml = r.denominations.map(g => {
      const foreign = g.currency !== r.base_currency;
      const gm = n => this._drawerMoney(n, foreign ? g.currency : null);
      return `
      <h3 style="font-size:13px;margin:14px 0 6px">Cash Count — ${esc(g.currency)}${foreign && g.base_per_unit ? ` <small style="font-weight:400;color:var(--text-muted,#777)">(1 ${esc(g.currency)} = ${Number(g.base_per_unit).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${esc(r.base_currency)})</small>` : ''}</h3>
      <table class="table" style="margin-bottom:0"><thead><tr><th>Denomination</th><th style="text-align:center">Qty</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${g.lines.map(l => `<tr><td>${esc(l.label)}</td><td style="text-align:center">${l.quantity}</td><td style="text-align:right">${gm(l.amount)}</td></tr>`).join('')}
        <tr style="font-weight:600"><td colspan="2">Total ${esc(g.currency)}</td><td style="text-align:right">${gm(g.total)}${foreign && g.base_equivalent != null ? `<div style="font-weight:400;font-size:12px;color:var(--text-muted,#777)">= ${m(g.base_equivalent)} ${esc(r.base_currency)}</div>` : ''}</td></tr></tbody></table>`;
    }).join('');
    return `
      ${floatHtml}
      <h3 style="font-size:13px;margin:14px 0 6px">Takings</h3>
      <table class="table" style="margin-bottom:0">
        <thead><tr><th>Tender</th><th style="text-align:center">Txns</th><th style="text-align:right">Sales</th><th style="text-align:right">Expected</th><th style="text-align:right">Counted</th><th style="text-align:right">Variance</th></tr></thead>
        <tbody>${tenderRows}${sum ? `
          <tr style="font-weight:700;border-top:2px solid var(--border,#ccc)">
            <td>All Tenders</td>
            <td style="text-align:center">${sum.tx_count ?? ''}</td>
            <td style="text-align:right">${m(sum.sales)}</td>
            <td style="text-align:right">${m(sum.expected)}</td>
            <td style="text-align:right">${sum.counted != null ? m(sum.counted) : '<span style="color:var(--text-muted,#777)">—</span>'}</td>
            <td style="text-align:right">${this._drawerVarianceHtml(sum.takings_variance)}</td>
          </tr>` : ''}</tbody>
      </table>
      <p style="font-size:12px;color:var(--text-muted,#777);margin:6px 0 0">Expected cash = cash sales &amp; account payments ${m(r.cash_sales)}${r.payouts_total ? ` − petty cash ${m(r.payouts_total)}` : ''}${r.float.included_in_cash ? ` + float ${m(r.float.opening)}` : ''} = <strong>${m(cash.expected)}</strong></p>
      ${sum ? this._drawerOverallHtml(sum, m) : ''}
      ${payoutsHtml}
      ${acctHtml}
      ${denomHtml}
      ${rec?.notes ? `<p style="margin-top:10px;font-size:13px"><strong>Notes:</strong> ${esc(rec.notes)}</p>` : ''}`;
  },

  async viewDrawerReport(id) {
    const s = await this.api('GET', `/drawers/sessions/${id}`);
    const rec = s.reconciliation;
    const sc = { open:'badge-success', closed:'badge-secondary', reconciled:'badge-info' };
    const label = t => `<label style="font-size:10px;text-transform:uppercase;color:var(--text-muted)">${t}</label>`;
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header">
          <span class="modal-title">Drawer Report — ${this.escapeAttr(s.drawer_name||'Session #'+s.id)}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body" style="max-height:78vh;overflow-y:auto">
          <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:6px;font-size:13px">
            <div>${label('Cashier')}<div>${this.escapeAttr(s.employee_name||'—')}</div></div>
            <div>${label('Branch')}<div>${this.escapeAttr(s.branch_name||'—')}</div></div>
            <div>${label('Opened')}<div>${s.opened_at ? this.fmtDateTime(s.opened_at) : '—'}</div></div>
            <div>${label('Closed')}<div>${s.closed_at ? this.fmtDateTime(s.closed_at) : '—'}</div></div>
            <div>${label('Status')}<div><span class="badge ${sc[s.status]}">${s.status}</span></div></div>
          </div>
          ${this._drawerReportBodyHtml(s, { actions: true })}
          ${rec ? `<p style="margin-top:6px;font-size:12px;color:var(--text-muted)">Reconciled by ${this.escapeAttr(rec.reconciled_by_name||'—')} at ${this.fmtDateTime(rec.reconciled_at)}</p>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.printDrawerReport(${id})">🖨 Print</button>
          <button class="btn btn-outline" onclick="App.emailDrawerReport(${id})">✉ Email PDF</button>
          ${this._canActOnDrawerSession(s) && s.status !== 'reconciled' ? `<button class="btn btn-primary" onclick="App.closeModal();App.showReconcileModal(${id})">Reconcile</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  emailDrawerReport(id) {
    this.showEmailModal('Email Drawer Report (PDF)', this.settings?.drawer_report_email || this.settings?.store_email || '', async to => {
      this.closeModal();
      try {
        const r = await this.api('POST', `/email/send-drawer-report/${id}`, { to });
        this.alert(r.message || `Drawer report sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    });
  },

  async voidDrawerPayout(payoutId, sessionId) {
    const reason = prompt('Reason for voiding this petty cash payout?');
    if (reason == null) return;
    if (!reason.trim()) { this.alert('Enter a reason', 'error'); return; }
    try {
      await this.api('PATCH', `/drawers/payouts/${payoutId}/void`, { reason: reason.trim() });
      this.alert('Payout voided');
      this.viewDrawerReport(sessionId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Reconciliation: hand back the float first (its own line), then count
  // the takings — base currency notes plus any alternate currency's notes
  // (e.g. USD), valued in base at Settings' rate — against cash sales and
  // account payments less petty cash.
  async showReconcileModal(id) {
    const [s, allDenoms] = await Promise.all([
      this.api('GET', `/drawers/sessions/${id}`),
      this.api('GET', '/denominations'),
    ]);
    const r = s.report, rec = s.reconciliation || {};
    const base = r.base_currency;
    const cashRow = r.tenders.find(t => t.key === 'cash');
    const expectedCash = r.float.included_in_cash ? cashRow.expected : Math.round((r.cash_sales - r.payouts_total) * 100) / 100;
    // Base value of 1 unit of each currency counted (1 USD = 155 JMD → 155).
    const rates = { [base]: 1 };
    (this.altCurrencies || []).forEach(c => { const per = this._altBasePerUnit(c); if (c.code && per) rates[c.code] = per; });
    const currencies = Object.keys(rates).filter(c => allDenoms.some(d => d.currency === c));
    const denoms = allDenoms.filter(d => currencies.includes(d.currency));
    this._reconcileExpectedCash = expectedCash;
    this._reconcileDenoms = denoms;
    this._reconcileRates = rates;
    this._reconcileBase = base;
    const savedCounts = {};
    (rec.note_counts || []).forEach(nc => { savedCounts[nc.denomination_id] = nc.quantity; });
    const m = n => this._drawerMoney(n);
    const inputStyle = 'width:110px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px';
    const floatReturned = rec.float_returned != null ? rec.float_returned : r.float.opening;

    const denomTables = currencies.map(cur => {
      const foreign = cur !== base;
      const list = denoms.filter(d => d.currency === cur);
      return `
        <div style="flex:1;min-width:230px">
          <div style="font-size:12px;font-weight:600;margin-bottom:4px">${this.escapeAttr(cur)}${foreign ? ` <span style="font-weight:400;color:var(--text-muted)">(1 ${this.escapeAttr(cur)} = ${rates[cur].toLocaleString('en-US', { maximumFractionDigits: 4 })} ${this.escapeAttr(base)})</span>` : ''}</div>
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead><tr style="background:var(--bg-alt)"><th style="padding:4px 6px;text-align:left">Note / Coin</th><th style="padding:4px 6px;text-align:center">Qty</th><th style="padding:4px 6px;text-align:right">Amount</th></tr></thead>
            <tbody>${list.map(d => `<tr>
              <td style="padding:3px 6px">${this.escapeAttr(d.label)}</td>
              <td style="padding:3px 6px;text-align:center"><input type="number" id="dn-${d.id}" min="0" step="1" value="${savedCounts[d.id] || 0}" oninput="App._updateDenomTotal()" style="width:64px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;text-align:center;font-size:12px"></td>
              <td style="padding:3px 6px;text-align:right" id="dna-${d.id}"></td>
            </tr>`).join('')}</tbody>
            <tfoot><tr style="font-weight:600;border-top:2px solid var(--border)">
              <td style="padding:5px 6px" colspan="2">Total ${this.escapeAttr(cur)}</td>
              <td style="padding:5px 6px;text-align:right"><span id="rc-denom-total-${cur}"></span>${foreign ? `<div style="font-weight:400;color:var(--text-muted)" id="rc-denom-base-${cur}"></div>` : ''}</td>
            </tr></tfoot>
          </table>
        </div>`;
    }).join('');
    const denomsHtml = currencies.length ? `
      <details id="rc-denom-details" open style="margin:8px 0 4px">
        <summary style="cursor:pointer;font-size:12px;font-weight:600;color:var(--primary);user-select:none;margin-bottom:6px">Count the takings by denomination</summary>
        <div style="display:flex;gap:14px;flex-wrap:wrap">${denomTables}</div>
        <div style="display:flex;align-items:center;gap:10px;margin:8px 0 6px;flex-wrap:wrap">
          <strong style="font-size:13px">Count total: <span id="rc-denom-grand"></span> ${this.escapeAttr(base)}</strong>
          <button class="btn btn-secondary btn-sm" onclick="App._applyDenomTotal(${expectedCash})">Apply total to Cash counted</button>
        </div>
      </details>` : `<p style="font-size:11px;color:var(--text-muted);margin:4px 0 8px">No denominations configured for ${this.escapeAttr(base)}. Set them up in Settings.</p>`;

    const nonCash = r.tenders.filter(t => t.key !== 'cash' && !t.uncounted);
    const exemptTaken = r.tenders.find(t => t.key === 'tax_exempt_tender')?.sales || 0;
    // What section 4 totals as the counts are typed.
    this._reconcileSummary = { opening: r.float.opening, tenders: [{ key: 'cash', expected: expectedCash }, ...nonCash.map(t => ({ key: t.key, expected: t.expected }))] };
    this.showModal(`
      <div class="modal" style="max-width:720px">
        <div class="modal-header">
          <span class="modal-title">Reconcile — ${this.escapeAttr(s.drawer_name||'Session #'+id)}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body" style="max-height:80vh;overflow-y:auto">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:10px">Cashier: <strong>${this.escapeAttr(s.employee_name)}</strong></p>
          <h3 style="font-size:13px;margin:0 0 6px">1. Return the float</h3>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 6px">Count out the opening float and hand it back first — it's kept separate from the takings.</p>
          <table class="table" style="margin-bottom:12px">
            <thead><tr><th>Opening Float</th><th>Float Returned</th><th>Variance</th></tr></thead>
            <tbody><tr>
              <td>${m(r.float.opening)}</td>
              <td><input type="number" id="rc-float" step="0.01" min="0" value="${Number(floatReturned).toFixed(2)}" oninput="App._updateFloatVariance(${r.float.opening})" style="${inputStyle}"></td>
              <td id="rcv-float" style="font-weight:600">${this._calcVariance(Number(floatReturned), r.float.opening)}</td>
            </tr></tbody>
          </table>
          <h3 style="font-size:13px;margin:0 0 6px">2. Count the cash takings</h3>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 6px">Cash sales &amp; account payments ${m(r.cash_sales)}${r.payouts_total ? ` − petty cash paid out ${m(r.payouts_total)} (${r.payouts_count})` : ''} = expected <strong>${m(expectedCash)}</strong></p>
          ${exemptTaken ? `<p id="rc-exempt-note" style="font-size:12px;margin:0 0 6px"><strong>Tax Exempt ${m(exemptTaken)} isn't part of this cash.</strong> Keep that money out of this count, including any paid in cash, and enter it on the Tax Exempt line in section 3.</p>` : ''}
          <table class="table" style="margin-bottom:4px">
            <thead><tr><th>Tender</th><th>Expected</th><th>Amount Counted</th><th>Variance</th></tr></thead>
            <tbody><tr>
              <td>Cash</td>
              <td>${m(expectedCash)}</td>
              <td><input type="number" id="rc-cash" step="0.01" min="0" value="${Number(rec.cash_counted != null ? rec.cash_counted : expectedCash).toFixed(2)}" oninput="App.updateReconcileVariance('cash', ${expectedCash})" style="${inputStyle}"></td>
              <td id="rcv-cash" style="font-weight:600">${this._calcVariance(Number(rec.cash_counted != null ? rec.cash_counted : expectedCash), expectedCash)}</td>
            </tr></tbody>
          </table>
          ${(s.payouts || []).length ? `
          <div style="margin:8px 0 4px">
            <div style="font-size:12px;font-weight:600;margin-bottom:4px">Petty cash paid out of this drawer</div>
            <table style="width:100%;font-size:12px;border-collapse:collapse">
              <thead><tr style="background:var(--bg-alt)"><th style="padding:4px 6px;text-align:left">Voucher #</th><th style="padding:4px 6px;text-align:left">Paid To</th><th style="padding:4px 6px;text-align:left">Reason</th><th style="padding:4px 6px;text-align:right">Amount</th></tr></thead>
              <tbody>${s.payouts.map(p => `<tr style="${p.voided_at ? 'opacity:0.55' : ''}">
                <td style="padding:3px 6px"><strong>${this.escapeAttr(p.voucher_number)}</strong></td>
                <td style="padding:3px 6px">${this.escapeAttr(p.paid_to || '—')}</td>
                <td style="padding:3px 6px">${p.category_name ? `${this.escapeAttr(p.category_name)}: ` : ''}${this.escapeAttr(p.reason || '')}</td>
                <td style="padding:3px 6px;text-align:right">${p.voided_at ? `<s>${m(p.amount)}</s> VOID` : m(p.amount)}</td>
              </tr>`).join('')}
              <tr style="font-weight:600;border-top:2px solid var(--border)"><td style="padding:5px 6px" colspan="3">Total paid out (taken off expected cash)</td><td style="padding:5px 6px;text-align:right">${m(r.payouts_total)}</td></tr></tbody>
            </table>
          </div>` : ''}
          ${denomsHtml}
          <h3 style="font-size:13px;margin:12px 0 6px">3. Other tenders</h3>
          <table class="table" style="margin-bottom:12px">
            <thead><tr><th>Tender</th><th>Expected</th><th>Amount Received</th><th>Variance</th></tr></thead>
            <tbody>${nonCash.map(t => `
              <tr>
                <td>${this.escapeAttr(t.label)}</td>
                <td>${m(t.expected)}</td>
                <td><input type="number" id="rc-${t.key}" step="0.01" min="0" value="${Number(rec[`${t.key}_counted`] != null ? rec[`${t.key}_counted`] : t.expected).toFixed(2)}" oninput="App.updateReconcileVariance('${t.key}', ${t.expected})" style="${inputStyle}"></td>
                <td id="rcv-${t.key}" style="font-weight:600">${this._calcVariance(Number(rec[`${t.key}_counted`] != null ? rec[`${t.key}_counted`] : t.expected), t.expected)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
          ${(() => { const ac = r.tenders.find(t => t.key === 'available_credit'); return ac && ac.sales ? `<p style="font-size:12px;color:var(--text-muted);margin:-6px 0 10px">Available Credit ${m(ac.sales)} was paid from customers' store credit — no money in the drawer, nothing to count.</p>` : ''; })()}
          <h3 style="font-size:13px;margin:0 0 6px">4. Summary — all tenders</h3>
          <table class="table" style="margin-bottom:12px">
            <thead><tr><th></th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead>
            <tbody>
              <tr><td>All tenders</td><td>${m(this._reconcileSummary.tenders.reduce((t, x) => t + x.expected, 0))}</td><td id="rcs-counted"></td><td id="rcs-var" style="font-weight:600"></td></tr>
              <tr><td>Float</td><td>${m(r.float.opening)}</td><td id="rcs-float"></td><td id="rcs-float-var" style="font-weight:600"></td></tr>
              <tr style="font-weight:700;border-top:2px solid var(--border)"><td>Overall</td><td>${m(this._reconcileSummary.tenders.reduce((t, x) => t + x.expected, 0) + r.float.opening)}</td><td id="rcs-all"></td><td id="rcs-all-var"></td></tr>
            </tbody>
          </table>
          <div class="form-group"><label>Notes</label>
            <textarea id="rc-notes" rows="2" placeholder="Optional notes…">${this.escapeAttr(rec.notes||'')}</textarea>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600"><input type="checkbox" id="rc-email-on" ${this.settings?.drawer_report_email ? 'checked' : ''} style="width:auto;margin:0"> Email the reconciliation report (PDF) when saved</label>
            <input type="text" id="rc-email-to" value="${this.escapeAttr(this.settings?.drawer_report_email || '')}" placeholder="Email address(es), comma-separated" style="margin-top:6px">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitReconcile(${id})">Save Reconciliation</button>
        </div>
      </div>`);
    this._updateDenomTotal();
    this._updateReconcileSummary();
  },

  _updateFloatVariance(opening) {
    const val = parseFloat(document.getElementById('rc-float')?.value) || 0;
    const el = document.getElementById('rcv-float');
    if (el) el.innerHTML = this._calcVariance(val, opening);
    this._updateReconcileSummary();
  },

  // Section 4 of the reconcile screen: every tender counted as one, the
  // float, and the overall over/short — same sums as the saved report's
  // summary (lib/drawerReport.js).
  _updateReconcileSummary() {
    const sum = this._reconcileSummary;
    if (!sum || !document.getElementById('rcs-all')) return;
    const val = id => parseFloat(document.getElementById(id)?.value) || 0;
    const cents = n => Math.round(n * 100);
    const expected = sum.tenders.reduce((t, x) => t + cents(x.expected), 0) / 100;
    const counted = sum.tenders.reduce((t, x) => t + cents(val(`rc-${x.key}`)), 0) / 100;
    const floatBack = val('rc-float');
    const m = n => this._drawerMoney(n);
    document.getElementById('rcs-counted').textContent = m(counted);
    document.getElementById('rcs-var').innerHTML = this._calcVariance(counted, expected);
    document.getElementById('rcs-float').textContent = m(floatBack);
    document.getElementById('rcs-float-var').innerHTML = this._calcVariance(floatBack, sum.opening);
    document.getElementById('rcs-all').textContent = m(counted + floatBack);
    document.getElementById('rcs-all-var').innerHTML = this._calcVariance(counted + floatBack, expected + sum.opening);
  },

  // Per-currency totals of the denomination count, and their sum in the
  // base currency (foreign amount × its rate) — what "Apply" puts in Cash.
  _denomCountTotals() {
    const rates = this._reconcileRates || {}, totals = {};
    let grand = 0;
    (this._reconcileDenoms || []).forEach(d => {
      const qty = parseInt(document.getElementById(`dn-${d.id}`)?.value) || 0;
      const amt = qty * d.value;
      totals[d.currency] = (totals[d.currency] || 0) + amt;
      const amtEl = document.getElementById(`dna-${d.id}`);
      if (amtEl) amtEl.textContent = this._drawerMoney(amt, d.currency === this._reconcileBase ? null : d.currency);
    });
    for (const [cur, t] of Object.entries(totals)) grand += t * (rates[cur] || 1);
    return { totals, grand: Math.round(grand * 100) / 100 };
  },

  _updateDenomTotal() {
    const { totals, grand } = this._denomCountTotals();
    const base = this._reconcileBase, rates = this._reconcileRates || {};
    for (const [cur, t] of Object.entries(totals)) {
      const el = document.getElementById(`rc-denom-total-${cur}`);
      if (el) el.textContent = this._drawerMoney(t, cur === base ? null : cur);
      const baseEl = document.getElementById(`rc-denom-base-${cur}`);
      if (baseEl) baseEl.textContent = `= ${this._drawerMoney(t * (rates[cur] || 1))} ${base}`;
    }
    const g = document.getElementById('rc-denom-grand');
    if (g) g.textContent = this._drawerMoney(grand);
  },

  _applyDenomTotal(expectedCash) {
    const { grand } = this._denomCountTotals();
    const input = document.getElementById('rc-cash');
    if (input) { input.value = grand.toFixed(2); this.updateReconcileVariance('cash', expectedCash); }
  },

  _calcVariance(counted, expected) {
    const v = parseFloat((counted - expected).toFixed(2));
    const style = v < 0 ? 'color:var(--danger)' : v > 0 ? 'color:var(--success)' : 'color:var(--text-muted)';
    return `<span style="${style}">${v >= 0 ? '+' : ''}${this._n2(v)}</span>`;
  },

  updateReconcileVariance(key, expected) {
    const val = parseFloat(document.getElementById(`rc-${key}`)?.value) || 0;
    const el = document.getElementById(`rcv-${key}`);
    if (el) el.innerHTML = this._calcVariance(val, expected);
    this._updateReconcileSummary();
  },

  async submitReconcile(id) {
    const denoms = this._reconcileDenoms || [];
    const note_counts = denoms.map(d => ({
      denomination_id: d.id,
      quantity: parseInt(document.getElementById(`dn-${d.id}`)?.value) || 0,
    })).filter(nc => nc.quantity > 0);
    const floatVal = document.getElementById('rc-float')?.value;
    if (floatVal === '' || floatVal == null) { this.alert('Enter the float returned (0 if none)', 'error'); return; }

    const data = {
      float_returned:         parseFloat(floatVal) || 0,
      cash_counted:           parseFloat(document.getElementById('rc-cash')?.value)           || 0,
      card_counted:           parseFloat(document.getElementById('rc-card')?.value)           || 0,
      check_counted:          parseFloat(document.getElementById('rc-check')?.value)          || 0,
      gift_card_counted:      parseFloat(document.getElementById('rc-gift_card')?.value)      || 0,
      credit_counted:         parseFloat(document.getElementById('rc-credit')?.value)         || 0,
      direct_deposit_counted: parseFloat(document.getElementById('rc-direct_deposit')?.value) || 0,
      tax_exempt_tender_counted: parseFloat(document.getElementById('rc-tax_exempt_tender')?.value) || 0,
      notes:             document.getElementById('rc-notes')?.value.trim() || null,
      reconciled_by:     this.currentUser?.id,
      note_counts,
    };
    const emailTo = document.getElementById('rc-email-on')?.checked ? (document.getElementById('rc-email-to')?.value || '').trim() : '';
    if (document.getElementById('rc-email-on')?.checked && !emailTo) { this.alert('Enter an email address for the report, or untick Email', 'error'); return; }
    try {
      await this.api('POST', `/drawers/sessions/${id}/reconcile`, data);
      this.closeModal();
      this.renderDrawerSessions();
      if (!emailTo) { this.alert('Drawer reconciled successfully'); return; }
      this.alert(`Drawer reconciled — emailing the report to ${emailTo}…`, 'info');
      try {
        const r = await this.api('POST', `/email/send-drawer-report/${id}`, { to: emailTo });
        this.alert(r.message || `Drawer report sent to ${emailTo}`);
      } catch (e) { this.alert(`Reconciled, but the email failed: ${e.message} — use Email on the drawer report to retry`, 'error'); }
    } catch(e) { this.alert(e.message,'error'); }
  },

  async printDrawerReport(id) {
    const s = await this.api('GET', `/drawers/sessions/${id}`);
    const rec = s.reconciliation;
    const store = this.settings || {};
    const esc = v => this.escapeAttr(v ?? '');
    const win = window.open('', '_blank', 'width=800,height=600');
    win.document.write(`<!DOCTYPE html><html><head><title>Drawer Report</title>
    <style>body{font-family:Arial,sans-serif;font-size:13px;margin:28px;color:#111}h2{margin:0 0 4px}h3{margin:0}p{margin:2px 0;font-size:12px;color:#555}table{width:100%;border-collapse:collapse;margin-top:4px}th{background:#eee;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;border:1px solid #ccc}td{padding:6px 8px;border:1px solid #ddd}tr:nth-child(even) td{background:#fafafa}button{display:none}.footer{margin-top:16px;font-size:11px;color:#999;border-top:1px solid #ddd;padding-top:8px}@media print{body{margin:12px}}</style>
    </head><body>
    ${this._printLogoTag(40)}
    <h2>${esc(store.store_name||'Drawer Report')} — Drawer Report</h2>
    <p><strong>Drawer:</strong> ${esc(s.drawer_name||'—')} (#${s.id}) &nbsp; <strong>Branch:</strong> ${esc(s.branch_name||'—')} &nbsp; <strong>Cashier:</strong> ${esc(s.employee_name||'—')}</p>
    <p><strong>Opened:</strong> ${s.opened_at ? this.fmtDateTime(s.opened_at) : '—'} &nbsp; <strong>Closed:</strong> ${s.closed_at ? this.fmtDateTime(s.closed_at) : '—'} &nbsp; <strong>Status:</strong> ${s.status}</p>
    ${this._drawerReportBodyHtml(s)}
    <div class="footer">Printed: ${new Date().toLocaleString()}${rec ? ` | Reconciled by ${esc(rec.reconciled_by_name||'—')} at ${this.fmtDateTime(rec.reconciled_at)}` : ''}</div>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
    win.document.close();
  },

  // POS "Petty Cash" — pay cash out of the cashier's open drawer against a
  // numbered petty cash request slip (permission pos_petty_cash). It comes
  // off the drawer's expected cash at reconciliation.
  async showPettyCashModal() {
    const session = this.currentDrawerSession;
    if (!session?.id) { this.alert('Open a cash drawer first — petty cash is paid from your open drawer', 'warning'); return; }
    let cats = [];
    try { cats = await this.api('GET', '/drawers/petty-cash/categories'); } catch (e) {}
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Petty Cash Payout</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Voucher # *</label><input type="text" id="pc-voucher" placeholder="Petty cash request slip number" autocomplete="off"></div>
          <div class="form-group"><label>Amount *</label><input type="number" id="pc-amount" step="0.01" min="0.01" placeholder="0.00"></div>
          <div class="form-group"><label>Paid To</label><input type="text" id="pc-paid-to" placeholder="Who received the cash"></div>
          <div class="form-group"><label>Expense Category *</label><select id="pc-category"><option value="">— Choose what it's for —</option>${cats.map(c => `<option value="${c.id}">${this.escapeAttr(c.name)}</option>`).join('')}</select>
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">Decides which expense account it's posted to in the books</div></div>
          <div class="form-group"><label>Reason *</label><input type="text" id="pc-reason" placeholder="What it's for"></div>
          <p style="font-size:12px;color:var(--text-muted);margin:0">Paid from ${this.escapeAttr(session.drawer_name || 'your open drawer')}. It's deducted from the drawer's expected cash at reconciliation.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="pc-submit" onclick="App.submitPettyCash()">Pay Out</button>
        </div>
      </div>`);
    document.getElementById('pc-voucher')?.focus();
  },

  // ── Petty cash → General Ledger ──────────────────────────────────────────
  // Categories map to RetailPOS Books expense accounts; payouts go to Books
  // once their drawer is reconciled (routes/drawers.js).
  _pettyGlCanSee() { const p = this.currentUser?.permissions || {}; return this.can('settings') || !!p.drawers_manage || !!p.drawers_reconcile_all; },
  _pettyGlCanManage() { const p = this.currentUser?.permissions || {}; return this.can('settings') || !!p.drawers_manage; },
  _pettyGlLabel(p, sessionStatus) {
    if (p.gl_status === 'posted') return `Posted to the books${p.gl_ref ? ` — ${this.escapeAttr(p.gl_ref)}` : ''}`;
    if (p.gl_status === 'failed') return `Not posted: ${this.escapeAttr(p.gl_error || 'failed')}`;
    return (sessionStatus || p.session_status) === 'reconciled' ? `Waiting for RetailPOS Books (account ${this.escapeAttr(p.account_code || '')})` : `Goes to the books once this drawer is reconciled (account ${this.escapeAttr(p.account_code || '')})`;
  },

  async renderPettyCashGl() {
    const el = document.getElementById('drawer-tab-content');
    if (!el) return;
    const hdr = document.getElementById('drawer-hdr-actions');
    if (hdr) hdr.innerHTML = '';
    const manage = this._pettyGlCanManage();
    const f = this._pettyGlFilter || (this._pettyGlFilter = 'open');
    el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let cats, settings, rows;
    try {
      [cats, settings, rows] = await Promise.all([
        this.api('GET', '/drawers/petty-cash/categories?all=1'),
        this.api('GET', '/drawers/petty-cash/settings'),
        this.api('GET', `/drawers/petty-cash/postings?status=${f}`),
      ]);
    } catch (e) { el.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (this.drawerTab !== 'petty-gl') return;
    const stage = { waiting: ['Drawer not reconciled', 'badge-secondary'], pending: ['Waiting for Books', 'badge-warning'], failed: ['Failed', 'badge-danger'], posted: ['Posted', 'badge-success'] };
    el.innerHTML = `
      <p style="font-size:13px;color:var(--text-muted);margin:4px 0 12px">Each petty cash payout is posted to RetailPOS Books once its drawer is reconciled: <strong>Dr</strong> the category's expense account, <strong>Cr</strong> the cash account below. Voided payouts are never posted.</p>
      <div class="two-col" style="align-items:start;gap:16px">
        <div class="card" style="padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong>Expense Categories</strong>${manage ? '<button class="btn btn-sm btn-primary" onclick="App._pettyGlEditCategory()">+ Category</button>' : ''}</div>
          <table class="table"><thead><tr><th>Category</th><th>GL Account</th><th>Status</th>${manage ? '<th></th>' : ''}</tr></thead><tbody>
            ${cats.map(c => `<tr style="${c.active ? '' : 'opacity:.55'}"><td>${this.escapeAttr(c.name)}</td><td class="fw-600">${this.escapeAttr(c.account_code)}</td><td>${c.active ? 'Active' : 'Hidden'}</td>
              ${manage ? `<td style="text-align:right;white-space:nowrap"><button class="btn btn-sm btn-outline" onclick="App._pettyGlEditCategory(${c.id})">Edit</button></td>` : ''}</tr>`).join('') || '<tr><td colspan="4" class="empty-state">No categories</td></tr>'}
          </tbody></table>
          <div style="display:flex;gap:8px;align-items:end;margin-top:12px">
            <div class="form-group" style="margin:0;flex:1"><label>Cash account credited (petty cash paid from)</label><input id="pgl-cash" value="${this.escapeAttr(settings.cash_account)}" ${manage ? '' : 'disabled'}></div>
            ${manage ? '<button class="btn btn-sm btn-secondary" onclick="App._pettyGlSaveCash()">Save</button>' : ''}
          </div>
        </div>
        <div class="card" style="padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px"><strong>Postings</strong>
            <select id="pgl-filter" style="width:auto" onchange="App._pettyGlFilter=this.value;App.renderPettyCashGl()">
              ${[['open', 'Not yet posted'], ['waiting', 'Drawer not reconciled'], ['pending', 'Waiting for Books'], ['failed', 'Failed'], ['posted', 'Posted'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="table-wrap" style="max-height:520px;overflow:auto"><table class="table"><thead><tr><th>Voucher #</th><th>Date</th><th>Category / Account</th><th style="text-align:right">Amount</th><th>Status</th></tr></thead><tbody>
            ${rows.map(p => `<tr>
              <td class="fw-600">${this.escapeAttr(p.voucher_number)}<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(p.drawer_name || '')}${p.branch_name ? ` · ${this.escapeAttr(p.branch_name)}` : ''}</div></td>
              <td style="font-size:12px">${this.fmtDateTime(p.created_at)}</td>
              <td style="font-size:12px">${this.escapeAttr(p.category_name || '—')}<div style="color:var(--text-muted)">Dr ${this.escapeAttr(p.account_code || '—')} / Cr ${this.escapeAttr(settings.cash_account)}</div></td>
              <td style="text-align:right">${this.fmt(p.amount)}</td>
              <td><span class="badge-pill ${stage[p.gl_stage]?.[1] || ''}">${stage[p.gl_stage]?.[0] || p.gl_stage}</span>
                ${p.gl_stage === 'posted' && p.gl_ref ? `<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(p.gl_ref)}</div>` : ''}
                ${p.gl_stage === 'failed' ? `<div style="font-size:11px;color:var(--danger,#c00);max-width:220px">${this.escapeAttr(p.gl_error || '')}</div>${manage ? `<button class="btn btn-sm btn-outline" style="margin-top:4px" onclick="App._pettyGlRetry(${p.id})">Retry</button>` : ''}` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty-state">Nothing here</td></tr>'}
          </tbody></table></div>
        </div>
      </div>`;
  },

  async _pettyGlEditCategory(id) {
    let c = { name: '', account_code: '', active: 1 };
    if (id) { try { c = (await this.api('GET', '/drawers/petty-cash/categories?all=1')).find(x => x.id === id) || c; } catch (e) {} }
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit' : 'New'} Petty Cash Category</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Category *</label><input id="pgc-name" value="${this.escapeAttr(c.name)}" placeholder="e.g. Cleaning Supplies"></div>
          <div class="form-group"><label>GL Expense Account Code *</label><input id="pgc-code" value="${this.escapeAttr(c.account_code)}" placeholder="e.g. 6300">
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">The RetailPOS Books account debited. A change applies to payouts made from now on (and failed ones you retry).</div></div>
          ${id ? `<label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="pgc-active" ${c.active ? 'checked' : ''} style="width:auto;margin:0"> Active (offered to cashiers)</label>` : ''}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="App._pettyGlSaveCategory(${id || 0})">Save</button></div>
      </div>`);
  },

  async _pettyGlSaveCategory(id) {
    const body = { name: document.getElementById('pgc-name').value.trim(), account_code: document.getElementById('pgc-code').value.trim() };
    if (id) body.active = document.getElementById('pgc-active')?.checked ? 1 : 0;
    try {
      await this.api(id ? 'PUT' : 'POST', `/drawers/petty-cash/categories${id ? `/${id}` : ''}`, body);
      this.closeModal(); this.alert('Category saved'); this.renderPettyCashGl();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _pettyGlSaveCash() {
    try { await this.api('PUT', '/drawers/petty-cash/settings', { cash_account: document.getElementById('pgl-cash').value.trim() }); this.alert('Cash account saved'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _pettyGlRetry(id) {
    try { await this.api('POST', `/drawers/petty-cash/postings/${id}/retry`, {}); this.alert('Queued again for RetailPOS Books'); this.renderPettyCashGl(); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async submitPettyCash() {
    const session = this.currentDrawerSession;
    const data = {
      voucher_number: document.getElementById('pc-voucher')?.value.trim(),
      amount: parseFloat(document.getElementById('pc-amount')?.value),
      paid_to: document.getElementById('pc-paid-to')?.value.trim(),
      reason: document.getElementById('pc-reason')?.value.trim(),
      category_id: parseInt(document.getElementById('pc-category')?.value) || null,
    };
    if (!data.voucher_number) { this.alert('Enter the voucher number', 'error'); return; }
    if (!(data.amount > 0)) { this.alert('Enter an amount above 0', 'error'); return; }
    if (!data.category_id) { this.alert('Choose the expense category', 'error'); return; }
    if (!data.reason) { this.alert("Enter what it's for", 'error'); return; }
    const btn = document.getElementById('pc-submit');
    if (btn) btn.disabled = true;
    try {
      const p = await this.api('POST', `/drawers/sessions/${session.id}/payouts`, data);
      this.closeModal();
      this.alert(`Petty cash ${this._drawerMoney(p.amount)} paid out — voucher ${p.voucher_number}`);
    } catch(e) { if (btn) btn.disabled = false; this.alert(e.message, 'error'); }
  },

  // ─── POS drawer check and open ───────────────────────────────────
  async checkPOSDrawer() {
    if (this.currentDrawerSession) return;
    if (!this.can('drawers')) { this._posHasDrawers = false; this.renderPOSBranchBar(); return; }

    const branches = this.currentUser.branches || [];
    const isMultiBranch = this.currentUser.permissions?.multi_branch_access && branches.length > 1;
    const defaultBranch = branches.find(b => b.is_default) || branches[0];

    // Check for an existing open session
    try {
      const sessions = await this.api('GET', `/drawers/sessions?employee_id=${this.currentUser.id}&status=open`);
      if (sessions.length) {
        const s = sessions[0];
        const openedToday = this._storeDay(s.opened_at) === this._storeDay(new Date());
        if (openedToday) {
          // Same-day session — resume it silently
          this.currentDrawerSession = s;
          const sb = branches.find(b => b.id == s.branch_id);
          if (sb) this.posBranch = sb;
          this.updateDrawerBadge();
          this.renderPOSBranchBar();
          return;
        }
        // Stale session from a previous day — auto-close it so a new one can be opened
        try { await this.api('PATCH', `/drawers/sessions/${s.id}/close`, {}); } catch(e) {}
      }
    } catch(e) {}

    // Fetch all active drawers (includes active_session_id / active_employee_name for in-use detection)
    let allDrawers;
    try { allDrawers = await this.api('GET', '/drawers'); } catch(e) { return; }

    const branchIds = branches.length ? branches.map(b => b.id) : null;
    const branchDrawers = allDrawers.filter(d => !branchIds || branchIds.some(id => id == d.branch_id));
    this._posHasDrawers = branchDrawers.length > 0;
    this.renderPOSBranchBar();
    if (!branchDrawers.length) return;

    this.showPOSDrawerModal(branches, branchDrawers, isMultiBranch, defaultBranch);
  },

  _buildDrawerSelHTML(drawers) {
    const available = drawers.filter(d => !d.active_session_id);
    const inUse = drawers.filter(d => d.active_session_id);
    const selHTML = available.length
      ? available.map(d => `<option value="${d.id}">${d.name}</option>`).join('')
      : '<option value="">— No drawers available —</option>';
    const inUseHTML = inUse.length
      ? `<div style="margin-top:10px;padding:8px 10px;background:#fef3cd;border:1px solid #ffc107;border-radius:4px;font-size:12px">
           <strong style="color:#856404">Currently in use:</strong>
           ${inUse.map(d => `<div style="margin-top:3px;color:#856404">${d.name} — ${d.active_employee_name || 'another user'}</div>`).join('')}
         </div>`
      : '';
    return { selHTML, inUseHTML, hasAvailable: available.length > 0 };
  },

  showPOSDrawerModal(branches, allDrawers, isMultiBranch, defaultBranch) {
    document.getElementById('pos-drawer-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'pos-drawer-overlay';
    overlay.style.cssText = 'z-index:9400';

    const branchId = (this.posBranch || defaultBranch)?.id || '';
    const drawersForBranch = allDrawers.filter(d => d.branch_id == branchId);
    this._posAllDrawers = allDrawers;
    const { selHTML, inUseHTML, hasAvailable } = this._buildDrawerSelHTML(drawersForBranch);

    overlay.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <span class="modal-title">Open Cash Drawer</span>
        </div>
        <div class="modal-body">
          ${isMultiBranch ? `
          <div class="form-group"><label>Branch *</label>
            <select id="pos-drawer-branch" onchange="App.onPOSDrawerBranchChange()">
              ${branches.map(b => `<option value="${b.id}" ${b.id==branchId?'selected':''}>${b.name}</option>`).join('')}
            </select>
          </div>` : `
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
            Branch: <strong>${defaultBranch?.name || '—'}</strong>
          </p>`}
          <div id="pos-drawer-sel-wrap">
            <div class="form-group"><label>Select Drawer *</label>
              <select id="pos-drawer-sel" ${!hasAvailable ? 'disabled' : ''}>${selHTML}</select>
            </div>
            ${inUseHTML}
          </div>
          <div class="form-group" id="pos-float-group" ${!hasAvailable ? 'style="display:none"' : ''}>
            <label>Opening Float ($)</label>
            <input type="number" id="pos-drawer-float" min="0" step="0.01" value="0" placeholder="0.00">
          </div>
          <div id="pos-drawer-err" style="color:var(--danger);font-size:13px;min-height:16px"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('pos-drawer-overlay').remove()">Skip</button>
          <button class="btn btn-primary" onclick="App.openPOSDrawer()" ${!hasAvailable ? 'disabled' : ''}>Open Drawer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    if (hasAvailable) setTimeout(() => document.getElementById('pos-drawer-float')?.focus(), 50);
  },

  onPOSDrawerBranchChange() {
    const branchId = document.getElementById('pos-drawer-branch')?.value;
    const wrap = document.getElementById('pos-drawer-sel-wrap');
    const floatGroup = document.getElementById('pos-float-group');
    const openBtn = document.querySelector('#pos-drawer-overlay .btn-primary');
    if (!wrap || !branchId) return;
    const drawers = (this._posAllDrawers || []).filter(d => d.branch_id == branchId);
    const { selHTML, inUseHTML, hasAvailable } = this._buildDrawerSelHTML(drawers);
    wrap.innerHTML = `
      <div class="form-group"><label>Select Drawer *</label>
        <select id="pos-drawer-sel" ${!hasAvailable ? 'disabled' : ''}>${selHTML}</select>
      </div>${inUseHTML}`;
    if (floatGroup) floatGroup.style.display = hasAvailable ? '' : 'none';
    if (openBtn) openBtn.disabled = !hasAvailable;
  },

  async openPOSDrawer() {
    const drawerId = document.getElementById('pos-drawer-sel')?.value;
    const float = parseFloat(document.getElementById('pos-drawer-float')?.value) || 0;
    const errEl = document.getElementById('pos-drawer-err');
    const branchEl = document.getElementById('pos-drawer-branch');
    const branches = this.currentUser.branches || [];
    const branchId = branchEl
      ? parseInt(branchEl.value)
      : (this.posBranch || branches.find(b => b.is_default) || branches[0])?.id;

    if (!drawerId) { if (errEl) errEl.textContent = 'Select a drawer.'; return; }
    try {
      const session = await this.api('POST', '/drawers/sessions', {
        drawer_id: parseInt(drawerId),
        branch_id: branchId || null,
        employee_id: this.currentUser.id,
        opening_float: float,
      });
      this.currentDrawerSession = session;
      // Sync branch selection
      const branch = branches.find(b => b.id === branchId);
      if (branch) this.posBranch = branch;
      document.getElementById('pos-drawer-overlay')?.remove();
      this.updateDrawerBadge();
      this.renderPOSBranchBar();
      this.renderRentalDrawerBanner();
      this.alert(`Drawer opened — float $${App._n2(float)}`);
    } catch(e) { if (errEl) errEl.textContent = e.message; }
  },

  updateDrawerBadge() {
    // Refresh the POS branch bar if it's currently visible
    this.renderPOSBranchBar();
  },
});
