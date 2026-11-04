// Promotions, bundles, discount cards, cash back cards.
Object.assign(App, {
  // ─── PROMOTIONS ──────────────────────────────────────────────────────────────

  async renderPromotions() {
    const [promos, categories, products] = await Promise.all([
      this.api('GET', '/promotions'),
      this.api('GET', '/categories'),
      this.api('GET', '/products'),
    ]);
    if (this.section !== 'promotions') return;
    this._promoCategories = categories;
    this._promoProducts = products;

    const today = new Date().toISOString().split('T')[0];
    const statusBadge = p => {
      if (!p.active) return '<span class="badge-pill" style="background:#e0e0e0;color:#666">Inactive</span>';
      if (p.end_date && today > p.end_date) return '<span class="badge-pill" style="background:#ffcdd2;color:#c62828">Expired</span>';
      if (p.start_date && today < p.start_date) return '<span class="badge-pill" style="background:#fff9c4;color:#f57f17">Scheduled</span>';
      return '<span class="badge-pill badge-green">Active</span>';
    };

    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Promotions</h2>
        <button class="btn btn-primary" onclick="App.showPromoForm()">+ New Promotion</button>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Applies To</th><th>Dates</th><th>Codes</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${promos.length ? promos.map(p => `
              <tr>
                <td class="fw-600">${p.name}</td>
                <td>${p.type === 'bundle' ? '<span class="badge-pill badge-teal">Bundle</span>' : p.type === 'percentage' ? 'Percentage' : 'Fixed'}</td>
                <td>${p.type === 'bundle' ? (p.bundle_pricing === 'price' ? `${this.fmt(p.bundle_price)} / bundle` : `${p.value}% off bundle`) : p.type === 'percentage' ? p.value + '%' : this.fmt(p.value)}</td>
                <td>${p.type === 'bundle' ? `<span class="badge-pill badge-teal">${p.bundle_unit_count} items per bundle</span>` : p.applies_to === 'all' ? 'All Items' : p.applies_to === 'categories' ? `<span class="badge-pill badge-purple">${p.item_count} categories</span>` : p.applies_to === 'items' ? `<span class="badge-pill badge-blue">${p.item_count} products</span>` : p.applies_to === 'brands' ? `<span class="badge-pill badge-purple">${p.brand_count} brands</span>` : `<span class="badge-pill badge-purple">${p.item_count} items/cats</span>`}${p.excluded_brand_count > 0 ? `<br><span class="badge-pill badge-danger" style="font-size:10px">${p.excluded_brand_count} brand${p.excluded_brand_count>1?'s':''} excluded</span>` : ''}</td>
                <td style="font-size:12px">${this._promoScheduleLabel(p)}</td>
                <td><span class="badge-pill badge-blue">${p.code_count} codes</span></td>
                <td>${statusBadge(p)}</td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="App.showPromoForm(${p.id})">Edit</button>
                  <button class="btn btn-sm btn-outline" onclick="App.managePromoCodes(${p.id},'${p.name.replace(/'/g,"\\'")}')">Codes</button>
                  ${['categories','items','specific'].includes(p.applies_to) ? `<button class="btn btn-sm btn-outline" onclick="App.managePromoItems(${p.id},'${p.name.replace(/'/g,"\\'")}')">Items</button>` : ''}
                  ${p.type !== 'bundle' ? `<button class="btn btn-sm btn-outline" onclick="App.managePromoBrands(${p.id},'${p.name.replace(/'/g,"\\'")}')">Brands</button>` : ''}
                  <button class="btn btn-sm btn-danger" onclick="App.deletePromotion(${p.id})">Del</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="8" class="empty-state">No promotions yet</td></tr>'}
          </tbody>
        </table>
      </div>`;
  },

  async showPromoForm(id) {
    let p = { type: 'percentage', value: 0, applies_to: 'all', active: 1, min_purchase: 0, items: [] };
    const [promoData, categories, products, assignments] = await Promise.all([
      id ? this.api('GET', `/promotions/${id}`) : Promise.resolve(p),
      this.api('GET', '/categories'),
      this.api('GET', '/products'),
      this.api('GET', '/promotions/product-assignments'),
    ]);
    if (id) p = promoData;
    // Bundle builder rows — see _renderPromoBundleRows.
    this._pmBundleProducts = products.filter(pr => pr.active);
    this._pmBundle = (p.bundle_items || []).map(b => ({ product_id: b.product_id, name: b.product_name, sku: b.sku, price: b.price, quantity: b.quantity }));
    const isBundle = p.type === 'bundle';

    const assignedCatMap = new Map((p.items||[]).filter(i=>i.item_type==='category').map(i=>[i.item_id, i.id]));
    const assignedProdMap = new Map((p.items||[]).filter(i=>i.item_type==='product').map(i=>[i.item_id, i.id]));

    // Build map of items in OTHER active promotions for exclusivity display
    const otherPromoMap = new Map();
    for (const a of assignments) {
      if (!id || Number(a.promotion_id) !== Number(id)) {
        otherPromoMap.set(`${a.item_type}-${a.item_id}`, a.promotion_name);
      }
    }

    const catCheckboxes = categories.map(c => {
      const inOther = otherPromoMap.get(`category-${c.id}`);
      const dis = inOther && !assignedCatMap.has(c.id);
      return `<label style="display:flex;align-items:center;gap:6px;cursor:${dis?'not-allowed':'pointer'};font-size:13px;min-width:140px;${dis?'opacity:0.5':''}">
        <input type="checkbox" class="pm-cat-cb" value="${c.id}" data-promo-item-id="${assignedCatMap.get(c.id)||''}"
          ${assignedCatMap.has(c.id)?'checked':''} ${dis?'disabled':''} style="width:auto">
        ${c.name}${inOther ? ` <small style="color:var(--danger);font-size:10px">(${inOther})</small>` : ''}
      </label>`;
    }).join('');

    const prodCheckboxes = products.filter(pr=>pr.active).map(pr => {
      const inOther = otherPromoMap.get(`product-${pr.id}`);
      const dis = inOther && !assignedProdMap.has(pr.id);
      return `<label class="pm-prod-label" style="display:flex;align-items:center;gap:6px;cursor:${dis?'not-allowed':'pointer'};padding:3px 0;${dis?'opacity:0.5':''}">
        <input type="checkbox" class="pm-prod-cb" value="${pr.id}" data-promo-item-id="${assignedProdMap.get(pr.id)||''}"
          ${assignedProdMap.has(pr.id)?'checked':''} ${dis?'disabled':''} style="width:auto;flex-shrink:0">
        <span style="font-size:13px"><span class="fw-600">${pr.name}</span> <span style="color:var(--text-muted);font-size:11px">${pr.sku||''}</span>${inOther ? ` <span style="color:var(--danger);font-size:10px">(${inOther})</span>` : ''}</span>
      </label>`;
    }).join('');

    // Normalise legacy 'specific' value to 'items' in the UI
    const appliesToVal = (p.applies_to === 'specific') ? 'items' : (p.applies_to || 'all');
    const recurrenceVal = p.recurrence_type || (p.is_recurring ? 'daily' : 'none');
    const recurrenceDays = new Set((() => { try { return JSON.parse(p.recurrence_days || '[]'); } catch { return []; } })());
    const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayCheckboxes = dayLabels.map((lbl, i) => `
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px">
        <input type="checkbox" class="pm-recur-day" value="${i}" ${recurrenceDays.has(i)?'checked':''} style="width:auto"> ${lbl}
      </label>`).join('');

    this.showModal(`
      <div class="modal" style="max-width:540px">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit' : 'New'} Promotion</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Name</label><input id="pm-name" value="${p.name||''}"></div>
          <div class="form-group"><label>Description</label><input id="pm-desc" value="${p.description||''}"></div>
          <div class="input-row">
            <div class="form-group"><label>Discount Type</label>
              <select id="pm-type" onchange="App._promoTypeToggle()">
                <option value="percentage" ${p.type==='percentage'?'selected':''}>Percentage (%)</option>
                <option value="fixed" ${p.type==='fixed'?'selected':''}>Fixed Amount ($)</option>
                <option value="bundle" ${isBundle?'selected':''}>Bundle (items sold together)</option>
              </select>
            </div>
            <div class="form-group" id="pm-value-group" style="display:${isBundle?'none':''}"><label id="pm-value-label">${p.type==='percentage'?'Discount %':'Discount $'}</label>
              <input type="number" id="pm-value" value="${p.value||0}" min="0" step="0.01">
            </div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Min Purchase Amount</label><input type="number" id="pm-minpur" value="${p.min_purchase||0}" min="0" step="0.01"></div>
            <div class="form-group" id="pm-applies-group" style="display:${isBundle?'none':''}"><label>Applies To</label>
              <select id="pm-applies" onchange="App._promoAppliesToToggle()">
                <option value="all" ${appliesToVal==='all'?'selected':''}>All Items</option>
                <option value="categories" ${appliesToVal==='categories'?'selected':''}>Specific Categories</option>
                <option value="items" ${appliesToVal==='items'?'selected':''}>Specific Products</option>
                <option value="brands" ${appliesToVal==='brands'?'selected':''}>Specific Brands</option>
              </select>
            </div>
          </div>
          <div id="pm-bundle-section" style="display:${isBundle?'':'none'};margin-bottom:12px;border:1px solid var(--border);border-radius:6px;padding:10px">
            <label style="font-weight:600;font-size:13px;display:block;margin-bottom:6px">Bundle Items</label>
            <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px">The products, and how many of each, that make up one bundle. Every complete set in the cart gets the bundle pricing.</p>
            <div style="position:relative;margin-bottom:8px">
              <input type="text" id="pm-bundle-search" placeholder="Search products to add…" autocomplete="off" style="width:100%" oninput="App._filterPromoBundleProducts(this.value)" onfocus="App._filterPromoBundleProducts(this.value)">
              <div id="pm-bundle-dd" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:200;max-height:220px;overflow-y:auto;margin-top:2px"></div>
            </div>
            <div id="pm-bundle-rows"></div>
            <div class="input-row" style="margin-top:10px">
              <div class="form-group"><label>Bundle Pricing</label>
                <select id="pm-bundle-pricing" onchange="App._renderPromoBundleSummary()">
                  <option value="percent" ${p.bundle_pricing!=='price'?'selected':''}>Discount % off the bundle</option>
                  <option value="price" ${p.bundle_pricing==='price'?'selected':''}>Set a bundle price</option>
                </select>
              </div>
              <div class="form-group" id="pm-bundle-pct-group"><label>Discount %</label><input type="number" id="pm-bundle-pct" value="${isBundle && p.bundle_pricing!=='price' ? p.value : ''}" min="0" max="100" step="0.01" oninput="App._renderPromoBundleSummary()"></div>
              <div class="form-group" id="pm-bundle-price-group"><label>Bundle Price</label><input type="number" id="pm-bundle-price" value="${p.bundle_price ?? ''}" min="0" step="0.01" oninput="App._renderPromoBundleSummary()"></div>
            </div>
            <div id="pm-bundle-summary" style="font-size:12px;color:var(--text-muted)"></div>
          </div>
          <div id="pm-cat-section" style="display:${appliesToVal==='categories'?'':'none'};margin-bottom:12px">
            <label style="font-weight:600;font-size:13px;display:block;margin-bottom:8px">Categories</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--bg-secondary,var(--bg))">
              ${categories.length ? catCheckboxes : '<span style="font-size:13px;color:var(--text-muted)">No categories found</span>'}
            </div>
          </div>
          <div id="pm-items-section" style="display:${appliesToVal==='items'?'':'none'};margin-bottom:12px">
            <label style="font-weight:600;font-size:13px;display:block;margin-bottom:6px">Specific Products</label>
            <input type="text" id="pm-prod-search" placeholder="Search products..." oninput="App._filterPromoProducts()" style="width:100%;margin-bottom:8px">
            <div id="pm-prod-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--bg-secondary,var(--bg))">
              ${products.filter(pr=>pr.active).length ? prodCheckboxes : '<span style="font-size:13px;color:var(--text-muted)">No products found</span>'}
            </div>
          </div>
          <div id="pm-brands-section" style="display:${appliesToVal==='brands'?'':'none'};margin-bottom:12px;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--bg-secondary,var(--bg))">
            <span style="font-size:13px">${id ? `Pick which brands this promotion applies to from the <strong>Brands</strong> button on the promotions list.` : `Save this promotion first, then use its <strong>Brands</strong> button on the list to pick which brands it applies to.`}</span>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Start Date (optional)</label><input type="date" id="pm-start" value="${p.start_date||''}"></div>
            <div class="form-group"><label>End Date (optional)</label><input type="date" id="pm-end" value="${p.end_date||''}"></div>
          </div>
          <div class="input-row">
            <div class="form-group"><label>Start Time (optional)</label><input type="time" id="pm-start-time" value="${p.start_time||''}"></div>
            <div class="form-group"><label>End Time (optional)</label><input type="time" id="pm-end-time" value="${p.end_time||''}"></div>
          </div>
          <div class="form-group">
            <label>Recurrence</label>
            <select id="pm-recurrence" onchange="App._promoRecurringToggle()">
              <option value="none" ${recurrenceVal==='none'?'selected':''}>None — runs once</option>
              <option value="daily" ${recurrenceVal==='daily'?'selected':''}>Daily</option>
              <option value="weekly" ${recurrenceVal==='weekly'?'selected':''}>Weekly</option>
              <option value="monthly" ${recurrenceVal==='monthly'?'selected':''}>Monthly</option>
              <option value="yearly" ${recurrenceVal==='yearly'?'selected':''}>Yearly</option>
            </select>
            <p id="pm-recurring-hint" style="font-size:11px;color:var(--text-muted);margin:4px 0 0">${this._promoRecurringHint(recurrenceVal)}</p>
            <div id="pm-recur-days" style="display:${recurrenceVal==='weekly'?'flex':'none'};flex-wrap:wrap;gap:10px;margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:6px">
              ${dayCheckboxes}
            </div>
          </div>
          <div class="form-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="pm-active" ${p.active?'checked':''} style="width:auto"> Active
          </label></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.savePromotion(${id||''})">Save</button>
        </div>
      </div>`);
    this._renderPromoBundleRows();
    if (isBundle) this._promoTypeToggle();
  },

  // ─── Bundle promotion builder ─────────────────────────────────────────────
  _filterPromoBundleProducts(q) {
    const dd = document.getElementById('pm-bundle-dd');
    if (!dd) return;
    const term = (q || '').trim().toLowerCase();
    const inBundle = new Set(this._pmBundle.map(b => String(b.product_id)));
    const matches = (this._pmBundleProducts || [])
      .filter(pr => !inBundle.has(String(pr.id)) && (!term || `${pr.name} ${pr.sku || ''}`.toLowerCase().includes(term)))
      .slice(0, 40);
    dd.innerHTML = matches.length ? matches.map(pr => `<div style="padding:7px 10px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)" onmousedown="event.preventDefault();App._addPromoBundleProduct(${pr.id})" onmouseover="this.style.background='var(--bg-secondary,#f5f5f5)'" onmouseout="this.style.background=''"><span class="fw-600">${this.escapeAttr(pr.name)}</span> <span style="color:var(--text-muted);font-size:11px">${this.escapeAttr(pr.sku || '')} · ${this.fmt(pr.price)}</span></div>`).join('')
      : '<div style="padding:8px 10px;font-size:12px;color:var(--text-muted)">No matching products</div>';
    dd.style.display = 'block';
    const search = document.getElementById('pm-bundle-search');
    if (search && !search._bundleBlurBound) { search.addEventListener('blur', () => { dd.style.display = 'none'; }); search._bundleBlurBound = true; }
  },

  _addPromoBundleProduct(productId) {
    const pr = (this._pmBundleProducts || []).find(x => String(x.id) === String(productId));
    if (!pr) return;
    this._pmBundle.push({ product_id: pr.id, name: pr.name, sku: pr.sku, price: pr.price, quantity: 1 });
    const search = document.getElementById('pm-bundle-search');
    if (search) search.value = '';
    document.getElementById('pm-bundle-dd').style.display = 'none';
    this._renderPromoBundleRows();
  },

  _setPromoBundleQty(idx, val) {
    if (this._pmBundle[idx]) this._pmBundle[idx].quantity = Math.max(1, parseInt(val) || 1);
    this._renderPromoBundleSummary();
  },

  _removePromoBundleProduct(idx) {
    this._pmBundle.splice(idx, 1);
    this._renderPromoBundleRows();
  },

  _renderPromoBundleRows() {
    const el = document.getElementById('pm-bundle-rows');
    if (!el) return;
    el.innerHTML = this._pmBundle.length ? this._pmBundle.map((b, idx) => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
        <span style="flex:1;font-size:13px"><span class="fw-600">${this.escapeAttr(b.name)}</span> <span style="color:var(--text-muted);font-size:11px">${this.escapeAttr(b.sku || '')} · ${this.fmt(b.price)} each</span></span>
        <label style="font-size:11px;color:var(--text-muted);margin:0">Qty</label>
        <input type="number" min="1" step="1" value="${b.quantity}" style="width:64px" oninput="App._setPromoBundleQty(${idx},this.value)">
        <button class="btn btn-sm btn-danger" onclick="App._removePromoBundleProduct(${idx})">✕</button>
      </div>`).join('') : '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No items yet — search above to add products.</div>';
    this._renderPromoBundleSummary();
  },

  // Live "regular price → customer pays → saves" readout for one bundle at
  // current catalog prices (the POS uses the actual cart prices).
  _renderPromoBundleSummary() {
    const pricing = document.getElementById('pm-bundle-pricing')?.value || 'percent';
    const pctGroup = document.getElementById('pm-bundle-pct-group');
    const priceGroup = document.getElementById('pm-bundle-price-group');
    if (pctGroup) pctGroup.style.display = pricing === 'percent' ? '' : 'none';
    if (priceGroup) priceGroup.style.display = pricing === 'price' ? '' : 'none';
    const el = document.getElementById('pm-bundle-summary');
    if (!el) return;
    const regular = this._pmBundle.reduce((s, b) => s + (parseFloat(b.price) || 0) * b.quantity, 0);
    if (!this._pmBundle.length) { el.innerHTML = ''; return; }
    let pays = null;
    if (pricing === 'percent') {
      const pct = parseFloat(document.getElementById('pm-bundle-pct')?.value);
      if (isFinite(pct)) pays = regular * (1 - pct / 100);
    } else {
      const price = parseFloat(document.getElementById('pm-bundle-price')?.value);
      if (isFinite(price)) pays = price;
    }
    const saves = pays != null ? regular - pays : null;
    el.innerHTML = `Regular price of one bundle: <strong>${this.fmt(regular)}</strong>${pays != null ? ` · Customer pays: <strong>${this.fmt(pays)}</strong> · ${saves >= 0 ? `Saves <strong style="color:var(--success,#2e7d32)">${this.fmt(saves)}</strong>` : `<strong style="color:var(--danger)">Bundle price is higher than buying separately — no discount will apply</strong>`}` : ''}`;
  },

  _promoTypeToggle() {
    const t = document.getElementById('pm-type')?.value;
    const lbl = document.getElementById('pm-value-label');
    if (lbl) lbl.textContent = t === 'percentage' ? 'Discount %' : 'Discount $';
    // A bundle prices itself (Bundle Items section), so the flat value and
    // the Applies To scoping don't apply to it.
    const isBundle = t === 'bundle';
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('pm-value-group', !isBundle);
    show('pm-applies-group', !isBundle);
    show('pm-bundle-section', isBundle);
    if (isBundle) { ['pm-cat-section', 'pm-items-section', 'pm-brands-section'].forEach(id => show(id, false)); }
    else this._promoAppliesToToggle();
  },

  _promoAppliesToToggle() {
    const val = document.getElementById('pm-applies')?.value;
    const catSec = document.getElementById('pm-cat-section');
    const itemSec = document.getElementById('pm-items-section');
    const brandSec = document.getElementById('pm-brands-section');
    if (catSec) catSec.style.display = val === 'categories' ? '' : 'none';
    if (itemSec) itemSec.style.display = val === 'items' ? '' : 'none';
    if (brandSec) brandSec.style.display = val === 'brands' ? '' : 'none';
  },

  _promoRecurringHint(recurrenceType) {
    const hints = {
      none: "Runs once: from the start date/time to the end date/time. Times only apply to the start/end date itself — leave blank for all day on that date.",
      daily: 'Runs every day between the times above (leave blank for all day), within the optional date range above.',
      weekly: 'Runs every week on the day(s) checked below, between the times above, within the optional date range above.',
      monthly: 'Runs every month on the same day-of-month as the Start Date, between the times above, within the optional date range above.',
      yearly: 'Runs every year on the same month/day as the Start Date, between the times above, within the optional date range above.',
    };
    return hints[recurrenceType] || hints.none;
  },

  _promoRecurringToggle() {
    const val = document.getElementById('pm-recurrence')?.value || 'none';
    const hint = document.getElementById('pm-recurring-hint');
    if (hint) hint.textContent = this._promoRecurringHint(val);
    const daysWrap = document.getElementById('pm-recur-days');
    if (daysWrap) daysWrap.style.display = val === 'weekly' ? 'flex' : 'none';
  },

  _promoFmtTime(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2,'0')} ${period}`;
  },

  _promoScheduleLabel(p) {
    const dateRange = `${p.start_date || '—'} → ${p.end_date || '∞'}`;
    const timeRange = (p.start_time || p.end_time) ? `${this._promoFmtTime(p.start_time) || '12:00 AM'}–${this._promoFmtTime(p.end_time) || '11:59 PM'}` : '';
    const recurType = p.recurrence_type || (p.is_recurring ? 'daily' : 'none');
    if (recurType === 'none') return `${dateRange}${timeRange ? `<br><span style="color:var(--text-muted)">${timeRange}</span>` : ''}`;
    const dayAbbr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let label = recurType[0].toUpperCase() + recurType.slice(1);
    if (recurType === 'weekly') {
      let days = [];
      try { days = JSON.parse(p.recurrence_days || '[]'); } catch {}
      if (days.length) label += ` (${days.map(d=>dayAbbr[d]).join(',')})`;
    }
    return `<span class="badge-pill badge-purple" style="font-size:10px">${label}</span> ${timeRange || 'all day'}<br><span style="color:var(--text-muted)">${dateRange}</span>`;
  },

  _filterPromoProducts() {
    const q = (document.getElementById('pm-prod-search')?.value || '').toLowerCase();
    document.querySelectorAll('#pm-prod-list .pm-prod-label').forEach(lbl => {
      lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  },

  async savePromotion(id) {
    const data = {
      name: document.getElementById('pm-name').value.trim(),
      description: document.getElementById('pm-desc').value.trim() || null,
      type: document.getElementById('pm-type').value,
      value: parseFloat(document.getElementById('pm-value').value) || 0,
      min_purchase: parseFloat(document.getElementById('pm-minpur').value) || 0,
      applies_to: document.getElementById('pm-applies').value,
      start_date: document.getElementById('pm-start').value || null,
      end_date: document.getElementById('pm-end').value || null,
      start_time: document.getElementById('pm-start-time').value || null,
      end_time: document.getElementById('pm-end-time').value || null,
      recurrence_type: document.getElementById('pm-recurrence').value,
      recurrence_days: [...document.querySelectorAll('.pm-recur-day:checked')].map(cb => parseInt(cb.value)),
      active: document.getElementById('pm-active').checked,
    };
    if (!data.name) return this.alert('Name required', 'error');
    if (data.type === 'bundle') {
      data.bundle_pricing = document.getElementById('pm-bundle-pricing').value;
      data.value = parseFloat(document.getElementById('pm-bundle-pct').value) || 0;
      data.bundle_price = document.getElementById('pm-bundle-price').value;
      data.bundle_items = this._pmBundle.map(b => ({ product_id: b.product_id, quantity: b.quantity }));
      data.applies_to = 'bundle';
    }

    // Snapshot both checkbox lists before modal closes
    const catCbs = [...document.querySelectorAll('.pm-cat-cb')];
    const prodCbs = [...document.querySelectorAll('.pm-prod-cb')];

    try {
      let promoId = id;
      if (id) {
        await this.api('PUT', `/promotions/${id}`, data);
      } else {
        const res = await this.api('POST', '/promotions', data);
        promoId = res.id;
      }

      const errors = [];

      if (data.applies_to === 'categories' && catCbs.length) {
        for (const cb of catCbs) {
          const catId = parseInt(cb.value);
          const promoItemId = cb.dataset.promoItemId;
          if (cb.checked && !promoItemId) {
            try { await this.api('POST', `/promotions/${promoId}/items`, { item_type: 'category', item_id: catId }); }
            catch(e) { errors.push(e.message); }
          } else if (!cb.checked && promoItemId) {
            await this.api('DELETE', `/promotions/${promoId}/items/${promoItemId}`);
          }
        }
      }

      if (data.applies_to === 'items' && prodCbs.length) {
        for (const cb of prodCbs) {
          const prodId = parseInt(cb.value);
          const promoItemId = cb.dataset.promoItemId;
          if (cb.checked && !promoItemId) {
            try { await this.api('POST', `/promotions/${promoId}/items`, { item_type: 'product', item_id: prodId }); }
            catch(e) { errors.push(e.message); }
          } else if (!cb.checked && promoItemId) {
            await this.api('DELETE', `/promotions/${promoId}/items/${promoItemId}`);
          }
        }
      }

      this.closeModal();
      this.renderPromotions();
      if (errors.length) {
        this.alert('Promotion saved. Some items could not be assigned (already in another promotion):\n' + errors.join('\n'), 'error');
      } else {
        this.alert('Promotion saved');
      }
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deletePromotion(id) {
    if (!confirm('Delete this promotion and all its codes?')) return;
    try {
      await this.api('DELETE', `/promotions/${id}`);
      this.alert('Promotion deleted');
      this.renderPromotions();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Discount Cards ───────────────────────────────────────────────────────
  // Simpler sibling to Promotions: a named card type with a flat percentage,
  // activated per-customer from their profile (Card Type + Card Number) and
  // auto-applied at POS checkout — no codes, no item/category scoping, no
  // date range, and never stacks with a promo code (see App.setCartCustomer /
  // App._checkAutoPromos).
  async renderDiscountCards() {
    const types = await this.api('GET', '/discount-cards');
    if (this.section !== 'discount-cards') return;
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Discount Cards</h2>
        <button class="btn btn-primary" onclick="App.showDiscountCardTypeForm()">+ New Card Type</button>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>Name</th><th>Discount</th><th>Customers</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${types.length ? types.map(t => `
              <tr>
                <td class="fw-600">${t.name}</td>
                <td>${t.discount_percent}%</td>
                <td><span class="badge-pill badge-blue">${t.customer_count}</span></td>
                <td><span class="badge-pill ${t.active ? 'badge-green' : ''}" style="${t.active?'':'background:#e0e0e0;color:#666'}">${t.active ? 'Active' : 'Inactive'}</span></td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="App.showDiscountCardTypeForm(${t.id})">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="App.deleteDiscountCardType(${t.id})">Del</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No discount card types yet</td></tr>'}
          </tbody>
        </table>
      </div>`;
  },

  async showDiscountCardTypeForm(id) {
    let t = { discount_percent: 0, active: 1 };
    if (id) t = (await this.api('GET', '/discount-cards')).find(x => x.id === id) || t;
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit' : 'New'} Card Type</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Name *</label><input id="dc-name" value="${t.name||''}" placeholder="e.g. VIP"></div>
          <div class="form-group"><label>Discount % *</label><input type="number" id="dc-percent" value="${t.discount_percent}" min="0" max="100" step="0.01"></div>
          <div class="form-group"><label style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="dc-active" ${t.active ? 'checked' : ''} style="width:auto"> Active
          </label></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveDiscountCardType(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveDiscountCardType(id) {
    const name = document.getElementById('dc-name').value.trim();
    const discount_percent = parseFloat(document.getElementById('dc-percent').value) || 0;
    const active = document.getElementById('dc-active').checked;
    if (!name) { this.alert('Name is required', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/discount-cards/${id}`, { name, discount_percent, active });
      else await this.api('POST', '/discount-cards', { name, discount_percent, active });
      this.closeModal();
      this.alert(id ? 'Card type updated' : 'Card type created');
      this.renderDiscountCards();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteDiscountCardType(id) {
    if (!confirm('Delete this discount card type?')) return;
    try {
      await this.api('DELETE', `/discount-cards/${id}`);
      this.alert('Card type deleted');
      this.renderDiscountCards();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Cash Back Cards ──────────────────────────────────────────────────
  // Customers accrue cash back from their existing loyalty points (see
  // routes/transactions.js) in whole reward chunks — every points_threshold
  // points earns reward_amount — redeemable at POS once (optionally) a
  // minimum accrued amount and/or a cooldown since their last redemption
  // are both satisfied. See availableCashBack() for the eligibility formula,
  // shared conceptually with computeAvailableCashBack() on the backend.

  async renderCashBackCards() {
    const types = await this.api('GET', '/cash-back-cards');
    if (this.section !== 'cash-back-cards') return;
    document.getElementById('content').innerHTML = `
      <div class="section-header">
        <h2>Cash Back Cards</h2>
        <button class="btn btn-primary" onclick="App.showCashBackCardTypeForm()">+ New Card Type</button>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>Name</th><th>Reward</th><th>Min Redeem</th><th>Cooldown</th><th>Customers</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${types.length ? types.map(t => `
              <tr>
                <td class="fw-600">${t.name}</td>
                <td>${t.points_threshold} pts = ${this.fmt(t.reward_amount)}</td>
                <td>${t.min_redeem_amount > 0 ? this.fmt(t.min_redeem_amount) : '<span style="color:var(--text-muted)">None</span>'}</td>
                <td>${t.min_redeem_days > 0 ? `${t.min_redeem_days} day${t.min_redeem_days===1?'':'s'}` : '<span style="color:var(--text-muted)">None</span>'}</td>
                <td><span class="badge-pill badge-blue">${t.customer_count}</span></td>
                <td><span class="badge-pill ${t.active ? 'badge-green' : ''}" style="${t.active?'':'background:#e0e0e0;color:#666'}">${t.active ? 'Active' : 'Inactive'}</span></td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="App.showCashBackCardTypeForm(${t.id})">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="App.deleteCashBackCardType(${t.id})">Del</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No cash back card types yet</td></tr>'}
          </tbody>
        </table>
      </div>`;
  },

  async showCashBackCardTypeForm(id) {
    let t = { points_threshold: 500, reward_amount: 0, min_redeem_amount: 0, min_redeem_days: 0, active: 1 };
    if (id) t = (await this.api('GET', '/cash-back-cards')).find(x => x.id === id) || t;
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit' : 'New'} Card Type</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Name *</label><input id="cb-name" value="${t.name||''}" placeholder="e.g. Rewards Plus"></div>
          <div class="input-row">
            <div class="form-group"><label>Points Threshold *</label><input type="number" id="cb-threshold" value="${t.points_threshold}" min="1" step="1"></div>
            <div class="form-group"><label>Reward Amount ($) *</label><input type="number" id="cb-reward" value="${t.reward_amount}" min="0" step="0.01"></div>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:-6px 0 10px">e.g. 500 points threshold + $5 reward = every 500 points earns $5 in cash back.</p>
          <div class="input-row">
            <div class="form-group"><label>Minimum Redeem Amount ($)</label><input type="number" id="cb-min-amount" value="${t.min_redeem_amount}" min="0" step="0.01" placeholder="0 = no minimum"></div>
            <div class="form-group"><label>Redemption Cooldown (days)</label><input type="number" id="cb-min-days" value="${t.min_redeem_days}" min="0" step="1" placeholder="0 = no cooldown"></div>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:-6px 0 10px">Both are optional gates — leave at 0 to disable. When set, a customer must have at least the minimum accrued <em>and</em> have waited out the cooldown since their last redemption before they can redeem again.</p>
          <div class="form-group"><label style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="cb-active" ${t.active ? 'checked' : ''} style="width:auto"> Active
          </label></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveCashBackCardType(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveCashBackCardType(id) {
    const name = document.getElementById('cb-name').value.trim();
    const points_threshold = parseInt(document.getElementById('cb-threshold').value) || 0;
    const reward_amount = parseFloat(document.getElementById('cb-reward').value) || 0;
    const min_redeem_amount = parseFloat(document.getElementById('cb-min-amount').value) || 0;
    const min_redeem_days = parseInt(document.getElementById('cb-min-days').value) || 0;
    const active = document.getElementById('cb-active').checked;
    if (!name) { this.alert('Name is required', 'error'); return; }
    if (points_threshold <= 0) { this.alert('Points threshold must be greater than 0', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/cash-back-cards/${id}`, { name, points_threshold, reward_amount, min_redeem_amount, min_redeem_days, active });
      else await this.api('POST', '/cash-back-cards', { name, points_threshold, reward_amount, min_redeem_amount, min_redeem_days, active });
      this.closeModal();
      this.alert(id ? 'Card type updated' : 'Card type created');
      this.renderCashBackCards();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteCashBackCardType(id) {
    if (!confirm('Delete this cash back card type?')) return;
    try {
      await this.api('DELETE', `/cash-back-cards/${id}`);
      this.alert('Card type deleted');
      this.renderCashBackCards();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async managePromoItems(promoId, promoName) {
    const [promo, categories, products] = await Promise.all([
      this.api('GET', `/promotions/${promoId}`),
      this.api('GET', '/categories'),
      this.api('GET', '/products'),
    ]);
    const assignedProductIds = new Set(promo.items.filter(i=>i.item_type==='product').map(i=>i.item_id));
    const assignedCategoryIds = new Set(promo.items.filter(i=>i.item_type==='category').map(i=>i.item_id));

    const catRows = categories.map(c => `
      <tr>
        <td>${c.name}</td><td>Category</td>
        <td>${assignedCategoryIds.has(c.id)
          ? `<span class="badge-pill badge-green">Assigned</span>`
          : ''}</td>
        <td>${assignedCategoryIds.has(c.id)
          ? `<button class="btn btn-sm btn-danger" onclick="App._removePromoItem(${promoId},${promo.items.find(i=>i.item_type==='category'&&i.item_id===c.id)?.id},${promoId},'${promoName.replace(/'/g,"\\'")}')">Remove</button>`
          : `<button class="btn btn-sm btn-secondary" onclick="App._addPromoItem(${promoId},'category',${c.id},'${promoName.replace(/'/g,"\\'")}')">Add</button>`}</td>
      </tr>`).join('');

    const prodRows = products.filter(p=>p.active).map(p => `
      <tr>
        <td>${p.name}<div style="font-size:11px;color:var(--text-muted)">${p.sku}</div></td><td>Product</td>
        <td>${assignedProductIds.has(p.id)
          ? `<span class="badge-pill badge-green">Assigned</span>`
          : ''}</td>
        <td>${assignedProductIds.has(p.id)
          ? `<button class="btn btn-sm btn-danger" onclick="App._removePromoItem(${promoId},${promo.items.find(i=>i.item_type==='product'&&i.item_id===p.id)?.id},${promoId},'${promoName.replace(/'/g,"\\'")}')">Remove</button>`
          : `<button class="btn btn-sm btn-secondary" onclick="App._addPromoItem(${promoId},'product',${p.id},'${promoName.replace(/'/g,"\\'")}')">Add</button>`}</td>
      </tr>`).join('');

    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">Items & Categories — ${promoName}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Assign specific categories and products to this promotion. The discount will only apply to these items at checkout.</p>
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>${catRows}${prodRows}</tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Done</button></div>
      </div>`);
  },

  async _addPromoItem(promoId, itemType, itemId, promoName) {
    try {
      await this.api('POST', `/promotions/${promoId}/items`, { item_type: itemType, item_id: itemId });
      this.alert('Item added');
      this.managePromoItems(promoId, promoName);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _removePromoItem(promoId, rowId, pid, promoName) {
    try {
      await this.api('DELETE', `/promotions/${promoId}/items/${rowId}`);
      this.alert('Item removed');
      this.managePromoItems(promoId, promoName);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async managePromoBrands(promoId, promoName) {
    const [promo, brandList] = await Promise.all([
      this.api('GET', `/promotions/${promoId}`),
      this.api('GET', '/promotions/brands'),
    ]);
    const includedMap = new Map(promo.brands.filter(b=>!b.excluded).map(b=>[b.brand.toLowerCase(), b]));
    const excludedMap = new Map(promo.brands.filter(b=>b.excluded).map(b=>[b.brand.toLowerCase(), b]));
    const escName = promoName.replace(/'/g,"\\'");

    const rows = brandList.map(brand => {
      const key = brand.toLowerCase();
      const inc = includedMap.get(key);
      const exc = excludedMap.get(key);
      const status = inc ? '<span class="badge-pill badge-green">Included</span>' : exc ? '<span class="badge-pill badge-danger">Excluded</span>' : '<span style="color:var(--text-muted)">—</span>';
      const rowId = inc ? inc.id : exc ? exc.id : null;
      const escBrand = brand.replace(/'/g,"\\'");
      const actions = [];
      if (!inc) actions.push(`<button class="btn btn-sm btn-secondary" onclick="App._setPromoBrand(${promoId},'${escBrand}',false,'${escName}')">Include</button>`);
      if (!exc) actions.push(`<button class="btn btn-sm btn-outline" onclick="App._setPromoBrand(${promoId},'${escBrand}',true,'${escName}')">Exclude</button>`);
      if (rowId) actions.push(`<button class="btn btn-sm btn-danger" onclick="App._removePromoBrand(${promoId},${rowId},'${escName}')">Remove</button>`);
      return `<tr><td>${brand}</td><td>${status}</td><td style="white-space:nowrap">${actions.join(' ')}</td></tr>`;
    }).join('');

    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header">
          <span class="modal-title">Brands — ${promoName}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px"><strong>Included</strong> brands only matter when this promotion's Applies To is "Specific Brands" — the discount is limited to those brands. <strong>Excluded</strong> brands are carved out of this promotion no matter what it applies to.</p>
          ${brandList.length ? `<table><thead><tr><th>Brand</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>` : '<p style="color:var(--text-muted)">No brands found in the catalog yet — set a Brand on a product first.</p>'}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Done</button></div>
      </div>`);
  },

  async _setPromoBrand(promoId, brand, excluded, promoName) {
    try {
      await this.api('POST', `/promotions/${promoId}/brands`, { brand, excluded });
      this.managePromoBrands(promoId, promoName);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _removePromoBrand(promoId, rowId, promoName) {
    try {
      await this.api('DELETE', `/promotions/${promoId}/brands/${rowId}`);
      this.managePromoBrands(promoId, promoName);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async managePromoCodes(promoId, promoName) {
    const promo = await this.api('GET', `/promotions/${promoId}`);
    const codeRows = promo.codes.length ? promo.codes.map(c => `
      <tr>
        <td style="font-family:monospace;font-weight:600">${c.code}</td>
        <td>${c.usage_limit !== null ? c.usage_limit : '∞'}</td>
        <td>${c.times_used}</td>
        <td>${c.active ? '<span class="badge-pill badge-green">Active</span>' : '<span class="badge-pill" style="background:#e0e0e0;color:#666">Inactive</span>'}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="App._togglePromoCode(${promoId},${c.id},${c.active},'${promoName.replace(/'/g,"\\'")}')">
            ${c.active ? 'Disable' : 'Enable'}
          </button>
          <button class="btn btn-sm btn-danger" onclick="App._deletePromoCode(${promoId},${c.id},'${promoName.replace(/'/g,"\\'")}')">Del</button>
        </td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="empty-state">No codes yet</td></tr>';

    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <span class="modal-title">Promotion Codes — ${promoName}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="card" style="margin-bottom:16px;padding:12px">
            <div class="fw-600" style="margin-bottom:8px">Add New Code</div>
            <div class="input-row">
              <div class="form-group" style="flex:2"><label>Code</label><input id="nc-code" placeholder="e.g. SUMMER20" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"></div>
              <div class="form-group"><label>Usage Limit (blank = unlimited)</label><input type="number" id="nc-limit" min="1" placeholder="∞"></div>
            </div>
            <button class="btn btn-primary btn-sm" onclick="App._addPromoCode(${promoId},'${promoName.replace(/'/g,"\\'")}')">Add Code</button>
          </div>
          <table>
            <thead><tr><th>Code</th><th>Limit</th><th>Used</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody id="promo-codes-table">${codeRows}</tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Done</button></div>
      </div>`);
  },

  async _addPromoCode(promoId, promoName) {
    const code = document.getElementById('nc-code')?.value?.trim();
    const limitVal = document.getElementById('nc-limit')?.value?.trim();
    const usage_limit = limitVal ? parseInt(limitVal) : null;
    if (!code) return this.alert('Code required', 'error');
    try {
      await this.api('POST', `/promotions/${promoId}/codes`, { code, usage_limit });
      this.alert('Code added');
      this.managePromoCodes(promoId, promoName);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _togglePromoCode(promoId, codeId, currentActive, promoName) {
    try {
      await this.api('PUT', `/promotions/${promoId}/codes/${codeId}`, { active: !currentActive });
      this.managePromoCodes(promoId, promoName);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _deletePromoCode(promoId, codeId, promoName) {
    if (!confirm('Delete this code?')) return;
    try {
      await this.api('DELETE', `/promotions/${promoId}/codes/${codeId}`);
      this.alert('Code deleted');
      this.managePromoCodes(promoId, promoName);
    } catch(e) { this.alert(e.message, 'error'); }
  },
});
