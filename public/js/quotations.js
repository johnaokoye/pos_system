// Quotations, special projects, special orders.
Object.assign(App, {
  // ─── Quotations ───────────────────────────────────────────
  async renderQuotations() {
    if (this.section === 'special-orders') return this.renderSpecialOrders();
    const c = document.getElementById('content');
    // Guarded before the stomp, not just after — saveQuote() calls this
    // unconditionally on success, including when the quote was created from
    // POS's "Create Quote" grid button while still on the POS screen; without
    // this check it would blow away the POS kiosk layout underneath the
    // closing modal.
    if (this.section === 'quotations') c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    // Special Projects live on their own screen (renderSpecialProjects) —
    // filtered out here even for employees who can see both, so this list
    // stays retail+rental only.
    const quotes = (await this.api('GET', '/quotations?limit=100')).filter(q => q.quote_type !== 'special_project');
    if (this.section !== 'quotations') return;
    this._quotesAll = quotes;
    // Salespeople get a "My Quotes" / "All Quotes" split so they can find
    // what they're currently working on (including anything reassigned to
    // them) without scrolling past the whole store's quotes — everyone else
    // just sees the flat list they always have.
    const isSalesperson = !!this.currentUser.is_salesperson;
    if (isSalesperson && !this.quoteTab) this.quoteTab = 'mine';
    c.innerHTML = `
      <div class="section-header">
        <h2>Quotations</h2>
        <button class="btn btn-primary" onclick="App.showQuoteForm()">+ New Quotation</button>
      </div>
      ${isSalesperson ? `<div class="crm-tabs">
        <button class="crm-tab ${this.quoteTab==='mine'?'active':''}" onclick="App.switchQuoteTab('mine')">My Quotes</button>
        <button class="crm-tab ${this.quoteTab==='all'?'active':''}" onclick="App.switchQuoteTab('all')">All Quotes</button>
      </div>` : ''}
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
        <input type="text" id="qt-list-number" placeholder="Quote # search…" style="width:150px" oninput="App.filterQuotationsList()">
        <input type="text" id="qt-list-customer" placeholder="Customer name…" style="width:160px" oninput="App.filterQuotationsList()">
        <input type="date" id="qt-list-date" style="width:150px" onchange="App.filterQuotationsList()" title="Filter by the date the quote was created">
        <select id="qt-list-status" onchange="App.filterQuotationsList()" style="width:150px">
          <option value="">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="accepted">Accepted</option>
          <option value="declined">Declined</option>
          <option value="converted">Converted</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;font-size:13px;text-transform:none;color:var(--text)">
          <input type="checkbox" id="qt-list-mine" onchange="App.filterQuotationsList()" style="width:16px;height:16px;cursor:pointer">
          My Quotes Only
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;font-size:13px;text-transform:none;color:var(--text)">
          <input type="checkbox" id="qt-list-reassigned" onchange="App.filterQuotationsList()" style="width:16px;height:16px;cursor:pointer">
          Reassigned only
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;font-size:13px;text-transform:none;color:var(--text)">
          <input type="checkbox" id="qt-list-special" onchange="App.filterQuotationsList()" style="width:16px;height:16px;cursor:pointer">
          Special orders only
        </label>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Quote #</th><th>Type</th><th>Customer</th><th>Employee</th><th>Total</th><th>Valid Until / Due</th><th>Status</th><th>Invoice #</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody id="quotes-tbody">
              ${this.buildQuoteRows(isSalesperson && this.quoteTab === 'mine' ? quotes.filter(q => q.employee_id === this.currentUser.id) : quotes)}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  buildQuoteRows(quotes) {
    const statusColor = { draft:'badge-warning', sent:'badge-info', accepted:'badge-success', declined:'badge-danger', converted:'badge-teal' };
    if (!quotes.length) return '<tr><td colspan="10" class="empty-state">No quotations found</td></tr>';
    return quotes.map(q => {
      const reassigned = q.original_employee_name && q.employee_name !== q.original_employee_name;
      return `
                <tr>
                  <td class="fw-600">${q.quote_number}</td>
                  <td><span class="badge-pill ${q.quote_type==='rental'?'badge-warning':'badge-info'}" style="font-size:10px">${q.quote_type==='rental'?'RENTAL':'RETAIL'}</span>${q.is_special_order ? ` <span class="badge-pill badge-purple" style="font-size:10px" title="Includes Q items — things Purchasing has to order">SPECIAL ORDER</span>` : ''}</td>
                  <td>${q.customer_name || '<em style="color:#999">No Customer</em>'}</td>
                  <td>${q.employee_name||'-'}${reassigned ? ` <span class="badge-pill badge-info" style="font-size:10px" title="Sale credited to ${q.original_employee_name}">↪ reassigned</span>` : ''}</td>
                  <td class="fw-600">${this.fmt(q.total)}</td>
                  <td>${q.quote_type==='rental' ? (q.due_date ? this.fmtDate(q.due_date) : '-') : (q.valid_until ? this.fmtDate(q.valid_until) : '-')}</td>
                  <td><span class="badge-pill ${statusColor[q.status]||'badge-info'}">${q.status}</span></td>
                  <td>${q.quote_type==='rental'
                    ? (q.converted_agreement_number ? `<a href="#" style="font-family:monospace;font-size:12px;color:var(--primary);text-decoration:none;font-weight:600" onclick="event.preventDefault();App.viewRentalAgreement(${q.converted_to_agreement_id})">${q.converted_agreement_number}</a>` : '<span style="color:var(--text-muted)">—</span>')
                    : (q.converted_tx_number ? `<a href="#" style="font-family:monospace;font-size:12px;color:var(--primary);text-decoration:none;font-weight:600" onclick="event.preventDefault();App.viewTransaction(${q.converted_to_tx})">${q.converted_tx_number}</a>` : '<span style="color:var(--text-muted)">—</span>')}</td>
                  <td style="color:var(--text-muted)">${this.fmtDate(q.created_at)}</td>
                  <td>
                    <button class="btn btn-sm btn-secondary" onclick="App.viewQuote(${q.id})">View</button>
                    ${q.status!=='converted'&&q.status!=='declined' ? `<button class="btn btn-sm btn-outline" onclick="App.showQuoteForm(${q.id})">Edit</button>` : ''}
                    ${q.status!=='converted'&&q.status!=='declined' ? `<button class="btn btn-sm btn-primary" onclick="App.showConvertQuote(${q.id})">Convert</button>` : ''}
                  </td>
                </tr>`;
    }).join('');
  },

  switchQuoteTab(tab) {
    this.quoteTab = tab;
    this.renderQuotations();
  },

  filterQuotationsList() {
    const status = document.getElementById('qt-list-status')?.value || '';
    const reassignedOnly = document.getElementById('qt-list-reassigned')?.checked || false;
    // Separate from the Salesperson-only "My Quotes"/"All Quotes" tabs above
    // (mineOnly) — this checkbox is open to anyone, so staff who aren't
    // flagged as a formal Salesperson can still narrow the list down to
    // just the quotes logged in under their own name.
    const myQuotesOnly = document.getElementById('qt-list-mine')?.checked || false;
    const mineOnly = !!this.currentUser.is_salesperson && this.quoteTab === 'mine';
    const numberSearch = (document.getElementById('qt-list-number')?.value || '').trim().toLowerCase();
    const customerSearch = (document.getElementById('qt-list-customer')?.value || '').trim().toLowerCase();
    const dateSearch = document.getElementById('qt-list-date')?.value || '';
    const specialOnly = document.getElementById('qt-list-special')?.checked || false;
    const filtered = (this._quotesAll||[]).filter(q => {
      if (specialOnly && !q.is_special_order) return false;
      if (mineOnly && q.employee_id !== this.currentUser.id) return false;
      if (myQuotesOnly && q.employee_id !== this.currentUser.id) return false;
      if (status && q.status !== status) return false;
      if (reassignedOnly && !(q.original_employee_name && q.employee_name !== q.original_employee_name)) return false;
      if (numberSearch && !q.quote_number.toLowerCase().includes(numberSearch)) return false;
      if (customerSearch && !(q.customer_name || '').toLowerCase().includes(customerSearch)) return false;
      if (dateSearch && (!q.created_at || q.created_at.slice(0,10) !== dateSearch)) return false;
      return true;
    });
    const tbody = document.getElementById('quotes-tbody');
    if (tbody) tbody.innerHTML = this.buildQuoteRows(filtered);
  },

  // ─── Special Projects ───────────────────────────────────────────────────
  // Custom quotes/invoices for one-off jobs (e.g. tree removal — equipment
  // rental, tools, labour) — free-text line items with optional catalog
  // items and per-line markup, gated to a handful of people
  // (special_projects) and requiring a supervisor's pricing approval
  // (special_projects_approve) before it can go to the customer. Lives on
  // its own screen/permission, deliberately separate from Quotations even
  // though it shares the same quotations table under the hood (see
  // routes/quotations.js's quote_type='special_project').
  _spStatusLabels: {
    draft: 'Draft', pending_approval: 'Pending Approval', approved: 'Approved', sent: 'Sent',
    accepted: 'Accepted', declined: 'Declined', converted: 'Converted', cancelled: 'Cancelled',
  },
  _spStatusBadge: {
    draft: 'badge-warning', pending_approval: 'badge-warning', approved: 'badge-info', sent: 'badge-info',
    accepted: 'badge-success', declined: 'badge-danger', converted: 'badge-teal', cancelled: 'badge-secondary',
  },

  async renderSpecialProjects() {
    if (this.section === 'special-orders') return this.renderSpecialOrders();
    const c = document.getElementById('content');
    if (this.section === 'special-projects') c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const projects = await this.api('GET', '/quotations?quote_type=special_project&limit=100');
    if (this.section !== 'special-projects') return;
    this._specialProjectsAll = projects;
    c.innerHTML = `
      <div class="section-header">
        <h2>Special Projects</h2>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" onclick="App.showSpecialProjectsMarginReport()">📊 Margin Report</button>
          ${this.can('special_projects') ? `<button class="btn btn-primary" onclick="App.showQuoteForm(null,'special_project')">+ New Quotation</button>` : ''}
        </div>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:-8px 0 14px">Custom quotes/invoices for one-off jobs — free-form pricing, needs a supervisor's approval before it can go to the customer.</p>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
        <select id="sp-list-status" onchange="App.filterSpecialProjectsList()" style="width:170px">
          <option value="">All Statuses</option>
          ${Object.entries(this._spStatusLabels).map(([k,l]) => `<option value="${k}">${l}</option>`).join('')}
        </select>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;font-size:13px;text-transform:none;color:var(--text)">
          <input type="checkbox" id="sp-list-special" onchange="App.filterSpecialProjectsList()" style="width:16px;height:16px;cursor:pointer">
          Special orders only
        </label>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Quotation #</th><th>Customer</th><th>Employee</th><th>Total</th><th>Status</th><th>Invoice #</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody id="sp-tbody">${this.buildSpecialProjectRows(projects)}</tbody>
          </table>
        </div>
      </div>`;
  },

  buildSpecialProjectRows(projects) {
    if (!projects.length) return '<tr><td colspan="8" class="empty-state">No special projects found</td></tr>';
    const canManage = this.can('special_projects');
    const canApprove = this.can('special_projects_approve');
    return projects.map(p => `
      <tr>
        <td class="fw-600">${p.quote_number}${p.is_special_order ? ` <span class="badge-pill badge-purple" style="font-size:10px" title="Includes Q items — things Purchasing has to order">SPECIAL ORDER</span>` : ''}</td>
        <td>${p.customer_name || '<em style="color:#999">No Customer</em>'}</td>
        <td>${p.employee_name||'-'}</td>
        <td class="fw-600">${this.fmt(p.total)}</td>
        <td><span class="badge-pill ${this._spStatusBadge[p.status]||'badge-info'}">${this._spStatusLabels[p.status]||p.status}</span></td>
        <td>${p.converted_tx_number ? `<a href="#" style="font-family:monospace;font-size:12px;color:var(--primary);text-decoration:none;font-weight:600" onclick="event.preventDefault();App.viewTransaction(${p.converted_to_tx})">${p.converted_tx_number}</a>` : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td style="color:var(--text-muted)">${this.fmtDate(p.created_at)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-secondary" onclick="App.viewQuote(${p.id})">View</button>
          ${p.status==='draft' && canManage ? `<button class="btn btn-sm btn-outline" onclick="App.showQuoteForm(${p.id})">Edit</button>
            <button class="btn btn-sm btn-primary" onclick="App.submitSpecialProjectForApproval(${p.id})">Submit</button>` : ''}
          ${p.status==='pending_approval' && canApprove ? `<button class="btn btn-sm btn-success" onclick="App.showApproveSpecialProjectModal(${p.id})">Approve</button>
            <button class="btn btn-sm btn-danger" onclick="App.showRejectSpecialProjectModal(${p.id})">Reject</button>` : ''}
          ${['pending_approval','approved','sent','accepted','declined'].includes(p.status) && canManage ? `<button class="btn btn-sm btn-outline" onclick="App.reopenSpecialProject(${p.id},'${p.status}')">Edit</button>` : ''}
          ${['approved','sent','accepted'].includes(p.status) && canManage ? `<button class="btn btn-sm btn-primary" onclick="App.showConvertQuote(${p.id})">Convert</button>` : ''}
        </td>
      </tr>`).join('');
  },

  filterSpecialProjectsList() {
    const status = document.getElementById('sp-list-status')?.value || '';
    const specialOnly = document.getElementById('sp-list-special')?.checked || false;
    const filtered = (this._specialProjectsAll||[]).filter(p => (!status || p.status === status) && (!specialOnly || p.is_special_order));
    const tbody = document.getElementById('sp-tbody');
    if (tbody) tbody.innerHTML = this.buildSpecialProjectRows(filtered);
  },

  // ─── Special Orders ─────────────────────────────────────────────────────
  // One combined list of every retail quote and Special Project that has a
  // Q item (see IS_SPECIAL_ORDER_SQL in routes/quotations.js) — the same
  // quotes the "Special orders only" filter picks out on each of those two
  // screens. The server already hides Special Projects from anyone without
  // special_projects/special_projects_approve, so those staff just see the
  // retail ones here.
  _canSeeSpecialOrders() {
    return this.can('quotations') || this.can('special_projects') || this.can('special_projects_approve');
  },

  async renderSpecialOrders() {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const orders = await this.api('GET', '/quotations?special_order=1&limit=500');
    if (this.section !== 'special-orders') return;
    this._specialOrdersAll = orders;
    const hasSP = orders.some(o => o.quote_type === 'special_project') || this.can('special_projects') || this.can('special_projects_approve');
    const statusLabels = { draft:'Draft', pending_approval:'Pending Approval', approved:'Approved', sent:'Sent', accepted:'Accepted', declined:'Declined', converted:'Converted', cancelled:'Cancelled' };
    c.innerHTML = `
      <div class="section-header">
        <h2>Special Orders</h2>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:-8px 0 14px">Retail quotes${hasSP ? ' and Special Projects' : ''} that include Q items — things Purchasing has to order for the customer.</p>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
        <input type="text" id="so-list-search" placeholder="Quote # or customer…" style="width:200px" oninput="App.filterSpecialOrdersList()">
        ${hasSP ? `<select id="so-list-type" onchange="App.filterSpecialOrdersList()" style="width:160px">
          <option value="">All Types</option>
          <option value="retail">Retail</option>
          <option value="special_project">Special Project</option>
        </select>` : ''}
        <select id="so-list-status" onchange="App.filterSpecialOrdersList()" style="width:170px">
          <option value="open">Open (not converted)</option>
          <option value="">All Statuses</option>
          ${Object.entries(statusLabels).filter(([k]) => hasSP || !['pending_approval','approved','cancelled'].includes(k)).map(([k,l]) => `<option value="${k}">${l}</option>`).join('')}
        </select>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Quote #</th><th>Type</th><th>Customer</th><th>Employee</th><th>Total</th><th>Valid Until</th><th>Status</th><th>Invoice #</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody id="so-tbody"></tbody>
          </table>
        </div>
      </div>`;
    this.filterSpecialOrdersList();
  },

  filterSpecialOrdersList() {
    const search = (document.getElementById('so-list-search')?.value || '').trim().toLowerCase();
    const type = document.getElementById('so-list-type')?.value || '';
    const status = document.getElementById('so-list-status')?.value ?? 'open';
    const filtered = (this._specialOrdersAll||[]).filter(o => {
      const oType = o.quote_type === 'special_project' ? 'special_project' : 'retail';
      if (type && oType !== type) return false;
      if (status === 'open' ? ['converted','declined','cancelled'].includes(o.status) : (status && o.status !== status)) return false;
      if (search && !(o.quote_number||'').toLowerCase().includes(search) && !(o.customer_name||'').toLowerCase().includes(search)) return false;
      return true;
    });
    const tbody = document.getElementById('so-tbody');
    if (tbody) tbody.innerHTML = this.buildSpecialOrderRows(filtered);
  },

  buildSpecialOrderRows(orders) {
    if (!orders.length) return '<tr><td colspan="10" class="empty-state">No special orders found</td></tr>';
    const retailBadge = { draft:'badge-warning', sent:'badge-info', accepted:'badge-success', declined:'badge-danger', converted:'badge-teal' };
    const canManageSP = this.can('special_projects');
    const canApproveSP = this.can('special_projects_approve');
    return orders.map(o => {
      const isSP = o.quote_type === 'special_project';
      const statusHtml = isSP
        ? `<span class="badge-pill ${this._spStatusBadge[o.status]||'badge-info'}">${this._spStatusLabels[o.status]||o.status}</span>`
        : `<span class="badge-pill ${retailBadge[o.status]||'badge-info'}">${o.status}</span>`;
      let actions = `<button class="btn btn-sm btn-secondary" onclick="App.viewQuote(${o.id})">View</button>`;
      if (isSP) {
        if (o.status==='draft' && canManageSP) actions += ` <button class="btn btn-sm btn-outline" onclick="App.showQuoteForm(${o.id})">Edit</button>`;
        if (o.status==='pending_approval' && canApproveSP) actions += ` <button class="btn btn-sm btn-success" onclick="App.showApproveSpecialProjectModal(${o.id})">Approve</button>`;
        if (['approved','sent','accepted'].includes(o.status) && canManageSP) actions += ` <button class="btn btn-sm btn-primary" onclick="App.showConvertQuote(${o.id})">Convert</button>`;
      } else if (o.status!=='converted' && o.status!=='declined') {
        actions += ` <button class="btn btn-sm btn-outline" onclick="App.showQuoteForm(${o.id})">Edit</button>
          <button class="btn btn-sm btn-primary" onclick="App.showConvertQuote(${o.id})">Convert</button>`;
      }
      return `
      <tr>
        <td class="fw-600" style="white-space:nowrap">${o.quote_number}</td>
        <td><span class="badge-pill ${isSP?'badge-danger':'badge-info'}" style="font-size:10px">${isSP?'SPECIAL PROJECT':'RETAIL'}</span></td>
        <td>${o.customer_name || '<em style="color:#999">No Customer</em>'}</td>
        <td>${o.employee_name||'-'}</td>
        <td class="fw-600">${this.fmt(o.total)}</td>
        <td>${o.valid_until ? this.fmtDate(o.valid_until) : '-'}</td>
        <td>${statusHtml}</td>
        <td>${o.converted_tx_number ? `<a href="#" style="font-family:monospace;font-size:12px;color:var(--primary);text-decoration:none;font-weight:600" onclick="event.preventDefault();App.viewTransaction(${o.converted_to_tx})">${o.converted_tx_number}</a>` : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td style="color:var(--text-muted)">${this.fmtDate(o.created_at)}</td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>`;
    }).join('');
  },

  // ─── Special Projects: margin report ────────────────────────────────────
  // Realized/quoted margin per project (unit_cost vs unit_price on each
  // line, see routes/quotations.js's processQuoteItems). Gated server-side
  // by special_projects/special_projects_approve, same as the rest of this
  // screen — cost data is exactly what this permission split is meant to
  // protect, so it deliberately isn't folded into the general Reports
  // screen (gated only by the much more broadly-held `reports` permission).
  showSpecialProjectsMarginReport() {
    const today = new Date().toISOString().slice(0,10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const branches = this.currentUser.branches || [];
    this.showModal(`
      <div class="modal" style="max-width:820px">
        <div class="modal-header"><span class="modal-title">Special Projects — Margin Report</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="max-height:75vh;overflow-y:auto">
          <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
            <input type="date" id="spm-start" value="${monthStart}" style="width:150px">
            <span>to</span>
            <input type="date" id="spm-end" value="${today}" style="width:150px">
            ${branches.length > 1 ? `<select id="spm-branch" style="width:160px">
              <option value="">All Locations</option>
              ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
            </select>` : ''}
            <select id="spm-status" style="width:170px">
              <option value="">All Statuses</option>
              ${Object.entries(this._spStatusLabels).map(([k,l]) => `<option value="${k}">${l}</option>`).join('')}
            </select>
            <button class="btn btn-primary" onclick="App.loadSpecialProjectsMarginReport()">Generate</button>
          </div>
          <div id="spm-content" data-report-title="Special Projects Margin Report"><div class="empty-state"><p>Choose a range and click Generate.</p></div></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.printReport('spm-content')">🖨 Print</button>
          <button class="btn btn-outline" onclick="App.exportReportCsv('spm-content')">⬇ Export CSV</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
    this.loadSpecialProjectsMarginReport();
  },

  async loadSpecialProjectsMarginReport() {
    const start = document.getElementById('spm-start')?.value || '';
    const end = document.getElementById('spm-end')?.value || '';
    const branchId = document.getElementById('spm-branch')?.value || '';
    const status = document.getElementById('spm-status')?.value || '';
    const params = new URLSearchParams({ start, end });
    if (branchId) params.set('branch_id', branchId);
    if (status) params.set('status', status);
    const content = document.getElementById('spm-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data;
    try { data = await this.api('GET', `/reports/special-projects-margin?${params}`); }
    catch(e) { content.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    if (!document.getElementById('spm-content')) return; // modal closed while loading

    const { summary, projects, bySalesperson } = data;
    const marginColor = pct => pct == null ? 'var(--text-muted)' : pct < 0 ? 'var(--danger)' : pct < 15 ? 'var(--warning)' : 'var(--success)';
    const fmtPct = pct => pct == null ? '—' : `${pct.toFixed(1)}%`;

    content.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Projects</div><div class="stat-value">${summary.project_count}</div></div>
        <div class="stat-card purple"><div class="stat-label">Revenue</div><div class="stat-value">${this.fmt(summary.total_revenue)}</div></div>
        <div class="stat-card orange"><div class="stat-label">Cost</div><div class="stat-value">${this.fmt(summary.total_cost)}</div></div>
        <div class="stat-card green"><div class="stat-label">Margin</div><div class="stat-value" style="color:${marginColor(summary.margin_percent)}">${this.fmt(summary.total_margin)} <span style="font-size:13px">(${fmtPct(summary.margin_percent)})</span></div></div>
      </div>
      ${summary.lines_missing_cost > 0 ? `<p style="font-size:12px;color:var(--warning);margin:-10px 0 14px">⚠ ${summary.lines_missing_cost} line item${summary.lines_missing_cost===1?'':'s'} in this range ${summary.lines_missing_cost===1?'has':'have'} no cost entered — margin for those projects is understated (treated as $0 cost on that line).</p>` : ''}
      ${!projects.length ? '<div class="empty-state"><p>No Special Projects in this range.</p></div>' : `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">By Project</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Project #</th><th>Customer</th><th>Salesperson</th><th>Status</th><th>Revenue</th><th>Cost</th><th>Margin</th><th>Date</th></tr></thead>
            <tbody>${projects.map(p => `
              <tr>
                <td class="fw-600"><a href="#" style="color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.viewQuote(${p.id})">${p.quote_number}</a></td>
                <td>${p.customer_name||'—'}</td>
                <td>${p.original_employee_name||p.employee_name||'—'}</td>
                <td><span class="badge-pill ${this._spStatusBadge[p.status]||'badge-info'}" style="font-size:10px">${this._spStatusLabels[p.status]||p.status}</span></td>
                <td>${this.fmt(p.revenue)}</td>
                <td>${this.fmt(p.cost)}${p.missing_cost_count > 0 ? ` <span title="${p.missing_cost_count} line(s) with no cost entered">⚠</span>` : ''}</td>
                <td style="color:${marginColor(p.margin_percent)};font-weight:600">${this.fmt(p.margin)} <span style="font-size:11px">(${fmtPct(p.margin_percent)})</span></td>
                <td style="color:var(--text-muted)">${this.fmtDate(p.created_at)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">By Salesperson</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Salesperson</th><th>Projects</th><th>Revenue</th><th>Cost</th><th>Margin</th></tr></thead>
            <tbody>${bySalesperson.map(r => `
              <tr>
                <td class="fw-600">${r.employee_name}</td>
                <td>${r.project_count}</td>
                <td>${this.fmt(r.revenue)}</td>
                <td>${this.fmt(r.cost)}</td>
                <td style="color:${marginColor(r.margin_percent)};font-weight:600">${this.fmt(r.margin)} <span style="font-size:11px">(${fmtPct(r.margin_percent)})</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`}`;
  },

  async showQuoteForm(editId, initialType) {
    const [employees, products] = await Promise.all([
      this.api('GET', '/employees'),
      this.api('GET', '/products?for_sale=1'),
    ]);
    const branches = this.currentUser.branches || [];
    this._quoteProducts = products;
    this._quoteItems = [];
    this._quoteBranches = branches;
    this._quoteStockCache = {};
    this._editingQuoteId = editId || null;
    this._rentalQuoteProducts = [];
    this._rentalQuoteLineIdx = 0;
    this._spRentalProducts = null;
    this._spRentalAvail = null;
    const q = editId ? await this.api('GET', `/quotations/${editId}`) : null;
    const quoteCustomer = q?.customer_id ? await this._customerById(q.customer_id) : null;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
    // A Special Project is wider: its rental item search shows each item's
    // details and availability.
    const spForm = (q && q.quote_type === 'special_project') || (!editId && initialType === 'special_project');
    this.showModal(`
      <div class="modal" style="max-width:${spForm ? 'min(1280px, 96vw)' : '720px'}">
        <div class="modal-header"><span class="modal-title">${editId ? `Edit ${(q&&q.quote_type==='special_project')?'Special Project Quotation':'Quotation'}: ${q.quote_number}` : (initialType==='special_project' ? 'New Special Project Quotation' : 'New Quotation')}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${!editId && initialType !== 'special_project' ? `<div class="form-group"><label>Quote Type</label>
            <div style="display:flex;gap:8px">
              <button type="button" id="qt-type-retail-btn" class="btn btn-sm btn-primary" onclick="App.setQuoteType('retail')">Retail</button>
              <button type="button" id="qt-type-rental-btn" class="btn btn-sm btn-outline" onclick="App.setQuoteType('rental')">Rental</button>
              ${this.can('special_projects') ? `<button type="button" class="btn btn-sm btn-outline" onclick="App._quoteSwitchToSpecialProject()" title="Start a Special Project instead, keeping the customer, branch and items entered here">Special Project</button>` : ''}
              ${this.can('wo_intake') ? `<button type="button" class="btn btn-sm btn-outline" onclick="App._quoteSwitchToWorkOrder()" title="Open a Work Order for this customer instead">Work Order</button>` : ''}
            </div>
          </div>` : ''}
          <div class="input-row">
            <div class="form-group"><label>Customer</label>
              ${this._customerPickerHtml('qt-cust', quoteCustomer ? [quoteCustomer] : [], q && q.customer_id, { emptyLabel: '-- Walk-in / No Customer --', remote: '' })}
              <p id="qt-cust-hint" style="display:none;font-size:11px;color:var(--text-muted);margin:4px 0 0">Only approved rental customers are listed.</p>
            </div>
            <div class="form-group"><label>Branch</label>
              <select id="qt-branch" onchange="App.onQuoteBranchTypeChange()">
                <option value="">-- Select Branch --</option>
                ${branches.map(b => `<option value="${b.id}" ${q&&q.branch_id===b.id?'selected':''}>${b.name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="input-row">
            <div class="form-group" id="qt-valid-group"><label>Valid Until</label>
              <div style="display:flex;gap:6px">
                <select id="qt-valid-preset" style="width:120px;flex-shrink:0" data-base="${q&&q.created_at?String(q.created_at).slice(0,10):''}" onchange="App._applyQuoteExpiryPreset()" title="Quote expiry, counted from the quote date">
                  <option value="">Custom date</option>
                  <option value="30">30 days</option>
                  <option value="60">60 days</option>
                  <option value="90">90 days</option>
                </select>
                <input id="qt-valid" type="date" value="${q&&q.valid_until?String(q.valid_until).slice(0,10):''}" oninput="App._syncQuoteExpiryPreset()">
              </div>
            </div>
            <div class="form-group" id="qt-duedate-group" style="display:none"><label>Due Date *</label><input id="qt-duedate" type="date" value="${q&&q.due_date?String(q.due_date).slice(0,10):tomorrow}" oninput="App._refreshQuoteRatePlan()"></div>
            <div id="qt-rateplan-group" style="display:none;flex:1">${this._ratePlanSelectHtml('qt-rateplan', 'App._refreshQuoteRatePlan()', q && q.rate_plan)}</div>
            <div class="form-group"><label>Discount ($)</label><input id="qt-disc" type="number" step="0.01" value="${q?q.discount_amount:0}" oninput="App.calcQuoteTotal()"></div>
          </div>
          <div class="input-row">
            <div class="form-group" id="qt-po-group" style="flex:0 0 220px"><label>Customer P.O. #</label><input id="qt-po" value="${this.escapeAttr(q&&q.po_number)}" placeholder="Optional — prints on the invoice"></div>
            <div class="form-group"><label>Notes</label><input id="qt-notes" value="${this.escapeAttr(q&&q.notes)}"></div>
          </div>
          <div id="qt-retail-items-section" style="margin-bottom:10px">
            <div class="card-header"><span class="card-title">Items</span>
              <div style="display:flex;gap:6px">
                <button class="btn btn-sm btn-outline" onclick="App.addQuoteItem()">+ Add Item</button>
                <button class="btn btn-sm btn-outline" id="qt-add-custom-item-btn" onclick="App.addQuoteCustomItem()" title="Something not in inventory that Purchasing should order — a Purchase Request is auto-created when the customer accepts the quote">+ Q Item</button>
                <button class="btn btn-sm btn-outline" onclick="App.addQuoteCommentItem()" title="A comment line — free text printed on the quote and invoice, with no price and nothing sent to Purchasing">+ C Item</button>
                <button class="btn btn-sm btn-outline" onclick="App.addQuoteDeliveryItem()" title="A delivery charge — your description and a price before tax; tax is added at the store rate">+ Delivery</button>
                <button class="btn btn-sm btn-outline" id="qt-add-q-item-btn" style="display:none" onclick="App.addQuoteCustomItem(null,{qItem:true})" title="Something not in inventory that Purchasing should order — a Purchase Request is auto-created when the project is accepted">+ Q Item</button>
                <button class="btn btn-sm btn-outline" id="qt-add-rental-item-btn" style="display:none" onclick="App.addQuoteRentalItem()" title="A rental item for a set period — held when the project is approved, issued and checked back in through Rentals">+ Rental Item</button>
              </div>
            </div>
            <div id="qt-items"></div>
          </div>
          <div id="qt-rental-items-section" style="display:none;margin-bottom:10px">
            <div class="card-header"><span class="card-title">Rental Items</span>
              <button class="btn btn-sm btn-outline" onclick="App.addRentalQuoteLine()">+ Add Item</button>
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin:-4px 0 8px">Item availability reflects stock at the selected branch. The total below is an estimate — the real charge is computed when the rental is finalized at the register.</p>
            <div id="qt-rental-items"></div>
            <hr style="margin:12px 0">
            <strong>Additional Services</strong>
            <p style="font-size:11px;color:var(--text-muted);margin:2px 0 8px">Matches New Rental — costs entered here are charged along with the rental fee at checkout. The driver/operator themselves are assigned later, at issue/return.</p>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="qt-delivery" onchange="App._toggleQuoteService('delivery')" style="width:16px;height:16px;cursor:pointer" ${q&&q.delivery_required?'checked':''}>
                Delivery required
              </label>
            </div>
            <div id="qt-delivery-fields" style="display:${q&&q.delivery_required?'block':'none'}">
              <div class="form-group" style="max-width:220px"><label style="font-size:11px">Delivery Cost</label><input type="number" id="qt-delivery-cost" oninput="App.calcQuoteTotal()" value="${q&&q.delivery_cost||0}" min="0" step="0.01"></div>
              <div class="form-group"><label style="font-size:11px">Delivery Address *</label><textarea id="qt-delivery-address" rows="2" placeholder="Required — ask the customer where it's going, even if it's their own address">${this.escapeAttr(q&&q.delivery_address)}</textarea></div>
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="qt-pickup" onchange="App._toggleQuoteService('pickup')" style="width:16px;height:16px;cursor:pointer" ${q&&q.pickup_required?'checked':''}>
                Pickup (from customer) required
              </label>
            </div>
            <div id="qt-pickup-fields" style="display:${q&&q.pickup_required?'block':'none'}">
              <div class="form-group" style="max-width:220px"><label style="font-size:11px">Pickup Cost</label><input type="number" id="qt-pickup-cost" oninput="App.calcQuoteTotal()" value="${q&&q.pickup_cost||0}" min="0" step="0.01"></div>
              <div class="form-group"><label style="font-size:11px">Pickup Address *<a href="#" style="font-weight:400;text-transform:none;color:var(--primary);margin-left:6px" onclick="event.preventDefault();const d=document.getElementById('qt-delivery-address');if(!document.getElementById('qt-delivery')?.checked||!d||!d.value.trim()){App.alert('Tick Delivery required and enter the delivery address first','warning');return;}document.getElementById('qt-pickup-address').value=d.value">same as delivery address</a></label><textarea id="qt-pickup-address" rows="2" placeholder="Required — ask the customer where it's being collected from, even if it's their own address">${this.escapeAttr(q&&q.pickup_address)}</textarea></div>
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="qt-operator" onchange="App._toggleQuoteService('operator')" style="width:16px;height:16px;cursor:pointer" ${q&&q.operator_required?'checked':''}>
                Operator required
              </label>
            </div>
            <div id="qt-operator-fields" class="form-group" style="display:${q&&q.operator_required?'block':'none'};max-width:220px">
              <label style="font-size:11px">Operator Fee</label><input type="number" id="qt-operator-fee" oninput="App.calcQuoteTotal()" value="${q&&q.operator_fee||0}" min="0" step="0.01">
            </div>
          </div>
          <div style="text-align:right;font-size:15px;font-weight:700">Total: <span id="qt-total">$0.00</span></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveQuote()">${initialType === 'special_project' || (q&&q.quote_type==='special_project') ? 'Save Draft' : (editId ? 'Save Changes' : 'Create Quote')}</button>
        </div>
      </div>`);
    if (q) {
      this._applyQuoteTypeVisibility(q.quote_type || 'retail');
      if (q.quote_type === 'rental') {
        await this._refreshRentalQuoteBranch();
        const parents = q.items.filter(i => i.parent_item_id == null);
        if (parents.length) {
          parents.forEach(p => {
            const accessory_ids = q.items.filter(c => c.parent_item_id === p.id && !c.is_mandatory).map(c => c.product_id);
            this.addRentalQuoteLine({ product_id: p.product_id, quantity: p.quantity, condition_out: p.condition_out, accessory_ids });
          });
        } else {
          this.addRentalQuoteLine();
        }
      } else if (q.items.length) {
        q.items.forEach(item => {
          // A rental line's mandatory accessories are re-added by the server on save.
          if (item.is_rental_line) { if (!item.parent_item_id) this.addQuoteRentalItem(item); return; }
          if (item.is_comment) { this.addQuoteCommentItem(item); return; }
          if (item.is_delivery) { this.addQuoteDeliveryItem(item); return; }
          item.product_id ? this.addQuoteItem(item) : this.addQuoteCustomItem(item, { qItem: !!item.is_q_item });
        });
      } else {
        this.addQuoteItem();
      }
    } else if (initialType === 'rental') {
      this._applyQuoteTypeVisibility('rental');
      await this._refreshRentalQuoteBranch();
      this.addRentalQuoteLine();
    } else if (initialType === 'special_project') {
      this._applyQuoteTypeVisibility('special_project');
      this.addQuoteItem();
    } else {
      this._applyQuoteTypeVisibility('retail');
      this.addQuoteItem();
    }
    // Item lines are added dynamically (addQuoteItem/addRentalQuoteLine), so
    // this closes whichever qti-prod-dd-*/rql-prod-dd-* dropdown is
    // currently open rather than binding to a specific line's id — same
    // pattern as the Work Order parts picker.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.qti-prod-search-wrap')) {
        document.querySelectorAll('[id^="qti-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
      if (!e.target.closest('.rql-prod-search-wrap')) {
        document.querySelectorAll('[id^="rql-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
      if (!e.target.closest('.qti-rprod-search-wrap')) {
        document.querySelectorAll('[id^="qti-rprod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
      }
    });
  },

  // Pure show/hide between the retail and rental sections of the quote form
  // — does not touch items, so it's safe to call while populating an
  // existing quote's items right after.
  _applyQuoteTypeVisibility(type) {
    this._quoteType = type;
    const retailBtn = document.getElementById('qt-type-retail-btn');
    const rentalBtn = document.getElementById('qt-type-rental-btn');
    if (retailBtn) retailBtn.className = type==='retail' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
    if (rentalBtn) rentalBtn.className = type==='rental' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
    const retailSection = document.getElementById('qt-retail-items-section');
    const rentalSection = document.getElementById('qt-rental-items-section');
    const validGroup = document.getElementById('qt-valid-group');
    const dueGroup = document.getElementById('qt-duedate-group');
    // Special Projects reuse the same catalog+custom item builder as retail
    // (just with an extra Cost field per row, see addQuoteItem/
    // addQuoteCustomItem) — so anything that isn't specifically rental shows
    // the retail items section and the Valid Until field.
    if (retailSection) retailSection.style.display = type!=='rental' ? '' : 'none';
    // A rental's customer P.O. is taken at checkout instead.
    const poGroup = document.getElementById('qt-po-group');
    if (poGroup) poGroup.style.display = type!=='rental' ? '' : 'none';
    // Retail's custom line is already a Q item (its button reads "+ Q Item"); a Special Project's is a
    // labour/fee line, so Q items get their own button there.
    const qItemBtn = document.getElementById('qt-add-q-item-btn');
    if (qItemBtn) qItemBtn.style.display = type==='special_project' ? '' : 'none';
    // Same button either way: on retail it adds a Q item, so it's labelled
    // that; on a Special Project it's the labour/fee line.
    const customItemBtn = document.getElementById('qt-add-custom-item-btn');
    if (customItemBtn) {
      customItemBtn.textContent = type==='special_project' ? '+ Custom Item' : '+ Q Item';
      customItemBtn.title = type==='special_project'
        ? 'A labour or fee line (e.g. Labour, Equipment operator) — not sent to Purchasing'
        : 'Something not in inventory that Purchasing should order — a Purchase Request is auto-created when the customer accepts the quote';
    }
    const rentalItemBtn = document.getElementById('qt-add-rental-item-btn');
    if (rentalItemBtn) rentalItemBtn.style.display = type==='special_project' ? '' : 'none';
    if (rentalSection) rentalSection.style.display = type==='rental' ? '' : 'none';
    if (validGroup) validGroup.style.display = type!=='rental' ? '' : 'none';
    if (dueGroup) dueGroup.style.display = type==='rental' ? '' : 'none';
    const ratePlanGroup = document.getElementById('qt-rateplan-group');
    if (ratePlanGroup) ratePlanGroup.style.display = type==='rental' ? '' : 'none';
    if (type === 'rental') this._refreshQuoteRatePlan();
    // Retail quotes default Valid Until to 30 days out when the field hasn't
    // been touched yet — a fresh new-quote render, or toggling back from
    // Rental — same idea as the rental Due Date field defaulting to
    // tomorrow. Never overwrites an already-populated value (editing an
    // existing quote, or a date the user already entered/cleared-and-kept).
    if (type === 'retail') {
      const validInput = document.getElementById('qt-valid');
      if (validInput && !validInput.value) {
        validInput.value = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      }
    }
    this._syncQuoteExpiryPreset();
    this._applyQuoteCustomerFilter(type);
    this.calcQuoteTotal();
  },

  // Rental quotes only offer customers already approved for rentals
  // (is_rental_customer) — the current selection is kept even if it doesn't
  // match, so editing an older quote (or a customer whose flag changed
  // since) never silently loses its assigned customer.
  _applyQuoteCustomerFilter(type) {
    const input = document.getElementById('qt-cust');
    const hint = document.getElementById('qt-cust-hint');
    const cfg = (this._custPickerLists || {})['qt-cust'];
    if (!input || !cfg) return;
    cfg.remote = type === 'rental' ? '&rental=1' : '';
    if (hint) hint.style.display = type === 'rental' ? '' : 'none';
  },

  // Toggle-button handler (new-quote flow only — the type is fixed once a
  // quote exists). Switching type mid-form resets items, since retail and
  // rental item shapes aren't interchangeable.
  setQuoteType(type) {
    if (type === this._quoteType) return;
    this._applyQuoteTypeVisibility(type);
    document.getElementById('qt-items').innerHTML = '';
    document.getElementById('qt-rental-items').innerHTML = '';
    this._quoteItems = [];
    if (type === 'rental') this.addRentalQuoteLine(); else this.addQuoteItem();
  },

  onQuoteBranchTypeChange() {
    if (this._quoteType === 'rental') this._refreshRentalQuoteBranch();
    else this.onQuoteBranchChange();
    document.querySelectorAll('#qt-items > [data-rental="1"]').forEach(row => this._quoteRentalEstimate(row.id.split('-').pop()));
  },

  _toggleQuoteService(which) {
    const box = document.getElementById(`qt-${which}`);
    const fields = document.getElementById(`qt-${which}-fields`);
    if (fields) fields.style.display = box?.checked ? 'block' : 'none';
    this.calcQuoteTotal();
  },

  addQuoteItem(prefill) {
    this._quoteItems = this._quoteItems || [];
    const idx = this._quoteItems.length;
    this._quoteItems.push({});
    const container = document.getElementById('qt-items');
    const isSP = this._quoteType === 'special_project';
    // prefill comes straight off the quotation_items row when editing an
    // existing quote, which already carries its own product_name/unit_price
    // snapshot — shown as-is rather than re-looked-up against the current
    // catalog (a product's price/name may have moved on since the quote was
    // written), matching how prices elsewhere on this form are snapshots.
    const prefillLabel = prefill && prefill.product_id ? `${prefill.product_name} (${this.fmt(prefill.unit_price)})` : '';
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.id = `qt-item-${idx}`;
    div.innerHTML = `
      <span class="qti-prod-search-wrap" style="flex:2;position:relative">
        <input type="text" id="qti-prod-search-${idx}" placeholder="Search products…" autocomplete="off" style="width:100%"
          value="${this.escapeAttr(prefillLabel)}"
          oninput="App._filterQuoteItemOptions(${idx},this.value)" onfocus="App._filterQuoteItemOptions(${idx},this.value)">
        <input type="hidden" id="qti-prod-${idx}" value="${prefill&&prefill.product_id||''}">
        <div id="qti-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
      </span>
      <input id="qti-sn-${idx}" type="text" placeholder="Serial #" value="${this.escapeAttr(prefill&&prefill.serial_number||'')}" style="width:130px;${prefill&&prefill.serial_number?'':'display:none'}" title="Serial number recorded on this SN line">
      ${this._quoteUnitSelectHtml(idx, prefill)}
      <input id="qti-qty-${idx}" type="number" min="0" step="any" value="${prefill?prefill.quantity:1}" style="width:70px" placeholder="Qty" ${prefill&&prefill.serial_number?'readonly':''} oninput="App.calcQuoteTotal();App.checkQuoteItemStock(${idx})">
      ${isSP ? `<input id="qti-cost-${idx}" type="number" step="0.01" value="${prefill&&prefill.unit_cost!=null?prefill.unit_cost:''}" style="width:90px" placeholder="Cost" title="Informational only — doesn't affect the total" oninput="App._updateQuoteItemMargin(${idx})">` : ''}
      <input id="qti-price-${idx}" type="number" step="0.01" value="${prefill?prefill.unit_price:''}" style="width:90px" placeholder="Price" oninput="App.calcQuoteTotal();App._updateQuoteItemMargin(${idx})">
      <input id="qti-disc-${idx}" type="number" min="0" step="0.01" value="${prefill&&prefill.discount_amount||''}" style="width:80px" placeholder="Discount" title="Discount given on this line — recorded for reference, doesn't change the price above">
      ${isSP ? `<span id="qti-margin-${idx}" style="font-size:11px;color:var(--text-muted);white-space:nowrap"></span>` : ''}
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('qt-item-${idx}').remove();const a=document.getElementById('qt-alloc-${idx}');if(a)a.remove();App.calcQuoteTotal()">✕</button>`;
    container.appendChild(div);
    const allocDiv = document.createElement('div');
    allocDiv.id = `qt-alloc-${idx}`;
    container.appendChild(allocDiv);
    this.calcQuoteTotal();
    if (prefill && prefill.product_id) this.checkQuoteItemStock(idx);
    if (isSP) this._updateQuoteItemMargin(idx);
  },

  // Searchable replacement for what used to be a plain <select> of every
  // for-sale product — same pattern as the Work Order parts picker
  // (_filterWOPartOptions/_selectWOPartOption). checkQuoteItemStock/
  // recalcQuoteAllocation/saveQuote all read qti-prod-${idx}'s value
  // directly (a hidden input here, same id/semantics as the old select), so
  // none of them needed to change.
  _filterQuoteItemOptions(idx, query) {
    const dd = document.getElementById(`qti-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._quoteProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectQuoteItemOption(${idx},${p.id})">
        <strong>${p.name}${p.is_rental?' [Rental]':''}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${this.fmt(p.price)}${p.sku ? ' · ' + p.sku : ''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No products found</div>`;
    dd.style.display = '';
  },

  async _selectQuoteItemOption(idx, productId) {
    const p = (this._quoteProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`qti-prod-${idx}`);
    const searchEl = document.getElementById(`qti-prod-search-${idx}`);
    const dd = document.getElementById(`qti-prod-dd-${idx}`);
    if (hidden) hidden.value = productId;
    if (searchEl) searchEl.value = `${p.name}${p.is_rental?' [Rental]':''} (${this.fmt(p.price)})`;
    if (dd) dd.style.display = 'none';
    // SN line: reveal the serial field and pin qty to 1 (one serial per line).
    const isSN = this._isSerialNumberProduct(p);
    const snInp = document.getElementById(`qti-sn-${idx}`);
    const qtyInp = document.getElementById(`qti-qty-${idx}`);
    if (snInp) { snInp.style.display = isSN ? '' : 'none'; if (!isSN) snInp.value = ''; }
    if (qtyInp) { qtyInp.readOnly = isSN; if (isSN) qtyInp.value = 1; }
    if (isSN && snInp) snInp.focus();

    // Once a branch is picked, its tiered price wins over the catalog base
    // price — matches what the register would actually charge at that
    // branch. No branch chosen yet falls back to the flat base price.
    const branchId = document.getElementById('qt-branch')?.value;
    let price = p.price;
    if (branchId) {
      const branchMap = await this.getBranchStock(branchId);
      const branchPrice = branchMap[productId]?.price;
      if (branchPrice != null) price = branchPrice;
    }
    const priceInp = document.getElementById(`qti-price-${idx}`);
    if (priceInp) priceInp.value = price;
    // An item with alternate units asks which one to quote it in (lib/units.js).
    const choice = isSN ? null : await this._pickUnit(p);
    this._refreshQuoteUnitSelect(idx, p, price, choice);
    if (choice && !choice.isBase) await this._onQuoteUnitChange(idx);
    this.calcQuoteTotal();
    this.checkQuoteItemStock(idx);
    if (this._quoteType === 'special_project') {
      const costInput = document.getElementById(`qti-cost-${idx}`);
      if (costInput && !costInput.value) costInput.value = p.cost || 0;
      this._updateQuoteItemMargin(idx);
    }
  },

  // Special Project rental line: a rental item for a set period, charged on
  // the project invoice. Price is per unit for the whole period — filled
  // from the catalog rate (POST /quotations/rental-line-estimate) until the
  // user types their own. Approving the project holds the item (see
  // holdSpecialProjectRentals in routes/quotations.js).
  addQuoteRentalItem(prefill) {
    this._quoteItems = this._quoteItems || [];
    const idx = this._quoteItems.length;
    this._quoteItems.push({ rental: true });
    const container = document.getElementById('qt-items');
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const name = prefill ? String(prefill.product_name || '').split(' — Rental ')[0] : '';
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.id = `qt-item-${idx}`;
    div.dataset.rental = '1';
    div.style.flexWrap = 'wrap';
    div.innerHTML = `
      <span class="badge-pill badge-warning" style="flex-shrink:0" title="Rental item — held when the project is approved">RENTAL</span>
      <span class="qti-rprod-search-wrap" style="flex:2;min-width:180px;position:relative">
        <input type="text" id="qti-rprod-search-${idx}" placeholder="Search rental items…" autocomplete="off" style="width:100%" value="${this.escapeAttr(name)}"
          oninput="App._filterQuoteRentalOptions(${idx},this.value)" onfocus="App._filterQuoteRentalOptions(${idx},this.value)">
        <input type="hidden" id="qti-rprod-${idx}" value="${prefill&&prefill.product_id||''}">
        <div id="qti-rprod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;width:max(100%, min(760px, 88vw));background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:420px;overflow-y:auto;margin-top:2px"></div>
      </span>
      <input id="qti-qty-${idx}" type="number" min="1" value="${prefill?prefill.quantity:1}" style="width:60px" placeholder="Qty" oninput="App._quoteRentalEstimate(${idx})">
      <input id="qti-rstart-${idx}" type="date" value="${prefill&&prefill.rental_start||today}" style="width:140px" title="Rental start" onchange="App._quoteRentalEstimate(${idx})">
      <span style="font-size:12px;color:var(--text-muted)">to</span>
      <input id="qti-rend-${idx}" type="date" value="${prefill&&prefill.rental_end||tomorrow}" style="width:140px" title="Rental end (due back)" onchange="App._quoteRentalEstimate(${idx})">
      <select id="qti-rplan-${idx}" style="width:150px" title="Rate — Automatic uses the rate the rental length earns" onchange="App._quoteRentalEstimate(${idx})" onfocus="App._refreshQuoteRentalLinePlan(${idx})">
        ${[['', 'Rate: Automatic'], ['daily', 'Daily rate'], ['weekly', 'Weekly rate'], ['monthly', 'Monthly rate']].map(([v, l]) => `<option value="${v}" ${(prefill && prefill.rate_plan || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input id="qti-cost-${idx}" type="number" step="0.01" value="${prefill&&prefill.unit_cost!=null?prefill.unit_cost:''}" style="width:80px" placeholder="Cost" title="Informational only — doesn't affect the total" oninput="App._updateQuoteItemMargin(${idx})">
      <input id="qti-price-${idx}" type="number" step="0.01" value="${prefill?prefill.unit_price:''}" data-auto="${prefill?'0':'1'}" style="width:90px" placeholder="Price" title="Price per unit for the whole rental period" oninput="this.dataset.auto='0';App.calcQuoteTotal();App._updateQuoteItemMargin(${idx})">
      <input id="qti-disc-${idx}" type="number" min="0" step="0.01" value="${prefill&&prefill.discount_amount||''}" style="width:75px" placeholder="Discount" title="Discount given on this line — recorded for reference, doesn't change the price">
      <span id="qti-margin-${idx}" style="font-size:11px;color:var(--text-muted);white-space:nowrap"></span>
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('qt-item-${idx}').remove();App.calcQuoteTotal()">✕</button>
      <div id="qti-rinfo-${idx}" style="flex-basis:100%;font-size:11px;color:var(--text-muted);padding-left:4px"></div>`;
    container.appendChild(div);
    this.calcQuoteTotal();
    this._updateQuoteItemMargin(idx);
    if (prefill && prefill.product_id) this._quoteRentalEstimate(idx);
  },

  async _filterQuoteRentalOptions(idx, query) {
    const dd = document.getElementById(`qti-rprod-dd-${idx}`);
    if (!dd) return;
    if (!this._spRentalProducts) {
      try { this._spRentalProducts = await this.api('GET', '/products?is_rental=1&active=1'); } catch(e) { this._spRentalProducts = []; }
    }
    const avail = await this._spRentalAvailability();
    const q = (query || '').toLowerCase().trim();
    const matches = this._spRentalProducts.filter(p => !q || `${p.name} ${p.sku || ''} ${p.model_number || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => this._spRentalOptionHtml(idx, p, avail && avail.byId.get(p.id), avail)).join('')
      : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No rental items found</div>`;
    dd.style.display = '';
  },

  // GET /quotations/rental-availability for the form's branch, kept for a
  // minute (the search reopens on every keystroke). null if it can't load —
  // the search still works, without availability.
  async _spRentalAvailability(force) {
    const branchId = document.getElementById('qt-branch')?.value || '';
    const c = this._spRentalAvail;
    if (!force && c && c.branchId === branchId && Date.now() - c.at < 60000) return c;
    try {
      const data = await this.api('GET', `/quotations/rental-availability${branchId ? `?branch_id=${branchId}` : ''}`);
      this._spRentalAvail = { branchId, at: Date.now(), today: data.today, byId: new Map(data.items.map(i => [i.product_id, i])) };
    } catch(e) { this._spRentalAvail = null; }
    return this._spRentalAvail;
  },

  // When it's back: "due back Nov 14" for the earliest rental out, flagged
  // when that date has passed.
  _spDueText(a, today) {
    if (!a || !a.next_due) return '';
    const overdue = today && a.next_due < today;
    return overdue
      ? `<span style="color:var(--danger)">overdue since ${this.fmtDate(a.next_due)}</span>`
      : `due back ${this.fmtDate(a.next_due)}`;
  },

  _spRentalOptionHtml(idx, p, a, avail) {
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    const rates = [['day', p.rental_rate], ['wk', p.rental_weekly_rate], ['mo', p.rental_monthly_rate], ['hr', p.rental_hourly_rate]]
      .filter(([, v]) => Number(v) > 0).map(([u, v]) => `${this.fmt(v)}/${u}`).join(' · ') || 'no rate set';
    const details = [p.sku, p.model_number && `Model ${p.model_number}`, p.size, p.category_name,
      p.rental_classification === 'equipment' ? 'Equipment' : 'Tool', p.is_accessory ? 'Accessory' : null,
      !avail?.branchId && p.assigned_branch_name ? p.assigned_branch_name : null].filter(Boolean).map(esc).join(' · ');
    let badge = '', stockLine = '', bookingLines = '';
    if (a) {
      const color = a.available > 0 ? 'var(--success)' : 'var(--danger)';
      badge = `<span style="flex-shrink:0;font-weight:700;font-size:12px;color:${color};border:1px solid ${color};border-radius:10px;padding:1px 8px">${a.available} available</span>`;
      stockLine = [`${a.on_hand} on hand`, a.out ? `${a.out} on rental` : '', a.held ? `${a.held} held` : '', a.out_of_service ? `${a.out_of_service} out of service` : '']
        .filter(Boolean).join(' · ');
      const due = this._spDueText(a, avail.today);
      if (due) stockLine += ` · <strong>${due}</strong>`;
      bookingLines = a.bookings.slice(0, 4).map(b => {
        const overdue = b.kind === 'out' && b.due && b.due < avail.today;
        const what = b.kind === 'held'
          ? `Held ${b.qty} for ${b.quote_number ? `Special Project ${esc(b.quote_number)}` : `${esc(b.agreement_number)} (awaiting checkout)`}${b.from ? ` · ${this.fmtDate(b.from)}` : ''}${b.due ? ` – ${this.fmtDate(b.due)}` : ''}`
          : `${b.qty} on rental ${esc(b.agreement_number)}${b.status === 'awaiting_issue' ? ' (paid, not yet issued)' : ''} · due back ${b.due ? this.fmtDate(b.due) : '—'}${overdue ? ' <span style="color:var(--danger)">(overdue)</span>' : ''}`;
        return `<div>${what}${!avail.branchId && b.branch_name ? ` · ${esc(b.branch_name)}` : ''}</div>`;
      }).join('') + (a.bookings.length > 4 ? `<div>…and ${a.bookings.length - 4} more</div>` : '');
    }
    return `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text);display:block;font-weight:400;border-bottom:1px solid var(--border)" onclick="App._selectQuoteRentalOption(${idx},${p.id})">
        <div style="display:flex;align-items:center;gap:8px"><strong style="flex:1">${esc(p.name)}</strong>${badge}</div>
        <div style="font-size:11px;color:var(--text-muted)">${details}${details ? ' · ' : ''}${rates}</div>
        ${stockLine ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${stockLine}</div>` : ''}
        ${bookingLines ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;padding-left:8px;border-left:2px solid var(--border)">${bookingLines}</div>` : ''}
      </div>`;
  },

  _selectQuoteRentalOption(idx, productId) {
    const p = (this._spRentalProducts || []).find(x => x.id === productId);
    if (!p) return;
    document.getElementById(`qti-rprod-${idx}`).value = productId;
    document.getElementById(`qti-rprod-search-${idx}`).value = p.name;
    document.getElementById(`qti-rprod-dd-${idx}`).style.display = 'none';
    const price = document.getElementById(`qti-price-${idx}`);
    if (price) price.dataset.auto = '1';
    const cost = document.getElementById(`qti-cost-${idx}`);
    if (cost) cost.value = '';
    this._quoteRentalEstimate(idx);
  },

  // Greys out the rates this line's period doesn't earn (same rule as New
  // Rental — see _refreshRatePlanOptions); returns false if it had to reset
  // the choice back to Automatic.
  _refreshQuoteRentalLinePlan(idx) {
    const sel = document.getElementById(`qti-rplan-${idx}`);
    if (!sel) return true;
    const before = sel.value;
    const st = document.getElementById(`qti-rstart-${idx}`)?.value, en = document.getElementById(`qti-rend-${idx}`)?.value;
    const days = st && en ? Math.max(0, Math.round((new Date(`${en}T00:00:00Z`) - new Date(`${st}T00:00:00Z`)) / 86400000)) : null;
    const p = (this._spRentalProducts || []).find(x => String(x.id) === String(document.getElementById(`qti-rprod-${idx}`)?.value));
    this._refreshRatePlanOptions(`qti-rplan-${idx}`, days, p ? [p.rental_classification || 'tool'] : []);
    if (!sel.value && sel.options[0]) sel.options[0].textContent = 'Rate: Automatic';
    return sel.value === before;
  },

  // Fills the catalog price for the period (unless the user typed their own)
  // and shows the length and how many are free to hold at the branch.
  async _quoteRentalEstimate(idx) {
    const info = document.getElementById(`qti-rinfo-${idx}`);
    const product_id = document.getElementById(`qti-rprod-${idx}`)?.value;
    if (!info || !product_id) return;
    const planKept = this._refreshQuoteRentalLinePlan(idx);
    const rate_plan = document.getElementById(`qti-rplan-${idx}`)?.value || null;
    const quantity = parseInt(document.getElementById(`qti-qty-${idx}`)?.value) || 1;
    const branch_id = document.getElementById('qt-branch')?.value || null;
    let est;
    try {
      est = await this.api('POST', '/quotations/rental-line-estimate', {
        product_id, quantity, branch_id, rate_plan,
        rental_start: document.getElementById(`qti-rstart-${idx}`)?.value,
        rental_end: document.getElementById(`qti-rend-${idx}`)?.value,
      });
    } catch(e) { info.innerHTML = `<span style="color:var(--danger)">${e.message}</span>`; return; }
    const price = document.getElementById(`qti-price-${idx}`);
    if (price && (price.dataset.auto === '1' || price.value === '')) { price.value = est.unit_price; price.dataset.auto = '1'; }
    const cost = document.getElementById(`qti-cost-${idx}`);
    if (cost && cost.value === '' && est.cost != null) cost.value = est.cost;
    let availText = est.available == null ? 'choose a branch to check availability'
      : est.available >= quantity ? `${est.available} available at this branch now`
      : `<span style="color:var(--danger)">only ${est.available} available at this branch now</span>`;
    if (est.available != null && est.available < quantity) {
      // Can still be quoted — say when more come back.
      const avail = await this._spRentalAvailability();
      const due = this._spDueText(avail && avail.byId.get(Number(product_id)), avail?.today);
      if (due) availText += ` · ${due}`;
    }
    info.innerHTML = `${est.days} day${est.days === 1 ? '' : 's'}${rate_plan ? ` · ${this._ratePlanLabel(rate_plan).toLowerCase()}` : ''} · catalog rate ${this.fmt(est.fee)} for ${quantity} · ${availText}${planKept ? '' : ' · <span style="color:var(--warning, #d97706)">rate set back to Automatic — the period is too short for it</span>'}`;
    this.calcQuoteTotal();
    this._updateQuoteItemMargin(idx);
  },

  // Temporary line item: no product_id, just a free-text description and a
  // manual amount. Used to quote something not yet in inventory — the quote
  // stays editable so this row can be swapped for a real product once the
  // item is received into stock. On a Special Project, this is also how
  // non-inventory lines like labour or equipment rental fees get added —
  // those don't carry the "Q" Purchasing badge. A Special Project line
  // added via "+ Q Item" (opts.qItem) does, and is the only kind that goes
  // to Purchasing when the project is accepted (see processQuoteAcceptance
  // in routes/quotations.js).
  addQuoteCustomItem(prefill, opts = {}) {
    this._quoteItems = this._quoteItems || [];
    const idx = this._quoteItems.length;
    this._quoteItems.push({ temp: true });
    const container = document.getElementById('qt-items');
    const isSP = this._quoteType === 'special_project';
    const isQ = !isSP || !!opts.qItem;
    const qBadge = `<span class="badge-pill badge-warning" style="flex-shrink:0" title="Flags this item for Purchasing to order — a Purchase Request is auto-created">Q</span>`;
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.id = `qt-item-${idx}`;
    if (isSP && !isQ) {
      div.style.cssText = 'flex-wrap:wrap;align-items:flex-end';
      div.innerHTML = this._spCustomItemHtml(idx, prefill);
      container.appendChild(div);
      this.calcQuoteTotal();
      this._updateQuoteItemMargin(idx);
      return;
    }
    div.innerHTML = `
      <input id="qti-desc-${idx}" style="flex:2" placeholder="${isSP && !isQ ? 'e.g. Labour, Chainsaw rental, Equipment operator' : 'Item to order — description'}" value="${prefill?this.escapeAttr(prefill.product_name):''}" data-pr-id="${prefill&&prefill.purchase_request_id||''}" data-q-item="${isSP && isQ ? '1' : ''}">
      <input id="qti-qty-${idx}" type="number" min="1" value="${prefill?prefill.quantity:1}" style="width:70px" placeholder="Qty" oninput="App.calcQuoteTotal()">
      ${isSP ? `<input id="qti-cost-${idx}" type="number" step="0.01" value="${prefill&&prefill.unit_cost!=null?prefill.unit_cost:''}" style="width:90px" placeholder="Cost" title="Informational only — doesn't affect the total" oninput="App._updateQuoteItemMargin(${idx})">` : ''}
      <input id="qti-price-${idx}" type="number" step="0.01" value="${prefill?prefill.unit_price:''}" style="width:90px" placeholder="Amount" oninput="App.calcQuoteTotal();App._updateQuoteItemMargin(${idx})">
      <input id="qti-disc-${idx}" type="number" min="0" step="0.01" value="${prefill&&prefill.discount_amount||''}" style="width:80px" placeholder="Discount" title="Discount given on this line — recorded for reference, doesn't change the price above">
      ${isSP ? `<span id="qti-margin-${idx}" style="font-size:11px;color:var(--text-muted);white-space:nowrap"></span>` : ''}${isQ ? qBadge : ''}
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('qt-item-${idx}').remove();App.calcQuoteTotal()">✕</button>`;
    container.appendChild(div);
    this.calcQuoteTotal();
    if (isSP) this._updateQuoteItemMargin(idx);
  },

  // A Special Project custom line's fields, in the order the quotation prints
  // them, plus Cost. Extended = quantity × rent period × unit price; the
  // discount (% or $) comes off it. Server: specialProjectCustomFields.
  _spCustomItemHtml(idx, p) {
    const field = (label, html, style = '') => `<label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--text-muted);margin:0;${style}">${label}${html}</label>`;
    const val = v => v == null ? '' : this.escapeAttr(String(v));
    const isPct = p?.discount_percent != null;
    const discVal = isPct ? p.discount_percent : (p?.discount_amount || '');
    const units = ['Hour(s)', 'Day(s)', 'Week(s)', 'Month(s)'];
    const unit = p?.rent_period_unit || 'Day(s)';
    return `
      ${field('Item No.', `<input id="qti-itemno-${idx}" value="${val(p?.sku)}" maxlength="60" style="width:110px">`)}
      ${field('Item Description', `<input id="qti-desc-${idx}" placeholder="e.g. Labour, Chainsaw rental, Equipment operator" value="${val(p?.product_name)}" data-pr-id="${p?.purchase_request_id || ''}" data-q-item="">`, 'flex:1 1 260px')}
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('qt-item-${idx}').remove();App.calcQuoteTotal()">✕</button>
      <div style="flex-basis:100%;height:0"></div>
      ${field('Quantity', `<input id="qti-qty-${idx}" type="number" min="0" step="any" value="${p ? p.quantity : 1}" style="width:80px" oninput="App.calcQuoteTotal()">`)}
      ${field('U.O.M', `<input id="qti-uom-${idx}" value="${val(p?.sell_unit)}" maxlength="30" style="width:60px">`)}
      ${field('Rent Period', `<span style="display:flex;gap:4px"><input id="qti-period-${idx}" type="number" min="0" step="any" value="${val(p?.rent_period)}" style="width:70px" title="Leave blank for a line that isn't charged by time" oninput="App.calcQuoteTotal()"><select id="qti-period-unit-${idx}" style="width:auto">${units.map(u => `<option${u === unit ? ' selected' : ''}>${u}</option>`).join('')}</select></span>`)}
      ${field('Cost', `<input id="qti-cost-${idx}" type="number" step="0.01" value="${val(p?.unit_cost)}" style="width:85px" title="Informational only, per unit and period — doesn't affect the total" oninput="App._updateQuoteItemMargin(${idx})">`)}
      ${field('Unit Price', `<input id="qti-price-${idx}" type="number" step="0.01" value="${p ? p.unit_price : ''}" style="width:90px" oninput="App.calcQuoteTotal();App._updateQuoteItemMargin(${idx})">`)}
      ${field('Discount', `<span style="display:flex;gap:4px"><input id="qti-disc-${idx}" type="number" min="0" step="0.01" value="${discVal}" style="width:80px" title="Taken off this line's extended price" oninput="App.calcQuoteTotal()"><select id="qti-disc-type-${idx}" style="width:auto" onchange="App.calcQuoteTotal()"><option value="amount"${isPct ? '' : ' selected'}>$</option><option value="percent"${isPct ? ' selected' : ''}>%</option></select></span>`)}
      ${field('Extended Price', `<strong id="qti-ext-${idx}" style="font-size:13px;color:var(--text);white-space:nowrap;padding:6px 0"></strong>`)}
      <span id="qti-margin-${idx}" style="font-size:11px;color:var(--text-muted);white-space:nowrap;padding-bottom:8px"></span>`;
  },

  // Delivery line: description + price before tax (taxed at the store rate,
  // routes/quotations.js processQuoteItems). Not a Q item — nothing goes to
  // Purchasing. Quantity is always 1; the hidden qti-qty keeps calcQuoteTotal
  // counting it like any other line.
  addQuoteDeliveryItem(prefill) {
    this._quoteItems = this._quoteItems || [];
    const idx = this._quoteItems.length;
    this._quoteItems.push({ delivery: true });
    const rate = parseFloat(this.settings?.tax_rate) || 0;
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.id = `qt-item-${idx}`;
    div.dataset.delivery = '1';
    div.innerHTML = `
      <span class="badge-pill badge-teal" style="flex-shrink:0" title="Delivery charge — taxed at the store rate">Delivery</span>
      <input id="qti-desc-${idx}" style="flex:2" placeholder="Description, e.g. Delivery to Montego Bay" value="${this.escapeAttr(prefill ? prefill.product_name : 'Delivery')}">
      <input id="qti-qty-${idx}" type="hidden" value="1">
      <input id="qti-price-${idx}" type="number" min="0" step="0.01" value="${prefill ? prefill.unit_price : ''}" style="width:110px" placeholder="Price (pre-tax)" title="Price before tax — tax is added on top" oninput="App.calcQuoteTotal()">
      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">+ tax ${rate}%</span>
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('qt-item-${idx}').remove();App.calcQuoteTotal()">✕</button>`;
    document.getElementById('qt-items').appendChild(div);
    if (!prefill) document.getElementById(`qti-price-${idx}`).focus();
    this.calcQuoteTotal();
  },

  // "C" (comment) line: free text printed on the quote, carried onto the sale
  // and its receipt/invoice. No quantity, price or tax, and unlike a Q item
  // it never goes to Purchasing.
  addQuoteCommentItem(prefill) {
    this._quoteItems = this._quoteItems || [];
    const idx = this._quoteItems.length;
    this._quoteItems.push({ comment: true });
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.id = `qt-item-${idx}`;
    div.dataset.comment = '1';
    div.innerHTML = `
      <span class="badge-pill badge-info" style="flex-shrink:0" title="Comment line — printed on the quote and invoice, no price">C</span>
      <textarea id="qti-comment-${idx}" rows="2" style="flex:1" placeholder="Comment to print on the quote and invoice, e.g. Price includes installation; colour to be confirmed">${prefill ? this.escapeAttr(prefill.product_name) : ''}</textarea>
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('qt-item-${idx}').remove()">✕</button>`;
    document.getElementById('qt-items').appendChild(div);
  },

  // Valid Until's 30/60/90-day dropdown. Counted from the quote's own date
  // (data-base — today for a new quote), so re-picking "60 days" on an
  // older quote doesn't quietly push it further out than intended. The date
  // picker stays fully editable; any other date shows as "Custom date".
  _quoteExpiryBase() {
    const base = document.getElementById('qt-valid-preset')?.dataset.base;
    return base || new Date().toISOString().slice(0, 10);
  },

  _applyQuoteExpiryPreset() {
    const days = parseInt(document.getElementById('qt-valid-preset')?.value);
    const input = document.getElementById('qt-valid');
    if (!days || !input) return;
    const d = new Date(`${this._quoteExpiryBase()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    input.value = d.toISOString().slice(0, 10);
  },

  _syncQuoteExpiryPreset() {
    const sel = document.getElementById('qt-valid-preset');
    const value = document.getElementById('qt-valid')?.value;
    if (!sel) return;
    const days = value ? Math.round((new Date(`${value}T00:00:00Z`) - new Date(`${this._quoteExpiryBase()}T00:00:00Z`)) / 86400000) : null;
    sel.value = [30, 60, 90].includes(days) ? String(days) : '';
  },

  // Special Projects only — live cost-vs-price markup readout on a line,
  // purely informational (never sent anywhere but unit_cost itself).
  _updateQuoteItemMargin(idx) {
    const el = document.getElementById(`qti-margin-${idx}`);
    if (!el) return;
    const cost = parseFloat(document.getElementById(`qti-cost-${idx}`)?.value);
    const price = parseFloat(document.getElementById(`qti-price-${idx}`)?.value);
    if (!isFinite(cost) || !isFinite(price) || price <= 0) { el.textContent = ''; return; }
    const marginPct = ((price - cost) / price * 100);
    el.textContent = `${marginPct >= 0 ? '+' : ''}${marginPct.toFixed(0)}% margin`;
    el.style.color = marginPct < 0 ? 'var(--danger)' : 'var(--text-muted)';
  },

  // ─── Rental quote item picker ────────────────────────────────────────────
  // Namespaced copies of showRentalCheckoutModal's addRentalCheckoutLine /
  // _onRentalLineProductChange / _updateRentalLineAvail /
  // _refreshRentalCheckoutBranch (kept separate rather than shared, so
  // changes here can't affect the working rental-checkout flow). Reuses the
  // same GET /products?is_rental=1 and GET /products/:id/accessories
  // endpoints. `prefill.accessory_ids` (when editing an existing rental
  // quote) pre-checks those boxes once accessories load.

  addRentalQuoteLine(prefill) {
    const container = document.getElementById('qt-rental-items');
    if (!container) return;
    const idx = this._rentalQuoteLineIdx = (this._rentalQuoteLineIdx || 0);
    this._rentalQuoteLineIdx++;
    const products = this._rentalQuoteProducts || [];
    const prefillProduct = prefill && prefill.product_id ? products.find(p => String(p.id) === String(prefill.product_id)) : null;
    const prefillAvail = prefillProduct ? (prefillProduct.stock_qty - (prefillProduct.rental_outstanding_qty||0)) : null;
    const prefillLabel = prefillProduct ? `${prefillProduct.name} (${prefillAvail} available)` : '';
    const wrap = document.createElement('div');
    wrap.id = `rq-line-${idx}`;
    wrap.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:8px';
    if (prefill && prefill.accessory_ids) wrap.dataset.preselect = JSON.stringify(prefill.accessory_ids);
    wrap.innerHTML = `
      <div style="display:flex;gap:6px;align-items:flex-start">
        <span class="rql-prod-search-wrap" style="flex:2;position:relative">
          <input type="text" id="rql-prod-search-${idx}" placeholder="Search rental items…" autocomplete="off" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px"
            value="${this.escapeAttr(prefillLabel)}"
            oninput="App._filterRentalQuoteLineOptions(${idx},this.value)" onfocus="App._filterRentalQuoteLineOptions(${idx},this.value)">
          <input type="hidden" id="rql-prod-${idx}" value="${prefill&&prefill.product_id||''}" data-avail="${prefillAvail!=null?prefillAvail:''}">
          <div id="rql-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
        </span>
        <input type="number" id="rql-qty-${idx}" value="${prefill?prefill.quantity:1}" min="1" style="width:70px;padding:6px;border:1px solid var(--border);border-radius:4px" onchange="App._updateRentalQuoteLineAvail(${idx})">
        <input type="text" id="rql-cond-${idx}" placeholder="Condition out (optional)" value="${prefill?this.escapeAttr(prefill.condition_out):''}" style="flex:2;padding:6px;border:1px solid var(--border);border-radius:4px;font-size:13px">
        <span id="rql-warn-${idx}" style="font-size:11px;color:var(--danger);align-self:center"></span>
        <button class="btn btn-sm btn-danger" onclick="document.getElementById('rq-line-${idx}').remove()">✕</button>
      </div>
      <div id="rql-accessories-${idx}"></div>`;
    container.appendChild(wrap);
    if (prefill && prefill.product_id) this._onRentalQuoteLineProductChange(idx);
  },

  // Searchable replacement for what used to be a plain <select> of every
  // rental item — same pattern as the retail Quote item picker
  // (_filterQuoteItemOptions/_selectQuoteItemOption) and the Work Order
  // parts picker. saveQuote/_refreshRentalQuoteBranch all read
  // rql-prod-${idx}'s value directly (a hidden input here, same id/semantics
  // as the old select), so neither needed to change.
  _filterRentalQuoteLineOptions(idx, query) {
    const dd = document.getElementById(`rql-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._rentalQuoteProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => {
      const avail = p.stock_qty - (p.rental_outstanding_qty||0);
      return `<div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectRentalQuoteLineOption(${idx},${p.id})">
        <strong>${p.name}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${avail} available${p.sku ? ' · ' + p.sku : ''}</div>
      </div>`;
    }).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No rental items found</div>`;
    dd.style.display = '';
  },

  _selectRentalQuoteLineOption(idx, productId) {
    const p = (this._rentalQuoteProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`rql-prod-${idx}`);
    const searchEl = document.getElementById(`rql-prod-search-${idx}`);
    const dd = document.getElementById(`rql-prod-dd-${idx}`);
    const avail = p.stock_qty - (p.rental_outstanding_qty||0);
    if (hidden) { hidden.value = productId; hidden.dataset.avail = avail; }
    if (searchEl) searchEl.value = `${p.name} (${avail} available)`;
    if (dd) dd.style.display = 'none';
    this._onRentalQuoteLineProductChange(idx);
  },

  _updateRentalQuoteLineAvail(idx) {
    const hidden = document.getElementById(`rql-prod-${idx}`);
    const qtyEl = document.getElementById(`rql-qty-${idx}`);
    const warnEl = document.getElementById(`rql-warn-${idx}`);
    if (!hidden || !qtyEl || !warnEl) return;
    const avail = parseInt(hidden.dataset.avail) || 0;
    const qty = parseInt(qtyEl.value) || 0;
    warnEl.textContent = qty > avail ? `Only ${avail} available` : '';
  },

  async _onRentalQuoteLineProductChange(idx) {
    this._updateRentalQuoteLineAvail(idx);
    const hidden = document.getElementById(`rql-prod-${idx}`);
    const accEl = document.getElementById(`rql-accessories-${idx}`);
    const wrap = document.getElementById(`rq-line-${idx}`);
    if (!hidden || !accEl) return;
    const productId = hidden.value;
    if (!productId) { accEl.innerHTML = ''; return; }
    const accessories = await this.api('GET', `/products/${productId}/accessories`);
    if (!document.getElementById(`rql-accessories-${idx}`)) return;
    const preselect = wrap && wrap.dataset.preselect ? JSON.parse(wrap.dataset.preselect).map(String) : null;
    if (!accessories.length) { accEl.innerHTML = ''; return; }
    accEl.innerHTML = `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);font-size:12px">
      ${accessories.map(a => a.is_mandatory
        ? `<div style="color:var(--text-muted)">✓ Includes ${a.name} <span style="font-size:11px">(mandatory, no charge)</span></div>`
        : `<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" class="rql-acc-${idx}" value="${a.accessory_product_id}" ${preselect&&preselect.includes(String(a.accessory_product_id))?'checked':''} style="width:auto"> ${a.name} <span style="color:var(--text-muted)">(+${this.fmt(a.rental_rate)}/day)</span></label>`
      ).join('')}
    </div>`;
    if (wrap) delete wrap.dataset.preselect;
  },

  // Re-fetches rental items scoped to the quote's branch and refreshes every
  // existing line's availability numbers in place.
  async _refreshRentalQuoteBranch() {
    const branchId = document.getElementById('qt-branch')?.value;
    this._rentalQuoteProducts = branchId ? await this.api('GET', `/products?is_rental=1&active=1&branch_id=${branchId}`) : [];
    if (!document.getElementById('qt-branch')) return;
    document.querySelectorAll('#qt-rental-items [id^="rq-line-"]').forEach(line => {
      const idx = line.id.replace('rq-line-','');
      const hidden = document.getElementById(`rql-prod-${idx}`);
      const searchEl = document.getElementById(`rql-prod-search-${idx}`);
      if (!hidden) return;
      const currentVal = hidden.value;
      const match = currentVal ? this._rentalQuoteProducts.find(p => String(p.id) === String(currentVal)) : null;
      if (match) {
        const avail = match.stock_qty - (match.rental_outstanding_qty||0);
        hidden.dataset.avail = avail;
        if (searchEl) searchEl.value = `${match.name} (${avail} available)`;
      } else if (currentVal) {
        // Selected item isn't available at the new branch — clear it rather
        // than silently keeping a stale selection the new branch can't serve.
        hidden.value = '';
        hidden.dataset.avail = '';
        if (searchEl) searchEl.value = '';
      }
      this._updateRentalQuoteLineAvail(idx);
      if (hidden.value) this._onRentalQuoteLineProductChange(idx);
    });
  },

  // Cached per-branch stock+price lookup — reuses the same branch-scoped
  // /products?branch_id= call the Transfers UI's onTransferFromChange makes
  // (which now also returns the branch's tiered price), so no new endpoint
  // is needed. Returns {productId: {stock_qty, price}}.
  async getBranchStock(branchId) {
    if (!branchId) return {};
    this._quoteStockCache = this._quoteStockCache || {};
    if (!this._quoteStockCache[branchId]) {
      const all = await this.api('GET', `/products?branch_id=${branchId}`);
      const map = {};
      // A rental item's stock_qty is the total number owned, not what's free
      // to sell/quote right now — subtract units out on an active rental
      // from this branch, same as the POS grid does. No-op for non-rental
      // products.
      all.forEach(p => { map[p.id] = { stock_qty: p.is_rental ? Math.max(0, (p.stock_qty||0) - (p.rental_outstanding_qty||0)) : p.stock_qty, price: p.price, units: p.units }; });
      this._quoteStockCache[branchId] = map;
    }
    return this._quoteStockCache[branchId];
  },

  // Quote's branch changed — cached stock/price no longer applies: re-check
  // stock and re-fill price for every row that already has a product picked.
  async onQuoteBranchChange() {
    this._quoteStockCache = {};
    const branchId = document.getElementById('qt-branch')?.value;
    const branchMap = branchId ? await this.getBranchStock(branchId) : {};
    const rows = document.querySelectorAll('#qt-items > [id^="qt-item-"]');
    for (const row of rows) {
      const idx = row.id.split('-').pop();
      const prodSel = document.getElementById(`qti-prod-${idx}`);
      if (!prodSel) continue;
      const productId = parseInt(prodSel.value);
      const branchPrice = productId && branchMap[productId]?.price;
      if (branchPrice != null) { document.getElementById(`qti-price-${idx}`).value = branchPrice; this.calcQuoteTotal(); }
      await this.checkQuoteItemStock(idx);
    }
  },

  // Compares the requested qty against the quote branch's available stock for
  // this row's product. If short, renders an allocator panel listing every
  // other branch's available qty so the shortfall can be split across them,
  // with any unallocated remainder auto-labeled for Purchasing.
  // Unit-of-measure chooser on a retail / Special Project quote line
  // (lib/units.js). Shown only for an item with alternate units; picking a
  // product asks which unit (_selectQuoteItemOption), and this dropdown
  // changes it afterwards. A line is priced in its unit and its stock is
  // checked in that unit.
  _quoteUnitSelectHtml(idx, prefill) {
    const p = prefill?.product_id ? (this._quoteProducts || []).find(x => String(x.id) === String(prefill.product_id)) : null;
    const choices = p ? this._unitChoices(p) : [];
    const legacyCase = prefill?.uom_id == null && prefill?.sell_unit === 'case' ? choices.find(c => c.name.toLowerCase() === 'case') : null;
    const selected = legacyCase ? legacyCase.uom_id : prefill?.uom_id;
    return `<select id="qti-unit-${idx}" style="width:120px;${choices.length > 1 ? '' : 'display:none'}" onchange="App._onQuoteUnitChange(${idx})" title="Unit of measure">
      ${choices.map(c => `<option value="${c.isBase ? '' : c.uom_id}" ${!c.isBase && String(c.uom_id) === String(selected) ? 'selected' : ''}>${this.escapeAttr(c.label || c.name)}</option>`).join('')}
    </select>`;
  },

  _refreshQuoteUnitSelect(idx, p, basePrice, choice = null) {
    const sel = document.getElementById(`qti-unit-${idx}`);
    if (!sel) return;
    sel.dataset.singlePrice = basePrice;
    const choices = this._unitChoices(p);
    sel.innerHTML = choices.map(c => `<option value="${c.isBase ? '' : c.uom_id}">${this.escapeAttr(c.label || c.name)}</option>`).join('');
    sel.style.display = choices.length > 1 ? '' : 'none';
    sel.value = choice && !choice.isBase ? String(choice.uom_id) : '';
  },

  _quoteLineProduct(idx) {
    return (this._quoteProducts || []).find(x => String(x.id) === document.getElementById(`qti-prod-${idx}`)?.value) || null;
  },

  // The line's unit choice (stock unit when none is picked).
  _quoteLineUnit(idx) {
    const p = this._quoteLineProduct(idx);
    if (!p) return null;
    const val = document.getElementById(`qti-unit-${idx}`)?.value;
    return this._unitChoiceFor(p, val ? Number(val) : (p.base_unit_id || null));
  },

  // Unit changed: price becomes that unit's price (the branch-tiered one
  // when a branch is set), cost the unit's size × the stock unit's cost.
  async _onQuoteUnitChange(idx) {
    const sel = document.getElementById(`qti-unit-${idx}`);
    const p = this._quoteLineProduct(idx);
    const priceInp = document.getElementById(`qti-price-${idx}`);
    if (!sel || !p || !priceInp) return;
    const choice = this._quoteLineUnit(idx);
    let price = sel.dataset.singlePrice ?? p.price;
    if (choice && !choice.isBase) {
      const branchId = document.getElementById('qt-branch')?.value;
      const branchUnits = branchId ? (await this.getBranchStock(branchId))[p.id]?.units : null;
      price = branchUnits?.find(u => u.unit_id === choice.uom_id)?.price ?? choice.price;
    }
    priceInp.value = price;
    const costInp = document.getElementById(`qti-cost-${idx}`);
    if (costInp) costInp.value = ((p.cost || 0) * (choice?.factor || 1)).toFixed(2);
    const qtyInp = document.getElementById(`qti-qty-${idx}`);
    if (qtyInp && !choice?.allow_decimal && !Number.isInteger(Number(qtyInp.value))) qtyInp.value = Math.max(1, Math.round(Number(qtyInp.value) || 1));
    this.calcQuoteTotal();
    this.checkQuoteItemStock(idx);
    if (this._quoteType === 'special_project') this._updateQuoteItemMargin(idx);
  },

  // Stock units in one of the line's unit (1 for the stock unit).
  _quoteUnitsPer(idx) {
    return this._quoteLineUnit(idx)?.factor || 1;
  },

  // Stock available for a quote line, in the line's unit (whole units unless
  // it's a measured unit like yards).
  _quoteAvail(idx, stockEntry) {
    const n = (stockEntry?.stock_qty || 0) / this._quoteUnitsPer(idx);
    return this._quoteLineUnit(idx)?.allow_decimal ? Math.round(n * 1000) / 1000 : Math.floor(n);
  },

  async checkQuoteItemStock(idx) {
    const prodSel = document.getElementById(`qti-prod-${idx}`);
    const allocDiv = document.getElementById(`qt-alloc-${idx}`);
    if (!prodSel || !allocDiv) return; // custom item row — no stock concept
    // SN line — a stockless serial-number placeholder, never a shortfall.
    if (this._isSerialNumberProduct((this._quoteProducts || []).find(p => String(p.id) === prodSel.value))) { allocDiv.innerHTML = ''; return; }
    const branchId = document.getElementById('qt-branch')?.value;
    const productId = parseInt(prodSel.value);
    const qty = parseInt(document.getElementById(`qti-qty-${idx}`)?.value) || 0;

    // Rapid edits (pick a product, then immediately change qty) fire
    // overlapping calls here; each does async network lookups, so they can
    // resolve out of order. Stamp this call and bail before touching the DOM
    // if a newer call has since started — otherwise a stale response can
    // clobber a fresher one.
    const myToken = (allocDiv.dataset.reqToken = String((parseInt(allocDiv.dataset.reqToken) || 0) + 1));
    const stillCurrent = () => allocDiv.dataset.reqToken === myToken;

    if (!branchId || !productId || !qty) { allocDiv.innerHTML = ''; return; }

    const stockMap = await this.getBranchStock(branchId);
    if (!stillCurrent()) return;
    const available = this._quoteAvail(idx, stockMap[productId]);
    if (qty <= available) { allocDiv.innerHTML = ''; delete allocDiv.dataset.productId; delete allocDiv.dataset.branchId; return; }

    const shortfall = qty - available;

    // Already showing the allocator for this exact product/branch — the
    // per-branch availability numbers don't change, only qty did, so just
    // update the shortfall figures and keep the user's existing branch splits.
    if (allocDiv.dataset.productId === String(productId) && allocDiv.dataset.branchId === String(branchId)) {
      const shortfallEl = document.getElementById(`qt-alloc-${idx}-shortfall`);
      if (shortfallEl) shortfallEl.textContent = shortfall;
      this.recalcQuoteAllocation(idx);
      return;
    }

    const otherBranches = (this._quoteBranches || []).filter(b => String(b.id) !== String(branchId));
    await Promise.all(otherBranches.map(b => this.getBranchStock(b.id)));
    if (!stillCurrent()) return;
    const rowsHtml = otherBranches.map(b => {
      const avail = this._quoteAvail(idx, (this._quoteStockCache[b.id] || {})[productId]);
      return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-top:4px">
        <span style="flex:1">${b.name} <span style="color:var(--text-muted)">(avail: ${avail})</span></span>
        <input type="number" min="0" max="${avail}" value="0" style="width:70px" id="qt-alloc-${idx}-b${b.id}" data-branch="${b.id}" data-max="${avail}" oninput="App.recalcQuoteAllocation(${idx})">
      </div>`;
    }).join('');
    allocDiv.dataset.productId = productId;
    allocDiv.dataset.branchId = branchId;
    allocDiv.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--warning,#f59e0b);border-radius:6px;padding:8px 10px;margin:2px 0 8px">
        <div style="font-size:12px;color:var(--warning,#f59e0b);font-weight:600;margin-bottom:4px">⚠ Only ${available} available at this branch — source the remaining <span id="qt-alloc-${idx}-shortfall">${shortfall}</span> from elsewhere:</div>
        ${rowsHtml}
        <div style="font-size:12px;margin-top:6px;font-weight:600">To purchase (no stock available): <span id="qt-alloc-${idx}-remainder">${shortfall}</span></div>
      </div>`;
  },

  recalcQuoteAllocation(idx) {
    const branchId = document.getElementById('qt-branch')?.value;
    const prodSel = document.getElementById(`qti-prod-${idx}`);
    const productId = parseInt(prodSel?.value);
    const qty = parseInt(document.getElementById(`qti-qty-${idx}`)?.value) || 0;
    const stockMap = (this._quoteStockCache || {})[branchId] || {};
    const available = this._quoteAvail(idx, stockMap[productId]);
    const shortfall = Math.max(0, qty - available);
    let allocated = 0;
    document.querySelectorAll(`[id^="qt-alloc-${idx}-b"]`).forEach(inp => {
      let v = parseInt(inp.value) || 0;
      const max = parseInt(inp.dataset.max) || 0;
      if (v > max) v = max;
      if (v < 0) v = 0;
      inp.value = v;
      allocated += v;
    });
    const remEl = document.getElementById(`qt-alloc-${idx}-remainder`);
    if (remEl) remEl.textContent = Math.max(0, shortfall - allocated);
  },

  calcQuoteTotal() {
    const el = document.getElementById('qt-total');
    if (this._quoteType === 'rental') {
      // Rental fees (and the deposit that mirrors them) are computed
      // server-side (nonlinear month/week/day/hour billing) — only the
      // flat service fees can be shown live here.
      const fee = (box, input) => document.getElementById(box)?.checked ? (parseFloat(document.getElementById(input)?.value) || 0) : 0;
      const services = fee('qt-delivery', 'qt-delivery-cost') + fee('qt-pickup', 'qt-pickup-cost') + fee('qt-operator', 'qt-operator-fee');
      if (el) el.textContent = services > 0 ? `${this.fmt(services)} services + rental fees, tax & deposit (calculated on save)` : 'Estimated at save';
      return;
    }
    let subtotal = 0;
    document.querySelectorAll('[id^="qti-qty-"]').forEach(qEl => {
      const idx = qEl.id.split('-').pop();
      const qty = parseFloat(qEl.value) || 0;
      const price = parseFloat(document.getElementById(`qti-price-${idx}`)?.value) || 0;
      const extEl = document.getElementById(`qti-ext-${idx}`);
      if (!extEl) { subtotal += qty * price; return; }
      // Special Project custom line: rent period and an applied discount.
      const extended = qty * price * (parseFloat(document.getElementById(`qti-period-${idx}`)?.value) || 1);
      const discEntered = parseFloat(document.getElementById(`qti-disc-${idx}`)?.value) || 0;
      const lineDisc = parseFloat((document.getElementById(`qti-disc-type-${idx}`)?.value === 'percent' ? parseFloat(extended.toFixed(2)) * discEntered / 100 : discEntered).toFixed(2));
      subtotal += extended - lineDisc;
      extEl.innerHTML = `${this.fmt(extended)}${lineDisc > 0 ? ` <span style="font-weight:400;color:var(--text-muted)">net ${this.fmt(extended - lineDisc)}</span>` : ''}`;
    });
    const disc = parseFloat(document.getElementById('qt-disc')?.value) || 0;
    if (el) el.textContent = this.fmt(Math.max(0, subtotal - disc));
  },

  // Rental quote Rate picker: tiers the quoted length earns for the items on it.
  _refreshQuoteRatePlan() {
    const dueDateStr = document.getElementById('qt-duedate')?.value;
    const start = new Date();
    const days = dueDateStr ? Math.floor(Math.max(0, new Date(`${dueDateStr}T${start.toISOString().slice(11,19)}.000Z`) - start) / 3600000) / 24 : null;
    const classes = [];
    document.querySelectorAll('#qt-rental-items [id^="rq-line-"]').forEach(line => {
      const idx = line.id.replace('rq-line-','');
      const p = (this._rentalQuoteProducts || []).find(x => String(x.id) === String(document.getElementById(`rql-prod-${idx}`)?.value));
      if (p) classes.push(p.rental_classification || 'tool');
    });
    this._refreshRatePlanOptions('qt-rateplan', days, classes);
  },

  async saveQuote() {
    const customer_id = document.getElementById('qt-cust').value;
    const branch_id = document.getElementById('qt-branch').value;
    const discount_amount = parseFloat(document.getElementById('qt-disc').value) || 0;
    const notes = document.getElementById('qt-notes').value;

    if (this._quoteType === 'rental') {
      const due_date = document.getElementById('qt-duedate')?.value;
      if (!branch_id) { this.alert('Please select a branch/location', 'error'); return; }
      if (!due_date) { this.alert('Please select a due date', 'error'); return; }
      const items = [];
      document.querySelectorAll('#qt-rental-items [id^="rq-line-"]').forEach(line => {
        const idx = line.id.replace('rq-line-','');
        const product_id = document.getElementById(`rql-prod-${idx}`)?.value;
        const quantity = parseInt(document.getElementById(`rql-qty-${idx}`)?.value) || 0;
        const condition_out = document.getElementById(`rql-cond-${idx}`)?.value.trim() || null;
        const accessory_ids = Array.from(document.querySelectorAll(`.rql-acc-${idx}:checked`)).map(cb => cb.value);
        if (product_id && quantity > 0) items.push({ product_id, quantity, condition_out, accessory_ids });
      });
      if (!items.length) { this.alert('Add at least one rental item', 'error'); return; }
      const deliveryRequired = document.getElementById('qt-delivery').checked;
      const pickupRequired = document.getElementById('qt-pickup').checked;
      const operatorRequired = document.getElementById('qt-operator').checked;
      if (deliveryRequired && !document.getElementById('qt-delivery-address')?.value.trim()) {
        this.alert("Enter the delivery address — ask the customer where it's going, even if it's their own address", 'error');
        document.getElementById('qt-delivery-address')?.focus();
        return;
      }
      if (pickupRequired && !document.getElementById('qt-pickup-address')?.value.trim()) {
        this.alert("Enter the pickup address — ask the customer where it's being collected from, even if it's their own address", 'error');
        document.getElementById('qt-pickup-address')?.focus();
        return;
      }
      try {
        const payload = {
          customer_id: customer_id||null, branch_id: branch_id||null, quote_type: 'rental', due_date, discount_amount, notes, items,
          rate_plan: document.getElementById('qt-rateplan')?.value || null,
          delivery_required: deliveryRequired ? 1 : 0,
          delivery_cost: deliveryRequired ? parseFloat(document.getElementById('qt-delivery-cost').value) || 0 : 0,
          delivery_address: deliveryRequired ? (document.getElementById('qt-delivery-address')?.value.trim() || null) : null,
          pickup_required: pickupRequired ? 1 : 0,
          pickup_cost: pickupRequired ? parseFloat(document.getElementById('qt-pickup-cost').value) || 0 : 0,
          pickup_address: pickupRequired ? document.getElementById('qt-pickup-address').value.trim() : null,
          operator_required: operatorRequired ? 1 : 0,
          operator_fee: operatorRequired ? parseFloat(document.getElementById('qt-operator-fee').value) || 0 : 0,
        };
        // Only on create — whoever creates the quote is the assignee. Never
        // sent on edit, so editing someone else's quote (e.g. a manager
        // fixing a line item) doesn't silently reassign it; that's what the
        // dedicated Reassign action (PATCH /:id/reassign) is for.
        if (!this._editingQuoteId) payload.employee_id = this.currentUser.id;
        if (this._editingQuoteId) {
          await this.api('PUT', `/quotations/${this._editingQuoteId}`, payload);
          this.alert('Rental quotation updated');
        } else {
          await this.api('POST', '/quotations', payload);
          this.alert('Rental quotation created');
        }
        this.closeModal();
        this.renderQuotations();
      } catch(e) { this.alert(e.message, 'error'); }
      return;
    }

    const valid_until = document.getElementById('qt-valid').value;
    const items = [];
    let snClash = null, deliveryErr = null;
    document.querySelectorAll('#qt-items > [id^="qt-item-"]').forEach(row => {
      const idx = row.id.split('-').pop();
      if (row.dataset.comment === '1') {
        const text = document.getElementById(`qti-comment-${idx}`)?.value.trim();
        if (text) items.push({ is_comment: 1, description: text });
        return;
      }
      if (row.dataset.delivery === '1') {
        const priceVal = document.getElementById(`qti-price-${idx}`)?.value;
        if (priceVal === '' && !deliveryErr) deliveryErr = 'Enter a price (before tax) for the delivery line';
        items.push({ is_delivery: 1, description: document.getElementById(`qti-desc-${idx}`)?.value.trim() || 'Delivery', unit_price: parseFloat(priceVal) || 0, quantity: 1 });
        return;
      }
      if (row.dataset.rental === '1') {
        const product_id = document.getElementById(`qti-rprod-${idx}`)?.value;
        if (!product_id) return;
        const priceVal = document.getElementById(`qti-price-${idx}`).value;
        const costVal = document.getElementById(`qti-cost-${idx}`)?.value;
        items.push({
          is_rental_line: 1, product_id,
          quantity: parseInt(document.getElementById(`qti-qty-${idx}`).value) || 1,
          rental_start: document.getElementById(`qti-rstart-${idx}`).value,
          rental_end: document.getElementById(`qti-rend-${idx}`).value,
          rate_plan: document.getElementById(`qti-rplan-${idx}`)?.value || null,
          unit_price: priceVal === '' ? null : parseFloat(priceVal),
          unit_cost: costVal === '' || costVal == null ? undefined : parseFloat(costVal),
          discount: parseFloat(document.getElementById(`qti-disc-${idx}`)?.value) || 0,
        });
        return;
      }
      // Part quantities for a measured unit (yards, kg — lib/units.js).
      const quantity = Math.round((Number(document.getElementById(`qti-qty-${idx}`).value) || 1) * 1000) / 1000;
      const unit_price = parseFloat(document.getElementById(`qti-price-${idx}`).value) || 0;
      const discount = parseFloat(document.getElementById(`qti-disc-${idx}`)?.value) || 0;
      const costInp = document.getElementById(`qti-cost-${idx}`);
      const unit_cost = costInp && costInp.value !== '' ? parseFloat(costInp.value) : undefined;
      const prodSel = document.getElementById(`qti-prod-${idx}`);
      if (prodSel) {
        if (!prodSel.value) return;
        const item = { product_id: prodSel.value, quantity, unit_price, unit_cost, discount };
        const uomVal = document.getElementById(`qti-unit-${idx}`)?.value;
        if (uomVal) item.uom_id = Number(uomVal);
        const snInp = document.getElementById(`qti-sn-${idx}`);
        if (snInp && snInp.style.display !== 'none') {
          item.serial_number = snInp.value.trim();
          // Optional — an SN line left blank is simply left off the quote.
          if (!item.serial_number) return;
          const clash = this._serialItemClash(item.serial_number);
          if (clash && !snClash) snClash = `"${item.serial_number}" is the item number for ${clash.name}, not a serial number — enter the serial printed on the product`;
        }
        const allocInputs = document.querySelectorAll(`[id^="qt-alloc-${idx}-b"]`);
        if (allocInputs.length && branch_id) {
          // Rebuild the split deterministically so it always sums exactly to
          // `quantity`, regardless of what's currently shown on screen: home
          // branch first (up to its available stock), then each other
          // branch's input (capped at what's actually left to cover), then
          // whatever's still unassigned goes to Purchasing (branch_id: null).
          const stockMap = (this._quoteStockCache || {})[branch_id] || {};
          const available = this._quoteAvail(idx, stockMap[prodSel.value]);
          const homeQty = Math.min(quantity, available);
          let remaining = quantity - homeQty;
          const sources = [];
          if (homeQty > 0) sources.push({ branch_id: parseInt(branch_id), quantity: homeQty });
          allocInputs.forEach(inp => {
            if (remaining <= 0) return;
            const v = Math.min(Number(inp.value) || 0, remaining);
            if (v > 0) { sources.push({ branch_id: parseInt(inp.dataset.branch), quantity: v }); remaining = Math.round((remaining - v) * 1000) / 1000; }
          });
          if (remaining > 0) sources.push({ branch_id: null, quantity: remaining });
          item.sources = sources;
        }
        items.push(item);
        return;
      }
      const descInp = document.getElementById(`qti-desc-${idx}`);
      const description = descInp?.value.trim();
      if (!description) return;
      const purchase_request_id = descInp.dataset.prId || null;
      const is_q_item = descInp.dataset.qItem === '1';
      const spFields = document.getElementById(`qti-ext-${idx}`) ? {
        item_no: document.getElementById(`qti-itemno-${idx}`).value,
        uom: document.getElementById(`qti-uom-${idx}`).value,
        rent_period: document.getElementById(`qti-period-${idx}`).value,
        rent_period_unit: document.getElementById(`qti-period-unit-${idx}`).value,
        discount_type: document.getElementById(`qti-disc-type-${idx}`).value,
      } : {};
      items.push({ description, quantity, unit_price, unit_cost, discount, purchase_request_id, is_q_item, ...spFields });
    });
    if (snClash) { this.alert(snClash, 'error'); return; }
    if (deliveryErr) { this.alert(deliveryErr, 'error'); return; }
    if (!items.length) { this.alert('Add at least one item', 'error'); return; }
    const isSpecialProject = this._quoteType === 'special_project';
    try {
      const payload = { customer_id: customer_id||null, branch_id: branch_id||null, discount_amount, notes, valid_until: valid_until||null, po_number: document.getElementById('qt-po')?.value.trim() || null, items };
      // Only on create — see the matching comment on the rental branch above.
      if (!this._editingQuoteId) payload.employee_id = this.currentUser.id;
      if (isSpecialProject && !this._editingQuoteId) payload.quote_type = 'special_project';
      if (this._editingQuoteId) {
        await this.api('PUT', `/quotations/${this._editingQuoteId}`, payload);
        this.alert('Quotation updated');
      } else {
        await this.api('POST', '/quotations', payload);
        this.alert(isSpecialProject ? 'Quotation saved as draft' : 'Quotation created');
      }
      this.closeModal();
      if (isSpecialProject) this.renderSpecialProjects(); else this.renderQuotations();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Under a Special Project rental line on viewQuote: its hold (rental
  // agreement), check-out and check-in, condition, and any charges raised at
  // check-in (late/early return, damage) — those are settled on the rental
  // itself (Returned – Not Paid → Collect), not on the project invoice.
  _spRentalDetailsHtml(i, q) {
    if (!i.is_rental_line || i.parent_item_id) return '';
    const d = v => v ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
    const cell = html => `<tr><td colspan="8" style="padding-top:0;border-top:none"><div style="font-size:12px;background:var(--bg-secondary);border-radius:6px;padding:8px 10px;line-height:1.6">${html}</div></td></tr>`;
    const r = i.rental;
    if (!r) {
      const note = ['draft', 'pending_approval'].includes(q.status) ? 'The item is held for this project when it\'s approved.' : 'Not held — send the project back to Draft and approve it again to hold the item.';
      return cell(`<strong>Rental period:</strong> ${d(i.rental_start)} to ${d(i.rental_end)} · ${this._ratePlanLabel(i.rate_plan)} · <span style="color:var(--text-muted)">${note}</span>`);
    }
    const labels = { pending: ['Held — awaiting project payment', 'badge-warning'], awaiting_issue: ['Paid — ready to check out', 'badge-info'], out_for_delivery: ['Out for delivery', 'badge-teal'], active: ['Checked out', 'badge-info'], paused: ['Checked out (paused)', 'badge-warning'], overdue: ['Overdue', 'badge-danger'], returned: ['Checked in', 'badge-success'], returned_unpaid: ['Checked in — balance due', 'badge-danger'], cancelled: ['Hold cancelled', 'badge-secondary'] };
    const [label, badge] = labels[r.display_status] || [r.display_status, 'badge-secondary'];
    const parts = [`<strong>Rental:</strong> <a href="#" style="color:var(--primary);font-weight:600;text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewRentalAgreement(${r.id})">${r.agreement_number}</a> <span class="badge-pill ${badge}" style="font-size:10px">${label}</span> · Period ${d(i.rental_start)} to ${d(i.rental_end)} · Due back ${d(r.due_date)} · ${this._ratePlanLabel(i.rate_plan)}`];
    parts.push(`<strong>Check-out:</strong> ${r.checkout_datetime ? `${this.fmtDateTime(r.checkout_datetime)}${r.issued_by_name ? ` · signed out by ${r.issued_by_name}` : ''}` : '<span style="color:var(--text-muted)">not yet</span>'}`
      + ` &nbsp; <strong>Check-in:</strong> ${r.returned_at ? `${this.fmtDateTime(r.returned_at)}${r.returned_by_name ? ` · signed in by ${r.returned_by_name}` : ''}` : '<span style="color:var(--text-muted)">not yet</span>'}`);
    const conds = (r.items || []).filter(it => it.condition_out || it.condition_in || it.damage_notes)
      .map(it => `${r.items.length > 1 ? `${it.product_name}: ` : ''}${it.condition_out || '—'} → ${it.condition_in || '—'}${it.damage_notes ? ` <span style="color:var(--danger)">(${it.damage_notes})</span>` : ''}`);
    if (conds.length) parts.push(`<strong>Condition:</strong> ${conds.join('; ')}`);
    if (r.status === 'returned') {
      const adj = (r.duration_adjustment_total || 0) + (r.tax_adjustment_total || 0);
      const charges = [];
      if (Math.abs(adj) >= 0.005) charges.push(`${adj > 0 ? 'Late return' : 'Early return credit'} ${this.fmt(adj)} (incl. tax)`);
      if (r.damage_fee_total > 0) charges.push(`Damage ${this.fmt(r.damage_fee_total)}`);
      const bal = r.balance_due || 0;
      const settled = r.settlement_transaction_number ? ` · settled on <a href="#" style="color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewTransaction(${r.settlement_transaction_id})">${r.settlement_transaction_number}</a>` : '';
      const balText = bal > 0.005 ? (r.settlement_transaction_id ? `Balance ${this.fmt(bal)}${settled}` : `<span style="color:var(--danger);font-weight:600">Balance due ${this.fmt(bal)}</span> — collect from Rentals → Returned – Not Paid`)
        : bal < -0.005 ? `Refund due ${this.fmt(-bal)} — see Rental Deposits` : 'No extra charges';
      parts.push(`<strong>Charges at check-in:</strong> ${charges.length ? charges.join(' · ') + ' · ' : ''}${balText}`);
    }
    return cell(parts.join('<br>'));
  },

  // Per-item branch-sourcing breakdown for viewQuote — how much of the line
  // came from the quote's own branch (no note needed), how much was
  // transferred in from elsewhere (linked to the auto-created transfer), and
  // how much had no stock anywhere and is on order (linked to the quote's PR).
  renderQuoteItemSources(item, quote) {
    if (!item.sources || !item.sources.length) return '';
    const parts = item.sources.map(s => {
      if (s.branch_id === quote.branch_id) return null; // already at the point of sale, nothing to call out
      if (s.branch_id === null) {
        return s.purchase_request_number
          ? `${s.quantity} on order <a href="#" style="color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewPR(${s.purchase_request_id})">${s.purchase_request_number}</a>`
          : `${s.quantity} on order (pending)`;
      }
      return s.transfer_number
        ? `${s.quantity} from ${s.branch_name} <a href="#" style="color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewTransfer(${s.transfer_id})">${s.transfer_number}</a>`
        : `${s.quantity} from ${s.branch_name} (pending)`;
    }).filter(Boolean);
    if (!parts.length) return '';
    return `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${parts.join(', ')}</div>`;
  },

  async viewQuote(id) {
    const [q, attachments] = await Promise.all([
      this.api('GET', `/quotations/${id}`),
      this.api('GET', `/quotations/${id}/attachments`).catch(() => []),
    ]);
    const isRental = q.quote_type === 'rental';
    const isSpecialProject = q.quote_type === 'special_project';
    const lineDiscounts = q.items.reduce((sum, i) => sum + (i.discount_applied ? parseFloat(i.discount_amount) || 0 : 0), 0);
    const canEditAttachments = !isSpecialProject || this.can('special_projects');
    const statusColor = { draft:'badge-warning', sent:'badge-info', accepted:'badge-success', declined:'badge-danger', converted:'badge-teal', pending_approval:'badge-warning', approved:'badge-success' };
    const statusLabel = { pending_approval: 'Pending Approval' };
    const approvalBanner = !isSpecialProject ? '' : q.status === 'pending_approval'
      ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--warning,#f59e0b);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px">Submitted for approval ${this.fmtDateTime(q.submitted_at)} — awaiting a supervisor's pricing sign-off.</div>`
      : q.approved_at
      ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--success,#22c55e);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px">Approved by ${q.approved_by_name||'a supervisor'} on ${this.fmtDateTime(q.approved_at)}.${this._approvalSigImg(q.approval_signature)}</div>`
      : q.rejected_at
      ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--danger,#ef4444);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px">Rejected by ${q.rejected_by_name||'a supervisor'} on ${this.fmtDateTime(q.rejected_at)} — ${q.rejection_reason}<br>Edit and resubmit when ready.</div>`
      : '';
    const convertedBanner = isRental
      ? (q.converted_to_agreement_id ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--teal,#14b8a6);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px">
          Converted to rental agreement <a href="#" style="font-weight:700;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewRentalAgreement(${q.converted_to_agreement_id})">${q.converted_agreement_number||'view agreement'}</a>
        </div>` : '')
      : (q.converted_to_tx ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--teal,#14b8a6);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px">
          Converted to invoice <a href="#" style="font-weight:700;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewTransaction(${q.converted_to_tx})">${q.converted_tx_number||'view transaction'}</a>
        </div>` : '');
    const rentalRateCard = i => (i.rate_basis && i.rate_basis.length) ? this._rateBasisLabel(i.rate_basis) : (i.rental_classification === 'equipment'
      ? [['Hourly', i.hourly_rate], ['Daily', i.daily_rate], ['Weekly', i.weekly_rate], ['Monthly', i.monthly_rate]]
      : [['Daily', i.daily_rate]]).filter(([, v]) => v > 0).map(([l, v]) => `${l} ${this.fmt(v)}`).join(' · ');
    const rentalDays = isRental && q.due_date
      ? Math.max(1, Math.round((new Date(`${String(q.due_date).slice(0,10)}T00:00:00Z`) - new Date(`${String(q.created_at).slice(0,10)}T00:00:00Z`)) / 86400000))
      : null;
    const itemsTable = isRental ? `
      ${rentalDays ? `<div style="border:1px solid var(--border);border-left:3px solid var(--primary);border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px">
        <strong>Rental Period:</strong> ${this.fmtDate(q.created_at)} – ${this.fmtDate(q.due_date)} (${rentalDays} day${rentalDays===1?'':'s'})
      </div>` : ''}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Qty</th><th>Rate</th><th>Condition Out</th><th>Est. Fee</th></tr></thead>
          <tbody>
            ${q.items.map(i => {
              const tag = i.parent_item_id ? (i.is_mandatory ? ' <span class="badge-pill badge-success" style="font-size:10px">included</span>' : ' <span class="badge-pill badge-secondary" style="font-size:10px">accessory</span>') : '';
              return `<tr><td>${i.parent_item_id ? '↳ ' : ''}${i.product_name}${tag}</td><td>${i.quantity}</td><td style="font-size:11px;color:var(--text-muted)">${rentalRateCard(i) || '-'}</td><td>${i.condition_out||'-'}</td><td class="fw-600">${i.is_mandatory ? 'Included' : this.fmt(i.total)}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:6px">Rental fees are estimated for the period shown — the real charge is computed when the rental is finalized at the register.</p>` : isSpecialProject ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Item</th><th>Qty</th><th>U.O.M</th><th>Rent Period</th><th>Cost</th><th>Price</th><th>Margin</th><th>Total</th></tr></thead>
          <tbody>
            ${q.items.map(i => { if (i.is_comment) return `<tr><td colspan="8" style="font-style:italic;white-space:pre-wrap;color:var(--text-muted)"><span class="badge-pill badge-info" style="font-size:10px;font-style:normal">C</span> ${this.escapeAttr(i.product_name)}</td></tr>`; const margin = (i.unit_cost != null && i.unit_price > 0) ? ((i.unit_price - i.unit_cost) / i.unit_price * 100) : null; return `<tr><td>${i.parent_item_id ? '↳ ' : ''}${i.is_rental_line && !i.parent_item_id ? '<span class="badge-pill badge-warning" style="font-size:10px">RENTAL</span> ' : ''}${i.is_temp_item && i.sku ? `<span style="color:var(--text-muted)">${this.escapeAttr(i.sku)}</span> ` : ''}${i.is_temp_item ? this.escapeAttr(i.product_name) : i.product_name}${i.is_temp_item && i.is_q_item ? ` <span class="badge-pill badge-warning" style="font-size:10px" title="Flagged for Purchasing to order">Q</span>${i.purchase_request_number ? ` <a href="#" style="font-size:11px;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewPR(${i.purchase_request_id})">${i.purchase_request_number}</a>` : ''}` : ''}${i.discount_amount > 0 ? ` <span class="badge-pill badge-purple" style="font-size:10px" title="${i.discount_applied ? 'Discount taken off this line' : 'Discount given on this line'}">-${this.fmt(i.discount_amount)}${i.discount_percent != null ? ` (${parseFloat(i.discount_percent)}%)` : ''}</span>` : ''}</td><td>${i.quantity}</td><td>${i.is_temp_item ? this.escapeAttr(i.sell_unit || '') : (i.sell_unit || '')}</td><td style="white-space:nowrap">${i.rent_period != null ? `${i.rent_period} ${this.escapeAttr(i.rent_period_unit || 'Day(s)')}` : ''}</td><td>${i.unit_cost != null ? this.fmt(i.unit_cost) : '<span style="color:var(--text-muted)">—</span>'}</td><td>${this.fmt(i.unit_price)}</td><td>${margin != null ? `<span style="color:${margin<0?'var(--danger)':'var(--text-muted)'}">${margin>=0?'+':''}${margin.toFixed(0)}%</span>` : '—'}</td><td class="fw-600">${i.is_mandatory ? 'Included' : this.fmt(i.total)}</td></tr>${this._spRentalDetailsHtml(i, q)}`; }).join('')}
          </tbody>
        </table>
      </div>` : `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Tax</th><th>Total</th></tr></thead>
          <tbody>
            ${q.items.map(i => !i.is_comment && i.serial_number ? `<tr><td colspan="5" style="font-size:12px;color:var(--text-muted);padding-left:24px">${this._serialNote(i)}</td></tr>` : i.is_comment ? `<tr><td colspan="5" style="font-style:italic;white-space:pre-wrap;color:var(--text-muted)"><span class="badge-pill badge-info" style="font-size:10px;font-style:normal">C</span> ${this.escapeAttr(i.product_name)}</td></tr>` : `<tr><td>${i.product_name}${i.is_temp_item && (!isSpecialProject || i.is_q_item) ? ` <span class="badge-pill badge-warning" style="font-size:10px" title="Flagged for Purchasing to order">Q</span>${i.purchase_request_number ? ` <a href="#" style="font-size:11px;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewPR(${i.purchase_request_id})">${i.purchase_request_number}</a>` : ''}` : ''}${i.discount_amount > 0 ? ` <span class="badge-pill badge-purple" style="font-size:10px" title="Discount given on this line">-${this.fmt(i.discount_amount)}</span>` : ''}${this.renderQuoteItemSources(i, q)}</td><td>${i.quantity}</td><td>${this.fmt(i.unit_price)}</td><td>${this.fmt(i.tax_amount)}</td><td class="fw-600">${this.fmt(i.total)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    this.showModal(`
      <div class="modal" style="max-width:960px">
        <div class="modal-header">
          <span class="modal-title">Quotation: ${q.quote_number}</span>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="badge-pill ${isRental?'badge-warning':isSpecialProject?'badge-danger':'badge-info'}" style="font-size:10px">${isRental?'RENTAL':isSpecialProject?'SPECIAL PROJECT':'RETAIL'}</span>
            ${q.is_special_order ? `<span class="badge-pill badge-purple" style="font-size:10px" title="Includes Q items — things Purchasing has to order">SPECIAL ORDER</span>` : ''}
            <span class="badge-pill ${statusColor[q.status]||''}">${statusLabel[q.status]||q.status}</span>
            <button class="modal-close">✕</button>
          </div>
        </div>
        <div class="modal-body">
          ${convertedBanner}
          ${approvalBanner}
          <div class="two-col" style="margin-bottom:14px;font-size:13px">
            <div><strong>Customer:</strong> ${q.customer_name||'Walk-in'}<br><strong>Phone:</strong> ${q.customer_phone||'-'}<br><strong>Email:</strong> ${q.customer_email||'-'}</div>
            <div><strong>Date:</strong> ${this.fmtDate(q.created_at)}<br><strong>${isRental?'Due Date':'Valid Until'}:</strong> ${(isRental?q.due_date:q.valid_until) ? this.fmtDate(isRental?q.due_date:q.valid_until) : 'N/A'}<br><strong>Branch:</strong> ${q.branch_name||'-'}<br>${isRental ? `<strong>Rate:</strong> ${this._ratePlanLabel(q.rate_plan)}<br>` : ''}<strong>Assigned to:</strong> ${q.employee_name||'-'}${q.original_employee_name && q.employee_name !== q.original_employee_name ? `<br><strong>Sale credited to:</strong> ${q.original_employee_name} <span class="badge-pill badge-info" style="font-size:10px" title="Reassigned for completion — commission still goes to the original salesperson">reassigned</span>` : ''}</div>
          </div>
          ${itemsTable}
          ${isRental && (q.delivery_required || q.pickup_required || q.operator_required) ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-top:10px;font-size:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Additional Services</strong>
            ${q.delivery_required ? `<div>Delivery — ${this.fmt(q.delivery_cost)}${q.delivery_address ? ` — ${q.delivery_address}` : ''}</div>` : ''}
            ${q.operator_required ? `<div>Operator — ${this.fmt(q.operator_fee)}</div>` : ''}
            ${q.pickup_required ? `<div>Pickup — ${this.fmt(q.pickup_cost)}${q.pickup_address ? ` — ${this.escapeAttr(q.pickup_address)}` : ''}</div>` : ''}
          </div>` : ''}
          ${isRental && q.rental_summary ? (() => {
            const sm = q.rental_summary;
            const row = (l, v) => `<div style="display:flex;justify-content:space-between"><span>${l}</span><span>${v}</span></div>`;
            return `<div style="margin:10px 0 0 auto;max-width:340px;font-size:13px;line-height:2">
              ${row('Rental Fees (est.)', this.fmt(sm.rental_fees))}
              ${sm.discount > 0 ? row('Discount', `-${this.fmt(sm.discount)}`) : ''}
              ${row('Sales Tax', this.fmt(sm.tax))}
              ${q.delivery_required ? row('Delivery', this.fmt(sm.delivery)) : ''}
              ${q.pickup_required ? row('Pickup', this.fmt(sm.pickup)) : ''}
              ${q.operator_required ? row('Operator', this.fmt(sm.operator)) : ''}
              ${row('Refundable Deposit', sm.deposit_waived ? (sm.deposit_waived_reason === 'credit' ? 'Not required (credit account)' : 'Waived (operator)') : this.fmt(sm.deposit))}
              <div style="display:flex;justify-content:space-between;border-top:2px solid var(--text);margin-top:4px;font-size:16px;font-weight:700"><span>Total Due at Checkout</span><span>${this.fmt(sm.total)}</span></div>
            </div>`;
          })() : `<div style="text-align:right;margin-top:10px;font-size:13px;line-height:2">
            <div>Subtotal: ${this.fmt(q.subtotal + lineDiscounts)}</div>
            ${q.discount_amount + lineDiscounts > 0 ? `<div>Discount: -${this.fmt(q.discount_amount + lineDiscounts)}</div>` : ''}
            <div>Tax: ${this.fmt(q.tax_amount)}</div>
            <div style="font-size:16px;font-weight:700">Total: ${this.fmt(q.total)}</div>
          </div>`}
          <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-weight:700;font-size:14px">Attachments</span>
              ${canEditAttachments ? `<button class="btn btn-sm btn-outline" onclick="App.showQuoteAttachForm(${q.id})">+ Attach Document</button>` : ''}
            </div>
            <div id="quote-attachments-list">
              ${attachments.length ? attachments.map(a => this._quoteAttachmentRow(q.id, a, canEditAttachments)).join('') : '<div style="font-size:13px;color:var(--text-muted);padding:6px 0" id="quote-att-empty">No documents attached yet.</div>'}
            </div>
          </div>
        </div>
        <div class="modal-footer footer-wrap">
          ${isSpecialProject && q.status==='draft' ? `
            <button class="btn btn-secondary" onclick="App.closeModal();App.showQuoteForm(${q.id})">Edit</button>
            ${this.can('special_projects') ? `<button class="btn btn-primary" onclick="App.submitSpecialProjectForApproval(${q.id})">Submit for Approval</button>` : ''}
          ` : ''}
          ${isSpecialProject && ['pending_approval','approved','sent','accepted','declined'].includes(q.status) && this.can('special_projects') ? `
            <button class="btn btn-secondary" onclick="App.reopenSpecialProject(${q.id},'${q.status}')">Edit</button>
          ` : ''}
          ${isSpecialProject && q.status==='pending_approval' && this.can('special_projects_approve') ? `
            <button class="btn btn-success" onclick="App.showApproveSpecialProjectModal(${q.id})">Approve</button>
            <button class="btn btn-danger" onclick="App.showRejectSpecialProjectModal(${q.id})">Reject</button>
          ` : ''}
          ${(!isSpecialProject || this.can('special_projects')) && q.status!=='converted'&&q.status!=='declined'&&!(isSpecialProject && ['draft','pending_approval'].includes(q.status)) ? `
            ${!isSpecialProject ? `<button class="btn btn-secondary" onclick="App.closeModal();App.showQuoteForm(${q.id})">Edit</button>` : ''}
            <button class="btn btn-secondary" onclick="App.updateQuoteStatus(${q.id},'sent')">Mark Sent</button>
            <button class="btn btn-success" onclick="App.updateQuoteStatus(${q.id},'accepted')">Accept</button>
            <button class="btn btn-danger" onclick="App.updateQuoteStatus(${q.id},'declined')">Decline</button>
          ` : ''}
          <button class="btn btn-secondary" onclick="App.printQuoteLetter(${q.id})" title="Opens the customer copy — choose Save as PDF in the print dialog to attach it to an email">🖨️ Print${isRental ? '' : ' Quotation'}</button>
          <button class="btn btn-secondary" onclick="App.emailQuote(${q.id},'${(q.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email Quote</button>
          ${q.status!=='converted'&&q.status!=='declined'&&this.can('sales_manager') ? `
            <button class="btn btn-secondary" onclick="App.showReassignQuoteModal(${q.id},${q.employee_id||'null'})">Reassign</button>
          ` : ''}
          ${(!isSpecialProject || this.can('special_projects')) && q.status!=='converted'&&q.status!=='declined'&&!(isSpecialProject && ['draft','pending_approval'].includes(q.status)) ? `
            <button class="btn btn-primary" onclick="App.closeModal();App.showConvertQuote(${q.id})">${isRental?'Convert to Rental':'Convert to Invoice'}</button>
          ` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  // ─── Quotation / Special Project attachments ───────────────────────────
  // Same UX as the PO attachments (showPOAttachForm & co.), backed by
  // /quotations/:id/attachments.

  _quoteAttachmentRow(quoteId, a, canEdit) {
    const docTypeLabel = { customer_po:'Customer PO', supplier_quotation:'Supplier Quotation', specification:'Drawing / Specification', other:'Other' };
    const fileIcon = m => m==='application/pdf'?'📄':m&&m.startsWith('image/')?'🖼':m&&m.includes('word')?'📝':m&&m.includes('sheet')?'📊':'📎';
    const fmtBytes = b => b<1024?`${b} B`:b<1048576?`${(b/1024).toFixed(1)} KB`:`${(b/1048576).toFixed(1)} MB`;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-secondary,#f8f9fa);border:1px solid var(--border);border-radius:6px;margin-bottom:6px" id="quote-att-${a.id}">
        <span style="font-size:18px">${fileIcon(a.mime_type)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this.escapeAttr(a.original_name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${docTypeLabel[a.document_type]||'Other'} &bull; ${fmtBytes(a.file_size||0)} &bull; ${this.fmtDate(a.uploaded_at)}${a.uploaded_by_name ? ` &bull; ${this.escapeAttr(a.uploaded_by_name)}` : ''}</div>
        </div>
        <a href="/api/quotations/${quoteId}/attachments/${a.id}/download" target="_blank" class="btn btn-sm btn-secondary" style="white-space:nowrap">Download</a>
        ${canEdit ? `<button class="btn btn-sm btn-danger" onclick="App.deleteQuoteAttachment(${quoteId},${a.id})">✕</button>` : ''}
      </div>`;
  },

  showQuoteAttachForm(quoteId) {
    this.showSecondaryModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">Attach Document</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group">
            <label>Document Type</label>
            <select id="qatt-doctype">
              <option value="customer_po">Customer PO</option>
              <option value="supplier_quotation">Supplier Quotation</option>
              <option value="specification">Drawing / Specification</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label>File <span style="font-size:11px;color:var(--text-muted)">(PDF, Word, Excel, image — max 20 MB)</span></label>
            <input type="file" id="qatt-file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.txt" style="display:block;width:100%;padding:8px 0">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" id="qatt-upload-btn" onclick="App.uploadQuoteAttachment(${quoteId})">Upload</button>
        </div>
      </div>`);
  },

  async uploadQuoteAttachment(quoteId) {
    const fileInput = document.getElementById('qatt-file');
    if (!fileInput.files.length) { this.alert('Please select a file', 'error'); return; }
    const btn = document.getElementById('qatt-upload-btn');
    btn.disabled = true; btn.textContent = 'Uploading...';
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    fd.append('document_type', document.getElementById('qatt-doctype').value);
    try {
      const res = await fetch(`/api/quotations/${quoteId}/attachments`, { method: 'POST', body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Upload failed'); }
      const att = await res.json();
      this.closeSecondaryModal();
      this.alert('Document attached successfully');
      const list = document.getElementById('quote-attachments-list');
      if (list) {
        document.getElementById('quote-att-empty')?.remove();
        list.insertAdjacentHTML('afterbegin', this._quoteAttachmentRow(quoteId, att, true));
      }
    } catch(e) {
      btn.disabled = false; btn.textContent = 'Upload';
      this.alert(e.message, 'error');
    }
  },

  async deleteQuoteAttachment(quoteId, attId) {
    if (!confirm('Remove this attachment permanently?')) return;
    try {
      await this.api('DELETE', `/quotations/${quoteId}/attachments/${attId}`);
      document.getElementById(`quote-att-${attId}`)?.remove();
      const list = document.getElementById('quote-attachments-list');
      if (list && !list.querySelector('[id^="quote-att-"]')) {
        list.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:6px 0" id="quote-att-empty">No documents attached yet.</div>';
      }
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Letter-size print of the same document the customer gets by email
  // (retail, rental and Special Project quotes) —
  // rendered server-side (GET /email/quote-preview/:id).
  printQuoteLetter(id) {
    return this._printServerDocument(`/api/email/quote-preview/${id}`, 'quotation', 'quotation');
  },

  async updateQuoteStatus(id, status) {
    try {
      await this.api('PATCH', `/quotations/${id}/status`, { status });
      this.closeModal();
      this.alert(`Quotation ${status}`);
      this.renderQuotations();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showReassignQuoteModal(id, currentEmployeeId) {
    const employees = await this.api('GET', '/employees');
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <span class="modal-title">Reassign Quote</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Hands this quote to another salesperson to complete. The sale's commission still credits whoever originally owned it, not the new assignee.</p>
          <div class="form-group"><label>Assign To</label>
            <select id="qr-employee">
              ${employees.filter(e => e.active !== 0).map(e => `<option value="${e.id}" ${e.id===currentEmployeeId?'selected':''}>${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.reassignQuote(${id})">Reassign</button>
        </div>
      </div>`);
  },

  async reassignQuote(id) {
    const employee_id = parseInt(document.getElementById('qr-employee').value);
    try {
      await this.api('PATCH', `/quotations/${id}/reassign`, { employee_id });
      this.closeModal();
      this.alert('Quote reassigned');
      this.viewQuote(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Special Projects: internal pricing approval ───────────────────────

  // Changing a quote after it was submitted or approved: back to Draft, approval
  // and any rental holds removed, so the new numbers get approved again.
  async reopenSpecialProject(id, status) {
    const warning = status === 'pending_approval'
      ? 'This takes the quotation back from approval and returns it to Draft so you can change it. It will need submitting again.'
      : status === 'declined'
      ? 'This reopens the declined quotation as a Draft so you can change it. It will need approving again.'
      : 'This returns the quotation to Draft so you can change it. Its approval and signature are removed, any rental holds are released, and it will need approving again.';
    const extra = status === 'accepted' ? '\n\nAny Purchase Request or transfer already raised for it stays as it is, so check those if the items change.' : '';
    if (!confirm(`${warning}${extra}\n\nContinue?`)) return;
    try {
      await this.api('PATCH', `/quotations/${id}/status`, { status: 'draft' });
      this.closeModal();
      this.renderSpecialProjects();
      this.showQuoteForm(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async submitSpecialProjectForApproval(id) {
    try {
      await this.api('PATCH', `/quotations/${id}/submit-for-approval`, {});
      this.alert('Submitted for approval');
      this.viewQuote(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showApproveSpecialProjectModal(id) {
    this._showApprovalDialog({
      title: 'Approve Quotation',
      intro: 'This signs off on the pricing as entered — the project can then be sent to the customer and converted to an invoice. Your signature appears on the quotation\'s printed, emailed and PDF copies.',
      approve: async (signature) => {
        await this.api('PATCH', `/quotations/${id}/approve`, { signature });
        this.closeModal();
        this.alert('Quotation approved');
        this.viewQuote(id);
      },
    });
  },

  showRejectSpecialProjectModal(id) {
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Reject Quotation</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">This sends it back to Draft so the pricing can be adjusted and resubmitted.</p>
          <div class="form-group"><label>Reason *</label><textarea id="sp-reject-reason" rows="3" placeholder="What needs to change"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" onclick="App.confirmRejectSpecialProject(${id})">Reject</button>
        </div>
      </div>`);
  },

  async confirmRejectSpecialProject(id) {
    const reason = document.getElementById('sp-reject-reason').value.trim();
    if (!reason) { this.alert('A rejection reason is required', 'error'); return; }
    try {
      await this.api('PATCH', `/quotations/${id}/reject`, { reason, employee_id: this.currentUser.id });
      this.closeModal();
      this.alert('Quotation rejected — back in Draft');
      this.viewQuote(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showConvertQuote(id) {
    const q = await this.api('GET', `/quotations/${id}`);
    const isRental = q.quote_type === 'rental';
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">${isRental?'Convert to Rental':'Convert to Invoice'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px">Converting quotation <strong>${q.quote_number}</strong> — ${isRental?'Estimated Total':'Total'}: <strong>${this.fmt(q.total)}</strong></p>
          <p style="font-size:13px;color:var(--text-muted);margin-top:8px">${isRental
            ? 'This reserves the item(s) and sends it to the POS as a pending rental — a cashier will collect payment via Recall Held Order to start the rental.'
            : 'This creates an invoice and sends it to the POS as a held order — a cashier will pick it up from Recall Held Order to collect payment.'}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-success" onclick="App.convertQuote(${id})">Send to Cashier</button>
        </div>
      </div>`);
  },

  async convertQuote(id) {
    try {
      const result = await this.api('POST', `/quotations/${id}/convert`, {});
      this.closeModal();
      if (result.agreement_number) {
        this.alert(`Sent to cashier as pending rental ${result.agreement_number} — ready for checkout at POS`);
      } else {
        this.alert(`Sent to cashier as held order ${result.transaction_number} — ready for checkout at POS`);
      }
      if (this.section === 'special-projects') this.renderSpecialProjects(); else this.renderQuotations();
    } catch(e) { this.alert(e.message, 'error'); }
  },

});
