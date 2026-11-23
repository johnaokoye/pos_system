// Consignment — supplier-owned stock: agreements, orders, Consignment GRNs and the consignment stock report (routes/consignment.js).
Object.assign(App, {
  _consCanOpen() { return this.can('consignment') || this.can('consignment_finance') || this.can('payables'); },
  _consFull() { return this.can('consignment') || this.can('consignment_finance'); },
  _consStatusBadge: { draft: 'badge-secondary', submitted: 'badge-warning', approved: 'badge-success', rejected: 'badge-danger', ended: 'badge-secondary',
    open: 'badge-info', partial: 'badge-warning', received: 'badge-success', cancelled: 'badge-secondary', pending: 'badge-warning' },
  _consStatusLabel: { draft: 'Draft', submitted: 'Awaiting Finance', approved: 'Approved', rejected: 'Rejected', ended: 'Ended',
    open: 'Open', partial: 'Part received', received: 'Received', cancelled: 'Cancelled', pending: 'Awaiting approval' },
  _consResp: { supplier: 'Supplier', total_tools: 'Total Tools' },

  async renderConsignment(tab) {
    // A/P without consignment access sees only the settlements to match.
    const tabs = this._consFull()
      ? [['agreements', 'Agreements'], ['orders', 'Orders'], ['grns', 'Goods Received (GRN)'], ['stock', 'Consignment Stock'], ['recon', 'Period-End Reconciliation'], ['settlements', 'Settlements'], ['postings', 'Books Postings']]
      : [['settlements', 'Settlements']];
    this._consTab = tab || this._consTab || tabs[0][0];
    if (!tabs.some(([k]) => k === this._consTab)) this._consTab = tabs[0][0];
    const c = document.getElementById('content');
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
      else if (this._consTab === 'settlements') await this._consSettlementsTab();
      else if (this._consTab === 'postings') await this._consPostingsTab();
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
            <div class="form-group"><label>Settlement</label><select id="ca-freq"><option value="monthly" ${v.settlement_frequency !== 'fortnightly' ? 'selected' : ''}>Monthly</option><option value="fortnightly" ${v.settlement_frequency === 'fortnightly' ? 'selected' : ''}>Every 14 days</option></select><div style="font-size:11px;color:var(--text-muted)">Every 14 days counts from the start date.</div></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Payment terms</label><input id="ca-terms" value="${esc(v.payment_terms)}" placeholder="e.g. Net 30 after settlement"></div>
            <div class="form-group" style="display:flex;flex-direction:column;gap:6px;justify-content:flex-end">
              <label style="font-weight:400"><input type="checkbox" id="ca-wo" ${v.allow_work_orders ? 'checked' : ''}> Parts may be issued to work orders</label>
              <label style="font-weight:400"><input type="checkbox" id="ca-shop" ${v.allow_shop_use ? 'checked' : ''}> May be taken for shop use</label>
            </div>
          </div>
          <div style="font-weight:600;font-size:13px;margin:6px 0">Items, unit and agreed cost (per that unit)</div>
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
    // + / "+ Add “…”" on the item picker creates the product right here
    // (_consNewProduct) for someone who may add inventory.
    const addAttr = this.can('inventory_add') ? ' data-add="App._consNewProduct"' : '';
    row.innerHTML = `<select class="ca-prod" data-searchable${addAttr} onchange="App._consProductPicked(this)" style="flex:1;min-width:0"><option value="">Choose item…</option>${(this._consProducts || []).map(p => `<option value="${p.id}" ${Number(it.product_id) === p.id ? 'selected' : ''}>${this.escapeAttr(p.name)}${p.sku ? ` (${this.escapeAttr(p.sku)})` : ''}</option>`).join('')}</select>
      <select class="ca-unit" title="Unit of measure — the agreed cost is per this unit" style="width:140px">${this._consUnitOptions(it.product_id, it.uom_id)}</select>
      <input class="ca-cost" type="number" step="0.01" min="0" placeholder="Agreed cost" value="${it.current_unit_cost ?? it.current_cost ?? it.cost ?? ''}" style="width:130px">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.remove()">✕</button>`;
    box.appendChild(row);
  },

  // Unit options for a consignment line: the item's stock unit and its
  // alternate (case / pack) units, value = uom_id ('' = stock unit).
  _consUnitOptions(productId, selected) {
    const p = (this._consProducts || []).find(x => x.id === Number(productId));
    const choices = p ? this._unitChoices(p, 'buy') : [{ uom_id: null, name: 'Each', isBase: true, factor: 1 }];
    return choices.map(c => {
      const val = c.isBase ? '' : c.uom_id;
      const sel = String(selected ?? '') === String(val ?? '') || (c.isBase && selected != null && String(selected) === String(c.uom_id)) ? 'selected' : '';
      return `<option value="${val ?? ''}" ${sel}>${this.escapeAttr(c.isBase ? c.name : (c.label || c.name))}</option>`;
    }).join('');
  },

  // A new item's agreed cost comes from the cost typed when creating it.
  _consProductPicked(sel) {
    const unit = sel.closest('.ca-item')?.querySelector('.ca-unit');
    if (unit) unit.innerHTML = this._consUnitOptions(sel.value, '');
    const cost = sel.closest('.ca-item')?.querySelector('.ca-cost');
    const agreed = (this._consNewCosts || {})[sel.value];
    if (cost && !cost.value && agreed != null) cost.value = agreed;
  },

  // data-add hook for the item picker: a small product form over the
  // agreement, prefilled with the typed name. Resolves { value, text } once
  // created (the picker selects it) or null if cancelled. Stock starts at 0
  // — consigned stock comes in through a consignment order's receiving.
  async _consNewProduct(name) {
    const categories = await this.api('GET', '/categories');
    const esc = x => this.escapeAttr(x ?? '');
    const overlay = this.showSecondaryModal(`
      <div class="modal">
        <div class="modal-header"><span class="modal-title">New Product</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>SKU *</label><input id="cnp-sku"></div>
            <div class="form-group"><label>Barcode</label><input id="cnp-barcode"></div>
          </div>
          <div class="form-group"><label>Name *</label><input id="cnp-name" value="${esc(name)}"></div>
          <div class="form-group"><label>Category</label><select id="cnp-cat"><option value="">— None —</option>${categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="input-row-3">
            <div class="form-group"><label>Selling price</label><input type="number" id="cnp-price" min="0" step="0.01" value="0"></div>
            <div class="form-group"><label>Agreed cost</label><input type="number" id="cnp-cost" min="0" step="0.01" placeholder="Per stock unit"></div>
            <div class="form-group"><label>Tax Rate %</label><input type="number" id="cnp-tax" min="0" step="0.1" value="${this.settings?.tax_rate ?? 8.5}"></div>
          </div>
          <div style="font-size:11px;color:var(--text-muted)">Stock starts at 0 — it comes in when a consignment order is received.</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="cnp-cancel">Cancel</button>
          <button class="btn btn-primary" id="cnp-save">Create & Add</button>
        </div>
      </div>`);
    document.getElementById(name ? 'cnp-sku' : 'cnp-name')?.focus();
    return new Promise(resolve => {
      const done = v => { overlay.remove(); resolve(v); };
      overlay.querySelector('.modal-close').addEventListener('click', () => resolve(null));
      overlay.querySelector('#cnp-cancel').addEventListener('click', () => done(null));
      overlay.querySelector('#cnp-save').addEventListener('click', async e => {
        const val = i => document.getElementById(i).value.trim();
        const data = {
          sku: val('cnp-sku'), barcode: val('cnp-barcode') || null, name: val('cnp-name'), category_id: val('cnp-cat') || null,
          price: parseFloat(val('cnp-price')) || 0, cost: parseFloat(val('cnp-cost')) || 0, tax_rate: parseFloat(val('cnp-tax')) || 0,
          stock_qty: 0, supplier_id: document.getElementById('ca-supplier')?.value || null,
        };
        if (!data.sku) return this.alert('SKU is required', 'error');
        if (!data.name) return this.alert('Name is required', 'error');
        e.target.disabled = true;
        try {
          const p = await this.api('POST', '/products', data);
          (this._consProducts ||= []).push(p);
          if (val('cnp-cost') !== '') (this._consNewCosts ||= {})[p.id] = val('cnp-cost');
          const text = `${p.name}${p.sku ? ` (${p.sku})` : ''}`;
          // The other item rows can pick it too.
          document.querySelectorAll('#ca-items .ca-prod').forEach(sel => { if (![...sel.options].some(o => o.value === String(p.id))) sel.add(new Option(text, p.id)); });
          this.alert(`Product "${p.name}" created`);
          done({ value: p.id, text });
        } catch (err) { e.target.disabled = false; this.alert(err.message, 'error'); }
      });
    });
  },

  async _consSaveAgreement(id, submit) {
    const val = i => document.getElementById(i)?.value ?? '';
    const body = {
      supplier_id: val('ca-supplier'), start_date: val('ca-start'), end_date: val('ca-end'), ownership_terms: val('ca-ownership'), billable_rule: val('ca-billable'),
      shortage_responsibility: val('ca-short'), damage_responsibility: val('ca-damage'), payment_terms: val('ca-terms'), notes: val('ca-notes'), settlement_frequency: val('ca-freq') || 'monthly',
      allow_work_orders: document.getElementById('ca-wo').checked, allow_shop_use: document.getElementById('ca-shop').checked, submit,
      items: [...document.querySelectorAll('.ca-item')].map(r => ({ product_id: r.querySelector('.ca-prod').value, uom_id: r.querySelector('.ca-unit')?.value || null, cost: r.querySelector('.ca-cost').value })).filter(i => i.product_id),
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
              <strong>Settlement:</strong> ${a.settlement_frequency === 'fortnightly' ? `Every 14 days from ${this.fmtDate(a.start_date)}` : 'Monthly'}<br><strong>Payment terms:</strong> ${esc(a.payment_terms || '—')}</div>
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
          <table style="width:100%"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Item</th><th style="text-align:left">Unit</th><th style="text-align:right">Cost now</th><th style="text-align:left;padding-left:12px">History (effective from)</th></tr></thead>
            <tbody>${a.items.map(it => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0">${esc(it.product_name)}${it.sku ? ` <span style="color:var(--text-muted)">${esc(it.sku)}</span>` : ''}</td>
              <td>${esc(it.unit_label || 'Each')}</td>
              <td style="text-align:right"><span class="fw-600">${it.current_unit_cost != null ? this.fmt(it.current_unit_cost) : '—'}</span>${Number(it.units_per) > 1 && it.current_cost != null ? `<div style="font-size:11px;color:var(--text-muted)">${this.fmt(it.current_cost)} / ${esc(it.stock_unit)}</div>` : ''}</td>
              <td style="padding-left:12px;font-size:12px">${it.costs.map(c => `${this.fmt(c.unit_cost ?? c.cost)} from ${this.fmtDate(c.effective_from)}`).join(' · ')}</td></tr>`).join('')}</tbody></table>
          ${a.status === 'approved' && this.can('consignment_agreements') ? `<div class="input-row" style="margin-top:10px;align-items:flex-end">
            <div class="form-group"><label>New agreed cost for</label><select id="cac-prod">${a.items.map(it => `<option value="${it.product_id}">${esc(it.product_name)} — per ${esc(it.unit_label || 'Each')}</option>`).join('')}</select></div>
            <div class="form-group"><label>Cost (per the item's unit)</label><input id="cac-cost" type="number" step="0.01" min="0" style="width:120px"></div>
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
    const [a, products] = await Promise.all([this.api('GET', `/consignment/agreements/${id}`), this._consProducts ? null : this.api('GET', '/products?active=1')]);
    if (products) this._consProducts = products.filter(p => !p.is_rental && !p.is_service && !p.is_non_inventory);
    this._consOrderAgreement = a;
    box.innerHTML = `<table style="width:100%"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Item</th><th style="text-align:left">Unit</th><th style="text-align:right">Agreed cost</th><th style="text-align:right;width:120px">Quantity</th></tr></thead>
      <tbody>${a.items.filter(i => i.active).map(i => `<tr style="border-top:1px solid var(--border);color:var(--text)"><td style="padding:5px 0">${this.escapeAttr(i.product_name)}</td>
        <td><select class="co-unit" data-product="${i.product_id}" onchange="App._consOrderUnitChanged(this)" style="width:140px">${this._consUnitOptions(i.product_id, i.uom_id ?? '')}</select></td>
        <td style="text-align:right" class="co-cost" data-product="${i.product_id}">${this._consOrderCostText(i, i.uom_id ?? '')}</td>
        <td style="text-align:right"><input class="co-qty" data-product="${i.product_id}" type="number" min="0" step="1" style="width:100px;text-align:right" placeholder="0"></td></tr>`).join('')}</tbody></table>`;
  },
  // The agreed cost shown for the unit chosen on an order line.
  _consOrderCostText(item, uomId) {
    if (item.current_cost == null) return '—';
    const p = (this._consProducts || []).find(x => x.id === item.product_id);
    const choice = p ? this._unitChoices(p, 'buy').find(c => (c.isBase ? '' : String(c.uom_id)) === String(uomId ?? '')) : null;
    const factor = choice ? Number(choice.factor) || 1 : Number(item.units_per) || 1;
    return `${this.fmt(Math.round(item.current_cost * factor * 100) / 100)} / ${this.escapeAttr(choice ? (choice.isBase ? choice.name : (choice.label || choice.name)) : (item.unit_label || 'Each'))}`;
  },
  _consOrderUnitChanged(sel) {
    const item = (this._consOrderAgreement?.items || []).find(i => String(i.product_id) === sel.dataset.product);
    const cell = document.querySelector(`.co-cost[data-product="${sel.dataset.product}"]`);
    if (item && cell) cell.innerHTML = this._consOrderCostText(item, sel.value);
  },
  async _consSaveOrder() {
    const items = [...document.querySelectorAll('.co-qty')].map(i => ({ product_id: i.dataset.product, uom_id: document.querySelector(`.co-unit[data-product="${i.dataset.product}"]`)?.value || null, quantity: parseFloat(i.value) || 0 })).filter(i => i.quantity > 0);
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
          <table style="width:100%"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Item</th><th style="text-align:left">Unit</th><th style="text-align:right">Ordered</th><th style="text-align:right">Received</th><th style="text-align:right">Awaiting approval</th><th style="text-align:right">Left</th>${canReceive ? '<th style="text-align:right;width:110px">Receive now</th>' : ''}</tr></thead>
            <tbody>${o.items.map(i => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0">${esc(i.product_name)}</td><td>${esc(i.unit_label || 'Each')}${Number(i.units_per) > 1 ? `<div style="font-size:11px;color:var(--text-muted)">${i.quantity_ordered} ${esc(i.stock_unit)} ordered</div>` : ''}</td>
              <td style="text-align:right">${i.ordered_units}</td><td style="text-align:right">${i.received_units}</td><td style="text-align:right">${i.pending_units || 0}</td><td style="text-align:right" class="fw-600">${i.left_units}</td>
              ${canReceive ? `<td style="text-align:right"><input class="cg-qty" data-line="${i.id}" type="number" min="0" max="${i.left_units}" step="${Number(i.units_per) > 1 ? 'any' : '1'}" style="width:90px;text-align:right" placeholder="0" ${i.quantity_left > 0 ? '' : 'disabled'}></td>` : ''}</tr>`).join('')}</tbody></table>
          ${o.items.some(i => Number(i.units_per) > 1) ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Quantities are in each line's unit; stock goes on hand in the item's stock unit.</div>` : ''}
          ${canReceive ? `<div class="input-row" style="margin-top:10px"><div class="form-group"><label>Supplier delivery note # *</label><input id="cg-note"></div><div class="form-group"><label>Notes</label><input id="cg-notes"></div></div>
            <button class="btn btn-primary btn-sm" onclick="App._consReceive(${o.id})">Enter GRN</button>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">The stock goes on hand once the GRN is approved.</div>` : ''}
          ${o.grns.length ? `<div style="font-weight:600;margin:12px 0 4px">GRNs</div>${o.grns.map(g => `<div style="border-top:1px solid var(--border);padding:4px 0"><a href="#" onclick="event.preventDefault();App.viewConsGrn(${g.id})">${g.grn_number}</a> · delivery note ${esc(g.delivery_note_number)} · ${this._consBadge(g.status)}</div>`).join('')}` : ''}
        </div>
        <div class="modal-footer">${['open', 'partial'].includes(o.status) && this.can('consignment_agreements') ? `<button class="btn btn-outline" onclick="App._consCancelOrder(${o.id})">${o.status === 'partial' ? 'Close (cancel the rest)' : 'Cancel Order'}</button>` : ''}<button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },
  async _consReceive(orderId) {
    const items = [...document.querySelectorAll('.cg-qty')].map(i => ({ order_item_id: i.dataset.line, unit_quantity: parseFloat(i.value) || 0 })).filter(i => i.unit_quantity > 0);
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
          <table style="width:100%"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Item</th><th style="text-align:left">Unit</th><th style="text-align:right">Quantity</th><th style="text-align:right">Stock units</th></tr></thead>
            <tbody>${g.items.map(i => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0">${esc(i.product_name)}</td><td>${esc(i.unit_label || 'Each')}</td><td style="text-align:right" class="fw-600">${i.unit_quantity ?? i.quantity}</td><td style="text-align:right">${i.quantity} ${esc(i.stock_unit || '')}</td></tr>`).join('')}</tbody></table>
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

  // ── Period-end reconciliation (a month, or 14 days) ──
  async _consReconTab() {
    const [rows, agreements] = await Promise.all([this.api('GET', '/consignment/reconciliations'), this.api('GET', '/consignment/agreements')]);
    const el = document.getElementById('cons-body');
    if (!el) return;
    const canPrep = this.can('consignment_receive') || this.can('consignment_finance');
    el.innerHTML = `
      ${canPrep ? `<div class="card" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0"><label>Agreement</label><select id="crn-agr" onchange="App._consReconPeriods()">${agreements.filter(a => ['approved', 'ended'].includes(a.status)).map(a => `<option value="${a.id}">${a.agreement_number} — ${this.escapeAttr(a.supplier_name)}</option>`).join('')}</select></div>
        <div class="form-group" style="margin:0"><label>Period</label><select id="crn-month"></select></div>
        <button class="btn btn-primary" onclick="App._consNewRecon()">Prepare Reconciliation</button></div>` : ''}
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Reconciliation #</th><th>Period</th><th>Agreement</th><th>Supplier</th><th style="text-align:right">Billable qty</th><th style="text-align:right">Billable value</th><th>Status</th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `<tr style="cursor:pointer" onclick="App.viewConsRecon(${r.id})"><td class="fw-600">${r.recon_number}</td><td>${this.escapeAttr(r.period_label || r.period)}</td><td>${r.agreement_number}</td><td>${this.escapeAttr(r.supplier_name)}</td>
          <td style="text-align:right">${r.totals.billable_qty ?? 0}</td><td style="text-align:right">${this.fmt(r.totals.billable_value || 0)}</td>
          <td><span class="badge-pill ${r.status === 'approved' ? 'badge-success' : 'badge-warning'}">${r.status === 'approved' ? 'Approved — locked' : 'Draft'}</span></td></tr>`).join('')
          : '<tr><td colspan="7" class="empty-state">No reconciliations yet</td></tr>'}</tbody></table></div></div>`;
    if (canPrep) this._consReconPeriods();
  },
  // Fills the Period box with the chosen agreement's months or 14-day
  // periods, newest first; picks the latest ended one not yet reconciled.
  async _consReconPeriods() {
    const sel = document.getElementById('crn-month');
    const agr = document.getElementById('crn-agr')?.value;
    if (!sel) return;
    if (!agr) { sel.innerHTML = ''; return; }
    let data;
    try { data = await this.api('GET', `/consignment/agreements/${agr}/periods`); } catch (e) { this.alert(e.message, 'error'); return; }
    const pick = data.periods.find(p => p.ended && !p.recon) || data.periods.find(p => !p.recon) || data.periods[0];
    sel.innerHTML = data.periods.map(p => `<option value="${p.period}" ${p === pick ? 'selected' : ''}>${this.escapeAttr(p.label)}${p.recon ? ` — ${p.recon.recon_number}` : p.ended ? '' : ' (in progress)'}</option>`).join('')
      || '<option value="">No periods yet</option>';
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
        <div class="modal-header"><span class="modal-title">${r.recon_number} — ${esc(r.supplier_name)} · ${r.agreement_number} · ${this.escapeAttr(r.period_label || r.period)}</span>
          <div style="display:flex;gap:8px;align-items:center"><span class="badge-pill ${draft ? 'badge-warning' : 'badge-success'}">${draft ? 'Draft' : 'Approved — locked'}</span><button class="modal-close">✕</button></div></div>
        <div class="modal-body" style="font-size:12px">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px;font-size:13px">
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">POS-RECORDED SALES</div><strong>${n(t.pos_sales_qty)} · ${this.fmt(t.pos_sales_value || 0)}</strong>${t.layaway_qty ? `<div style="font-size:11px">+ layaways ${n(t.layaway_qty)} · ${this.fmt(t.layaway_value)}</div>` : ''}${t.work_order_qty ? `<div style="font-size:11px">+ work orders ${n(t.work_order_qty)} · ${this.fmt(t.work_order_value)}</div>` : ''}</div>
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">RETURNS</div><strong>${n(t.returns_qty)} · ${this.fmt(t.returns_value || 0)}</strong>${t.prior_returns_qty ? `<div style="font-size:11px">+ of earlier periods' sales ${n(t.prior_returns_qty)} · ${this.fmt(t.prior_returns_value)}</div>` : ''}</div>
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">COUNT DISCREPANCIES</div><strong>${t.discrepancy_lines || 0} line${t.discrepancy_lines === 1 ? '' : 's'}</strong><div style="font-size:11px">shortage ${n(t.shortage_qty)} · damage ${n(t.damage_qty)}${t.uncounted_lines ? ` · <span style="color:var(--warning, #d97706)">${t.uncounted_lines} not counted</span>` : ''}</div></div>
            <div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">APPROVED BILLABLE</div><strong>${n(t.billable_qty)} · ${this.fmt(t.billable_value || 0)}</strong><div style="font-size:11px">incl. approved shortage ${n(t.approved_shortage_qty)} / damage ${n(t.approved_damage_qty)}</div></div>
            ${t.in_transit ? `<div class="card" style="margin:0;padding:8px 10px"><div style="color:var(--text-muted);font-size:11px">IN TRANSIT AT CUT-OFF</div><strong>${n(t.in_transit)}</strong></div>` : ''}
          </div>
          <div style="font-weight:600;margin-bottom:4px">Stock by branch and item</div>
          <div class="table-wrap"><table style="font-size:12px">
            <thead><tr>${th('Item', false)}${th('Branch', false)}${th('Opening')}${th('Received')}${th('Transfers in')}${th('Transfers out')}${th('POS sales')}${th('Returns')}${th('Layaways')}${th('Work orders')}${th('Shop use')}${th('Damage')}${th('Adjust.')}${th('Expected')}${th('Counted')}${th('Diff.')}</tr></thead>
            <tbody>${stock.map(l => `<tr><td>${esc(l.product_name)}</td><td>${esc(l.branch_name)}</td>${['opening', 'receipts', 'transfers_in', 'transfers_out', 'sales', 'returns', 'layaways', 'work_orders', 'shop_use', 'damaged', 'adjustments'].map(c => `<td style="text-align:right">${n(l[c])}</td>`).join('')}
              <td style="text-align:right" class="fw-600">${n(l.expected_closing)}</td>
              <td style="text-align:right">${canPrep ? `<input type="number" min="0" step="1" value="${l.physical_count ?? ''}" style="width:70px;text-align:right" onchange="App._consReconLine(${r.id}, ${l.id}, { physical_count: this.value })">` : n(l.physical_count)}</td>
              <td style="text-align:right;${Math.abs(l.discrepancy) > 0.0005 ? 'color:var(--danger);font-weight:600' : ''}">${l.physical_count == null ? '' : n(l.discrepancy)}</td></tr>`).join('') || '<tr><td colspan="16" class="empty-state">No supplier stock movements this period</td></tr>'}</tbody></table></div>
          ${transit.length ? `<div style="font-weight:600;margin:10px 0 4px">In transit at the cut-off (still the supplier's)</div>${transit.map(l => `<div>${esc(l.product_name)}: <strong>${n(l.in_transit)}</strong></div>`).join('')}` : ''}
          <div style="font-weight:600;margin:12px 0 4px">Billing</div>
          <div class="table-wrap"><table style="font-size:12px">
            <thead><tr>${th('Item', false)}${th('Branch', false)}${th('POS sales')}${th('Layaways paid')}${th('Work orders')}${th('Returns')}${th('Earlier periods returned')}${th('Shop use')}${th('Shortage')}${th('Approved shortage')}${th('Damage')}${th('Approved damage')}${th('Billable qty')}${th('Billable value')}</tr></thead>
            <tbody>${stock.map(l => `<tr><td>${esc(l.product_name)}</td><td>${esc(l.branch_name)}</td>
              <td style="text-align:right">${n(l.pos_sales_qty)}<div style="color:var(--text-muted)">${this.fmt(l.pos_sales_value)}</div></td>
              <td style="text-align:right">${n(l.layaway_qty)}</td>
              <td style="text-align:right">${n(l.work_order_qty)}${l.work_order_qty ? `<div style="color:var(--text-muted)">${this.fmt(l.work_order_value)}</div>` : ''}</td>
              <td style="text-align:right">${n(l.returns_qty)}<div style="color:var(--text-muted)">${this.fmt(l.returns_value)}</div></td>
              <td style="text-align:right">${n(l.prior_returns_qty)}${l.prior_returns_qty ? `<div style="color:var(--text-muted)">${this.fmt(l.prior_returns_value)}</div>` : ''}</td>
              <td style="text-align:right">${n(-l.shop_use)}</td>
              <td style="text-align:right">${n(l.shortage_qty)}</td>
              <td style="text-align:right">${draft && fin && r.shortage_responsibility === 'total_tools' && l.shortage_qty > 0 ? `<input type="number" min="0" max="${l.shortage_qty}" step="1" value="${l.approved_shortage_qty || ''}" style="width:60px;text-align:right" onchange="App._consReconLine(${r.id}, ${l.id}, { approved_shortage_qty: this.value })">` : n(l.approved_shortage_qty)}</td>
              <td style="text-align:right">${n(l.damage_qty)}</td>
              <td style="text-align:right">${draft && fin && r.damage_responsibility === 'total_tools' && l.damage_qty > 0 ? `<input type="number" min="0" max="${l.damage_qty}" step="1" value="${l.approved_damage_qty || ''}" style="width:60px;text-align:right" onchange="App._consReconLine(${r.id}, ${l.id}, { approved_damage_qty: this.value })">` : n(l.approved_damage_qty)}</td>
              <td style="text-align:right" class="fw-600">${n(l.billable_qty)}</td><td style="text-align:right" class="fw-600">${this.fmt(l.billable_value)}</td></tr>`).join('')}</tbody></table></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Shortages ${r.shortage_responsibility === 'total_tools' ? 'are' : "aren't"} and damage ${r.damage_responsibility === 'total_tools' ? 'is' : "isn't"} chargeable to Total Tools under this agreement. Sales and returns are at the cost saved on each sale; shop use, shortages and damage at the agreed cost on the last day of the period.</div>
          ${r.log.length ? `<div style="font-weight:600;margin:12px 0 4px">History</div>${r.log.map(g => `<div>${this.fmtDateTime(g.created_at)} — ${esc(g.action.replace('_', ' '))} by ${esc(g.employee_name || '—')}${g.reason ? `: ${esc(g.reason)}` : ''}${g.finance_approver ? ` · Finance approval: ${esc(g.finance_approver)} (${esc(g.approval_reference)})` : ''}</div>`).join('')}` : ''}
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          ${canPrep ? `<button class="btn btn-outline" onclick="App._consReconAction(${r.id}, 'refresh')">Refresh Figures</button>` : ''}
          ${draft && fin ? `<button class="btn btn-success" ${r.period_ended ? '' : 'disabled title="After the period has ended"'} onclick="App._consApproveRecon(${r.id})">Approve &amp; Lock</button>` : ''}
          ${!draft && r.settlement ? `<button class="btn btn-primary" onclick="App.viewConsSettlement(${r.settlement.id})">Settlement ${r.settlement.settlement_number}</button>` : ''}
          ${!draft && !r.settlement && fin ? `<button class="btn btn-outline" onclick="App._consMakeSettlement(${r.id})">Make Settlement Statement</button>` : ''}
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
      intro: 'Approving locks this period. A later return or correction goes into the next open period; reopening needs an Administrator acting on documented Finance approval.',
      approve: async (signature) => {
        await this.api('POST', `/consignment/reconciliations/${id}/approve`, { signature });
        this.alert('Reconciliation approved and locked', 'success');
        if (this.section === 'consignment') this.renderConsignment('recon');
        this.viewConsRecon(id);
      },
    });
  },
  async _consReopenRecon(id) {
    const reason = prompt('Why is this period being reopened?');
    if (!reason) return;
    const approver = prompt('Who in Finance approved reopening it?');
    if (!approver) return;
    const reference = prompt('Approval reference (e.g. the email or memo it was approved in):');
    if (!reference) return;
    try { await this.api('POST', `/consignment/reconciliations/${id}/reopen`, { reason, finance_approver: approver, approval_reference: reference }); this.renderConsignment('recon'); this.viewConsRecon(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Stock ──
  // Filters kept while moving between tabs; the table reloads on each change.
  async _consStockTab() {
    const f = this._consStockFilters || (this._consStockFilters = { supplier_id: '', agreement_id: '', branch_id: '', q: '' });
    const [agreements, branches] = await Promise.all([this.api('GET', '/consignment/agreements'), this.api('GET', '/branches')]);
    const el = document.getElementById('cons-body');
    if (!el) return;
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    const suppliers = [...new Map(agreements.map(a => [a.supplier_id, a.supplier_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    this._consStockAgreements = agreements;
    el.innerHTML = `
      <div id="cons-stock-head"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <input type="search" id="cs-q" placeholder="Search item, SKU, barcode, supplier…" value="${esc(f.q)}" style="width:240px">
        <select id="cs-supplier" style="width:auto;min-width:150px"><option value="">All Suppliers</option>${suppliers.map(([id, name]) => `<option value="${id}" ${String(f.supplier_id) === String(id) ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>
        <select id="cs-agreement" style="width:auto;min-width:150px"></select>
        <select id="cs-branch" style="width:auto;min-width:130px"><option value="">All Branches</option>${branches.map(b => `<option value="${b.id}" ${String(f.branch_id) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
        <div style="flex:1"></div>
        <button class="btn btn-sm btn-secondary" onclick="App._consStockPrint()">🖨 Print</button>
        <button class="btn btn-sm btn-secondary" onclick="App._consStockCsv()">&#8659; CSV</button>
      </div>
      <div id="cons-stock-table"><div class="card"><p class="empty-state">Loading…</p></div></div>`;
    this._consStockAgreementOptions();
    const reload = () => {
      f.q = document.getElementById('cs-q').value.trim();
      f.supplier_id = document.getElementById('cs-supplier').value;
      f.agreement_id = document.getElementById('cs-agreement').value;
      f.branch_id = document.getElementById('cs-branch').value;
      this._consStockLoad();
    };
    let t;
    document.getElementById('cs-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(reload, 250); });
    document.getElementById('cs-supplier').addEventListener('change', () => { this._consStockAgreementOptions(); reload(); });
    document.getElementById('cs-agreement').addEventListener('change', reload);
    document.getElementById('cs-branch').addEventListener('change', reload);
    await this._consStockLoad();
  },

  // Agreement box lists only the chosen supplier's agreements.
  _consStockAgreementOptions() {
    const f = this._consStockFilters, sel = document.getElementById('cs-agreement');
    if (!sel) return;
    const sup = document.getElementById('cs-supplier').value;
    const list = (this._consStockAgreements || []).filter(a => !sup || String(a.supplier_id) === String(sup));
    if (!list.some(a => String(a.id) === String(f.agreement_id))) f.agreement_id = '';
    sel.innerHTML = `<option value="">All Agreements</option>${list.map(a => `<option value="${a.id}" ${String(f.agreement_id) === String(a.id) ? 'selected' : ''}>${this.escapeAttr(a.agreement_number)}${sup ? '' : ` — ${this.escapeAttr(a.supplier_name || '')}`}</option>`).join('')}`;
  },

  async _consStockLoad() {
    const f = this._consStockFilters;
    const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const seq = this._consStockSeq = (this._consStockSeq || 0) + 1;
    const data = await this.api('GET', `/consignment/stock${qs ? `?${qs}` : ''}`);
    if (seq !== this._consStockSeq) return;
    this._consStockData = data;
    const head = document.getElementById('cons-stock-head'), el = document.getElementById('cons-stock-table');
    if (!el) return;
    const filtered = Object.values(f).some(v => v);
    if (head) head.innerHTML = data.go_live ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><div style="font-size:12px;color:var(--text-muted);flex:1">Stock receipts tracked since ${this.fmtDateTime(data.go_live)}. Supplier-owned stock is not part of Total Tools' inventory value.</div>
          <button class="btn btn-sm btn-outline" onclick="App.showConsOpeningLog()">Supplier stock found on hand</button>${this.can('consignment_opening_record') ? '<button class="btn btn-sm btn-outline" onclick="App.showConsOpeningStock()">+ Record supplier-owned stock</button>' : ''}</div>`
        : `<div class="card" style="border-color:var(--warning, #d97706);margin-bottom:12px"><strong>Consignment tracking hasn't started.</strong>
            <div style="font-size:13px;margin:4px 0 8px">Starting it records the stock on hand now: anything you list as already belonging to a supplier becomes theirs, and the rest one Total Tools-owned receipt dated today, so it sells before any consignment stock received later. Consignment GRNs can be approved after that. It can't be undone.</div>
            ${this.can('consignment_go_live') ? '<button class="btn btn-sm btn-primary" onclick="App._consGoLive()">Start Consignment Tracking</button>' : '<span style="font-size:12px;color:var(--text-muted)">Started by someone with the Start Consignment Tracking permission.</span>'}</div>`;
    const units = data.rows.reduce((t, r) => t + Number(r.qty_on_hand || 0), 0);
    el.innerHTML = `<div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Agreement</th><th>Branch</th><th>SKU</th><th>Item</th><th style="text-align:right">On hand</th><th style="text-align:right">Reserved</th><th style="text-align:right">Agreed cost</th><th style="text-align:right">Value at cost</th><th>Oldest receipt</th></tr></thead>
        <tbody>${data.rows.length ? data.rows.map(r => `<tr><td>${this.escapeAttr(r.supplier_name)}</td><td>${r.agreement_number}</td><td>${this.escapeAttr(r.branch_name)}</td><td style="font-family:monospace;font-size:12px">${this.escapeAttr(r.sku || '')}</td><td>${this.escapeAttr(r.product_name)}</td>
          <td style="text-align:right" class="fw-600">${r.qty_on_hand}</td><td style="text-align:right">${r.qty_reserved || 0}</td><td style="text-align:right">${r.agreed_cost != null ? this.fmt(r.agreed_cost) : '—'}</td>
          <td style="text-align:right">${r.value != null ? this.fmt(r.value) : '—'}</td><td>${this.fmtDate(r.oldest_receipt)}</td></tr>`).join('')
          : `<tr><td colspan="10" class="empty-state">${filtered ? 'No supplier-owned stock matches these filters' : 'No supplier-owned stock on hand'}</td></tr>`}</tbody>
        ${data.rows.length ? `<tfoot><tr><td colspan="5" style="text-align:right" class="fw-600">${data.rows.length} line${data.rows.length === 1 ? '' : 's'} · total</td><td style="text-align:right" class="fw-600">${units}</td><td colspan="2" style="text-align:right" class="fw-600">At agreed cost</td><td style="text-align:right" class="fw-600">${this.fmt(data.total_value)}</td><td></td></tr></tfoot>` : ''}
      </table></div></div>`;
  },

  // What the filters say, for the printout and the CSV file name.
  _consStockFilterLabel() {
    const pick = id => { const s = document.getElementById(id); return s && s.value ? s.options[s.selectedIndex].text : ''; };
    const parts = [pick('cs-supplier'), pick('cs-agreement'), pick('cs-branch')].filter(Boolean);
    const q = (this._consStockFilters || {}).q;
    if (q) parts.push(`matching "${q}"`);
    return parts.join(' · ');
  },

  _consStockCsv() {
    const d = this._consStockData;
    if (!d) return;
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['supplier', 'agreement', 'branch', 'sku', 'barcode', 'item', 'on_hand', 'reserved', 'agreed_cost', 'value_at_cost', 'oldest_receipt'];
    const lines = [head.join(',')].concat(d.rows.map(r => [r.supplier_name, r.agreement_number, r.branch_name, r.sku, r.barcode, r.product_name, r.qty_on_hand, r.qty_reserved || 0, r.agreed_cost ?? '', r.value ?? '', r.oldest_receipt ? this.fmtDate(r.oldest_receipt) : ''].map(q).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `consignment-stock-${this._storeDay()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  },

  _consStockPrint() {
    const d = this._consStockData;
    if (!d) return;
    const win = window.open('', '_blank', 'width=1000,height=800');
    if (!win) { this.alert('Your browser blocked the print popup — allow popups for this site and try again', 'warning'); return; }
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    const td = 'padding:5px 6px;border-bottom:1px solid #e5e5e5';
    const units = d.rows.reduce((t, r) => t + Number(r.qty_on_hand || 0), 0);
    const label = this._consStockFilterLabel();
    win.document.write(`<!DOCTYPE html><html><head><title>Consignment Stock</title>
      <style>body{font-family:Arial,sans-serif;font-size:12px;margin:0;padding:32px;color:#111}h1{font-size:18px;margin:0 0 4px}
      table{width:100%;border-collapse:collapse;margin-top:14px}th{text-align:left;font-size:11px;color:#555;border-bottom:2px solid #333;padding:5px 6px}
      .r{text-align:right}tfoot td{font-weight:700;border-top:2px solid #333;padding:6px}@media print{body{padding:12px}}</style></head><body>
      ${this._printLogoTag(40)}
      <h1>Consignment Stock — supplier-owned items on hand</h1>
      <div style="color:#555">${esc(this.settings?.store_name || '')} · ${esc(this._storeDateTime ? this._storeDateTime(new Date().toISOString()) : new Date().toLocaleString())}${label ? ` · ${esc(label)}` : ''}</div>
      <div style="color:#555;margin-top:2px">Not part of Total Tools' inventory value. Value at the agreed cost in effect today.</div>
      <table><thead><tr><th>Supplier</th><th>Agreement</th><th>Branch</th><th>SKU</th><th>Item</th><th class="r">On hand</th><th class="r">Reserved</th><th class="r">Agreed cost</th><th class="r">Value</th><th>Oldest receipt</th></tr></thead>
      <tbody>${d.rows.map(r => `<tr><td style="${td}">${esc(r.supplier_name)}</td><td style="${td}">${esc(r.agreement_number)}</td><td style="${td}">${esc(r.branch_name)}</td><td style="${td};font-family:monospace">${esc(r.sku)}</td><td style="${td}">${esc(r.product_name)}</td>
        <td style="${td}" class="r">${r.qty_on_hand}</td><td style="${td}" class="r">${r.qty_reserved || 0}</td><td style="${td}" class="r">${r.agreed_cost != null ? this.fmt(r.agreed_cost) : '—'}</td><td style="${td}" class="r">${r.value != null ? this.fmt(r.value) : '—'}</td><td style="${td}">${this.fmtDate(r.oldest_receipt)}</td></tr>`).join('') || `<tr><td colspan="10" style="${td};text-align:center;color:#777">No supplier-owned stock on hand</td></tr>`}</tbody>
      ${d.rows.length ? `<tfoot><tr><td colspan="5" class="r">${d.rows.length} line${d.rows.length === 1 ? '' : 's'} · total</td><td class="r">${units}</td><td colspan="2"></td><td class="r">${this.fmt(d.total_value)}</td><td></td></tr></tfoot>` : ''}
      </table><script>window.onload=()=>{window.print()}<\/script></body></html>`);
    win.document.close();
  },
  // Start Consignment Tracking: supplier-owned stock already on hand is
  // listed first; everything else becomes one Total Tools-owned receipt.
  // After go-live the same list records supplier stock found later.
  async _consGoLive() { return this._consOpeningForm(false); },
  async showConsOpeningStock() { return this._consOpeningForm(true); },
  async showConsOpeningLog() {
    let rows;
    try { rows = await this.api('GET', '/consignment/opening-stock'); } catch (e) { this.alert(e.message, 'error'); return; }
    this.showModal(`<div class="modal" style="max-width:860px"><div class="modal-header"><span class="modal-title">Supplier Stock Found On Hand</span><button class="modal-close">✕</button></div>
      <div class="modal-body"><div class="table-wrap"><table style="font-size:13px"><thead><tr><th>When</th><th>Supplier</th><th>Agreement</th><th>Item</th><th>Branch</th><th style="text-align:right">Qty</th><th>Recorded</th></tr></thead>
      <tbody>${rows.length ? rows.map(r => `<tr><td>${this.fmtDateTime(r.entered_at)}</td><td>${this.escapeAttr(r.supplier_name || '')}</td><td>${r.agreement_number}</td><td>${this.escapeAttr(r.product_name)}</td><td>${this.escapeAttr(r.branch_name)}</td>
        <td style="text-align:right">${r.qty}</td><td>${r.mode === 'go_live' ? 'When tracking started' : `Later: ${this.escapeAttr(r.note || '')}`}<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(r.entered_by_name || '')}</div></td></tr>`).join('')
        : '<tr><td colspan="7" class="empty-state">None — all stock on hand when tracking started was Total Tools\'</td></tr>'}</tbody></table></div></div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div></div>`);
  },

  async _consOpeningForm(after) {
    let data;
    try { data = await this.api('GET', '/consignment/opening-candidates'); } catch (e) { this.alert(e.message, 'error'); return; }
    this._consOpeningCands = data.rows;
    this._consOpeningAfter = after;
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">${after ? 'Record Supplier-Owned Stock Found On Hand' : 'Start Consignment Tracking'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="font-size:13px">
          ${after
            ? '<p style="margin-top:0">For units that were recorded as Total Tools\' stock when tracking started but really belong to a supplier. They move to the supplier\'s ownership, dated when tracking started, and the reason is kept. The stock figures don\'t change.</p>'
            : '<p style="margin-top:0">Everything on hand is recorded as of now. First list any stock on hand that already belongs to a supplier under an approved agreement — it becomes that supplier\'s. All the rest becomes one Total Tools-owned receipt dated today, so it sells before consignment stock received later. This is done once and can\'t be undone.</p>'}
          <div style="font-weight:600;margin:10px 0 6px">Supplier-owned stock on hand</div>
          ${data.rows.length ? `<div id="cons-open-lines" style="display:grid;gap:6px"></div>
            ${after ? '' : '<button class="btn btn-sm btn-outline" style="margin-top:6px" onclick="App._consOpeningAddLine()">+ Add line</button>'}`
            : `<p style="color:var(--text-muted)">No stock on hand is on an approved agreement, so there's nothing to list${after ? '' : ' — everything will be Total Tools-owned'}. An agreement has to be approved before its stock can be recorded here.</p>`}
          ${after ? '<div class="form-group" style="margin-top:10px"><label>Reason *</label><input id="cons-open-note" placeholder="e.g. delivery note CPT-DN-4101 shows these were left on consignment"></div>'
            : `<div class="form-group" style="margin-top:12px"><label>Type START to confirm</label><input id="cons-open-confirm" autocomplete="off" style="max-width:160px"></div>`}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App._consOpeningSave()">${after ? 'Record' : 'Start Tracking'}</button></div>
      </div>`);
    if (data.rows.length) this._consOpeningAddLine();
  },

  _consOpeningAddLine() {
    const box = document.getElementById('cons-open-lines');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'cons-open-line';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    row.innerHTML = `<select class="cons-open-pick" style="flex:1;min-width:260px"><option value="">— Agreement · item · branch —</option>${this._consOpeningCands.map((c, i) =>
      `<option value="${i}">${this.escapeAttr(c.supplier_name)} ${c.agreement_number} · ${this.escapeAttr(c.product_name)} · ${this.escapeAttr(c.branch_name)} (${Number(c.available)} ${this._consOpeningAfter ? "Total Tools'" : 'on hand'})</option>`).join('')}</select>
      <input class="cons-open-qty" type="number" min="0" step="any" placeholder="Qty" style="width:90px">
      ${this._consOpeningAfter ? '' : '<button class="btn btn-sm btn-outline" title="Remove" onclick="this.parentElement.remove()">✕</button>'}`;
    box.appendChild(row);
  },

  async _consOpeningSave() {
    const lines = [...document.querySelectorAll('.cons-open-line')].map(r => {
      const c = this._consOpeningCands[r.querySelector('.cons-open-pick').value];
      const qty = Number(r.querySelector('.cons-open-qty').value) || 0;
      return c && qty ? { agreement_id: c.agreement_id, product_id: c.product_id, branch_id: c.branch_id, qty } : null;
    }).filter(Boolean);
    try {
      if (this._consOpeningAfter) {
        if (!lines.length) { this.alert('Choose the agreement, item and branch and enter the quantity', 'warning'); return; }
        await this.api('POST', '/consignment/opening-stock', { ...lines[0], note: document.getElementById('cons-open-note').value });
        this.closeModal();
        this.alert('Recorded as the supplier\'s stock', 'success');
      } else {
        const out = await this.api('POST', '/consignment/go-live', { confirm: document.getElementById('cons-open-confirm').value.trim(), opening: lines });
        this.closeModal();
        this.alert(`Consignment tracking started — ${out.supplier_owned ? `${out.supplier_owned} supplier-owned line${out.supplier_owned === 1 ? '' : 's'}, the rest` : 'all stock'} recorded as Total Tools-owned`, 'success');
      }
      this.renderConsignment('stock');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Settlements and invoice matching (Phase 4) ─────────────────────────────
  _consSettleStatus: { open: ['Awaiting invoice', 'badge-info'], in_review: ['Differences — Finance', 'badge-warning'], matched: ['Matched — to accept', 'badge-info'], billed: ['Billed', 'badge-success'], cancelled: ['Cancelled', 'badge-secondary'] },
  _consSettleBadge(st) { const [l, c] = this._consSettleStatus[st] || [st, '']; return `<span class="badge-pill ${c}">${l}</span>`; },

  async _consSettlementsTab() {
    const rows = await this.api('GET', '/consignment/settlements');
    const el = document.getElementById('cons-body');
    if (!el) return;
    el.innerHTML = `<div class="card"><div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">A settlement statement is made when Finance approves a period (a month, or 14 days). A/P enters the supplier's invoice against it; any difference goes to Finance; accepting it raises the A/P bill, paid through a payment request.</div>
      <div class="table-wrap"><table>
      <thead><tr><th>Settlement #</th><th>Period</th><th>Supplier</th><th>Agreement</th><th>Supplier invoice</th><th style="text-align:right">Total</th><th>Bill</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map(r => `<tr style="cursor:pointer" onclick="App.viewConsSettlement(${r.id})"><td class="fw-600">${r.settlement_number}</td><td>${this.escapeAttr(r.period_label || r.period)}</td><td>${this.escapeAttr(r.supplier_name)}</td><td>${r.agreement_number}</td>
        <td>${this.escapeAttr(r.invoice_number || '—')}</td><td style="text-align:right">${this.fmt(r.total)}</td><td>${r.bill_number || '—'}</td><td>${this._consSettleBadge(r.status)}</td></tr>`).join('')
        : '<tr><td colspan="8" class="empty-state">No settlements yet — they are made when a period-end reconciliation is approved</td></tr>'}</tbody></table></div></div>`;
  },

  async _consMakeSettlement(reconId) {
    try { const s = await this.api('POST', `/consignment/reconciliations/${reconId}/settlement`, {}); this.viewConsSettlement(s.id); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async viewConsSettlement(id) {
    let s;
    try { s = await this.api('GET', `/consignment/settlements/${id}`); } catch (e) { this.alert(e.message, 'error'); return; }
    this._consSettlement = s;
    const esc = x => this.escapeAttr(x ?? '');
    const n = v => (v == null ? '' : (Math.abs(v) < 0.0005 ? '0' : String(Math.round(v * 1000) / 1000)));
    const th = (x, right = true) => `<th style="text-align:${right ? 'right' : 'left'};white-space:nowrap">${x}</th>`;
    const inv = s.invoice;
    const ap = this.can('payables_bills');
    const fin = this.can('consignment_finance');
    const live = s.status !== 'cancelled';
    const diff = (v, money) => (Math.abs(v) < (money ? 0.005 : 0.0005) ? '<span style="color:var(--text-muted)">—</span>' : `<span style="color:var(--danger);font-weight:600">${v > 0 ? '+' : ''}${money ? this.fmt(v) : n(v)}</span>`);
    const resLabel = { corrected: 'Settlement corrected', variance: 'Approved to Consignment Variance' };
    const invoiceHtml = !inv ? '' : `
      <div style="font-weight:600;margin:14px 0 4px">Supplier invoice ${esc(inv.supplier_invoice_number)} · ${this.fmtDate(inv.invoice_date)} ${this._consSettleBadge(inv.status === 'accepted' ? 'billed' : inv.status)}</div>
      <div style="font-size:12px;margin-bottom:6px">Entered by ${esc(inv.entered_by_name)} · ${inv.tax_invoice ? `Valid tax invoice${inv.supplier_trn ? `, TRN ${esc(inv.supplier_trn)}` : ''}` : 'Not marked as a valid tax invoice'}${inv.notes ? ` · ${esc(inv.notes)}` : ''}</div>
      <div class="table-wrap"><table style="font-size:12px">
        <thead><tr>${th('Item', false)}${th('Settlement qty')}${th('Invoice qty')}${th('Qty diff.')}${th('Unit cost')}${th('Cost diff.')}${th('Settlement amount')}${th('Invoice amount')}${th('Amount diff.')}${th('GCT diff.')}${th('Finance', false)}</tr></thead>
        <tbody>${inv.lines.map(l => `<tr style="${l.flagged && !l.resolution ? 'background:rgba(220,38,38,.06)' : ''}"><td>${esc(l.product_name)}</td>
          <td style="text-align:right">${n(l.settlement_qty)}</td><td style="text-align:right">${n(l.qty)}</td><td style="text-align:right">${diff(l.qty_diff)}</td>
          <td style="text-align:right">${this.fmt(l.unit_cost)}</td><td style="text-align:right">${diff(l.cost_diff, true)}</td>
          <td style="text-align:right">${this.fmt(l.settlement_value)}</td><td style="text-align:right">${this.fmt(l.amount)}</td><td style="text-align:right">${diff(l.value_diff, true)}</td><td style="text-align:right">${diff(l.tax_diff, true)}</td>
          <td>${!l.flagged ? '<span style="color:var(--success, #16a34a)">Matches</span>' : l.resolution ? `${resLabel[l.resolution]}<div style="color:var(--text-muted)">${esc(l.resolved_by_name)}: ${esc(l.resolution_reason)}</div>`
            : fin && inv.status === 'in_review' ? `<button class="btn btn-sm btn-outline" onclick="App._consResolveLine(${s.id}, ${l.id}, 'corrected')">Correct settlement</button> <button class="btn btn-sm btn-outline" onclick="App._consResolveLine(${s.id}, ${l.id}, 'variance')">Approve to variance</button>`
            : '<span style="color:var(--warning, #d97706)">Waiting for Finance</span>'}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="7" style="text-align:right">Invoice subtotal ${this.fmt(inv.subtotal)} · GCT ${this.fmt(inv.tax_amount)} · <strong>Total ${this.fmt(inv.total)}</strong></td><td colspan="4" style="text-align:right">${inv.variance_amount ? `Approved variance ${this.fmt(inv.variance_amount)}` : ''}</td></tr></tfoot>
      </table></div>
      ${inv.bill_number ? `<div style="margin-top:6px">A/P bill <strong>${inv.bill_number}</strong>${this.can('payables') ? ` — <a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewBill(${inv.bill_id})">open it</a>` : ''}; it's paid through a payment request.</div>` : ''}`;
    this.showModal(`
      <div class="modal" style="max-width:1150px;width:96vw">
        <div class="modal-header"><span class="modal-title">${s.settlement_number} — ${esc(s.supplier_name)} · ${s.agreement_number} · ${this.escapeAttr(s.period_label || s.period)}</span>
          <div style="display:flex;gap:8px;align-items:center">${this._consSettleBadge(s.status)}<button class="modal-close">✕</button></div></div>
        <div class="modal-body" style="font-size:12px">
          ${s.status === 'cancelled' ? `<div class="card" style="border-color:var(--danger);color:var(--danger);margin-bottom:10px">Cancelled: ${esc(s.cancel_reason)}</div>` : ''}
          <div style="margin-bottom:8px">From reconciliation <a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewConsRecon(${s.recon_id})">${s.recon_number}</a> · made ${this.fmtDateTime(s.created_at)}</div>
          <div class="table-wrap"><table style="font-size:12px">
            <thead><tr>${th('Item', false)}${th('Sold')}${th('Layaways')}${th('Work orders')}${th('Returned')}${th('Shop use')}${th('Chargeable')}${th('Billable qty')}${th('Unit cost')}${th('Amount')}${th('Expected GCT')}</tr></thead>
            <tbody>${s.lines.map(l => `<tr><td>${esc(l.product_name)}${l.corrected_at ? `<div style="color:var(--warning, #d97706)">Corrected by ${esc(l.corrected_by_name)} (was ${n(l.original_qty)} · ${this.fmt(l.original_value)}): ${esc(l.correction_reason)}</div>` : ''}</td>
              <td style="text-align:right">${n(l.sales_qty)}</td><td style="text-align:right">${n(l.layaway_qty)}</td><td style="text-align:right">${n(l.work_order_qty)}</td>
              <td style="text-align:right">${n(-(l.returns_qty + l.prior_returns_qty))}</td><td style="text-align:right">${n(l.shop_use_qty)}</td><td style="text-align:right">${n(l.chargeable_qty)}</td>
              <td style="text-align:right" class="fw-600">${n(l.billable_qty)}</td><td style="text-align:right">${l.unit_cost == null ? '' : this.fmt(l.unit_cost)}</td>
              <td style="text-align:right" class="fw-600">${this.fmt(l.billable_value)}</td><td style="text-align:right">${this.fmt(l.expected_tax)}</td></tr>`).join('')}</tbody>
            <tfoot><tr><td colspan="9" style="text-align:right">Subtotal</td><td style="text-align:right" class="fw-600">${this.fmt(s.subtotal)}</td><td style="text-align:right">${this.fmt(s.expected_tax)}</td></tr>
              <tr><td colspan="9" style="text-align:right;font-weight:700">Total owed</td><td colspan="2" style="text-align:right;font-weight:700">${this.fmt(s.total)}</td></tr></tfoot></table></div>
          ${s.adjustments.length ? `<div style="font-weight:600;margin:12px 0 4px">Adjustments — returns this period of earlier periods' sales (credited here; those periods stay locked)</div>
            ${s.adjustments.map(a => `<div>${esc(a.return_number || a.kind)} of sale ${esc(a.sale_number)} (${esc(String(a.sale_qualified_on || '').slice(0, 7))}) — ${esc(a.product_name)} × ${n(a.qty)} · credit ${this.fmt(a.value)}${a.goods_condition ? ` · ${esc(a.goods_condition)}` : ''}</div>`).join('')}` : ''}
          ${invoiceHtml}
          ${!inv && live && ap ? this._consInvoiceFormHtml(s) : ''}
          ${!inv && live && !ap ? `<div style="margin-top:12px;color:var(--text-muted)">Waiting for A/P to enter the supplier's invoice.</div>` : ''}
          ${s.credit_notes.length ? `<div style="font-weight:600;margin:12px 0 4px">Supplier credit notes</div>${s.credit_notes.map(c => `<div>${c.payment_number} · ${esc(c.reference)} · ${this.fmtDate(c.payment_date)} · ${this.fmt(c.amount)} ${c.status === 'void' ? '(void)' : ''}</div>`).join('')}` : ''}
          ${s.rejected_invoices.length ? `<div style="font-weight:600;margin:12px 0 4px">Rejected invoices</div>${s.rejected_invoices.map(i => `<div>${esc(i.supplier_invoice_number)} · ${this.fmt(i.total)} — ${esc(i.reject_reason)}</div>`).join('')}` : ''}
          ${s.log.length ? `<div style="font-weight:600;margin:12px 0 4px">History</div>${s.log.map(g => `<div>${this.fmtDateTime(g.created_at)} — ${esc(g.action.replace(/_/g, ' '))} by ${esc(g.employee_name || '—')}${g.details?.reason ? `: ${esc(g.details.reason)}` : ''}</div>`).join('')}` : ''}
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-outline" onclick="App._printServerDocument('/api/consignment/settlements/${s.id}/statement', 'consignment-settlement', 'settlement statement')">Print Statement</button>
          ${!inv && live && ap ? `<button class="btn btn-primary" onclick="App._consSaveInvoice(${s.id})">Match Invoice</button>` : ''}
          ${inv && inv.status === 'matched' && ap ? `<button class="btn btn-success" onclick="App._consAcceptInvoice(${s.id})">Accept — Create A/P Bill</button>` : ''}
          ${inv && ['in_review', 'matched'].includes(inv.status) && (ap || fin) ? `<button class="btn btn-danger" onclick="App._consRejectInvoice(${s.id})">Reject Invoice</button>` : ''}
          ${live && ap ? `<button class="btn btn-outline" onclick="App.showApCreditNoteForm({ supplier_id: ${s.supplier_id}, consignment_settlement_id: ${s.id}, credit_account: 'consignment' })">+ Supplier Credit Note</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  // Prefilled from the settlement; A/P types what the supplier's invoice says.
  _consInvoiceFormHtml(s) {
    const esc = x => this.escapeAttr(x ?? '');
    return `<div class="card" style="margin-top:14px;padding:12px">
      <div style="font-weight:600;margin-bottom:8px">Enter the supplier's invoice</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:8px">
        <div class="form-group" style="margin:0"><label>Invoice # *</label><input id="csi-number"></div>
        <div class="form-group" style="margin:0"><label>Invoice date *</label><input id="csi-date" type="date" value="${this._storeDay()}"></div>
        <div class="form-group" style="margin:0"><label>Supplier TRN</label><input id="csi-trn"></div>
        <div class="form-group" style="margin:0;display:flex;align-items:flex-end"><label style="display:flex;gap:6px;align-items:center"><input id="csi-taxinv" type="checkbox"> Valid supplier tax invoice (GCT)</label></div>
      </div>
      <div class="table-wrap"><table style="font-size:12px" id="csi-lines"><thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit cost</th><th style="text-align:right">GCT</th></tr></thead>
        <tbody>${s.lines.map(l => `<tr data-product="${l.product_id}"><td>${esc(l.product_name)}</td>
          <td style="text-align:right"><input class="csi-qty" type="number" step="any" value="${l.billable_qty}" style="width:80px;text-align:right"></td>
          <td style="text-align:right"><input class="csi-cost" type="number" step="0.01" min="0" value="${l.unit_cost ?? 0}" style="width:100px;text-align:right"></td>
          <td style="text-align:right"><input class="csi-tax" type="number" step="0.01" value="${l.expected_tax}" style="width:90px;text-align:right"></td></tr>`).join('')}</tbody></table></div>
      <div class="form-group" style="margin:8px 0 0"><label>Notes</label><input id="csi-notes"></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Prefilled with the settlement's figures — change them to what the supplier's invoice says. Any difference is flagged for Finance.</div>
    </div>`;
  },

  async _consSaveInvoice(id) {
    const lines = [...document.querySelectorAll('#csi-lines tbody tr')].map(tr => ({
      product_id: Number(tr.dataset.product), qty: Number(tr.querySelector('.csi-qty').value) || 0,
      unit_cost: Number(tr.querySelector('.csi-cost').value) || 0, tax_amount: Number(tr.querySelector('.csi-tax').value) || 0,
    }));
    const body = {
      supplier_invoice_number: document.getElementById('csi-number').value, invoice_date: document.getElementById('csi-date').value,
      supplier_trn: document.getElementById('csi-trn').value, tax_invoice: document.getElementById('csi-taxinv').checked,
      notes: document.getElementById('csi-notes').value, lines,
    };
    try {
      const s = await this.api('POST', `/consignment/settlements/${id}/invoice`, body);
      this.alert(s.invoice.status === 'matched' ? 'The invoice matches the settlement — accept it to create the A/P bill' : 'Differences found — sent to Finance', s.invoice.status === 'matched' ? 'success' : 'warning');
      this.viewConsSettlement(id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _consResolveLine(id, lineId, resolution) {
    const reason = prompt(resolution === 'corrected' ? "Why was the settlement wrong? (it will take the invoice's figures)" : 'Why is this difference approved to Consignment Variance?');
    if (!reason) return;
    try { await this.api('POST', `/consignment/settlements/${id}/invoice/lines/${lineId}/resolve`, { resolution, reason }); this.viewConsSettlement(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _consAcceptInvoice(id) {
    if (!confirm('Create the A/P bill for this invoice? It is then paid through a payment request.')) return;
    try { await this.api('POST', `/consignment/settlements/${id}/invoice/accept`, {}); this.alert('A/P bill created', 'success'); this.viewConsSettlement(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _consRejectInvoice(id) {
    const reason = prompt('Why is the invoice rejected? (e.g. the supplier is sending a corrected one)');
    if (!reason) return;
    try { await this.api('POST', `/consignment/settlements/${id}/invoice/reject`, { reason }); this.viewConsSettlement(id); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // ── Books postings (accruals, month-end, reversals) ────────────────────────
  async _consPostingsTab() {
    const { postings, counts } = await this.api('GET', '/consignment/postings');
    const el = document.getElementById('cons-body');
    if (!el) return;
    const role = { cost_of_sales: 'Consignment Cost of Sales', obligation: 'Accrued Consignment Obligation', variance: 'Consignment Variance', chargeable: 'Shortages & Damage Chargeable', inventory: 'Inventory' };
    const label = { pending: 'Waiting for Books', waiting: 'Books accounts not set', failed: 'Failed', posted: 'Posted' };
    const badge = { pending: 'badge-info', waiting: 'badge-warning', failed: 'badge-danger', posted: 'badge-success' };
    el.innerHTML = `<div class="card">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Entries RetailPOS Books posts: the supplier's cost accrued as each sale qualifies (and reversed by returns), and at period-end the approved chargeable shortages/damage and shop use. Books posts them once its four consignment accounts are set in its Settings. Settlement bills and supplier credit notes go through Accounts Payable.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${counts.map(c => `<span class="badge-pill ${badge[c.status] || ''}">${label[c.status] || c.status}: ${c.n} · ${this.fmt(c.amount)}</span>`).join('') || '<span style="color:var(--text-muted)">Nothing yet</span>'}</div>
      <div class="table-wrap"><table style="font-size:12px">
        <thead><tr><th>Date</th><th>Supplier</th><th>Reference</th><th>For</th><th>Debit</th><th>Credit</th><th style="text-align:right">Amount</th><th>Status</th></tr></thead>
        <tbody>${postings.length ? postings.map(p => `<tr><td>${this.fmtDate(p.posting_date)}</td><td>${this.escapeAttr(p.supplier_name || '')}</td><td>${this.escapeAttr(p.reference || '')}</td><td>${this.escapeAttr(p.memo || '')}</td>
          <td>${role[p.debit_role] || p.debit_role}${p.debit_role === 'inventory' && p.inventory_account_code ? ` (${p.inventory_account_code})` : ''}</td><td>${role[p.credit_role] || p.credit_role}</td>
          <td style="text-align:right">${this.fmt(p.amount)}</td><td><span class="badge-pill ${badge[p.status] || ''}" ${p.last_error ? `title="${this.escapeAttr(p.last_error)}"` : ''}>${label[p.status] || p.status}</span>${p.external_ref ? `<div>${this.escapeAttr(p.external_ref)}</div>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="8" class="empty-state">No entries yet</td></tr>'}</tbody></table></div></div>`;
  },
});

