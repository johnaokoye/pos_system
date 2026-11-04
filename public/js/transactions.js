// Transactions screen and online orders.
Object.assign(App, {
  // ─── Transactions ─────────────────────────────────────────
  async renderTransactions() {
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
    const branches = this.currentUser.branches || [];
    // A sales manager can filter by who rang a sale up / who it's credited
    // to and change the credit (one sale or a selection).
    const spManager = this.can('sales_manager');
    const [txs, employees] = await Promise.all([
      this.api('GET', `/transactions?start=${weekAgo}&end=${today}`),
      spManager ? this.api('GET', '/employees').catch(() => []) : [],
    ]);
    if (this.section !== 'transactions') return;
    this._txEmployees = employees;
    const empOptions = employees.map(e => `<option value="${e.id}">${this.escapeAttr(`${e.first_name} ${e.last_name}`.trim())}${e.active ? '' : ' (inactive)'}</option>`).join('');

    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Transactions ${this.currentUser.is_salesperson ? '<span style="font-size:12px;font-weight:normal;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;padding:2px 8px;margin-left:8px;vertical-align:middle">My Sales Only</span>' : ''}</h2>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <select id="tx-view" style="width:170px" onchange="App._txViewChanged()" title="Sales, the returns made against them, or payments received on customer accounts">
            <option value="sales">Sales</option>
            <option value="returns">Returns</option>
            <option value="payments">Customer Payments</option>
          </select>
          <label style="font-size:13px;text-transform:none;color:var(--text)">From</label>
          <input type="date" id="tx-start" value="${weekAgo}" style="width:150px">
          <label style="font-size:13px;text-transform:none;color:var(--text)">To</label>
          <input type="date" id="tx-end" value="${today}" style="width:150px">
          <select id="tx-branch" style="width:160px">
            <option value="">All Branches</option>
            ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
          <select id="tx-status" style="width:130px">
            <option value="">All Status</option>
            <option value="completed">Completed</option>
            <option value="voided">Voided</option>
          </select>
          <select id="tx-source" style="width:145px">
            <option value="">All Orders</option>
            <option value="online">Online Orders</option>
            <option value="pos">In-Store (POS)</option>
          </select>
          <input type="text" id="tx-number" placeholder="Tx # search…" style="width:150px">
          <input type="text" id="tx-customer" placeholder="Customer name…" style="width:160px">
          ${spManager ? `<select id="tx-cashier" style="width:160px" title="Who rang the sale up">
            <option value="">Any Cashier</option>${empOptions}
          </select>
          <select id="tx-credited" style="width:170px" title="Who the sale counts for (sales targets)">
            <option value="">Any Salesperson</option>${empOptions}
          </select>` : ''}
          <button class="btn btn-primary" onclick="App.loadTransactions()">Search</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap" id="tx-table">${this.buildTxTable(txs)}</div>
      </div>`;
  },

  // ─── Online Orders Dashboard ───────────────────────────────────────────────

  async renderOnlineOrders() {
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const [txs, settingRows] = await Promise.all([
      this.api('GET', `/transactions?source=online&start=${weekAgo}&end=${today}`),
      this.api('GET', '/settings').catch(() => [])
    ]);
    if (this.section !== 'online-orders') return;
    this._onlineCompanyName = (Array.isArray(settingRows) ? settingRows : []).find(s => s.key==='company_name')?.value || 'Store';
    const todayTxs = txs.filter(t => t.created_at && t.created_at.slice(0,10) === today);
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Online Orders</h2>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <label style="font-size:13px;text-transform:none;color:var(--text)">From</label>
          <input type="date" id="oo-start" value="${weekAgo}" style="width:150px">
          <label style="font-size:13px;text-transform:none;color:var(--text)">To</label>
          <input type="date" id="oo-end" value="${today}" style="width:150px">
          <select id="oo-fulfillment" style="width:155px">
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input type="text" id="oo-customer" placeholder="Customer name…" style="width:160px">
          <input type="text" id="oo-txnum" placeholder="Order # search…" style="width:150px">
          <button class="btn btn-primary" onclick="App.loadOnlineOrders()">Search</button>
        </div>
      </div>
      <div id="oo-stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px">
        ${this.buildOnlineOrdersStats(todayTxs, true)}
      </div>
      <div class="card">
        <div class="table-wrap" id="oo-table">${this.buildOnlineOrdersTable(txs)}</div>
      </div>`;
  },

  // `isDefault` labels the revenue/count cards as "Today's ..." (the
  // unfiltered landing view); once the user runs a Search, loadOnlineOrders()
  // passes false so the same cards read as filtered totals instead — the
  // status-count cards always reflect whatever `txs` was actually passed in.
  buildOnlineOrdersStats(txs, isDefault) {
    const revenue = txs.reduce((s,t)=>s+(t.total||0),0);
    const cnt = st => txs.filter(t=>(t.fulfillment_status||'pending')===st).length;
    return [
      {label:isDefault ? "Today's Revenue" : 'Revenue (Filtered)', val:this.fmt(revenue), color:'var(--primary)'},
      {label:isDefault ? "Today's Orders" : 'Orders (Filtered)',   val:txs.length,         color:'var(--primary)'},
      {label:'Pending',         val:cnt('pending'),          color:'#f59e0b'},
      {label:'Processing',      val:cnt('processing'),       color:'#3b82f6'},
      {label:'Shipped',         val:cnt('shipped'),          color:'#8b5cf6'},
      {label:'Delivered',       val:cnt('delivered'),        color:'#22c55e'},
    ].map(s=>`<div class="card" style="padding:16px;text-align:center">
      <div style="font-size:22px;font-weight:700;color:${s.color}">${s.val}</div>
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-top:3px">${s.label}</div>
    </div>`).join('');
  },

  buildOnlineOrdersTable(txs) {
    if (!txs.length) return '<div class="empty-state"><p>No online orders found</p></div>';
    const sc = {pending:'#f59e0b',processing:'#3b82f6',shipped:'#8b5cf6',delivered:'#22c55e',cancelled:'#ef4444'};
    return `<table>
      <thead><tr><th>Order #</th><th>Date/Time</th><th>Customer</th><th>Branch</th><th>Total</th><th>Payment</th><th>Fulfillment</th><th>Actions</th></tr></thead>
      <tbody>${txs.map(tx => {
        const st = tx.fulfillment_status || 'pending';
        const c = sc[st] || '#888';
        return `<tr>
          <td class="fw-600" style="font-family:monospace">${tx.transaction_number}<br><span style="font-size:10px;background:#6366f1;color:#fff;border-radius:3px;padding:1px 5px;font-family:sans-serif;font-weight:500;letter-spacing:.3px">ONLINE</span></td>
          <td style="white-space:nowrap">${this.fmtDateTime(tx.created_at)}</td>
          <td>${tx.customer_name||'<em style="color:#999">Walk-in</em>'}</td>
          <td style="font-size:12px;color:var(--text-muted)">${tx.branch_name||'—'}</td>
          <td class="fw-600">${this.fmt(tx.total)}</td>
          <td><span class="badge-pill badge-info">${tx.payment_method.replace('_',' ')}</span></td>
          <td><span style="display:inline-block;background:${c}22;color:${c};border:1px solid ${c}55;border-radius:12px;padding:2px 10px;font-size:11px;font-weight:600;text-transform:capitalize">${st}</span></td>
          <td style="white-space:nowrap">
            <button class="btn btn-secondary btn-sm" onclick="App.viewOnlineOrder(${tx.id})">View</button>
            <button class="btn btn-sm" style="background:#0ea5e9;color:#fff;border:none;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;margin-left:3px" onclick="App.printLabel(${tx.id},'pickup')">🏪 Pickup</button>
            <button class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;margin-left:3px" onclick="App.printLabel(${tx.id},'shipping')">📦 Ship</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  },

  async loadOnlineOrders() {
    const start = document.getElementById('oo-start').value;
    const end = document.getElementById('oo-end').value;
    const fulfillment = document.getElementById('oo-fulfillment').value;
    const customer = document.getElementById('oo-customer').value.trim();
    const txnum = document.getElementById('oo-txnum').value.trim();
    let url = `/transactions?source=online&start=${start}&end=${end}`;
    if (fulfillment) url += `&fulfillment_status=${encodeURIComponent(fulfillment)}`;
    if (customer) url += `&customer_name=${encodeURIComponent(customer)}`;
    if (txnum) url += `&transaction_number=${encodeURIComponent(txnum)}`;
    const txs = await this.api('GET', url);
    const ooTable = document.getElementById('oo-table');
    if (ooTable) ooTable.innerHTML = this.buildOnlineOrdersTable(txs);
    const ooStats = document.getElementById('oo-stats');
    if (ooStats) ooStats.innerHTML = this.buildOnlineOrdersStats(txs, false);
  },

  async viewOnlineOrder(id) {
    const tx = await this.api('GET', `/transactions/${id}`);
    const sc = {pending:'#f59e0b',processing:'#3b82f6',shipped:'#8b5cf6',delivered:'#22c55e',cancelled:'#ef4444'};
    const st = tx.fulfillment_status || 'pending';
    const c = sc[st] || '#888';
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <span class="modal-title"><span style="background:#6366f1;color:#fff;border-radius:3px;padding:2px 7px;font-weight:600;font-size:11px;letter-spacing:.3px;margin-right:8px">ONLINE</span>Order ${tx.transaction_number}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div style="background:#eef2ff;border:1px solid #c7d2fe;border-left:3px solid #6366f1;border-radius:6px;padding:12px;margin-bottom:14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
              <span style="color:var(--text-muted);font-size:12px">Fulfillment:</span>
              <span style="background:${c}22;color:${c};border:1px solid ${c}55;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600;text-transform:capitalize">${st}</span>
              <span style="font-size:12px;color:var(--text-muted);margin-left:auto">${tx.source==='woocommerce'?'Imported from WooCommerce':'Placed via ecommerce site'}${tx.notes?` · ${tx.notes}`:''}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="color:var(--text-muted);font-size:12px;white-space:nowrap">Update to:</span>
              <select id="fulfillment-status-select" style="flex:1;font-size:12px;padding:3px 6px">
                ${['pending','processing','shipped','delivered','cancelled'].map(s=>`<option value="${s}" ${st===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
              </select>
              <button class="btn btn-primary btn-sm" onclick="App.updateFulfillmentOnline(${tx.id})">Update</button>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;font-size:13px">
            <div><span style="color:var(--text-muted)">Date:</span> ${this.fmtDateTime(tx.created_at)}</div>
            <div><span style="color:var(--text-muted)">Status:</span> <span class="badge-pill ${tx.status==='completed'?'badge-success':'badge-danger'}">${tx.status}</span></div>
            <div><span style="color:var(--text-muted)">Customer:</span> ${tx.customer_name||'Walk-in'}</div>
            ${tx.customer_email?`<div><span style="color:var(--text-muted)">Email:</span> ${tx.customer_email}</div>`:''}
            ${tx.customer_phone?`<div><span style="color:var(--text-muted)">Phone:</span> ${tx.customer_phone}</div>`:''}
            ${tx.customer_address?`<div style="grid-column:1/-1"><span style="color:var(--text-muted)">Ship to:</span> ${tx.customer_address}${tx.customer_city?', '+tx.customer_city:''}${tx.customer_state?' '+tx.customer_state:''}${tx.customer_zip?' '+tx.customer_zip:''}</div>`:''}
            <div><span style="color:var(--text-muted)">Branch:</span> ${tx.branch_name||'—'}</div>
            <div><span style="color:var(--text-muted)">Payment:</span> ${tx.payment_method.replace('_',' ')}</div>
          </div>
          <table style="margin-bottom:12px">
            <thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>${(tx.items||[]).map(i=>i.is_comment ? `<tr><td colspan="5" style="font-style:italic;white-space:pre-wrap;color:var(--text-muted)"><span class="badge-pill badge-info" style="font-size:10px;font-style:normal">C</span> ${this.escapeAttr(i.product_name)}</td></tr>` : `<tr><td>${i.product_name}</td><td style="font-family:monospace;font-size:12px">${i.sku||''}</td><td style="text-align:center">${i.quantity}</td><td>${this.fmt(i.unit_price)}</td><td class="fw-600">${this.fmt(i.total)}</td></tr>`).join('')}</tbody>
          </table>
          <div style="text-align:right;border-top:1px solid var(--border);padding-top:10px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>Subtotal</span><span>${this.fmt(tx.subtotal)}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>Tax</span><span>${this.fmt(tx.tax_amount)}</span></div>
            ${tx.discount_amount>0?`<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;color:var(--success)"><span>Discount${tx.promotion_name?' — '+tx.promotion_name:''}${tx.promotion_code?` <span style="font-family:monospace;font-size:11px;background:var(--bg);padding:1px 5px;border-radius:4px">${tx.promotion_code}</span>`:''}</span><span>-${this.fmt(tx.discount_amount)}</span></div>`:''}
            <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;margin-top:6px"><span>TOTAL</span><span>${this.fmt(tx.total)}</span></div>
          </div>
        </div>
        <div class="modal-footer" style="gap:6px;flex-wrap:wrap">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-secondary" onclick="App.emailReceipt(${tx.id},'${(tx.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email</button>
          ${tx.status==='completed'&&!tx.rental_agreement_number&&!tx.work_order_number&&this.can('transactions_returns')?`<button class="btn btn-sm" style="background:#f59e0b;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-weight:600;cursor:pointer" onclick="App.closeModal();App.processReturn(${tx.id})">↩ Return</button>`:''}
          <button class="btn btn-sm" style="background:#0ea5e9;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-weight:600;cursor:pointer" onclick="App.printLabel(${tx.id},'pickup')">🏪 Pickup Label</button>
          <button class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-weight:600;cursor:pointer" onclick="App.printLabel(${tx.id},'shipping')">📦 Shipping Label</button>
        </div>
      </div>`);
    this._viewTx = tx;
  },

  async updateFulfillmentOnline(txId) {
    const sel = document.getElementById('fulfillment-status-select');
    if (!sel) return;
    const status = sel.value;
    try {
      await this.api('PATCH', `/transactions/${txId}/fulfillment`, { fulfillment_status: status });
      this.alert(`Fulfillment updated to "${status}"`);
      this.viewOnlineOrder(txId);
      this.loadOnlineOrders().catch(()=>{});
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async printLabel(txId, type) {
    const tx = await this.api('GET', `/transactions/${txId}`);
    const company = this._onlineCompanyName || 'Store';
    const items = (tx.items||[]).filter(i => !i.is_comment).map(i=>`${i.quantity}× ${i.product_name}`).join('<br>');
    const dt = this.fmtDateTime(tx.created_at);
    const addrLine = [tx.customer_address, tx.customer_city && (tx.customer_city+(tx.customer_state?' '+tx.customer_state:'')+(tx.customer_zip?' '+tx.customer_zip:''))].filter(Boolean).join('<br>');

    const base = `body{margin:0;padding:0;font-family:'Courier New',monospace}
      .lbl{width:4in;padding:.3in;border:2px solid #000;margin:.25in auto;box-sizing:border-box}
      hr{border:none;border-top:1px dashed #000;margin:.15in 0}
      @media print{body{margin:0}}`;

    let html;
    if (type === 'shipping') {
      html = `<!DOCTYPE html><html><head><title>Shipping Label</title><style>${base}
        .from{font-size:11px;color:#555}.from-name{font-size:14px;font-weight:bold;color:#000}
        .to-hdr{font-size:11px;font-weight:bold;letter-spacing:2px;border-bottom:1px solid #000;padding-bottom:4px;margin:.15in 0 .1in}
        .cname{font-size:20px;font-weight:bold;margin-bottom:4px}
        .addr{font-size:13px;line-height:1.6;color:#333}
        .onum{font-size:22px;font-weight:bold;letter-spacing:1px;margin-bottom:4px}
        .odate{font-size:11px;color:#666;margin-bottom:.1in}
        .ilbl{font-size:11px;font-weight:bold;letter-spacing:2px;margin-bottom:6px}
        .ilist{font-size:13px;line-height:1.7}
        .total{font-size:16px;font-weight:bold;margin-top:.1in}
        .barzone{border:1px solid #ccc;height:.45in;display:flex;align-items:center;justify-content:center;font-size:11px;color:#aaa;margin-top:.15in;letter-spacing:5px}
      </style></head><body><div class="lbl">
        <div class="from"><div class="from-name">${company}</div>FROM: Online Store</div>
        <div class="to-hdr">Ship To</div>
        <div class="cname">${tx.customer_name||'Customer'}</div>
        <div class="addr">${addrLine||'<em style="color:#aaa">No address on file</em>'}${tx.customer_phone?'<br>Tel: '+tx.customer_phone:''}</div>
        <hr>
        <div class="onum">ORDER: ${tx.transaction_number}</div>
        <div class="odate">${dt}</div>
        <hr>
        <div class="ilbl">Items</div>
        <div class="ilist">${items}</div>
        <hr>
        <div class="total">TOTAL: ${this.fmt(tx.total)}</div>
        <div class="barzone">${tx.transaction_number}</div>
      </div><script>window.onload=()=>{window.print();}<\/script></body></html>`;
    } else {
      const code = tx.transaction_number.replace(/^TXN-0*/,'');
      html = `<!DOCTYPE html><html><head><title>Pickup Label</title><style>${base}
        .phdr{background:#000;color:#fff;text-align:center;padding:10px;font-size:16px;font-weight:bold;letter-spacing:3px;margin:-.3in -.3in .2in}
        .onum{font-size:28px;font-weight:bold;text-align:center;letter-spacing:2px;margin:.1in 0}
        .cname{font-size:18px;font-weight:bold;margin-bottom:2px}
        .phone{font-size:13px;color:#444;margin-bottom:.1in}
        .slbl{font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;color:#666}
        .ilist{font-size:13px;line-height:1.7}
        .total{font-size:16px;font-weight:bold;text-align:right;margin-top:.1in}
        .cbox{border:3px solid #000;text-align:center;padding:10px;margin-top:.15in}
        .clbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#666}
        .ccode{font-size:36px;font-weight:bold;letter-spacing:8px}
        .foot{font-size:11px;color:#666;margin-top:.1in;text-align:center}
      </style></head><body><div class="lbl">
        <div class="phdr">IN-STORE PICKUP</div>
        <div class="onum">${tx.transaction_number}</div>
        <hr>
        <div class="slbl">Customer</div>
        <div class="cname">${tx.customer_name||'Customer'}</div>
        ${tx.customer_phone?`<div class="phone">${tx.customer_phone}</div>`:''}
        <hr>
        <div class="slbl">Items</div>
        <div class="ilist">${items}</div>
        <div class="total">TOTAL: ${this.fmt(tx.total)}</div>
        <div class="cbox"><div class="clbl">Pickup Code</div><div class="ccode">${code}</div></div>
        <div class="foot">Ordered: ${dt}</div>
      </div><script>window.onload=()=>{window.print();}<\/script></body></html>`;
    }
    const w = window.open('', '_blank', 'width=620,height=850');
    if (w) { w.document.write(html); w.document.close(); }
  },

  // Transactions screen "Sales / Returns" switch. Returns use the same date,
  // branch, number and customer boxes; the sales-only filters are hidden.
  _txViewChanged() {
    const view = document.getElementById('tx-view')?.value;
    ['tx-status', 'tx-source', 'tx-cashier', 'tx-credited'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = view === 'sales' ? '' : 'none'; });
    const num = document.getElementById('tx-number');
    if (num) num.placeholder = view === 'returns' ? 'Return # or Tx #…' : view === 'payments' ? 'Payment # or reference…' : 'Tx # search…';
    this.loadTransactions();
  },

  // Customer Payments view — account payments received at the POS
  // (GET /transactions/customer-payments).
  async loadCustomerPaymentsList() {
    const params = new URLSearchParams();
    const val = id => (document.getElementById(id)?.value || '').trim();
    if (val('tx-start')) params.set('start', val('tx-start'));
    if (val('tx-end')) params.set('end', val('tx-end'));
    if (val('tx-branch')) params.set('branch_id', val('tx-branch'));
    if (val('tx-number')) params.set('number', val('tx-number'));
    if (val('tx-customer')) params.set('customer_name', val('tx-customer'));
    const rows = await this.api('GET', `/transactions/customer-payments?${params}`);
    const el = document.getElementById('tx-table');
    if (el) el.innerHTML = this.buildCustomerPaymentsTable(rows);
  },

  buildCustomerPaymentsTable(rows) {
    if (!rows.length) return '<div class="empty-state"><p>No customer payments found for these dates</p></div>';
    const method = m => String(m || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const total = rows.reduce((t, r) => t + (Number(r.amount) || 0), 0);
    return `<table>
      <thead><tr><th>Payment #</th><th>Date/Time</th><th>Customer</th><th>Branch</th><th>Method</th><th>Reference</th><th>Amount</th><th>Applied To</th><th>On Account</th><th>Received By</th><th>Notes</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="fw-600" style="font-family:monospace;white-space:nowrap">${this.escapeAttr(r.payment_number)}</td>
        <td style="white-space:nowrap">${this.fmtDateTime(r.created_at)}</td>
        <td>${this.escapeAttr(r.customer_name || '—')}${r.customer_number ? `<div style="font-size:11px;color:var(--text-muted);font-family:monospace">${this.escapeAttr(r.customer_number)}</div>` : ''}</td>
        <td>${this.escapeAttr(r.branch_name || '—')}</td>
        <td>${this.escapeAttr(method(r.payment_method))}</td>
        <td>${this.escapeAttr(r.reference || '—')}</td>
        <td class="fw-600">${this.fmt(r.amount)}</td>
        <td style="font-size:12px;font-family:monospace">${this.escapeAttr(r.applied_to || '—')}</td>
        <td${r.unapplied > 0.005 ? ' style="color:var(--warning);font-weight:600"' : ''}>${r.unapplied > 0.005 ? this.fmt(r.unapplied) : '—'}</td>
        <td>${this.escapeAttr(r.employee_name || '—')}</td>
        <td style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(r.notes || '')}</td>
        <td><button class="btn btn-outline btn-sm" style="white-space:nowrap" onclick="App.showPaymentReceipt(${r.id})" title="View, print or email the payment receipt">🧾 Receipt</button></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="6" class="fw-600" style="text-align:right">${rows.length} payment${rows.length === 1 ? '' : 's'} — Total</td><td class="fw-600">${this.fmt(total)}</td><td colspan="5"></td></tr></tfoot>
    </table>`;
  },

  async loadReturnsList() {
    const params = new URLSearchParams();
    const val = id => (document.getElementById(id)?.value || '').trim();
    if (val('tx-start')) params.set('start', val('tx-start'));
    if (val('tx-end')) params.set('end', val('tx-end'));
    if (val('tx-branch')) params.set('branch_id', val('tx-branch'));
    if (val('tx-number')) params.set('number', val('tx-number'));
    if (val('tx-customer')) params.set('customer_name', val('tx-customer'));
    const rows = await this.api('GET', `/transactions/returns?${params}`);
    const el = document.getElementById('tx-table');
    if (el) el.innerHTML = this.buildReturnsTable(rows);
  },

  buildReturnsTable(rows) {
    if (!rows.length) return '<div class="empty-state"><p>No returns found for these dates</p></div>';
    const label = { refund: 'Refund', credit_note: 'Credit Note', replacement: 'Exchange' };
    const badge = { refund: 'badge-warning', credit_note: 'badge-info', replacement: 'badge-secondary' };
    return `<table>
      <thead><tr><th>Return #</th><th>Date/Time</th><th>Original Sale</th><th>Customer</th><th>Branch</th><th>Items</th><th>Resolution</th><th>Total</th><th>Processed By</th><th>Authorized By</th><th>Reason</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="fw-600" style="font-family:monospace">${this.escapeAttr(r.return_number)}</td>
        <td style="white-space:nowrap">${this.fmtDateTime(r.created_at)}</td>
        <td>${r.original_transaction_id ? `<a href="#" style="font-family:monospace;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.viewTransaction(${r.original_transaction_id})">${this.escapeAttr(r.original_transaction_number)}</a>` : '—'}</td>
        <td>${r.customer_name ? this.escapeAttr(r.customer_name) : '<em style="color:#999">Walk-in</em>'}</td>
        <td style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(r.branch_name || '—')}</td>
        <td>${r.item_count}</td>
        <td><span class="badge-pill ${badge[r.resolution] || 'badge-secondary'}">${label[r.resolution] || this.escapeAttr(r.resolution)}</span></td>
        <td class="fw-600">${this.fmt(r.total)}</td>
        <td style="font-size:12px">${this.escapeAttr(r.employee_name || '—')}</td>
        <td style="font-size:12px">${this.escapeAttr(r.override_by_name || '—')}</td>
        <td style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.escapeAttr(r.notes || '')}">${this.escapeAttr(r.notes || '—')}</td>
        <td style="white-space:nowrap"><button class="btn btn-secondary btn-sm" onclick="App.viewReturn(${r.id})">View / Print</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
  },

  // Opens a return's receipt (Print and Email are on it).
  async viewReturn(id) {
    try { this.showReturnReceipt(await this.api('GET', `/transactions/returns/${id}`)); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  buildTxTable(txs) {
    this._txSelected = new Set();
    if (!txs.length) return '<div class="empty-state"><p>No transactions found</p></div>';
    // Sales managers tick sales to credit them to a salesperson in one go.
    const pick = this.can('sales_manager');
    const pickable = tx => tx.status !== 'voided' && tx.status !== 'hold';
    return `${pick ? `<div id="tx-bulk-bar" style="display:flex;align-items:center;gap:10px;padding:8px 10px;flex-wrap:wrap;font-size:13px">
        <span id="tx-bulk-count" style="color:var(--text-muted)">Tick sales to change who they're credited to</span>
        <button class="btn btn-primary btn-sm" id="tx-bulk-btn" disabled onclick="App.showChangeSalespersonModal([...App._txSelected])">Change Salesperson…</button>
        ${txs.length >= (this._txLimit || 100) ? `<span style="color:var(--text-muted);font-size:12px">Showing the latest ${txs.length} — narrow the dates to see more</span>` : ''}
      </div>` : ''}<table>
      <thead><tr>${pick ? `<th style="width:28px"><input type="checkbox" title="Select all" onchange="App._txSelectAll(this.checked)" style="width:auto;margin:0"></th>` : ''}<th>Tx #</th><th>Date/Time</th><th>Customer</th><th>Branch</th><th>Type</th><th>Subtotal</th><th>Tax</th><th>Total</th><th>Method</th><th>Salesperson</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${txs.map(tx => `<tr>
        ${pick ? `<td>${pickable(tx) ? `<input type="checkbox" class="tx-pick" value="${tx.id}" onchange="App._txToggle(${tx.id}, this.checked)" style="width:auto;margin:0">` : ''}</td>` : ''}
        <td class="fw-600" style="font-family:monospace">${tx.transaction_number}${(tx.source==='online'||tx.source==='woocommerce')?'<br><span style="font-size:10px;background:#6366f1;color:#fff;border-radius:3px;padding:1px 5px;font-family:sans-serif;font-weight:500;letter-spacing:.3px">ONLINE</span>':''}</td>
        <td style="white-space:nowrap">${this.fmtDateTime(tx.created_at)}</td>
        <td>${tx.customer_name || '<em style="color:#999">Walk-in</em>'}</td>
        <td style="font-size:12px;color:var(--text-muted)">${tx.branch_name || '—'}</td>
        <td>${tx.rental_agreement_number ? `<span class="badge-pill badge-info" title="${tx.rental_agreement_number} (${tx.rental_role})">Rental</span>`
          : tx.work_order_number ? `<span class="badge-pill badge-info" title="${tx.work_order_number} (${tx.wo_role})">Work Order</span>`
          : `<span class="badge-pill badge-secondary">Retail</span>`}</td>
        <td>${this.fmt(tx.subtotal)}</td>
        <td style="color:var(--text-muted)">${this.fmt(tx.tax_amount)}</td>
        <td class="fw-600">${this.fmt(tx.total)}</td>
        <td><span class="badge-pill badge-info">${tx.payment_method.replace('_',' ')}</span></td>
        <td style="font-size:12px">${this.escapeAttr(tx.credited_name || '—')}</td>
        <td><span class="badge-pill ${tx.status==='completed'?'badge-success':'badge-danger'}">${tx.status}</span>${tx.return_count > 0 ? ` <span class="badge-pill badge-warning" title="Has ${tx.return_count} return${tx.return_count > 1 ? 's' : ''} — open the sale to see ${tx.return_count > 1 ? 'them' : 'it'}">↩ Returned</span>` : ''}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-secondary btn-sm" onclick="App.viewTransaction(${tx.id})">View</button>
          ${tx.status==='completed'&&!tx.rental_agreement_number&&!tx.work_order_number&&this.can('transactions_returns')?`<button class="btn btn-warning btn-sm" onclick="App.processReturn(${tx.id})" style="background:#f59e0b;color:#fff;border:none">Return</button>`:''}
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
  },

  async loadTransactions() {
    if (document.getElementById('tx-view')?.value === 'returns') return this.loadReturnsList();
    if (document.getElementById('tx-view')?.value === 'payments') return this.loadCustomerPaymentsList();
    const start = document.getElementById('tx-start').value;
    const end = document.getElementById('tx-end').value;
    const branch = document.getElementById('tx-branch').value;
    const status = document.getElementById('tx-status').value;
    const txNumber = document.getElementById('tx-number').value.trim();
    const customerName = document.getElementById('tx-customer').value.trim();
    const source = document.getElementById('tx-source').value;
    let url = `/transactions?start=${start}&end=${end}`;
    if (branch) url += `&branch_id=${branch}`;
    if (status) url += `&status=${status}`;
    if (source) url += `&source=${encodeURIComponent(source)}`;
    if (txNumber) url += `&transaction_number=${encodeURIComponent(txNumber)}`;
    if (customerName) url += `&customer_name=${encodeURIComponent(customerName)}`;
    const cashier = document.getElementById('tx-cashier')?.value;
    const credited = document.getElementById('tx-credited')?.value;
    if (cashier) url += `&employee_id=${cashier}`;
    if (credited) url += `&credited_id=${credited}`;
    // Bigger pages for a sales manager sorting out who sales belong to.
    this._txLimit = this.can('sales_manager') ? 500 : 100;
    url += `&limit=${this._txLimit}`;
    const txs = await this.api('GET', url);
    const txTable = document.getElementById('tx-table');
    if (txTable) txTable.innerHTML = this.buildTxTable(txs);
  },

  _txToggle(id, on) {
    if (on) this._txSelected.add(id); else this._txSelected.delete(id);
    const n = this._txSelected.size;
    const count = document.getElementById('tx-bulk-count');
    if (count) count.textContent = n ? `${n} sale${n === 1 ? '' : 's'} selected` : "Tick sales to change who they're credited to";
    const btn = document.getElementById('tx-bulk-btn');
    if (btn) btn.disabled = !n;
  },

  _txSelectAll(on) {
    document.querySelectorAll('#tx-table .tx-pick').forEach(cb => { cb.checked = on; this._txToggle(Number(cb.value), on); });
  },

  // Credit past sales to a salesperson (sales targets) — one sale from its
  // detail view, or the sales ticked on the Transactions list.
  async showChangeSalespersonModal(ids, fromTxId = null) {
    if (!ids.length) return;
    let people;
    try { people = await this.api('GET', '/sales-targets/salespeople'); } catch (e) { this.alert(e.message, 'error'); return; }
    const one = ids.length === 1;
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">Change Salesperson</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">${one ? 'This sale' : `These ${ids.length} sales`} will count toward the chosen salesperson's targets, and unpaid commission moves to them (worked out on their plan). Commission already paid stays where it is. The change is logged.</p>
          <div class="form-group"><label>Salesperson</label>
            <select id="csp-person">
              <option value="">— Select —</option>
              ${people.map(p => `<option value="${p.id}">${this.escapeAttr(`${p.first_name} ${p.last_name}`.trim())}</option>`).join('')}
              <option value="none">None — credit whoever started the ticket</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0"><label>Reason (optional)</label>
            <input type="text" id="csp-reason" maxlength="500" placeholder="e.g. Sold before the Salesperson field was turned on">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="csp-save" onclick="App.submitChangeSalesperson(${JSON.stringify(ids)}, ${fromTxId || 'null'})">Save</button>
        </div>
      </div>`);
  },

  async submitChangeSalesperson(ids, fromTxId) {
    const person = document.getElementById('csp-person')?.value;
    if (!person) { this.alert('Choose a salesperson', 'error'); return; }
    const btn = document.getElementById('csp-save');
    if (btn) btn.disabled = true;
    try {
      const r = await this.api('PATCH', '/transactions/salesperson', { ids, salesperson_id: person === 'none' ? null : Number(person), reason: document.getElementById('csp-reason')?.value || '' });
      this.closeModal();
      this.alert(r.changed ? `${r.changed} sale${r.changed === 1 ? '' : 's'} updated${r.unchanged ? ` (${r.unchanged} already credited that way)` : ''}${r.commissions_moved ? ` · commission moved on ${r.commissions_moved}` : ''}` : 'No change — already credited that way');
      if (r.commissions_paid?.length) this.alert(`Commission on ${r.commissions_paid.join(', ')} was already paid, so it was left with the previous salesperson — adjust it by hand in Commissions if needed.`, 'warning');
      if (this.section === 'transactions' && document.getElementById('tx-table')) this.loadTransactions().catch(() => {});
      if (fromTxId) this.viewTransaction(fromTxId);
    } catch (e) {
      if (btn) btn.disabled = false;
      this.alert(e.message, 'error');
    }
  },

  async viewTransaction(id) {
    const tx = await this.api('GET', `/transactions/${id}`);
    this.showModal(`
      <div class="modal" style="max-width:500px">
        <div class="modal-header"><span class="modal-title">Transaction ${tx.transaction_number}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${(tx.source==='online'||tx.source==='woocommerce') ? `<div style="background:#eef2ff;border:1px solid #c7d2fe;border-left:3px solid #6366f1;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:12px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="background:#6366f1;color:#fff;border-radius:3px;padding:2px 7px;font-weight:600;font-size:11px;letter-spacing:.3px">ONLINE</span><span>${tx.source==='woocommerce'?'Imported from WooCommerce':'Placed via ecommerce site'}${tx.notes?` &nbsp;·&nbsp; <span style="color:var(--text-muted)">${tx.notes}</span>`:''}</span></div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="color:var(--text-muted);white-space:nowrap">Fulfillment:</span>
              <select id="fulfillment-status-select" style="flex:1;font-size:12px;padding:3px 6px">
                ${['pending','processing','shipped','delivered','cancelled'].map(s=>`<option value="${s}" ${(tx.fulfillment_status||'pending')===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
              </select>
              <button class="btn btn-primary btn-sm" onclick="App.updateFulfillment(${tx.id})">Update</button>
            </div>
          </div>` : ''}
          ${tx.rental_agreement_number ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-left:3px solid #16a34a;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:12px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="background:#16a34a;color:#fff;border-radius:3px;padding:2px 7px;font-weight:600;font-size:11px;letter-spacing:.3px">RENTAL</span>
              <span>${tx.rental_role === 'settlement' ? 'Rental settlement' : 'Rental checkout'} for <a href="#" style="font-weight:700;color:#16a34a;text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewRentalAgreement(${tx.rental_agreement_id})">${tx.rental_agreement_number}</a> <span class="badge-pill ${tx.rental_status==='returned'?'badge-success':tx.rental_status==='cancelled'?'badge-secondary':'badge-info'}" style="font-size:10px">${tx.rental_status}</span></span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;color:#166534">
              <div>Checked out: ${this.fmtDateTime(tx.rental_checkout_datetime)}</div>
              <div>Due back: ${this.fmtDate(tx.rental_due_date)}</div>
              <div>Duration: ${this.rentalDurationLabel(tx.rental_checkout_datetime, tx.rental_due_date, tx.rental_returned_at)}</div>
              <div>Deposit: ${this.fmt(tx.rental_deposit_total)}${tx.rental_deposit_refunded > 0 ? ` (${this.fmt(tx.rental_deposit_refunded)} refunded)` : ''}</div>
              <div>${tx.rental_returned_at ? `Returned: ${this.fmtDateTime(tx.rental_returned_at)}` : 'Not yet returned'}</div>
            </div>
          </div>` : ''}
          ${tx.work_order_number ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--primary);border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:12px">
            <span style="background:var(--primary);color:#fff;border-radius:3px;padding:2px 7px;font-weight:600;font-size:11px;letter-spacing:.3px">WORK ORDER</span>
            <span>${({assessment:'Assessment fee',deposit:'Deposit',final:'Final payment'})[tx.wo_role] || 'Payment'} for <a href="#" style="font-weight:700;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewWorkOrder(${tx.work_order_id})">${tx.work_order_number}</a> <span class="badge-pill badge-info" style="font-size:10px">${tx.work_order_status}</span></span>
          </div>` : ''}
          ${tx.source_quote_number ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--primary);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;display:flex;justify-content:space-between;align-items:center">
            <span>Converted from quotation <a href="#" style="font-weight:700;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewQuote(${tx.source_quote_id})">${tx.source_quote_number}</a>${tx.quote_created_by ? ` &nbsp;·&nbsp; <span style="color:var(--text-muted)">Created by</span> <strong>${tx.quote_created_by}</strong>` : ''}</span>
          </div>` : ''}
          ${tx.source_return_number ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid #f59e0b;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px">
            ↩ Replacement for return <strong style="color:#f59e0b">${tx.source_return_number}</strong>
          </div>` : ''}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;font-size:13px">
            <div><span style="color:var(--text-muted)">Date:</span> ${this.fmtDateTime(tx.created_at)}</div>
            <div><span style="color:var(--text-muted)">Status:</span> <span class="badge-pill ${tx.status==='completed'?'badge-success':'badge-danger'}">${tx.status}</span></div>
            <div><span style="color:var(--text-muted)">Customer:</span> ${tx.customer_name || 'Walk-in'}</div>
            <div><span style="color:var(--text-muted)">Employee:</span> ${tx.employee_name || '—'}</div>
            <div><span style="color:var(--text-muted)">Salesperson:</span> ${this.escapeAttr(tx.credited_name || '—')}</div>
            <div><span style="color:var(--text-muted)">Branch:</span> ${tx.branch_name || '—'}</div>
            <div><span style="color:var(--text-muted)">Payment:</span> ${tx.payment_method === 'split' ? 'SPLIT' : tx.payment_method.replace('_',' ')}</div>
            <div><span style="color:var(--text-muted)">Tendered:</span> ${this.fmt(tx.amount_tendered)}</div>
          </div>
          ${tx.payment_method === 'split' ? `<div style="margin-bottom:14px;font-size:13px;border:1px solid var(--border);border-radius:6px;padding:8px 12px">
            ${(tx.payments||[]).map(p => `<div style="display:flex;justify-content:space-between;padding:2px 0"><span>${p.payment_method.replace('_',' ')}${p.approval_code ? ` <span style="color:var(--text-muted);font-size:11px">(${p.approval_code})</span>` : ''}</span><span>${this.fmt(p.amount)}</span></div>`).join('')}
          </div>` : ''}
          ${(tx.salesperson_changes || []).length ? `<div style="margin-bottom:14px;font-size:12px;border:1px solid var(--border);border-radius:6px;padding:8px 12px">
            <div style="font-weight:600;margin-bottom:4px">Salesperson changes</div>
            ${tx.salesperson_changes.map(c => `<div style="padding:2px 0">${this.fmtDateTime(c.changed_at)} — ${this.escapeAttr(c.old_name || '—')} → <strong>${this.escapeAttr(c.new_name || '—')}</strong> by ${this.escapeAttr(c.changed_by_name || '—')}${c.reason ? ` <span style="color:var(--text-muted)">(${this.escapeAttr(c.reason)})</span>` : ''}</div>`).join('')}
          </div>` : ''}
          <table style="margin-bottom:12px">
            <thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>${tx.items.map(i => i.is_comment ? `<tr><td colspan="5" style="font-style:italic;white-space:pre-wrap;color:var(--text-muted)"><span class="badge-pill badge-info" style="font-size:10px;font-style:normal">C</span> ${this.escapeAttr(i.product_name)}</td></tr>` : `<tr><td>${i.product_name}</td><td style="font-family:monospace;font-size:12px">${i.sku||''}</td><td style="text-align:center">${i.quantity}</td><td>${this.fmt(i.unit_price)}</td><td class="fw-600">${this.fmt(i.total)}</td></tr>`).join('')}</tbody>
          </table>
          <div style="text-align:right;border-top:1px solid var(--border);padding-top:10px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>Subtotal</span><span>${this.fmt(tx.subtotal)}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>Tax</span><span>${this.fmt(tx.tax_amount)}</span></div>
            ${tx.discount_amount > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;color:var(--success)"><span>${tx.source_return_number ? `↩ Return Credit <span style="font-family:monospace;font-size:11px;color:var(--text-muted)">${tx.source_return_number}</span>` : `Discount${tx.promotion_code ? ` <span style="font-family:monospace;font-size:11px;background:var(--bg);padding:1px 5px;border-radius:4px;color:var(--text-muted)">${tx.promotion_code}</span>` : ''}${tx.promotion_name ? ` <span style="color:var(--text-muted);font-size:11px">— ${tx.promotion_name}</span>` : ''}`}</span><span>-${this.fmt(tx.discount_amount)}</span></div>` : ''}
            ${tx.store_credit_applied > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;color:#2e7d32"><span>💳 Available Credit Applied</span><span>-${this.fmt(tx.store_credit_applied)}</span></div>` : ''}
            ${tx.cash_back_applied > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;color:#2e7d32"><span>🎁 Cash Back Applied</span><span>-${this.fmt(tx.cash_back_applied)}</span></div>` : ''}
            <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;margin-top:6px"><span>TOTAL</span><span>${this.fmt(tx.total)}</span></div>
            ${tx.change_amount > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--success)"><span>Change</span><span>${this.fmt(tx.change_amount)}</span></div>` : ''}
          </div>
          ${(tx.returns || []).length ? `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
            <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Returns on this sale</div>
            ${tx.returns.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;margin-bottom:4px">
              <span><a href="#" style="font-family:monospace;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.viewReturn(${r.id})">${this.escapeAttr(r.return_number)}</a> <span style="color:var(--text-muted)">${this.fmtDateTime(r.created_at)} · ${{ refund: 'Refund', credit_note: 'Credit Note', replacement: 'Exchange' }[r.resolution] || this.escapeAttr(r.resolution)}</span></span>
              <span class="fw-600">${this.fmt(r.total)}</span>
            </div>`).join('')}
          </div>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          ${tx.status!=='voided'&&tx.status!=='hold'&&this.can('sales_manager')?`<button class="btn btn-secondary" onclick="App.showChangeSalespersonModal([${tx.id}], ${tx.id})">Change Salesperson</button>`:''}
          ${tx.status==='completed'&&!tx.rental_agreement_number&&!tx.work_order_number&&this.can('transactions_returns')?`<button class="btn btn-sm" style="background:#f59e0b;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-weight:600;cursor:pointer" onclick="App.closeModal();App.processReturn(${tx.id})">↩ Return</button>`:''}
          <button class="btn btn-secondary" onclick="App.emailReceipt(${tx.id},'${(tx.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email Receipt</button>
          <button class="btn btn-primary" onclick="App.closeModal();App.printReceiptOrInvoice(App._viewTx,App._viewTx.change_amount||0)">🖨️ Print Receipt</button>
        </div>
      </div>`);
    this._viewTx = tx;
  },

  async updateFulfillment(txId) {
    const sel = document.getElementById('fulfillment-status-select');
    if (!sel) return;
    const status = sel.value;
    try {
      await this.api('PATCH', `/transactions/${txId}/fulfillment`, { fulfillment_status: status });
      this.alert(`Fulfillment status updated to "${status}"`);
      this.viewTransaction(txId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async processReturn(txId) {
    const [tx, existingReturns] = await Promise.all([
      this.api('GET', `/transactions/${txId}`),
      this.api('GET', `/transactions/${txId}/returns`),
    ]);

    // Build map of already-returned quantities per transaction_item id
    const returnedQtyMap = {};
    existingReturns.forEach(r => {
      r.items.forEach(ri => {
        returnedQtyMap[ri.transaction_item_id] = (returnedQtyMap[ri.transaction_item_id] || 0) + ri.quantity;
      });
    });

    const hasCustomer = !!tx.customer_id;
    const canRefund = this.can('transactions_refund');
    const canIssueCreditNote = this.can('transactions_credit_note');
    const canCreditNote = hasCustomer && canIssueCreditNote;
    // Credit card sales can only be refunded within 90 days (enforced again
    // in POST /transactions/:id/return) — after that, credit note or exchange.
    const paidByCard = tx.payment_method === 'credit_card' || (tx.payments || []).some(p => p.payment_method === 'credit_card');
    const saleAgeDays = (Date.now() - new Date(String(tx.created_at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(tx.created_at) ? '' : 'Z')).getTime()) / 86400000;
    const cardRefundExpired = paidByCard && saleAgeDays > 90;
    // A charge-account sale was never paid, so there's nothing to refund —
    // its return goes back on the account as a credit note (enforced again
    // in POST /transactions/:id/return).
    const chargeSale = !!tx.is_credit || tx.payment_method === 'credit';
    const refundBlocked = cardRefundExpired || chargeSale;
    const refundAllowed = canRefund && !refundBlocked;
    const firstResolution = refundAllowed ? 'refund' : (canCreditNote ? 'credit_note' : 'replacement');

    const itemRows = tx.items.filter(item => !item.is_comment).map(item => {
      const alreadyRet = returnedQtyMap[item.id] || 0;
      const maxQty = item.quantity - alreadyRet;
      if (item.is_sp_rental) return `<tr style="opacity:0.5"><td><input type="checkbox" disabled></td><td>${item.product_name}</td><td style="font-family:monospace;font-size:12px">${item.sku||''}</td><td style="text-align:center">${item.quantity}</td><td colspan="3" style="font-size:12px;color:var(--text-muted)">Rental — check it back in from the Rentals screen</td></tr>`;
      if (maxQty <= 0) return `<tr style="opacity:0.4"><td><input type="checkbox" disabled></td><td>${item.product_name}</td><td style="font-family:monospace;font-size:12px">${item.sku||''}</td><td style="text-align:center">${item.quantity}</td><td style="text-align:center;color:var(--danger)">All returned</td><td>${this.fmt(item.unit_price)}</td><td>—</td></tr>`;
      return `<tr>
        <td><input type="checkbox" class="ret-chk" data-item-id="${item.id}" data-max="${maxQty}" data-price="${item.unit_price}" data-tax-rate="${item.tax_amount > 0 ? (item.tax_amount / item.total * 100) : 0}" data-total="${item.total}" data-tax="${item.tax_amount}" data-disc="${item.discount_share || 0}" onchange="App._retCalcTotal()"></td>
        <td>${item.product_name}</td>
        <td style="font-family:monospace;font-size:12px">${item.sku||''}</td>
        <td style="text-align:center">${item.quantity}${alreadyRet > 0 ? ` <span style="font-size:10px;color:var(--warning)">(${alreadyRet} returned)</span>` : ''}</td>
        <td style="text-align:center"><input type="number" class="ret-qty" data-item-id="${item.id}" min="1" max="${maxQty}" value="1" style="width:56px;text-align:center" onchange="App._retCalcTotal()" oninput="App._retCalcTotal()"></td>
        <td>${this.fmt(item.unit_price)}</td>
        <td class="ret-line-total" data-item-id="${item.id}" style="font-weight:600">—</td>
      </tr>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'return-overlay';
    overlay.style.zIndex = '9600';
    overlay.innerHTML = `
      <div class="modal" style="max-width:620px">
        <div class="modal-header">
          <span class="modal-title">↩ Process Return — ${tx.transaction_number}</span>
          <button class="modal-close" onclick="document.getElementById('return-overlay').remove()">✕</button>
        </div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;font-size:12px;background:var(--bg-secondary);border-radius:6px;padding:8px 12px">
            <div><span style="color:var(--text-muted)">Original:</span> <strong>${tx.transaction_number}</strong></div>
            <div><span style="color:var(--text-muted)">Date:</span> ${this.fmtDate(tx.created_at)}</div>
            <div><span style="color:var(--text-muted)">Customer:</span> ${tx.customer_name || '<em>Walk-in</em>'}</div>
          </div>
          <p style="font-size:13px;font-weight:600;margin-bottom:8px">Select items to return:</p>
          <table style="margin-bottom:16px">
            <thead><tr><th style="width:32px"></th><th>Item</th><th>SKU</th><th>Orig Qty</th><th>Return Qty</th><th>Unit Price</th><th>Refund</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
          <div style="margin-bottom:14px">
            <p style="font-size:13px;font-weight:600;margin-bottom:8px">Resolution:</p>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${canRefund ? `<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px${refundBlocked?';opacity:0.45':''}">
                <input type="radio" name="ret-resolution" value="refund" ${refundBlocked?'disabled':(firstResolution==='refund'?'checked':'')} style="margin-top:2px">
                <span><strong>Refund</strong> — return cash or reverse the original payment method${chargeSale?' <em style="color:var(--danger)">(not available — this sale was charged to the customer\'s account; use Credit Note to take it off their balance)</em>':cardRefundExpired?' <em style="color:var(--danger)">(not available — paid by credit card more than 90 days ago)</em>':''}</span>
              </label>` : ''}
              ${canIssueCreditNote ? `<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px${hasCustomer?'':';opacity:0.45'}">
                <input type="radio" name="ret-resolution" value="credit_note" ${hasCustomer?(firstResolution==='credit_note'?'checked':''):'disabled'} style="margin-top:2px">
                <span><strong>Credit Note</strong> — add return value to customer's store credit account${hasCustomer?'':' <em style="color:var(--text-muted)">(requires customer)</em>'}</span>
              </label>` : ''}
              <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px">
                <input type="radio" name="ret-resolution" value="replacement" ${firstResolution==='replacement'?'checked':''} style="margin-top:2px">
                <span><strong>Replacement / Exchange</strong> — process return then open POS with credit pre-applied</span>
              </label>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label style="font-size:13px">Reason for return *</label>
            <textarea id="ret-notes" rows="4" placeholder="Why is the customer returning it? e.g. Wrong size, damaged in box" style="font-size:13px;width:100%;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere"></textarea>
          </div>
          <div class="form-group" style="margin:12px 0 0">
            <label style="font-size:13px">Manager Override PIN *</label>
            <input type="password" id="ret-override-pin" inputmode="numeric" autocomplete="off" placeholder="Manager enters their PIN" style="width:220px" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('ret-submit-btn')?.click()}">
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">Every return needs a manager's authorization — someone with <em>Authorize Return Override</em>. Recorded on the return.</div>
          </div>
        </div>
        <div class="modal-footer" style="justify-content:space-between;align-items:center">
          <div style="font-size:14px">Return Total: <strong id="ret-total-display" style="font-size:16px;color:var(--primary)">$0.00</strong></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-secondary" onclick="document.getElementById('return-overlay').remove()">Cancel</button>
            <button class="btn btn-primary" id="ret-submit-btn" onclick="App.submitReturn(${tx.id})" disabled>Process Return</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this._retTx = tx;
    this._retCalcTotal();
  },

  _retCalcTotal() {
    let total = 0;
    document.querySelectorAll('.ret-chk').forEach(chk => {
      const itemId = chk.dataset.itemId;
      const maxQty = parseInt(chk.dataset.max);
      const origTotal = parseFloat(chk.dataset.total);
      const origTax = parseFloat(chk.dataset.tax);
      const origDisc = parseFloat(chk.dataset.disc) || 0;
      const origQtyEl = chk.closest('tr').querySelector('input[type="checkbox"]');
      const origQty = parseInt(this._retTx?.items.find(i => String(i.id) === itemId)?.quantity || 1);
      const qtyInput = document.querySelector(`.ret-qty[data-item-id="${itemId}"]`);
      const lineDisplay = document.querySelector(`.ret-line-total[data-item-id="${itemId}"]`);
      if (chk.checked && qtyInput) {
        let qty = parseInt(qtyInput.value) || 1;
        if (qty < 1) qty = 1;
        if (qty > maxQty) { qty = maxQty; qtyInput.value = qty; }
        const proportion = qty / origQty;
        // Same as POST /:id/return: the line's net less its share of the
        // ticket discount, plus its tax.
        const lineRefund = parseFloat((parseFloat((origTotal * proportion - Math.round(origDisc * proportion * 100) / 100).toFixed(2)) + parseFloat((origTax * proportion).toFixed(2))).toFixed(2));
        total += lineRefund;
        if (lineDisplay) lineDisplay.textContent = this.fmt(lineRefund);
      } else {
        if (lineDisplay) lineDisplay.textContent = '—';
      }
    });
    const display = document.getElementById('ret-total-display');
    if (display) display.textContent = this.fmt(total);
    const btn = document.getElementById('ret-submit-btn');
    if (btn) btn.disabled = total <= 0;
  },

  async submitReturn(txId) {
    const items = [];
    document.querySelectorAll('.ret-chk:checked').forEach(chk => {
      const itemId = parseInt(chk.dataset.itemId);
      const qtyInput = document.querySelector(`.ret-qty[data-item-id="${itemId}"]`);
      const qty = parseInt(qtyInput?.value) || 1;
      items.push({ transaction_item_id: itemId, quantity: qty });
    });
    if (!items.length) { this.alert('Select at least one item to return', 'warning'); return; }
    const resolution = document.querySelector('input[name="ret-resolution"]:checked')?.value || 'refund';
    const notes = (document.getElementById('ret-notes')?.value || '').trim();
    if (!notes) { this.alert('Enter the reason for the return', 'warning'); document.getElementById('ret-notes')?.focus(); return; }
    const pinInput = document.getElementById('ret-override-pin');
    const override_pin = pinInput?.value.trim() || '';
    if (!override_pin) { this.alert('A manager must enter their PIN to authorize this return', 'warning'); pinInput?.focus(); return; }
    const btn = document.getElementById('ret-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
    try {
      const ret = await this.api('POST', `/transactions/${txId}/return`, {
        items, resolution, notes, employee_id: this.currentUser?.id || null, override_pin
      });
      document.getElementById('return-overlay')?.remove();
      if (resolution === 'replacement' && this.can('pos')) {
        await this._startExchange({ ...ret, customer_id: ret.customer_id ?? this._retTx?.customer_id });
        this.alert(`Return ${ret.return_number} processed. Return credit ${this.fmt(ret.total)} applied to cart.`, 'success');
      } else if (resolution === 'replacement') {
        // No POS access here — the credit waits in POS Hold Recall for a
        // cashier to ring up the replacement.
        this.alert(`Return ${ret.return_number} processed. The ${this.fmt(ret.total)} exchange credit is waiting in POS → Hold Recall for a cashier to ring up the replacement.`, 'success');
        if (this.section === 'transactions') this.loadTransactions();
        const fullRet = await this.api('GET', `/transactions/returns/${ret.id}`);
        this.showReturnReceipt(fullRet);
      } else {
        const resLabel = resolution === 'credit_note' ? 'Credit note issued' : 'Refund processed';
        this.alert(`${resLabel} — ${ret.return_number} · ${this.fmt(ret.total)}`, 'success');
        // Returns can be started from a customer's history too — only refresh
        // the Transactions list when it's the page that's open.
        if (this.section === 'transactions') this.loadTransactions();
        const fullRet = await this.api('GET', `/transactions/returns/${ret.id}`);
        this.showReturnReceipt(fullRet);
      }
    } catch(e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Process Return'; }
      // A wrong PIN is cleared so the manager can re-enter it.
      if (pinInput && /PIN/.test(e.message)) { pinInput.value = ''; pinInput.focus(); }
      this.alert(e.message, 'error');
    }
  },

  // Opens the POS on an exchange's return credit: the return's customer on
  // the ticket and its total as the (after-tax) discount. The server only
  // accepts it from a pending exchange (GET /transactions/pending-exchanges).
  async _startExchange(ret) {
    this._returnCredit = { id: ret.id, amount: parseFloat(ret.total), return_number: ret.return_number };
    this.cartDiscount = this._returnCredit.amount;
    if (ret.customer_id) {
      try { this.cartCustomer = await this.api('GET', `/customers/${ret.customer_id}`); } catch(e) {}
    }
    await this.showSection('pos');
    const di = document.getElementById('discount-input');
    if (di) di.value = this._returnCredit.amount.toFixed(2);
    const dd = document.getElementById('discount-display');
    if (dd) dd.textContent = `-${this.fmt(this._returnCredit.amount)}`;
    if (this.cartCustomer) this._renderCartCustomer();
    this.renderCart();
  },

  // Hold Recall → a pending exchange: start a fresh ticket on its credit.
  async recallExchange(returnId) {
    try {
      const pending = await this.api('GET', '/transactions/pending-exchanges');
      const ret = pending.find(r => r.id === returnId);
      if (!ret) { this.alert('That exchange credit has already been used', 'warning'); this.updateHoldBadge(); return; }
      if (this.cart.length && !confirm('Starting this exchange will replace your current cart. Continue?')) return;
      this.closeModal();
      this.clearCart();
      await this._startExchange(ret);
      this.alert(`Exchange credit ${this.fmt(ret.total)} from ${ret.return_number} applied — ring up the replacement.`, 'success');
    } catch(e) {
      this.alert(e.message, 'error');
    }
  },

  showReturnReceipt(ret) {
    const items = ret.items || [];
    const storeName = this.settings.store_name || 'My Store';
    const resolutionLabel = { refund: 'Refund', credit_note: 'Credit Note', replacement: 'Replacement / Exchange' }[ret.resolution] || ret.resolution;
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">Return Receipt</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="receipt">
            <div class="receipt-store" style="text-align:center;font-weight:700;font-size:15px;margin-bottom:6px">${storeName}</div>
            ${this._printLogoTag(36)}
            <div class="receipt-title" style="color:var(--danger)">RETURN RECEIPT</div>
            ${ret.branch_name ? `<div style="text-align:center;font-size:12px;color:#444;font-weight:600">${ret.branch_name}</div>` : ''}
            <hr>
            <div class="receipt-row"><span>Return #:</span><span>${ret.return_number}</span></div>
            <div class="receipt-row"><span>Date:</span><span>${this.fmtDateTime(ret.created_at)}</span></div>
            ${ret.original_transaction_number ? `<div class="receipt-row"><span>Original Tx:</span><span>${ret.original_transaction_number}</span></div>` : ''}
            ${ret.customer_name ? `<div class="receipt-row"><span>Customer:</span><span>${ret.customer_name}</span></div>` : ''}
            <div class="receipt-row"><span>Resolution:</span><span>${resolutionLabel}</span></div>
            ${ret.employee_name ? `<div class="receipt-row"><span>Processed By:</span><span>${ret.employee_name}</span></div>` : ''}
            ${ret.override_by_name ? `<div class="receipt-row"><span>Authorized By:</span><span>${ret.override_by_name}</span></div>` : ''}
            ${ret.notes ? `<div class="receipt-row"><span style="flex-shrink:0">Reason:</span><span style="text-align:right;white-space:pre-wrap;overflow-wrap:anywhere">${ret.notes}</span></div>` : ''}
            <hr>
            ${items.map(i => `<div class="receipt-row"><span>${i.sku ? `<span style="font-size:11px;color:#555">${i.sku}</span> ` : ''}${i.product_name}</span><span>${this.fmt(i.total)}</span></div>${i.quantity > 1 ? `<div style="color:#666;font-size:11px;padding-left:4px">${i.quantity} x ${this.fmt(i.unit_price)}</div>` : ''}`).join('')}
            <hr>
            <div class="receipt-row"><span>Subtotal</span><span>${this.fmt(ret.subtotal)}</span></div>
            <div class="receipt-row"><span>Tax</span><span>${this.fmt(ret.tax_amount)}</span></div>
            <div class="receipt-row receipt-total" style="color:var(--danger)"><span>${resolutionLabel.toUpperCase()} TOTAL</span><span>${this.fmt(ret.total)}</span></div>
            <hr>
          </div>
        </div>
        <div class="modal-footer no-print">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-secondary" onclick="App.emailReturnReceipt(${ret.id},'${(ret.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email</button>
          <button class="btn btn-primary" onclick="window.print()">🖨️ Print</button>
        </div>
      </div>`);
  },

  // Customer account payment receipt (GET /transactions/customer-payments/:id)
  // — from the Customer Payments view, or straight after POS Receive Payment.
  async showPaymentReceipt(paymentId) {
    let p;
    try { p = await this.api('GET', `/transactions/customer-payments/${paymentId}`); }
    catch(e) { this.alert(e.message, 'error'); return; }
    const storeName = this.settings.store_name || 'My Store';
    const method = String(p.payment_method || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const esc = v => this.escapeAttr(v ?? '');
    this._paymentReceipt = p;
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">Payment Receipt</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="receipt">
            <div class="receipt-store" style="text-align:center;font-weight:700;font-size:15px;margin-bottom:6px">${esc(storeName)}</div>
            ${this._printLogoTag(36)}
            <div class="receipt-title">PAYMENT RECEIPT</div>
            ${p.branch_name ? `<div style="text-align:center;font-size:12px;color:#444;font-weight:600">${esc(p.branch_name)}</div>` : ''}
            <hr>
            <div class="receipt-row"><span>Payment #:</span><span>${esc(p.payment_number)}</span></div>
            <div class="receipt-row"><span>Date:</span><span>${this.fmtDateTime(p.created_at)}</span></div>
            <div class="receipt-row wrap"><span>Customer:</span><span>${esc(p.customer_name)}</span></div>
            ${p.customer_number ? `<div class="receipt-row"><span>Account #:</span><span>${esc(p.customer_number)}</span></div>` : ''}
            <div class="receipt-row wrap"><span>Method:</span><span>${esc(method)}</span></div>
            ${p.reference ? `<div class="receipt-row wrap"><span>Reference:</span><span>${esc(p.reference)}</span></div>` : ''}
            ${p.employee_name ? `<div class="receipt-row wrap"><span>Received By:</span><span>${esc(p.employee_name)}</span></div>` : ''}
            ${p.notes ? `<div class="receipt-row wrap"><span>Notes:</span><span style="white-space:pre-wrap">${esc(p.notes)}</span></div>` : ''}
            ${p.applied.length ? `<hr><div style="font-size:11px;font-weight:700;color:#555;margin-bottom:4px">APPLIED TO</div>
            ${p.applied.map(a => `<div class="receipt-row" style="margin-bottom:3px"><span>${esc(a.invoice_number)}${a.invoice_date ? `<div style="font-size:11px;color:#555">Invoice date ${this.fmtDate(a.invoice_date)}</div>` : ''}</span><span>${this.fmt(a.amount)}</span></div>`).join('')}` : ''}
            ${p.unapplied > 0.005 ? `<div class="receipt-row"><span>Held on account</span><span>${this.fmt(p.unapplied)}</span></div>` : ''}
            <hr>
            <div class="receipt-row receipt-total"><span>AMOUNT RECEIVED</span><span>${this.fmt(p.amount)}</span></div>
            <div class="receipt-row" style="margin-top:6px"><span>Account Balance<div style="font-size:11px;color:#555">as of ${this.fmtDate(new Date().toISOString())}</div></span><span>${this.fmt(p.account_balance)}</span></div>
            <hr>
          </div>
        </div>
        <div class="modal-footer no-print">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-secondary" onclick="App.emailPaymentReceipt()">✉️ Email</button>
          <button class="btn btn-secondary" onclick="window.print()" title="Narrow receipt for the receipt printer">🖨️ Normal</button>
          <button class="btn btn-primary" onclick="App.printPaymentReceiptLetter()" title="Full-page letter-size receipt">🖨️ Letter</button>
        </div>
      </div>`);
  },

  // Letter-size print of the payment receipt open in the modal — same
  // popup-window approach as printReceiptLetter, with the invoices' Bill To box.
  printPaymentReceiptLetter() {
    const p = this._paymentReceipt;
    if (!p) return;
    const win = window.open('', '_blank', 'width=850,height=1000');
    if (!win) { this.alert('Your browser blocked the print popup — allow popups for this site and try again', 'warning'); return; }
    const esc = v => this.escapeAttr(v ?? '');
    const storeName = this.settings.store_name || 'My Store';
    const addressLine = p.branch_address || this.settings.store_address || '';
    const cityLine = p.branch_address ? `${p.branch_city ? ', ' + p.branch_city : ''}${p.branch_state ? ' ' + p.branch_state : ''}${p.branch_zip ? ' ' + p.branch_zip : ''}` : '';
    const phoneLine = p.branch_phone || this.settings.store_phone || '';
    const method = String(p.payment_method || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const td = 'padding:8px;border-bottom:1px solid #e8e8e8';
    win.document.write(`<!DOCTYPE html><html><head><title>Payment Receipt – ${esc(p.payment_number)}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:0;padding:48px;color:#111}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
      .store h1{font-size:20px;margin:0 0 2px}
      .store div{font-size:12px;color:#555}
      .doc-title{font-size:22px;font-weight:700;text-align:right;color:#333}
      .meta{display:flex;gap:32px;margin-bottom:20px;font-size:12px}
      .meta div{line-height:1.6}
      .meta label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      table{width:100%;border-collapse:collapse}
      th{background:#f0f0f0;text-align:left;padding:8px;font-size:11px;text-transform:uppercase;color:#555}
      ${this._billToPrintCss}
      .totals{width:320px;margin-left:auto;margin-top:16px;font-size:13px}
      .totals tr td{padding:4px 0;border:none}
      .totals .total-row td{border-top:2px solid #111;font-size:16px;font-weight:700;padding-top:8px}
      .footer{margin-top:32px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:10px;text-align:center}
      @page { size: letter; margin: 0.75in; }
      @media print{body{padding:0}}
    </style></head><body>
    <div style="text-align:center;font-weight:700;font-size:20px;margin-bottom:16px">${esc(storeName)}</div>
    <div class="header">
      <div class="store">
        ${this._printLogoTag(50)}
        ${p.branch_name ? `<h1>${esc(p.branch_name)}</h1>` : ''}
        ${addressLine ? `<div>${esc(addressLine)}${esc(cityLine)}</div>` : ''}
        ${phoneLine ? `<div>${esc(phoneLine)}</div>` : ''}
      </div>
      <div class="doc-title">PAYMENT RECEIPT</div>
    </div>
    ${this._billToPrintHtml(p, [['Payment #', esc(p.payment_number)], ['Date', this.fmtDateTime(p.created_at)], ['Method', esc(method)], ['Reference', p.reference ? esc(p.reference) : '']])}
    <div class="meta">
      ${p.employee_name ? `<div><label>Received By</label>${esc(p.employee_name)}</div>` : ''}
      ${p.notes ? `<div><label>Notes</label><span style="white-space:pre-wrap">${esc(p.notes)}</span></div>` : ''}
    </div>
    ${p.applied.length ? `<table>
      <thead><tr><th>Applied To Invoice</th><th>Invoice Date</th><th style="text-align:right">Amount Applied</th></tr></thead>
      <tbody>${p.applied.map(a => `<tr>
        <td style="${td};font-weight:600">${esc(a.invoice_number)}</td>
        <td style="${td}">${a.invoice_date ? this.fmtDate(a.invoice_date) : '—'}</td>
        <td style="${td};text-align:right">${this.fmt(a.amount)}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div style="font-size:13px;color:#555;padding:8px 0">Received on account — not yet applied to an invoice.</div>'}
    <table class="totals">
      ${p.applied.length ? `<tr><td>Applied to invoices</td><td style="text-align:right">${this.fmt(p.amount - p.unapplied)}</td></tr>` : ''}
      ${p.unapplied > 0.005 ? `<tr><td>Held on account</td><td style="text-align:right">${this.fmt(p.unapplied)}</td></tr>` : ''}
      <tr class="total-row"><td>AMOUNT RECEIVED</td><td style="text-align:right">${this.fmt(p.amount)}</td></tr>
      <tr><td style="padding-top:10px">Account Balance <span style="font-size:11px;color:#555">as of ${this.fmtDate(new Date().toISOString())}</span></td><td style="text-align:right;padding-top:10px;font-weight:600">${this.fmt(p.account_balance)}</td></tr>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-top:70px">
      <div style="width:280px;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">Received By</div></div>
    </div>
    <div class="footer">${this._receiptFooterHtml('Thank you!')}</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

  emailPaymentReceipt() {
    const p = this._paymentReceipt;
    if (!p) return;
    this.showEmailModal('Email Payment Receipt', p.customer_email || '', async (to) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-payment-receipt/${p.id}`, { to });
        this.alert(`Payment receipt sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    });
  },

  emailReturnReceipt(retId, customerEmail) {
    this.showEmailModal('Email Return Receipt', customerEmail, async (to) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-return-receipt/${retId}`, { to });
        this.alert(`Return receipt sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    });
  },

});
