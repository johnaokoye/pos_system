// Customers: duplicates, form, history, CSV import/export, shared customer picker.
Object.assign(App, {
  // ─── Customers ────────────────────────────────────────────
  // ─── Find Duplicates ──────────────────────────────────────
  // Groups of active customers sharing a phone number or email (GET
  // /customers/duplicates). Pick the one to keep and merge the rest into it
  // (lib/customerMerge.js), or mark the group as not duplicates.
  async renderCustomerDuplicates(page = 1) {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Looking for duplicates…</p></div>';
    let data;
    try { data = await this.api('GET', `/customers/duplicates?page=${page}`); }
    catch (e) { c.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (this.section !== 'customers') return;
    this._dupPage = page;
    const pages = Math.max(1, Math.ceil(data.total_groups / data.page_size));
    const esc = v => this.escapeAttr(v ?? '');
    const date = d => d ? this.fmtDate(d) : '—';
    const groupHtml = g => `
      <div class="card" id="dup-group-${g.key.replace(/,/g, '-')}" style="margin-bottom:14px;padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
          <div style="font-size:13px"><strong>${g.customers.length} customers</strong> <span style="color:var(--text-muted)">share ${g.shared.map(esc).join(' · ')}</span></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-secondary btn-sm" onclick="App._dismissDuplicateGroup('${g.key}')">Not Duplicates</button>
            <button class="btn btn-primary btn-sm" onclick="App._mergeDuplicateGroup('${g.key}')">Merge into Kept Customer</button>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th style="width:52px">Keep</th><th>Customer</th><th>Phone / Email</th><th>Address</th><th>History</th><th>Balance</th><th>Added</th></tr></thead>
          <tbody>${g.customers.map(cu => `<tr>
            <td><input type="radio" name="dup-keep-${g.key}" value="${cu.id}" ${cu.id === g.suggested_keep_id ? 'checked' : ''} style="width:auto"></td>
            <td><div class="fw-600">${esc(cu.name)}</div><div style="font-size:11px;color:var(--text-muted);font-family:monospace">${esc(cu.customer_number)}</div>
              <div style="margin-top:3px">${cu.customer_type === 'credit' ? '<span class="badge-pill badge-info" style="font-size:10px">Credit</span>' : '<span class="badge-pill" style="font-size:10px;background:#e0e0e0;color:#555">Cash</span>'}${cu.rental_approved ? ' <span class="badge-pill badge-success" style="font-size:10px">Rental Approved</span>' : cu.is_rental_customer ? ' <span class="badge-pill badge-purple" style="font-size:10px">Rental</span>' : ''}${cu.customer_kind === 'business' ? ' <span class="badge-pill badge-secondary" style="font-size:10px">Business</span>' : ''}</div></td>
            <td style="font-size:12px">${esc(cu.phone) || '—'}<br><span style="color:var(--text-muted)">${esc(cu.email) || '—'}</span></td>
            <td style="font-size:12px;color:var(--text-muted)">${esc(cu.address) || '—'}</td>
            <td style="font-size:12px">${cu.sales_count} sale${cu.sales_count === 1 ? '' : 's'}${cu.rentals_count ? ` · ${cu.rentals_count} rental${cu.rentals_count === 1 ? '' : 's'}` : ''}${cu.legacy_invoice_count ? ` · ${cu.legacy_invoice_count} legacy inv.` : ''}${cu.last_sale_at ? `<br><span style="color:var(--text-muted)">last ${date(cu.last_sale_at)}</span>` : ''}</td>
            <td style="font-size:12px">${cu.account_balance ? this.fmt(cu.account_balance) : '—'}</td>
            <td style="font-size:12px;color:var(--text-muted)">${date(cu.created_at)}${cu.from_import ? '<br>by import' : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    this._dupGroups = Object.fromEntries(data.groups.map(g => [g.key, g]));
    c.innerHTML = `
      <div class="section-header" style="gap:16px;flex-wrap:wrap">
        <h2>Duplicate Customers</h2>
        <button class="btn btn-secondary btn-sm" onclick="App.renderCustomers()">&larr; Back to Customers</button>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:-6px 0 14px">${data.total_groups ? `${data.total_groups.toLocaleString()} group${data.total_groups === 1 ? '' : 's'} of active customers (${data.total_customers.toLocaleString()} customers) share a phone number or email. In each group, pick the customer to <strong>keep</strong> — the suggestion is the one with the most history — and merge the others into it: their sales, rentals, payments, quotes, layaways, work orders, legacy invoices and contacts move over, balances and loyalty points are added together, details the kept customer is missing are filled in, and the others are deactivated (marked as merged, not deleted). Merging can't be undone.` : 'No duplicates found — no two active customers share a phone number or email.'}</p>
      ${data.groups.map(groupHtml).join('')}
      ${pages > 1 ? `<div style="display:flex;gap:8px;align-items:center;justify-content:center;margin:10px 0">
        <button class="btn btn-secondary btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="App.renderCustomerDuplicates(${page - 1})">&larr; Previous</button>
        <span style="font-size:13px;color:var(--text-muted)">Page ${page} of ${pages}</span>
        <button class="btn btn-secondary btn-sm" ${page >= pages ? 'disabled' : ''} onclick="App.renderCustomerDuplicates(${page + 1})">Next &rarr;</button>
      </div>` : ''}`;
  },

  _removeDuplicateGroupCard(key) {
    document.getElementById(`dup-group-${key.replace(/,/g, '-')}`)?.remove();
    if (!document.querySelector('[id^="dup-group-"]')) this.renderCustomerDuplicates(this._dupPage || 1);
  },

  async _dismissDuplicateGroup(key) {
    try {
      await this.api('POST', '/customers/duplicates/dismiss', { ids: key.split(',').map(Number) });
      this._removeDuplicateGroupCard(key);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _mergeDuplicateGroup(key) {
    const g = this._dupGroups?.[key];
    const keepId = Number(document.querySelector(`input[name="dup-keep-${key}"]:checked`)?.value);
    if (!g || !keepId) return;
    const keep = g.customers.find(cu => cu.id === keepId);
    const others = g.customers.filter(cu => cu.id !== keepId);
    let preview = {};
    try { preview = await this.api('GET', `/customers/merge-preview?ids=${others.map(o => o.id).join(',')}`); } catch (e) {}
    const labels = { transactions: 'sales', returns: 'returns', account_payments: 'payments', ar_legacy_invoices: 'legacy invoices', quotations: 'quotes', rental_agreements: 'rentals', layaway_plans: 'layaways', work_orders: 'work orders', shipments: 'shipments', crm_leads: 'CRM leads', crm_opportunities: 'CRM opportunities', crm_activities: 'CRM activities', customer_contacts: 'contacts' };
    const moving = o => { const p = preview[o.id] || {}; const parts = Object.entries(p).map(([t, n]) => `${n} ${labels[t] || t}`); return parts.length ? parts.join(', ') : 'no history'; };
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header"><span class="modal-title">Merge Duplicate Customers</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="font-size:13px">
          <p>Keep <strong>${this.escapeAttr(keep.name)}</strong> (${this.escapeAttr(keep.customer_number)}) and merge into it:</p>
          <ul style="margin:8px 0 12px 18px">${others.map(o => `<li><strong>${this.escapeAttr(o.name)}</strong> (${this.escapeAttr(o.customer_number)}) — ${moving(o)}${o.account_balance ? `, balance ${this.fmt(o.account_balance)}` : ''}</li>`).join('')}</ul>
          <p style="color:var(--text-muted)">Their history moves to ${this.escapeAttr(keep.name)}, balances and loyalty points are added together, missing details are filled in, and they're deactivated. This can't be undone.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" id="dup-merge-confirm">Merge ${others.length} into ${this.escapeAttr(keep.name)}</button>
        </div>
      </div>`);
    document.getElementById('dup-merge-confirm').addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        await this.api('POST', '/customers/merge', { keep_id: keepId, merge_ids: others.map(o => o.id) });
        this.closeModal();
        this.alert(`Merged ${others.length} customer${others.length === 1 ? '' : 's'} into ${keep.name}`);
        this._removeDuplicateGroupCard(key);
      } catch (err) { e.target.disabled = false; this.alert(err.message, 'error'); }
    });
  },

  // Search box + type filter together (GET /customers ?search= &type=), one
  // page at a time (?paged=1 → { rows, total }).
  _customerListQuery(offset = 0) {
    const q = (document.getElementById('cust-search')?.value || '').trim();
    const type = document.getElementById('cust-type-filter')?.value || '';
    return `/customers?active=1&paged=1&offset=${offset}${q ? `&search=${encodeURIComponent(q)}` : ''}${type ? `&type=${type}` : ''}`;
  },

  // Customers filter bar as it stands, so a save / deactivate re-renders on
  // the same customer; `fallback` fills the search only when it was empty.
  _custFilterState(fallback = {}) {
    if (this.section !== 'customers') return null;
    const val = id => (document.getElementById(id) || {}).value || '';
    return { search: val('cust-search') || fallback.search || '', type: val('cust-type-filter') };
  },

  async renderCustomers(filters = null) {
    if (this.section !== 'customers') return;

    document.getElementById('content').innerHTML = `
      <div class="section-header" style="gap:16px;flex-wrap:wrap">
        <h2>Customers</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          ${this.can('customers_import') ? `<a class="btn btn-secondary btn-sm" style="white-space:nowrap;text-decoration:none" href="/api/customers/export/template" download title="Download import template">&#8659; Template</a>` : ''}
          ${this.can('customers_import') ? `<label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0;white-space:nowrap;text-transform:none;letter-spacing:normal" title="Import customers from CSV or Excel">&#8657; Import<input type="file" accept=".csv,.tsv,.txt,.xls,.xlsx" style="display:none" onchange="App.importCustomersCsv(this)"></label>` : ''}
          ${this.can('customers_import_history') ? `<button class="btn btn-secondary btn-sm" style="white-space:nowrap" onclick="App.showCustomerImportHistory()" title="Review or reverse past CSV imports">Import History</button>` : ''}
          ${this.can('customers_export_balances') ? `<button class="btn btn-secondary btn-sm" style="white-space:nowrap" onclick="App.showCustomerBalancesExport()" title="Export AR balance, credit note total, and status by customer type">Export Balances</button>` : ''}
          ${this.can('customers_missing_rental_info') ? `<button class="btn btn-secondary btn-sm" style="white-space:nowrap" onclick="App.showRentalIncompleteReport()" title="Rental customers missing the ID/reference/document info required to create a rental">🔑 Missing Rental Info</button>` : ''}
          ${this.can('customers_merge') ? `<button class="btn btn-secondary btn-sm" style="white-space:nowrap" onclick="App.renderCustomerDuplicates()" title="Customers sharing a phone number or email — review and merge">Find Duplicates</button>` : ''}
          ${this.can('customers_add') ? `<button class="btn btn-primary" style="white-space:nowrap" onclick="App.showCustomerForm()">+ Add Customer</button>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <div class="search-bar" style="flex:1 1 280px;max-width:420px">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" id="cust-search" placeholder="Search name, number, phone or email…" style="width:100%">
        </div>
        <select id="cust-type-filter" title="Show only this kind of customer" style="width:auto;flex:0 0 auto">
          <option value="">All Customers</option>
          <option value="credit">Credit</option>
          <option value="cash">Cash</option>
          <option value="rental_approved">Rental Approved</option>
          <option value="other">Other (not rental approved)</option>
        </select>
        <span id="cust-count" style="font-size:13px;color:var(--text-muted);margin-left:auto"></span>
      </div>
      <div class="card">
        <div class="table-wrap" id="cust-table" style="max-height:65vh;overflow-y:auto"
          onscroll="if(this.scrollTop+this.clientHeight>=this.scrollHeight-400)App._custMoreRows()"></div>
      </div>`;

    if (filters) {
      document.getElementById('cust-search').value = filters.search || '';
      document.getElementById('cust-type-filter').value = filters.type || '';
    }

    // Search once typing pauses (Enter at once); _custLoad ignores replies
    // to anything but the latest request.
    let searchTimer;
    const searchEl = document.getElementById('cust-search');
    searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => this._custLoad(), 250); });
    searchEl.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); this._custLoad(); } });
    document.getElementById('cust-type-filter').addEventListener('change', () => this._custLoad());
    await this._custLoad();
  },

  // First page of the list for the current filters.
  async _custLoad() {
    const seq = this._custSeq = (this._custSeq || 0) + 1;
    this._custList = null; // no "next page" against the old list meanwhile
    const { rows, total } = await this.api('GET', this._customerListQuery(0));
    if (seq !== this._custSeq || !document.getElementById('cust-table')) return;
    this._custList = { shown: rows.length, total, loading: false };
    this.buildCustomerTable(rows, total);
  },

  // Next page, when the table is scrolled near its bottom.
  async _custMoreRows() {
    const t = this._custList, seq = this._custSeq;
    if (!t || t.loading || t.shown >= t.total) return;
    t.loading = true;
    try {
      const { rows } = await this.api('GET', this._customerListQuery(t.shown));
      if (seq !== this._custSeq || t !== this._custList) return;
      t.shown += rows.length;
      document.getElementById('cust-tbody')?.insertAdjacentHTML('beforeend', this._custRowsHtml(rows));
      const shownEl = document.getElementById('cust-shown');
      if (shownEl) shownEl.textContent = t.shown.toLocaleString();
      if (t.shown >= t.total || !rows.length) { t.shown = t.total; document.getElementById('cust-more')?.remove(); }
    } finally { t.loading = false; }
  },

  buildCustomerTable(customers, total = customers.length) {
    const el = document.getElementById('cust-table');
    if (!el) return;
    const count = document.getElementById('cust-count');
    if (count) count.textContent = `${total.toLocaleString()} customer${total === 1 ? '' : 's'}`;
    if (!customers.length) { el.innerHTML = '<div class="empty-state"><p>No customers found</p></div>'; return; }
    el.innerHTML = `<table class="sticky-table">
      <thead><tr><th>Customer #</th><th>Name</th><th>Type</th><th>Email</th><th>Phone</th><th>City</th><th>Loyalty Pts</th><th>Total Spent</th><th>Actions</th></tr></thead>
      <tbody id="cust-tbody">${this._custRowsHtml(customers)}</tbody>
    </table>
    ${customers.length < total ? `<div id="cust-more" style="padding:10px;text-align:center;color:var(--text-muted);font-size:12px">
      Showing <span id="cust-shown">${customers.length.toLocaleString()}</span> of ${total.toLocaleString()} — scroll for more
    </div>` : ''}`;
  },

  _custRowsHtml(customers) {
    return customers.map(c => {
        const isCredit = c.customer_type === 'credit';
        const typeBadge = isCredit
          ? `<span class="badge-pill badge-info">Credit</span>${c.account_blocked ? ' <span class="badge-pill badge-danger">Blocked</span>' : ''}`
          : '<span class="badge-pill" style="background:#e0e0e0;color:#555">Cash</span>';
        const taxExemptBadge = c.tax_exempt ? ' <span class="badge-pill" style="background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7">Tax Exempt</span>' : '';
        const rentalBadge = c.is_rental_customer ? ' <span class="badge-pill badge-purple">🔑 Rental</span>' : '';
        const preapprovedBadge = c.is_rental_customer && c.rental_preapproved ? ' <span class="badge-pill badge-success" title="Can be rented to despite incomplete compliance info">Preapproved</span>' : '';
        return `<tr>
        <td style="font-family:monospace;font-size:12px">${c.customer_number}</td>
        <td class="fw-600">${c.first_name} ${c.last_name}${c.customer_kind === 'business' ? ' <span class="badge-pill badge-secondary" style="font-size:10px">Business</span>' : ''}</td>
        <td style="white-space:nowrap">${typeBadge}${taxExemptBadge}${rentalBadge}${preapprovedBadge}</td>
        <td style="color:var(--text-muted)">${c.email||'—'}</td>
        <td>${c.phone||'—'}</td>
        <td style="color:var(--text-muted)">${c.city||'—'}</td>
        <td><span class="badge-pill badge-info">🏆 ${c.loyalty_points}</span></td>
        <td class="fw-600">${this.fmt(c.total_spent)}</td>
        <td>
          ${this.can('customers_edit') ? `<button class="btn btn-secondary btn-sm" onclick="App.showCustomerForm(${c.id})">Edit</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="App.viewCustomer(${c.id})">History</button>
        </td>
      </tr>`;}).join('');
  },

  async showCustomerForm(id, opts = {}) {
    const [c, cardTypes, cashBackCardTypes, customerCategories] = await Promise.all([
      id ? this.api('GET', `/customers/${id}`).then(c => ({ ...c, ...(opts.prefill || {}) })) : Promise.resolve({ ...(opts.prefill || {}) }),
      this.api('GET', '/discount-cards'),
      this.api('GET', '/cash-back-cards'),
      this.api('GET', '/customer-categories'),
    ]);
    this._custFormNumber = c.customer_number || '';
    const isCredit = (c.customer_type || 'cash') === 'credit';
    const isTaxExempt = c.tax_exempt ? true : false;
    const isRentalCust = c.is_rental_customer ? true : false;
    const isBusiness = c.customer_kind === 'business';
    // A business always offers at least 3 contact rows.
    const contactRows = [...(c.contacts || [])];
    while (contactRows.length < 3) contactRows.push({});
    // Include the customer's current type even if it's since been
    // deactivated, so editing them doesn't silently drop it from the list.
    const cardTypeOptions = c.discount_card_type_id && !cardTypes.some(t => t.id === c.discount_card_type_id)
      ? [...cardTypes, { id: c.discount_card_type_id, name: `${c.discount_card_type_name} (inactive)` }]
      : cardTypes;
    const cashBackCardTypeOptions = c.cash_back_card_type_id && !cashBackCardTypes.some(t => t.id === c.cash_back_card_type_id)
      ? [...cashBackCardTypes, { id: c.cash_back_card_type_id, name: `${c.cash_back_card_type_name} (inactive)` }]
      : cashBackCardTypes;
    const customerCategoryOptions = c.customer_category_id && !customerCategories.some(t => t.id === c.customer_category_id)
      ? [...customerCategories, { id: c.customer_category_id, name: `${c.customer_category_name} (inactive)`, discount_percent: 0 }]
      : customerCategories;
    this.showModal(`
      <div class="modal">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit Customer' : 'Add Customer'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group" style="display:flex;gap:18px;align-items:center;margin-bottom:12px">
            <label style="margin:0;font-weight:600">Customer is</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal;cursor:pointer"><input type="radio" name="cf-kind" value="individual" ${!isBusiness?'checked':''} onchange="App._toggleCustomerKind()" style="width:auto;margin:0"> Individual</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal;cursor:pointer"><input type="radio" name="cf-kind" value="business" ${isBusiness?'checked':''} onchange="App._toggleCustomerKind()" style="width:auto;margin:0"> Business</label>
          </div>
          <div class="input-row" id="cf-individual-names" style="${isBusiness?'display:none':''}">
            <div class="form-group"><label>First Name *</label><input id="cf-first" value="${this.escapeAttr(isBusiness ? '' : c.first_name)}"></div>
            <div class="form-group"><label>Last Name *</label><input id="cf-last" value="${this.escapeAttr(isBusiness ? '' : c.last_name)}"></div>
          </div>
          <div class="form-group" id="cf-business-name-wrap" style="${isBusiness?'':'display:none'}"><label>Business Name *</label><input id="cf-business-name" value="${this.escapeAttr(isBusiness ? (c.business_name || c.first_name) : '')}"></div>
          <div class="input-row">
            <div class="form-group"><label>Email</label><input type="email" id="cf-email" value="${c.email||''}"></div>
            <div class="form-group"><label>Phone</label><input id="cf-phone" value="${c.phone||''}"></div>
          </div>
          <div class="form-group"><label id="cf-addr-label">${isBusiness ? 'Business Address' : 'Address'}</label><input id="cf-addr" value="${c.address||''}"></div>
          <div class="input-row-3">
            <div class="form-group"><label>City</label><input id="cf-city" value="${c.city||''}"></div>
            <div class="form-group"><label>Parish</label><input id="cf-state" value="${c.state||''}"></div>
            <div class="form-group"><label>ZIP</label><input id="cf-zip" value="${c.zip||''}"></div>
          </div>
          <div id="cf-contacts-section" style="${isBusiness?'':'display:none'};border-top:1px solid var(--border);margin-top:4px;padding-top:12px;margin-bottom:12px">
            <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Contact Persons</strong>
            <p style="font-size:11px;color:var(--text-muted);margin:2px 0 8px">The people you deal with at this business. Leave unused rows blank.</p>
            <div id="cf-contacts">${contactRows.map(ct => this._customerContactRowHtml(ct)).join('')}</div>
            <button type="button" class="btn btn-secondary btn-sm" onclick="App._addCustomerContactRow()">+ Add Contact</button>
          </div>
          <div class="form-group"><label>Salesperson</label>
            <select id="cf-salesperson" data-current="${c.salesperson_id||''}" ${this.can('sales_manager') ? '' : 'disabled'} title="Owns this customer's transactions: they count toward this person's sales targets and commission"><option value="">None</option></select>
          </div>
          <div class="form-group"><label>Notes</label><textarea id="cf-notes" rows="2">${c.notes||''}</textarea></div>
          <div class="form-group">
            <label>Customer Type</label>
            <select id="cf-type" onchange="App.toggleCreditFields()" ${this.can('customers_credit') ? '' : 'disabled'}>
              <option value="cash" ${!isCredit?'selected':''}>Cash</option>
              <option value="credit" ${isCredit?'selected':''}>Credit</option>
            </select>
            ${this.can('customers_credit') ? '' : '<p style="font-size:11px;color:var(--text-muted);margin-top:4px">Switching between Cash and Credit, and credit limits and terms, need the Manage Credit Limits permission.</p>'}
          </div>
          <div class="form-group"><label>Customer Category</label>
            <select id="cf-category">
              <option value="">— None —</option>
              ${customerCategoryOptions.map(cat => `<option value="${cat.id}" ${c.customer_category_id===cat.id?'selected':''}>${cat.name}${cat.discount_percent > 0 ? ` (${cat.discount_percent}% off)` : ''}</option>`).join('')}
            </select>
            <p style="font-size:11px;color:var(--text-muted);margin-top:4px">A classification like Individual/Company/Contractor — separate from the Cash/Credit type above. Set up in Settings.</p>
          </div>
          <div id="cf-credit-fields" style="display:${isCredit?'block':'none'}">
            <div class="input-row">
              <div class="form-group"><label>Credit Terms (days)</label><input type="number" id="cf-terms" value="${c.credit_terms_days||30}" min="1" placeholder="e.g. 30" ${this.can('customers_credit') ? '' : 'readonly'}></div>
              <div class="form-group"><label>Credit Limit</label><input type="number" id="cf-limit" value="${c.credit_limit||0}" min="0" step="0.01" placeholder="0 = unlimited" ${this.can('customers_credit') ? '' : 'readonly'}></div>
            </div>
            ${id && c.credit_block ? this._creditBlockBoxHtml(c) : ''}
          </div>
          <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">
            <label style="display:flex;align-items:center;gap:4px;font-weight:600;cursor:pointer">
              Tax Exempt
              <input type="checkbox" id="cf-tax-exempt" ${isTaxExempt?'checked':''} onchange="App.toggleTaxExemptFields()" style="margin:0">
            </label>
            <div id="cf-tax-exempt-fields" style="display:${isTaxExempt?'block':'none'};margin-top:10px">
              <div class="form-group"><label>Tax Exemption Reference #</label><input id="cf-tax-ref" value="${c.tax_exemption_number||''}" placeholder="e.g. EX-123456"></div>
            </div>
          </div>
          <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">
            <label style="display:flex;align-items:center;gap:4px;font-weight:600;cursor:pointer">
              Rental Customer
              <input type="checkbox" id="cf-rental-customer" ${isRentalCust?'checked':''} onchange="App.toggleRentalCustomerFields()" style="margin:0">
            </label>
            <p style="font-size:11px;color:var(--text-muted);margin:2px 0 0">Required for anyone renting equipment — a valid photo ID, an uploaded proof of address, and three references on file.</p>
            <div id="cf-rental-customer-fields" style="display:${isRentalCust?'block':'none'};margin-top:10px">
              <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Photo ID</strong>
              <div class="input-row" style="margin-top:6px">
                <div class="form-group"><label>ID Type</label>
                  <select id="cf-id-type">
                    <option value="">-- Select --</option>
                    ${['Driver\'s License','Passport','National ID','Voter ID','Other'].map(t => `<option value="${t}" ${c.rental_id_type===t?'selected':''}>${t}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group"><label>ID Number</label><input id="cf-id-number" value="${c.rental_id_number||''}"></div>
              </div>
              ${id ? `<div class="form-group" style="margin-top:4px"><label>ID Scan</label>
                <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
                  ${c.rental_id_scan_path ? `<img src="${c.rental_id_scan_path}" class="prod-img-thumb" id="cf-id-scan-preview" alt="">` : `<div class="prod-img-placeholder" id="cf-id-scan-preview" onclick="document.getElementById('cf-id-scan-input').click()">📷</div>`}
                  <div>
                    <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">Upload Scan<input type="file" id="cf-id-scan-input" accept="image/*" style="display:none" onchange="App.uploadCustomerIdScan(${id},this)"></label>
                    ${c.rental_id_scan_path ? `<button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="App.deleteCustomerIdScan(${id})">Remove</button>` : ''}
                  </div>
                </div>
              </div>` : `<p style="font-size:11px;color:var(--text-muted);margin-top:6px">Save the customer first to upload an ID scan.</p>`}
              <hr style="margin:12px 0">
              <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Proof of Address</strong>
              <div class="form-group" style="margin-top:6px"><label>Document Type</label>
                <select id="cf-address-proof-type">
                  <option value="">-- Select --</option>
                  ${['Utility Bill','Bank Statement','Lease Agreement','Government Letter','Other'].map(t => `<option value="${t}" ${c.rental_address_proof_type===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              ${id ? `<div class="form-group" style="margin-top:4px"><label>Document</label>
                <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
                  ${c.rental_address_proof_path
                    ? (/^image\//.test(c.rental_address_proof_mime||'')
                        ? `<img src="${c.rental_address_proof_path}" class="prod-img-thumb" id="cf-address-proof-preview" alt="">`
                        : `<a href="${c.rental_address_proof_path}" target="_blank" class="prod-img-placeholder" id="cf-address-proof-preview" style="text-decoration:none;font-size:22px">📄</a>`)
                    : `<div class="prod-img-placeholder" id="cf-address-proof-preview" onclick="document.getElementById('cf-address-proof-input').click()">📄</div>`}
                  <div>
                    <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">Upload Document<input type="file" id="cf-address-proof-input" accept="image/*,application/pdf" style="display:none" onchange="App.uploadCustomerAddressProof(${id},this)"></label>
                    ${c.rental_address_proof_path ? `<button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="App.deleteCustomerAddressProof(${id})">Remove</button>` : ''}
                  </div>
                </div>
              </div>` : `<p style="font-size:11px;color:var(--text-muted);margin-top:6px">Save the customer first to upload a proof-of-address document.</p>`}
              <hr style="margin:12px 0">
              <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Reference 1 (Main)</strong>
              <div class="input-row" style="margin-top:6px">
                <div class="form-group"><label>Name</label><input id="cf-ref-name" value="${this.escapeAttr(c.rental_reference_name)}"></div>
                <div class="form-group"><label>Phone</label><input id="cf-ref-phone" value="${c.rental_reference_phone||''}"></div>
              </div>
              <div class="input-row">
                <div class="form-group"><label>Relationship</label><input id="cf-ref-relationship" value="${c.rental_reference_relationship||''}" placeholder="e.g. Employer, Family, Friend"></div>
                <div class="form-group"><label>Address</label><input id="cf-ref-address" value="${c.rental_reference_address||''}"></div>
              </div>
              ${id ? `<div class="form-group" style="margin-top:4px"><label>Reference's Photo ID</label>
                <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
                  ${c.rental_reference_id_path ? `<img src="${c.rental_reference_id_path}" class="prod-img-thumb" id="cf-reference-id-preview" alt="">` : `<div class="prod-img-placeholder" id="cf-reference-id-preview" onclick="document.getElementById('cf-reference-id-input').click()">📷</div>`}
                  <div>
                    <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">Upload ID<input type="file" id="cf-reference-id-input" accept="image/*" style="display:none" onchange="App.uploadCustomerReferenceId(${id},this)"></label>
                    ${c.rental_reference_id_path ? `<button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="App.deleteCustomerReferenceId(${id})">Remove</button>` : ''}
                  </div>
                </div>
              </div>` : `<p style="font-size:11px;color:var(--text-muted);margin-top:6px">Save the customer first to upload the main reference's ID.</p>`}
              <hr style="margin:12px 0">
              <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Reference 2</strong>
              <div class="input-row" style="margin-top:6px">
                <div class="form-group"><label>Name</label><input id="cf-ref2-name" value="${this.escapeAttr(c.rental_reference2_name)}"></div>
                <div class="form-group"><label>Phone</label><input id="cf-ref2-phone" value="${c.rental_reference2_phone||''}"></div>
              </div>
              <div class="form-group"><label>Relationship</label><input id="cf-ref2-relationship" value="${c.rental_reference2_relationship||''}" placeholder="e.g. Employer, Family, Friend"></div>
              <hr style="margin:12px 0">
              <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Reference 3</strong>
              <div class="input-row" style="margin-top:6px">
                <div class="form-group"><label>Name</label><input id="cf-ref3-name" value="${this.escapeAttr(c.rental_reference3_name)}"></div>
                <div class="form-group"><label>Phone</label><input id="cf-ref3-phone" value="${c.rental_reference3_phone||''}"></div>
              </div>
              <div class="form-group"><label>Relationship</label><input id="cf-ref3-relationship" value="${c.rental_reference3_relationship||''}" placeholder="e.g. Employer, Family, Friend"></div>
              <hr style="margin:12px 0">
              <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Preapproved (Legacy Migration)</strong>
              ${this.can('customers_rental_preapprove') && (c.created_by_import || c.rental_preapproved) ? `
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;margin-top:6px">
                <input type="checkbox" id="cf-rental-preapproved" ${c.rental_preapproved?'checked':''} style="margin:0">
                Preapproved — allow rentals despite incomplete info above
              </label>
              <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">For rental customers migrated from a previous system whose old export didn't carry the ID/reference/document data above. Still shows on the Missing Rental Info report until those fields are actually filled in — this only stops the gap from blocking a new rental today.</p>
              ` : `
              <p style="font-size:12px;margin-top:6px;${c.rental_preapproved ? 'color:#2e7d32' : 'color:var(--text-muted)'}">${c.rental_preapproved ? '✓ Preapproved for rentals despite incomplete info' : 'Not preapproved'}</p>
              ${!c.rental_preapproved ? `<p style="font-size:11px;color:var(--text-muted);margin:2px 0 0">Only customers created by a customer import can be preapproved — complete the ID, proof of address and references above before renting.</p>` : ''}
              `}
              ${c.rental_preapproved && c.rental_preapproved_at ? `<p style="font-size:11px;color:var(--text-muted);margin-top:2px">Approved ${this.fmtDate(c.rental_preapproved_at)}${c.rental_preapproved_by_name ? ' by ' + c.rental_preapproved_by_name : ''}</p>` : ''}
            </div>
          </div>
          <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">
            <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Discount Card</strong>
            <p style="font-size:11px;color:var(--text-muted);margin:2px 0 8px">Assigning a card type here activates it — the discount auto-applies at checkout when this customer is on the cart.</p>
            <div class="input-row">
              <div class="form-group"><label>Card Type</label>
                <select id="cf-discount-card-type">
                  <option value="">— None —</option>
                  ${cardTypeOptions.map(t => `<option value="${t.id}" ${c.discount_card_type_id===t.id?'selected':''}>${t.name}</option>`).join('')}
                </select>
              </div>
              <div class="form-group"><label>Card Number</label><input id="cf-discount-card-number" value="${c.discount_card_number||''}"></div>
            </div>
          </div>
          <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">
            <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Cash Back Card</strong>
            <p style="font-size:11px;color:var(--text-muted);margin:2px 0 8px">Assigning a card type here lets this customer redeem cash back from their loyalty points at checkout, once the type's redemption rules are met.</p>
            <div class="input-row">
              <div class="form-group"><label>Card Type</label>
                <select id="cf-cash-back-card-type">
                  <option value="">— None —</option>
                  ${cashBackCardTypeOptions.map(t => `<option value="${t.id}" ${c.cash_back_card_type_id===t.id?'selected':''}>${t.name}</option>`).join('')}
                </select>
              </div>
              <div class="form-group"><label>Card Number</label><input id="cf-cash-back-card-number" value="${c.cash_back_card_number||''}"></div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          ${id && this.can('customers_delete') ? `<button class="btn btn-danger" onclick="App.deleteCustomer(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveCustomer(${id||'null'})">Save</button>
        </div>
      </div>`);
    this._loadCustomerSalespeople();
  },

  toggleCreditFields() {
    const type = document.getElementById('cf-type')?.value;
    const panel = document.getElementById('cf-credit-fields');
    if (panel) panel.style.display = type === 'credit' ? 'block' : 'none';
  },

  toggleTaxExemptFields() {
    const checked = document.getElementById('cf-tax-exempt')?.checked;
    const panel = document.getElementById('cf-tax-exempt-fields');
    if (panel) panel.style.display = checked ? 'block' : 'none';
  },

  toggleRentalCustomerFields() {
    const checked = document.getElementById('cf-rental-customer')?.checked;
    const panel = document.getElementById('cf-rental-customer-fields');
    if (panel) panel.style.display = checked ? 'block' : 'none';
  },

  async uploadCustomerIdScan(customerId, input) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('id_scan', file);
    try {
      const res = await fetch(`/api/customers/${customerId}/id-scan`, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      this.alert('ID scan uploaded');
      this.showCustomerForm(customerId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteCustomerIdScan(customerId) {
    if (!confirm('Remove this ID scan?')) return;
    try {
      await this.api('DELETE', `/customers/${customerId}/id-scan`);
      this.showCustomerForm(customerId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async uploadCustomerReferenceId(customerId, input) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('reference_id', file);
    try {
      const res = await fetch(`/api/customers/${customerId}/reference-id`, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      this.alert('Reference ID uploaded');
      this.showCustomerForm(customerId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteCustomerReferenceId(customerId) {
    if (!confirm("Remove the main reference's ID?")) return;
    try {
      await this.api('DELETE', `/customers/${customerId}/reference-id`);
      this.showCustomerForm(customerId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async uploadCustomerAddressProof(customerId, input) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('address_proof', file);
    try {
      const res = await fetch(`/api/customers/${customerId}/address-proof`, { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      this.alert('Proof of address uploaded');
      this.showCustomerForm(customerId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteCustomerAddressProof(customerId) {
    if (!confirm('Remove this proof-of-address document?')) return;
    try {
      await this.api('DELETE', `/customers/${customerId}/address-proof`);
      this.showCustomerForm(customerId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Why a credit customer can't buy on account right now (lib/creditBlock.js).
  _creditBlockedText(c) {
    if (c.block_override === 'block') return `Account blocked${c.block_override_reason ? `: ${c.block_override_reason}` : ''}. It stays blocked until someone with permission unblocks it.`;
    if ((c.credit_limit || 0) > 0 && (c.account_balance || 0) - c.credit_limit > 0.005) return `Account blocked: the balance (${this.fmt(c.account_balance)}) is over the credit limit (${this.fmt(c.credit_limit)}). A payment is needed to bring it back under the limit.`;
    return `Account blocked: payment is overdue (credit terms ${c.credit_terms_days || 30} days). Settle the overdue balance to restore credit purchases.`;
  },

  // The Block box on a credit customer's form. Ticked whenever the account is
  // blocked — automatically for an overdue balance, or by hand. Changing it
  // needs customers_credit_block and a reason, and is saved with the form
  // (PATCH /customers/:id/credit-block).
  _creditBlockBoxHtml(c) {
    const b = c.credit_block;
    const canChange = this.can('customers_credit_block');
    const by = b.override_by_name ? ` by ${this.escapeAttr(b.override_by_name)}` : '';
    const when = b.override_at ? ` on ${this.fmtDate(b.override_at)}` : '';
    const why = b.reason ? ` — “${this.escapeAttr(b.reason)}”` : '';
    // Why the automatic rule blocks it: overdue, over the credit limit, or both.
    const autoWhy = [
      b.overdue ? `the oldest unpaid invoice is ${b.days_since} days old (terms ${b.terms_days} days)` : '',
      b.over_limit ? `the balance (${this.fmt(b.balance)}) is over the credit limit (${this.fmt(b.credit_limit)})` : '',
    ].filter(Boolean).join(' and ');
    const status = b.override === 'block' ? `Blocked by hand${by}${when}${why}. Stays blocked until unticked, even once payments are up to date.`
      : b.override === 'unblock' ? `Would be blocked (${autoWhy}) but unblocked${by}${when}${why}. Stays unblocked until the account is up to date and within its limit; if it falls behind again it's blocked automatically.`
      : b.blocked ? `Blocked automatically: ${autoWhy}. Unblocks by itself once payments are up to date and the balance is within the limit.`
      : `Not blocked — payments are up to date and the balance is within the limit.`;
    return `<div id="cf-block-box" data-initial="${b.blocked ? 1 : 0}" style="margin-top:6px;padding:10px 12px;border-radius:6px;border:1px solid ${b.blocked ? '#f44336' : 'var(--border)'};background:${b.blocked ? '#fff3f3' : 'transparent'}">
      <label style="display:flex;align-items:center;gap:8px;margin:0;cursor:${canChange ? 'pointer' : 'default'};font-weight:600;${b.blocked ? 'color:#c62828' : ''}">
        <input type="checkbox" id="cf-blocked" ${b.blocked ? 'checked' : ''} ${canChange ? '' : 'disabled'} onchange="App._toggleBlockReason()" style="width:auto;margin:0">
        Block account (no new credit sales)
      </label>
      <p style="font-size:12px;margin:6px 0 0;color:var(--text-muted)">${status}${canChange ? '' : ' Only staff with the Block / Unblock Credit Accounts permission can change this.'}</p>
      <div id="cf-block-reason-wrap" style="display:none;margin-top:8px">
        <input id="cf-block-reason" placeholder="${b.blocked ? 'Why is this account being unblocked? (required)' : 'Why is this account being blocked? (required)'}">
      </div>
    </div>`;
  },

  _toggleBlockReason() {
    const box = document.getElementById('cf-block-box');
    const changed = document.getElementById('cf-blocked').checked !== (box.dataset.initial === '1');
    document.getElementById('cf-block-reason-wrap').style.display = changed ? '' : 'none';
  },

  _customerContactRowHtml(ct = {}) {
    const v = x => this.escapeAttr(x || '');
    return `<div class="cf-contact-row" style="display:grid;grid-template-columns:1.2fr 1fr 1fr 1.2fr;gap:6px;margin-bottom:6px">
      <input class="cf-contact-name" placeholder="Name" value="${v(ct.name)}">
      <input class="cf-contact-title" placeholder="Job title" value="${v(ct.job_title)}">
      <input class="cf-contact-phone" placeholder="Phone" value="${v(ct.phone)}">
      <input class="cf-contact-email" type="email" placeholder="Email" value="${v(ct.email)}">
    </div>`;
  },

  _addCustomerContactRow() {
    document.getElementById('cf-contacts').insertAdjacentHTML('beforeend', this._customerContactRowHtml());
  },

  // Individual shows First/Last Name; Business shows Business Name, labels the
  // address as the business's, and adds the contact persons. Switching an
  // existing individual to a business starts the business name from their
  // current name (and back), so nothing typed is lost.
  _toggleCustomerKind() {
    const isBusiness = document.querySelector('input[name="cf-kind"]:checked')?.value === 'business';
    const first = document.getElementById('cf-first'), last = document.getElementById('cf-last'), biz = document.getElementById('cf-business-name');
    if (isBusiness && !biz.value.trim()) biz.value = `${first.value} ${last.value}`.trim();
    if (!isBusiness && !first.value.trim() && !last.value.trim() && biz.value.trim()) {
      const [f, ...rest] = biz.value.trim().split(/\s+/);
      first.value = f; last.value = rest.join(' ');
    }
    document.getElementById('cf-individual-names').style.display = isBusiness ? 'none' : '';
    document.getElementById('cf-business-name-wrap').style.display = isBusiness ? '' : 'none';
    document.getElementById('cf-contacts-section').style.display = isBusiness ? '' : 'none';
    document.getElementById('cf-addr-label').textContent = isBusiness ? 'Business Address' : 'Address';
  },

  // Fills the customer form's Salesperson box; a current owner who's no longer
  // an active Salesperson stays listed, since they're still what's saved.
  async _loadCustomerSalespeople() {
    const sel = document.getElementById('cf-salesperson');
    if (!sel) return;
    const people = await this.api('GET', '/sales-targets/salespeople').catch(() => []);
    const current = sel.dataset.current;
    const options = people.map(p => `<option value="${p.id}">${this.escapeAttr(`${p.first_name} ${p.last_name}`.trim())}</option>`);
    if (current && !people.some(p => String(p.id) === current)) options.push(`<option value="${current}">Employee #${current} (not an active Salesperson)</option>`);
    sel.insertAdjacentHTML('beforeend', options.join(''));
    sel.value = current;
  },

  async saveCustomer(id, opts = {}) {
    const customerType = document.getElementById('cf-type')?.value || 'cash';
    const taxExempt = document.getElementById('cf-tax-exempt')?.checked ? 1 : 0;
    const isRentalCustomer = document.getElementById('cf-rental-customer')?.checked ? 1 : 0;
    const customerKind = document.querySelector('input[name="cf-kind"]:checked')?.value === 'business' ? 'business' : 'individual';
    const data = {
      customer_kind: customerKind,
      first_name: document.getElementById('cf-first').value.trim(),
      last_name: document.getElementById('cf-last').value.trim(),
      business_name: document.getElementById('cf-business-name').value.trim(),
      contacts: customerKind === 'business' ? Array.from(document.querySelectorAll('.cf-contact-row')).map(r => ({
        name: r.querySelector('.cf-contact-name').value.trim(),
        job_title: r.querySelector('.cf-contact-title').value.trim(),
        phone: r.querySelector('.cf-contact-phone').value.trim(),
        email: r.querySelector('.cf-contact-email').value.trim(),
      })) : [],
      email: document.getElementById('cf-email').value.trim() || null,
      phone: document.getElementById('cf-phone').value.trim() || null,
      address: document.getElementById('cf-addr').value.trim() || null,
      city: document.getElementById('cf-city').value.trim() || null,
      state: document.getElementById('cf-state').value.trim() || null,
      zip: document.getElementById('cf-zip').value.trim() || null,
      notes: document.getElementById('cf-notes').value.trim() || null,
      customer_type: customerType,
      credit_terms_days: parseInt(document.getElementById('cf-terms')?.value) || 30,
      credit_limit: parseFloat(document.getElementById('cf-limit')?.value) || 0,
      tax_exempt: taxExempt,
      tax_exemption_number: taxExempt ? (document.getElementById('cf-tax-ref')?.value.trim() || null) : null,
      is_rental_customer: isRentalCustomer,
      rental_id_type: isRentalCustomer ? (document.getElementById('cf-id-type')?.value || null) : null,
      rental_id_number: isRentalCustomer ? (document.getElementById('cf-id-number')?.value.trim() || null) : null,
      rental_address_proof_type: isRentalCustomer ? (document.getElementById('cf-address-proof-type')?.value || null) : null,
      rental_reference_name: isRentalCustomer ? (document.getElementById('cf-ref-name')?.value.trim() || null) : null,
      rental_reference_phone: isRentalCustomer ? (document.getElementById('cf-ref-phone')?.value.trim() || null) : null,
      rental_reference_relationship: isRentalCustomer ? (document.getElementById('cf-ref-relationship')?.value.trim() || null) : null,
      rental_reference_address: isRentalCustomer ? (document.getElementById('cf-ref-address')?.value.trim() || null) : null,
      rental_reference2_name: isRentalCustomer ? (document.getElementById('cf-ref2-name')?.value.trim() || null) : null,
      rental_reference2_phone: isRentalCustomer ? (document.getElementById('cf-ref2-phone')?.value.trim() || null) : null,
      rental_reference2_relationship: isRentalCustomer ? (document.getElementById('cf-ref2-relationship')?.value.trim() || null) : null,
      rental_reference3_name: isRentalCustomer ? (document.getElementById('cf-ref3-name')?.value.trim() || null) : null,
      rental_reference3_phone: isRentalCustomer ? (document.getElementById('cf-ref3-phone')?.value.trim() || null) : null,
      rental_reference3_relationship: isRentalCustomer ? (document.getElementById('cf-ref3-relationship')?.value.trim() || null) : null,
      rental_preapproved: isRentalCustomer ? (document.getElementById('cf-rental-preapproved')?.checked ? 1 : 0) : 0,
      discount_card_type_id: document.getElementById('cf-discount-card-type')?.value || null,
      discount_card_number: document.getElementById('cf-discount-card-number')?.value.trim() || null,
      cash_back_card_type_id: document.getElementById('cf-cash-back-card-type')?.value || null,
      cash_back_card_number: document.getElementById('cf-cash-back-card-number')?.value.trim() || null,
      customer_category_id: document.getElementById('cf-category')?.value || null,
      ...(this.can('sales_manager') ? { salesperson_id: document.getElementById('cf-salesperson')?.value || null } : {}),
    };
    if (customerKind === 'business' && !data.business_name) { this.alert('Business name is required', 'error'); return; }
    if (customerKind === 'individual' && (!data.first_name || !data.last_name)) { this.alert('First and last name required', 'error'); return; }
    if (data.contacts.some(ct => !ct.name && (ct.job_title || ct.phone || ct.email))) { this.alert('Each contact person needs a name', 'error'); return; }
    // A changed Block box is saved separately (needs customers_credit_block).
    const blockBox = document.getElementById('cf-block-box');
    const blockChange = blockBox && data.customer_type === 'credit' && document.getElementById('cf-blocked').checked !== (blockBox.dataset.initial === '1')
      ? { blocked: document.getElementById('cf-blocked').checked, reason: document.getElementById('cf-block-reason').value.trim() } : null;
    if (blockChange && !blockChange.reason) { this.alert(`Enter a reason for ${blockChange.blocked ? 'blocking' : 'unblocking'} this account`, 'error'); return; }
    if (data.customer_type === 'credit' && data.credit_terms_days < 1) { this.alert('Credit terms must be at least 1 day', 'error'); return; }
    if (opts.force) data.force = true;
    try {
      let number = this._custFormNumber;
      if (id) {
        await this.api('PUT', `/customers/${id}`, data);
        if (blockChange) await this.api('PATCH', `/customers/${id}/credit-block`, blockChange);
      } else {
        const created = await this.api('POST', '/customers', data);
        if (this._customerFormStack) return this._finishStackedCustomerForm(created.id);
        number = created.customer_number;
      }
      const filters = this._custFilterState({ search: number });
      this.closeModal();
      this.alert(id ? 'Customer updated' : 'Customer created');
      this.renderCustomers(filters);
    } catch (e) {
      // The customer form's inputs are gone once the duplicate-picker modal
      // replaces it, so stash the already-collected data for "Create Anyway"
      // to resubmit directly rather than re-reading (now-missing) DOM fields.
      if (e.status === 409 && e.data && e.data.matches && (!id || e.data.blocking)) { this._pendingCustomerData = data; this._pendingCustomerId = id || null; return this.showCustomerDuplicateModal(e.data.matches, { blocking: !!e.data.blocking, message: e.message }); }
      this.alert(e.message, 'error');
    }
  },

  // Shown when creating a customer would duplicate one that already matches
  // by email, phone, or name — lets the user view the existing record or
  // confirm they really do want a separate one. A `blocking` match (same
  // phone or email — server refuses those outright, on create and edit)
  // offers no "Create Anyway", only going back to fix the details.
  showCustomerDuplicateModal(matches, { blocking = false, message = '' } = {}) {
    const editId = this._pendingCustomerId;
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header">
          <span class="modal-title">${blocking ? 'Duplicate Customer' : 'Possible Duplicate Customer'}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <p>${blocking ? `${message}. Each customer must have their own contact number and email — use the existing customer, or change the details.` : 'A customer with the same name, phone, or email already exists:'}</p>
          <div style="display:flex;flex-direction:column;gap:8px;margin:12px 0">
            ${matches.map(c => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border:1px solid var(--border);border-radius:6px">
                <div>
                  <div><strong>${c.first_name} ${c.last_name}</strong> (${c.customer_number})</div>
                  <div style="font-size:12px;color:var(--text-muted)">${c.email || ''} ${c.phone ? '· ' + c.phone : ''}</div>
                </div>
                ${this._customerFormStack && !editId
                  ? `<button class="btn btn-primary btn-sm" onclick="App._pendingCustomerData=null;App._finishStackedCustomerForm(${c.id})">Use This Customer</button>`
                  : `<button class="btn btn-outline btn-sm" onclick="App.closeModal();App.viewCustomer(${c.id})">View</button>`}
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.showCustomerForm(${editId || null}, { prefill: App._pendingCustomerData })">${blocking ? 'Back to Edit' : 'Cancel'}</button>
          ${blocking ? '' : `<button class="btn btn-danger" onclick="App.forceCreateCustomer()">Create New Customer Anyway</button>`}
        </div>
      </div>
    `);
  },

  async forceCreateCustomer() {
    const data = this._pendingCustomerData;
    if (!data) return this.closeModal();
    data.force = true;
    try {
      const created = await this.api('POST', '/customers', data);
      this._pendingCustomerData = null;
      if (this._customerFormStack) return this._finishStackedCustomerForm(created.id);
      const filters = this._custFilterState({ search: created.customer_number });
      this.closeModal();
      this.alert('Customer created');
      this.renderCustomers(filters);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ─── Customer CSV Import / Export ────────────────────────
  async importCustomersCsv(inputEl) {
    const file = inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); } catch (e) { this.alert(e.message, 'error'); return; }
    const { headers, rows: rawRows } = parsed;
    if (!rawRows.length) { this.alert('No data rows found in CSV', 'error'); return; }

    // rental_preapproved only offered to map when the employee actually holds
    // customers_rental_preapprove — mirrors the server-side gate in POST
    // /customers/import (routes/customers.js), which silently ignores the
    // column anyway without that permission; hiding it here avoids a mapping
    // choice that would quietly do nothing.
    const importFields = this._customerImportFields.filter(f => f.key !== 'rental_preapproved' || this.can('customers_rental_preapprove'));
    const mapping = await this._showFieldMappingModal({
      title: 'Map Import Columns', headers, fields: importFields,
      validate: m => (m.first_name && m.last_name) || m.business_name ? null : 'Map First Name and Last Name, or Business Name for a file of businesses',
    });
    if (!mapping) return;
    const rows = this._remapCsvRows(rawRows, mapping);

    const duplicateMode = await this._askCustomerDuplicateMode({
      message: "Rows whose contact number or email already belongs to an active customer are always skipped. Rows that only match an existing customer's full name — what should happen to those?",
    });
    if (duplicateMode === null) return; // dismissed without choosing

    // Opened before the row-chunks start so every chunk's outcomes log under
    // one batch id — that id is what makes this import reviewable and
    // reversible afterward (Import History button).
    const { id: batchId } = await this.api('POST', '/customer-imports');

    await this._runBatchedCsvImport({
      rows, endpoint: '/customers/import', title: 'Importing Customers',
      extraBody: { duplicate_mode: duplicateMode, batch_id: batchId },
      summarize: totals => `${totals.created||0} created${totals.skipped ? `, ${totals.skipped} skipped (possible duplicate)` : ''}${totals.imported_as_cash ? `, ${totals.imported_as_cash} marked Credit imported as Cash (needs Manage Credit Limits)` : ''}`,
      onFinish: async () => {
        await this.api('PATCH', `/customer-imports/${batchId}/finish`).catch(() => {});
        this.renderCustomers();
        this.showCustomerImportBatchDetail(batchId);
      },
    });
  },

  // Same email/phone/full-name duplicate check as adding one customer at a
  // time (POST /customers) — asks up front whether a row matching an
  // existing active customer should be skipped (the default) or created
  // anyway, since a bulk import can't pause per-row for a Link/Create choice
  // the way the single Add Customer form does.
  _askCustomerDuplicateMode({ title = 'Possible Duplicate Customers', message = "Any row matching an existing active customer's email, phone, or full name is checked before import. What should happen to those rows?" } = {}) {
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:420px">
          <div class="modal-header"><span class="modal-title">${title}</span></div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-muted)">${message}</p>
          </div>
          <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
            <button class="btn btn-secondary btn-sm" id="import-dupmode-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="import-dupmode-skip">Skip likely duplicates</button>
            <button class="btn btn-secondary btn-sm" id="import-dupmode-force">Import all rows anyway</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const finish = val => { overlay.remove(); resolve(val); };
      overlay.querySelector('#import-dupmode-cancel').addEventListener('click', () => finish(null));
      overlay.querySelector('#import-dupmode-skip').addEventListener('click', () => finish('skip'));
      overlay.querySelector('#import-dupmode-force').addEventListener('click', () => finish('force'));
    });
  },

  // Lets the user pick which customer type to export a balances CSV for —
  // AR balance, outstanding credit note total, and status per customer
  // (GET /customers/export/balances). A plain link per option so the
  // browser handles the download; no need to round-trip through this.api().
  showCustomerBalancesExport() {
    this.showModal(`
      <div class="modal" style="max-width:380px">
        <div class="modal-header"><span class="modal-title">Export Customer Balances</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Includes AR balance, outstanding credit note total, and status. Choose which customers to include:</p>
          <div style="display:flex;flex-direction:column;gap:8px">
            <a class="btn btn-secondary" href="/api/customers/export/balances" download onclick="App.closeModal()">All Customers</a>
            <a class="btn btn-secondary" href="/api/customers/export/balances?type=retail" download onclick="App.closeModal()">Retail Only</a>
            <a class="btn btn-secondary" href="/api/customers/export/balances?type=rental" download onclick="App.closeModal()">Rental Only</a>
          </div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button></div>
      </div>`);
  },

  // Lists rental customers (is_rental_customer = 1) failing the same
  // eligibility check lib/rentals.js runs before a new rental can be
  // created (GET /customers/rental-incomplete) — meant for working through
  // customers bulk-imported from a previous system a row at a time via
  // "Edit", since the ID/reference/document requirements can't be satisfied
  // from a CSV alone (the three scanned documents need an upload).
  async showRentalIncompleteReport() {
    const rows = await this.api('GET', '/customers/rental-incomplete');
    this.showModal(`
      <div class="modal" style="max-width:720px">
        <div class="modal-header"><span class="modal-title">Rental Customers Missing Info</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="padding:0">
          ${!rows.length ? '<div class="empty-state" style="padding:20px"><p>Every rental customer has a complete compliance record.</p></div>' : `
          <p style="font-size:12px;color:var(--text-muted);margin:12px 12px 0">${rows.length} rental customer${rows.length === 1 ? '' : 's'} missing info below. <strong>Preapproved</strong> ones can still be rented to today — the rest are blocked until it's added.</p>
          <table style="width:100%;border-collapse:collapse;margin-top:8px">
            <thead><tr style="background:var(--bg-secondary,#f9fafb)">
              <th style="padding:8px 12px;text-align:left;font-size:12px">Customer #</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">Name</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">Phone</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">Status</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">Missing</th>
              <th style="padding:8px 12px"></th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `<tr style="border-top:1px solid var(--border,#e5e7eb)">
                <td style="padding:8px 12px;font-size:12px;font-family:monospace">${r.customer_number}</td>
                <td style="padding:8px 12px;font-size:12px">${r.first_name} ${r.last_name}</td>
                <td style="padding:8px 12px;font-size:12px">${r.phone || '—'}</td>
                <td style="padding:8px 12px;font-size:12px">${r.rental_preapproved ? '<span class="badge-pill badge-success">Preapproved</span>' : '<span class="badge-pill badge-danger">Blocked</span>'}</td>
                <td style="padding:8px 12px;font-size:12px">${r.missing.map(m => `<span class="badge-pill badge-danger" style="margin:2px">${m}</span>`).join(' ')}</td>
                <td style="padding:8px 12px"><button class="btn btn-secondary btn-sm" onclick="App.closeModal();App.showCustomerForm(${r.id})">Edit</button></td>
              </tr>`).join('')}
            </tbody>
          </table>`}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  async showCustomerImportHistory() {
    const batches = await this.api('GET', '/customer-imports');
    const fmtDate = d => d ? this._toDate(d).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZone: this._storeTz() }) : '—';
    this.showModal(`
      <div class="modal" style="max-width:720px">
        <div class="modal-header"><span class="modal-title">Customer Import History</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="padding:0">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--bg-secondary,#f9fafb)">
              <th style="padding:8px 12px;text-align:left;font-size:12px">Started</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">By</th>
              <th style="padding:8px 12px;text-align:center;font-size:12px">Created</th>
              <th style="padding:8px 12px;text-align:center;font-size:12px">Skipped Dupes</th>
              <th style="padding:8px 12px;text-align:center;font-size:12px">Errors</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">Status</th>
              <th style="padding:8px 12px"></th>
            </tr></thead>
            <tbody>
              ${batches.length ? batches.map(b => `<tr style="border-top:1px solid var(--border,#e5e7eb)">
                <td style="padding:8px 12px;font-size:12px;white-space:nowrap">${fmtDate(b.started_at)}</td>
                <td style="padding:8px 12px;font-size:12px">${b.employee_name || '—'}</td>
                <td style="padding:8px 12px;text-align:center;font-size:12px">${b.created_count || 0}</td>
                <td style="padding:8px 12px;text-align:center;font-size:12px">${b.skipped_count || 0}</td>
                <td style="padding:8px 12px;text-align:center;font-size:12px;${b.error_count ? 'color:var(--danger);font-weight:600' : ''}">${b.error_count || 0}</td>
                <td style="padding:8px 12px;font-size:12px"><span class="badge-pill ${b.status==='reversed'?'badge-danger':b.status==='completed'?'badge-success':'badge-warning'}">${b.status}</span></td>
                <td style="padding:8px 12px;text-align:right;white-space:nowrap"><button class="btn btn-secondary btn-sm" onclick="App.showCustomerImportBatchDetail(${b.id})">Review</button></td>
              </tr>`).join('') : '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text-muted)">No imports logged yet</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  async showCustomerImportBatchDetail(batchId) {
    const { batch, counts, duplicates, errors } = await this.api('GET', `/customer-imports/${batchId}`);
    const fmtDate = d => d ? this._toDate(d).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZone: this._storeTz() }) : '—';
    const c = counts || {};
    const canReverse = batch.status !== 'reversed';
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Import #${batch.id} Review</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
            Started ${fmtDate(batch.started_at)} by ${batch.employee_name || 'unknown'}
            ${batch.status === 'reversed' ? ` · reversed ${fmtDate(batch.reversed_at)}` : ''}
          </p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700">${c.created||0}</div><div style="font-size:11px;color:var(--text-muted)">Created</div></div>
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700">${c.skipped_duplicate||0}</div><div style="font-size:11px;color:var(--text-muted)">Skipped (Duplicate)</div></div>
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700;${c.error?'color:var(--danger)':''}">${c.error||0}</div><div style="font-size:11px;color:var(--text-muted)">Errors</div></div>
          </div>
          ${duplicates.length ? `<div style="padding:12px;border:1px solid var(--border,#e5e7eb);border-radius:6px;margin-bottom:12px">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px">Skipped as likely duplicates of an existing customer</div>
            <div style="max-height:180px;overflow-y:auto;font-size:12px">
              ${duplicates.map(d => `<div style="padding:3px 0;border-top:1px solid var(--border,#e5e7eb)">${d.row_label} → matched <strong>${d.first_name} ${d.last_name}</strong> (${d.customer_number})</div>`).join('')}
            </div>
          </div>` : ''}
          ${errors.length ? `<div style="padding:12px;border:1px solid var(--border,#e5e7eb);border-radius:6px;margin-bottom:12px">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px;color:var(--danger)">Row errors</div>
            <div style="max-height:180px;overflow-y:auto;font-size:12px">
              ${errors.map(e => `<div style="padding:3px 0;border-top:1px solid var(--border,#e5e7eb)">${e.row_label} — ${e.error_message}</div>`).join('')}
            </div>
          </div>` : ''}
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-secondary" onclick="App.showCustomerImportHistory()">Back</button>
          ${canReverse && this.can('customers_import_history') ? `<button class="btn btn-danger" onclick="App.reverseCustomerImportBatch(${batch.id})">Reverse This Import</button>` : ''}
        </div>
      </div>`);
  },

  async reverseCustomerImportBatch(batchId) {
    if (!confirm('Reverse this import? Every customer this batch created will be deactivated (same as deleting a customer). This cannot be undone.')) return;
    try {
      const result = await this.api('POST', `/customer-imports/${batchId}/reverse`);
      this.alert(`Reversed: ${result.deactivated} customer(s) deactivated.`, 'success');
      this.renderCustomers();
      this.showCustomerImportBatchDetail(batchId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteCustomer(id) {
    if (!confirm('Deactivate this customer?')) return;
    await this.api('DELETE', `/customers/${id}`);
    const filters = this._custFilterState();
    this.closeModal();
    this.alert('Customer deactivated');
    this.renderCustomers(filters);
  },

  async viewCustomer(id) {
    const c = await this.api('GET', `/customers/${id}`);
    const isCredit = c.customer_type === 'credit';
    const { txs, pmts, legacy } = await this._loadCustomerHistory(id, '');
    this.showModal(`
      <div class="modal" style="max-width:660px">
        <div class="modal-header">
          <span class="modal-title">${c.first_name} ${c.last_name}${isCredit ? ` <span style="font-size:12px;padding:2px 8px;border-radius:4px;background:#e3f2fd;color:#1565c0;margin-left:6px">Credit</span>` : ''}${c.account_blocked ? ` <span style="font-size:12px;padding:2px 8px;border-radius:4px;background:#ffebee;color:#c62828;margin-left:4px">BLOCKED</span>` : ''}${c.is_rental_customer ? ` <span class="badge-pill badge-purple" style="font-size:12px;margin-left:4px">🔑 Rental</span>` : ''}${c.is_rental_customer && c.rental_preapproved ? ` <span class="badge-pill badge-success" style="font-size:12px;margin-left:4px" title="Can be rented to despite incomplete compliance info">Preapproved</span>` : ''}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          ${c.account_blocked ? `<div style="padding:10px 14px;background:#ffebee;border:1px solid #f44336;border-radius:6px;color:#c62828;margin-bottom:12px;font-size:13px">&#9888; ${this.escapeAttr(this._creditBlockedText(c))}</div>` : ''}
          <div class="stats-grid" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:16px">
            <div class="stat-card blue"><div class="stat-label">Total Spent</div><div class="stat-value" style="font-size:20px">${this.fmt(c.total_spent)}</div></div>
            <div class="stat-card green"><div class="stat-label">Loyalty Points</div><div class="stat-value" style="font-size:20px">🏆 ${c.loyalty_points}</div></div>
            <div class="stat-card"><div class="stat-label">Member Since</div><div class="stat-value" style="font-size:16px">${this.fmtDate(c.created_at)}</div></div>
          </div>
          ${isCredit ? `<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
            <div style="flex:1;padding:10px;background:#f5f5f5;border-radius:6px;min-width:120px">
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Credit Terms</div>
              <div style="font-weight:700;font-size:16px">${c.credit_terms_days} days</div>
            </div>
            <div style="flex:1;padding:10px;background:#f5f5f5;border-radius:6px;min-width:120px">
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Credit Limit</div>
              <div style="font-weight:700;font-size:16px">${c.credit_limit > 0 ? this.fmt(c.credit_limit) : 'Unlimited'}</div>
            </div>
            <div style="flex:1;padding:10px;background:#fff3f3;border-radius:6px;min-width:120px">
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Outstanding</div>
              <div style="font-weight:700;font-size:16px;color:#c62828">${this.fmt(c.account_balance||0)}</div>
            </div>
          </div>` : ''}
          ${!isCredit ? `<div id="cust-credits" style="margin-bottom:16px"></div>` : ''}
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            <h4 style="margin:0;flex:1">History</h4>
            <label style="font-size:12px">From</label>
            <input type="date" id="ch-start" value="" title="Leave blank for all dates" style="width:140px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px">
            <label style="font-size:12px">To</label>
            <input type="date" id="ch-end" value="" title="Leave blank for all dates" style="width:140px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px">
            <button class="btn btn-primary btn-sm" onclick="App.filterCustomerHistory(${c.id})">Filter</button>
            ${this.can('customers_print_history') ? `<button class="btn btn-secondary btn-sm" onclick="App.printCustomerHistory(${c.id},'${c.first_name} ${c.last_name}')">Print</button>` : ''}
          </div>
          <div id="ch-table">${this._buildCustomerTxHTML(txs)}</div>
          <div id="ch-payments" style="margin-top:16px">${this._buildCustomerPmtHTML(pmts)}</div>
          <div id="ch-legacy" style="margin-top:16px">${this._buildCustomerLegacyHTML(legacy)}</div>
        </div>
      </div>`);
    if (!isCredit) this._renderCustomerCredits(c.id);
  },

  // Cash customer's credit: what's available at the POS, each credit note
  // (old-system ones entered here, and return credit notes) with what's left,
  // + Add Old Credit Note (customers_legacy_credit) and Void
  // (customers_legacy_credit_void, only while unused).
  async _renderCustomerCredits(customerId, data) {
    const el = document.getElementById('cust-credits');
    if (!el) return;
    if (!data) { try { data = await this.api('GET', `/customers/${customerId}/credits`); } catch (e) { el.innerHTML = ''; return; } }
    const canAdd = this.can('customers_legacy_credit'), canVoid = this.can('customers_legacy_credit_void');
    if (data.is_credit_account || (!data.notes.length && !data.voided.length && !canAdd)) { el.innerHTML = ''; return; }
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    el.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:${data.notes.length ? '10px' : '0'}">
          <div style="flex:1;min-width:180px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Available Credit</div>
            <div style="font-weight:700;font-size:20px;color:${data.available > 0 ? 'var(--success)' : 'var(--text)'}">${this.fmt(data.available)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${data.available > 0 ? 'Offered as Available Credit when this customer is on a POS ticket' : 'No credit on the account'}</div>
          </div>
          ${canAdd ? `<button class="btn btn-sm btn-primary" onclick="App._showLegacyCreditForm(${customerId})">+ Add Old Credit Note</button>` : ''}
        </div>
        ${data.notes.length ? `<table style="margin:0"><thead><tr><th>Credit Note</th><th>Old #</th><th>Dated</th><th style="text-align:right">Amount</th><th style="text-align:right">Left</th>${canVoid ? '<th></th>' : ''}</tr></thead><tbody>
          ${data.notes.map(n => `<tr>
            <td class="fw-600">${esc(n.payment_number)}${n.return_id ? ' <span class="badge-pill badge-secondary" style="font-size:10px">Return</span>' : n.entered_in_pos ? ' <span class="badge-pill badge-purple" style="font-size:10px">Old system</span>' : ' <span class="badge-pill badge-secondary" style="font-size:10px">Books</span>'}</td>
            <td>${n.return_id ? '—' : esc(String(n.reference || '').replace(/^Legacy CN /, ''))}</td>
            <td style="white-space:nowrap">${n.legacy_credit_date ? this.fmtDate(n.legacy_credit_date) : this.fmtDate(n.created_at)}</td>
            <td style="text-align:right">${this.fmt(n.amount)}</td>
            <td style="text-align:right" class="fw-600">${n.remaining > 0.005 ? this.fmt(n.remaining) : '<span style="color:var(--text-muted)">Used</span>'}</td>
            ${canVoid ? `<td style="text-align:right">${n.can_void ? `<button class="btn btn-sm btn-outline" onclick="App._voidLegacyCredit(${customerId}, ${n.id}, '${esc(n.payment_number)}')">Void</button>` : ''}</td>` : ''}
          </tr>${!n.return_id ? `<tr><td colspan="${canVoid ? 6 : 5}" style="font-size:12px;color:var(--text-muted);padding-top:0;border-top:none">${n.entered_in_pos ? `Entered ${this.fmtDate(n.created_at)}${n.entered_by_name ? ` by ${esc(n.entered_by_name)}` : ''}` : 'From RetailPOS Books'}${(m => m ? ` · ${esc(m)}` : '')(String(n.notes || '').replace(/^Old system credit note .*? dated [0-9-]+( — )?/, ''))}</td></tr>` : ''}`).join('')}
        </tbody></table>` : ''}
        ${data.voided.length ? `<details style="margin-top:8px;font-size:12px"><summary style="cursor:pointer;color:var(--text-muted)">Voided (${data.voided.length})</summary>
          ${data.voided.map(v => `<div style="padding:4px 0;color:var(--text-muted)">${esc(v.payment_number)} — old # ${esc(v.credit_note_number)}, ${this.fmt(v.amount)} — voided ${this.fmtDateTime(v.voided_at)}${v.voided_by_name ? ` by ${esc(v.voided_by_name)}` : ''}: ${esc(v.reason)}</div>`).join('')}
        </details>` : ''}
      </div>`;
  },

  _showLegacyCreditForm(customerId) {
    const today = this._storeDay();
    const html = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px" id="lcn-overlay">
      <div class="modal" style="max-width:440px;width:100%">
        <div class="modal-header"><span class="modal-title">Add Old Credit Note</span><button class="modal-close" onclick="document.getElementById('lcn-overlay').remove()">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-top:0">Credit this customer has from the old system. It goes on their account as Available Credit for use at the POS.</p>
          <div class="form-group"><label>Old Credit Note # *</label><input id="lcn-number" autocomplete="off"></div>
          <div class="form-group"><label>Date on the Credit Note *</label><input id="lcn-date" type="date" max="${today}"></div>
          <div class="form-group"><label>Amount *</label><input id="lcn-amount" type="number" min="0.01" step="0.01"></div>
          <div class="form-group"><label>Notes</label><input id="lcn-memo" placeholder="e.g. returned goods, overpayment"></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="document.getElementById('lcn-overlay').remove()">Cancel</button><button class="btn btn-primary" id="lcn-save" onclick="App._saveLegacyCredit(${customerId})">Add Credit</button></div>
      </div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('lcn-number').focus();
  },

  async _saveLegacyCredit(customerId) {
    const v = id => document.getElementById(id).value.trim();
    const body = { credit_note_number: v('lcn-number'), date: v('lcn-date'), amount: v('lcn-amount'), memo: v('lcn-memo') };
    if (!body.credit_note_number || !body.date || !(parseFloat(body.amount) > 0)) return this.alert('Enter the old credit note #, its date and the amount', 'error');
    if (!confirm(`Add ${this.fmt(parseFloat(body.amount))} of credit to this customer's account?`)) return;
    const btn = document.getElementById('lcn-save'); btn.disabled = true;
    try {
      const out = await this.api('POST', `/customers/${customerId}/legacy-credit-notes`, body);
      document.getElementById('lcn-overlay')?.remove();
      this.alert(`${out.payment_number} added — ${this.fmt(out.available)} available`);
      this._renderCustomerCredits(customerId, out);
    } catch (e) { btn.disabled = false; this.alert(e.message, 'error'); }
  },

  async _voidLegacyCredit(customerId, paymentId, number) {
    const reason = prompt(`Void ${number}? It comes off the customer's available credit.\n\nReason:`);
    if (reason == null) return;
    if (!reason.trim()) return this.alert('A reason is required', 'error');
    try {
      const out = await this.api('POST', `/customers/${customerId}/legacy-credit-notes/${paymentId}/void`, { reason: reason.trim() });
      this.alert(`${number} voided`);
      this._renderCustomerCredits(customerId, out);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // Everything the History window (and its Print) shows for a customer —
  // all dates unless a From/To is given. Payments and old-system invoices
  // come from customer-scoped routes, so anyone who can open the customer
  // sees them; a section that fails to load shows empty rather than
  // stopping the window from opening.
  async _loadCustomerHistory(id, qs) {
    const q = qs ? '?' + qs : '';
    const get = url => this.api('GET', url).catch(() => []);
    const [txs, pmts, legacy] = await Promise.all([
      this.api('GET', `/customers/${id}/transactions${q}`),
      get(`/customers/${id}/payments${q}`),
      get(`/customers/${id}/legacy-invoices${q}`),
    ]);
    return { txs, pmts, legacy };
  },

  // Old-system invoices (entered in RetailPOS Books) — only shown when the
  // customer has any, e.g. accounts carried over from the old system.
  _buildCustomerLegacyHTML(legacy) {
    if (!legacy.length) return '';
    return `<h5 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--text-muted)">Invoices from the Old System</h5>
    <table>
      <thead><tr><th>Invoice #</th><th>Date</th><th>Amount</th><th>Balance Due</th><th>Status</th></tr></thead>
      <tbody>${legacy.map(li => `<tr>
        <td class="fw-600">${this.escapeAttr(li.invoice_number)}</td>
        <td>${this.fmtDate(li.invoice_date)}</td>
        <td>${this.fmt(li.amount)}</td>
        <td>${li.status === 'void' ? '—' : this.fmt(li.balance_due)}</td>
        <td><span class="badge-pill ${li.status === 'void' ? 'badge-danger' : li.balance_due > 0.001 ? 'badge-warning' : 'badge-success'}">${li.status === 'void' ? 'void' : li.balance_due > 0.001 ? 'open' : 'paid'}</span></td>
      </tr>`).join('')}</tbody>
    </table>`;
  },

  _buildCustomerTxHTML(txs) {
    if (!txs.length) return '<p style="color:var(--text-muted);margin:0">No transactions for this period</p>';
    return `<h5 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--text-muted)">Transactions</h5>
    <table>
      <thead><tr><th>Tx #</th><th>Date</th><th>Total</th><th>Method</th><th>Status</th></tr></thead>
      <tbody>${txs.map(tx => `<tr>
        <td class="fw-600">${tx.transaction_number}</td>
        <td>${this.fmtDateTime(tx.created_at)}</td>
        <td>${this.fmt(tx.total)}</td>
        <td>${(tx.payment_method||'').replace('_',' ')}</td>
        <td><span class="badge-pill ${tx.status==='completed'?'badge-success':'badge-danger'}">${tx.status}</span></td>
      </tr>`).join('')}</tbody>
    </table>`;
  },

  _buildCustomerPmtHTML(pmts) {
    if (!pmts.length) return '<p style="color:var(--text-muted);margin:0">No payments for this period</p>';
    return `<h5 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;color:var(--text-muted)">Payments Received</h5>
    <table>
      <thead><tr><th>Pmt #</th><th>Date</th><th>Amount</th><th>Method</th><th>Notes</th></tr></thead>
      <tbody>${pmts.map(p => `<tr>
        <td class="fw-600">${p.payment_number}</td>
        <td>${this.fmtDateTime(p.created_at)}</td>
        <td style="color:#2e7d32;font-weight:600">${this.fmt(p.amount)}</td>
        <td>${(p.payment_method||'').replace('_',' ')}</td>
        <td style="font-size:12px;color:var(--text-muted)">${p.notes||'—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  },

  async filterCustomerHistory(id) {
    const start = document.getElementById('ch-start').value;
    const end = document.getElementById('ch-end').value;
    const qs = [start && `start=${start}`, end && `end=${end}`].filter(Boolean).join('&');
    const { txs, pmts, legacy } = await this._loadCustomerHistory(id, qs);
    document.getElementById('ch-table').innerHTML = this._buildCustomerTxHTML(txs);
    document.getElementById('ch-payments').innerHTML = this._buildCustomerPmtHTML(pmts);
    document.getElementById('ch-legacy').innerHTML = this._buildCustomerLegacyHTML(legacy);
  },

  async printCustomerHistory(id, name) {
    const start = document.getElementById('ch-start').value;
    const end = document.getElementById('ch-end').value;
    const qs = [start && `start=${start}`, end && `end=${end}`].filter(Boolean).join('&');
    const { txs, pmts, legacy } = await this._loadCustomerHistory(id, qs);
    const store = this.settings || {};
    const txTotal = txs.filter(t => t.status === 'completed').reduce((s, t) => s + (t.total || 0), 0);
    const pmtTotal = pmts.reduce((s, p) => s + (p.amount || 0), 0);
    const dateRange = (start || end) ? `${start || '—'} to ${end || '—'}` : 'All time';
    const txRows = txs.map(tx => `<tr>
      <td>${tx.transaction_number}</td>
      <td>${this.fmtDateTime(tx.created_at)}</td>
      <td>${this.fmt(tx.total)}</td>
      <td>${(tx.payment_method||'').replace('_',' ')}</td>
      <td>${tx.status}</td>
    </tr>`).join('');
    const pmtRows = pmts.map(p => `<tr>
      <td>${p.payment_number}</td>
      <td>${this.fmtDateTime(p.created_at)}</td>
      <td>${this.fmt(p.amount)}</td>
      <td>${(p.payment_method||'').replace('_',' ')}</td>
      <td>${p.notes||'—'}</td>
    </tr>`).join('');
    const win = window.open('', '_blank', 'width=750,height=800');
    win.document.write(`<!DOCTYPE html><html><head><title>Customer History – ${name}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:32px;color:#111}
      h1{font-size:18px;margin:0 0 2px}
      .sub{font-size:13px;color:#555;margin-bottom:16px}
      .meta{display:flex;gap:32px;margin-bottom:16px;font-size:12px}
      .meta div{line-height:1.7}
      .meta label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      h2{font-size:13px;text-transform:uppercase;color:#555;margin:20px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}
      table{width:100%;border-collapse:collapse}
      th{background:#f0f0f0;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;border:1px solid #ccc}
      td{padding:6px 8px;border:1px solid #ddd}
      tr:nth-child(even) td{background:#fafafa}
      .summary{margin-top:8px;text-align:right;font-size:12px;color:#444}
      .summary strong{font-size:13px}
      .footer{margin-top:24px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:8px}
      @media print{body{margin:16px}}
    </style></head><body>
    ${this._printLogoTag(50)}
    <h1>${store.store_name || 'Customer History'}</h1>
    <div class="sub">Customer History Report</div>
    <div class="meta">
      <div><label>Customer</label>${name}</div>
      <div><label>Period</label>${dateRange}</div>
      <div><label>Printed</label>${new Date().toLocaleString()}</div>
    </div>
    <h2>Transactions</h2>
    <table>
      <thead><tr><th>Tx #</th><th>Date / Time</th><th>Total</th><th>Method</th><th>Status</th></tr></thead>
      <tbody>${txRows || '<tr><td colspan="5" style="text-align:center;color:#999">No transactions found</td></tr>'}</tbody>
    </table>
    <div class="summary">Completed total: <strong>${this.fmt(txTotal)}</strong> &nbsp;|&nbsp; ${txs.length} transaction(s)</div>
    <h2>Payments Received</h2>
    <table>
      <thead><tr><th>Pmt #</th><th>Date / Time</th><th>Amount</th><th>Method</th><th>Notes</th></tr></thead>
      <tbody>${pmtRows || '<tr><td colspan="5" style="text-align:center;color:#999">No payments found</td></tr>'}</tbody>
    </table>
    <div class="summary">Payments total: <strong>${this.fmt(pmtTotal)}</strong> &nbsp;|&nbsp; ${pmts.length} payment(s)</div>
    ${legacy.length ? `<h2>Invoices from the Old System</h2>
    <table>
      <thead><tr><th>Invoice #</th><th>Date</th><th>Amount</th><th>Balance Due</th><th>Status</th></tr></thead>
      <tbody>${legacy.map(li => `<tr><td>${this.escapeAttr(li.invoice_number)}</td><td>${this.fmtDate(li.invoice_date)}</td><td>${this.fmt(li.amount)}</td><td>${li.status === 'void' ? '—' : this.fmt(li.balance_due)}</td><td>${li.status === 'void' ? 'void' : li.balance_due > 0.001 ? 'open' : 'paid'}</td></tr>`).join('')}</tbody>
    </table>` : ''}
    <div class="footer">Generated by ${store.store_name || 'POS System'} &nbsp;|&nbsp; ${new Date().toLocaleString()}</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

  // ─── Shared customer picker ──────────────────────────────────────
  // Server-side customer search for the type-to-search pickers: the first
  // 50 matches for what's typed (plus any extra query, e.g. '&rental=1'),
  // never the whole customer table. Debounced per picker key; resolves null
  // when newer typing has overtaken the request.
  _customerSearch(key, q, extra = '') {
    this._custSearchState = this._custSearchState || {};
    const st = this._custSearchState[key] = this._custSearchState[key] || { seq: 0 };
    clearTimeout(st.timer);
    const mine = ++st.seq;
    const query = (q || '').trim();
    return new Promise((resolve, reject) => {
      st.timer = setTimeout(() => {
        this.api('GET', `/customers?active=1&limit=50${query ? `&search=${encodeURIComponent(query)}` : ''}${extra}`)
          .then(rows => resolve(mine === st.seq ? rows : null), e => (mine === st.seq ? reject(e) : resolve(null)));
      }, 200);
    });
  },

  // One customer by id (active or not), for preselecting a saved form's
  // customer in a picker that only holds search results.
  async _customerById(id) {
    if (id == null || id === '') return null;
    const [c] = await this.api('GET', `/customers?ids=${encodeURIComponent(id)}&limit=1`);
    return c || null;
  },

  // Adds/refreshes rows (by id) in a picker's cache of loaded customers.
  _mergeCustomers(list, rows) {
    const out = [...(list || [])];
    for (const r of rows || []) {
      const i = out.findIndex(c => String(c.id) === String(r.id));
      if (i >= 0) out[i] = r; else out.push(r);
    }
    return out;
  },

  // Shared type-to-search customer picker for forms that used to render a
  // plain <select> of every customer. The hidden input keeps the old
  // select's id, so callers keep reading document.getElementById(id).value
  // unchanged. emptyLabel (optional) adds a "none" row that clears the pick.
  // remote (a query-string suffix, '' for none) searches the server as you
  // type instead of filtering `customers`, which then only needs to hold the
  // preselected customer, if any.
  _customerPickerHtml(id, customers, selectedId, { placeholder = 'Search customer…', emptyLabel = '', remote = null, allowAdd = true, showBalance = false } = {}) {
    this._custPickerLists = this._custPickerLists || {};
    this._custPickerLists[id] = { customers: customers || [], emptyLabel, remote, allowAdd, showBalance };
    const sel = selectedId != null && selectedId !== '' ? (customers || []).find(c => String(c.id) === String(selectedId)) : null;
    if (!this._custPickerListenerBound) {
      this._custPickerListenerBound = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.cust-picker-wrap')) {
          document.querySelectorAll('.cust-picker-dd').forEach(dd => { dd.style.display = 'none'; });
        }
      });
    }
    return `<div class="cust-picker-wrap" style="position:relative">
      <input type="text" id="${id}-search" placeholder="${this.escapeAttr(placeholder)}" autocomplete="off"
        value="${sel ? this.escapeAttr(`${sel.first_name} ${sel.last_name}`) : ''}"
        oninput="document.getElementById('${id}').value='';App._filterCustomerPicker('${id}',this.value)" onfocus="App._filterCustomerPicker('${id}',this.value)">
      <input type="hidden" id="${id}" value="${sel ? sel.id : ''}">
      <div id="${id}-dd" class="cust-picker-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
    </div>`;
  },

  async _filterCustomerPicker(id, q) {
    const dd = document.getElementById(`${id}-dd`);
    const cfg = (this._custPickerLists || {})[id];
    if (!dd || !cfg) return;
    const query = (q || '').toLowerCase().trim();
    const noneRow = cfg.emptyLabel && !query
      ? `<div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text-muted)" onclick="App._selectCustomerPicker('${id}',null)">${cfg.emptyLabel}</div>`
      : '';
    let matches;
    if (cfg.remote != null) {
      if (dd.style.display === 'none') { dd.innerHTML = (cfg.allowAdd ? this._addCustomerRowHtml(id) : '') + noneRow + '<div style="padding:10px;color:var(--text-muted);font-size:13px">Searching…</div>'; dd.style.display = ''; }
      let rows;
      try { rows = await this._customerSearch(id, query, cfg.remote); }
      catch (e) { dd.innerHTML = `<div style="padding:10px;color:var(--danger);font-size:13px">${this.escapeAttr(e.message)}</div>`; return; }
      if (!rows) return;
      cfg.customers = this._mergeCustomers(cfg.customers, rows);
      matches = rows;
    } else {
      matches = cfg.customers.filter(c =>
        !query || `${c.first_name} ${c.last_name} ${c.business_name || ''} ${c.customer_number || ''} ${c.phone || ''} ${c.email || ''}`.toLowerCase().includes(query));
    }
    const esc = v => this.escapeAttr(v ?? '');
    const balance = c => !cfg.showBalance ? '' : Number(c.account_balance) > 0.005
      ? `<span style="margin-left:auto;padding-left:12px;white-space:nowrap;font-size:12px;color:var(--danger);font-weight:600">owes ${this.fmt(c.account_balance)}</span>`
      : '<span style="margin-left:auto;padding-left:12px;white-space:nowrap;font-size:12px;font-weight:400;color:var(--text-muted)">nothing owing</span>';
    dd.innerHTML = (cfg.allowAdd ? this._addCustomerRowHtml(id) : '') + noneRow + (matches.length
      ? matches.slice(0, 50).map(c => `<div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectCustomerPicker('${id}',${c.id})">
          <div style="display:flex;align-items:baseline;width:100%"><span><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong><span style="color:var(--text-muted);font-size:12px;margin-left:4px">${esc(c.customer_number)}</span></span>${balance(c)}</div>
        </div>`).join('')
      : '<div style="padding:10px;color:var(--text-muted);font-size:13px">No customers found</div>');
    dd.style.display = '';
  },

  async _selectCustomerPicker(id, customerId) {
    const cfg = (this._custPickerLists || {})[id];
    let c = customerId != null && cfg ? cfg.customers.find(x => String(x.id) === String(customerId)) : null;
    // A remote picker only holds search results — fetch a customer chosen
    // from elsewhere (the POS ticket, a form being carried over).
    if (customerId != null && cfg && !c && cfg.remote != null) {
      try { c = await this._customerById(customerId); } catch (e) { c = null; }
      if (c) cfg.customers = this._mergeCustomers(cfg.customers, [c]);
    }
    const idEl = document.getElementById(id);
    const searchEl = document.getElementById(`${id}-search`);
    const dd = document.getElementById(`${id}-dd`);
    if (idEl) idEl.value = c ? c.id : '';
    if (searchEl) searchEl.value = c ? `${c.first_name} ${c.last_name}` : '';
    if (dd) dd.style.display = 'none';
    const onSelect = (this._custPickerOnSelect || {})[id];
    if (onSelect) onSelect(c);
  },
});
