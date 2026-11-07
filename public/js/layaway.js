// Layaway plans.
Object.assign(App, {
  // ─── Layaway ──────────────────────────────────────────────────────────────

  _layawayTabs: [
    { key: 'active',    label: 'Active' },
    { key: 'overdue',   label: 'Overdue' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'all',       label: 'All' },
  ],

  async renderLayaway() {
    // Guarded — createLayawayPlan() calls this unconditionally on success,
    // including when the plan was created from POS's "Create Layaway" grid
    // button while still on the POS screen; without this check it would
    // blow away the POS kiosk layout underneath the closing modal (same
    // class of bug as renderQuotations() had for Create Quote from POS).
    if (this.section !== 'layaway') return;
    this.layawayTab = this.layawayTab || 'active';
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Layaway</h2>
        <div id="layaway-header-actions">${this.can('layaway_create') ? `<button class="btn btn-primary btn-sm" onclick="App.showLayawayCheckoutModal()">+ New Layaway</button>` : ''}</div>
      </div>
      <div class="crm-tabs" id="layaway-tabs-nav">
        ${this._layawayTabs.map(t=>`<button class="crm-tab ${this.layawayTab===t.key?'active':''}" onclick="App.filterLayaway('${t.key}')">${t.label}</button>`).join('')}
      </div>
      <div id="layaway-content"></div>`;
    await this.loadLayawayTab();
  },

  async filterLayaway(tab) {
    this.layawayTab = tab;
    document.querySelectorAll('#layaway-tabs-nav .crm-tab').forEach((btn,i) => {
      btn.classList.toggle('active', this._layawayTabs[i].key === tab);
    });
    await this.loadLayawayTab();
  },

  async loadLayawayTab() {
    const el = document.getElementById('layaway-content');
    if (!el) return;
    const view = this.layawayTab === 'all' ? '' : this.layawayTab;
    const plans = await this.api('GET', `/layaway/plans${view ? '?view='+view : ''}`);
    if (!document.getElementById('layaway-content')) return;
    const sc = { active:'badge-info', overdue:'badge-danger', completed:'badge-success', cancelled:'badge-secondary' };
    document.getElementById('layaway-content').innerHTML = !plans.length ? '<div class="empty-state"><p>No layaway plans found.</p></div>' : `
      <table class="table">
        <thead><tr><th>Plan #</th><th>Customer</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Next Due</th><th>Status</th><th></th></tr></thead>
        <tbody>${plans.map(p => {
          const displayStatus = p.status === 'active' && p.is_overdue ? 'overdue' : p.status;
          const remaining = Math.max(0, p.total - p.amount_paid);
          return `<tr>
          <td class="fw-600">${p.plan_number}</td>
          <td>${p.customer_name||'—'}</td>
          <td>${this.fmt(p.total)}</td>
          <td>${this.fmt(p.amount_paid)}</td>
          <td>${this.fmt(remaining)}</td>
          <td>${p.next_due_date ? this.fmtDate(p.next_due_date) : '—'}</td>
          <td><span class="badge-pill ${sc[displayStatus]||'badge-secondary'}">${displayStatus}</span></td>
          <td style="text-align:right"><button class="btn btn-sm btn-outline" onclick="App.viewLayawayPlan(${p.id})">View</button></td>
        </tr>`;
        }).join('')}</tbody>
      </table>`;
  },

  // ─── New Layaway (customer + items + deposit) ──────────────────────────────

  async showLayawayCheckoutModal() {
    // Reset on every open — posCreateLayawayFromCart() sets this true right
    // after this call returns, for that one attempt only.
    this._layawayFromPOSCart = false;
    const branches = this.currentUser.branches || [];
    const defaultBranch = branches.find(b => b.is_default) || branches[0] || null;
    const products = await this.api('GET', `/products?is_layaway_eligible=1&active=1${defaultBranch ? '&branch_id='+defaultBranch.id : ''}`);
    this._layawayProducts = products;
    this._layawayCustomers = [];
    this._layawayLineIdx = 0;
    const depositPct = this.settings?.layaway_deposit_percent || 20;
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">New Layaway</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group" style="position:relative"><label>Customer *</label>
              <input type="text" id="lc-customer-search" placeholder="Search customer…" autocomplete="off"
                oninput="App._filterLayawayCustomers(this.value)" onfocus="App._filterLayawayCustomers(this.value)">
              <input type="hidden" id="lc-customer" value="">
              <div id="lc-customer-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
            </div>
            <div class="form-group"><label>Branch / Location *</label>
              <select id="lc-branch" onchange="App._refreshLayawayCheckoutBranch()">
                <option value="">Select location…</option>
                ${branches.map(b=>`<option value="${b.id}" ${defaultBranch && b.id===defaultBranch.id?'selected':''}>${b.name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>Payment Frequency</label>
            <select id="lc-frequency">
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly" selected>Monthly</option>
            </select>
          </div>
          <hr style="margin:12px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>Items</strong>
            <button class="btn btn-sm btn-outline" onclick="App.addLayawayLine()">+ Add Item</button>
          </div>
          <div id="layaway-checkout-lines"></div>
          <div id="layaway-totals" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;font-size:13px"></div>
          <div class="input-row" style="margin-top:8px">
            <div class="form-group"><label>Payment Method</label>
              <select id="lc-paymethod">
                <option value="cash">Cash</option>
                <option value="credit_card">Card</option>
                <option value="check">Check</option>
                <option value="tax_exempt_tender">Tax Exempt</option>
              </select>
            </div>
            <div class="form-group"><label>Deposit Collected (min ${depositPct}%)</label><input type="number" id="lc-tendered" step="0.01" min="0" oninput="this.dataset.touched='1'"></div>
          </div>
          <div class="form-group"><label>Notes</label><input id="lc-notes" placeholder="Optional"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.createLayawayPlan()">Create Layaway</button>
        </div>
      </div>`);
    this.addLayawayLine();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#lc-customer-search') && !e.target.closest('#lc-customer-dd')) {
        const dd = document.getElementById('lc-customer-dd');
        if (dd) dd.style.display = 'none';
      }
      if (!e.target.closest('.ll-prod-search-wrap')) {
        document.querySelectorAll('[id^="ll-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
    });
  },

  async _filterLayawayCustomers(q) {
    const dd = document.getElementById('lc-customer-dd');
    if (!dd) return;
    if (dd.style.display === 'none') { dd.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:13px">Searching…</div>'; dd.style.display = ''; }
    let matches;
    try { matches = await this._customerSearch('layaway', q); }
    catch (e) { dd.innerHTML = `<div style="padding:10px;color:var(--danger);font-size:13px">${this.escapeAttr(e.message)}</div>`; return; }
    if (!matches) return;
    this._layawayCustomers = this._mergeCustomers(this._layawayCustomers, matches);
    const esc = v => this.escapeAttr(v ?? '');
    if (!matches.length) {
      dd.innerHTML = this._addCustomerRowHtml('layaway') + '<div style="padding:10px;color:var(--text-muted);font-size:13px">No customers found</div>';
      dd.style.display = '';
      return;
    }
    dd.innerHTML = this._addCustomerRowHtml('layaway') + matches.map(c => `<div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectLayawayCustomer(${c.id})">
        <div><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong><span style="color:var(--text-muted);font-size:12px;margin-left:4px">${esc(c.customer_number)}</span></div>
      </div>`).join('');
    dd.style.display = '';
  },

  async _selectLayawayCustomer(id) {
    let c = (this._layawayCustomers || []).find(x => x.id === id);
    if (!c) {
      try { c = await this._customerById(id); } catch (e) { c = null; }
      if (!c) return;
      this._layawayCustomers = this._mergeCustomers(this._layawayCustomers, [c]);
    }
    const idEl = document.getElementById('lc-customer');
    const searchEl = document.getElementById('lc-customer-search');
    const dd = document.getElementById('lc-customer-dd');
    if (idEl) idEl.value = id;
    if (searchEl) searchEl.value = `${c.first_name} ${c.last_name}`;
    if (dd) dd.style.display = 'none';
  },

  addLayawayLine() {
    const container = document.getElementById('layaway-checkout-lines');
    if (!container) return;
    const idx = this._layawayLineIdx++;
    const wrap = document.createElement('div');
    wrap.id = `layaway-line-${idx}`;
    wrap.style.cssText = 'display:flex;gap:6px;align-items:flex-start;border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:8px';
    wrap.innerHTML = `
      <span class="ll-prod-search-wrap" style="flex:2;position:relative">
        <input type="text" id="ll-prod-search-${idx}" placeholder="Search products…" autocomplete="off" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px"
          oninput="App._filterLayawayLineOptions(${idx},this.value)" onfocus="App._filterLayawayLineOptions(${idx},this.value)">
        <input type="hidden" id="ll-prod-${idx}" value="">
        <div id="ll-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
      </span>
      <select id="ll-unit-${idx}" style="width:120px;padding:6px;display:none" onchange="App._recalcLayawayTotals()" title="Unit of measure"><option value="">Each</option></select>
      <input type="number" id="ll-qty-${idx}" value="1" min="0" step="any" style="width:70px;padding:6px;border:1px solid var(--border);border-radius:4px" onchange="App._recalcLayawayTotals()">
      <span id="ll-warn-${idx}" style="font-size:11px;color:var(--danger);align-self:center"></span>
      <button class="btn btn-sm btn-outline" onclick="document.getElementById('layaway-line-${idx}').remove();App._recalcLayawayTotals()">✕</button>`;
    container.appendChild(wrap);
    this._recalcLayawayTotals();
  },

  // Searchable replacement for what used to be a plain <select> of every
  // layaway-eligible product — same pattern as the Quotation item picker.
  // createLayawayPlan/_recalcLayawayTotals read ll-prod-${idx}'s value
  // directly (a hidden input here, same id/semantics as the old select).
  // Shelf price + Settings → Layaway markup, per unit, rounded — must match
  // POST /layaway/plans (routes/layaway.js), which is what actually charges.
  _layawayUnitPrice(price) {
    const markup = Math.max(0, parseFloat(this.settings?.layaway_markup_percent) || 0);
    return parseFloat(((parseFloat(price) || 0) * (1 + markup / 100)).toFixed(2));
  },

  _filterLayawayLineOptions(idx, query) {
    const dd = document.getElementById(`ll-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._layawayProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectLayawayLineOption(${idx},${p.id})">
        <strong>${p.name}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${this.fmt(this._layawayUnitPrice(p.price))} &bull; ${p.stock_qty} available${p.sku ? ' · ' + p.sku : ''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No products found</div>`;
    dd.style.display = '';
  },

  _selectLayawayLineOption(idx, productId) {
    const p = (this._layawayProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`ll-prod-${idx}`);
    const searchEl = document.getElementById(`ll-prod-search-${idx}`);
    const dd = document.getElementById(`ll-prod-dd-${idx}`);
    if (hidden) { hidden.value = productId; hidden.dataset.price = p.price; hidden.dataset.tax = p.tax_rate||0; hidden.dataset.avail = p.stock_qty; }
    if (searchEl) searchEl.value = `${p.name} (${p.stock_qty}${p.base_unit_id ? ' ' + (p.base_unit_abbr || p.base_unit_name) : ''} available)`;
    if (dd) dd.style.display = 'none';
    // Unit of measure (lib/units.js) — offered when the item has alternate units.
    const unitSel = document.getElementById(`ll-unit-${idx}`);
    if (unitSel) {
      const choices = this._unitChoices(p);
      unitSel.innerHTML = choices.map(c => `<option value="${c.isBase ? '' : c.uom_id}">${this.escapeAttr(c.label || c.name)}</option>`).join('');
      unitSel.style.display = choices.length > 1 ? '' : 'none';
    }
    this._recalcLayawayTotals();
  },

  async _refreshLayawayCheckoutBranch() {
    const branchId = document.getElementById('lc-branch')?.value;
    this._layawayProducts = branchId ? await this.api('GET', `/products?is_layaway_eligible=1&active=1&branch_id=${branchId}`) : [];
    if (!document.getElementById('lc-branch')) return;
    document.querySelectorAll('#layaway-checkout-lines [id^="layaway-line-"]').forEach(line => {
      const idx = line.id.replace('layaway-line-','');
      const hidden = document.getElementById(`ll-prod-${idx}`);
      const searchEl = document.getElementById(`ll-prod-search-${idx}`);
      if (!hidden) return;
      const currentVal = hidden.value;
      const match = currentVal ? this._layawayProducts.find(p => String(p.id) === String(currentVal)) : null;
      if (match) {
        hidden.dataset.price = match.price;
        hidden.dataset.tax = match.tax_rate||0;
        hidden.dataset.avail = match.stock_qty;
        if (searchEl) searchEl.value = `${match.name} (${match.stock_qty} available)`;
      } else if (currentVal) {
        // Selected item isn't available at the new branch — clear it rather
        // than silently keeping a stale selection the new branch can't serve.
        hidden.value = '';
        hidden.dataset.price = '';
        hidden.dataset.tax = '';
        hidden.dataset.avail = '';
        if (searchEl) searchEl.value = '';
      }
    });
    this._recalcLayawayTotals();
  },

  _recalcLayawayTotals() {
    let subtotal = 0, taxAmount = 0;
    document.querySelectorAll('#layaway-checkout-lines [id^="layaway-line-"]').forEach(line => {
      const idx = line.id.replace('layaway-line-','');
      const hidden = document.getElementById(`ll-prod-${idx}`);
      const qtyEl = document.getElementById(`ll-qty-${idx}`);
      const warnEl = document.getElementById(`ll-warn-${idx}`);
      if (!hidden || !qtyEl) return;
      // A line in another unit (lib/units.js): that unit's price, and
      // availability in that unit.
      const product = (this._layawayProducts || []).find(p => String(p.id) === hidden.value);
      const unitVal = document.getElementById(`ll-unit-${idx}`)?.value;
      const choice = product ? this._unitChoiceFor(product, unitVal ? Number(unitVal) : (product.base_unit_id || null)) : null;
      const per = choice?.factor || 1;
      const avail = choice?.allow_decimal ? (Number(hidden.dataset.avail) || 0) / per : Math.floor((Number(hidden.dataset.avail) || 0) / per);
      const qty = Number(qtyEl.value) || 0;
      if (warnEl) warnEl.textContent = (hidden.value && qty > avail) ? `Only ${Math.round(avail * 1000) / 1000} ${choice?.label || ''} available` : '';
      if (!hidden.value) return;
      const price = this._layawayUnitPrice(choice ? choice.price : hidden.dataset.price);
      const taxRate = parseFloat(hidden.dataset.tax) || 0;
      const lineTotal = price * qty;
      subtotal += lineTotal;
      taxAmount += lineTotal * taxRate / 100;
    });
    const total = subtotal + taxAmount;
    const depositPct = this.settings?.layaway_deposit_percent || 20;
    const depositRequired = parseFloat((total * depositPct / 100).toFixed(2));
    const totalsEl = document.getElementById('layaway-totals');
    const markupPct = Math.max(0, parseFloat(this.settings?.layaway_markup_percent) || 0);
    if (totalsEl) totalsEl.innerHTML = `
      <div style="display:flex;justify-content:space-between"><span>Subtotal${markupPct > 0 ? ` <span style="font-size:11px;color:var(--text-muted)">(includes ${markupPct}% layaway markup)</span>` : ''}</span><span>${this.fmt(subtotal)}</span></div>
      <div style="display:flex;justify-content:space-between"><span>Tax</span><span>${this.fmt(taxAmount)}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:600"><span>Total</span><span>${this.fmt(total)}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:600;color:var(--primary)"><span>Required Deposit (${depositPct}%)</span><span>${this.fmt(depositRequired)}</span></div>`;
    const tenderedEl = document.getElementById('lc-tendered');
    if (tenderedEl && !tenderedEl.dataset.touched) tenderedEl.value = depositRequired.toFixed(2);
  },

  async createLayawayPlan() {
    const customer_id = document.getElementById('lc-customer').value;
    const branch_id = document.getElementById('lc-branch').value || null;
    const payment_frequency = document.getElementById('lc-frequency').value;
    const payment_method = document.getElementById('lc-paymethod').value;
    const amount_tendered = parseFloat(document.getElementById('lc-tendered').value) || 0;
    const notes = document.getElementById('lc-notes').value.trim() || null;
    if (!customer_id) { this.alert('Please select a customer', 'error'); return; }
    if (!branch_id) { this.alert('Please select a branch/location', 'error'); return; }
    const items = [];
    document.querySelectorAll('#layaway-checkout-lines [id^="layaway-line-"]').forEach(line => {
      const idx = line.id.replace('layaway-line-','');
      const product_id = document.getElementById(`ll-prod-${idx}`)?.value;
      const quantity = Number(document.getElementById(`ll-qty-${idx}`)?.value) || 0;
      const uom_id = Number(document.getElementById(`ll-unit-${idx}`)?.value) || null;
      if (product_id && quantity > 0) items.push({ product_id, quantity, uom_id });
    });
    if (!items.length) { this.alert('Add at least one item', 'error'); return; }
    try {
      const plan = await this.api('POST', '/layaway/plans', {
        customer_id, branch_id, employee_id: this.currentUser.id, items,
        payment_method, amount_tendered, payment_frequency, notes,
        drawer_session_id: this.currentDrawerSession?.id || null,
      });
      this.closeModal();
      this.alert(`Layaway ${plan.plan_number} created — deposit collected`);
      // Only clear the POS ticket when this plan was seeded from it — a
      // layaway created normally from the Layaway section has no relation
      // to whatever (if anything) happens to be sitting in this.cart.
      if (this._layawayFromPOSCart) { this._layawayFromPOSCart = false; this._dropRecalledHold(); this.clearCart(); }
      this.renderLayaway();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Detail / payments / cancellation ──────────────────────────────────────

  async viewLayawayPlan(id) {
    const p = await this.api('GET', `/layaway/plans/${id}`);
    const sc = { active:'badge-info', overdue:'badge-danger', completed:'badge-success', cancelled:'badge-secondary' };
    const displayStatus = p.status === 'active' && p.is_overdue ? 'overdue' : p.status;
    const remaining = Math.max(0, p.total - p.amount_paid);
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">Layaway ${p.plan_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer</label><div>${p.customer_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Branch</label><div>${p.branch_name||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Status</label><div><span class="badge-pill ${sc[displayStatus]||'badge-secondary'}">${displayStatus}</span></div></div>
          </div>
          <table class="table" style="margin-bottom:12px">
            <thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr></thead>
            <tbody>${p.items.map(i => `<tr><td>${i.product_name}</td><td>${i.quantity}</td><td>${this.fmt(i.unit_price)}${i.base_unit_price != null && i.base_unit_price !== i.unit_price ? `<div style="font-size:11px;color:var(--text-muted)">Regular ${this.fmt(i.base_unit_price)}</div>` : ''}</td><td>${this.fmt(i.line_total)}</td></tr>`).join('')}</tbody>
          </table>
          ${p.markup_percent > 0 ? `<p style="font-size:12px;color:var(--text-muted);margin:-6px 0 10px">Prices include the ${p.markup_percent}% layaway markup in effect when this plan was created.</p>` : ''}
          <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:14px;font-size:13px">
            <span>Total: <strong>${this.fmt(p.total)}</strong></span>
            <span>Paid: <strong>${this.fmt(p.amount_paid)}</strong></span>
            <span>Remaining: <strong>${this.fmt(remaining)}</strong></span>
            ${p.next_due_date ? `<span>Next Due: <strong>${this.fmtDate(p.next_due_date)}</strong></span>` : ''}
            ${p.status==='cancelled' ? `<span>Forfeited: <strong>${this.fmt(p.forfeited_amount)}</strong></span><span>Refunded: <strong>${this.fmt(p.refunded_amount)}</strong></span>` : ''}
          </div>
          <strong>Payment History</strong>
          <table class="table">
            <thead><tr><th>Payment #</th><th>Date</th><th>Amount</th><th>Method</th><th>Type</th></tr></thead>
            <tbody>${p.payments.map(pay => `<tr><td>${pay.payment_number}</td><td>${this.fmtDateTime(pay.created_at)}</td><td>${this.fmt(pay.amount)}</td><td>${(pay.payment_method||'').replace(/_/g, ' ')}</td><td>${pay.is_deposit ? 'Deposit' : 'Installment'}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="modal-footer">
          ${p.status==='active' && this.can('layaway_payments') ? `<button class="btn btn-primary" onclick="App.closeModal();App.showLayawayPaymentModal(${p.id})">Record Payment</button>` : ''}
          ${p.status==='active' && this.can('layaway_cancel') ? `<button class="btn btn-danger" onclick="App.closeModal();App.cancelLayawayPlan(${p.id})">Cancel Plan</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async showLayawayPaymentModal(id) {
    const p = await this.api('GET', `/layaway/plans/${id}`);
    if (p.status !== 'active') { this.alert('This plan is not active', 'warning'); return; }
    const remaining = Math.max(0, p.total - p.amount_paid);
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <span class="modal-title">Record Payment — ${p.plan_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Remaining balance: <strong>${this.fmt(remaining)}</strong></p>
          <div class="form-group"><label>Amount</label><input type="number" id="lp-amount" step="0.01" min="0.01" max="${remaining}" value="${remaining.toFixed(2)}"></div>
          <div class="form-group"><label>Payment Method</label>
            <select id="lp-paymethod">
              <option value="cash">Cash</option>
              <option value="credit_card">Card</option>
              <option value="check">Check</option>
              <option value="tax_exempt_tender">Tax Exempt</option>
            </select>
          </div>
          <div class="form-group"><label>Notes</label><input id="lp-notes" placeholder="Optional"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveLayawayPayment(${id})">Record Payment</button>
        </div>
      </div>`);
  },

  async saveLayawayPayment(id) {
    const amount = parseFloat(document.getElementById('lp-amount').value);
    const payment_method = document.getElementById('lp-paymethod').value;
    const notes = document.getElementById('lp-notes').value.trim() || null;
    if (!amount || amount <= 0) { this.alert('Enter a valid amount', 'error'); return; }
    try {
      const plan = await this.api('PATCH', `/layaway/plans/${id}/payments`, {
        amount, payment_method, notes, employee_id: this.currentUser.id,
        drawer_session_id: this.currentDrawerSession?.id || null,
      });
      this.closeModal();
      this.alert(plan.status === 'completed' ? `Layaway ${plan.plan_number} fully paid — ready for pickup!` : 'Payment recorded');
      this.renderLayaway();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  cancelLayawayPlan(id) {
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">Cancel Layaway Plan</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Items will be restocked. Any cancellation fee configured in Settings → Layaway will be forfeited from what's already been paid; the rest is refunded automatically.</p>
          <div class="form-group"><label>Reason (optional)</label>
            <input type="text" id="cancel-layaway-reason" placeholder="e.g. Customer no longer wants the item...">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Back</button>
          <button class="btn btn-danger" onclick="App._confirmCancelLayawayPlan(${id})">Cancel Plan</button>
        </div>
      </div>`);
  },

  async _confirmCancelLayawayPlan(id) {
    const reason = document.getElementById('cancel-layaway-reason')?.value.trim() || null;
    try {
      const plan = await this.api('PATCH', `/layaway/plans/${id}/cancel`, { reason, employee_id: this.currentUser?.id || null });
      this.closeModal();
      this.alert(`Layaway cancelled — forfeited ${this.fmt(plan.forfeited_amount)}, refunded ${this.fmt(plan.refunded_amount)}`);
      this.renderLayaway();
    } catch(e) { this.alert(e.message, 'error'); }
  },

});
