// Work orders: intake, parts, tasks, technician schedule, sign-off, pickup.
Object.assign(App, {
  // ─── Work Orders (service/repair tickets) ──────────────────────────────────

  _woTabs: [
    { key: 'active',          label: 'Active' },
    { key: 'assessed',        label: 'Assessment Queue' },
    { key: 'awaiting_pickup', label: 'Awaiting Pickup' },
    { key: 'picked_up',       label: 'Picked Up' },
    { key: 'cancelled',       label: 'Cancelled' },
    { key: 'not_worth_fixing', label: 'Not Worth Fixing' },
    { key: 'all',             label: 'All' },
  ],

  _woStatusLabels: {
    intake: 'Intake', assessed: 'Assessed', pending_deposit: 'Pending Deposit', in_progress: 'In Progress',
    awaiting_signoff: 'Awaiting Sign-Off', awaiting_parts: 'Awaiting Parts', complete: 'Complete', awaiting_pickup: 'Awaiting Pickup',
    picked_up: 'Picked Up', cancelled: 'Cancelled', not_worth_fixing: 'Not Worth Fixing',
  },
  _woStatusBadge: {
    intake: 'badge-warning', assessed: 'badge-warning', pending_deposit: 'badge-warning', in_progress: 'badge-info',
    awaiting_signoff: 'badge-info', awaiting_parts: 'badge-warning', complete: 'badge-success', awaiting_pickup: 'badge-success',
    picked_up: 'badge-secondary', cancelled: 'badge-secondary', not_worth_fixing: 'badge-danger',
  },

  async renderWorkOrders() {
    this.woTab = this.woTab || 'active';
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Work Orders</h2>
        <div id="wo-header-actions">
          ${this.can('work_orders') ? `<button class="btn btn-secondary btn-sm" style="margin-right:8px" onclick="App.showActiveTasksPopup()">⏱ Active Tasks</button>` : ''}
          ${this.can('work_orders') ? `<button class="btn btn-secondary btn-sm" style="margin-right:8px" onclick="App.showSection('wo-schedule')">📅 Schedule</button>` : ''}
          ${this.can('work_orders') ? `<button class="btn btn-secondary btn-sm" style="margin-right:8px" onclick="App.showSkillsManager()">Manage Skills</button>` : ''}
          ${this.can('wo_intake') ? `<button class="btn btn-primary btn-sm" onclick="App.showWOIntakeModal()">+ New Work Order</button>` : ''}
        </div>
      </div>
      <div class="crm-tabs" id="wo-tabs-nav">
        ${this._woTabs.map(t=>`<button class="crm-tab ${this.woTab===t.key?'active':''}" onclick="App.filterWorkOrders('${t.key}')">${t.label}</button>`).join('')}
      </div>
      <div id="wo-content"></div>`;
    await this.loadWorkOrders();
  },

  async filterWorkOrders(tab) {
    this.woTab = tab;
    document.querySelectorAll('#wo-tabs-nav .crm-tab').forEach((btn,i) => {
      btn.classList.toggle('active', this._woTabs[i].key === tab);
    });
    await this.loadWorkOrders();
  },

  // The 30-day pickup window runs from completion (sign-off, or Not Worth
  // Fixing) — no due date until then.
  _woPickupBadge(wo) {
    if (['picked_up', 'cancelled'].includes(wo.status) || wo.returned_to_customer_at) return '';
    const daysPast = wo.days_past_pickup_due;
    if (daysPast == null) return '';
    if (daysPast > 0) return `<div style="font-size:11px;color:var(--danger)">Pickup overdue ${Math.floor(daysPast)}d</div>`;
    const daysLeft = Math.ceil(-daysPast);
    if (daysLeft <= 5) return `<div style="font-size:11px;color:var(--warning)">Pickup due in ${daysLeft}d</div>`;
    return `<div style="font-size:11px;color:var(--text-muted)">Pickup due in ${daysLeft}d</div>`;
  },

  async loadWorkOrders() {
    const el = document.getElementById('wo-content');
    if (!el) return;
    const isQueue = this.woTab === 'assessed';
    const view = this.woTab === 'all' ? '' : this.woTab;
    const workOrders = await this.api('GET', `/work-orders${view ? '?view='+view : ''}`);
    if (!document.getElementById('wo-content')) return;
    document.getElementById('wo-content').innerHTML = !workOrders.length ? '<div class="empty-state"><p>No work orders found.</p></div>' : `
      ${isQueue ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Waiting to be assessed, oldest first — work top to bottom unless a supervisor bumps a job for express service.</p>` : ''}
      <div class="table-wrap">
      <table class="table">
        <thead><tr>${isQueue ? '<th>#</th>' : ''}<th>WO #</th><th>Customer</th><th>Description</th><th>Branch</th><th>Opened</th>${isQueue ? '<th>Waiting</th>' : '<th>Pickup Due</th>'}<th>Status</th><th></th></tr></thead>
        <tbody>${workOrders.map((wo,i) => `<tr>
          ${isQueue ? `<td class="fw-600">${i+1}</td>` : ''}
          <td class="fw-600">${wo.wo_number}${wo.is_express ? ' <span class="badge-pill badge-danger" style="font-size:10px" title="Express same-day service">⚡</span>' : ''}</td>
          <td>${wo.customer_name||'—'}</td>
          <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.escapeAttr(wo.description)}">${wo.description}</td>
          <td>${wo.branch_name||'—'}</td>
          <td>${this.fmtDate(wo.created_at)}</td>
          ${isQueue ? `<td>${this._woWaitingLabel(wo.created_at)}</td>` : `<td>${wo.pickup_due_date ? this.fmtDate(wo.pickup_due_date) : '<span style="color:var(--text-muted)">After completion</span>'}${this._woPickupBadge(wo)}</td>`}
          <td><span class="badge-pill ${this._woStatusBadge[wo.status]||'badge-secondary'}">${this._woStatusLabels[wo.status]||wo.status}</span>${wo.returned_to_customer_at ? '<div style="font-size:11px;color:var(--text-muted)">Returned to customer</div>' : ''}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-sm btn-outline" onclick="App.viewWorkOrder(${wo.id})">View</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>
      </div>`;
  },

  // Days (or hours, for same-day jobs) since a work order entered the
  // assessment queue — shown next to the FIFO position so a supervisor can
  // see at a glance how long the line has actually been waiting.
  _woWaitingLabel(createdAt) {
    const hours = (Date.now() - new Date(createdAt).getTime()) / 36e5;
    if (hours < 24) return `${Math.max(0, Math.floor(hours))}h`;
    return `${Math.floor(hours / 24)}d`;
  },

  async showWOIntakeModal() {
    const feeServices = await this.api('GET', '/products?is_service=1&active=1');
    this._woFeeServices = feeServices;
    const branches = this.currentUser.branches || [];
    const isMultiBranch = this.currentUser.permissions?.multi_branch_access && branches.length > 1;
    const defaultBranch = branches.find(b => b.is_default) || branches[0] || null;
    this._woIntake = { item: [], acc: [] };
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">New Work Order</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Customer *</label>
            ${this._customerPickerHtml('wo-customer', [], null, { remote: '' })}
          </div>
          <div class="form-group"><label>Branch / Location</label>
            ${isMultiBranch ? `<select id="wo-branch">${branches.map(b=>`<option value="${b.id}" ${defaultBranch && b.id===defaultBranch.id?'selected':''}>${b.name}</option>`).join('')}</select>`
              : `<input type="text" value="${defaultBranch?.name||'No branch assigned'}" disabled style="background:var(--bg-secondary)"><input type="hidden" id="wo-branch" value="${defaultBranch?.id||''}">`}
          </div>
          <div class="input-row">
            <div class="form-group"><label>Item / Tag Label</label><input id="wo-item-label" placeholder="e.g. Red mountain bike"></div>
            <div class="form-group"><label>Item # / Serial #</label><input id="wo-item-serial" placeholder="Serial, model or asset number"></div>
          </div>
          <div class="form-group"><label>Photos of the Item</label>${this._woPhotoPickerHtml('item')}</div>
          <div class="form-group wo-fee-search-wrap" style="position:relative"><label>Assessment Fee *</label>
            <input type="text" id="wo-fee-search" placeholder="Search assessment fee…" autocomplete="off"
              oninput="App._filterWOFeeOptions(this.value)" onfocus="App._filterWOFeeOptions(this.value)">
            <input type="hidden" id="wo-fee-product" value="">
            <div id="wo-fee-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Different machine types can carry different flat fees — pick the one that matches what's coming in.</p>
          </div>
          <div class="form-group"><label>Description *</label><textarea id="wo-description" rows="3" placeholder="What the customer reported / what's being brought in for"></textarea></div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:-4px">The description stays editable after intake, once the item's been assessed.</p>
          <div class="form-group">
            <label style="display:flex;justify-content:space-between;align-items:center">Accessories Handed In
              <button type="button" class="btn btn-sm btn-outline" onclick="App._woAddIntakeAccessory()">+ Add Accessory</button></label>
            <div id="wo-acc-list"></div>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Charger, case, remote, cables… Each one is numbered (A1, A2…) on the work order and its label.</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="wo-intake-save" onclick="App.saveWOIntake()">Open Work Order</button>
        </div>
      </div>`);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.wo-fee-search-wrap')) {
        const dd = document.getElementById('wo-fee-dd');
        if (dd) dd.style.display = 'none';
      }
    });
  },

  _filterWOFeeOptions(query) {
    const dd = document.getElementById('wo-fee-dd');
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._woFeeServices || []).filter(p => !q || p.name.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectWOFeeOption(${p.id})">
        <strong>${p.name}</strong> <span style="color:var(--text-muted);font-size:12px">${this.fmt(p.price)}</span>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No assessment fee services found — add one under Services first.</div>`;
    dd.style.display = '';
  },

  _selectWOFeeOption(productId) {
    const p = (this._woFeeServices || []).find(x => x.id === productId);
    if (!p) return;
    const idEl = document.getElementById('wo-fee-product');
    const searchEl = document.getElementById('wo-fee-search');
    const dd = document.getElementById('wo-fee-dd');
    if (idEl) idEl.value = productId;
    if (searchEl) searchEl.value = `${p.name} (${this.fmt(p.price)})`;
    if (dd) dd.style.display = 'none';
  },

  async saveWOIntake() {
    const customer_id = document.getElementById('wo-customer').value;
    const branch_id = document.getElementById('wo-branch')?.value || null;
    const item_label = document.getElementById('wo-item-label').value.trim();
    const item_serial = document.getElementById('wo-item-serial').value.trim();
    const assessment_fee_product_id = document.getElementById('wo-fee-product').value;
    const description = document.getElementById('wo-description').value.trim();
    const { item: itemPhotos, acc } = this._woIntake;
    if (!customer_id) { this.alert('Please select a customer', 'error'); return; }
    if (!assessment_fee_product_id) { this.alert('Select an assessment fee', 'error'); return; }
    if (!description) { this.alert('A description is required', 'error'); return; }
    const badAcc = acc.findIndex(a => !a.name.trim() || !a.description.trim());
    if (badAcc >= 0) { this.alert(`Accessory A${badAcc + 1} needs a name and a description`, 'error'); return; }
    const unphotographed = [!itemPhotos.length ? 'the item' : null, ...acc.map((a, i) => a.photos.length ? null : `A${i + 1}`)].filter(Boolean);
    if (unphotographed.length && !confirm(`No photo of ${unphotographed.join(', ')}. Open the work order anyway?`)) return;
    const btn = document.getElementById('wo-intake-save');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const wo = await this.api('POST', '/work-orders', { customer_id, branch_id, item_label, item_serial, description, assessment_fee_product_id, employee_id: this.currentUser.id,
        accessories: acc.map(a => ({ name: a.name, serial_number: a.serial_number, description: a.description })) });
      // Accessories come back in the order sent, so photo i of accessory i goes to wo.accessories[i]
      const uploads = [...itemPhotos.map(f => [f, null]), ...acc.flatMap((a, i) => a.photos.map(f => [f, wo.accessories[i].id]))];
      const failed = [];
      for (const [i, [file, accessoryId]] of uploads.entries()) {
        btn.textContent = `Uploading photo ${i + 1} of ${uploads.length}...`;
        try { await this._woUploadPhoto(wo.id, file, accessoryId); } catch(e) { failed.push(e.message); }
      }
      this.closeModal();
      if (failed.length) this.alert(`Work order ${wo.wo_number} opened, but ${failed.length} photo(s) didn't upload — add them from the work order. ${failed.join('; ')}`, 'error');
      else this.alert(`Work order ${wo.wo_number} opened`);
      this.printWOLabel(wo.id);
      // Can be opened from the quote form on the POS screen — don't replace
      // POS with the Work Orders list underneath the closing modal.
      if (this.section === 'work-orders') this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); btn.disabled = false; btn.textContent = 'Open Work Order'; }
  },

  // Intake photos and accessories. "Take Photo" opens the camera on a phone
  // or tablet; "Upload" picks existing files. key is 'item' or the
  // accessory's index in this._woIntake.acc.
  _woPhotoPickerHtml(key) {
    return `<div style="display:flex;gap:6px;flex-wrap:wrap">
        <label class="btn btn-sm btn-outline" style="margin:0;cursor:pointer">📷 Take Photo<input type="file" accept="image/*" capture="environment" style="display:none" onchange="App._woAddIntakePhotos('${key}', this)"></label>
        <label class="btn btn-sm btn-outline" style="margin:0;cursor:pointer">Upload Photos<input type="file" accept="image/*" multiple style="display:none" onchange="App._woAddIntakePhotos('${key}', this)"></label>
      </div>
      <div id="wo-ph-${key}" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"></div>`;
  },

  _woIntakePhotoList(key) { return key === 'item' ? this._woIntake.item : this._woIntake.acc[key].photos; },

  _woAddIntakePhotos(key, input) {
    this._woIntakePhotoList(key).push(...input.files);
    input.value = '';
    this._woRenderIntakePhotos(key);
  },

  _woRemoveIntakePhoto(key, i) {
    this._woIntakePhotoList(key).splice(i, 1);
    this._woRenderIntakePhotos(key);
  },

  _woRenderIntakePhotos(key) {
    const el = document.getElementById(`wo-ph-${key}`);
    if (!el) return;
    el.innerHTML = this._woIntakePhotoList(key).map((f, i) => `<div style="position:relative">
        <img src="${URL.createObjectURL(f)}" style="width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">
        <button type="button" title="Remove" onclick="App._woRemoveIntakePhoto('${key}',${i})" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:none;background:var(--danger);color:#fff;font-size:11px;cursor:pointer;line-height:20px;padding:0">✕</button>
      </div>`).join('');
  },

  _woAddIntakeAccessory() {
    this._woIntake.acc.push({ name: '', serial_number: '', description: '', photos: [] });
    this._woRenderIntakeAccessories();
  },

  _woRemoveIntakeAccessory(i) {
    this._woIntake.acc.splice(i, 1);
    this._woRenderIntakeAccessories();
  },

  _woRenderIntakeAccessories() {
    const el = document.getElementById('wo-acc-list');
    if (!el) return;
    el.innerHTML = this._woIntake.acc.map((a, i) => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-top:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><strong>A${i + 1}</strong>
          <button type="button" class="btn btn-sm btn-outline" onclick="App._woRemoveIntakeAccessory(${i})">Remove</button></div>
        <div class="input-row">
          <div class="form-group"><label>Accessory *</label><input value="${this.escapeAttr(a.name)}" placeholder="e.g. Charger" oninput="App._woIntake.acc[${i}].name = this.value"></div>
          <div class="form-group"><label>Item # / Serial #</label><input value="${this.escapeAttr(a.serial_number)}" oninput="App._woIntake.acc[${i}].serial_number = this.value"></div>
        </div>
        <div class="form-group"><label>Description *</label><textarea rows="2" placeholder="Make/model, colour, condition, any marks or damage" oninput="App._woIntake.acc[${i}].description = this.value">${this.escapeAttr(a.description)}</textarea></div>
        ${this._woPhotoPickerHtml(i)}
      </div>`).join('');
    this._woIntake.acc.forEach((a, i) => this._woRenderIntakePhotos(i));
  },

  async _woUploadPhoto(woId, file, accessoryId) {
    const fd = new FormData();
    fd.append('photo', file);
    if (accessoryId) fd.append('accessory_id', accessoryId);
    const res = await fetch(`/api/work-orders/${woId}/photos`, { method: 'POST', body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`${file.name}: ${e.error || 'Upload failed'}`); }
    return res.json();
  },

  // ─── Item & accessories on an existing work order ───
  _woPhotoThumbs(photos, woId, canRemove) {
    return photos.map(p => `<div style="position:relative">
        <a href="${p.url}" target="_blank" rel="noopener"><img src="${p.url}" loading="lazy" style="width:72px;height:72px;object-fit:cover;border-radius:4px;border:1px solid var(--border)"></a>
        ${canRemove ? `<button type="button" title="Remove photo" onclick="App.deleteWOPhoto(${woId},${p.id})" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:none;background:var(--danger);color:#fff;font-size:11px;cursor:pointer;line-height:20px;padding:0">✕</button>` : ''}
      </div>`).join('');
  },

  _woDetailPhotoButtons(woId, accessoryId) {
    const a = accessoryId || 0;
    return `<label class="btn btn-sm btn-outline" style="margin:0;cursor:pointer;padding:1px 8px;font-size:11px">📷 Take Photo<input type="file" accept="image/*" capture="environment" style="display:none" onchange="App.addWOPhotos(${woId},${a},this)"></label>
      <label class="btn btn-sm btn-outline" style="margin:0;cursor:pointer;padding:1px 8px;font-size:11px">Upload<input type="file" accept="image/*" multiple style="display:none" onchange="App.addWOPhotos(${woId},${a},this)"></label>`;
  },

  _woIntakeSectionHtml(wo) {
    const canAdd = !['picked_up','cancelled'].includes(wo.status) && !wo.returned_to_customer_at && (this.can('work_orders') || this.can('wo_intake'));
    const canRemove = wo.status === 'intake' && canAdd;
    const accs = wo.accessories || [];
    return `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:13px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Item</strong>
        <button type="button" class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.printWOLabel(${wo.id})">Print Label</button>
      </div>
      <div style="margin-top:4px">${wo.item_label ? this.escapeAttr(wo.item_label) : '<span style="color:var(--text-muted)">No tag label</span>'}${wo.item_serial ? ` · <strong>Item #</strong> ${this.escapeAttr(wo.item_serial)}` : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${this._woPhotoThumbs(wo.photos || [], wo.id, canRemove) || '<span style="color:var(--text-muted);font-size:12px">No photos of the item</span>'}</div>
      ${canAdd ? `<div style="display:flex;gap:6px;margin-top:6px">${this._woDetailPhotoButtons(wo.id, 0)}</div>` : ''}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;border-top:1px solid var(--border);padding-top:8px">
        <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Accessories Handed In (${accs.length})</strong>
        ${canAdd ? `<button type="button" class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="document.getElementById('wo-nacc').style.display='block'">+ Add Accessory</button>` : ''}
      </div>
      ${accs.length ? accs.map(a => `<div style="border-top:1px dashed var(--border);margin-top:6px;padding-top:6px">
          <div style="display:flex;justify-content:space-between;gap:8px"><div><strong>A${a.line_no}</strong> — ${this.escapeAttr(a.name)}${a.serial_number ? ` · <strong>Item #</strong> ${this.escapeAttr(a.serial_number)}` : ''}</div>
            ${canRemove ? `<button type="button" class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.deleteWOAccessory(${wo.id},${a.id},'A${a.line_no}')">Remove</button>` : ''}</div>
          <div style="color:var(--text-muted);white-space:pre-wrap">${this.escapeAttr(a.description)}</div>
          ${wo.status === 'picked_up' || wo.returned_to_customer_at ? (a.returned_at ? `<div style="font-size:12px;color:var(--success)">✓ Handed back ${this.fmtDateTime(a.returned_at)}${a.returned_by_name ? ` by ${this.escapeAttr(a.returned_by_name)}` : ''}</div>` : `<div style="font-size:12px;color:var(--danger)">✗ Not handed back</div>`) : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">${this._woPhotoThumbs(a.photos || [], wo.id, canRemove)}</div>
          ${canAdd ? `<div style="display:flex;gap:6px;margin-top:4px">${this._woDetailPhotoButtons(wo.id, a.id)}</div>` : ''}
        </div>`).join('') : '<div style="color:var(--text-muted);font-size:12px;margin-top:4px">None recorded</div>'}
      ${wo.accessories_pickup_note ? `<div style="margin-top:6px;padding:6px 8px;background:var(--bg-secondary);border-radius:4px;font-size:12px"><strong>Hand-back note:</strong> ${this.escapeAttr(wo.accessories_pickup_note)}</div>` : ''}
      ${canAdd ? `<div id="wo-nacc" style="display:none;border-top:1px dashed var(--border);margin-top:8px;padding-top:8px">
          <div class="input-row">
            <div class="form-group"><label>Accessory *</label><input id="wo-nacc-name" placeholder="e.g. Charger"></div>
            <div class="form-group"><label>Item # / Serial #</label><input id="wo-nacc-serial"></div>
          </div>
          <div class="form-group"><label>Description *</label><textarea id="wo-nacc-desc" rows="2" placeholder="Make/model, colour, condition, any marks or damage"></textarea></div>
          <div class="form-group"><label>Photos</label><input type="file" id="wo-nacc-photos" accept="image/*" multiple></div>
          <div style="text-align:right"><button type="button" class="btn btn-sm btn-primary" id="wo-nacc-save" onclick="App.addWOAccessory(${wo.id})">Add Accessory</button></div>
        </div>` : ''}
    </div>`;
  },

  async addWOPhotos(woId, accessoryId, input) {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    this.alert(`Uploading ${files.length} photo(s)...`);
    try {
      for (const f of files) await this._woUploadPhoto(woId, f, accessoryId || null);
      await this.viewWorkOrder(woId);
    } catch(e) { this.alert(e.message, 'error'); await this.viewWorkOrder(woId); }
  },

  async deleteWOPhoto(woId, photoId) {
    if (!confirm('Remove this photo?')) return;
    try { await this.api('DELETE', `/work-orders/${woId}/photos/${photoId}`); await this.viewWorkOrder(woId); }
    catch(e) { this.alert(e.message, 'error'); }
  },

  async addWOAccessory(woId) {
    const name = document.getElementById('wo-nacc-name').value.trim();
    const serial_number = document.getElementById('wo-nacc-serial').value.trim();
    const description = document.getElementById('wo-nacc-desc').value.trim();
    const files = [...document.getElementById('wo-nacc-photos').files];
    if (!name || !description) { this.alert('Enter the accessory and describe it', 'error'); return; }
    const btn = document.getElementById('wo-nacc-save');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const { accessories } = await this.api('POST', `/work-orders/${woId}/accessories`, { name, serial_number, description });
      const added = accessories[accessories.length - 1];
      for (const f of files) await this._woUploadPhoto(woId, f, added.id);
      await this.viewWorkOrder(woId);
    } catch(e) { this.alert(e.message, 'error'); btn.disabled = false; btn.textContent = 'Add Accessory'; }
  },

  async deleteWOAccessory(woId, accId, label) {
    if (!confirm(`Remove accessory ${label} and its photos?`)) return;
    try { await this.api('DELETE', `/work-orders/${woId}/accessories/${accId}`); await this.viewWorkOrder(woId); }
    catch(e) { this.alert(e.message, 'error'); }
  },

  printWOLabel(id) {
    this.api('GET', `/work-orders/${id}/label`).then(wo => {
      const win = window.open('', '_blank', 'width=420,height=320');
      win.document.write(`<!DOCTYPE html><html><head><title>Label – ${wo.wo_number}</title>
      <style>
        body{font-family:Arial,sans-serif;margin:0;padding:20px;text-align:center}
        .wo-num{font-size:28px;font-weight:800;letter-spacing:1px;margin:10px 0}
        .item{font-size:14px;margin-bottom:6px}
        .cust{font-size:12px;color:#555}
        @media print{body{padding:8px}}
      </style></head><body>
      <div style="font-size:12px;text-transform:uppercase;color:#777">Work Order</div>
      <div class="wo-num">${wo.wo_number}</div>
      <div class="item">${wo.item_label || '—'}</div>
      ${wo.item_serial ? `<div class="item">Item # ${this.escapeAttr(wo.item_serial)}</div>` : ''}
      <div class="cust">${wo.customer_name || ''}</div>
      ${(wo.accessories || []).length ? `<div style="margin-top:10px;border-top:1px dashed #999;padding-top:6px;font-size:12px;text-align:left">${wo.accessories.map(a => `<div><strong>${wo.wo_number}-A${a.line_no}</strong> ${this.escapeAttr(a.name)}${a.serial_number ? ` (#${this.escapeAttr(a.serial_number)})` : ''}</div>`).join('')}</div>` : ''}
      <script>window.onload=()=>{window.print()}<\/script>
      </body></html>`);
      win.document.close();
    });
  },

  _woPartStatusBadge(item) {
    if (item.is_customer_supplied) return `<span class="badge-pill badge-info" style="font-size:10px">Customer Supplied</span>`;
    if (item.is_temp_item) {
      const prLink = item.purchase_request_number ? ` <a href="#" style="font-size:10px;color:var(--primary);text-decoration:none" onclick="event.preventDefault();App.closeModal();App.viewPR(${item.purchase_request_id})">${item.purchase_request_number}</a>` : '';
      return `<span class="badge-pill badge-warning" style="font-size:10px" title="Flagged for Purchasing to order">Q</span>${prLink}`;
    }
    if (!item.sources || !item.sources.length) return `<span class="badge-pill badge-success" style="font-size:10px">Sourced from ${this.escapeAttr(this._woCurrentBranchName||'branch')}</span>`;
    return item.sources.map(s => {
      // The WO's own branch's covered portion is stored as a source row too
      // (needed so sourcesSum === quantity server-side) but was already in
      // stock there — nothing to transfer or purchase for it.
      if (String(s.branch_id) === String(this._woCurrentBranchId)) return `<span class="badge-pill badge-success" style="font-size:10px">${s.quantity} from ${this.escapeAttr(this._woCurrentBranchName||'branch')}</span>`;
      if (s.transfer_id) return `<span class="badge-pill badge-info" style="font-size:10px">Transfer ${s.transfer_number||''} — ${s.transfer_status||'pending'}</span>`;
      if (s.purchase_request_id) return `<span class="badge-pill ${s.purchase_request_status==='received'||s.purchase_request_status==='closed'?'badge-success':'badge-warning'}" style="font-size:10px">PR ${s.purchase_request_number||''} — ${s.purchase_request_status||'pending'}</span>`;
      return `<span class="badge-pill badge-warning" style="font-size:10px">${s.branch_name||'Other branch'} pending</span>`;
    }).join(' ');
  },

  async viewWorkOrder(id) {
    const wo = await this.api('GET', `/work-orders/${id}`);
    this._woCurrentBranchName = wo.branch_name;
    this._woCurrentBranchId = wo.branch_id;
    const estimateTotal = (parseFloat(wo.estimate_labor)||0) + (parseFloat(wo.estimate_consumables)||0);
    const estimateTax = parseFloat((estimateTotal * (parseFloat(wo.estimate_tax_rate)||0) / 100).toFixed(2));
    const assessmentTax = parseFloat(((parseFloat(wo.assessment_fee)||0) * (parseFloat(wo.assessment_fee_tax_rate)||0) / 100).toFixed(2));
    // Parts can be identified and assigned as soon as the item's in the door —
    // mirrors what the backend already allows (any pre-completion status), so
    // a tech isn't blocked from pulling/ordering parts just because the
    // customer hasn't paid a deposit yet.
    const canManageParts = !['cancelled','not_worth_fixing'].includes(wo.status);
    const partsEditable = !['complete','awaiting_pickup','picked_up','cancelled','not_worth_fixing'].includes(wo.status) && this.can('wo_assign_parts');
    if (partsEditable) {
      const [products, branches] = await Promise.all([
        this.api('GET', `/products?is_service=0&is_rental=0&active=1${wo.branch_id?'&branch_id='+wo.branch_id:''}`),
        this.api('GET', '/branches'),
      ]);
      this._woPartsProducts = products;
      this._woBranches = (branches||[]).filter(b => String(b.id) !== String(wo.branch_id));
      this._woPartsStockCache = {};
      // Part lines are added dynamically (addWOPartLine), so this closes
      // whichever wop-prod-dd-* dropdown is currently open rather than
      // binding to a specific line's id.
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.wop-prod-search-wrap')) {
          document.querySelectorAll('[id^="wop-prod-dd-"]').forEach(dd => { dd.style.display = 'none'; });
        }
      });
    }
    const tasksSectionVisible = ['in_progress','awaiting_signoff','awaiting_parts','complete','awaiting_pickup','picked_up','not_worth_fixing'].includes(wo.status);
    const tasksEditable = ['in_progress','awaiting_signoff','awaiting_parts'].includes(wo.status) && this.can('wo_technician');
    if (tasksEditable) {
      this._woTechnicians = await this.api('GET', '/employees');
    }
    const partsTotal = (wo.items||[]).reduce((s,i) => s + (parseFloat(i.total)||0), 0);
    const partsTax = (wo.items||[]).reduce((s,i) => s + (parseFloat(i.total)||0) * (parseFloat(i.tax_rate)||0) / 100, 0);
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">${wo.wo_number} <span class="badge-pill ${this._woStatusBadge[wo.status]||'badge-secondary'}" style="margin-left:6px">${this._woStatusLabels[wo.status]||wo.status}</span>${wo.is_express ? `<span class="badge-pill badge-danger" style="margin-left:6px" title="Express same-day service — 25% surcharge applied">⚡ Express</span>` : ''}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Customer</label><div>${wo.customer_name||'—'} ${wo.customer_phone?`<span style="color:var(--text-muted);font-size:12px">(${wo.customer_phone})</span>`:''}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Branch</label><div>${wo.branch_name||'—'}</div></div>
          </div>
          <div class="input-row" style="margin-bottom:10px">
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Opened</label><div>${this.fmtDateTime(wo.created_at)}</div></div>
            <div><label style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Pickup Due</label><div>${wo.pickup_due_date ? this.fmtDate(wo.pickup_due_date) : '30 days after completion'}${this._woPickupBadge(wo)}</div></div>
          </div>
          ${wo.returned_to_customer_at ? `<div style="margin-bottom:10px;padding:6px 10px;border-radius:6px;background:var(--bg-secondary);font-size:13px">✓ <strong>Returned to customer</strong> ${this.fmtDateTime(wo.returned_to_customer_at)}${wo.returned_to_customer_by_name ? ` by ${this.escapeAttr(wo.returned_to_customer_by_name)}` : ''}</div>` : ''}
          <div class="form-group">
            <label style="display:flex;justify-content:space-between;align-items:center">Description
              ${!['complete','awaiting_pickup','picked_up','cancelled','not_worth_fixing'].includes(wo.status) && this.can('work_orders') ? `<button type="button" class="btn btn-sm btn-outline" onclick="App._toggleWODescEdit(${wo.id})">Edit</button>` : ''}
            </label>
            <div id="wo-desc-view">${wo.description}</div>
            <div id="wo-desc-edit" style="display:none">
              <textarea id="wo-desc-input" rows="3">${wo.description}</textarea>
              <input id="wo-serial-input" placeholder="Item # / Serial #" value="${this.escapeAttr(wo.item_serial || '')}" style="margin-top:6px">
              <div style="text-align:right;margin-top:4px"><button class="btn btn-sm btn-primary" onclick="App.saveWODescription(${wo.id})">Save</button></div>
            </div>
          </div>
          <div class="form-group">
            <label style="display:flex;justify-content:space-between;align-items:center">Customer P.O. #
              ${this.can('work_orders') ? `<button type="button" class="btn btn-sm btn-outline" onclick="App.editWOPoNumber(${wo.id}, '${this.escapeAttr(wo.po_number || '').replace(/'/g, "\\'")}')">Edit</button>` : ''}
            </label>
            <div>${wo.po_number ? this.escapeAttr(wo.po_number) : '<span style="color:var(--text-muted)">None — the invoice prints a blank line</span>'}</div>
          </div>
          ${this._woIntakeSectionHtml(wo)}

          <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:13px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Fees & Estimate</strong>
            <div style="display:flex;justify-content:space-between;margin-top:4px"><span>Assessment Fee</span><span>${this.fmt(wo.assessment_fee)} ${wo.assessment_transaction_id ? '<span class="badge-pill badge-success" style="font-size:10px">Paid</span>' : '<span style="color:var(--text-muted)">Unpaid</span>'}</span></div>
            ${assessmentTax > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:12px"><span>Tax on Assessment Fee</span><span>${this.fmt(assessmentTax)}</span></div>` : ''}
            ${wo.status !== 'intake' ? `<div style="display:flex;justify-content:space-between"><span>Estimate (labor + consumables)${wo.is_express ? ' <span class="badge-pill badge-danger" style="font-size:10px">Express +25%</span>' : ''}</span><span>${this.fmt(estimateTotal)}</span></div>` : ''}
            ${partsTotal > 0 ? `<div style="display:flex;justify-content:space-between"><span>Parts</span><span>${this.fmt(partsTotal)}</span></div>` : ''}
            ${(estimateTax+partsTax) > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:12px"><span>Tax (estimate + parts)</span><span>${this.fmt(estimateTax+partsTax)}</span></div>` : ''}
            ${wo.deposit_amount > 0 ? `<div style="display:flex;justify-content:space-between"><span>Deposit</span><span>${this.fmt(wo.deposit_amount)} ${wo.deposit_transaction_id ? '<span class="badge-pill badge-success" style="font-size:10px">Paid</span>' : '<span style="color:var(--text-muted)">Unpaid</span>'}</span></div>` : ''}
            ${['complete','awaiting_pickup','picked_up'].includes(wo.status) ? `<div style="display:flex;justify-content:space-between;margin-top:4px;border-top:1px solid var(--border);padding-top:4px"><strong>Balance Due</strong><strong>${this.fmt(Math.max(0, estimateTotal + partsTotal + estimateTax + partsTax - (parseFloat(wo.deposit_amount)||0)))} ${wo.final_transaction_id ? '<span class="badge-pill badge-success" style="font-size:10px">Paid</span>' : (wo.status === 'picked_up' ? '' : '<span style="color:var(--text-muted)">Unpaid</span>')}</strong></div>` : ''}
            ${wo.estimate_notes ? `<div style="color:var(--text-muted);margin-top:4px">${wo.estimate_notes}</div>` : ''}
          </div>

          ${canManageParts ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Parts</strong>
            <div id="wo-parts-list" style="margin-top:6px">
              ${(wo.items||[]).length ? `<table class="table" style="font-size:12px"><thead><tr><th>Part</th><th>Qty</th><th title="Taken out of this branch's stock for the job">Issued</th><th>Total</th><th>Source</th><th></th></tr></thead><tbody>
                ${wo.items.map(i => { const remaining = i.quantity - (i.quantity_returned||0); const canReturn = partsEditable && i.product_id && !i.is_customer_supplied && remaining > 0; const toIssue = i.product_id && !i.is_customer_supplied ? Math.max(0, (wo.items.filter(x => x.product_id === i.product_id && !x.is_customer_supplied).reduce((t, x) => t + x.quantity - (x.quantity_returned || 0), 0)) - (i.issued_qty || 0)) : 0; const canIssue = partsEditable && toIssue > 0 && wo.branch_id; return `<tr><td>${i.product_name}</td><td>${i.quantity}${i.quantity_returned>0?` <span style="color:var(--text-muted)">(${i.quantity_returned} returned)</span>`:''}</td><td>${i.product_id && !i.is_customer_supplied ? (i.issued_qty || 0) : '—'}</td><td>${this.fmt(i.total)}</td><td>${this._woPartStatusBadge(i)}</td><td style="white-space:nowrap">${canIssue ? `<button class="btn btn-sm btn-primary" title="Take it out of this branch's stock for the job" onclick="App.issueWOPart(${wo.id},${i.product_id},${toIssue},'${this.escapeAttr(i.product_name).replace(/'/g, '&#39;')}')">Issue</button> ` : ''}${canReturn ? `<button class="btn btn-sm btn-outline" onclick="App.showWOPartReturnModal(${wo.id},${i.id})">Return</button>` : ''}</td></tr>`; }).join('')}
              </tbody></table>` : '<div style="color:var(--text-muted);font-size:12px">No parts assigned yet</div>'}
            </div>
            ${partsEditable ? `
            <div id="wo-parts-new-lines" style="margin-top:8px"></div>
            <button type="button" class="btn btn-sm btn-outline" style="margin-top:4px" onclick="App.addWOPartLine(${wo.id})">+ Add Part</button>
            <div style="text-align:right;margin-top:8px;display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-sm btn-secondary" onclick="App.saveWOParts(${wo.id})">Save Parts</button>
              <button class="btn btn-sm btn-primary" onclick="App.confirmWOParts(${wo.id})">Confirm Parts</button>
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">Save Parts records what's needed; Confirm Parts is what actually creates the branch transfer or purchase request for anything not in stock here.</p>` : ''}
          </div>` : ''}

          ${tasksSectionVisible ? `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Tasks</strong>
            <div id="wo-tasks-list" style="margin-top:6px">
              ${(wo.tasks||[]).length ? wo.tasks.map(t => this._woTaskRowHtml(wo.id, t, tasksEditable)).join('') : '<div style="color:var(--text-muted);font-size:12px">No tasks yet</div>'}
            </div>
            ${tasksEditable ? `
            <div id="wo-task-form" style="display:none;margin-top:8px;border-top:1px dashed var(--border);padding-top:8px">
              <div class="form-group" style="margin-bottom:6px"><input id="wo-task-desc" placeholder="Task description"></div>
              <div class="input-row" style="margin-bottom:6px">
                <div class="form-group"><label style="font-size:11px">Allotted (minutes)</label><input type="number" id="wo-task-allotted" min="0" value="30"></div>
                <div class="form-group"><label style="font-size:11px">Technician</label>
                  <select id="wo-task-tech"><option value="">-- Unassigned --</option>${(this._woTechnicians||[]).map(e=>`<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}</select>
                </div>
              </div>
              <button class="btn btn-sm btn-primary" onclick="App.saveWOTask(${wo.id})">Add Task</button>
              <button class="btn btn-sm btn-secondary" onclick="document.getElementById('wo-task-form').style.display='none'">Cancel</button>
            </div>
            <button type="button" class="btn btn-sm btn-outline" style="margin-top:8px" onclick="document.getElementById('wo-task-form').style.display='block'">+ Add Task</button>` : ''}
          </div>` : ''}

          <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px">
            <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Status History</strong>
            <div style="max-height:180px;overflow-y:auto;margin-top:6px">
              ${wo.status_log.map(l => `<div style="font-size:12px;padding:5px 0;border-top:1px solid var(--border)">
                <strong>${this._woStatusLabels[l.status]||l.status}</strong> — ${this.fmtDateTime(l.created_at)}${l.employee_name?` · ${l.employee_name}`:''}
                ${l.comment ? `<div style="color:var(--text-muted)">${l.comment}</div>` : ''}
              </div>`).join('') || '<div style="color:var(--text-muted);font-size:12px;padding:6px 0">No history yet</div>'}
            </div>
          </div>
        </div>
        <div class="modal-footer" style="flex-wrap:wrap">
          ${wo.status==='intake' ? `<span class="badge-pill badge-warning" style="align-self:center;padding:6px 10px" title="Collected at the register — open Hold Recall in POS to take payment">On hold — awaiting cashier</span>` : ''}
          ${wo.status==='assessed' && this.can('wo_assess') ? `<button class="btn btn-primary" onclick="App.closeModal();App.showWOEstimateModal(${wo.id})">Enter Estimate</button>` : ''}
          ${wo.status==='pending_deposit' ? `<span class="badge-pill badge-warning" style="align-self:center;padding:6px 10px" title="Collected at the register — open Hold Recall in POS to take payment">On hold — awaiting cashier</span>` : ''}
          ${['in_progress','awaiting_signoff','awaiting_parts'].includes(wo.status) && this.can('work_orders') ? `<button class="btn btn-secondary" onclick="App.closeModal();App.showWOStatusCommentModal(${wo.id})">Add Status Update</button>` : ''}
          ${['in_progress','awaiting_signoff'].includes(wo.status) && this.can('wo_signoff') ? `<button class="btn btn-primary" onclick="App.closeModal();App.showWOSignoffModal(${wo.id})">Supervisor Sign-Off</button>` : ''}
          ${wo.status==='complete' && this.can('work_orders') ? `<button class="btn btn-primary" onclick="App.closeModal();App.showWONotifyModal(${wo.id})">Notify Customer</button>` : ''}
          ${wo.status==='awaiting_pickup' ? `<span class="badge-pill badge-warning" style="align-self:center;padding:6px 10px" title="Collected at the register — open Hold Recall in POS to take payment">On hold — awaiting cashier</span>` : ''}
          ${['intake','assessed','pending_deposit'].includes(wo.status) && this.can('work_orders') ? `<button class="btn btn-danger" onclick="App.closeModal();App.showWOCancelModal(${wo.id})">Cancel Work Order</button>` : ''}
          ${['not_worth_fixing','cancelled'].includes(wo.status) && !wo.returned_to_customer_at && this.can('work_orders') ? `<button class="btn btn-primary" onclick="App.showWOReturnToCustomerModal(${wo.id})">Return to Customer</button>` : ''}
          <button class="btn btn-secondary" title="Opens the customer copy — choose Save as PDF in the print dialog to attach it to an email" onclick="App.printWorkOrderInvoice(${wo.id})">🖨️ Print Invoice</button>
          <button class="btn btn-secondary" onclick="App.emailWorkOrderInvoice(${wo.id}, '${(wo.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email Invoice</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  _toggleWODescEdit(id) {
    document.getElementById('wo-desc-view').style.display = 'none';
    document.getElementById('wo-desc-edit').style.display = 'block';
  },

  async saveWODescription(id) {
    const description = document.getElementById('wo-desc-input').value.trim();
    if (!description) { this.alert('Description cannot be empty', 'error'); return; }
    try {
      await this.api('PATCH', `/work-orders/${id}`, { description, item_serial: document.getElementById('wo-serial-input').value.trim(), employee_id: this.currentUser.id });
      await this.viewWorkOrder(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async editWOPoNumber(id, current) {
    const po = prompt("Customer's P.O. number (leave blank to clear):", current || '');
    if (po === null) return;
    try {
      await this.api('PATCH', `/work-orders/${id}/po-number`, { po_number: po.trim() });
      await this.viewWorkOrder(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showWOAssessmentFeeModal(id) {
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Process Assessment Fee</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">This fee is non-refundable and covers the initial assessment of the item.</p>
          <div class="form-group"><label>Payment Method</label>
            <select id="wo-fee-paymethod"><option value="cash">Cash</option><option value="credit_card">Card</option><option value="check">Check</option><option value="tax_exempt_tender">Tax Exempt</option></select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmWOAssessmentFee(${id})">Confirm Payment</button>
        </div>
      </div>`);
  },

  async confirmWOAssessmentFee(id) {
    const payment_method = document.getElementById('wo-fee-paymethod').value;
    try {
      const wo = await this.api('PATCH', `/work-orders/${id}/assessment-paid`, {
        payment_method, employee_id: this.currentUser.id, drawer_session_id: this.currentDrawerSession?.id || null,
      });
      this.closeModal();
      this.alert(`Assessment fee collected for ${wo.wo_number}`);
      if (this.section === 'work-orders') this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showWOEstimateModal(id) {
    const canExpress = this.can('wo_signoff');
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Enter Estimate</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="input-row">
            <div class="form-group"><label>Labor Estimate</label><input type="number" id="wo-est-labor" min="0" step="0.01" value="0" oninput="App._updateWOEstimatePreview()"></div>
            <div class="form-group"><label>Consumables Estimate</label><input type="number" id="wo-est-consumables" min="0" step="0.01" value="0" oninput="App._updateWOEstimatePreview()"></div>
          </div>
          <div class="form-group"><label>Estimate Notes</label><textarea id="wo-est-notes" rows="2" placeholder="What's needed, findings from assessment, etc."></textarea></div>
          <div class="form-group"><label>Deposit (optional)</label><input type="number" id="wo-est-deposit" min="0" step="0.01" placeholder="Leave blank if no deposit is required"></div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:-4px">Parts costs are added separately once parts are assigned, and will show alongside this estimate.</p>
          ${canExpress ? `
          <div class="form-group" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal">
              <input type="checkbox" id="wo-est-express" style="width:16px;height:16px;cursor:pointer" onchange="App._updateWOEstimatePreview()">
              ⚡ Express same-day service (+25%)
            </label>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Supervisor discretion only — weigh how many other jobs are queued and how hard this one is before offering it.</p>
            <p id="wo-est-preview" style="font-size:12px;font-weight:600;margin:6px 0 0"></p>
          </div>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveWOEstimate(${id})">Save Estimate</button>
        </div>
      </div>`);
    if (canExpress) this._updateWOEstimatePreview();
  },

  _updateWOEstimatePreview() {
    const preview = document.getElementById('wo-est-preview');
    if (!preview) return;
    const labor = parseFloat(document.getElementById('wo-est-labor').value) || 0;
    const consumables = parseFloat(document.getElementById('wo-est-consumables').value) || 0;
    const express = document.getElementById('wo-est-express')?.checked;
    const base = labor + consumables;
    preview.textContent = express ? `Total with express surcharge: ${this.fmt(base * 1.25)} (base ${this.fmt(base)} + 25%)` : `Total: ${this.fmt(base)}`;
  },

  async saveWOEstimate(id) {
    const estimate_labor = document.getElementById('wo-est-labor').value;
    const estimate_consumables = document.getElementById('wo-est-consumables').value;
    const estimate_notes = document.getElementById('wo-est-notes').value.trim();
    const deposit_amount = document.getElementById('wo-est-deposit').value;
    const is_express = document.getElementById('wo-est-express')?.checked || false;
    try {
      const wo = await this.api('PATCH', `/work-orders/${id}/estimate`, { estimate_labor, estimate_consumables, estimate_notes, deposit_amount, is_express, employee_id: this.currentUser.id });
      this.closeModal();
      this.alert(`Estimate saved for ${wo.wo_number}${is_express ? ' — express same-day' : ''}${wo.status === 'in_progress' ? ' — no deposit required, now in progress' : ''}`);
      this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showWODepositModal(id) {
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Process Deposit</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Payment Method</label>
            <select id="wo-dep-paymethod"><option value="cash">Cash</option><option value="credit_card">Card</option><option value="check">Check</option><option value="tax_exempt_tender">Tax Exempt</option></select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmWODeposit(${id})">Confirm Payment</button>
        </div>
      </div>`);
  },

  async confirmWODeposit(id) {
    const payment_method = document.getElementById('wo-dep-paymethod').value;
    try {
      const wo = await this.api('PATCH', `/work-orders/${id}/deposit-paid`, {
        payment_method, employee_id: this.currentUser.id, drawer_session_id: this.currentDrawerSession?.id || null,
      });
      this.closeModal();
      this.alert(`Deposit collected for ${wo.wo_number} — now in progress`);
      if (this.section === 'work-orders') this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showWOStatusCommentModal(id) {
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Add Status Update</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Status</label>
            <select id="wo-status-select">
              <option value="">No change — just log a comment</option>
              <option value="in_progress">In Progress</option>
              <option value="awaiting_signoff">Awaiting Sign-Off (work done, ready for supervisor)</option>
              <option value="awaiting_parts">Awaiting Parts (paused, waiting on a part)</option>
              <option value="not_worth_fixing">Not Worth Fixing (stop work, item isn't repairable/economical)</option>
            </select>
          </div>
          <div class="form-group"><label>Comment *</label><textarea id="wo-status-comment" rows="3" placeholder="What's happening"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveWOStatusComment(${id})">Save</button>
        </div>
      </div>`);
  },

  async saveWOStatusComment(id) {
    const status = document.getElementById('wo-status-select').value || null;
    const comment = document.getElementById('wo-status-comment').value.trim();
    if (!comment) { this.alert('A comment is required', 'error'); return; }
    try {
      await this.api('PATCH', `/work-orders/${id}/status`, { status, comment, employee_id: this.currentUser.id });
      this.closeModal();
      await this.viewWorkOrder(id);
      this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  showWOCancelModal(id) {
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Cancel Work Order</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Reason *</label><textarea id="wo-cancel-reason" rows="3"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Back</button>
          <button class="btn btn-danger" onclick="App.confirmWOCancel(${id})">Cancel Work Order</button>
        </div>
      </div>`);
  },

  async confirmWOCancel(id) {
    const reason = document.getElementById('wo-cancel-reason').value.trim();
    if (!reason) { this.alert('A cancellation reason is required', 'error'); return; }
    try {
      await this.api('PATCH', `/work-orders/${id}/cancel`, { reason, employee_id: this.currentUser.id });
      this.closeModal();
      this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Work Order parts (mirrors the quotation item-picker/allocator —
  // public/index.html's addQuoteItem/checkQuoteItemStock/recalcQuoteAllocation
  // — copied rather than shared so changes here can't affect the working
  // quote flow, same reasoning as the rental item picker). Unlike a quote,
  // a WO's branch is fixed at intake, so there's no branch selector to react
  // to here — sourcing is always computed against wo.branch_id. ─────────────

  _woNewPartIdx: 0,

  addWOPartLine() {
    const idx = this._woNewPartIdx++;
    const container = document.getElementById('wo-parts-new-lines');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'po-receive-row';
    div.id = `wo-part-${idx}`;
    div.style.flexWrap = 'wrap';
    div.innerHTML = `
      <select style="flex:0 0 190px" id="wop-type-${idx}" onchange="App.toggleWOPartLineType(${idx})">
        <option value="product">Catalog Product (in stock or elsewhere)</option>
        <option value="custom">Not In Our Catalog — Order It</option>
        <option value="customer">Customer Brought Their Own</option>
      </select>
      <span id="wop-product-fields-${idx}" style="display:flex;flex:1;gap:8px;min-width:260px">
        <span class="wop-prod-search-wrap" style="flex:2;position:relative">
          <input type="text" id="wop-prod-search-${idx}" placeholder="Search parts…" autocomplete="off" style="width:100%"
            oninput="App._filterWOPartOptions(${idx},this.value)" onfocus="App._filterWOPartOptions(${idx},this.value)">
          <input type="hidden" id="wop-prod-${idx}" value="">
          <div id="wop-prod-dd-${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
        </span>
        <input id="wop-qty-${idx}" type="number" min="1" value="1" style="width:70px" placeholder="Qty" oninput="App.checkWOPartStock(${idx})">
      </span>
      <span id="wop-custom-fields-${idx}" style="display:none;flex:1;gap:8px;min-width:260px">
        <input id="wop-desc-${idx}" placeholder="Item description" style="flex:2">
        <input id="wop-custom-qty-${idx}" type="number" min="1" value="1" style="width:70px" placeholder="Qty">
        <input id="wop-price-${idx}" type="number" min="0" step="0.01" style="width:90px" placeholder="Unit price">
      </span>
      <span id="wop-customer-fields-${idx}" style="display:none;flex:1;gap:8px;min-width:260px">
        <input id="wop-cs-desc-${idx}" placeholder="Item description" style="flex:2">
        <input id="wop-cs-qty-${idx}" type="number" min="1" value="1" style="width:70px" placeholder="Qty">
      </span>
      <button class="btn btn-sm btn-danger" onclick="document.getElementById('wo-part-${idx}').remove();const a=document.getElementById('wo-part-alloc-${idx}');if(a)a.remove();const h=document.getElementById('wo-part-hint-${idx}');if(h)h.remove()">✕</button>
      <div id="wo-part-hint-${idx}" style="flex-basis:100%;font-size:11px;color:var(--text-muted);margin-top:2px">Checked against this branch's stock — a shortfall is auto-sourced from another branch or sent to Purchasing.</div>`;
    container.appendChild(div);
    const allocDiv = document.createElement('div');
    allocDiv.id = `wo-part-alloc-${idx}`;
    container.appendChild(allocDiv);
  },

  // Searchable replacement for what used to be a plain <select> of every
  // part in the catalog — checkWOPartStock/recalcWOPartAllocation/
  // _collectWOPartLines all read wop-prod-${idx}'s value directly (a hidden
  // input here, same id/semantics as the old select), so none of them
  // needed to change.
  _filterWOPartOptions(idx, query) {
    const dd = document.getElementById(`wop-prod-dd-${idx}`);
    if (!dd) return;
    const q = (query || '').toLowerCase().trim();
    const matches = (this._woPartsProducts || []).filter(p => !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q));
    dd.innerHTML = matches.length ? matches.slice(0, 50).map(p => `
      <div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--text)" onclick="App._selectWOPartOption(${idx},${p.id})">
        <strong>${p.name}</strong>
        <div style="font-size:11px;color:var(--text-muted)">${this.fmt(p.price)} · stock: ${p.stock_qty}${p.sku ? ' · ' + p.sku : ''}</div>
      </div>`).join('') : `<div style="padding:10px;color:var(--text-muted);font-size:13px">No parts found</div>`;
    dd.style.display = '';
  },

  _selectWOPartOption(idx, productId) {
    const p = (this._woPartsProducts || []).find(x => x.id === productId);
    if (!p) return;
    const hidden = document.getElementById(`wop-prod-${idx}`);
    const searchEl = document.getElementById(`wop-prod-search-${idx}`);
    const dd = document.getElementById(`wop-prod-dd-${idx}`);
    if (hidden) hidden.value = productId;
    if (searchEl) searchEl.value = p.name;
    if (dd) dd.style.display = 'none';
    this.checkWOPartStock(idx);
  },

  _woPartTypeHints: {
    product: "Checked against this branch's stock — a shortfall is auto-sourced from another branch or sent to Purchasing.",
    custom: "Not in the catalog at all — automatically sent to Purchasing to order once you Confirm Parts. Enter your best price estimate; Purchasing can adjust it later.",
    customer: "The customer brought this part themselves — no charge, and it's never sourced or sent to Purchasing. It just shows up on the WO for the technician.",
  },

  toggleWOPartLineType(idx) {
    const type = document.getElementById(`wop-type-${idx}`)?.value;
    document.getElementById(`wop-product-fields-${idx}`).style.display = type === 'product' ? 'flex' : 'none';
    document.getElementById(`wop-custom-fields-${idx}`).style.display = type === 'custom' ? 'flex' : 'none';
    document.getElementById(`wop-customer-fields-${idx}`).style.display = type === 'customer' ? 'flex' : 'none';
    const hintDiv = document.getElementById(`wo-part-hint-${idx}`);
    if (hintDiv) hintDiv.textContent = this._woPartTypeHints[type] || '';
    const allocDiv = document.getElementById(`wo-part-alloc-${idx}`);
    if (allocDiv && type !== 'product') allocDiv.innerHTML = '';
  },

  async getWOBranchStock(branchId) {
    this._woPartsStockCache = this._woPartsStockCache || {};
    if (!this._woPartsStockCache[branchId]) {
      const all = await this.api('GET', `/products?branch_id=${branchId}`);
      const map = {};
      all.forEach(p => { map[p.id] = { stock_qty: p.stock_qty }; });
      this._woPartsStockCache[branchId] = map;
    }
    return this._woPartsStockCache[branchId];
  },

  async checkWOPartStock(idx) {
    const prodSel = document.getElementById(`wop-prod-${idx}`);
    const allocDiv = document.getElementById(`wo-part-alloc-${idx}`);
    if (!prodSel || !allocDiv) return;
    const productId = parseInt(prodSel.value);
    const qty = parseInt(document.getElementById(`wop-qty-${idx}`)?.value) || 0;
    if (!productId || !qty) { allocDiv.innerHTML = ''; return; }

    // this._woPartsProducts was already fetched branch-scoped (see
    // viewWorkOrder), so its stock_qty is the home branch's available qty.
    const homeProduct = (this._woPartsProducts||[]).find(p => p.id === productId);
    const available = homeProduct?.stock_qty || 0;
    if (qty <= available) { allocDiv.innerHTML = ''; delete allocDiv.dataset.productId; return; }

    const shortfall = qty - available;
    const otherBranches = this._woBranches || [];
    await Promise.all(otherBranches.map(b => this.getWOBranchStock(b.id)));
    const rowsHtml = otherBranches.map(b => {
      const avail = (this._woPartsStockCache[b.id]||{})[productId]?.stock_qty || 0;
      return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-top:4px">
        <span style="flex:1">${b.name} <span style="color:var(--text-muted)">(avail: ${avail})</span></span>
        <input type="number" min="0" max="${avail}" value="0" style="width:70px" id="wo-part-alloc-${idx}-b${b.id}" data-branch="${b.id}" data-max="${avail}" oninput="App.recalcWOPartAllocation(${idx})">
      </div>`;
    }).join('');
    allocDiv.dataset.productId = productId;
    allocDiv.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--warning,#f59e0b);border-radius:6px;padding:8px 10px;margin:2px 0 8px">
        <div style="font-size:12px;color:var(--warning,#f59e0b);font-weight:600;margin-bottom:4px">⚠ Only ${available} available at this branch — source the remaining <span id="wo-part-alloc-${idx}-shortfall">${shortfall}</span> from elsewhere:</div>
        ${rowsHtml}
        <div style="font-size:12px;margin-top:6px;font-weight:600">To purchase (no stock available): <span id="wo-part-alloc-${idx}-remainder">${shortfall}</span></div>
      </div>`;
  },

  recalcWOPartAllocation(idx) {
    const prodSel = document.getElementById(`wop-prod-${idx}`);
    const productId = parseInt(prodSel?.value);
    const qty = parseInt(document.getElementById(`wop-qty-${idx}`)?.value) || 0;
    const homeProduct = (this._woPartsProducts||[]).find(p => p.id === productId);
    const available = homeProduct?.stock_qty || 0;
    const shortfall = Math.max(0, qty - available);
    let allocated = 0;
    document.querySelectorAll(`[id^="wo-part-alloc-${idx}-b"]`).forEach(inp => {
      let v = parseInt(inp.value) || 0;
      const max = parseInt(inp.dataset.max) || 0;
      if (v > max) v = max;
      if (v < 0) v = 0;
      inp.value = v;
      allocated += v;
    });
    const remEl = document.getElementById(`wo-part-alloc-${idx}-remainder`);
    if (remEl) remEl.textContent = Math.max(0, shortfall - allocated);
  },

  // Rebuilds each line's branch split deterministically so it always sums
  // exactly to `quantity` — home branch first (up to its available stock),
  // then each other branch's allocator input (capped at what's actually
  // left to cover), then whatever's still unassigned goes to Purchasing
  // (branch_id: null). Exactly mirrors the quotation form's own submit
  // logic (search homeQty in this file) — the backend's sourcesSum===qty
  // validation requires the home branch's covered portion to be included
  // as its own row, not omitted.
  _collectWOPartLines() {
    const rows = document.querySelectorAll('#wo-parts-new-lines > [id^="wo-part-"]');
    const items = [];
    for (const row of rows) {
      if (row.id.includes('alloc')) continue;
      const idx = row.id.replace('wo-part-', '');
      const type = document.getElementById(`wop-type-${idx}`)?.value || 'product';

      if (type === 'custom') {
        const description = document.getElementById(`wop-desc-${idx}`)?.value.trim();
        const qty = parseInt(document.getElementById(`wop-custom-qty-${idx}`)?.value) || 0;
        const unit_price = parseFloat(document.getElementById(`wop-price-${idx}`)?.value) || 0;
        if (!description || !qty) continue;
        items.push({ description, quantity: qty, unit_price });
        continue;
      }
      if (type === 'customer') {
        const description = document.getElementById(`wop-cs-desc-${idx}`)?.value.trim();
        const qty = parseInt(document.getElementById(`wop-cs-qty-${idx}`)?.value) || 0;
        if (!description || !qty) continue;
        items.push({ description, quantity: qty, is_customer_supplied: true });
        continue;
      }

      const prodSel = document.getElementById(`wop-prod-${idx}`);
      if (!prodSel || !prodSel.value) continue;
      const productId = parseInt(prodSel.value);
      const qty = parseInt(document.getElementById(`wop-qty-${idx}`)?.value) || 0;
      if (!qty) continue;
      const item = { product_id: productId, quantity: qty };
      const allocInputs = document.querySelectorAll(`[id^="wo-part-alloc-${idx}-b"]`);
      if (allocInputs.length) {
        const homeProduct = (this._woPartsProducts||[]).find(p => p.id === productId);
        const available = homeProduct?.stock_qty || 0;
        const homeQty = Math.min(qty, available);
        let remaining = qty - homeQty;
        const sources = [];
        if (homeQty > 0) sources.push({ branch_id: this._woCurrentBranchId, quantity: homeQty });
        allocInputs.forEach(inp => {
          if (remaining <= 0) return;
          const v = Math.min(parseInt(inp.value) || 0, remaining);
          if (v > 0) { sources.push({ branch_id: parseInt(inp.dataset.branch), quantity: v }); remaining -= v; }
        });
        if (remaining > 0) sources.push({ branch_id: null, quantity: remaining });
        item.sources = sources;
      }
      items.push(item);
    }
    return items;
  },

  async saveWOParts(id) {
    const items = this._collectWOPartLines();
    try {
      await this.api('PATCH', `/work-orders/${id}/parts`, { items });
      this.alert('Parts saved');
      await this.viewWorkOrder(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async confirmWOParts(id) {
    try {
      await this.api('PATCH', `/work-orders/${id}/parts`, { items: this._collectWOPartLines() });
      await this.api('POST', `/work-orders/${id}/confirm-parts`);
      this.alert('Parts confirmed — transfers/purchase requests created where needed');
      await this.viewWorkOrder(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Pulled for the job but not installed (or removed from the customer's
  // machine and still resalable) — sends the remaining quantity back to
  // stock as a discounted "Used" sibling product and knocks it off this
  // line's charge on the work order.
  // Issue from Stock: take a part on the job out of the branch's stock
  // (recorded once — the key stops a double-click issuing it twice).
  async issueWOPart(woId, productId, max, name) {
    const raw = prompt(`Issue ${name} from stock to this job.\n\nHow many? (up to ${max})`, String(max));
    if (raw == null) return;
    const quantity = parseFloat(raw);
    if (!(quantity > 0)) { this.alert('Enter how many are being issued', 'warning'); return; }
    try {
      await this.api('POST', `/work-orders/${woId}/parts/issue`, { product_id: productId, quantity, issue_key: `${woId}-${productId}-${Date.now()}` });
      this.alert(`${quantity} × ${name} issued from stock`, 'success');
      this.viewWorkOrder(woId);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async showWOPartReturnModal(woId, itemId) {
    const wo = await this.api('GET', `/work-orders/${woId}`);
    const item = (wo.items||[]).find(i => i.id === itemId);
    if (!item) return;
    const remaining = item.quantity - (item.quantity_returned || 0);
    this.showSecondaryModal(`
      <div class="modal">
        <div class="modal-header"><span class="modal-title">Return to Stock — ${this.escapeAttr(item.product_name)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--text-muted)">Restocks this quantity as a discounted "Used" item (kept separate from new-condition stock) and reduces this line's charge on the work order.</p>
          <div class="input-row">
            <div class="form-group"><label>Quantity to Return</label><input type="number" id="wopr-qty" min="1" max="${remaining}" value="${remaining}"></div>
            <div class="form-group"><label>Used Resale Price (each)</label><input type="number" id="wopr-price" min="0" step="0.01" value="${item.unit_price}"></div>
          </div>
          <div class="form-group"><label>Notes</label><textarea id="wopr-notes" rows="2" placeholder="Why it's being returned"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeSecondaryModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveWOPartReturn(${woId},${itemId})">Return to Stock</button>
        </div>
      </div>`);
  },

  async saveWOPartReturn(woId, itemId) {
    const quantity = parseInt(document.getElementById('wopr-qty').value);
    const used_price = parseFloat(document.getElementById('wopr-price').value);
    const notes = document.getElementById('wopr-notes').value.trim();
    if (!quantity || quantity <= 0) { this.alert('Enter a quantity to return', 'error'); return; }
    if (isNaN(used_price) || used_price < 0) { this.alert('Enter a used resale price', 'error'); return; }
    try {
      await this.api('POST', `/work-orders/${woId}/parts/${itemId}/return`, { quantity, used_price, notes, employee_id: this.currentUser.id });
      this.closeSecondaryModal();
      this.alert('Returned to stock as Used');
      await this.viewWorkOrder(woId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Work Order tasks & time tracking ──────────────────────────────────────

  _woMinutesLabel(mins) {
    const m = Math.round(mins || 0);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m/60)}h ${m%60}m`;
  },

  _woTaskRowHtml(woId, t, editable) {
    const actual = parseFloat(t.actual_minutes) || 0;
    const liveElapsed = t.open_time_entry_id ? (Date.now() - this._toDate(t.open_time_entry_started_at).getTime()) / 60000 : 0;
    const totalActual = actual + liveElapsed;
    const overAllotted = t.allotted_minutes > 0 && totalActual > t.allotted_minutes;
    const statusBadge = { pending: 'badge-secondary', in_progress: 'badge-info', complete: 'badge-success' }[t.status] || 'badge-secondary';
    return `<div style="border-top:1px solid var(--border);padding:6px 0;font-size:12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>${t.description}</strong>
        <span class="badge-pill ${statusBadge}" style="font-size:10px">${t.status.replace('_',' ')}</span>
      </div>
      <div style="color:var(--text-muted);margin-top:2px">
        ${t.technician_name || 'Unassigned'} · Allotted ${this._woMinutesLabel(t.allotted_minutes)} ·
        <span style="color:${overAllotted?'var(--danger)':'inherit'}">Actual ${this._woMinutesLabel(totalActual)}${t.open_time_entry_id ? ' (running)' : ''}</span>
      </div>
      ${editable && t.status !== 'complete' ? `<div style="margin-top:4px;display:flex;gap:6px">
        ${t.open_time_entry_id
          ? `<button class="btn btn-sm btn-danger" onclick="App.woClockOut(${woId},${t.id})">Clock Out</button>`
          : `<button class="btn btn-sm btn-secondary" onclick="App.woClockIn(${woId},${t.id})">Clock In</button>`}
        ${!t.open_time_entry_id ? `<button class="btn btn-sm btn-outline" onclick="App.woMarkTaskComplete(${woId},${t.id})">Mark Complete</button>` : ''}
      </div>` : ''}
    </div>`;
  },

  async saveWOTask(id) {
    const description = document.getElementById('wo-task-desc').value.trim();
    const allotted_minutes = document.getElementById('wo-task-allotted').value;
    const technician_id = document.getElementById('wo-task-tech').value || null;
    if (!description) { this.alert('A task description is required', 'error'); return; }
    try {
      await this.api('POST', `/work-orders/${id}/tasks`, { description, allotted_minutes, technician_id });
      await this.viewWorkOrder(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async woClockIn(woId, taskId) {
    try {
      await this.api('POST', `/work-orders/tasks/${taskId}/clock-in`, { technician_id: this.currentUser.id });
      await this.viewWorkOrder(woId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async woClockOut(woId, taskId) {
    try {
      await this.api('POST', `/work-orders/tasks/${taskId}/clock-out`, {});
      await this.viewWorkOrder(woId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async woMarkTaskComplete(woId, taskId) {
    try {
      await this.api('PATCH', `/work-orders/tasks/${taskId}`, { status: 'complete' });
      await this.viewWorkOrder(woId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Live supervisor view of every technician currently clocked into a task,
  // across every work order — polls every 15s while open. The poll clears
  // itself the moment the popup's own DOM node is gone, regardless of how it
  // was closed (✕ button or clicking outside the overlay), rather than
  // needing to hook every close path individually.
  showActiveTasksPopup() {
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header"><span class="modal-title">⏱ Active Tasks</span><button class="modal-close">✕</button></div>
        <div class="modal-body" id="active-tasks-body"><div class="empty-state"><p>Loading…</p></div></div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
    this._renderActiveTasksPopup();
    clearInterval(this._activeTasksInterval);
    this._activeTasksInterval = setInterval(() => this._renderActiveTasksPopup(), 15000);
  },

  async _renderActiveTasksPopup() {
    const body = document.getElementById('active-tasks-body');
    if (!body) { clearInterval(this._activeTasksInterval); return; }
    const rows = await this.api('GET', '/work-orders/active-tasks').catch(() => []);
    if (!document.getElementById('active-tasks-body')) { clearInterval(this._activeTasksInterval); return; }
    body.innerHTML = !rows.length ? '<div class="empty-state"><p>No technicians currently clocked in.</p></div>' : `
      <table class="table" style="font-size:12px">
        <thead><tr><th>Technician</th><th>Work Order</th><th>Task</th><th>Elapsed</th><th>Allotted</th></tr></thead>
        <tbody>${rows.map(r => {
          const over = r.allotted_minutes > 0 && r.elapsed_minutes > r.allotted_minutes;
          return `<tr>
            <td>${r.technician_name||'—'}</td>
            <td>${r.wo_number}</td>
            <td>${r.task_description}</td>
            <td style="color:${over?'var(--danger)':'inherit'};font-weight:${over?'700':'400'}">${this._woMinutesLabel(r.elapsed_minutes)}</td>
            <td>${this._woMinutesLabel(r.allotted_minutes)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  },

  // ─── Technician skills (catalog + assignment) ──────────────────────────────

  async showSkillsManager() {
    const skills = await this.api('GET', '/work-orders/skills');
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Technician Skills</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="padding:0">
          <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" onclick="App.showSkillForm()">+ Add Skill</button>
          </div>
          <table style="width:100%;border-collapse:collapse">
            <tbody>
              ${skills.length ? skills.map(s => `<tr style="border-top:1px solid var(--border)">
                <td style="padding:10px 16px;font-weight:600">${s.name}</td>
                <td style="padding:10px 16px;text-align:right">
                  <button class="btn btn-secondary btn-sm" onclick="App.showSkillForm(${s.id},'${(s.name||'').replace(/'/g,"\\'")}')">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="App.deactivateSkill(${s.id})">Remove</button>
                </td>
              </tr>`).join('') : '<tr><td style="padding:24px;text-align:center;color:var(--text-muted)">No skills defined yet</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  showSkillForm(id, name = '') {
    this.showModal(`
      <div class="modal" style="max-width:360px">
        <div class="modal-header"><span class="modal-title">${id?'Edit':'New'} Skill</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Name</label><input id="skill-name" value="${this.escapeAttr(name)}" placeholder="e.g. Engine Repair"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.showSkillsManager()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveSkill(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveSkill(id) {
    const name = document.getElementById('skill-name').value.trim();
    if (!name) { this.alert('A skill name is required', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/work-orders/skills/${id}`, { name });
      else await this.api('POST', '/work-orders/skills', { name });
      this.showSkillsManager();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deactivateSkill(id) {
    if (!confirm('Remove this skill? Technicians already assigned it will keep it on record.')) return;
    try {
      await this.api('DELETE', `/work-orders/skills/${id}`);
      this.showSkillsManager();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Day-ahead technician schedule ──────────────────────────────────────────

  async renderWOSchedule() {
    this.woScheduleDate = this.woScheduleDate || new Date().toISOString().slice(0,10);
    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>Technician Schedule</h2></div>
      <div class="form-group" style="max-width:220px;margin-bottom:14px">
        <label>Date</label>
        <input type="date" id="wo-sched-date" value="${this.woScheduleDate}" onchange="App.woScheduleDate=this.value;App.loadWOSchedule()">
      </div>
      <div id="wo-schedule-content"></div>`;
    await this.loadWOSchedule();
  },

  async loadWOSchedule() {
    const el = document.getElementById('wo-schedule-content');
    if (!el) return;
    const [data, employees] = await Promise.all([
      this.api('GET', `/work-orders/schedule?date=${this.woScheduleDate}`),
      this.api('GET', '/employees'),
    ]);
    if (!document.getElementById('wo-schedule-content')) return;
    const byEmployee = {};
    data.scheduled.forEach(s => { (byEmployee[s.employee_id] = byEmployee[s.employee_id] || []).push(s); });
    document.getElementById('wo-schedule-content').innerHTML = `
      <div class="two-col">
        <div class="card">
          <div class="card-header"><span class="card-title">Unscheduled Tasks</span></div>
          ${data.unscheduled.length ? data.unscheduled.map(t => `
            <div style="border-top:1px solid var(--border);padding:8px 0;font-size:13px">
              <strong>${t.description}</strong> <span style="color:var(--text-muted)">(${t.wo_number})</span>
              ${t.required_skills ? `<div style="font-size:11px;color:var(--text-muted)">Needs: ${t.required_skills}</div>` : ''}
              <div style="display:flex;gap:6px;margin-top:4px;align-items:center">
                <select id="wo-sched-tech-${t.id}" style="flex:1">
                  <option value="">-- Assign technician --</option>
                  ${employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}${e.skills?.length ? ` (${e.skills.map(s=>s.name).join(', ')})` : ''}</option>`).join('')}
                </select>
                <button class="btn btn-sm btn-primary" onclick="App.assignWOSchedule(${t.id})">Assign</button>
              </div>
            </div>`).join('') : '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">Nothing unscheduled for this date</div>'}
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Assigned — ${this.fmtDate(this.woScheduleDate)}</span></div>
          ${Object.keys(byEmployee).length ? Object.entries(byEmployee).map(([empId, rows]) => `
            <div style="border-top:1px solid var(--border);padding:8px 0">
              <strong style="font-size:13px">${rows[0].employee_name||'—'}</strong>
              ${rows.map(r => `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;display:flex;justify-content:space-between;align-items:center">
                <span>${r.task_description || r.notes || '—'} ${r.wo_number?`(${r.wo_number})`:''}</span>
                <button class="btn btn-sm btn-outline" style="padding:1px 8px;font-size:11px" onclick="App.unassignWOSchedule(${r.id})">✕</button>
              </div>`).join('')}
            </div>`).join('') : '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No one scheduled for this date yet</div>'}
        </div>
      </div>`;
  },

  async assignWOSchedule(taskId) {
    const employee_id = document.getElementById(`wo-sched-tech-${taskId}`).value;
    if (!employee_id) { this.alert('Select a technician', 'error'); return; }
    try {
      await this.api('POST', '/work-orders/schedule', { employee_id, work_order_task_id: taskId, scheduled_date: this.woScheduleDate });
      this.loadWOSchedule();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async unassignWOSchedule(scheduleId) {
    try {
      await this.api('DELETE', `/work-orders/schedule/${scheduleId}`);
      this.loadWOSchedule();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Sign-off, notification, pickup ─────────────────────────────────────────

  showWOSignoffModal(id) {
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Supervisor Sign-Off</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">This confirms every task on this work order is complete and the item is ready to hand back to the customer. All tasks must already be marked Complete.</p>
          <div class="form-group"><label>Comment (optional)</label><textarea id="wo-signoff-comment" rows="2"></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmWOSignoff(${id})">Sign Off</button>
        </div>
      </div>`);
  },

  async confirmWOSignoff(id) {
    const comment = document.getElementById('wo-signoff-comment').value.trim();
    try {
      await this.api('PATCH', `/work-orders/${id}/signoff`, { comment, employee_id: this.currentUser.id });
      this.closeModal();
      this.alert('Work order signed off — complete');
      this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showWONotifyModal(id) {
    const wo = await this.api('GET', `/work-orders/${id}`);
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Notify Customer</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">Let the customer know their item is ready for pickup.</p>
          ${wo.customer_email ? `
          <div class="form-group"><label>Email</label><input id="wo-notify-email" value="${this.escapeAttr(wo.customer_email)}"></div>
          <button class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="App.sendWONotifyEmail(${id})">📧 Send Email Notification</button>` : `<p style="font-size:12px;color:var(--warning)">No email on file for this customer.</p>`}
          <button class="btn btn-secondary" style="width:100%" onclick="App.markWONotifyCalled(${id})">☎ Mark as Called</button>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async sendWONotifyEmail(id) {
    const to = document.getElementById('wo-notify-email').value.trim();
    if (!to) { this.alert('An email address is required', 'error'); return; }
    try {
      await this.api('POST', `/email/send-work-order-ready/${id}`, { to });
      await this.api('PATCH', `/work-orders/${id}/notify`, { notification_method: 'email', employee_id: this.currentUser.id });
      this.closeModal();
      this.alert('Customer notified by email');
      this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async markWONotifyCalled(id) {
    try {
      await this.api('PATCH', `/work-orders/${id}/notify`, { notification_method: 'phone', employee_id: this.currentUser.id });
      this.closeModal();
      this.alert('Marked as called');
      this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showWOFinalPaymentModal(id) {
    try {
      const wo = await this.api('GET', `/work-orders/${id}`);
      const estimateTotal = (parseFloat(wo.estimate_labor)||0) + (parseFloat(wo.estimate_consumables)||0);
      const estimateTax = parseFloat((estimateTotal * (parseFloat(wo.estimate_tax_rate)||0) / 100).toFixed(2));
      const partsTotal = (wo.items||[]).reduce((s,i) => s + (parseFloat(i.total)||0), 0);
      const partsTax = (wo.items||[]).reduce((s,i) => s + (parseFloat(i.total)||0) * (parseFloat(i.tax_rate)||0) / 100, 0);
      const taxTotal = parseFloat((estimateTax + partsTax).toFixed(2));
      const balance = Math.max(0, parseFloat((estimateTotal + partsTotal + taxTotal - (parseFloat(wo.deposit_amount)||0)).toFixed(2)));
      this.showModal(`
        <div class="modal" style="max-width:440px">
          <div class="modal-header"><span class="modal-title">Process Final Payment — ${wo.wo_number}</span><button class="modal-close">✕</button></div>
          <div class="modal-body">
            <div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:13px">
              <div style="display:flex;justify-content:space-between"><span>Estimate (labor + consumables)</span><span>${this.fmt(estimateTotal)}</span></div>
              <div style="display:flex;justify-content:space-between"><span>Parts</span><span>${this.fmt(partsTotal)}</span></div>
              ${taxTotal > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:12px"><span>Tax</span><span>${this.fmt(taxTotal)}</span></div>` : ''}
              <div style="display:flex;justify-content:space-between"><span>Less deposit paid</span><span>-${this.fmt(wo.deposit_amount)}</span></div>
              <div style="display:flex;justify-content:space-between;margin-top:4px;border-top:1px solid var(--border);padding-top:4px"><strong>Balance Due</strong><strong>${this.fmt(balance)}</strong></div>
            </div>
            ${this._woAccChecklistHtml(wo)}
            ${balance > 0 ? `<div class="form-group"><label>Payment Method</label>
              <select id="wo-final-paymethod"><option value="cash">Cash</option><option value="credit_card">Card</option><option value="check">Check</option><option value="tax_exempt_tender">Tax Exempt</option></select>
            </div>` : `<p style="font-size:13px;color:var(--text-muted)">No balance due — the deposit already covers the final cost.</p>`}
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" title="Opens the customer copy — choose Save as PDF in the print dialog to attach it to an email" onclick="App.printWorkOrderInvoice(${id})">🖨️ Print Invoice</button>
            <button class="btn btn-secondary" onclick="App.emailWorkOrderInvoice(${id}, '${(wo.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email Invoice</button>
            <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="App.confirmWOFinalPayment(${id})">${balance > 0 ? 'Confirm Payment' : 'Complete Pickup'}</button>
          </div>
        </div>`);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Accessory hand-back checklist — the cashier's final payment and Return to Customer
  _woAccChecklistHtml(wo) {
    if (!(wo.accessories || []).length) return '';
    return `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:13px">
      <strong style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Hand Back Accessories</strong>
      <div style="font-size:12px;color:var(--text-muted);margin:2px 0 6px">Tick each one as you give it to the customer.</div>
      ${wo.accessories.map(a => `<label style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-top:1px dashed var(--border);cursor:pointer;text-transform:none;font-weight:normal">
        <input type="checkbox" class="wo-acc-back" value="${a.id}" style="width:auto;margin-top:3px" onchange="App._woPickupAccChanged()">
        ${a.photos?.[0] ? `<img src="${a.photos[0].url}" style="width:44px;height:44px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">` : ''}
        <span><strong>A${a.line_no}</strong> — ${this.escapeAttr(a.name)}${a.serial_number ? ` · Item # ${this.escapeAttr(a.serial_number)}` : ''}<br><span style="color:var(--text-muted);font-size:12px">${this.escapeAttr(a.description)}</span></span>
      </label>`).join('')}
      <div id="wo-acc-note-wrap" class="form-group" style="margin:6px 0 0">
        <label>Why isn't everything being handed back? *</label>
        <textarea id="wo-acc-note" rows="2" placeholder="e.g. Customer left the bag with us / charger not found — manager informed"></textarea>
      </div>
    </div>`;
  },

  // Reads the checklist; null (after telling the user) if something isn't ticked and there's no reason
  _woReadAccChecklist() {
    const boxes = [...document.querySelectorAll('.wo-acc-back')];
    const accessories_returned = boxes.filter(b => b.checked).map(b => Number(b.value));
    const accessories_note = document.getElementById('wo-acc-note')?.value.trim() || '';
    if (boxes.length && accessories_returned.length < boxes.length && !accessories_note) {
      this.alert('Some accessories aren\'t ticked as handed back — say why first', 'error');
      document.getElementById('wo-acc-note')?.focus();
      return null;
    }
    return { accessories_returned, accessories_note };
  },

  async showWOReturnToCustomerModal(id) {
    try {
      const wo = await this.api('GET', `/work-orders/${id}`);
      this.showModal(`
        <div class="modal" style="max-width:440px">
          <div class="modal-header"><span class="modal-title">Return to Customer — ${wo.wo_number}</span><button class="modal-close">✕</button></div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-muted);margin-top:0">${wo.status === 'cancelled' ? 'This work order was cancelled' : 'This item was found not worth fixing'} — record the item${(wo.accessories||[]).length ? ' and its accessories' : ''} going back to ${this.escapeAttr(wo.customer_name || 'the customer')}.</p>
            <div style="font-size:13px;margin-bottom:12px"><strong>Item:</strong> ${this.escapeAttr(wo.item_label || wo.description)}${wo.item_serial ? ` · Item # ${this.escapeAttr(wo.item_serial)}` : ''}</div>
            ${this._woAccChecklistHtml(wo)}
            <div class="form-group"><label>Comment</label><input id="wo-return-comment" placeholder="Optional — e.g. collected by the customer's son"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="App.confirmWOReturnToCustomer(${id})">Return to Customer</button>
          </div>
        </div>`);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async confirmWOReturnToCustomer(id) {
    const checklist = this._woReadAccChecklist();
    if (!checklist) return;
    try {
      const wo = await this.api('PATCH', `/work-orders/${id}/return-to-customer`, { ...checklist, comment: document.getElementById('wo-return-comment').value.trim() });
      this.alert(`${wo.wo_number} returned to the customer`);
      if (this.section === 'work-orders') this.renderWorkOrders();
      await this.viewWorkOrder(id);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  _woPickupAccChanged() {
    const boxes = [...document.querySelectorAll('.wo-acc-back')];
    const wrap = document.getElementById('wo-acc-note-wrap');
    if (wrap) wrap.style.display = boxes.every(b => b.checked) ? 'none' : '';
  },

  async confirmWOFinalPayment(id) {
    const paymethodEl = document.getElementById('wo-final-paymethod');
    const payment_method = paymethodEl ? paymethodEl.value : undefined;
    const checklist = this._woReadAccChecklist();
    if (!checklist) return;
    try {
      const wo = await this.api('PATCH', `/work-orders/${id}/final-payment`, {
        payment_method, employee_id: this.currentUser.id, drawer_session_id: this.currentDrawerSession?.id || null, ...checklist,
      });
      this.closeModal();
      this.alert(`${wo.wo_number} picked up${payment_method ? ' — final payment collected' : ''}`);
      if (this.section === 'work-orders') this.renderWorkOrders();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Work order invoice ──────────────────────────────────────────
  // Letter-size print of the invoice (see _printServerDocument) — available
  // from the WO detail view (viewWorkOrder) and the cashier's final-payment
  // modal (showWOFinalPaymentModal), not gated on WO status since a partial
  // invoice (assessment fee only, no estimate yet) is still valid to hand over.
  printWorkOrderInvoice(id) {
    return this._printServerDocument(`/api/email/work-order-preview/${id}`, 'work-order-invoice', 'invoice');
  },

  emailWorkOrderInvoice(id, customerEmail) {
    this.showEmailModal('Email Service and Repair Tax Invoice', customerEmail, async (to, { as_pdf }) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-work-order-invoice/${id}`, { to, as_pdf });
        this.alert(`Service and Repair Tax Invoice sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    }, { pdfOption: true });
  },
});
