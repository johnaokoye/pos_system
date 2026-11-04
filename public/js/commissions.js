// Commissions.
Object.assign(App, {
  // ─── Commissions ─────────────────────────────────────────
  commTab: 'dashboard',

  async renderCommissions() {
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Commission Tracking ${this.currentUser.is_salesperson ? '<span style="font-size:12px;font-weight:normal;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;padding:2px 8px;margin-left:8px;vertical-align:middle">My Commissions Only</span>' : ''}</h2>
        <div style="display:flex;gap:8px">
          ${this.can('commissions_plans') ? `<button class="btn btn-outline btn-sm" onclick="App.showPlanModal()">+ New Plan</button>` : ''}
          <button class="btn btn-primary btn-sm" onclick="App.showManualCommModal()">+ Manual Entry</button>
        </div>
      </div>
      <div class="crm-tabs">
        <button class="crm-tab ${this.commTab==='dashboard'?'active':''}" data-tab="dashboard" onclick="App.switchCommTab('dashboard')">Dashboard</button>
        <button class="crm-tab ${this.commTab==='records'?'active':''}" data-tab="records" onclick="App.switchCommTab('records')">Records</button>
        ${this.can('commissions_plans') ? `<button class="crm-tab ${this.commTab==='plans'?'active':''}" data-tab="plans" onclick="App.switchCommTab('plans')">Plans &amp; Assignments</button>` : ''}
      </div>
      <div id="comm-tab-content"></div>`;
    await this.renderCommTab();
  },

  switchCommTab(tab) {
    this.commTab = tab;
    document.querySelectorAll('.crm-tabs .crm-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    this.renderCommTab();
  },

  async renderCommTab() {
    const el = document.getElementById('comm-tab-content');
    if (!el) return;
    if (this.commTab === 'dashboard') await this.renderCommDashboard(el);
    else if (this.commTab === 'records') await this.renderCommRecords(el);
    else if (this.commTab === 'plans') await this.renderCommPlans(el);
  },

  commStatusBadge(s) {
    return `<span class="badge-pill comm-status-${s}">${s.charAt(0).toUpperCase()+s.slice(1)}</span>`;
  },

  sourceTypeLabel(s) {
    return { transaction:'POS Sale', quotation:'Quote', opportunity:'CRM Deal', manual:'Manual', rental:'Rental' }[s] || s;
  },

  async renderCommDashboard(el) {
    const curPeriod = new Date().toISOString().slice(0,7);
    this._commPeriod = this._commPeriod || curPeriod;
    const summary = await this.api('GET', `/commissions/summary?period=${this._commPeriod}`);

    const rankColors = ['gold','silver','bronze'];
    const bySource = {};
    summary.bySource.forEach(r => { bySource[r.source_type] = r; });

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <label style="font-size:12px;text-transform:uppercase;color:var(--text-muted);margin:0">Period</label>
        <select id="comm-period-sel" onchange="App.changeCommPeriod(this.value)" style="width:160px">
          ${(summary.periods.length ? summary.periods : [curPeriod]).map(p =>
            `<option value="${p}" ${p===this._commPeriod?'selected':''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
        <div class="stat-card blue"><div class="stat-label">Total Earned</div><div class="stat-value">${this.fmt(summary.totals.total)}</div><div class="stat-sub">${summary.totals.count} records</div></div>
        <div class="stat-card orange"><div class="stat-label">Pending Approval</div><div class="stat-value">${this.fmt(summary.totals.pending)}</div>
          ${summary.totals.pending > 0 && this.can('commissions_approve') ? `<div style="margin-top:6px"><button class="btn btn-sm btn-primary" onclick="App.bulkApproveAll('${this._commPeriod}')">Approve All</button></div>` : (summary.totals.pending > 0 ? '' : '<div class="stat-sub">None pending</div>')}
        </div>
        <div class="stat-card purple"><div class="stat-label">Approved (Unpaid)</div><div class="stat-value">${this.fmt(summary.totals.approved)}</div>
          ${summary.totals.approved > 0 && this.can('commissions_pay') ? `<div style="margin-top:6px"><button class="btn btn-sm btn-success" onclick="App.bulkPayAll('${this._commPeriod}')">Pay All</button></div>` : (summary.totals.approved > 0 ? '' : '<div class="stat-sub">None to pay</div>')}
        </div>
        <div class="stat-card green"><div class="stat-label">Paid This Period</div><div class="stat-value">${this.fmt(summary.totals.paid)}</div><div class="stat-sub">Disbursed</div></div>
      </div>
      <div class="two-col" style="margin-bottom:16px">
        <div class="card">
          <div class="card-header"><span class="card-title">Salesperson Leaderboard</span></div>
          ${summary.byEmployee.length === 0 ? '<div class="empty-state" style="padding:20px"><p>No commission records for this period</p></div>' :
            summary.byEmployee.map((e, i) => {
              const rankClass = rankColors[i] || '';
              const paidPct = e.total_commission > 0 ? Math.round(e.paid / e.total_commission * 100) : 0;
              return `
                <div class="leaderboard-item">
                  <div class="leaderboard-rank ${rankClass}">${i+1}</div>
                  <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:13px">${e.employee_name}</div>
                    <div style="font-size:11px;color:var(--text-muted)">${e.record_count} sale${e.record_count!==1?'s':''} &bull; ${this.fmt(e.total_sales)} volume</div>
                    <div style="display:flex;gap:6px;margin-top:4px;font-size:11px">
                      <span style="color:var(--warning)">${this.fmt(e.pending)} pending</span>
                      <span style="color:var(--accent)">${this.fmt(e.approved)} approved</span>
                      <span style="color:var(--success)">${this.fmt(e.paid)} paid</span>
                    </div>
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:18px;font-weight:700;color:var(--success)">${this.fmt(e.total_commission)}</div>
                    <div style="font-size:11px;color:var(--text-muted)">${paidPct}% paid</div>
                  </div>
                </div>`;
            }).join('')}
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Commission by Source</span></div>
          ${['transaction','quotation','opportunity','rental','manual'].map(s => {
            const r = bySource[s] || { count: 0, total: 0 };
            if (!r.count) return '';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
              <div>
                <div style="font-weight:600;font-size:13px">${this.sourceTypeLabel(s)}</div>
                <div style="font-size:11px;color:var(--text-muted)">${r.count} record${r.count!==1?'s':''}</div>
              </div>
              <div style="font-size:16px;font-weight:700;color:var(--accent)">${this.fmt(r.total)}</div>
            </div>`;
          }).join('') || '<div style="color:var(--text-muted);text-align:center;padding:20px">No data</div>'}
          <div style="margin-top:16px">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase">Period Breakdown</div>
            ${summary.byEmployee.map(e => {
              const pct = summary.totals.total > 0 ? (e.total_commission / summary.totals.total * 100) : 0;
              return `<div style="margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
                  <span>${e.employee_name}</span><span style="font-weight:600">${this.fmt(e.total_commission)}</span>
                </div>
                <div style="background:#f0f0f0;border-radius:3px;height:8px">
                  <div style="width:${pct.toFixed(1)}%;background:var(--accent);height:100%;border-radius:3px"></div>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>`;
  },

  changeCommPeriod(p) { this._commPeriod = p; this.renderCommTab(); },

  async bulkApproveAll(period) {
    const recs = await this.api('GET', `/commissions/records?period=${period}&status=pending`);
    if (!recs.length) return this.alert('No pending records', 'warning');
    const total = recs.reduce((t, r) => t + (r.commission_amount || 0), 0);
    this._showApprovalDialog({
      title: 'Approve Commissions',
      intro: `Approve all <strong>${recs.length}</strong> pending commission record${recs.length === 1 ? '' : 's'} for ${period} (${this.fmt(total)}). Your signature is recorded on each one.`,
      approveLabel: `Approve ${recs.length}`,
      approve: async (signature) => {
        const r = await this.api('PATCH', '/commissions/records/bulk-approve', { ids: recs.map(r => r.id), signature });
        this.closeModal();
        this.alert(`${r.updated} record${r.updated === 1 ? '' : 's'} approved`);
        this.renderCommTab();
      },
    });
  },

  async bulkPayAll(period) {
    const recs = await this.api('GET', `/commissions/records?period=${period}&status=approved`);
    if (!recs.length) return this.alert('No approved records to pay', 'warning');
    if (!confirm(`Mark all ${recs.length} approved records as paid for ${period}?`)) return;
    try {
      await this.api('PATCH', '/commissions/records/bulk-pay', { ids: recs.map(r => r.id) });
      this.alert(`${recs.length} records marked as paid`);
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async renderCommRecords(el) {
    // Only /employees is actually used below — this used to also fetch
    // /commissions/plans (result was unused dead code) but that endpoint is
    // now gated by commissions_plans, which a view-only commissions user
    // legitimately lacks; fetching it here would break the Records tab for
    // them for no reason.
    const employees = await this.api('GET', '/employees');
    const curPeriod = new Date().toISOString().slice(0,7);
    this._recPeriod = this._recPeriod || curPeriod;
    this._recEmp = this._recEmp || '';
    this._recStatus = this._recStatus || '';

    const params = new URLSearchParams();
    if (this._recPeriod) params.set('period', this._recPeriod);
    if (this._recEmp) params.set('employee_id', this._recEmp);
    if (this._recStatus) params.set('status', this._recStatus);
    const records = await this.api('GET', `/commissions/records?${params}`);

    const pending = records.filter(r => r.status === 'pending');
    const approved = records.filter(r => r.status === 'approved');

    el.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        <input type="month" value="${this._recPeriod}" onchange="App._recPeriod=this.value;App.renderCommTab()" style="width:160px">
        <select onchange="App._recEmp=this.value;App.renderCommTab()" style="width:180px">
          <option value="">All Salespeople</option>
          ${employees.map(e => `<option value="${e.id}" ${this._recEmp==e.id?'selected':''}>${e.first_name} ${e.last_name}</option>`).join('')}
        </select>
        <select onchange="App._recStatus=this.value;App.renderCommTab()" style="width:140px">
          <option value="">All Statuses</option>
          <option value="pending" ${this._recStatus==='pending'?'selected':''}>Pending</option>
          <option value="approved" ${this._recStatus==='approved'?'selected':''}>Approved</option>
          <option value="paid" ${this._recStatus==='paid'?'selected':''}>Paid</option>
        </select>
        <div style="margin-left:auto;display:flex;gap:6px">
          ${pending.length && this.can('commissions_approve') ? `<button class="btn btn-sm btn-primary" onclick="App.bulkApproveAll('${this._recPeriod}')">Approve All Pending (${pending.length})</button>` : ''}
          ${approved.length && this.can('commissions_pay') ? `<button class="btn btn-sm btn-success" onclick="App.bulkPayAll('${this._recPeriod}')">Pay All Approved (${approved.length})</button>` : ''}
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Date</th><th>Salesperson</th><th>Source</th><th>Reference</th>
              <th>Sale Amount</th><th>Rate</th><th>Commission</th><th>Plan</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${records.length === 0 ? `<tr><td colspan="10"><div class="empty-state">No records found</div></td></tr>` :
                records.map(r => `
                  <tr>
                    <td style="font-size:12px;white-space:nowrap">${this.fmtDate(r.created_at)}</td>
                    <td style="font-weight:600">${r.employee_name}</td>
                    <td><span style="font-size:11px;background:#f0f0f0;padding:2px 6px;border-radius:4px">${this.sourceTypeLabel(r.source_type)}</span></td>
                    <td style="font-family:monospace;font-size:12px">${r.source_ref||'—'}</td>
                    <td style="text-align:right">${this.fmt(r.sale_amount)}</td>
                    <td style="text-align:right;color:var(--text-muted)">${r.commission_rate > 0 ? r.commission_rate+'%' : '—'}</td>
                    <td style="text-align:right;font-weight:700;color:var(--success)">${this.fmt(r.commission_amount)}</td>
                    <td><span class="comm-plan-badge">${r.plan_name||'Manual'}</span></td>
                    <td>${this.commStatusBadge(r.status)}${r.approved_by_name ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;white-space:nowrap" title="Approved ${r.approved_at ? this.fmtDateTime(r.approved_at) : ''}">by ${this.escapeAttr(r.approved_by_name)}</div>` : ''}${r.approval_signature ? `<img src="${this.escapeAttr(r.approval_signature)}" alt="Approver signature" style="display:block;max-height:28px;max-width:110px;margin-top:2px;background:#fff;border-radius:3px">` : ''}</td>
                    <td style="white-space:nowrap">
                      ${r.status==='pending' && this.can('commissions_approve') ? `<button class="btn btn-sm btn-primary" onclick="App.approveRecord(${r.id})">Approve</button> ` : ''}
                      ${r.status==='approved' && this.can('commissions_pay') ? `<button class="btn btn-sm btn-success" onclick="App.payRecord(${r.id})">Pay</button> ` : ''}
                      ${r.status!=='paid' && this.can('commissions_delete') ? `<button class="btn btn-sm btn-secondary" onclick="App.deleteRecord(${r.id})">Del</button>` : ''}
                    </td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${records.length ? `<div style="padding:10px 0;display:flex;justify-content:flex-end;gap:20px;font-size:13px;font-weight:600;border-top:1px solid var(--border);margin-top:8px">
          <span style="color:var(--text-muted)">Total: ${this.fmt(records.reduce((s,r)=>s+r.commission_amount,0))}</span>
          <span style="color:var(--warning)">Pending: ${this.fmt(records.filter(r=>r.status==='pending').reduce((s,r)=>s+r.commission_amount,0))}</span>
          <span style="color:var(--success)">Paid: ${this.fmt(records.filter(r=>r.status==='paid').reduce((s,r)=>s+r.commission_amount,0))}</span>
        </div>` : ''}
      </div>`;
  },

  approveRecord(id) {
    this._showApprovalDialog({
      title: 'Approve Commission',
      intro: 'Your signature is recorded on the approved commission.',
      approve: async (signature) => {
        await this.api('PATCH', `/commissions/records/${id}/approve`, { signature });
        this.closeModal();
        this.alert('Approved');
        this.renderCommTab();
      },
    });
  },

  async payRecord(id) {
    try {
      await this.api('PATCH', `/commissions/records/${id}/pay`);
      this.alert('Marked as paid');
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteRecord(id) {
    if (!confirm('Delete this commission record?')) return;
    try {
      await this.api('DELETE', `/commissions/records/${id}`);
      this.alert('Deleted');
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async renderCommPlans(el) {
    const [plans, assignments, employees] = await Promise.all([
      this.api('GET', '/commissions/plans'),
      this.api('GET', '/commissions/assignments'),
      this.api('GET', '/employees'),
    ]);

    const typeLabel = t => ({ percentage:'% of Sale', tiered:'Tiered %', flat:'Flat Amount' }[t] || t);
    const applyLabel = a => ({ all:'All Sales', pos:'POS Only', quotes:'Quotes Only', crm:'CRM Deals Only', rentals:'Rentals Only' }[a] || a);

    el.innerHTML = `
      <div class="two-col" style="align-items:start">
        <div>
          <div class="card-header" style="margin-bottom:10px"><span class="card-title">Commission Plans</span><button class="btn btn-sm btn-primary" onclick="App.showPlanModal()">+ New Plan</button></div>
          ${plans.length === 0 ? '<div class="empty-state">No plans yet</div>' :
            plans.map(p => `
              <div class="card" style="margin-bottom:10px;opacity:${p.active?1:.6}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                  <div>
                    <div style="font-weight:700;font-size:14px">${p.name} ${!p.active?'<span style="font-size:11px;color:var(--text-muted)">(Inactive)</span>':''}</div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:3px">${typeLabel(p.type)} &bull; ${applyLabel(p.apply_to)}${p.min_sale_amount>0?' &bull; Min '+this.fmt(p.min_sale_amount):''}</div>
                    <div style="font-size:13px;font-weight:600;margin-top:4px;color:var(--accent)">
                      ${p.type==='percentage'?p.rate+'% of sale':p.type==='flat'?this.fmt(p.rate)+' per sale':this.buildTierSummary(p.tiers)}
                    </div>
                    ${p.notes?`<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${p.notes}</div>`:''}
                  </div>
                  <button class="btn btn-sm btn-outline" onclick="App.showPlanModal(${p.id})">Edit</button>
                </div>
              </div>`).join('')}
        </div>
        <div>
          <div class="card-header" style="margin-bottom:10px"><span class="card-title">Employee Assignments</span><button class="btn btn-sm btn-primary" onclick="App.showAssignModal()">+ Assign Plan</button></div>
          ${assignments.length === 0 ? '<div class="empty-state">No assignments yet</div>' :
            assignments.map(a => `
              <div class="card" style="margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div>
                    <div style="font-weight:600">${a.employee_name}</div>
                    <div style="font-size:12px;color:var(--text-muted)">${a.plan_name} &bull; from ${this.fmtDate(a.effective_from)}${a.effective_to?' to '+this.fmtDate(a.effective_to):' (ongoing)'}</div>
                    <span class="comm-plan-badge" style="margin-top:3px">${typeLabel(a.plan_type)}: ${a.plan_type==='flat'?this.fmt(a.plan_rate):a.plan_rate+'%'}</span>
                  </div>
                  <button class="btn btn-sm btn-danger" onclick="App.removeAssignment(${a.id})">Remove</button>
                </div>
              </div>`).join('')}
        </div>
      </div>`;
  },

  buildTierSummary(tiersJson) {
    try {
      const tiers = JSON.parse(tiersJson || '[]');
      return tiers.map(t => `${t.rate}% ($${t.min}–${t.max!=null?'$'+t.max:'∞'})`).join(', ');
    } catch(e) { return 'Tiered'; }
  },

  async showPlanModal(id = null) {
    const plan = id ? await this.api('GET', `/commissions/plans`).then(plans => plans.find(p => p.id === id)) : null;
    const p = plan || { type: 'percentage', rate: 5, apply_to: 'all', active: 1 };
    let tiers = [];
    try { tiers = JSON.parse(p.tiers || '[]'); } catch(e) {}
    if (!tiers.length) tiers = [{min:0,max:5000,rate:3},{min:5000,max:15000,rate:5},{min:15000,max:null,rate:7}];

    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit Plan' : 'New Commission Plan'}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Plan Name *</label><input id="cp-name" value="${p.name||''}"></div>
          <div class="input-row">
            <div class="form-group"><label>Type</label>
              <select id="cp-type" onchange="App.togglePlanTypeFields()">
                <option value="percentage" ${p.type==='percentage'?'selected':''}>% of Sale Amount</option>
                <option value="tiered" ${p.type==='tiered'?'selected':''}>Tiered (Monthly)</option>
                <option value="flat" ${p.type==='flat'?'selected':''}>Flat Amount per Sale</option>
              </select>
            </div>
            <div class="form-group"><label>Apply To</label>
              <select id="cp-apply">
                <option value="all" ${p.apply_to==='all'?'selected':''}>All Sales</option>
                <option value="pos" ${p.apply_to==='pos'?'selected':''}>POS Only</option>
                <option value="quotes" ${p.apply_to==='quotes'?'selected':''}>Quotes Only</option>
                <option value="crm" ${p.apply_to==='crm'?'selected':''}>CRM Deals Only</option>
                <option value="rentals" ${p.apply_to==='rentals'?'selected':''}>Rentals Only</option>
              </select>
            </div>
          </div>
          <div id="cp-rate-wrap" class="form-group" style="${p.type==='tiered'?'display:none':''}">
            <label id="cp-rate-lbl">${p.type==='flat'?'Flat Amount ($)':'Commission Rate (%)'}</label>
            <input id="cp-rate" type="number" value="${p.rate||0}" min="0" step="0.01">
          </div>
          <div id="cp-tiers-wrap" style="${p.type==='tiered'?'':'display:none'}">
            <label style="font-size:12px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:.3px">Tiers (cumulative monthly sales)</label>
            <div id="cp-tiers-list" style="margin-top:8px">
              ${tiers.map((t,i) => this.buildTierRow(i, t)).join('')}
            </div>
            <button class="btn btn-sm btn-outline" onclick="App.addTierRow()" style="margin-top:8px">+ Add Tier</button>
          </div>
          <div class="form-group" style="margin-top:12px"><label>Min Sale Amount</label><input id="cp-min" type="number" value="${p.min_sale_amount||0}" min="0" step="0.01" placeholder="0 = no minimum"></div>
          <div class="form-group">
            <label>Status</label>
            <select id="cp-active">
              <option value="1" ${p.active?'selected':''}>Active</option>
              <option value="0" ${!p.active?'selected':''}>Inactive</option>
            </select>
          </div>
          <div class="form-group"><label>Notes</label><textarea id="cp-notes" rows="2">${p.notes||''}</textarea></div>
        </div>
        <div class="modal-footer">
          ${id ? `<button class="btn btn-danger" onclick="App.deletePlan(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.savePlan(${id||'null'})">Save Plan</button>
        </div>
      </div>`);
  },

  buildTierRow(i, t) {
    return `<div class="tier-row" id="tier-row-${i}">
      <div class="form-group" style="flex:1;margin:0"><label style="font-size:10px">From ($)</label><input id="tier-min-${i}" type="number" value="${t.min||0}" min="0" placeholder="0"></div>
      <div class="form-group" style="flex:1;margin:0"><label style="font-size:10px">To ($, blank=∞)</label><input id="tier-max-${i}" type="number" value="${t.max!=null?t.max:''}" min="0" placeholder="∞"></div>
      <div class="form-group" style="flex:1;margin:0"><label style="font-size:10px">Rate (%)</label><input id="tier-rate-${i}" type="number" value="${t.rate||0}" min="0" step="0.01"></div>
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('tier-row-${i}').remove()" style="margin-top:14px">✕</button>
    </div>`;
  },

  addTierRow() {
    const list = document.getElementById('cp-tiers-list');
    const i = list.children.length;
    const prev = list.lastElementChild;
    let min = 0;
    if (prev) { const prevMax = prev.querySelector(`[id^="tier-max-"]`); min = parseFloat(prevMax?.value)||0; }
    list.insertAdjacentHTML('beforeend', this.buildTierRow(i, {min, max:null, rate:0}));
  },

  togglePlanTypeFields() {
    const type = document.getElementById('cp-type').value;
    const rateWrap = document.getElementById('cp-rate-wrap');
    const tiersWrap = document.getElementById('cp-tiers-wrap');
    const rateLbl = document.getElementById('cp-rate-lbl');
    if (type === 'tiered') { rateWrap.style.display = 'none'; tiersWrap.style.display = ''; }
    else { rateWrap.style.display = ''; tiersWrap.style.display = 'none'; rateLbl.textContent = type === 'flat' ? 'Flat Amount ($)' : 'Commission Rate (%)'; }
  },

  collectTiers() {
    const list = document.getElementById('cp-tiers-list');
    if (!list) return null;
    const tiers = [];
    for (const row of list.children) {
      const minEl = row.querySelector('[id^="tier-min-"]');
      const maxEl = row.querySelector('[id^="tier-max-"]');
      const rateEl = row.querySelector('[id^="tier-rate-"]');
      if (!minEl) continue;
      tiers.push({ min: parseFloat(minEl.value)||0, max: maxEl.value !== '' ? parseFloat(maxEl.value) : null, rate: parseFloat(rateEl.value)||0 });
    }
    return JSON.stringify(tiers);
  },

  async savePlan(id) {
    const type = document.getElementById('cp-type').value;
    const data = {
      name: document.getElementById('cp-name').value.trim(),
      type,
      rate: parseFloat(document.getElementById('cp-rate')?.value||0) || 0,
      tiers: type === 'tiered' ? this.collectTiers() : null,
      apply_to: document.getElementById('cp-apply').value,
      min_sale_amount: parseFloat(document.getElementById('cp-min').value)||0,
      active: parseInt(document.getElementById('cp-active').value),
      notes: document.getElementById('cp-notes').value.trim() || null,
    };
    if (!data.name) return this.alert('Plan name required', 'error');
    try {
      if (id) await this.api('PUT', `/commissions/plans/${id}`, data);
      else await this.api('POST', '/commissions/plans', data);
      this.alert('Plan saved');
      this.closeModal();
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deletePlan(id) {
    if (!confirm('Delete this commission plan?')) return;
    try {
      await this.api('DELETE', `/commissions/plans/${id}`);
      this.alert('Plan deleted');
      this.closeModal();
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showAssignModal() {
    const [plans, employees] = await Promise.all([
      this.api('GET', '/commissions/plans'),
      this.api('GET', '/employees'),
    ]);
    const today = new Date().toISOString().split('T')[0];
    const activePlans = plans.filter(p => p.active);
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header">
          <span class="modal-title">Assign Commission Plan</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Employee *</label>
            <select id="asgn-emp">
              ${employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Commission Plan *</label>
            <select id="asgn-plan">
              ${activePlans.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
            </select>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Effective From *</label><input id="asgn-from" type="date" value="${today}"></div>
            <div class="form-group"><label>Effective To (blank = ongoing)</label><input id="asgn-to" type="date"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveCommissionAssignment()">Assign</button>
        </div>
      </div>`);
  },

  async saveCommissionAssignment() {
    const data = {
      employee_id: document.getElementById('asgn-emp').value,
      plan_id: document.getElementById('asgn-plan').value,
      effective_from: document.getElementById('asgn-from').value,
      effective_to: document.getElementById('asgn-to').value || null,
    };
    if (!data.employee_id) return this.alert('Employee required', 'error');
    if (!data.plan_id) return this.alert('Commission plan required', 'error');
    if (!data.effective_from) return this.alert('Effective from date required', 'error');
    try {
      await this.api('POST', '/commissions/assignments', data);
      this.alert('Plan assigned to employee');
      this.closeModal();
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async removeAssignment(id) {
    if (!confirm('Remove this commission plan assignment?')) return;
    try {
      await this.api('DELETE', `/commissions/assignments/${id}`);
      this.alert('Assignment removed');
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showManualCommModal() {
    const employees = await this.api('GET', '/employees');
    const curPeriod = new Date().toISOString().slice(0,7);
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header">
          <span class="modal-title">Manual Commission Entry</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Employee *</label>
            <select id="mc-emp">
              ${employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Sale Amount</label><input id="mc-sale" type="number" value="0" min="0" step="0.01"></div>
            <div class="form-group"><label>Commission Amount *</label><input id="mc-comm" type="number" value="0" min="0" step="0.01"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Reference</label><input id="mc-ref" placeholder="e.g. Invoice #, Deal name"></div>
            <div class="form-group"><label>Period</label><input id="mc-period" type="month" value="${curPeriod}"></div>
          </div>
          <div class="form-group"><label>Notes</label><textarea id="mc-notes" rows="2" placeholder="Reason for manual entry..."></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveManualComm()">Add Entry</button>
        </div>
      </div>`);
  },

  async saveManualComm() {
    const data = {
      employee_id: document.getElementById('mc-emp').value,
      sale_amount: parseFloat(document.getElementById('mc-sale').value)||0,
      commission_amount: parseFloat(document.getElementById('mc-comm').value)||0,
      source_ref: document.getElementById('mc-ref').value.trim() || 'Manual entry',
      period: document.getElementById('mc-period').value,
      notes: document.getElementById('mc-notes').value.trim() || null,
    };
    if (!data.commission_amount) return this.alert('Commission amount required', 'error');
    try {
      await this.api('POST', '/commissions/records', data);
      this.alert('Commission entry added');
      this.closeModal();
      this.commTab = 'records';
      this.renderCommTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

});
