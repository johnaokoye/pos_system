// Consignment — supplier-owned stock: agreements, orders, Consignment GRNs and the consignment stock report (routes/consignment.js).
Object.assign(App, {
  _consCanOpen() { return this.can('consignment') || this.can('consignment_finance'); },
  _consStatusBadge: { draft: 'badge-secondary', submitted: 'badge-warning', approved: 'badge-success', rejected: 'badge-danger', ended: 'badge-secondary',
    open: 'badge-info', partial: 'badge-warning', received: 'badge-success', cancelled: 'badge-secondary', pending: 'badge-warning' },
  _consStatusLabel: { draft: 'Draft', submitted: 'Awaiting Finance', approved: 'Approved', rejected: 'Rejected', ended: 'Ended',
    open: 'Open', partial: 'Part received', received: 'Received', cancelled: 'Cancelled', pending: 'Awaiting approval' },
  _consResp: { supplier: 'Supplier', total_tools: 'Total Tools' },

  async renderConsignment(tab) {
    this._consTab = tab || this._consTab || 'agreements';
    const c = document.getElementById('content');
    const tabs = [['agreements', 'Agreements'], ['orders', 'Orders'], ['grns', 'Goods Received (GRN)'], ['stock', 'Consignment Stock'], ['recon', 'Month-End Reconciliation']];
    c.innerHTML = `
      <div class="page-header"><h2>Consignment</h2>
        <div style="display:flex;gap:8px">
          ${this.can('consignment_agreements') ? `<button class="btn btn-primary" onclick="App.showConsAgreementForm()">+ New Agreement</button><button class="btn btn-outline" onclick="App.showConsOrderForm()">+ New Order</button>` : ''}
        </div></div>
      <div class="tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        ${tabs.map(([k, l]) => `<button class="btn btn-sm ${this._consTab === k ? 'btn-primary' : 'btn-outline'}" onclick="App.renderConsignment('${k}')">${l}</button>`).join('')}
      </div>
      <div id="cons-banner"></div>
      <div id="cons-body"><div class="card"><p class="empty-state">Loading…</p></div></div>`;
    this.api('GET', '/consignment/status').then(st => {
      const b = document.getElementById('cons-banner');
      if (b && !st.enabled) b.innerHTML = '<div class="card" style="border-color:var(--warning, #d97706);margin-bottom:12px;font-size:13px"><strong>Consignment is still being built and tested.</strong> It isn\'t in use on this system yet — anything entered here is for trying it out, and no stock can go on hand.</div>';
    }).catch(() => {});
    try {
      if (this._consTab === 'agreements') await this._consAgreementsTab();
      else if (this._consTab === 'orders') await this._consOrdersTab();
      else if (this._consTab === 'grns') await this._consGrnsTab();
      else if (this._consTab === 'recon') await this._consReconTab();
      else await this._consStockTab();
    } catch (e) {
      const el = document.getElementById('cons-body');
      if (el) el.innerHTML = `<div class="card" style="color:var(--danger)">${this.escapeAttr(e.message)}</div>`;
    }
  },

  _consBadge(s) { return `<span class="badge-pill ${this._consStatusBadge[s] || ''}">${this._consStatusLabel[s] || s}</span>`; },

  async _consAgreementsTab() {
    const rows = await this.api('GET', '/consignment/agreements');
    const el = document.getElementById('cons-body');
    if (!el) return;
    el.innerHTML = `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Agreement #</th><th>Supplier</th><th>From</th><th>To</th><th>Items</th><th>Revenue</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map(a => `<tr style="cursor:pointer" onclick="App.viewConsAgreement(${a.id})">
        <td class="fw-600">${a.agreement_number}</td><td>${this.escapeAttr(a.supplier_name)}</td><td>${this.fmtDate(a.start_date)}</td><td>${a.end_date ? this.fmtDate(a.end_date) : '—'}</td>
        <td>${a.item_count}</td><td>${a.revenue_treatment ? (a.revenue_treatment === 'principal' ? 'Principal' : 'Agent') : '<span style="color:var(--text-muted)">not set</span>'}</td><td>${this._consBadge(a.status)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="empty-state">No consignment agreements yet</td></tr>'}</tbody></table></div></div>`;
  },

  async showConsAgreementForm(id) {
    const [a, suppliers, products] = await Promise.all([
      id ? this.api('GET', `/consignment/agreements/${id}`) : null,
      this.api('GET', '/suppliers'),
      this.api('GET', '/products?active=1'),
    ]);
    this._consProducts = products.filter(p => !p.is_rental && !p.is_service && !p.is_non_inventory);
    const v = a || { start_date: this._storeDay(new Date()), shortage_responsibility: 'supplier', damage_responsibility: 'supplier', items: [] };
    const esc = x => this.escapeAttr(x ?? '');
    const resp = (id2, val) => `<select id="${id2}">${Object.entries(this._consResp).map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">${a ? `Edit ${a.agreement_number}` : 'New Consignment Agreement'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>Supplier *</label><select id="ca-supplier" data-searchable><option value="">Choose…</option>${suppliers.map(s => `<option value="${s.id}" ${Number(v.supplier_id) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
            <div class="form-group"><label>Starts *</label><input id="ca-start" type="date" value="${esc(v.start_date)}"></div>
            <div class="form-group"><label>Ends</label><input id="ca-end" type="date" value="${esc(v.end_date)}"></div>
          </div>
          <div class="form-group"><label>Ownership terms *</label><textarea id="ca-ownership" rows="2" style="width:100%" placeholder="e.g. Stock remains the supplier's until sold to a customer">${esc(v.ownership_terms)}</textarea></div>
          <div class="form-group"><label>What makes a quantity billable</label><textarea id="ca-billable" rows="2" style="width:100%">${esc(v.billable_rule || 'Qualifying sales less eligible returns, plus approved shortages or damage Total Tools is responsible for')}</textarea><div style="font-size:11px;color:var(--text-muted)">Billing trigger: a completed sale.</div></div>
          <div class="input-row">
            <div class="form-group"><label>Shortages are the responsibility of</label>${resp('ca-short', v.shortage_responsibility)}</div>
            <div class="form-group"><label>Damage is the responsibility of</label>${resp('ca-damage', v.damage_responsibility)}</div>
            <div class="form-group"><label>Settlement</label><select id="ca-freq" disabled><option>Monthly</option></select></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Payment terms</label><input id="ca-terms" value="${esc(v.payment_terms)}" placeholder="e.g. Net 30 after settlement"></div>
            <div class="form-group" style="display:flex;flex-direction:column;gap:6px;justify-content:flex-end">
              <label style="font-weight:400"><input type="checkbox" id="ca-wo" ${v.allow_work_orders ? 'checked' : ''}> Parts may be issued to work orders</label>
              <label style="font-weight:400"><input type="checkbox" id="ca-shop" ${v.allow_shop_use ? 'checked' : ''}> May be taken for shop use</label>
            </div>
          </div>
          <div style="font-weight:600;font-size:13px;margin:6px 0">Items and agreed costs (per stock unit)</div>
          <div id="ca-items"></div>
          <button class="btn btn-sm btn-outline" onclick="App._consAddItemRow()">+ Add Item</button>
          <div class="form-group" style="margin-top:10px"><label>Notes</label><input id="ca-notes" value="${esc(v.notes)}"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-outline" onclick="App._consSaveAgreement(${a ? a.id : 'null'}, false)">Save Draft</button>
          <button class="btn btn-primary" onclick="App._consSaveAgreement(${a ? a.id : 'null'}, true)">Submit to Finance</button>
        </div>
      </div>`);
    (v.items.length ? v.items : [{}]).forEach(it => this._consAddItemRow(it));
  },

  _consAddItemRow(it = {}) {
    const box = document.getElementById('ca-items');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'ca-item';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
    row.innerHTML = `<select class="ca-prod" data-searchable style="flex:1;min-width:0"><option value="">Choose item…</option>${(this._consProducts || []).map(p => `<option value="${p.id}" ${Number(it.product_id) === p.id ? 'selected' : ''}>${this.escapeAttr(p.name)}${p.sku ? ` (${this.escapeAttr(p.sku)})` : ''}</option>`).join('')}</select>
      <input class="ca-cost" type="number" step="0.01" min="0" placeholder="Agreed cost" value="${it.current_cost ?? it.cost ?? ''}" style="width:130px">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.remove()">✕</button>`;
    box.appendChild(row);
  },

  async _consSaveAgreement(id, submit) {
    const val = i => document.getElementById(i)?.value ?? '';
    const body = {
      supplier_id: val('ca-supplier'), start_date: val('ca-start'), end_date: val('ca-end'), ownership_terms: val('ca-ownership'), billable_rule: val('ca-billable'),
      shortage_responsibility: val('ca-short'), damage_responsibility: val('ca-damage'), payment_terms: val('ca-terms'), notes: val('ca-notes'),
      allow_work_orders: document.getElementById('ca-wo').checked, allow_shop_use: document.getElementById('ca-shop').checked, submit,
      items: [...document.querySelectorAll('.ca-item')].map(r => ({ product_id: r.querySelector('.ca-prod').value, cost: r.querySelector('.ca-cost').value })).filter(i => i.product_id),
    };
    try {
      const a = await this.api(id ? 'PUT' : 'POST', id ? `/consignment/agreements/${id}` : '/consignment/agreements', body);
      this.alert(`${a.agreement_number} ${submit ? 'submitted to Finance' : 'saved'}`, 'success');
      this.renderConsignment('agreements');
      this.viewConsAgreement(a.id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async viewConsAgreement(id) {
    let a;
    try { a = await this.api('GET', `/consignment/agreements/${id}`); } catch (e) { this.alert(e.message, 'error'); return; }
    const esc = x => this.escapeAttr(x ?? '');
    const fin = this.can('consignment_finance');
    const mine = Number(a.created_by) === Number(this.currentUser?.id);
    const btns = [];
    if (['draft', 'rejected'].includes(a.status) && this.can('consignment_agreements')) btns.push(`<button class="btn btn-outline" onclick="App.showConsAgreementForm(${a.id})">Edit</button>`);
    if (a.status === 'draft' && this.can('consignment_agreements')) btns.push(`<button class="btn btn-primary" onclick="App._consAgreementAction(${a.id}, 'submit')">Submit to Finance</button>`);
    if (a.status === 'submitted' && fin) {
      btns.push(`<button class="btn btn-danger" onclick="App._consRejectAgreement(${a.id})">Reject</button>`);
      if (!mine) btns.push(`<button class="btn btn-success" ${a.revenue_treatment ? '' : 'disabled title="Set the revenue and GCT treatment first"'} onclick="App._consApproveAgreement(${a.id})">Approve</button>`);
    }
    if (a.status === 'approved' && this.can('consignment_agreements')) btns.push(`<button class="btn btn-outline" onclick="App._consAgreementAction(${a.id}, 'end')">End Agreement</button>`);
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">Consignment Agreement ${a.agreement_number}</span><div style="display:flex;gap:8px;align-items:center">${this._consBadge(a.status)}<button class="modal-close">✕</button></div></div>
        <div class="modal-body" style="font-size:13px">
          ${a.status === 'rejected' ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;margin-bottom:12px;color:#991b1b"><strong>Rejected</strong> by ${esc(a.rejected_by_name)}: ${esc(a.rejection_reason)}</div>` : ''}
          <div class="two-col" style="margin-bottom:12px">
            <div><strong>Supplier:</strong> ${esc(a.supplier_name)}<br><strong>Term:</strong> ${this.fmtDate(a.start_date)} – ${a.end_date ? this.fmtDate(a.end_date) : 'open'}<br>
              <strong>Settlement:</strong> Monthly<br><strong>Payment terms:</strong> ${esc(a.payment_terms || '—')}</div>
            <div><strong>Shortages:</strong> ${this._consResp[a.shortage_responsibility]} · <strong>Damage:</strong> ${this._consResp[a.damage_responsibility]}<br>
              <strong>Work orders:</strong> ${a.allow_work_orders ? 'allowed' : 'not allowed'} · <strong>Shop use:</strong> ${a.allow_shop_use ? 'allowed' : 'not allowed'}<br>
              <strong>Drafted by:</strong> ${esc(a.created_by_name || '—')}${a.approved_at ? `<br><strong>Approved:</strong> ${esc(a.approved_by_name)} · ${this.fmtDate(a.approved_at)}` : ''}</div>
          </div>
          <div style="margin-bottom:8px"><strong>Ownership terms:</strong> ${esc(a.ownership_terms)}</div>
          <div style="margin-bottom:12px"><strong>Billable:</strong> ${esc(a.billable_rule)} <span style="color:var(--text-muted)">(trigger: a completed sale)</span></div>
          <div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:12px">
            <strong>Finance — revenue and output GCT</strong>
            ${a.revenue_treatment ? `<div style="margin-top:4px">${a.revenue_treatment === 'principal' ? 'Principal — gross sales revenue, excluding GCT' : 'Agent — revenue is the commission or fee'} · Output GCT: ${esc(a.output_gct_treatment)}${a.finance_notes ? `<br><span style="color:var(--text-muted)">${esc(a.finance_notes)}</span>` : ''}<div style="font-size:11px;color:var(--text-muted)">Set by ${esc(a.finance_set_by_name || '—')} · ${this.fmtDateTime(a.finance_set_at)}</div></div>` : '<div style="color:var(--warning, #d97706);margin-top:4px">Not set yet — Finance sets it before approving.</div>'}
            ${fin && ['draft', 'submitted'].includes(a.status) ? `<div class="input-row" style="margin-top:8px">
              <div class="form-group"><label>Revenue treatment *</label><select id="caf-rev"><option value="">Choose…</option><option value="principal" ${a.revenue_treatment === 'principal' ? 'selected' : ''}>Principal (gross revenue ex GCT)</option><option value="agent" ${a.revenue_treatment === 'agent' ? 'selected' : ''}>Agent (commission / fee)</option></select></div>
              <div class="form-group"><label>Output GCT treatment *</label><input id="caf-gct" value="${esc(a.output_gct_treatment)}" placeholder="e.g. Standard 15% on full selling price"></div></div>
              <div class="form-group"><label>Finance notes</label><input id="caf-notes" value="${esc(a.finance_notes)}"></div>
              <button class="btn btn-sm btn-primary" onclick="App._consSetFinance(${a.id})">Save Treatment</button>` : ''}
          </div>
          <div style="font-weight:600;margin-bottom:4px">Items and agreed costs</div>
          <table style="width:100%"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Item</th><th style="text-align:right">Cost now</th><th style="text-align:left;padding-left:12px">History (effective from)</th></tr></thead>
            <tbody>${a.items.map(it => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0">${esc(it.product_name)}${it.sku ? ` <span style="color:var(--text-muted)">${esc(it.sku)}</span>` : ''}</td>
              <td style="text-align:right" class="fw-600">${it.current_cost != null ? this.fmt(it.current_cost) : '—'}</td>
              <td style="padding-left:12px;font-size:12px">${it.costs.map(c => `${this.fmt(c.cost)} from ${this.fmtDate(c.effective_from)}`).join(' · ')}</td></tr>`).join('')}</tbody></table>
          ${a.status === 'approved' && this.can('consignment_agreements') ? `<div class="input-row" style="margin-top:10px;align-items:flex-end">
            <div class="form-group"><label>New agreed cost for</label><select id="cac-prod">${a.items.map(it => `<option value="${it.product_id}">${esc(it.product_name)}</option>`).join('')}</select></div>
            <div class="form-group"><label>Cost</label><input id="cac-cost" type="number" step="0.01" min="0" style="width:120px"></div>
            <div class="form-group"><label>Effective from</label><input id="cac-date" type="date"></div>
            <div class="form-group"><button class="btn btn-sm btn-outline" onclick="App._consAddCost(${a.id})">Add Cost</button></div></div>` : ''}
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">${btns.join('')}<button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  async _consAgreementAction(id, action) {
    try { await this.api('POST', `/consignment/agreements/${id}/${action}`, {}); this.renderConsignment('agreements'); this.viewConsAgreement(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },
  async _consSetFinance(id) {
    try {
      await this.api('POST', `/consignment/agreements/${id}/finance`, { revenue_treatment: document.getElementById('caf-rev').value, output_gct_treatment: document.getElementById('caf-gct').value, finance_notes: document.getElementById('caf-notes').value });
      this.viewConsAgreement(id);
    } catch (e) { this.alert(e.message, 'error'); }
  },
  async _consRejectAgreement(id) {
    const reason = prompt('Reason for rejecting this agreement:');
    if (reason == null) return;
    try { await this.api('POST', `/consignment/agreements/${id}/reject`, { reason }); this.renderConsignment('agreements'); this.viewConsAgreement(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },
  _consApproveAgreement(id) {
    this._showApprovalDialog({
      title: 'Approve Consignment Agreement',
      intro: 'Once approved, stock can be ordered and received on it. Your signature is recorded.',
      approve: async (signature) => {
        await this.api('POST', `/consignment/agreements/${id}/approve`, { signature });
        this.alert('Agreement approved', 'success');
        this.renderConsignment('agreements');
        this.viewConsAgreement(id);
      },
    });
  },
  async _consAddCost(id) {
    try {
      await this.api('POST', `/consignment/agreements/${id}/costs`, { product_id: document.getElementById('cac-prod').value, cost: document.getElementById('cac-cost').value, effective_from: document.getElementById('cac-date').value });
      this.viewConsAgreement(id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Orders ──
  async _consOrdersTab() {
    const rows = await this.api('GET', '/consignment/orders');
    const el = document.getElementById('cons-body');
    if (!el) return;
    el.innerHTML = `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Order #</th><th>Agreement</th><th>Supplier</th><th>Branch</th><th>Expected</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map(o => `<tr style="cursor:pointer" onclick="App.viewConsOrder(${o.id})"><td class="fw-600">${o.order_number}</td><td>${o.agreement_number}</td>
        <td>${this.escapeAttr(o.supplier_name)}</td><td>${this.escapeAttr(o.branch_name)}</td><td>${o.expected_date ? this.fmtDate(o.expected_date) : '—'}</td><td>${this._consBadge(o.status)}</td></tr>`).join('')
        : '<tr><td colspan="6" class="empty-state">No consignment orders yet</td></tr>'}</tbody></table></div></div>`;
  },

  async showConsOrderForm() {
    const [agreements, branches] = await Promise.all([this.api('GET', '/consignment/agreements?status=approved'), this.api('GET', '/branches')]);
    if (!agreements.length) { this.alert('There are no approved consignment agreements to order on yet', 'warning'); return; }
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">New Consignment Order</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>Agreement *</label><select id="co-agr" onchange="App._consOrderAgreementChanged()"><option value="">Choose…</option>${agreements.map(a => `<option value="${a.id}">${a.agreement_number} — ${this.escapeAttr(a.supplier_name)}</option>`).join('')}</select></div>
            <div class="form-group"><label>Receiving branch *</label><select id="co-branch">${branches.filter(b => b.active !== 0).map(b => `<option value="${b.id}">${this.escapeAttr(b.name)}</option>`).join('')}</select></div>
            <div class="form-group"><label>Expected</label><input id="co-date" type="date"></div>
          </div>
          <div id="co-items" style="font-size:13px;color:var(--text-muted)">Choose the agreement to list its items.</div>
          <div class="form-group" style="margin-top:8px"><label>Notes</label><input id="co-notes"></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="App._consSaveOrder()">Create Order</button></div>
      </div>`);
  },
  async _consOrderAgreementChanged() {
    const id = document.getElementById('co-agr').value;
    const box = document.getElementById('co-items');
    if (!id) { box.innerHTML = ''; return; }
    const a = await this.api('GET', `/consignment/agreements/${id}`);
    box.innerHTML = `<table style="width:100%"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Item</th><th style="text-align:right">Agreed cost</th><th style="text-align:right;width:120px">Quantity</th></tr></thead>
      <tbody>${a.items.filter(i => i.active).map(i => `<tr style="border-top:1px solid var(--border);color:var(--text)"><td style="padding:5px 0">${this.escapeAttr(i.product_name)}</td><td style="text-align:right">${i.current_cost != null ? this.fmt(i.current_cost) : '—'}</td>
        <td style="text-align:right"><input class="co-qty" data-product="${i.product_id}" type="number" min="0" step="1" style="width:100px;text-align:right" placeholder="0"></td></tr>`).join('')}</tbody></table>`;
  },
  async _consSaveOrder() {
    const items = [...document.querySelectorAll('.co-qty')].map(i => ({ product_id: i.dataset.product, quantity: parseFloat(i.value) || 0 })).filter(i => i.quantity > 0);
    try {
      const o = await this.api('POST', '/consignment/orders', { agreement_id: document.getElementById('co-agr').value, branch_id: document.getElementById('co-branch').value, expected_date: document.getElementById('co-date').value, notes: document.getElementById('co-notes').value, items });
      this.alert(`${o.order_number} created`, 'success');
      this.renderConsignment('orders');
      this.viewConsOrder(o.id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async viewConsOrder(id) {
    let o;
    try { o = await this.api('GET', `/consignment/orders/${id}`); } catch (e) { this.alert(e.message, 'error'); return; }
    const esc = x => this.escapeAttr(x ?? '');
    const canReceive = this.can('consignment_receive') && ['open', 'partial'].includes(o.status);
    this.showModal(`
      <div class="modal" style="max-width:720px">
        <div class="modal-header"><span class="modal-title">Consignment Order ${o.order_number}</span><div style="display:flex;gap:8px;align-items:center">${this._consBadge(o.status)}<button class="modal-close">✕</button></div></div>
        <div class="modal-body" style="font-size:13px">
          <div style="margin-bottom:10px"><strong>${esc(o.supplier_name)}</strong> · ${o.agreement_number} · to ${esc(o.branch_name)}${o.expected_date ? ` · expected ${this.fmtDate(o.expected_date)}` : ''}</div>
          <table style="width:100%"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Item</th><th style="text-align:right">Ordered</th><th style="text-align:right">Received</th><th style="text-align:right">Awaiting approval</th><th style="text-align:right">Left</th>${canReceive ? '<th style="text-align:right;width:110px">Receive now</th>' : ''}</tr></thead>
            <tbody>${o.items.map(i => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0">${esc(i.product_name)}</td><td style="text-align:right">${i.quantity_ordered}</td><td style="text-align:right">${i.quantity_received}</td><td style="text-align:right">${i.quantity_pending || 0}</td><td style="text-align:right" class="fw-600">${i.quantity_left}</td>
              ${canReceive ? `<td style="text-align:right"><input class="cg-qty" data-line="${i.id}" type="number" min="0" max="${i.quantity_left}" step="1" style="width:90px;text-align:right" placeholder="0" ${i.quantity_left > 0 ? '' : 'disabled'}></td>` : ''}</tr>`).join('')}</tbody></table>
          ${canReceive ? `<div class="input-row" style="margin-top:10px"><div class="form-group"><label>Supplier delivery note # *</label><input id="cg-note"></div><div class="form-group"><label>Notes</label><input id="cg-notes"></div></div>
            <button class="btn btn-primary btn-sm" onclick="App._consReceive(${o.id})">Enter GRN</button>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">The stock goes on hand once the GRN is approved.</div>` : ''}
          ${o.grns.length ? `<div style="font-weight:600;margin:12px 0 4px">GRNs</div>${o.grns.map(g => `<div style="border-top:1px solid var(--border);padding:4px 0"><a href="#" onclick="event.preventDefault();App.viewConsGrn(${g.id})">${g.grn_number}</a> · delivery note ${esc(g.delivery_note_number)} · ${this._consBadge(g.status)}</div>`).join('')}` : ''}
        </div>
        <div class="modal-footer">${['open', 'partial'].includes(o.status) && this.can('consignment_agreements') ? `<button class="btn btn-outline" onclick="App._consCancelOrder(${o.id})">${o.status === 'partial' ? 'Close (cancel the rest)' : 'Cancel Order'}</button>` : ''}<button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },
  async _consReceive(orderId) {
    const items = [...document.querySelectorAll('.cg-qty')].map(i => ({ order_item_id: i.dataset.line, quantity: parseFloat(i.value) || 0 })).filter(i => i.quantity > 0);
    try {
      const g = await this.api('POST', `/consignment/orders/${orderId}/grns`, { delivery_note_number: document.getElementById('cg-note').value, notes: document.getElementById('cg-notes').value, items });
      this.alert(`${g.grn_number} entered — waiting for approval`, 'success');
      this.viewConsGrn(g.id);
    } catch (e) { this.alert(e.message, 'error'); }
  },
  async _consCancelOrder(id) {
    if (!confirm('Cancel what is left on this order?')) return;
    try { await this.api('POST', `/consignment/orders/${id}/cancel`, {}); this.renderConsignment('orders'); this.viewConsOrder(id); } catch (e) { this.alert(e.message, 'error'); }
  },

  // ── GRNs ──
  async _consGrnsTab() {
    const rows = await this.api('GET', '/consignment/grns');
    const el = document.getElementById('cons-body');
    if (!el) return;
    el.innerHTML = `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>GRN #</th><th>Delivery note</th><th>Order</th><th>Supplier</th><th>Branch</th><th>Received</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map(g => `<tr style="cursor:pointer" onclick="App.viewConsGrn(${g.id})"><td class="fw-600">${g.grn_number}</td><td>${this.escapeAttr(g.delivery_note_number)}</td><td>${g.order_number}</td>
        <td>${this.escapeAttr(g.supplier_name)}</td><td>${this.escapeAttr(g.branch_name)}</td><td>${this.fmtDateTime(g.received_at)}</td><td>${this._consBadge(g.status)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="empty-state">No consignment GRNs yet</td></tr>'}</tbody></table></div></div>`;
  },
  async viewConsGrn(id) {
    let g;
    try { g = await this.api('GET', `/consignment/grns/${id}`); } catch (e) { this.alert(e.message, 'error'); return; }
    const esc = x => this.escapeAttr(x ?? '');
    const canApprove = g.status === 'pending' && this.can('consignment_grn_approve');
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Consignment GRN ${g.grn_number}</span><div style="display:flex;gap:8px;align-items:center">${this._consBadge(g.status)}<button class="modal-close">✕</button></div></div>
        <div class="modal-body" style="font-size:13px">
          <div class="two-col" style="margin-bottom:10px"><div><strong>Supplier:</strong> ${esc(g.supplier_name)}<br><strong>Agreement:</strong> ${g.agreement_number}<br><strong>Order:</strong> ${g.order_number}</div>
            <div><strong>Delivery note:</strong> ${esc(g.delivery_note_number)}<br><strong>Branch:</strong> ${esc(g.branch_name)}<br><strong>Received by:</strong> ${esc(g.received_by_name || '—')} · ${this.fmtDateTime(g.received_at)}
              ${g.approved_at ? `<br><strong>Approved by:</strong> ${esc(g.approved_by_name)} · ${this.fmtDateTime(g.approved_at)}` : ''}${g.rejected_at ? `<br><strong>Rejected by:</strong> ${esc(g.rejected_by_name)}: ${esc(g.rejection_reason)}` : ''}</div></div>
          <table style="width:100%"><tbody>${g.items.map(i => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0">${esc(i.product_name)}</td><td style="text-align:right" class="fw-600">${i.quantity}</td></tr>`).join('')}</tbody></table>
          ${g.notes ? `<div style="margin-top:8px">${esc(g.notes)}</div>` : ''}
          ${canApprove ? '<div style="font-size:12px;color:var(--text-muted);margin-top:8px">Approving puts this stock on hand at the branch, owned by the supplier, and saleable at the POS.</div>' : ''}
        </div>
        <div class="modal-footer">${canApprove ? `<button class="btn btn-danger" onclick="App._consGrnAction(${g.id}, 'reject')">Reject</button><button class="btn btn-success" onclick="App._consGrnAction(${g.id}, 'approve')">Approve GRN</button>` : ''}<button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },
  async _consGrnAction(id, action) {
    let body = {};
    if (action === 'reject') {
      const reason = prompt('Reason for rejecting this GRN:');
      if (reason == null) return;
      body = { reason };
    }
    try {
      await this.api('POST', `/consignment/grns/${id}/${action}`, body);
      this.alert(action === 'approve' ? 'GRN approved — the stock is on hand' : 'GRN rejected', 'success');
      if (this.section === 'consignment') this.renderConsignment('grns');
      this.viewConsGrn(id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Month-end reconciliation ──
  async _consReconTab() {
    const [rows, agreements] = await Promise.all([this.api('GET', '/consignment/reconciliations'), this.api('GET', '/consignment/agreements')]);
    const el = document.getElementById('cons-body');
    if (!el) return;
    const canPrep = this.can('consignment_receive') || this.can('consignment_finance');
    const lastMonth = (() => { const d = new Date(this._storeDay(new Date()) + 'T00:00:00'); d.setDate(0); return d.toISOString().slice(0, 7); })();
    el.innerHTML = `
      ${canPrep ? `<div class="card" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0"><label>Agreement</label><select id="crn-agr">${agreements.filter(a => ['approved', 'ended'].includes(a.status)).map(a => `<option value="${a.id}">${a.agreement_number} — ${this.escapeAttr(a.supplier_name)}</option>`).join('')}</select></div>
        <div class="form-group" style="margin:0"><label>Month</label><input id="crn-month" type="month" value="${lastMonth}"></div>
        <button class="btn btn-primary" onclick="App._consNewRecon()">Prepare Reconciliation</button></div>` : ''}
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Reconciliation #</th><th>Month</th><th>Agreement</th><th>Supplier</th><th style="text-align:right">Billable qty</th><th style="text-align:right">Billable value</th><th>Status</th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `<tr style="cursor:pointer" onclick="App.viewConsRecon(${r.id})"><td class="fw-600">${r.recon_number}</td><td>${r.period}</td><td>${r.agreement_number}</td><td>${this.escapeAttr(r.supplier_name)}</td>
          <td style="text-align:right">${r.totals.billable_qty ?? 0}</td><td style="text-align:right">${this.fmt(r.totals.billable_value || 0)}</td>
          <td><span class="badge-pill ${r.status === 'approved' ? 'badge-success' : 'badge-warning'}">${r.status === 'approved' ? 'Approved — locked' : 'Draft'}</span></td></tr>`).join('')
          : '<tr><td colspan="7" class="empty-state">No reconciliations yet</td></tr>'}</tbody></table></div></div>`;
  },
  async _consNewRecon() {
    try {
      const r = await this.api('POST', '/consignment/reconciliations', { agreement_id: document.getElementById('crn-agr').value, period: document.getElementById('crn-month').value });
      this.renderConsignment('recon');
      this.viewConsRecon(r.id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async viewConsRecon(id) {
    let r;
    try { r = await this.api('GET', `/consignment/reconciliations/${id}`); } catch (e) { this.alert(e.message, 'error'); return; }
    const esc = x => this.escapeAttr(x ?? '');
    const draft = r.status === 'draft';
    const canPrep = draft && (this.can('consignment_receive') || this.can('consignment_finance'));
    const fin = this.can('consignment_finance');
    const n = v => (v == null ? '' : (Math.abs(v) < 0.0005 ? '0' : String(Math.round(v * 1000) / 1000)));
    const stock = r.lines.filter(l => l.line_type === 'stock');
    const transit = r.lines.filter(l => l.line_type === 'in_transit');
    const t = r.totals || {};
    const th = (x, right = true) => `<th style="text-align:${right ? 'right' : 'left'};white-space:nowrap">${x}</th>`;
    this.showModal(`
      <div class="modal" style="max-width:1200px;width:96vw">
        <div class="modal-header"><span class="modal-title">${r.recon_number} — ${esc(r.supplier_name)} · ${r.agreement_number} · ${r.period}</span>
          <div style="display:flex;gap:8px;align-items:center"><span class="badge-pill ${draft ? 'badge-warning' : 'badge-success'}">${draft ? 'Draft' : 'Approved — locked'}</span><button class="modal-close">✕</button></div></div>
        <div class="modal-body" style="font-size:12px">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px;font-size:13px">
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">POS-RECORDED SALES</div><strong>${n(t.pos_sales_qty)} · ${this.fmt(t.pos_sales_value || 0)}</strong>${t.layaway_qty ? `<div style="font-size:11px">+ layaways ${n(t.layaway_qty)} · ${this.fmt(t.layaway_value)}</div>` : ''}</div>
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">RETURNS</div><strong>${n(t.returns_qty)} · ${this.fmt(t.returns_value || 0)}</strong>${t.prior_returns_qty ? `<div style="font-size:11px">+ of earlier months' sales ${n(t.prior_returns_qty)} · ${this.fmt(t.prior_returns_value)}</div>` : ''}</div>
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">COUNT DISCREPANCIES</div><strong>${t.discrepancy_lines || 0} line${t.discrepancy_lines === 1 ? '' : 's'}</strong><div style="font-size:11px">shortage ${n(t.shortage_qty)} · damage ${n(t.damage_qty)}${t.uncounted_lines ? ` · <span style="color:var(--warning, #d97706)">${t.uncounted_lines} not counted</span>` : ''}</div></div>
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">APPROVED BILLABLE</div><strong>${n(t.billable_qty)} · ${this.fmt(t.billable_value || 0)}</strong><div style="font-size:11px">incl. approved shortage ${n(t.approved_shortage_qty)} / damage ${n(t.approved_damage_qty)}</div></div>
            ${t.in_transit ? `<div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">IN TRANSIT AT CUT-OFF</div><strong>${n(t.in_transit)}</strong></div>` : ''}
          </div>
          <div style="font-weight:600;margin-bottom:4px">Stock by branch and item</div>
          <div class="table-wrap"><table style="font-size:12px">
            <thead><tr>${th('Item', false)}${th('Branch', false)}${th('Opening')}${th('Received')}${th('Transfers in')}${th('Transfers out')}${th('POS sales')}${th('Returns')}${th('Layaways')}${th('Shop use')}${th('Damage')}${th('Adjust.')}${th('Expected')}${th('Counted')}${th('Diff.')}</tr></thead>
            <tbody>${stock.map(l => `<tr><td>${esc(l.product_name)}</td><td>${esc(l.branch_name)}</td>${['opening', 'receipts', 'transfers_in', 'transfers_out', 'sales', 'returns', 'layaways', 'shop_use', 'damaged', 'adjustments'].map(c => `<td style="text-align:right">${n(l[c])}</td>`).join('')}
              <td style="text-align:right" class="fw-600">${n(l.expected_closing)}</td>
              <td style="text-align:right">${canPrep ? `<input type="number" min="0" step="1" value="${l.physical_count ?? ''}" style="width:70px;text-align:right" onchange="App._consReconLine(${r.id}, ${l.id}, { physical_count: this.value })">` : n(l.physical_count)}</td>
              <td style="text-align:right;${Math.abs(l.discrepancy) > 0.0005 ? 'color:var(--danger);font-weight:600' : ''}">${l.physical_count == null ? '' : n(l.discrepancy)}</td></tr>`).join('') || '<tr><td colspan="15" class="empty-state">No supplier stock movements this month</td></tr>'}</tbody></table></div>
          ${transit.length ? `<div style="font-weight:600;margin:10px 0 4px">In transit at the cut-off (still the supplier's)</div>${transit.map(l => `<div>${esc(l.product_name)}: <strong>${n(l.in_transit)}</strong></div>`).join('')}` : ''}
          <div style="font-weight:600;margin:12px 0 4px">Billing</div>
          <div class="table-wrap"><table style="font-size:12px">
            <thead><tr>${th('Item', false)}${th('Branch', false)}${th('POS sales')}${th('Layaways paid')}${th('Returns')}${th('Earlier months returned')}${th('Shop use')}${th('Shortage')}${th('Approved shortage')}${th('Damage')}${th('Approved damage')}${th('Billable qty')}${th('Billable value')}</tr></thead>
            <tbody>${stock.map(l => `<tr><td>${esc(l.product_name)}</td><td>${esc(l.branch_name)}</td>
              <td style="text-align:right">${n(l.pos_sales_qty)}<div style="color:var(--text-muted)">${this.fmt(l.pos_sales_value)}</div></td>
              <td style="text-align:right">${n(l.layaway_qty)}</td>
              <td style="text-align:right">${n(l.returns_qty)}<div style="color:var(--text-muted)">${this.fmt(l.returns_value)}</div></td>
              <td style="text-align:right">${n(l.prior_returns_qty)}${l.prior_returns_qty ? `<div style="color:var(--text-muted)">${this.fmt(l.prior_returns_value)}</div>` : ''}</td>
              <td style="text-align:right">${n(-l.shop_use)}</td>
              <td style="text-align:right">${n(l.shortage_qty)}</td>
              <td style="text-align:right">${draft && fin && r.shortage_responsibility === 'total_tools' && l.shortage_qty > 0 ? `<input type="number" min="0" max="${l.shortage_qty}" step="1" value="${l.approved_shortage_qty || ''}" style="width:60px;text-align:right" onchange="App._consReconLine(${r.id}, ${l.id}, { approved_shortage_qty: this.value })">` : n(l.approved_shortage_qty)}</td>
              <td style="text-align:right">${n(l.damage_qty)}</td>
              <td style="text-align:right">${draft && fin && r.damage_responsibility === 'total_tools' && l.damage_qty > 0 ? `<input type="number" min="0" max="${l.damage_qty}" step="1" value="${l.approved_damage_qty || ''}" style="width:60px;text-align:right" onchange="App._consReconLine(${r.id}, ${l.id}, { approved_damage_qty: this.value })">` : n(l.approved_damage_qty)}</td>
              <td style="text-align:right" class="fw-600">${n(l.billable_qty)}</td><td style="text-align:right" class="fw-600">${this.fmt(l.billable_value)}</td></tr>`).join('')}</tbody></table></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Shortages ${r.shortage_responsibility === 'total_tools' ? 'are' : "aren't"} and damage ${r.damage_responsibility === 'total_tools' ? 'is' : "isn't"} chargeable to Total Tools under this agreement. Sales and returns are at the cost saved on each sale; shop use, shortages and damage at the agreed cost on the last day of the month.</div>
          ${r.log.length ? `<div style="font-weight:600;margin:12px 0 4px">History</div>${r.log.map(g => `<div>${this.fmtDateTime(g.created_at)} — ${esc(g.action.replace('_', ' '))} by ${esc(g.employee_name || '—')}${g.reason ? `: ${esc(g.reason)}` : ''}${g.finance_approver ? ` · Finance approval: ${esc(g.finance_approver)} (${esc(g.approval_reference)})` : ''}</div>`).join('')}` : ''}
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          ${canPrep ? `<button class="btn btn-outline" onclick="App._consReconAction(${r.id}, 'refresh')">Refresh Figures</button>` : ''}
          ${draft && fin ? `<button class="btn btn-success" ${r.period_ended ? '' : 'disabled title="After the month has ended"'} onclick="App._consApproveRecon(${r.id})">Approve &amp; Lock</button>` : ''}
          ${!draft && this.can('settings') ? `<button class="btn btn-danger" onclick="App._consReopenRecon(${r.id})">Reopen…</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },
  async _consReconLine(reconId, lineId, body) {
    try { await this.api('PATCH', `/consignment/reconciliations/${reconId}/lines/${lineId}`, body); this.viewConsRecon(reconId); }
    catch (e) { this.alert(e.message, 'error'); this.viewConsRecon(reconId); }
  },
  async _consReconAction(id, action) {
    try { await this.api('POST', `/consignment/reconciliations/${id}/${action}`, {}); this.viewConsRecon(id); } catch (e) { this.alert(e.message, 'error'); }
  },
  _consApproveRecon(id) {
    this._showApprovalDialog({
      title: 'Approve Reconciliation',
      intro: 'Approving locks this month. A later return or correction goes into the next open month; reopening needs an Administrator acting on documented Finance approval.',
      approve: async (signature) => {
        await this.api('POST', `/consignment/reconciliations/${id}/approve`, { signature });
        this.alert('Reconciliation approved and locked', 'success');
        if (this.section === 'consignment') this.renderConsignment('recon');
        this.viewConsRecon(id);
      },
    });
  },
  async _consReopenRecon(id) {
    const reason = prompt('Why is this month being reopened?');
    if (!reason) return;
    const approver = prompt('Who in Finance approved reopening it?');
    if (!approver) return;
    const reference = prompt('Approval reference (e.g. the email or memo it was approved in):');
    if (!reference) return;
    try { await this.api('POST', `/consignment/reconciliations/${id}/reopen`, { reason, finance_approver: approver, approval_reference: reference }); this.renderConsignment('recon'); this.viewConsRecon(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Stock ──
  async _consStockTab() {
    const data = await this.api('GET', '/consignment/stock');
    const el = document.getElementById('cons-body');
    if (!el) return;
    el.innerHTML = `
      ${data.go_live ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Stock receipts tracked since ${this.fmtDateTime(data.go_live)}. Supplier-owned stock is not part of Total Tools' inventory value.</div>`
        : `<div class="card" style="border-color:var(--warning, #d97706);margin-bottom:12px"><strong>Consignment tracking hasn't started.</strong>
            <div style="font-size:13px;margin:4px 0 8px">Starting it records all stock on hand now as one Total Tools-owned receipt dated today, so it sells before any consignment stock received later. Consignment GRNs can be approved after that. It can't be undone.</div>
            ${this.can('settings') ? '<button class="btn btn-sm btn-primary" onclick="App._consGoLive()">Start Consignment Tracking</button>' : '<span style="font-size:12px;color:var(--text-muted)">An Administrator starts it.</span>'}</div>`}
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Agreement</th><th>Branch</th><th>Item</th><th style="text-align:right">On hand</th><th style="text-align:right">Reserved</th><th style="text-align:right">Agreed cost</th><th style="text-align:right">Value at cost</th><th>Oldest receipt</th></tr></thead>
        <tbody>${data.rows.length ? data.rows.map(r => `<tr><td>${this.escapeAttr(r.supplier_name)}</td><td>${r.agreement_number}</td><td>${this.escapeAttr(r.branch_name)}</td><td>${this.escapeAttr(r.product_name)}</td>
          <td style="text-align:right" class="fw-600">${r.qty_on_hand}</td><td style="text-align:right">${r.qty_reserved || 0}</td><td style="text-align:right">${r.agreed_cost != null ? this.fmt(r.agreed_cost) : '—'}</td>
          <td style="text-align:right">${r.value != null ? this.fmt(r.value) : '—'}</td><td>${this.fmtDate(r.oldest_receipt)}</td></tr>`).join('')
          : '<tr><td colspan="9" class="empty-state">No supplier-owned stock on hand</td></tr>'}</tbody>
        ${data.rows.length ? `<tfoot><tr><td colspan="7" style="text-align:right" class="fw-600">Total at agreed cost</td><td style="text-align:right" class="fw-600">${this.fmt(data.total_value)}</td><td></td></tr></tfoot>` : ''}
      </table></div></div>`;
  },
  async _consGoLive() {
    const typed = prompt('This records all stock on hand now as one Total Tools-owned receipt dated today. It cannot be undone.\n\nType START to confirm:');
    if (typed == null) return;
    try {
      const out = await this.api('POST', '/consignment/go-live', { confirm: typed.trim() });
      this.alert(`Consignment tracking started — ${out.lots} stock records dated today`, 'success');
      this.renderConsignment('stock');
    } catch (e) { this.alert(e.message, 'error'); }
  },
});
