// Employees.
Object.assign(App, {
  // ─── Employees ────────────────────────────────────────────
  async renderEmployees() {
    const employees = await this.api('GET', '/employees');
    if (this.section !== 'employees') return;
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Employees</h2>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" onclick="App.showStaffPurchasesReport()">Staff Purchases</button>
          <button class="btn btn-primary" onclick="App.showEmployeeForm()">+ Add Employee</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Employee #</th><th>Name</th><th>Username</th><th>Security Group</th><th>Default Branch</th><th>Branches</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${employees.map(e => `<tr>
              <td style="font-family:monospace;font-size:12px">${e.employee_number}</td>
              <td class="fw-600">${e.first_name} ${e.last_name}</td>
              <td style="color:var(--text-muted)">${e.username}</td>
              <td>${e.security_group_name ? `<span class="badge-pill badge-purple">${e.security_group_name}</span>` : '<span style="color:var(--text-muted)">None</span>'}</td>
              <td>${e.default_branch_name||'<span style="color:var(--text-muted)">None</span>'}</td>
              <td>${(e.branches||[]).map(b => `<span class="badge-pill badge-teal" style="margin-right:2px">${b.name}</span>`).join('')||'-'}</td>
              <td><span class="badge-pill ${e.active?'badge-success':'badge-danger'}">${e.active?'Active':'Inactive'}</span></td>
              <td style="white-space:nowrap"><button class="btn btn-secondary btn-sm" onclick="App.showEmployeeForm(${e.id})">Edit</button> <button class="btn btn-secondary btn-sm" title="New employee with this employee's security group, roles and access" onclick="App.showEmployeeForm(null, ${e.id})">Copy</button></td>
            </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  // copyFromId (new employees only) prefills the form from an existing
  // employee — security group, default branch, role flags, skills — and on
  // save the server also copies their branch/drawer access, commission plans
  // and sales targets. Name and login credentials are never copied.
  async showEmployeeForm(id, copyFromId) {
    const [empList, secGroups, branches, skills] = await Promise.all([
      this.api('GET', '/employees'),
      this.api('GET', '/security-groups'),
      this.api('GET', '/branches'),
      this.api('GET', '/work-orders/skills').catch(() => []),
    ]);
    const emp = (id ? empList.find(x => x.id === id) : null) || {};
    const empSkillIds = (emp.skills || []).map(s => s.id);
    this._efEmpList = empList;
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit Employee' : 'Add Employee'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          ${id ? '' : `<div style="background:var(--bg-secondary,rgba(0,0,0,.03));border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:12px">
            <div class="form-group" style="margin-bottom:0"><label>Copy From Existing Employee</label>
              <select id="ef-copy-from" onchange="App.applyEmployeeCopySource(this.value)">
                <option value="">-- Start blank --</option>
                ${empList.map(x => `<option value="${x.id}">${x.first_name} ${x.last_name} (${x.employee_number})${x.security_group_name ? ' — ' + x.security_group_name : ''}${x.active ? '' : ' [inactive]'}</option>`).join('')}
              </select>
            </div>
            <div id="ef-copy-opts" style="display:none;margin-top:8px;font-size:13px">
              <div style="color:var(--text-muted);margin-bottom:6px">Security group, default branch, role designations and skills are filled in below. Also copy:</div>
              <div style="display:flex;flex-wrap:wrap;gap:12px">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal"><input type="checkbox" id="ef-copy-branches" checked style="width:16px;height:16px">Branch access</label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal"><input type="checkbox" id="ef-copy-drawers" checked style="width:16px;height:16px">Cash drawer access</label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal"><input type="checkbox" id="ef-copy-commissions" checked style="width:16px;height:16px">Commission plans</label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal"><input type="checkbox" id="ef-copy-targets" checked style="width:16px;height:16px">Sales targets</label>
              </div>
            </div>
          </div>`}
          <div class="input-row">
            <div class="form-group"><label>First Name *</label><input id="ef-first" value="${this.escapeAttr(emp.first_name)}"></div>
            <div class="form-group"><label>Last Name *</label><input id="ef-last" value="${this.escapeAttr(emp.last_name)}"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Username *</label><input id="ef-user" value="${this.escapeAttr(emp.username)}"></div>
            <div class="form-group"><label>PIN *</label><input type="password" id="ef-pin" placeholder="${id ? 'Leave blank to keep' : 'Enter PIN'}" maxlength="6"></div>
          </div>
          <div style="border-top:1px solid var(--border);margin:8px 0 12px;padding-top:12px">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Login Credentials</div>
            <div class="input-row">
              <div class="form-group"><label>Login Password</label><input type="password" id="ef-password" placeholder="${id ? 'Leave blank to keep' : 'Set login password'}"></div>
              <div class="form-group"><label>Confirm Password</label><input type="password" id="ef-password2" placeholder="Confirm password"></div>
            </div>
            <div class="form-group" style="margin-top:4px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="ef-must-change" ${emp.must_change_password?'checked':''} style="width:16px;height:16px;cursor:pointer">
                Require password change on next login
              </label>
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Security Group</label>
              <select id="ef-sg">
                <option value="">-- None --</option>
                ${secGroups.map(g => `<option value="${g.id}" ${emp.security_group_id===g.id?'selected':''}>${g.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Status</label>
              <select id="ef-active">
                <option value="1" ${emp.active!==0?'selected':''}>Active</option>
                <option value="0" ${emp.active===0?'selected':''}>Inactive</option>
              </select>
            </div>
          </div>
          <div class="form-group"><label>Default Branch</label>
            <select id="ef-branch">
              <option value="">-- None --</option>
              ${branches.map(b => `<option value="${b.id}" ${emp.default_branch_id===b.id?'selected':''}>${b.name}</option>`).join('')}
            </select>
          </div>
          <div class="input-row">
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="ef-driver" ${emp.is_driver?'checked':''} style="width:16px;height:16px;cursor:pointer">
                Designated driver (rental delivery/pickup)
              </label>
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="ef-operator" ${emp.is_operator?'checked':''} style="width:16px;height:16px;cursor:pointer">
                Rental equipment operator
              </label>
            </div>
          </div>
          <div class="input-row">
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="ef-security" ${emp.is_security?'checked':''} style="width:16px;height:16px;cursor:pointer">
                Security (verifies rental issue/return)
              </label>
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
                <input type="checkbox" id="ef-salesperson" ${emp.is_salesperson?'checked':''} style="width:16px;height:16px;cursor:pointer">
                Salesperson (Dashboard/CRM/Commissions scoped to their own records only)
              </label>
            </div>
          </div>
          ${skills.length ? `<div style="border-top:1px solid var(--border);margin:8px 0 0;padding-top:12px">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Technician Skills</div>
            <div style="display:flex;flex-wrap:wrap;gap:10px">
              ${skills.map(s => `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;font-size:13px">
                <input type="checkbox" class="ef-skill" value="${s.id}" ${empSkillIds.includes(s.id)?'checked':''} style="width:16px;height:16px;cursor:pointer">
                ${s.name}
              </label>`).join('')}
            </div>
          </div>` : ''}
          ${id ? `<div style="border-top:1px solid var(--border);margin:12px 0 0;padding-top:12px">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Staff Purchases</div>
            <div id="ef-staff-box"><div style="font-size:12px;color:var(--text-muted)">Loading…</div></div>
          </div>` : ''}
          ${id && this.can('employees_edit') ? `<div style="border-top:1px solid var(--border);margin:12px 0 0;padding-top:12px">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Approval Signature</div>
            <div id="ef-sig-box"><div style="font-size:12px;color:var(--text-muted)">Loading…</div></div>
          </div>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveEmployee(${id||'null'})">Save</button>
        </div>
      </div>`);
    if (id && this.can('employees_edit')) this._loadEmployeeSignature(id);
    if (id) this._loadStaffAccount(id);
    if (!id && copyFromId) {
      document.getElementById('ef-copy-from').value = String(copyFromId);
      this.applyEmployeeCopySource(copyFromId);
    }
  },

  // Fills the Add Employee form's non-personal fields from an existing
  // employee. Leaves name, username, PIN and password untouched.
  applyEmployeeCopySource(srcId) {
    const src = (this._efEmpList || []).find(x => x.id === parseInt(srcId));
    document.getElementById('ef-copy-opts').style.display = src ? '' : 'none';
    if (!src) return;
    document.getElementById('ef-sg').value = src.security_group_id || '';
    document.getElementById('ef-branch').value = src.default_branch_id || '';
    document.getElementById('ef-driver').checked = !!src.is_driver;
    document.getElementById('ef-operator').checked = !!src.is_operator;
    document.getElementById('ef-security').checked = !!src.is_security;
    document.getElementById('ef-salesperson').checked = !!src.is_salesperson;
    const skillIds = (src.skills || []).map(s => s.id);
    document.querySelectorAll('.ef-skill').forEach(el => { el.checked = skillIds.includes(parseInt(el.value)); });
  },

  async saveEmployee(id) {
    const password = document.getElementById('ef-password').value;
    const password2 = document.getElementById('ef-password2').value;
    if (password && password !== password2) { this.alert('Passwords do not match', 'error'); return; }
    const data = {
      first_name: document.getElementById('ef-first').value.trim(),
      last_name: document.getElementById('ef-last').value.trim(),
      username: document.getElementById('ef-user').value.trim(),
      pin: document.getElementById('ef-pin').value || undefined,
      password: password || undefined,
      must_change_password: document.getElementById('ef-must-change').checked ? 1 : 0,
      active: parseInt(document.getElementById('ef-active').value),
      security_group_id: parseInt(document.getElementById('ef-sg').value) || null,
      default_branch_id: parseInt(document.getElementById('ef-branch').value) || null,
      is_driver: document.getElementById('ef-driver').checked ? 1 : 0,
      is_operator: document.getElementById('ef-operator').checked ? 1 : 0,
      is_security: document.getElementById('ef-security').checked ? 1 : 0,
      is_salesperson: document.getElementById('ef-salesperson').checked ? 1 : 0,
      skill_ids: Array.from(document.querySelectorAll('.ef-skill:checked')).map(el => parseInt(el.value)),
    };
    if (!data.pin) delete data.pin;
    if (!data.password) delete data.password;
    const copyFrom = !id && parseInt(document.getElementById('ef-copy-from')?.value);
    if (copyFrom) {
      data.copy_from_id = copyFrom;
      data.copy_options = {
        branches: document.getElementById('ef-copy-branches').checked,
        drawers: document.getElementById('ef-copy-drawers').checked,
        commissions: document.getElementById('ef-copy-commissions').checked,
        targets: document.getElementById('ef-copy-targets').checked,
      };
    }
    try {
      if (id) await this.api('PUT', `/employees/${id}`, data);
      else await this.api('POST', '/employees', { ...data, pin: data.pin || '0000' });
      this.closeModal();
      this.alert(id ? 'Employee updated' : 'Employee created');
      this.renderEmployees();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // ─── Staff purchases (lib/staffPurchases.js) ──────────────
  // The employee form's Staff Purchases box: their staff account (a cash
  // customer in their name), limit tier and this period's use.
  async _loadStaffAccount(id) {
    const box = document.getElementById('ef-staff-box');
    if (!box) return;
    let d;
    try { d = await this.api('GET', `/employees/${id}/staff-account`); }
    catch (e) { box.innerHTML = `<div style="font-size:12px;color:var(--danger)">${this.escapeAttr(e.message)}</div>`; return; }
    this._renderStaffAccount(id, d);
  },

  _renderStaffAccount(id, d) {
    const box = document.getElementById('ef-staff-box');
    if (!box) return;
    const edit = this.can('employees_edit');
    const set = d.settings;
    const per = set.period === 'year' ? 'year' : 'month';
    const tierLimit = d.tier === 'manager' ? set.limit_manager : set.limit_staff;
    const st = d.status;
    const account = d.customer
      ? `<div style="font-size:13px;margin-bottom:8px">Account <strong>${this.escapeAttr(d.customer.customer_number)}</strong> — ${this.escapeAttr(`${d.customer.first_name} ${d.customer.last_name}`.trim())}
          ${edit ? ` <button class="btn btn-secondary btn-sm" style="margin-left:6px" onclick="App._unlinkStaffAccount(${id})">Unlink</button>` : ''}</div>
         ${st ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${this.escapeAttr(st.period_label)}: used <strong>${this.fmt(st.used)}</strong> of ${this.fmt(st.limit)} — <strong>${this.fmt(st.remaining)}</strong> left (${st.sales} sale${st.sales === 1 ? '' : 's'}).</div>` : ''}`
      : `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">No staff account yet. Staff purchases are rung up at the POS on this account: ${set.discount_pct}% off, cash only.</div>
         ${edit ? `<div class="input-row" style="align-items:flex-end;margin-bottom:10px">
           <button class="btn btn-secondary btn-sm" onclick="App._createStaffAccount(${id})">Create Staff Account</button>
           <div class="form-group" style="flex:1;margin-bottom:0"><label>or link existing customer #</label><input id="ef-staff-link" placeholder="e.g. CUST-0123"></div>
           <button class="btn btn-secondary btn-sm" onclick="App._createStaffAccount(${id}, true)">Link</button>
         </div>` : ''}`;
    box.innerHTML = `${account}
      <div class="input-row" style="align-items:flex-end">
        <div class="form-group" style="margin-bottom:0"><label>Limit Tier</label>
          <select id="ef-staff-tier" ${edit ? '' : 'disabled'}>
            <option value="staff" ${d.tier === 'staff' ? 'selected' : ''}>Staff — ${this.fmt(set.limit_staff)} a ${per}</option>
            <option value="manager" ${d.tier === 'manager' ? 'selected' : ''}>Manager — ${this.fmt(set.limit_manager)} a ${per}</option>
          </select></div>
        <div class="form-group" style="margin-bottom:0"><label>Personal limit (blank = tier's ${this.fmt(tierLimit)})</label>
          <input id="ef-staff-limit" type="number" min="0" step="0.01" value="${d.own_limit ?? ''}" ${edit ? '' : 'disabled'}></div>
        ${edit ? `<button class="btn btn-secondary btn-sm" onclick="App._saveStaffPurchase(${id})">Save Limit</button>` : ''}
      </div>`;
  },

  async _createStaffAccount(id, link) {
    let customer_id;
    if (link) {
      const q = document.getElementById('ef-staff-link')?.value.trim();
      if (!q) { this.alert('Enter the customer number to link', 'warning'); return; }
      try {
        const found = await this.api('GET', `/customers?search=${encodeURIComponent(q)}&limit=20`);
        const list = Array.isArray(found) ? found : (found.customers || found.rows || []);
        const c = list.find(x => String(x.customer_number).toLowerCase() === q.toLowerCase());
        if (!c) { this.alert(`No customer numbered ${q}`, 'error'); return; }
        customer_id = c.id;
      } catch (e) { this.alert(e.message, 'error'); return; }
    }
    try {
      const d = await this.api('POST', `/employees/${id}/staff-account`, customer_id ? { customer_id } : {});
      this.alert(`Staff account ${d.customer.customer_number} ${link ? 'linked' : 'created'}`, 'success');
      this._renderStaffAccount(id, d);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async _unlinkStaffAccount(id) {
    if (!confirm('Unlink this staff account? The customer and its sales stay; it just stops getting the staff discount and limit.')) return;
    try { this._renderStaffAccount(id, await this.api('DELETE', `/employees/${id}/staff-account`)); this.alert('Staff account unlinked'); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _saveStaffPurchase(id) {
    try {
      const d = await this.api('PUT', `/employees/${id}/staff-purchase`, {
        tier: document.getElementById('ef-staff-tier').value,
        limit: document.getElementById('ef-staff-limit').value,
      });
      this._renderStaffAccount(id, d);
      this.alert('Staff purchase limit saved', 'success');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // Employees → Staff Purchases: every staff account for a month (or year).
  async showStaffPurchasesReport(period) {
    let r;
    try { r = await this.api('GET', `/employees/staff-purchases${period ? `?period=${encodeURIComponent(period)}` : ''}`); }
    catch (e) { this.alert(e.message, 'error'); return; }
    this._staffReport = r;
    const yearly = r.period === 'year';
    const tot = k => r.accounts.reduce((s, a) => s + (Number(a[k]) || 0), 0);
    const rows = r.accounts.map(a => `<tr${a.employee_active ? '' : ' style="opacity:.6"'}>
        <td class="fw-600">${this.escapeAttr(a.employee_name)}${a.employee_active ? '' : ' <span class="badge-pill badge-danger">Inactive</span>'}</td>
        <td style="font-family:monospace;font-size:12px">${this.escapeAttr(a.customer_number)}</td>
        <td>${a.tier === 'manager' ? 'Manager' : 'Staff'}${a.own_limit ? ' (personal)' : ''}</td>
        <td class="text-right">${this.fmt(a.limit)}</td>
        <td class="text-right">${a.sales}</td>
        <td class="text-right">${this.fmt(a.purchases)}</td>
        <td class="text-right">${a.returns ? '-' + this.fmt(a.returns) : '—'}</td>
        <td class="text-right fw-600">${this.fmt(a.used)}</td>
        <td class="text-right" style="color:${a.remaining <= 0 ? 'var(--danger)' : 'inherit'}">${this.fmt(a.remaining)}</td>
        <td class="text-right">${this.fmt(a.discount_given)}</td>
      </tr>`).join('');
    this.showModal(`
      <div class="modal" style="max-width:1000px">
        <div class="modal-header"><span class="modal-title">Staff Purchases — ${this.escapeAttr(r.period_label)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="input-row" style="align-items:flex-end;margin-bottom:12px">
            <div class="form-group" style="margin-bottom:0;max-width:200px"><label>${yearly ? 'Year' : 'Month'}</label>
              ${yearly ? `<input id="spr-period" type="number" min="2000" max="2100" value="${r.period_key}">` : `<input id="spr-period" type="month" value="${r.period_key}">`}</div>
            <button class="btn btn-secondary" onclick="App.showStaffPurchasesReport(document.getElementById('spr-period').value)">Show</button>
            <button class="btn btn-secondary" onclick="App._staffPurchasesCsv()">CSV</button>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">${r.discount_pct}% staff discount, cash only. Used = purchases (after the discount, with GCT) less returns made in the ${yearly ? 'year' : 'month'}. Limit tiers and staff accounts are set on each employee's form; the discount and limits in Settings.</p>
          ${r.accounts.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Employee</th><th>Account</th><th>Tier</th><th class="text-right">Limit</th><th class="text-right">Sales</th><th class="text-right">Purchases</th><th class="text-right">Returns</th><th class="text-right">Used</th><th class="text-right">Left</th><th class="text-right">Discount Given</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr class="fw-600"><td colspan="4">Total</td><td class="text-right">${tot('sales')}</td><td class="text-right">${this.fmt(tot('purchases'))}</td><td class="text-right">${tot('returns') ? '-' + this.fmt(tot('returns')) : '—'}</td><td class="text-right">${this.fmt(tot('used'))}</td><td></td><td class="text-right">${this.fmt(tot('discount_given'))}</td></tr></tfoot>
          </table></div>` : '<p style="color:var(--text-muted)">No staff accounts yet — create one from an employee\'s form (Edit → Staff Purchases).</p>'}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  _staffPurchasesCsv() {
    const r = this._staffReport;
    if (!r) return;
    const head = ['employee', 'employee_number', 'account', 'tier', 'limit', 'sales', 'purchases', 'returns', 'used', 'remaining', 'discount_given'];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.join(',')].concat(r.accounts.map(a => [a.employee_name, a.employee_number, a.customer_number, a.tier, a.limit, a.sales, a.purchases, a.returns, a.used, a.remaining, a.discount_given].map(q).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `staff-purchases-${r.period_key}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  },

});
