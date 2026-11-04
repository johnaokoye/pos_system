// Settings, API keys, integrations, email dialogs, units, categories, brands, customer categories.
Object.assign(App, {
  // ─── Settings ─────────────────────────────────────────────
  async renderSettings() {
    const [s, categories, branches, customerCategories] = await Promise.all([
      this.api('GET', '/settings'),
      this.api('GET', '/categories'),
      this.api('GET', '/branches'),
      this.api('GET', '/customer-categories'),
    ]);
    if (this.section !== 'settings') return;

    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>Settings</h2><span style="font-size:11px;color:var(--text-muted)">Build: ${s.build_commit || 'unknown'}</span></div>
      <div class="two-col">
        <div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Store Information</span></div>
            <div class="form-group"><label>Company Logo</label>
              <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
                ${s.company_logo_url ? `<img src="${s.company_logo_url}" alt="Company logo" style="max-height:48px;max-width:160px;object-fit:contain;border:1px solid var(--border);border-radius:6px;padding:4px" id="s-logo-preview">` : `<div style="width:48px;height:48px;border:1px dashed var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:20px" id="s-logo-preview">🖼</div>`}
                <div>
                  <label class="btn btn-secondary btn-sm" style="cursor:pointer;margin:0">Upload Logo<input type="file" id="s-logo-input" accept="image/*" style="display:none" onchange="App.uploadCompanyLogo(this)"></label>
                  ${s.company_logo_url ? `<button class="btn btn-danger btn-sm" style="margin-left:6px" onclick="App.removeCompanyLogo()">Remove</button>` : ''}
                </div>
              </div>
              <p style="font-size:11px;color:var(--text-muted);margin-top:6px">Replaces the RetailPOS wordmark on the login screen and sidebar.</p>
            </div>
            <div class="form-group"><label>Store Name</label><input id="s-name" value="${this.escapeAttr(s.store_name||'')}"></div>
            <div class="form-group"><label>Address</label><input id="s-addr" value="${this.escapeAttr(s.store_address||'')}"></div>
            <div class="input-row">
              <div class="form-group"><label>Phone</label><input id="s-phone" value="${this.escapeAttr(s.store_phone||'')}"></div>
              <div class="form-group"><label>Email</label><input id="s-email" value="${this.escapeAttr(s.store_email||'')}"></div>
            </div>
            <div class="form-group"><label>Receipt Footer Message</label><textarea id="s-footer" rows="8">${this.escapeAttr(s.receipt_footer||'')}</textarea><p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Shown at the bottom of receipts, Retail Tax Invoices and quotes, on screen, printed, emailed and in PDFs. Each line you type here stays on its own line.</p></div>
            <button class="btn btn-primary" onclick="App.saveSettings()">Save Settings</button>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Tax & Loyalty</span></div>
            <div class="input-row">
              <div class="form-group"><label>Default Tax Rate (%)</label><input type="number" id="s-tax" value="${s.tax_rate||8.5}" min="0" step="0.1"></div>
              <div class="form-group"><label>Default Currency</label><select id="s-currency">${this.currencyOptions(s.currency)}</select></div>
            </div>
            <div class="input-row">
              <div class="form-group"><label>Loyalty Points per $1 Spent</label><input type="number" id="s-loyalty" value="${s.loyalty_rate||0.5}" min="0" step="0.1"></div>
              <div class="form-group"><label>Low Stock Threshold</label><input type="number" id="s-lowstock" value="${s.low_stock_threshold||5}" min="0"></div>
            </div>
            <div class="form-group"><label>Maximum Discount (%, 0 = unlimited) — caps the ticket discount and each line-item discount</label><input type="number" id="s-max-discount" value="${s.max_discount_pct||0}" min="0" max="100" step="0.1" placeholder="e.g. 20 for 20% max"></div>
            <button class="btn btn-primary" onclick="App.saveSettings()">Save Settings</button>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Layaway</span></div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Applies to every layaway-eligible item storewide.</p>
            <div class="input-row">
              <div class="form-group"><label>Required Deposit (% of item total)</label><input type="number" id="s-layaway-deposit" value="${s.layaway_deposit_percent||20}" min="0" max="100" step="0.1"></div>
              <div class="form-group"><label>Layaway Markup (% added to price)</label><input type="number" id="s-layaway-markup" value="${s.layaway_markup_percent||0}" min="0" step="0.1" placeholder="0 = sell at regular price"></div>
            </div>
            <div class="input-row">
              <div class="form-group"><label>Cancellation Fee Type</label>
                <select id="s-layaway-fee-type">
                  <option value="percent" ${(s.layaway_cancellation_fee_type||'percent')==='percent'?'selected':''}>% of amount paid</option>
                  <option value="fixed" ${s.layaway_cancellation_fee_type==='fixed'?'selected':''}>Fixed amount</option>
                </select>
              </div>
              <div class="form-group"><label>Cancellation Fee Value</label><input type="number" id="s-layaway-fee-value" value="${s.layaway_cancellation_fee_value||0}" min="0" step="0.01"></div>
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px">This amount is forfeited from what the customer already paid when a plan is cancelled; the rest is refunded automatically.</p>
            <button class="btn btn-primary" onclick="App.saveSettings()">Save Settings</button>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Rental Returns — Closed Days</span></div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">At branches marked <strong>Closed on Sundays &amp; public holidays</strong> (Branch Management), a rental due back on a Sunday or one of the holidays below can be returned by the return-by time on the next open day with no late charge.</p>
            <div class="input-row">
              <div class="form-group"><label>Return By (next open day)</label><input type="time" id="s-closed-return-by" value="${this.escapeAttr(s.closed_day_return_by || '08:00')}"></div>
              <div class="form-group"><label>Store Time Zone</label><input id="s-store-tz" list="s-store-tz-list" value="${this.escapeAttr(s.store_timezone || 'America/Jamaica')}" placeholder="America/Jamaica">
                <datalist id="s-store-tz-list">${(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map(z => `<option value="${z}">`).join('')}</datalist></div>
            </div>
            <div class="form-group"><label>Public Holidays <span style="color:var(--text-muted);font-weight:400;font-size:11px">(one per line: date, then name — e.g. 2026-12-25 Christmas Day)</span></label>
              <textarea id="s-public-holidays" rows="5" placeholder="2026-12-25 Christmas Day&#10;2026-12-26 Boxing Day">${this.escapeAttr(s.public_holidays || '')}</textarea></div>
            <button class="btn btn-primary" onclick="App.saveSettings()">Save Settings</button>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">POS Line-Item Discounts</span></div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Governs the per-line "%" and "$" (fixed amount) discounts in the POS cart — a "$" discount counts as the percentage it takes off the line. It's capped at the Maximum Discount above (currently ${parseFloat(s.max_discount_pct) > 0 ? `${parseFloat(s.max_discount_pct)}%` : 'unlimited'}); a discount above that needs a manager PIN with <span class="perm-pill">pos_discount_override</span> to authorize. An item already covered by an active promotion, or whose brand is listed below, can't take a manual discount at all.</p>
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Brands Excluded From Manual Discounts</div>
            <div id="discount-excluded-brands-wrap">Loading…</div>
            <div class="input-row" style="margin-top:10px;align-items:flex-end">
              <div class="form-group" style="flex:1"><label>Brand</label><input id="discount-excl-brand-input" placeholder="e.g. Apple" onkeydown="if(event.key==='Enter')App.addDiscountExcludedBrand()"></div>
              <div style="padding-bottom:4px"><button class="btn btn-secondary" onclick="App.addDiscountExcludedBrand()">+ Add</button></div>
            </div>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Alternate Currencies</span></div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Define currencies accepted at the POS and what <strong>1 unit</strong> of each is worth in <strong>${s.currency||'USD'}</strong> — e.g. 1 USD = 155 ${s.currency||'USD'}. Cashiers can select these when processing cash payments, and drawer reconciliation multiplies counted foreign notes by this rate.</p>
            <div id="alt-currencies-table">${this._renderAltCurrenciesTable()}</div>
            <div class="input-row" style="margin-top:12px;align-items:flex-end">
              <div class="form-group" style="flex:2"><label>Currency</label><select id="alt-cur-code">${this.currencyOptions('')}</select></div>
              <div class="form-group" style="flex:1"><label>1 unit = ? ${s.currency||'USD'}</label><input type="number" id="alt-cur-rate" min="0.0001" step="any" placeholder="e.g. 155"></div>
              <div style="padding-bottom:4px"><button class="btn btn-secondary" onclick="App.addAltCurrency()">+ Add</button></div>
            </div>
            <button class="btn btn-primary" style="margin-top:12px" onclick="App.saveSettings()">Save Settings</button>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Currency Denominations</span></div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Define banknotes and coins for each currency. These appear in the cash reconciliation breakdown so cashiers can count each denomination.</p>
            <div id="denom-currency-row" class="input-row" style="margin-bottom:10px;align-items:flex-end">
              <div class="form-group" style="flex:2"><label>Show denominations for</label><select id="denom-filter-currency" onchange="App.loadDenominations()">${this.currencyOptions(s.currency||'USD')}</select></div>
            </div>
            <div id="denom-table-wrap"></div>
            <div class="form-group" style="margin-top:12px"><label>Email drawer reconciliation reports to</label>
              <div style="display:flex;gap:8px"><input id="s-drawer-email" type="email" value="${this.escapeAttr(s.drawer_report_email||'')}" placeholder="e.g. accounts@yourstore.com — several can be separated by commas" style="flex:1"><button class="btn btn-secondary" onclick="App.saveSettings()">Save</button></div>
              <small style="color:var(--text-muted)">Filled in on the Reconcile screen and the drawer report's Email PDF, so the PDF goes to this address unless changed.</small></div>
            <div class="input-row" style="margin-top:12px;align-items:flex-end">
              <div class="form-group" style="flex:1.5"><label>Value</label><input type="number" id="denom-new-value" step="any" min="0.01" placeholder="e.g. 50"></div>
              <div class="form-group" style="flex:1.5"><label>Label</label><input type="text" id="denom-new-label" placeholder="e.g. $50"></div>
              <div style="padding-bottom:4px"><button class="btn btn-secondary" onclick="App.addDenomination()">+ Add</button></div>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><span class="card-title">Email (SMTP)</span></div>
            <div class="input-row">
              <div class="form-group" style="flex:2"><label>SMTP Host</label><input id="s-smtp-host" placeholder="smtp.gmail.com" value="${s.email_smtp_host||''}"></div>
              <div class="form-group" style="flex:1"><label>Port</label><input type="number" id="s-smtp-port" placeholder="587" value="${s.email_smtp_port||'587'}"></div>
            </div>
            <div class="input-row">
              <div class="form-group"><label>Username</label><input id="s-smtp-user" placeholder="you@gmail.com" value="${s.email_smtp_user||''}"></div>
              <div class="form-group"><label>Password / App Password</label><input type="password" id="s-smtp-pass" value="${s.email_smtp_pass||''}"></div>
            </div>
            <div class="input-row">
              <div class="form-group"><label>From Name</label><input id="s-smtp-name" placeholder="${s.store_name||'My Store'}" value="${s.email_from_name||''}"></div>
              <div class="form-group" style="flex:0 0 140px;display:flex;align-items:flex-end;gap:8px;padding-bottom:4px">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:500"><input type="checkbox" id="s-smtp-secure" ${s.email_smtp_secure==='true'?'checked':''} style="width:auto">Use TLS (port 465)</label>
              </div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-primary" onclick="App.saveSettings()">Save Settings</button>
              <button class="btn btn-secondary" onclick="App.testSmtp()">Test Connection</button>
            </div>
          </div>
          <div class="card" style="margin-top:16px">
            <div class="card-header"><span class="card-title">Cloudinary (Image &amp; File Storage)</span></div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">When configured, product images and PO attachments are stored in Cloudinary instead of the local filesystem. Required for Vercel deployments.</p>
            <div class="form-group"><label>Cloud Name</label><input id="cld-cloud-name" placeholder="your-cloud-name" value="${s.cloudinary_cloud_name||''}"></div>
            <div class="input-row">
              <div class="form-group"><label>API Key</label><input id="cld-api-key" placeholder="123456789012345" value="${s.cloudinary_api_key||''}"></div>
              <div class="form-group"><label>API Secret</label><input type="password" id="cld-api-secret" placeholder="••••••••••••••••••••••" value="${s.cloudinary_api_secret||''}"></div>
            </div>
            <button class="btn btn-primary" onclick="App.saveCloudinarySettings()">Save</button>
          </div>
          <div class="card" style="margin-top:16px">
            <div class="card-header">
              <span class="card-title">Ecommerce Sync</span>
              <span id="woo-conn-status" style="font-size:12px"></span>
            </div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Products and customers push from POS → Ecommerce. Ecommerce orders import as POS transactions.</p>
            <div class="form-group"><label>Store URL</label><input id="woo-url" placeholder="https://yourstore.com" value="${s.woo_url||''}"></div>
            <div class="form-group"><label>POS Public URL <span style="font-weight:400;color:var(--text-muted)">(for image sync)</span></label><input id="woo-pos-url" placeholder="https://your-pos-server.com" value="${s.woo_pos_url||''}"></div>
            <div class="input-row">
              <div class="form-group"><label>Consumer Key</label><input id="woo-ck" type="password" placeholder="ck_…" value="${s.woo_consumer_key||''}"></div>
              <div class="form-group"><label>Consumer Secret</label><input id="woo-cs" type="password" placeholder="cs_…" value="${s.woo_consumer_secret||''}"></div>
            </div>
            <div class="form-group">
              <label>Auto-Sync Interval</label>
              <select id="woo-interval">
                <option value="0" ${(!s.woo_sync_interval||s.woo_sync_interval==='0')?'selected':''}>Disabled (manual only)</option>
                <option value="15" ${s.woo_sync_interval==='15'?'selected':''}>Every 15 minutes</option>
                <option value="30" ${s.woo_sync_interval==='30'?'selected':''}>Every 30 minutes</option>
                <option value="60" ${s.woo_sync_interval==='60'?'selected':''}>Every hour</option>
                <option value="120" ${s.woo_sync_interval==='120'?'selected':''}>Every 2 hours</option>
                <option value="1440" ${s.woo_sync_interval==='1440'?'selected':''}>Daily</option>
              </select>
            </div>
            <div class="form-group">
              <label>Inventory Source <span style="font-weight:400;color:var(--text-muted)">(branch/warehouse whose stock levels are pushed online)</span></label>
              <select id="woo-sync-branch">
                <option value="" ${!s.woo_sync_branch_id?'selected':''}>Global Stock</option>
                ${branches.map(b => `<option value="${b.id}" ${s.woo_sync_branch_id==b.id?'selected':''}>${b.name}${b.is_warehouse?' (Warehouse)':''}</option>`).join('')}
              </select>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:16px">
              <button class="btn btn-primary" onclick="App.saveWooSettings()">Save</button>
              <button class="btn btn-secondary" onclick="App.testWooConnection()">Test Connection</button>
            </div>
            <div style="border-top:1px solid var(--border);padding-top:12px">
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn btn-primary" onclick="App.wooSync('products')">Sync Products</button>
                <button class="btn btn-primary" onclick="App.wooSync('customers')">Sync Customers</button>
                <button class="btn btn-primary" onclick="App.wooSync('orders')">Import Orders</button>
                <button class="btn btn-secondary" onclick="App.wooSync('all')">Sync All</button>
              </div>
              ${s.woo_last_sync_products?`<p style="font-size:11px;color:var(--text-muted);margin:8px 0 0">Products last synced: ${this.fmtDateTime(s.woo_last_sync_products)}</p>`:''}
              ${s.woo_last_sync_customers?`<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Customers last synced: ${this.fmtDateTime(s.woo_last_sync_customers)}</p>`:''}
              ${s.woo_last_sync_orders?`<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Orders last imported: ${this.fmtDateTime(s.woo_last_sync_orders)}</p>`:''}
            </div>
            <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="font-size:13px">Sync History</strong>
                <button class="btn btn-secondary btn-sm" onclick="App.loadWooLogs()">Refresh</button>
              </div>
              <div id="woo-logs-table"></div>
            </div>
          </div>
        </div>
        <div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Categories</span><button class="btn btn-primary btn-sm" onclick="App.showCategoryForm()">+ Add</button></div>
            <table>
              <thead><tr><th>Name</th><th>Products</th><th>Actions</th></tr></thead>
              <tbody id="cat-table-body">
                ${categories.map(c => `<tr><td class="fw-600">${c.name}</td><td style="text-align:center">${c.product_count}</td><td><button class="btn btn-secondary btn-sm" onclick="App.showCategoryForm(${c.id},'${this.escapeAttr(c.name).replace(/'/g,"\\'")}','${this.escapeAttr(c.description).replace(/'/g,"\\'")}')">Edit</button></td></tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header"><span class="card-title">Customer Categories</span><button class="btn btn-primary btn-sm" onclick="App.showCustomerCategoryForm()">+ Add</button></div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Classify customers (Individual, Company, Contractor, ...) on their profile. A category's discount auto-applies at checkout like a discount card does, but only when the customer has no discount card assigned — a card always wins.</p>
            <table>
              <thead><tr><th>Name</th><th>Discount %</th><th>Customers</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody id="customer-cat-table-body">
                ${customerCategories.length ? customerCategories.map(c => `<tr>
                  <td class="fw-600">${c.name}</td>
                  <td>${c.discount_percent}%</td>
                  <td style="text-align:center"><span class="badge-pill badge-blue">${c.customer_count}</span></td>
                  <td><span class="badge-pill ${c.active ? 'badge-green' : ''}" style="${c.active?'':'background:#e0e0e0;color:#666'}">${c.active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <button class="btn btn-sm btn-secondary" onclick="App.showCustomerCategoryForm(${c.id})">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="App.deleteCustomerCategory(${c.id})">Del</button>
                  </td>
                </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No customer categories yet</td></tr>'}
              </tbody>
            </table>
          </div>
          <div class="card" style="margin-bottom:16px">
            <div class="card-header">
              <span class="card-title">API Keys</span>
              <button class="btn btn-primary btn-sm" onclick="App.showCreateApiKeyModal()">+ New Key</button>
            </div>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">API keys allow external systems (e-commerce sites, integrations) to authenticate with this POS. Each key can be scoped to specific resources.</p>
            <div id="api-keys-table"><p style="font-size:13px;color:var(--text-muted)">Loading…</p></div>
          </div>
          <div class="card">
            <div class="card-header"><span class="card-title">System Info</span></div>
            <div style="font-size:13px;line-height:2;color:var(--text-muted)">
              <div><strong>Version:</strong> 1.0.0</div>
              <div><strong>Database:</strong> SQLite (pos.db)</div>
              <div><strong>Platform:</strong> Node.js / Express</div>
              <div><strong>Date:</strong> ${new Date().toLocaleDateString()}</div>
            </div>
          </div>
        </div>
      </div>`;
    // Fields saved by saveSettings(): typing in one marks the page unsaved,
    // so leaving Settings without saving asks first instead of silently
    // dropping the edit (e.g. a longer receipt footer).
    this._settingsDirty = false;
    if (!this._settingsDirtyBound) {
      this._settingsDirtyBound = true;
      document.getElementById('content').addEventListener('input', e => {
        if (this.section === 'settings' && this._SETTINGS_FORM_IDS.includes(e.target.id)) this._settingsDirty = true;
      });
    }
    this.loadDenominations();
    this.loadWooLogs();
    this.loadApiKeys();
    this.loadDiscountExcludedBrands();
  },

  async loadDiscountExcludedBrands() {
    const wrap = document.getElementById('discount-excluded-brands-wrap');
    if (!wrap) return;
    const brands = await this.api('GET', '/settings/discount-excluded-brands');
    if (!brands.length) { wrap.innerHTML = `<p style="font-size:12px;color:var(--text-muted);margin:0">No brands excluded — every item is eligible for a manual discount (subject to the promotion check above).</p>`; return; }
    wrap.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px">
      ${brands.map(b => `<span class="badge-pill badge-secondary" style="display:flex;align-items:center;gap:6px;padding:5px 6px 5px 10px">${this.escapeAttr(b.brand)}<button class="btn-remove" style="font-size:14px" title="Remove" onclick="App.removeDiscountExcludedBrand(${b.id})">×</button></span>`).join('')}
    </div>`;
  },

  async addDiscountExcludedBrand() {
    const input = document.getElementById('discount-excl-brand-input');
    const brand = input?.value.trim();
    if (!brand) return;
    try {
      await this.api('POST', '/settings/discount-excluded-brands', { brand });
      input.value = '';
      this.loadDiscountExcludedBrands();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async removeDiscountExcludedBrand(id) {
    try {
      await this.api('DELETE', `/settings/discount-excluded-brands/${id}`);
      this.loadDiscountExcludedBrands();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async loadDenominations() {
    const cur = document.getElementById('denom-filter-currency')?.value || 'USD';
    const denoms = await this.api('GET', `/denominations?currency=${cur}`);
    const wrap = document.getElementById('denom-table-wrap');
    if (!wrap) return;
    if (!denoms.length) {
      wrap.innerHTML = `<p style="font-size:12px;color:var(--text-muted);margin:0">No denominations defined for ${cur}. Add some below.</p>`;
      return;
    }
    const arrow = (dir, label) => `<button class="btn btn-secondary btn-sm" style="padding:2px 8px" title="Move ${label}" onclick="App._moveDenomination(this, ${dir})">${dir < 0 ? '↑' : '↓'}</button>`;
    wrap.innerHTML = `<p style="font-size:12px;color:var(--text-muted);margin:0 0 6px">Drag <strong>⠿</strong> (or use ↑ ↓) to set the order notes and coins are listed in when counting a drawer.</p>
    <table class="table" style="font-size:13px">
      <thead><tr><th style="width:34px"></th><th>Label</th><th>Value</th><th style="text-align:right">Actions</th></tr></thead>
      <tbody id="denom-sort-body" data-currency="${this.escapeAttr(cur)}">${denoms.map(d => `<tr data-id="${d.id}">
        <td class="denom-drag" title="Drag to reorder" style="cursor:grab;touch-action:none;user-select:none;color:var(--text-muted);font-size:18px;line-height:1">⠿</td>
        <td><strong>${this.escapeAttr(d.label)}</strong></td>
        <td>${d.value % 1 === 0 ? d.value.toFixed(0) : d.value.toFixed(2)}</td>
        <td style="text-align:right;white-space:nowrap">${arrow(-1, 'up')} ${arrow(1, 'down')} <button class="btn btn-secondary btn-sm" onclick="App.deleteDenomination(${d.id})">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
    this._bindDenominationDrag(document.getElementById('denom-sort-body'));
  },

  // Drag a denomination row by its ⠿ handle (pointer events, so mouse and
  // touch screens both work); dropping saves the new order. Moves are
  // followed on the document, not the handle — moving the row in the DOM
  // drops any pointer capture on it.
  _bindDenominationDrag(body) {
    if (!body) return;
    body.addEventListener('pointerdown', e => {
      const handle = e.target.closest('.denom-drag');
      if (!handle || e.button > 0) return;
      e.preventDefault();
      const row = handle.closest('tr');
      const before = [...body.children].map(r => r.dataset.id).join(',');
      row.style.background = 'var(--bg-alt)';
      row.style.boxShadow = '0 2px 10px rgba(0,0,0,.15)';
      document.body.style.cursor = 'grabbing';
      const move = ev => {
        if (ev.pointerId !== e.pointerId) return;
        ev.preventDefault();
        const others = [...body.children].filter(r => r !== row);
        const next = others.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
        if (next) { if (row.nextElementSibling !== next) body.insertBefore(row, next); }
        else if (body.lastElementChild !== row) body.appendChild(row);
      };
      const up = ev => {
        if (ev.pointerId !== e.pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        row.style.background = ''; row.style.boxShadow = ''; document.body.style.cursor = '';
        if ([...body.children].map(r => r.dataset.id).join(',') !== before) this._saveDenominationOrder(body);
      };
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
  },

  _moveDenomination(btn, dir) {
    const row = btn.closest('tr'), body = row?.parentElement;
    if (!body) return;
    const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    if (dir < 0) body.insertBefore(row, sib); else body.insertBefore(sib, row);
    this._saveDenominationOrder(body);
  },

  async _saveDenominationOrder(body) {
    try {
      await this.api('PUT', '/denominations/order', { currency: body.dataset.currency, ids: [...body.children].map(r => Number(r.dataset.id)) });
    } catch (e) { this.alert(e.message, 'error'); this.loadDenominations(); }
  },

  async addDenomination() {
    const cur = document.getElementById('denom-filter-currency')?.value || 'USD';
    const value = parseFloat(document.getElementById('denom-new-value')?.value);
    const label = document.getElementById('denom-new-label')?.value.trim();
    if (!value || !label) return this.alert('Enter a value and label', 'error');
    try {
      await this.api('POST', '/denominations', { currency: cur, value, label });
      document.getElementById('denom-new-value').value = '';
      document.getElementById('denom-new-label').value = '';
      this.loadDenominations();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteDenomination(id) {
    await this.api('DELETE', `/denominations/${id}`);
    this.loadDenominations();
  },

  async loadApiKeys() {
    const wrap = document.getElementById('api-keys-table');
    if (!wrap) return;
    try {
      const keys = await this.api('GET', '/api-keys');
      if (!keys.length) {
        wrap.innerHTML = `<p style="font-size:13px;color:var(--text-muted);margin:0">No API keys yet. Create one to allow external integrations.</p>`;
        return;
      }
      const scopeLabel = s => s === '*' ? 'Full Access' : s;
      wrap.innerHTML = `<table class="table" style="font-size:12px">
        <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last Used</th><th>Status</th><th></th></tr></thead>
        <tbody>${keys.map(k => `<tr>
          <td class="fw-600">${this.esc(k.name)}</td>
          <td style="font-family:monospace">${k.key_prefix}…</td>
          <td style="max-width:160px;white-space:normal">${JSON.parse(k.scopes||'[]').map(scopeLabel).join(', ')}</td>
          <td style="color:var(--text-muted)">${k.last_used_at ? this.fmtDate(k.last_used_at) : 'Never'}</td>
          <td><span class="badge ${k.is_active?'badge-success':'badge-danger'}">${k.is_active?'Active':'Revoked'}</span></td>
          <td>${k.is_active ? `<button class="btn btn-secondary btn-sm" onclick="App.revokeApiKey(${k.id})">Revoke</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch(e) { wrap.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`; }
  },

  showCreateApiKeyModal() {
    const scopeOptions = [
      { value: '*',               label: 'Full Access (all endpoints)' },
      { value: 'products:read',   label: 'Products — Read' },
      { value: 'products:write',  label: 'Products — Write' },
      { value: 'customers:read',  label: 'Customers — Read' },
      { value: 'customers:write', label: 'Customers — Write' },
      { value: 'orders:read',     label: 'Orders — Read' },
      { value: 'orders:write',    label: 'Orders — Write' },
      { value: 'accounts:read',   label: 'Accounts Receivable — Read' },
      { value: 'accounts:write',  label: 'Accounts Receivable — Write legacy invoices (RetailPOS Books)' },
      { value: 'suppliers:read',  label: 'Vendors — Read' },
      { value: 'payables:read',   label: 'Accounts Payable — Read' },
      { value: 'shop_use:read',   label: 'Shop Use Postings — Read' },
      { value: 'shop_use:write',  label: 'Shop Use Postings — Acknowledge' },
      { value: 'payables:write',   label: 'Contra Postings — Acknowledge' },
      { value: 'petty_cash:read',  label: 'Petty Cash Postings — Read' },
      { value: 'petty_cash:write', label: 'Petty Cash Postings — Acknowledge' },
    ];
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">Create API Key</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Name <span style="color:var(--text-muted);font-weight:400">(e.g. "E-commerce Site")</span></label>
            <input id="ak-name" placeholder="My Integration" autofocus>
          </div>
          <div class="form-group">
            <label>Scopes</label>
            <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Select what this key is allowed to do. For a full e-commerce integration, "Full Access" is simplest.</p>
            ${scopeOptions.map(o => `<label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;font-weight:400">
              <input type="checkbox" class="ak-scope" value="${o.value}" style="width:auto" ${o.value==='*'?'checked':''}>
              <span><strong style="font-family:monospace;font-size:11px">${o.value}</strong> — ${o.label}</span>
            </label>`).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.createApiKey()">Generate Key</button>
        </div>
      </div>`);
  },

  async createApiKey() {
    const name = document.getElementById('ak-name')?.value.trim();
    if (!name) return this.alert('Enter a name for this key', 'error');
    const scopes = [...document.querySelectorAll('.ak-scope:checked')].map(el => el.value);
    if (!scopes.length) return this.alert('Select at least one scope', 'error');
    try {
      const result = await this.api('POST', '/api-keys', { name, scopes });
      this.showModal(`
        <div class="modal" style="max-width:480px">
          <div class="modal-header"><span class="modal-title">API Key Created</span></div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--danger);margin:0 0 12px">Copy this key now — it will <strong>never be shown again</strong>.</p>
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;color:var(--text)">${result.key}</div>
            <p style="font-size:12px;color:var(--text-muted);margin:12px 0 0">Send it in the <code>X-API-Key</code> header or as <code>Authorization: Bearer &lt;key&gt;</code></p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="App.closeModal();App.loadApiKeys()">Done</button>
            <button class="btn btn-primary" onclick="navigator.clipboard.writeText('${result.key}').then(()=>App.alert('Copied!','success'))">Copy to Clipboard</button>
          </div>
        </div>`);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async revokeApiKey(id) {
    if (!confirm('Revoke this API key? Any integrations using it will immediately lose access.')) return;
    try {
      await this.api('DELETE', `/api-keys/${id}`);
      this.alert('API key revoked', 'success');
      this.loadApiKeys();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async uploadCompanyLogo(input) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('logo', file);
    try {
      const res = await fetch('/api/settings/logo', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      this.alert('Logo uploaded');
      // Receipts and other printouts read the logo from this.settings
      // (via _printLogoTag), and the server has already deleted the old
      // file, so keep it in sync or they'd show a broken image until reload.
      if (this.settings) this.settings.company_logo_url = json.logo_url;
      this.applyBranding(json.logo_url, this.settings?.store_name);
      this.renderSettings();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async removeCompanyLogo() {
    if (!confirm('Remove the company logo?')) return;
    try {
      await this.api('DELETE', '/settings/logo');
      this.alert('Logo removed');
      if (this.settings) delete this.settings.company_logo_url;
      this.applyBranding(null, this.settings?.store_name);
      this.renderSettings();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  _SETTINGS_FORM_IDS: ['s-name', 's-addr', 's-phone', 's-email', 's-drawer-email', 's-footer', 's-tax', 's-currency', 's-loyalty', 's-lowstock', 's-max-discount', 's-layaway-deposit', 's-layaway-markup', 's-closed-return-by', 's-store-tz', 's-public-holidays', 's-layaway-fee-type', 's-layaway-fee-value', 's-smtp-host', 's-smtp-port', 's-smtp-user', 's-smtp-pass', 's-smtp-name', 's-smtp-secure'],

  async saveSettings() {
    const data = {
      store_name: document.getElementById('s-name').value,
      store_address: document.getElementById('s-addr').value,
      store_phone: document.getElementById('s-phone').value,
      store_email: document.getElementById('s-email').value,
      ...(document.getElementById('s-drawer-email') ? { drawer_report_email: document.getElementById('s-drawer-email').value.trim() } : {}),
      receipt_footer: document.getElementById('s-footer').value,
      tax_rate: document.getElementById('s-tax').value,
      currency: document.getElementById('s-currency').value,
      loyalty_rate: document.getElementById('s-loyalty').value,
      low_stock_threshold: document.getElementById('s-lowstock').value,
      max_discount_pct: document.getElementById('s-max-discount').value,
      layaway_deposit_percent: document.getElementById('s-layaway-deposit').value,
      layaway_markup_percent: document.getElementById('s-layaway-markup').value,
      closed_day_return_by: document.getElementById('s-closed-return-by').value || '08:00',
      store_timezone: document.getElementById('s-store-tz').value.trim(),
      public_holidays: document.getElementById('s-public-holidays').value
        .split('\n').map(l => l.trim()).filter(Boolean).join('\n'),
      layaway_cancellation_fee_type: document.getElementById('s-layaway-fee-type').value,
      layaway_cancellation_fee_value: document.getElementById('s-layaway-fee-value').value,
      email_smtp_host: document.getElementById('s-smtp-host').value,
      email_smtp_port: document.getElementById('s-smtp-port').value,
      email_smtp_user: document.getElementById('s-smtp-user').value,
      email_smtp_pass: document.getElementById('s-smtp-pass').value,
      email_from_name: document.getElementById('s-smtp-name').value,
      email_smtp_secure: document.getElementById('s-smtp-secure').checked ? 'true' : 'false',
      alt_currencies: JSON.stringify(this.altCurrencies || []),
    };
    const badHoliday = data.public_holidays.split('\n').find(l => !/^\d{4}-\d{2}-\d{2}\b/.test(l));
    if (badHoliday) { this.alert(`Public holiday line "${badHoliday}" needs to start with a date like 2026-12-25`, 'error'); return; }
    try {
      await this.api('PUT', '/settings', data);
      this._settingsDirty = false;
      await this.loadSettings();
      this.alert('Settings saved');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async testSmtp() {
    try {
      await this.api('POST', '/email/test', {
        host: document.getElementById('s-smtp-host').value,
        port: document.getElementById('s-smtp-port').value,
        user: document.getElementById('s-smtp-user').value,
        pass: document.getElementById('s-smtp-pass').value,
        secure: document.getElementById('s-smtp-secure').checked,
      });
      this.alert('SMTP connection successful');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async saveCloudinarySettings() {
    try {
      await this.api('PUT', '/settings', {
        cloudinary_cloud_name: document.getElementById('cld-cloud-name').value.trim(),
        cloudinary_api_key: document.getElementById('cld-api-key').value.trim(),
        cloudinary_api_secret: document.getElementById('cld-api-secret').value.trim(),
      });
      this.alert('Cloudinary settings saved');
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async saveWooSettings() {
    const data = {
      woo_url: document.getElementById('woo-url').value.trim(),
      woo_pos_url: document.getElementById('woo-pos-url').value.trim(),
      woo_consumer_key: document.getElementById('woo-ck').value.trim(),
      woo_consumer_secret: document.getElementById('woo-cs').value.trim(),
      woo_sync_interval: document.getElementById('woo-interval').value,
      woo_sync_branch_id: document.getElementById('woo-sync-branch').value || null,
    };
    try {
      await this.api('PUT', '/settings', data);
      this.alert('Ecommerce settings saved');
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async testWooConnection() {
    const el = document.getElementById('woo-conn-status');
    if (el) el.innerHTML = '<span style="color:var(--text-muted)">Testing…</span>';
    try {
      const r = await this.api('POST', '/woocommerce/test');
      if (el) el.innerHTML = `<span style="color:var(--success)">Connected — WC ${r.wc_version||''}</span>`;
    } catch (e) {
      if (el) el.innerHTML = `<span style="color:var(--danger)">${e.message}</span>`;
    }
  },

  async wooSync(type) {
    const labels = { products: 'Products', customers: 'Customers', orders: 'Orders', all: 'All' };
    try {
      this.alert(`Syncing ${labels[type]||type}…`);
      const r = await this.api('POST', `/woocommerce/sync/${type}`);
      let msg;
      if (type === 'all') {
        const parts = ['products','customers','orders'].map(t =>
          r[t]?.error ? `${t}: error` : `${t}: +${r[t]?.created||0} updated ${r[t]?.updated||0}`
        );
        msg = parts.join(' | ');
      } else {
        msg = `${labels[type]}: ${r.created||0} created, ${r.updated||0} updated, ${r.failed||0} failed`;
      }
      const anyFailed = type === 'all'
        ? ['products','customers','orders'].some(t => (r[t]?.failed||0) > 0 || r[t]?.error)
        : (r.failed || 0) > 0;
      this.alert(msg, anyFailed ? 'warning' : 'success');
      this.loadWooLogs();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  async loadWooLogs() {
    const el = document.getElementById('woo-logs-table');
    if (!el) return;
    try {
      const logs = await this.api('GET', '/woocommerce/logs');
      if (!logs.length) {
        el.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">No sync history yet.</p>';
        return;
      }
      const color = s => s === 'completed' ? 'var(--success)' : s === 'failed' ? 'var(--danger)' : 'var(--text-muted)';
      el.innerHTML = `<table style="font-size:12px;width:100%">
        <thead><tr><th>Type</th><th>Status</th><th>Created</th><th>Updated</th><th>Failed</th><th>Started</th></tr></thead>
        <tbody>${logs.map(l => `<tr>
          <td>${l.sync_type}</td>
          <td><span style="color:${color(l.status)}">${l.status}</span></td>
          <td style="text-align:center">${l.records_created}</td>
          <td style="text-align:center">${l.records_updated}</td>
          <td style="text-align:center;color:${l.records_failed>0?'var(--danger)':'inherit'}">${l.records_failed}</td>
          <td>${this.fmtDateTime(l.started_at)}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);font-size:12px">${e.message}</p>`;
    }
  },

  // `pdfOption` adds an "Attach as PDF" checkbox (quotations, invoices, POs, GRNs —
  // see documentEmailContent in routes/email.js); onSend then gets
  // { as_pdf } as its second argument. The last choice is remembered per
  // browser, since a store tends to settle on one or the other.
  showEmailModal(title, defaultEmail, onSend, { pdfOption = false } = {}) {
    let pdfDefault = false;
    try { pdfDefault = localStorage.getItem('pos_email_as_pdf') === '1'; } catch(e) {}
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header"><span class="modal-title">${title}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group">
            <label>Recipient Email *</label>
            <input type="email" id="email-to" value="${defaultEmail||''}" placeholder="customer@example.com">
          </div>
          ${pdfOption ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="email-as-pdf" ${pdfDefault ? 'checked' : ''} style="width:16px;height:16px;margin:0">
            Attach as PDF <span style="color:var(--text-muted);font-size:12px">(instead of in the email body)</span>
          </label>` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="email-send-btn">Send</button>
        </div>
      </div>`);
    document.getElementById('email-send-btn').addEventListener('click', () => {
      const to = document.getElementById('email-to').value.trim();
      if (!to || !to.includes('@')) { this.alert('Please enter a valid email address', 'error'); return; }
      const as_pdf = !!document.getElementById('email-as-pdf')?.checked;
      if (pdfOption) { try { localStorage.setItem('pos_email_as_pdf', as_pdf ? '1' : '0'); } catch(e) {} }
      onSend(to, { as_pdf });
    });
  },

  emailReceipt(txId, customerEmail) {
    this.showEmailModal('Email Receipt', customerEmail, async (to, { as_pdf }) => {
      this.closeModal();
      try {
        const r = await this.api('POST', `/email/send-receipt/${txId}`, { to, as_pdf });
        this.alert(r.message || `Receipt sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    }, { pdfOption: true });
  },

  emailRentalInvoice(agreementId, customerEmail) {
    this.showEmailModal('Email Rental Agreement', customerEmail, async (to, { as_pdf }) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-rental-invoice/${agreementId}`, { to, as_pdf });
        this.alert(`Rental agreement sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    }, { pdfOption: true });
  },

  emailQuote(quoteId, customerEmail) {
    this.showEmailModal('Email Quotation', customerEmail, async (to, { as_pdf }) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-quote/${quoteId}`, { to, as_pdf });
        this.alert(`Quotation sent to ${to}`);
        this.renderQuotations();
      } catch(e) { this.alert(e.message, 'error'); }
    }, { pdfOption: true });
  },

  emailGRN(poId, supplierEmail) {
    this.showEmailModal('Email Goods Received Note', supplierEmail, async (to, { as_pdf }) => {
      this.closeModal();
      try {
        await this.api('POST', `/email/send-grn/${poId}`, { to, as_pdf });
        this.alert(`Goods received note sent to ${to}`);
      } catch(e) { this.alert(e.message, 'error'); }
    }, { pdfOption: true });
  },

  // Units of measure list (routes/units.js). Opened over the product form
  // (fromForm) as a secondary modal so the form underneath isn't lost; its
  // unit dropdowns are refreshed when this closes.
  async showUnitsManager(fromForm = false) {
    const uoms = await this.api('GET', '/units');
    this._uoms = uoms;
    const canManage = this.can('inventory_units') || this.can('settings');
    const row = u => `<tr style="border-top:1px solid var(--border);${u.active ? '' : 'opacity:.55'}">
      <td style="padding:6px 10px"><input id="uom-name-${u.id}" value="${this.escapeAttr(u.name)}" style="width:100%" ${canManage ? '' : 'disabled'}></td>
      <td style="padding:6px 10px"><input id="uom-abbr-${u.id}" value="${this.escapeAttr(u.abbreviation || '')}" style="width:70px" ${canManage ? '' : 'disabled'}></td>
      <td style="padding:6px 10px;text-align:center"><input type="checkbox" id="uom-dec-${u.id}" ${u.allow_decimal ? 'checked' : ''} ${canManage ? '' : 'disabled'} style="width:auto"></td>
      <td style="padding:6px 10px;text-align:center"><input type="checkbox" id="uom-active-${u.id}" ${u.active ? 'checked' : ''} ${canManage ? '' : 'disabled'} style="width:auto"></td>
      <td style="padding:6px 10px;text-align:center;font-size:13px">${u.product_count}</td>
      <td style="padding:6px 10px;text-align:right;white-space:nowrap">${canManage ? `<button class="btn btn-secondary btn-sm" onclick="App._saveUnit(${u.id},${fromForm})">Save</button>${u.product_count ? '' : ` <button class="btn btn-danger btn-sm" onclick="App._deleteUnit(${u.id},${fromForm})">✕</button>`}` : ''}</td>
    </tr>`;
    const html = `
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Units of Measure</span><button class="modal-close" onclick="App._closeUnitsManager(${fromForm})">✕</button></div>
        <div class="modal-body" style="padding:0">
          <p style="font-size:12px;color:var(--text-muted);margin:10px 16px">Units an item can be stocked, sold or ordered in. Tick <strong>Decimals</strong> for measures sold in part quantities (2.5 yards, 1.25 kg). An inactive unit stays on items already using it but isn't offered for new ones.</p>
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--bg-secondary)"><th style="padding:8px 10px;text-align:left;font-size:13px">Name</th><th style="padding:8px 10px;text-align:left;font-size:13px">Abbrev.</th><th style="padding:8px 10px;font-size:13px">Decimals</th><th style="padding:8px 10px;font-size:13px">Active</th><th style="padding:8px 10px;font-size:13px">Items</th><th></th></tr></thead>
            <tbody>${uoms.map(row).join('')}
              ${canManage ? `<tr style="border-top:2px solid var(--border)">
                <td style="padding:6px 10px"><input id="uom-name-new" placeholder="New unit, e.g. Yard" style="width:100%"></td>
                <td style="padding:6px 10px"><input id="uom-abbr-new" placeholder="yd" style="width:70px"></td>
                <td style="padding:6px 10px;text-align:center"><input type="checkbox" id="uom-dec-new" style="width:auto"></td>
                <td></td><td></td>
                <td style="padding:6px 10px;text-align:right"><button class="btn btn-primary btn-sm" onclick="App._saveUnit(null,${fromForm})">+ Add</button></td>
              </tr>` : ''}
            </tbody>
          </table></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App._closeUnitsManager(${fromForm})">Close</button></div>
      </div>`;
    if (fromForm) this.showSecondaryModal(html); else this.showModal(html);
  },

  async _saveUnit(id, fromForm) {
    const k = id || 'new';
    const data = {
      name: document.getElementById(`uom-name-${k}`).value.trim(),
      abbreviation: document.getElementById(`uom-abbr-${k}`).value.trim(),
      allow_decimal: document.getElementById(`uom-dec-${k}`).checked ? 1 : 0,
      active: id ? (document.getElementById(`uom-active-${k}`).checked ? 1 : 0) : 1,
    };
    if (!data.name) { this.alert('Enter the unit name', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/units/${id}`, data);
      else await this.api('POST', '/units', data);
      this.alert('Unit saved');
      this.showUnitsManager(fromForm);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async _deleteUnit(id, fromForm) {
    try { await this.api('DELETE', `/units/${id}`); this.showUnitsManager(fromForm); }
    catch(e) { this.alert(e.message, 'error'); }
  },

  // Back on the product form: rebuild its unit dropdowns from the updated
  // list, keeping whatever was already chosen.
  _closeUnitsManager(fromForm) {
    if (!fromForm) { this.closeModal(); return; }
    this.closeSecondaryModal();
    const base = document.getElementById('pf-base-unit');
    if (!base) return;
    const uoms = (this._uoms || []).filter(u => u.active);
    const keep = base.value;
    base.innerHTML = `<option value="">Each</option>` + uoms.filter(u => u.name.toLowerCase() !== 'each').map(u => `<option value="${u.id}">${this.escapeAttr(u.name)}</option>`).join('');
    base.value = keep;
    document.querySelectorAll('#pf-unit-rows .pf-unit-id').forEach(sel => {
      const v = sel.value;
      sel.innerHTML = `<option value="">Unit…</option>` + uoms.map(u => `<option value="${u.id}">${this.escapeAttr(u.name)}</option>`).join('');
      sel.value = v;
    });
    this._pfRefreshUnitLabels();
  },

  async showCategoriesManager() {
    const categories = await this.api('GET', '/categories');
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">Product Categories</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="padding:0">
          <div style="padding:12px 16px;border-bottom:1px solid var(--border,#e5e7eb);display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" onclick="App.showCategoryForm(null,null,null,true)">+ Add Category</button>
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--bg-secondary,#f9fafb)"><th style="padding:8px 16px;text-align:left;font-size:13px">Name</th><th style="padding:8px 16px;text-align:left;font-size:13px">Description</th><th style="padding:8px 16px;text-align:center;font-size:13px">Products</th><th style="padding:8px 16px"></th></tr></thead>
            <tbody>
              ${categories.length ? categories.map(c => `<tr style="border-top:1px solid var(--border,#e5e7eb)">
                <td style="padding:10px 16px;font-weight:600">${c.name}</td>
                <td style="padding:10px 16px;color:var(--text-secondary,#6b7280);font-size:13px">${c.description || '—'}</td>
                <td style="padding:10px 16px;text-align:center;font-size:13px">${c.product_count}</td>
                <td style="padding:10px 16px;text-align:right">
                  <button class="btn btn-secondary btn-sm" onclick="App.showCategoryForm(${c.id},'${this.escapeAttr(c.name).replace(/'/g,"\\'")}','${this.escapeAttr(c.description).replace(/'/g,"\\'")}',true)">Edit</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--text-secondary,#6b7280)">No categories yet</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  showCategoryForm(id, name = '', desc = '', fromInventory = false) {
    this.showModal(`
      <div class="modal" style="max-width:380px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit Category' : 'Add Category'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Name *</label><input id="catf-name" value="${this.escapeAttr(name)}"></div>
          <div class="form-group"><label>Description</label><input id="catf-desc" value="${this.escapeAttr(desc)}"></div>
        </div>
        <div class="modal-footer">
          ${id ? `<button class="btn btn-danger" onclick="App.deleteCategory(${id},${fromInventory})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="${fromInventory ? 'App.showCategoriesManager()' : 'App.closeModal()'}">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveCategory(${id||'null'},${fromInventory})">Save</button>
        </div>
      </div>`);
  },

  async saveCategory(id, fromInventory = false) {
    const data = { name: document.getElementById('catf-name').value.trim(), description: document.getElementById('catf-desc').value.trim() };
    if (!data.name) { this.alert('Name required', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/categories/${id}`, data);
      else await this.api('POST', '/categories', data);
      this.alert('Category saved');
      if (fromInventory) { this.showCategoriesManager(); this.renderInventory(); }
      else { this.closeModal(); this.renderSettings(); }
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteCategory(id, fromInventory = false) {
    try {
      await this.api('DELETE', `/categories/${id}`);
      this.alert('Category deleted');
      if (fromInventory) { this.showCategoriesManager(); this.renderInventory(); }
      else { this.closeModal(); this.renderSettings(); }
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Brands ───────────────────────────────────────────────────────────
  // Mirrors the Categories manager above — a managed picklist behind the
  // Inventory "Brands" button, the product form's Brand dropdown, and the
  // WooCommerce brand sync (routes/woocommerce.js ensureWcBrands).

  async showBrandsManager() {
    const brands = await this.api('GET', '/brands');
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">Product Brands</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="padding:0">
          <div style="padding:12px 16px;border-bottom:1px solid var(--border,#e5e7eb);display:flex;justify-content:flex-end">
            <button class="btn btn-primary btn-sm" onclick="App.showBrandForm(null,null,null)">+ Add Brand</button>
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--bg-secondary,#f9fafb)"><th style="padding:8px 16px;text-align:left;font-size:13px">Name</th><th style="padding:8px 16px;text-align:left;font-size:13px">Description</th><th style="padding:8px 16px;text-align:center;font-size:13px">Products</th><th style="padding:8px 16px"></th></tr></thead>
            <tbody>
              ${brands.length ? brands.map(b => `<tr style="border-top:1px solid var(--border,#e5e7eb)">
                <td style="padding:10px 16px;font-weight:600">${b.name}</td>
                <td style="padding:10px 16px;color:var(--text-secondary,#6b7280);font-size:13px">${b.description || '—'}</td>
                <td style="padding:10px 16px;text-align:center;font-size:13px">${b.product_count}</td>
                <td style="padding:10px 16px;text-align:right">
                  <button class="btn btn-secondary btn-sm" onclick="App.showBrandForm(${b.id},'${this.escapeAttr(b.name).replace(/'/g,"\\'")}','${this.escapeAttr(b.description).replace(/'/g,"\\'")}')">Edit</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--text-secondary,#6b7280)">No brands yet</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  showBrandForm(id, name = '', desc = '') {
    this.showModal(`
      <div class="modal" style="max-width:380px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit Brand' : 'Add Brand'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Name *</label><input id="brandf-name" value="${this.escapeAttr(name)}"></div>
          <div class="form-group"><label>Description</label><input id="brandf-desc" value="${this.escapeAttr(desc)}"></div>
        </div>
        <div class="modal-footer">
          ${id ? `<button class="btn btn-danger" onclick="App.deleteBrand(${id})">Delete</button>` : ''}
          <button class="btn btn-secondary" onclick="App.showBrandsManager()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveBrand(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveBrand(id) {
    const data = { name: document.getElementById('brandf-name').value.trim(), description: document.getElementById('brandf-desc').value.trim() };
    if (!data.name) { this.alert('Name required', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/brands/${id}`, data);
      else await this.api('POST', '/brands', data);
      this.alert('Brand saved');
      this.showBrandsManager();
      this.renderInventory();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteBrand(id) {
    try {
      await this.api('DELETE', `/brands/${id}`);
      this.alert('Brand deleted');
      this.showBrandsManager();
      this.renderInventory();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Customer Categories ──────────────────────────────────
  async showCustomerCategoryForm(id) {
    let t = { discount_percent: 0, active: 1 };
    if (id) t = (await this.api('GET', '/customer-categories')).find(x => x.id === id) || t;
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">${id ? 'Edit' : 'New'} Customer Category</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>Name *</label><input id="cc-name" value="${t.name||''}" placeholder="e.g. Contractor"></div>
          <div class="form-group"><label>Discount %</label><input type="number" id="cc-percent" value="${t.discount_percent}" min="0" max="100" step="0.01"></div>
          <div class="form-group"><label style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="cc-active" ${t.active ? 'checked' : ''} style="width:auto"> Active
          </label></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveCustomerCategory(${id||'null'})">Save</button>
        </div>
      </div>`);
  },

  async saveCustomerCategory(id) {
    const name = document.getElementById('cc-name').value.trim();
    const discount_percent = parseFloat(document.getElementById('cc-percent').value) || 0;
    const active = document.getElementById('cc-active').checked;
    if (!name) { this.alert('Name is required', 'error'); return; }
    try {
      if (id) await this.api('PUT', `/customer-categories/${id}`, { name, discount_percent, active });
      else await this.api('POST', '/customer-categories', { name, discount_percent, active });
      this.closeModal();
      this.alert(id ? 'Category updated' : 'Category created');
      this.renderSettings();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteCustomerCategory(id) {
    if (!confirm('Delete this customer category?')) return;
    try {
      await this.api('DELETE', `/customer-categories/${id}`);
      this.alert('Category deleted');
      this.renderSettings();
    } catch(e) { this.alert(e.message, 'error'); }
  },

});
