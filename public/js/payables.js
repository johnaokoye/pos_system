// Accounts payable, contra / barter, payment requests.
Object.assign(App, {
  // ─── Accounts Payable ─────────────────────────────────────
  // What we owe vendors (routes/payables.js): bills — created automatically
  // when a PO is received, entered from a PO, or entered by hand — payments
  // applied against them, and aging by vendor. Vendors are only paid from
  // an approved payment request (routes/payment-requests.js).
  _apStatusBadge: { open: 'badge-info', partial: 'badge-purple', overdue: 'badge-danger', paid: 'badge-success', void: 'badge-secondary' },
  _apMethods: [['cheque', 'Cheque'], ['bank_transfer', 'Bank Transfer'], ['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']],
  // Shown for payments, never offered when paying: a contra offset is posted from Payables → Contra.
  _apMethodNames: { contra: 'Contra (offset)' },
  // Bill/payment dates are plain YYYY-MM-DD; fmtDate shows a bare date as
  // that calendar day.
  _apDate(d) { return d ? this.fmtDate(String(d).slice(0, 10)) : '—'; },
  _apToday() { return new Date().toLocaleDateString('en-CA'); },

  async renderPayables(tab) {
    if (tab) this._apTab = tab;
    else this._apSuppliers = null; // re-fetch the vendor filter list on a fresh visit
    // Approvers without the A/P module only get the request queue.
    const fullAp = this.can('payables');
    const contraTab = fullAp || this.can('payables_approve') || this.can('payables_contra');
    tab = fullAp ? (this._apTab || 'bills') : (this._apTab === 'contras' && contraTab ? 'contras' : 'requests');
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let aging, awaiting, toPay;
    try {
      [aging, awaiting, toPay] = await Promise.all([
        fullAp ? this.api('GET', `/payables/aging?as_of=${this._apToday()}`) : null,
        this.api('GET', '/payables/payment-requests?status=submitted'),
        this.api('GET', '/payables/payment-requests?status=approved'),
      ]);
    }
    catch (e) { if (this.section === 'payables') c.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (this.section !== 'payables') return;
    const tile = (label, value, color) => `<div class="card" style="padding:14px 16px"><div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em">${label}</div><div style="font-size:22px;font-weight:700;margin-top:4px;${color ? `color:${color}` : ''}">${value}</div></div>`;
    const t = aging?.totals;
    const overdue = t ? t.d1_30 + t.d31_60 + t.d61_90 + t.d90_plus : 0;
    const tabs = fullAp ? [['bills', 'Bills'], ['requests', 'Payment Request'], ['payments', 'Payments'], ['aging', 'Aging by Vendor']] : [['requests', 'Payment Request']];
    if (contraTab) tabs.push(['contras', 'Contra / Barter']);
    c.innerHTML = `
      <div class="section-header">
        <h2>Accounts Payable</h2>
        <div style="display:flex;gap:10px">
          ${this.can('payables_bills') ? `<button class="btn btn-secondary" onclick="App.showBillForm()">+ Enter Bill</button>` : ''}
          ${this.can('payables_requests') ? `<button class="btn btn-primary" onclick="App.showPaymentRequestForm()">+ Payment Request</button>` : ''}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
        ${t ? `${tile('Total Owed', this.fmt(t.total))}
        ${tile('Overdue', this.fmt(overdue), overdue > 0 ? 'var(--danger)' : '')}
        ${tile('Not Yet Due', this.fmt(t.current))}` : ''}
        ${tile('Awaiting Approval', `${awaiting.length}${awaiting.length ? ` <span style="font-size:13px;font-weight:500;color:var(--text-muted)">· ${this.fmt(awaiting.reduce((sum, r) => sum + r.amount, 0))}</span>` : ''}`, awaiting.length ? 'var(--warning, #b45309)' : '')}
        ${tile('Approved — To Pay', `${toPay.length}${toPay.length ? ` <span style="font-size:13px;font-weight:500;color:var(--text-muted)">· ${this.fmt(toPay.reduce((sum, r) => sum + r.amount, 0))}</span>` : ''}${(() => { const d = toPay.map(r => r.scheduled_date || r.required_date).filter(Boolean).sort()[0]; return d ? `<div style="font-size:12px;font-weight:500;margin-top:2px">Next scheduled: ${this._prqPayByHtml(d, { short: true })}</div>` : ''; })()}`, toPay.length ? 'var(--primary)' : '')}
        ${aging?.advances_unapplied > 0 ? tile('Advances Not Yet Billed', this.fmt(aging.advances_unapplied)) : ''}
      </div>
      <div class="var-tab-bar" style="padding:0;margin-bottom:14px">
        ${tabs.map(([k, l]) => `<div class="var-tab ${tab === k ? 'active' : ''}" onclick="App.renderPayables('${k}')">${l}${k === 'requests' && awaiting.length ? ` <span class="badge-pill badge-warning" style="font-size:10px;margin-left:4px">${awaiting.length}</span>` : ''}</div>`).join('')}
      </div>
      <div id="ap-tab-body"></div>`;
    if (tab === 'bills') this._renderApBills();
    else if (tab === 'requests') this._renderApRequests();
    else if (tab === 'payments') this._renderApPayments();
    else if (tab === 'contras') this._renderApContras();
    else this._renderApAging(aging);
  },

  // ── Contra / barter (routes/contras.js) ───────────────────────────────────
  // A business that's both our customer and supplier: what we owe on their
  // bills is set off against what they owe on our invoices, no cash moves.
  _contraStatus: { draft: ['Draft', 'badge-secondary'], submitted: ['Awaiting Approval', 'badge-warning'], approved: ['Approved — To Post', 'badge-info'], posted: ['Posted', 'badge-success'], rejected: ['Rejected', 'badge-danger'], cancelled: ['Cancelled', 'badge-secondary'] },

  async _renderApContras() {
    const el = document.getElementById('ap-tab-body');
    const f = this._contraFilter || (this._contraFilter = { status: 'open', q: '' });
    const canRaise = this.can('payables_contra');
    let links = [];
    try { links = await this.api('GET', '/payables/contras/links'); } catch (e) {}
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px;padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px">
          <div><strong>Linked Businesses</strong> <span style="font-size:12px;color:var(--text-muted)">— a supplier that's also a customer, so their bills can be offset against our invoices</span></div>
          <div style="display:flex;gap:8px">${canRaise ? `<button class="btn btn-sm btn-outline" onclick="App._contraLinkForm()">+ Link Accounts</button>${links.length ? '<button class="btn btn-sm btn-primary" onclick="App.showContraForm()">+ New Contra</button>' : ''}` : ''}</div>
        </div>
        ${links.length ? `<table class="table" style="margin:0"><thead><tr><th>Supplier</th><th>Customer Account</th><th style="text-align:right">They Owe Us</th>${canRaise ? '<th></th>' : ''}</tr></thead><tbody>
          ${links.map(l => `<tr><td class="fw-600">${this.escapeAttr(l.supplier_name)} <span style="color:var(--text-muted);font-weight:400">${this.escapeAttr(l.supplier_number || '')}</span></td>
            <td>${this.escapeAttr(l.customer_name)} <span style="color:var(--text-muted)">${this.escapeAttr(l.customer_number || '')}</span></td>
            <td style="text-align:right">${this.fmt(l.account_balance)}</td>
            ${canRaise ? `<td style="text-align:right;white-space:nowrap"><button class="btn btn-sm btn-primary" onclick="App.showContraForm(null, ${l.supplier_id})">New Contra</button> <button class="btn btn-sm btn-outline" onclick="App._contraUnlink(${l.supplier_id}, '${this.escapeAttr(l.supplier_name).replace(/'/g, "\\'")}')">Unlink</button></td>` : ''}</tr>`).join('')}
        </tbody></table>` : `<p style="font-size:13px;color:var(--text-muted);margin:0">No linked businesses yet.${canRaise ? ' Use <strong>+ Link Accounts</strong> to link a supplier to its customer account.' : ''}</p>`}
      </div>
      <div class="card" style="margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <select id="ctr-f-status" style="width:auto">
          ${[['open', 'Not yet posted'], ['submitted', 'Awaiting approval'], ['approved', 'Approved — to post'], ['posted', 'Posted'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['', 'All']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <input id="ctr-f-q" placeholder="Contra #, business, notes..." value="${this.escapeAttr(f.q)}" style="flex:1;min-width:200px">
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Contra #</th><th>Date</th><th>Business</th><th style="text-align:right">Amount Offset</th><th>Raised By</th><th>Status</th><th>Books</th></tr></thead>
        <tbody id="ctr-tbody"><tr><td colspan="7" class="empty-state">Loading...</td></tr></tbody>
      </table></div></div>`;
    const load = async () => {
      const qs = new URLSearchParams({ status: f.status });
      if (f.q) qs.set('q', f.q);
      const rows = await this.api('GET', `/payables/contras?${qs}`);
      const tb = document.getElementById('ctr-tbody');
      if (!tb) return;
      tb.innerHTML = rows.length ? rows.map(k => `<tr style="cursor:pointer;${k.status === 'cancelled' ? 'opacity:.6' : ''}" onclick="App.viewContra(${k.id})">
          <td class="fw-600">${k.contra_number}</td><td>${this._apDate(k.contra_date)}</td>
          <td>${this.escapeAttr(k.supplier_name)}${k.customer_name !== k.supplier_name ? `<div style="font-size:11px;color:var(--text-muted)">customer: ${this.escapeAttr(k.customer_name)}</div>` : ''}</td>
          <td style="text-align:right" class="fw-600">${this.fmt(k.amount)}</td><td>${this.escapeAttr(k.created_by_name || '—')}</td>
          <td><span class="badge-pill ${this._contraStatus[k.status]?.[1] || ''}">${this._contraStatus[k.status]?.[0] || k.status}</span></td>
          <td style="font-size:12px">${k.status !== 'posted' ? '—' : k.gl_status === 'posted' ? `<span class="color-success">${this.escapeAttr(k.gl_ref || 'Posted')}</span>` : k.gl_status === 'failed' ? '<span class="color-danger">Failed</span>' : 'Waiting'}</td>
        </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No contras found</td></tr>';
    };
    document.getElementById('ctr-f-status').addEventListener('change', e => { f.status = e.target.value; load(); });
    let timer;
    document.getElementById('ctr-f-q').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); });
    await load();
  },

  async _contraLinkForm() {
    const suppliers = await this.api('GET', '/suppliers').catch(() => []);
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">Link Supplier and Customer Accounts</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-top:0">For a business that both buys from us and sells to us (e.g. rents equipment and supplies fuel), so their bills can be offset against our invoices.</p>
          <div class="form-group"><label>Supplier *</label><select id="ctl-supplier" data-searchable><option value="">— Choose —</option>${suppliers.map(sp => `<option value="${sp.id}">${this.escapeAttr(sp.name)}${sp.supplier_number ? ` (${this.escapeAttr(sp.supplier_number)})` : ''}</option>`).join('')}</select></div>
          <div class="form-group"><label>Their Customer Account *</label>${this._customerPickerHtml('ctl-customer', [], null, { placeholder: 'Search by name, account #, phone…', remote: '', allowAdd: false, showBalance: true })}</div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="App._contraSaveLink()">Link</button></div>
      </div>`);
  },

  async _contraSaveLink() {
    const supplier_id = document.getElementById('ctl-supplier').value, customer_id = document.getElementById('ctl-customer').value;
    if (!supplier_id || !customer_id) return this.alert('Choose the supplier and the customer account', 'error');
    try { await this.api('PUT', '/payables/contras/links', { supplier_id, customer_id }); this.closeModal(); this.alert('Accounts linked'); this.renderPayables('contras'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _contraUnlink(supplierId, name) {
    if (!confirm(`Unlink ${name} from its customer account? Posted contras stay as they are.`)) return;
    try { await this.api('PUT', '/payables/contras/links', { supplier_id: supplierId, customer_id: null }); this.renderPayables('contras'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  // New (supplierId) or edit (id) — pick the invoices and bills, amounts per line.
  async showContraForm(id, supplierId) {
    let k = null;
    if (id) { try { k = await this.api('GET', `/payables/contras/${id}`); } catch (e) { return this.alert(e.message, 'error'); } supplierId = k.supplier_id; }
    if (!supplierId) {
      const links = await this.api('GET', '/payables/contras/links').catch(() => []);
      if (links.length === 1) supplierId = links[0].supplier_id;
      else {
        this.showModal(`<div class="modal" style="max-width:420px"><div class="modal-header"><span class="modal-title">New Contra</span><button class="modal-close">✕</button></div>
          <div class="modal-body"><div class="form-group"><label>Business *</label><select id="ctr-pick">${links.map(l => `<option value="${l.supplier_id}">${this.escapeAttr(l.supplier_name)}</option>`).join('')}</select></div></div>
          <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="App.showContraForm(null, document.getElementById('ctr-pick').value)">Next</button></div></div>`);
        return;
      }
    }
    let items;
    try { items = await this.api('GET', `/payables/contras/open-items/${supplierId}${id ? `?exclude=${id}` : ''}`); } catch (e) { return this.alert(e.message, 'error'); }
    const had = new Map((k?.lines || []).map(l => [l.bill_id ? `B${l.bill_id}` : l.legacy_invoice_id ? `L${l.legacy_invoice_id}` : `T${l.transaction_id}`, l.amount]));
    this._ctr = { id: id || null, supplierId: Number(supplierId), items };
    const rows = (list, side) => list.length ? list.map(d => `<tr style="${d.room > 0.005 ? '' : 'opacity:.5'}">
        <td><input type="checkbox" class="ctr-pick" data-side="${side}" data-key="${d.key}" ${had.has(d.key) ? 'checked' : ''} ${d.room > 0.005 ? '' : 'disabled'} onchange="App._ctrPick(this)" style="width:auto;margin:0"></td>
        <td class="fw-600" style="font-size:12px">${this.escapeAttr(d.number)}${d.kind === 'legacy' ? ' <span class="badge-pill badge-secondary" style="font-size:9px">Legacy</span>' : ''}${d.vendor_invoice_number ? `<div style="font-weight:400;color:var(--text-muted)">Their #${this.escapeAttr(d.vendor_invoice_number)}</div>` : ''}</td>
        <td style="font-size:12px">${this._apDate(d.date)}</td>
        <td style="font-size:12px;text-align:right">${this.fmt(d.balance)}${d.reserved > 0.005 ? `<div style="font-size:10px;color:var(--warning,#b45309)" title="Already on another contra${side === 'ap' ? ' or payment request' : ''}">${this.fmt(d.reserved)} held</div>` : ''}</td>
        <td><input type="number" class="ctr-amt" data-side="${side}" data-key="${d.key}" step="0.01" min="0" max="${d.room.toFixed(2)}" value="${had.has(d.key) ? Number(had.get(d.key)).toFixed(2) : ''}" ${had.has(d.key) ? '' : 'disabled'} oninput="App._ctrTotals()" style="width:110px;padding:4px 6px;font-size:12px"></td>
      </tr>`).join('') : `<tr><td colspan="5" style="font-size:12px;color:var(--text-muted);padding:8px">Nothing open.</td></tr>`;
    const table = (title, sub, list, side) => `<div style="flex:1;min-width:320px">
        <div style="font-weight:600;font-size:13px">${title}</div><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${sub}</div>
        <div class="table-wrap" style="max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:6px"><table style="font-size:12px">
          <thead><tr><th style="width:28px"></th><th>${side === 'ap' ? 'Bill' : 'Invoice'}</th><th>Date</th><th style="text-align:right">Balance</th><th style="width:120px">Offset</th></tr></thead>
          <tbody>${rows(list, side)}</tbody></table></div>
        <div style="text-align:right;font-size:13px;margin-top:4px">Selected: <strong id="ctr-tot-${side}">${this.fmt(0)}</strong></div></div>`;
    this.showModal(`
      <div class="modal" style="max-width:1000px">
        <div class="modal-header"><span class="modal-title">${k ? `Edit ${k.contra_number}` : 'New Contra / Barter Offset'} — ${this.escapeAttr(items.supplier.name)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${k?.status === 'rejected' ? `<div style="padding:8px 12px;border:1px solid #fecaca;background:#fef2f2;border-radius:6px;font-size:13px;color:#991b1b;margin-bottom:10px"><strong>Rejected</strong> by ${this.escapeAttr(k.rejected_by_name || '—')}: ${this.escapeAttr(k.rejection_reason || '')}</div>` : ''}
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-bottom:12px">
            <div class="form-group" style="margin:0"><label>Contra Amount</label><input type="number" id="ctr-amount" step="0.01" min="0" style="width:160px" placeholder="0.00"></div>
            <button class="btn btn-sm btn-outline" onclick="App._ctrFill()" title="Spreads the amount over the ticked invoices and bills, oldest first (all of them if none are ticked)">Fill Oldest First</button>
            <div class="form-group" style="margin:0"><label>Contra Date</label><input type="date" id="ctr-date" value="${k?.contra_date || this._storeDay(new Date())}"></div>
            <div style="font-size:12px;color:var(--text-muted);max-width:300px">Most that can be offset now: <strong>${this.fmt(Math.min(items.invoices.reduce((t, d) => t + d.room, 0), items.bills.reduce((t, d) => t + d.room, 0)))}</strong>. Partial amounts are fine; what isn't offset stays outstanding.</div>
          </div>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            ${table(`Our invoices to ${this.escapeAttr(items.customer.name)}`, 'Accounts Receivable — what they owe us', items.invoices, 'ar')}
            ${table(`${this.escapeAttr(items.supplier.name)} bills to us`, 'Accounts Payable — what we owe them', items.bills, 'ap')}
          </div>
          <div id="ctr-balance-msg" style="margin-top:10px;font-size:13px"></div>
          <div class="form-group" style="margin-top:10px"><label>Notes</label><input id="ctr-notes" value="${this.escapeAttr(k?.notes || '')}" placeholder="e.g. Fuel invoices for October set off against equipment rental"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-outline" onclick="App._ctrSave(false)">Save Draft</button>
          <button class="btn btn-primary" onclick="App._ctrSave(true)">Submit for Approval</button>
        </div>
      </div>`);
    this._ctrTotals();
  },

  _ctrPick(cb) {
    const amt = document.querySelector(`.ctr-amt[data-key="${cb.dataset.key}"]`);
    const doc = [...this._ctr.items.invoices, ...this._ctr.items.bills].find(d => d.key === cb.dataset.key);
    amt.disabled = !cb.checked;
    amt.value = cb.checked ? doc.room.toFixed(2) : '';
    this._ctrTotals();
  },

  // Spreads the contra amount over each side oldest first.
  _ctrFill() {
    const amount = Math.round((parseFloat(document.getElementById('ctr-amount').value) || 0) * 100) / 100;
    if (!(amount > 0)) return this.alert('Enter the contra amount first', 'error');
    // Check both sides have room before changing either.
    const sides = [['ar', this._ctr.items.invoices], ['ap', this._ctr.items.bills]].map(([side, list]) => {
      const ticked = [...document.querySelectorAll(`.ctr-pick[data-side="${side}"]:checked`)].map(c => c.dataset.key);
      const pool = list.filter(d => d.room > 0.005 && (!ticked.length || ticked.includes(d.key)));
      return { side, list, ticked, pool, room: pool.reduce((t, d) => t + d.room, 0) };
    });
    for (const x of sides) if (amount - x.room > 0.005) return this.alert(`Only ${this.fmt(x.room)} can be offset on the ${x.side === 'ar' ? 'invoices' : 'bills'}${x.ticked.length ? ' ticked' : ''}`, 'error');
    for (const { list, pool } of sides) {
      let left = amount;
      for (const d of list) {
        const cb = document.querySelector(`.ctr-pick[data-key="${d.key}"]`), amt = document.querySelector(`.ctr-amt[data-key="${d.key}"]`);
        const take = pool.includes(d) ? Math.min(d.room, Math.round(left * 100) / 100) : 0;
        left = Math.round((left - take) * 100) / 100;
        cb.checked = take > 0; amt.disabled = !(take > 0); amt.value = take > 0 ? take.toFixed(2) : '';
      }
    }
    this._ctrTotals();
  },

  _ctrLines() {
    return [...document.querySelectorAll('.ctr-amt')].filter(i => !i.disabled && parseFloat(i.value) > 0).map(i => {
      const key = i.dataset.key, id = Number(key.slice(1)), amount = Math.round(parseFloat(i.value) * 100) / 100;
      return key[0] === 'B' ? { bill_id: id, amount } : key[0] === 'L' ? { legacy_invoice_id: id, amount } : { transaction_id: id, amount };
    });
  },

  _ctrTotals() {
    const sum = side => [...document.querySelectorAll(`.ctr-amt[data-side="${side}"]`)].filter(i => !i.disabled).reduce((t, i) => t + (parseFloat(i.value) || 0), 0);
    const ar = Math.round(sum('ar') * 100) / 100, ap = Math.round(sum('ap') * 100) / 100;
    document.getElementById('ctr-tot-ar').textContent = this.fmt(ar);
    document.getElementById('ctr-tot-ap').textContent = this.fmt(ap);
    const msg = document.getElementById('ctr-balance-msg');
    if (!ar && !ap) msg.innerHTML = '<span style="color:var(--text-muted)">Tick the invoices and bills to offset, or enter the contra amount and press Fill Oldest First.</span>';
    else if (Math.abs(ar - ap) > 0.005) msg.innerHTML = `<span class="color-danger fw-600">The two sides must be equal — invoices ${this.fmt(ar)} vs bills ${this.fmt(ap)} (difference ${this.fmt(Math.abs(ar - ap))}).</span>`;
    else { msg.innerHTML = `<span class="color-success fw-600">Balanced — ${this.fmt(ar)} will be offset.</span>`; const a = document.getElementById('ctr-amount'); if (a && !a.matches(':focus')) a.value = ar.toFixed(2); }
  },

  async _ctrSave(submit) {
    const body = { supplier_id: this._ctr.supplierId, lines: this._ctrLines(), contra_date: document.getElementById('ctr-date').value, notes: document.getElementById('ctr-notes').value.trim(), submit };
    try {
      const k = await this.api(this._ctr.id ? 'PUT' : 'POST', `/payables/contras${this._ctr.id ? `/${this._ctr.id}` : ''}`, body);
      this.closeModal();
      this.alert(submit ? `${k.contra_number} submitted for approval` : `${k.contra_number} saved as a draft`);
      if (this.section === 'payables') this.renderPayables('contras');
      this.viewContra(k.id);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async viewContra(id) {
    let k;
    try { k = await this.api('GET', `/payables/contras/${id}`); } catch (e) { return this.alert(e.message, 'error'); }
    const me = this.currentUser?.id;
    const mine = Number(k.created_by) === Number(me) || Number(k.submitted_by) === Number(me);
    const canRaise = this.can('payables_contra'), canApprove = this.can('payables_approve'), canPost = this.can('payables_payments');
    const posted = k.status === 'posted';
    const lineRows = (lines, isBill) => lines.map(l => `<tr>
        <td class="fw-600">${this.escapeAttr(l.number || '')}${l.is_legacy ? ' <span class="badge-pill badge-secondary" style="font-size:9px">Legacy</span>' : ''}${l.vendor_invoice_number ? `<div style="font-weight:400;font-size:11px;color:var(--text-muted)">Their #${this.escapeAttr(l.vendor_invoice_number)}</div>` : ''}</td>
        <td>${this._apDate(l.doc_date)}</td><td style="text-align:right">${this.fmt(l.doc_total)}</td>
        <td style="text-align:right">${l.balance_before != null ? this.fmt(l.balance_before) : '—'}</td>
        <td style="text-align:right" class="fw-600">${this.fmt(l.amount)}</td>
        <td style="text-align:right">${l.balance_after != null ? this.fmt(l.balance_after) : '—'}</td></tr>`).join('');
    const table = (title, lines, isBill) => `<div style="font-weight:600;font-size:13px;margin:12px 0 4px">${title}</div>
      <table class="table" style="font-size:12px;margin:0"><thead><tr><th>${isBill ? 'Bill' : 'Invoice'}</th><th>Date</th><th style="text-align:right">Total</th><th style="text-align:right">${posted ? 'Balance Before' : 'Balance Now'}</th><th style="text-align:right">Offset</th><th style="text-align:right">${posted ? 'Remaining' : 'Would Remain'}</th></tr></thead><tbody>${lineRows(lines, isBill)}</tbody></table>`;
    const actionLabel = { created: 'Created', edited: 'Edited', submitted: 'Submitted for approval', recalled: 'Recalled to draft', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', posted: 'Posted — receivables and payables updated', gl_posted: 'Posted to RetailPOS Books', gl_failed: 'RetailPOS Books posting failed', gl_retry: 'Books posting retried' };
    const btn = (cls, label, onclick) => `<button class="btn ${cls}" onclick="${onclick}">${label}</button>`;
    const actions = [];
    if (['draft', 'rejected'].includes(k.status) && canRaise) actions.push(btn('btn-outline', k.status === 'rejected' ? 'Edit &amp; Resubmit' : 'Edit', `App.closeModal();App.showContraForm(${k.id})`));
    if (k.status === 'draft' && canRaise) actions.push(btn('btn-primary', 'Submit for Approval', `App._contraAction(${k.id}, 'submit')`));
    if (k.status === 'submitted' && canRaise) actions.push(btn('btn-outline', 'Recall to Draft', `App._contraAction(${k.id}, 'recall')`));
    if (['submitted', 'approved'].includes(k.status) && canApprove && !mine) actions.push(btn('btn-danger', 'Reject', `App._contraReject(${k.id})`));
    if (k.status === 'submitted' && canApprove && !mine) actions.push(btn('btn-success', 'Approve', `App._contraApprove(${k.id})`));
    if (k.status === 'approved' && canPost) actions.push(btn('btn-primary', 'Post Contra', `App._contraPost(${k.id})`));
    if (!['posted', 'cancelled'].includes(k.status) && canRaise) actions.unshift(btn('btn-outline', 'Cancel Contra', `App._contraCancel(${k.id})`));
    if (posted && k.gl_status === 'failed' && canPost) actions.push(btn('btn-outline', 'Retry Books Posting', `App._contraAction(${k.id}, 'gl-retry')`));
    this.showModal(`
      <div class="modal" style="max-width:900px">
        <div class="modal-header"><span class="modal-title">Contra ${k.contra_number}</span>
          <div style="display:flex;gap:8px;align-items:center"><span class="badge-pill ${this._contraStatus[k.status]?.[1] || ''}">${this._contraStatus[k.status]?.[0] || k.status}</span><button class="modal-close">✕</button></div></div>
        <div class="modal-body">
          ${k.status === 'submitted' && mine && canApprove ? '<div style="padding:8px 12px;border:1px solid #fde68a;background:#fffbeb;border-radius:6px;font-size:13px;color:#92400e;margin-bottom:10px">You raised this contra, so someone else has to approve it.</div>' : ''}
          ${k.status === 'rejected' ? `<div style="padding:8px 12px;border:1px solid #fecaca;background:#fef2f2;border-radius:6px;font-size:13px;color:#991b1b;margin-bottom:10px"><strong>Rejected</strong> by ${this.escapeAttr(k.rejected_by_name || '—')} · ${this.fmtDate(k.rejected_at)}<br>${this.escapeAttr(k.rejection_reason || '')}</div>` : ''}
          ${k.status === 'cancelled' ? `<div style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;border-radius:6px;font-size:13px;margin-bottom:10px"><strong>Cancelled</strong> by ${this.escapeAttr(k.cancelled_by_name || '—')} · ${this.fmtDate(k.cancelled_at)}<br>${this.escapeAttr(k.cancel_reason || '')}</div>` : ''}
          ${posted ? `<div style="padding:8px 12px;border:1px solid #bbf7d0;background:#f0fdf4;border-radius:6px;font-size:13px;color:#166534;margin-bottom:10px"><strong>Posted</strong> ${this.fmtDateTime(k.posted_at)} by ${this.escapeAttr(k.posted_by_name || '—')} — receivable ${this.escapeAttr(k.ar_payment_number || '')}, payable ${this.escapeAttr(k.ap_payment_number || '')}. No cash or bank movement.
            <div style="margin-top:4px">RetailPOS Books: ${k.gl_status === 'posted' ? `posted as <strong>${this.escapeAttr(k.gl_ref || '')}</strong> (Dr Accounts Payable / Cr Accounts Receivable)` : k.gl_status === 'failed' ? `<span class="color-danger">failed — ${this.escapeAttr(k.gl_error || '')}</span>` : 'waiting for the next sync (Dr Accounts Payable / Cr Accounts Receivable)'}</div></div>` : ''}
          <div class="two-col" style="font-size:13px">
            <div><strong>Supplier:</strong> ${this.escapeAttr(k.supplier_name)}${k.supplier_number ? ` (${this.escapeAttr(k.supplier_number)})` : ''}<br><strong>Customer account:</strong> ${this.escapeAttr(k.customer_name)}${k.customer_number ? ` (${this.escapeAttr(k.customer_number)})` : ''}<br><strong>Contra date:</strong> ${this._apDate(k.contra_date)}</div>
            <div style="text-align:right"><div style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Amount Offset</div><div style="font-size:24px;font-weight:700">${this.fmt(k.amount)}</div></div>
          </div>
          ${table(`Our invoices to ${this.escapeAttr(k.customer_name)} (Receivable)`, k.ar_lines, false)}
          ${table(`${this.escapeAttr(k.supplier_name)} bills to us (Payable)`, k.ap_lines, true)}
          ${k.notes ? `<div style="font-size:13px;margin-top:10px"><strong>Notes:</strong> ${this.escapeAttr(k.notes)}</div>` : ''}
          <div style="font-weight:600;font-size:13px;margin:14px 0 4px">Audit Trail</div>
          <div style="font-size:12px">${k.audit.map(a => { let d = {}; try { d = JSON.parse(a.details || '{}'); } catch (e) {}
            return `<div style="display:flex;justify-content:space-between;gap:10px;border-top:1px solid var(--border);padding:4px 0"><span><strong>${actionLabel[a.action] || a.action}</strong>${d.reason ? ` — ${this.escapeAttr(d.reason)}` : ''}${d.error ? ` — ${this.escapeAttr(d.error)}` : ''}${d.journal ? ` — ${this.escapeAttr(d.journal)}` : ''}</span><span style="color:var(--text-muted);white-space:nowrap">${this.escapeAttr(a.employee_name || d.by || '')} · ${this.fmtDateTime(a.created_at)}</span></div>`; }).join('')}
            ${k.approval_signature ? this._approvalSigImg(k.approval_signature) : ''}</div>
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-secondary" style="margin-right:auto" onclick="App._printServerDocument('/api/email/contra-preview/${k.id}', 'contra', 'contra statement')">🖨 Print Statement</button>
          ${actions.join('')}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async _contraAfter(id, message) {
    this.alert(message);
    this.closeModal();
    if (this.section === 'payables') this.renderPayables('contras');
    this.viewContra(id);
  },

  async _contraAction(id, action) {
    try {
      await this.api('POST', `/payables/contras/${id}/${action}`, {});
      this._contraAfter(id, { submit: 'Submitted for approval', recall: 'Back in draft', 'gl-retry': 'Queued again for RetailPOS Books' }[action] || 'Done');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _contraApprove(id) {
    const k = await this.api('GET', `/payables/contras/${id}`).catch(() => null);
    this._showApprovalDialog({
      title: `Approve Contra${k ? ` ${k.contra_number}` : ''}`,
      intro: 'Once approved it can be posted, which updates both receivables and payables. Your signature is printed on the contra statement.',
      context: k ? `<div style="font-size:13px;margin-bottom:12px;padding:10px 12px;background:var(--bg-secondary,#f9fafb);border-radius:6px">
        <strong>${this.escapeAttr(k.supplier_name)}</strong> — offset <strong>${this.fmt(k.amount)}</strong><br>
        ${k.ar_lines.length} invoice${k.ar_lines.length === 1 ? '' : 's'} to them against ${k.ap_lines.length} bill${k.ap_lines.length === 1 ? '' : 's'} from them · raised by ${this.escapeAttr(k.created_by_name || '—')}
        ${k.notes ? `<div style="margin-top:4px;color:var(--text-muted)">${this.escapeAttr(k.notes)}</div>` : ''}</div>` : '',
      approve: async (signature) => {
        await this.api('POST', `/payables/contras/${id}/approve`, { signature });
        this._contraAfter(id, 'Contra approved');
      },
    });
  },

  async _contraReject(id) {
    const reason = prompt('Reject this contra? Tell the person who raised it why:');
    if (reason === null) return;
    if (!reason.trim()) return this.alert('A reason is required', 'error');
    try { await this.api('POST', `/payables/contras/${id}/reject`, { reason: reason.trim() }); this._contraAfter(id, 'Contra rejected'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _contraCancel(id) {
    const reason = prompt('Cancel this contra? Enter a reason:');
    if (reason === null) return;
    if (!reason.trim()) return this.alert('A reason is required', 'error');
    try { await this.api('POST', `/payables/contras/${id}/cancel`, { reason: reason.trim() }); this._contraAfter(id, 'Contra cancelled'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _contraPost(id) {
    if (!confirm('Post this contra? The invoices and bills are reduced by the amounts offset — receivables and payables are updated, with no cash or bank movement. This can\'t be undone.')) return;
    try { await this.api('POST', `/payables/contras/${id}/post`, {}); this._contraAfter(id, 'Contra posted — receivables and payables updated'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _renderApBills() {
    const el = document.getElementById('ap-tab-body');
    const f = this._apBillFilter || (this._apBillFilter = { status: 'unpaid', supplier_id: '', search: '' });
    if (!this._apSuppliers) this._apSuppliers = await this.api('GET', '/suppliers').catch(() => []);
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <select id="ap-f-status" style="width:auto">
          ${[['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['void', 'Void'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="ap-f-vendor" data-searchable style="width:auto;min-width:200px">
          <option value="">All vendors</option>
          ${this._apSuppliers.map(s => `<option value="${s.id}" ${String(f.supplier_id) === String(s.id) ? 'selected' : ''}>${this.escapeAttr(s.name)}</option>`).join('')}
        </select>
        <input id="ap-f-search" placeholder="Bill #, vendor invoice #, PO #..." value="${this.escapeAttr(f.search)}" style="flex:1;min-width:200px">
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Bill #</th><th>Vendor</th><th>Vendor Inv #</th><th>PO</th><th>Bill Date</th><th>Due</th><th style="text-align:right">Amount</th><th style="text-align:right">Balance</th><th>Status</th><th></th></tr></thead>
        <tbody id="ap-bills-tbody"><tr><td colspan="10" class="empty-state">Loading...</td></tr></tbody>
      </table></div></div>`;
    const load = async () => {
      const qs = new URLSearchParams({ status: f.status, as_of: this._apToday() });
      if (f.supplier_id) qs.set('supplier_id', f.supplier_id);
      if (f.search) qs.set('search', f.search);
      const bills = await this.api('GET', `/payables/bills?${qs}`);
      const tbody = document.getElementById('ap-bills-tbody');
      if (!tbody) return;
      tbody.innerHTML = bills.length ? bills.map(b => `
        <tr style="cursor:pointer" onclick="App.viewBill(${b.id})">
          <td class="fw-600">${b.bill_number}</td>
          <td>${this.escapeAttr(b.supplier_name)}</td>
          <td>${b.vendor_invoice_number ? this.escapeAttr(b.vendor_invoice_number) : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td>${b.po_number || '—'}</td>
          <td>${this._apDate(b.bill_date)}</td>
          <td>${this._apDate(b.due_date)}</td>
          <td style="text-align:right">${this.fmt(b.amount)}</td>
          <td style="text-align:right" class="fw-600">${this.fmt(b.balance)}</td>
          <td><span class="badge-pill ${this._apStatusBadge[b.display_status] || ''}">${b.display_status}</span></td>
          <td onclick="event.stopPropagation()">${b.balance > 0 && this.can('payables_requests') ? `<button class="btn btn-sm btn-primary" onclick="App.showPaymentRequestForm(null, { supplier_id: ${b.supplier_id}, bill_id: ${b.id} })">Request Payment</button>` : ''}</td>
        </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No bills found</td></tr>';
    };
    document.getElementById('ap-f-status').addEventListener('change', e => { f.status = e.target.value; load(); });
    document.getElementById('ap-f-vendor').addEventListener('change', e => { f.supplier_id = e.target.value; load(); });
    let timer;
    document.getElementById('ap-f-search').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { f.search = e.target.value.trim(); load(); }, 300); });
    await load();
  },

  async _renderApPayments() {
    const el = document.getElementById('ap-tab-body');
    const payments = await this.api('GET', '/payables/payments');
    if (!el.isConnected) return;
    const methodLabel = { ...Object.fromEntries(this._apMethods), ...this._apMethodNames };
    el.innerHTML = `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Payment #</th><th>Date</th><th>Vendor</th><th>Method</th><th>Reference</th><th>Request</th><th>Applied To</th><th style="text-align:right">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${payments.length ? payments.map(p => `
        <tr style="${p.status === 'void' ? 'opacity:.6' : ''}">
          <td class="fw-600"><a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewApPayment(${p.id})">${p.payment_number}</a></td>
          <td>${this._apDate(p.payment_date)}</td>
          <td>${this.escapeAttr(p.supplier_name)}${p.bank_account_name ? `<div style="font-size:11px;color:var(--text-muted)">from ${this.escapeAttr(p.bank_account_name)}</div>` : ''}</td>
          <td>${methodLabel[p.method] || p.method}</td>
          <td>${this.escapeAttr(p.reference || '—')}</td>
          <td>${p.payment_request_id ? `<a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewPaymentRequest(${p.payment_request_id})">${p.request_number}</a>` : '—'}</td>
          <td style="font-size:12px">${p.po_number ? `Advance on ${p.po_number}${p.bill_numbers ? ` → ${p.bill_numbers}` : ''}` : (p.bill_numbers || '—')}${p.status !== 'void' && p.method !== 'contra' && p.unapplied > 0.004 ? `<div style="color:var(--warning, #d97706)">${this.fmt(p.unapplied)} available to apply</div>` : ''}</td>
          <td style="text-align:right" class="fw-600">${this.fmt(p.amount)}</td>
          <td><span class="badge-pill ${p.status === 'void' ? 'badge-secondary' : 'badge-success'}" ${p.void_reason ? `title="${this.escapeAttr(p.void_reason)}"` : ''}>${p.status}</span></td>
          <td>${p.status !== 'void' && this.can('payables_void') ? `<button class="btn btn-sm btn-outline" onclick="App.voidApPayment(${p.id}, '${p.payment_number}')">Void</button>` : ''}</td>
        </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No payments recorded yet</td></tr>'}
      </tbody></table></div></div>`;
  },

  _renderApAging(aging) {
    const el = document.getElementById('ap-tab-body');
    const cell = (v, danger) => `<td style="text-align:right;${v > 0 && danger ? 'color:var(--danger)' : ''}">${v ? this.fmt(v) : '—'}</td>`;
    const row = (v, isTotal) => `
      <tr ${isTotal ? 'style="font-weight:700;border-top:2px solid var(--border)"' : `style="cursor:pointer" onclick="App.showVendorStatement(${v.supplier_id})"`}>
        <td>${isTotal ? 'Total' : `<span class="fw-600">${this.escapeAttr(v.supplier_name)}</span> <span style="color:var(--text-muted);font-size:12px">${v.supplier_number || ''}</span>`}</td>
        ${cell(v.current)}${cell(v.d1_30, true)}${cell(v.d31_60, true)}${cell(v.d61_90, true)}${cell(v.d90_plus, true)}
        <td style="text-align:right" class="fw-600">${this.fmt(v.total)}</td>
      </tr>`;
    el.innerHTML = `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Vendor</th><th style="text-align:right">Current</th><th style="text-align:right">1–30 Days</th><th style="text-align:right">31–60 Days</th><th style="text-align:right">61–90 Days</th><th style="text-align:right">90+ Days</th><th style="text-align:right">Total Owed</th></tr></thead>
      <tbody>${aging.vendors.length ? aging.vendors.map(v => row(v)).join('') + row(aging.totals, true) : '<tr><td colspan="7" class="empty-state">Nothing owed to any vendor</td></tr>'}</tbody>
    </table></div>
    <p style="font-size:12px;color:var(--text-muted);margin:10px 0 0">Days are counted past each bill's due date, as of today. Click a vendor for their statement.</p></div>`;
  },

  // Enter or edit a bill. `opts.po_id` preselects a PO (from the PO view),
  // prefilling its vendor and whatever has been received but not yet billed.
  async showBillForm(id, opts = {}) {
    const [bill, suppliers] = await Promise.all([
      id ? this.api('GET', `/payables/bills/${id}`) : Promise.resolve(null),
      this.api('GET', '/suppliers'),
    ]);
    const b = bill || { bill_date: this._apToday(), supplier_id: opts.supplier_id || '', po_id: opts.po_id || '' };
    if (opts.po_id && !id) {
      const po = await this.api('GET', `/purchase-orders/${opts.po_id}`);
      const billing = await this.api('GET', `/payables/po/${opts.po_id}`);
      b.supplier_id = po.supplier_id;
      b.branch_id = po.branch_id;
      b.amount = billing.unbilled || '';
      b.tax_amount = billing.unbilled_tax || '';
      b.description = `Goods received on ${po.po_number}`;
    }
    this._apBillSuppliers = suppliers;
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">${id ? `Edit Bill ${bill.bill_number}` : 'Enter Bill'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Vendor *</label>
            <select id="bf-ap-vendor" data-searchable ${bill && bill.paid > 0 ? 'disabled' : ''} onchange="App._apBillVendorChanged()">
              <option value="">— Select vendor —</option>
              ${suppliers.map(s => `<option value="${s.id}" ${String(b.supplier_id) === String(s.id) ? 'selected' : ''}>${this.escapeAttr(s.name)} (${s.supplier_number})</option>`).join('')}
            </select>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Vendor Invoice #</label><input id="bf-ap-invoice" value="${this.escapeAttr(b.vendor_invoice_number)}" placeholder="From the vendor's invoice"></div>
            <div class="form-group"><label>Purchase Order</label><select id="bf-ap-po" onchange="App._apBillPOChanged()"><option value="">— None —</option></select></div>
          </div>
          <div class="input-row-3">
            <div class="form-group"><label>Bill Date *</label><input id="bf-ap-date" type="date" value="${b.bill_date || ''}" onchange="App._apBillSetDue()"></div>
            <div class="form-group"><label>Due Date</label><input id="bf-ap-due" type="date" value="${b.due_date || ''}"><div id="bf-ap-terms" style="font-size:11px;color:var(--text-muted);margin-top:3px"></div></div>
            <div class="form-group"><label id="bf-ap-amount-label">Amount${b.currency ? ` (${this._baseCurrency()})` : ''} *</label><input id="bf-ap-amount" type="number" step="0.01" min="0" value="${b.amount ?? ''}" ${b.currency ? 'readonly' : ''}></div>
          </div>
          <div class="input-row-3" style="align-items:flex-end">
            <div class="form-group"><label>Invoice Currency</label><select id="bf-ap-currency" onchange="App._apBillCurrencyChanged()">
              ${this._poCurrencyCodes(b.currency).map(c => `<option value="${c}" ${c === (b.currency || this._baseCurrency()) ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
            <div class="form-group bf-ap-fx" style="display:${b.currency ? '' : 'none'}"><label>Amount in <span id="bf-ap-fx-code">${this.escapeAttr(b.currency || '')}</span> *</label><input id="bf-ap-amount-fx" type="number" step="0.01" min="0" value="${b.amount_fx ?? ''}" oninput="App._apBillFxRecalc()"></div>
            <div class="form-group bf-ap-fx" style="display:${b.currency ? '' : 'none'}"><label>Rate (${this._baseCurrency()} per unit) *</label><input id="bf-ap-rate" type="number" step="0.0001" min="0" value="${b.exchange_rate ?? ''}" oninput="App._apBillFxRecalc()"></div>
          </div>
          <div class="form-group"><label>GCT Included</label><input id="bf-ap-tax" type="number" step="0.01" min="0" value="${b.tax_amount || ''}" placeholder="0.00" style="max-width:180px"><div style="font-size:11px;color:var(--text-muted);margin-top:3px">The GCT on the vendor's invoice, already in the amount — it's claimed as input tax.</div></div>
          <div class="form-group"><label>Description</label><input id="bf-ap-desc" value="${this.escapeAttr(b.description)}" placeholder="e.g. Electricity for September"></div>
          ${bill && bill.paid > 0 ? `<p style="font-size:12px;color:var(--text-muted)">${this.fmt(bill.paid)} has already been paid on this bill, so the vendor can't be changed and the amount can't go below that.</p>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveBill(${id || 'null'})">Save Bill</button>
        </div>
      </div>`);
    this._apBillBranchId = b.branch_id || null;
    this._apBillLinkedPo = b.po_id ? { id: b.po_id, po_number: b.po_number || 'Linked PO' } : null;
    await this._apBillVendorChanged({ keepDue: !!b.due_date, poId: b.po_id });
  },

  // Loads the chosen vendor's POs into the PO picker and shows their terms.
  async _apBillVendorChanged({ keepDue = false, poId } = {}) {
    const vendorId = document.getElementById('bf-ap-vendor').value;
    const poSel = document.getElementById('bf-ap-po');
    const supplier = (this._apBillSuppliers || []).find(s => String(s.id) === vendorId);
    document.getElementById('bf-ap-terms').textContent = supplier ? `Terms: ${supplier.payment_terms || 'Net 30'}` : '';
    poSel.innerHTML = '<option value="">— None —</option>';
    if (vendorId) {
      const pos = await this.api('GET', `/purchase-orders?supplier_id=${vendorId}`).catch(() => []);
      poSel.innerHTML += pos.filter(p => String(p.supplier_id) === vendorId && p.status !== 'cancelled')
        .map(p => `<option value="${p.id}" ${String(poId) === String(p.id) ? 'selected' : ''}>${p.po_number} · ${p.status} · ${this.fmt(p.total)}</option>`).join('');
      // The PO list needs the Purchasing permission; keep an existing link
      // selectable anyway so saving the bill doesn't silently drop it.
      const linked = this._apBillLinkedPo;
      if (linked && poId && String(linked.id) === String(poId) && !poSel.querySelector(`option[value="${linked.id}"]`)) {
        poSel.innerHTML += `<option value="${linked.id}" selected>${linked.po_number}</option>`;
      }
    }
    if (!keepDue) this._apBillSetDue();
  },

  // Picking a PO fills the amount with what's been received on it but not billed yet.
  async _apBillPOChanged() {
    const poId = document.getElementById('bf-ap-po').value;
    if (!poId) return;
    const billing = await this.api('GET', `/payables/po/${poId}`).catch(() => null);
    const amt = document.getElementById('bf-ap-amount');
    if (billing && !amt.value) {
      amt.value = billing.unbilled || '';
      document.getElementById('bf-ap-tax').value = billing.unbilled_tax || '';
    }
    if (billing && billing.unbilled === 0) this.alert('Everything received on this PO has already been billed', 'warning');
  },

  // Due date = bill date + the vendor's terms days (same rule as the server).
  _apBillSetDue() {
    const vendorId = document.getElementById('bf-ap-vendor').value;
    const billDate = document.getElementById('bf-ap-date').value;
    const supplier = (this._apBillSuppliers || []).find(s => String(s.id) === vendorId);
    if (!billDate || !supplier) return;
    const m = String(supplier.payment_terms || 'Net 30').match(/\d+/);
    const d = new Date(`${billDate}T00:00:00`);
    d.setDate(d.getDate() + (m ? parseInt(m[0], 10) : 0));
    document.getElementById('bf-ap-due').value = d.toLocaleDateString('en-CA');
  },

  // A bill in a foreign currency: the vendor's amount and our rate give the base amount.
  _apBillCurrencyChanged() {
    const code = document.getElementById('bf-ap-currency').value;
    const foreign = code !== this._baseCurrency();
    document.querySelectorAll('.bf-ap-fx').forEach(el => { el.style.display = foreign ? '' : 'none'; });
    document.getElementById('bf-ap-fx-code').textContent = code;
    document.getElementById('bf-ap-amount').readOnly = foreign;
    document.getElementById('bf-ap-amount-label').textContent = foreign ? `Amount (${this._baseCurrency()}) *` : 'Amount *';
    if (foreign && !document.getElementById('bf-ap-rate').value) document.getElementById('bf-ap-rate').value = this._settingsRate(code) || '';
    this._apBillFxRecalc();
  },
  _apBillFxRecalc() {
    if (document.getElementById('bf-ap-currency').value === this._baseCurrency()) return;
    const fx = parseFloat(document.getElementById('bf-ap-amount-fx').value) || 0, rate = parseFloat(document.getElementById('bf-ap-rate').value) || 0;
    document.getElementById('bf-ap-amount').value = fx && rate ? (Math.round(fx * rate * 100) / 100).toFixed(2) : '';
  },

  async saveBill(id) {
    const data = {
      supplier_id: document.getElementById('bf-ap-vendor').value,
      vendor_invoice_number: document.getElementById('bf-ap-invoice').value.trim(),
      po_id: document.getElementById('bf-ap-po').value || null,
      bill_date: document.getElementById('bf-ap-date').value,
      due_date: document.getElementById('bf-ap-due').value || null,
      amount: parseFloat(document.getElementById('bf-ap-amount').value),
      tax_amount: parseFloat(document.getElementById('bf-ap-tax').value) || 0,
      description: document.getElementById('bf-ap-desc').value.trim(),
      branch_id: this._apBillBranchId,
      currency: document.getElementById('bf-ap-currency').value,
      exchange_rate: parseFloat(document.getElementById('bf-ap-rate').value) || null,
      amount_fx: parseFloat(document.getElementById('bf-ap-amount-fx').value) || null,
    };
    if (data.currency !== this._baseCurrency() && !(data.amount_fx > 0 && data.exchange_rate > 0)) return this.alert(`Enter the ${data.currency} amount and the exchange rate`, 'error');
    if (!data.supplier_id) return this.alert('Choose a vendor', 'error');
    if (!(data.amount > 0)) return this.alert('Enter the bill amount', 'error');
    if (data.tax_amount < 0 || data.tax_amount > data.amount) return this.alert('GCT must be between zero and the bill amount', 'error');
    try {
      const saved = id ? await this.api('PUT', `/payables/bills/${id}`, data) : await this.api('POST', '/payables/bills', data);
      this.alert(id ? 'Bill updated' : `Bill ${saved.bill_number} entered`);
      this.closeModal();
      this._afterApChange();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // Refreshes whichever screen the A/P action was taken from.
  _afterApChange() {
    this._pollPayablesInbox();
    if (this.section === 'payables') this.renderPayables();
    else if (this.section === 'suppliers') this.renderSuppliers();
    if (this._viewingPOId && this.section === 'purchasing') this.viewPO(this._viewingPOId);
  },

  async viewBill(id) {
    const b = await this.api('GET', `/payables/bills/${id}`);
    const methodLabel = { ...Object.fromEntries(this._apMethods), ...this._apMethodNames };
    const sourceLabel = { receipt: 'Created automatically when the PO was received', direct_receipt: 'Created automatically when goods were received without a PO', po: 'Entered from a purchase order', manual: 'Entered manually' };
    this.showModal(`
      <div class="modal" style="max-width:620px">
        <div class="modal-header">
          <span class="modal-title">Bill ${b.bill_number}</span>
          <div style="display:flex;gap:8px;align-items:center"><span class="badge-pill ${this._apStatusBadge[b.display_status] || ''}">${b.display_status}</span><button class="modal-close">✕</button></div>
        </div>
        <div class="modal-body">
          <div class="two-col" style="font-size:13px;margin-bottom:14px">
            <div>
              <strong>Vendor:</strong> ${this.escapeAttr(b.supplier_name)} (${b.supplier_number})<br>
              <strong>Vendor Invoice #:</strong> ${b.vendor_invoice_number ? this.escapeAttr(b.vendor_invoice_number) : '<span style="color:var(--text-muted)">not entered</span>'}<br>
              <strong>PO:</strong> ${b.po_id ? (this.can('purchasing') ? `<a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.closeModal();App.showSection('purchasing').then(()=>App.viewPO(${b.po_id}))">${b.po_number}</a>` : b.po_number) : '—'}<br>
              ${b.branch_name ? `<strong>Branch:</strong> ${this.escapeAttr(b.branch_name)}<br>` : ''}
            </div>
            <div>
              <strong>Bill Date:</strong> ${this._apDate(b.bill_date)}<br>
              <strong>Due:</strong> ${this._apDate(b.due_date)}<br>
              <strong>Entered:</strong> ${b.created_by_name || 'System'}<br>
              <span style="font-size:12px;color:var(--text-muted)">${sourceLabel[b.source] || ''}</span>
            </div>
          </div>
          ${b.description ? `<p style="font-size:13px;margin-bottom:14px">${this.escapeAttr(b.description)}</p>` : ''}
          ${b.status === 'void' ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:13px;color:#991b1b"><strong>Void:</strong> ${this.escapeAttr(b.void_reason)}</div>` : ''}
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700">${this.fmt(b.amount)}</div>${b.currency ? `<div style="font-size:12px;font-weight:600">${b.currency} ${this._n2(b.amount_fx)} @ ${b.exchange_rate}</div>` : ''}<div style="font-size:11px;color:var(--text-muted)">Amount${b.tax_amount > 0 ? ` (incl. GCT ${this.fmt(b.tax_amount)})` : ''}</div></div>
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700">${this.fmt(b.paid)}</div><div style="font-size:11px;color:var(--text-muted)">Paid</div></div>
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;${b.balance > 0 ? 'color:var(--danger)' : ''}">${this.fmt(b.balance)}</div>${b.currency && b.balance_fx != null ? `<div style="font-size:12px;font-weight:600">${b.currency} ${this._n2(b.balance_fx)}</div>` : ''}<div style="font-size:11px;color:var(--text-muted)">Balance</div></div>
          </div>
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">Payments</div>
          ${b.payments.length ? `<table style="width:100%;font-size:13px"><tbody>${b.payments.map(p => `
            <tr style="border-top:1px solid var(--border);${p.status === 'void' ? 'opacity:.55;text-decoration:line-through' : ''}">
              <td style="padding:6px 0">${p.payment_number}</td><td>${this._apDate(p.payment_date)}</td><td>${methodLabel[p.method] || p.method}${p.reference ? ` · ${this.escapeAttr(p.reference)}` : ''}</td>
              <td style="text-align:right">${this.fmt(p.applied)}${p.currency && p.applied_fx != null ? `<div style="font-size:11px;color:var(--text-muted)">paid ${p.currency} ${this._n2(p.applied_fx)} @ ${p.exchange_rate}</div>` : ''}</td>
            </tr>`).join('')}</tbody></table>` : '<p style="font-size:13px;color:var(--text-muted)">No payments yet.</p>'}
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          ${b.status !== 'void' && b.paid === 0 && this.can('payables_void') ? `<button class="btn btn-danger" onclick="App.voidBill(${b.id}, '${b.bill_number}')">Void Bill</button>` : ''}
          ${b.status !== 'void' && this.can('payables_bills') ? `<button class="btn btn-outline" onclick="App.showBillForm(${b.id})">Edit</button>` : ''}
          <button class="btn btn-secondary" onclick="App.showVendorStatement(${b.supplier_id})">Vendor Statement</button>
          ${b.balance > 0 && this.can('payables_requests') ? `<button class="btn btn-primary" onclick="App.showPaymentRequestForm(null, { supplier_id: ${b.supplier_id}, bill_id: ${b.id} })">Request Payment</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async voidBill(id, number) {
    const reason = prompt(`Void bill ${number}? Enter a reason:`);
    if (reason === null) return;
    if (!reason.trim()) return this.alert('A reason is required', 'error');
    try {
      await this.api('POST', `/payables/bills/${id}/void`, { reason: reason.trim() });
      this.alert(`Bill ${number} voided`);
      this.closeModal();
      this._afterApChange();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async voidApPayment(id, number) {
    const reason = prompt(`Void payment ${number}? The bills it paid will show as owing again (an advance stops counting toward its PO). Enter a reason:`);
    if (reason === null) return;
    if (!reason.trim()) return this.alert('A reason is required', 'error');
    try {
      await this.api('POST', `/payables/payments/${id}/void`, { reason: reason.trim() });
      this.alert(`Payment ${number} voided`);
      this._afterApChange();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ─── Payment requests ─────────────────────────────────────
  // The only way a vendor gets paid (routes/payment-requests.js): raised for
  // open bills, as a quick payment with no bill, or as an advance on a PO;
  // submitted, approved by someone else (payables_approve), then paid.
  _prqStatusBadge: { draft: 'badge-secondary', submitted: 'badge-warning', approved: 'badge-info', rejected: 'badge-danger', paid: 'badge-success', cancelled: 'badge-secondary' },
  _prqStatusLabel: { draft: 'Draft', submitted: 'Awaiting Approval', approved: 'Approved', rejected: 'Rejected', paid: 'Paid', cancelled: 'Cancelled' },
  _prqTypeLabel: { invoice: 'Invoice Payment', quick: 'Quick Payment', advance: 'Advance Payment' },

  async _renderApRequests() {
    const el = document.getElementById('ap-tab-body');
    // Approvers land on what's waiting for them; everyone else on what's still open.
    const f = this._prqFilter || (this._prqFilter = { status: this.can('payables_approve') && !this.can('payables_requests') ? 'submitted' : 'open', supplier_id: '', q: '' });
    if (!this._apSuppliers) this._apSuppliers = await this.api('GET', '/suppliers').catch(() => []);
    if (!el.isConnected) return;
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <select id="prq-f-status" style="width:auto">
          ${[['open', 'Open (not paid)'], ['submitted', 'Awaiting Approval'], ['approved', 'Approved — to pay'], ['draft', 'Draft'], ['rejected', 'Rejected'], ['paid', 'Paid'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="prq-f-vendor" data-searchable style="width:auto;min-width:200px">
          <option value="">All vendors</option>
          ${this._apSuppliers.map(s => `<option value="${s.id}" ${String(f.supplier_id) === String(s.id) ? 'selected' : ''}>${this.escapeAttr(s.name)}</option>`).join('')}
        </select>
        <input id="prq-f-search" placeholder="Request #, vendor, bill #, PO #, description..." value="${this.escapeAttr(f.q)}" style="flex:1;min-width:200px">
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Request #</th><th>Date</th><th>Vendor</th><th>Type</th><th>For</th><th style="text-align:right">Amount</th><th title="Payment date the requester asked for">Requested Pay Date</th><th title="Payment date set by the approver">Scheduled Pay Date</th><th>Requested By</th><th>Status</th></tr></thead>
        <tbody id="prq-tbody"><tr><td colspan="10" class="empty-state">Loading...</td></tr></tbody>
      </table></div></div>`;
    const load = async () => {
      const qs = new URLSearchParams({ status: f.status });
      if (f.supplier_id) qs.set('supplier_id', f.supplier_id);
      if (f.q) qs.set('q', f.q);
      const rows = await this.api('GET', `/payables/payment-requests?${qs}`);
      const tbody = document.getElementById('prq-tbody');
      if (!tbody) return;
      tbody.innerHTML = rows.length ? rows.map(r => `
        <tr style="cursor:pointer;${r.status === 'cancelled' ? 'opacity:.6' : ''}" onclick="App.viewPaymentRequest(${r.id})">
          <td class="fw-600">${r.request_number}</td>
          <td>${this.fmtDate(r.created_at)}</td>
          <td>${this.escapeAttr(r.supplier_name)}</td>
          <td>${this._prqTypeLabel[r.request_type] || r.request_type}</td>
          <td style="font-size:12px;max-width:260px">${r.request_type === 'advance' ? `PO ${this.escapeAttr(r.po_number || '')}` : this.escapeAttr(r.summary || '—')}${r.attachment_count ? ` <span title="Supporting documents" style="color:var(--text-muted)">📎${r.attachment_count}</span>` : ''}</td>
          <td style="text-align:right" class="fw-600">${r.currency ? `${r.currency} ${this._n2(r.amount_fx)}<div style="font-size:11px;font-weight:400;color:var(--text-muted)">≈ ${this.fmt(r.amount)}</div>` : this.fmt(r.amount)}</td>
          <td style="white-space:nowrap">${['paid', 'cancelled'].includes(r.status) || r.scheduled_date ? (r.required_date ? this._apDate(r.required_date) : '—') : this._prqPayByHtml(r.required_date, { short: true })}</td>
          <td style="white-space:nowrap">${!r.scheduled_date ? '<span style="color:var(--text-muted)">—</span>' : ['paid', 'cancelled'].includes(r.status) ? this._apDate(r.scheduled_date) : this._prqPayByHtml(r.scheduled_date, { short: true })}</td>
          <td>${this.escapeAttr(r.requested_by_name || '—')}</td>
          <td><span class="badge-pill ${this._prqStatusBadge[r.status] || ''}">${this._prqStatusLabel[r.status] || r.status}</span>${r.status === 'approved' && Number(r.paid_total) > 0.005 ? ' <span class="badge-pill badge-warning" style="font-size:10px">part paid</span>' : ''}</td>
        </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No payment requests found</td></tr>';
    };
    document.getElementById('prq-f-status').addEventListener('change', e => { f.status = e.target.value; load(); });
    document.getElementById('prq-f-vendor').addEventListener('change', e => { f.supplier_id = e.target.value; load(); });
    let timer;
    document.getElementById('prq-f-search').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); });
    await load();
  },

  // New or edit (draft/rejected) request. opts.supplier_id / opts.bill_id
  // preselect a vendor and one of their bills (from the Bills tab, a bill
  // or a vendor statement).
  async showPaymentRequestForm(id, opts = {}) {
    const [req, suppliers] = await Promise.all([
      id ? this.api('GET', `/payables/payment-requests/${id}`) : Promise.resolve(null),
      this.api('GET', '/suppliers'),
    ]);
    const r = req || { supplier_id: opts.supplier_id || '', request_type: opts.request_type || 'invoice', lines: opts.bill_id ? [{ bill_id: opts.bill_id }] : [] };
    this._prq = { id: id || null, request: r, files: [], currency: r.currency || null, rate: r.exchange_rate || null,
      quickLines: r.request_type === 'quick' ? r.lines.map(l => ({ description: l.description, amount: r.currency ? l.amount_fx : l.amount })) : [{ description: '', amount: '' }] };
    const typeCard = (k, title, sub) => `
      <label style="flex:1;min-width:150px;border:1px solid var(--border);border-radius:8px;padding:10px 12px;cursor:pointer;display:flex;gap:8px;align-items:flex-start;justify-content:flex-start;text-align:left;text-transform:none;letter-spacing:normal;margin:0">
        <input type="radio" name="prq-type" value="${k}" ${r.request_type === k ? 'checked' : ''} onchange="App._prqTypeChanged()" style="width:auto;flex:none;margin:3px 0 0">
        <span><strong style="font-size:13px;color:var(--text)">${title}</strong><br><span style="font-size:11px;color:var(--text-muted);font-weight:400">${sub}</span></span>
      </label>`;
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">${id ? `Edit Payment Request ${r.request_number}` : 'New Payment Request'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${r.status === 'rejected' ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:#991b1b"><strong>Rejected by ${this.escapeAttr(r.rejected_by_name || '—')}:</strong> ${this.escapeAttr(r.rejection_reason || '')}<br><span style="font-size:12px">Saving puts it back to draft so it can be submitted again.</span></div>` : ''}
          <div class="form-group"><label>Vendor *</label>
            <select id="prq-vendor" data-searchable onchange="App._prqVendorChanged()">
              <option value="">— Select vendor —</option>
              ${suppliers.map(s => `<option value="${s.id}" ${String(r.supplier_id) === String(s.id) ? 'selected' : ''}>${this.escapeAttr(s.name)} (${s.supplier_number})</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Payment Type *</label>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              ${typeCard('invoice', 'Invoice Payment', 'Pay one or more of the vendor\'s outstanding bills')}
              ${typeCard('quick', 'Quick Payment', 'No invoice — describe what it\'s for and attach support')}
              ${typeCard('advance', 'Advance Payment', 'Pay ahead against one of the vendor\'s purchase orders')}
            </div>
          </div>
          <div class="input-row" style="align-items:flex-end">
            <div class="form-group"><label>Pay In *</label>
              <select id="prq-currency" onchange="App._prqCurrencyChanged()">
                ${this._poCurrencyCodes(r.currency).map(c => `<option value="${c}" ${c === (r.currency || this._baseCurrency()) ? 'selected' : ''}>${c}${c === this._baseCurrency() ? ' (our currency)' : ''}</option>`).join('')}
              </select></div>
            <div class="form-group" id="prq-rate-wrap" style="display:${r.currency ? '' : 'none'}"><label id="prq-rate-label">Exchange Rate (${this._baseCurrency()} per ${this.escapeAttr(r.currency || '')})</label>
              <input id="prq-rate" type="number" step="0.0001" min="0" value="${r.exchange_rate || ''}" oninput="App._prq.rate = parseFloat(this.value) || null; App._prqTypeChanged()"></div>
          </div>
          <div id="prq-cur-hint" style="font-size:11px;color:var(--text-muted);margin:-6px 0 10px"></div>
          <div id="prq-body" style="margin-bottom:12px"></div>
          <div class="form-group" style="max-width:300px"><label>Requested Payment Date *</label><input id="prq-date" type="date" value="${r.required_date || ''}"><div style="font-size:11px;color:var(--text-muted);margin-top:3px">When the vendor needs to be paid (needed to submit). The approver sets the scheduled date.</div></div>
          <div class="form-group"><label>Purpose / Notes for the approver</label>
            <textarea id="prq-notes" rows="2" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;resize:vertical" placeholder="Why this payment is needed, any deadline...">${this.escapeAttr(r.notes || '')}</textarea>
          </div>
          <div class="form-group"><label>Supporting Documents</label>
            <div id="prq-existing-files" style="font-size:13px"></div>
            <input type="file" id="prq-files" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt">
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">Invoices, quotes, receipts — PDF, image, Word, Excel or text, up to 20 MB each. Uploaded when you save.</div>
          </div>
        </div>
        <div class="modal-footer">
          <span id="prq-total" style="margin-right:auto;font-size:15px"></span>
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-outline" onclick="App.savePaymentRequest(false)">Save Draft</button>
          <button class="btn btn-primary" onclick="App.savePaymentRequest(true)">Save &amp; Submit for Approval</button>
        </div>
      </div>`);
    if (id) {
      const atts = await this.api('GET', `/payables/payment-requests/${id}/attachments`).catch(() => []);
      const box = document.getElementById('prq-existing-files');
      if (box && atts.length) box.innerHTML = `<div style="margin-bottom:6px">${atts.map(a => `📎 ${this.escapeAttr(a.original_name)}`).join('<br>')}</div>`;
    }
    await this._prqVendorChanged();
  },

  _prqType() { return document.querySelector('input[name="prq-type"]:checked')?.value || 'invoice'; },
  // Paying in a foreign currency: amounts on the form are in that currency.
  // A bill or PO in the same currency converts at its own booked rate (paying
  // the USD owed clears it); anything else at the rate entered here.
  _prqCurrencyChanged() {
    this._prqKeepQuickLines();
    const code = document.getElementById('prq-currency').value;
    const foreign = code !== this._baseCurrency();
    this._prq.currency = foreign ? code : null;
    if (foreign) { this._prq.rate = this._settingsRate(code) || this._prq.rate; document.getElementById('prq-rate').value = this._prq.rate || ''; }
    document.getElementById('prq-rate-wrap').style.display = foreign ? '' : 'none';
    document.getElementById('prq-rate-label').textContent = `Exchange Rate (${this._baseCurrency()} per ${code})`;
    this._prq.request = { ...this._prq.request, lines: [] }; // amounts were in the other currency
    this._prqTypeChanged();
  },
  // A payment request's (or line's) amount in the currency it's paid in, with the base value.
  _prqAmountHtml(r, amount = r.amount, amountFx = r.amount_fx, { base = true } = {}) {
    if (!r.currency) return this.fmt(amount);
    return `${r.currency} ${this._n2(amountFx)}${base ? ` <span style="font-size:11px;color:var(--text-muted);font-weight:400">≈ ${this.fmt(amount)}</span>` : ''}`;
  },
  _prqFmt(v) { return this._prq.currency ? `${this._prq.currency} ${this._n2(v)}` : this.fmt(v); },
  // What can still be paid on a bill/PO, in the payment currency (null = no rate yet).
  _prqAvail(baseAvail, docCurrency, docRate) {
    if (!this._prq.currency) return Math.max(0, baseAvail);
    if (docCurrency === this._prq.currency && Number(docRate) > 0) return Math.round(Math.max(0, baseAvail) / Number(docRate) * 100) / 100;
    return this._prq.rate > 0 ? Math.round(Math.max(0, baseAvail) / this._prq.rate * 100) / 100 : null;
  },

  async _prqVendorChanged() {
    const vendorId = document.getElementById('prq-vendor').value;
    const body = document.getElementById('prq-body');
    this._prq.options = null;
    if (vendorId) {
      body.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Loading...</p>';
      try { this._prq.options = await this.api('GET', `/payables/payment-requests/options?supplier_id=${vendorId}${this._prq.id ? `&exclude=${this._prq.id}` : ''}`); }
      catch (e) { body.innerHTML = `<p style="color:var(--danger);font-size:13px">${this.escapeAttr(e.message)}</p>`; return; }
    }
    this._prqTypeChanged();
  },

  // Keeps typed quick-payment lines when switching type back and forth.
  _prqKeepQuickLines() {
    const rows = document.querySelectorAll('[data-prq-quick]');
    if (rows.length) this._prq.quickLines = [...rows].map(row => ({ description: row.querySelector('.prq-q-desc').value, amount: row.querySelector('.prq-q-amt').value }));
  },

  _prqTypeChanged() {
    this._prqKeepQuickLines();
    const type = this._prqType();
    const body = document.getElementById('prq-body');
    const opts = this._prq.options;
    const r = this._prq.request;
    if (!opts) { body.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Choose a vendor first.</p>'; this._prqSum(); return; }
    const sameAsSaved = String(r.supplier_id) === document.getElementById('prq-vendor').value;
    const cur = this._prq.currency;
    const hint = document.getElementById('prq-cur-hint');
    if (hint) {
      const foreignDocs = [...new Set([...(opts.bills || []).map(b => b.currency), ...(opts.pos || []).map(p => p.currency)].filter(Boolean))];
      hint.innerHTML = cur ? `Amounts below are in <strong>${cur}</strong>. A bill or PO in ${cur} is cleared at its own rate, so paying the ${cur} owed settles it; the bank pays at the rate above.`
        : foreignDocs.length ? `This vendor has bills/POs in ${foreignDocs.join(', ')} — choose <strong>Pay In ${foreignDocs[0]}</strong> to pay the ${foreignDocs[0]} amount.` : '';
    }
    if (type === 'invoice') {
      const sameCur = (r.currency || null) === cur;
      const chosen = new Map((sameAsSaved && r.request_type === 'invoice' || !r.id ? r.lines : []).map(l => [Number(l.bill_id), sameCur ? (cur ? l.amount_fx : l.amount) : undefined]));
      body.innerHTML = opts.bills.length ? `
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">Outstanding invoices</div>
        <table style="width:100%;font-size:13px">
          <thead><tr style="color:var(--text-muted);font-size:12px"><th style="width:28px"></th><th style="text-align:left">Bill #</th><th style="text-align:left">Vendor Inv #</th><th style="text-align:left">Due</th><th style="text-align:right">Balance</th><th style="text-align:right;width:140px">Request</th></tr></thead>
          <tbody>${opts.bills.map(b => {
            const pre = chosen.has(Number(b.id));
            const avail = this._prqAvail(b.available, b.currency, b.exchange_rate);
            const amt = pre ? (chosen.get(Number(b.id)) ?? avail ?? '') : '';
            return `<tr style="border-top:1px solid var(--border)">
              <td><input type="checkbox" data-prq-bill-check="${b.id}" ${pre ? 'checked' : ''} ${b.available <= 0 && !pre ? 'disabled' : ''} onchange="App._prqBillToggle(${b.id})"></td>
              <td style="padding:6px 0">${b.bill_number}${b.po_number ? `<div style="font-size:11px;color:var(--text-muted)">${b.po_number}</div>` : ''}</td>
              <td>${this.escapeAttr(b.vendor_invoice_number || '—')}</td>
              <td style="${b.due_date < this._apToday() ? 'color:var(--danger)' : ''}">${this._apDate(b.due_date)}</td>
              <td style="text-align:right">${this.fmt(b.balance)}${b.currency && Number(b.exchange_rate) > 0 ? `<div style="font-size:11px;color:var(--text-muted)">${b.currency} ${this._n2(b.balance / b.exchange_rate)} @ ${b.exchange_rate}</div>` : ''}${b.requested > 0 ? `<div style="font-size:11px;color:var(--text-muted)">${this.fmt(b.requested)} on other requests</div>` : ''}${cur && avail != null ? `<div style="font-size:11px;font-weight:600">${cur} ${this._n2(avail)} payable</div>` : ''}</td>
              <td style="text-align:right"><input type="number" step="0.01" min="0" ${avail != null ? `max="${avail}"` : ''} data-prq-bill="${b.id}" value="${amt === '' ? '' : Number(amt).toFixed(2)}" ${pre ? '' : 'disabled'} style="width:120px;text-align:right" oninput="App._prqSum()"></td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : '<p style="font-size:13px;color:var(--text-muted)">This vendor has no outstanding invoices. Use a Quick Payment, or enter the bill first.</p>';
    } else if (type === 'quick') {
      body.innerHTML = `
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">What's being paid</div>
        <div id="prq-quick-lines"></div>
        <button type="button" class="btn btn-sm btn-outline" style="margin-top:6px" onclick="App._prqAddQuickLine()">+ Add line</button>`;
      this._prqRenderQuickLines();
    } else {
      const usable = opts.pos.filter(p => !p.missing_rate);
      const poId = sameAsSaved && r.request_type === 'advance' ? r.po_id : '';
      const line = sameAsSaved && r.request_type === 'advance' ? r.lines[0] || {} : {};
      body.innerHTML = opts.pos.length ? `
        <div class="input-row">
          <div class="form-group"><label>Purchase Order *</label>
            <select id="prq-po" onchange="App._prqPoChanged()">
              <option value="">— Select PO —</option>
              ${usable.map(p => `<option value="${p.id}" ${String(poId) === String(p.id) ? 'selected' : ''}>${p.po_number} · ${p.status} · ${p.currency && p.available_fx != null ? `${p.currency} ${this._n2(p.available_fx)} (${this.fmt(p.available)})` : this.fmt(p.available)} left</option>`).join('')}
            </select>
            <div id="prq-po-info" style="font-size:11px;color:var(--text-muted);margin-top:3px"></div>
          </div>
          <div class="form-group"><label>Advance Amount (${cur || this._baseCurrency()}) *</label><input id="prq-adv-amount" type="number" step="0.01" min="0" value="${(r.currency || null) === cur ? ((cur ? line.amount_fx : line.amount) ?? '') : ''}" oninput="App._prqSum()"></div>
        </div>
        <div class="form-group"><label>Description</label><input id="prq-adv-desc" value="${this.escapeAttr(line.description || '')}" placeholder="e.g. 50% deposit to start production"></div>
        ${opts.pos.length > usable.length ? `<p style="font-size:11px;color:var(--text-muted)">${opts.pos.length - usable.length} foreign-currency PO(s) are hidden until they have an exchange rate.</p>` : ''}` :
        '<p style="font-size:13px;color:var(--text-muted)">This vendor has no purchase orders an advance can go against (drafts and cancelled POs don\'t count).</p>';
      if (opts.pos.length) this._prqPoChanged();
    }
    this._prqSum();
  },

  _prqBillToggle(billId) {
    const check = document.querySelector(`[data-prq-bill-check="${billId}"]`);
    const input = document.querySelector(`[data-prq-bill="${billId}"]`);
    const bill = this._prq.options.bills.find(b => b.id === billId);
    const avail = this._prqAvail(bill.available, bill.currency, bill.exchange_rate);
    if (check.checked && avail == null) { check.checked = false; return this.alert(`Enter the ${this._prq.currency} exchange rate first`, 'error'); }
    input.disabled = !check.checked;
    input.value = check.checked ? avail.toFixed(2) : '';
    this._prqSum();
  },

  _prqRenderQuickLines() {
    const box = document.getElementById('prq-quick-lines');
    if (!box) return;
    if (!this._prq.quickLines.length) this._prq.quickLines.push({ description: '', amount: '' });
    box.innerHTML = this._prq.quickLines.map((l, i) => `
      <div data-prq-quick style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
        <input class="prq-q-desc" placeholder="Description (e.g. Generator repair callout)" value="${this.escapeAttr(l.description || '')}" style="flex:1">
        <input class="prq-q-amt" type="number" step="0.01" min="0" placeholder="Amount${this._prq.currency ? ` (${this._prq.currency})` : ''}" value="${l.amount ?? ''}" style="width:130px;text-align:right" oninput="App._prqSum()">
        <button type="button" class="btn btn-sm btn-outline" title="Remove line" onclick="App._prqRemoveQuickLine(${i})">✕</button>
      </div>`).join('');
    this._prqSum();
  },
  _prqAddQuickLine() { this._prqKeepQuickLines(); this._prq.quickLines.push({ description: '', amount: '' }); this._prqRenderQuickLines(); },
  _prqRemoveQuickLine(i) { this._prqKeepQuickLines(); this._prq.quickLines.splice(i, 1); this._prqRenderQuickLines(); },

  _prqPoChanged() {
    const id = document.getElementById('prq-po')?.value;
    const info = document.getElementById('prq-po-info');
    const po = (this._prq.options?.pos || []).find(p => String(p.id) === id);
    if (!info) return;
    info.innerHTML = po ? `PO total ${this.fmt(po.total_base)}${po.currency ? ` (${po.currency} ${this._n2(po.total)})` : ''} · paid so far ${this.fmt(po.paid)}${po.requested > 0 ? ` · ${this.fmt(po.requested)} on other requests` : ''} · <strong>${this.fmt(po.available)} left</strong>${po.currency && po.available_fx != null ? ` (<strong>${po.currency} ${this._n2(po.available_fx)}</strong>)` : ''}${po.currency && po.currency !== this._prq.currency ? ` — choose <strong>Pay In ${po.currency}</strong> to pay the ${po.currency} amount` : ''}` : '';
  },

  // The lines as the server wants them, read from whichever panel is showing.
  _prqLines() {
    const type = this._prqType();
    // In a foreign currency each amount is sent as amount_fx too (the server
    // works out the base value).
    const fx = !!this._prq.currency;
    const tag = l => (fx ? { ...l, amount_fx: l.amount } : l);
    if (type === 'invoice') {
      return [...document.querySelectorAll('[data-prq-bill]')].filter(i => !i.disabled)
        .map(i => tag({ bill_id: Number(i.dataset.prqBill), amount: parseFloat(i.value) || 0 }));
    }
    if (type === 'quick') {
      return [...document.querySelectorAll('[data-prq-quick]')]
        .map(row => tag({ description: row.querySelector('.prq-q-desc').value.trim(), amount: parseFloat(row.querySelector('.prq-q-amt').value) || 0 }))
        .filter(l => l.description || l.amount);
    }
    const amount = parseFloat(document.getElementById('prq-adv-amount')?.value) || 0;
    return [tag({ description: document.getElementById('prq-adv-desc')?.value.trim() || '', amount })];
  },

  // Base-currency value of a form line, as the server will book it.
  _prqLineBase(l) {
    if (!this._prq.currency) return l.amount || 0;
    const opts = this._prq.options || {};
    const type = this._prqType();
    let doc = null;
    if (type === 'invoice') doc = (opts.bills || []).find(b => Number(b.id) === Number(l.bill_id));
    if (type === 'advance') doc = (opts.pos || []).find(p => String(p.id) === document.getElementById('prq-po')?.value);
    const rate = doc && doc.currency === this._prq.currency && Number(doc.exchange_rate) > 0 ? Number(doc.exchange_rate) : (this._prq.rate || 0);
    return (l.amount || 0) * rate;
  },

  _prqSum() {
    const el = document.getElementById('prq-total');
    if (!el) return;
    const lines = this._prqLines();
    const cents = lines.reduce((s, l) => s + Math.round((l.amount || 0) * 100), 0);
    if (!this._prq.currency) { el.innerHTML = `Total requested: <strong>${this.fmt(cents / 100)}</strong>`; return; }
    const base = lines.reduce((s, l) => s + this._prqLineBase(l), 0);
    el.innerHTML = `Total requested: <strong>${this._prqFmt(cents / 100)}</strong> <span style="font-size:12px;color:var(--text-muted)">≈ ${this.fmt(base)}</span>`;
  },

  async savePaymentRequest(submit) {
    const type = this._prqType();
    const lines = this._prqLines();
    const data = {
      supplier_id: document.getElementById('prq-vendor').value,
      request_type: type,
      notes: document.getElementById('prq-notes').value.trim(),
      required_date: document.getElementById('prq-date')?.value || null,
      lines,
      submit,
      currency: this._prq.currency || this._baseCurrency(),
      exchange_rate: this._prq.currency ? this._prq.rate : null,
    };
    if (!data.supplier_id) return this.alert('Choose a vendor', 'error');
    if (this._prq.currency && !(this._prq.rate > 0)) return this.alert(`Enter the ${this._prq.currency} exchange rate`, 'error');
    if (type === 'advance') {
      data.po_id = document.getElementById('prq-po')?.value || null;
      data.amount = lines[0].amount;
      if (this._prq.currency) data.amount_fx = lines[0].amount;
      data.description = lines[0].description;
      if (!data.po_id) return this.alert('Choose the purchase order the advance is for', 'error');
    }
    if (!lines.length) return this.alert(type === 'invoice' ? 'Tick at least one invoice to pay' : 'Add at least one payment line', 'error');
    const files = [...(document.getElementById('prq-files').files || [])];
    try {
      const id = this._prq.id;
      const saved = id ? await this.api('PUT', `/payables/payment-requests/${id}`, data) : await this.api('POST', '/payables/payment-requests', data);
      try { await this._uploadPaymentRequestFiles(saved.id, files); }
      catch (e) { this.alert(`${saved.request_number} saved, but a document didn't upload — ${e.message}`, 'warning'); }
      this.alert(submit ? `${saved.request_number} submitted for approval` : `${saved.request_number} saved as a draft`);
      this.closeModal();
      this._apTab = 'requests';
      this._afterApChange();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _uploadPaymentRequestFiles(id, files) {
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/payables/payment-requests/${id}/attachments`, { method: 'POST', body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`${file.name}: ${e.error || 'Upload failed'}`); }
    }
  },

  async viewPaymentRequest(id) {
    const [r, atts] = await Promise.all([
      this.api('GET', `/payables/payment-requests/${id}`),
      this.api('GET', `/payables/payment-requests/${id}/attachments`).catch(() => []),
    ]);
    const methodLabel = { ...Object.fromEntries(this._apMethods), ...this._apMethodNames };
    const mine = this.currentUser && Number(r.requested_by) === Number(this.currentUser.id);
    const canEdit = this.can('payables_requests');
    const canApprove = this.can('payables_approve');
    const canRemoveDocs = canEdit && ['draft', 'submitted', 'rejected'].includes(r.status);
    const note = (bg, border, color, html) => `<div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:${color}">${html}</div>`;
    const linesHtml = r.request_type === 'invoice'
      ? `<table style="width:100%;font-size:13px"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Bill #</th><th style="text-align:left">Vendor Inv #</th><th style="text-align:left">Due</th><th style="text-align:right">Balance Now</th><th style="text-align:right">Requested</th></tr></thead>
         <tbody>${r.lines.map(l => `<tr style="border-top:1px solid var(--border)">
           <td style="padding:6px 0">${this.can('payables') ? `<a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.viewBill(${l.bill_id})">${l.bill_number}</a>` : l.bill_number}</td>
           <td>${this.escapeAttr(l.vendor_invoice_number || '—')}</td><td>${this._apDate(l.due_date)}</td>
           <td style="text-align:right">${this.fmt(l.bill_balance)}${l.bill_currency && Number(l.bill_rate) > 0 ? `<div style="font-size:11px;color:var(--text-muted)">${l.bill_currency} ${this._n2(l.bill_balance / l.bill_rate)}</div>` : ''}</td><td style="text-align:right" class="fw-600">${this._prqAmountHtml(r, l.amount, l.amount_fx)}</td></tr>`).join('')}</tbody></table>`
      : `<table style="width:100%;font-size:13px"><tbody>${r.lines.map(l => `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 0">${this.escapeAttr(l.description || '')}</td><td style="text-align:right" class="fw-600">${this._prqAmountHtml(r, l.amount, l.amount_fx)}</td></tr>`).join('')}</tbody></table>`;
    const btn = (cls, label, onclick) => `<button class="btn ${cls}" onclick="${onclick}">${label}</button>`;
    const actions = [];
    if (['draft', 'rejected'].includes(r.status) && canEdit) actions.push(btn('btn-outline', r.status === 'rejected' ? 'Edit &amp; Resubmit' : 'Edit', `App.showPaymentRequestForm(${r.id})`));
    if (r.status === 'draft' && canEdit) actions.push(btn('btn-primary', 'Submit for Approval', `App.paymentRequestAction(${r.id}, 'submit')`));
    if (r.status === 'submitted' && canEdit) actions.push(btn('btn-outline', 'Recall to Draft', `App.paymentRequestAction(${r.id}, 'recall')`));
    if (r.status === 'submitted' && canApprove && !mine) {
      actions.push(btn('btn-danger', 'Reject', `App.rejectPaymentRequest(${r.id})`));
      actions.push(btn('btn-success', 'Approve', `App.approvePaymentRequest(${r.id})`));
    }
    if (r.status === 'approved' && this.can('payables_payments')) actions.push(btn('btn-primary', r.paid_amount > 0 ? 'Pay Remaining' : 'Process Payment', `App.showPayRequestForm(${r.id})`));
    if (['draft', 'submitted', 'approved', 'rejected'].includes(r.status) && canEdit) actions.unshift(btn('btn-outline', 'Cancel Request', `App.cancelPaymentRequest(${r.id})`));
    this.showModal(`
      <div class="modal" style="max-width:680px">
        <div class="modal-header">
          <span class="modal-title">Payment Request ${r.request_number}</span>
          <div style="display:flex;gap:8px;align-items:center"><span class="badge-pill ${this._prqStatusBadge[r.status] || ''}">${this._prqStatusLabel[r.status] || r.status}</span><button class="modal-close">✕</button></div>
        </div>
        <div class="modal-body">
          ${r.status === 'submitted' && mine && canApprove ? note('#fffbeb', '#fde68a', '#92400e', 'You raised this request, so someone else has to approve it.') : ''}
          ${r.status === 'rejected' ? note('#fef2f2', '#fecaca', '#991b1b', `<strong>Rejected</strong> by ${this.escapeAttr(r.rejected_by_name || '—')} · ${this.fmtDate(r.rejected_at)}<br>${this.escapeAttr(r.rejection_reason || '')}`) : ''}
          ${r.status === 'cancelled' ? note('#f9fafb', '#e5e7eb', '#374151', `<strong>Cancelled</strong> by ${this.escapeAttr(r.cancelled_by_name || '—')} · ${this.fmtDate(r.cancelled_at)}<br>${this.escapeAttr(r.cancel_reason || '')}`) : ''}
          ${(r.payments || []).length ? note(r.paid_in_full ? '#f0fdf4' : '#eff6ff', r.paid_in_full ? '#bbf7d0' : '#bfdbfe', r.paid_in_full ? '#166534' : '#1e40af',
            `<strong>${r.paid_in_full ? 'Paid in full' : `Part paid — ${this._prqAmountHtml(r, r.remaining, r.remaining_fx, { base: false })} still to pay`}</strong>${r.paid_by_name && r.paid_in_full ? ` · completed by ${this.escapeAttr(r.paid_by_name)}` : ''}
             ${r.payments.map(p => `<div style="margin-top:4px">${p.status === 'void' ? '<s>' : ''}<a href="#" onclick="event.preventDefault();App.viewApPayment(${p.id})">${p.payment_number}</a> · ${this._apDate(p.payment_date)} · ${methodLabel[p.method] || p.method}${p.reference ? ` ${this.escapeAttr(p.reference)}` : ''}${p.bank_account_name ? ` · from ${this.escapeAttr(p.bank_account_name)}` : ''} · <strong>${p.currency ? `${p.currency} ${this._n2(p.amount_fx)}` : this.fmt(p.amount)}</strong>${p.status === 'void' ? '</s> <strong style="color:#dc2626">void</strong>' : ''}</div>`).join('')}`) : ''}
          <div class="two-col" style="font-size:13px;margin-bottom:14px">
            <div>
              <strong>Vendor:</strong> ${this.escapeAttr(r.supplier_name)} (${r.supplier_number})<br>
              <strong>Type:</strong> ${this._prqTypeLabel[r.request_type]}<br>
              <strong>Requested payment date:</strong> ${r.required_date ? (['paid', 'cancelled'].includes(r.status) || r.scheduled_date ? this._apDate(r.required_date) : this._prqPayByHtml(r.required_date, { short: true })) : '<span style="color:var(--text-muted)">not given</span>'}<br>
              <strong>Scheduled payment date:</strong> ${r.scheduled_date
                ? `${['paid', 'cancelled'].includes(r.status) ? this._apDate(r.scheduled_date) : this._prqPayByHtml(r.scheduled_date, { short: true })}${r.scheduled_date !== r.required_date && r.required_date ? ' <span class="badge-pill badge-warning" style="font-size:10px">differs from requested</span>' : ''}<div style="font-size:11px;color:var(--text-muted)">set by ${this.escapeAttr(r.scheduled_by_name || '—')} · ${this.fmtDateTime(r.scheduled_at)}${r.status === 'approved' && canApprove ? ` · <a href="#" onclick="event.preventDefault();App.reschedulePaymentRequest(${r.id})">Change</a>` : ''}</div>`
                : `<span style="color:var(--text-muted)">${['submitted', 'draft'].includes(r.status) ? 'set by the approver' : '—'}</span><br>`}
              ${r.po_number ? `<strong>Purchase Order:</strong> ${this.can('purchasing') ? `<a href="#" style="color:var(--primary)" onclick="event.preventDefault();App.closeModal();App.showSection('purchasing').then(()=>App.viewPO(${r.po_id}))">${r.po_number}</a>` : r.po_number}<br>` : ''}
            </div>
            <div>
              <strong>Requested:</strong> ${this.escapeAttr(r.requested_by_name || '—')} · ${this.fmtDate(r.created_at)}<br>
              ${r.submitted_at ? `<strong>Submitted:</strong> ${this.fmtDate(r.submitted_at)}<br>` : ''}
              ${r.approved_at ? `<strong>Approved:</strong> ${this.escapeAttr(r.approved_by_name || '—')} · ${this.fmtDate(r.approved_at)}${this._approvalSigImg(r.approval_signature)}` : ''}
            </div>
          </div>
          ${linesHtml}
          <div style="text-align:right;font-size:16px;margin:10px 0 14px">Total requested: <strong>${this._prqAmountHtml(r)}</strong>${r.currency ? `<div style="font-size:12px;color:var(--text-muted)">Paid in ${r.currency} · request rate ${r.exchange_rate} ${this._baseCurrency()} per ${r.currency}</div>` : ''}</div>
          ${r.notes ? `<div style="font-size:13px;margin-bottom:14px"><strong>Purpose / Notes:</strong> ${this.escapeAttr(r.notes)}</div>` : ''}
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">Supporting Documents</div>
          <div style="font-size:13px">${atts.length ? atts.map(a => `
            <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);padding:5px 0">
              <a href="/api/payables/payment-requests/${r.id}/attachments/${a.id}/download" target="_blank" style="color:var(--primary)">📎 ${this.escapeAttr(a.original_name)}</a>
              <span style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(a.uploaded_by_name || '')}${canRemoveDocs ? ` <button class="btn btn-sm btn-outline" style="margin-left:6px" onclick="App.removePaymentRequestFile(${r.id}, ${a.id})">Remove</button>` : ''}</span>
            </div>`).join('') : '<p style="color:var(--text-muted);margin:0">None attached.</p>'}</div>
          ${canEdit && r.status !== 'cancelled' ? `<div style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="file" id="prq-view-files" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt"><button class="btn btn-sm btn-outline" onclick="App.addPaymentRequestFiles(${r.id})">Upload</button></div>` : ''}
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-secondary" style="margin-right:auto" onclick="App.printPaymentRequest(${r.id})">🖨 Print</button>
          ${actions.join('')}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async _afterPrqChange(id, message) {
    this.alert(message);
    this.closeModal();
    this._pollPayablesInbox();
    if (this.section === 'payables') this.renderPayables();
    if (id) this.viewPaymentRequest(id);
  },

  async paymentRequestAction(id, action) {
    try {
      const r = await this.api('POST', `/payables/payment-requests/${id}/${action}`, {});
      this._afterPrqChange(id, action === 'submit' ? `${r.request_number} submitted for approval` : `${r.request_number} is back in draft`);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async approvePaymentRequest(id) {
    const r = await this.api('GET', `/payables/payment-requests/${id}`).catch(() => null);
    this._showApprovalDialog({
      title: `Approve Payment Request${r ? ` ${r.request_number}` : ''}`,
      intro: 'Once approved, the request can be paid. Your signature is printed on it.',
      context: r ? `<div style="font-size:13px;margin-bottom:12px;padding:10px 12px;background:var(--bg-secondary,#f9fafb);border-radius:6px">
        <strong>${this.escapeAttr(r.supplier_name)}</strong> · ${this._prqTypeLabel[r.request_type]}${r.po_number ? ` on ${r.po_number}` : ''}<br>
        Total: <strong>${this._prqAmountHtml(r)}</strong> · requested by ${this.escapeAttr(r.requested_by_name || '—')}
        <div style="margin-top:4px">Requested payment date: <strong>${r.required_date ? this._apDate(r.required_date) : 'not given'}</strong></div>
        ${r.notes ? `<div style="margin-top:4px;color:var(--text-muted)">${this.escapeAttr(r.notes)}</div>` : ''}</div>
        <div class="form-group"><label>Scheduled Payment Date *</label><input id="prq-sched-date" type="date" value="${r.required_date || this._storeDay(new Date())}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">When this will be paid — can differ from the requested date. Both are kept.</div></div>` : '',
      approve: async (signature) => {
        const scheduled_date = document.getElementById('prq-sched-date')?.value || '';
        if (!scheduled_date) throw new Error('Enter the scheduled payment date');
        await this.api('POST', `/payables/payment-requests/${id}/approve`, { signature, scheduled_date });
        this._afterPrqChange(id, 'Payment request approved');
      },
    });
  },

  async reschedulePaymentRequest(id) {
    const r = await this.api('GET', `/payables/payment-requests/${id}`).catch(() => null);
    if (!r) return;
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Change Scheduled Date — ${r.request_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;margin-top:0">Requested payment date: <strong>${r.required_date ? this._apDate(r.required_date) : 'not given'}</strong> (stays as it is)</p>
          <div class="form-group"><label>Scheduled Payment Date *</label><input id="prq-resched-date" type="date" value="${r.scheduled_date || r.required_date || ''}"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal();App.viewPaymentRequest(${id})">Cancel</button>
          <button class="btn btn-primary" onclick="App._saveReschedulePaymentRequest(${id})">Save</button>
        </div>
      </div>`);
  },

  async _saveReschedulePaymentRequest(id) {
    const scheduled_date = document.getElementById('prq-resched-date')?.value || '';
    if (!scheduled_date) return this.alert('Enter the scheduled payment date', 'error');
    try {
      await this.api('PATCH', `/payables/payment-requests/${id}/schedule`, { scheduled_date });
      this._afterPrqChange(id, 'Scheduled payment date changed');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async rejectPaymentRequest(id) {
    const reason = prompt('Reject this payment request? Tell the requester why:');
    if (reason === null) return;
    if (!reason.trim()) return this.alert('A reason is required', 'error');
    try {
      await this.api('POST', `/payables/payment-requests/${id}/reject`, { reason: reason.trim() });
      this._afterPrqChange(id, 'Payment request rejected');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async cancelPaymentRequest(id) {
    const reason = prompt('Cancel this payment request? It can\'t be paid afterwards. Enter a reason:');
    if (reason === null) return;
    if (!reason.trim()) return this.alert('A reason is required', 'error');
    try {
      await this.api('POST', `/payables/payment-requests/${id}/cancel`, { reason: reason.trim() });
      this._afterPrqChange(id, 'Payment request cancelled');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async addPaymentRequestFiles(id) {
    const files = [...(document.getElementById('prq-view-files').files || [])];
    if (!files.length) return this.alert('Choose a file to upload', 'error');
    try {
      await this._uploadPaymentRequestFiles(id, files);
      this._afterPrqChange(id, files.length > 1 ? `${files.length} documents attached` : 'Document attached');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async removePaymentRequestFile(id, attId) {
    if (!confirm('Remove this document from the request?')) return;
    try {
      await this.api('DELETE', `/payables/payment-requests/${id}/attachments/${attId}`);
      this._afterPrqChange(id, 'Document removed');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // Pays an approved request — the only place a vendor payment is recorded.
  // Process Payment on an approved request: the bank account it was paid
  // from (RetailPOS Books' accounts), the actual date, method and bank
  // reference / cheque #, the amount (all or part of what's left) and how it's
  // applied to the request's invoices, plus proof of payment. Review shows it
  // all before it's posted; posting opens the payment for its advice.
  async showPayRequestForm(id) {
    let r, banks;
    try {
      [r, banks] = await Promise.all([this.api('GET', `/payables/payment-requests/${id}`), this.api('GET', '/payables/payment-requests/bank-accounts')]);
    } catch (e) { this.alert(e.message, 'error'); return; }
    const base = this._baseCurrency();
    const cur = r.currency || base;
    const fx = !!r.currency;
    const esc = v => this.escapeAttr(v ?? '');
    const money = (b, f) => fx ? `${cur} ${this._n2(f)}` : this.fmt(b);
    const usable = banks.filter(b => b.currency === cur || b.currency === base);
    const bankLabel = b => `${b.name}${b.bank_name ? ` — ${b.bank_name}` : ''}${b.last4 ? ` ••${b.last4}` : ''} · ${b.currency}`;
    const lines = r.request_type === 'advance' ? [] : r.lines.filter(l => (fx ? l.remaining_fx : l.remaining) > 0.005);
    const left = fx ? r.remaining_fx : r.remaining;
    this._payCtx = { r, banks, fx, cur };
    const linked = r.request_type === 'advance'
      ? `Advance / COD on purchase order <strong>${esc(r.po_number)}</strong>. With no invoice yet, it's held on the vendor's account against that PO and applied to its invoice when that's entered.`
      : r.request_type === 'quick'
        ? 'A bill is entered for each line on the first payment, and this payment is applied to them.'
        : `Invoices: ${r.lines.map(l => `<strong>${esc(l.bill_number)}</strong>${l.vendor_invoice_number ? ` (vendor inv ${esc(l.vendor_invoice_number)})` : ''}`).join(', ')}`;
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Process Payment — ${esc(r.request_number)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body" id="prp-form">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 16px;font-size:13px;margin-bottom:12px">
            <div><div style="color:var(--text-muted);font-size:11px">VENDOR</div><strong>${esc(r.supplier_name)}</strong></div>
            <div><div style="color:var(--text-muted);font-size:11px">APPROVED AMOUNT</div><strong>${money(r.amount, r.amount_fx)}</strong></div>
            <div><div style="color:var(--text-muted);font-size:11px">ALREADY PAID</div>${money(r.paid_amount, r.paid_amount_fx)}</div>
            <div><div style="color:var(--text-muted);font-size:11px">LEFT TO PAY</div><strong>${money(r.remaining, r.remaining_fx)}</strong></div>
            <div><div style="color:var(--text-muted);font-size:11px">SCHEDULED FOR</div>${r.scheduled_date ? this._apDate(r.scheduled_date) : '—'}</div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${linked}</div>
          <div class="form-group"><label>Paid From (bank account) *</label>
            ${usable.length
              ? `<select id="prp-bank"><option value="">Choose the bank account…</option>${usable.map(b => `<option value="${b.id}" data-currency="${b.currency}">${esc(bankLabel(b))}</option>`).join('')}</select>`
              : `<div style="font-size:13px;color:var(--danger)">No ${cur}${cur !== base ? ` or ${base}` : ''} bank accounts yet. They come from RetailPOS Books (Bank &amp; Reconciliation) on its next sync. A cash payment needs none.</div><input type="hidden" id="prp-bank" value="">`}
          </div>
          <div class="input-row">
            <div class="form-group"><label>Actual Payment Date *</label><input id="prp-date" type="date" value="${this._apToday()}">${r.scheduled_date && r.scheduled_date !== this._apToday() ? `<div style="font-size:11px;color:var(--text-muted)">Scheduled for ${this._apDate(r.scheduled_date)}</div>` : ''}</div>
            <div class="form-group"><label>Method *</label><select id="prp-method" onchange="App._payMethodChanged()">${this._apMethods.map(([v, l]) => `<option value="${v}" ${v === 'bank_transfer' ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          </div>
          <div class="form-group"><label id="prp-ref-label">Bank Transaction Reference *</label><input id="prp-ref"></div>
          ${fx ? `<div class="form-group" style="max-width:260px"><label>Exchange Rate on Payment (${base} per ${cur}) *</label><input id="prp-rate" type="number" step="0.0001" min="0" value="${r.exchange_rate || ''}" oninput="App._payRecalc()"></div>` : ''}
          ${r.request_type === 'advance'
            ? `<div class="form-group" style="max-width:260px"><label>Amount Paid (${cur}) *</label><input id="prp-amount" type="number" step="0.01" min="0" value="${left}" oninput="App._payRecalc()"></div>`
            : `<div style="font-weight:600;font-size:13px;margin:6px 0">Applied to</div>
               <table style="width:100%;font-size:13px"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">${r.request_type === 'quick' ? 'Line' : 'Invoice'}</th><th style="text-align:right">Left to pay</th><th style="text-align:right;width:150px">Pay now (${cur})</th></tr></thead>
               <tbody>${lines.map(l => `<tr style="border-top:1px solid var(--border)">
                 <td style="padding:6px 0">${esc(l.bill_number || l.description || '')}${l.vendor_invoice_number ? `<div style="font-size:11px;color:var(--text-muted)">Vendor inv ${esc(l.vendor_invoice_number)}</div>` : ''}</td>
                 <td style="text-align:right">${money(l.remaining, l.remaining_fx)}</td>
                 <td style="text-align:right"><input class="prp-alloc" data-line="${l.id}" data-max="${fx ? l.remaining_fx : l.remaining}" data-label="${esc(l.bill_number || l.description || '')}" type="number" step="0.01" min="0" value="${fx ? l.remaining_fx : l.remaining}" style="width:130px;text-align:right" oninput="App._payRecalc()"></td>
               </tr>`).join('')}</tbody></table>`}
          <div id="prp-total" style="text-align:right;font-size:15px;margin:10px 0"></div>
          <div class="form-group"><label>Proof of Payment</label><input type="file" id="prp-files" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"><div style="font-size:11px;color:var(--text-muted)">Bank confirmation or cheque copy, if you have it. It can be added later too.</div></div>
          <div class="form-group"><label>Notes</label><input id="prp-notes" placeholder="Defaults to the request number"></div>
        </div>
        <div class="modal-body" id="prp-review" hidden></div>
        <div class="modal-footer" id="prp-form-footer">
          <button class="btn btn-secondary" onclick="App.viewPaymentRequest(${r.id})">Back</button>
          <button class="btn btn-primary" onclick="App._payReview()">Review Payment</button>
        </div>
        <div class="modal-footer" id="prp-review-footer" hidden>
          <button class="btn btn-secondary" onclick="App._payEdit()">Edit</button>
          <button class="btn btn-primary" id="prp-btn" onclick="App.payPaymentRequest(${r.id})">Post Payment</button>
        </div>
      </div>`);
    this._payMethodChanged();
    this._payRecalc();
  },

  _payMethodChanged() {
    const m = document.getElementById('prp-method')?.value;
    const label = document.getElementById('prp-ref-label');
    if (label) label.textContent = m === 'cheque' ? 'Cheque Number *' : m === 'bank_transfer' ? 'Bank Transaction Reference *' : 'Reference';
  },

  // The payment's amount (sum of what's applied, or the advance) and its
  // base value at the rate entered.
  _payAmounts() {
    const c = this._payCtx;
    const allocs = [...document.querySelectorAll('.prp-alloc')].map(i => ({ line_id: Number(i.dataset.line), amount: Math.round((parseFloat(i.value) || 0) * 100) / 100, max: Number(i.dataset.max), label: i.dataset.label }));
    const amount = c.r.request_type === 'advance' ? Math.round((parseFloat(document.getElementById('prp-amount')?.value) || 0) * 100) / 100 : Math.round(allocs.reduce((t, a) => t + a.amount, 0) * 100) / 100;
    const rate = c.fx ? parseFloat(document.getElementById('prp-rate')?.value) || 0 : 1;
    return { allocs, amount, rate };
  },
  _payRecalc() {
    const c = this._payCtx;
    const { amount, rate } = this._payAmounts();
    const el = document.getElementById('prp-total');
    if (el) el.innerHTML = `Paying <strong>${c.fx ? `${c.cur} ${this._n2(amount)}` : this.fmt(amount)}</strong>${c.fx && rate ? `<div style="font-size:12px;color:var(--text-muted)">≈ ${this.fmt(amount * rate)} at ${rate}</div>` : ''}`;
  },

  _payValues() {
    const c = this._payCtx;
    const { allocs, amount, rate } = this._payAmounts();
    const bankSel = document.getElementById('prp-bank');
    const bank = c.banks.find(b => String(b.id) === String(bankSel?.value)) || null;
    const v = {
      bank, method: document.getElementById('prp-method').value, payment_date: document.getElementById('prp-date').value,
      reference: document.getElementById('prp-ref').value.trim(), notes: document.getElementById('prp-notes').value.trim(),
      amount, rate, allocs: allocs.filter(a => a.amount > 0), files: [...(document.getElementById('prp-files')?.files || [])],
    };
    const left = c.fx ? c.r.remaining_fx : c.r.remaining;
    if (!v.bank && v.method !== 'cash') return { error: 'Choose the bank account the payment was made from' };
    if (!v.payment_date) return { error: 'Enter the date the payment was made' };
    if (['cheque', 'bank_transfer'].includes(v.method) && !v.reference) return { error: v.method === 'cheque' ? 'Enter the cheque number' : 'Enter the bank transaction reference' };
    if (c.fx && !(rate > 0)) return { error: `Enter the ${c.cur} exchange rate used for this payment` };
    if (!(amount > 0)) return { error: 'Enter the amount paid' };
    if (amount - left > 0.005) return { error: `Only ${c.fx ? `${c.cur} ${this._n2(left)}` : this.fmt(left)} is left to pay` };
    const over = allocs.find(a => a.amount - a.max > 0.005);
    if (over) return { error: `Only ${this._n2(over.max)} is left to pay on ${over.label}` };
    return v;
  },

  _payReview() {
    const v = this._payValues();
    if (v.error) { this.alert(v.error, 'warning'); return; }
    const c = this._payCtx;
    const esc = s => this.escapeAttr(s ?? '');
    const amt = n => c.fx ? `${c.cur} ${this._n2(n)}` : this.fmt(n);
    const method = Object.fromEntries(this._apMethods)[v.method] || v.method;
    const full = Math.abs(v.amount - (c.fx ? c.r.remaining_fx : c.r.remaining)) <= 0.005;
    const row = (k, val) => `<tr style="border-top:1px solid var(--border)"><td style="padding:7px 0;color:var(--text-muted);width:40%">${k}</td><td style="padding:7px 0">${val}</td></tr>`;
    document.getElementById('prp-review').innerHTML = `
      <p style="margin-top:0;font-size:13px">Check the payment before it's posted to the bank account in the ledger.</p>
      <table style="width:100%;font-size:14px">
        ${row('Vendor', `<strong>${esc(c.r.supplier_name)}</strong>`)}
        ${row('Paid from', v.bank ? `<strong>${esc(v.bank.name)}</strong>${v.bank.bank_name ? ` — ${esc(v.bank.bank_name)}` : ''}${v.bank.last4 ? ` ••${esc(v.bank.last4)}` : ''} <span class="badge-pill badge-info" style="font-size:11px">${v.bank.currency}</span>` : 'Cash (no bank account)')}
        ${row('Payment date', this._apDate(v.payment_date))}
        ${row('Method', `${method}${v.reference ? ` · <strong>${esc(v.reference)}</strong>` : ''}`)}
        ${row('Amount', `<strong style="font-size:16px">${amt(v.amount)}</strong>${c.fx ? ` <span style="color:var(--text-muted)">≈ ${this.fmt(v.amount * v.rate)} at ${v.rate}</span>` : ''}`)}
        ${row('Applied to', c.r.request_type === 'advance'
          ? `Held on ${esc(c.r.supplier_name)}'s account against <strong>${esc(c.r.po_number)}</strong> until its invoice is entered`
          : v.allocs.map(a => `${esc(a.label)}: <strong>${amt(a.amount)}</strong>`).join('<br>'))}
        ${row('Request', `${esc(c.r.request_number)} — ${full ? 'paid in full' : `part payment, ${amt((c.fx ? c.r.remaining_fx : c.r.remaining) - v.amount)} still to pay`}`)}
        ${v.files.length ? row('Proof of payment', v.files.map(f => esc(f.name)).join(', ')) : ''}
      </table>`;
    for (const [id, show] of [['prp-form', false], ['prp-form-footer', false], ['prp-review', true], ['prp-review-footer', true]]) document.getElementById(id).hidden = !show;
  },
  _payEdit() {
    for (const [id, show] of [['prp-form', true], ['prp-form-footer', true], ['prp-review', false], ['prp-review-footer', false]]) document.getElementById(id).hidden = !show;
  },

  async payPaymentRequest(id) {
    const v = this._payValues();
    if (v.error) { this._payEdit(); this.alert(v.error, 'warning'); return; }
    const c = this._payCtx;
    const btn = document.getElementById('prp-btn');
    if (btn) btn.disabled = true;
    let paid;
    try {
      paid = await this.api('POST', `/payables/payment-requests/${id}/pay`, {
        payment_date: v.payment_date, method: v.method, reference: v.reference, notes: v.notes,
        bank_account_id: v.bank ? v.bank.id : null, amount: v.amount,
        exchange_rate: c.fx ? v.rate : undefined,
        allocations: c.r.request_type === 'advance' ? undefined : v.allocs.map(a => ({ line_id: a.line_id, amount: a.amount })),
      });
    } catch (e) {
      if (btn) btn.disabled = false;
      this.alert(e.message, 'error');
      return;
    }
    let note = '';
    if (v.files.length) {
      try { await this._uploadApPaymentFiles(paid.new_payment_id, v.files); }
      catch (e) { note = ` — but the proof of payment didn't upload (${e.message}); add it from the payment`; }
    }
    this.alert(`Payment ${paid.payment_number} posted${note}`, note ? 'warning' : 'success');
    this._pollPayablesInbox();
    if (this.section === 'payables') this.renderPayables();
    this.viewApPayment(paid.new_payment_id);
  },

  async _uploadApPaymentFiles(paymentId, files) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const res = await fetch(`/api/payables/payments/${paymentId}/attachments`, { method: 'POST', body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Upload failed'); }
    return res.json();
  },

  // A vendor payment: where it went, what it paid, what's still on the
  // vendor's account to apply (with Apply), proof of payment, and the
  // payment advice (preview, PDF, email, history).
  async viewApPayment(id) {
    let p;
    try { p = await this.api('GET', `/payables/payments/${id}`); } catch (e) { this.alert(e.message, 'error'); return; }
    const esc = v => this.escapeAttr(v ?? '');
    const fx = !!p.currency;
    const amt = (b, f) => fx ? `${p.currency} ${this._n2(f)}` : this.fmt(b);
    const method = { ...Object.fromEntries(this._apMethods), ...this._apMethodNames }[p.method] || p.method;
    const canPay = this.can('payables_payments');
    const posted = p.status === 'posted';
    const unapplied = posted && p.unapplied > 0.005;
    this.showModal(`
      <div class="modal" style="max-width:720px">
        <div class="modal-header"><span class="modal-title">Payment ${esc(p.payment_number)}</span>
          <div style="display:flex;gap:8px;align-items:center"><span class="badge-pill ${posted ? 'badge-success' : 'badge-secondary'}">${posted ? 'Posted' : 'Void'}</span><button class="modal-close">✕</button></div></div>
        <div class="modal-body">
          ${!posted ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:#991b1b"><strong>Voided</strong> ${esc(p.void_reason || '')}</div>` : ''}
          <div class="two-col" style="font-size:13px;margin-bottom:12px">
            <div>
              <strong>Vendor:</strong> ${esc(p.supplier_name)} (${esc(p.supplier_number)})<br>
              <strong>Paid from:</strong> ${p.bank_account_name ? `${esc(p.bank_account_name)} · ${esc(p.bank_currency)}` : p.method === 'cash' ? 'Cash' : '<span style="color:var(--text-muted)">not recorded (before bank accounts were added)</span>'}<br>
              <strong>Payment date:</strong> ${this._apDate(p.payment_date)}<br>
              <strong>Method:</strong> ${method}${p.reference ? ` · ${esc(p.reference)}` : ''}
            </div>
            <div>
              <strong>Amount:</strong> <span class="fw-600">${amt(p.amount, p.amount_fx)}</span>${fx ? ` <span style="color:var(--text-muted)">≈ ${this.fmt(p.amount)} at ${p.exchange_rate}</span>` : ''}<br>
              ${p.request_number ? `<strong>Request:</strong> <a href="#" onclick="event.preventDefault();App.viewPaymentRequest(${p.payment_request_id})">${esc(p.request_number)}</a><br>` : ''}
              ${p.po_number ? `<strong>Purchase order:</strong> ${esc(p.po_number)}<br>` : ''}
              <strong>Recorded by:</strong> ${esc(p.created_by_name || '—')} · ${this.fmtDateTime(p.created_at)}
            </div>
          </div>
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">Applied to</div>
          <table style="width:100%;font-size:13px;margin-bottom:10px"><tbody>
            ${p.allocations.length ? p.allocations.map(a => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0"><a href="#" onclick="event.preventDefault();App.viewBill(${a.bill_id})">${esc(a.bill_number)}</a>${a.vendor_invoice_number ? ` · vendor inv ${esc(a.vendor_invoice_number)}` : ''}${a.bill_po_number ? ` · ${esc(a.bill_po_number)}` : ''}</td><td style="text-align:right" class="fw-600">${amt(a.amount, a.amount_fx)}</td></tr>`).join('')
              : '<tr><td style="color:var(--text-muted);padding:5px 0">Not applied to any invoice yet</td></tr>'}
          </tbody></table>
          ${unapplied ? `<div style="border:1px solid #fde68a;background:#fffbeb;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:13px">
            <strong>${amt(p.unapplied, p.unapplied_fx)} available to apply</strong> on ${esc(p.supplier_name)}'s account${p.po_number ? ` (paid on ${esc(p.po_number)}, awaiting its invoice)` : ''}.
            ${canPay && p.open_bills.length ? `<table style="width:100%;font-size:13px;margin-top:8px"><thead><tr style="color:var(--text-muted);font-size:12px"><th style="text-align:left">Open bill</th><th style="text-align:right">Owed</th><th style="text-align:right;width:140px">Apply (${this._baseCurrency()})</th></tr></thead><tbody>
                ${p.open_bills.map(b => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 0">${esc(b.bill_number)}${b.vendor_invoice_number ? ` · inv ${esc(b.vendor_invoice_number)}` : ''}${b.po_number ? ` · ${esc(b.po_number)}` : ''}</td><td style="text-align:right">${this.fmt(b.balance)}</td>
                  <td style="text-align:right"><input class="pay-apply" data-bill="${b.id}" type="number" step="0.01" min="0" max="${b.balance}" placeholder="0.00" style="width:120px;text-align:right"></td></tr>`).join('')}
              </tbody></table>
              <div style="text-align:right;margin-top:6px"><button class="btn btn-sm btn-primary" onclick="App._applyApPayment(${p.id})">Apply to Bills</button></div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Only the Payables records change: the money already left the bank when this payment was posted.</div>`
              : canPay ? '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">No open bills for this vendor yet. Enter the supplier invoice in Bills, then apply this payment to it.</div>' : ''}
          </div>` : ''}
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">Proof of Payment</div>
          <div style="font-size:13px;margin-bottom:6px">${p.attachments.length ? p.attachments.map(a => `<div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding:4px 0">
              <a href="/api/payables/payments/${p.id}/attachments/${a.id}/download" target="_blank">📎 ${esc(a.original_name)}</a>
              <span style="font-size:11px;color:var(--text-muted)">${esc(a.uploaded_by_name || '')}${canPay ? ` <button class="btn btn-sm btn-outline" onclick="App._removeApPaymentFile(${p.id}, ${a.id})">Remove</button>` : ''}</span></div>`).join('') : '<span style="color:var(--text-muted)">None attached.</span>'}</div>
          ${canPay ? `<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px"><input type="file" id="pay-view-files" multiple accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"><button class="btn btn-sm btn-outline" onclick="App._addApPaymentFiles(${p.id})">Upload</button></div>` : ''}
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">Payment Advice</div>
          ${posted ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <button class="btn btn-sm btn-outline" onclick="App._printServerDocument('/api/email/payment-advice-preview/${p.id}', 'payment-advice', 'payment advice')">Preview</button>
            <a class="btn btn-sm btn-outline" href="/api/email/payment-advice-pdf/${p.id}" target="_blank">Download PDF</a>
            ${canPay ? `<button class="btn btn-sm btn-primary" onclick="App._showPaymentAdviceEmail(${p.id})">Email to Vendor</button>` : ''}
          </div>` : ''}
          <div id="pay-advice-email"></div>
          <div style="font-size:12px">${p.advices.length ? p.advices.map(d => `<div style="border-top:1px solid var(--border);padding:4px 0">Sent to <strong>${esc(d.sent_to)}</strong>${d.cc ? ` (cc ${esc(d.cc)})` : ''} · ${this.fmtDateTime(d.sent_at)} by ${esc(d.sent_by_name || '—')}${d.has_copy ? ` · <a href="/api/payables/payments/${p.id}/advices/${d.id}/download" target="_blank">copy sent</a>` : ''}</div>`).join('') : '<span style="color:var(--text-muted)">Not emailed yet.</span>'}</div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
    this._apPaymentView = p;
  },

  _showPaymentAdviceEmail(id) {
    const p = this._apPaymentView;
    const box = document.getElementById('pay-advice-email');
    if (!box || !p) return;
    box.innerHTML = `<div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:10px">
      <div class="form-group"><label>Vendor email *</label><input id="pa-to" value="${this.escapeAttr(p.supplier_email || '')}" placeholder="accounts@vendor.com">${p.supplier_email ? '' : '<div style="font-size:11px;color:var(--warning, #d97706)">No email on file for this vendor — enter one.</div>'}</div>
      <div class="form-group"><label>CC</label><input id="pa-cc" placeholder="Optional, comma-separated"></div>
      <div class="form-group"><label>Message</label><textarea id="pa-msg" rows="2" style="width:100%;resize:vertical" placeholder="Optional note above the attached PDF"></textarea></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-sm btn-secondary" onclick="document.getElementById('pay-advice-email').innerHTML=''">Cancel</button><button class="btn btn-sm btn-primary" id="pa-send" onclick="App._sendPaymentAdvice(${id})">Send Payment Advice</button></div>
    </div>`;
    document.getElementById('pa-to').focus();
  },
  async _sendPaymentAdvice(id) {
    const to = document.getElementById('pa-to').value.trim();
    if (!to) { this.alert("Enter the vendor's email address", 'warning'); return; }
    const btn = document.getElementById('pa-send');
    btn.disabled = true;
    try {
      const out = await this.api('POST', `/email/send-payment-advice/${id}`, { to, cc: document.getElementById('pa-cc').value.trim(), message: document.getElementById('pa-msg').value.trim() });
      this.alert(out.message, 'success');
      this.viewApPayment(id);
    } catch (e) { btn.disabled = false; this.alert(e.message, 'error'); }
  },

  async _applyApPayment(id) {
    const allocations = [...document.querySelectorAll('.pay-apply')].map(i => ({ bill_id: Number(i.dataset.bill), amount: parseFloat(i.value) || 0 })).filter(a => a.amount > 0);
    if (!allocations.length) { this.alert('Enter an amount to apply to at least one bill', 'warning'); return; }
    try {
      await this.api('POST', `/payables/payments/${id}/apply`, { allocations });
      this.alert('Payment applied', 'success');
      if (this.section === 'payables') this.renderPayables();
      this.viewApPayment(id);
    } catch (e) { this.alert(e.message, 'error'); }
  },
  async _addApPaymentFiles(id) {
    const files = [...(document.getElementById('pay-view-files')?.files || [])];
    if (!files.length) { this.alert('Choose a file first', 'warning'); return; }
    try { await this._uploadApPaymentFiles(id, files); this.viewApPayment(id); } catch (e) { this.alert(e.message, 'error'); }
  },
  async _removeApPaymentFile(id, attId) {
    if (!confirm('Remove this proof of payment?')) return;
    try { await this.api('DELETE', `/payables/payments/${id}/attachments/${attId}`); this.viewApPayment(id); } catch (e) { this.alert(e.message, 'error'); }
  },

  printPaymentRequest(id) {
    return this._printServerDocument(`/api/email/payment-request-preview/${id}`, 'payment-request', 'payment request');
  },

  async showVendorStatement(supplierId) {
    const st = await this.api('GET', `/payables/vendors/${supplierId}/statement`);
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">Statement — ${this.escapeAttr(st.supplier.name)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="padding:0">
          ${st.available_to_apply > 0.005 ? `<div style="margin:12px;padding:10px 12px;border:1px solid #fde68a;background:#fffbeb;border-radius:6px;font-size:13px"><strong>${this.fmt(st.available_to_apply)} available to apply</strong> — paid to this vendor but not yet applied to an invoice (COD / advance payments awaiting their invoice). Open the payment in Payments to apply it.</div>` : ''}
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:var(--bg-secondary,#f9fafb)">
              <th style="padding:8px 12px;text-align:left">Date</th><th style="padding:8px 12px;text-align:left">Document</th><th style="padding:8px 12px;text-align:left">Details</th>
              <th style="padding:8px 12px;text-align:right">Billed</th><th style="padding:8px 12px;text-align:right">Paid</th><th style="padding:8px 12px;text-align:right">Balance</th>
            </tr></thead>
            <tbody>${st.lines.length ? st.lines.map(l => `
              <tr style="border-top:1px solid var(--border);${l.void ? 'opacity:.5' : ''}${l.type === 'bill' ? ';cursor:pointer' : ''}" ${l.type === 'bill' ? `onclick="App.viewBill(${l.id})"` : ''}>
                <td style="padding:7px 12px;white-space:nowrap">${this._apDate(l.date)}</td>
                <td style="padding:7px 12px">${l.number}${l.void ? ' <span class="badge-pill badge-secondary" style="font-size:10px">void</span>' : ''}</td>
                <td style="padding:7px 12px">${this.escapeAttr(l.reference || '')}</td>
                <td style="padding:7px 12px;text-align:right">${l.charge ? this.fmt(l.charge) : ''}</td>
                <td style="padding:7px 12px;text-align:right">${l.payment ? this.fmt(l.payment) : ''}</td>
                <td style="padding:7px 12px;text-align:right" class="fw-600">${this.fmt(l.balance)}</td>
              </tr>`).join('') : '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted)">No bills or payments for this vendor yet</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="modal-footer" style="justify-content:space-between">
          <span style="font-size:15px">Balance owed: <strong>${this.fmt(st.balance)}</strong></span>
          <div style="display:flex;gap:8px">
            ${st.balance > 0 && this.can('payables_requests') ? `<button class="btn btn-primary" onclick="App.showPaymentRequestForm(null, { supplier_id: ${supplierId} })">Request Payment</button>` : ''}
            <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          </div>
        </div>
      </div>`);
  },

});
