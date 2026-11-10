// Reports hub and individual reports.
Object.assign(App, {
  // ─── Reports ──────────────────────────────────────────────
  // ─── Reports hub: Marketing / Sales / Accounts ─────────────────────────
  // The Sales and Accounts categories currently just point at the existing
  // Reports & Analytics screen (below) rather than duplicating it — the
  // Marketing category is the first one broken out into its own dedicated,
  // purpose-built reports.

  _reportButtonCard(title, description, onclick) {
    return `<div class="card" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 18px">
      <div>
        <div style="font-weight:600;font-size:15px;margin-bottom:3px">${title}</div>
        <div style="font-size:12px;color:var(--text-muted)">${description}</div>
      </div>
      <button class="btn btn-primary" style="flex-shrink:0" onclick="${onclick}">View Report</button>
    </div>`;
  },

  renderReportsMarketing() {
    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>Marketing Reports</h2></div>
      ${this._reportButtonCard('Lead Source Performance', 'Conversion rate from lead source (Website, Referral, Bid, etc.) through to won opportunities.', 'App.showLeadSourceReport()')}
      ${this._reportButtonCard('Customer Segment Report', 'Sales and margin by Customer Category, to see whether each category\'s auto-discount is driving volume.', 'App.showCustomerSegmentReport()')}
      ${this._reportButtonCard('Loyalty & Cash-Back Engagement', 'Points issued vs. redeemed, redemption rate, and top point earners.', 'App.showLoyaltyEngagementReport()')}
      ${this._reportButtonCard('Discount Card Utilization', 'Active discount cards vs. actually used in a sale, to spot cards issued but never redeemed.', 'App.showDiscountCardReport()')}
      ${this._reportButtonCard('New vs. Repeat Customer Rate', 'New vs. returning customers over a period, and the revenue split between them.', 'App.showCustomerRetentionReport()')}
      ${this._reportButtonCard('Sales by Promotion', 'Sales made under each promotion, broken down by branch, with the discount given.', 'App.showSalesByPromotionReport()')}`;
  },

  renderReportsSales() {
    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>Sales Reports</h2></div>
      ${this._reportButtonCard('Sales by Branch &amp; Department', 'Total sales per branch, broken down into Retail, Rental, Work Orders, and Special Projects.', 'App.showSalesByDepartmentReport()')}
      ${this._reportButtonCard('Hourly Sales by Day', 'For each day of the week, sales and tickets in every hour of the day, with average revenue per ticket — to see when the store is busiest.', 'App.showHourlySalesReport()')}
      ${this._reportButtonCard('Online Sales', 'Orders from the website and WooCommerce — by channel, branch, fulfillment status and day, with top-selling products.', 'App.showOnlineSalesReport()')}
      ${this._reportButtonCard('Salesperson Leaderboard', 'Quotes created/converted, win rate, and total credited sales per salesperson.', 'App.showSalesLeaderboardReport()')}
      ${this._reportButtonCard('Quote Funnel &amp; Cycle Time', 'How many quotes sit in each status, and the average days spent between Draft, Sent, Accepted, and Converted.', 'App.showQuoteFunnelReport()')}
      ${(this.can('special_projects') || this.can('special_projects_approve')) ? this._reportButtonCard('Special Projects Margin Report', "Realized markup per Special Project, from each line's Cost vs. Price.", 'App.showSpecialProjectsMarginReport()') : ''}
      ${this._reportButtonCard('CRM Pipeline / Weighted Forecast', 'Open opportunities by stage, weighted by close probability.', 'App.showCrmPipelineReport()')}
      ${this._reportButtonCard('Rental Utilization', "Bookings and revenue per rental item, to spot under-used equipment vs. what's always out.", 'App.showRentalUtilizationReport()')}
      ${this._reportButtonCard('Salesperson Targets', 'Hourly, daily, weekly, and monthly targets vs. current sales for every salesperson — see also CRM &amp; Sales → Targets.', 'App.showSalespersonTargetsReport()')}
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">Sales Summary, Top Products, and By Category still live on the general <a href="#" onclick="event.preventDefault();App.showSection('reports')">Reports &amp; Analytics</a> screen.</p>`;
  },

  renderReportsAccounts() {
    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>Accounts Reports</h2></div>
      ${this._reportButtonCard('Cash Drawer Variance Trend', 'Over/short by employee and branch across reconciliations, to catch a pattern before it\'s a problem.', 'App.showCashVarianceReport()')}
      ${this._reportButtonCard('Credit Risk / Exposure', 'Customers near or over their credit limit, blocked accounts, and days remaining before an unpaid balance auto-blocks.', 'App.showCreditRiskReport()')}
      ${this._reportButtonCard('Tax Collected', 'Taxable sales and tax collected by day and branch, sized for filing.', 'App.showTaxCollectedReport()')}
      ${this.can('accounts_writeoff') ? this._reportButtonCard('Write-Off / Bad Debt', 'Every balance written off, by customer and branch, over a period.', 'App.showWriteoffReport()') : ''}
      ${this._reportButtonCard('Rental Deposits', 'Deposits taken on rentals and where they went — used against fees/damage, refunded (by method), issued as credit notes, or still held.', 'App.showRentalDepositReport()')}
      ${this._reportButtonCard('Gross Margin (COGS)', 'Store-wide cost vs. price on completed sales, by category and branch — the sibling of the Special Projects margin report.', 'App.showGrossMarginReport()')}
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">AR Collections still lives on the general <a href="#" onclick="event.preventDefault();App.showSection('reports')">Reports &amp; Analytics</a> screen; Customer Balances / Aging / Payment History are on the <a href="#" onclick="event.preventDefault();App.showSection('accounts')">Accounts</a> screen.</p>`;
  },

  renderReportsPurchasing() {
    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>Purchasing Reports</h2></div>
      ${this._reportButtonCard('Supplier Item Sales', "What each supplier's items sold — units, sales net of returns, cost and margin — by day, week, month, quarter or year, with a per-item breakdown for one supplier.", 'App.showSupplierItemSalesReport()')}`;
  },

  renderReportsInventory() {
    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>Inventory Reports</h2>${this.can('inventory') ? `<button class="btn btn-outline btn-sm" onclick="App.showSection('inventory')">← Retail Inventory</button>` : ''}</div>
      ${this._reportButtonCard('Items Sold', 'Every item sold over a period — units sold and returned, net sales, cost, margin and what\'s on hand now — filterable by location, category, brand or item.', 'App.showItemsSoldReport()')}
      ${this._reportButtonCard('Zero &amp; Negative Stock', 'Every inventory item at or below zero on hand, per location — negative counts to investigate and zero counts to reorder — with cost value, last sold and last received.', 'App.showZeroStockReport()')}`;
  },

  // ─── Zero & Negative Stock ──────────────────────────────────────────────
  // GET /reports/zero-negative-stock — one row per item per location at or
  // below 0 (an item at no location: its overall stock).

  async showZeroStockReport() {
    const [branches, categories, brands] = await Promise.all([
      this.api('GET', '/branches').catch(() => []),
      this.api('GET', '/categories').catch(() => []),
      this.api('GET', '/brands').catch(() => []),
    ]);
    const filters = `
      <select id="zns-status" style="width:170px" title="Which counts to list">
        <option value="all">Zero and negative</option><option value="negative">Negative only</option><option value="zero">Zero only</option>
      </select>
      <select id="zns-branch" style="width:150px"><option value="">All Locations</option>${(branches || []).filter(b => b.active).map(b => `<option value="${b.id}">${this.escapeAttr(b.name)}</option>`).join('')}</select>
      <select id="zns-category" style="width:160px"><option value="">All Categories</option><option value="none">Uncategorized</option>${(categories || []).map(c => `<option value="${c.id}">${this.escapeAttr(c.name)}</option>`).join('')}</select>
      <select id="zns-brand" style="width:150px"><option value="">All Brands</option>${(brands || []).map(b => `<option value="${this.escapeAttr(b.name || '')}">${this.escapeAttr(b.name || '')}</option>`).join('')}</select>
      <input type="text" id="zns-q" placeholder="Item name, SKU or barcode" style="width:200px" onkeydown="if(event.key==='Enter')App.loadZeroStockReport()">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap"><input type="checkbox" id="zns-inactive"> Include inactive items</label>
      <select id="zns-sort" style="width:170px" onchange="App._renderZeroStock()" title="Sort by">
        <option value="qty">Most negative first</option><option value="value">Largest value at cost</option><option value="location">Location, then item</option>
        <option value="name">Item name A–Z</option><option value="sold">Most recently sold</option>
      </select>`;
    this._showReportModal('Zero &amp; Negative Stock', filters, 'loadZeroStockReport');
    document.querySelector('#rpt-modal-content')?.closest('.modal')?.style.setProperty('max-width', '1150px');
  },

  async loadZeroStockReport() {
    const statusEl = document.getElementById('zns-status');
    if (!statusEl) return;
    const params = new URLSearchParams({ status: statusEl.value });
    for (const [id, key] of [['zns-branch', 'branch_id'], ['zns-category', 'category_id'], ['zns-brand', 'brand'], ['zns-q', 'q']]) {
      const v = document.getElementById(id).value.trim();
      if (v) params.set(key, v);
    }
    if (document.getElementById('zns-inactive').checked) params.set('include_inactive', '1');
    const content = document.getElementById('rpt-modal-content');
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/zero-negative-stock?${params}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;
    const branchSel = document.getElementById('zns-branch');
    data.branchName = branchSel.value ? branchSel.options[branchSel.selectedIndex].text : '';
    this._zeroStockData = data;
    this._renderZeroStock();
  },

  _renderZeroStock() {
    const data = this._zeroStockData;
    const content = document.getElementById('rpt-modal-content');
    if (!data || !content) return;
    const { summary } = data;
    const loc = r => r.branch_name || 'No location';
    const sorters = {
      qty: (a, b) => a.on_hand - b.on_hand || String(a.product_name).localeCompare(String(b.product_name)),
      value: (a, b) => a.value - b.value,
      location: (a, b) => loc(a).localeCompare(loc(b)) || String(a.product_name).localeCompare(String(b.product_name)),
      name: (a, b) => String(a.product_name || '').localeCompare(String(b.product_name || '')) || loc(a).localeCompare(loc(b)),
      sold: (a, b) => String(b.last_sold || '').localeCompare(String(a.last_sold || '')),
    };
    const items = [...data.items].sort(sorters[document.getElementById('zns-sort')?.value] || sorters.qty);
    const qty = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
    const statusLabel = { all: 'Zero and negative', negative: 'Negative only', zero: 'Zero only' }[data.status];

    content.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">On hand now · ${statusLabel} · ${data.branchName ? this.escapeAttr(data.branchName) : 'All locations'}</div>
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card"><div class="stat-label">Items</div><div class="stat-value">${summary.items}</div><div class="stat-sub">${summary.lines} item-location line${summary.lines === 1 ? '' : 's'}</div></div>
        <div class="stat-card red"><div class="stat-label">Negative</div><div class="stat-value" style="color:var(--danger)">${summary.negative}</div><div class="stat-sub">${qty(summary.negative_units)} units in all</div></div>
        <div class="stat-card orange"><div class="stat-label">Zero</div><div class="stat-value">${summary.zero}</div></div>
        <div class="stat-card blue"><div class="stat-label">Negative Value at Cost</div><div class="stat-value" style="font-size:20px;color:${summary.negative_value < 0 ? 'var(--danger)' : 'inherit'}">${this.fmt(summary.negative_value)}</div></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Zero &amp; Negative Stock</span></div>
        ${!items.length ? '<div class="empty-state"><p>No items at or below zero.</p></div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>Location</th><th>SKU</th><th>Item</th><th>Category</th><th>Brand</th><th>On Hand</th><th>Min</th><th>Cost</th><th>Value at Cost</th><th>Last Sold</th><th>Last Received</th></tr></thead>
          <tbody>${items.map(r => `<tr>
            <td>${this.escapeAttr(loc(r))}</td>
            <td style="font-family:monospace;font-size:12px">${this.escapeAttr(r.sku || '')}</td>
            <td class="fw-600" style="min-width:200px">${this.escapeAttr(r.product_name || '')}${r.active ? '' : ' <span class="badge-pill badge-warning" style="font-size:10px">Inactive</span>'}</td>
            <td>${this.escapeAttr(r.category_name || '')}</td>
            <td>${this.escapeAttr(r.brand || '—')}</td>
            <td class="fw-600"${r.on_hand < 0 ? ' style="color:var(--danger)"' : ''}>${qty(r.on_hand)}</td>
            <td>${r.min_stock == null ? '—' : qty(r.min_stock)}</td>
            <td>${this.fmt(r.cost)}</td>
            <td${r.value < 0 ? ' style="color:var(--danger)"' : ''}>${this.fmt(r.value)}</td>
            <td>${r.last_sold ? this.fmtDate(r.last_sold) : '—'}</td>
            <td>${r.last_received ? this.fmtDate(r.last_received) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table></div>`}
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">Inventory items only — no services, rentals or non-inventory items. One line per item per location; an item not set up at any location shows its overall stock as "No location". Value at cost = on hand × the item's current cost. Last sold / last received are at that location (completed sales; purchase-order receipts and receipts without a PO, not reversed).</p>`;
  },

  // ─── Items Sold ─────────────────────────────────────────────────────────
  // GET /reports/items-sold — per-item totals net of returns. Range presets
  // are shared with Supplier Item Sales.

  async showItemsSoldReport() {
    const [branches, categories, brands] = await Promise.all([
      this.api('GET', '/branches').catch(() => []),
      this.api('GET', '/categories').catch(() => []),
      this.api('GET', '/brands').catch(() => []),
    ]);
    const filters = `
      <select id="isr-range" onchange="App._applyItemsSoldRange()" style="width:150px">
        <option value="this_month">This month</option><option value="today">Today</option><option value="this_week">This week</option>
        <option value="last_month">Last month</option><option value="last_3_months">Last 3 months</option><option value="this_quarter">This quarter</option>
        <option value="last_12_months">Last 12 months</option><option value="this_year">This year</option><option value="last_year">Last year</option>
        <option value="custom">Custom</option>
      </select>
      <input type="date" id="isr-start" style="width:145px" onchange="document.getElementById('isr-range').value='custom'">
      <span>to</span>
      <input type="date" id="isr-end" style="width:145px" onchange="document.getElementById('isr-range').value='custom'">
      <select id="isr-branch" style="width:150px"><option value="">All Locations</option>${(branches || []).filter(b => b.active && !b.is_warehouse).map(b => `<option value="${b.id}">${this.escapeAttr(b.name)}</option>`).join('')}</select>
      <select id="isr-category" style="width:160px"><option value="">All Categories</option><option value="none">Uncategorized</option>${(categories || []).map(c => `<option value="${c.id}">${this.escapeAttr(c.name)}</option>`).join('')}</select>
      <select id="isr-brand" style="width:150px"><option value="">All Brands</option>${(brands || []).map(b => `<option value="${this.escapeAttr(b.name || '')}">${this.escapeAttr(b.name || '')}</option>`).join('')}</select>
      <select id="isr-type" style="width:170px" title="Which items to include">
        <option value="stock">Inventory items only</option><option value="all">All items (incl. services &amp; rentals)</option>
      </select>
      <input type="text" id="isr-q" placeholder="Item name, SKU or barcode" style="width:200px" onkeydown="if(event.key==='Enter')App.loadItemsSoldReport()">
      <select id="isr-sort" style="width:160px" onchange="App._renderItemsSold()" title="Sort items by">
        <option value="units">Most units sold</option><option value="sales">Highest net sales</option><option value="margin">Highest margin</option>
        <option value="returns">Most returned</option><option value="name">Item name A–Z</option>
      </select>`;
    this._showReportModal('Items Sold', filters, 'loadItemsSoldReport');
    document.querySelector('#rpt-modal-content')?.closest('.modal')?.style.setProperty('max-width', '1150px');
  },

  _applyItemsSoldRange() {
    const r = this._supplierSalesRanges()[document.getElementById('isr-range')?.value];
    if (!r) return;
    document.getElementById('isr-start').value = r[0];
    document.getElementById('isr-end').value = r[1];
  },

  async loadItemsSoldReport() {
    const startEl = document.getElementById('isr-start');
    if (!startEl) return;
    if (!startEl.value) this._applyItemsSoldRange();
    const params = new URLSearchParams({ start: startEl.value, end: document.getElementById('isr-end').value, type: document.getElementById('isr-type').value });
    for (const [id, key] of [['isr-branch', 'branch_id'], ['isr-category', 'category_id'], ['isr-brand', 'brand'], ['isr-q', 'q']]) {
      const v = document.getElementById(id).value.trim();
      if (v) params.set(key, v);
    }
    const content = document.getElementById('rpt-modal-content');
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/items-sold?${params}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;
    const branchSel = document.getElementById('isr-branch');
    data.branchName = branchSel.value ? branchSel.options[branchSel.selectedIndex].text : '';
    this._itemsSoldData = data;
    this._renderItemsSold();
  },

  _renderItemsSold() {
    const data = this._itemsSoldData;
    const content = document.getElementById('rpt-modal-content');
    if (!data || !content) return;
    const { summary } = data;
    const sorters = {
      units: (a, b) => b.net_units - a.net_units || b.net_sales - a.net_sales,
      sales: (a, b) => b.net_sales - a.net_sales,
      margin: (a, b) => b.margin - a.margin,
      returns: (a, b) => b.ret_units - a.ret_units || b.returns - a.returns,
      name: (a, b) => String(a.product_name || '').localeCompare(String(b.product_name || '')),
    };
    const items = [...data.items].sort(sorters[document.getElementById('isr-sort')?.value] || sorters.units);
    const marginColor = pct => pct == null ? 'var(--text-muted)' : pct < 0 ? 'var(--danger)' : pct < 15 ? 'var(--warning)' : 'var(--success)';
    const qty = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
    const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    content.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${fmtDate(data.start)} – ${fmtDate(data.end)}${data.branchName ? ' · ' + this.escapeAttr(data.branchName) : ' · All locations'}</div>
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card"><div class="stat-label">Units Sold (net)</div><div class="stat-value">${qty(summary.net_units)}</div><div class="stat-sub">${summary.items} item${summary.items === 1 ? '' : 's'} · ${qty(summary.units)} sold · ${qty(summary.ret_units)} returned</div></div>
        <div class="stat-card blue"><div class="stat-label">Net Sales</div><div class="stat-value" style="font-size:20px">${this.fmt(summary.net_sales)}</div><div class="stat-sub">${this.fmt(summary.returns)} returned</div></div>
        <div class="stat-card orange"><div class="stat-label">Cost</div><div class="stat-value" style="font-size:20px">${this.fmt(summary.cost)}</div></div>
        <div class="stat-card green"><div class="stat-label">Margin</div><div class="stat-value" style="font-size:20px;color:${marginColor(summary.margin_percent)}">${this.fmt(summary.margin)} <span style="font-size:13px">(${summary.margin_percent == null ? '—' : summary.margin_percent + '%'})</span></div></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Items Sold</span></div>
        ${!items.length ? '<div class="empty-state"><p>No items sold in this range.</p></div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>SKU</th><th>Item</th><th>Category</th><th>Brand</th><th>Sales</th><th>Units Sold</th><th>Returned</th><th>Net Units</th><th>Avg Price</th><th>Net Sales</th><th>Cost</th><th>Margin</th><th>On Hand${data.branchName ? ' (branch)' : ''}</th></tr></thead>
          <tbody>${items.map(r => `<tr>
            <td style="font-family:monospace;font-size:12px">${this.escapeAttr(r.sku || '')}</td>
            <td class="fw-600" style="min-width:200px">${this.escapeAttr(r.product_name || '')}</td>
            <td>${this.escapeAttr(r.category_name || '')}</td>
            <td>${this.escapeAttr(r.brand || '—')}</td>
            <td>${r.sales_count}</td>
            <td>${qty(r.units)}</td>
            <td${r.ret_units ? ' style="color:var(--danger)"' : ''}>${qty(r.ret_units)}</td>
            <td class="fw-600">${qty(r.net_units)}</td>
            <td>${r.avg_price == null ? '—' : this.fmt(r.avg_price)}</td>
            <td class="fw-600">${this.fmt(r.net_sales)}</td>
            <td>${this.fmt(r.cost)}</td>
            <td style="color:${marginColor(r.margin_percent)};font-weight:600">${this.fmt(r.margin)} (${r.margin_percent == null ? '—' : r.margin_percent + '%'})</td>
            <td${r.on_hand != null && r.on_hand <= 0 ? ' style="color:var(--danger)"' : ''}>${r.on_hand == null ? '—' : qty(r.on_hand)}</td>
          </tr>`).join('')}</tbody>
        </table></div>`}
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">Completed sales only. Units are in each item's stock unit (a case of 12 counts as 12). Returns are counted on the day they were processed. Cost uses each item's current cost. "Sales" is the number of tickets the item was on.</p>`;
  },

  // ─── Supplier Item Sales ────────────────────────────────────────────────
  // An item counts toward the supplier set on the product, or else the
  // supplier of the latest PO it was on (GET /reports/supplier-item-sales).

  _supplierSalesRanges() {
    const d = new Date(), y = d.getFullYear(), m = d.getMonth();
    const iso = x => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const today = iso(d);
    const monday = new Date(y, m, d.getDate() - ((d.getDay() + 6) % 7));
    const q = Math.floor(m / 3) * 3;
    return {
      today: [today, today, 'day'],
      this_week: [iso(monday), today, 'day'],
      this_month: [iso(new Date(y, m, 1)), today, 'day'],
      last_month: [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0)), 'day'],
      last_3_months: [iso(new Date(y, m - 2, 1)), today, 'month'],
      this_quarter: [iso(new Date(y, q, 1)), today, 'month'],
      last_12_months: [iso(new Date(y, m - 11, 1)), today, 'month'],
      this_year: [iso(new Date(y, 0, 1)), today, 'month'],
      last_year: [iso(new Date(y - 1, 0, 1)), iso(new Date(y - 1, 11, 31)), 'quarter'],
    };
  },

  async showSupplierItemSalesReport(supplierId) {
    const branches = (await this.api('GET', '/branches').catch(() => []) || []).filter(b => b.active && !b.is_warehouse);
    const filters = `
      <select id="sis-range" onchange="App._applySupplierSalesRange()" style="width:150px">
        <option value="this_month">This month</option><option value="today">Today</option><option value="this_week">This week</option>
        <option value="last_month">Last month</option><option value="last_3_months">Last 3 months</option><option value="this_quarter">This quarter</option>
        <option value="last_12_months">Last 12 months</option><option value="this_year">This year</option><option value="last_year">Last year</option>
        <option value="custom">Custom</option>
      </select>
      <input type="date" id="sis-start" style="width:145px" onchange="document.getElementById('sis-range').value='custom'">
      <span>to</span>
      <input type="date" id="sis-end" style="width:145px" onchange="document.getElementById('sis-range').value='custom'">
      <select id="sis-period" title="Break the trend down by" style="width:120px">
        <option value="day">By day</option><option value="week">By week</option><option value="month">By month</option><option value="quarter">By quarter</option><option value="year">By year</option>
      </select>
      <select id="sis-branch" style="width:150px"><option value="">All Locations</option>${branches.map(b => `<option value="${b.id}">${this.escapeAttr(b.name)}</option>`).join('')}</select>
      <select id="sis-supplier" style="width:200px"><option value="">All suppliers</option></select>`;
    this._sisSupplier = supplierId ? String(supplierId) : '';
    this._showReportModal('Supplier Item Sales', filters, 'loadSupplierItemSalesReport');
    document.querySelector('#rpt-modal-content')?.closest('.modal')?.style.setProperty('max-width', '1100px');
  },

  _applySupplierSalesRange() {
    const r = this._supplierSalesRanges()[document.getElementById('sis-range')?.value];
    if (!r) return;
    document.getElementById('sis-start').value = r[0];
    document.getElementById('sis-end').value = r[1];
    document.getElementById('sis-period').value = r[2];
  },

  _drillSupplierSales(id) {
    const sel = document.getElementById('sis-supplier');
    if (!sel) return;
    if (![...sel.options].some(o => o.value === String(id))) sel.add(new Option(String(id), String(id)));
    sel.value = String(id);
    this.loadSupplierItemSalesReport();
  },

  async loadSupplierItemSalesReport() {
    const startEl = document.getElementById('sis-start');
    if (!startEl) return;
    if (!startEl.value) this._applySupplierSalesRange();
    const sel = document.getElementById('sis-supplier');
    if (this._sisSupplier != null) { if (this._sisSupplier) { sel.add(new Option('…', this._sisSupplier)); sel.value = this._sisSupplier; } this._sisSupplier = null; }
    const params = new URLSearchParams({ start: startEl.value, end: document.getElementById('sis-end').value, period: document.getElementById('sis-period').value });
    const branchId = document.getElementById('sis-branch').value;
    if (branchId) params.set('branch_id', branchId);
    const supplierId = sel.value;
    if (supplierId) params.set('supplier_id', supplierId);
    const content = document.getElementById('rpt-modal-content');
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/supplier-item-sales?${params}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    // Supplier choices = those with sales in the range (plus the one picked).
    const keyOf = r => r.supplier_id == null ? 'none' : String(r.supplier_id);
    const picked = data.bySupplier.find(r => keyOf(r) === supplierId);
    sel.innerHTML = `<option value="">All suppliers</option>${data.bySupplier.map(r => `<option value="${keyOf(r)}">${this.escapeAttr(r.supplier_name)}</option>`).join('')}${supplierId && !picked ? `<option value="${this.escapeAttr(supplierId)}">(no sales in range)</option>` : ''}`;
    sel.value = supplierId;

    const { summary, bySupplier, byPeriod, items, itemPeriods } = data;
    const marginColor = pct => pct == null ? 'var(--text-muted)' : pct < 0 ? 'var(--danger)' : pct < 15 ? 'var(--warning)' : 'var(--success)';
    const marginCell = r => `<td style="color:${marginColor(r.margin_percent)};font-weight:600">${this.fmt(r.margin)} (${r.margin_percent == null ? '—' : r.margin_percent + '%'})</td>`;
    const qty = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
    const periodLabel = p => {
      if (data.period === 'day') return new Date(p + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      if (data.period === 'week') return 'Wk of ' + new Date(p + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      if (data.period === 'month') return new Date(p + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      return p;
    };
    const scopeName = supplierId ? (picked ? picked.supplier_name : 'this supplier') : 'all suppliers';
    const periods = byPeriod.map(p => p.period);
    const grid = {};
    for (const r of itemPeriods || []) (grid[r.product_id] ||= {})[r.period] = r.net_units;

    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card"><div class="stat-label">Units Sold (net)</div><div class="stat-value">${qty(summary.net_units)}</div><div class="stat-sub">${qty(summary.units)} sold · ${qty(summary.ret_units)} returned</div></div>
        <div class="stat-card blue"><div class="stat-label">Net Sales</div><div class="stat-value" style="font-size:20px">${this.fmt(summary.net_sales)}</div><div class="stat-sub">${this.fmt(summary.returns)} returned</div></div>
        <div class="stat-card orange"><div class="stat-label">Cost</div><div class="stat-value" style="font-size:20px">${this.fmt(summary.cost)}</div></div>
        <div class="stat-card green"><div class="stat-label">Margin</div><div class="stat-value" style="font-size:20px;color:${marginColor(summary.margin_percent)}">${this.fmt(summary.margin)} <span style="font-size:13px">(${summary.margin_percent == null ? '—' : summary.margin_percent + '%'})</span></div></div>
      </div>
      ${!supplierId ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Supplier</span><span style="font-size:12px;color:var(--text-muted)">Click a supplier to see its items</span></div>
        ${!bySupplier.length ? '<div class="empty-state"><p>No item sales in this range.</p></div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>Supplier</th><th>Items</th><th>Units Sold</th><th>Returned</th><th>Net Sales</th><th>Cost</th><th>Margin</th></tr></thead>
          <tbody>${bySupplier.map(r => `<tr style="cursor:pointer" onclick="App._drillSupplierSales('${keyOf(r)}')">
            <td class="fw-600" style="color:var(--primary)">${this.escapeAttr(r.supplier_name)}</td><td>${r.items}</td><td>${qty(r.units)}</td><td>${qty(r.ret_units)}</td>
            <td class="fw-600">${this.fmt(r.net_sales)}</td><td>${this.fmt(r.cost)}</td>${marginCell(r)}</tr>`).join('')}</tbody>
        </table></div>`}
      </div>` : ''}
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By ${{ day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' }[data.period]} — ${this.escapeAttr(scopeName)}</span></div>
        ${!byPeriod.length ? '<div class="empty-state"><p>No item sales in this range.</p></div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>Period</th><th>Units Sold</th><th>Returned</th><th>Net Sales</th><th>Cost</th><th>Margin</th></tr></thead>
          <tbody>${byPeriod.map(r => `<tr><td class="fw-600">${periodLabel(r.period)}</td><td>${qty(r.units)}</td><td>${qty(r.ret_units)}</td><td class="fw-600">${this.fmt(r.net_sales)}</td><td>${this.fmt(r.cost)}</td>${marginCell(r)}</tr>`).join('')}</tbody>
        </table></div>`}
      </div>
      ${supplierId ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">Items — ${this.escapeAttr(scopeName)}</span><a href="#" style="font-size:12px" onclick="event.preventDefault();App._drillSupplierSales('')">← All suppliers</a></div>
        ${!items.length ? '<div class="empty-state"><p>None of this supplier\'s items sold in this range.</p></div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>SKU</th><th>Item</th><th>Units Sold</th><th>Returned</th><th>Net Sales</th><th>Cost</th><th>Margin</th></tr></thead>
          <tbody>${items.map(r => `<tr><td style="font-family:monospace;font-size:12px">${this.escapeAttr(r.sku || '')}</td><td class="fw-600">${this.escapeAttr(r.product_name)}</td><td>${qty(r.units)}</td><td>${qty(r.ret_units)}</td><td class="fw-600">${this.fmt(r.net_sales)}</td><td>${this.fmt(r.cost)}</td>${marginCell(r)}</tr>`).join('')}</tbody>
        </table></div>`}
      </div>
      ${items.length && periods.length > 1 ? `
      <div class="card">
        <div class="card-header"><span class="card-title">Net Units by Item &amp; ${{ day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' }[data.period]}</span></div>
        <div class="table-wrap" style="overflow-x:auto"><table>
          <thead><tr><th>Item</th>${periods.map(p => `<th style="white-space:nowrap">${periodLabel(p)}</th>`).join('')}<th>Total</th></tr></thead>
          <tbody>${items.map(r => `<tr><td class="fw-600" style="white-space:nowrap">${this.escapeAttr(r.product_name)}</td>${periods.map(p => `<td style="text-align:center${grid[r.product_id]?.[p] ? '' : ';color:var(--text-muted)'}">${grid[r.product_id]?.[p] ? qty(grid[r.product_id][p]) : '—'}</td>`).join('')}<td class="fw-600" style="text-align:center">${qty(r.net_units)}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : ''}` : ''}
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">An item counts toward the supplier set on the product, or if none, the supplier of the latest PO it was on. Returns are counted on the day they were processed. Cost uses each item's current cost.</p>`;
  },

  // ─── Cash Drawer Variance Trend ─────────────────────────────────────────

  showCashVarianceReport() {
    this._showReportModal('Cash Drawer Variance Trend', this._reportDateRangeFilters('cv-start','cv-end'), 'loadCashVarianceReport');
  },

  async loadCashVarianceReport() {
    const start = document.getElementById('cv-start')?.value || '';
    const end = document.getElementById('cv-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/cash-variance?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, byEmployee, sessions } = data;
    const varColor = v => v > 0.005 ? 'var(--success)' : v < -0.005 ? 'var(--danger)' : 'var(--text-muted)';
    const varLabel = v => v > 0.005 ? `+${this.fmt(v)} over` : v < -0.005 ? `${this.fmt(v)} short` : 'exact';
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Reconciliations</div><div class="stat-value">${summary.session_count}</div></div>
        <div class="stat-card ${summary.total_variance<0?'red':'green'}"><div class="stat-label">Net Variance</div><div class="stat-value">${varLabel(summary.total_variance)}</div></div>
        <div class="stat-card green"><div class="stat-label">Over</div><div class="stat-value">${summary.over_count}</div></div>
        <div class="stat-card red"><div class="stat-label">Short</div><div class="stat-value">${summary.short_count}</div></div>
      </div>
      ${!byEmployee.length ? '<div class="empty-state"><p>No reconciled sessions in this range.</p></div>' : `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Employee</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Employee</th><th>Sessions</th><th>Over</th><th>Short</th><th>Net Variance</th><th>Avg / Session</th></tr></thead>
            <tbody>${byEmployee.map(r => `
              <tr>
                <td class="fw-600">${r.name}</td>
                <td>${r.session_count}</td>
                <td>${r.over_count}</td>
                <td>${r.short_count}</td>
                <td style="color:${varColor(r.total_variance)};font-weight:600">${this.fmt(r.total_variance)}</td>
                <td>${this.fmt(r.avg_variance)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Trend (most recent first)</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Employee</th><th>Branch</th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead>
            <tbody>${sessions.map(r => `
              <tr>
                <td style="color:var(--text-muted)">${this.fmtDateTime(r.reconciled_at)}</td>
                <td>${r.employee_name||'—'}</td>
                <td>${r.branch_name||'—'}</td>
                <td>${this.fmt(r.expected_cash)}</td>
                <td>${this.fmt(r.cash_counted)}</td>
                <td style="color:${varColor(r.variance)};font-weight:600">${this.fmt(r.variance)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Credit Risk / Exposure ─────────────────────────────────────────────

  showCreditRiskReport() {
    this.showModal(`
      <div class="modal" style="max-width:820px">
        <div class="modal-header"><span class="modal-title">Credit Risk / Exposure</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="max-height:75vh;overflow-y:auto">
          <div id="rpt-modal-content" data-report-title="Credit Risk / Exposure"><div class="empty-state"><p>Loading...</p></div></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.printReport('rpt-modal-content')">🖨 Print</button>
          <button class="btn btn-outline" onclick="App.exportReportCsv('rpt-modal-content')">⬇ Export CSV</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
    this.loadCreditRiskReport();
  },

  async loadCreditRiskReport() {
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    let data;
    try { data = await this.api('GET', '/reports/credit-risk'); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, customers } = data;
    const riskBadge = { blocked: 'badge-danger', over_limit: 'badge-danger', near_limit: 'badge-warning', ok: 'badge-success' };
    const riskLabel = { blocked: 'Blocked', over_limit: 'Over Limit', near_limit: 'Near Limit', ok: 'OK' };
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Customers w/ Balance</div><div class="stat-value">${summary.at_risk_count}</div></div>
        <div class="stat-card red"><div class="stat-label">Blocked</div><div class="stat-value">${summary.blocked_count}</div></div>
        <div class="stat-card orange"><div class="stat-label">Over/Near Limit</div><div class="stat-value">${summary.over_limit_count + summary.near_limit_count}</div></div>
        <div class="stat-card purple"><div class="stat-label">Total Exposure</div><div class="stat-value">${this.fmt(summary.total_exposure)}</div></div>
      </div>
      ${!customers.length ? '<div class="empty-state"><p>No outstanding credit balances.</p></div>' : `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Balance</th><th>Limit</th><th>% of Limit</th><th>Status</th><th>Days to Block</th></tr></thead>
            <tbody>${customers.map(c => `
              <tr>
                <td class="fw-600">${c.customer_name} <span style="color:var(--text-muted);font-size:11px">(${c.customer_number})</span></td>
                <td>${this.fmt(c.account_balance)}</td>
                <td>${c.credit_limit > 0 ? this.fmt(c.credit_limit) : '—'}</td>
                <td>${c.pct_of_limit!=null?c.pct_of_limit+'%':'—'}</td>
                <td><span class="badge-pill ${riskBadge[c.risk_level]}" style="font-size:10px">${riskLabel[c.risk_level]}</span></td>
                <td>${c.days_to_block==null?'—':(c.days_to_block<=0?`<span style="color:var(--danger)">overdue ${-c.days_to_block}d</span>`:`${c.days_to_block}d`)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Tax Collected ───────────────────────────────────────────────────────

  showTaxCollectedReport() {
    this._showReportModal('Tax Collected', this._reportDateRangeFilters('tc-start','tc-end'), 'loadTaxCollectedReport');
  },

  async loadTaxCollectedReport() {
    const start = document.getElementById('tc-start')?.value || '';
    const end = document.getElementById('tc-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/tax-collected?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, byDay, byBranch } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Taxable Sales</div><div class="stat-value">${this.fmt(summary.taxable_sales)}</div></div>
        <div class="stat-card green"><div class="stat-label">Tax Collected</div><div class="stat-value">${this.fmt(summary.tax_collected)}</div></div>
        <div class="stat-card purple"><div class="stat-label">Effective Rate</div><div class="stat-value">${summary.effective_rate==null?'—':summary.effective_rate+'%'}</div></div>
      </div>
      ${byBranch.length > 1 ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Branch</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Branch</th><th>Taxable Sales</th><th>Tax Collected</th></tr></thead>
            <tbody>${byBranch.map(r => `<tr><td class="fw-600">${r.branch_name||'—'}</td><td>${this.fmt(r.taxable_sales)}</td><td>${this.fmt(r.tax_collected)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}
      ${!byDay.length ? '<div class="empty-state"><p>No completed sales in this range.</p></div>' : `
      <div class="card">
        <div class="card-header"><span class="card-title">By Day</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Taxable Sales</th><th>Tax Collected</th></tr></thead>
            <tbody>${byDay.map(r => `<tr><td class="fw-600">${this.fmtDate(r.date)}</td><td>${this.fmt(r.taxable_sales)}</td><td>${this.fmt(r.tax_collected)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Write-Off / Bad Debt ───────────────────────────────────────────────

  showWriteoffReport() {
    this._showReportModal('Write-Off / Bad Debt', this._reportDateRangeFilters('wor-start','wor-end'), 'loadWriteoffReport');
  },

  async loadWriteoffReport() {
    const start = document.getElementById('wor-start')?.value || '';
    const end = document.getElementById('wor-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/writeoffs?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, byCustomer, records } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:18px">
        <div class="stat-card orange"><div class="stat-label">Write-Offs</div><div class="stat-value">${summary.writeoff_count}</div></div>
        <div class="stat-card red"><div class="stat-label">Total Written Off</div><div class="stat-value">${this.fmt(summary.total_written_off)}</div></div>
      </div>
      ${!records.length ? '<div class="empty-state"><p>No write-offs in this range.</p></div>' : `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Customer</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Write-Offs</th><th>Total</th></tr></thead>
            <tbody>${byCustomer.map(r => `<tr><td class="fw-600">${r.customer_name} <span style="color:var(--text-muted);font-size:11px">(${r.customer_number})</span></td><td>${r.writeoff_count}</td><td>${this.fmt(r.total_written_off)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Records</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Customer</th><th>Amount</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>${records.map(r => `
              <tr>
                <td style="color:var(--text-muted)">${this.fmtDate(r.created_at)}</td>
                <td class="fw-600">${r.customer_name}</td>
                <td>${this.fmt(r.amount)}</td>
                <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.escapeAttr(r.reason)}">${r.reason||'—'}</td>
                <td>${r.employee_name||'—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Rental Deposits ─────────────────────────────────────────────────────

  showRentalDepositReport() {
    const filters = `${this._reportDateRangeFilters('rdr-start','rdr-end')}
      <select id="rdr-basis" style="width:auto" title="Which date the range applies to">
        <option value="deposit">By deposit date</option>
        <option value="settled">By return date</option>
      </select>`;
    this._showReportModal('Rental Deposits', filters, 'loadRentalDepositReport');
  },

  async loadRentalDepositReport() {
    const start = document.getElementById('rdr-start')?.value || '';
    const end = document.getElementById('rdr-end')?.value || '';
    const basis = document.getElementById('rdr-basis')?.value || 'deposit';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/rental-deposits?start=${start}&end=${end}&basis=${basis}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, counts, byBranch, records } = data;
    const dispLabel = {
      held: ['Held', 'badge-info'], used: ['Fully Used', 'badge-danger'],
      refunded_cash: ['Refunded — Cash', 'badge-success'], refunded_bank_transfer: ['Refunded — Bank Transfer', 'badge-success'],
      refunded_original_card: ['Refunded — Original Card', 'badge-success'], refund_pending: ['Refund Due', 'badge-warning'],
      credit_note: ['Credit Note', 'badge-teal'], applied_to_account: ['Applied to Account', 'badge-info'],
    };
    const amt = v => v > 0 ? this.fmt(v) : '<span style="color:var(--text-muted)">—</span>';
    const breakdown = [
      ['Used (fees / damage)', 'used'],
      ['Refunded — Cash', 'refunded_cash'],
      ['Refunded — Bank Transfer', 'refunded_bank_transfer'],
      ['Refunded — Original Card', 'refunded_original_card'],
      ['Applied to Customer Credit Note', 'credit_note'],
      ['Applied to Credit Account Balance', 'applied_to_account'],
      ['Refund Due (method not recorded)', 'refund_pending'],
      ['Still Held (open rentals)', 'held'],
    ];
    const pct = v => summary.collected > 0 ? (v / summary.collected * 100).toFixed(1) + '%' : '—';
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Deposits Collected</div><div class="stat-value">${this.fmt(summary.collected)}</div></div>
        <div class="stat-card orange"><div class="stat-label">Used</div><div class="stat-value">${this.fmt(summary.used)}</div></div>
        <div class="stat-card green"><div class="stat-label">Refunded</div><div class="stat-value">${this.fmt(summary.refunded)}</div></div>
        <div class="stat-card purple"><div class="stat-label">Credit Notes</div><div class="stat-value">${this.fmt(summary.credit_note)}</div></div>
      </div>
      ${!records.length ? '<div class="empty-state"><p>No rental deposits in this range.</p></div>' : `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">Breakdown (${summary.agreement_count} agreement${summary.agreement_count===1?'':'s'})</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Disposition</th><th>Agreements</th><th>Amount</th><th>% of Collected</th></tr></thead>
            <tbody>${breakdown.map(([label, k]) => `<tr><td class="fw-600">${label}</td><td>${counts[k]}</td><td>${this.fmt(summary[k])}</td><td>${pct(summary[k])}</td></tr>`).join('')}
              <tr style="border-top:2px solid var(--border)"><td class="fw-600">Total Collected</td><td>${summary.agreement_count}</td><td class="fw-600">${this.fmt(summary.collected)}</td><td>100%</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      ${summary.fee_refund > 0 ? `<p style="font-size:11px;color:var(--text-muted);margin:-8px 0 16px">Early returns also refunded ${this.fmt(summary.fee_refund)} of unused prepaid rental fees on top of these deposits — not included above, since it wasn't deposit money.</p>` : ''}
      ${byBranch.length > 1 ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Branch</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Branch</th><th>Collected</th><th>Used</th><th>Refunded</th><th>Credit Notes</th><th>To Account</th><th>Refund Due</th><th>Held</th></tr></thead>
            <tbody>${byBranch.map(r => `<tr><td class="fw-600">${r.branch_name||'—'}</td><td>${this.fmt(r.collected)}</td><td>${this.fmt(r.used)}</td><td>${this.fmt(r.refunded)}</td><td>${this.fmt(r.credit_note)}</td><td>${this.fmt(r.applied_to_account)}</td><td>${this.fmt(r.refund_pending)}</td><td>${this.fmt(r.held)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}
      <div class="card">
        <div class="card-header"><span class="card-title">Agreements</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Deposit Date</th><th>Agreement</th><th>Customer</th><th>Deposit</th><th>Used</th><th>Refunded</th><th>Credit Note</th><th>To Account</th><th>Outstanding</th><th>Status</th></tr></thead>
            <tbody>${records.map(r => {
              const [label, badge] = dispLabel[r.disposition] || [r.disposition, 'badge-secondary'];
              const refunded = r.refunded_cash + r.refunded_bank_transfer + r.refunded_original_card;
              return `<tr>
                <td style="color:var(--text-muted)">${this.fmtDate(r.deposit_date)}</td>
                <td class="fw-600">${r.agreement_number}</td>
                <td>${r.customer_name||'—'}</td>
                <td>${this.fmt(r.collected)}</td>
                <td>${amt(r.used)}</td>
                <td>${amt(refunded)}</td>
                <td>${amt(r.credit_note)}</td>
                <td>${amt(r.applied_to_account)}</td>
                <td>${amt(r.held + r.refund_pending)}</td>
                <td><span class="badge-pill ${badge}" style="font-size:10px">${label}</span></td>
              </tr>`;
            }).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Gross Margin (COGS) ─────────────────────────────────────────────────

  showGrossMarginReport() {
    this._showReportModal('Gross Margin (COGS)', this._reportDateRangeFilters('gm-start','gm-end'), 'loadGrossMarginReport');
  },

  async loadGrossMarginReport() {
    const start = document.getElementById('gm-start')?.value || '';
    const end = document.getElementById('gm-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/gross-margin?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, byCategory, byBranch } = data;
    const marginColor = pct => pct == null ? 'var(--text-muted)' : pct < 0 ? 'var(--danger)' : pct < 15 ? 'var(--warning)' : 'var(--success)';
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Revenue</div><div class="stat-value">${this.fmt(summary.revenue)}</div></div>
        <div class="stat-card orange"><div class="stat-label">Cost</div><div class="stat-value">${this.fmt(summary.cost)}</div></div>
        <div class="stat-card green"><div class="stat-label">Margin</div><div class="stat-value" style="color:${marginColor(summary.margin_percent)}">${this.fmt(summary.margin)} <span style="font-size:13px">(${summary.margin_percent==null?'—':summary.margin_percent+'%'})</span></div></div>
      </div>
      ${byBranch.length > 1 ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Branch</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Branch</th><th>Revenue</th><th>Cost</th><th>Margin</th></tr></thead>
            <tbody>${byBranch.map(r => `<tr><td class="fw-600">${r.branch_name||'—'}</td><td>${this.fmt(r.revenue)}</td><td>${this.fmt(r.cost)}</td><td style="color:${marginColor(r.margin_percent)};font-weight:600">${this.fmt(r.margin)} (${r.margin_percent==null?'—':r.margin_percent+'%'})</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>` : ''}
      ${!byCategory.length ? '<div class="empty-state"><p>No completed sales in this range.</p></div>' : `
      <div class="card">
        <div class="card-header"><span class="card-title">By Category</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Revenue</th><th>Cost</th><th>Margin</th></tr></thead>
            <tbody>${byCategory.map(r => `<tr><td class="fw-600">${r.category_name}</td><td>${this.fmt(r.revenue)}</td><td>${this.fmt(r.cost)}</td><td style="color:${marginColor(r.margin_percent)};font-weight:600">${this.fmt(r.margin)} (${r.margin_percent==null?'—':r.margin_percent+'%'})</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Sales by Branch & Department ───────────────────────────────────────

  showSalesByDepartmentReport() {
    this._showReportModal('Sales by Branch &amp; Department', this._reportDateRangeFilters('sbd-start','sbd-end'), 'loadSalesByDepartmentReport');
  },

  async loadSalesByDepartmentReport() {
    const start = document.getElementById('sbd-start')?.value || '';
    const end = document.getElementById('sbd-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/sales-by-department?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { departments, branches, totals } = data;
    const labels = { retail: 'Retail', rental: 'Rental', work_order: 'Work Orders', special_project: 'Special Projects' };
    const colors = { retail: 'blue', rental: 'orange', work_order: 'purple', special_project: 'green' };
    const pct = (part, whole) => whole ? (part / whole * 100).toFixed(1) + '%' : '—';
    // Intl puts a non-breaking space after the currency code ("JMD 868,049.85"),
    // so a big total can't wrap and spills out of a narrow card — let it break there.
    const money = n => this.fmt(n).replace(/\u00a0/g, ' ');
    const valStyle = 'font-size:18px;line-height:1.25;overflow-wrap:anywhere';
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:18px">
        <div class="stat-card" style="grid-column:1/-1;min-width:0"><div class="stat-label">Total Sales</div><div class="stat-value" style="font-size:24px;overflow-wrap:anywhere">${money(totals.total)}</div><div class="stat-sub">${totals.transaction_count} transactions</div></div>
        ${departments.map(d => `<div class="stat-card ${colors[d]}" style="min-width:0;padding:14px"><div class="stat-label">${labels[d]}</div><div class="stat-value" style="${valStyle}">${money(totals.departments[d].total)}</div><div class="stat-sub">${pct(totals.departments[d].total, totals.total)} of total</div></div>`).join('')}
      </div>
      ${!branches.length ? '<div class="empty-state"><p>No completed sales in this range.</p></div>' : `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Branch</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Branch</th>${departments.map(d => `<th>${labels[d]}</th>`).join('')}<th>Branch Total</th></tr></thead>
            <tbody>${branches.map(b => `
              <tr>
                <td class="fw-600">${b.branch_name}</td>
                ${departments.map(d => `<td>${this.fmt(b.departments[d].total)}</td>`).join('')}
                <td class="fw-600">${this.fmt(b.total)}</td>
              </tr>`).join('')}
              <tr style="border-top:2px solid var(--border)">
                <td class="fw-600">All Branches</td>
                ${departments.map(d => `<td class="fw-600">${this.fmt(totals.departments[d].total)}</td>`).join('')}
                <td class="fw-600">${this.fmt(totals.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      ${branches.map(b => `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">${b.branch_name} — ${this.fmt(b.total)}</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Department</th><th>Transactions</th><th>Tax</th><th>Sales</th><th>% of Branch</th></tr></thead>
            <tbody>${departments.map(d => `
              <tr>
                <td class="fw-600">${labels[d]}</td>
                <td>${b.departments[d].transaction_count}</td>
                <td>${this.fmt(b.departments[d].tax)}</td>
                <td>${this.fmt(b.departments[d].total)}</td>
                <td>${pct(b.departments[d].total, b.total)}</td>
              </tr>`).join('')}
              <tr style="border-top:2px solid var(--border)">
                <td class="fw-600">Branch Total</td>
                <td class="fw-600">${b.transaction_count}</td>
                <td class="fw-600">${this.fmt(b.tax)}</td>
                <td class="fw-600">${this.fmt(b.total)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>`).join('')}`}
      <p style="font-size:11px;color:var(--text-muted)">Completed transactions, tax included. Rental figures exclude refundable security deposits; Work Order figures include assessment fees, deposits, and final payments as collected.</p>`;
  },

  // ─── Sales by Promotion ─────────────────────────────────────────────────

  showSalesByPromotionReport() {
    this._showReportModal('Sales by Promotion', this._reportDateRangeFilters('sbp-start','sbp-end'), 'loadSalesByPromotionReport');
  },

  async loadSalesByPromotionReport() {
    const start = document.getElementById('sbp-start')?.value || '';
    const end = document.getElementById('sbp-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/sales-by-promotion?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { promotions, branches, totals } = data;
    const esc = s => this.escapeAttr(s);
    const pct = (part, whole) => whole ? (part / whole * 100).toFixed(1) + '%' : '—';
    const money = n => this.fmt(n).replace(/ /g, ' ');
    const valStyle = 'font-size:18px;line-height:1.25;overflow-wrap:anywhere';
    const codes = p => p.codes.length ? ` <span style="font-family:monospace;font-size:11px;color:var(--text-muted)">${p.codes.map(esc).join(', ')}</span>` : '';
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:18px">
        <div class="stat-card blue" style="min-width:0;padding:14px"><div class="stat-label">Promotion Sales</div><div class="stat-value" style="${valStyle}">${money(totals.total)}</div><div class="stat-sub">${pct(totals.total, totals.all_sales)} of all sales</div></div>
        <div class="stat-card orange" style="min-width:0;padding:14px"><div class="stat-label">Discount Given</div><div class="stat-value" style="${valStyle}">${money(totals.discount)}</div><div class="stat-sub">${pct(totals.discount, totals.total + totals.discount)} off pre-discount</div></div>
        <div class="stat-card" style="min-width:0;padding:14px"><div class="stat-label">Transactions</div><div class="stat-value" style="${valStyle}">${totals.transaction_count}</div><div class="stat-sub">avg ${money(totals.transaction_count ? totals.total / totals.transaction_count : 0)}</div></div>
        <div class="stat-card purple" style="min-width:0;padding:14px"><div class="stat-label">Promotions Used</div><div class="stat-value" style="${valStyle}">${promotions.length}</div><div class="stat-sub">across ${branches.length} branch${branches.length === 1 ? '' : 'es'}</div></div>
      </div>
      ${!promotions.length ? '<div class="empty-state"><p>No sales with a promotion in this range.</p></div>' : `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">Promotion Sales by Branch</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Branch</th>${promotions.map(p => `<th>${esc(p.promotion_name)}</th>`).join('')}<th>Branch Total</th></tr></thead>
            <tbody>${branches.map(b => `
              <tr>
                <td class="fw-600">${esc(b.branch_name)}</td>
                ${promotions.map(p => `<td>${b.promotions[p.promotion_name] ? this.fmt(b.promotions[p.promotion_name].total) : '—'}</td>`).join('')}
                <td class="fw-600">${this.fmt(b.total)}</td>
              </tr>`).join('')}
              <tr style="border-top:2px solid var(--border)">
                <td class="fw-600">All Branches</td>
                ${promotions.map(p => `<td class="fw-600">${this.fmt(p.total)}</td>`).join('')}
                <td class="fw-600">${this.fmt(totals.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Promotion</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Promotion</th><th>Transactions</th><th>Discount Given</th><th>Sales</th><th>Avg Sale</th><th>% of Promo Sales</th></tr></thead>
            <tbody>${promotions.map(p => `
              <tr>
                <td class="fw-600">${esc(p.promotion_name)}${codes(p)}</td>
                <td>${p.transaction_count}</td>
                <td>${this.fmt(p.discount)}</td>
                <td>${this.fmt(p.total)}</td>
                <td>${this.fmt(p.transaction_count ? p.total / p.transaction_count : 0)}</td>
                <td>${pct(p.total, totals.total)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ${branches.map(b => `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">${esc(b.branch_name)} — ${this.fmt(b.total)}</span><span style="font-size:12px;color:var(--text-muted)">${pct(b.total, b.all_sales)} of branch sales</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Promotion</th><th>Transactions</th><th>Discount Given</th><th>Sales</th><th>% of Branch Promo Sales</th></tr></thead>
            <tbody>${promotions.filter(p => b.promotions[p.promotion_name]).map(p => { const r = b.promotions[p.promotion_name]; return `
              <tr>
                <td class="fw-600">${esc(p.promotion_name)}</td>
                <td>${r.transaction_count}</td>
                <td>${this.fmt(r.discount)}</td>
                <td>${this.fmt(r.total)}</td>
                <td>${pct(r.total, b.total)}</td>
              </tr>`; }).join('')}
              <tr style="border-top:2px solid var(--border)">
                <td class="fw-600">Branch Total</td>
                <td class="fw-600">${b.transaction_count}</td>
                <td class="fw-600">${this.fmt(b.discount)}</td>
                <td class="fw-600">${this.fmt(b.total)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>`).join('')}`}
      <p style="font-size:11px;color:var(--text-muted)">Completed transactions that carried a promotion (auto-applied or via promo code), tax included, after the discount. Discount Card sales are excluded — see the Discount Card Utilization report.</p>`;
  },

  // ─── Online Sales ───────────────────────────────────────────────────────

  // ─── Hourly Sales by Day ────────────────────────────────────────────────
  // GET /reports/hourly-sales — completed sales by weekday × hour (store time).
  // "Average per day" divides by how many of that weekday the range holds.

  async showHourlySalesReport() {
    const branches = await this.api('GET', '/branches').catch(() => []);
    const filters = `${this._reportDateRangeFilters('hsr-start', 'hsr-end', 3)}
      <select id="hsr-branch" style="width:170px"><option value="">All locations</option>${branches.map(b => `<option value="${b.id}">${this.escapeAttr(b.name)}</option>`).join('')}</select>
      <select id="hsr-mode" style="width:170px" onchange="App._renderHourlySalesReport()"><option value="total">Totals for the range</option><option value="avg">Average per day</option></select>`;
    this._showReportModal('Hourly Sales by Day', filters, 'loadHourlySalesReport');
    const modal = document.getElementById('rpt-modal-content')?.closest('.modal');
    if (modal) modal.style.maxWidth = '1060px';
  },

  async loadHourlySalesReport() {
    const start = document.getElementById('hsr-start')?.value || '';
    const end = document.getElementById('hsr-end')?.value || '';
    const branch = document.getElementById('hsr-branch')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    try { this._hourlySalesData = await this.api('GET', `/reports/hourly-sales?start=${start}&end=${end}${branch ? '&branch_id=' + branch : ''}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    this._renderHourlySalesReport();
  },

  _renderHourlySalesReport() {
    const content = document.getElementById('rpt-modal-content');
    const data = this._hourlySalesData;
    if (!content || !data) return;
    const avgMode = document.getElementById('hsr-mode')?.value === 'avg';
    const { totals } = data;
    // Monday first; Sunday last.
    const days = [1, 2, 3, 4, 5, 6, 0].map(d => data.days[d]);
    const per = (n, day) => avgMode ? (day.days_in_range ? n / day.days_in_range : 0) : n;
    const money = n => this.fmt(n).replace(/ /g, ' ');
    const compact = n => {
      const v = Math.abs(n);
      const num = v >= 1e6 ? (n / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : v >= 1e3 ? (n / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k' : Math.round(n).toString();
      return num.replace(/\.0(?=[kM])/, '');
    };
    const tix = n => avgMode ? (Math.round(n * 10) / 10).toLocaleString('en-US') : Math.round(n).toLocaleString('en-US');
    const hourLabel = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
    const hourRange = h => `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`;
    const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Same hour span on every chart so the days line up: the first to last hour
    // with any sale in the range.
    const active = data.hours.filter(h => h.tickets || h.return_count).map(h => h.hour);
    const header = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${fmtDate(data.start)} – ${fmtDate(data.end)} · ${data.branch_name ? this.escapeAttr(data.branch_name) : 'All locations'} · ${avgMode ? 'average per day' : 'totals for the range'}</div>`;
    if (!active.length) { content.innerHTML = header + '<div class="empty-state"><p>No completed sales in this range.</p></div>'; return; }
    const span = [];
    for (let h = Math.min(...active); h <= Math.max(...active); h++) span.push(h);

    let busiest = null;
    for (const d of days) for (const h of d.hours) if (h.tickets && (!busiest || per(h.revenue, d) > busiest.rev)) busiest = { day: d.name, hour: h.hour, rev: per(h.revenue, d) };
    const bestDay = days.reduce((a, d) => (per(d.revenue, d) > per(a.revenue, a) ? d : a), days[0]);

    // Each chart has its own scale — one big sale would otherwise flatten
    // every other day.
    const chart = day => {
      const maxRev = Math.max(...span.map(h => per(day.hours[h].revenue, day)), 0) || 1;
      const bars = span.map(h => {
        const c = day.hours[h];
        const rev = per(c.revenue, day);
        const pct = rev > 0 ? Math.max(rev / maxRev * 100, 1.5) : 0;
        const tip = `${day.name} ${hourRange(h)} — ${money(rev)}${c.returns ? ` (after ${money(per(c.returns, day))} returns)` : ''} · ${tix(per(c.tickets, day))} ticket${per(c.tickets, day) === 1 ? '' : 's'}${c.avg_ticket != null ? ' · avg ' + money(c.avg_ticket) + '/ticket' : ''}`;
        return `<div class="hsr-col" title="${this.escapeAttr(tip)}">
          <div class="hsr-bar-area">
            <div class="hsr-val"${rev < 0 ? ' style="color:var(--danger)"' : ''}>${rev ? compact(rev) : ''}</div>
            <div class="hsr-bar" style="height:${pct}%"></div>
          </div>
          <div class="hsr-hour">${hourLabel(h)}</div>
        </div>`;
      }).join('');
      return `<div class="hsr-chart">${bars}</div>`;
    };
    const dayTable = day => `
      <div class="table-wrap"><table class="hsr-table">
        <thead><tr><th>${day.name}</th>${span.map(h => `<th>${hourLabel(h)}</th>`).join('')}</tr></thead>
        <tbody>
          <tr><td class="fw-600">Sales</td>${span.map(h => `<td>${day.hours[h].gross ? compact(per(day.hours[h].gross, day)) : '—'}</td>`).join('')}</tr>
          <tr><td class="fw-600">Returns</td>${span.map(h => `<td${day.hours[h].returns ? ' style="color:var(--danger)"' : ''}>${day.hours[h].returns ? '-' + compact(per(day.hours[h].returns, day)) : '—'}</td>`).join('')}</tr>
          <tr><td class="fw-600">Net Revenue</td>${span.map(h => `<td class="fw-600"${day.hours[h].revenue < 0 ? ' style="color:var(--danger)"' : ''}>${day.hours[h].revenue ? compact(per(day.hours[h].revenue, day)) : '—'}</td>`).join('')}</tr>
          <tr><td class="fw-600">Tickets</td>${span.map(h => `<td>${day.hours[h].tickets ? tix(per(day.hours[h].tickets, day)) : '—'}</td>`).join('')}</tr>
          <tr><td class="fw-600">Avg / Ticket</td>${span.map(h => `<td>${day.hours[h].avg_ticket != null ? compact(day.hours[h].avg_ticket) : '—'}</td>`).join('')}</tr>
        </tbody>
      </table></div>`;

    content.innerHTML = `
      <style>
        .hsr-chart { display:flex; gap:2px; align-items:stretch; height:170px; padding:4px 0 0; border-bottom:1px solid var(--border); margin-bottom:6px; }
        .hsr-col { flex:1 1 0; min-width:0; display:flex; flex-direction:column; cursor:default; }
        .hsr-col:hover .hsr-bar { opacity:.75; }
        .hsr-col:hover .hsr-val { color:var(--text); font-weight:700; }
        .hsr-bar-area { flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; min-height:0; }
        .hsr-bar { width:min(70%, 34px); background:var(--primary); border-radius:4px 4px 0 0; }
        .hsr-val { font-size:10px; color:var(--text-muted); white-space:nowrap; margin-bottom:2px; font-variant-numeric:tabular-nums; }
        .hsr-hour { font-size:10px; color:var(--text-muted); text-align:center; padding-top:3px; white-space:nowrap; }
        .hsr-table th, .hsr-table td { font-size:11px; padding:4px 4px; text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
        .hsr-table th:first-child, .hsr-table td:first-child { text-align:left; }
        .hsr-days th, .hsr-days td { white-space:nowrap; font-size:12px; padding:8px 8px; font-variant-numeric:tabular-nums; }
      </style>
      ${header}
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:18px">
        <div class="stat-card blue" style="min-width:0;padding:14px"><div class="stat-label">Net Revenue</div><div class="stat-value" style="font-size:18px;overflow-wrap:anywhere">${money(totals.revenue)}</div><div class="stat-sub">net of ${money(totals.returns)} returns (${totals.return_count})</div></div>
        <div class="stat-card" style="min-width:0;padding:14px"><div class="stat-label">Tickets</div><div class="stat-value" style="font-size:18px">${totals.tickets.toLocaleString('en-US')}</div></div>
        <div class="stat-card green" style="min-width:0;padding:14px"><div class="stat-label">Avg Revenue per Ticket</div><div class="stat-value" style="font-size:18px;overflow-wrap:anywhere">${totals.avg_ticket != null ? money(totals.avg_ticket) : '—'}</div></div>
        <div class="stat-card orange" style="min-width:0;padding:14px"><div class="stat-label">Busiest Hour</div><div class="stat-value" style="font-size:16px">${busiest ? `${busiest.day.slice(0, 3)} ${hourRange(busiest.hour)}` : '—'}</div><div class="stat-sub">${busiest ? money(busiest.rev) + (avgMode ? ' avg' : '') : ''} · best day ${bestDay.name}</div></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Day of the Week</span></div>
        <div class="table-wrap"><table class="hsr-days">
          <thead><tr><th>Day</th><th>Days</th><th>Tickets</th><th>Sales</th><th>Returns</th><th>Net Revenue</th><th>Avg / Day</th><th>Avg / Ticket</th><th>Busiest Hour</th></tr></thead>
          <tbody>${days.map(d => {
            const top = d.hours.reduce((a, h) => (h.revenue > (a?.revenue || 0) ? h : a), null);
            return `<tr>
              <td class="fw-600">${d.name}</td><td>${d.days_in_range}</td><td>${d.tickets.toLocaleString('en-US')}</td><td>${money(d.gross)}</td><td${d.returns ? ' style="color:var(--danger)"' : ''}>${d.returns ? '-' + money(d.returns) : '—'}</td><td class="fw-600">${money(d.revenue)}</td>
              <td>${d.days_in_range ? money(d.revenue / d.days_in_range) : '—'}</td><td class="fw-600">${d.avg_ticket != null ? money(d.avg_ticket) : '—'}</td>
              <td>${top ? hourRange(top.hour) : '—'}</td></tr>`;
          }).join('')}
            <tr style="border-top:2px solid var(--border)"><td class="fw-600">All days</td><td>${days.reduce((n, d) => n + d.days_in_range, 0)}</td><td class="fw-600">${totals.tickets.toLocaleString('en-US')}</td><td class="fw-600">${money(totals.gross)}</td><td class="fw-600">${totals.returns ? '-' + money(totals.returns) : '—'}</td><td class="fw-600">${money(totals.revenue)}</td><td></td><td class="fw-600">${totals.avg_ticket != null ? money(totals.avg_ticket) : '—'}</td><td></td></tr>
          </tbody>
        </table></div>
      </div>
      ${days.map(d => `
      <div class="card" style="margin-bottom:16px;break-inside:avoid">
        <div class="card-header" style="flex-wrap:wrap;gap:6px">
          <span class="card-title">${d.name}</span>
          <span style="font-size:12px;color:var(--text-muted)">${d.tickets || d.return_count ? `${money(per(d.revenue, d))}${avgMode ? ' avg/day' : ''} · ${tix(per(d.tickets, d))} tickets · avg ${d.avg_ticket != null ? money(d.avg_ticket) : '—'}/ticket` : 'No sales'} · ${d.days_in_range} ${d.name}${d.days_in_range === 1 ? '' : 's'} in range</span>
        </div>
        ${d.tickets || d.return_count ? chart(d) + dayTable(d) : '<div class="empty-state" style="padding:14px"><p>No completed sales on ' + d.name + 's in this range.</p></div>'}
      </div>`).join('')}
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">Completed sales only, by the time the ticket was rung up in store time (${this.escapeAttr(data.time_zone)}). Revenue is the ticket total including tax, less refund and credit-note returns, which come off the hour the return was processed. Exchanges aren't deducted, since the replacement sale already carries the credit as a discount. Average revenue per ticket is net revenue over sales tickets. Bar labels are net revenue (k = thousand); hover a bar for the full figures. Each day's chart is scaled to its own busiest hour, so compare days by the figures, not bar heights. Average per day divides by the number of that weekday in the range; average revenue per ticket is the same either way.</p>`;
  },

  showOnlineSalesReport() {
    this._showReportModal('Online Sales', this._reportDateRangeFilters('ons-start','ons-end'), 'loadOnlineSalesReport');
  },

  async loadOnlineSalesReport() {
    const start = document.getElementById('ons-start')?.value || '';
    const end = document.getElementById('ons-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/online-sales?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { totals, byChannel, byFulfillment, byBranch, byDay, topProducts } = data;
    const esc = s => this.escapeAttr(s);
    const pct = (part, whole) => whole ? (part / whole * 100).toFixed(1) + '%' : '—';
    const money = n => this.fmt(n).replace(/ /g, ' ');
    const valStyle = 'font-size:18px;line-height:1.25;overflow-wrap:anywhere';
    const channelLabels = { online: 'Website', woocommerce: 'WooCommerce' };
    const avg = r => this.fmt(r.order_count ? r.total / r.order_count : 0);
    const table = (title, head, rows) => `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">${title}</span></div>
        <div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:18px">
        <div class="stat-card blue" style="min-width:0;padding:14px"><div class="stat-label">Online Sales</div><div class="stat-value" style="${valStyle}">${money(totals.total)}</div><div class="stat-sub">${pct(totals.total, totals.all_sales)} of all sales</div></div>
        <div class="stat-card" style="min-width:0;padding:14px"><div class="stat-label">Orders</div><div class="stat-value" style="${valStyle}">${totals.order_count}</div><div class="stat-sub">excl. cancelled</div></div>
        <div class="stat-card green" style="min-width:0;padding:14px"><div class="stat-label">Avg Order</div><div class="stat-value" style="${valStyle}">${money(totals.order_count ? totals.total / totals.order_count : 0)}</div><div class="stat-sub">tax included</div></div>
        <div class="stat-card orange" style="min-width:0;padding:14px"><div class="stat-label">Tax Collected</div><div class="stat-value" style="${valStyle}">${money(totals.tax)}</div><div class="stat-sub">${money(totals.discount)} discounts</div></div>
      </div>
      ${!byFulfillment.length ? '<div class="empty-state"><p>No online orders in this range.</p></div>' : `
      ${table('By Channel', ['Channel', 'Orders', 'Tax', 'Sales', 'Avg Order', '% of Online'], byChannel.map(r => `
        <tr><td class="fw-600">${channelLabels[r.source] || esc(r.source)}</td><td>${r.order_count}</td><td>${this.fmt(r.tax)}</td><td>${this.fmt(r.total)}</td><td>${avg(r)}</td><td>${pct(r.total, totals.total)}</td></tr>`).join(''))}
      ${table('By Branch', ['Branch', 'Orders', 'Tax', 'Sales', 'Avg Order', '% of Online'], byBranch.map(r => `
        <tr><td class="fw-600">${esc(r.branch_name || 'No Branch')}</td><td>${r.order_count}</td><td>${this.fmt(r.tax)}</td><td>${this.fmt(r.total)}</td><td>${avg(r)}</td><td>${pct(r.total, totals.total)}</td></tr>`).join(''))}
      ${table('By Fulfillment Status', ['Status', 'Orders', 'Order Value'], byFulfillment.map(r => `
        <tr><td class="fw-600" style="text-transform:capitalize">${esc(r.fulfillment_status)}</td><td>${r.order_count}</td><td>${this.fmt(r.total)}${r.fulfillment_status === 'cancelled' ? ' <span style="font-size:11px;color:var(--text-muted)">(not in totals)</span>' : ''}</td></tr>`).join(''))}
      ${topProducts.length ? table('Top Products', ['Product', 'SKU', 'Qty Sold', 'Orders', 'Sales'], topProducts.map(r => `
        <tr><td class="fw-600">${esc(r.product_name)}</td><td style="font-family:monospace;font-size:12px">${esc(r.sku)}</td><td>${r.quantity}</td><td>${r.order_count}</td><td>${this.fmt(r.total)}</td></tr>`).join('')) : ''}
      ${table('By Day', ['Date', 'Orders', 'Sales'], byDay.map(r => `
        <tr><td>${r.date}</td><td>${r.order_count}</td><td>${this.fmt(r.total)}</td></tr>`).join(''))}`}
      <p style="font-size:11px;color:var(--text-muted)">Completed transactions from the website (e-commerce API) and WooCommerce, tax included. Orders with a Cancelled fulfillment status are excluded from totals.</p>`;
  },

  // ─── Salesperson Leaderboard ────────────────────────────────────────────

  showSalesLeaderboardReport() {
    this._showReportModal('Salesperson Leaderboard', this._reportDateRangeFilters('slb-start','slb-end'), 'loadSalesLeaderboardReport');
  },

  async loadSalesLeaderboardReport() {
    const start = document.getElementById('slb-start')?.value || '';
    const end = document.getElementById('slb-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/salesperson-leaderboard?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { totals, rows } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Quotes Created</div><div class="stat-value">${totals.quotes_created}</div></div>
        <div class="stat-card green"><div class="stat-label">Converted</div><div class="stat-value">${totals.quotes_converted} <span style="font-size:13px">(${totals.win_rate}%)</span></div></div>
        <div class="stat-card purple"><div class="stat-label">Credited Sales</div><div class="stat-value">${this.fmt(totals.credited_sales)}</div></div>
      </div>
      ${!rows.length ? '<div class="empty-state"><p>No quotes in this range.</p></div>' : `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Salesperson</th><th>Quotes Created</th><th>Converted</th><th>Win Rate</th><th>Credited Sales</th></tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td class="fw-600">${r.employee_name}</td>
                <td>${r.quotes_created}</td>
                <td>${r.quotes_converted}</td>
                <td>${r.win_rate}%</td>
                <td class="fw-600">${this.fmt(r.credited_sales)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Quote Funnel & Cycle Time ──────────────────────────────────────────

  showQuoteFunnelReport() {
    this._showReportModal('Quote Funnel &amp; Cycle Time', this._reportDateRangeFilters('qf-start','qf-end'), 'loadQuoteFunnelReport');
  },

  async loadQuoteFunnelReport() {
    const start = document.getElementById('qf-start')?.value || '';
    const end = document.getElementById('qf-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/quote-funnel?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { funnel, cycleTimes } = data;
    const statusLabel = { draft:'Draft', sent:'Sent', accepted:'Accepted', declined:'Declined', converted:'Converted', cancelled:'Cancelled', pending_approval:'Pending Approval', approved:'Approved' };
    const visibleCycle = cycleTimes.filter(c => c.sample_size > 0);
    content.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">Current Funnel (by quote created date)</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Status</th><th>Count</th></tr></thead>
            <tbody>${funnel.map(f => `<tr><td class="fw-600">${statusLabel[f.status]||f.status}</td><td>${f.count}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Average Days Per Stage</span></div>
        ${!visibleCycle.length ? '<p style="padding:14px;color:var(--text-muted);font-size:13px">No timed transitions yet in this range — stage timestamps only started being recorded recently, so older quotes won\'t show here.</p>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Stage</th><th>Avg. Days</th><th>Sample Size</th></tr></thead>
            <tbody>${visibleCycle.map(c => `
              <tr>
                <td class="fw-600">${c.stage}</td>
                <td>${c.avg_days} day${c.avg_days===1?'':'s'}</td>
                <td style="color:var(--text-muted)">${c.sample_size}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
      </div>`;
  },

  // ─── CRM Pipeline / Weighted Forecast ───────────────────────────────────

  showCrmPipelineReport() {
    const today = new Date().toISOString().slice(0,10);
    const in90 = new Date(Date.now() + 90*86400000).toISOString().slice(0,10);
    const filters = `<input type="date" id="cp-start" value="${today}" style="width:150px"><span>to</span><input type="date" id="cp-end" value="${in90}" style="width:150px">`;
    this._showReportModal('CRM Pipeline / Weighted Forecast', filters, 'loadCrmPipelineReport');
  },

  async loadCrmPipelineReport() {
    const start = document.getElementById('cp-start')?.value || '';
    const end = document.getElementById('cp-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/crm-pipeline?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { totals, byStage, top } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:8px">
        <div class="stat-card blue"><div class="stat-label">Open Opportunities</div><div class="stat-value">${totals.opp_count}</div></div>
        <div class="stat-card purple"><div class="stat-label">Total Value</div><div class="stat-value">${this.fmt(totals.total_value)}</div></div>
        <div class="stat-card green"><div class="stat-label">Weighted Forecast</div><div class="stat-value">${this.fmt(totals.weighted_value)}</div></div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 16px">Opportunities with no expected close date are always included, regardless of the range above.</p>
      ${!byStage.length ? '<div class="empty-state"><p>No open opportunities.</p></div>' : `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Stage</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Stage</th><th>Opportunities</th><th>Avg. Probability</th><th>Total Value</th><th>Weighted Value</th></tr></thead>
            <tbody>${byStage.map(r => `
              <tr>
                <td class="fw-600">${r.stage}</td>
                <td>${r.opp_count}</td>
                <td>${r.avg_probability}%</td>
                <td>${this.fmt(r.total_value)}</td>
                <td class="fw-600">${this.fmt(r.weighted_value)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Top Weighted Opportunities</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Opportunity</th><th>Customer</th><th>Salesperson</th><th>Stage</th><th>Value</th><th>Prob.</th><th>Expected Close</th></tr></thead>
            <tbody>${top.map(o => `
              <tr>
                <td class="fw-600">${o.title} <span style="color:var(--text-muted);font-size:11px">(${o.opp_number})</span></td>
                <td>${o.customer_name||'—'}</td>
                <td>${o.employee_name||'—'}</td>
                <td>${o.stage}</td>
                <td>${this.fmt(o.value)}</td>
                <td>${o.probability}%</td>
                <td>${o.expected_close?this.fmtDate(o.expected_close):'—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Rental Utilization ─────────────────────────────────────────────────

  showRentalUtilizationReport() {
    this._showReportModal('Rental Utilization', this._reportDateRangeFilters('ru-start','ru-end'), 'loadRentalUtilizationReport');
  },

  async loadRentalUtilizationReport() {
    const start = document.getElementById('ru-start')?.value || '';
    const end = document.getElementById('ru-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/rental-utilization?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { totals, items } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px">
        <div class="stat-card blue"><div class="stat-label">Total Bookings</div><div class="stat-value">${totals.booking_count}</div></div>
        <div class="stat-card green"><div class="stat-label">Total Revenue</div><div class="stat-value">${this.fmt(totals.revenue)}</div></div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 16px">Sorted by revenue — scroll to the bottom for the least-booked items. "Out Now" is how many units of that item are on an active rental right now, regardless of the date range above.</p>
      ${!items.length ? '<div class="empty-state"><p>No rental bookings in this range.</p></div>' : `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Owned</th><th>Out Now</th><th>Bookings</th><th>Qty Booked</th><th>Revenue</th></tr></thead>
            <tbody>${items.map(i => `
              <tr>
                <td class="fw-600">${i.product_name}</td>
                <td>${i.units_owned ?? '—'}</td>
                <td>${i.currently_out > 0 ? `<span class="badge-pill badge-warning" style="font-size:10px">${i.currently_out} out</span>` : '—'}</td>
                <td>${i.booking_count}</td>
                <td>${i.total_quantity_booked}</td>
                <td class="fw-600">${this.fmt(i.revenue)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Salesperson Targets ────────────────────────────────────────────────
  // No date-range filter — GET /sales-targets always answers "right now"
  // for each period (current hour/day/week/month), same as the CRM & Sales
  // → Targets tab this reuses the same endpoint (and scoping rules) from.
  showSalespersonTargetsReport() {
    this.showModal(`
      <div class="modal" style="max-width:900px">
        <div class="modal-header"><span class="modal-title">Salesperson Targets</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="max-height:75vh;overflow-y:auto">
          <div id="rpt-modal-content" data-report-title="Salesperson Targets"><div class="empty-state"><p>Loading...</p></div></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.printReport('rpt-modal-content')">🖨 Print</button>
          <button class="btn btn-outline" onclick="App.exportReportCsv('rpt-modal-content')">⬇ Export CSV</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
    this.loadSalespersonTargetsReport();
  },

  async loadSalespersonTargetsReport() {
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    let data;
    try { data = await this.api('GET', '/sales-targets'); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const periods = [['Hourly','hourly'], ['Daily','daily'], ['Weekly','weekly'], ['Monthly','monthly']];
    const pctCell = (current, target) => {
      if (!target) return '<span style="color:var(--text-muted)">—</span>';
      const pct = Math.round(current / target * 100);
      const color = pct >= 100 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
      return `<span style="color:${color};font-weight:600">${pct}%</span>`;
    };
    content.innerHTML = !data.length ? '<div class="empty-state"><p>No employees flagged as a Salesperson yet.</p></div>' : `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Salesperson</th>${periods.map(([label]) => `<th colspan="3">${label}</th>`).join('')}</tr>
            <tr><th></th>${periods.map(() => '<th>Current</th><th>Target</th><th>%</th>').join('')}</tr></thead>
            <tbody>${data.map(e => `
              <tr>
                <td class="fw-600">${e.employee_name}</td>
                ${periods.map(([,key]) => `<td>${this.fmt(e[key+'_sales'])}</td><td>${e[key+'_target']>0?this.fmt(e[key+'_target']):'<span style="color:var(--text-muted)">—</span>'}</td><td>${pctCell(e[key+'_sales'], e[key+'_target'])}</td>`).join('')}
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Current sales are transactions in the current hour/day/week/month where the salesperson was picked on the POS ticket, or rang it up themselves when no salesperson was picked — not the commission-credit chain a reassigned quote uses elsewhere. Targets are set from CRM &amp; Sales → Targets.</p>`;
  },

  // Shared modal shell for the report-with-filters pattern below — takes a
  // title, the filter controls' HTML (ids are the caller's responsibility),
  // and the load function name to call for both the initial render and each
  // "Generate" click.
  _showReportModal(title, filtersHtml, loadFnName) {
    this.showModal(`
      <div class="modal" style="max-width:820px">
        <div class="modal-header"><span class="modal-title">${title}</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="max-height:75vh;overflow-y:auto">
          <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
            ${filtersHtml}
            <button class="btn btn-primary" onclick="App.${loadFnName}()">Generate</button>
          </div>
          <div id="rpt-modal-content" data-report-title="${title}"><div class="empty-state"><p>Choose a range and click Generate.</p></div></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.printReport('rpt-modal-content')">🖨 Print</button>
          <button class="btn btn-outline" onclick="App.exportReportCsv('rpt-modal-content')">⬇ Export CSV</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
    this[loadFnName]();
  },

  _reportDateRangeFilters(startId, endId, monthsBack = 1) {
    const today = new Date().toISOString().slice(0,10);
    const start = new Date(new Date().getFullYear(), new Date().getMonth() - (monthsBack - 1), 1).toISOString().slice(0,10);
    return `<input type="date" id="${startId}" value="${start}" style="width:150px">
      <span>to</span>
      <input type="date" id="${endId}" value="${today}" style="width:150px">`;
  },

  // Print/export work off whatever's currently rendered inside the given
  // report container (stat cards + tables) rather than re-fetching or
  // rebuilding per-report markup — one implementation covers every report
  // in the Reports hub (and Special Projects' own Margin Report) since they
  // all share this same stat-card/table shape. `data-report-title` on the
  // container (set once in each modal's shell) is the only per-report
  // wiring needed.
  printReport(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !container.querySelector('.stat-card, table')) { this.alert('Generate the report first', 'error'); return; }
    const title = container.dataset.reportTitle || 'Report';
    const store = this.settings || {};
    const win = window.open('', '_blank', 'width=900,height=1000');
    win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:28px;color:#111}
      h1{font-size:17px;margin:0 0 2px}
      h2{font-size:14px;margin:0 0 14px;color:#444;font-weight:600}
      .stats-grid{display:flex;gap:14px;flex-wrap:wrap;margin:0 0 16px}
      .stat-card{border:1px solid #ccc;border-radius:6px;padding:10px 14px;min-width:130px}
      .stat-label{font-size:10px;text-transform:uppercase;color:#666;letter-spacing:.03em}
      .stat-value{font-size:17px;font-weight:700;margin-top:2px}
      .card{border:1px solid #ccc;border-radius:6px;padding:10px 12px;margin-bottom:14px}
      .card-header{margin-bottom:6px}
      .card-title{font-weight:700;font-size:13px}
      table{width:100%;border-collapse:collapse;margin-top:4px}
      th{background:#eee;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;border:1px solid #ccc}
      td{padding:6px 8px;border:1px solid #ddd;font-size:12px}
      .badge-pill{display:inline-block;border:1px solid #999;border-radius:10px;padding:1px 7px;font-size:10px}
      p{margin:4px 0}
      .footer{margin-top:16px;font-size:11px;color:#999;border-top:1px solid #ddd;padding-top:8px}
      @media print{body{margin:12px}}
    </style>
    </head><body>
    ${this._printLogoTag(40)}
    <h1>${store.store_name||'RetailPOS'}</h1>
    <h2>${title}</h2>
    ${container.innerHTML}
    <div class="footer">Printed: ${new Date().toLocaleString()} by ${this.currentUser?.first_name||''} ${this.currentUser?.last_name||''}</div>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
    win.document.close();
  },

  // Walks every stat card (as a two-column "Summary" section) and every
  // table currently in the container, in DOM order, into one CSV — each
  // table's nearest .card-title (if any) becomes its own header row so
  // multi-table reports (e.g. "By Category" + "By Branch") stay readable
  // as separate sections in the same file rather than needing one export
  // per sub-table.
  exportReportCsv(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !container.querySelector('.stat-card, table')) { this.alert('Generate the report first', 'error'); return; }
    const title = container.dataset.reportTitle || 'Report';
    const csvRow = cells => cells.map(c => `"${String(c ?? '').replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`).join(',');
    const lines = [];

    const stats = container.querySelectorAll('.stat-card');
    if (stats.length) {
      lines.push(csvRow(['Summary']));
      stats.forEach(sc => {
        const label = sc.querySelector('.stat-label')?.textContent || '';
        const value = sc.querySelector('.stat-value')?.textContent || '';
        lines.push(csvRow([label, value]));
      });
      lines.push('');
    }
    container.querySelectorAll('table').forEach(table => {
      const cardTitle = table.closest('.card')?.querySelector('.card-title')?.textContent;
      if (cardTitle) lines.push(csvRow([cardTitle]));
      const headerCells = [...table.querySelectorAll('thead th')].map(th => th.textContent);
      if (headerCells.length) lines.push(csvRow(headerCells));
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = [...tr.children].map(td => td.textContent);
        if (cells.length) lines.push(csvRow(cells));
      });
      lines.push('');
    });

    if (!lines.length) { this.alert('Nothing to export', 'error'); return; }
    const blob = new Blob([lines.join('\r\n')], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/&amp;/g,'and').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g,'').toLowerCase()}-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // ─── Lead Source Performance ────────────────────────────────────────────

  showLeadSourceReport() {
    this._showReportModal('Lead Source Performance', this._reportDateRangeFilters('lsp-start','lsp-end'), 'loadLeadSourceReport');
  },

  async loadLeadSourceReport() {
    const start = document.getElementById('lsp-start')?.value || '';
    const end = document.getElementById('lsp-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/lead-source-performance?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { totals, bySource } = data;
    const pct = v => v == null ? '—' : `${v}%`;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Leads</div><div class="stat-value">${totals.lead_count}</div></div>
        <div class="stat-card purple"><div class="stat-label">Opportunities</div><div class="stat-value">${totals.opportunity_count}</div></div>
        <div class="stat-card green"><div class="stat-label">Won</div><div class="stat-value">${totals.won_count}</div></div>
        <div class="stat-card orange"><div class="stat-label">Won Value</div><div class="stat-value">${this.fmt(totals.won_value)}</div></div>
      </div>
      ${!bySource.length ? '<div class="empty-state"><p>No leads in this range.</p></div>' : `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Leads</th><th>Opportunities</th><th>Won</th><th>Won Value</th><th>Lead → Opp</th><th>Opp → Won</th><th>Lead → Won</th></tr></thead>
            <tbody>${bySource.map(r => `
              <tr>
                <td class="fw-600">${r.source}</td>
                <td>${r.lead_count}</td>
                <td>${r.opportunity_count}</td>
                <td>${r.won_count}</td>
                <td>${this.fmt(r.won_value)}</td>
                <td>${pct(r.lead_to_opp_rate)}</td>
                <td>${pct(r.win_rate)}</td>
                <td style="font-weight:600">${pct(r.lead_to_won_rate)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Customer Segment Report ────────────────────────────────────────────

  showCustomerSegmentReport() {
    this._showReportModal('Customer Segment Report', this._reportDateRangeFilters('csr-start','csr-end'), 'loadCustomerSegmentReport');
  },

  async loadCustomerSegmentReport() {
    const start = document.getElementById('csr-start')?.value || '';
    const end = document.getElementById('csr-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/customer-segments?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { segments } = data;
    const marginColor = pct => pct == null ? 'var(--text-muted)' : pct < 0 ? 'var(--danger)' : pct < 15 ? 'var(--warning)' : 'var(--success)';
    const totalRevenue = segments.reduce((s,r) => s + r.revenue, 0);
    content.innerHTML = !segments.length ? '<div class="empty-state"><p>No customer categories set up yet.</p></div>' : `
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Discount</th><th>Customers</th><th>Orders</th><th>Revenue</th><th>% of Total</th><th>Discount Given</th><th>Margin</th></tr></thead>
            <tbody>${segments.map(r => `
              <tr>
                <td class="fw-600">${r.category_name}</td>
                <td>${r.discount_percent > 0 ? `${r.discount_percent}%` : '—'}</td>
                <td>${r.customer_count}</td>
                <td>${r.order_count}</td>
                <td>${this.fmt(r.revenue)}</td>
                <td>${totalRevenue > 0 ? (r.revenue / totalRevenue * 100).toFixed(1) : '0.0'}%</td>
                <td>${this.fmt(r.total_discount)}</td>
                <td style="color:${marginColor(r.margin_percent)};font-weight:600">${this.fmt(r.margin)}${r.margin_percent!=null?` (${r.margin_percent}%)`:''}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Revenue is net of ticket-level discounts, before tax. "No Category" is every completed sale from a customer with no category assigned, shown for comparison.</p>`;
  },

  // ─── Loyalty & Cash-Back Engagement ─────────────────────────────────────

  showLoyaltyEngagementReport() {
    this._showReportModal('Loyalty &amp; Cash-Back Engagement', this._reportDateRangeFilters('lye-start','lye-end'), 'loadLoyaltyEngagementReport');
  },

  async loadLoyaltyEngagementReport() {
    const start = document.getElementById('lye-start')?.value || '';
    const end = document.getElementById('lye-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/loyalty-engagement?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, topEarners } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:8px">
        <div class="stat-card blue"><div class="stat-label">Points Issued</div><div class="stat-value">${summary.points_issued.toLocaleString()}</div></div>
        <div class="stat-card green"><div class="stat-label">Cash Back Redeemed</div><div class="stat-value">${this.fmt(summary.cash_redeemed)}</div></div>
        <div class="stat-card purple"><div class="stat-label">Redemptions</div><div class="stat-value">${summary.redemption_count}</div></div>
        <div class="stat-card orange"><div class="stat-label">Redemption Rate</div><div class="stat-value">${summary.redemption_rate==null?'—':summary.redemption_rate+'%'}</div></div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 16px">Points issued is calculated from completed sales in this range (0.5 pt per $1 spent) — there's no historical points ledger, so this reapplies the current earn rate rather than reading a stored log. Redemption rate compares that to cash-back redeemed, valued at each customer's current card type.</p>
      ${!topEarners.length ? '<div class="empty-state"><p>No point-earning sales in this range.</p></div>' : `
      <div class="card">
        <div class="card-header"><span class="card-title">Top Point Earners (this range)</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Points Earned</th><th>Current Balance</th></tr></thead>
            <tbody>${topEarners.map(r => `
              <tr>
                <td class="fw-600">${r.customer_name} <span style="color:var(--text-muted);font-size:11px">(${r.customer_number})</span></td>
                <td>${r.points_earned.toLocaleString()}</td>
                <td>${r.current_balance.toLocaleString()}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  // ─── Discount Card Utilization ──────────────────────────────────────────

  showDiscountCardReport() {
    this._showReportModal('Discount Card Utilization', this._reportDateRangeFilters('dcu-start','dcu-end'), 'loadDiscountCardReport');
  },

  async loadDiscountCardReport() {
    const start = document.getElementById('dcu-start')?.value || '';
    const end = document.getElementById('dcu-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/discount-card-utilization?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary, byType, neverUsed } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:8px">
        <div class="stat-card blue"><div class="stat-label">Cards Issued</div><div class="stat-value">${summary.total_issued}</div></div>
        <div class="stat-card green"><div class="stat-label">Used This Range</div><div class="stat-value">${summary.total_used}</div></div>
        <div class="stat-card orange"><div class="stat-label">Utilization</div><div class="stat-value">${summary.utilization_rate==null?'—':summary.utilization_rate+'%'}</div></div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 16px">"Used" means a customer with that card had a completed sale with the card's discount applied in this range — cards are matched by name, not a dedicated link, since a card's use is recorded the same way a category discount is.</p>
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Card Type</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Discount</th><th>Status</th><th>Issued</th><th>Used</th><th>Utilization</th><th>Discount Given</th></tr></thead>
            <tbody>${byType.map(t => `
              <tr>
                <td class="fw-600">${t.name}</td>
                <td>${t.discount_percent}%</td>
                <td><span class="badge-pill ${t.active?'badge-success':'badge-secondary'}" style="font-size:10px">${t.active?'Active':'Inactive'}</span></td>
                <td>${t.cards_issued}</td>
                <td>${t.customers_used}</td>
                <td>${t.utilization_rate==null?'—':t.utilization_rate+'%'}</td>
                <td>${this.fmt(t.total_discount_given)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Issued but Not Used This Range (${summary.never_used_count})</span></div>
        ${!neverUsed.length ? '<p style="padding:14px;color:var(--text-muted);font-size:13px">Every active cardholder used their card in this range.</p>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Card Type</th><th>Card #</th></tr></thead>
            <tbody>${neverUsed.map(c => `
              <tr>
                <td class="fw-600">${c.customer_name} <span style="color:var(--text-muted);font-size:11px">(${c.customer_number})</span></td>
                <td>${c.card_type}</td>
                <td style="font-family:monospace">${c.discount_card_number}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${summary.never_used_count > neverUsed.length ? `<p style="padding:8px 14px;color:var(--text-muted);font-size:12px">+${summary.never_used_count - neverUsed.length} more not shown</p>` : ''}`}
      </div>`;
  },

  // ─── New vs. Repeat Customer Rate ───────────────────────────────────────

  showCustomerRetentionReport() {
    this._showReportModal('New vs. Repeat Customer Rate', this._reportDateRangeFilters('cret-start','cret-end'), 'loadCustomerRetentionReport');
  },

  async loadCustomerRetentionReport() {
    const start = document.getElementById('cret-start')?.value || '';
    const end = document.getElementById('cret-end')?.value || '';
    const content = document.getElementById('rpt-modal-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/customer-retention?start=${start}&end=${end}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('rpt-modal-content')) return;

    const { summary } = data;
    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:8px">
        <div class="stat-card blue"><div class="stat-label">New Customers</div><div class="stat-value">${summary.new_customers}</div></div>
        <div class="stat-card green"><div class="stat-label">Repeat Customers</div><div class="stat-value">${summary.repeat_customers}</div></div>
        <div class="stat-card purple"><div class="stat-label">New Revenue</div><div class="stat-value">${this.fmt(summary.new_revenue)}</div></div>
        <div class="stat-card orange"><div class="stat-label">Repeat Revenue</div><div class="stat-value">${this.fmt(summary.repeat_revenue)}</div></div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 16px">"New" = a customer's first-ever completed sale falls inside this range. "Repeat" = they bought again in this range but their first-ever sale was earlier.</p>
      <div class="card" style="padding:16px 18px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span>New</span><span class="fw-600">${summary.new_rate==null?'—':summary.new_rate+'%'}</span></div>
        <div style="background:var(--bg-secondary,#eee);border-radius:6px;height:10px;overflow:hidden;margin-bottom:14px">
          <div style="background:var(--accent);height:100%;width:${summary.new_rate||0}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span>Repeat</span><span class="fw-600">${summary.repeat_rate==null?'—':summary.repeat_rate+'%'}</span></div>
        <div style="background:var(--bg-secondary,#eee);border-radius:6px;height:10px;overflow:hidden">
          <div style="background:var(--success);height:100%;width:${summary.repeat_rate||0}%"></div>
        </div>
      </div>`;
  },

  async renderReports() {
    const today = new Date().toISOString().slice(0,10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const branches = await this.api('GET', '/branches').catch(() => []);
    const activeBranches = (branches || []).filter(b => b.active && !b.is_warehouse);

    // The user may have navigated to a different section while /branches was
    // in flight — #content always exists, so without this check we'd silently
    // overwrite whatever section they're actually looking at now.
    if (this.section !== 'reports') return;

    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Reports & Analytics</h2>
        <div style="display:flex;gap:10px;align-items:center;">
          <select id="rpt-branch" style="min-width:150px">
            <option value="">All Locations</option>
            ${activeBranches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
          <input type="date" id="rpt-start" value="${monthStart}" style="width:150px">
          <span>to</span>
          <input type="date" id="rpt-end" value="${today}" style="width:150px">
          <button class="btn btn-primary" onclick="App.loadReportData()">Generate</button>
        </div>
      </div>
      <div id="report-content"><div class="empty-state"><p>Loading...</p></div></div>`;

    this.loadReportData();
  },

  async loadReportData() {
    const start = document.getElementById('rpt-start')?.value || '';
    const end = document.getElementById('rpt-end')?.value || '';
    const branchId = document.getElementById('rpt-branch')?.value || '';
    const bq = branchId ? `&branch_id=${branchId}` : '';
    const [sales, topProds, byCat, inv, promoRpt, arRpt] = await Promise.all([
      this.api('GET', `/reports/sales?start=${start}&end=${end}${bq}`),
      this.api('GET', `/reports/top-products?start=${start}&end=${end}&limit=8${bq}`),
      this.api('GET', `/reports/by-category?start=${start}&end=${end}${bq}`),
      this.api('GET', `/reports/inventory${bq ? '?' + bq.slice(1) : ''}`),
      this.api('GET', `/reports/promotions?start=${start}&end=${end}${bq}`),
      this.api('GET', `/reports/ar-collections?start=${start}&end=${end}${bq}`),
    ]);

    // The user may have navigated away from Reports while these fetches were
    // in flight — #report-content would be gone, so bail out instead of throwing.
    const reportContentEl = document.getElementById('report-content');
    if (!reportContentEl) return;

    const s = sales.summary;
    const maxSales = Math.max(...(sales.byDay.map(d => d.sales) || [1]), 1);

    reportContentEl.innerHTML = `
      <div class="stats-grid" style="margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Gross Sales</div><div class="stat-value">${this.fmt(s.gross_sales)}</div><div class="stat-sub">${s.transaction_count} transactions</div></div>
        <div class="stat-card green"><div class="stat-label">Tax Collected</div><div class="stat-value">${this.fmt(s.total_tax)}</div></div>
        <div class="stat-card orange"><div class="stat-label">Discounts Given</div><div class="stat-value">${this.fmt(s.total_discounts)}</div></div>
        <div class="stat-card"><div class="stat-label">Avg Order Value</div><div class="stat-value">${this.fmt(s.avg_order)}</div></div>
      </div>
      <div class="two-col" style="margin-bottom:16px">
        <div class="card">
          <div class="card-header"><span class="card-title">Daily Sales</span></div>
          <div class="chart-bars">
            ${sales.byDay.slice(-14).map(d => {
              const h = Math.round((d.sales / maxSales) * 100);
              const label = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
              return `<div class="chart-bar-wrap"><div class="chart-bar-track"><div class="chart-bar" style="height:${h}%" title="${label}: ${this.fmt(d.sales)}"><div class="chart-bar-val">${this.fmtCompact(d.sales)}</div></div></div><div class="chart-bar-label">${label}</div></div>`;
            }).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Payment Methods</span></div>
          <table>
            <thead><tr><th>Method</th><th>Transactions</th><th>Total</th></tr></thead>
            <tbody>${sales.byMethod.map(m => `<tr><td><span class="badge-pill badge-info">${m.payment_method.replace(/_/g, ' ')}</span></td><td style="text-align:center">${m.count}</td><td class="fw-600">${this.fmt(m.total)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <div class="two-col" style="margin-bottom:16px">
        <div class="card">
          <div class="card-header"><span class="card-title">Top Selling Products</span><span style="font-size:11px;color:var(--text-muted)">by number of transactions</span></div>
          <table>
            <thead><tr><th>#</th><th>Product</th><th title="Number of completed transactions the item was on">Transactions</th><th>Units</th><th>Revenue</th></tr></thead>
            <tbody>${topProds.map((p,i) => `<tr><td style="color:var(--text-muted)">${i+1}</td><td class="fw-600">${p.product_name}</td><td class="fw-600" style="text-align:center">${p.transactions}</td><td style="text-align:center">${p.units_sold}</td><td class="fw-600 color-success">${this.fmt(p.revenue)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Sales by Category</span></div>
          <table>
            <thead><tr><th>Category</th><th>Units</th><th>Revenue</th></tr></thead>
            <tbody>${byCat.map(c => `<tr><td class="fw-600">${c.category}</td><td style="text-align:center">${c.units_sold}</td><td class="fw-600 color-success">${this.fmt(c.revenue)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Inventory Snapshot</span></div>
        <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
          <div class="stat-card"><div class="stat-label">Total Products</div><div class="stat-value">${inv.summary.total_products}</div></div>
          <div class="stat-card"><div class="stat-label">Total Units</div><div class="stat-value">${inv.summary.total_units}</div></div>
          <div class="stat-card blue"><div class="stat-label">Cost Value</div><div class="stat-value" style="font-size:20px">${this.fmt(inv.summary.cost_value)}</div></div>
          <div class="stat-card green"><div class="stat-label">Retail Value</div><div class="stat-value" style="font-size:20px">${this.fmt(inv.summary.retail_value)}</div></div>
        </div>
        ${inv.lowStock.length ? `<h4 style="margin-bottom:8px;color:var(--danger)">⚠️ Low Stock Alert (${inv.lowStock.length} items)</h4>
        <table>
          <thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Branch</th><th>Stock Level</th><th>Minimum</th></tr></thead>
          <tbody>${inv.lowStock.map(p => `<tr><td style="font-family:monospace;font-size:12px">${p.sku}</td><td class="fw-600">${p.name}</td><td>${p.category_name||'—'}</td><td>${p.branch_name||'—'}</td><td class="fw-600 color-danger">${p.stock_qty}</td><td style="color:var(--text-muted)">${p.min_stock}</td></tr>`).join('')}</tbody>
        </table>` : '<p style="color:var(--success)">✓ All products have sufficient stock</p>'}
      </div>
      ${inv.warehouseValue && inv.warehouseValue.length ? `
      <div class="card" style="margin-top:16px">
        <div class="card-header"><span class="card-title">Warehouse Inventory Value</span></div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Warehouses don't generate sales, so they're left out of the location filter above — this always shows their stock value regardless of the filter.</p>
        <table>
          <thead><tr><th>Warehouse</th><th>Products</th><th>Units</th><th>Cost Value</th><th>Retail Value</th></tr></thead>
          <tbody>${inv.warehouseValue.map(w => `<tr><td class="fw-600">${w.branch_name}</td><td>${w.total_products}</td><td>${w.total_units}</td><td class="fw-600">${this.fmt(w.cost_value)}</td><td class="fw-600 color-success">${this.fmt(w.retail_value)}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}
      <div class="card" style="margin-top:16px">
        <div class="card-header"><span class="card-title">Promotions Used</span></div>
        <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
          <div class="stat-card"><div class="stat-label">Promo Transactions</div><div class="stat-value">${promoRpt.totals.promo_transactions}</div></div>
          <div class="stat-card orange"><div class="stat-label">Total Discounts Given</div><div class="stat-value" style="font-size:20px">${this.fmt(promoRpt.totals.total_discount)}</div></div>
          <div class="stat-card blue"><div class="stat-label">Promo Sales Revenue</div><div class="stat-value" style="font-size:20px">${this.fmt(promoRpt.totals.total_sales)}</div></div>
        </div>
        ${promoRpt.byPromotion.length ? `
        <table>
          <thead><tr><th>Promotion</th><th>Code</th><th style="text-align:center">Times Used</th><th>Total Discount</th><th>Revenue Generated</th></tr></thead>
          <tbody>${promoRpt.byPromotion.map(p => `<tr>
            <td class="fw-600">${p.promotion_name||'—'}</td>
            <td><span style="font-family:monospace;font-size:12px;background:var(--bg);padding:2px 6px;border-radius:4px">${p.promotion_code}</span></td>
            <td style="text-align:center">${p.times_used}</td>
            <td class="fw-600 color-danger">-${this.fmt(p.total_discount)}</td>
            <td class="fw-600 color-success">${this.fmt(p.total_sales)}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr style="border-top:2px solid var(--border);background:var(--bg)">
            <td class="fw-600" colspan="2">Totals</td>
            <td class="fw-600" style="text-align:center">${promoRpt.totals.promo_transactions}</td>
            <td class="fw-600 color-danger">-${this.fmt(promoRpt.totals.total_discount)}</td>
            <td class="fw-600 color-success">${this.fmt(promoRpt.totals.total_sales)}</td>
          </tr></tfoot>
        </table>` : '<p style="color:var(--text-muted)">No promotions used in this period.</p>'}
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-header"><span class="card-title">AR Collections — Payments Received on Account</span></div>
        <div class="stats-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
          <div class="stat-card green"><div class="stat-label">Total Collected</div><div class="stat-value" style="font-size:20px">${this.fmt(arRpt.summary.total_collected)}</div></div>
          <div class="stat-card blue"><div class="stat-label">Payments Received</div><div class="stat-value">${arRpt.summary.payment_count}</div></div>
          <div class="stat-card"><div class="stat-label">Avg Payment</div><div class="stat-value" style="font-size:20px">${arRpt.summary.payment_count > 0 ? this.fmt(arRpt.summary.total_collected / arRpt.summary.payment_count) : this.fmt(0)}</div></div>
        </div>
        ${arRpt.summary.payment_count > 0 ? `
        <div class="two-col" style="margin-bottom:14px">
          <div>
            <h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">By Payment Method</h4>
            <table>
              <thead><tr><th>Method</th><th style="text-align:center">Payments</th><th>Amount</th></tr></thead>
              <tbody>${arRpt.byMethod.map(m => `<tr>
                <td><span class="badge-pill badge-info">${m.payment_method.replace(/_/g, ' ')}</span></td>
                <td style="text-align:center">${m.count}</td>
                <td class="fw-600 color-success">${this.fmt(m.total)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
          <div>
            <h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">Daily Collections</h4>
            <table>
              <thead><tr><th>Date</th><th style="text-align:center">Payments</th><th>Collected</th></tr></thead>
              <tbody>${arRpt.byDay.map(d => `<tr>
                <td>${new Date(d.date + 'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</td>
                <td style="text-align:center">${d.payments}</td>
                <td class="fw-600 color-success">${this.fmt(d.collected)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
        <h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">By Customer</h4>
        <table>
          <thead><tr><th>Customer #</th><th>Name</th><th style="text-align:center">Payments</th><th>Total Paid</th><th>Outstanding Balance</th></tr></thead>
          <tbody>${arRpt.byCustomer.map(c => `<tr>
            <td style="font-family:monospace;font-size:12px">${c.customer_number}</td>
            <td class="fw-600">${c.customer_name}</td>
            <td style="text-align:center">${c.payments}</td>
            <td class="fw-600 color-success">${this.fmt(c.total_paid)}</td>
            <td class="${c.outstanding > 0 ? 'fw-600 color-danger' : 'color-success'}">${this.fmt(c.outstanding)}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr style="border-top:2px solid var(--border);background:var(--bg)">
            <td class="fw-600" colspan="3">Total</td>
            <td class="fw-600 color-success">${this.fmt(arRpt.summary.total_collected)}</td>
            <td></td>
          </tr></tfoot>
        </table>` : '<p style="color:var(--text-muted)">No AR payments received in this period.</p>'}
      </div>`;
  },

});
