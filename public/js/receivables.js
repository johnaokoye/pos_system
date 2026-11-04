// Accounts receivable.
Object.assign(App, {
  // ─── Accounts Receivable ──────────────────────────────────
  async renderAccounts() {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const [accounts, stats, aging] = await Promise.all([
      this.api('GET', '/accounts'),
      this.api('GET', '/accounts/stats'),
      this.api('GET', '/accounts/aging'),
    ]);
    if (this.section !== 'accounts') return;
    const maxBal = Math.max(...accounts.map(a => a.account_balance), 1);
    c.innerHTML = `
      <div class="section-header"><h2>Accounts Receivable</h2></div>
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Credit Customers</div><div class="stat-value">${stats.credit_customers}</div></div>
        <div class="stat-card orange"><div class="stat-label">Total Outstanding</div><div class="stat-value">${this.fmt(stats.total_outstanding)}</div></div>
        <div class="stat-card red"><div class="stat-label">Over Limit</div><div class="stat-value">${stats.over_limit_count}</div></div>
        <div class="stat-card green"><div class="stat-label">Payments Today</div><div class="stat-value">${this.fmt(stats.payments_today)}</div></div>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" onclick="App.showARTab(this,'ar-list')">Customer Balances</button>
        <button class="tab-btn" onclick="App.showARTab(this,'ar-aging')">Aging Report</button>
        <button class="tab-btn" onclick="App.showARTab(this,'ar-payments')">Payment History</button>
      </div>
      <div id="ar-list">
        <div class="card">
          <div class="card-header"><span class="card-title">Credit Accounts</span>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="search" id="ar-acct-q" placeholder="Search name, business, account #, phone, email…" autocomplete="off" style="width:280px;font-size:13px" oninput="App._arAcctSearch(this.value)">
              <button class="btn btn-sm btn-outline" onclick="App.showBatchStatementsModal()">🖨 Print Statements</button>
              ${this.can('customers_credit') ? '<button class="btn btn-sm btn-primary" onclick="App.showEnableCreditModal()">Enable Credit for Customer</button>' : ''}
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead id="ar-acct-head"></thead>
              <tbody id="ar-acct-body"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div id="ar-aging" style="display:none">
        <div class="card">
          <div class="card-header"><span class="card-title">AR Aging Report</span>
            <input type="search" id="ar-aging-q" placeholder="Search name, business, account #, phone, email…" autocomplete="off" style="width:280px;font-size:13px" oninput="App._arAgingSearch(this.value)">
          </div>
          <div class="table-wrap">
            <table>
              <thead id="ar-aging-head"></thead>
              <tbody id="ar-aging-body"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div id="ar-payments" style="display:none">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Payment History</span>
            <div style="display:flex;gap:8px;align-items:center">
              <div style="position:relative">
                <input type="text" id="ar-cust-search" placeholder="Search customers..." autocomplete="off"
                  style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;width:200px"
                  oninput="App._arFilterCustomers(this.value)">
                <div id="ar-cust-dd" style="display:none;position:absolute;top:100%;left:0;min-width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
              </div>
              <span id="ar-stmt-btn"></span>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:0 0 10px">
            <input type="search" id="ar-pay-q" placeholder="Search payment #, reference, customer, account #, method, employee…" autocomplete="off" style="flex:1;min-width:240px;font-size:13px" oninput="App._arPaySearch(this.value)">
            <input type="date" id="ar-pay-start" title="From" style="width:145px" onchange="App._arPay.start=this.value;App._loadARPayments(App._arCustomerId)">
            <span style="color:var(--text-muted)">to</span>
            <input type="date" id="ar-pay-end" title="To" style="width:145px" onchange="App._arPay.end=this.value;App._loadARPayments(App._arCustomerId)">
            <button class="btn btn-sm btn-outline" onclick="App._arPayClear()">Clear</button>
          </div>
          <div id="ar-payments-table"><div class="empty-state"><p>Loading payments...</p></div></div>
        </div>
      </div>`;
    this._arCustomers = null;
    this._arCustomerId = '';
    this._arAccounts = accounts;
    this._arAcct = { q: '', key: 'balance', dir: 'desc' };
    this._renderARAccounts();
    this._arAgingRows = aging;
    this._arAging = { q: '', key: 'balance', dir: 'desc' };
    this._renderARAging();
    this._arPay = { q: '', start: '', end: '', sortBy: 'date', dir: 'desc' };
    this._loadARPayments();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ar-cust-search') && !e.target.closest('#ar-cust-dd')) {
        const dd = document.getElementById('ar-cust-dd');
        if (dd) dd.style.display = 'none';
      }
    });
  },

  async _loadARPayments(customerId = '') {
    this._arCustomerId = customerId;
    const f = this._arPay || (this._arPay = { q: '', start: '', end: '', sortBy: 'date', dir: 'desc' });

    if (!this._arCustomers) {
      try { this._arCustomers = await this.api('GET', '/accounts'); } catch(e) { this._arCustomers = []; }
    }

    const limit = 500;
    const qs = new URLSearchParams({ limit, sort: f.dir, sort_by: f.sortBy });
    if (customerId) qs.set('customer_id', customerId);
    if (f.q) qs.set('q', f.q);
    if (f.start) qs.set('start', f.start);
    if (f.end) qs.set('end', f.end);
    const seq = (this._arPaySeq = (this._arPaySeq || 0) + 1);
    const payments = await this.api('GET', `/accounts/payments?${qs}`);
    if (seq !== this._arPaySeq) return; // a newer search is on its way

    const el = document.getElementById('ar-payments-table');
    if (!el) return;


    const stmtBtn = document.getElementById('ar-stmt-btn');
    if (stmtBtn) stmtBtn.innerHTML = customerId
      ? `<button class="btn btn-sm btn-secondary" onclick="App.showStatementModal(${customerId})">&#128438; Statement</button>`
      : '';

    const searchInput = document.getElementById('ar-cust-search');
    if (searchInput) {
      const customer = customerId ? this._arCustomers.find(c => String(c.id) === String(customerId)) : null;
      searchInput.value = customer ? `${customer.first_name} ${customer.last_name}` : '';
    }

    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th></th>${[['number','Payment #'],['customer','Customer'],['amount','Amount'],['method','Method'],['employee','Employee'],['date','Date']]
            .map(([k, l]) => this._arSortTh(l, k, f.sortBy, f.dir, `App._arPaySort('${k}')`)).join('')}</tr></thead>
          <tbody>
            ${payments.length ? payments.map(p => `
              <tr>
                <td style="width:28px;padding:4px 6px">
                  <button class="btn btn-sm" style="padding:1px 6px;font-size:11px;line-height:1.4" onclick="App._togglePaymentAllocs(${p.id},this)" title="Show invoice allocations">&#9654;</button>
                </td>
                <td class="fw-600">${p.payment_number}</td>
                <td>${this.escapeAttr(p.customer_name||'-')} <small style="color:var(--text-muted)">${p.customer_number||''}</small>${p.business_name ? `<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(p.business_name)}</div>` : ''}${p.reference ? `<div style="font-size:11px;color:var(--text-muted)">Ref: ${this.escapeAttr(p.reference)}</div>` : ''}</td>
                <td class="fw-600 color-success">${this.fmt(p.amount)}${p.unapplied > 0.005 ? `<div style="font-size:11px;font-weight:400;color:var(--text-muted)">${this.fmt(p.unapplied)} not yet applied</div>` : ''}</td>
                <td><span class="badge-pill badge-info">${p.payment_method}</span></td>
                <td>${p.employee_name||'-'}</td>
                <td style="color:var(--text-muted)">${this.fmtDateTime(p.created_at)}</td>
              </tr>
              <tr id="pmt-allocs-${p.id}" style="display:none;background:var(--bg-secondary,var(--bg))">
                <td colspan="7" style="padding:0 0 0 40px;border-top:none"></td>
              </tr>`).join('') : `<tr><td colspan="7" class="empty-state">${f.q || f.start || f.end || customerId ? 'No payments match these filters' : 'No payments recorded'}</td></tr>`}
          </tbody>
        </table>
      </div>
      ${payments.length >= limit ? `<p style="font-size:12px;color:var(--text-muted);margin:8px 0 0">Showing the first ${limit} — search, pick a customer or set dates to narrow it down.</p>` : ''}`;
  },

  // Sortable column header: click to sort, click again to reverse.
  _arSortTh(label, key, curKey, dir, onclick) {
    const arrow = key === curKey ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th style="cursor:pointer;user-select:none;white-space:nowrap" title="Sort by ${label}" onclick="${onclick}">${label}<span style="color:var(--primary)">${arrow}</span></th>`;
  },
  _arPaySort(key) {
    const f = this._arPay;
    // Text columns start A→Z; dates and amounts start largest/newest first.
    f.dir = f.sortBy === key ? (f.dir === 'asc' ? 'desc' : 'asc') : (['date', 'amount'].includes(key) ? 'desc' : 'asc');
    f.sortBy = key;
    this._loadARPayments(this._arCustomerId || '');
  },
  _arPaySearch(text) {
    clearTimeout(this._arPayTimer);
    this._arPayTimer = setTimeout(() => { this._arPay.q = text.trim(); this._loadARPayments(this._arCustomerId || ''); }, 300);
  },
  _arPayClear() {
    this._arPay = { q: '', start: '', end: '', sortBy: 'date', dir: 'desc' };
    ['ar-pay-q', 'ar-pay-start', 'ar-pay-end'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    this._loadARPayments('');
  },

  // Aging Report tab: filtered and sorted in the browser, like Credit Accounts.
  _arAgingSearch(text) {
    this._arAging.q = text.trim().toLowerCase();
    this._renderARAging();
  },
  _arAgingSort(key) {
    const a = this._arAging;
    a.dir = a.key === key ? (a.dir === 'asc' ? 'desc' : 'asc') : (key === 'customer' ? 'asc' : 'desc');
    a.key = key;
    this._renderARAging();
  },
  _renderARAging() {
    const head = document.getElementById('ar-aging-head');
    const body = document.getElementById('ar-aging-body');
    if (!head || !body) return;
    const { q, key, dir } = this._arAging;
    const col = { customer: a => String(a.customer_name || '').toLowerCase(), balance: 'account_balance', current: 'current_30',
      d31: 'days_31_60', d61: 'days_61_90', d90: 'over_90', unapplied: 'unapplied_credit' }[key];
    const val = typeof col === 'function' ? col : a => Number(a[col]) || 0;
    const rows = (this._arAgingRows || [])
      .filter(a => !q || [a.customer_name, a.business_name, a.customer_number, a.phone, a.email].some(v => String(v || '').toLowerCase().includes(q)))
      .sort((x, y) => { const p = val(x), r = val(y); return (p < r ? -1 : p > r ? 1 : 0) * (dir === 'asc' ? 1 : -1); });
    head.innerHTML = `<tr>${[['customer','Customer'],['balance','Balance'],['current','Current (0-30)'],['d31','31-60 Days'],['d61','61-90 Days'],['d90','90+ Days']]
      .map(([k, l]) => this._arSortTh(l, k, key, dir, `App._arAgingSort('${k}')`)).join('')}${this._arSortTh('Unapplied Payments', 'unapplied', key, dir, "App._arAgingSort('unapplied')")
      .replace('title="Sort by Unapplied Payments"', 'title="Payments received on account but not yet applied to the invoices aged here — click to sort"')}</tr>`;
    body.innerHTML = rows.length ? rows.map(a => `
      <tr>
        <td><div class="fw-600">${this.escapeAttr(a.customer_name)}</div><div style="font-size:11px;color:var(--text-muted)">${a.customer_number||''}${a.business_name ? ` · ${this.escapeAttr(a.business_name)}` : ''} ${this.escapeAttr(a.email||'')}</div></td>
        <td class="fw-600 color-danger">${this.fmt(a.account_balance||0)}</td>
        <td class="color-success">${this.fmt(a.current_30||0)}</td>
        <td class="${a.days_31_60 > 0 ? 'color-warning' : ''}">${this.fmt(a.days_31_60||0)}</td>
        <td class="${a.days_61_90 > 0 ? 'color-warning' : ''}">${this.fmt(a.days_61_90||0)}</td>
        <td class="${a.over_90 > 0 ? 'color-danger fw-600' : ''}">${this.fmt(a.over_90||0)}</td>
        <td class="${a.unapplied_credit > 0 ? 'color-success' : ''}">${a.unapplied_credit > 0 ? `−${this.fmt(a.unapplied_credit)}` : '—'}</td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty-state">${q ? 'No customers match that search' : 'No aging data'}</td></tr>`;
  },

  // Credit Accounts tab: filtered and sorted in the browser.
  _arAcctSearch(text) {
    this._arAcct.q = text.trim().toLowerCase();
    this._renderARAccounts();
  },
  _arAcctSort(key) {
    const a = this._arAcct;
    a.dir = a.key === key ? (a.dir === 'asc' ? 'desc' : 'asc') : (key === 'customer' ? 'asc' : 'desc');
    a.key = key;
    this._renderARAccounts();
  },
  _renderARAccounts() {
    const head = document.getElementById('ar-acct-head');
    const body = document.getElementById('ar-acct-body');
    if (!head || !body) return;
    const { q, key, dir } = this._arAcct;
    const avail = a => Math.max(0, (a.credit_limit || 0) - (a.account_balance || 0));
    const name = a => `${a.first_name || ''} ${a.last_name || ''}`.trim();
    const val = {
      customer: a => name(a).toLowerCase(), limit: a => a.credit_limit || 0, balance: a => a.account_balance || 0,
      invoiced: a => a.total_invoiced || 0, paid: a => a.total_paid || 0, available: avail,
    }[key];
    const rows = (this._arAccounts || [])
      .filter(a => !q || [name(a), a.business_name, a.customer_number, a.phone, a.email].some(v => String(v || '').toLowerCase().includes(q)))
      .sort((x, y) => { const p = val(x), r = val(y); return (p < r ? -1 : p > r ? 1 : 0) * (dir === 'asc' ? 1 : -1); });
    head.innerHTML = `<tr>${[['customer','Customer'],['limit','Credit Limit'],['balance','Balance'],['invoiced','Invoiced'],['paid','Paid'],['available','Available']]
      .map(([k, l]) => this._arSortTh(l, k, key, dir, `App._arAcctSort('${k}')`)).join('')}<th>Actions</th></tr>`;
    body.innerHTML = rows.length ? rows.map(a => {
      const pct = a.credit_limit > 0 ? Math.min(100, (a.account_balance / a.credit_limit) * 100) : 0;
      const color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--success)';
      return `<tr>
        <td><div class="fw-600">${this.escapeAttr(name(a))}</div><div style="font-size:11px;color:var(--text-muted)">${a.customer_number}${a.business_name ? ` · ${this.escapeAttr(a.business_name)}` : ''}</div></td>
        <td>${this.fmt(a.credit_limit||0)}</td>
        <td><div class="fw-600 color-danger">${this.fmt(a.account_balance||0)}</div><div class="aging-bar"><div class="aging-fill" style="width:${pct}%;background:${color}"></div></div></td>
        <td>${this.fmt(a.total_invoiced||0)}</td>
        <td>${this.fmt(a.total_paid||0)}</td>
        <td class="${avail(a) > 0 ? 'color-success' : 'color-danger'}">${this.fmt(avail(a))}</td>
        <td>
          ${this.can('accounts_writeoff') && a.account_balance > 0 ? `<button class="btn btn-sm btn-danger" onclick="App.showWriteoffModal(${a.id},'${this.escapeAttr(name(a)).replace(/'/g, "\\'")}',${a.account_balance||0})">Write Off</button>` : ''}
          <button class="btn btn-sm btn-secondary" onclick="App.viewCustomerAccount(${a.id})">Details</button>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="7" class="empty-state">${q ? 'No credit accounts match that search' : 'No credit accounts. Enable credit for a customer to get started.'}</td></tr>`;
  },

  showStatementModal(customerId, info) {
    const customer = (this._arCustomers || this._arAccounts || []).find(c => String(c.id) === String(customerId));
    const name = info?.name || (customer ? `${customer.first_name} ${customer.last_name}` : 'Customer');
    const email = info?.email ?? (customer ? (customer.email || '') : '');
    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = today.slice(0, 8) + '01';
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Account Statement &mdash; ${name}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div class="form-group" style="margin:0"><label>From Date</label><input type="date" id="stmt-start" value="${firstOfMonth}"></div>
            <div class="form-group" style="margin:0"><label>To Date</label><input type="date" id="stmt-end" value="${today}"></div>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:14px">
            <div class="form-group" style="margin:0"><label>Email To</label>
              <input type="email" id="stmt-email" value="${email}" placeholder="customer@email.com">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-outline" onclick="App._statementCsv(${customerId})">⬇ CSV</button>
          <button class="btn btn-outline" onclick="App._printStatement(${customerId})">&#128438; Print / PDF</button>
          <button class="btn btn-primary" onclick="App._emailStatement(${customerId})">&#9993; Send Email</button>
        </div>
      </div>`);
  },

  _statementCsv(customerId) {
    const params = new URLSearchParams();
    const start = document.getElementById('stmt-start').value, end = document.getElementById('stmt-end').value;
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    window.open(`/api/email/statement-csv/${customerId}?${params}`, '_blank');
  },

  // Statements for many customers in one printable document (one per page).
  showBatchStatementsModal() {
    const today = this._apToday();
    const q = this._arAcct?.q || '';
    const matching = q ? (this._arAccounts || []).filter(a => [`${a.first_name} ${a.last_name}`, a.business_name, a.customer_number, a.phone, a.email].some(v => String(v || '').toLowerCase().includes(q))) : [];
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Print Statements</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div class="form-group" style="margin:0"><label>From Date</label><input type="date" id="bstmt-start" value="${today.slice(0, 8)}01"></div>
            <div class="form-group" style="margin:0"><label>To Date</label><input type="date" id="bstmt-end" value="${today}"></div>
          </div>
          <div class="form-group"><label>Customers</label>
            <select id="bstmt-scope">
              <option value="balance">Credit customers with a balance</option>
              <option value="all">All credit customers</option>
              ${matching.length ? `<option value="search" selected>The ${matching.length} matching "${this.escapeAttr(q)}"</option>` : ''}
            </select>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin:0">Opens one document with a statement per page — print it, or choose <em>Save as PDF</em> in the print dialog.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App._printBatchStatements()">🖨 Print / PDF</button>
        </div>
      </div>`);
    this._batchStmtIds = matching.map(a => a.id);
  },
  _printBatchStatements() {
    const params = new URLSearchParams();
    const start = document.getElementById('bstmt-start').value, end = document.getElementById('bstmt-end').value;
    const scope = document.getElementById('bstmt-scope').value;
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    if (scope === 'search') params.set('ids', (this._batchStmtIds || []).join(','));
    else params.set('scope', scope);
    const win = window.open(`/api/email/statements-batch?${params}`, '_blank', 'width=900,height=750');
    if (win) win.addEventListener('load', () => win.print());
    this.closeModal();
  },

  _printStatement(customerId) {
    const start = document.getElementById('stmt-start').value;
    const end = document.getElementById('stmt-end').value;
    const params = new URLSearchParams();
    if (start) params.set('start', start);
    if (end)   params.set('end', end);
    const url = `/api/email/statement-preview/${customerId}?${params}`;
    const win = window.open(url, '_blank', 'width=820,height=700');
    win.addEventListener('load', () => win.print());
  },

  async _emailStatement(customerId) {
    const to = (document.getElementById('stmt-email').value || '').trim();
    const start = document.getElementById('stmt-start').value;
    const end = document.getElementById('stmt-end').value;
    if (!to) { this.alert('Enter a recipient email address', 'error'); return; }
    try {
      await this.api('POST', `/email/send-statement/${customerId}`, { to, start: start||undefined, end: end||undefined });
      this.closeModal();
      this.alert(`Statement sent to ${to}`);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _togglePaymentAllocs(paymentId, btn) {
    const row = document.getElementById(`pmt-allocs-${paymentId}`);
    if (!row) return;
    if (row.style.display !== 'none') {
      row.style.display = 'none';
      btn.innerHTML = '&#9654;';
      return;
    }
    btn.innerHTML = '&#9660;';
    row.style.display = '';
    const cell = row.querySelector('td');
    cell.innerHTML = '<em style="color:var(--text-muted);font-size:12px;padding:8px 0;display:block">Loading...</em>';
    try {
      const allocs = await this.api('GET', `/accounts/payments/${paymentId}/allocations`);
      if (!allocs.length) {
        cell.innerHTML = '<em style="color:var(--text-muted);font-size:12px;padding:8px 0;display:block">No invoice allocations recorded for this payment.</em>';
        return;
      }
      cell.innerHTML = `
        <div style="padding:8px 0 12px">
          <table style="width:auto">
            <thead><tr>
              <th style="font-size:11px">Invoice</th>
              <th style="font-size:11px">Invoice Date</th>
              <th style="font-size:11px">Invoice Total</th>
              <th style="font-size:11px">Applied</th>
            </tr></thead>
            <tbody>
              ${allocs.map(a => `<tr>
                <td style="font-size:12px">${a.legacy_invoice_id ? `<span class="fw-600">${this.escapeAttr(a.transaction_number)}</span> <span class="badge-pill badge-secondary" style="font-size:10px">Legacy</span>` : `<a href="#" class="fw-600" style="color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.viewTransaction(${a.transaction_id})">${a.transaction_number}</a>`}</td>
                <td style="font-size:12px;color:var(--text-muted)">${a.legacy_invoice_id ? this._apDate(a.invoice_date) : this.fmtDate(a.invoice_date)}</td>
                <td style="font-size:12px">${this.fmt(a.invoice_total)}</td>
                <td class="fw-600 color-success" style="font-size:12px">${this.fmt(a.amount)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch(e) {
      cell.innerHTML = '<em style="color:var(--danger);font-size:12px;padding:8px 0;display:block">Failed to load allocations.</em>';
    }
  },

  _arFilterCustomers(text) {
    const dd = document.getElementById('ar-cust-dd');
    if (!dd) return;
    const q = text.trim().toLowerCase();
    if (!q) {
      dd.style.display = 'none';
      if (this._arCustomerId) this._loadARPayments('');
      return;
    }
    const matches = (this._arCustomers || []).filter(c =>
      `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
      (c.business_name || '').toLowerCase().includes(q) ||
      (c.customer_number || '').toLowerCase().includes(q)
    ).slice(0, 12);
    if (!matches.length) {
      dd.innerHTML = '<div style="padding:8px 12px;color:var(--text-muted);font-size:13px">No customers found</div>';
    } else {
      dd.innerHTML = matches.map(c => `
        <div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)"
          onmouseover="this.style.background='var(--hover,rgba(0,0,0,.06))'" onmouseout="this.style.background=''"
          onmousedown="App._arSelectCustomer('${c.id}')">
          ${c.first_name} ${c.last_name}${c.customer_number ? ` <small style="color:var(--text-muted)">${c.customer_number}</small>` : ''}
        </div>`).join('');
    }
    dd.style.display = '';
  },

  _arSelectCustomer(customerId) {
    const dd = document.getElementById('ar-cust-dd');
    if (dd) dd.style.display = 'none';
    this._loadARPayments(customerId);
  },

  showARTab(btn, tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['ar-list','ar-aging','ar-payments'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = id === tabId ? '' : 'none';
    });
  },

  // Forgives part or all of a balance instead of collecting it — same
  // FIFO-oldest-first invoice allocation as Record Payment, minus the
  // invoice-by-invoice override table (kept deliberately simpler, since a
  // write-off is a rarer, blunter action than a normal payment).
  showWriteoffModal(customerId, customerName, balance) {
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Write Off Balance</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="margin-bottom:14px;font-size:13px">Writing off balance for <strong>${customerName}</strong> &nbsp;|&nbsp; Outstanding Balance: <strong style="color:var(--danger)">${this.fmt(balance)}</strong></p>
          <div class="form-group"><label>Amount to Write Off *</label><input id="wo-amount" type="number" step="0.01" min="0.01" max="${balance.toFixed(2)}" value="${balance.toFixed(2)}"></div>
          <div class="form-group"><label>Reason *</label><textarea id="wo-reason" rows="3" placeholder="Why this balance is being written off (uncollectible, dispute resolved in customer's favor, etc.)"></textarea></div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:-4px">Applied to the oldest outstanding invoices first, same as a normal payment — this doesn't collect any money, it forgives it.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App.saveWriteoff(${customerId})">Write Off</button>
        </div>
      </div>`);
  },

  async saveWriteoff(customerId) {
    const amount = parseFloat(document.getElementById('wo-amount').value);
    const reason = document.getElementById('wo-reason').value.trim();
    if (!amount || amount <= 0) { this.alert('Enter a valid amount', 'error'); return; }
    if (!reason) { this.alert('A reason is required', 'error'); return; }
    try {
      await this.api('POST', '/accounts/writeoff', { customer_id: customerId, amount, reason, employee_id: this.currentUser.id });
      this.closeModal();
      this.alert('Balance written off');
      this.renderAccounts();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showEnableCreditModal() {
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">Enable Credit Account</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Customer *</label>
            ${this._customerPickerHtml('ec-cust', [], null, { remote: '&credit_enabled=0' })}
          </div>
          <div class="form-group"><label>Credit Limit ($)</label><input id="ec-limit" type="number" step="0.01" value="1000.00"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.enableCredit()">Enable Credit</button>
        </div>
      </div>`);
  },

  async enableCredit() {
    const customer_id = document.getElementById('ec-cust').value;
    const credit_limit = parseFloat(document.getElementById('ec-limit').value) || 0;
    if (!customer_id) { this.alert('Select a customer', 'error'); return; }
    try {
      await this.api('PATCH', `/accounts/customer/${customer_id}`, { credit_enabled: true, credit_limit });
      this.closeModal();
      this.alert('Credit account enabled');
      this.renderAccounts();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async viewCustomerAccount(customerId) {
    const data = await this.api('GET', `/accounts/customer/${customerId}`);
    const c = data.customer;
    this.showModal(`
      <div class="modal" style="max-width:1000px">
        <div class="modal-header"><span class="modal-title">${this.escapeAttr(`${c.first_name} ${c.last_name}`)} — Account</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="two-col" style="margin-bottom:14px;font-size:13px">
            <div><strong>Credit Limit:</strong> ${this.fmt(c.credit_limit||0)}<br><strong>Outstanding:</strong> <span class="color-danger">${this.fmt(c.account_balance||0)}</span><br><strong>Available:</strong> <span class="color-success">${this.fmt(Math.max(0,(c.credit_limit||0)-(c.account_balance||0)))}</span></div>
            <div><strong>Phone:</strong> ${c.phone||'-'}<br><strong>Email:</strong> ${c.email||'-'}</div>
          </div>
          <div class="tab-bar" style="margin-bottom:10px">
            <button class="tab-btn active" onclick="App.showModalTab(this,'acct-inv')">Invoice Detail</button>
            <button class="tab-btn" onclick="App.showModalTab(this,'acct-pmts')">Payments (${data.payments.length})</button>
            ${(data.legacy_invoices || []).length ? `<button class="tab-btn" onclick="App.showModalTab(this,'acct-legacy')">Legacy Invoices (${data.legacy_invoices.length})</button>` : ''}
          </div>
          <div id="acct-inv">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;margin:0;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:500;color:var(--text);white-space:nowrap;width:auto"><input type="checkbox" id="ard-all" style="width:16px;height:16px;margin:0" onchange="App._loadARDetail(${c.id})"> Include paid invoices</label>
              <span style="margin-left:auto"></span>
              <button class="btn btn-sm btn-primary" onclick="App.showStatementModal(${c.id}, ${this.escapeAttr(JSON.stringify({ name: `${c.first_name} ${c.last_name}`, email: c.email || '' }))})">📄 Statement</button>
              <button class="btn btn-sm btn-outline" onclick="App._printARDetail(${c.id})">🖨 Print Detail</button>
              <button class="btn btn-sm btn-outline" onclick="App._emailARDetail(${c.id}, '${this.escapeAttr(c.email || '').replace(/'/g, "\\'")}')">✉ Email Detail</button>
            </div>
            <div id="ard-body"><div class="empty-state"><p>Loading...</p></div></div>
          </div>
          <div id="acct-pmts" style="display:none">
            <div class="table-wrap"><table>
              <thead><tr><th>Payment #</th><th>Amount</th><th>Method</th><th>Applied To</th><th>Date</th></tr></thead>
              <tbody>${data.payments.map(p => `<tr><td class="fw-600">${p.payment_number}</td><td class="color-success">${this.fmt(p.amount)}${p.unapplied > 0.005 ? `<div style="font-size:11px;color:var(--text-muted)">${this.fmt(p.unapplied)} on account, not yet applied</div>` : ''}</td><td>${p.payment_method === 'credit_note' ? '<span class="badge-pill badge-purple" style="font-size:10px">Credit note</span>' : p.payment_method}${p.reference ? `<div style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(p.reference)}</div>` : ''}</td><td>${(p.applied_to || '').replace(/,\s*$/, '').trim() ? `<span style="font-size:12px">${this.escapeAttr(p.applied_to.trim())}</span>` : `<span style="font-size:12px;color:var(--text-muted)">${p.payment_method === 'writeoff' ? '—' : 'Not applied yet'}</span>`}</td><td>${this.fmtDate(p.created_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No payments</td></tr>'}</tbody>
            </table></div>
          </div>
          ${(data.legacy_invoices || []).length ? `<div id="acct-legacy" style="display:none">
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Invoices carried over from the old system, entered by the accounts team in RetailPOS Books. Payments apply to them like any other invoice.</p>
            <div class="table-wrap"><table>
              <thead><tr><th>Old Invoice #</th><th>Date</th><th>Due</th><th>Amount</th><th>Balance Due</th><th>Status</th></tr></thead>
              <tbody>${data.legacy_invoices.map(i => `<tr><td class="fw-600">${this.escapeAttr(i.invoice_number)}</td><td>${this._apDate(i.invoice_date)}</td><td>${this._apDate(i.due_date)}</td><td>${this.fmt(i.amount)}</td><td class="${i.status === 'open' && i.balance_due > 0.001 ? 'color-danger fw-600' : ''}">${i.status === 'void' ? '—' : this.fmt(i.balance_due)}</td><td><span class="badge-pill ${i.status === 'void' ? 'badge-secondary' : i.balance_due > 0.001 ? 'badge-danger' : 'badge-success'}">${i.status === 'void' ? 'void' : i.balance_due > 0.001 ? (i.balance_due < i.amount ? 'partial' : 'open') : 'paid'}</span></td></tr>`).join('')}</tbody>
            </table></div>
          </div>` : ''}
        </div>
        <div class="modal-footer">
          <span style="font-size:12px;color:var(--text-muted);margin-right:auto">Payments are received at the POS (Receive Payment).</span>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
    this._loadARDetail(c.id);
  },

  // Invoice-by-invoice account detail (GET /accounts/customer/:id/detail):
  // each invoice's due date, age, P.O. #, and the payments / credit notes /
  // write-offs applied to it, then credits still on account.
  async _loadARDetail(customerId) {
    const el = document.getElementById('ard-body');
    if (!el) return;
    const all = document.getElementById('ard-all')?.checked;
    let d;
    try { d = await this.api('GET', `/accounts/customer/${customerId}/detail?as_of=${this._apToday()}${all ? '&all=1' : ''}`); }
    catch (e) { el.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    const t = d.totals;
    const pct = n => t.open_invoices > 0 ? `${Math.round(n / t.open_invoices * 100)}%` : '';
    const tile = (label, v, sub, color) => `<div style="border:1px solid var(--border);border-radius:6px;padding:6px 10px;text-align:right;min-width:110px"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">${label}</div><div class="fw-600" style="${color ? `color:${color}` : ''}">${v}</div>${sub ? `<div style="font-size:10px;color:var(--text-muted)">${sub}</div>` : ''}</div>`;
    const typeBadge = { P: ['Payment', 'badge-success'], C: ['Credit note', 'badge-purple'], W: ['Write-off', 'badge-secondary'] };
    const dt = v => this._apDate(v);
    const status = i => i.balance_due <= 0.005 ? ['Paid', 'badge-success'] : i.days_past_due > 0 ? [`Overdue ${i.days_past_due}d`, 'badge-danger'] : i.balance_due < i.amount - 0.005 ? ['Partial', 'badge-warning'] : ['Open', 'badge-info'];
    el.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        ${tile('Balance', this.fmt(t.balance), '', 'var(--danger)')}
        ${tile('Current', this.fmt(t.aging.current), pct(t.aging.current))}
        ${tile('31–60 days', this.fmt(t.aging.d31_60), pct(t.aging.d31_60))}
        ${tile('61–90 days', this.fmt(t.aging.d61_90), pct(t.aging.d61_90))}
        ${tile('Over 90 days', this.fmt(t.aging.over_90), pct(t.aging.over_90), t.aging.over_90 > 0 ? 'var(--danger)' : '')}
        ${tile('Unapplied credits', t.unapplied > 0 ? `−${this.fmt(t.unapplied)}` : '—', '', t.unapplied > 0 ? 'var(--success)' : '')}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Terms ${d.customer.terms_days} days · Last payment: ${d.last_payment ? `${this.fmt(d.last_payment.amount)} on ${dt(d.last_payment.date)} (${d.last_payment.number})` : 'none'}</div>
      <div class="table-wrap"><table style="font-size:13px">
        <thead><tr><th>Invoice #</th><th>Date</th><th>Due</th><th>P.O. # / Ref</th><th style="text-align:right">Amount</th><th style="text-align:right">Age</th><th style="text-align:right">Balance Due</th><th>Status</th></tr></thead>
        <tbody>
          ${d.invoices.map(i => { const [sl, sc] = status(i); return `
            <tr style="background:var(--bg-secondary,#f8f9fa)">
              <td class="fw-600">${i.kind === 'legacy' ? `${this.escapeAttr(i.number)} <span class="badge-pill badge-secondary" style="font-size:10px">Legacy</span>` : `<a href="#" style="color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.viewTransaction(${i.id})">${this.escapeAttr(i.number)}</a>${i.kind === 'store_credit' ? ' <span class="badge-pill badge-purple" style="font-size:10px">Store credit used</span>' : ''}`}</td>
              <td>${dt(i.date)}</td><td>${dt(i.due_date)}</td>
              <td>${i.reference ? this.escapeAttr(i.reference) : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td style="text-align:right">${this.fmt(i.amount)}</td>
              <td style="text-align:right">${i.age_days}d</td>
              <td style="text-align:right" class="fw-600 ${i.balance_due > 0.005 ? 'color-danger' : ''}">${this.fmt(i.balance_due)}</td>
              <td><span class="badge-pill ${sc}" style="font-size:10px">${sl}</span></td>
            </tr>
            ${i.applied.map(a => `<tr style="color:var(--text-muted)">
              <td style="padding-left:24px">↳ ${this.escapeAttr(a.number)}</td>
              <td>${dt(a.date)}</td>
              <td colspan="2"><span class="badge-pill ${typeBadge[a.type][1]}" style="font-size:10px">${typeBadge[a.type][0]}</span>${a.type === 'P' ? ` <span style="font-size:11px">${this.escapeAttr(String(a.method || '').replace(/_/g, ' '))}</span>` : ''}${a.reference ? ` <span style="font-size:11px">· ${this.escapeAttr(a.reference)}</span>` : ''}</td>
              <td style="text-align:right;color:${a.type === 'C' ? 'var(--purple,#7c3aed)' : 'var(--success)'}">−${this.fmt(a.amount)}</td>
              <td colspan="3"></td>
            </tr>`).join('')}`; }).join('') || `<tr><td colspan="8" class="empty-state">${all ? 'No invoices' : 'No open invoices'}</td></tr>`}
          ${d.unapplied.length ? `<tr><td colspan="8" style="padding-top:14px;font-weight:600;font-size:12px">On account — not yet applied to an invoice</td></tr>
            ${d.unapplied.map(u => `<tr>
              <td class="fw-600">${this.escapeAttr(u.number)}</td><td>${dt(u.date)}</td>
              <td colspan="2"><span class="badge-pill ${typeBadge[u.type][1]}" style="font-size:10px">${typeBadge[u.type][0]}</span>${u.reference ? ` <span style="font-size:11px;color:var(--text-muted)">${this.escapeAttr(u.reference)}</span>` : ''}</td>
              <td style="text-align:right">${this.fmt(u.amount)}</td><td style="text-align:right">${u.age_days}d</td>
              <td style="text-align:right" class="fw-600 color-success">−${this.fmt(u.unapplied)}</td><td></td>
            </tr>`).join('')}` : ''}
        </tbody>
      </table></div>
      <div style="text-align:right;font-weight:700;margin-top:8px">Open document balance: ${this.fmt(t.balance)}</div>
      ${Math.abs(t.balance - (d.customer.account_balance || 0)) > 0.01 ? `<p style="font-size:11px;color:var(--text-muted);text-align:right;margin:2px 0 0">Account balance on file: ${this.fmt(d.customer.account_balance || 0)}</p>` : ''}`;
  },
  _printARDetail(customerId) {
    const all = document.getElementById('ard-all')?.checked;
    const win = window.open(`/api/email/aging-detail-preview/${customerId}${all ? '?all=1' : ''}`, '_blank', 'width=1100,height=750');
    if (win) win.addEventListener('load', () => win.print());
  },
  async _emailARDetail(customerId, email) {
    const to = prompt('Email the account detail to:', email || '');
    if (to == null) return;
    if (!to.trim()) { this.alert('Enter a recipient email address', 'error'); return; }
    try {
      await this.api('POST', `/email/send-aging-detail/${customerId}`, { to: to.trim(), all: !!document.getElementById('ard-all')?.checked });
      this.alert(`Account detail sent to ${to.trim()}`);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  showModalTab(btn, tabId) {
    const modal = btn.closest('.modal');
    modal.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    modal.querySelectorAll('[id^="acct-"]').forEach(el => { el.style.display = el.id === tabId ? '' : 'none'; });
  },

});
