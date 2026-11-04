// Employees.
Object.assign(App, {
  // ─── Employees ────────────────────────────────────────────
  async renderEmployees() {
    const employees = await this.api('GET', '/employees');
    if (this.section !== 'employees') return;
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Employees</h2>
        <button class="btn btn-primary" onclick="App.showEmployeeForm()">+ Add Employee</button>
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

});
