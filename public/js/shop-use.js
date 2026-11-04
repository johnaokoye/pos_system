// Shop Use: requests, issues, returns, tool register, reconciliation, reports, routing, inbox.
Object.assign(App, {
  // ─── Shop Use ─────────────────────────────────────────────────────────────
  // Stock taken for company use (routes/shop-use.js, lib/shopUse.js):
  // request → approval → issue (stock out at inventory cost, posted to
  // RetailPOS Books) → returns / reversals → Finance reconciliation.
  // Approval, fulfilment, posting and reconciliation statuses are tracked
  // separately so a partial issue reads correctly.
  _suStatus: {
    approval: { draft: ['Draft', 'su-badge-muted'], pending_approval: ['Pending Approval', 'badge-warning'], returned: ['Returned for Correction', 'badge-purple'], approved: ['Approved', 'badge-success'], rejected: ['Rejected', 'badge-danger'] },
    fulfillment: { not_issued: ['Not Issued', 'su-badge-muted'], partial: ['Partially Issued', 'badge-warning'], issued: ['Fully Issued', 'badge-success'], cancelled: ['Cancelled', 'badge-danger'] },
    posting: { pending: ['Pending Posting', 'badge-warning'], posted: ['Posted', 'badge-success'], failed: ['Posting Failed', 'badge-danger'], not_required: ['No Posting Needed', 'su-badge-muted'] },
    recon: { unreconciled: ['Unreconciled', 'badge-warning'], reconciled: ['Reconciled', 'badge-success'] },
  },
  _suBadge(kind, value) {
    if (!value) return '<span style="color:var(--text-muted)">—</span>';
    const [label, cls] = this._suStatus[kind][value] || [value, 'su-badge-muted'];
    return `<span class="badge-pill ${cls}" style="white-space:nowrap">${label}</span>`;
  },
  _suCanOpen() { return this.can('shop_use') || this.can('shop_use_approve'); },
  _suQty(n) { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000); },
  _suDate(d) { return d ? this.fmtDateTime(String(d).includes('T') ? d : String(d).replace(' ', 'T') + 'Z') : '—'; },
  _suKey() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; },

  async _suMeta(refresh) {
    if (!this._suMetaCache || refresh) this._suMetaCache = await this.api('GET', '/shop-use/meta');
    return this._suMetaCache;
  },

  async renderShopUse(tab) {
    if (tab) this._suTab = tab;
    this._pollShopUseInbox();
    const tabs = [['dashboard', 'Dashboard'], ['requests', 'Requests']];
    if (this.can('shop_use_issue')) tabs.push(['issue', 'Issue']);
    tabs.push(['tools', 'Tool Register']);
    if (this.can('shop_use_finance')) tabs.push(['reconciliation', 'Reconciliation']);
    if (this.can('shop_use_reports') || this.can('shop_use_finance')) tabs.push(['reports', 'Reports']);
    if (this.can('shop_use_routing') || this.can('shop_use_finance')) tabs.push(['settings', 'Settings']);
    if (!tabs.some(([k]) => k === this._suTab)) this._suTab = 'dashboard';
    tab = this._suTab;
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let dash;
    try { [dash] = await Promise.all([this.api('GET', '/shop-use/dashboard'), this._suMeta(!tab)]); }
    catch (e) { if (this.section === 'shop-use') c.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (this.section !== 'shop-use') return;
    this._suDash = dash;
    const n = dash.counts;
    const badge = (k) => {
      const v = { requests: n.awaiting_my_approval, issue: n.approved_awaiting_issue + n.partially_issued, reconciliation: n.posting_failed + n.unreconciled }[k];
      return v ? ` <span class="badge-pill badge-warning" style="font-size:10px;margin-left:4px">${v}</span>` : '';
    };
    c.innerHTML = `
      <div class="section-header">
        <h2>Shop Use</h2>
        <div style="display:flex;gap:10px">
          ${this.can('shop_use_request') ? `<button class="btn btn-primary" onclick="App.showShopUseForm()">+ New Request</button>` : ''}
        </div>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:-6px 0 14px">Stock taken for company use — cleaning, branch maintenance, equipment repairs, internal projects and reusable tools — valued at inventory cost. Staff purchases, giveaways, damaged stock and shortages are handled elsewhere.</p>
      <div class="var-tab-bar" style="padding:0;margin-bottom:14px">
        ${tabs.map(([k, l]) => `<div class="var-tab ${tab === k ? 'active' : ''}" onclick="App.renderShopUse('${k}')">${l}${badge(k)}</div>`).join('')}
      </div>
      <div id="su-tab-body"></div>`;
    const run = { dashboard: '_suRenderDashboard', requests: '_suRenderRequests', issue: '_suRenderIssueQueue', tools: '_suRenderTools', reconciliation: '_suRenderRecon', reports: '_suRenderReports', settings: '_suRenderSettings' }[tab];
    await this[run]();
  },

  _suTile(label, value, opts = {}) {
    return `<div class="card" style="padding:14px 16px;${opts.onclick ? 'cursor:pointer' : ''}" ${opts.onclick ? `onclick="${opts.onclick}"` : ''}>
      <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em">${label}</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;${opts.color ? `color:${opts.color}` : ''}">${value}</div>
      ${opts.sub ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${opts.sub}</div>` : ''}
    </div>`;
  },

  _suRequestRows(rows, cols = 'full') {
    if (!rows.length) return `<tr><td colspan="10" class="empty-state">Nothing here</td></tr>`;
    return rows.map(r => `
      <tr style="cursor:pointer" onclick="App.viewShopUseRequest(${r.id})">
        <td class="fw-600">${r.request_number}${r.overdue ? ' <span class="badge-pill badge-danger" style="font-size:9px">Overdue</span>' : ''}${r.awaiting_me ? ' <span class="badge-pill badge-info" style="font-size:9px">Your approval</span>' : ''}</td>
        <td style="white-space:nowrap">${this._apDate(r.created_at)}</td>
        <td>${this.escapeAttr(r.requested_by_name || '—')}</td>
        <td>${this.escapeAttr(r.branch_name || '—')}<div style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(r.department || '')}</div></td>
        <td style="font-size:12px">${this.escapeAttr(r.category_label || r.category)}</td>
        <td style="text-align:right">${this.fmt(r.total_estimated)}</td>
        <td>${this._suBadge('approval', r.approval_status)}</td>
        <td>${r.approval_status === 'approved' || r.fulfillment_status !== 'not_issued' ? this._suBadge('fulfillment', r.fulfillment_status) : '<span style="color:var(--text-muted)">—</span>'}</td>
        ${cols === 'full' ? `<td>${this._suBadge('posting', r.posting_status)}</td><td>${this._suBadge('recon', r.recon_status)}</td>` : ''}
      </tr>`).join('');
  },
  _suRequestHead(cols = 'full') {
    return `<thead><tr><th>Request #</th><th>Date</th><th>Requester</th><th>For</th><th>Category</th><th style="text-align:right">Est. Value</th><th>Approval</th><th>Fulfilment</th>${cols === 'full' ? '<th>Posting</th><th>Reconciliation</th>' : ''}</tr></thead>`;
  },

  async _suRenderDashboard() {
    const el = document.getElementById('su-tab-body');
    const d = this._suDash, n = d.counts;
    const goto = (filter) => `App._suReqFilter = Object.assign(App._suDefaultReqFilter(), ${this.escapeAttr(JSON.stringify(filter))}); App.renderShopUse('requests')`;
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px">
        ${this._suTile('Pending Approval', n.pending_approval, { sub: this.fmt(n.pending_value), onclick: goto({ approval_status: 'pending_approval' }) })}
        ${this._suTile('Overdue Approvals', n.overdue_approvals, { color: n.overdue_approvals ? 'var(--danger)' : '', sub: `waiting over ${d.approval_hours}h`, onclick: goto({ approval_status: 'pending_approval' }) })}
        ${this.can('shop_use_approve') ? this._suTile('Awaiting Your Approval', n.awaiting_my_approval, { color: n.awaiting_my_approval ? 'var(--warning, #b45309)' : '', onclick: goto({ view: 'awaiting_me' }) }) : ''}
        ${this._suTile('Approved, Awaiting Issue', n.approved_awaiting_issue, { onclick: goto({ approval_status: 'approved', fulfillment_status: 'not_issued' }) })}
        ${this._suTile('Partially Issued', n.partially_issued, { sub: `${n.outstanding_lines} line(s) · ${this.fmt(n.outstanding_value)} outstanding`, onclick: goto({ fulfillment_status: 'partial' }) })}
        ${this._suTile('Posting Failures', n.posting_failed, { color: n.posting_failed ? 'var(--danger)' : '', sub: `${n.posting_pending} pending`, onclick: this.can('shop_use_finance') ? "App.renderShopUse('reconciliation')" : '' })}
        ${this._suTile('Unreconciled', n.unreconciled, { color: n.unreconciled ? 'var(--warning, #b45309)' : '', onclick: this.can('shop_use_finance') ? "App.renderShopUse('reconciliation')" : '' })}
        ${this._suTile('Cost This Month', this.fmt(n.month_cost), { sub: 'net of returns' })}
        ${this._suTile('Tools Out', n.tools_assigned, { onclick: "App.renderShopUse('tools')" })}
      </div>
      <div class="card" style="margin-bottom:14px"><div class="card-header"><span class="card-title">Overdue approvals</span></div>
        <div class="table-wrap"><table>${this._suRequestHead('short')}<tbody>${this._suRequestRows(d.overdue, 'short')}</tbody></table></div></div>
      <div class="card" style="margin-bottom:14px"><div class="card-header"><span class="card-title">Approved requests awaiting issue</span></div>
        <div class="table-wrap"><table>${this._suRequestHead('short')}<tbody>${this._suRequestRows(d.awaiting_issue, 'short')}</tbody></table></div></div>
      ${d.failed_postings.length ? `<div class="card"><div class="card-header"><span class="card-title">Posting failures</span></div>
        <div class="table-wrap"><table><thead><tr><th>Reference</th><th>Request</th><th>Date</th><th style="text-align:right">Amount</th><th>Error</th></tr></thead><tbody>
        ${d.failed_postings.map(p => `<tr style="cursor:pointer" onclick="App.viewShopUseRequest(${p.request_id})"><td class="fw-600">${p.reference}</td><td>${p.request_number}</td><td>${this._apDate(p.posting_date)}</td><td style="text-align:right">${this.fmt(p.amount)}</td><td style="font-size:12px;color:var(--danger)">${this.escapeAttr(p.last_error || '')}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}`;
  },

  _suDefaultReqFilter() { return { view: 'all', approval_status: '', fulfillment_status: '', posting_status: '', recon_status: '', branch_id: '', category: '', q: '' }; },

  async _suRenderRequests() {
    const el = document.getElementById('su-tab-body');
    const meta = await this._suMeta();
    const f = this._suReqFilter || (this._suReqFilter = this._suDefaultReqFilter());
    const opts = (map, cur, all) => `<option value="">${all}</option>` + Object.entries(map).map(([k, [l]]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`).join('');
    const views = [['all', 'All requests'], ['mine', 'My requests']];
    if (this.can('shop_use_approve')) views.push(['awaiting_me', 'Awaiting my approval']);
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="su-f-view" style="width:auto">${views.map(([v, l]) => `<option value="${v}" ${f.view === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="su-f-approval" style="width:auto">${opts(this._suStatus.approval, f.approval_status, 'Any approval status')}</select>
        <select id="su-f-fulfil" style="width:auto">${opts(this._suStatus.fulfillment, f.fulfillment_status, 'Any fulfilment')}</select>
        <select id="su-f-posting" style="width:auto">${opts(this._suStatus.posting, f.posting_status, 'Any posting status')}</select>
        <select id="su-f-recon" style="width:auto">${opts(this._suStatus.recon, f.recon_status, 'Any reconciliation')}</select>
        <select id="su-f-branch" style="width:auto"><option value="">All branches</option>${meta.branches.map(b => `<option value="${b.id}" ${String(f.branch_id) === String(b.id) ? 'selected' : ''}>${this.escapeAttr(b.name)}</option>`).join('')}</select>
        <select id="su-f-cat" style="width:auto"><option value="">All categories</option>${meta.categories.map(c => `<option value="${c.key}" ${f.category === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        <input id="su-f-q" placeholder="Request #, item, reason, requester…" value="${this.escapeAttr(f.q)}" style="flex:1;min-width:180px">
      </div>
      <div class="card"><div class="table-wrap"><table>${this._suRequestHead()}<tbody id="su-req-tbody"><tr><td colspan="10" class="empty-state">Loading...</td></tr></tbody></table></div></div>`;
    const load = async () => {
      const qs = new URLSearchParams();
      if (f.view === 'mine') qs.set('mine', '1');
      if (f.view === 'awaiting_me') qs.set('awaiting_me', '1');
      for (const k of ['approval_status', 'fulfillment_status', 'posting_status', 'recon_status', 'branch_id', 'category', 'q']) if (f[k]) qs.set(k, f[k]);
      const rows = await this.api('GET', `/shop-use/requests?${qs}`);
      const tb = document.getElementById('su-req-tbody');
      if (tb) tb.innerHTML = this._suRequestRows(rows);
    };
    const bind = (id, key) => document.getElementById(id).addEventListener('change', e => { f[key] = e.target.value; load(); });
    bind('su-f-view', 'view'); bind('su-f-approval', 'approval_status'); bind('su-f-fulfil', 'fulfillment_status'); bind('su-f-posting', 'posting_status');
    bind('su-f-recon', 'recon_status'); bind('su-f-branch', 'branch_id'); bind('su-f-cat', 'category');
    let timer;
    document.getElementById('su-f-q').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); });
    await load();
  },

  async _suRenderIssueQueue() {
    const el = document.getElementById('su-tab-body');
    const rows = await this.api('GET', '/shop-use/issue-queue');
    if (!el.isConnected) return;
    el.innerHTML = `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Request #</th><th>Approved</th><th>For</th><th>Supplying Location</th><th>Category</th><th>Requester</th><th>Status</th><th style="text-align:right">Outstanding</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map(r => `
        <tr>
          <td class="fw-600"><a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewShopUseRequest(${r.id})">${r.request_number}</a></td>
          <td>${this._suDate(r.decided_at)}<div style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(r.decided_by_name || '')}</div></td>
          <td>${this.escapeAttr(r.branch_name || '')}<div style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(r.department || '')}</div></td>
          <td>${this.escapeAttr(r.source_branch_name || '')}</td>
          <td style="font-size:12px">${this.escapeAttr(r.category_label)}</td>
          <td>${this.escapeAttr(r.requested_by_name || '')}</td>
          <td>${this._suBadge('fulfillment', r.fulfillment_status)}</td>
          <td style="text-align:right">${this.fmt(r.value_outstanding)}</td>
          <td><button class="btn btn-sm btn-primary" onclick="App._suIssue(${r.id})">Issue</button></td>
        </tr>`).join('') : '<tr><td colspan="9" class="empty-state">No approved requests are waiting to be issued</td></tr>'}
      </tbody></table></div></div>`;
  },

  // ── Request form ──────────────────────────────────────────────────────────
  async _suAddDepartment(name) {
    const d = await this.api('POST', '/shop-use/departments', { name });
    if (this._suMetaCache && !this._suMetaCache.departments.includes(d.name)) this._suMetaCache.departments.push(d.name);
    return { value: d.name, text: d.name };
  },

  async showShopUseForm(id) {
    const [meta, r] = await Promise.all([this._suMeta(), id ? this.api('GET', `/shop-use/requests/${id}`) : null]);
    const myBranch = this.currentUser.default_branch_id || meta.branches[0]?.id;
    const req = r || { category: '', branch_id: myBranch, source_branch_id: myBranch, department: '', reason: '' };
    const depts = [...meta.departments];
    if (req.department && !depts.some(d => d.toLowerCase() === req.department.toLowerCase())) depts.unshift(req.department);
    const amend = r && ['pending_approval', 'approved'].includes(r.approval_status);
    const anyIssued = r && r.lines.some(l => l.qty_issued > 0);
    const lockHead = anyIssued ? 'disabled title="Items have been issued — this can\'t change"' : '';
    this._suForm = { id: id || null, lines: [] };
    this.showModal(`
      <div class="modal" style="max-width:980px">
        <div class="modal-header"><span class="modal-title">${r ? `Edit Shop Use Request ${r.request_number}` : 'New Shop Use Request'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${amend ? `<div style="background:#FFF8E1;border:1px solid #f0d58a;border-radius:6px;padding:8px 12px;font-size:13px;margin-bottom:12px">This request is ${r.approval_status === 'approved' ? 'approved' : 'waiting for approval'}. Changing its items, quantities, supplying location, branch, department or category sends it back for approval${r.approval_status === 'approved' ? ' — nothing more can be issued until it is approved again' : ''}.</div>` : ''}
          <div class="input-row" style="grid-template-columns:1fr 1fr 1fr">
            <div class="form-group"><label>Category *</label>
              <select id="su-cat" ${lockHead}><option value="">— Choose —</option>${meta.categories.map(c => `<option value="${c.key}" ${req.category === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
            </div>
            <div class="form-group"><label>For branch *</label>
              <select id="su-branch" ${lockHead}>${meta.branches.map(b => `<option value="${b.id}" ${String(req.branch_id) === String(b.id) ? 'selected' : ''}>${this.escapeAttr(b.name)}</option>`).join('')}</select>
            </div>
            <div class="form-group"><label>For department *</label>
              <select id="su-dept" data-searchable data-add="App._suAddDepartment" ${lockHead}><option value="">— Choose —</option>${depts.map(d => `<option value="${this.escapeAttr(d)}" ${String(req.department || '').toLowerCase() === d.toLowerCase() ? 'selected' : ''}>${this.escapeAttr(d)}</option>`).join('')}</select>
            </div>
          </div>
          <div class="input-row" style="grid-template-columns:1fr 1fr 1fr">
            <div class="form-group"><label>Supplying stock location *</label>
              <select id="su-source" ${lockHead} onchange="App._suRefreshAvailability()">${meta.branches.map(b => `<option value="${b.id}" ${String(req.source_branch_id) === String(b.id) ? 'selected' : ''}>${this.escapeAttr(b.name)}${b.is_warehouse ? ' (warehouse)' : ''}</option>`).join('')}</select>
            </div>
            <div class="form-group"><label>Equipment ID</label><input id="su-equip" value="${this.escapeAttr(req.equipment_ref || '')}" placeholder="Asset tag / serial being repaired"></div>
            <div class="form-group"><label>Project reference</label><input id="su-project" value="${this.escapeAttr(req.project_ref || '')}" placeholder="Internal project code"></div>
          </div>
          <div class="form-group"><label>Reason *</label><textarea id="su-reason" rows="2" placeholder="What the items are needed for">${this.escapeAttr(req.reason || '')}</textarea></div>
          <div class="card-header" style="margin-top:6px"><span class="card-title">Items</span>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm btn-outline" onclick="App._suAddLine()">+ Add Item</button>
              <button class="btn btn-sm btn-outline" onclick="App._suAddToolLine()" title="Borrow a tool already on the company tool register">+ Borrow Tool</button>
            </div>
          </div>
          <div class="table-wrap"><table style="font-size:13px">
            <thead><tr><th style="min-width:240px">Item</th><th>Unit</th><th style="width:90px">Qty</th><th style="text-align:right">Available</th><th style="text-align:right">Unit Cost</th><th style="text-align:right">Line Total</th><th style="width:130px">Equipment ID</th><th></th></tr></thead>
            <tbody id="su-lines"></tbody>
            <tfoot><tr><td colspan="5" style="text-align:right;font-weight:700">Estimated total (inventory cost)</td><td id="su-total" style="text-align:right;font-weight:700"></td><td colspan="2"></td></tr></tfoot>
          </table></div>
          <div id="su-shortage" style="display:none;margin-top:8px;padding:8px 12px;border-radius:6px;background:#FFEBEE;color:#C62828;font-size:13px"></div>
          <div class="input-row" style="margin-top:12px">
            <div class="form-group"><label>Notes</label><input id="su-notes" value="${this.escapeAttr(req.notes || '')}"></div>
            <div class="form-group"><label>Supporting documents / photos <span style="font-weight:400;color:var(--text-muted);font-size:12px">(PDF, image, Word, Excel — 20 MB each)</span></label>
              <input type="file" id="su-files" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.heic,.txt"></div>
          </div>
          ${amend ? `<div class="form-group"><label>Reason for the change <span style="font-weight:400;color:var(--text-muted);font-size:12px">(shown to the approver)</span></label><input id="su-amend-reason"></div>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          ${!r || ['draft', 'returned'].includes(r.approval_status) ? `<button class="btn btn-outline" onclick="App._suSaveForm(false)">Save Draft</button>
            <button class="btn btn-primary" onclick="App._suSaveForm(true)">Submit for Approval</button>`
            : `<button class="btn btn-primary" onclick="App._suSaveForm(false)">Save Changes</button>`}
        </div>
      </div>`);
    if (r) {
      for (const l of r.lines) {
        this._suForm.lines.push({
          key: this._suKey(), id: l.id, product_id: l.product_id, tool_id: l.tool_id, sku: l.sku, description: l.description,
          name: l.product_name || l.description, cost: l.qty_issued > 0 ? l.unit_cost / (l.units_per || 1) : (l.current_cost ?? l.unit_cost / (l.units_per || 1)),
          uom_id: l.uom_id, units: [], base_unit_name: null, units_per: l.units_per, qty: l.qty_requested, on_hand: l.on_hand_units, equipment_ref: l.equipment_ref || '',
          issued: l.qty_issued, locked: l.qty_issued > 0,
        });
      }
      await this._suRefreshAvailability();
    } else {
      this._suAddLine();
    }
    this._suRenderLines();
    if (!this._suDdBound) {
      this._suDdBound = true;
      document.addEventListener('click', e => { if (!e.target.closest('.su-item-search')) document.querySelectorAll('.su-item-dd').forEach(d => { d.style.display = 'none'; }); });
    }
  },

  _suAddLine() {
    this._suForm.lines.push({ key: this._suKey(), product_id: null, tool_id: null, qty: 1, units: [], units_per: 1, equipment_ref: '' });
    this._suRenderLines();
  },

  async _suAddToolLine() {
    const tools = await this.api('GET', '/shop-use/tools?status=available');
    const taken = new Set(this._suForm.lines.map(l => l.tool_id).filter(Boolean));
    const avail = tools.filter(t => !taken.has(t.id));
    if (!avail.length) { this.alert('No tools on the register are available to borrow', 'error'); return; }
    const pick = document.createElement('div');
    pick.className = 'modal-overlay';
    pick.style.zIndex = 1100;
    pick.innerHTML = `<div class="modal" style="max-width:560px"><div class="modal-header"><span class="modal-title">Borrow a tool from the register</span><button class="modal-close">✕</button></div>
      <div class="modal-body"><div class="table-wrap"><table><thead><tr><th>Tool #</th><th>Description</th><th>Serial</th><th>Location</th><th></th></tr></thead><tbody>
      ${avail.map(t => `<tr><td class="fw-600">${t.tool_number}</td><td>${this.escapeAttr(t.description)}</td><td>${this.escapeAttr(t.serial_number || '—')}</td><td>${this.escapeAttr([t.branch_name, t.location].filter(Boolean).join(' · ') || '—')}</td>
        <td><button class="btn btn-sm btn-primary" data-id="${t.id}">Add</button></td></tr>`).join('')}
      </tbody></table></div></div></div>`;
    document.body.appendChild(pick);
    pick.querySelector('.modal-close').onclick = () => pick.remove();
    pick.querySelectorAll('button[data-id]').forEach(b => b.onclick = () => {
      const t = avail.find(x => String(x.id) === b.dataset.id);
      const blank = this._suForm.lines.findIndex(l => !l.product_id && !l.tool_id);
      const line = { key: this._suKey(), tool_id: t.id, sku: t.tool_number, name: `${t.description}${t.serial_number ? ` (S/N ${t.serial_number})` : ''}`, description: t.description, qty: 1, cost: 0, units: [], units_per: 1, on_hand: 1, equipment_ref: '' };
      if (blank >= 0) this._suForm.lines[blank] = line; else this._suForm.lines.push(line);
      pick.remove();
      this._suRenderLines();
    });
  },

  _suRenderLines() {
    const tb = document.getElementById('su-lines');
    if (!tb) return;
    const lines = this._suForm.lines;
    tb.innerHTML = lines.map((l, i) => {
      const per = Number(l.units_per) || 1;
      const unitCost = (Number(l.cost) || 0) * per;
      const avail = l.tool_id ? 1 : l.on_hand == null ? null : (Number(l.on_hand) || 0) / per;
      const short = l.product_id && avail != null && Number(l.qty) - (Number(l.issued) || 0) > avail;
      const unitOpts = l.product_id ? [{ id: '', name: l.base_unit_name || 'Each', factor: 1 }, ...(l.units || []).map(u => ({ id: u.unit_id, name: `${u.name} (${this._suQty(u.factor)})`, factor: u.factor }))] : [];
      return `<tr>
        <td>${l.tool_id ? `<div class="fw-600">${this.escapeAttr(l.name)}</div><div style="font-size:11px;color:var(--text-muted)">${l.sku} · borrowed from tool register</div>`
          : l.locked ? `<div class="fw-600">${this.escapeAttr(l.name)}</div><div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(l.sku || '')} · ${this._suQty(l.issued)} already issued</div>`
          : `<div class="su-item-search" style="position:relative">
              <input value="${this.escapeAttr(l.product_id ? `${l.sku ? l.sku + ' — ' : ''}${l.name}` : '')}" placeholder="Search item code or name…" oninput="App._suSearchItem(${i}, this.value)" onfocus="this.select()">
              <div class="su-item-dd" id="su-dd-${i}" style="display:none;position:absolute;z-index:50;left:0;right:0;top:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;max-height:240px;overflow:auto;box-shadow:0 6px 18px rgba(0,0,0,.12)"></div>
            </div>`}</td>
        <td>${l.product_id && !l.locked && unitOpts.length > 1 ? `<select onchange="App._suSetUnit(${i}, this.value)" style="width:auto">${unitOpts.map(u => `<option value="${u.id}" ${String(l.uom_id || '') === String(u.id) ? 'selected' : ''}>${this.escapeAttr(u.name)}</option>`).join('')}</select>`
          : `<span style="font-size:12px">${l.tool_id ? 'Tool' : this.escapeAttr(unitOpts.find(u => String(u.id) === String(l.uom_id || ''))?.name || l.base_unit_name || 'Each')}</span>`}</td>
        <td>${l.tool_id ? '1' : `<input type="number" min="0" step="any" value="${l.qty}" style="width:80px" oninput="App._suSetQty(${i}, this.value)">`}</td>
        <td style="text-align:right;${short ? 'color:var(--danger);font-weight:600' : ''}">${avail == null ? '—' : this._suQty(avail)}${short ? '<div style="font-size:11px">short</div>' : ''}</td>
        <td style="text-align:right">${l.tool_id ? '—' : this.fmt(unitCost)}</td>
        <td style="text-align:right">${l.tool_id ? '—' : this.fmt(unitCost * (Number(l.qty) || 0))}</td>
        <td><input value="${this.escapeAttr(l.equipment_ref || '')}" oninput="App._suForm.lines[${i}].equipment_ref = this.value" style="width:120px"></td>
        <td>${l.locked ? '' : `<button class="btn btn-sm btn-outline" onclick="App._suForm.lines.splice(${i}, 1); App._suRenderLines()" title="Remove">✕</button>`}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="empty-state">Add an item</td></tr>';
    this._suUpdateTotals();
  },

  _suUpdateTotals() {
    const lines = this._suForm.lines;
    const total = lines.reduce((s, l) => s + (Number(l.cost) || 0) * (Number(l.units_per) || 1) * (Number(l.qty) || 0), 0);
    const t = document.getElementById('su-total');
    if (t) t.textContent = this.fmt(total);
    const short = lines.filter(l => l.product_id && l.on_hand != null && (Number(l.qty) - (Number(l.issued) || 0)) * (Number(l.units_per) || 1) > Number(l.on_hand));
    const box = document.getElementById('su-shortage');
    if (box) {
      box.style.display = short.length ? 'block' : 'none';
      box.innerHTML = short.length ? `<strong>Not enough stock at the supplying location:</strong> ${short.map(l => `${this.escapeAttr(l.name)} (short ${this._suQty((Number(l.qty) - (Number(l.issued) || 0)) - Number(l.on_hand) / (Number(l.units_per) || 1))})`).join(', ')}. You can still submit — once saved, use <em>Raise Purchase Request</em> on the request to order the shortage through purchasing approval.` : '';
    }
  },

  _suSetQty(i, v) {
    this._suForm.lines[i].qty = v;
    this._suUpdateTotals();
    // Refresh just the shortage marker on this row without losing focus.
    const l = this._suForm.lines[i];
    const row = document.getElementById('su-lines')?.children[i];
    if (row && l.product_id && l.on_hand != null) {
      const per = Number(l.units_per) || 1;
      const avail = Number(l.on_hand) / per;
      const short = Number(v) - (Number(l.issued) || 0) > avail;
      row.children[3].style.color = short ? 'var(--danger)' : '';
      row.children[3].innerHTML = `${this._suQty(avail)}${short ? '<div style="font-size:11px">short</div>' : ''}`;
      row.children[5].textContent = this.fmt((Number(l.cost) || 0) * per * (Number(v) || 0));
    }
  },

  _suSetUnit(i, uomId) {
    const l = this._suForm.lines[i];
    const u = (l.units || []).find(x => String(x.unit_id) === String(uomId));
    l.uom_id = uomId ? Number(uomId) : null;
    l.units_per = u ? Number(u.factor) : 1;
    this._suRenderLines();
  },

  _suSearchItem(i, q) {
    clearTimeout(this._suSearchTimer);
    const dd = document.getElementById(`su-dd-${i}`);
    if (!dd) return;
    if (q.trim().length < 2) { dd.style.display = 'none'; return; }
    this._suSearchTimer = setTimeout(async () => {
      const src = document.getElementById('su-source')?.value || '';
      const items = await this.api('GET', `/shop-use/items?q=${encodeURIComponent(q.trim())}&branch_id=${src}`).catch(() => []);
      this._suSearchResults = items;
      dd.innerHTML = items.length ? items.map((p, k) => `<div style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px" onmousedown="event.preventDefault();App._suPickItem(${i}, ${k})">
          <div class="fw-600">${this.escapeAttr(p.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(p.sku || '')} · ${this._suQty(p.on_hand)} on hand · cost ${this.fmt(p.cost)}</div>
        </div>`).join('') : '<div style="padding:8px 10px;font-size:13px;color:var(--text-muted)">No stocked items match</div>';
      dd.style.display = 'block';
    }, 250);
  },

  _suPickItem(i, k) {
    const p = this._suSearchResults[k];
    if (this._suForm.lines.some((l, j) => j !== i && l.product_id === p.id && !l.uom_id)) { this.alert(`${p.name} is already on the request — change its quantity instead`, 'error'); return; }
    Object.assign(this._suForm.lines[i], { product_id: p.id, tool_id: null, sku: p.sku, name: p.name, cost: Number(p.cost) || 0, units: p.units || [], base_unit_name: p.base_unit_name, uom_id: null, units_per: 1, on_hand: p.on_hand });
    this._suRenderLines();
  },

  async _suRefreshAvailability() {
    const src = document.getElementById('su-source')?.value || '';
    for (const l of this._suForm.lines) {
      if (!l.product_id) continue;
      const items = await this.api('GET', `/shop-use/items?q=${encodeURIComponent(l.sku || l.name)}&branch_id=${src}`).catch(() => []);
      const hit = items.find(p => p.id === l.product_id);
      if (hit) { l.on_hand = hit.on_hand; l.units = hit.units || []; l.base_unit_name = hit.base_unit_name; if (!l.locked) l.cost = Number(hit.cost) || 0; }
    }
    this._suRenderLines();
  },

  async _suSaveForm(submit) {
    const v = id => document.getElementById(id)?.value;
    const lines = this._suForm.lines.filter(l => l.product_id || l.tool_id).map(l => ({
      id: l.id || undefined, product_id: l.product_id || undefined, tool_id: l.tool_id || undefined, uom_id: l.uom_id || null, quantity: l.qty, equipment_ref: l.equipment_ref,
    }));
    const body = {
      category: v('su-cat'), branch_id: v('su-branch'), department: v('su-dept'), source_branch_id: v('su-source'), reason: v('su-reason'),
      equipment_ref: v('su-equip'), project_ref: v('su-project'), notes: v('su-notes'), lines, submit, amend_reason: v('su-amend-reason'),
    };
    const files = [...(document.getElementById('su-files')?.files || [])];
    try {
      const saved = this._suForm.id ? await this.api('PUT', `/shop-use/requests/${this._suForm.id}`, body) : await this.api('POST', '/shop-use/requests', body);
      for (const f of files) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch(`/api/shop-use/requests/${saved.id}/attachments`, { method: 'POST', body: fd });
        if (!res.ok) this.alert(`${f.name}: ${(await res.json().catch(() => ({}))).error || 'upload failed'}`, 'error');
      }
      this.alert(saved.approval_status === 'pending_approval' ? `${saved.request_number} sent for approval to ${saved.routed_approvers.map(a => a.name).join(', ')}` : `${saved.request_number} saved`);
      this.closeModal();
      if (this.section === 'shop-use') this.renderShopUse(this._suTab);
      this.viewShopUseRequest(saved.id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Request view ──────────────────────────────────────────────────────────
  async viewShopUseRequest(id) {
    let r;
    try { r = await this.api('GET', `/shop-use/requests/${id}`); } catch (e) { this.alert(e.message, 'error'); return; }
    const me = this.currentUser.id;
    const mine = r.requested_by === me;
    const open = !['issued', 'cancelled'].includes(r.fulfillment_status) && r.approval_status !== 'rejected';
    const outstanding = r.lines.some(l => l.outstanding > 0);
    const shortage = r.lines.some(l => l.product_id && l.shortage > 0);
    const actions = [];
    if (mine && this.can('shop_use_request') && open && r.approval_status !== 'rejected') actions.push(`<button class="btn btn-outline" onclick="App.showShopUseForm(${r.id})">Edit</button>`);
    if (mine && this.can('shop_use_request') && ['draft', 'returned'].includes(r.approval_status) && r.fulfillment_status !== 'cancelled') actions.push(`<button class="btn btn-primary" onclick="App._suSubmit(${r.id})">Submit for Approval</button>`);
    if (r.approval_status === 'pending_approval' && r.can_decide) {
      actions.push(`<button class="btn btn-primary" onclick="App._suApprove(${r.id})">Approve…</button>`);
      actions.push(`<button class="btn btn-outline" onclick="App._suDecide(${r.id}, 'return')">Return for Correction</button>`);
      actions.push(`<button class="btn btn-outline" style="color:var(--danger)" onclick="App._suDecide(${r.id}, 'reject')">Reject</button>`);
    }
    if (r.approval_status === 'approved' && outstanding && this.can('shop_use_issue')) actions.push(`<button class="btn btn-primary" onclick="App._suIssue(${r.id})">Issue Items</button>`);
    if (shortage && open && this.can('pr_create')) actions.push(`<button class="btn btn-outline" onclick="App._suRaisePR(${r.id})">Raise Purchase Request</button>`);
    if (open && (mine || this.can('shop_use_issue') || r.can_decide)) actions.push(`<button class="btn btn-outline" style="color:var(--danger)" onclick="App._suCancel(${r.id})">${r.lines.some(l => l.qty_issued > 0) ? 'Cancel Outstanding…' : 'Cancel Request'}</button>`);
    const info = (label, value) => value ? `<div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em">${label}</div><div style="font-weight:500">${value}</div></div>` : '';
    const actionLabel = { submitted: 'Submitted', resubmitted: 'Resubmitted', amended: 'Amended — sent for reapproval', approved: 'Approved', approved_reduced: 'Approved (reduced)', rejected: 'Rejected', returned: 'Returned for correction', cancelled: 'Cancelled', cancelled_quantity: 'Outstanding quantity cancelled' };
    const postingCell = (status, err, pid) => `${this._suBadge('posting', status)}${status === 'failed' && err ? `<div style="font-size:11px;color:var(--danger);max-width:220px">${this.escapeAttr(err)}</div>` : ''}${status === 'failed' && this.can('shop_use_finance') ? ` <button class="btn btn-sm btn-outline" style="margin-top:3px" onclick="App._suRetryPosting(${pid}, ${r.id})">Retry</button>` : ''}`;
    this.showModal(`
      <div class="modal" style="max-width:1080px">
        <div class="modal-header"><span class="modal-title">Shop Use ${r.request_number} <span style="font-weight:400;color:var(--text-muted);font-size:13px">v${r.version}</span></span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
            <span style="font-size:12px;color:var(--text-muted)">Approval</span> ${this._suBadge('approval', r.approval_status)}
            <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Fulfilment</span> ${this._suBadge('fulfillment', r.fulfillment_status)}
            <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Posting</span> ${this._suBadge('posting', r.posting_status)}
            <span style="font-size:12px;color:var(--text-muted);margin-left:8px">Reconciliation</span> ${this._suBadge('recon', r.recon_status)}
          </div>
          ${r.approval_status === 'pending_approval' ? `<div style="background:#FFF8E1;border:1px solid #f0d58a;border-radius:6px;padding:8px 12px;font-size:13px;margin-bottom:12px">Waiting for approval by ${this.escapeAttr(r.routed_approvers.map(a => a.name).join(', ') || 'a Shop Use approver')}${r.submitted_at ? ` since ${this._suDate(r.submitted_at)}` : ''}.${!r.can_decide && r.decide_block && this.can('shop_use_approve') ? ` <em>${this.escapeAttr(r.decide_block)}.</em>` : ''}</div>` : ''}
          ${['returned', 'rejected'].includes(r.approval_status) ? `<div style="background:#FFEBEE;border-radius:6px;padding:8px 12px;font-size:13px;margin-bottom:12px"><strong>${r.approval_status === 'returned' ? 'Returned for correction' : 'Rejected'}</strong> by ${this.escapeAttr(r.decided_by_name || '')} ${this._suDate(r.decided_at)}: ${this.escapeAttr(r.decision_comment || '')}</div>` : ''}
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px">
            ${info('Requested', `${this._suDate(r.created_at)}<br>${this.escapeAttr(r.requested_by_name || '')}`)}
            ${info('For', `${this.escapeAttr(r.branch_name || '')}<br>${this.escapeAttr(r.department || '')}`)}
            ${info('Supplying location', this.escapeAttr(r.source_branch_name || ''))}
            ${info('Category', this.escapeAttr(r.category_label))}
            ${info('Estimated total', `${this.fmt(r.total_estimated)}${r.approval_status === 'approved' ? `<div style="font-size:12px;color:var(--text-muted)">approved ${this.fmt(r.total_approved)}</div>` : ''}`)}
            ${info('Net cost so far', this.fmt(r.net_cost))}
            ${info('Equipment / project', this.escapeAttr([r.equipment_ref, r.project_ref].filter(Boolean).join(' / ')))}
            ${r.decided_by_name && r.approval_status === 'approved' ? info('Approved', `${this.escapeAttr(r.decided_by_name)}<br>${this._suDate(r.decided_at)}`) : ''}
          </div>
          <div style="margin-bottom:12px"><span style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Reason</span><div>${this.escapeAttr(r.reason || '—')}</div>${r.notes ? `<div style="font-size:13px;color:var(--text-muted);margin-top:4px">${this.escapeAttr(r.notes)}</div>` : ''}</div>
          <div class="table-wrap"><table style="font-size:13px">
            <thead><tr><th>Code</th><th>Item</th><th>Unit</th><th style="text-align:right">Requested</th><th style="text-align:right">Approved</th><th style="text-align:right">Issued</th><th style="text-align:right">Cancelled</th><th style="text-align:right">Outstanding</th><th style="text-align:right">Available</th><th style="text-align:right">Unit Cost</th><th style="text-align:right">Est. Total</th></tr></thead>
            <tbody>${r.lines.map(l => `<tr>
              <td style="font-size:12px">${this.escapeAttr(l.sku || '')}</td>
              <td>${this.escapeAttr(l.description)}${l.equipment_ref ? `<div style="font-size:11px;color:var(--text-muted)">Equipment: ${this.escapeAttr(l.equipment_ref)}</div>` : ''}${l.approve_reason ? `<div style="font-size:11px;color:#b45309">Approved less: ${this.escapeAttr(l.approve_reason)}</div>` : ''}${l.cancel_reason ? `<div style="font-size:11px;color:var(--danger)">Cancelled: ${this.escapeAttr(l.cancel_reason)}</div>` : ''}</td>
              <td style="font-size:12px">${l.tool_id ? 'Tool (borrow)' : this.escapeAttr(l.unit_name || 'Each')}</td>
              <td style="text-align:right">${this._suQty(l.qty_requested)}</td>
              <td style="text-align:right">${l.qty_approved == null ? '—' : this._suQty(l.qty_approved)}</td>
              <td style="text-align:right">${this._suQty(l.qty_issued)}</td>
              <td style="text-align:right">${l.qty_cancelled ? this._suQty(l.qty_cancelled) : '—'}</td>
              <td style="text-align:right;font-weight:600">${l.outstanding == null ? '—' : this._suQty(l.outstanding)}</td>
              <td style="text-align:right;${l.shortage > 0 && open ? 'color:var(--danger);font-weight:600' : ''}">${l.tool_id ? (l.tool_status === 'available' ? 'Yes' : this.escapeAttr(l.tool_status || '')) : this._suQty(l.available)}${l.shortage > 0 && open ? `<div style="font-size:11px">short ${this._suQty(l.shortage)}</div>` : ''}</td>
              <td style="text-align:right">${this.fmt(l.unit_cost)}</td>
              <td style="text-align:right">${this.fmt(l.line_total)}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          ${r.purchase_requests.length ? `<div style="margin-top:10px;font-size:13px">Linked purchase requests: ${r.purchase_requests.map(p => `<span class="badge-pill badge-info" style="margin-right:4px">${p.pr_number} · ${p.status}</span>`).join('')}</div>` : ''}

          ${r.issues.length ? `<h4 style="margin:18px 0 6px">Issues</h4>
          <div class="table-wrap"><table style="font-size:13px">
            <thead><tr><th>Issue #</th><th>Date</th><th>Items</th><th>Recipient</th><th>Issued By</th><th style="text-align:right">Cost</th><th>Posting</th><th>Recon.</th><th></th></tr></thead>
            <tbody>${r.issues.map(i => `<tr>
              <td class="fw-600">${i.issue_number}</td><td style="white-space:nowrap">${this._suDate(i.issued_at)}</td>
              <td style="font-size:12px">${i.lines.map(x => `${this._suQty(x.quantity)} × ${this.escapeAttr(x.description)}${x.qty_returned ? ` <span style="color:var(--text-muted)">(${this._suQty(x.qty_returned)} back)</span>` : ''}${x.tools.length ? `<div style="color:var(--text-muted)">${x.tools.map(t => `${t.tool_number}${t.serial_number ? ` S/N ${this.escapeAttr(t.serial_number)}` : ''}`).join(', ')}</div>` : ''}`).join('<br>')}${i.comments ? `<div style="color:var(--text-muted);margin-top:3px">${this.escapeAttr(i.comments)}</div>` : ''}</td>
              <td>${this.escapeAttr(i.recipient_name || '')}${i.acknowledged ? '<div style="font-size:11px;color:var(--success)">✓ acknowledged</div>' : ''}</td>
              <td>${this.escapeAttr(i.issued_by_name || '')}</td>
              <td style="text-align:right">${this.fmt(i.total_cost)}</td>
              <td>${i.posting_status ? postingCell(i.posting_status, i.posting_error, i.posting_id) : '<span style="font-size:12px;color:var(--text-muted)">No stock (tool loan)</span>'}</td>
              <td>${this._suBadge('recon', i.recon_status)}</td>
              <td><div style="display:flex;flex-wrap:wrap;gap:4px;min-width:120px">
                <button class="btn btn-sm btn-outline" onclick="App._suPrintSlip(${i.id})" title="Print issue slip">🖨 Slip</button>
                <a class="btn btn-sm btn-outline" href="/api/shop-use/issues/${i.id}/slip.pdf" title="Download PDF">PDF</a>
                ${this.can('shop_use_issue') && i.lines.some(x => !x.tool_id && x.quantity > x.qty_returned) ? `<button class="btn btn-sm btn-outline" onclick="App._suReturn(${i.id}, 'return')">Return</button>` : ''}
                ${this.can('shop_use_finance') && i.lines.some(x => !x.tool_id && x.quantity > x.qty_returned) ? `<button class="btn btn-sm btn-outline" style="color:var(--danger)" onclick="App._suReturn(${i.id}, 'reversal')">Reverse</button>` : ''}
              </div></td></tr>`).join('')}</tbody></table></div>` : ''}

          ${r.returns.length ? `<h4 style="margin:18px 0 6px">Returns &amp; reversals</h4>
          <div class="table-wrap"><table style="font-size:13px">
            <thead><tr><th>Number</th><th>Type</th><th>Date</th><th>Against</th><th>Items</th><th>Received By</th><th style="text-align:right">Cost Reversed</th><th>Posting</th><th>Recon.</th></tr></thead>
            <tbody>${r.returns.map(x => `<tr>
              <td class="fw-600">${x.return_number}</td><td>${x.kind === 'reversal' ? '<span class="badge-pill badge-danger">Reversal</span>' : '<span class="badge-pill badge-info">Return</span>'}</td>
              <td style="white-space:nowrap">${this._suDate(x.received_at)}</td><td>${x.issue_number}</td>
              <td style="font-size:12px">${x.lines.map(l => `${this._suQty(l.quantity)} × ${this.escapeAttr(l.description)} — ${l.condition === 'damaged' ? '<span style="color:var(--danger)">damaged, not restocked (damaged-stock procedure)</span>' : 'back in stock'}`).join('<br>')}${x.reason ? `<div style="color:var(--text-muted)">${this.escapeAttr(x.reason)}</div>` : ''}</td>
              <td>${this.escapeAttr(x.received_by_name || '')}</td>
              <td style="text-align:right">${this.fmt(x.total_cost)}</td>
              <td>${x.posting_status ? postingCell(x.posting_status, x.posting_error, x.posting_id) : '<span style="font-size:12px;color:var(--text-muted)">Nothing to reverse</span>'}</td>
              <td>${this._suBadge('recon', x.recon_status)}</td></tr>`).join('')}</tbody></table></div>` : ''}

          <h4 style="margin:18px 0 6px">Documents</h4>
          <div style="font-size:13px">${r.attachments.length ? r.attachments.map(a => `<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">📎 <a href="/api/shop-use/requests/${r.id}/attachments/${a.id}/download" style="color:var(--primary)">${this.escapeAttr(a.original_name)}</a>
              <span style="color:var(--text-muted);font-size:12px">${this.escapeAttr(a.uploaded_by_name || '')} · ${this._suDate(a.uploaded_at)}</span>
              ${mine && ['draft', 'returned'].includes(r.approval_status) ? `<button class="btn btn-sm btn-outline" onclick="App._suDeleteAttachment(${r.id}, ${a.id})">Remove</button>` : ''}</div>`).join('') : '<span style="color:var(--text-muted)">None</span>'}
            ${this.can('shop_use_request') && (mine || this.can('shop_use_issue')) ? `<div style="margin-top:6px"><label class="btn btn-sm btn-outline" style="cursor:pointer;margin:0">+ Add document<input type="file" style="display:none" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.heic,.txt" onchange="App._suUploadAttachment(${r.id}, this)"></label></div>` : ''}
          </div>

          <details style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">Approval history (${r.approvals.length})</summary>
            <div class="table-wrap"><table style="font-size:12px;margin-top:6px"><thead><tr><th>When</th><th>Version</th><th>Action</th><th>By</th><th style="text-align:right">Amount</th><th>Comments</th></tr></thead><tbody>
            ${r.approvals.map(a => `<tr><td style="white-space:nowrap">${this._suDate(a.created_at)}</td><td>v${a.version || ''}</td><td>${actionLabel[a.action] || a.action}</td><td>${this.escapeAttr(a.employee_name || '')}</td><td style="text-align:right">${a.amount != null ? this.fmt(a.amount) : ''}</td><td>${this.escapeAttr(a.comments || '')}</td></tr>`).join('')}
            </tbody></table></div></details>
          <details style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Audit trail (${r.audit.length})</summary>
            <div class="table-wrap"><table style="font-size:12px;margin-top:6px"><thead><tr><th>When</th><th>Action</th><th>By</th><th>Details</th></tr></thead><tbody>
            ${r.audit.map(a => `<tr><td style="white-space:nowrap">${this._suDate(a.created_at)}</td><td>${this.escapeAttr(a.action.replace(/_/g, ' '))}</td><td>${this.escapeAttr(a.employee_name || '')}</td><td style="font-family:monospace;font-size:11px;word-break:break-word;max-width:520px">${this.escapeAttr(a.details || '')}</td></tr>`).join('')}
            </tbody></table></div></details>
        </div>
        <div class="modal-footer" style="flex-wrap:wrap">${actions.join('')}<button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  async _suAfterAction(id, msg) {
    if (msg) this.alert(msg);
    if (this.section === 'shop-use') this.renderShopUse(this._suTab);
    if (id) await this.viewShopUseRequest(id);
  },

  // Small reason/comment dialog over whatever is open. Resolves with the text
  // or null when cancelled.
  _suPrompt(title, label, { required = true, placeholder = '', okLabel = 'OK', danger = false } = {}) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.style.zIndex = 1100;
      ov.innerHTML = `<div class="modal" style="max-width:460px"><div class="modal-header"><span class="modal-title">${title}</span><button class="modal-close">✕</button></div>
        <div class="modal-body"><div class="form-group"><label>${label}</label><textarea rows="3" placeholder="${this.escapeAttr(placeholder)}"></textarea></div></div>
        <div class="modal-footer"><button class="btn btn-secondary" data-x>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${okLabel}</button></div></div>`;
      document.body.appendChild(ov);
      const ta = ov.querySelector('textarea');
      ta.focus();
      const close = v => { ov.remove(); resolve(v); };
      ov.querySelector('.modal-close').onclick = () => close(null);
      ov.querySelector('[data-x]').onclick = () => close(null);
      ov.querySelector('[data-ok]').onclick = () => {
        const v = ta.value.trim();
        if (required && !v) { ta.style.borderColor = 'var(--danger)'; ta.focus(); return; }
        close(v);
      };
    });
  },

  async _suSubmit(id) {
    try { const r = await this.api('POST', `/shop-use/requests/${id}/submit`); await this._suAfterAction(id, `Sent for approval to ${r.routed_approvers.map(a => a.name).join(', ')}`); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suApprove(id) {
    const r = await this.api('GET', `/shop-use/requests/${id}`);
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">Approve ${r.request_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;margin-top:0">${this.escapeAttr(r.requested_by_name || '')} · ${this.escapeAttr(r.branch_name || '')} / ${this.escapeAttr(r.department || '')} · ${this.escapeAttr(r.category_label)}<br><span style="color:var(--text-muted)">${this.escapeAttr(r.reason || '')}</span></p>
          <div class="table-wrap"><table style="font-size:13px">
            <thead><tr><th>Item</th><th style="text-align:right">Requested</th><th style="text-align:right">Available</th><th style="width:100px">Approve</th><th>Reason if less</th></tr></thead>
            <tbody>${r.lines.map(l => `<tr>
              <td>${this.escapeAttr(l.description)}<div style="font-size:11px;color:var(--text-muted)">${this.fmt(l.unit_cost)} each${l.qty_issued ? ` · ${this._suQty(l.qty_issued)} already issued` : ''}</div></td>
              <td style="text-align:right">${this._suQty(l.qty_requested)}</td>
              <td style="text-align:right;${l.shortage > 0 ? 'color:var(--danger)' : ''}">${l.tool_id ? (l.tool_status === 'available' ? 'Yes' : l.tool_status) : this._suQty(l.available)}</td>
              <td><input type="number" min="${l.qty_issued + l.qty_cancelled}" max="${l.qty_requested}" step="any" value="${l.qty_requested}" data-line="${l.id}" class="su-appr-qty" style="width:90px"></td>
              <td><input data-reason="${l.id}" placeholder="Required if lower"></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <div class="form-group" style="margin-top:10px"><label>Comments</label><input id="su-appr-comment"></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.viewShopUseRequest(${id})">Back</button><button class="btn btn-primary" onclick="App._suConfirmApprove(${id})">Approve</button></div>
      </div>`);
  },

  async _suConfirmApprove(id) {
    const lines = [...document.querySelectorAll('.su-appr-qty')].map(inp => ({ id: Number(inp.dataset.line), qty_approved: inp.value, reason: document.querySelector(`[data-reason="${inp.dataset.line}"]`).value }));
    try {
      await this.api('POST', `/shop-use/requests/${id}/approve`, { lines, comment: document.getElementById('su-appr-comment').value });
      await this._suAfterAction(id, 'Approved');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _suDecide(id, action) {
    const reason = await this._suPrompt(action === 'reject' ? 'Reject request' : 'Return for correction', action === 'reject' ? 'Reason for rejecting' : 'What needs correcting', { okLabel: action === 'reject' ? 'Reject' : 'Return', danger: action === 'reject' });
    if (reason == null) return;
    try { await this.api('POST', `/shop-use/requests/${id}/${action}`, { reason }); await this._suAfterAction(id, action === 'reject' ? 'Rejected' : 'Returned to the requester'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suCancel(id) {
    const r = await this.api('GET', `/shop-use/requests/${id}`);
    const open = r.lines.filter(l => Math.max(0, (l.qty_approved ?? l.qty_requested) - l.qty_issued - l.qty_cancelled) > 0);
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Cancel unissued quantities — ${r.request_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;margin-top:0">Issued quantities stay on the record. Cancel everything not yet issued, or only some of it.</p>
          <div class="table-wrap"><table style="font-size:13px"><thead><tr><th>Item</th><th style="text-align:right">Not yet issued</th><th style="width:110px">Cancel</th></tr></thead><tbody>
          ${open.map(l => { const left = Math.max(0, (l.qty_approved ?? l.qty_requested) - l.qty_issued - l.qty_cancelled); return `<tr><td>${this.escapeAttr(l.description)}</td><td style="text-align:right">${this._suQty(left)}</td><td><input type="number" min="0" max="${left}" step="any" value="${left}" class="su-cx-qty" data-line="${l.id}" data-left="${left}" style="width:90px"></td></tr>`; }).join('')}
          </tbody></table></div>
          <div class="form-group" style="margin-top:10px"><label>Reason *</label><textarea id="su-cx-reason" rows="2"></textarea></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.viewShopUseRequest(${id})">Back</button><button class="btn btn-danger" onclick="App._suConfirmCancel(${id})">Cancel Quantities</button></div>
      </div>`);
  },

  async _suConfirmCancel(id) {
    const inputs = [...document.querySelectorAll('.su-cx-qty')];
    const all = inputs.every(i => Number(i.value) === Number(i.dataset.left));
    const body = { reason: document.getElementById('su-cx-reason').value.trim() };
    if (!all) body.lines = inputs.filter(i => Number(i.value) > 0).map(i => ({ id: Number(i.dataset.line), qty: Number(i.value) }));
    try { await this.api('POST', `/shop-use/requests/${id}/cancel`, body); await this._suAfterAction(id, 'Cancelled'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suRaisePR(id) {
    if (!confirm('Raise a draft purchase request for the stock the supplying location is short of? It follows the normal purchase-request approval and stays linked to this request.')) return;
    try { const pr = await this.api('POST', `/shop-use/requests/${id}/purchase-request`); await this._suAfterAction(id, `${pr.pr_number} created as a draft — submit it from Purchase Requests`); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suUploadAttachment(id, input) {
    const f = input.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    const res = await fetch(`/api/shop-use/requests/${id}/attachments`, { method: 'POST', body: fd });
    if (!res.ok) { this.alert((await res.json().catch(() => ({}))).error || 'Upload failed', 'error'); return; }
    this.viewShopUseRequest(id);
  },

  async _suDeleteAttachment(id, aid) {
    if (!confirm('Remove this document?')) return;
    try { await this.api('DELETE', `/shop-use/requests/${id}/attachments/${aid}`); this.viewShopUseRequest(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suRetryPosting(pid, requestId) {
    try { await this.api('POST', `/shop-use/postings/${pid}/retry`); this.alert('Queued for posting again'); if (requestId) this.viewShopUseRequest(requestId); else this.renderShopUse(this._suTab); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Issue ─────────────────────────────────────────────────────────────────
  async _suIssue(id) {
    const [r, meta] = await Promise.all([this.api('GET', `/shop-use/requests/${id}`), this._suMeta()]);
    const lines = r.lines.filter(l => l.outstanding > 0);
    this._suIssueKey = this._suKey(); // one per dialog — a double Confirm can't issue twice
    this.showModal(`
      <div class="modal" style="max-width:900px">
        <div class="modal-header"><span class="modal-title">Issue ${r.request_number} from ${this.escapeAttr(r.source_branch_name || '')}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;margin-top:0">${this.escapeAttr(r.branch_name || '')} / ${this.escapeAttr(r.department || '')} · ${this.escapeAttr(r.category_label)} · approved by ${this.escapeAttr(r.decided_by_name || '')}</p>
          <div class="table-wrap"><table style="font-size:13px">
            <thead><tr><th>Item</th><th style="text-align:right">Outstanding</th><th style="text-align:right">On Hand</th><th style="width:100px">Issue Now</th><th style="width:140px">Condition</th>${r.category === 'tools' ? '<th>Serial numbers (one per unit)</th>' : ''}</tr></thead>
            <tbody>${lines.map(l => {
              const max = l.tool_id ? (l.tool_status === 'available' ? 1 : 0) : Math.min(l.outstanding, l.allow_decimal ? l.available : Math.floor(l.available + 1e-9));
              return `<tr>
                <td>${this.escapeAttr(l.description)}<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(l.sku || '')} · ${l.tool_id ? 'borrowed from tool register' : this.escapeAttr(l.unit_name || 'Each')}</div></td>
                <td style="text-align:right">${this._suQty(l.outstanding)}</td>
                <td style="text-align:right;${max < l.outstanding ? 'color:var(--danger);font-weight:600' : ''}">${l.tool_id ? (l.tool_status === 'available' ? 'Yes' : this.escapeAttr(l.tool_status)) : this._suQty(l.available)}</td>
                <td><input type="number" min="0" max="${max}" step="any" value="${Math.max(0, max)}" class="su-iss-qty" data-line="${l.id}" style="width:85px"></td>
                <td><input class="su-iss-cond" data-line="${l.id}" placeholder="${r.category === 'tools' || l.tool_id ? 'e.g. New / Good' : ''}" style="width:130px"></td>
                ${r.category === 'tools' ? `<td>${l.tool_id ? '' : `<input class="su-iss-serials" data-line="${l.id}" placeholder="SN1, SN2…" style="width:100%">`}</td>` : ''}
              </tr>`; }).join('')}</tbody>
          </table></div>
          <div class="input-row" style="margin-top:12px">
            <div class="form-group"><label>Received by (employee)</label>
              <select id="su-iss-emp" data-searchable><option value="">— Not an employee —</option>${meta.employees.map(e => `<option value="${e.id}" ${r.requested_by === e.id ? 'selected' : ''}>${this.escapeAttr(e.name)}</option>`).join('')}</select></div>
            <div class="form-group"><label>…or recipient name</label><input id="su-iss-name" placeholder="If not an employee"></div>
          </div>
          <div class="form-group"><label>Comments <span style="font-weight:400;color:var(--text-muted);font-size:12px">(required for a partial issue — what is still to come and why)</span></label><input id="su-iss-comments"></div>
          ${this._sigPadHtml('su-iss-sig', 'Recipient signature', 'optional')}
          <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" id="su-iss-ack" style="width:16px;height:16px"> The recipient acknowledges receiving the items above</label>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.viewShopUseRequest(${id})">Back</button><button class="btn btn-primary" id="su-iss-btn" onclick="App._suConfirmIssue(${id})">Confirm Issue</button></div>
      </div>`);
    this._sigPadInit('su-iss-sig');
  },

  async _suConfirmIssue(id) {
    const btn = document.getElementById('su-iss-btn');
    const lines = [...document.querySelectorAll('.su-iss-qty')].map(inp => {
      const line = inp.dataset.line;
      const serials = (document.querySelector(`.su-iss-serials[data-line="${line}"]`)?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      return { line_id: Number(line), qty: Number(inp.value) || 0, condition: document.querySelector(`.su-iss-cond[data-line="${line}"]`).value, tools: serials.map(s => ({ serial_number: s })) };
    }).filter(l => l.qty > 0);
    const body = {
      issue_key: this._suIssueKey, lines, recipient_employee_id: document.getElementById('su-iss-emp').value || null, recipient_name: document.getElementById('su-iss-name').value,
      acknowledged: document.getElementById('su-iss-ack').checked, comments: document.getElementById('su-iss-comments').value,
      signature: this._sigPadHasDrawn('su-iss-sig') ? this._sigPadDataUrl('su-iss-sig') : null,
    };
    btn.disabled = true;
    try {
      const res = await this.api('POST', `/shop-use/requests/${id}/issues`, body);
      this.alert(res.duplicate ? 'Already issued — showing the existing issue' : `${res.issueNumber} issued`);
      if (this.section === 'shop-use') this.renderShopUse(this._suTab);
      await this.viewShopUseRequest(id);
      if (!res.duplicate && confirm('Print the issue slip now?')) this._suPrintSlip(res.issue_id);
    } catch (e) { btn.disabled = false; this.alert(e.message, 'error'); }
  },

  async _suPrintSlip(issueId) {
    const i = await this.api('GET', `/shop-use/issues/${issueId}`);
    const s = this.settings || {};
    const win = window.open('', '_blank', 'width=900,height=1000');
    const row = (k, v) => v ? `<tr><th style="text-align:left;padding:3px 10px 3px 0;color:#555;font-weight:600">${k}</th><td style="padding:3px 0">${v}</td></tr>` : '';
    win.document.write(`<!DOCTYPE html><html><head><title>${i.issue_number}</title><style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:28px;color:#111} h1{font-size:18px;margin:0} h2{font-size:15px;margin:2px 0 14px}
      table.lines{width:100%;border-collapse:collapse;margin-top:12px} .lines th{background:#eee;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;border:1px solid #ccc}
      .lines td{padding:6px 8px;border:1px solid #ddd} .r{text-align:right} .sig{display:flex;gap:40px;margin-top:40px} .sig div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:12px}
      .note{margin-top:14px;font-size:11px;color:#666} @media print{body{margin:12px}}
    </style></head><body>
      ${this._printLogoTag(40)}<h1>${this.escapeAttr(s.store_name || 'RetailPOS')}</h1><h2>Shop Use Issue Slip — ${i.issue_number}</h2>
      <table>${row('Request', i.request_number)}${row('Issued', this._suDate(i.issued_at))}${row('From', this.escapeAttr(i.source_branch_name || ''))}
        ${row('For', `${this.escapeAttr(i.branch_name || '')} — ${this.escapeAttr(i.department || '')}`)}${row('Category', this.escapeAttr(i.category_label))}${row('Reason', this.escapeAttr(i.reason || ''))}
        ${row('Equipment / project', this.escapeAttr([i.equipment_ref, i.project_ref].filter(Boolean).join(' / ')))}${row('Requested by', this.escapeAttr(i.requested_by_name || ''))}
        ${row('Approved by', i.approved_by_name ? `${this.escapeAttr(i.approved_by_name)} (${this._suDate(i.approved_at)})` : '')}${row('Issued by', this.escapeAttr(i.issued_by_name || ''))}
        ${row('Received by', this.escapeAttr(i.recipient_name || ''))}${row('Comments', this.escapeAttr(i.comments || ''))}</table>
      <table class="lines"><thead><tr><th>Code</th><th>Item</th><th>Unit</th><th class="r">Qty Issued</th><th class="r">Still Outstanding</th><th class="r">Cost</th></tr></thead><tbody>
        ${i.lines.map(l => `<tr><td>${this.escapeAttr(l.sku || '')}</td><td>${this.escapeAttr(l.description)}${l.tools.length ? `<div style="font-size:11px;color:#555">${l.tools.map(t => `${t.tool_number}${t.serial_number ? ` S/N ${this.escapeAttr(t.serial_number)}` : ''}`).join(', ')}</div>` : ''}${l.condition ? `<div style="font-size:11px;color:#555">Condition: ${this.escapeAttr(l.condition)}</div>` : ''}</td>
          <td>${this.escapeAttr(l.unit_name || 'Each')}</td><td class="r">${this._suQty(l.quantity)}</td><td class="r">${this._suQty(l.outstanding)}</td><td class="r">${this.fmt(l.line_cost)}</td></tr>`).join('')}
        <tr><td colspan="5" class="r" style="font-weight:700">Total at inventory cost</td><td class="r" style="font-weight:700">${this.fmt(i.total_cost)}</td></tr>
      </tbody></table>
      ${i.recipient_signature ? `<div style="margin-top:16px"><img src="${this.escapeAttr(i.recipient_signature)}" style="max-height:70px"></div>` : ''}
      <div class="sig"><div>Received by: ${this.escapeAttr(i.recipient_name || '')}${i.acknowledged ? ' (acknowledged)' : ''}</div><div>Issued by: ${this.escapeAttr(i.issued_by_name || '')}</div></div>
      <div class="note">Valued at inventory cost. Company use only — not a sale.</div>
      <script>window.onload=()=>{window.print()}<\/script></body></html>`);
    win.document.close();
  },

  // ── Returns / reversals ───────────────────────────────────────────────────
  async _suReturn(issueId, kind) {
    const i = await this.api('GET', `/shop-use/issues/${issueId}`);
    const lines = i.lines.filter(l => !l.tool_id && l.returnable > 0);
    const reversal = kind === 'reversal';
    this._suReturnKey = this._suKey();
    this.showModal(`
      <div class="modal" style="max-width:820px">
        <div class="modal-header"><span class="modal-title">${reversal ? 'Reverse' : 'Return items from'} ${i.issue_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;margin-top:0">${reversal
            ? 'A reversal corrects an issue posted in error: the stock goes back to the supplying location, the cost is reversed at the original issue cost, and the quantity is outstanding on the request again. The original issue stays on the record.'
            : 'Count and inspect what is coming back. Items in good condition go back into saleable stock and their cost is reversed at the original issue cost. Damaged or unusable items are recorded but not restocked — process them through the damaged-stock procedure.'}</p>
          <div class="table-wrap"><table style="font-size:13px">
            <thead><tr><th>Item</th><th style="text-align:right">Issued</th><th style="text-align:right">Can Return</th><th style="width:95px">Qty</th>${reversal ? '' : '<th style="width:130px">Condition</th>'}<th>Tools / notes</th></tr></thead>
            <tbody>${lines.map(l => `<tr>
              <td>${this.escapeAttr(l.description)}<div style="font-size:11px;color:var(--text-muted)">${this.fmt(l.unit_cost * (l.units_per || 1))} each at issue</div></td>
              <td style="text-align:right">${this._suQty(l.quantity)}</td><td style="text-align:right">${this._suQty(l.returnable)}</td>
              <td><input type="number" min="0" max="${l.returnable}" step="any" value="0" class="su-ret-qty" data-line="${l.id}" style="width:80px"></td>
              ${reversal ? '' : `<td><select class="su-ret-cond" data-line="${l.id}"><option value="good">Good — restock</option><option value="damaged">Damaged / unusable</option></select></td>`}
              <td>${l.tools.filter(t => !['returned_to_stock', 'disposed', 'returned_damaged'].includes(t.status)).map(t => `<label style="display:inline-flex;gap:4px;align-items:center;margin-right:8px;font-size:12px"><input type="checkbox" class="su-ret-tool" data-line="${l.id}" value="${t.id}">${t.tool_number}${t.serial_number ? ` (${this.escapeAttr(t.serial_number)})` : ''}</label>`).join('')}
                <input class="su-ret-notes" data-line="${l.id}" placeholder="Notes" style="width:100%;margin-top:3px"></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <div class="form-group" style="margin-top:10px"><label>${reversal ? 'Reason for the reversal *' : 'Comments'}</label><textarea id="su-ret-reason" rows="2"></textarea></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.viewShopUseRequest(${i.request_id})">Back</button><button class="btn ${reversal ? 'btn-danger' : 'btn-primary'}" id="su-ret-btn" onclick="App._suConfirmReturn(${issueId}, ${i.request_id}, '${kind}')">${reversal ? 'Reverse' : 'Accept Return'}</button></div>
      </div>`);
  },

  async _suConfirmReturn(issueId, requestId, kind) {
    const lines = [...document.querySelectorAll('.su-ret-qty')].map(inp => {
      const line = inp.dataset.line;
      return {
        issue_line_id: Number(line), qty: Number(inp.value) || 0, condition: document.querySelector(`.su-ret-cond[data-line="${line}"]`)?.value || 'good',
        notes: document.querySelector(`.su-ret-notes[data-line="${line}"]`)?.value || '',
        tool_ids: [...document.querySelectorAll(`.su-ret-tool[data-line="${line}"]:checked`)].map(c => Number(c.value)),
      };
    }).filter(l => l.qty > 0);
    const btn = document.getElementById('su-ret-btn');
    btn.disabled = true;
    try {
      const res = await this.api('POST', `/shop-use/issues/${issueId}/returns`, { return_key: this._suReturnKey, kind, reason: document.getElementById('su-ret-reason').value, lines });
      await this._suAfterAction(requestId, res.duplicate ? 'Already recorded' : `${res.return_number} recorded`);
    } catch (e) { btn.disabled = false; this.alert(e.message, 'error'); }
  },

  // ── Tool register ─────────────────────────────────────────────────────────
  async _suRenderTools() {
    const el = document.getElementById('su-tab-body');
    const f = this._suToolFilter || (this._suToolFilter = { status: '', source: '', q: '' });
    const statusLabel = { available: ['In store', 'badge-success'], assigned: ['With custodian', 'badge-info'], returned_to_stock: ['Back in saleable stock', 'su-badge-muted'], returned_damaged: ['Returned damaged', 'badge-danger'], disposed: ['Disposed', 'su-badge-muted'] };
    this._suToolStatus = statusLabel;
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="su-t-status" style="width:auto"><option value="">Any status</option>${Object.entries(statusLabel).map(([k, [l]]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="su-t-source" style="width:auto"><option value="">Any type</option><option value="inventory" ${f.source === 'inventory' ? 'selected' : ''}>Taken from inventory (permanent)</option><option value="register" ${f.source === 'register' ? 'selected' : ''}>Company tool register (lent out)</option></select>
        <input id="su-t-q" placeholder="Tool #, description, serial, custodian…" value="${this.escapeAttr(f.q)}" style="flex:1;min-width:180px">
        ${this.can('shop_use_issue') ? '<button class="btn btn-primary btn-sm" onclick="App._suToolForm()">+ Register Tool</button>' : ''}
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Tool #</th><th>Description</th><th>Serial #</th><th>Type</th><th>Status</th><th>Custodian</th><th>Branch / Dept / Location</th><th>Issued</th><th>Condition</th><th></th></tr></thead>
        <tbody id="su-tools-tbody"><tr><td colspan="10" class="empty-state">Loading...</td></tr></tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-muted);margin:10px 0 0">Tools taken from inventory on a Reusable Tools request are out of saleable stock for good; tools entered on the register directly are company tools lent out on a request and returned here.</p></div>`;
    const load = async () => {
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      const rows = await this.api('GET', `/shop-use/tools?${qs}`);
      const tb = document.getElementById('su-tools-tbody');
      if (!tb) return;
      tb.innerHTML = rows.length ? rows.map(t => `<tr>
        <td class="fw-600"><a href="#" style="color:var(--primary)" onclick="event.preventDefault();App._suToolHistory(${t.id})">${t.tool_number}</a></td>
        <td>${this.escapeAttr(t.description)}</td><td>${this.escapeAttr(t.serial_number || '—')}</td>
        <td style="font-size:12px">${t.source === 'inventory' ? 'From inventory' : 'Tool register'}</td>
        <td><span class="badge-pill ${(statusLabel[t.status] || [, 'su-badge-muted'])[1]}">${(statusLabel[t.status] || [t.status])[0]}</span></td>
        <td>${this.escapeAttr(t.custodian_name || '—')}</td>
        <td style="font-size:12px">${this.escapeAttr([t.branch_name, t.department, t.location].filter(Boolean).join(' / ') || '—')}</td>
        <td style="font-size:12px">${t.issued_at ? this._apDate(t.issued_at) : '—'}${t.request_number ? `<div><a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewShopUseRequest(${t.request_id})">${t.request_number}</a></div>` : ''}</td>
        <td style="font-size:12px">${this.escapeAttr(t.condition || '—')}</td>
        <td>${this.can('shop_use_issue') && !['disposed', 'returned_to_stock'].includes(t.status) ? `<div style="display:flex;flex-wrap:wrap;gap:4px;min-width:90px">
          <button class="btn btn-sm btn-outline" onclick="App._suToolAction(${t.id}, 'transfer')">Transfer</button>
          ${t.status === 'assigned' ? `<button class="btn btn-sm btn-outline" onclick="App._suToolAction(${t.id}, 'return')">Return</button>` : ''}
          <button class="btn btn-sm btn-outline" style="color:var(--danger)" onclick="App._suToolAction(${t.id}, 'dispose')">Dispose</button></div>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No tools on the register</td></tr>';
    };
    document.getElementById('su-t-status').addEventListener('change', e => { f.status = e.target.value; load(); });
    document.getElementById('su-t-source').addEventListener('change', e => { f.source = e.target.value; load(); });
    let timer;
    document.getElementById('su-t-q').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); });
    await load();
  },

  async _suToolForm() {
    const meta = await this._suMeta();
    this.showModal(`<div class="modal" style="max-width:560px"><div class="modal-header"><span class="modal-title">Register a company tool</span><button class="modal-close">✕</button></div>
      <div class="modal-body">
        <p style="font-size:13px;margin-top:0;color:var(--text-muted)">For tools the company already owns (not taken from saleable stock). They can then be borrowed on a Shop Use request.</p>
        <div class="form-group"><label>Description *</label><input id="su-tf-desc"></div>
        <div class="input-row"><div class="form-group"><label>Serial / ID number</label><input id="su-tf-serial"></div><div class="form-group"><label>Condition</label><input id="su-tf-cond" placeholder="Good"></div></div>
        <div class="input-row"><div class="form-group"><label>Branch</label><select id="su-tf-branch"><option value="">—</option>${meta.branches.map(b => `<option value="${b.id}">${this.escapeAttr(b.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Department</label><select id="su-tf-dept"><option value="">—</option>${meta.departments.map(d => `<option>${this.escapeAttr(d)}</option>`).join('')}</select></div></div>
        <div class="form-group"><label>Storage location</label><input id="su-tf-loc" placeholder="Tool room, shelf 2"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="App._suSaveTool()">Register</button></div></div>`);
  },

  async _suSaveTool() {
    const v = id => document.getElementById(id).value;
    try {
      await this.api('POST', '/shop-use/tools', { description: v('su-tf-desc'), serial_number: v('su-tf-serial'), condition: v('su-tf-cond'), branch_id: v('su-tf-branch'), department: v('su-tf-dept'), location: v('su-tf-loc') });
      this.closeModal(); this.alert('Tool registered'); this.renderShopUse('tools');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _suToolAction(id, action) {
    const meta = await this._suMeta();
    const title = { transfer: 'Transfer custody', return: 'Return to store', dispose: 'Dispose of tool' }[action];
    this.showModal(`<div class="modal" style="max-width:520px"><div class="modal-header"><span class="modal-title">${title}</span><button class="modal-close">✕</button></div>
      <div class="modal-body">
        ${action === 'transfer' ? `<div class="input-row"><div class="form-group"><label>New custodian</label><select id="su-ta-emp" data-searchable><option value="">— Not an employee —</option>${meta.employees.map(e => `<option value="${e.id}">${this.escapeAttr(e.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>…or name</label><input id="su-ta-name"></div></div>
          <div class="input-row"><div class="form-group"><label>Branch</label><select id="su-ta-branch"><option value="">(unchanged)</option>${meta.branches.map(b => `<option value="${b.id}">${this.escapeAttr(b.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Department</label><select id="su-ta-dept"><option value="">(unchanged)</option>${meta.departments.map(d => `<option>${this.escapeAttr(d)}</option>`).join('')}</select></div></div>` : ''}
        ${action !== 'dispose' ? '<div class="form-group"><label>Location</label><input id="su-ta-loc"></div>' : ''}
        <div class="form-group"><label>Condition</label><input id="su-ta-cond"></div>
        <div class="form-group"><label>${action === 'dispose' ? 'Reason *' : 'Notes'}</label><textarea id="su-ta-notes" rows="2"></textarea></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn ${action === 'dispose' ? 'btn-danger' : 'btn-primary'}" onclick="App._suSaveToolAction(${id}, '${action}')">${title}</button></div></div>`);
  },

  async _suSaveToolAction(id, action) {
    const v = id => document.getElementById(id)?.value || '';
    try {
      await this.api('POST', `/shop-use/tools/${id}/${action}`, { custodian_employee_id: v('su-ta-emp') || null, custodian_name: v('su-ta-name'), branch_id: v('su-ta-branch') || null, department: v('su-ta-dept'), location: v('su-ta-loc'), condition: v('su-ta-cond'), notes: v('su-ta-notes') });
      this.closeModal(); this.alert('Saved'); this.renderShopUse('tools');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _suToolHistory(id) {
    const t = await this.api('GET', `/shop-use/tools/${id}`);
    this.showModal(`<div class="modal" style="max-width:820px"><div class="modal-header"><span class="modal-title">${t.tool_number} — ${this.escapeAttr(t.description)}</span><button class="modal-close">✕</button></div>
      <div class="modal-body">
        <p style="font-size:13px;margin-top:0">${t.source === 'inventory' ? `Taken out of saleable inventory on ${t.issue_number || ''} (${t.request_number || ''}) at ${this.fmt(t.unit_cost)}.` : 'Company tool register — lent out on Shop Use requests.'}${t.serial_number ? ` Serial ${this.escapeAttr(t.serial_number)}.` : ''}</p>
        <div class="table-wrap"><table style="font-size:13px"><thead><tr><th>When</th><th>Event</th><th>Custodian</th><th>Branch / Dept / Location</th><th>Condition</th><th>Notes</th><th>By</th></tr></thead><tbody>
        ${t.events.map(e => `<tr><td style="white-space:nowrap">${this._suDate(e.created_at)}</td><td>${this.escapeAttr(e.event.replace(/_/g, ' '))}</td><td>${this.escapeAttr(e.custodian_name || '')}</td>
          <td style="font-size:12px">${this.escapeAttr([e.branch_name, e.department, e.location].filter(Boolean).join(' / '))}</td><td>${this.escapeAttr(e.condition || '')}</td><td>${this.escapeAttr(e.notes || '')}</td><td>${this.escapeAttr(e.employee_name || '')}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div></div>`);
  },

  // ── Reconciliation (Finance) ──────────────────────────────────────────────
  async _suRenderRecon() {
    const el = document.getElementById('su-tab-body');
    const meta = await this._suMeta();
    const f = this._suReconFilter || (this._suReconFilter = { recon_status: 'unreconciled', status: '', branch_id: '', from: '', to: '' });
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="su-r-recon" style="width:auto"><option value="">All</option><option value="unreconciled" ${f.recon_status === 'unreconciled' ? 'selected' : ''}>Unreconciled</option><option value="reconciled" ${f.recon_status === 'reconciled' ? 'selected' : ''}>Reconciled</option></select>
        <select id="su-r-status" style="width:auto"><option value="">Any posting status</option>${['pending', 'posted', 'failed'].map(k => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${this._suStatus.posting[k][0]}</option>`).join('')}</select>
        <select id="su-r-branch" style="width:auto"><option value="">All branches</option>${meta.branches.map(b => `<option value="${b.id}" ${String(f.branch_id) === String(b.id) ? 'selected' : ''}>${this.escapeAttr(b.name)}</option>`).join('')}</select>
        <label style="font-size:12px;color:var(--text-muted)">From</label><input type="date" id="su-r-from" value="${f.from}" style="width:auto">
        <label style="font-size:12px;color:var(--text-muted)">To</label><input type="date" id="su-r-to" value="${f.to}" style="width:auto">
      </div>
      <div class="card"><div class="table-wrap"><table style="font-size:13px">
        <thead><tr><th>Date</th><th>Reference</th><th>Request</th><th>Branch / Dept</th><th>Accounts</th><th style="text-align:right">Amount</th><th>Posting</th><th>Checks</th><th>Status</th><th></th></tr></thead>
        <tbody id="su-recon-tbody"><tr><td colspan="10" class="empty-state">Loading...</td></tr></tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-muted);margin:10px 0 0">Each issue and return is checked: authorized against an approval (not by the requester, within the approved quantity) · stock movements match · document cost = amount posted to the books · branch, department and accounts are right · returns are recorded against the issue. An item can be marked reconciled only once every check passes — differences stay listed until resolved.</p></div>`;
    const load = async () => {
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      const rows = await this.api('GET', `/shop-use/reconciliation?${qs}`);
      const tb = document.getElementById('su-recon-tbody');
      if (!tb) return;
      tb.innerHTML = rows.length ? rows.map(p => `<tr>
        <td style="white-space:nowrap">${this._apDate(p.posting_date)}</td>
        <td class="fw-600">${p.reference}<div style="font-size:11px;color:var(--text-muted)">${p.source_type === 'issue' ? 'Issue' : 'Return / reversal'}</div></td>
        <td><a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewShopUseRequest(${p.request_id})">${p.request_number}</a></td>
        <td style="font-size:12px">${this.escapeAttr(p.branch_name || '')}<div>${this.escapeAttr(p.department || '')}</div><div style="color:var(--text-muted)">${this.escapeAttr(p.category_label)}</div></td>
        <td style="font-size:12px">Dr ${this.escapeAttr(p.debit_account_code || '?')}<br>Cr ${this.escapeAttr(p.credit_account_code || '?')}</td>
        <td style="text-align:right">${this.fmt(p.amount)}${p.posted_amount != null && Math.abs(p.posted_amount - p.amount) > 0.004 ? `<div style="font-size:11px;color:var(--danger)">posted ${this.fmt(p.posted_amount)}</div>` : ''}</td>
        <td>${this._suBadge('posting', p.status)}${p.external_ref ? `<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(p.external_ref)}</div>` : ''}${p.status === 'failed' ? `<div style="font-size:11px;color:var(--danger);max-width:200px">${this.escapeAttr(p.last_error || '')}</div><button class="btn btn-sm btn-outline" style="margin-top:3px" onclick="App._suRetryPosting(${p.id})">Retry</button>` : ''}</td>
        <td style="font-size:12px;min-width:200px">${p.checks.map(c => `<div title="${this.escapeAttr(c.detail || '')}" style="color:${c.ok ? 'var(--success)' : 'var(--danger)'}">${c.ok ? '✓' : '✗'} ${c.label}${!c.ok && c.detail ? `<div style="color:var(--text-muted);margin-left:14px">${this.escapeAttr(c.detail)}</div>` : ''}</div>`).join('')}</td>
        <td>${this._suBadge('recon', p.recon_status)}${p.reconciled_by_name ? `<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(p.reconciled_by_name)}<br>${this._suDate(p.reconciled_at)}</div>` : ''}${p.recon_comment ? `<div style="font-size:11px;white-space:pre-wrap;max-width:240px;margin-top:3px">${this.escapeAttr(p.recon_comment)}</div>` : ''}</td>
        <td style="white-space:nowrap">${p.recon_status === 'unreconciled'
          ? `<button class="btn btn-sm ${p.differences ? 'btn-outline' : 'btn-primary'}" ${p.differences ? 'disabled title="Resolve the differences first"' : ''} onclick="App._suReconcile(${p.id})">Reconcile</button>
             <button class="btn btn-sm btn-outline" onclick="App._suReconNote(${p.id})">Note</button>`
          : `<button class="btn btn-sm btn-outline" onclick="App._suUnreconcile(${p.id})">Reopen</button>`}</td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty-state">Nothing to show</td></tr>';
    };
    const bind = (id, key) => document.getElementById(id).addEventListener('change', e => { f[key] = e.target.value; load(); });
    bind('su-r-recon', 'recon_status'); bind('su-r-status', 'status'); bind('su-r-branch', 'branch_id'); bind('su-r-from', 'from'); bind('su-r-to', 'to');
    await load();
  },

  async _suReconcile(id) {
    const comment = await this._suPrompt('Mark reconciled', 'Review comments', { required: false, okLabel: 'Reconcile' });
    if (comment == null) return;
    try { await this.api('POST', `/shop-use/postings/${id}/reconcile`, { comment }); this.alert('Reconciled'); this.renderShopUse('reconciliation'); }
    catch (e) { this.alert(e.message, 'error'); }
  },
  async _suReconNote(id) {
    const comment = await this._suPrompt('Investigation note', 'What was found / what is being done', { okLabel: 'Add Note' });
    if (comment == null) return;
    try { await this.api('POST', `/shop-use/postings/${id}/note`, { comment }); this.renderShopUse('reconciliation'); }
    catch (e) { this.alert(e.message, 'error'); }
  },
  async _suUnreconcile(id) {
    const reason = await this._suPrompt('Reopen reconciliation', 'Reason for reopening', { okLabel: 'Reopen' });
    if (reason == null) return;
    try { await this.api('POST', `/shop-use/postings/${id}/unreconcile`, { reason }); this.renderShopUse('reconciliation'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Reports ───────────────────────────────────────────────────────────────
  _suReports: [
    ['detail', 'Detailed transaction report'], ['monthly', 'Monthly cost by branch & department'], ['usage', 'Usage by item & category'],
    ['awaiting-issue', 'Approved requests awaiting issue'], ['outstanding', 'Partially issued & outstanding quantities'], ['postings', 'Failed or pending postings'],
    ['unreconciled', 'Unreconciled transactions'], ['returns', 'Returns & reversals'], ['tools', 'Reusable tools & custodians'],
  ],

  async _suRenderReports() {
    const el = document.getElementById('su-tab-body');
    const meta = await this._suMeta();
    const f = this._suRptFilter || (this._suRptFilter = { type: 'detail', from: new Date(Date.now() - 30 * 864e5).toLocaleDateString('en-CA'), to: this._apToday() });
    const sel = (id, label, options, cur) => `<div class="form-group" style="margin:0"><label style="font-size:11px">${label}</label><select id="${id}" style="width:auto">${options.map(([v, l]) => `<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${this.escapeAttr(l)}</option>`).join('')}</select></div>`;
    const any = l => [['', l]];
    const st = k => Object.entries(this._suStatus[k]).map(([v, [l]]) => [v, l]);
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          ${sel('su-rp-type', 'Report', this._suReports, f.type)}
          <div class="form-group" style="margin:0"><label style="font-size:11px">From</label><input type="date" id="su-rp-from" value="${f.from || ''}" style="width:auto"></div>
          <div class="form-group" style="margin:0"><label style="font-size:11px">To</label><input type="date" id="su-rp-to" value="${f.to || ''}" style="width:auto"></div>
          ${sel('su-rp-branch', 'Branch', any('All').concat(meta.branches.map(b => [b.id, b.name])), f.branch_id)}
          ${sel('su-rp-dept', 'Department', any('All').concat(meta.departments.map(d => [d, d])), f.department)}
          ${sel('su-rp-cat', 'Category', any('All').concat(meta.categories.map(c => [c.key, c.label])), f.category)}
          ${sel('su-rp-req', 'Requester', any('Anyone').concat(meta.employees.map(e => [e.id, e.name])), f.requested_by)}
          ${sel('su-rp-appr', 'Approver', any('Anyone').concat(meta.employees.map(e => [e.id, e.name])), f.approved_by)}
          ${sel('su-rp-as', 'Approval', any('Any').concat(st('approval')), f.approval_status)}
          ${sel('su-rp-fs', 'Fulfilment', any('Any').concat(st('fulfillment')), f.fulfillment_status)}
          ${sel('su-rp-ps', 'Posting', any('Any').concat(st('posting')), f.posting_status)}
          ${sel('su-rp-rs', 'Reconciliation', any('Any').concat(st('recon')), f.recon_status)}
          <div class="form-group su-item-search" style="margin:0;position:relative"><label style="font-size:11px">Item</label>
            <input id="su-rp-item" placeholder="Code or name" value="${this.escapeAttr(f.item_label || '')}" style="width:170px" oninput="App._suReportItemSearch(this.value)">
            <div class="su-item-dd" id="su-rp-item-dd" style="display:none;position:absolute;z-index:50;left:0;width:280px;top:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;max-height:240px;overflow:auto"></div></div>
          <button class="btn btn-primary" onclick="App._suRunReport()">Run</button>
        </div>
      </div>
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span class="card-title" id="su-rp-title"></span>
        <div style="display:flex;gap:8px"><button class="btn btn-sm btn-outline" onclick="App._suExportReport('xlsx')">Excel</button><button class="btn btn-sm btn-outline" onclick="App._suExportReport('pdf')">PDF</button><button class="btn btn-sm btn-outline" onclick="App.printReport('su-rp-out')">🖨 Print</button></div></div>
        <div id="su-rp-out"><div class="empty-state">Choose a report and press Run</div></div></div>`;
    if (!this._suDdBound) {
      this._suDdBound = true;
      document.addEventListener('click', e => { if (!e.target.closest('.su-item-search')) document.querySelectorAll('.su-item-dd').forEach(d => { d.style.display = 'none'; }); });
    }
    await this._suRunReport();
  },

  _suReportItemSearch(q) {
    const f = this._suRptFilter;
    f.product_id = ''; f.item_label = q;
    clearTimeout(this._suSearchTimer);
    const dd = document.getElementById('su-rp-item-dd');
    if (q.trim().length < 2) { dd.style.display = 'none'; return; }
    this._suSearchTimer = setTimeout(async () => {
      const items = await this.api('GET', `/shop-use/items?q=${encodeURIComponent(q.trim())}`).catch(() => []);
      dd.innerHTML = items.map(p => `<div style="padding:6px 10px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)" onmousedown="event.preventDefault();App._suRptFilter.product_id=${p.id};App._suRptFilter.item_label=${this.escapeAttr(JSON.stringify(p.name))};document.getElementById('su-rp-item').value=App._suRptFilter.item_label;this.parentNode.style.display='none'">${this.escapeAttr(p.name)} <span style="color:var(--text-muted);font-size:11px">${this.escapeAttr(p.sku || '')}</span></div>`).join('') || '<div style="padding:6px 10px;font-size:13px;color:var(--text-muted)">No match</div>';
      dd.style.display = 'block';
    }, 250);
  },

  _suReportQuery() {
    const f = this._suRptFilter;
    const v = id => document.getElementById(id)?.value || '';
    Object.assign(f, { type: v('su-rp-type'), from: v('su-rp-from'), to: v('su-rp-to'), branch_id: v('su-rp-branch'), department: v('su-rp-dept'), category: v('su-rp-cat'),
      requested_by: v('su-rp-req'), approved_by: v('su-rp-appr'), approval_status: v('su-rp-as'), fulfillment_status: v('su-rp-fs'), posting_status: v('su-rp-ps'), recon_status: v('su-rp-rs') });
    if (!v('su-rp-item')) { f.product_id = ''; f.item_label = ''; }
    const qs = new URLSearchParams();
    for (const k of ['from', 'to', 'branch_id', 'department', 'category', 'requested_by', 'approved_by', 'approval_status', 'fulfillment_status', 'posting_status', 'recon_status', 'product_id']) if (f[k]) qs.set(k, f[k]);
    return qs;
  },

  async _suRunReport() {
    const qs = this._suReportQuery();
    const out = document.getElementById('su-rp-out');
    out.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const rpt = await this.api('GET', `/shop-use/reports/${this._suRptFilter.type}?${qs}`);
      this._suLastReport = rpt;
      document.getElementById('su-rp-title').textContent = `${rpt.title} — ${rpt.rows.length} row${rpt.rows.length === 1 ? '' : 's'}`;
      out.dataset.reportTitle = rpt.title;
      const cell = (c, v) => v == null || v === '' ? '' : c.money ? this.fmt(v) : c.key.endsWith('status') || c.key === 'status' ? this.escapeAttr(String(v).replace(/_/g, ' ')) : this.escapeAttr(typeof v === 'number' ? this._suQty(v) : v);
      out.innerHTML = `<div class="table-wrap"><table style="font-size:12px">
        <thead><tr>${rpt.columns.map(c => `<th style="${c.align === 'right' ? 'text-align:right' : ''}">${c.label}</th>`).join('')}</tr></thead>
        <tbody>${rpt.rows.length ? rpt.rows.map(r => `<tr>${rpt.columns.map(c => `<td style="${c.align === 'right' ? 'text-align:right' : ''}">${cell(c, r[c.key])}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${rpt.columns.length}" class="empty-state">No records match these filters</td></tr>`}</tbody>
        ${Object.keys(rpt.totals).length ? `<tfoot><tr style="font-weight:700;border-top:2px solid var(--border)">${rpt.columns.map((c, i) => `<td style="${c.align === 'right' ? 'text-align:right' : ''}">${i === 0 ? 'Totals' : c.key in rpt.totals ? cell(c, rpt.totals[c.key]) : ''}</td>`).join('')}</tr></tfoot>` : ''}
      </table></div>`;
    } catch (e) { out.innerHTML = `<div class="empty-state">${this.escapeAttr(e.message)}</div>`; }
  },

  async _suExportReport(format) {
    const qs = this._suReportQuery();
    if (format === 'pdf') { window.open(`/api/shop-use/reports/${this._suRptFilter.type}?${qs}&format=pdf`, '_blank'); return; }
    const rpt = this._suLastReport;
    if (!rpt) { this.alert('Run the report first', 'error'); return; }
    try {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
          el.onload = resolve;
          el.onerror = () => reject(new Error('Could not load the Excel writer. Check your internet connection.'));
          document.head.appendChild(el);
        });
      }
      const aoa = [rpt.columns.map(c => c.label), ...rpt.rows.map(r => rpt.columns.map(c => r[c.key] ?? ''))];
      if (Object.keys(rpt.totals).length) aoa.push(rpt.columns.map((c, i) => i === 0 ? 'Totals' : c.key in rpt.totals ? rpt.totals[c.key] : ''));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = rpt.columns.map(c => ({ wch: Math.min(40, Math.max(10, c.label.length + 2)) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Shop Use');
      XLSX.writeFile(wb, `shop-use-${this._suRptFilter.type}-${this._apToday()}.xlsx`);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Settings: approval routing (management) and account mapping (Finance) ─
  async _suRenderSettings() {
    const el = document.getElementById('su-tab-body');
    const meta = await this._suMeta(true);
    const [rules, accounts] = await Promise.all([this.api('GET', '/shop-use/rules'), this.api('GET', '/shop-use/accounts')]);
    const canRoute = this.can('shop_use_routing'), canFin = this.can('shop_use_finance');
    el.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-header"><span class="card-title">Approval routing</span>${canRoute ? '<button class="btn btn-sm btn-primary" onclick="App._suRuleForm()">+ Add Rule</button>' : ''}</div>
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">A request goes to the approvers of the matching rule with the lowest limit that covers its total (blank branch, department or category = any; blank limit = no limit). Anything above a rule's limit — or raised by that rule's only approver — moves to the next rule up. Approvers also need the <em>Approve Shop Use Requests</em> permission and can never approve their own requests. With no rules, any approver may approve.</p>
        <div class="table-wrap"><table style="font-size:13px"><thead><tr><th>Rule</th><th>Branch</th><th>Department</th><th>Category</th><th style="text-align:right">Limit</th><th>Approvers</th><th>Active</th><th></th></tr></thead><tbody>
        ${rules.length ? rules.map(r => `<tr style="${r.active ? '' : 'opacity:.55'}"><td class="fw-600">${this.escapeAttr(r.name)}</td><td>${this.escapeAttr(r.branch_name || 'Any')}</td><td>${this.escapeAttr(r.department || 'Any')}</td><td style="font-size:12px">${this.escapeAttr(r.category_label || 'Any')}</td>
          <td style="text-align:right">${r.max_amount == null ? 'No limit' : this.fmt(r.max_amount)}</td><td style="font-size:12px">${r.approvers.map(a => this.escapeAttr(a.name)).join(', ')}</td><td>${r.active ? 'Yes' : 'No'}</td>
          <td style="white-space:nowrap">${canRoute ? `<button class="btn btn-sm btn-outline" onclick='App._suRuleForm(${JSON.stringify(r).replace(/'/g, '&#39;')})'>Edit</button> <button class="btn btn-sm btn-outline" style="color:var(--danger)" onclick="App._suDeleteRule(${r.id})">Delete</button>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="8" class="empty-state">No rules yet — any Shop Use approver (other than the requester) may approve</td></tr>'}
        </tbody></table></div>
        <div style="display:flex;gap:10px;align-items:flex-end;margin-top:12px">
          <div class="form-group" style="margin:0"><label>Approvals are overdue after (hours)</label><input type="number" id="su-set-hours" min="1" value="${meta.settings.approval_hours}" style="width:120px" ${canRoute ? '' : 'disabled'}></div>
          ${canRoute ? '<button class="btn btn-outline" onclick="App._suSaveHours()">Save</button>' : ''}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Account mapping</span></div>
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">Account codes in RetailPOS Books. Each issue posts <strong>Dr</strong> the category's expense (or asset) account and <strong>Cr</strong> inventory, at inventory cost; returns post the reverse. Changes apply to entries queued from now on. Books needs an API key with the Shop Use Postings scopes.</p>
        <div class="form-group" style="max-width:280px"><label>Inventory account (credited)</label><input id="su-acc-inv" value="${this.escapeAttr(accounts.inventory_account)}" ${canFin ? '' : 'disabled'}></div>
        <div class="table-wrap"><table style="font-size:13px"><thead><tr><th>Category</th><th>Treatment</th><th>Debit account code</th><th>Account name</th><th>Credit account (blank = inventory)</th></tr></thead><tbody>
        ${accounts.categories.map(c => `<tr data-cat="${c.key}"><td class="fw-600">${c.label}</td>
          <td><select class="su-acc-treat" ${canFin ? '' : 'disabled'}><option value="expense" ${c.treatment !== 'asset' ? 'selected' : ''}>Expense</option><option value="asset" ${c.treatment === 'asset' ? 'selected' : ''}>Asset</option></select></td>
          <td><input class="su-acc-debit" value="${this.escapeAttr(c.debit_account_code || '')}" placeholder="e.g. 6100" style="width:110px" ${canFin ? '' : 'disabled'}></td>
          <td><input class="su-acc-name" value="${this.escapeAttr(c.debit_account_name || '')}" ${canFin ? '' : 'disabled'}></td>
          <td><input class="su-acc-credit" value="${this.escapeAttr(c.credit_account_code || '')}" style="width:110px" ${canFin ? '' : 'disabled'}></td></tr>`).join('')}
        </tbody></table></div>
        ${canFin ? '<div style="margin-top:10px"><button class="btn btn-primary" onclick="App._suSaveAccounts()">Save Mapping</button></div>' : ''}
      </div>`;
  },

  async _suSaveHours() {
    try { await this.api('PUT', '/shop-use/settings', { approval_hours: document.getElementById('su-set-hours').value }); this.alert('Saved'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suSaveAccounts() {
    const categories = [...document.querySelectorAll('tr[data-cat]')].map(tr => ({
      key: tr.dataset.cat, treatment: tr.querySelector('.su-acc-treat').value, debit_account_code: tr.querySelector('.su-acc-debit').value,
      debit_account_name: tr.querySelector('.su-acc-name').value, credit_account_code: tr.querySelector('.su-acc-credit').value,
    }));
    try { await this.api('PUT', '/shop-use/accounts', { inventory_account: document.getElementById('su-acc-inv').value, categories }); this.alert('Account mapping saved'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suRuleForm(rule) {
    const meta = await this._suMeta();
    const r = rule || { active: 1, approvers: [] };
    const chosen = new Set((r.approvers || []).map(a => a.id));
    this.showModal(`<div class="modal" style="max-width:640px"><div class="modal-header"><span class="modal-title">${rule ? 'Edit' : 'Add'} approval rule</span><button class="modal-close">✕</button></div>
      <div class="modal-body">
        <div class="form-group"><label>Name *</label><input id="su-rule-name" value="${this.escapeAttr(r.name || '')}" placeholder="e.g. Branch manager up to 50,000"></div>
        <div class="input-row" style="grid-template-columns:1fr 1fr 1fr">
          <div class="form-group"><label>Branch</label><select id="su-rule-branch"><option value="">Any</option>${meta.branches.map(b => `<option value="${b.id}" ${String(r.branch_id) === String(b.id) ? 'selected' : ''}>${this.escapeAttr(b.name)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Department</label><select id="su-rule-dept"><option value="">Any</option>${meta.departments.map(d => `<option ${r.department === d ? 'selected' : ''}>${this.escapeAttr(d)}</option>`).join('')}</select></div>
          <div class="form-group"><label>Category</label><select id="su-rule-cat"><option value="">Any</option>${meta.categories.map(c => `<option value="${c.key}" ${r.category === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
        </div>
        <div class="input-row">
          <div class="form-group"><label>Approval limit <span style="font-weight:400;color:var(--text-muted);font-size:12px">(blank = no limit)</span></label><input type="number" min="0" step="0.01" id="su-rule-max" value="${r.max_amount ?? ''}"></div>
          <div class="form-group"><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" id="su-rule-active" ${r.active ? 'checked' : ''} style="width:16px;height:16px"> Active</label></div>
        </div>
        <div class="form-group"><label>Approvers *</label>
          <input placeholder="Filter…" oninput="document.querySelectorAll('#su-rule-emps label').forEach(l => l.style.display = l.textContent.toLowerCase().includes(this.value.toLowerCase()) ? '' : 'none')" style="margin-bottom:6px">
          <div id="su-rule-emps" style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px 10px">
            ${meta.employees.map(e => `<label style="display:flex;gap:8px;align-items:center;padding:3px 0;font-weight:400"><input type="checkbox" value="${e.id}" ${chosen.has(e.id) ? 'checked' : ''}>${this.escapeAttr(e.name)}</label>`).join('')}
          </div></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="App._suSaveRule(${rule ? rule.id : 'null'})">Save</button></div></div>`);
  },

  async _suSaveRule(id) {
    const v = x => document.getElementById(x).value;
    const body = { name: v('su-rule-name'), branch_id: v('su-rule-branch') || null, department: v('su-rule-dept'), category: v('su-rule-cat'), max_amount: v('su-rule-max'),
      active: document.getElementById('su-rule-active').checked, approver_ids: [...document.querySelectorAll('#su-rule-emps input:checked')].map(c => Number(c.value)) };
    try { await (id ? this.api('PUT', `/shop-use/rules/${id}`, body) : this.api('POST', '/shop-use/rules', body)); this.closeModal(); this.alert('Rule saved'); this.renderShopUse('settings'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _suDeleteRule(id) {
    if (!confirm('Delete this approval rule?')) return;
    try { await this.api('DELETE', `/shop-use/rules/${id}`); this.renderShopUse('settings'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  // Approvers are told when a request is routed to them, and requesters when
  // theirs is decided — GET /shop-use/inbox polled every minute, each item
  // shown once per user in this browser (same pattern as transfer requests).
  // The count waiting on you (to approve, to issue, or your own request sent
  // back) shows on the Warehouse menu item and the Shop Use tile.
  _startShopUseInbox() {
    clearInterval(this._suInboxTimer);
    this._suInboxFirst = true;
    this._suInboxCount = 0;
    if (!this._suCanOpen()) return this._paintShopUseBadges();
    this._pollShopUseInbox();
    this._suInboxTimer = setInterval(() => this._pollShopUseInbox(), 60000);
  },
  _stopShopUseInbox() { clearInterval(this._suInboxTimer); this._suInboxTimer = null; this._suInboxCount = 0; this._paintShopUseBadges(); },
  _paintShopUseBadges() {
    const n = this._suInboxCount || 0;
    const el = document.querySelector('.hub-tile[data-section="shop-use"]');
    if (el) {
      let pill = el.querySelector('.count-pill.su-inbox');
      if (!n) pill?.remove();
      else {
        if (!pill) { pill = document.createElement('span'); pill.className = 'count-pill su-inbox'; el.appendChild(pill); }
        pill.textContent = n > 99 ? '99+' : n;
        pill.title = `${n} Shop Use request${n === 1 ? '' : 's'} waiting on you (to approve, issue or correct)`;
      }
    }
    this._paintWarehouseNavBadge();
  },
  async _pollShopUseInbox() {
    if (!this.currentUser || !this._suCanOpen()) return;
    let inbox;
    try { inbox = await this.api('GET', '/shop-use/inbox'); } catch { return; }
    if (!this.currentUser) return;
    this._suInboxCount = inbox.count || 0;
    this._paintShopUseBadges();
    const key = `suInboxSeen:${this.currentUser.id}`;
    let seen;
    try { seen = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { seen = new Set(); }
    const freshA = inbox.approvals.filter(r => !seen.has(`a${r.id}:${r.version}`));
    const freshD = inbox.decisions.filter(r => !seen.has(`d${r.id}:${r.version}:${r.approval_status}`));
    if (this._suInboxFirst && freshA.length > 1) {
      this._notify({ title: `🧰 ${freshA.length} Shop Use requests awaiting your approval`, body: freshA.map(r => `${r.request_number} · ${this.escapeAttr(r.requested_by_name || '')} · ${this.fmt(r.total_estimated)}`).join('<br>'),
        actions: [{ label: 'Open Shop Use', primary: true, run: () => { this._suReqFilter = Object.assign(this._suDefaultReqFilter(), { view: 'awaiting_me' }); this.showSection('shop-use').then(() => this.renderShopUse('requests')); } }] });
    } else {
      for (const r of freshA) {
        this._notify({ title: `🧰 Shop Use ${r.request_number} needs your approval`,
          body: `<strong>${this.escapeAttr(r.requested_by_name || '')}</strong> · ${this.escapeAttr(r.branch_name || '')} / ${this.escapeAttr(r.department || '')} · ${this.escapeAttr(r.category_label)} · ${this.fmt(r.total_estimated)}${r.reason ? `<div style="color:var(--text-muted);margin-top:4px">${this.escapeAttr(r.reason)}</div>` : ''}`,
          actions: [{ label: 'Review', primary: true, run: () => this.viewShopUseRequest(r.id) }] });
      }
    }
    const toIssue = inbox.to_issue || [];
    const freshI = toIssue.filter(r => !seen.has(`i${r.id}:${r.version}`));
    if (this._suInboxFirst && freshI.length > 1) {
      this._notify({ title: `🧰 ${freshI.length} approved Shop Use requests to issue`, body: freshI.slice(0, 8).map(r => `${r.request_number} · ${this.escapeAttr(r.requested_by_name || '')} · ${this.fmt(r.value_outstanding)}`).join('<br>') + (freshI.length > 8 ? `<br>…and ${freshI.length - 8} more` : ''),
        actions: [{ label: 'Open Issue', primary: true, run: () => this.showSection('shop-use').then(() => this.renderShopUse('issue')) }] });
    } else {
      for (const r of freshI) {
        this._notify({ title: `🧰 Shop Use ${r.request_number} ${r.fulfillment_status === 'partial' ? 'part-issued — rest to issue' : 'approved — ready to issue'}`,
          body: `<strong>${this.escapeAttr(r.requested_by_name || '')}</strong> · ${this.escapeAttr(r.branch_name || '')} / ${this.escapeAttr(r.department || '')} · ${this.escapeAttr(r.category_label)} · ${this.fmt(r.value_outstanding)}${r.source_branch_name ? `<div style="color:var(--text-muted)">From ${this.escapeAttr(r.source_branch_name)}</div>` : ''}`,
          actions: [{ label: 'Open', primary: true, run: () => this.viewShopUseRequest(r.id) }] });
      }
    }
    freshI.forEach(r => seen.add(`i${r.id}:${r.version}`));
    if (!this._suInboxFirst) {
      const word = { approved: 'approved', rejected: 'rejected', returned: 'returned for correction' };
      for (const r of freshD) {
        this._notify({ title: `🧰 Shop Use ${r.request_number} ${word[r.approval_status]}`, body: `by ${this.escapeAttr(r.decided_by_name || '')}${r.decision_comment ? `: ${this.escapeAttr(r.decision_comment)}` : ''}`,
          actions: [{ label: 'Open', primary: true, run: () => this.viewShopUseRequest(r.id) }] });
      }
    }
    freshA.forEach(r => seen.add(`a${r.id}:${r.version}`));
    freshD.forEach(r => seen.add(`d${r.id}:${r.version}:${r.approval_status}`));
    try { localStorage.setItem(key, JSON.stringify([...seen].slice(-300))); } catch {}
    this._suInboxFirst = false;
  },

});
