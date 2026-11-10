// CRM and salesperson targets.
Object.assign(App, {
  // ─── CRM ─────────────────────────────────────────────────
  crmTab: 'overview',

  async renderCRM() {
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>CRM &amp; Sales ${this.currentUser.is_salesperson ? '<span style="font-size:12px;font-weight:normal;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;padding:2px 8px;margin-left:8px;vertical-align:middle">My Leads &amp; Deals Only</span>' : ''}</h2>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="App.showLeadModal()">+ New Lead</button>
          <button class="btn btn-outline btn-sm" onclick="App.showActivityModal()">+ Activity</button>
        </div>
      </div>
      <div class="crm-tabs" id="crm-tabs-nav">
        <button class="crm-tab ${this.crmTab==='overview'?'active':''}" onclick="App.switchCrmTab('overview')">Overview</button>
        <button class="crm-tab ${this.crmTab==='leads'?'active':''}" onclick="App.switchCrmTab('leads')">Leads</button>
        <button class="crm-tab ${this.crmTab==='pipeline'?'active':''}" onclick="App.switchCrmTab('pipeline')">Pipeline</button>
        <button class="crm-tab ${this.crmTab==='activities'?'active':''}" onclick="App.switchCrmTab('activities')">Activities</button>
        <button class="crm-tab ${this.crmTab==='targets'?'active':''}" onclick="App.switchCrmTab('targets')">Targets</button>
      </div>
      <div id="crm-tab-content"></div>`;
    await this.renderCrmTab();
  },

  switchCrmTab(tab) {
    this.crmTab = tab;
    document.querySelectorAll('#crm-tabs-nav .crm-tab').forEach(btn => {
      const t = btn.getAttribute('onclick').match(/switchCrmTab\('(\w+)'\)/)?.[1];
      btn.classList.toggle('active', t === tab);
    });
    this.renderCrmTab();
  },

  async renderCrmTab() {
    const el = document.getElementById('crm-tab-content');
    if (!el) return;
    if (this.crmTab === 'overview') await this.renderCrmOverview(el);
    else if (this.crmTab === 'leads') await this.renderCrmLeads(el);
    else if (this.crmTab === 'pipeline') await this.renderCrmPipeline(el);
    else if (this.crmTab === 'activities') await this.renderCrmActivities(el);
    else if (this.crmTab === 'targets') await this.renderCrmTargets(el);
  },

  crmStatusLabel(s) {
    const map = { new:'New', contacted:'Contacted', qualified:'Qualified', proposal:'Proposal', negotiation:'Negotiation', won:'Won', lost:'Lost' };
    return map[s] || s;
  },

  crmStageLabel(s) {
    const map = { qualification:'Qualification', proposal:'Proposal', negotiation:'Negotiation', closed_won:'Closed Won', closed_lost:'Closed Lost' };
    return map[s] || s;
  },

  activityIcon(type) {
    const icons = { call:'📞', email:'✉️', meeting:'📅', task:'✅', note:'📝', rental:'🔑' };
    return icons[type] || '📌';
  },

  activityDueClass(due, completed) {
    if (completed) return '';
    if (!due) return '';
    const d = this._toDate(due), now = new Date();
    if (d < now) return 'overdue';
    const diff = (d - now) / 86400000;
    return diff <= 1 ? 'today' : 'upcoming';
  },

  fmtDue(due) {
    if (!due) return '—';
    const d = this._toDate(due);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone: this._storeTz() });
  },

  // ─── Salesperson Targets ────────────────────────────────────────────────
  // A single ratio against a limit (current sales / target) is a meter, not
  // a bar/line chart: the fill carries severity (danger below 50%, warning
  // 50–99%, success at/over 100%) and the unfilled track is a lighter tint
  // of that same hue rather than a neutral gray, so status reads at a
  // glance without needing the number. No legend needed — each meter is a
  // single series, self-labeled by its own period name and figures.
  _targetMeterHtml(label, current, target) {
    if (!target || target <= 0) {
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
          <span style="font-weight:600">${label}</span>
          <span style="color:var(--text-muted)">No target set</span>
        </div>
        <div style="background:var(--bg-secondary,#eee);border-radius:4px;height:18px"></div>
      </div>`;
    }
    const pct = Math.round(current / target * 100);
    const barPct = Math.min(100, Math.max(0, pct));
    const c = pct >= 100 ? { fill: 'var(--success)', track: '#E8F5E9' } : pct >= 50 ? { fill: 'var(--warning)', track: '#FFF3E0' } : { fill: 'var(--danger)', track: '#FFEBEE' };
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span style="font-weight:600">${label}</span>
        <span style="color:var(--text-muted)">${this.fmt(current)} / ${this.fmt(target)} <strong style="color:${c.fill}">(${pct}%)</strong></span>
      </div>
      <div style="background:${c.track};border-radius:4px;height:18px;overflow:hidden">
        <div style="width:${barPct}%;background:${c.fill};height:100%;border-radius:4px;transition:width .4s"></div>
      </div>
    </div>`;
  },

  async renderCrmTargets(el) {
    let data = [];
    try { data = await this.api('GET', '/sales-targets'); }
    catch(e) { el.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; return; }
    const canManage = this.can('sales_manager');
    el.innerHTML = `
      ${canManage ? `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">Set Targets</span></div>
        ${!data.length ? '<p style="padding:14px;color:var(--text-muted);font-size:13px">No employees flagged as a Salesperson yet — see Employees.</p>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Salesperson</th><th>Hourly</th><th>Daily</th><th>Weekly</th><th>Monthly</th><th></th></tr></thead>
            <tbody>${data.map(e => `
              <tr>
                <td class="fw-600">${e.employee_name}</td>
                <td><input type="number" min="0" step="0.01" id="tgt-hourly-${e.id}" value="${e.hourly_target}" style="width:90px"></td>
                <td><input type="number" min="0" step="0.01" id="tgt-daily-${e.id}" value="${e.daily_target}" style="width:90px"></td>
                <td><input type="number" min="0" step="0.01" id="tgt-weekly-${e.id}" value="${e.weekly_target}" style="width:100px"></td>
                <td><input type="number" min="0" step="0.01" id="tgt-monthly-${e.id}" value="${e.monthly_target}" style="width:100px"></td>
                <td><button class="btn btn-sm btn-primary" onclick="App.saveSalesTarget(${e.id})">Save</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
      </div>` : ''}
      ${!data.length ? (canManage ? '' : `<div class="empty-state"><p>${this.currentUser.is_salesperson || this.can('reports')
        ? 'No sales targets to show yet.'
        : 'Sales targets show to each salesperson (their own) and to sales managers.'}</p></div>`) : `
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
        ${data.map(e => `
          <div class="card">
            <div class="card-header"><span class="card-title">${e.employee_name}</span></div>
            ${this._targetMeterHtml('Hourly', e.hourly_sales, e.hourly_target)}
            ${this._targetMeterHtml('Daily', e.daily_sales, e.daily_target)}
            ${this._targetMeterHtml('Weekly', e.weekly_sales, e.weekly_target)}
            ${this._targetMeterHtml('Monthly', e.monthly_sales, e.monthly_target)}
          </div>`).join('')}
      </div>`}`;
  },

  async saveSalesTarget(employeeId) {
    const hourly_target = document.getElementById(`tgt-hourly-${employeeId}`).value;
    const daily_target = document.getElementById(`tgt-daily-${employeeId}`).value;
    const weekly_target = document.getElementById(`tgt-weekly-${employeeId}`).value;
    const monthly_target = document.getElementById(`tgt-monthly-${employeeId}`).value;
    try {
      await this.api('PUT', `/sales-targets/${employeeId}`, { hourly_target, daily_target, weekly_target, monthly_target });
      this.alert('Targets saved');
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async renderCrmOverview(el) {
    const dash = await this.api('GET', '/crm/dashboard');
    const statusOrder = ['new','contacted','qualified','proposal','negotiation','won','lost'];
    const byStatus = {};
    dash.leadsByStatus.forEach(r => { byStatus[r.status] = r; });
    const total = dash.leadsByStatus.reduce((s, r) => s + r.count, 0);
    const maxCount = Math.max(...statusOrder.map(s => byStatus[s]?.count || 0), 1);
    const funnelColors = { new:'#2196F3', contacted:'#7986CB', qualified:'#26A69A', proposal:'#FFA726', negotiation:'#EF5350', won:'#4CAF50', lost:'#9E9E9E' };

    const stageOrder = ['qualification','proposal','negotiation'];
    const byStage = {};
    dash.oppsByStage.forEach(r => { byStage[r.stage] = r; });

    el.innerHTML = `
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat-card blue"><div class="stat-label">Total Leads</div><div class="stat-value">${total}</div><div class="stat-sub">Conversion: ${dash.conversionRate}%</div></div>
        <div class="stat-card green"><div class="stat-label">Pipeline Value</div><div class="stat-value">${this.fmt(dash.pipelineTotal.total)}</div><div class="stat-sub">Active opportunities</div></div>
        <div class="stat-card purple"><div class="stat-label">Won This Month</div><div class="stat-value">${dash.wonThisMonth.count}</div><div class="stat-sub">${this.fmt(dash.wonThisMonth.value)}</div></div>
        <div class="stat-card orange"><div class="stat-label">Overdue Tasks</div><div class="stat-value">${dash.overdueActivities.count}</div><div class="stat-sub">Need attention</div></div>
      </div>
      <div class="two-col" style="margin-bottom:16px">
        <div class="card">
          <div class="card-header"><span class="card-title">Lead Funnel</span></div>
          ${statusOrder.map(s => {
            const r = byStatus[s] || { count: 0, value: 0 };
            const pct = Math.max(Math.round((r.count / maxCount) * 100), 4);
            return `<div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
                <span style="font-weight:600">${this.crmStatusLabel(s)}</span>
                <span style="color:var(--text-muted)">${r.count} lead${r.count!==1?'s':''} &bull; ${this.fmt(r.value)}</span>
              </div>
              <div style="background:#f0f0f0;border-radius:4px;height:20px;overflow:hidden">
                <div style="width:${pct}%;background:${funnelColors[s]};height:100%;border-radius:4px;transition:width .4s"></div>
              </div></div>`;
          }).join('')}
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Active Pipeline</span></div>
          ${stageOrder.map(s => {
            const r = byStage[s] || { count: 0, value: 0 };
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
              <div>
                <div style="font-weight:600;font-size:13px">${this.crmStageLabel(s)}</div>
                <div style="font-size:11px;color:var(--text-muted)">${r.count} deal${r.count!==1?'s':''}</div>
              </div>
              <div style="font-size:15px;font-weight:700;color:var(--accent)">${this.fmt(r.value)}</div>
            </div>`;
          }).join('')}
          <div style="display:flex;justify-content:space-between;padding-top:10px;font-weight:700">
            <span>Total Pipeline</span><span style="color:var(--success)">${this.fmt(dash.pipelineTotal.total)}</span>
          </div>
        </div>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header"><span class="card-title">Upcoming Activities</span><button class="btn btn-sm btn-outline" onclick="App.switchCrmTab('activities')">View All</button></div>
          ${dash.upcomingActivities.length === 0 ? '<div class="empty-state" style="padding:20px"><p>No upcoming activities</p></div>' :
            dash.upcomingActivities.map(a => {
              const dueClass = this.activityDueClass(a.due_date, a.completed);
              return `<div class="activity-item">
                <div class="activity-icon ${a.type}">${this.activityIcon(a.type)}</div>
                <div class="activity-info">
                  <div class="activity-subject">${a.subject}</div>
                  <div class="activity-meta">${a.lead_name ? (a.lead_company ? a.lead_company + ' — ' : '') + a.lead_name : (a.customer_name || a.employee_name || '')}</div>
                </div>
                <div class="activity-due ${dueClass}">${this.fmtDue(a.due_date)}</div>
              </div>`;
            }).join('')}
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Recent Leads</span><button class="btn btn-sm btn-outline" onclick="App.switchCrmTab('leads')">View All</button></div>
          ${dash.recentLeads.length === 0 ? '<div class="empty-state" style="padding:20px"><p>No leads yet</p></div>' :
            dash.recentLeads.map(l => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="App.viewLead(${l.id})">
                <div>
                  <div style="font-weight:600;font-size:13px">${l.first_name} ${l.last_name}${l.company?' — '+l.company:''}</div>
                  <div style="font-size:11px;color:var(--text-muted)">${l.assigned_name || 'Unassigned'} &bull; ${this.fmtDate(l.created_at)}</div>
                </div>
                <span class="badge-pill lead-status-${l.status}">${this.crmStatusLabel(l.status)}</span>
              </div>`).join('')}
        </div>
      </div>`;
  },

  async renderCrmLeads(el) {
    const [leads, employees] = await Promise.all([
      this.api('GET', '/crm/leads'),
      this.api('GET', '/employees'),
    ]);
    el.innerHTML = `
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <div class="search-bar" style="flex:1;min-width:200px">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" id="crm-lead-search" placeholder="Search leads..." oninput="App.filterCrmLeads()" style="padding-left:34px">
        </div>
        <select id="crm-lead-status" onchange="App.filterCrmLeads()" style="width:160px">
          <option value="">All Statuses</option>
          <option value="new">New</option>
          <option value="contacted">Contacted</option>
          <option value="qualified">Qualified</option>
          <option value="proposal">Proposal</option>
          <option value="negotiation">Negotiation</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </select>
        <select id="crm-lead-assigned" onchange="App.filterCrmLeads()" style="width:160px">
          <option value="">All Salespeople</option>
          ${employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
        </select>
        <select id="crm-lead-sort" onchange="App.filterCrmLeads()" style="width:160px">
          <option value="newest">Newest First</option>
          <option value="name_asc">Name (A-Z)</option>
          <option value="name_desc">Name (Z-A)</option>
        </select>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Lead #</th><th>Name / Company</th><th>Contact</th><th>Source</th>
              <th>Est. Value</th><th>Status</th><th>Assigned To</th><th>Activities</th><th>Actions</th>
            </tr></thead>
            <tbody id="crm-leads-tbody">
              ${this.buildLeadRows(leads)}
            </tbody>
          </table>
        </div>
      </div>`;
    this._crmAllLeads = leads;
  },

  buildLeadRows(leads) {
    if (!leads.length) return `<tr><td colspan="9"><div class="empty-state">No leads found</div></td></tr>`;
    const sourceLabel = s => ({ website:'Website', referral:'Referral', cold_call:'Cold Call', trade_show:'Trade Show', social_media:'Social Media', email_campaign:'Email', walk_in:'Walk-in', bid:'Bid', other:'Other' }[s] || s);
    return leads.map(l => `
      <tr>
        <td style="font-family:monospace;font-size:12px">${l.lead_number}</td>
        <td><div style="font-weight:600">${l.first_name} ${l.last_name}</div>${l.company?`<div style="font-size:11px;color:var(--text-muted)">${l.company}</div>`:''}</td>
        <td><div style="font-size:12px">${l.email||''}</div><div style="font-size:12px;color:var(--text-muted)">${l.phone||''}</div></td>
        <td style="font-size:12px">${sourceLabel(l.source)}</td>
        <td style="font-weight:600">${this.fmt(l.estimated_value)}</td>
        <td><span class="badge-pill lead-status-${l.status}">${this.crmStatusLabel(l.status)}</span></td>
        <td style="font-size:12px">${l.assigned_name||'—'}</td>
        <td style="text-align:center"><span class="badge" style="background:${l.open_activities>0?'var(--warning)':'#e0e0e0'};color:${l.open_activities>0?'#fff':'var(--text-muted)'}">${l.open_activities}</span></td>
        <td>
          <button class="btn btn-sm btn-outline" onclick="App.viewLead(${l.id})">View</button>
          <button class="btn btn-sm btn-secondary" onclick="App.showLeadModal(${l.id})" style="margin-left:4px">Edit</button>
        </td>
      </tr>`).join('');
  },

  filterCrmLeads() {
    const search = (document.getElementById('crm-lead-search')?.value||'').toLowerCase();
    const status = document.getElementById('crm-lead-status')?.value||'';
    const assignedTo = document.getElementById('crm-lead-assigned')?.value||'';
    const sort = document.getElementById('crm-lead-sort')?.value||'newest';
    const filtered = (this._crmAllLeads||[]).filter(l => {
      if (status && l.status !== status) return false;
      if (assignedTo && String(l.assigned_to) !== assignedTo) return false;
      if (search && !`${l.first_name} ${l.last_name} ${l.company||''} ${l.email||''}`.toLowerCase().includes(search)) return false;
      return true;
    });
    if (sort === 'name_asc' || sort === 'name_desc') {
      filtered.sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
      if (sort === 'name_desc') filtered.reverse();
    }
    const tbody = document.getElementById('crm-leads-tbody');
    if (tbody) tbody.innerHTML = this.buildLeadRows(filtered);
  },

  async renderCrmPipeline(el) {
    const opps = await this.api('GET', '/crm/opportunities');
    const stages = ['qualification','proposal','negotiation','closed_won','closed_lost'];
    const stageColors = { qualification:'#2196F3', proposal:'#FF9800', negotiation:'#9C27B0', closed_won:'#4CAF50', closed_lost:'#9E9E9E' };
    const grouped = {};
    stages.forEach(s => { grouped[s] = []; });
    opps.forEach(o => { if (grouped[o.stage]) grouped[o.stage].push(o); });

    el.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn btn-primary btn-sm" onclick="App.showOppModal()">+ New Opportunity</button>
      </div>
      <div class="pipeline-wrap">
        ${stages.map(s => {
          const list = grouped[s];
          const total = list.reduce((sum, o) => sum + o.value, 0);
          return `
            <div class="pipeline-col">
              <div class="pipeline-col-header">
                <span style="color:${stageColors[s]}">${this.crmStageLabel(s)}</span>
                <span style="font-size:11px;color:var(--text-muted);font-weight:400">${this.fmt(total)}</span>
              </div>
              ${list.map(o => `
                <div class="pipeline-card" onclick="App.viewOpp(${o.id})">
                  <div class="pipeline-card-title">${o.title}</div>
                  <div class="pipeline-card-sub">${o.lead_name||o.customer_name||'—'}</div>
                  ${o.lead_company?`<div class="pipeline-card-sub">${o.lead_company}</div>`:''}
                  ${o.lead_type?`<div class="pipeline-card-sub">Lead: ${this.escapeAttr(o.lead_type)}</div>`:''}
                  <div class="pipeline-card-value">${this.fmt(o.value)}</div>
                  <div style="display:flex;justify-content:space-between;margin-top:6px">
                    <span style="font-size:11px;color:var(--text-muted)">${o.probability}% likely</span>
                    ${o.expected_close?`<span style="font-size:11px;color:var(--text-muted)">${this.fmtDate(o.expected_close)}</span>`:''}
                  </div>
                </div>`).join('')}
              ${list.length===0?`<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:12px">Empty</div>`:''}
            </div>`;
        }).join('')}
      </div>`;
  },

  async renderCrmActivities(el) {
    const [acts, employees] = await Promise.all([
      this.api('GET', '/crm/activities'),
      this.api('GET', '/employees'),
    ]);
    const now = new Date();
    const overdue = acts.filter(a => !a.completed && a.due_date && this._toDate(a.due_date) < now);
    const upcoming = acts.filter(a => !a.completed && (!a.due_date || this._toDate(a.due_date) >= now));
    const done = acts.filter(a => a.completed);

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm ${this._actFilter!=='done'?'btn-primary':'btn-secondary'}" onclick="App.setActFilter('open')">Open (${overdue.length+upcoming.length})</button>
          <button class="btn btn-sm ${this._actFilter==='done'?'btn-primary':'btn-secondary'}" onclick="App.setActFilter('done')">Completed (${done.length})</button>
        </div>
        <button class="btn btn-primary btn-sm" onclick="App.showActivityModal()">+ New Activity</button>
      </div>
      <div id="act-list-wrap">
        ${this._actFilter === 'done' ? this.buildActList(done, employees) : `
          ${overdue.length ? `<div style="margin-bottom:4px"><span style="font-size:12px;font-weight:700;color:var(--danger);text-transform:uppercase">Overdue (${overdue.length})</span></div>
          <div class="card" style="margin-bottom:12px">${this.buildActItems(overdue)}</div>` : ''}
          ${upcoming.length ? `<div style="margin-bottom:4px"><span style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase">Upcoming (${upcoming.length})</span></div>
          <div class="card">${this.buildActItems(upcoming)}</div>` : ''}
          ${!overdue.length && !upcoming.length ? '<div class="empty-state"><p>No open activities</p></div>' : ''}
        `}
      </div>`;
    this._crmAllActivities = acts;
  },

  setActFilter(f) { this._actFilter = f; this.renderCrmActivities(document.getElementById('crm-tab-content')); },

  buildActList(acts, employees) {
    if (!acts.length) return '<div class="empty-state"><p>No completed activities</p></div>';
    return `<div class="card">${this.buildActItems(acts)}</div>`;
  },

  buildActItems(acts) {
    return acts.map(a => {
      const dueClass = this.activityDueClass(a.due_date, a.completed);
      const context = a.lead_name ? (a.lead_company ? a.lead_company + ' — ' : '') + a.lead_name : (a.opp_title || a.customer_name || a.employee_name || '');
      return `
        <div class="activity-item">
          <div class="activity-icon ${a.type}">${this.activityIcon(a.type)}</div>
          <div class="activity-info">
            <div class="activity-subject" style="${a.completed?'text-decoration:line-through;color:var(--text-muted)':''}">${a.subject}</div>
            <div class="activity-meta">${a.type.toUpperCase()}${context?' &bull; '+context:''}</div>
            ${a.description?`<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${a.description}</div>`:''}
            ${a.outcome?`<div style="font-size:12px;color:var(--success);margin-top:2px">Outcome: ${a.outcome}</div>`:''}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
            ${a.due_date?`<div class="activity-due ${dueClass}">${this.fmtDue(a.due_date)}</div>`:''}
            ${!a.completed ? `<button class="btn btn-sm btn-success" onclick="App.completeActivity(${a.id})">Done</button>` : `<span style="font-size:11px;color:var(--success)">Completed</span>`}
            <button class="btn btn-sm btn-secondary" onclick="App.deleteActivity(${a.id})">Del</button>
          </div>
        </div>`;
    }).join('');
  },

  // ─── CRM Modals ───────────────────────────────────────────
  async showLeadModal(id = null) {
    const [employees, lead] = await Promise.all([
      this.api('GET', '/employees'),
      id ? this.api('GET', `/crm/leads/${id}`) : Promise.resolve(null),
    ]);
    const l = lead || {};
    const sources = ['website','referral','cold_call','trade_show','social_media','email_campaign','walk_in','bid','other'];
    const statuses = ['new','contacted','qualified','proposal','negotiation','won','lost'];
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit Lead' : 'New Lead'}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>First Name *</label><input id="l-fn" value="${l.first_name||''}"></div>
            <div class="form-group"><label>Last Name *</label><input id="l-ln" value="${l.last_name||''}"></div>
          </div>
          <div class="form-group"><label>Company</label><input id="l-co" value="${l.company||''}"></div>
          <div class="input-row">
            <div class="form-group"><label>Email</label><input id="l-em" type="email" value="${l.email||''}"></div>
            <div class="form-group"><label>Phone</label><input id="l-ph" value="${l.phone||''}"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Source</label>
              <select id="l-src">${sources.map(s => `<option value="${s}" ${l.source===s?'selected':''}>${{website:'Website',referral:'Referral',cold_call:'Cold Call',trade_show:'Trade Show',social_media:'Social Media',email_campaign:'Email Campaign',walk_in:'Walk-in',bid:'Bid',other:'Other'}[s]}</option>`).join('')}</select>
            </div>
            <div class="form-group"><label>Status</label>
              <select id="l-st">${statuses.map(s => `<option value="${s}" ${(l.status||'new')===s?'selected':''}>${this.crmStatusLabel(s)}</option>`).join('')}</select>
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Estimated Value</label><input id="l-val" type="number" value="${l.estimated_value||0}" min="0" step="0.01"></div>
            <div class="form-group"><label>Assigned To</label>
              <select id="l-emp">
                <option value="">Unassigned</option>
                ${employees.map(e => `<option value="${e.id}" ${l.assigned_to===e.id?'selected':''}>${e.first_name} ${e.last_name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>Notes</label><textarea id="l-notes" rows="3">${l.notes||''}</textarea></div>
        </div>
        <div class="modal-footer">
          ${id && !l.customer_id ? `<button class="btn btn-success" onclick="App.convertLead(${id})">Convert to Customer</button>` : ''}
          ${id ? `<button class="btn btn-danger" onclick="App.deleteLead(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveLead(${id||'null'})">Save Lead</button>
        </div>
      </div>`);
  },

  async saveLead(id) {
    const data = {
      first_name: document.getElementById('l-fn').value.trim(),
      last_name: document.getElementById('l-ln').value.trim(),
      company: document.getElementById('l-co').value.trim() || null,
      email: document.getElementById('l-em').value.trim() || null,
      phone: document.getElementById('l-ph').value.trim() || null,
      source: document.getElementById('l-src').value,
      status: document.getElementById('l-st').value,
      estimated_value: parseFloat(document.getElementById('l-val').value) || 0,
      assigned_to: document.getElementById('l-emp').value || null,
      notes: document.getElementById('l-notes').value.trim() || null,
    };
    if (!data.first_name || !data.last_name) return this.alert('First and last name required', 'error');
    try {
      if (id) await this.api('PUT', `/crm/leads/${id}`, data);
      else await this.api('POST', '/crm/leads', data);
      this.alert('Lead saved');
      this.closeModal();
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteLead(id) {
    if (!confirm('Delete this lead and all its activities?')) return;
    try {
      await this.api('DELETE', `/crm/leads/${id}`);
      this.alert('Lead deleted');
      this.closeModal();
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async convertLead(id, opts = {}) {
    if (!opts.force && !opts.link_customer_id && !confirm('Convert this lead to a customer record?')) return;
    try {
      const res = await this.api('POST', `/crm/leads/${id}/convert`, opts);
      this.alert(`${opts.link_customer_id ? 'Linked to' : 'Converted to'} customer ${res.customer.customer_number}`);
      this.closeModal();
      this.renderCrmTab();
    } catch(e) {
      if (e.status === 409 && e.data && e.data.matches) return this.showLeadDuplicateModal(id, e.data.matches, !!e.data.blocking);
      this.alert(e.message, 'error');
    }
  },

  // Shown when converting a lead would create a customer that matches an
  // existing one by email, phone, or name — lets the user link to the
  // existing record instead of creating a duplicate.
  showLeadDuplicateModal(leadId, matches, blocking = false) {
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header">
          <span class="modal-title">Possible Duplicate Customer</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <p>${blocking ? "This lead's contact number or email already belongs to an existing customer. Link the lead to that customer — a second customer with the same contact details can't be created." : 'A customer with the same name, phone, or email already exists. Link this lead to an existing customer instead of creating a duplicate?'}</p>
          <div style="display:flex;flex-direction:column;gap:8px;margin:12px 0">
            ${matches.map(c => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border:1px solid var(--border);border-radius:6px">
                <div>
                  <div><strong>${c.first_name} ${c.last_name}</strong> (${c.customer_number})</div>
                  <div style="font-size:12px;color:var(--text-muted)">${c.email || ''} ${c.phone ? '· ' + c.phone : ''}</div>
                </div>
                <button class="btn btn-outline btn-sm" onclick="App.convertLead(${leadId}, {link_customer_id:${c.id}})">Link</button>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.closeModal()">Cancel</button>
          ${blocking ? '' : `<button class="btn btn-danger" onclick="App.convertLead(${leadId}, {force:true})">Create New Customer Anyway</button>`}
        </div>
      </div>
    `);
  },

  async viewLead(id) {
    const lead = await this.api('GET', `/crm/leads/${id}`);
    const statusColors = { new:'info', contacted:'info', qualified:'teal', proposal:'warning', negotiation:'warning', won:'success', lost:'danger' };
    const sourceLabel = s => ({ website:'Website',referral:'Referral',cold_call:'Cold Call',trade_show:'Trade Show',social_media:'Social Media',email_campaign:'Email Campaign',walk_in:'Walk-in',bid:'Bid',other:'Other' }[s]||s);
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">${lead.lead_number} — ${lead.first_name} ${lead.last_name}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
            <span class="badge-pill badge-${statusColors[lead.status]||'info'}">${this.crmStatusLabel(lead.status)}</span>
            ${lead.company?`<span style="font-size:13px;font-weight:600">${lead.company}</span>`:''}
            <span style="font-size:13px;color:var(--text-muted)">${sourceLabel(lead.source)}</span>
            <span style="font-size:13px;font-weight:700;color:var(--success)">${this.fmt(lead.estimated_value)}</span>
          </div>
          <div class="input-row" style="margin-bottom:12px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Email</label><div style="font-size:13px">${lead.email||'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Phone</label><div style="font-size:13px">${lead.phone||'—'}</div></div>
          </div>
          <div class="input-row" style="margin-bottom:12px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Assigned To</label><div style="font-size:13px">${lead.assigned_name||'Unassigned'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Created</label><div style="font-size:13px">${this.fmtDate(lead.created_at)}</div></div>
          </div>
          ${lead.notes?`<div style="margin-bottom:16px"><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Notes</label><div style="font-size:13px;padding:8px;background:#f9f9f9;border-radius:4px;margin-top:4px">${lead.notes}</div></div>`:''}

          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <strong style="font-size:14px">Activities (${lead.activities.length})</strong>
            <button class="btn btn-sm btn-outline" onclick="App.showActivityModal(${lead.id},null)">+ Add Activity</button>
          </div>
          <div style="max-height:220px;overflow-y:auto">
            ${lead.activities.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px">No activities yet</div>' :
              lead.activities.map(a => `
                <div class="activity-item">
                  <div class="activity-icon ${a.type}">${this.activityIcon(a.type)}</div>
                  <div class="activity-info">
                    <div class="activity-subject" style="${a.completed?'text-decoration:line-through;color:var(--text-muted)':''}">${a.subject}</div>
                    <div class="activity-meta">${a.type.toUpperCase()}${a.due_date?' &bull; '+this.fmtDue(a.due_date):''}</div>
                    ${a.outcome?`<div style="font-size:12px;color:var(--success)">Outcome: ${a.outcome}</div>`:''}
                  </div>
                  ${!a.completed?`<button class="btn btn-sm btn-success" onclick="App.completeActivityAndRefreshLead(${a.id},${lead.id})">Done</button>`:'<span style="font-size:11px;color:var(--success)">Done</span>'}
                </div>`).join('')}
          </div>

          ${lead.opportunities.length ? `
            <div style="margin-top:16px"><strong style="font-size:14px">Opportunities (${lead.opportunities.length})</strong></div>
            ${lead.opportunities.map(o => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="App.viewOpp(${o.id})">
                <div>
                  <div style="font-weight:600;font-size:13px">${o.title}</div>
                  <div style="font-size:11px;color:var(--text-muted)">${this.crmStageLabel(o.stage)} &bull; ${o.probability}%</div>
                </div>
                <div style="font-weight:700;color:var(--accent)">${this.fmt(o.value)}</div>
              </div>`).join('')}
          ` : ''}
        </div>
        <div class="modal-footer">
          ${!lead.customer_id ? `<button class="btn btn-success" onclick="App.convertLead(${lead.id})">Convert to Customer</button>` : `<span style="font-size:12px;color:var(--success)">Converted: ${lead.customer_number}</span>`}
          <button class="btn btn-outline" onclick="App.showLeadModal(${lead.id})">Edit</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async completeActivityAndRefreshLead(actId, leadId) {
    const outcome = prompt('Outcome / notes (optional):') || null;
    try {
      await this.api('PATCH', `/crm/activities/${actId}/complete`, { outcome });
      this.alert('Activity completed');
      this.viewLead(leadId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // "+ Add" on the opportunity form's Lead list (_searchableSelect data-add).
  async _addLeadType(name) {
    const t = await this.api('POST', '/crm/lead-types', { name });
    return { value: t.name, text: t.name };
  },

  async showOppModal(id = null) {
    const [employees, leadTypeRows, opp] = await Promise.all([
      this.api('GET', '/employees'),
      this.api('GET', '/crm/lead-types').catch(() => []),
      id ? this.api('GET', `/crm/opportunities/${id}`) : Promise.resolve(null),
    ]);
    const o = opp || {};
    const leadTypes = leadTypeRows.map(t => t.name);
    if (o.lead_type && !leadTypes.includes(o.lead_type)) leadTypes.unshift(o.lead_type);
    const oppCustomer = o.customer_id ? await this._customerById(o.customer_id) : null;
    const stages = ['qualification','proposal','negotiation','closed_won','closed_lost'];
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit Opportunity' : 'New Opportunity'}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Title *</label><input id="o-title" value="${o.title||''}"></div>
          <div class="input-row">
            <div class="form-group"><label>Lead</label>
              <select id="o-lead-type" data-searchable data-add="App._addLeadType">
                <option value="">None</option>
                ${leadTypes.map(t => `<option value="${this.escapeAttr(t)}" ${o.lead_type === t ? 'selected' : ''}>${this.escapeAttr(t)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Customer</label>
              ${this._customerPickerHtml('o-cust', oppCustomer ? [oppCustomer] : [], o.customer_id, { emptyLabel: 'None', remote: '' })}
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Stage</label>
              <select id="o-stage">${stages.map(s => `<option value="${s}" ${(o.stage||'qualification')===s?'selected':''}>${this.crmStageLabel(s)}</option>`).join('')}</select>
            </div>
            <div class="form-group"><label>Probability %</label><input id="o-prob" type="number" value="${o.probability||50}" min="0" max="100"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Deal Value</label><input id="o-val" type="number" value="${o.value||0}" min="0" step="0.01"></div>
            <div class="form-group"><label>Expected Close</label><input id="o-close" type="date" value="${o.expected_close||''}"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Assigned To</label>
              ${id
                ? `<div style="display:flex;align-items:center;gap:8px">
                    <span style="padding:6px 0">${o.employee_id ? (employees.find(e=>e.id===o.employee_id)?.first_name+' '+employees.find(e=>e.id===o.employee_id)?.last_name) : 'Unassigned'}</span>
                    ${this.can('sales_manager') ? `<button type="button" class="btn btn-secondary btn-sm" onclick="App.showReassignOppModal(${id},${o.employee_id||'null'})">Reassign</button>` : ''}
                  </div>`
                : `<span style="padding:6px 0">${this.currentUser ? `${this.currentUser.first_name} ${this.currentUser.last_name}` : 'You'} (assigned automatically)</span>`}
            </div>
          </div>
          <div class="form-group"><label>Notes</label><textarea id="o-notes" rows="3">${o.notes||''}</textarea></div>
        </div>
        <div class="modal-footer">
          ${id ? `<button class="btn btn-danger" onclick="App.deleteOpp(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveOpp(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveOpp(id) {
    const data = {
      title: document.getElementById('o-title').value.trim(),
      lead_type: document.getElementById('o-lead-type').value || null,
      customer_id: document.getElementById('o-cust').value || null,
      stage: document.getElementById('o-stage').value,
      probability: parseInt(document.getElementById('o-prob').value) || 50,
      value: parseFloat(document.getElementById('o-val').value) || 0,
      expected_close: document.getElementById('o-close').value || null,
      notes: document.getElementById('o-notes').value.trim() || null,
    };
    if (!data.title) return this.alert('Title required', 'error');
    try {
      if (id) await this.api('PUT', `/crm/opportunities/${id}`, data);
      else await this.api('POST', '/crm/opportunities', data);
      this.alert('Opportunity saved');
      this.closeModal();
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showReassignOppModal(id, currentEmployeeId) {
    const employees = await this.api('GET', '/employees');
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <span class="modal-title">Reassign Opportunity</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Hands this opportunity to another salesperson's pipeline.</p>
          <div class="form-group"><label>Assign To</label>
            <select id="or-employee">
              ${employees.filter(e => e.active !== 0).map(e => `<option value="${e.id}" ${e.id===currentEmployeeId?'selected':''}>${e.first_name} ${e.last_name}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.reassignOpp(${id})">Reassign</button>
        </div>
      </div>`);
  },

  async reassignOpp(id) {
    const employee_id = parseInt(document.getElementById('or-employee').value);
    try {
      await this.api('PATCH', `/crm/opportunities/${id}/reassign`, { employee_id });
      this.closeModal();
      this.alert('Opportunity reassigned');
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteOpp(id) {
    if (!confirm('Delete this opportunity?')) return;
    try {
      await this.api('DELETE', `/crm/opportunities/${id}`);
      this.alert('Deleted');
      this.closeModal();
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async viewOpp(id) {
    const opp = await this.api('GET', `/crm/opportunities/${id}`);
    const stages = ['qualification','proposal','negotiation','closed_won','closed_lost'];
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <span class="modal-title">${opp.opp_number} — ${opp.title}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
            <span class="badge-pill badge-info">${this.crmStageLabel(opp.stage)}</span>
            <span style="font-size:15px;font-weight:700;color:var(--success)">${this.fmt(opp.value)}</span>
            <span style="font-size:13px;color:var(--text-muted)">${opp.probability}% likely</span>
          </div>
          <div class="input-row" style="margin-bottom:12px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Lead / Contact</label><div style="font-size:13px">${opp.lead_type ? `${this.escapeAttr(opp.lead_type)}${opp.lead_name || opp.customer_name ? ' · ' : ''}` : ''}${opp.lead_name||opp.customer_name||(opp.lead_type ? '' : '—')}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Assigned</label><div style="font-size:13px">${opp.employee_name||'—'}</div></div>
          </div>
          <div class="input-row" style="margin-bottom:16px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Expected Close</label><div style="font-size:13px">${opp.expected_close?this.fmtDate(opp.expected_close):'—'}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Quote</label><div style="font-size:13px">${opp.quote_number||'—'}</div></div>
          </div>
          ${opp.notes?`<div style="margin-bottom:16px;font-size:13px;color:var(--text-muted)">${opp.notes}</div>`:''}
          <div style="margin-bottom:10px"><strong>Move Stage</strong></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
            ${stages.filter(s => s !== opp.stage).map(s => `
              <button class="btn btn-sm btn-outline" onclick="App.moveOppStage(${opp.id},'${s}')">${this.crmStageLabel(s)}</button>`).join('')}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <strong>Activities (${opp.activities.length})</strong>
            <button class="btn btn-sm btn-outline" onclick="App.showActivityModal(null,${opp.id})">+ Add</button>
          </div>
          ${opp.activities.map(a => `
            <div class="activity-item">
              <div class="activity-icon ${a.type}">${this.activityIcon(a.type)}</div>
              <div class="activity-info">
                <div class="activity-subject" style="${a.completed?'text-decoration:line-through;color:var(--text-muted)':''}">${a.subject}</div>
                <div class="activity-meta">${a.type.toUpperCase()}${a.due_date?' &bull; '+this.fmtDue(a.due_date):''}</div>
              </div>
              ${!a.completed?`<button class="btn btn-sm btn-success" onclick="App.completeActivity(${a.id})">Done</button>`:''}
            </div>`).join('')}
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.showOppModal(${opp.id})">Edit</button>
          ${this.can('sales_manager') ? `<button class="btn btn-secondary" onclick="App.showReassignOppModal(${opp.id},${opp.employee_id||'null'})">Reassign</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async moveOppStage(id, stage) {
    const lostReason = stage === 'closed_lost' ? (prompt('Reason for loss (optional):') || null) : null;
    try {
      await this.api('PATCH', `/crm/opportunities/${id}/stage`, { stage, lost_reason: lostReason });
      this.alert('Stage updated');
      this.viewOpp(id);
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showActivityModal(leadId = null, oppId = null) {
    const [employees, leads] = await Promise.all([
      this.api('GET', '/employees'),
      this.api('GET', '/crm/leads'),
    ]);
    const types = ['call','email','meeting','task','note'];
    const tomorrow = new Date(Date.now() + 86400000);
    const defaultDue = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}T09:00`;
    this.showModal(`
      <div class="modal" style="max-width:500px">
        <div class="modal-header">
          <span class="modal-title">New Activity</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>Type</label>
              <select id="a-type">${types.map(t => `<option value="${t}">${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}</select>
            </div>
            <div class="form-group"><label>Assigned To</label>
              <select id="a-emp">
                <option value="">Unassigned</option>
                ${employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group"><label>Subject *</label><input id="a-subj" placeholder="e.g. Follow-up call with Alice"></div>
          <div class="input-row">
            <div class="form-group"><label>Lead</label>
              <select id="a-lead">
                <option value="">None</option>
                ${leads.map(l => `<option value="${l.id}" ${leadId===l.id?'selected':''}>${l.first_name} ${l.last_name}${l.company?' — '+l.company:''}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Customer</label>
              ${this._customerPickerHtml('a-cust', [], null, { emptyLabel: 'None', remote: '' })}
            </div>
          </div>
          <div class="form-group"><label>Due Date / Time</label><input id="a-due" type="datetime-local" value="${defaultDue}"></div>
          <div class="form-group"><label>Description</label><textarea id="a-desc" rows="3" placeholder="Additional details..."></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveActivity(${leadId||'null'},${oppId||'null'})">Save Activity</button>
        </div>
      </div>`);
  },

  async saveActivity(leadId, oppId) {
    const data = {
      type: document.getElementById('a-type').value,
      subject: document.getElementById('a-subj').value.trim(),
      description: document.getElementById('a-desc').value.trim() || null,
      // Saved as UTC like every other timestamp, so the server's
      // due_date < datetime('now') overdue checks compare like with like.
      due_date: this._storeLocalToUtc(document.getElementById('a-due').value),
      employee_id: document.getElementById('a-emp').value || null,
      lead_id: document.getElementById('a-lead').value || leadId || null,
      opportunity_id: oppId || null,
      customer_id: document.getElementById('a-cust').value || null,
    };
    if (!data.subject) return this.alert('Subject required', 'error');
    try {
      await this.api('POST', '/crm/activities', data);
      this.alert('Activity scheduled');
      this.closeModal();
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async completeActivity(id) {
    const outcome = prompt('Outcome / notes (optional):') || null;
    try {
      await this.api('PATCH', `/crm/activities/${id}/complete`, { outcome });
      this.alert('Activity completed');
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteActivity(id) {
    if (!confirm('Delete this activity?')) return;
    try {
      await this.api('DELETE', `/crm/activities/${id}`);
      this.alert('Activity deleted');
      this.renderCrmTab();
    } catch(e) { this.alert(e.message, 'error'); }
  },

});
