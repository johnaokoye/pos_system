// Work Orders → Technician Performance: tasks per technician over a period (duration, on-time badges, completed/incomplete counts) and monthly incentive targets.
Object.assign(App, {
  // Period presets → [start, end] store days.
  _woPerfRange(preset) {
    const today = this._storeDay(new Date());
    const [y, m, d] = today.split('-').map(Number);
    const iso = dt => dt.toISOString().slice(0, 10);
    const utc = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd));
    if (preset === 'last_month') return [iso(utc(y, m - 2, 1)), iso(utc(y, m - 1, 0))];
    if (preset === 'this_week') { const dow = utc(y, m - 1, d).getUTCDay(); return [iso(utc(y, m - 1, d - ((dow + 6) % 7))), today]; }
    if (preset === 'last_7') return [iso(utc(y, m - 1, d - 6)), today];
    if (preset === 'today') return [today, today];
    return [iso(utc(y, m - 1, 1)), today]; // this_month
  },

  async _renderWOPerformance() {
    const el = document.getElementById('wo-content');
    if (!el) return;
    const f = this._woPerf || (this._woPerf = { preset: 'this_month', technician_id: '', branch_id: '', show: 'all' });
    if (!f.start) [f.start, f.end] = this._woPerfRange(f.preset);
    if (!this._woPerfBranches) { try { this._woPerfBranches = await this.api('GET', '/branches'); } catch (e) { this._woPerfBranches = []; } }
    if (!this._woPerfTechs) { try { this._woPerfTechs = (await this.api('GET', '/employees')).filter(e => e.active !== 0); } catch (e) { this._woPerfTechs = []; } }
    const q = new URLSearchParams({ start: f.start, end: f.end });
    if (f.technician_id) q.set('technician_id', f.technician_id);
    if (f.branch_id) q.set('branch_id', f.branch_id);
    let data;
    try { data = await this.api('GET', `/work-orders/task-performance?${q}`); }
    catch (e) { el.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    if (this.woTab !== 'performance' || !document.getElementById('wo-content')) return;
    this._woPerfData = data;
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    const sel = (v, cur) => String(v) === String(cur ?? '') ? ' selected' : '';
    const presets = [['today', 'Today'], ['this_week', 'This week'], ['last_7', 'Last 7 days'], ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom']];
    const t = data.totals;
    const stat = (label, value, sub, color) => `<div class="card" style="padding:10px 14px;min-width:120px;flex:1"><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">${label}</div><div style="font-size:22px;font-weight:700${color ? `;color:${color}` : ''}">${value}</div>${sub ? `<div style="font-size:11px;color:var(--text-muted)">${sub}</div>` : ''}</div>`;

    const filtered = data.tasks.filter(x => f.show === 'all' || (f.show === 'complete' && x.status === 'complete') || (f.show === 'incomplete' && x.status !== 'complete')
      || (f.show === 'on_time' && x.timing === 'on_time') || (f.show === 'late' && x.timing === 'late'));

    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:12px">
        <div class="form-group" style="margin:0"><label style="font-size:11px">Period</label>
          <select id="wop-preset" onchange="App._woPerfPreset(this.value)">${presets.map(([k, l]) => `<option value="${k}"${sel(k, f.preset)}>${l}</option>`).join('')}</select></div>
        <div class="form-group" style="margin:0"><label style="font-size:11px">From</label><input type="date" id="wop-start" value="${esc(f.start)}" onchange="App._woPerfDates()"></div>
        <div class="form-group" style="margin:0"><label style="font-size:11px">To</label><input type="date" id="wop-end" value="${esc(f.end)}" onchange="App._woPerfDates()"></div>
        <div class="form-group" style="margin:0"><label style="font-size:11px">Technician</label>
          <select id="wop-tech" onchange="App._woPerfSet('technician_id', this.value)"><option value="">All technicians</option>${this._woPerfTechs.map(e => `<option value="${e.id}"${sel(e.id, f.technician_id)}>${esc(e.first_name + ' ' + e.last_name)}</option>`).join('')}</select></div>
        <div class="form-group" style="margin:0"><label style="font-size:11px">Branch</label>
          <select id="wop-branch" onchange="App._woPerfSet('branch_id', this.value)"><option value="">All branches</option>${(this._woPerfBranches || []).filter(b => b.active).map(b => `<option value="${b.id}"${sel(b.id, f.branch_id)}>${esc(b.name)}</option>`).join('')}</select></div>
        <div style="flex:1"></div>
        ${this.can('wo_incentives') ? `<button class="btn btn-secondary btn-sm" onclick="App.showWOIncentiveTargets()">🎯 Incentive Targets</button>` : ''}
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        ${stat('Completed', t.completed)}
        ${stat('On time', t.on_time, t.on_time_pct != null ? `${t.on_time_pct}% of timed tasks` : 'No timed tasks', 'var(--success)')}
        ${stat('Late', t.late, '', t.late ? 'var(--danger)' : '')}
        ${stat('No time set', t.no_allotment, 'Completed with no allotted time')}
        ${stat('Incomplete', t.incomplete, 'Still open', t.incomplete ? 'var(--warning)' : '')}
        ${stat('Hours worked', this._woMinutesLabel(t.minutes_worked), 'On completed tasks')}
      </div>

      <h3 style="font-size:14px;margin:4px 0 8px">By technician ${data.period ? `<span style="font-size:12px;font-weight:normal;color:var(--text-muted)">· targets for ${this._woPerfMonthLabel(data.period)}</span>` : `<span style="font-size:12px;font-weight:normal;color:var(--text-muted)">· pick a whole month to see incentive targets</span>`}</h3>
      ${data.technicians.length ? `<div class="table-wrap"><table class="table" id="wop-tech-table">
        <thead><tr><th>Technician</th><th>Completed</th><th>On time</th><th>Late</th><th>No time set</th><th>Incomplete</th><th>On-time %</th><th>Hours worked</th>${data.period ? '<th>Target</th>' : ''}</tr></thead>
        <tbody>${data.technicians.map(s => `<tr data-tech="${s.technician_id || 0}">
          <td class="fw-600">${esc(s.technician_name)}${s.target && s.target.met ? ' <span class="badge-pill badge-success" style="font-size:10px">🏆 Target met</span>' : ''}</td>
          <td>${s.completed}</td>
          <td><span class="badge-pill badge-success" style="font-size:11px">${s.on_time}</span></td>
          <td>${s.late ? `<span class="badge-pill badge-danger" style="font-size:11px">${s.late}</span>` : '0'}</td>
          <td>${s.no_allotment}</td>
          <td>${s.incomplete ? `<span class="badge-pill badge-warning" style="font-size:11px">${s.incomplete}</span>` : '0'}</td>
          <td>${s.on_time_pct != null ? s.on_time_pct + '%' : '—'}</td>
          <td>${this._woMinutesLabel(s.minutes_worked)}</td>
          ${data.period ? `<td style="min-width:200px">${this._woPerfTargetHtml(s)}</td>` : ''}
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><p>No tasks in this period.</p></div>'}

      <div style="display:flex;align-items:center;gap:8px;margin:16px 0 8px">
        <h3 style="font-size:14px;margin:0">Tasks</h3>
        <select id="wop-show" onchange="App._woPerfShow(this.value)" style="width:auto">
          ${[['all', 'All'], ['complete', 'Completed'], ['on_time', 'Completed on time'], ['late', 'Completed late'], ['incomplete', 'Incomplete']].map(([k, l]) => `<option value="${k}"${sel(k, f.show)}>${l}</option>`).join('')}
        </select>
        <span style="font-size:12px;color:var(--text-muted)">${filtered.length} task${filtered.length === 1 ? '' : 's'}</span>
      </div>
      ${filtered.length ? `<div class="table-wrap"><table class="table" id="wop-task-table" style="font-size:13px">
        <thead><tr><th>Task</th><th>Work Order</th><th>Technician</th><th>Allotted</th><th>Actual</th><th>Result</th><th>Completed</th></tr></thead>
        <tbody>${filtered.map(x => `<tr>
          <td>${esc(x.description)}</td>
          <td><a href="#" onclick="App.viewWorkOrder(${x.work_order_id});return false">${esc(x.wo_number)}</a><div style="font-size:11px;color:var(--text-muted)">${esc(x.customer_name || '')}${x.branch_name ? ' · ' + esc(x.branch_name) : ''}</div></td>
          <td>${esc(x.technician_name || 'Unassigned')}</td>
          <td>${x.allotted_minutes > 0 ? this._woMinutesLabel(x.allotted_minutes) : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td>${this._woMinutesLabel(x.actual_minutes)}${x.running ? ' <span class="badge-pill badge-info" style="font-size:10px">running</span>' : ''}${x.variance_minutes != null && x.variance_minutes !== 0 && (x.status === 'complete' || x.variance_minutes > 0) ? `<div style="font-size:11px;color:${x.variance_minutes > 0 ? 'var(--danger)' : 'var(--success)'}">${x.variance_minutes > 0 ? '+' : '−'}${this._woMinutesLabel(Math.abs(x.variance_minutes))}</div>` : ''}</td>
          <td>${this._woPerfBadge(x)}</td>
          <td>${x.completed_at ? this.fmtDateTime(x.completed_at) : `<span style="color:var(--text-muted)">Opened ${this.fmtDate(x.created_at)}</span>`}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><p>No tasks match.</p></div>'}
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">On time = clocked time within the task's allotted time. Completed tasks count in the period they were marked complete; incomplete ones are every task still open on a live work order.</p>`;
  },

  _woPerfBadge(x) {
    if (x.status !== 'complete') return x.timing === 'over'
      ? '<span class="badge-pill badge-danger" style="font-size:11px">Open · over time</span>'
      : `<span class="badge-pill badge-warning" style="font-size:11px">${x.status === 'in_progress' ? 'In progress' : 'Not started'}</span>`;
    if (x.timing === 'on_time') return '<span class="badge-pill badge-success" style="font-size:11px">✓ On time</span>';
    if (x.timing === 'late') return '<span class="badge-pill badge-danger" style="font-size:11px">Late</span>';
    return '<span class="badge-pill badge-secondary" style="font-size:11px">Done · no time set</span>';
  },

  _woPerfMonthLabel(period) {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  },

  // Progress toward the technician's target (their own, else the default).
  _woPerfTargetHtml(s) {
    const tg = s.target;
    if (!s.technician_id) return '<span style="color:var(--text-muted)">—</span>';
    if (!tg) return '<span style="color:var(--text-muted);font-size:12px">No target set</span>';
    const bar = (have, want, label) => {
      const pct = want > 0 ? Math.min(100, Math.round(have / want * 100)) : 100;
      const done = have >= want;
      return `<div style="font-size:11px;margin-bottom:3px">${label}: <strong>${have}</strong> / ${want}
        <div style="height:5px;background:var(--bg-secondary);border-radius:3px;overflow:hidden;margin-top:2px"><div style="height:100%;width:${pct}%;background:${done ? 'var(--success)' : 'var(--primary)'}"></div></div></div>`;
    };
    return `${tg.target_completed != null ? bar(s.completed, tg.target_completed, 'Completed') : ''}
      ${tg.target_on_time_pct != null ? bar(s.on_time_pct ?? 0, tg.target_on_time_pct, 'On-time %') : ''}
      <div style="font-size:11px;color:var(--text-muted)">${tg.is_default ? 'Default target' : 'Own target'}${tg.reward_amount ? ` · Reward ${this.fmt(tg.reward_amount)}` : ''}${tg.reward_note ? ` · ${this.escapeAttr(tg.reward_note)}` : ''}</div>`;
  },

  _woPerfPreset(preset) {
    const f = this._woPerf;
    f.preset = preset;
    if (preset !== 'custom') [f.start, f.end] = this._woPerfRange(preset);
    this._renderWOPerformance();
  },
  _woPerfDates() {
    const f = this._woPerf;
    f.start = document.getElementById('wop-start').value || f.start;
    f.end = document.getElementById('wop-end').value || f.end;
    f.preset = 'custom';
    this._renderWOPerformance();
  },
  _woPerfSet(key, value) { this._woPerf[key] = value; this._renderWOPerformance(); },
  _woPerfShow(value) { this._woPerf.show = value; this._renderWOPerformance(); },

  // ─── Incentive targets (wo_incentives) ─────────────────────────────────
  async showWOIncentiveTargets(period) {
    period = period || (this._woPerfData && this._woPerfData.period) || this._storeDay(new Date()).slice(0, 7);
    if (!this._woPerfTechs) { try { this._woPerfTechs = (await this.api('GET', '/employees')).filter(e => e.active !== 0); } catch (e) { this._woPerfTechs = []; } }
    const { targets } = await this.api('GET', `/work-orders/incentive-targets?period=${period}`);
    this._woTargets = targets;
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    const taken = new Set(targets.map(t => t.employee_id || 0));
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">🎯 Technician Incentive Targets</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group" style="max-width:220px"><label>Month</label><input type="month" id="wot-period" value="${period}" onchange="App.showWOIncentiveTargets(this.value)"></div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:0">A technician's own target applies to them; the default target applies to every other technician. A target is met when every figure set on it is reached.</p>
          ${targets.length ? `<table class="table" style="font-size:13px"><thead><tr><th>For</th><th>Tasks completed</th><th>On-time %</th><th>Reward</th><th></th></tr></thead><tbody>
            ${targets.map(t => `<tr data-target="${t.id}">
              <td class="fw-600">${t.employee_id ? esc(t.employee_name) : 'Default (all technicians)'}</td>
              <td>${t.target_completed ?? '—'}</td>
              <td>${t.target_on_time_pct != null ? t.target_on_time_pct + '%' : '—'}</td>
              <td>${t.reward_amount ? this.fmt(t.reward_amount) : '—'}${t.reward_note ? `<div style="font-size:11px;color:var(--text-muted)">${esc(t.reward_note)}</div>` : ''}</td>
              <td style="white-space:nowrap"><button class="btn btn-sm btn-outline" onclick="App._woTargetForm(${t.id})">Edit</button> <button class="btn btn-sm btn-outline" onclick="App.deleteWOTarget(${t.id})">Remove</button></td>
            </tr>`).join('')}</tbody></table>` : '<div style="color:var(--text-muted);font-size:13px;margin-bottom:8px">No targets for this month yet.</div>'}
          <div id="wot-form" style="border-top:1px dashed var(--border);padding-top:10px;margin-top:10px">
            <input type="hidden" id="wot-id" value="">
            <div class="input-row">
              <div class="form-group"><label>For</label>
                <select id="wot-emp">
                  ${taken.has(0) ? '' : '<option value="">Default (all technicians)</option>'}
                  ${this._woPerfTechs.filter(e => !taken.has(e.id)).map(e => `<option value="${e.id}">${esc(e.first_name + ' ' + e.last_name)}</option>`).join('')}
                </select></div>
              <div class="form-group"><label>Tasks completed</label><input type="number" id="wot-done" min="0" step="1" placeholder="e.g. 40"></div>
              <div class="form-group"><label>On-time %</label><input type="number" id="wot-pct" min="0" max="100" step="1" placeholder="e.g. 90"></div>
            </div>
            <div class="input-row">
              <div class="form-group"><label>Reward amount</label><input type="number" id="wot-reward" min="0" step="0.01" placeholder="Optional"></div>
              <div class="form-group" style="flex:2"><label>Reward note</label><input id="wot-note" placeholder="e.g. Paid with month-end wages"></div>
            </div>
            <button class="btn btn-primary btn-sm" id="wot-save" onclick="App.saveWOTarget('${period}')">Add Target</button>
            <button class="btn btn-secondary btn-sm" id="wot-cancel" style="display:none" onclick="App.showWOIncentiveTargets('${period}')">Cancel Edit</button>
          </div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal();App.woTab==='performance'&&App._renderWOPerformance()">Close</button></div>
      </div>`);
  },

  _woTargetForm(id) {
    const t = (this._woTargets || []).find(x => x.id === id);
    if (!t) return;
    document.getElementById('wot-id').value = id;
    const emp = document.getElementById('wot-emp');
    emp.innerHTML = `<option>${this.escapeAttr(t.employee_id ? t.employee_name : 'Default (all technicians)')}</option>`;
    emp.disabled = true;
    document.getElementById('wot-done').value = t.target_completed ?? '';
    document.getElementById('wot-pct').value = t.target_on_time_pct ?? '';
    document.getElementById('wot-reward').value = t.reward_amount ?? '';
    document.getElementById('wot-note').value = t.reward_note || '';
    document.getElementById('wot-save').textContent = 'Save Target';
    document.getElementById('wot-cancel').style.display = '';
  },

  async saveWOTarget(period) {
    const v = id => document.getElementById(id).value.trim();
    const id = v('wot-id');
    const body = { period, employee_id: id ? undefined : (v('wot-emp') || null), target_completed: v('wot-done'), target_on_time_pct: v('wot-pct'), reward_amount: v('wot-reward'), reward_note: v('wot-note') };
    if (body.target_completed === '' && body.target_on_time_pct === '') { this.alert('Set a tasks-completed target, an on-time % target, or both', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/work-orders/incentive-targets/${id}`, body);
      else await this.api('POST', '/work-orders/incentive-targets', body);
      this.alert('Target saved', 'success');
      await this.showWOIncentiveTargets(period);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async deleteWOTarget(id) {
    const t = (this._woTargets || []).find(x => x.id === id);
    if (!confirm(`Remove the ${t && t.employee_id ? t.employee_name + "'s" : 'default'} target for ${t ? this._woPerfMonthLabel(t.period) : 'this month'}?`)) return;
    try { await this.api('DELETE', `/work-orders/incentive-targets/${id}`); await this.showWOIncentiveTargets(t ? t.period : undefined); }
    catch (e) { this.alert(e.message, 'error'); }
  },
});
