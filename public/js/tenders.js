// POS tender modals (cash, card, gift card, deposit, split) and alternate currency helpers.
Object.assign(App, {
  // ─── Cash Tender Modal ────────────────────────────────────
  showCashTenderModal(total) {
    return new Promise(resolve => {
      const base = this.activeCurrency || this.settings.currency || 'USD';
      const alts = this.altCurrencies || [];
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const currencyOpts = [
        `<option value="${base}" data-rate="1">${base} — base currency</option>`,
        ...alts.map(c => `<option value="${c.code}" data-rate="${c.rate}">${c.code} &nbsp;(${this._altRateLabel(c, base)})</option>`)
      ].join('');
      overlay.innerHTML = `
        <div class="modal" style="max-width:380px">
          <div class="modal-header"><span class="modal-title">Cash Payment</span><button id="ctm-x" class="modal-close">✕</button></div>
          <div class="modal-body">
            <div style="text-align:center;background:var(--bg);border-radius:8px;padding:12px;margin-bottom:16px">
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px">Total Due</div>
              <div style="font-size:30px;font-weight:700">${this.fmt(total)}</div>
            </div>
            ${alts.length > 0 ? `
            <div class="form-group">
              <label>Payment Currency</label>
              <select id="ctm-currency" onchange="App._ctmUpdate(${total})">${currencyOpts}</select>
            </div>
            <div id="ctm-total-alt" style="background:var(--bg);border-radius:6px;padding:8px 10px;margin:-8px 0 12px;display:none;font-size:13px"></div>
            ` : ''}
            <div class="form-group">
              <label id="ctm-label">Amount Tendered</label>
              <input type="number" id="ctm-tendered" placeholder="${total.toFixed(2)}" step="any"
                oninput="App._ctmUpdate(${total})" style="font-size:18px;font-weight:600">
            </div>
            <div id="ctm-tendered-info" style="display:none;font-size:12px;color:var(--text-muted);margin:-8px 0 8px;padding:0 2px;text-align:right"></div>
            ${alts.length > 0 ? `<div class="form-group" id="ctm-change-currency-group" style="display:none">
              <label>Give Change In</label>
              <select id="ctm-change-currency" onchange="App._ctmUpdate(${total})">${currencyOpts}</select>
            </div>` : ''}
            <div id="ctm-change" style="display:none;text-align:center;padding:12px;border-radius:8px;margin-top:4px">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Change Due</div>
              <div id="ctm-change-val" style="font-size:26px;font-weight:700"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="ctm-cancel">Cancel</button>
            <button class="btn btn-primary" id="ctm-confirm">Confirm Payment</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cancel = () => { overlay.remove(); resolve(null); };
      overlay.querySelector('#ctm-x').addEventListener('click', cancel);
      overlay.querySelector('#ctm-cancel').addEventListener('click', cancel);
      overlay.querySelector('#ctm-confirm').addEventListener('click', () => {
        const r = this._ctmGetResult(total);
        if (r) { overlay.remove(); resolve(r); }
      });
      setTimeout(() => overlay.querySelector('#ctm-tendered')?.focus(), 50);
    });
  },

  _ctmUpdate(total) {
    const base = this.activeCurrency || this.settings.currency || 'USD';
    const sel = document.getElementById('ctm-currency');
    const rate = sel ? parseFloat(sel.selectedOptions[0]?.dataset.rate || '1') : 1;
    const code = sel ? sel.value : base;
    const totalAlt = parseFloat((total * rate).toFixed(2));
    const altEl = document.getElementById('ctm-total-alt');
    if (altEl) {
      if (rate !== 1) {
        altEl.style.display = '';
        altEl.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--text-muted)">Amount in ${code}</span><span style="font-weight:600">${code} ${this._n2(totalAlt)}</span></div><div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Equivalent (${base})</span><span>${this.fmt(total)}</span></div>`;
      } else { altEl.style.display = 'none'; }
    }
    const lbl = document.getElementById('ctm-label');
    if (lbl) lbl.textContent = rate !== 1 ? `Amount Tendered (${code})` : 'Amount Tendered';
    const tendered = parseFloat(document.getElementById('ctm-tendered')?.value);
    const changeEl = document.getElementById('ctm-change');
    const changeValEl = document.getElementById('ctm-change-val');
    const tenderedInfoEl = document.getElementById('ctm-tendered-info');
    const changeCurrencyGroup = document.getElementById('ctm-change-currency-group');
    const changeCurrencySel = document.getElementById('ctm-change-currency');
    if (!isNaN(tendered) && tendered > 0 && changeEl && changeValEl) {
      const changeAlt = parseFloat((tendered - totalAlt).toFixed(2));
      const changeBase = parseFloat((changeAlt / rate).toFixed(2));
      if (tenderedInfoEl) {
        if (rate !== 1) { tenderedInfoEl.style.display = ''; tenderedInfoEl.innerHTML = `Tendered: <strong>${code} ${this._n2(tendered)}</strong>`; }
        else { tenderedInfoEl.style.display = 'none'; }
      }
      changeEl.style.display = '';
      if (changeAlt >= 0) {
        // The cashier can hand back change in any configured currency,
        // independent of what the customer paid in (pays USD, wants JMD
        // change back, etc.) — defaults to matching the payment currency the
        // first time this becomes visible, but only then, so switching it
        // manually afterward isn't clobbered by every keystroke re-running
        // this same update function.
        if (changeCurrencyGroup) {
          if (changeCurrencyGroup.style.display === 'none') { changeCurrencyGroup.style.display = ''; if (changeCurrencySel) changeCurrencySel.value = code; }
        }
        const changeRate = changeCurrencySel ? parseFloat(changeCurrencySel.selectedOptions[0]?.dataset.rate || '1') : 1;
        const changeCode = changeCurrencySel ? changeCurrencySel.value : base;
        const changeAmountAlt = parseFloat((changeBase * changeRate).toFixed(2));
        changeEl.style.background = '#e8f5e9'; changeValEl.style.color = 'var(--success)';
        changeValEl.textContent = changeRate !== 1 ? `${changeCode} ${this._n2(changeAmountAlt)}` : this.fmt(changeBase);
      } else {
        if (changeCurrencyGroup) changeCurrencyGroup.style.display = 'none';
        changeEl.style.background = '#fff3e0'; changeValEl.style.color = 'var(--danger)';
        changeValEl.textContent = rate !== 1 ? `Short ${this.fmt(Math.abs(changeBase))}` : `Short ${code} ${this._n2(Math.abs(changeAlt))}`;
      }
    } else {
      if (changeEl) changeEl.style.display = 'none';
      if (tenderedInfoEl) tenderedInfoEl.style.display = 'none';
      if (changeCurrencyGroup) changeCurrencyGroup.style.display = 'none';
    }
  },

  _ctmGetResult(total) {
    const base = this.activeCurrency || this.settings.currency || 'USD';
    const sel = document.getElementById('ctm-currency');
    const rate = sel ? parseFloat(sel.selectedOptions[0]?.dataset.rate || '1') : 1;
    const code = sel ? sel.value : base;
    const totalAlt = parseFloat((total * rate).toFixed(2));
    const tenderedAlt = parseFloat(document.getElementById('ctm-tendered')?.value);
    if (isNaN(tenderedAlt) || tenderedAlt < totalAlt - 0.001) { this.alert('Amount tendered is less than total', 'error'); return null; }
    const changeAmount = parseFloat(((tenderedAlt - totalAlt) / rate).toFixed(2));
    // Independent of the payment currency above — the cashier picks whatever
    // currency they're actually handing back to the customer.
    const changeCurrencySel = document.getElementById('ctm-change-currency');
    const changeRate = changeCurrencySel ? parseFloat(changeCurrencySel.selectedOptions[0]?.dataset.rate || '1') : 1;
    const changeCurrency = changeCurrencySel ? changeCurrencySel.value : base;
    return {
      amountTendered: parseFloat((tenderedAlt / rate).toFixed(2)),
      changeAmount,
      tenderedAlt, changeAlt: parseFloat((tenderedAlt - totalAlt).toFixed(2)),
      currency: code, rate,
      changeCurrency, changeRate, changeAmountAlt: parseFloat((changeAmount * changeRate).toFixed(2)),
    };
  },

  // Change is handed back in whatever currency the cashier picked in the
  // cash tender modal (ctm-change-currency) — independent of what currency
  // the payment itself was tendered in. Falls back to the base currency
  // when no cash result is on hand (card/other tenders) or no alt was chosen.
  _changeDisplay(cashResult, changeBase) {
    if (cashResult?.changeRate && cashResult.changeRate !== 1) {
      return `${cashResult.changeCurrency} ${this._n2(cashResult.changeAmountAlt)}`;
    }
    return this.fmt(changeBase);
  },

  // ─── Card Approval Code Modal ─────────────────────────────
  showCardApprovalModal() {
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:360px">
          <div class="modal-header"><span class="modal-title">Card Payment</span><button id="cam-x" class="modal-close">✕</button></div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Enter the approval code from the card terminal.</p>
            <div class="form-group">
              <label>Approval Code</label>
              <input id="cam-code" placeholder="e.g. 123456" style="font-size:18px;font-weight:600;letter-spacing:2px;text-transform:uppercase">
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="cam-cancel">Cancel</button>
            <button class="btn btn-primary" id="cam-confirm">Confirm Payment</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cancel = () => { overlay.remove(); resolve(null); };
      overlay.querySelector('#cam-x').addEventListener('click', cancel);
      overlay.querySelector('#cam-cancel').addEventListener('click', cancel);
      overlay.querySelector('#cam-confirm').addEventListener('click', () => {
        const code = overlay.querySelector('#cam-code').value.trim().toUpperCase();
        if (!code) { this.alert('Please enter the approval code', 'error'); return; }
        overlay.remove();
        resolve(code);
      });
      setTimeout(() => overlay.querySelector('#cam-code')?.focus(), 50);
    });
  },

  // ─── Gift Card Number Modal ───────────────────────────────
  showGiftCardModal() {
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:360px">
          <div class="modal-header"><span class="modal-title">Gift Card Payment</span><button id="gcm-x" class="modal-close">✕</button></div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Enter the gift card number.</p>
            <div class="form-group">
              <label>Gift Card #</label>
              <input id="gcm-num" placeholder="e.g. GC-0001-2345-6789" style="font-size:16px;font-weight:600;letter-spacing:1px">
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="gcm-cancel">Cancel</button>
            <button class="btn btn-primary" id="gcm-confirm">Confirm Payment</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cancel = () => { overlay.remove(); resolve(null); };
      overlay.querySelector('#gcm-x').addEventListener('click', cancel);
      overlay.querySelector('#gcm-cancel').addEventListener('click', cancel);
      overlay.querySelector('#gcm-confirm').addEventListener('click', () => {
        const num = overlay.querySelector('#gcm-num').value.trim();
        if (!num) { this.alert('Please enter the gift card number', 'error'); return; }
        overlay.remove();
        resolve(num);
      });
      setTimeout(() => overlay.querySelector('#gcm-num')?.focus(), 50);
    });
  },

  // ─── Direct Deposit Reference Modal ──────────────────────
  showDepositReferenceModal() {
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:360px">
          <div class="modal-header"><span class="modal-title">Direct Deposit</span><button id="ddm-x" class="modal-close">✕</button></div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Enter the bank transfer / deposit reference number.</p>
            <div class="form-group">
              <label>Deposit Reference #</label>
              <input id="ddm-ref" placeholder="e.g. TRF-20260627-001" style="font-size:16px;font-weight:600;letter-spacing:1px">
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="ddm-cancel">Cancel</button>
            <button class="btn btn-primary" id="ddm-confirm">Confirm Payment</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cancel = () => { overlay.remove(); resolve(null); };
      overlay.querySelector('#ddm-x').addEventListener('click', cancel);
      overlay.querySelector('#ddm-cancel').addEventListener('click', cancel);
      overlay.querySelector('#ddm-confirm').addEventListener('click', () => {
        const ref = overlay.querySelector('#ddm-ref').value.trim();
        if (!ref) { this.alert('Please enter the deposit reference number', 'error'); return; }
        overlay.remove();
        resolve(ref);
      });
      setTimeout(() => overlay.querySelector('#ddm-ref')?.focus(), 50);
    });
  },

  // ─── Tax Exempt Tender Modal ─────────────────────────────
  // The customer pays the full total, GCT included, and reclaims the GCT
  // themselves. Any customer, or none; the exemption reference is optional, so
  // this resolves '' with no reference and null only on cancel.
  showExemptTenderModal(total, tax) {
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:380px">
          <div class="modal-header"><span class="modal-title">Tax Exempt Payment</span><button id="etm-x" class="modal-close">✕</button></div>
          <div class="modal-body">
            <div style="text-align:center;background:var(--bg);border-radius:8px;padding:12px;margin-bottom:14px">
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px">Total Due</div>
              <div style="font-size:30px;font-weight:700">${this.fmt(total)}</div>
              <div id="etm-gct" style="font-size:13px;color:var(--text-muted)">Includes GCT of ${this.fmt(tax)}</div>
            </div>
            ${tax > 0 ? '' : '<p id="etm-no-gct" class="color-danger" style="font-size:12px;margin:0 0 10px">This ticket has no GCT on it, so the customer will have none to reclaim.</p>'}
            <div class="form-group">
              <label>Exemption Ref # (optional)</label>
              <input id="etm-ref" value="${this.escapeAttr(this.cartCustomer?.tax_exemption_number || '')}" placeholder="Exemption or reference number">
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="etm-cancel">Cancel</button>
            <button class="btn btn-primary" id="etm-confirm">Confirm Payment</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const cancel = () => { overlay.remove(); resolve(null); };
      overlay.querySelector('#etm-x').addEventListener('click', cancel);
      overlay.querySelector('#etm-cancel').addEventListener('click', cancel);
      overlay.querySelector('#etm-confirm').addEventListener('click', () => {
        const ref = overlay.querySelector('#etm-ref').value.trim();
        overlay.remove();
        resolve(ref);
      });
      setTimeout(() => overlay.querySelector('#etm-ref')?.focus(), 50);
    });
  },

  // ─── Split Tender Modal ───────────────────────────────────
  // Collects 2+ tender rows (method + amount, plus a ref/approval code for
  // methods that need one) that together must add up to the total. Charge
  // Account is intentionally excluded — see routes/transactions.js.
  // `exclude` drops further methods from the picker (e.g. rental checkout
  // can't take Gift Card for a deposit — see routes/rentals.js).
  showSplitTenderModal(total, { exclude = [] } = {}) {
    this._stmTotal = total;
    this._stmExclude = exclude;
    return new Promise(resolve => {
      document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:480px">
          <div class="modal-header"><span class="modal-title">Split Tender</span><button id="stm-x" class="modal-close">✕</button></div>
          <div class="modal-body">
            <div style="text-align:center;background:var(--bg);border-radius:8px;padding:12px;margin-bottom:14px">
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px">Total Due</div>
              <div style="font-size:26px;font-weight:700">${this.fmt(total)}</div>
            </div>
            <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Add two or more tenders that together cover the full total. Charge Account${exclude.includes('gift_card') ? ' and Gift Card aren\'t' : ' isn\'t'} available as a split leg.</p>
            <div id="stm-rows"></div>
            <button type="button" class="btn btn-secondary btn-sm" onclick="App._addStmRow()" style="margin-top:4px">+ Add Tender</button>
            <div id="stm-summary" style="text-align:right;font-size:13px;font-weight:600;margin-top:12px"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="stm-cancel">Cancel</button>
            <button class="btn btn-primary" id="stm-confirm" disabled>Confirm Payment</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const rowsEl = overlay.querySelector('#stm-rows');
      rowsEl.innerHTML = this._stmRowHtml() + this._stmRowHtml();
      this._updateStmSummary(total);

      const cancel = () => { overlay.remove(); resolve(null); };
      overlay.querySelector('#stm-x').addEventListener('click', cancel);
      overlay.querySelector('#stm-cancel').addEventListener('click', cancel);
      overlay.querySelector('#stm-confirm').addEventListener('click', () => {
        const rows = this._getStmRows();
        const applied = parseFloat(rows.reduce((sum, r) => sum + r.amount, 0).toFixed(2));
        if (rows.length < 2) { this.alert('Add at least two tenders to split payment', 'error'); return; }
        if (Math.abs(applied - total) > 0.01) { this.alert('Tender amounts must add up to the total due', 'error'); return; }
        for (const r of rows) {
          if (this._stmRefRequired(r.method) && !r.approval_code) { this.alert(`Enter a reference/approval number for ${r.method.replace('_',' ')}`, 'error'); return; }
        }
        overlay.remove();
        resolve({
          tenders: rows.map(r => ({ method: r.method, amount: r.amount, approval_code: r.approval_code || null })),
          foreignCash: rows.map(r => r.foreign),
        });
      });
    });
  },

  _stmRefRequired(method) {
    return ['credit_card', 'debit_card', 'direct_deposit', 'gift_card'].includes(method);
  },

  // Tax Exempt's reference box is shown but optional.
  _stmRefShown(method) {
    return method === 'tax_exempt_tender' || this._stmRefRequired(method);
  },

  _stmMethodOptionsHtml(selected) {
    const methods = [['cash', 'Cash'], ['credit_card', 'Credit Card'], ['debit_card', 'Debit Card'], ['check', 'Check'], ['gift_card', 'Gift Card'], ['direct_deposit', 'Direct Deposit'], ['tax_exempt_tender', 'Tax Exempt']]
      .filter(([v]) => !(this._stmExclude || []).includes(v));
    return `<option value="">Method…</option>` + methods.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
  },

  // Alt-currency support mirrors showCashTenderModal's — only Cash rows get
  // a currency picker, and only when Alternate Currencies are configured in
  // Settings. The Amount field is in whatever currency is selected; the base
  // equivalent (what's actually validated/sent to the server) is shown as a
  // live hint underneath, same conversion math as _ctmGetResult().
  _stmHasAltCurrencies() {
    return (this.altCurrencies || []).length > 0;
  },

  _stmCurrencyOptionsHtml() {
    const base = this.activeCurrency || this.settings.currency || 'USD';
    return [
      `<option value="${base}" data-rate="1">${base} — base currency</option>`,
      ...(this.altCurrencies || []).map(c => `<option value="${c.code}" data-rate="${c.rate}">${c.code} (${this._altRateLabel(c, base)})</option>`),
    ].join('');
  },

  _stmRowHtml(method = '', amount = '') {
    const showCurrency = method === 'cash' && this._stmHasAltCurrencies();
    return `<div class="stm-row" style="margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:6px">
      <div style="display:flex;gap:8px;align-items:center">
        <select class="stm-method" style="flex:1.4" onchange="App._stmRowMethodChanged(this)">${this._stmMethodOptionsHtml(method)}</select>
        <input type="number" class="stm-amount" min="0" step="0.01" value="${amount}" placeholder="Amount" style="width:100px;flex-shrink:0" oninput="App._updateStmSummary()">
        <button type="button" class="btn btn-danger btn-sm" style="flex-shrink:0" onclick="this.closest('.stm-row').remove();App._updateStmSummary()">✕</button>
      </div>
      ${this._stmHasAltCurrencies() ? `<div class="stm-currency-wrap" style="margin-top:6px;${showCurrency ? '' : 'display:none'}">
        <select class="stm-currency" style="width:100%" onchange="App._updateStmSummary()">${this._stmCurrencyOptionsHtml()}</select>
        <div class="stm-currency-hint" style="font-size:11px;color:var(--text-muted);margin-top:2px"></div>
      </div>` : ''}
      <input type="text" class="stm-ref" placeholder="Ref / Approval #" style="width:100%;margin-top:6px;box-sizing:border-box;${this._stmRefShown(method) ? '' : 'display:none'}">
    </div>`;
  },

  _stmRowMethodChanged(selectEl) {
    const row = selectEl.closest('.stm-row');
    const refInput = row.querySelector('.stm-ref');
    refInput.style.display = this._stmRefShown(selectEl.value) ? '' : 'none';
    const curWrap = row.querySelector('.stm-currency-wrap');
    if (curWrap) curWrap.style.display = (selectEl.value === 'cash' && this._stmHasAltCurrencies()) ? '' : 'none';
    this._updateStmSummary();
  },

  _addStmRow() {
    const rowsEl = document.getElementById('stm-rows');
    if (!rowsEl) return;
    const div = document.createElement('div');
    div.innerHTML = this._stmRowHtml();
    rowsEl.appendChild(div.firstElementChild);
    this._updateStmSummary();
  },

  _getStmRows() {
    return Array.from(document.querySelectorAll('#stm-rows .stm-row')).map(row => {
      const method = row.querySelector('.stm-method')?.value || '';
      const rawAmount = parseFloat(row.querySelector('.stm-amount')?.value) || 0;
      const curSel = row.querySelector('.stm-currency');
      const rate = curSel ? parseFloat(curSel.selectedOptions[0]?.dataset.rate || '1') : 1;
      const currency = curSel ? curSel.value : (this.activeCurrency || this.settings.currency || 'USD');
      return {
        method,
        amount: parseFloat((rawAmount / rate).toFixed(2)),
        approval_code: row.querySelector('.stm-ref')?.value.trim() || '',
        foreign: rate !== 1 ? { currency, rate, tenderedAlt: rawAmount } : null,
      };
    }).filter(r => r.method && r.amount > 0);
  },

  _updateStmSummary() {
    const total = this._stmTotal || 0;
    const summary = document.getElementById('stm-summary');
    const confirmBtn = document.getElementById('stm-confirm');
    document.querySelectorAll('#stm-rows .stm-row').forEach(row => {
      const hint = row.querySelector('.stm-currency-hint');
      if (!hint) return;
      const curSel = row.querySelector('.stm-currency');
      const rate = curSel ? parseFloat(curSel.selectedOptions[0]?.dataset.rate || '1') : 1;
      const rawAmount = parseFloat(row.querySelector('.stm-amount')?.value) || 0;
      hint.textContent = (rate !== 1 && rawAmount > 0) ? `≈ ${this.fmt(rawAmount / rate)}` : '';
    });
    if (!summary) return;
    const rows = this._getStmRows();
    const applied = parseFloat(rows.reduce((sum, r) => sum + r.amount, 0).toFixed(2));
    const remaining = parseFloat((total - applied).toFixed(2));
    const balanced = Math.abs(remaining) <= 0.005;
    summary.style.color = balanced ? 'var(--success)' : 'var(--danger)';
    summary.textContent = balanced
      ? `Applied ${this.fmt(applied)} of ${this.fmt(total)} — balanced ✓`
      : `Applied ${this.fmt(applied)} of ${this.fmt(total)} — Remaining ${this.fmt(remaining)}`;
    if (confirmBtn) confirmBtn.disabled = !balanced || rows.length < 2;
  },

  // ─── Alternate Currency Helpers ───────────────────────────
  // How many base-currency units one unit of an alternate currency is worth
  // (1 USD = 155 JMD → 155) — what Settings asks for. Older entries only
  // stored `rate` (alt per 1 base, e.g. 0.0064), so it's derived from that.
  _altBasePerUnit(c) {
    const per = Number(c?.base_per_unit);
    if (per > 0) return per;
    const rate = Number(c?.rate);
    return rate > 0 ? Math.round((1 / rate) * 10000) / 10000 : null;
  },

  // "1 USD = 155 JMD" for labels.
  _altRateLabel(c, base) {
    const per = this._altBasePerUnit(c);
    return per ? `1 ${c.code} = ${per.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${base}` : '';
  },

  _renderAltCurrenciesTable() {
    const base = this.activeCurrency || this.settings.currency || 'USD';
    if (!this.altCurrencies || !this.altCurrencies.length) {
      return '<p style="color:var(--text-muted);font-size:13px;margin:0">No alternate currencies configured. Use the form below to add one.</p>';
    }
    return `<table><thead><tr><th>Code</th><th>Currency</th><th>Exchange Rate</th><th></th></tr></thead><tbody>
      ${this.altCurrencies.map(c => {
        const label = this.CURRENCIES.find(([cd]) => cd === c.code)?.[1] || c.code;
        return `<tr>
          <td><span class="badge-pill badge-purple">${c.code}</span></td>
          <td style="font-size:13px;color:var(--text-muted)">${label}</td>
          <td style="white-space:nowrap;font-size:13px">1 ${c.code} = <input type="number" value="${this._altBasePerUnit(c) ?? ''}" min="0.0001" step="any"
            style="width:110px;padding:4px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px"
            onchange="App.updateAltCurrencyRate('${c.code}',this.value)"> ${base}</td>
          <td><button class="btn btn-danger btn-sm" onclick="App.removeAltCurrency('${c.code}')">Remove</button></td>
        </tr>`;
      }).join('')}
    </tbody></table>`;
  },

  addAltCurrency() {
    const code = document.getElementById('alt-cur-code')?.value;
    const per = parseFloat(document.getElementById('alt-cur-rate')?.value);
    const base = this.activeCurrency || this.settings.currency || 'USD';
    if (!code) { this.alert('Select a currency', 'error'); return; }
    if (code === base) { this.alert('Cannot add the base currency as an alternate', 'error'); return; }
    if (!per || per <= 0) { this.alert(`Enter what 1 ${code} is worth in ${base}, e.g. 155`, 'error'); return; }
    if (this.altCurrencies.find(c => c.code === code)) { this.alert(`${code} is already in the list`, 'error'); return; }
    this.altCurrencies.push({ code, base_per_unit: per, rate: 1 / per });
    const el = document.getElementById('alt-currencies-table');
    if (el) el.innerHTML = this._renderAltCurrenciesTable();
    document.getElementById('alt-cur-rate').value = '';
  },

  removeAltCurrency(code) {
    this.altCurrencies = this.altCurrencies.filter(c => c.code !== code);
    const el = document.getElementById('alt-currencies-table');
    if (el) el.innerHTML = this._renderAltCurrenciesTable();
  },

  updateAltCurrencyRate(code, val) {
    const per = parseFloat(val);
    if (!per || per <= 0) return;
    const c = this.altCurrencies.find(c => c.code === code);
    if (c) { c.base_per_unit = per; c.rate = 1 / per; }
  },

});
