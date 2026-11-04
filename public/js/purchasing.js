// Purchase requests, purchase orders, receiving, receive without PO.
Object.assign(App, {
  // ─── Purchase Requests (dedicated section) ────────────────
  async renderPurchaseRequests() {
    return this.renderPurchasing('requests');
  },

  // ─── Purchasing (tabbed: Purchase Orders + Purchase Requests) ─
  async renderPurchasing(activeTab, { keepFocus = false } = {}) {
    const tab = activeTab || this._purchasingTab || 'orders';
    this._purchasingTab = tab;
    const c = document.getElementById('content');
    if (!keepFocus) c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';

    const tabBtn = (key, label) => `
      <button class="btn btn-sm ${tab===key?'btn-primary':'btn-outline'}"
        onclick="App.renderPurchasing('${key}')">${label}</button>`;

    if (tab === 'orders') {
      const suppliers = await this.api('GET', '/suppliers');
      if (this.section !== 'purchasing' && this.section !== 'purchase-requests') return;
      const branches = this.currentUser.branches || [];
      const f = this._poFilters ||= {};
      const opt = (v, label, cur) => `<option value="${v}" ${String(cur || '') === String(v) ? 'selected' : ''}>${label}</option>`;
      c.innerHTML = `
        <div class="section-header">
          <h2>Purchasing</h2>
          <div style="display:flex;gap:8px">
            ${this.can('purchasing_approve') ? `<button class="btn btn-outline" onclick="App.renderPurchasing('approvals')">Approvals</button>` : ''}
            ${this.can('purchase_requests') ? `<button class="btn btn-outline" onclick="App.showPRForm()">+ New Purchase Request</button>` : ''}
            ${this.can('purchasing_receive_direct') ? `<button class="btn btn-outline" onclick="App.showDirectReceiptForm()">+ Receive Without PO</button>` : ''}
            <button class="btn btn-primary" onclick="App.showPOForm()">+ New PO</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          ${tabBtn('orders','Purchase Orders')}
          ${this.can('purchasing_approve') ? tabBtn('approvals','Approvals') : ''}
          ${this.can('purchase_requests') ? tabBtn('requests','Purchase Requests') : ''}
          ${this.can('purchasing_receive_direct') ? tabBtn('direct','Received Without PO') : ''}
        </div>
        <div class="card" style="margin-bottom:12px;padding:12px 16px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="pof-q" type="search" value="${this.escapeAttr(f.q || '')}" placeholder="Search PO #, supplier, vendor order #, item or SKU…" style="flex:1;min-width:220px" oninput="App._poFilterChanged(true)">
            <select id="pof-status" style="width:150px" onchange="App._poFilterChanged()">
              ${opt('', 'All statuses', f.status)}${opt('draft', 'Draft', f.status)}${opt('sent', 'Awaiting approval', f.status)}${opt('approved', 'Approved', f.status)}${opt('partial', 'Partially received', f.status)}${opt('received', 'Received', f.status)}${opt('cancelled', 'Cancelled', f.status)}
            </select>
            <select id="pof-supplier" data-searchable style="width:200px" onchange="App._poFilterChanged()">
              <option value="">All suppliers</option>${suppliers.map(sp => opt(sp.id, this.escapeAttr(sp.name), f.supplier_id)).join('')}
            </select>
            ${branches.length > 1 ? `<select id="pof-branch" style="width:150px" onchange="App._poFilterChanged()"><option value="">All branches</option>${branches.map(b => opt(b.id, this.escapeAttr(b.name), f.branch_id)).join('')}</select>` : ''}
            <input id="pof-start" type="date" value="${f.start || ''}" style="width:145px" title="Created from" onchange="App._poFilterChanged()">
            <span style="color:var(--text-muted)">to</span>
            <input id="pof-end" type="date" value="${f.end || ''}" style="width:145px" title="Created to" onchange="App._poFilterChanged()">
            <button class="btn btn-sm btn-outline" onclick="App._poFilters={};App.renderPurchasing('orders')">Clear</button>
          </div>
        </div>
        <div class="card">
          <div id="po-list"><div class="empty-state"><p>Loading...</p></div></div>
        </div>`;
      this._poSuppliers = suppliers;
      this._poBranches = branches;
      this._loadPOList();

    } else if (tab === 'direct') {
      if (!this.can('purchasing_receive_direct')) return this.renderPurchasing('orders');
      const suppliers = await this.api('GET', '/suppliers');
      if (this.section !== 'purchasing' && this.section !== 'purchase-requests') return;
      const f = this._drFilters ||= {};
      const opt = (v, label, cur) => `<option value="${v}" ${String(cur || '') === String(v) ? 'selected' : ''}>${label}</option>`;
      c.innerHTML = `
        <div class="section-header">
          <h2>Purchasing</h2>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" onclick="App.showDirectReceiptForm()">+ Receive Without PO</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          ${tabBtn('orders','Purchase Orders')}
          ${this.can('purchasing_approve') ? tabBtn('approvals','Approvals') : ''}
          ${this.can('purchase_requests') ? tabBtn('requests','Purchase Requests') : ''}
          ${tabBtn('direct','Received Without PO')}
        </div>
        <p style="font-size:13px;color:var(--text-muted);margin:-8px 0 14px">Goods taken in without a purchase order. Stock goes on hand when received, the item cost is updated, and an A/P bill is raised for vendors set to sync with A/P.</p>
        <div class="card" style="margin-bottom:12px;padding:12px 16px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="drf-q" type="search" value="${this.escapeAttr(f.q || '')}" placeholder="Search receipt #, supplier invoice #, item or SKU…" style="flex:1;min-width:220px" oninput="App._drFilterChanged(true)">
            <select id="drf-supplier" data-searchable style="width:200px" onchange="App._drFilterChanged()">
              <option value="">All suppliers</option>${suppliers.map(sp => opt(sp.id, this.escapeAttr(sp.name), f.supplier_id)).join('')}
            </select>
            <select id="drf-status" style="width:140px" onchange="App._drFilterChanged()">
              ${opt('', 'All', f.status)}${opt('received', 'Received', f.status)}${opt('reversed', 'Reversed', f.status)}
            </select>
            <input id="drf-start" type="date" value="${f.start || ''}" style="width:145px" title="Received from" onchange="App._drFilterChanged()">
            <span style="color:var(--text-muted)">to</span>
            <input id="drf-end" type="date" value="${f.end || ''}" style="width:145px" title="Received to" onchange="App._drFilterChanged()">
            <button class="btn btn-sm btn-outline" onclick="App._drFilters={};App.renderPurchasing('direct')">Clear</button>
          </div>
        </div>
        <div class="card"><div id="dr-list"><div class="empty-state"><p>Loading...</p></div></div></div>`;
      this._loadDirectReceiptList();

    } else if (tab === 'approvals') {
      // Tray of POs formally submitted ('sent') and awaiting an approve/reject
      // decision — draft POs aren't included since they haven't been
      // submitted by their requester yet.
      const orders = await this.api('GET', '/purchase-orders?status=sent&limit=100');
      if (this.section !== 'purchasing' && this.section !== 'purchase-requests') return;
      c.innerHTML = `
        <div class="section-header">
          <h2>Purchasing</h2>
          <div style="display:flex;gap:8px">
            ${this.can('purchasing_approve') ? `<button class="btn btn-outline" onclick="App.renderPurchasing('approvals')">Approvals</button>` : ''}
            ${this.can('purchase_requests') ? `<button class="btn btn-outline" onclick="App.showPRForm()">+ New Purchase Request</button>` : ''}
            ${this.can('purchasing_receive_direct') ? `<button class="btn btn-outline" onclick="App.showDirectReceiptForm()">+ Receive Without PO</button>` : ''}
            <button class="btn btn-primary" onclick="App.showPOForm()">+ New PO</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          ${tabBtn('orders','Purchase Orders')}
          ${tabBtn('approvals','Approvals')}
          ${this.can('purchase_requests') ? tabBtn('requests','Purchase Requests') : ''}
          ${this.can('purchasing_receive_direct') ? tabBtn('direct','Received Without PO') : ''}
        </div>
        <p style="font-size:13px;color:var(--text-muted);margin:-8px 0 14px">Purchase orders submitted for approval. Review the items and any linked quote or work order before approving or rejecting.</p>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>PO #</th><th>Supplier</th><th>Branch</th><th>Total</th><th>Submitted</th><th>Actions</th></tr></thead>
              <tbody>
                ${orders.length ? orders.map(po => `
                  <tr>
                    <td class="fw-600">${po.po_number}${this._internalNotesSnippet(po.internal_notes)}</td>
                    <td>${po.supplier_name || '-'}</td>
                    <td>${po.branch_name || '-'}</td>
                    <td class="fw-600">${this._fmtPO(po.total, po)}</td>
                    <td style="color:var(--text-muted)">${this.fmtDate(po.created_at)}</td>
                    <td>
                      <button class="btn btn-sm btn-secondary" onclick="App.viewPO(${po.id})">Review</button>
                      <button class="btn btn-sm btn-primary" onclick="App.showApprovePOModal(${po.id})">Approve</button>
                      <button class="btn btn-sm btn-danger" onclick="App.showRejectPOModal(${po.id})">Reject</button>
                    </td>
                  </tr>`).join('') : '<tr><td colspan="6" class="empty-state">Nothing awaiting approval</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;

    } else {
      // Purchase Requests tab
      const filter = this._prFilter || 'all';
      const typeFilter = this._prTypeFilter || 'all';
      const pf = this._prFilters ||= {};
      const params = new URLSearchParams({ limit: 200 });
      if (filter !== 'all') params.set('status', filter);
      if (typeFilter !== 'all') params.set('request_type', typeFilter);
      for (const k of ['q', 'branch_id', 'start', 'end']) if (pf[k]) params.set(k, pf[k]);
      const seq = (this._prListSeq = (this._prListSeq || 0) + 1);
      const requests = await this.api('GET', `/purchase-requests?${params}`);
      if (seq !== this._prListSeq) return; // a newer search has replaced this one
      const prBranches = this.currentUser.branches || [];
      if (this.section !== 'purchasing' && this.section !== 'purchase-requests') return;
      const prStatusColor = { draft:'badge-warning', submitted:'badge-info', approved:'badge-teal', rejected:'badge-danger', converted:'badge-success' };
      const typeLabel = this._prTypeLabels;
      const typeBadge = this._prTypeBadges;
      const statusTabs = ['all','draft','submitted','approved','rejected','converted'];
      const typeFilters = ['all', ...Object.keys(typeLabel)];
      c.innerHTML = `
        <div class="section-header">
          <h2>Purchasing</h2>
          <div style="display:flex;gap:8px">
            ${this.can('purchasing_approve') ? `<button class="btn btn-outline" onclick="App.renderPurchasing('approvals')">Approvals</button>` : ''}
            <button class="btn btn-primary" onclick="App.showPRForm()">+ New Request</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          ${tabBtn('orders','Purchase Orders')}
          ${this.can('purchasing_approve') ? tabBtn('approvals','Approvals') : ''}
          ${tabBtn('requests','Purchase Requests')}
        </div>
        <div class="card" style="margin-bottom:0;border-bottom:none;border-radius:8px 8px 0 0;padding:10px 16px 0">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <div style="display:flex;gap:4px">
              ${statusTabs.map(t=>`<button class="btn btn-sm ${filter===t?'btn-primary':'btn-outline'}" onclick="App._prFilter='${t}';App.renderPurchasing('requests')">${t.charAt(0).toUpperCase()+t.slice(1)}</button>`).join('')}
            </div>
            <div style="display:flex;gap:4px;margin-left:auto">
              ${typeFilters.map(t=>`<button class="btn btn-sm ${typeFilter===t?'btn-primary':'btn-outline'}" onclick="App._prTypeFilter='${t}';App.renderPurchasing('requests')">${t==='all'?'All Types':typeLabel[t]||t}</button>`).join('')}
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;padding-bottom:10px">
            <input id="prf-q" type="search" value="${this.escapeAttr(pf.q || '')}" placeholder="Search PR #, item, SKU, department, requester, supplier, PO #…" style="flex:1;min-width:220px" oninput="App._prFilterChanged(true)">
            ${prBranches.length > 1 ? `<select id="prf-branch" style="width:150px" onchange="App._prFilterChanged()"><option value="">All branches</option>${prBranches.map(b => `<option value="${b.id}" ${String(pf.branch_id || '') === String(b.id) ? 'selected' : ''}>${this.escapeAttr(b.name)}</option>`).join('')}</select>` : ''}
            <input id="prf-start" type="date" value="${pf.start || ''}" style="width:145px" title="Created from" onchange="App._prFilterChanged()">
            <span style="color:var(--text-muted)">to</span>
            <input id="prf-end" type="date" value="${pf.end || ''}" style="width:145px" title="Created to" onchange="App._prFilterChanged()">
            <button class="btn btn-sm btn-outline" onclick="App._prFilters={};App._prFilter='all';App._prTypeFilter='all';App.renderPurchasing('requests')">Clear</button>
          </div>
        </div>
        <div class="card" style="border-radius:0 0 8px 8px">
          <div class="table-wrap">
            <table>
              <thead><tr><th>PR #</th><th>Type</th><th>Branch</th><th>Department</th><th>Required By</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                ${requests.length ? requests.map(pr => `
                  <tr>
                    <td class="fw-600">${pr.pr_number}${pr.attachment_count > 0 ? ` <span title="${pr.attachment_count} document${pr.attachment_count > 1 ? 's' : ''} attached" style="font-weight:400;font-size:12px;color:var(--text-muted)">📎${pr.attachment_count}</span>` : ''}${this._internalNotesSnippet(pr.internal_notes)}</td>
                    <td><span class="badge-pill ${typeBadge[pr.request_type]||'badge-info'}" style="font-size:11px">${typeLabel[pr.request_type]||pr.request_type||'Sale Items'}</span></td>
                    <td>${pr.branch_name||'-'}</td>
                    <td>${pr.department||'-'}</td>
                    <td>${pr.required_date?this.fmtDate(pr.required_date):'-'}</td>
                    <td><span class="badge-pill ${prStatusColor[pr.status]||'badge-info'}">${pr.status}</span></td>
                    <td style="color:var(--text-muted)">${this.fmtDate(pr.created_at)}</td>
                    <td>
                      <button class="btn btn-sm btn-secondary" onclick="App.viewPR(${pr.id})">View</button>
                      ${pr.status==='draft'?`<button class="btn btn-sm btn-outline" onclick="App.showPRForm(${pr.id})">Edit</button>`:''}
                      ${pr.status==='draft'?`<button class="btn btn-sm btn-primary" onclick="App.updatePRStatus(${pr.id},'submitted')">Submit</button>`:''}
                      ${pr.status==='submitted'?`<button class="btn btn-sm btn-success" onclick="App.approvePR(${pr.id})">Approve</button><button class="btn btn-sm btn-danger" onclick="App.rejectPR(${pr.id})">Reject</button>`:''}
                      ${pr.status==='approved'?`<button class="btn btn-sm btn-teal" onclick="App.showConvertPRtoPO(${pr.id})">Convert to PO</button>`:''}
                      ${pr.converted_po_number?`<span style="font-size:12px;color:var(--text-muted)">→ ${this._prConvertedPOLink(pr)}</span>`:''}
                    </td>
                  </tr>`).join('') : `<tr><td colspan="8" class="empty-state">No purchase requests${filter!=='all'?' with status "'+filter+'"':''}${Object.values(pf).some(Boolean)?' matching these filters':''}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
      // Typing in the search box re-renders the tab — put the cursor back.
      if (keepFocus) { const q = document.getElementById('prf-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
    }
  },

  // Purchase Orders / Requests list filters: read the bar into
  // this._poFilters / this._prFilters (kept while you move around) and reload
  // just the list — typing in the search box waits a moment first.
  _poFilterChanged(typing) {
    const v = id => document.getElementById(id)?.value || '';
    this._poFilters = { q: v('pof-q').trim(), status: v('pof-status'), supplier_id: v('pof-supplier'), branch_id: v('pof-branch'), start: v('pof-start'), end: v('pof-end') };
    clearTimeout(this._poFilterTimer);
    this._poFilterTimer = setTimeout(() => this._loadPOList(), typing ? 300 : 0);
  },

  async _loadPOList() {
    const f = this._poFilters || {};
    const params = new URLSearchParams({ limit: 200 });
    for (const k of ['q', 'status', 'supplier_id', 'branch_id', 'start', 'end']) if (f[k]) params.set(k, f[k]);
    const seq = (this._poListSeq = (this._poListSeq || 0) + 1);
    let orders;
    try { orders = await this.api('GET', `/purchase-orders?${params}`); }
    catch(e) { const el = document.getElementById('po-list'); if (el) el.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    const el = document.getElementById('po-list');
    if (!el || seq !== this._poListSeq) return; // a newer search has replaced this one
    const statusColor = { draft:'badge-warning', sent:'badge-info', approved:'badge-teal', partial:'badge-purple', received:'badge-success', cancelled:'badge-danger' };
    const filtered = Object.values(f).some(Boolean);
    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>PO #</th><th>Supplier</th><th>Branch</th><th>Expected</th><th>Total</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            ${orders.length ? orders.map(po => `
              <tr>
                <td class="fw-600">${po.po_number}${po.vendor_order_number ? `<div style="font-size:11px;font-weight:400;color:var(--text-muted)">Vendor # ${this.escapeAttr(po.vendor_order_number)}</div>` : ''}${this._internalNotesSnippet(po.internal_notes)}</td>
                <td>${this.escapeAttr(po.supplier_name || '-')}</td>
                <td>${po.branch_name || '-'}</td>
                <td>${po.expected_date ? this.fmtDate(po.expected_date) : '-'}</td>
                <td class="fw-600">${this._fmtPO(po.total, po)}</td>
                <td><span class="badge-pill ${statusColor[po.status]||'badge-info'}">${po.status}</span></td>
                <td style="color:var(--text-muted)">${this.fmtDate(po.created_at)}</td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="App.viewPO(${po.id})">View</button>
                  ${po.status==='sent' && this.can('purchasing_approve') ? `<button class="btn btn-sm btn-primary" onclick="App.showApprovePOModal(${po.id})">Approve</button>` : ''}
                  ${(po.status==='approved'||po.status==='partial') && this.can('purchasing_receive') ? `<button class="btn btn-sm btn-success" onclick="App.showReceivePO(${po.id})">Receive</button>` : ''}
                </td>
              </tr>`).join('') : `<tr><td colspan="8" class="empty-state">${filtered ? 'No purchase orders match these filters' : 'No purchase orders yet'}</td></tr>`}
          </tbody>
        </table>
      </div>
      ${orders.length >= 200 ? '<div style="font-size:12px;color:var(--text-muted);padding:8px 12px">Showing the latest 200 — search or filter to narrow it down.</div>' : ''}`;
  },

  _prFilterChanged(typing) {
    const v = id => document.getElementById(id)?.value || '';
    this._prFilters = { q: v('prf-q').trim(), branch_id: v('prf-branch'), start: v('prf-start'), end: v('prf-end') };
    clearTimeout(this._prFilterTimer);
    this._prFilterTimer = setTimeout(() => this.renderPurchasing('requests', { keepFocus: typing }), typing ? 300 : 0);
  },

  // ─── Purchase Requests ────────────────────────────────────
  // "+ Add" on the PR form's Department list (_searchableSelect data-add).
  async _addPRDepartment(name) {
    const d = await this.api('POST', '/purchase-requests/departments', { name });
    return { value: d.name, text: d.name };
  },

  async showPRForm(editId) {
    const [products, suppliers, settings, deptRows] = await Promise.all([
      this.api('GET', '/products'),
      this.api('GET', '/suppliers'),
      this.api('GET', '/settings').catch(() => ({})),
      this.api('GET', '/purchase-requests/departments').catch(() => []),
    ]);
    const branches = this.currentUser.branches || [];
    const defaultCurrency = (settings.currency || 'USD').toUpperCase();
    const currencies = ['USD','EUR','GBP','CAD','AUD','JMD','TTD','BBD','GYD','BSD','HTG','MXN','CNY','JPY','INR','NGN','GHS','KES','ZAR'];
    if (!currencies.includes(defaultCurrency)) currencies.unshift(defaultCurrency);
    this._editingPRId = editId || null;
    const pr = editId ? await this.api('GET', `/purchase-requests/${editId}`) : null;
    const prCurrency = (pr && pr.currency) || defaultCurrency;
    // Match the PR's own department to the list loosely (older PRs were free
    // text) and keep it selectable even if it's not on the list.
    const departments = deptRows.map(d => d.name);
    const typedDept = String((pr && pr.department) || '').trim();
    const prDept = departments.find(d => d.toLowerCase() === typedDept.toLowerCase()) || typedDept;
    if (prDept && !departments.includes(prDept)) departments.unshift(prDept);
    if (!currencies.includes(prCurrency.toUpperCase())) currencies.unshift(prCurrency);
    const supOpts = `<option value="">-- No Supplier --</option>${suppliers.map(s=>`<option value="${s.id}" data-local="${s.is_local||0}" ${pr&&pr.supplier_id===s.id?'selected':''}>${s.name}${s.is_local?' (Local)':''}</option>`).join('')}`;
    this.showModal(`
      <div class="modal" style="max-width:800px">
        <div class="modal-header"><span class="modal-title">${editId ? `Edit Purchase Request: ${pr.pr_number}` : 'New Purchase Request'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group" style="margin-bottom:14px">
            <label style="font-weight:600;margin-bottom:6px;display:block">Request Type</label>
            <div style="display:flex;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden;width:fit-content">
              <button id="pr-type-sale" class="btn" style="border-radius:0;border:none;padding:8px 20px;background:var(--primary);color:#fff;font-weight:600" onclick="App._setPRType('sale_items')">Sale Items (for resale)</button>
              <button id="pr-type-internal" class="btn" style="border-radius:0;border:none;padding:8px 20px;background:var(--card);color:var(--text)" onclick="App._setPRType('internal_use')">Internal Use</button>
              <button id="pr-type-supplier" class="btn" style="border-radius:0;border:none;padding:8px 20px;background:var(--card);color:var(--text)" onclick="App._setPRType('supplier_priced')">Fuel / Supplier-priced</button>
            </div>
            <p id="pr-type-hint" style="font-size:12px;color:var(--text-muted);margin-top:5px">Products that will be stocked and sold to customers.</p>
          </div>

          <div class="input-row" style="grid-template-columns:1fr 1fr 1fr">
            <div class="form-group"><label>Supplier</label>
              <select id="pr-supplier" data-searchable onchange="App._onPRSupplierChange()">${supOpts}</select>
            </div>
            <div class="form-group"><label>Currency</label>
              <select id="pr-currency" onchange="App._onPRCurrencyChange()">
                ${currencies.map(c=>`<option value="${c}" ${c===prCurrency?'selected':''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Branch</label>
              <select id="pr-branch">
                <option value="">-- Select Branch --</option>
                ${branches.map(b => `<option value="${b.id}" ${pr&&pr.branch_id===b.id?'selected':''}>${b.name}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="input-row">
            <div class="form-group"><label>Department</label>
              <select id="pr-dept" data-searchable data-add="App._addPRDepartment">
                <option value="">— None —</option>
                ${departments.map(d => `<option value="${this.escapeAttr(d)}" ${prDept === d ? 'selected' : ''}>${this.escapeAttr(d)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Required By Date</label><input id="pr-date" type="date" value="${pr&&pr.required_date?String(pr.required_date).slice(0,10):''}"></div>
            <div class="form-group"><label>Notes <span style="font-weight:400;color:var(--text-muted);font-size:12px">(copied to the PO for the supplier)</span></label><input id="pr-notes" placeholder="Delivery or supplier instructions..." value="${this.escapeAttr(pr&&pr.notes)}"></div>
          </div>
          ${this._internalNotesInput('pr-internal-notes', pr && pr.internal_notes)}

          <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;padding:10px 12px;background:var(--bg);border-radius:6px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;margin:0">
              <input type="checkbox" id="pr-online" onchange="App._onPROnlineToggle()" style="width:16px;height:16px" ${pr&&pr.is_online_purchase?'checked':''}>
              Online Purchase
            </label>
            <span style="font-size:12px;color:var(--text-muted)">Adds product URLs per item; no local tax</span>
            <label id="pr-taxfree-wrap" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;margin:0" title="Local purchase with no GCT — ticks No Tax on every item">
              <input type="checkbox" id="pr-taxfree-all" onchange="App._onPRTaxFreeAll()" style="width:16px;height:16px">
              Tax Exempt (all items)
            </label>
            <div id="pr-tax-badge" style="display:none;margin-left:auto;padding:4px 12px;background:#e8f5e9;border-radius:20px;font-size:13px;color:#2e7d32"></div>
          </div>

          <div style="margin-bottom:10px">
            <div class="card-header"><span class="card-title">Items</span>
              <button class="btn btn-sm btn-outline" onclick="App.addPRItem()">+ Add Item</button>
            </div>
            <div style="display:grid;grid-template-columns:2fr 1.5fr 100px 60px 90px 90px 50px 28px;gap:6px;padding:4px 0 4px 8px;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase">
              <span>Product</span><span>Item Name</span><span title="Unit of measure to order in">Unit</span><span id="pr-qty-head">Qty</span><span>Est. Cost</span><span>Item Type</span><span title="Local tax exempt">No Tax</span><span></span>
            </div>
            <div id="pr-items"></div>
          </div>

          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 0 12px;padding:10px 12px;background:var(--bg);border-radius:6px">
            <span style="font-weight:600;font-size:13px">📎 Documents</span>
            <select id="pr-files-type" style="width:auto;font-size:12px">${this._prDocTypeOptions()}</select>
            <input type="file" id="pr-files" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.txt" style="flex:1;min-width:200px;font-size:12px">
            <span style="font-size:11px;color:var(--text-muted);width:100%">Supplier quotes, a brief or spec — uploaded when you save${editId ? '; existing documents are on the request\'s View screen' : ''}. Max 20 MB each.</span>
          </div>

          <div id="pr-totals-block" style="text-align:right;font-size:13px;line-height:1.9">
            <div>Subtotal: <span id="pr-subtotal" style="font-weight:600;min-width:80px;display:inline-block">$0.00</span></div>
            <div id="pr-tax-row" style="display:none;color:var(--text-muted)">Tax (<span id="pr-tax-pct"></span>%): <span id="pr-tax-amt" style="font-weight:600;min-width:80px;display:inline-block">$0.00</span></div>
            <div style="font-size:15px;font-weight:700;border-top:1px solid var(--border);margin-top:4px;padding-top:4px">Est. Total: <span id="pr-total">$0.00</span></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-outline" onclick="App.savePR('draft')">${editId ? 'Save Changes' : 'Save Draft'}</button>
          <button class="btn btn-primary" onclick="App.savePR('submitted')">Submit Request</button>
        </div>
      </div>`);
    this._prAllProducts = products;
    this._prAllSuppliers = suppliers;
    this._prItems = [];
    this._prRequestType = (pr && pr.request_type) || 'sale_items';
    this._prTaxRate = parseFloat(settings.tax_rate) || 0;
    this._prDefaultCurrency = defaultCurrency;
    this._prIsOnline = !!(pr && pr.is_online_purchase);
    this._prIsLocalSupplier = true; // default currency is pre-selected
    this._setPRType(this._prRequestType);
    if (pr && pr.items.length) {
      pr.items.forEach(item => this.addPRItem(item));
    } else {
      this.addPRItem();
    }
    this._onPRCurrencyChange(); // show tax badge on open
    // Item lines are added dynamically (addPRItem), so this closes whichever
    // pri-prod-dd-* dropdown is currently open rather than binding to a
    // specific line's id — same pattern as the Quotation item picker.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pri-prod-search-wrap')) {
        document.querySelectorAll('[id^="pri-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
    });
  },

  _prTypeLabels: { sale_items: 'Sale Items', internal_use: 'Internal Use', supplier_priced: 'Fuel / Supplier-priced' },
  _prTypeBadges: { sale_items: 'badge-info', internal_use: 'badge-purple', supplier_priced: 'badge-warning' },

  _setPRType(type) {
    this._prRequestType = type;
    const buttons = { sale_items: 'pr-type-sale', internal_use: 'pr-type-internal', supplier_priced: 'pr-type-supplier' };
    for (const [t, id] of Object.entries(buttons)) {
      const btn = document.getElementById(id);
      btn.style.background = t === type ? 'var(--primary)' : 'var(--card)';
      btn.style.color = t === type ? '#fff' : 'var(--text)';
    }
    document.getElementById('pr-type-hint').textContent = {
      sale_items: 'Products that will be stocked and sold to customers.',
      internal_use: 'Items for internal use — office supplies, equipment, consumables, etc. Will not enter product inventory.',
      supplier_priced: 'Fuel and other items the supplier prices on delivery. Pick each item from inventory and enter the maximum quantity — no cost. Once approved, send the signed Authorization to Pump to the supplier; their invoice sets the cost on the PO.',
    }[type];
    document.querySelectorAll('[id^="pri-itype-"]').forEach(sel => {
      if (sel.value === 'service' && type !== 'supplier_priced') return;
      sel.value = type === 'internal_use' ? 'internal' : 'sale';
      this._onPRItemTypeChange(sel.id.replace('pri-itype-', ''));
    });
    // Supplier-priced lines are inventory items only — no Service option
    document.querySelectorAll('[id^="pri-itype-"] option[value="service"]').forEach(o => { o.hidden = type === 'supplier_priced'; });
    this._applyPRSupplierPriced();
  },

  // Supplier-priced lines carry no cost (it comes from the supplier's
  // invoice) and their quantity is the maximum authorized, which may be a
  // part quantity (litres/gallons).
  _applyPRSupplierPriced() {
    const on = this._prRequestType === 'supplier_priced';
    document.querySelectorAll('[id^="pri-cost-"]').forEach(el => {
      el.disabled = on;
      if (on) el.value = '';
      el.placeholder = on ? 'Invoice' : 'Est. Cost';
    });
    document.querySelectorAll('[id^="pri-qty-"]').forEach(el => { el.step = on || el.dataset.measured ? 'any' : '1'; el.title = on ? 'Maximum quantity authorized' : ''; });
    const qtyHead = document.getElementById('pr-qty-head');
    if (qtyHead) qtyHead.textContent = on ? 'Max Qty' : 'Qty';
    this.calcPRTotal();
  },

  _onPRSupplierChange() {
    // supplier change keeps local badge in sync but doesn't drive tax
    this._onPRCurrencyChange();
  },

  _onPRCurrencyChange() {
    const currency = document.getElementById('pr-currency')?.value || '';
    // Online (overseas) purchases never carry local tax, even in local currency
    this._prIsLocalSupplier = currency === this._prDefaultCurrency && !this._prIsOnline;
    const badge = document.getElementById('pr-tax-badge');
    if (badge) {
      if (this._prIsOnline) {
        badge.style.display = 'block';
        badge.textContent = 'Online purchase — no local tax';
      } else if (this._prIsLocalSupplier && this._prTaxRate > 0) {
        badge.style.display = 'block';
        badge.textContent = `${currency} is local currency — ${this._prTaxRate}% tax applies`;
      } else {
        badge.style.display = 'none';
      }
    }
    // Exemption only means something when local tax would apply
    document.querySelectorAll('[id^="pri-taxfree-"], #pr-taxfree-all').forEach(cb => { cb.disabled = !this._prIsLocalSupplier; });
    const wrap = document.getElementById('pr-taxfree-wrap');
    if (wrap) wrap.style.opacity = this._prIsLocalSupplier ? '' : '.5';
    this.calcPRTotal();
  },

  _onPRTaxFreeAll() {
    const on = document.getElementById('pr-taxfree-all')?.checked || false;
    document.querySelectorAll('[id^="pri-taxfree-"]').forEach(cb => { cb.checked = on; });
    this.calcPRTotal();
  },

  _onPROnlineToggle() {
    this._prIsOnline = document.getElementById('pr-online')?.checked || false;
    document.querySelectorAll('[id^="pri-url-row-"]').forEach(el => {
      el.style.display = this._prIsOnline ? '' : 'none';
    });
    this._onPRCurrencyChange(); // online drops local tax
  },

  addPRItem(prefill) {
    this._prItems = this._prItems || [];
    const idx = this._prItems.length;
    this._prItems.push({});
    const container = document.getElementById('pr-items');
    const prefillProduct = prefill && prefill.product_id ? (this._prAllProducts||[]).find(p => p.id === prefill.product_id) : null;
    const prefillLabel = prefillProduct ? `${prefillProduct.name} (${prefillProduct.sku||''})` : '';
    const defaultType = prefill ? prefill.item_type : ((this._prRequestType === 'internal_use') ? 'internal' : 'sale');
    const supplierPriced = this._prRequestType === 'supplier_priced';
    const isService = defaultType === 'service';
    const wrap = document.createElement('div');
    wrap.id = `pr-item-${idx}`;
    wrap.style.cssText = 'border-bottom:1px solid var(--border);padding:8px 0';
    wrap.innerHTML = `
      <div style="display:grid;grid-template-columns:2fr 1.5fr 100px 60px 90px 90px 50px 28px;gap:6px;align-items:center">
        <span class="pri-prod-search-wrap" style="position:relative">
          <input type="text" id="pri-prod-search-${idx}" placeholder="${isService ? 'Service — not an inventory item' : 'Search product (optional)…'}" ${isService ? 'disabled' : ''} autocomplete="off" style="width:100%"
            value="${this.escapeAttr(prefillLabel)}"
            oninput="App._filterPRProdOptions(${idx},this.value)" onfocus="App._filterPRProdOptions(${idx},this.value)">
          <input type="hidden" id="pri-prod-${idx}" value="${prefill&&prefill.product_id||''}">
          <div id="pri-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
        </span>
        <input id="pri-name-${idx}" placeholder="${isService ? 'Describe the service' : 'Or type item name'}" value="${prefill&&!prefill.product_id?this.escapeAttr(prefill.product_name):''}" data-qi-id="${prefill&&prefill.quotation_item_id||''}" oninput="App.calcPRTotal()">
        <select id="pri-unit-${idx}" style="font-size:12px" onchange="App._onPRUnitChange(${idx})" title="Unit of measure to order in" disabled><option value="">—</option></select>
        <input id="pri-qty-${idx}" type="number" min="${supplierPriced?'0':'1'}" step="${supplierPriced?'any':'1'}" value="${prefill?prefill.quantity:1}" placeholder="Qty" ${supplierPriced?'title="Maximum quantity authorized"':''} oninput="App.calcPRTotal()">
        <input id="pri-cost-${idx}" type="number" step="0.01" value="${prefill&&!supplierPriced?prefill.unit_cost:''}" placeholder="${supplierPriced?'Invoice':'Est. Cost'}" ${supplierPriced?'title="Cost comes from the supplier\'s invoice on the PO"':''} ${supplierPriced?'disabled':''} oninput="App.calcPRTotal()">
        <select id="pri-itype-${idx}" style="font-size:12px" onchange="App._onPRItemTypeChange(${idx})" title="Service = non-physical (e.g. a promotional video, design work, a subscription): no product, no stock">
          <option value="sale" ${defaultType==='sale'?'selected':''}>Sale</option>
          <option value="internal" ${defaultType==='internal'?'selected':''}>Internal</option>
          <option value="service" ${isService?'selected':''} ${supplierPriced?'hidden':''}>Service</option>
        </select>
        <input type="checkbox" id="pri-taxfree-${idx}" title="Tax exempt — no local tax on this item" style="width:16px;height:16px;justify-self:center" ${prefill&&prefill.tax_exempt?'checked':''} ${this._prIsLocalSupplier?'':'disabled'} onchange="App.calcPRTotal()">
        <button class="btn btn-sm btn-danger" onclick="document.getElementById('pr-item-${idx}').remove();App.calcPRTotal()">✕</button>
      </div>
      <div id="pri-url-row-${idx}" style="display:${this._prIsOnline?'':'none'};margin-top:6px;padding:0 0 2px 2px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;min-width:80px">Product URL:</span>
          <input id="pri-url-${idx}" placeholder="https://..." style="flex:1" value="${this.escapeAttr(prefill&&prefill.product_url)}">
        </div>
      </div>
      <div id="pri-details-row-${idx}" style="display:${isService || (prefill && prefill.notes) ? '' : 'none'};margin-top:6px;padding:0 0 2px 2px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;min-width:80px">Details:</span>
          <input id="pri-notes-${idx}" placeholder="Scope / deliverables — e.g. 60-second promo video, 2 revision rounds, MP4 for social media, due by launch" style="flex:1" value="${this.escapeAttr(prefill&&prefill.notes)}">
        </div>
      </div>`;
    container.appendChild(wrap);
    if (prefillProduct && !isService) this._setPRLineUnits(idx, prefillProduct, this._unitChoiceFor(prefillProduct, prefill.uom_id ?? prefillProduct.base_unit_id ?? null, 'buy'));
  },

  // A PR line's unit dropdown (lib/units.js), like a PO line's: the item's
  // units plus "+ Add unit…"; a free-typed item or service has none.
  _setPRLineUnits(idx, p, choice) {
    const unitSel = document.getElementById(`pri-unit-${idx}`);
    if (!unitSel) return;
    unitSel.innerHTML = p ? this._orderUnitOptionsHtml(p, choice) : '<option value="">—</option>';
    unitSel.disabled = !p || unitSel.options.length < 2;
    unitSel.dataset.prev = unitSel.value;
    const qty = document.getElementById(`pri-qty-${idx}`);
    // A measured unit (yards, kg…) takes part quantities.
    const measured = !!choice?.allow_decimal || (!choice && !!p?.base_unit_decimal);
    if (qty) {
      qty.dataset.measured = measured ? '1' : '';
      const part = measured || this._prRequestType === 'supplier_priced';
      qty.step = part ? 'any' : '1'; qty.min = part ? '0' : '1';
    }
  },

  // A new unit sets the line's estimated cost to the unit's size × the
  // item's cost (not on a supplier-priced request — its cost comes later).
  async _onPRUnitChange(idx) {
    const hidden = document.getElementById(`pri-prod-${idx}`);
    const p = (this._prAllProducts || []).find(x => String(x.id) === hidden?.value);
    const unitSel = document.getElementById(`pri-unit-${idx}`);
    if (!p || !unitSel) return;
    let choice;
    if (unitSel.value === '__add') {
      choice = await this._addOrderUnit(p);
      if (!choice) { unitSel.value = unitSel.dataset.prev || ''; return; }
    } else {
      choice = this._unitChoiceFor(p, unitSel.value ? Number(unitSel.value) : (p.base_unit_id || null), 'buy');
    }
    this._setPRLineUnits(idx, p, choice);
    if (this._prRequestType !== 'supplier_priced') document.getElementById(`pri-cost-${idx}`).value = ((p.cost || 0) * (choice?.factor || 1)).toFixed(2);
    this.calcPRTotal();
  },

  // Service = a non-physical purchase (promotional video, design work…):
  // never an inventory product, so the product picker is cleared and locked,
  // and a Details line opens for the scope/deliverables.
  _onPRItemTypeChange(idx) {
    const isService = document.getElementById(`pri-itype-${idx}`)?.value === 'service';
    const search = document.getElementById(`pri-prod-search-${idx}`);
    const hidden = document.getElementById(`pri-prod-${idx}`);
    const name = document.getElementById(`pri-name-${idx}`);
    const details = document.getElementById(`pri-notes-${idx}`);
    if (isService) {
      if (hidden.value && !name.value) name.value = hidden.dataset.name || search.value.replace(/\s*\([^)]*\)$/, '');
      hidden.value = ''; delete hidden.dataset.name; delete hidden.dataset.sku;
      search.value = '';
      this._setPRLineUnits(idx, null, null);
    }
    search.disabled = isService;
    search.placeholder = isService ? 'Service — not an inventory item' : 'Search product (optional)…';
    name.placeholder = isService ? 'Describe the service' : 'Or type item name';
    document.getElementById(`pri-details-row-${idx}`).style.display = isService || details.value ? '' : 'none';
    if (isService) name.focus();
  },

  // Searchable replacement for what used to be a plain <select> of every
  // product — same pattern as the Quotation item picker. The product is
  // optional here (a request can name a free-typed item instead), so an
  // empty search box is a valid, unselected state — savePR falls back to
  // pri-name-${idx}'s free text whenever pri-prod-${idx} has no value.
  _filterPRProdOptions(idx, query) {
    const dd = document.getElementById(`pri-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._prAllProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectPRProdOption(${idx},${p.id})">
        <strong>${p.name}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${p.sku||''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No products found</div>`;
    dd.style.display = '';
  },

  async _selectPRProdOption(idx, productId) {
    const p = (this._prAllProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`pri-prod-${idx}`);
    const searchEl = document.getElementById(`pri-prod-search-${idx}`);
    const dd = document.getElementById(`pri-prod-dd-${idx}`);
    if (hidden) { hidden.value = productId; hidden.dataset.name = p.name; hidden.dataset.sku = p.sku||''; }
    if (searchEl) searchEl.value = `${p.name} (${p.sku||''})`;
    if (dd) dd.style.display = 'none';
    document.getElementById(`pri-name-${idx}`).value = '';
    // An item with alternate units asks which one to order in (lib/units.js).
    const choice = (await this._pickUnit(p, 'buy')) || this._unitChoices(p, 'buy')[0];
    this._setPRLineUnits(idx, p, choice);
    if (this._prRequestType !== 'supplier_priced') document.getElementById(`pri-cost-${idx}`).value = p.cost ? ((p.cost || 0) * (choice?.factor || 1)).toFixed(2) : '';
    this.calcPRTotal();
  },

  calcPRTotal() {
    let subtotal = 0, taxable = 0, lines = 0, exempt = 0;
    document.querySelectorAll('[id^="pri-qty-"]').forEach(qEl => {
      const idx = qEl.id.split('-').pop();
      const amt = (parseFloat(qEl.value)||0) * (parseFloat(document.getElementById(`pri-cost-${idx}`)?.value)||0);
      const isExempt = !!document.getElementById(`pri-taxfree-${idx}`)?.checked;
      subtotal += amt;
      if (!isExempt) taxable += amt;
      lines++; if (isExempt) exempt++;
    });
    const allBox = document.getElementById('pr-taxfree-all');
    if (allBox) allBox.checked = lines > 0 && exempt === lines;
    const taxRate = this._prIsLocalSupplier ? (this._prTaxRate || 0) : 0;
    const taxAmt = parseFloat((taxable * taxRate / 100).toFixed(2));
    const total = parseFloat((subtotal + taxAmt).toFixed(2));

    const currency = document.getElementById('pr-currency')?.value || this._prDefaultCurrency || 'USD';
    const fmtPR = n => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n || 0);

    const sub = document.getElementById('pr-subtotal');
    const taxRow = document.getElementById('pr-tax-row');
    const taxPct = document.getElementById('pr-tax-pct');
    const taxAmtEl = document.getElementById('pr-tax-amt');
    const totalEl = document.getElementById('pr-total');
    if (sub) sub.textContent = fmtPR(subtotal);
    if (taxRow) taxRow.style.display = taxRate > 0 ? '' : 'none';
    if (taxPct) taxPct.textContent = taxRate;
    if (taxAmtEl) taxAmtEl.textContent = fmtPR(taxAmt);
    if (totalEl) totalEl.textContent = fmtPR(total);
  },

  async savePR(initialStatus) {
    const branch_id = document.getElementById('pr-branch').value;
    const department = document.getElementById('pr-dept').value;
    const required_date = document.getElementById('pr-date').value;
    const notes = document.getElementById('pr-notes').value;
    const request_type = this._prRequestType || 'sale_items';
    const supplier_id = document.getElementById('pr-supplier')?.value || null;
    const currency = document.getElementById('pr-currency')?.value || null;
    const is_online_purchase = document.getElementById('pr-online')?.checked ? 1 : 0;
    const taxRate = this._prIsLocalSupplier ? (this._prTaxRate || 0) : 0;

    const items = [];
    let missingProduct = false, unnamedService = false;
    document.querySelectorAll('[id^="pri-qty-"]').forEach(qEl => {
      if (!qEl.closest('[id^="pr-item-"]')) return;
      const idx = qEl.id.split('-').pop();
      const sel = document.getElementById(`pri-prod-${idx}`);
      const product_id = sel?.value || '';
      const nameEl = document.getElementById(`pri-name-${idx}`);
      const nameInput = nameEl?.value.trim();
      const product_name = product_id ? (sel?.dataset.name || '') : nameInput;
      const sku = product_id ? (sel?.dataset.sku || '') : '';
      const details = document.getElementById(`pri-notes-${idx}`)?.value.trim() || null;
      if (!product_id && !product_name) { if (details) unnamedService = true; return; }
      if (request_type === 'supplier_priced' && !product_id) missingProduct = true;
      const unitVal = product_id ? document.getElementById(`pri-unit-${idx}`)?.value : '';
      const uom_id = unitVal && unitVal !== '__add' ? Number(unitVal) : null;
      const quantity = request_type === 'supplier_priced' || qEl.step === 'any' ? (parseFloat(qEl.value) || 0) : (parseInt(qEl.value) || 1);
      const unit_cost = parseFloat(document.getElementById(`pri-cost-${idx}`)?.value) || 0;
      const item_type = document.getElementById(`pri-itype-${idx}`)?.value || (request_type === 'internal_use' ? 'internal' : 'sale');
      const product_url = document.getElementById(`pri-url-${idx}`)?.value.trim() || null;
      const quotation_item_id = nameEl?.dataset.qiId || null;
      const tax_exempt = this._prIsLocalSupplier && document.getElementById(`pri-taxfree-${idx}`)?.checked ? 1 : 0;
      items.push({ product_id: product_id || null, product_name, sku, quantity, unit_cost, item_type, product_url, quotation_item_id, tax_exempt, notes: details, uom_id });
    });
    if (unnamedService) { this.alert('Give each line a name — e.g. "Promotional video" — the details go underneath', 'error'); return; }
    if (!items.length) { this.alert('Add at least one item', 'error'); return; }
    if (missingProduct) { this.alert('Fuel / supplier-priced requests need every item picked from inventory', 'error'); return; }
    if (request_type === 'supplier_priced' && items.some(i => !(i.quantity > 0))) { this.alert('Enter the maximum quantity for each item', 'error'); return; }

    const taxable = items.reduce((s, i) => s + (i.tax_exempt ? 0 : i.unit_cost * i.quantity), 0);
    const tax_amount = parseFloat((taxable * taxRate / 100).toFixed(2));

    try {
      const payload = {
        branch_id: branch_id||null, department: department||null, notes: notes||null,
        internal_notes: document.getElementById('pr-internal-notes').value.trim() || null,
        required_date: required_date||null, request_type,
        supplier_id: supplier_id||null, currency: currency||null,
        is_online_purchase, tax_rate: taxRate, tax_amount, items
      };
      const pr = this._editingPRId
        ? await this.api('PUT', `/purchase-requests/${this._editingPRId}`, payload)
        : await this.api('POST', '/purchase-requests', payload);
      // Documents picked on the form go up once the request exists. The
      // request itself is saved either way; a failed file is reported.
      const files = [...(document.getElementById('pr-files')?.files || [])];
      let uploadError = null;
      if (files.length) {
        try { await this._uploadPRFiles(pr.id, files, document.getElementById('pr-files-type').value); }
        catch (e) { uploadError = e.message; }
      }
      if (initialStatus === 'submitted') {
        await this.api('PATCH', `/purchase-requests/${pr.id}/status`, { status: 'submitted' });
      }
      this.closeModal();
      this.alert(this._editingPRId ? 'Purchase request updated' : 'Purchase request created');
      this.renderPurchasing('requests');
      if (uploadError) this.alert(`Request saved, but a document didn't upload — ${uploadError}. Add it from the request's View screen.`, 'error');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // A converted PR's PO number, as a link that opens the PO — only for
  // users who can actually view it (/purchase-orders is gated on
  // `purchasing`); everyone else just sees the number.
  _prConvertedPOLink(pr) {
    if (!pr.converted_to_po_id || !this.can('purchasing')) return pr.converted_po_number;
    return `<a href="#" style="color:inherit;text-decoration:underline" title="Open purchase order" onclick="event.preventDefault();event.stopPropagation();App.closeModal();App.viewPO(${pr.converted_to_po_id})">${pr.converted_po_number}</a>`;
  },

  async viewPR(id) {
    const [pr, attachments] = await Promise.all([
      this.api('GET', `/purchase-requests/${id}`),
      this.api('GET', `/purchase-requests/${id}/attachments`).catch(() => []),
    ]);
    // Documents can be added at any stage; removed only before approval
    const canRemoveDocs = ['draft', 'submitted', 'rejected'].includes(pr.status);
    const prStatusColor = { draft:'badge-warning', submitted:'badge-info', approved:'badge-teal', rejected:'badge-danger', converted:'badge-success' };
    const typeLabel = this._prTypeLabels;
    const typeBadge = this._prTypeBadges;
    const supplierPriced = pr.request_type === 'supplier_priced';
    const total = (pr.items || []).reduce((s, i) => s + (i.total || 0), 0);
    const saleItems = (pr.items||[]).filter(i => i.item_type !== 'internal');
    const internalItems = (pr.items||[]).filter(i => i.item_type === 'internal');
    const hasUrls = (pr.items||[]).some(i => i.product_url);
    const renderItemRows = items => items.map(i => `<tr>
      <td>
        ${this._orderLineUnit(i).name}${i.item_type==='internal'?'<span style="font-size:10px;margin-left:4px;color:var(--text-muted)">[internal]</span>':''}${i.item_type==='service'?' <span class="badge-pill badge-info" style="font-size:10px">Service</span>':''}${i.discount_amount > 0 ? ` <span class="badge-pill badge-purple" style="font-size:10px" title="Discount given on the originating quote line">-${this.fmt(i.discount_amount)} quoted</span>` : ''}${i.tax_exempt ? ' <span class="badge-pill badge-teal" style="font-size:10px">Tax exempt</span>' : ''}
        ${i.product_url ? `<br><a href="${i.product_url}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);word-break:break-all">${i.product_url}</a>` : ''}
      </td>
      <td>${i.sku||'-'}</td>
      <td>${i.quantity}${supplierPriced ? '<div style="font-size:11px;color:var(--text-muted)">max</div>' : ''}</td>
      <td>${this.escapeAttr(this._orderLineUnit(i).unit)}</td>
      <td>${supplierPriced ? '<span style="color:var(--text-muted)">Per invoice</span>' : this._fmtPR(i.unit_cost, pr)}</td>
      <td class="fw-600">${supplierPriced ? '—' : this._fmtPR(i.total, pr)}</td>
      <td style="font-size:12px;color:var(--text-muted)">${i.notes||''}</td>
    </tr>`).join('');
    this.showModal(`
      <div class="modal" style="max-width:700px">
        <div class="modal-header">
          <span class="modal-title">PR: ${pr.pr_number}</span>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="badge-pill ${typeBadge[pr.request_type]||'badge-info'}" style="font-size:11px">${typeLabel[pr.request_type]||'Sale Items'}</span>
            <span class="badge-pill ${prStatusColor[pr.status]||''}">${pr.status}</span>
            <button class="modal-close">✕</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="two-col" style="margin-bottom:14px;font-size:13px">
            <div>
              <strong>Branch:</strong> ${pr.branch_name||'-'}<br>
              <strong>Department:</strong> ${pr.department||'-'}<br>
              <strong>Requested by:</strong> ${pr.employee_name||'-'}<br>
              <strong>Supplier:</strong> ${pr.supplier_name ? `${pr.supplier_name}${pr.supplier_is_local?' <span class="badge-pill badge-teal" style="font-size:10px">Local</span>':''}` : '-'}<br>
              <strong>Currency:</strong> ${pr.currency||'-'}
              ${pr.is_online_purchase ? ' &nbsp;<span class="badge-pill badge-info" style="font-size:10px">Online Purchase</span>' : ''}
            </div>
            <div>
              <strong>Created:</strong> ${this.fmtDate(pr.created_at)}<br>
              <strong>Required By:</strong> ${pr.required_date ? this.fmtDate(pr.required_date) : '-'}<br>
              ${pr.approver_name ? `<strong>Approved by:</strong> <span class="color-success">${pr.approver_name}</span>${pr.approved_at?' on '+this.fmtDate(pr.approved_at):''}${this._approvalSigImg(pr.approval_signature)}` : ''}
              ${pr.converted_po_number ? `<strong>Converted to:</strong> <span class="color-success fw-600">${this._prConvertedPOLink(pr)}</span>` : ''}
            </div>
          </div>
          ${this._internalNotesHtml(pr.internal_notes)}
          ${pr.notes ? `<div style="padding:8px 12px;background:var(--bg-secondary,#f8f9fa);border-radius:6px;font-size:13px;margin-bottom:12px"><strong>Notes:</strong> ${pr.notes}</div>` : ''}
          ${pr.rejection_reason ? `<div style="padding:8px 12px;background:#fff3f3;border-left:3px solid var(--danger);border-radius:0 6px 6px 0;font-size:13px;margin-bottom:12px"><strong>Rejection Reason:</strong> ${pr.rejection_reason}</div>` : ''}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Unit</th><th>Est. Cost</th><th>Total</th><th>Notes</th></tr></thead>
              <tbody>${renderItemRows(pr.items||[])}</tbody>
            </table>
          </div>
          ${saleItems.length && internalItems.length ? `
            <div style="display:flex;gap:16px;margin-top:10px;font-size:13px;color:var(--text-muted)">
              <span>Sale items: <strong>${saleItems.length}</strong></span>
              <span>Internal items: <strong>${internalItems.length}</strong></span>
            </div>` : ''}
          ${supplierPriced ? `<div style="margin-top:10px;padding:8px 12px;background:var(--bg-secondary,#f8f9fa);border-radius:6px;font-size:13px">
            Quantities are the <strong>maximum</strong> the supplier may supply. ${['approved','converted','received'].includes(pr.status) ? 'Print or email the signed <strong>Authorization to Pump</strong> to the supplier; enter the cost from their invoice on the PO and attach the invoice.' : 'Once approved, the signed Authorization to Pump can be printed or emailed to the supplier.'}
          </div>` : `<div style="text-align:right;margin-top:10px;font-size:13px;line-height:1.9">
            <div style="color:var(--text-muted)">Subtotal: <strong>${this._fmtPR(total, pr)}</strong></div>
            ${pr.tax_amount > 0 ? `<div style="color:var(--text-muted)">Tax (${pr.tax_rate}% local): <strong>${this._fmtPR(pr.tax_amount, pr)}</strong></div>` : ''}
            <div style="font-size:15px;font-weight:700;border-top:1px solid var(--border);padding-top:4px">Est. Total: ${this._fmtPR(total + (pr.tax_amount||0), pr)}</div>
          </div>`}
          <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-weight:700;font-size:14px">Attachments</span>
              <button class="btn btn-sm btn-outline" onclick="App.showPRAttachForm(${pr.id})">+ Attach Document</button>
            </div>
            <div id="pr-attachments-list" data-can-remove="${canRemoveDocs ? 1 : 0}">
              ${attachments.length ? attachments.map(a => this._prAttachmentRow(pr.id, a, canRemoveDocs)).join('') : '<div style="font-size:13px;color:var(--text-muted);padding:6px 0" id="pr-att-empty">No documents attached yet.</div>'}
            </div>
          </div>
        </div>
        <div class="modal-footer">
          ${pr.status==='draft' ? `<button class="btn btn-secondary" onclick="App.closeModal();App.showPRForm(${pr.id})">Edit</button>` : ''}
          ${pr.status==='draft' ? `<button class="btn btn-primary" onclick="App.updatePRStatus(${pr.id},'submitted');App.closeModal()">Submit Request</button>` : ''}
          ${pr.status==='submitted' ? `<button class="btn btn-success" onclick="App.closeModal();App.approvePR(${pr.id})">Approve</button><button class="btn btn-danger" onclick="App.closeModal();App.rejectPR(${pr.id})">Reject</button>` : ''}
          ${supplierPriced && ['approved','converted','received'].includes(pr.status) ? `<button class="btn btn-secondary" onclick="App.printPumpAuthorization(${pr.id})">🖨️ Print Authorization</button>
            <button class="btn btn-secondary" onclick="App.emailPumpAuthorization(${pr.id},'${(pr.supplier_email||'').replace(/'/g,"\\'")}')">✉️ Email Authorization</button>` : ''}
          ${pr.status==='approved' ? `<button class="btn btn-teal" onclick="App.closeModal();App.showConvertPRtoPO(${pr.id})">Convert to PO</button>` : ''}
          ${['draft','submitted','approved','rejected'].includes(pr.status) && !pr.converted_to_po_id && this.can('pr_delete') ? `<button class="btn btn-outline" style="color:var(--danger,#dc2626);border-color:var(--danger,#dc2626)" title="Remove this request permanently" onclick="App.deletePR(${pr.id}, '${this.escapeAttr(pr.pr_number)}')">🗑 Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  _prDocTypeLabels: { supplier_quotation: 'Supplier Quotation', specification: 'Brief / Specification', other: 'Other' },

  _prAttachmentRow(prId, a, canRemove) {
    const icon = a.mime_type === 'application/pdf' ? '📄' : (a.mime_type || '').startsWith('image/') ? '🖼' : /word|document/.test(a.mime_type || '') ? '📝' : /excel|sheet/.test(a.mime_type || '') ? '📊' : '📎';
    const size = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`;
    return `<div id="pr-att-${a.id}" class="pr-att-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-secondary,#f8f9fa);border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
        <span style="font-size:18px">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this.escapeAttr(a.original_name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${this._prDocTypeLabels[a.document_type] || 'Other'} &bull; ${size(a.file_size || 0)} &bull; ${this.fmtDate(a.uploaded_at)}${a.uploaded_by_name ? ` &bull; ${this.escapeAttr(a.uploaded_by_name)}` : ''}</div>
        </div>
        <a href="/api/purchase-requests/${prId}/attachments/${a.id}/download" target="_blank" class="btn btn-sm btn-secondary" style="white-space:nowrap">Download</a>
        ${canRemove ? `<button class="btn btn-sm btn-danger" onclick="App.deletePRAttachment(${prId},${a.id})">✕</button>` : ''}
      </div>`;
  },

  _prDocTypeOptions(selected = 'supplier_quotation') {
    return Object.entries(this._prDocTypeLabels).map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
  },

  showPRAttachForm(prId) {
    this.showSecondaryModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">Attach Document</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group">
            <label>Document Type</label>
            <select id="pratt-doctype">${this._prDocTypeOptions()}</select>
          </div>
          <div class="form-group">
            <label>File <span style="font-size:11px;color:var(--text-muted)">(PDF, Word, Excel, image, text — max 20 MB each)</span></label>
            <input type="file" id="pratt-file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.txt" style="display:block;width:100%;padding:8px 0">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" id="pratt-upload-btn" onclick="App.uploadPRAttachments(${prId})">Upload</button>
        </div>
      </div>`);
  },

  // Uploads each file; returns the saved rows and throws on the first failure.
  async _uploadPRFiles(prId, files, documentType) {
    const saved = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('document_type', documentType);
      const res = await fetch(`/api/purchase-requests/${prId}/attachments`, { method: 'POST', body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`${file.name}: ${e.error || 'Upload failed'}`); }
      saved.push(await res.json());
    }
    return saved;
  },

  async uploadPRAttachments(prId) {
    const files = [...(document.getElementById('pratt-file').files || [])];
    if (!files.length) { this.alert('Please select a file', 'error'); return; }
    const btn = document.getElementById('pratt-upload-btn');
    btn.disabled = true; btn.textContent = 'Uploading...';
    const list = document.getElementById('pr-attachments-list');
    const canRemove = list && list.dataset.canRemove === '1';
    try {
      const saved = await this._uploadPRFiles(prId, files, document.getElementById('pratt-doctype').value);
      this.closeSecondaryModal();
      this.alert(saved.length > 1 ? `${saved.length} documents attached` : 'Document attached successfully');
      if (list) {
        document.getElementById('pr-att-empty')?.remove();
        saved.forEach(a => list.insertAdjacentHTML('afterbegin', this._prAttachmentRow(prId, a, canRemove)));
      }
    } catch(e) {
      btn.disabled = false; btn.textContent = 'Upload';
      this.alert(e.message, 'error');
    }
  },

  async deletePRAttachment(prId, attId) {
    if (!confirm('Remove this attachment permanently?')) return;
    try {
      await this.api('DELETE', `/purchase-requests/${prId}/attachments/${attId}`);
      document.getElementById(`pr-att-${attId}`)?.remove();
      const list = document.getElementById('pr-attachments-list');
      if (list && !list.querySelector('.pr-att-row')) {
        list.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:6px 0" id="pr-att-empty">No documents attached yet.</div>';
      }
    } catch(e) { this.alert(e.message, 'error'); }
  },

  printPumpAuthorization(id) {
    const win = window.open(`/api/email/pump-authorization-preview/${id}`, '_blank', 'width=820,height=700');
    win.addEventListener('load', () => win.print());
  },

  emailPumpAuthorization(id, supplierEmail) {
    this.showEmailModal('Email Authorization to Pump', supplierEmail, async (to, { as_pdf }) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-pump-authorization/${id}`, { to, as_pdf });
        this.alert(`Authorization sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    }, { pdfOption: true });
  },

  async deletePR(id, number) {
    if (!confirm(`Delete purchase request ${number}? This removes it and its attached documents permanently and can't be undone.`)) return;
    try {
      await this.api('DELETE', `/purchase-requests/${id}`);
      this.closeModal();
      this.alert(`${number} deleted`);
      this.renderPurchasing('requests');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async updatePRStatus(id, status) {
    try {
      await this.api('PATCH', `/purchase-requests/${id}/status`, { status });
      this.alert(`Request ${status}`);
      this.renderPurchasing('requests');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async approvePR(id) {
    const pr = await this.api('GET', `/purchase-requests/${id}`).catch(() => null);
    this._showApprovalDialog({
      title: `Approve Purchase Request${pr ? ` ${pr.pr_number}` : ''}`,
      intro: 'Your signature is recorded on the approved request.',
      context: pr ? (this._internalNotesHtml(pr.internal_notes) || '<p style="font-size:12px;color:var(--text-muted)">No internal notes on this request.</p>') : '',
      approve: async (signature) => {
        await this.api('PATCH', `/purchase-requests/${id}/status`, { status: 'approved', signature });
        this.closeModal();
        this.alert('Purchase request approved');
        this.renderPurchasing('requests');
      },
    });
  },

  async rejectPR(id) {
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Reject Purchase Request</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group">
            <label>Reason for rejection *</label>
            <textarea id="pr-reject-reason" rows="3" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;resize:vertical" placeholder="Explain why this request is being rejected..."></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App._confirmRejectPR(${id})">Reject Request</button>
        </div>
      </div>`);
  },

  async _confirmRejectPR(id) {
    const reason = document.getElementById('pr-reject-reason').value.trim();
    if (!reason) { this.alert('Please provide a reason for rejection', 'error'); return; }
    try {
      await this.api('PATCH', `/purchase-requests/${id}/status`, { status: 'rejected', rejection_reason: reason });
      this.closeModal();
      this.alert('Purchase request rejected');
      this.renderPurchasing('requests');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showConvertPRtoPO(id) {
    const [pr, suppliers] = await Promise.all([
      this.api('GET', `/purchase-requests/${id}`),
      this.api('GET', '/suppliers'),
    ]);
    const total = (pr.items||[]).reduce((s,i) => s+(i.total||0), 0);
    const hasInternal = (pr.items||[]).some(i => i.item_type === 'internal');
    const hasService = (pr.items||[]).some(i => i.item_type === 'service');
    const hasSale = (pr.items||[]).some(i => i.item_type !== 'internal');
    const supplierPriced = pr.request_type === 'supplier_priced';
    this.showModal(`
      <div class="modal" style="max-width:580px">
        <div class="modal-header"><span class="modal-title">Convert PR to Purchase Order</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:10px">
            Converting <strong>${pr.pr_number}</strong> will create a new Purchase Order with all items below.
          </p>
          ${this._internalNotesHtml(pr.internal_notes)}
          ${hasInternal ? `<div style="padding:8px 12px;background:#fff8e1;border-left:3px solid var(--warning);border-radius:0 6px 6px 0;font-size:13px;margin-bottom:12px">
            <strong>Note:</strong> Internal-use items will be included on the PO but <em>will not update product stock levels</em> when received.
          </div>` : ''}
          ${hasService ? `<div style="padding:8px 12px;background:var(--bg-secondary,#f8f9fa);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;font-size:13px;margin-bottom:12px">
            Service lines go on the PO with their details and never touch stock — receive them on the PO once the work is delivered.
          </div>` : ''}
          <div class="table-wrap" style="margin-bottom:14px">
            <table>
              <thead><tr><th>Item</th><th>Type</th><th>Qty</th><th>Est. Cost</th></tr></thead>
              <tbody>
                ${(pr.items||[]).map(i=>`<tr>
                  <td>${i.product_name}</td>
                  <td><span style="font-size:11px;color:${i.item_type==='sale'?'var(--accent)':'var(--text-muted)'}">${{ internal: 'Internal', service: 'Service' }[i.item_type] || 'Sale'}</span></td>
                  <td>${i.quantity}</td>
                  <td>${supplierPriced ? 'Per invoice' : this._fmtPR(i.unit_cost, pr)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          ${supplierPriced ? `<div style="padding:8px 12px;background:#fff8e1;border-left:3px solid var(--warning);border-radius:0 6px 6px 0;font-size:13px;margin-bottom:12px">
            The PO starts at the authorized maximum quantities with no cost. Enter the quantity and cost from the supplier's invoice and attach the invoice before sending it for approval.
          </div>` : `<div style="text-align:right;font-size:14px;font-weight:700;margin-bottom:14px">Est. Total: ${this._fmtPR(total, pr)}</div>`}
          <div class="form-group"><label>Supplier *</label>
            <select id="cpr-supplier" data-searchable>
              <option value="">-- Select Supplier --</option>
              ${suppliers.map(s=>`<option value="${s.id}" ${pr.supplier_id===s.id?'selected':''}>${s.name}</option>`).join('')}
            </select>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Expected Date</label><input id="cpr-date" type="date" value="${pr.required_date||''}"></div>
            <div class="form-group"><label>PO Notes</label><input id="cpr-notes" value="${pr.notes||''}"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmConvertPRtoPO(${pr.id})">Create Purchase Order</button>
        </div>
      </div>`);
  },

  async confirmConvertPRtoPO(prId) {
    const supplier_id = document.getElementById('cpr-supplier').value;
    if (!supplier_id) { this.alert('Please select a supplier', 'error'); return; }
    const expected_date = document.getElementById('cpr-date').value;
    const notes = document.getElementById('cpr-notes').value;
    try {
      const po = await this.api('POST', `/purchase-requests/${prId}/convert`, { supplier_id, expected_date: expected_date||null, notes: notes||null });
      this.closeModal();
      this.alert(`Purchase Order ${po.po_number} created`);
      this.showSection('purchasing');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // editId (optional): edits an existing draft PO instead of creating a new
  // one — reachable from its own "Edit PO" button, or after a rejection
  // sends it back to Draft for adjustments. Existing lines render as fixed
  // rows (qty/cost only, product locked) so an item's quotation_item_id/
  // work_order_item_id link — if it traces back to a "Q" line — survives the
  // edit untouched; "+ Add Item" still adds a fresh catalog-product line the
  // normal way.
  async showPOForm(editId) {
    const [suppliers, products, po] = await Promise.all([
      this.api('GET', '/suppliers'),
      this.api('GET', '/products'),
      editId ? this.api('GET', `/purchase-orders/${editId}`) : Promise.resolve(null),
    ]);
    const branches = this.currentUser.branches || [];
    this.showModal(`
      <div class="modal" style="max-width:960px">
        <div class="modal-header"><span class="modal-title">${editId ? `Edit Purchase Order: ${po.po_number}` : 'New Purchase Order'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>Supplier *</label>
              <select id="po-supplier" data-searchable onchange="App.onPOSupplierChange()">
                <option value="">-- Select Supplier --</option>
                ${suppliers.map(s => `<option value="${s.id}" ${po&&po.supplier_id===s.id?'selected':''}>${s.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Branch</label>
              <select id="po-branch">
                <option value="">-- All Branches --</option>
                ${branches.map(b => `<option value="${b.id}" ${po&&po.branch_id===b.id?'selected':''}>${b.name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Currency</label>
              <select id="po-currency" onchange="App._onPOCurrencyChange()">
                ${this._poCurrencyCodes(po && po.currency).map(c => `<option value="${c}" ${c === ((po && po.currency) || this._baseCurrency()) ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" id="po-rate-wrap"><label id="po-rate-label">Exchange Rate</label>
              <input id="po-rate" type="number" min="0" step="any" value="${po && po.exchange_rate ? po.exchange_rate : ''}" oninput="App.calcPOTotal()">
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Converts the PO for stock cost and the A/P bill. Defaults from Settings.</div>
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Expected Date</label><input id="po-date" type="date" value="${po&&po.expected_date?String(po.expected_date).slice(0,10):''}"></div>
            <div class="form-group"><label>Vendor Order/Quote #</label><input id="po-vendor-order" placeholder="e.g. Amazon order #" value="${this.escapeAttr(po&&po.vendor_order_number)}"></div>
          </div>
          <div class="form-group"><label>Notes <span style="font-weight:400;color:var(--text-muted);font-size:12px">(printed on the PO for the supplier)</span></label><input id="po-notes" value="${this.escapeAttr(po&&po.notes)}"></div>
          ${this._internalNotesInput('po-internal-notes', po && po.internal_notes)}
          <div style="margin-bottom:10px">
            <div class="card-header"><span class="card-title">Items</span>
              <div style="display:flex;gap:8px">
                <button class="btn btn-sm btn-outline" onclick="App.showPONewProductForm()">+ New Product</button>
                <button class="btn btn-sm btn-outline" onclick="App.addPOItem()">+ Add Item</button>
              </div>
            </div>
            <div id="po-items-status" style="font-size:12px;color:var(--text-muted);padding:4px 0 8px">Select a supplier above to see their products.</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--text-muted);margin-bottom:6px">
              <span>Each line: quantity · unit cost · vendor discount ($ off the line) · tax.</span>
              <span style="margin-left:auto">Set every line to:</span>
              <button type="button" class="btn btn-sm btn-outline" onclick="App._setAllPOTax('local')">${this._poTaxLabel('local')}</button>
              <button type="button" class="btn btn-sm btn-outline" onclick="App._setAllPOTax('none')">${this._poTaxLabel('none')}</button>
            </div>
            <div id="po-existing-items">${po ? po.items.map(i => this._poExistingItemRowHtml(i)).join('') : ''}</div>
            <div id="po-items"></div>
          </div>
          <div id="po-totals" style="text-align:right;font-size:13px;line-height:1.7"></div>
          <div style="text-align:right;font-size:15px;font-weight:700">Total: <span id="po-total">$0.00</span></div>
          <div id="po-total-base" style="text-align:right;font-size:12px;color:var(--text-muted)"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.savePO(${editId||'null'})">${editId ? 'Update PO' : 'Create PO'}</button>
        </div>
      </div>`);
    this._poAllProducts = products;
    this._poSuppliers = suppliers;
    this._poProducts = [];
    this._poItems = [];
    this._onPOCurrencyChange(true);
    if (po) {
      this.onPOSupplierChange();
      this.calcPOTotal();
    } else {
      this.addPOItem();
    }
    // Item lines are added dynamically (addPOItem), so this closes whichever
    // poi-prod-dd-* dropdown is currently open rather than binding to a
    // specific line's id — same pattern as the Quotation item picker.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.poi-prod-search-wrap')) {
        document.querySelectorAll('[id^="poi-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
    });
  },

  // Order currency — the store's base currency unless chosen otherwise; a
  // foreign one needs a rate (base per 1 unit, defaulted from Settings).
  _baseCurrency() { return String(this.settings?.currency || 'USD').toUpperCase(); },
  _poCurrencyCodes(current) {
    const codes = [this._baseCurrency(), ...this._altCurrencyList().map(a => String(a.code).toUpperCase()),
      'USD','EUR','GBP','CAD','AUD','JMD','TTD','BBD','GYD','BSD','HTG','MXN','CNY','JPY','INR','NGN','GHS','KES','ZAR'];
    if (current) codes.unshift(String(current).toUpperCase());
    return [...new Set(codes)];
  },
  _altCurrencyList() { return this.altCurrencies || []; },
  _settingsRate(code) {
    const a = this._altCurrencyList().find(x => String(x.code).toUpperCase() === code);
    return a ? (parseFloat(a.base_per_unit) || (a.rate > 0 ? 1 / a.rate : '')) : '';
  },
  _onPOCurrencyChange(initial) {
    const code = document.getElementById('po-currency')?.value;
    const foreign = code && code !== this._baseCurrency();
    const wrap = document.getElementById('po-rate-wrap');
    if (wrap) wrap.style.visibility = foreign ? 'visible' : 'hidden';
    const label = document.getElementById('po-rate-label');
    if (label) label.textContent = `Exchange Rate (${this._baseCurrency()} per 1 ${code})`;
    const rate = document.getElementById('po-rate');
    if (rate && foreign && (!initial || !rate.value)) rate.value = this._settingsRate(code);
    this.calcPOTotal();
  },
  _fmtPO(n, po) {
    const code = (po && po.currency) || this._baseCurrency();
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: po && po.currency ? 'code' : 'symbol' }).format(n || 0); }
    catch (e) { return `${code} ${this._n2(n)}`; }
  },
  // A PR/PO's internal notes — what it's for, for the approver. Never on
  // anything the supplier sees.
  _internalNotesHtml(text, style = 'margin-bottom:12px') {
    if (!text) return '';
    return `<div style="padding:8px 12px;background:#fffbeb;border-left:3px solid var(--warning,#d97706);border-radius:0 6px 6px 0;font-size:13px;${style}">
      <strong>🔒 Internal notes</strong> <span style="font-size:11px;color:var(--text-muted)">— not sent to the supplier</span>
      <div style="white-space:pre-wrap;margin-top:2px">${this.escapeAttr(text)}</div></div>`;
  },
  // One-line preview of internal notes under a list row's number.
  _internalNotesSnippet(text) {
    if (!text) return '';
    return `<div style="font-size:11px;font-weight:400;color:var(--text-muted);max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${this.escapeAttr(text)}">🔒 ${this.escapeAttr(text)}</div>`;
  },
  _internalNotesInput(id, value) {
    return `<div class="form-group"><label>Internal Notes <span style="font-weight:400;color:var(--text-muted);font-size:12px">— what this is for, for the approver; not sent to the supplier</span></label><textarea id="${id}" rows="2" placeholder="e.g. Restock for the Smith job / replacing the damaged cutter at Drax Hall">${this.escapeAttr(value || '')}</textarea></div>`;
  },
  // An amount on a purchase request, in the request's own currency.
  _fmtPR(n, pr) {
    const code = pr && pr.currency;
    return !code || code === this._baseCurrency() ? this.fmt(n) : this._fmtPO(n, { currency: code });
  },
  // A base-currency amount (A/P figures) on a foreign-currency PO: shown in
  // the PO's currency at its rate, with the base amount alongside.
  _fmtPOBase(n, po) {
    if (!po || !po.currency || !(Number(po.exchange_rate) > 0)) return this.fmt(n);
    return `${this._fmtPO((Number(n) || 0) / Number(po.exchange_rate), po)} <span style="font-weight:400;color:var(--text-muted)">(${this.fmt(n)})</span>`;
  },
  _poLinkInputHtml(cls, url) {
    return `<input type="url" class="${cls}" value="${this.escapeAttr(url || '')}" placeholder="🔗 Item link (online order)" style="flex-basis:100%;margin-top:4px;font-size:12px">`;
  },

  _poExistingItemRowHtml(item) {
    return `<div class="po-receive-row po-existing-item" style="flex-wrap:wrap" data-item-id="${item.id}" data-product-id="${item.product_id||''}">
      <span style="flex:2;font-size:13px">${item.product_name}${item.sku?` <span style="color:var(--text-muted)">(${item.sku})</span>`:''}${item.item_type === 'service' ? ' <span class="badge-pill badge-info" style="font-size:10px">Service</span>' : ''}</span>
      <input type="number" class="poi-existing-qty" min="0" step="any" value="${item.quantity_ordered}" style="width:70px" placeholder="Qty" oninput="App.calcPOTotal()" ${item.authorized_qty != null ? `data-max="${item.authorized_qty}"` : ''}>
      ${item.authorized_qty != null ? `<span class="poi-existing-max" style="font-size:11px;color:var(--text-muted);white-space:nowrap" title="Maximum authorized on the purchase request">max ${item.authorized_qty}</span>` : ''}
      <input type="number" class="poi-existing-cost" step="0.01" value="${item.authorized_qty != null && !(item.unit_cost > 0) ? '' : item.unit_cost}" style="width:90px" placeholder="${item.authorized_qty != null ? 'Invoice cost' : 'Unit Cost'}" oninput="App.calcPOTotal()">
      ${this._poLineExtrasHtml('poi-existing', item.vendor_discount_percent != null ? `${item.vendor_discount_percent}%` : item.vendor_discount, item.tax_option || 'none', false)}
      <button class="btn btn-sm btn-danger" onclick="this.closest('.po-existing-item').remove();App.calcPOTotal()">✕</button>
      ${this._poLinkInputHtml('poi-existing-url', item.product_url)}
    </div>`;
  },

  // Purchase order line tax: the store's own sales tax (GCT, Settings → tax
  // rate) for a local vendor, or none for an overseas one. Mirrors
  // lib/poLines.js — discount comes off the line first, tax on the rest.
  _poTaxRate() { return parseFloat(this.settings?.tax_rate) || 0; },
  _poTaxLabel(option) { return option === 'local' ? `GCT ${this._poTaxRate()}% (local)` : 'No tax (overseas)'; },
  _poSupplierTaxDefault() {
    const sup = (this._poSuppliers || []).find(s => String(s.id) === String(document.getElementById('po-supplier')?.value));
    return sup && sup.is_local ? 'local' : 'none';
  },
  // Vendor discount + tax select + line total, shared by new and existing
  // rows. `auto` marks a tax choice that still follows the supplier's
  // default (flips if the supplier changes) until someone picks one.
  _poLineExtrasHtml(cls, discount, taxOption, auto) {
    const shown = typeof discount === 'string' ? discount : (discount > 0 ? discount : '');
    return `<input type="text" inputmode="decimal" class="${cls}-disc" value="${this.escapeAttr(shown)}" style="width:95px" placeholder="Disc. $ or %" title="Vendor discount before tax — dollars off this line (e.g. 50) or a percentage (e.g. 10%)" oninput="App.calcPOTotal()">
      <select class="${cls}-tax" data-auto="${auto ? 1 : 0}" style="width:150px" title="Tax on this line" onchange="this.dataset.auto='0';App.calcPOTotal()">
        ${['local', 'none'].map(o => `<option value="${o}" ${taxOption === o ? 'selected' : ''}>${this._poTaxLabel(o)}</option>`).join('')}
      </select>
      <span class="${cls}-line" style="width:90px;text-align:right;font-size:12px;font-weight:600"></span>`;
  },
  // "50" -> $50 off the line, "10%" -> 10% of it; blank -> none.
  _parsePODiscount(raw) {
    const str = String(raw || '').trim().replace(/[$,\s]/g, '');
    if (!str) return { vendor_discount: 0, vendor_discount_percent: null };
    const pct = str.match(/^(\d*\.?\d+)%$/);
    if (pct) return { vendor_discount: 0, vendor_discount_percent: parseFloat(pct[1]) };
    if (/^\d*\.?\d+$/.test(str)) return { vendor_discount: parseFloat(str), vendor_discount_percent: null };
    return { error: true };
  },
  _setAllPOTax(option) {
    document.querySelectorAll('.poi-existing-tax, .poi-new-tax').forEach(sel => { sel.value = option; sel.dataset.auto = '0'; });
    this.calcPOTotal();
  },

  onPOSupplierChange() {
    const supplierId = document.getElementById('po-supplier').value;
    const taxDefault = this._poSupplierTaxDefault();
    document.querySelectorAll('.poi-new-tax[data-auto="1"]').forEach(sel => { sel.value = taxDefault; });
    this._poProducts = supplierId
      ? (this._poAllProducts || []).filter(p => String(p.supplier_id) === String(supplierId))
      : [];
    const statusEl = document.getElementById('po-items-status');
    if (statusEl) {
      if (!supplierId) statusEl.textContent = 'Select a supplier above to see their products.';
      else if (this._poProducts.length === 0) statusEl.textContent = 'No products assigned to this supplier yet. Use "+ New Product" to add one.';
      else statusEl.textContent = `${this._poProducts.length} product(s) available from this supplier.`;
    }
    // Iterate line wrappers rather than a "[id^='poi-prod-']" attribute
    // selector — that prefix also matches this same line's poi-prod-dd-*/
    // poi-prod-search-* elements, not just the hidden product-id field.
    document.querySelectorAll('#po-items [id^="po-item-"]').forEach(line => {
      const idx = line.id.replace('po-item-','');
      const hidden = document.getElementById(`poi-prod-${idx}`);
      const searchEl = document.getElementById(`poi-prod-search-${idx}`);
      if (!hidden) return;
      const currentVal = hidden.value;
      const match = currentVal ? this._poProducts.find(p => String(p.id) === String(currentVal)) : null;
      if (match) {
        hidden.dataset.cost = match.cost||0; hidden.dataset.name = match.name; hidden.dataset.sku = match.sku||'';
        if (searchEl) searchEl.value = `${match.name} (${match.sku||''})`;
      } else if (currentVal) {
        // Selected product isn't offered by the new supplier — clear it
        // rather than silently keeping a stale selection.
        hidden.value = ''; hidden.dataset.cost = ''; hidden.dataset.name = ''; hidden.dataset.sku = '';
        if (searchEl) searchEl.value = '';
      }
    });
  },

  addPOItem(preselectedId) {
    this._poItems = this._poItems || [];
    const idx = this._poItems.length;
    this._poItems.push({});
    const container = document.getElementById('po-items');
    const preselectedProduct = preselectedId ? (this._poProducts||[]).find(p => String(p.id) === String(preselectedId)) : null;
    const prefillLabel = preselectedProduct ? `${preselectedProduct.name} (${preselectedProduct.sku||''})` : '';
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.style.flexWrap = 'wrap';
    div.id = `po-item-${idx}`;
    div.innerHTML = `
      <span class="poi-prod-search-wrap" style="flex:2;position:relative">
        <input type="text" id="poi-prod-search-${idx}" placeholder="Search products…" autocomplete="off" style="width:100%"
          value="${this.escapeAttr(prefillLabel)}"
          oninput="App._filterPOProdOptions(${idx},this.value)" onfocus="App._filterPOProdOptions(${idx},this.value)">
        <input type="hidden" id="poi-prod-${idx}" value="${preselectedProduct?preselectedProduct.id:''}" data-cost="${preselectedProduct?(preselectedProduct.cost||0):''}" data-name="${preselectedProduct?preselectedProduct.name:''}" data-sku="${preselectedProduct?(preselectedProduct.sku||''):''}">
        <div id="poi-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
      </span>
      <select id="poi-unit-${idx}" style="width:120px;display:none" onchange="App._onPOUnitChange(${idx})" title="Unit of measure to order in"></select>
      <input id="poi-qty-${idx}" type="number" min="0" step="any" value="1" style="width:70px" placeholder="Qty" oninput="App.calcPOTotal()">
      <input id="poi-cost-${idx}" type="number" step="0.01" value="${preselectedProduct?(preselectedProduct.cost||''):''}" style="width:90px" placeholder="Unit Cost" oninput="App.calcPOTotal()">
      ${this._poLineExtrasHtml('poi-new', 0, this._poSupplierTaxDefault(), true)}
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('po-item-${idx}').remove();App.calcPOTotal()">✕</button>
      ${this._poLinkInputHtml('poi-new-url', '')}`;
    container.appendChild(div);
    if (preselectedProduct) this._setPOLineUnits(idx, preselectedProduct, null);
    this.calcPOTotal();
  },

  // Fills a PO line's unit dropdown (lib/units.js) — shown for an item with
  // alternate units, or when the user can add one — and selects `choice`
  // (null = the stock unit).
  _setPOLineUnits(idx, p, choice) {
    const unitSel = document.getElementById(`poi-unit-${idx}`);
    if (!unitSel) return;
    unitSel.innerHTML = this._orderUnitOptionsHtml(p, choice);
    unitSel.style.display = unitSel.options.length > 1 ? '' : 'none';
    unitSel.dataset.prev = unitSel.value;
  },

  // Searchable replacement for what used to be a plain <select> scoped to
  // the chosen supplier's products — same pattern as the Quotation item
  // picker. savePO/onPOSupplierChange read poi-prod-${idx}'s value directly
  // (a hidden input here, same id/semantics as the old select).
  _filterPOProdOptions(idx, query) {
    const dd = document.getElementById(`poi-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const products = this._poProducts || [];
    const matches = products.filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectPOProdOption(${idx},${p.id})">
        <strong>${p.name}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${this.fmt(p.cost||0)}${p.sku ? ' · ' + p.sku : ''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">${products.length ? 'No products found' : (document.getElementById('po-supplier')?.value ? 'No products assigned to this supplier yet' : 'Select a supplier first')}</div>`;
    dd.style.display = '';
  },

  async _selectPOProdOption(idx, productId) {
    const p = (this._poProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`poi-prod-${idx}`);
    const searchEl = document.getElementById(`poi-prod-search-${idx}`);
    const dd = document.getElementById(`poi-prod-dd-${idx}`);
    if (hidden) { hidden.value = productId; hidden.dataset.cost = p.cost||0; hidden.dataset.name = p.name; hidden.dataset.sku = p.sku||''; }
    if (searchEl) searchEl.value = `${p.name} (${p.sku||''})`;
    if (dd) dd.style.display = 'none';
    // An item with alternate units asks which one to order in (lib/units.js).
    const choice = (await this._pickUnit(p, 'buy')) || this._unitChoices(p, 'buy')[0];
    this._setPOLineUnits(idx, p, choice);
    this._onPOUnitChange(idx);
  },

  // A PO line's unit sets its default cost — the unit's size × the stock
  // unit's cost; quantity and cost are then per that unit.
  async _onPOUnitChange(idx) {
    const hidden = document.getElementById(`poi-prod-${idx}`);
    const p = (this._poProducts || []).find(x => String(x.id) === hidden?.value);
    const unitSel = document.getElementById(`poi-unit-${idx}`);
    if (unitSel?.value === '__add') {
      const added = p ? await this._addOrderUnit(p) : null;
      if (!added) { unitSel.value = unitSel.dataset.prev || ''; return; }
      this._setPOLineUnits(idx, p, added);
    }
    if (unitSel) unitSel.dataset.prev = unitSel.value;
    const val = unitSel?.value;
    const choice = p ? this._unitChoiceFor(p, val ? Number(val) : (p.base_unit_id || null), 'buy') : null;
    if (p) document.getElementById(`poi-cost-${idx}`).value = ((p.cost || 0) * (choice?.factor || 1)).toFixed(2);
    this.calcPOTotal();
  },

  async showPONewProductForm() {
    const supplierId = document.getElementById('po-supplier').value;
    if (!supplierId) { this.alert('Please select a supplier first', 'error'); return; }
    const categories = await this.api('GET', '/categories');
    this.showSecondaryModal(`
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Add New Product</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>SKU *</label><input id="npf-sku" placeholder="PROD-001"></div>
            <div class="form-group"><label>Barcode</label><input id="npf-barcode" placeholder="0001234567890"></div>
          </div>
          <div class="form-group"><label>Name *</label><input id="npf-name"></div>
          <div class="form-group"><label>Category</label>
            <select id="npf-cat">
              <option value="">— None —</option>
              ${categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
            </select>
          </div>
          <div class="input-row-3">
            <div class="form-group"><label>Price</label><input type="number" id="npf-price" value="0" min="0" step="0.01"></div>
            <div class="form-group"><label>Cost</label><input type="number" id="npf-cost" value="0" min="0" step="0.01"></div>
            <div class="form-group"><label>Tax Rate %</label><input type="number" id="npf-tax" value="${this.settings?.tax_rate ?? 8.5}" min="0" step="0.1"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Stock Qty</label><input type="number" id="npf-stock" value="0" min="0"></div>
            <div class="form-group"><label>Min Stock</label><input type="number" id="npf-minstock" value="5" min="0"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.savePONewProduct()">Create & Add to PO</button>
        </div>
      </div>`);
  },

  async savePONewProduct() {
    const supplierId = document.getElementById('po-supplier').value;
    const data = {
      sku: document.getElementById('npf-sku').value.trim(),
      barcode: document.getElementById('npf-barcode').value.trim() || null,
      name: document.getElementById('npf-name').value.trim(),
      category_id: document.getElementById('npf-cat').value || null,
      price: parseFloat(document.getElementById('npf-price').value) || 0,
      cost: parseFloat(document.getElementById('npf-cost').value) || 0,
      tax_rate: parseFloat(document.getElementById('npf-tax').value) || 8.5,
      stock_qty: parseInt(document.getElementById('npf-stock').value) || 0,
      min_stock: parseInt(document.getElementById('npf-minstock').value) || 5,
      supplier_id: supplierId || null,
    };
    if (!data.sku) { this.alert('SKU is required', 'error'); return; }
    if (!data.name) { this.alert('Name is required', 'error'); return; }
    try {
      const newProduct = await this.api('POST', '/products', data);
      this._poAllProducts.push(newProduct);
      this._poProducts.push(newProduct);
      this.closeSecondaryModal();
      this.alert(`Product "${newProduct.name}" created`);
      const statusEl = document.getElementById('po-items-status');
      if (statusEl) statusEl.textContent = `${this._poProducts.length} product(s) available from this supplier.`;
      this.addPOItem(newProduct.id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  calcPOTotal() {
    const rate = this._poTaxRate();
    const curPO = { currency: document.getElementById('po-currency')?.value || null };
    const fmtc = n => this._fmtPO(n, curPO);
    let gross = 0, discounts = 0, subtotal = 0, tax = 0;
    const price = (row, qty, cost, cls) => {
      const lineGross = qty * cost;
      const parsed = this._parsePODiscount(row.querySelector(`.${cls}-disc`)?.value);
      const disc = parsed.error ? 0 : (parsed.vendor_discount_percent != null ? Math.round(lineGross * parsed.vendor_discount_percent) / 100 : parsed.vendor_discount);
      const bad = parsed.error || disc > lineGross || parsed.vendor_discount_percent > 100;
      const net = lineGross - disc;
      const lineTax = row.querySelector(`.${cls}-tax`)?.value === 'local' ? net * rate / 100 : 0;
      const out = row.querySelector(`.${cls}-line`);
      if (out) {
        out.textContent = fmtc(net);
        out.style.color = bad ? 'var(--danger)' : '';
        out.title = bad ? 'Enter the discount as dollars (50) or a percentage (10%), no more than the line cost' : `${parsed.vendor_discount_percent ? `${parsed.vendor_discount_percent}% = −${fmtc(disc)} · ` : ''}${lineTax ? `+ ${fmtc(lineTax)} GCT` : ''}`;
      }
      gross += lineGross; discounts += disc; subtotal += net; tax += lineTax;
    };
    document.querySelectorAll('#po-items [id^="po-item-"]').forEach(row => {
      const idx = row.id.replace('po-item-', '');
      price(row, parseFloat(document.getElementById(`poi-qty-${idx}`)?.value) || 0, parseFloat(document.getElementById(`poi-cost-${idx}`)?.value) || 0, 'poi-new');
    });
    document.querySelectorAll('.po-existing-item').forEach(row => {
      const qtyEl = row.querySelector('.poi-existing-qty');
      price(row, parseFloat(qtyEl?.value) || 0, parseFloat(row.querySelector('.poi-existing-cost')?.value) || 0, 'poi-existing');
      // Fuel/supplier-priced line: warn (don't block) past the authorized maximum
      const maxEl = row.querySelector('.poi-existing-max');
      if (maxEl) {
        const over = (parseFloat(qtyEl.value) || 0) > parseFloat(qtyEl.dataset.max);
        maxEl.style.color = over ? 'var(--danger)' : 'var(--text-muted)';
        maxEl.textContent = `${over ? '⚠️ over ' : ''}max ${qtyEl.dataset.max}`;
      }
    });
    const r2 = n => Math.round(n * 100) / 100;
    const totalsEl = document.getElementById('po-totals');
    if (totalsEl) totalsEl.innerHTML = `
      ${discounts ? `<div>Items: ${fmtc(r2(gross))}</div><div>Vendor discounts: −${fmtc(r2(discounts))}</div>` : ''}
      <div>Subtotal: ${fmtc(r2(subtotal))}</div>
      <div>GCT: ${fmtc(r2(tax))}</div>`;
    const el = document.getElementById('po-total');
    if (el) el.textContent = fmtc(r2(subtotal) + r2(tax));
    const baseEl = document.getElementById('po-total-base');
    if (baseEl) {
      const fx = parseFloat(document.getElementById('po-rate')?.value);
      const foreign = curPO.currency && curPO.currency !== this._baseCurrency();
      baseEl.textContent = !foreign ? '' : fx > 0 ? `≈ ${this.fmt((r2(subtotal) + r2(tax)) * fx)} at ${fx}` : 'Enter the exchange rate';
    }
  },

  async savePO(editId) {
    const supplier_id = document.getElementById('po-supplier').value;
    const branch_id = document.getElementById('po-branch').value;
    const expected_date = document.getElementById('po-date').value;
    const notes = document.getElementById('po-notes').value;
    const internal_notes = document.getElementById('po-internal-notes').value.trim() || null;
    const vendor_order_number = document.getElementById('po-vendor-order').value.trim() || null;
    const items = [];
    let discountError = false;
    document.querySelectorAll('.po-existing-item').forEach(row => {
      const qty = Number(row.querySelector('.poi-existing-qty').value) || 1;
      const unit_cost = parseFloat(row.querySelector('.poi-existing-cost').value) || 0;
      const disc = this._parsePODiscount(row.querySelector('.poi-existing-disc').value);
      if (disc.error) discountError = true;
      const tax_option = row.querySelector('.poi-existing-tax').value;
      items.push({ id: row.dataset.itemId, product_id: row.dataset.productId || null, quantity_ordered: qty, unit_cost, vendor_discount: disc.vendor_discount, vendor_discount_percent: disc.vendor_discount_percent, tax_option, product_url: row.querySelector('.poi-existing-url')?.value.trim() || null });
    });
    document.querySelectorAll('#po-items [id^="po-item-"]').forEach(line => {
      const idx = line.id.replace('po-item-','');
      const product_id = document.getElementById(`poi-prod-${idx}`)?.value;
      if (!product_id) return;
      const qty = Number(document.getElementById(`poi-qty-${idx}`).value) || 1;
      const unit_cost = parseFloat(document.getElementById(`poi-cost-${idx}`).value) || 0;
      const disc = this._parsePODiscount(line.querySelector('.poi-new-disc').value);
      if (disc.error) discountError = true;
      const tax_option = line.querySelector('.poi-new-tax').value;
      const uom_id = Number(document.getElementById(`poi-unit-${idx}`)?.value) || null;
      items.push({ product_id, quantity_ordered: qty, unit_cost, vendor_discount: disc.vendor_discount, vendor_discount_percent: disc.vendor_discount_percent, tax_option, uom_id, product_url: line.querySelector('.poi-new-url')?.value.trim() || null });
    });
    if (!supplier_id) { this.alert('Please select a supplier', 'error'); return; }
    if (!items.length) { this.alert('Add at least one item', 'error'); return; }
    if (discountError) { this.alert('Enter each vendor discount as dollars (e.g. 50) or a percentage (e.g. 10%)', 'error'); return; }
    const currency = document.getElementById('po-currency').value;
    const exchange_rate = currency !== this._baseCurrency() ? (parseFloat(document.getElementById('po-rate').value) || null) : null;
    try {
      if (editId) {
        await this.api('PUT', `/purchase-orders/${editId}`, { supplier_id, branch_id: branch_id||null, notes, internal_notes, expected_date: expected_date||null, vendor_order_number, items, currency, exchange_rate });
        this.closeModal();
        this.alert('Purchase order updated');
      } else {
        await this.api('POST', '/purchase-orders', { supplier_id, branch_id: branch_id||null, notes, internal_notes, expected_date: expected_date||null, vendor_order_number, items, currency, exchange_rate });
        this.closeModal();
        this.alert('Purchase order created');
      }
      this.renderPurchasing();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async viewPO(id) {
    const [po, attachments, billing, payReqs] = await Promise.all([
      this.api('GET', `/purchase-orders/${id}`),
      this.api('GET', `/purchase-orders/${id}/attachments`),
      this.can('payables') ? this.api('GET', `/payables/po/${id}`).catch(() => null) : null,
      this.api('GET', `/payables/payment-requests/for-po/${id}`).catch(() => null),
    ]);
    const canReqPay = this.can('purchasing_request_payment') || this.can('payables_requests');
    const canOpenPrq = this.can('payables') || this.can('payables_approve');
    const statusColor = { draft:'badge-warning', sent:'badge-info', approved:'badge-teal', partial:'badge-purple', received:'badge-success', cancelled:'badge-danger' };
    const docTypeLabel = this._poDocTypeLabels;
    const fileIcon = mime => {
      if (mime === 'application/pdf') return '📄';
      if (mime && mime.startsWith('image/')) return '🖼';
      if (mime && (mime.includes('word') || mime.includes('document'))) return '📝';
      if (mime && (mime.includes('excel') || mime.includes('sheet'))) return '📊';
      return '📎';
    };
    const fmtBytes = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`;
    const freightStatusColor = { pending:'badge-warning', received_by_forwarder:'badge-info', forwarded:'badge-teal' };
    const freightStatusLabel = { pending:'Pending', received_by_forwarder:'Received by Forwarder', forwarded:'Forwarded to Us' };
    const itemLinkBadges = i => {
      const badges = [];
      if (i.quotation_id) badges.push(`<a href="#" style="font-size:10px;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewQuote(${i.quotation_id})">Quote ${i.quote_number}</a>`);
      if (i.work_order_id) badges.push(`<a href="#" style="font-size:10px;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewWorkOrder(${i.work_order_id})">WO ${i.wo_number}</a>`);
      return badges.length ? `<br>${badges.join(' &bull; ')}` : '';
    };
    // Fuel / supplier-priced PO: invoiced cost on every line + the supplier's
    // invoice attached are required (server enforces); over the authorized
    // maximum quantity is only a warning.
    const sp = po.supplier_priced ? this._poSupplierPricedCheck(po, attachments) : null;
    this.showModal(`
      <div class="modal" style="max-width:920px">
        <div class="modal-header">
          <span class="modal-title">PO: ${po.po_number}</span>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="badge-pill ${statusColor[po.status]||''}">${po.status}</span>
            <button class="modal-close">✕</button>
          </div>
        </div>
        <div class="modal-body">
          ${po.reinstated_from_status ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:13px;color:#92400e">
            <strong>Received before approval — sent back for approval${po.reinstated_by_name ? ` by ${po.reinstated_by_name}` : ''} on ${this.fmtDateTime(po.reinstated_at)}:</strong> ${po.reinstate_reason}<br>
            The goods are already in; stock and receipts are unchanged. Approving (or rejecting) returns it to <strong>${po.reinstated_from_status === 'partial' ? 'Partially received' : 'Received'}</strong>.
          </div>` : ''}
          ${(po.status==='draft' || (['received','partial'].includes(po.status) && !po.approved_at)) && po.rejection_reason ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:13px;color:#991b1b">
            <strong>Rejected${po.rejected_by_name ? ` by ${po.rejected_by_name}` : ''}${po.rejected_at ? ` on ${this.fmtDateTime(po.rejected_at)}` : ''}:</strong> ${po.rejection_reason}
          </div>` : ''}
          <div class="two-col" style="margin-bottom:14px;font-size:13px">
            <div><strong>Supplier:</strong> ${po.supplier_name||'-'}<br><strong>Contact:</strong> ${po.supplier_contact||'-'}<br><strong>Email:</strong> ${po.supplier_email||'-'}</div>
            <div><strong>Branch:</strong> ${po.branch_name||'-'}<br><strong>Created:</strong> ${this.fmtDate(po.created_at)}<br><strong>Expected:</strong> ${po.expected_date ? this.fmtDate(po.expected_date) : '-'}<br><strong>Vendor Order/Quote #:</strong> ${po.vendor_order_number || '-'}${po.currency ? `<br><strong>Currency:</strong> ${po.currency} @ ${po.exchange_rate ? `${po.exchange_rate} ${this._baseCurrency()}` : '<span style="color:var(--danger)">no exchange rate — edit the PO to add it</span>'}` : ''}</div>
          </div>
          ${this._internalNotesHtml(po.internal_notes)}
          ${po.notes ? `<div style="padding:8px 12px;background:var(--bg-secondary,#f8f9fa);border-radius:6px;font-size:13px;margin-bottom:12px"><strong>Notes</strong> <span style="font-size:11px;color:var(--text-muted)">(printed for the supplier)</span><div style="white-space:pre-wrap">${this.escapeAttr(po.notes)}</div></div>` : ''}
          ${sp ? `<div id="po-sp-check" style="border:1px solid ${sp.ready ? '#bbf7d0' : '#fde68a'};background:${sp.ready ? '#f0fdf4' : '#fffbeb'};border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:13px">
            <strong>Fuel / supplier-priced PO</strong> — authorized on ${po.source_pr_number || 'the purchase request'}. Before it can be sent for approval:
            <div style="margin-top:6px">${sp.costed ? '✅' : '⬜'} Invoiced cost entered on every line</div>
            <div>${sp.invoice ? '✅' : '⬜'} Supplier's invoice attached (document type <em>Supplier Invoice</em>)</div>
            ${sp.over.length ? `<div style="margin-top:6px;color:var(--danger)">⚠️ More than the authorized maximum: ${sp.over.map(i => `${this.escapeAttr(i.product_name)} — ${i.quantity_ordered} of max ${i.authorized_qty}`).join('; ')}</div>` : ''}
          </div>` : ''}
          ${po.source_pr_id ? `<div style="font-size:12px;color:var(--text-muted);margin:-6px 0 12px">Converted from <a href="#" style="color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewPR(${po.source_pr_id})">${po.source_pr_number}</a>${po.source_pr_attachments > 0 ? ` · 📎 ${po.source_pr_attachments} document${po.source_pr_attachments > 1 ? 's' : ''} on the request` : ''}</div>` : ''}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Product</th><th>SKU</th><th>Ordered</th><th>Unit</th><th>Received</th><th>Damaged</th><th>Unit Cost</th><th>Vendor Disc.</th><th>Tax</th><th>Total</th></tr></thead>
              <tbody>
                ${po.items.map(i => `<tr>
                  <td>${this._orderLineUnit(i).name}${i.item_type === 'service' ? ' <span class="badge-pill badge-info" style="font-size:10px">Service</span>' : ''}${i.discount_amount > 0 ? ` <span class="badge-pill badge-purple" style="font-size:10px" title="Discount given on the originating quote line">-${this._fmtPO(i.discount_amount, po)} quoted</span>` : ''}${i.notes ? `<div style="font-size:11px;color:var(--text-muted);max-width:280px">${this.escapeAttr(i.notes)}</div>` : ''}${i.product_url ? `<div style="font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="${this.escapeAttr(i.product_url)}" target="_blank" rel="noopener" style="color:var(--primary)">🔗 ${this.escapeAttr(i.product_url)}</a></div>` : ''}${itemLinkBadges(i)}${(!i.product_id && i.item_type !== 'service' && i.quantity_received>0) ? `<br><button class="btn btn-sm btn-outline" style="margin-top:4px" onclick="App.showLinkToInventory(${po.id},${i.id})">+ Add to Inventory</button>` : ''}</td>
                  <td>${i.sku||'-'}</td>
                  <td>${i.quantity_ordered}${i.authorized_qty != null ? `<div style="font-size:11px;color:${i.quantity_ordered > i.authorized_qty ? 'var(--danger)' : 'var(--text-muted)'}">${i.quantity_ordered > i.authorized_qty ? '⚠️ ' : ''}max ${i.authorized_qty}</div>` : ''}</td>
                  <td>${this.escapeAttr(this._orderLineUnit(i).unit)}</td>
                  <td><span class="${i.quantity_received>=i.quantity_ordered?'color-success':'color-warning'}">${i.quantity_received||0}</span></td>
                  <td>${i.quantity_damaged>0 ? `<span class="color-danger">${i.quantity_damaged}</span>` : '-'}</td>
                  <td>${this._fmtPO(i.unit_cost, po)}</td>
                  <td>${i.vendor_discount > 0 ? `−${this._fmtPO(i.vendor_discount, po)}${i.vendor_discount_percent != null ? `<div style="font-size:11px;color:var(--text-muted)">${i.vendor_discount_percent}%</div>` : ''}` : '-'}</td>
                  <td>${i.tax_option === 'local' ? `GCT ${i.tax_rate}%<div style="font-size:11px;color:var(--text-muted)">${this._fmtPO(i.tax_amount, po)}</div>` : '<span style="color:var(--text-muted)">No tax</span>'}</td>
                  <td class="fw-600">${this._fmtPO(i.total, po)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div style="text-align:right;margin-top:10px;font-size:13px;line-height:1.7">
            ${po.items.some(i => i.vendor_discount > 0) ? `<div>Vendor discounts: −${this._fmtPO(po.items.reduce((sum, i) => sum + (i.vendor_discount || 0), 0), po)}</div>` : ''}
            <div>Subtotal: ${this._fmtPO(po.subtotal, po)}</div>
            <div>GCT: ${this._fmtPO(po.tax_amount, po)}</div>
          </div>
          <div style="text-align:right;font-size:15px;font-weight:700">Total: ${this._fmtPO(po.total, po)}</div>
          ${po.currency && po.exchange_rate ? `<div style="text-align:right;font-size:12px;color:var(--text-muted)">≈ ${this.fmt(po.total * po.exchange_rate)} at ${po.exchange_rate}</div>` : ''}
          ${billing ? `<div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-weight:700;font-size:14px">Accounts Payable</span>
              ${billing.unbilled > 0 && this.can('payables_bills') ? `<button class="btn btn-sm btn-outline" onclick="App.showBillForm(null, { po_id: ${po.id} })">+ Create Bill (${this.fmt(billing.unbilled)})</button>` : ''}
            </div>
            <div style="font-size:13px;margin-bottom:8px">Received: <strong>${this._fmtPOBase(billing.received_value, po)}</strong> &nbsp;·&nbsp; Billed: <strong>${this._fmtPOBase(billing.billed, po)}</strong> &nbsp;·&nbsp; Not yet billed: <strong style="${billing.unbilled > 0 ? 'color:var(--warning,#d97706)' : ''}">${this._fmtPOBase(billing.unbilled, po)}</strong></div>
            ${po.currency ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Bills are recorded in ${this._baseCurrency()}${po.exchange_rate ? ` — converted at ${po.exchange_rate} ${this._baseCurrency()} per ${po.currency}` : ''}.</div>` : ''}
            ${billing.bills.map(b => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:13px;cursor:pointer" onclick="App.viewBill(${b.id})">
              <span><strong>${b.bill_number}</strong>${b.vendor_invoice_number ? ` · Inv ${this.escapeAttr(b.vendor_invoice_number)}` : ''} · due ${this._apDate(b.due_date)}</span>
              <span>${this.fmt(b.amount)} <span class="badge-pill ${this._apStatusBadge[b.display_status] || ''}" style="margin-left:6px">${b.display_status}</span></span>
            </div>`).join('')}
          </div>` : ''}
          ${payReqs && (payReqs.requests.length || (['approved','partial'].includes(po.status) && canReqPay)) ? `<div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span style="font-weight:700;font-size:14px">Payment Requests</span>
            </div>
            ${payReqs.room ? `<div style="font-size:13px;margin-bottom:8px">Paid so far: <strong>${this.fmt(payReqs.room.paid)}</strong>${payReqs.room.requested > 0 ? ` &nbsp;·&nbsp; Requested, not yet paid: <strong>${this.fmt(payReqs.room.requested)}</strong>` : ''} &nbsp;·&nbsp; Left to request: <strong>${this.fmt(payReqs.room.available)}</strong></div>` : ''}
            ${payReqs.requests.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:13px;${canOpenPrq ? 'cursor:pointer' : ''};${r.status === 'cancelled' ? 'opacity:.6' : ''}" ${canOpenPrq ? `onclick="App.viewPaymentRequest(${r.id})"` : ''}>
              <span><strong>${r.request_number}</strong> · ${this.escapeAttr(r.summary || this._prqTypeLabel[r.request_type])}${r.required_date && !['paid','cancelled'].includes(r.status) ? ` · ${this._prqPayByHtml(r.required_date, { label: 'Requested for ' })}` : ''}${r.scheduled_date && !['paid','cancelled'].includes(r.status) ? ` · ${this._prqPayByHtml(r.scheduled_date, { label: 'Scheduled for ' })}` : ''}${r.requested_by_name ? `<span style="color:var(--text-muted)"> · ${this.escapeAttr(r.requested_by_name)}</span>` : ''}</span>
              <span style="white-space:nowrap">${this.fmt(r.amount)} <span class="badge-pill ${this._prqStatusBadge[r.status] || ''}" style="margin-left:6px">${this._prqStatusLabel[r.status] || r.status}</span></span>
            </div>`).join('') || '<div style="font-size:13px;color:var(--text-muted)">No payment requested yet. If the supplier needs a deposit or advance before supplying, use <strong>💵 Request Payment</strong> below — Accounts Payable is notified.</div>'}
          </div>` : ''}
          ${po.status==='approved' ? `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px;font-size:13px">
            <strong>Approved by:</strong> ${po.approved_by_name||'-'} on ${this.fmtDateTime(po.approved_at)}
            ${this._approvalSigImg(po.approval_signature)}
          </div>` : ''}

          <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-weight:700;font-size:14px">Freight Forwarding</span>
              <button class="btn btn-sm btn-outline" onclick="App.showFreightForm(${po.id})">Edit</button>
            </div>
            <div style="font-size:13px;display:flex;flex-direction:column;gap:4px;margin-bottom:10px">
              <div><strong>Status:</strong> <span class="badge-pill ${freightStatusColor[po.freight_status]||'badge-warning'}">${freightStatusLabel[po.freight_status]||po.freight_status}</span></div>
              ${po.freight_forwarder_received_at ? `<div><strong>Received by Forwarder:</strong> ${this.fmtDate(po.freight_forwarder_received_at)}</div>` : ''}
              ${po.freight_forwarded_at ? `<div><strong>Forwarded to Us:</strong> ${this.fmtDate(po.freight_forwarded_at)}</div>` : ''}
              ${po.freight_tracking_number ? `<div><strong>Tracking #:</strong> ${po.freight_tracking_number}</div>` : ''}
              ${po.freight_notes ? `<div><strong>Notes:</strong> ${po.freight_notes}</div>` : ''}
            </div>
            <div style="display:flex;gap:8px">
              ${po.freight_status==='pending' ? `<button class="btn btn-sm btn-secondary" onclick="App.updateFreightStatus(${po.id},'received_by_forwarder')">Mark Received by Forwarder</button>` : ''}
              ${po.freight_status==='received_by_forwarder' ? `<button class="btn btn-sm btn-primary" onclick="App.updateFreightStatus(${po.id},'forwarded')">Mark Forwarded</button>` : ''}
            </div>
          </div>

          ${(po.receipts || []).length || po.items.some(i => i.quantity_unlogged > 0) ? `
          <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-weight:700;font-size:14px">Receipts</span>
              ${po.items.some(i => i.quantity_unlogged > 0) && ['received','partial'].includes(po.status) && this.can('purchasing_receive') ? `<button class="btn btn-sm btn-outline" title="Goods received before receipts were logged" onclick="App.showReverseUnloggedReceipt(${po.id})">↩ Reverse Earlier Receiving</button>` : ''}
            </div>
            ${(po.receipts || []).map(r => `
              <div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px${r.status === 'reversed' ? ';opacity:.65' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                  <div style="font-size:13px"><span class="fw-600">${r.receipt_number}</span> · ${this.fmtDateTime(r.received_at)}${r.received_by_name ? ` · ${this.escapeAttr(r.received_by_name)}` : ''}${r.bill_number ? ` · A/P ${r.bill_number}${r.bill_status === 'void' ? ' (void)' : ''}` : ''}
                    ${r.status === 'reversed' ? `<span class="badge-pill badge-danger" style="font-size:10px">Reversed</span>` : ''}</div>
                  ${r.status === 'received' && ['received','partial'].includes(po.status) && this.can('purchasing_receive') ? `<button class="btn btn-sm btn-danger" onclick="App.showReversePOReceipt(${po.id}, ${r.id})">↩ Reverse</button>` : ''}
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:3px">${r.items.map(i => `${this.escapeAttr(i.product_name)} × ${i.quantity}`).join(' · ')}</div>
                ${(r.price_changes || []).length ? `<div style="font-size:12px;margin-top:3px">${r.price_changes.map(c => `<div>💲 ${this.escapeAttr(c.product_name)}: ${c.new_unit_cost != null ? `cost ${this._fmtPO(c.old_unit_cost, po)} → <strong>${this._fmtPO(c.new_unit_cost, po)}</strong>` : ''}${c.new_unit_cost != null && c.new_price != null ? ' · ' : ''}${c.new_price != null ? `price ${c.old_price != null ? this.fmt(c.old_price) : '—'} → <strong>${this.fmt(c.new_price)}</strong>` : ''}${c.changed_by_name ? ` <span style="color:var(--text-muted)">(${this.escapeAttr(c.changed_by_name)})</span>` : ''}</div>`).join('')}</div>` : ''}
                ${r.status === 'reversed' ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">Reversed ${this.fmtDateTime(r.reversed_at)}${r.reversed_by_name ? ` by ${this.escapeAttr(r.reversed_by_name)}` : ''} — ${this.escapeAttr(r.reverse_reason)}</div>` : ''}
              </div>`).join('')}
          </div>` : ''}

          <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-weight:700;font-size:14px">Attachments</span>
              <button class="btn btn-sm btn-outline" onclick="App.showPOAttachForm(${po.id}${po.supplier_priced ? ",'supplier_invoice'" : ''})">+ Attach Document</button>
            </div>
            <div id="po-attachments-list">
              ${attachments.length ? attachments.map(a => `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-secondary,#f8f9fa);border:1px solid var(--border);border-radius:6px;margin-bottom:6px" id="po-att-${a.id}">
                  <span style="font-size:18px">${fileIcon(a.mime_type)}</span>
                  <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.original_name}</div>
                    <div style="font-size:11px;color:var(--text-muted)">${docTypeLabel[a.document_type]||'Other'} &bull; ${fmtBytes(a.file_size||0)} &bull; ${this.fmtDate(a.uploaded_at)}</div>
                  </div>
                  <a href="/api/purchase-orders/${po.id}/attachments/${a.id}/download" target="_blank" class="btn btn-sm btn-secondary" style="white-space:nowrap">Download</a>
                  <button class="btn btn-sm btn-danger" onclick="App.deletePOAttachment(${po.id},${a.id})">✕</button>
                </div>`).join('') : '<div style="font-size:13px;color:var(--text-muted);padding:6px 0" id="po-att-empty">No documents attached yet.</div>'}
            </div>
          </div>
        </div>
        <div class="modal-footer">
          ${po.status==='draft' ? `<button class="btn btn-outline" onclick="App.closeModal();App.showPOForm(${po.id})">Edit PO</button>` : ''}
          ${po.status==='draft' ? `<button class="btn btn-secondary" onclick="${sp && sp.over.length ? `if(!confirm('Some lines are over the authorized maximum quantity. Send for approval anyway?'))return;` : ''}App.updatePOStatus(${po.id},'sent')">Send for Approval</button>` : ''}
          ${po.status==='sent' && this.can('purchasing_approve') ? `<button class="btn btn-danger" onclick="App.showRejectPOModal(${po.id})">Reject</button>` : ''}
          ${po.status==='sent' && this.can('purchasing_approve') ? `<button class="btn btn-primary" onclick="${sp && sp.over.length ? `if(!confirm('Some lines are over the authorized maximum quantity. Approve anyway?'))return;` : ''}App.showApprovePOModal(${po.id})">Approve PO</button>` : ''}
          ${po.status!=='cancelled'&&po.status!=='received'&&!po.reinstated_from_status ? `<button class="btn btn-danger" onclick="App.updatePOStatus(${po.id},'cancelled')">Cancel PO</button>` : ''}
          ${['draft','cancelled'].includes(po.status) && !po.reinstated_from_status && this.can('purchasing_delete') ? `<button class="btn btn-outline" style="color:var(--danger,#dc2626);border-color:var(--danger,#dc2626)" title="Remove this PO permanently" onclick="App.deletePO(${po.id}, '${this.escapeAttr(po.po_number)}')">🗑 Delete PO</button>` : ''}
          ${['received','partial'].includes(po.status) && !po.approved_at && this.can('purchasing_approve') ? `<button class="btn btn-outline" title="Received before approval was required — send it for approval; stock and receipts stay as they are" onclick="App.reinstatePOForApproval(${po.id})">↩ Send Back for Approval</button>` : ''}
          ${(po.status==='approved'||po.status==='partial') && this.can('purchasing_receive') ? `<button class="btn btn-success" onclick="App.closeModal();App.showReceivePO(${po.id})">Receive Items</button>` : ''}
          ${(po.status==='approved'||po.status==='partial') && canReqPay ? `<button class="btn btn-outline" title="Ask Accounts Payable for an advance or deposit payment on this PO" onclick="App.showPoPaymentRequestForm(${po.id})">💵 Request Payment</button>` : ''}
          ${(po.status==='received'||po.status==='partial') && this.can('purchasing_receive') ? `<button class="btn" style="background:#f59e0b;color:#fff;border:none" onclick="App.closeModal();App.showProcessDamaged(${po.id})">⚠️ Process Damaged</button>` : ''}
          ${(po.status==='received'||po.status==='partial') && this.can('purchasing_receive') ? `<button class="btn btn-secondary" onclick="App.emailGRN(${po.id},'${(po.supplier_email||'').replace(/'/g,"\\'")}')">✉️ Email GRN</button>` : ''}
          <button class="btn btn-secondary" onclick="App.printApprovedPO(${po.id})">🖨️ Print</button>
          <a class="btn btn-secondary" href="/api/email/po-pdf/${po.id}" download="${po.po_number}.pdf" style="text-decoration:none">⬇️ Download PDF</a>
          ${po.status==='approved' ? `<button class="btn btn-secondary" onclick="App.emailApprovedPO(${po.id})">✉️ Email PO</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
    this._viewingPOId = po.id;
  },

  async showFreightForm(poId) {
    const po = await this.api('GET', `/purchase-orders/${poId}`);
    this.showSecondaryModal(`
      <div class="modal">
        <div class="modal-header"><span class="modal-title">Freight Forwarding Details</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Vendor Order/Quote #</label><input id="ff-vendor-order" value="${this.escapeAttr(po.vendor_order_number || '')}" placeholder="e.g. Amazon order #"></div>
          <div class="form-group"><label>Freight Tracking #</label><input id="ff-tracking" value="${this.escapeAttr(po.freight_tracking_number || '')}"></div>
          <div class="form-group"><label>Notes</label><textarea id="ff-notes" rows="3">${po.freight_notes || ''}</textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveFreightForm(${poId})">Save</button>
        </div>
      </div>`);
  },

  async saveFreightForm(poId) {
    const vendor_order_number = document.getElementById('ff-vendor-order').value.trim() || null;
    const freight_tracking_number = document.getElementById('ff-tracking').value.trim() || null;
    const freight_notes = document.getElementById('ff-notes').value.trim() || null;
    try {
      await this.api('PATCH', `/purchase-orders/${poId}/freight`, { vendor_order_number, freight_tracking_number, freight_notes });
      this.closeSecondaryModal();
      this.viewPO(poId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async updateFreightStatus(poId, freight_status) {
    try {
      await this.api('PATCH', `/purchase-orders/${poId}/freight`, { freight_status });
      this.viewPO(poId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // A received PO line with no product_id never touched stock (see
  // /receive) — typically a "Q" custom item quoted before it existed in the
  // catalog. This lets the receiver either link it to an existing product or
  // create a new one on the spot; either way the received qty gets added to
  // stock now, and if the line traces back to a quote it gets updated too.
  async showLinkToInventory(poId, itemId) {
    const [po, categories, products] = await Promise.all([
      this.api('GET', `/purchase-orders/${poId}`),
      this.api('GET', '/categories'),
      this.api('GET', '/products'),
    ]);
    const item = po.items.find(i => i.id === itemId);
    if (!item) return;
    this._linkPOId = poId;
    this._linkItemId = itemId;
    this._linkQuotationItemId = item.quotation_item_id || null;
    this._linkWorkOrderItemId = item.work_order_item_id || null;
    this._linkMode = 'new';
    const fromQuote = !!item.quotation_item_id;
    const fromWorkOrder = !!item.work_order_item_id;
    const fromCustomJob = fromQuote || fromWorkOrder;
    this.showSecondaryModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">${fromCustomJob ? `Add "${item.product_name}" as Non-Inventory Item` : `Add "${item.product_name}" to Inventory`}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${fromCustomJob ? `<p style="font-size:12px;color:var(--text-muted);margin-top:0;margin-bottom:14px">This item was ${fromWorkOrder ? 'requested for a work order' : 'quoted for a specific customer'} — it'll show under Inventory → Non-Inventory Items, not the main list, until someone orders more for general stock.</p>` : ''}
          <div style="display:flex;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden;width:fit-content;margin-bottom:14px">
            <button id="link-mode-new" class="btn" style="border-radius:0;border:none;padding:8px 16px;background:var(--primary);color:#fff;font-weight:600" onclick="App._setLinkMode('new')">Create New Product</button>
            <button id="link-mode-existing" class="btn" style="border-radius:0;border:none;padding:8px 16px;background:var(--card);color:var(--text)" onclick="App._setLinkMode('existing')">Link Existing Product</button>
          </div>
          <div id="link-new-panel">
            <div class="input-row">
              <div class="form-group"><label>SKU *</label><input id="link-sku" placeholder="PROD-001"></div>
              <div class="form-group"><label>Category</label><select id="link-cat"><option value="">— None —</option>${categories.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
            </div>
            <div class="form-group"><label>Name *</label><input id="link-name" value="${this.escapeAttr(item.product_name)}"></div>
            <div class="input-row-3">
              <div class="form-group"><label>Price *</label><input type="number" id="link-price" step="0.01" value="0"></div>
              <div class="form-group"><label>Cost</label><input type="number" id="link-cost" step="0.01" value="${item.unit_cost||0}"></div>
              <div class="form-group"><label>Tax Rate %</label><input type="number" id="link-tax" step="0.1" value="${this.settings?.tax_rate ?? 8.5}"></div>
            </div>
            ${item.product_url ? `<p style="font-size:12px;color:var(--text-muted)">Sourced from: <a href="${item.product_url}" target="_blank" rel="noopener">${item.product_url}</a></p>` : ''}
          </div>
          <div id="link-existing-panel" style="display:none">
            <div class="form-group"><label>Product</label>
              <select id="link-existing-select"><option value="">-- Select Product --</option>${products.map(p=>`<option value="${p.id}">${p.name} (${p.sku})</option>`).join('')}</select>
            </div>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:10px">This will add <strong>${item.quantity_received}</strong> unit(s) to stock${po.branch_name?` at <strong>${po.branch_name}</strong>`:''}.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.linkPOItemToProduct()">${fromCustomJob ? 'Add as Non-Inventory Item' : 'Add to Inventory'}</button>
        </div>
      </div>`);
  },

  _setLinkMode(mode) {
    this._linkMode = mode;
    const newBtn = document.getElementById('link-mode-new');
    const existingBtn = document.getElementById('link-mode-existing');
    newBtn.style.background = mode === 'new' ? 'var(--primary)' : 'var(--card)';
    newBtn.style.color = mode === 'new' ? '#fff' : 'var(--text)';
    existingBtn.style.background = mode === 'existing' ? 'var(--primary)' : 'var(--card)';
    existingBtn.style.color = mode === 'existing' ? '#fff' : 'var(--text)';
    document.getElementById('link-new-panel').style.display = mode === 'new' ? '' : 'none';
    document.getElementById('link-existing-panel').style.display = mode === 'existing' ? '' : 'none';
    // Only a brand-new product gets tagged non-inventory (see link-product route) —
    // linking to an existing product leaves its inventory status untouched.
    const submitBtn = document.querySelector('.modal-footer .btn-primary');
    if (submitBtn && (this._linkQuotationItemId || this._linkWorkOrderItemId)) {
      submitBtn.textContent = mode === 'new' ? 'Add as Non-Inventory Item' : 'Add to Inventory';
    }
  },

  async linkPOItemToProduct() {
    const payload = this._linkMode === 'existing'
      ? { product_id: document.getElementById('link-existing-select').value || null }
      : {
          sku: document.getElementById('link-sku').value.trim(),
          name: document.getElementById('link-name').value.trim(),
          category_id: document.getElementById('link-cat').value || null,
          price: parseFloat(document.getElementById('link-price').value) || 0,
          cost: parseFloat(document.getElementById('link-cost').value) || 0,
          tax_rate: parseFloat(document.getElementById('link-tax').value) || 0,
        };
    if (this._linkMode === 'existing' && !payload.product_id) { this.alert('Select a product', 'error'); return; }
    if (this._linkMode === 'new' && (!payload.sku || !payload.name)) { this.alert('SKU and name are required', 'error'); return; }
    try {
      const result = await this.api('POST', `/purchase-orders/${this._linkPOId}/items/${this._linkItemId}/link-product`, payload);
      this.closeSecondaryModal();
      const nonInventory = this._linkMode === 'new' && (this._linkQuotationItemId || this._linkWorkOrderItemId);
      const base = nonInventory ? 'Added as a non-inventory item (see Inventory → Non-Inventory Items)' : 'Added to inventory';
      const linkedBackTo = result.quotation_updated ? ' — the original quote was updated too' : result.work_order_updated ? ' — the work order was updated too' : '';
      this.alert(`${base}${linkedBackTo}`);
      this.viewPO(this._linkPOId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  _poDocTypeLabels: { purchase_request: 'Purchase Request', supplier_quotation: 'Supplier Quotation', supplier_invoice: 'Supplier Invoice', other: 'Other' },

  _poSupplierPricedCheck(po, attachments) {
    const costed = (po.items || []).every(i => Number(i.unit_cost) > 0);
    const invoice = (attachments || []).some(a => a.document_type === 'supplier_invoice');
    const over = (po.items || []).filter(i => i.authorized_qty != null && Number(i.quantity_ordered) > Number(i.authorized_qty));
    return { costed, invoice, over, ready: costed && invoice };
  },

  showPOAttachForm(poId, defaultType = 'purchase_request') {
    this.showSecondaryModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">Attach Document</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group">
            <label>Document Type</label>
            <select id="att-doctype">
              ${Object.entries(this._poDocTypeLabels).map(([v, l]) => `<option value="${v}" ${v === defaultType ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>File <span style="font-size:11px;color:var(--text-muted)">(PDF, Word, Excel, image — max 20 MB)</span></label>
            <input type="file" id="att-file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.txt" style="display:block;width:100%;padding:8px 0">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" id="att-upload-btn" onclick="App.uploadPOAttachment(${poId})">Upload</button>
        </div>
      </div>`);
  },

  async uploadPOAttachment(poId) {
    const fileInput = document.getElementById('att-file');
    const docType = document.getElementById('att-doctype').value;
    if (!fileInput.files.length) { this.alert('Please select a file', 'error'); return; }
    const file = fileInput.files[0];
    const btn = document.getElementById('att-upload-btn');
    btn.disabled = true; btn.textContent = 'Uploading...';
    const fd = new FormData();
    fd.append('file', file);
    fd.append('document_type', docType);
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/attachments`, { method: 'POST', body: fd });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Upload failed'); }
      const att = await res.json();
      this.closeSecondaryModal();
      this.alert('Document attached successfully');
      // A fuel PO's checklist depends on its attachments — redraw it
      if (document.getElementById('po-sp-check')) return this.viewPO(poId);
      // Refresh attachment list in-place
      const list = document.getElementById('po-attachments-list');
      if (list) {
        document.getElementById('po-att-empty')?.remove();
        const docTypeLabel = this._poDocTypeLabels;
        const fileIcon = m => m==='application/pdf'?'📄':m&&m.startsWith('image/')?'🖼':m&&m.includes('word')?'📝':m&&m.includes('sheet')?'📊':'📎';
        const fmtBytes = b => b<1024?`${b} B`:b<1048576?`${(b/1024).toFixed(1)} KB`:`${(b/1048576).toFixed(1)} MB`;
        const div = document.createElement('div');
        div.id = `po-att-${att.id}`;
        div.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-secondary,#f8f9fa);border:1px solid var(--border);border-radius:6px;margin-bottom:6px';
        div.innerHTML = `
          <span style="font-size:18px">${fileIcon(att.mime_type)}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${att.original_name}</div>
            <div style="font-size:11px;color:var(--text-muted)">${docTypeLabel[att.document_type]||'Other'} &bull; ${fmtBytes(att.file_size||0)} &bull; ${this.fmtDate(att.uploaded_at)}</div>
          </div>
          <a href="/api/purchase-orders/${poId}/attachments/${att.id}/download" target="_blank" class="btn btn-sm btn-secondary" style="white-space:nowrap">Download</a>
          <button class="btn btn-sm btn-danger" onclick="App.deletePOAttachment(${poId},${att.id})">✕</button>`;
        list.appendChild(div);
      }
    } catch(e) {
      btn.disabled = false; btn.textContent = 'Upload';
      this.alert(e.message, 'error');
    }
  },

  async deletePOAttachment(poId, attId) {
    if (!confirm('Remove this attachment permanently?')) return;
    try {
      await this.api('DELETE', `/purchase-orders/${poId}/attachments/${attId}`);
      if (document.getElementById('po-sp-check')) return this.viewPO(poId);
      document.getElementById(`po-att-${attId}`)?.remove();
      const list = document.getElementById('po-attachments-list');
      if (list && !list.querySelector('[id^="po-att-"]')) {
        list.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:6px 0" id="po-att-empty">No documents attached yet.</div>';
      }
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // "Request Payment" on an approved PO: an advance/deposit the supplier
  // needs before supplying, optionally by a pay-by date. Goes straight to
  // A/P's approval queue (POST /payables/payment-requests/from-po/:id), and
  // A/P is notified (see _pollPayablesInbox).
  async showPoPaymentRequestForm(poId) {
    let po, info;
    try {
      [po, info] = await Promise.all([this.api('GET', `/purchase-orders/${poId}`), this.api('GET', `/payables/payment-requests/for-po/${poId}`)]);
    } catch (e) { return this.alert(e.message, 'error'); }
    const room = info.room || { available: 0, paid: 0, requested: 0, total_base: 0 };
    if (room.missing_rate) return this.alert(`${po.po_number} has no exchange rate — set one on the PO first`, 'error');
    if (!(room.available > 0)) return this.alert(`Nothing is left to request on ${po.po_number} — it's fully paid or already requested`, 'warning');
    const pct = p => Math.min(room.available, Math.round(room.total_base * p) / 100);
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header"><span class="modal-title">Request Payment — ${po.po_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="font-size:13px;margin-bottom:12px;padding:10px 12px;background:var(--bg-secondary,#f8f9fa);border:1px solid var(--border);border-radius:6px">
            <strong>${this.escapeAttr(po.supplier_name || '')}</strong><br>
            PO total ${this.fmt(room.total_base)}${po.currency ? ` <span style="color:var(--text-muted)">(${this._fmtPO(po.total, po)})</span>` : ''} · paid ${this.fmt(room.paid)}${room.requested > 0 ? ` · ${this.fmt(room.requested)} already requested` : ''} · <strong>${this.fmt(room.available)} left to request</strong>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Amount *</label><input id="popr-amount" type="number" step="0.01" min="0" max="${room.available}" placeholder="0.00"></div>
            <div class="form-group"><label>Requested Payment Date *</label><input id="popr-date" type="date" min="${this._storeDay(new Date())}"><div style="font-size:11px;color:var(--text-muted);margin-top:3px">When the supplier needs to be paid — the approver sets the scheduled date</div></div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin:-6px 0 12px">
            ${[25, 50, 100].map(p => `<button type="button" class="btn btn-sm btn-outline" onclick="document.getElementById('popr-amount').value='${pct(p).toFixed(2)}'">${p}% (${this.fmt(pct(p))})</button>`).join('')}
            <button type="button" class="btn btn-sm btn-outline" onclick="document.getElementById('popr-amount').value='${room.available.toFixed(2)}'">All that's left</button>
          </div>
          <div class="form-group"><label>Description</label><input id="popr-desc" placeholder="e.g. 50% deposit to start production" value="Advance payment on ${po.po_number}"></div>
          <div class="form-group"><label>Notes for Accounts Payable</label><textarea id="popr-notes" rows="2" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;resize:vertical" placeholder="Why it's needed, supplier's payment terms, bank details reference..."></textarea></div>
          <div class="form-group" style="margin:0"><label>Supporting Documents</label>
            <input type="file" id="popr-files" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt">
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">The supplier's proforma invoice or deposit request — up to 20 MB each.</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal();App.viewPO(${po.id})">Cancel</button>
          <button class="btn btn-primary" onclick="App.submitPoPaymentRequest(${po.id})">Send to Accounts Payable</button>
        </div>
      </div>`);
    setTimeout(() => document.getElementById('popr-amount')?.focus(), 50);
  },

  async submitPoPaymentRequest(poId) {
    const amount = parseFloat(document.getElementById('popr-amount').value);
    if (!(amount > 0)) return this.alert('Enter the amount to pay', 'error');
    const data = {
      amount,
      required_date: document.getElementById('popr-date').value || null,
      description: document.getElementById('popr-desc').value.trim(),
      notes: document.getElementById('popr-notes').value.trim(),
    };
    const files = [...(document.getElementById('popr-files').files || [])];
    try {
      const saved = await this.api('POST', `/payables/payment-requests/from-po/${poId}`, data);
      try { await this._uploadPaymentRequestFiles(saved.id, files); }
      catch (e) { this.alert(`${saved.request_number} sent, but a document didn't upload — ${e.message}`, 'warning'); }
      this.closeModal();
      this.alert(`${saved.request_number} sent to Accounts Payable for approval`);
      this.viewPO(poId);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async deletePO(id, number) {
    if (!confirm(`Delete purchase order ${number}? This removes it and its attached documents permanently and can't be undone. A purchase request converted into it goes back to Approved.`)) return;
    try {
      await this.api('DELETE', `/purchase-orders/${id}`);
      this.closeModal();
      this.alert(`${number} deleted`);
      this.renderPurchasing();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async updatePOStatus(id, status) {
    try {
      await this.api('PATCH', `/purchase-orders/${id}/status`, { status });
      this.closeModal();
      this.alert(`PO ${status}`);
      this.renderPurchasing();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showRejectPOModal(id) {
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Reject Purchase Order</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">This sends the PO back to Draft so the requester can make adjustments and resubmit it.</p>
          <div class="form-group"><label>Reason *</label><textarea id="po-reject-reason" rows="3" placeholder="What needs to change"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App.confirmRejectPO(${id})">Reject PO</button>
        </div>
      </div>`);
  },

  async confirmRejectPO(id) {
    const reason = document.getElementById('po-reject-reason').value.trim();
    if (!reason) { this.alert('A rejection reason is required', 'error'); return; }
    try {
      await this.api('PATCH', `/purchase-orders/${id}/reject`, { reason, employee_id: this.currentUser.id });
      this.closeModal();
      this.alert('Purchase order rejected — back in Draft');
      this.renderPurchasing();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showApprovePOModal(id) {
    const po = await this.api('GET', `/purchase-orders/${id}`).catch(() => null);
    this._showApprovalDialog({
      title: `Approve Purchase Order${po ? ` ${po.po_number}` : ''}`,
      context: po ? (this._internalNotesHtml(po.internal_notes) || '<p style="font-size:12px;color:var(--text-muted)">No internal notes on this PO.</p>') : '',
      intro: 'Your signature is recorded on the approved PO and appears on its printed, emailed and PDF copies.',
      approve: async (signature) => {
        await this.api('PATCH', `/purchase-orders/${id}/approve`, { signature });
        this.closeModal();
        this.alert('Purchase order approved');
        this.renderPurchasing();
      },
    });
  },

  // Any status — copies of a PO that isn't approved are marked as such on the page
  printApprovedPO(id) {
    return this._printServerDocument(`/api/email/po-preview/${id}`, 'purchase-order', 'purchase order');
  },

  // TEMPORARY — for POs received before approval was required (see the route)
  async reinstatePOForApproval(id) {
    const reason = prompt('This PO was received without being approved. Send it back to Awaiting Approval so it can be signed off?\n\nStock and receipts stay exactly as they are; once approved it returns to Received.\n\nReason:');
    if (reason == null) return;
    if (!reason.trim()) { this.alert('A reason is required', 'error'); return; }
    try {
      await this.api('PATCH', `/purchase-orders/${id}/reinstate-for-approval`, { reason: reason.trim() });
      this.alert('Sent back for approval');
      this.closeModal();
      this.renderPurchasing();
      this.viewPO(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Email an approved PO to one or more addresses (the supplier's Email and
  // Email 2 filled in), with optional CC, subject and a message for
  // delivery details or instructions shown above the PO.
  async emailApprovedPO(id) {
    const po = await this.api('GET', `/purchase-orders/${id}`);
    const to = [po.supplier_email, po.supplier_email2].filter(Boolean).join(', ');
    let pdfDefault = false;
    try { pdfDefault = localStorage.getItem('pos_email_as_pdf') === '1'; } catch(e) {}
    this.showSecondaryModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header"><span class="modal-title">Email Purchase Order — ${po.po_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group">
            <label>To *</label>
            <input id="poe-to" value="${this.escapeAttr(to)}" placeholder="orders@supplier.com, accounts@supplier.com">
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">Separate several addresses with commas.</div>
          </div>
          <div class="form-group"><label>CC</label><input id="poe-cc" placeholder="Optional — e.g. our receiving team"></div>
          <div class="form-group"><label>Subject</label><input id="poe-subject" value="${this.escapeAttr(`Purchase Order ${po.po_number} from ${this.settings?.store_name || 'Our Store'}`)}"></div>
          <div class="form-group">
            <label>Message</label>
            <textarea id="poe-message" rows="5" placeholder="Delivery details or instructions — e.g. Deliver to the Drax Hall warehouse Mon–Fri 8am–3pm; call ahead on 876-…; include the PO number on your invoice."></textarea>
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">Shown above the purchase order in the email.</div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="poe-pdf" ${pdfDefault ? 'checked' : ''} style="width:16px;height:16px;margin:0">
            Attach as PDF <span style="color:var(--text-muted);font-size:12px">(instead of in the email body)</span>
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" id="poe-send" onclick="App.sendApprovedPOEmail(${po.id})">Send</button>
        </div>
      </div>`);
  },

  async sendApprovedPOEmail(id) {
    const val = k => document.getElementById(k)?.value.trim() || '';
    const split = v => v.split(/[,;\s]+/).filter(Boolean);
    const to = split(val('poe-to')), cc = split(val('poe-cc'));
    if (!to.length) { this.alert('Enter at least one email address', 'error'); return; }
    const bad = [...to, ...cc].find(a => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
    if (bad) { this.alert(`"${bad}" isn't a valid email address`, 'error'); return; }
    const as_pdf = !!document.getElementById('poe-pdf')?.checked;
    try { localStorage.setItem('pos_email_as_pdf', as_pdf ? '1' : '0'); } catch(e) {}
    const btn = document.getElementById('poe-send');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const r = await this.api('POST', `/email/send-po/${id}`, { to, cc, subject: val('poe-subject'), message: document.getElementById('poe-message')?.value || '', as_pdf });
      this.closeSecondaryModal();
      this.alert(r.message || 'Purchase order sent');
    } catch(e) {
      this.alert(e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
    }
  },

  async showReceivePO(id) {
    const po = await this.api('GET', `/purchase-orders/${id}`);
    const pendingItems = po.items.filter(i => (i.quantity_received||0) < i.quantity_ordered);
    if (!pendingItems.length) { this.alert('All items already received', 'warning'); return; }
    this._recvPO = po;
    const canPrice = this.can('inventory_edit');
    const canRaise = this.can('purchasing_approve');
    const step = n => (Number.isInteger(n) ? '1' : 'any');
    this.showModal(`
      <div class="modal" style="max-width:980px">
        <div class="modal-header"><span class="modal-title">Receive Items - ${po.po_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:6px">Enter the quantities received. If the supplier's price changed since the PO, enter the new <strong>unit cost</strong> (${po.currency ? `in ${po.currency}, ` : ''}per the line's unit, before tax and vendor discount) — the PO line, the item's cost and the A/P bill use it. ${canPrice ? 'Change the <strong>selling price</strong> here too if the shelf price should move with it.' : ''}</p>
          ${canRaise ? '' : '<p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">You can lower a cost; raising one above the approved cost needs someone who can approve POs.</p>'}
          <div class="table-wrap"><table class="data-table" style="width:100%">
            <thead><tr><th>Item</th><th style="text-align:right;width:90px">Receive</th><th style="text-align:right;width:130px">Unit cost</th><th style="text-align:right;width:130px">Selling price</th><th style="text-align:right;width:80px">Margin</th></tr></thead>
            <tbody>${pendingItems.map(i => {
              const pending = Math.round((i.quantity_ordered - (i.quantity_received || 0)) * 1000) / 1000;
              const service = i.item_type === 'service' || !i.product_id;
              const lockedCost = (i.quantity_received || 0) > 0;
              const ul = this._orderLineUnit(i);
              const hasPrice = !service && i.sell_price != null;
              return `<tr>
                <td><div class="fw-600">${this.escapeAttr(ul.name)}${i.item_type === 'service' ? ' <span class="badge-pill badge-info" style="font-size:10px">Service</span>' : ''}</div>
                  <div style="font-size:12px;color:var(--text-muted)">${ul.unit !== 'Each' ? `${this.escapeAttr(ul.unit)} · ` : ''}Ordered ${i.quantity_ordered} · Received ${i.quantity_received || 0} · Pending ${pending}${i.item_type === 'service' ? ' · no stock change' : ''}</div></td>
                <td style="text-align:right"><input id="recv-${i.id}" type="number" min="0" step="any" value="${pending}" style="width:80px;text-align:right" placeholder="Qty"></td>
                <td style="text-align:right"><input id="recv-cost-${i.id}" type="number" min="0" step="0.01" value="${Number(i.unit_cost || 0).toFixed(2)}" data-orig="${Number(i.unit_cost || 0)}" style="width:110px;text-align:right" ${lockedCost ? `disabled title="Already part-received at this cost — it can't change now"` : ''} oninput="App._recvLineCalc(${i.id})">
                  <div id="recv-cost-note-${i.id}" style="font-size:11px;color:var(--text-muted)">${lockedCost ? 'part-received' : `PO ${this._fmtPO(i.unit_cost, po)}`}</div></td>
                <td style="text-align:right">${hasPrice ? `<input id="recv-price-${i.id}" type="number" min="0" step="0.01" value="${Number(i.sell_price).toFixed(2)}" data-orig="${Number(i.sell_price)}" style="width:110px;text-align:right" ${canPrice ? '' : 'disabled title="Changing selling prices needs Edit Inventory permission"'} oninput="App._recvLineCalc(${i.id})">
                  <div id="recv-price-note-${i.id}" style="font-size:11px;color:var(--text-muted)">now ${this.fmt(i.sell_price)}</div>` : `<span style="color:var(--text-muted);font-size:12px">${service ? '—' : 'not sold in this unit'}</span>`}</td>
                <td style="text-align:right" id="recv-margin-${i.id}"></td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" onclick="App.confirmReceivePO(${po.id}, [${pendingItems.map(i=>i.id).join(',')}])">Confirm Receipt</button>
        </div>
      </div>`);
    pendingItems.forEach(i => this._recvLineCalc(i.id));
  },

  // Net cost per line unit in base currency (after the vendor discount) for the margin.
  _recvNetCost(i, cost) {
    const rate = this._recvPO?.currency ? (Number(this._recvPO.exchange_rate) || 0) : 1;
    const net = i.vendor_discount_percent != null ? cost * (1 - Number(i.vendor_discount_percent) / 100)
      : cost - (i.quantity_ordered ? (Number(i.vendor_discount) || 0) / i.quantity_ordered : 0);
    return Math.max(0, net) * rate;
  },

  _recvLineCalc(id) {
    const i = (this._recvPO?.items || []).find(x => x.id === id);
    if (!i) return;
    const costEl = document.getElementById(`recv-cost-${id}`), priceEl = document.getElementById(`recv-price-${id}`);
    const cost = Number(costEl?.value) || 0, price = priceEl ? Number(priceEl.value) || 0 : null;
    const costChanged = costEl && !costEl.disabled && Math.abs(cost - Number(costEl.dataset.orig)) >= 0.005;
    const costNote = document.getElementById(`recv-cost-note-${id}`);
    if (costNote && !costEl.disabled) {
      const up = cost > Number(costEl.dataset.orig);
      costNote.innerHTML = costChanged ? `<span style="color:${up ? 'var(--danger)' : 'var(--success)'};font-weight:700">${up ? '▲' : '▼'} was ${this._fmtPO(costEl.dataset.orig, this._recvPO)}</span>` : `PO ${this._fmtPO(i.unit_cost, this._recvPO)}`;
    }
    if (costEl) costEl.style.borderColor = costChanged ? 'var(--primary)' : '';
    const priceNote = document.getElementById(`recv-price-note-${id}`);
    if (priceEl && priceNote) {
      const pc = Math.abs(price - Number(priceEl.dataset.orig)) >= 0.005;
      priceNote.innerHTML = pc ? `<span style="color:var(--primary);font-weight:700">was ${this.fmt(priceEl.dataset.orig)}</span>` : `now ${this.fmt(priceEl.dataset.orig)}`;
      priceEl.style.borderColor = pc ? 'var(--primary)' : '';
    }
    const m = document.getElementById(`recv-margin-${id}`);
    if (!m) return;
    if (!(price > 0)) { m.innerHTML = '<span style="color:var(--text-muted)">—</span>'; return; }
    const pct = (price - this._recvNetCost(i, cost)) / price * 100;
    m.innerHTML = `<span style="font-weight:700;color:${pct < 0 ? 'var(--danger)' : pct < 15 ? 'var(--warning,#b7791f)' : 'var(--success)'}">${pct.toFixed(1)}%</span>`;
  },

  // Step 2 of receiving: read the counts — and any cost / price changes —
  // back before stock moves, flagging lines left out and anything over what's still pending.
  async confirmReceivePO(poId, itemIds) {
    const po = this._recvPO && this._recvPO.id === poId ? this._recvPO : await this.api('GET', `/purchase-orders/${poId}`);
    const lines = itemIds.map(id => {
      const i = po.items.find(x => x.id === id);
      const costEl = document.getElementById(`recv-cost-${id}`), priceEl = document.getElementById(`recv-price-${id}`);
      const cost = costEl && !costEl.disabled ? Number(costEl.value) : null;
      const price = priceEl && !priceEl.disabled ? Number(priceEl.value) : null;
      return {
        i, qty: Number(document.getElementById(`recv-${id}`).value) || 0, pending: i.quantity_ordered - (i.quantity_received || 0),
        cost, costChanged: cost != null && Math.abs(cost - (Number(i.unit_cost) || 0)) >= 0.005,
        price, priceChanged: price != null && Math.abs(price - (Number(i.sell_price) || 0)) >= 0.005,
      };
    });
    for (const l of lines) {
      if (l.qty > 0 && l.cost != null && !(l.cost >= 0)) return this.alert(`Enter a valid cost for ${l.i.product_name}`, 'error');
      if (l.qty > 0 && l.price != null && !(l.price >= 0)) return this.alert(`Enter a valid selling price for ${l.i.product_name}`, 'error');
      if (l.qty > 0 && l.costChanged && l.cost > l.i.unit_cost && !this.can('purchasing_approve')) return this.alert(`Raising the cost of ${l.i.product_name} needs someone who can approve POs`, 'error');
    }
    const items = lines.filter(l => l.qty > 0).map(l => ({ item_id: l.i.id, quantity_received: l.qty, ...(l.costChanged ? { unit_cost: l.cost } : {}), ...(l.priceChanged ? { selling_price: l.price } : {}) }));
    if (!items.length) { this.alert('Enter at least one quantity', 'error'); return; }
    this._pendingPOReceipt = { poId, items };
    const flag = l => l.qty <= 0 ? '<span class="badge-pill badge-warning" style="font-size:10px">Not receiving</span>'
      : l.qty > l.pending ? `<span class="badge-pill badge-danger" style="font-size:10px">Over by ${Math.round((l.qty - l.pending) * 1000) / 1000}</span>`
      : l.qty < l.pending ? `<span class="badge-pill badge-info" style="font-size:10px">Short ${Math.round((l.pending - l.qty) * 1000) / 1000}</span>` : '';
    const changes = lines.filter(l => l.qty > 0 && (l.costChanged || l.priceChanged));
    this.showSecondaryModal(`
      <div class="modal" style="max-width:700px">
        <div class="modal-header"><span class="modal-title">Confirm Counts — ${po.po_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Check these counts against what's physically here. Stock${po.supplier_id ? ' and the A/P bill' : ''} will be updated with exactly these quantities.</p>
          <table class="data-table" style="width:100%">
            <thead><tr><th>Item</th><th style="text-align:right">Pending</th><th style="text-align:right">Receiving</th><th></th></tr></thead>
            <tbody>${lines.map(l => `<tr${l.qty <= 0 ? ' style="opacity:.6"' : ''}>
              <td>${this.escapeAttr(l.i.product_name)}${l.i.purchase_unit ? ` <span style="font-size:11px;color:var(--text-muted)">(${this.escapeAttr(l.i.purchase_unit)})</span>` : ''}</td>
              <td style="text-align:right">${l.pending}</td>
              <td style="text-align:right;font-weight:700">${l.qty}</td>
              <td>${flag(l)}</td></tr>`).join('')}</tbody>
          </table>
          ${changes.length ? `<div style="margin-top:14px;font-weight:700;font-size:13px">Price changes</div>
          <table class="data-table" style="width:100%;margin-top:6px">
            <thead><tr><th>Item</th><th style="text-align:right">Unit cost</th><th style="text-align:right">Selling price</th></tr></thead>
            <tbody>${changes.map(l => `<tr>
              <td>${this.escapeAttr(l.i.product_name)}</td>
              <td style="text-align:right">${l.costChanged ? `${this._fmtPO(l.i.unit_cost, po)} → <strong>${this._fmtPO(l.cost, po)}</strong>` : '<span style="color:var(--text-muted)">unchanged</span>'}</td>
              <td style="text-align:right">${l.priceChanged ? `${this.fmt(l.i.sell_price)} → <strong>${this.fmt(l.price)}</strong>` : '<span style="color:var(--text-muted)">unchanged</span>'}</td>
            </tr>`).join('')}</tbody>
          </table>
          <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">A new cost updates the PO line and total, the item's cost and the A/P bill for this receipt. A new selling price takes effect at the POS straight away.</p>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Back — Change Counts</button>
          <button class="btn btn-success" onclick="App.submitReceivePO()">Counts Are Correct — Receive</button>
        </div>
      </div>`);
  },

  async submitReceivePO() {
    const { poId, items } = this._pendingPOReceipt || {};
    if (!poId) return;
    try {
      await this.api('PATCH', `/purchase-orders/${poId}/receive`, { items });
      this._pendingPOReceipt = null;
      this._recvPO = null;
      this.closeSecondaryModal();
      this.closeModal();
      const changed = items.filter(i => i.unit_cost !== undefined || i.selling_price !== undefined).length;
      this.alert(`Items received and stock updated${changed ? ` — ${changed} price change${changed > 1 ? 's' : ''} applied` : ''}`);
      this.renderPurchasing();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ── Receive Without PO (routes/direct-receipts.js) ─────────────
  _drFilterChanged(typing) {
    const f = this._drFilters ||= {};
    f.q = document.getElementById('drf-q')?.value.trim() || '';
    f.supplier_id = document.getElementById('drf-supplier')?.value || '';
    f.status = document.getElementById('drf-status')?.value || '';
    f.start = document.getElementById('drf-start')?.value || '';
    f.end = document.getElementById('drf-end')?.value || '';
    clearTimeout(this._drFilterTimer);
    this._drFilterTimer = setTimeout(() => this._loadDirectReceiptList(), typing ? 300 : 0);
  },

  async _loadDirectReceiptList() {
    const box = document.getElementById('dr-list');
    if (!box) return;
    const f = this._drFilters || {};
    const params = new URLSearchParams();
    for (const k of ['q', 'supplier_id', 'status', 'start', 'end']) if (f[k]) params.set(k, f[k]);
    const seq = (this._drListSeq = (this._drListSeq || 0) + 1);
    let rows;
    try { rows = await this.api('GET', `/direct-receipts?${params}`); } catch (e) { box.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (seq !== this._drListSeq || !document.getElementById('dr-list')) return;
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Receipt #</th><th>Received</th><th>Supplier</th><th>Supplier Invoice #</th><th>Branch</th><th style="text-align:right">Items</th><th style="text-align:right">Total</th><th>A/P Bill</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map(r => `<tr>
        <td class="fw-600">${r.receipt_number}</td>
        <td style="color:var(--text-muted)">${this.fmtDateTime(r.received_at)}</td>
        <td>${this.escapeAttr(r.supplier_name || '—')}</td>
        <td>${this.escapeAttr(r.vendor_invoice_number || '—')}</td>
        <td>${this.escapeAttr(r.branch_name || '—')}</td>
        <td style="text-align:right">${r.item_count}</td>
        <td style="text-align:right" class="fw-600">${this.fmt(r.total)}</td>
        <td>${r.bill_number ? `${r.bill_number}${r.bill_status === 'void' ? ' <span style="color:var(--text-muted)">(void)</span>' : ''}` : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td>${r.status === 'reversed' ? '<span class="badge-pill badge-danger">Reversed</span>' : '<span class="badge-pill badge-success">Received</span>'}</td>
        <td><button class="btn btn-sm btn-secondary" onclick="App.viewDirectReceipt(${r.id})">View</button></td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No goods received without a PO yet</td></tr>'}</tbody>
    </table></div>`;
  },

  async showDirectReceiptForm() {
    const [suppliers, products] = await Promise.all([this.api('GET', '/suppliers'), this.api('GET', '/products')]);
    const branches = this.currentUser.branches || [];
    const defBranch = branches.find(b => b.is_default) || branches[0];
    // Stocked catalog items only — services, rentals and items with variations aren't received here.
    this._dr = { suppliers, products: products.filter(p => p.active !== 0 && !p.is_service && !p.is_rental && !(p.has_variations > 0)), lines: [] };
    this.showModal(`
      <div class="modal" style="max-width:1000px">
        <div class="modal-header"><span class="modal-title">Receive Without PO</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">For goods that arrived without a purchase order. Stock goes on hand as soon as you receive, each item's cost is updated to the unit cost entered, and an A/P bill is raised for vendors set to sync with A/P.</p>
          <div class="input-row">
            <div class="form-group"><label>Supplier *</label>
              <select id="dr-supplier" data-searchable onchange="App._drSupplierChanged()">
                <option value="">-- Select Supplier --</option>
                ${suppliers.map(s => `<option value="${s.id}">${this.escapeAttr(s.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Branch receiving *</label>
              <select id="dr-branch">
                ${branches.length ? '' : '<option value="">—</option>'}
                ${branches.map(b => `<option value="${b.id}" ${defBranch && b.id === defBranch.id ? 'selected' : ''}>${this.escapeAttr(b.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Supplier invoice / delivery note #</label>
              <input id="dr-invoice" type="text" maxlength="60" placeholder="e.g. INV-55102">
            </div>
          </div>
          <div class="form-group" style="position:relative">
            <label>Add item — scan a barcode or search</label>
            <input id="dr-search" type="search" autocomplete="off" placeholder="Scan barcode, or type name / SKU…" oninput="App._drSearch(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();App._drSearchEnter(this.value)}">
            <div id="dr-search-dd" style="display:none;position:absolute;z-index:20;left:0;right:0;max-height:260px;overflow:auto;background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.15)"></div>
          </div>
          <div class="table-wrap">
            <table class="data-table" style="width:100%">
              <thead><tr><th>Item</th><th style="width:150px">Unit</th><th style="width:90px;text-align:right">Qty</th><th style="width:120px;text-align:right">Unit cost</th><th style="width:170px">Tax</th><th style="width:110px;text-align:right">Line</th><th style="width:36px"></th></tr></thead>
              <tbody id="dr-lines"></tbody>
            </table>
          </div>
          <div id="dr-totals" style="text-align:right;margin-top:10px;font-size:14px"></div>
          <div class="form-group" style="margin-top:12px"><label>Notes</label>
            <textarea id="dr-notes" rows="2" placeholder="Why there was no PO, who delivered it, condition…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" onclick="App._drConfirm()">Review &amp; Receive</button>
        </div>
      </div>`);
    this._drRenderLines();
    setTimeout(() => document.getElementById('dr-search')?.focus(), 50);
  },

  _drTaxDefault() {
    const sup = (this._dr?.suppliers || []).find(s => String(s.id) === String(document.getElementById('dr-supplier')?.value));
    return sup && sup.is_local ? 'local' : 'none';
  },

  // Lines whose tax wasn't picked by hand follow the supplier (GCT for a local vendor).
  _drSupplierChanged() {
    const t = this._drTaxDefault();
    for (const l of this._dr?.lines || []) if (l.taxAuto) l.tax = t;
    this._drRenderLines();
  },

  _drMatches(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return (this._dr?.products || []).filter(p => `${p.name} ${p.sku || ''} ${p.barcode || ''}`.toLowerCase().includes(q)).slice(0, 40);
  },

  _drSearch(query) {
    const dd = document.getElementById('dr-search-dd');
    if (!dd) return;
    const matches = this._drMatches(query);
    if (!String(query || '').trim()) { dd.style.display = 'none'; return; }
    dd.innerHTML = matches.length ? matches.map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._drAdd(${p.id})">
        <strong>${this.escapeAttr(p.name)}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${p.sku ? this.escapeAttr(p.sku) + ' · ' : ''}cost ${this.fmt(p.cost || 0)} · on hand ${p.stock_qty ?? 0}</div>
      </div>`).join('') : '<div style="padding:10px;color:var(--text-muted);font-size:13px">No stocked item matches — add it in Inventory first</div>';
    dd.style.display = '';
  },

  // Enter in the search box: an exact SKU / barcode (or alternate-unit barcode) adds it straight away.
  _drSearchEnter(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return;
    for (const p of this._dr?.products || []) {
      if ([p.sku, p.barcode].some(v => v && String(v).toLowerCase() === q)) return this._drAdd(p.id);
      const u = (p.units || []).find(u => u.barcode && String(u.barcode).toLowerCase() === q);
      if (u) return this._drAdd(p.id, this._unitChoices(p, 'buy').find(c => c.uom_id === u.unit_id));
    }
    const m = this._drMatches(q);
    if (m.length === 1) return this._drAdd(m[0].id);
    this._drSearch(query);
  },

  async _drAdd(productId, choice) {
    const p = (this._dr?.products || []).find(x => x.id === productId);
    if (!p) return;
    const dd = document.getElementById('dr-search-dd');
    if (dd) dd.style.display = 'none';
    const search = document.getElementById('dr-search');
    if (search) search.value = '';
    choice = choice || (await this._pickUnit(p, 'buy'));
    if (!choice) return; // unit picker cancelled
    const lines = this._dr.lines;
    // Scanning the same item in the same unit again adds one more.
    const same = lines.find(l => l.p.id === p.id && (l.choice.uom_id ?? null) === (choice.uom_id ?? null));
    if (same) same.qty = (Number(same.qty) || 0) + 1;
    else lines.push({ p, choice, qty: 1, cost: ((Number(p.cost) || 0) * (choice.factor || 1)).toFixed(2), tax: this._drTaxDefault(), taxAuto: true });
    this._drRenderLines();
    setTimeout(() => document.getElementById('dr-search')?.focus(), 0);
  },

  _drSetUnit(i, uomVal) {
    const l = this._dr.lines[i];
    if (!l) return;
    const choice = this._unitChoiceFor(l.p, uomVal ? Number(uomVal) : (l.p.base_unit_id || null), 'buy');
    if (!choice) return;
    l.choice = choice;
    l.cost = ((Number(l.p.cost) || 0) * (choice.factor || 1)).toFixed(2);
    this._drRenderLines();
  },

  _drSet(i, field, value) {
    const l = this._dr.lines[i];
    if (!l) return;
    l[field] = value;
    if (field === 'tax') l.taxAuto = false;
    this._drUpdateTotals();
  },

  _drRemove(i) { this._dr.lines.splice(i, 1); this._drRenderLines(); },

  _drLineValues(l) {
    const net = Math.round((Number(l.qty) || 0) * (Number(l.cost) || 0) * 100) / 100;
    const tax = l.tax === 'local' ? Math.round(net * this._poTaxRate()) / 100 : 0;
    return { net, tax };
  },

  _drRenderLines() {
    const body = document.getElementById('dr-lines');
    if (!body) return;
    const lines = this._dr.lines;
    body.innerHTML = lines.length ? lines.map((l, i) => {
      const choices = this._unitChoices(l.p, 'buy');
      const stockAbbr = l.p.base_unit_abbr || l.p.base_unit_name || 'ea';
      return `<tr>
        <td><div class="fw-600">${this.escapeAttr(l.p.name)}</div><div style="font-size:11px;color:var(--text-muted)">${l.p.sku ? this.escapeAttr(l.p.sku) + ' · ' : ''}current cost ${this.fmt(l.p.cost || 0)}${l.choice.factor > 1 ? ` · ${l.choice.factor} ${this.escapeAttr(stockAbbr)} each` : ''}</div></td>
        <td>${choices.length > 1 ? `<select onchange="App._drSetUnit(${i}, this.value)">${choices.map(c => `<option value="${c.isBase ? '' : c.uom_id}" ${(c.uom_id ?? null) === (l.choice.uom_id ?? null) ? 'selected' : ''}>${this.escapeAttr(c.label || c.name)}</option>`).join('')}</select>` : this.escapeAttr(l.choice.label || l.choice.name)}</td>
        <td><input type="number" min="0" step="${l.choice.allow_decimal ? 'any' : '1'}" value="${l.qty}" style="width:80px;text-align:right" oninput="App._drSet(${i},'qty',this.value)"></td>
        <td><input type="number" min="0" step="0.01" value="${l.cost}" style="width:110px;text-align:right" title="Cost per ${this.escapeAttr(l.choice.label || l.choice.name)}, after any vendor discount, before tax" oninput="App._drSet(${i},'cost',this.value)"></td>
        <td><select onchange="App._drSet(${i},'tax',this.value)">${['local', 'none'].map(o => `<option value="${o}" ${l.tax === o ? 'selected' : ''}>${this._poTaxLabel(o)}</option>`).join('')}</select></td>
        <td style="text-align:right" class="fw-600" id="dr-line-${i}"></td>
        <td><button class="btn btn-sm btn-outline" title="Remove" onclick="App._drRemove(${i})">✕</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-state" style="padding:18px">Scan or search to add the items that arrived</td></tr>';
    this._drUpdateTotals();
  },

  _drUpdateTotals() {
    let sub = 0, tax = 0;
    this._dr.lines.forEach((l, i) => {
      const v = this._drLineValues(l);
      sub += v.net; tax += v.tax;
      const cell = document.getElementById(`dr-line-${i}`);
      if (cell) { cell.textContent = this.fmt(v.net); cell.title = v.tax ? `+ ${this.fmt(v.tax)} GCT` : ''; }
    });
    const el = document.getElementById('dr-totals');
    if (el) el.innerHTML = this._dr.lines.length ? `Subtotal ${this.fmt(sub)} &nbsp;·&nbsp; GCT ${this.fmt(tax)} &nbsp;·&nbsp; <strong>Total ${this.fmt(sub + tax)}</strong>` : '';
  },

  // Step 2: read the counts and costs back before stock moves, flagging big cost changes.
  _drConfirm() {
    const supplierId = document.getElementById('dr-supplier')?.value;
    const branchSel = document.getElementById('dr-branch');
    const branchId = branchSel?.value || '';
    if (!supplierId) return this.alert('Choose the supplier', 'error');
    if (branchSel && branchSel.options.length && !branchId) return this.alert('Choose the branch receiving the goods', 'error');
    const lines = this._dr.lines;
    if (!lines.length) return this.alert('Add at least one item', 'error');
    for (const l of lines) {
      const q = Number(l.qty);
      if (!(q > 0) || (!l.choice.allow_decimal && !Number.isInteger(q))) return this.alert(`Enter a ${l.choice.allow_decimal ? '' : 'whole '}quantity for ${l.p.name}`, 'error');
      if (l.cost === '' || !(Number(l.cost) >= 0)) return this.alert(`Enter the unit cost for ${l.p.name}`, 'error');
    }
    const supplier = this._dr.suppliers.find(s => String(s.id) === String(supplierId));
    const branch = (this.currentUser.branches || []).find(b => String(b.id) === String(branchId));
    this._drPending = {
      supplier_id: Number(supplierId), branch_id: branchId ? Number(branchId) : null,
      vendor_invoice_number: document.getElementById('dr-invoice')?.value.trim() || null,
      notes: document.getElementById('dr-notes')?.value.trim() || null,
      items: lines.map(l => ({ product_id: l.p.id, uom_id: l.choice.isBase ? null : l.choice.uom_id, quantity: Number(l.qty), unit_cost: Number(l.cost), tax_option: l.tax })),
    };
    let sub = 0, tax = 0;
    const rows = lines.map(l => {
      const v = this._drLineValues(l);
      sub += v.net; tax += v.tax;
      const newStockCost = (Number(l.cost) || 0) / (l.choice.factor || 1);
      const oldCost = Number(l.p.cost) || 0;
      const change = oldCost > 0 ? (newStockCost - oldCost) / oldCost : 0;
      const flag = oldCost > 0 && Math.abs(change) >= 0.25 ? ` <span class="badge-pill ${change > 0 ? 'badge-danger' : 'badge-warning'}" style="font-size:10px">cost ${change > 0 ? '+' : ''}${Math.round(change * 100)}%</span>` : '';
      return `<tr><td>${this.escapeAttr(l.p.name)}${l.choice.label ? ` <span style="font-size:11px;color:var(--text-muted)">(${this.escapeAttr(l.choice.label)})</span>` : ''}</td>
        <td style="text-align:right;font-weight:700">${l.qty}</td>
        <td style="text-align:right">${this.fmt(l.cost)}${flag}<div style="font-size:11px;color:var(--text-muted)">was ${this.fmt(oldCost * (l.choice.factor || 1))}</div></td>
        <td style="text-align:right">${this.fmt(v.net)}</td></tr>`;
    }).join('');
    this.showSecondaryModal(`
      <div class="modal" style="max-width:680px">
        <div class="modal-header"><span class="modal-title">Confirm Receipt — ${this.escapeAttr(supplier?.name || '')}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">Check these against what's physically here and the supplier's invoice. Receiving puts the stock on hand${branch ? ` at <strong>${this.escapeAttr(branch.name)}</strong>` : ''} and sets each item's cost to the unit cost below${supplier && supplier.sync_ap !== 0 && supplier.voucher_default !== 'Not vouchered' ? ', and raises an A/P bill' : ''}.</p>
          <table class="data-table" style="width:100%">
            <thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit cost</th><th style="text-align:right">Line</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="text-align:right;margin-top:10px">Subtotal ${this.fmt(sub)} · GCT ${this.fmt(tax)} · <strong>Total ${this.fmt(sub + tax)}</strong></div>
          ${this._drPending.vendor_invoice_number ? '' : '<p style="font-size:12px;color:var(--warning,#b7791f);margin:10px 0 0">No supplier invoice number entered — A/P will need it to match the bill.</p>'}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Back — Change</button>
          <button class="btn btn-success" id="dr-submit-btn" onclick="App._drSubmit()">Counts Are Correct — Receive</button>
        </div>
      </div>`);
  },

  async _drSubmit(allowDuplicate) {
    const body = this._drPending;
    if (!body) return;
    const btn = document.getElementById('dr-submit-btn');
    if (btn) btn.disabled = true;
    try {
      const r = await this.api('POST', '/direct-receipts', { ...body, allow_duplicate_invoice: !!allowDuplicate });
      this._drPending = null;
      this.closeSecondaryModal();
      this.closeModal();
      this.alert(`${r.receipt_number} received — stock updated${r.bill_number ? `, A/P bill ${r.bill_number} raised` : ''}`);
      if (this.section === 'purchasing' || this.section === 'purchase-requests') this.renderPurchasing('direct');
      this.viewDirectReceipt(r.id);
    } catch (e) {
      if (btn) btn.disabled = false;
      if (/already on/.test(e.message) && !allowDuplicate) {
        if (confirm(`${e.message}\n\nReceive it anyway?`)) return this._drSubmit(true);
        return;
      }
      this.alert(e.message, 'error');
    }
  },

  async viewDirectReceipt(id) {
    const r = await this.api('GET', `/direct-receipts/${id}`);
    this._drView = r;
    const ul = l => this._orderLineUnit({ product_name: l.product_name, purchase_unit: l.purchase_unit, units_per: l.units_per });
    this.showModal(`
      <div class="modal" style="max-width:860px">
        <div class="modal-header"><span class="modal-title">${r.receipt_number} — Received Without PO</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${r.status === 'reversed' ? `<div style="background:rgba(244,67,54,.08);border:1px solid var(--danger);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px"><strong>Reversed</strong> ${this.fmtDateTime(r.reversed_at)} by ${this.escapeAttr(r.reversed_by_name || '—')}: ${this.escapeAttr(r.reverse_reason || '')}</div>` : ''}
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 16px;font-size:13px;margin-bottom:12px">
            <div><span style="color:var(--text-muted)">Supplier</span><div class="fw-600">${this.escapeAttr(r.supplier_name || '—')}</div></div>
            <div><span style="color:var(--text-muted)">Supplier invoice #</span><div class="fw-600">${this.escapeAttr(r.vendor_invoice_number || '—')}</div></div>
            <div><span style="color:var(--text-muted)">Branch</span><div class="fw-600">${this.escapeAttr(r.branch_name || '—')}</div></div>
            <div><span style="color:var(--text-muted)">Received</span><div class="fw-600">${this.fmtDateTime(r.received_at)} · ${this.escapeAttr(r.received_by_name || '—')}</div></div>
            <div><span style="color:var(--text-muted)">A/P bill</span><div class="fw-600">${r.bill_number ? `${r.bill_number}${r.bill_status === 'void' ? ' (void)' : ''}` : 'None — vendor not synced with A/P'}</div></div>
          </div>
          <table class="data-table" style="width:100%">
            <thead><tr><th>Item</th><th>Unit</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit cost</th><th>Tax</th><th style="text-align:right">Line</th><th style="text-align:right">Item cost was → now</th></tr></thead>
            <tbody>${r.items.map(l => `<tr>
              <td>${this.escapeAttr(ul(l).name)}${l.sku ? `<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(l.sku)}</div>` : ''}</td>
              <td>${this.escapeAttr(ul(l).unit)}</td>
              <td style="text-align:right">${l.quantity}</td>
              <td style="text-align:right">${this.fmt(l.unit_cost)}</td>
              <td>${l.tax_option === 'local' ? `GCT ${l.tax_rate}%` : 'No tax'}</td>
              <td style="text-align:right">${this.fmt(l.total)}</td>
              <td style="text-align:right;font-size:12px;color:var(--text-muted)">${l.prev_cost != null ? this.fmt(l.prev_cost) : '—'} → ${l.new_cost != null ? this.fmt(l.new_cost) : '—'}</td>
            </tr>`).join('')}</tbody>
          </table>
          <div style="text-align:right;margin-top:10px">Subtotal ${this.fmt(r.subtotal)} · GCT ${this.fmt(r.tax_amount)} · <strong>Total ${this.fmt(r.total)}</strong></div>
          ${r.notes ? `<div style="margin-top:12px;font-size:13px"><span style="color:var(--text-muted)">Notes</span><div style="white-space:pre-wrap">${this.escapeAttr(r.notes)}</div></div>` : ''}
        </div>
        <div class="modal-footer">
          ${r.status === 'received' ? `<button class="btn btn-danger" onclick="App.showReverseDirectReceipt(${r.id})">Reverse Receipt</button>` : ''}
          <button class="btn btn-outline" onclick="App.printDirectReceipt()">Print</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  printDirectReceipt() {
    const r = this._drView;
    if (!r) return;
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    const ul = l => this._orderLineUnit({ product_name: l.product_name, purchase_unit: l.purchase_unit, units_per: l.units_per });
    const company = this.settings?.store_name || '';
    const win = window.open('', '_blank', 'width=850,height=1000');
    if (!win) return this.alert('Allow popups to print', 'error');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(r.receipt_number)}</title>
<style>body{font-family:Arial,sans-serif;font-size:13px;color:#111;margin:24px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{border-bottom:1px solid #ccc;padding:6px;text-align:left}th{background:#f2f2f2}.r{text-align:right}.grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-top:14px}.muted{color:#666}.sig{display:flex;gap:40px;margin-top:48px}.sig div{flex:1;border-top:1px solid #000;padding-top:4px}@media print{.noprint{display:none}}</style></head><body>
<div class="noprint" style="margin-bottom:12px"><button onclick="window.print()">Print</button> <button onclick="window.close()">Close</button></div>
<div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div class="muted">${esc(company)}</div><h1>Goods Received — No PO</h1></div><div style="text-align:right"><strong style="font-size:16px">${esc(r.receipt_number)}</strong>${r.status === 'reversed' ? '<div style="color:#c00;font-weight:700">REVERSED</div>' : ''}</div></div>
<div class="grid">
<div><span class="muted">Supplier:</span> <strong>${esc(r.supplier_name)}</strong></div>
<div><span class="muted">Supplier invoice #:</span> ${esc(r.vendor_invoice_number || '—')}</div>
<div><span class="muted">Branch:</span> ${esc(r.branch_name || '—')}</div>
<div><span class="muted">Received:</span> ${esc(this.fmtDateTime(r.received_at))} by ${esc(r.received_by_name || '—')}</div>
<div><span class="muted">A/P bill:</span> ${esc(r.bill_number || '—')}</div>
</div>
<table><thead><tr><th>Item</th><th>SKU</th><th>Unit</th><th class="r">Qty</th><th class="r">Unit cost</th><th class="r">Tax</th><th class="r">Line</th></tr></thead><tbody>
${r.items.map(l => `<tr><td>${esc(ul(l).name)}</td><td>${esc(l.sku || '')}</td><td>${esc(ul(l).unit)}</td><td class="r">${l.quantity}</td><td class="r">${esc(this.fmt(l.unit_cost))}</td><td class="r">${l.tax_option === 'local' ? esc(this.fmt(l.tax_amount)) : '—'}</td><td class="r">${esc(this.fmt(l.total))}</td></tr>`).join('')}
</tbody></table>
<div style="text-align:right;margin-top:10px">Subtotal ${esc(this.fmt(r.subtotal))} &nbsp; GCT ${esc(this.fmt(r.tax_amount))} &nbsp; <strong>Total ${esc(this.fmt(r.total))}</strong></div>
${r.notes ? `<p><span class="muted">Notes:</span> ${esc(r.notes)}</p>` : ''}
<div class="sig"><div>Received by</div><div>Delivered by</div></div>
</body></html>`);
    win.document.close();
  },

  showReverseDirectReceipt(id) {
    this.showSecondaryModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">Reverse Receipt</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">The received stock comes back off the shelf, each item's cost goes back to what it was (unless it has changed since), and the receipt's A/P bill is voided. Refused if the stock has already been sold or moved, or the bill has payments.</p>
          <div class="form-group"><label>Reason *</label><textarea id="dr-reverse-reason" rows="3" placeholder="e.g. Entered against the wrong supplier"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App._submitReverseDirectReceipt(${id})">Reverse</button>
        </div>
      </div>`);
  },

  async _submitReverseDirectReceipt(id) {
    const reason = document.getElementById('dr-reverse-reason')?.value.trim();
    if (!reason) return this.alert('Enter the reason', 'error');
    try {
      await this.api('POST', `/direct-receipts/${id}/reverse`, { reason });
      this.closeSecondaryModal();
      this.alert('Receipt reversed');
      if (this.section === 'purchasing' || this.section === 'purchase-requests') this._loadDirectReceiptList();
      this.viewDirectReceipt(id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // Reverse one logged receipt (its A/P bill is voided with it), or — for
  // goods received before receipts were logged — per-line quantities.
  showReversePOReceipt(poId, receiptId) {
    this.showSecondaryModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">Reverse Receipt</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">The received stock comes back off the shelf, the product cost goes back to what it was, and the receipt's A/P bill is voided. The PO can then be received again.</p>
          <div class="form-group"><label>Reason *</label><textarea id="rev-rcpt-reason" rows="2" placeholder="e.g. Counted wrong — received 12 instead of 10"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App.confirmReversePOReceipt(${poId}, ${receiptId})">Reverse Receipt</button>
        </div>
      </div>`);
  },

  async confirmReversePOReceipt(poId, receiptId) {
    const reason = document.getElementById('rev-rcpt-reason').value.trim();
    if (!reason) { this.alert('Enter the reason for reversing this receipt', 'error'); return; }
    try {
      await this.api('POST', `/purchase-orders/${poId}/receipts/${receiptId}/reverse`, { reason });
      this.closeSecondaryModal();
      this.alert('Receipt reversed — the PO can be received again');
      this.viewPO(poId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showReverseUnloggedReceipt(poId) {
    const po = await this.api('GET', `/purchase-orders/${poId}`);
    const lines = po.items.filter(i => i.quantity_unlogged > 0);
    this.showSecondaryModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">Reverse Earlier Receiving — ${po.po_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">These goods were received before receipts were logged. Enter how much to take back off each line. Their A/P bill isn't tied to a receipt, so void it in Accounts Payable yourself if needed before receiving again.</p>
          ${lines.map(i => `
            <div class="po-receive-row">
              <div style="flex:1">
                <div class="fw-600">${this.escapeAttr(i.product_name)}</div>
                <div style="font-size:12px;color:var(--text-muted)">Received earlier: ${i.quantity_unlogged}${i.quantity_damaged ? ` | Damaged: ${i.quantity_damaged}` : ''}</div>
              </div>
              <input id="revu-${i.id}" type="number" min="0" step="any" max="${i.quantity_unlogged}" value="0" style="width:80px">
            </div>`).join('')}
          <div class="form-group" style="margin-top:14px"><label>Reason *</label><textarea id="revu-reason" rows="2"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App.confirmReverseUnloggedReceipt(${po.id}, [${lines.map(i => i.id).join(',')}])">Reverse</button>
        </div>
      </div>`);
  },

  async confirmReverseUnloggedReceipt(poId, itemIds) {
    const reason = document.getElementById('revu-reason').value.trim();
    const items = itemIds.map(id => ({ item_id: id, quantity: Number(document.getElementById(`revu-${id}`).value) || 0 })).filter(i => i.quantity > 0);
    if (!items.length) { this.alert('Enter at least one quantity to reverse', 'error'); return; }
    if (!reason) { this.alert('Enter the reason for the reversal', 'error'); return; }
    try {
      await this.api('POST', `/purchase-orders/${poId}/reverse-unlogged`, { items, reason });
      this.closeSecondaryModal();
      this.alert('Receiving reversed — the PO can be received again');
      this.viewPO(poId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showProcessDamaged(id) {
    const po = await this.api('GET', `/purchase-orders/${id}`);
    const receivedItems = po.items.filter(i => i.item_type !== 'service' && (i.quantity_received||0) - (i.quantity_damaged||0) > 0);
    if (!receivedItems.length) { this.alert('No received items available to process as damaged', 'warning'); return; }
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">Process Damaged Goods - ${po.po_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Enter quantities to mark damaged. This will remove them from stock. Damaged goods already recorded are excluded from the available count below.</p>
          ${receivedItems.map(i => `
            <div class="po-receive-row">
              <div style="flex:1">
                <div class="fw-600">${i.product_name}</div>
                <div style="font-size:12px;color:var(--text-muted)">Received: ${i.quantity_received||0} | Already Damaged: ${i.quantity_damaged||0} | Available: ${(i.quantity_received||0)-(i.quantity_damaged||0)}</div>
              </div>
              <input id="dmg-${i.id}" type="number" min="0" max="${(i.quantity_received||0)-(i.quantity_damaged||0)}" value="0" style="width:80px" placeholder="Qty">
            </div>`).join('')}
          <div class="form-group" style="margin-top:14px">
            <label>Reason / Notes</label>
            <textarea id="dmg-reason" rows="2" placeholder="e.g. Crushed in transit"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App.confirmProcessDamaged(${po.id}, [${receivedItems.map(i=>i.id).join(',')}])">Confirm Damaged</button>
        </div>
      </div>`);
  },

  async confirmProcessDamaged(poId, itemIds) {
    const reason = document.getElementById('dmg-reason').value.trim();
    const items = itemIds.map(id => ({ item_id: id, quantity_damaged: parseInt(document.getElementById(`dmg-${id}`).value) || 0, reason })).filter(i => i.quantity_damaged > 0);
    if (!items.length) { this.alert('Enter at least one quantity', 'error'); return; }
    try {
      await this.api('PATCH', `/purchase-orders/${poId}/damage`, { items });
      this.closeModal();
      this.alert('Damaged goods processed and stock adjusted');
      this.renderPurchasing();
    } catch(e) { this.alert(e.message, 'error'); }
  },

});
