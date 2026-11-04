// Inventory CSV import/export, import history and column mapping, label printing.
Object.assign(App, {
  // ─── CSV Import / Export ──────────────────────────────────
  async importProductsCsv(inputEl) {
    const file = inputEl.files[0];
    inputEl.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await this._readImportFile(file); } catch (e) { this.alert(e.message, 'error'); return; }
    const { headers, rows: rawRows } = parsed;
    if (!rawRows.length) { this.alert('No data rows found in CSV', 'error'); return; }

    const mapping = await this._showFieldMappingModal({ title: 'Map Import Columns', headers, fields: this._productImportFields });
    if (!mapping) return;
    const rows = this._remapCsvRows(rawRows, mapping);

    const choice = await this._askImportExistingSkuMode();
    if (choice === null) return; // dismissed without choosing
    const { skipExisting, branchId } = choice;

    // Opened before the row-chunks start so every chunk's outcomes log under
    // one batch id — that id is what makes this import reviewable and
    // reversible afterward (Import History button).
    const { id: batchId } = await this.api('POST', '/product-imports');

    await this._runBatchedCsvImport({
      rows, endpoint: '/products/import', title: 'Importing Products',
      extraBody: { skip_existing: skipExisting, batch_id: batchId, branch_id: branchId },
      onFinish: async () => {
        await this.api('PATCH', `/product-imports/${batchId}/finish`).catch(() => {});
        this.renderInventory();
        this.showImportBatchDetail(batchId);
      },
    });
  },

  // Re-importing a stock list often re-sends SKUs that are already in the
  // system unchanged — asks up front whether those rows should overwrite the
  // existing product (the historical default) or be left untouched and just
  // counted, so a re-import doesn't have to be all-or-nothing. Also asks
  // which branch (if any) the imported quantities should be assigned to —
  // a plain import only ever sets the overall stock level (see Bulk Assign
  // to Branch above), so picking one here sets that branch's stock too,
  // in the same pass, instead of needing a separate bulk-assign afterward.
  async _askImportExistingSkuMode() {
    const branches = await this.api('GET', '/branches');
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:420px">
          <div class="modal-header"><span class="modal-title">Import Options</span></div>
          <div class="modal-body">
            <div class="form-group">
              <label>Assign imported stock to branch</label>
              <select id="import-branch">
                <option value="">Don't assign — "All Branches" total only</option>
                ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
              </select>
              <p style="font-size:12px;color:var(--text-muted);margin-top:4px">Sets each row's stock at that branch too, not just the overall total — otherwise every branch-filtered view (and POS with a branch selected) shows 0 for everything just imported.</p>
            </div>
            <p style="font-size:13px;color:var(--text-muted)">This file may contain SKUs already in the system. What should happen to those rows?</p>
          </div>
          <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
            <button class="btn btn-secondary btn-sm" id="import-skumode-cancel">Cancel</button>
            <button class="btn btn-secondary btn-sm" id="import-skumode-skip">Skip existing SKUs</button>
            <button class="btn btn-primary btn-sm" id="import-skumode-update">Update existing SKUs</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const finish = skipExisting => {
        if (skipExisting === null) { overlay.remove(); resolve(null); return; }
        const branchId = overlay.querySelector('#import-branch').value || null;
        overlay.remove();
        resolve({ skipExisting, branchId });
      };
      overlay.querySelector('#import-skumode-cancel').addEventListener('click', () => finish(null));
      overlay.querySelector('#import-skumode-skip').addEventListener('click', () => finish(true));
      overlay.querySelector('#import-skumode-update').addEventListener('click', () => finish(false));
    });
  },

  // ─── Import History / Review / Reverse ──────────────────────────────
  async showImportHistory() {
    const batches = await this.api('GET', '/product-imports');
    const fmtDate = d => d ? this._toDate(d).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZone: this._storeTz() }) : '—';
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">Import History</span><button class="modal-close">✕</button></div>
        <div class="modal-body" style="padding:0">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--bg-secondary,#f9fafb)">
              <th style="padding:8px 12px;text-align:left;font-size:12px">Started</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">By</th>
              <th style="padding:8px 12px;text-align:center;font-size:12px">Created</th>
              <th style="padding:8px 12px;text-align:center;font-size:12px">Updated</th>
              <th style="padding:8px 12px;text-align:center;font-size:12px">Skipped</th>
              <th style="padding:8px 12px;text-align:center;font-size:12px">Errors</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px">Status</th>
              <th style="padding:8px 12px"></th>
            </tr></thead>
            <tbody>
              ${batches.length ? batches.map(b => `<tr style="border-top:1px solid var(--border,#e5e7eb)">
                <td style="padding:8px 12px;font-size:12px;white-space:nowrap">${fmtDate(b.started_at)}</td>
                <td style="padding:8px 12px;font-size:12px">${b.employee_name || '—'}</td>
                <td style="padding:8px 12px;text-align:center;font-size:12px">${b.created_count || 0}</td>
                <td style="padding:8px 12px;text-align:center;font-size:12px">${b.updated_count || 0}</td>
                <td style="padding:8px 12px;text-align:center;font-size:12px">${b.skipped_count || 0}</td>
                <td style="padding:8px 12px;text-align:center;font-size:12px;${b.error_count ? 'color:var(--danger);font-weight:600' : ''}">${b.error_count || 0}</td>
                <td style="padding:8px 12px;font-size:12px"><span class="badge-pill ${b.status==='reversed'?'badge-danger':b.status==='completed'?'badge-success':'badge-warning'}">${b.status}</span></td>
                <td style="padding:8px 12px;text-align:right;white-space:nowrap"><button class="btn btn-secondary btn-sm" onclick="App.showImportBatchDetail(${b.id})">Review</button></td>
              </tr>`).join('') : '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text-muted)">No imports logged yet</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
  },

  async showImportBatchDetail(batchId) {
    const { batch, counts, issue_count, issues } = await this.api('GET', `/product-imports/${batchId}`);
    const fmtDate = d => d ? this._toDate(d).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZone: this._storeTz() }) : '—';
    const c = counts || {};
    const canReverse = batch.status !== 'reversed';
    this.showModal(`
      <div class="modal" style="max-width:640px">
        <div class="modal-header"><span class="modal-title">Import #${batch.id} Review</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
            Started ${fmtDate(batch.started_at)} by ${batch.employee_name || 'unknown'}
            ${batch.status === 'reversed' ? ` · reversed ${fmtDate(batch.reversed_at)}` : ''}
          </p>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700">${c.created||0}</div><div style="font-size:11px;color:var(--text-muted)">Created</div></div>
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700">${c.updated||0}</div><div style="font-size:11px;color:var(--text-muted)">Updated</div></div>
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700">${c.skipped||0}</div><div style="font-size:11px;color:var(--text-muted)">Skipped</div></div>
            <div class="card" style="padding:10px;text-align:center"><div style="font-size:20px;font-weight:700;${c.error?'color:var(--danger)':''}">${c.error||0}</div><div style="font-size:11px;color:var(--text-muted)">Errors</div></div>
          </div>
          <div style="padding:12px;border:1px solid var(--border,#e5e7eb);border-radius:6px;margin-bottom:12px">
            <div style="font-weight:600;font-size:13px;margin-bottom:4px">${issue_count} product(s) with missing/questionable data</div>
            <div style="font-size:12px;color:var(--text-muted)">$0 price, negative stock, or no category/supplier/barcode among the rows this import touched.</div>
            ${issue_count ? `<div style="margin-top:8px;max-height:160px;overflow-y:auto;font-size:12px">
              ${issues.slice(0,25).map(i => `<div style="padding:3px 0;border-top:1px solid var(--border,#e5e7eb)">${i.sku} — ${i.name} <span style="color:var(--text-muted)">(${i.issue})</span></div>`).join('')}
              ${issues.length > 25 ? `<div style="padding:4px 0;color:var(--text-muted)">…and ${issues.length - 25} more, see the export</div>` : ''}
            </div>` : ''}
          </div>
        </div>
        <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
          <button class="btn btn-secondary" onclick="App.showImportHistory()">Back</button>
          ${issue_count ? `<a class="btn btn-secondary" href="/api/product-imports/${batch.id}/export-issues" download>Export Issues CSV</a>` : ''}
          ${canReverse ? `<button class="btn btn-danger" onclick="App.reverseImportBatch(${batch.id})">Reverse This Import</button>` : ''}
        </div>
      </div>`);
  },

  async reverseImportBatch(batchId) {
    if (!confirm('Reverse this import? Newly created products will be permanently deleted (unless already sold/ordered/counted elsewhere, which are left alone and reported), and updated products will be restored to their prior values. This cannot be undone.')) return;
    try {
      const result = await this.api('POST', `/product-imports/${batchId}/reverse`);
      let msg = `Reversed: ${result.deleted} product(s) deleted, ${result.restored} restored.`;
      if (result.kept.length) {
        msg += `\n\n${result.kept.length} kept because they're already in use elsewhere:\n` +
          result.kept.map(k => `${k.sku} (${k.reasons.join(', ')})`).join('\n');
      }
      this.alert(msg, result.kept.length ? 'warning' : 'success');
      this.renderInventory();
      this.showImportBatchDetail(batchId);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // Shared by importProductsCsv and importRentalItemsCsv — splits rows into
  // batches, POSTs each in turn against `endpoint`, and updates a progress
  // bar/status modal as batches complete. Each batch is its own committed API
  // call, so Cancel can only stop the *next* batch from starting — whatever
  // already posted stays imported, which is why the final message reports it
  // as a partial count rather than pretending nothing happened.
  //
  // Built by hand rather than via this.showModal(): that helper's overlay
  // dismisses on a backdrop click, which would let someone think they'd
  // stopped the import while it kept posting batches invisibly in the
  // background. Cancel is deliberately the only way out here.
  // actionVerb/actionVerbPast/itemLabel default to the original CSV-import
  // wording ("Import"/"Imported"/"row(s)") — override them for a batched
  // operation that isn't a CSV import (e.g. Bulk Assign to Branch passes
  // 'Assignment'/'Assigned'/'product(s)') so the status text and final alert
  // read naturally instead of talking about "rows" that were never a CSV.
  async _runBatchedCsvImport({ rows, endpoint, title, extraBody, onFinish, summarize, actionVerb = 'Import', actionVerbPast = 'Imported', itemLabel = 'row(s)' }) {
    const BATCH_SIZE = 25;
    const batches = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));

    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">${title}</span></div>
        <div class="modal-body">
          <p id="csv-import-status" style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Starting ${actionVerb.toLowerCase()} of ${rows.length} ${itemLabel}…</p>
          <div style="background:var(--border);border-radius:6px;overflow:hidden;height:10px">
            <div id="csv-import-bar" style="background:var(--primary);height:100%;width:0%;transition:width .2s"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary btn-sm" id="csv-import-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let cancelled = false;
    overlay.querySelector('#csv-import-cancel').addEventListener('click', () => {
      cancelled = true;
      const btn = overlay.querySelector('#csv-import-cancel');
      btn.disabled = true;
      btn.textContent = 'Cancelling…';
    });

    // Totals are summed generically from whatever numeric fields each
    // endpoint's response happens to carry (created/updated/skipped/...) so
    // this stays shared across products, rentals, and customers even though
    // their per-row outcome shapes differ — a caller that cares how its
    // counts read passes `summarize`; otherwise the created/updated/skipped
    // wording below (the original product-import phrasing) is used as-is.
    let processed = 0;
    const totals = {};
    const errors = [];
    for (const batch of batches) {
      if (cancelled) break;
      try {
        const result = await this.api('POST', endpoint, { rows: batch, ...extraBody });
        for (const key of Object.keys(result)) {
          if (typeof result[key] === 'number') totals[key] = (totals[key] || 0) + result[key];
        }
        errors.push(...(result.errors || []));
      } catch (e) {
        errors.push(e.message);
      }
      processed += batch.length;
      const pct = Math.round((processed / rows.length) * 100);
      const bar = overlay.querySelector('#csv-import-bar');
      const status = overlay.querySelector('#csv-import-status');
      if (bar) bar.style.width = pct + '%';
      if (status) status.textContent = `${actionVerbPast} ${processed} of ${rows.length} ${itemLabel} (${pct}%)`;
    }

    overlay.remove();
    const counts = summarize ? summarize(totals) : `${totals.created||0} created, ${totals.updated||0} updated${totals.skipped ? `, ${totals.skipped} skipped (already existed)` : ''}`;
    let msg = cancelled
      ? `${actionVerb} cancelled after ${processed} of ${rows.length} ${itemLabel}: ${counts}`
      : `${actionVerb} complete: ${counts}`;
    if (errors.length) msg += `\n${errors.length} error(s):\n${errors.join('\n')}`;
    this.alert(msg, errors.length ? 'error' : (cancelled ? 'warning' : 'success'));
    if (onFinish) onFinish();
  },

  _cancelCsvImport() {
    this._csvImportCancelled = true;
    const btn = document.getElementById('csv-import-cancel');
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
  },

  // Reads an import file picked by the user into the same { headers, rows }
  // shape _parseCsv returns. Excel workbooks (.xlsx, and legacy .xls, which
  // is what many older systems export) are detected by their file signature
  // rather than the extension and read with SheetJS, loaded on first use;
  // the first sheet is imported. Text files are decoded by BOM (UTF-8,
  // UTF-16 LE/BE), falling back to UTF-16 when the bytes are NUL-interleaved
  // and to Windows-1252 when they aren't valid UTF-8.
  async _readImportFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const isXlsx = buf[0] === 0x50 && buf[1] === 0x4B;
    const isXls = buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0;
    if (isXlsx || isXls) {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
          el.onload = resolve;
          el.onerror = () => reject(new Error('Could not load the Excel reader. Check your internet connection, or save the file as CSV and try again.'));
          document.head.appendChild(el);
        });
      }
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
      if (grid.length < 2) return { headers: [], rows: [] };
      const headers = grid[0].map(h => String(h).trim());
      const rows = grid.slice(1).filter(r => r.some(v => String(v).trim())).map(r =>
        Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
      return { headers, rows };
    }
    let encoding = 'utf-8';
    if (buf[0] === 0xFF && buf[1] === 0xFE) encoding = 'utf-16le';
    else if (buf[0] === 0xFE && buf[1] === 0xFF) encoding = 'utf-16be';
    else if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) encoding = 'utf-16le';
    else if (buf.length > 3 && buf[0] === 0 && buf[2] === 0) encoding = 'utf-16be';
    let text;
    try { text = new TextDecoder(encoding, { fatal: encoding === 'utf-8' }).decode(buf); }
    catch { text = new TextDecoder('windows-1252').decode(buf); }
    return this._parseCsv(text.replace(/^\uFEFF/, ''));
  },

  // Returns { headers, rows } — headers is the raw column order from the
  // file (used by _showFieldMappingModal to build the mapping UI), rows are
  // keyed by those same raw header strings (not yet mapped to backend field
  // names — see _remapCsvRows).
  // The separator is sniffed from the header line (comma, tab, or
  // semicolon), since Excel "Text"/"Unicode Text" saves and older POS
  // exports are tab-separated.
  _parseCsv(text) {
    const lines = this._splitCsvRecords(text.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const count = ch => lines[0].split(ch).length - 1;
    const delim = ['\t', ';', ','].reduce((best, ch) => count(ch) > count(best) ? ch : best, ',');
    const headers = this._parseCsvLine(lines[0], delim).map(h => h.trim());
    const rows = lines.slice(1).filter(l => l.trim()).map(line => {
      const vals = this._parseCsvLine(line, delim);
      return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').trim()]));
    });
    return { headers, rows };
  },

  // Splits CSV text into records on line breaks that fall OUTSIDE quoted
  // cells, so a multi-line value (e.g. a Detailed Description, which our own
  // exports write as one quoted cell) stays in its row. Doubled "" escapes
  // toggle the quote state twice, so they net out correctly.
  _splitCsvRecords(text) {
    const records = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') inQuote = !inQuote;
      if (ch === '\n' && !inQuote) { records.push(cur.replace(/\r$/, '')); cur = ''; continue; }
      if (ch === '\r' && inQuote && text[i + 1] === '\n') continue;
      cur += ch;
    }
    records.push(cur.replace(/\r$/, ''));
    return records;
  },

  // ─── Import Column Mapping ────────────────────────────────
  // Field definitions for the three CSV imports that now go through a
  // mapping step — key must match exactly what the corresponding backend
  // /import endpoint destructures off each row (routes/products.js POST
  // /import and /import/rentals, routes/customers.js POST /import).
  _productImportFields: [
    { key: 'sku',            label: 'SKU',              required: true },
    { key: 'barcode',        label: 'Barcode' },
    { key: 'name',           label: 'Name',             required: true },
    { key: 'description',    label: 'Description' },
    { key: 'long_description', label: 'Detailed Description (website)', aliases: ['Detailed Description', 'Long Description', 'Web Description'] },
    { key: 'category_name',  label: 'Category' },
    { key: 'price',          label: 'Price' },
    { key: 'cost',           label: 'Cost' },
    { key: 'tax_rate',       label: 'Tax Rate (%)' },
    { key: 'stock_qty',      label: 'Stock Qty' },
    { key: 'min_stock',      label: 'Min Stock' },
    { key: 'active',         label: 'Active (1/0)' },
    { key: 'supplier_name',  label: 'Supplier' },
  ],
  _serviceImportFields: [
    { key: 'sku',           label: 'SKU',          required: true },
    { key: 'name',          label: 'Name',         required: true },
    { key: 'description',   label: 'Description' },
    { key: 'category_name', label: 'Category' },
    { key: 'unit',          label: 'Unit / Billing Type' },
    { key: 'price',         label: 'Price' },
    { key: 'cost',          label: 'Cost' },
    { key: 'tax_rate',      label: 'Tax Rate (%)' },
    { key: 'active',        label: 'Active (1/0)' },
  ],
  _rentalImportFields: [
    { key: 'sku',                    label: 'SKU',        required: true },
    { key: 'name',                   label: 'Name',       required: true },
    { key: 'description',            label: 'Description' },
    { key: 'long_description',       label: 'Detailed Description (website)', aliases: ['Detailed Description', 'Long Description', 'Web Description'] },
    { key: 'model_number',           label: 'Model Number' },
    { key: 'size',                   label: 'Size' },
    { key: 'category_name',          label: 'Category' },
    { key: 'branch_name',            label: 'Branch' },
    { key: 'stock_qty',              label: 'Stock Qty' },
    { key: 'min_stock',              label: 'Min Stock' },
    { key: 'tax_rate',               label: 'Tax Rate (%)' },
    { key: 'taxable',                label: 'Taxable (1/0)' },
    { key: 'rental_classification',  label: 'Classification (tool/equipment)' },
    { key: 'daily_rate',             label: 'Daily Rate' },
    { key: 'weekly_rate',            label: 'Weekly Rate' },
    { key: 'monthly_rate',           label: 'Monthly Rate' },
    { key: 'hourly_rate',            label: 'Hourly Rate' },
    { key: 'replacement_value',      label: 'Replacement Value' },
    { key: 'is_accessory',           label: 'Is Accessory (1/0)' },
    { key: 'active',                 label: 'Active (1/0)' },
  ],
  _rentalAccessoryCountFields: [
    { key: 'accessory',   label: 'Accessory SKU or Name', required: true, aliases: ['SKU', 'Accessory', 'Accessory Name', 'Name', 'Item'] },
    { key: 'branch_name', label: 'Branch / Location', required: true, aliases: ['Branch', 'Location', 'Property', 'Store'] },
    { key: 'stock_qty',   label: 'Quantity', required: true, aliases: ['Qty', 'Count', 'Stock', 'Stock Qty', 'Quantity On Hand'] },
  ],
  _rentalAccessoryImportFields: [
    { key: 'name',   label: 'Accessory Name', required: true, aliases: ['Accessory', 'Name', 'Description'] },
    { key: 'active', label: 'Active (Yes/No, True/False, 1/0)', aliases: ['Is Active', 'Status'] },
  ],
  // First/Last Name aren't flagged required: a file of businesses can map
  // Business Name instead (checked by importCustomersCsv's mapping validate).
  _customerImportFields: [
    { key: 'first_name',            label: 'First Name (individuals)' },
    { key: 'last_name',             label: 'Last Name (individuals)' },
    { key: 'email',                 label: 'Email' },
    { key: 'phone',                 label: 'Phone' },
    { key: 'address',               label: 'Address' },
    { key: 'city',                  label: 'City' },
    { key: 'state',                 label: 'Parish', aliases: ['State', 'Parish / State'] },
    { key: 'zip',                   label: 'ZIP' },
    { key: 'customer_type',         label: 'Customer Type (cash/credit)' },
    { key: 'credit_terms_days',     label: 'Credit Terms (days)' },
    { key: 'credit_limit',          label: 'Credit Limit' },
    { key: 'tax_exempt',            label: 'Tax Exempt (1/0)' },
    { key: 'tax_exemption_number',  label: 'Tax Exemption #' },
    { key: 'customer_category_name', label: 'Category' },
    { key: 'notes',                 label: 'Notes' },
    { key: 'customer_kind',          label: 'Customer Type (Individual/Business)', aliases: ['Kind', 'Customer Kind', 'Individual or Business', 'Entity Type'], group: 'Business (optional)' },
    { key: 'business_name',          label: 'Business Name', aliases: ['Company', 'Company Name', 'Business', 'Organization', 'Organisation'], group: 'Business (optional)' },
    ...[1, 2, 3].flatMap(n => [
      { key: `contact${n}_name`,      label: `Contact ${n} Name`,      aliases: [`Contact ${n}`, `Contact Person ${n}`], group: 'Business (optional)' },
      { key: `contact${n}_job_title`, label: `Contact ${n} Job Title`, aliases: [`Contact ${n} Title`, `Contact ${n} Position`], group: 'Business (optional)' },
      { key: `contact${n}_phone`,     label: `Contact ${n} Phone`, group: 'Business (optional)' },
      { key: `contact${n}_email`,     label: `Contact ${n} Email`, group: 'Business (optional)' },
    ]),
    { key: 'is_rental_customer',              label: 'Rental Customer? (1/0)',      group: 'Rental Compliance (optional)' },
    { key: 'rental_id_type',                  label: 'Rental ID Type',              group: 'Rental Compliance (optional)' },
    { key: 'rental_id_number',                label: 'Rental ID Number',            group: 'Rental Compliance (optional)' },
    { key: 'rental_address_proof_type',       label: 'Address Proof Type',          group: 'Rental Compliance (optional)' },
    { key: 'rental_reference_name',           label: 'Reference 1 Name',            group: 'Rental Compliance (optional)' },
    { key: 'rental_reference_phone',          label: 'Reference 1 Phone',           group: 'Rental Compliance (optional)' },
    { key: 'rental_reference_relationship',   label: 'Reference 1 Relationship',    group: 'Rental Compliance (optional)' },
    { key: 'rental_reference_address',        label: 'Reference 1 Address',         group: 'Rental Compliance (optional)' },
    { key: 'rental_reference2_name',          label: 'Reference 2 Name',            group: 'Rental Compliance (optional)' },
    { key: 'rental_reference2_phone',         label: 'Reference 2 Phone',           group: 'Rental Compliance (optional)' },
    { key: 'rental_reference2_relationship',  label: 'Reference 2 Relationship',    group: 'Rental Compliance (optional)' },
    { key: 'rental_reference3_name',          label: 'Reference 3 Name',            group: 'Rental Compliance (optional)' },
    { key: 'rental_reference3_phone',         label: 'Reference 3 Phone',           group: 'Rental Compliance (optional)' },
    { key: 'rental_reference3_relationship',  label: 'Reference 3 Relationship',    group: 'Rental Compliance (optional)' },
    { key: 'rental_preapproved',              label: 'Preapproved (1/0) — bypasses missing-info check', group: 'Rental Compliance (optional)' },
  ],

  // One target per column of the previous system's vendor screen (header +
  // Main / Address / Contacts tabs); aliases are its on-screen labels and
  // likely export column names, so its export auto-maps.
  _supplierImportFields: [
    { key: 'supplier_number',  label: 'Vendor Number',   aliases: ['Vendor number', 'Vendor #', 'Vendor No', 'VEND_NO'], group: 'Vendor' },
    { key: 'name',             label: 'Name', required: true, aliases: ['Vendor Name', 'Company Name', 'NAM'], group: 'Vendor' },
    { key: 'name_type',        label: 'Name Type (Business/Person)', aliases: ['NAM_TYP'], group: 'Vendor' },
    { key: 'salutation',       label: 'Salutation',      aliases: ['SALUTATION'], group: 'Main' },
    { key: 'first_name',       label: 'First Name',      aliases: ['FST_NAM'], group: 'Main' },
    { key: 'last_name',        label: 'Last Name',       aliases: ['LST_NAM'], group: 'Main' },
    { key: 'category',         label: 'Category',        aliases: ['CATEG_COD'], group: 'Main' },
    { key: 'payment_terms',    label: 'Terms Code',      aliases: ['Terms', 'Payment Terms', 'TERMS_COD'], group: 'Main' },
    { key: 'ship_via',         label: 'Ship-via Code',   aliases: ['Ship via', 'SHIP_VIA_COD'], group: 'Main' },
    { key: 'sync_ap',          label: 'Sync with A/P (1/0)', aliases: ['Sync with AP'], group: 'Main' },
    { key: 'ap_vendor_number', label: 'A/P Vendor #',    aliases: ['AP vendor #', 'AP_VEND_NO'], group: 'Main' },
    { key: 'account_number',   label: "Vendor's Ref #",  aliases: ['Vendors ref #', 'VEND_REF_NO'], group: 'Main' },
    { key: 'voucher_default',  label: 'Voucher Default', aliases: ['VOUCH_DFLT'], group: 'Main' },
    { key: 'is_local',         label: 'Local Supplier (1/0)', group: 'Main' },
    { key: 'address',          label: 'Address 1',       aliases: ['Address', 'ADRS_1'], group: 'Address' },
    { key: 'address2',         label: 'Address 2',       aliases: ['ADRS_2'], group: 'Address' },
    { key: 'address3',         label: 'Address 3',       aliases: ['ADRS_3'], group: 'Address' },
    { key: 'city',             label: 'City',            group: 'Address' },
    { key: 'state',            label: 'State',           aliases: ['Parish', 'State / Parish'], group: 'Address' },
    { key: 'zip',              label: 'Zip Code',        aliases: ['ZIP', 'ZIP_COD'], group: 'Address' },
    { key: 'country',          label: 'Country',         aliases: ['CNTRY'], group: 'Address' },
    { key: 'comment1',         label: 'Comment 1',       aliases: ['COMMNT_1'], group: 'Address' },
    { key: 'comment2',         label: 'Comment 2',       aliases: ['COMMNT_2'], group: 'Address' },
    { key: 'comment3',         label: 'Comment 3',       aliases: ['COMMNT_3'], group: 'Address' },
    { key: 'notes',            label: 'Notes',           group: 'Address' },
    { key: 'contact_name',     label: 'Contact 1',       aliases: ['Contact', 'CONTCT_1'], group: 'Contacts' },
    { key: 'phone',            label: 'Phone 1',         aliases: ['Phone', 'PHONE_1'], group: 'Contacts' },
    { key: 'fax',              label: 'Fax 1',           aliases: ['Fax', 'FAX_1'], group: 'Contacts' },
    { key: 'email',            label: 'Email 1',         aliases: ['E-mail 1', 'Email', 'EMAIL_ADRS_1'], group: 'Contacts' },
    { key: 'website',          label: 'URL 1',           aliases: ['URL', 'Website', 'URL_1'], group: 'Contacts' },
    { key: 'contact2_name',    label: 'Contact 2',       aliases: ['CONTCT_2'], group: 'Contacts' },
    { key: 'phone2',           label: 'Phone 2',         aliases: ['PHONE_2'], group: 'Contacts' },
    { key: 'fax2',             label: 'Fax 2',           aliases: ['FAX_2'], group: 'Contacts' },
    { key: 'email2',           label: 'Email 2',         aliases: ['E-mail 2', 'EMAIL_ADRS_2'], group: 'Contacts' },
    { key: 'website2',         label: 'URL 2',           aliases: ['URL_2'], group: 'Contacts' },
    { key: 'report_email',     label: 'Receipt/Report E-mail (1/2)', aliases: ['Receipt/report e-mail'], group: 'Contacts' },
  ],

  // Shown once per CSV import, right after the file is parsed and before any
  // other import-options prompt (existing-SKU mode, duplicate mode, ...).
  // Lets the user match each of our target fields to whichever column in
  // their file actually holds that data — the file's own headers don't need
  // to match our field names at all. Auto-maps anything whose header, once
  // lowercased with spaces/punctuation stripped, matches the target field's
  // key or label the same way (so a re-import of our own template, or a
  // file that already uses matching headers, auto-fills every field and
  // just needs Continue). A field may also list `aliases` — other header
  // spellings it should auto-match (e.g. another system's export names).
  // Resolves to a { targetField: csvHeader } mapping, or null if the user
  // cancels.
  // `validate(mapping)` (optional) returns an error message for a mapping
  // that can't work beyond the per-field `required` flags.
  _showFieldMappingModal({ title, headers, fields, validate }) {
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normedHeaders = headers.map(h => ({ header: h, n: norm(h) }));
    const autoMap = {};
    for (const f of fields) {
      const hit = [f.key, f.label, ...(f.aliases || [])].map(norm).reduce((found, n) => found || normedHeaders.find(x => x.n === n), null);
      if (hit) autoMap[f.key] = hit.header;
    }
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const optionsHtml = fieldKey => `<option value="">— Not mapped —</option>` +
        headers.map(h => `<option value="${h.replace(/"/g,'&quot;')}" ${autoMap[fieldKey] === h ? 'selected' : ''}>${h}</option>`).join('');
      const rowHtml = f => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
          <label style="flex:0 0 200px;font-size:13px">${f.label}${f.required ? ' <span style="color:var(--danger)">*</span>' : ''}</label>
          <select data-field="${f.key}" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card);color:var(--text)">${optionsHtml(f.key)}</select>
        </div>`;
      let bodyHtml = '', currentGroup;
      for (const f of fields) {
        if (f.group !== currentGroup) {
          currentGroup = f.group;
          if (currentGroup) bodyHtml += `<div style="font-weight:600;font-size:12px;margin:14px 0 4px;color:var(--text-muted);text-transform:uppercase">${currentGroup}</div>`;
        }
        bodyHtml += rowHtml(f);
      }
      const unmappedCount = headers.length - new Set(Object.values(autoMap)).size;
      overlay.innerHTML = `
        <div class="modal" style="max-width:580px">
          <div class="modal-header"><span class="modal-title">${title}</span></div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Match each field below to the matching column in your file. Columns that already look like a match are pre-selected — double-check them and adjust anything wrong. Fields left "Not mapped" are skipped (default value used, if any).${unmappedCount > 0 ? ` ${unmappedCount} column(s) in your file weren't auto-matched to anything.` : ''}</p>
            <div style="max-height:420px;overflow-y:auto">${bodyHtml}</div>
          </div>
          <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
            <button class="btn btn-secondary btn-sm" id="fm-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="fm-continue">Continue</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const finish = mapping => { overlay.remove(); resolve(mapping); };
      overlay.querySelector('#fm-cancel').addEventListener('click', () => finish(null));
      overlay.querySelector('#fm-continue').addEventListener('click', () => {
        const mapping = {};
        overlay.querySelectorAll('select[data-field]').forEach(sel => { mapping[sel.dataset.field] = sel.value; });
        const missing = fields.filter(f => f.required && !mapping[f.key]);
        if (missing.length) { this.alert(`Please map required field(s): ${missing.map(f => f.label).join(', ')}`, 'error'); return; }
        const invalid = validate && validate(mapping);
        if (invalid) { this.alert(invalid, 'error'); return; }
        finish(mapping);
      });
    });
  },

  // Applies a { targetField: csvHeader } mapping (from _showFieldMappingModal)
  // to rows keyed by raw CSV headers (from _parseCsv), producing rows keyed
  // by the backend's expected field names — an unmapped target field is
  // simply absent from the output row, same as if the CSV never had that
  // column at all.
  _remapCsvRows(rows, mapping) {
    const entries = Object.entries(mapping).filter(([, header]) => header);
    return rows.map(row => Object.fromEntries(entries.map(([field, header]) => [field, row[header]])));
  },

  _parseCsvLine(line, delim = ',') {
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === delim && !inQuote) {
        result.push(cur); cur = '';
      } else { cur += ch; }
    }
    result.push(cur);
    return result;
  },

  // ─── Label Printing ───────────────────────────────────────
  _lpPrinters: {
    zebra:   { name: 'Zebra (Thermal)',   sizes: [
      { id: 'z2x1', name: '2" × 1"',            w: 192, h: 96  },
      { id: 'z3x2', name: '3" × 2"',            w: 288, h: 192 },
      { id: 'z4x2', name: '4" × 2"',            w: 384, h: 192 },
      { id: 'z4x3', name: '4" × 3"',            w: 384, h: 288 },
      { id: 'z4x6', name: '4" × 6" (Shipping)', w: 384, h: 576 },
    ]},
    brother: { name: 'Brother (Thermal)', sizes: [
      { id: 'b29x90',  name: '29mm × 90mm',  w: 110, h: 340 },
      { id: 'b38x90',  name: '38mm × 90mm',  w: 144, h: 340 },
      { id: 'b62x100', name: '62mm × 100mm', w: 236, h: 378 },
    ]},
    dymo:    { name: 'DYMO LabelWriter',  sizes: [
      { id: 'd30252', name: 'Address 1" × 2⅛"',   w: 204, h: 96  },
      { id: 'd30336', name: 'Large Addr 1" × 3½"', w: 336, h: 96  },
      { id: 'd99010', name: 'Shipping 2¼" × 4"',   w: 384, h: 216 },
    ]},
    generic: { name: 'Generic / Laser',   sizes: [
      { id: 'g5160', name: 'Avery 5160 (1" × 2⅝")', w: 252, h: 96  },
      { id: 'g5163', name: 'Avery 5163 (2" × 4")',   w: 384, h: 192 },
      { id: 'g3x5',  name: '3" × 5" Card',           w: 480, h: 288 },
    ]},
  },

  _lpFieldDefs: [
    { key: 'name',        label: 'Product Name' },
    { key: 'sku',         label: 'SKU' },
    { key: 'barcode',     label: 'Barcode' },
    { key: 'price',       label: 'Price' },
    { key: 'category',    label: 'Category' },
    { key: 'description', label: 'Description' },
  ],

  async showLabelPrint(id) {
    const p = await this.api('GET', `/products/${id}`);
    this._lpProduct = p;
    const saved = JSON.parse(localStorage.getItem('lpSettings') || '{}');
    const pt   = saved.printerType || 'zebra';
    const ls   = saved.labelSize   || 'z2x1';
    const qty  = saved.qty         || 1;
    const fs   = saved.fontSize    || 'medium';
    const flds = Object.assign({ name: true, sku: true, barcode: true, price: true, category: false, description: false }, saved.fields || {});
    const cw   = saved.customW || 50;
    const ch   = saved.customH || 25;
    const allKeys = this._lpFieldDefs.map(f => f.key);
    const fo   = (saved.fieldOrder || allKeys).filter(k => allKeys.includes(k));
    allKeys.forEach(k => { if (!fo.includes(k)) fo.push(k); });
    const fa   = Object.assign({ name:'left',sku:'left',barcode:'center',price:'left',category:'left',description:'left' }, saved.fieldAlign || {});
    const fva  = Object.assign({ name:'top',sku:'top',barcode:'top',price:'top',category:'top',description:'top' }, saved.fieldVAlign || {});

    this.showModal(`
      <div class="modal" style="max-width:820px">
        <div class="modal-header">
          <span class="modal-title">
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" style="vertical-align:-3px;margin-right:6px"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>
            Print Labels — ${p.name}
          </span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body" style="display:grid;grid-template-columns:265px 1fr;gap:20px">
          <div>
            <div class="form-group">
              <label>Printer Type</label>
              <select id="lp-printer" onchange="App._lpOnPrinterChange()">
                ${Object.entries(this._lpPrinters).map(([k,v]) => `<option value="${k}" ${pt===k?'selected':''}>${v.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Label Size / Type</label>
              <select id="lp-size" onchange="App._lpToggleCustomDims();App._lpUpdatePreview()"></select>
            </div>
            <div id="lp-custom-dims" style="display:none;margin-top:-6px;margin-bottom:12px">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Enter dimensions in millimetres</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div><label style="font-size:11px">Width (mm)</label><input type="number" id="lp-cw" value="${cw}" min="10" max="500" step="0.5" oninput="App._lpUpdatePreview()"></div>
                <div><label style="font-size:11px">Height (mm)</label><input type="number" id="lp-ch" value="${ch}" min="10" max="500" step="0.5" oninput="App._lpUpdatePreview()"></div>
              </div>
            </div>
            <div class="form-group">
              <label>Quantity</label>
              <input type="number" id="lp-qty" value="${qty}" min="1" max="500" oninput="App._lpUpdatePreview()">
            </div>
            <div style="border-top:1px solid var(--border);margin:14px 0"></div>
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:6px">Fields &amp; Layout</div>
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:6px;padding:0 5px">Reorder fields, toggle visibility, and set horizontal (H) / vertical (V) placement for each</div>
            <div id="lp-fields-container">
              ${fo.map(k => { const fld = this._lpFieldDefs.find(f => f.key === k); const lbl = fld ? fld.label : k;
                const hBtns = ['left','center','right'].map(a=>`<button class="lp-align-btn${fa[k]===a?' active':''}" data-align="${a}" id="lp-a-${k}-${a}" onclick="App._lpSetAlign('${k}','${a}')" title="Align ${a}">${a.charAt(0).toUpperCase()}</button>`).join('');
                const vBtns = ['top','middle','bottom'].map(v=>`<button class="lp-align-btn${fva[k]===v?' active':''}" data-valign="${v}" id="lp-v-${k}-${v}" onclick="App._lpSetVAlign('${k}','${v}')" title="Anchor ${v}">${v.charAt(0).toUpperCase()}</button>`).join('');
                return `<div class="lp-field-row" id="lp-row-${k}" data-key="${k}">
                  <div style="display:flex;align-items:center;gap:5px">
                    <div style="display:flex;flex-direction:column;gap:1px;flex-shrink:0"><button class="lp-move-btn" onclick="App._lpMoveField('${k}',-1)" title="Move up">▲</button><button class="lp-move-btn" onclick="App._lpMoveField('${k}',1)" title="Move down">▼</button></div>
                    <input type="checkbox" id="lp-f-${k}" ${flds[k]?'checked':''} style="width:auto;margin:0;flex-shrink:0" onchange="App._lpUpdatePreview()">
                    <span style="flex:1;font-size:12px;overflow:hidden;white-space:nowrap;color:var(--text)">${lbl}</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px;padding-left:21px">
                    <div style="display:flex;align-items:center;gap:2px"><span style="font-size:9px;color:var(--text-muted)">H</span>${hBtns}</div>
                    <div style="display:flex;align-items:center;gap:2px"><span style="font-size:9px;color:var(--text-muted)">V</span>${vBtns}</div>
                  </div>
                </div>`; }).join('')}
            </div>
            <div style="border-top:1px solid var(--border);margin:14px 0"></div>
            <div class="form-group">
              <label>Font Size</label>
              <select id="lp-fs" onchange="App._lpUpdatePreview()">
                <option value="small" ${fs==='small'?'selected':''}>Small</option>
                <option value="medium" ${fs==='medium'?'selected':''}>Medium</option>
                <option value="large" ${fs==='large'?'selected':''}>Large</option>
              </select>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;min-width:0">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:10px">Live Preview</div>
            <div id="lp-preview" style="background:#d0d0d0;border-radius:6px;padding:12px;flex:1;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;overflow:auto;min-height:120px;max-height:360px"></div>
            <div id="lp-info" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button id="lp-print-btn" class="btn btn-primary" onclick="App._lpDoPrint()">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>
            Print Labels
          </button>
        </div>
      </div>`);

    this._lpInitSizes(ls);
  },

  _lpOnPrinterChange() {
    const pt = document.getElementById('lp-printer').value;
    this._lpInitSizes(this._lpPrinters[pt].sizes[0].id);
  },

  _lpInitSizes(selectedId) {
    const pt = document.getElementById('lp-printer')?.value;
    if (!pt) return;
    const sel = document.getElementById('lp-size');
    sel.innerHTML = this._lpPrinters[pt].sizes.map(s =>
      `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${s.name}</option>`
    ).join('') + `<option value="custom" ${selectedId === 'custom' ? 'selected' : ''}>Custom…</option>`;
    this._lpToggleCustomDims();
    this._lpUpdatePreview();
  },

  _lpToggleCustomDims() {
    const sizeId = document.getElementById('lp-size')?.value;
    const el = document.getElementById('lp-custom-dims');
    if (el) el.style.display = sizeId === 'custom' ? '' : 'none';
  },

  _lpMoveField(key, dir) {
    const container = document.getElementById('lp-fields-container');
    if (!container) return;
    const row = document.getElementById(`lp-row-${key}`);
    if (!row) return;
    if (dir < 0 && row.previousElementSibling) container.insertBefore(row, row.previousElementSibling);
    else if (dir > 0 && row.nextElementSibling) container.insertBefore(row.nextElementSibling, row);
    this._lpUpdatePreview();
  },

  _lpSetAlign(key, align) {
    ['left','center','right'].forEach(a => {
      const btn = document.getElementById(`lp-a-${key}-${a}`);
      if (btn) btn.classList.toggle('active', a === align);
    });
    this._lpUpdatePreview();
  },

  _lpSetVAlign(key, valign) {
    ['top','middle','bottom'].forEach(v => {
      const btn = document.getElementById(`lp-v-${key}-${v}`);
      if (btn) btn.classList.toggle('active', v === valign);
    });
    this._lpUpdatePreview();
  },

  _lpGetCfg() {
    const pt = document.getElementById('lp-printer')?.value || 'zebra';
    const sizeId = document.getElementById('lp-size')?.value;
    let size;
    if (sizeId === 'custom') {
      const mmW = parseFloat(document.getElementById('lp-cw')?.value) || 50;
      const mmH = parseFloat(document.getElementById('lp-ch')?.value) || 25;
      const w = Math.round(mmW * 96 / 25.4);
      const h = Math.round(mmH * 96 / 25.4);
      size = { id: 'custom', name: `Custom (${mmW}×${mmH}mm)`, w, h };
    } else {
      size = (this._lpPrinters[pt]?.sizes || []).find(s => s.id === sizeId) || { id: sizeId, name: sizeId, w: 192, h: 96 };
    }
    const defOrder = ['name','sku','barcode','price','category','description'];
    const fieldOrder = [...document.querySelectorAll('#lp-fields-container .lp-field-row')].map(el => el.dataset.key).filter(Boolean);
    const order = fieldOrder.length ? fieldOrder : defOrder;
    const fields = {};
    const fieldAlign = {};
    const fieldVAlign = {};
    for (const k of order) {
      fields[k] = document.getElementById(`lp-f-${k}`)?.checked ?? false;
      const activeBtn = document.querySelector(`#lp-row-${k} .lp-align-btn[data-align].active`);
      fieldAlign[k] = activeBtn?.dataset.align || 'left';
      const activeVBtn = document.querySelector(`#lp-row-${k} .lp-align-btn[data-valign].active`);
      fieldVAlign[k] = activeVBtn?.dataset.valign || 'top';
    }
    return {
      printerType: pt,
      labelSize: sizeId,
      size,
      qty: Math.min(500, Math.max(1, parseInt(document.getElementById('lp-qty')?.value) || 1)),
      fontSize: document.getElementById('lp-fs')?.value || 'medium',
      fields,
      fieldOrder: order,
      fieldAlign,
      fieldVAlign,
    };
  },

  _lpBuildLabel(p, cfg, scale) {
    const { size, fields, fieldOrder, fieldAlign, fieldVAlign, fontSize } = cfg;
    const sc     = scale || 1;
    const w      = Math.round(size.w * sc);
    const h      = Math.round(size.h * sc);
    const sz     = { small: 8, medium: 10, large: 13 }[fontSize] || 10;
    const b      = Math.max(7, Math.round(sz * sc));
    const pad    = Math.max(3, Math.round(6 * sc));
    const gap    = Math.max(1, Math.round(3 * sc));
    const order  = fieldOrder || ['name','sku','barcode','price','category','description'];
    const align  = fieldAlign || {};
    const valign = fieldVAlign || {};

    const renderField = (k) => {
      const a  = align[k] || 'left';
      const ta = `text-align:${a};`;
      const barcodeMargin = a === 'center' ? 'margin:0 auto' : a === 'right' ? 'margin-left:auto' : 'margin-right:auto';
      if (k === 'name' && fields.name && p.name)
        return `<div style="${ta}font-weight:700;font-size:${Math.round(b*1.3)}px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:1.25">${p.name}</div>`;
      if (k === 'sku' && fields.sku && p.sku)
        return `<div style="${ta}font-size:${b}px;font-family:monospace;color:#444;line-height:1.2">SKU: ${p.sku}</div>`;
      if (k === 'barcode' && fields.barcode && p.barcode)
        return `<svg class="lp-bc" data-value="${p.barcode}" style="display:block;flex-shrink:0;${barcodeMargin}" height="${Math.max(18, Math.round(28*sc))}"></svg>`;
      if (k === 'price' && fields.price)
        return `<div style="${ta}font-size:${Math.round(b*1.4)}px;font-weight:700;line-height:1.25">${this.fmt(p.price)}</div>`;
      if (k === 'category' && fields.category && p.category_name)
        return `<div style="${ta}font-size:${b}px;color:#555;line-height:1.2">${p.category_name}</div>`;
      if (k === 'description' && fields.description && p.description)
        return `<div style="${ta}font-size:${Math.max(6,b-1)}px;color:#666;overflow:hidden;line-height:1.2">${p.description}</div>`;
      return '';
    };

    // Group fields into top/middle/bottom vertical zones so each field can be
    // independently anchored within the label, not just stacked in order.
    const zones = { top: '', middle: '', bottom: '' };
    for (const k of order) {
      const html = renderField(k);
      if (!html) continue;
      const v = zones.hasOwnProperty(valign[k]) ? valign[k] : 'top';
      zones[v] += html;
    }
    const zoneStyle = `display:flex;flex-direction:column;gap:${gap}px`;
    const body = `<div style="${zoneStyle}">${zones.top}</div><div style="${zoneStyle};flex:1;justify-content:center">${zones.middle}</div><div style="${zoneStyle}">${zones.bottom}</div>`;

    return `<div style="width:${w}px;min-height:${h}px;max-height:${h}px;background:#fff;border:1px solid #999;padding:${pad}px;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;gap:${gap}px;font-family:Arial,sans-serif;flex-shrink:0">${body}</div>`;
  },

  _lpApplyBarcodes(container) {
    if (typeof JsBarcode === 'undefined') return;
    container.querySelectorAll('.lp-bc').forEach(svg => {
      const val = svg.dataset.value;
      if (!val) return;
      const savedStyle = svg.getAttribute('style');
      try {
        JsBarcode(svg, val, {
          format: 'CODE128', width: 1.2,
          height: parseInt(svg.getAttribute('height')) || 25,
          displayValue: true, fontSize: 8, margin: 0,
          background: 'transparent', lineColor: '#000', textMargin: 1,
        });
        // JsBarcode overwrites the svg's style attribute wholesale, which erases
        // the display/margin rules used for horizontal alignment — restore them.
        if (savedStyle) svg.style.cssText += ';' + savedStyle;
      } catch(e) { svg.remove(); }
    });
  },

  _lpUpdatePreview() {
    const preview = document.getElementById('lp-preview');
    const info    = document.getElementById('lp-info');
    const btn     = document.getElementById('lp-print-btn');
    if (!preview) return;
    const p = this._lpProduct;
    if (!p) return;
    const cfg   = this._lpGetCfg();
    const maxW  = (preview.clientWidth || 280) - 24;
    const scale = Math.min(1, maxW / cfg.size.w);
    const shown = Math.min(cfg.qty, 6);
    preview.innerHTML = Array(shown).fill(this._lpBuildLabel(p, cfg, scale)).join('');
    if (cfg.qty > shown)
      preview.innerHTML += `<div style="padding:8px;font-size:12px;color:#666;width:100%">+${cfg.qty - shown} more label${cfg.qty - shown !== 1 ? 's' : ''}...</div>`;
    this._lpApplyBarcodes(preview);
    if (info) info.textContent = `${cfg.qty} label${cfg.qty !== 1 ? 's' : ''} · ${this._lpPrinters[cfg.printerType]?.name} · ${cfg.size.name}`;
    if (btn) btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg> Print ${cfg.qty} Label${cfg.qty !== 1 ? 's' : ''}`;
  },

  _lpDoPrint() {
    const p = this._lpProduct;
    if (!p) return;
    const cfg = this._lpGetCfg();
    const lpSave = { printerType: cfg.printerType, labelSize: cfg.labelSize, qty: cfg.qty, fontSize: cfg.fontSize, fields: cfg.fields, fieldOrder: cfg.fieldOrder, fieldAlign: cfg.fieldAlign, fieldVAlign: cfg.fieldVAlign };
    if (cfg.labelSize === 'custom') {
      lpSave.customW = parseFloat(document.getElementById('lp-cw')?.value) || 50;
      lpSave.customH = parseFloat(document.getElementById('lp-ch')?.value) || 25;
    }
    localStorage.setItem('lpSettings', JSON.stringify(lpSave));
    const allLabels = Array(cfg.qty).fill(this._lpBuildLabel(p, cfg, 1)).join('');
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { this.alert('Allow popups to print labels', 'error'); return; }
    const printerName = this._lpPrinters[cfg.printerType]?.name || cfg.printerType;
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Labels \u2014 ${p.name}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#e0e0e0;padding:20px}.toolbar{background:#fff;padding:10px 16px;margin-bottom:16px;border-radius:6px;display:flex;align-items:center;gap:10px;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.1)}.toolbar button{padding:6px 16px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500}.pbtn{background:#10703a;color:#fff}.cbtn{background:#e0e0e0;color:#333}.labels-wrap{display:flex;flex-wrap:wrap;gap:4px;background:#fff;padding:12px;border-radius:4px}@media print{body{background:#fff;padding:0}.toolbar{display:none!important}.labels-wrap{padding:0;gap:2mm}}</style>
</head><body>
<div class="toolbar">
  <strong>${p.name}</strong>
  <span style="color:#666">${cfg.qty} label${cfg.qty!==1?'s':''} \u00b7 ${printerName} \u00b7 ${cfg.size.name}</span>
  <div style="flex:1"></div>
  <button class="pbtn" onclick="window.print()">&#128424; Print</button>
  <button class="cbtn" onclick="window.close()">Close</button>
</div>
<div class="labels-wrap">${allLabels}</div>
<script>(function(){function r(){if(typeof JsBarcode==='undefined')return;document.querySelectorAll('.lp-bc').forEach(function(s){var v=s.dataset.value;if(!v)return;var ss=s.getAttribute('style');try{JsBarcode(s,v,{format:'CODE128',width:1.2,height:parseInt(s.getAttribute('height'))||25,displayValue:true,fontSize:8,margin:0,background:'transparent',lineColor:'#000',textMargin:1});if(ss)s.style.cssText+=';'+ss;}catch(e){s.remove();}});}if(document.readyState==='complete'){r();}else{window.addEventListener('load',r);}})();<\/script>
</body></html>`);
    win.document.close();
  },

});
