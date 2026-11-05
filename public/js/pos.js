// POS screen: ticket, cart, Receive Payment, tax exemption, bundle upsell, checkout, receipts.
Object.assign(App, {
  // ─── POS ──────────────────────────────────────────────────
  renderPOSBranchBar() {
    const bar = document.getElementById('pos-branch-bar');
    if (!bar) return;
    const branches = this.currentUser.branches || [];
    const isMulti = this.currentUser.permissions?.multi_branch_access && branches.length > 1;
    const inner = isMulti
      ? `<select id="pos-branch-select" onchange="App.switchPOSBranch(+this.value)" style="border:none;background:transparent;font-weight:600;font-size:14px;color:var(--brand-black);cursor:pointer;outline:none;max-width:260px">
           ${branches.map(b => `<option value="${b.id}" ${this.posBranch?.id===b.id?'selected':''}>${b.name}</option>`).join('')}
         </select>`
      : `<span style="font-weight:600;font-size:14px;color:var(--brand-black)">${this.posBranch?.name || 'No Branch'}</span>`;
    const drawerInfo = this.currentDrawerSession
      ? `<span style="margin-left:16px;font-size:12px;color:var(--accent);background:rgba(0,126,55,0.1);padding:3px 10px;border-radius:12px">🗄 ${this.currentDrawerSession.drawer_name||'Drawer'} · $${this._n2(this.currentDrawerSession.opening_float)} float</span>`
      : '';
    bar.innerHTML = `
      <svg viewBox="0 0 24 24" style="fill:var(--accent)" width="16" height="16"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
      <span style="font-size:12px;color:var(--accent);text-transform:uppercase;letter-spacing:.5px">Branch</span>
      ${inner}${drawerInfo}`;

    // Show/hide the drawer banner below the branch bar
    const banner = document.getElementById('pos-drawer-banner');
    if (banner) {
      banner.style.display = (!this.currentDrawerSession && this._posHasDrawers) ? 'flex' : 'none';
    }
  },

  // Re-fetches the product grid against the new branch so its tiered price
  // and per-branch stock are correct — blocked while a ticket is in
  // progress rather than trying to re-price already-added cart lines, since
  // a ticket is conceptually "for" whichever branch it was started under.
  async switchPOSBranch(branchId) {
    if (this.cart.length) {
      this.alert('Complete or cancel the current ticket before switching branches', 'warning');
      this.renderPOSBranchBar();
      return;
    }
    const branch = this.currentUser.branches.find(b => b.id === branchId);
    if (!branch) return;
    this.posBranch = branch;
    this.allProducts = await this.api('GET', `/products?active=1&for_sale=1&branch_id=${branchId}`);
    this._applySellableRentalStock(this.allProducts);
    this.renderProductGrid();
    this.renderPOSBranchBar();
  },

  // A rental item's stock_qty is the total number owned, not what's free to
  // sell right now — units out on an active rental don't physically sit on
  // the shelf, so they're subtracted before this list reaches the product
  // grid/cart cap. No-op for non-rental products (rental_outstanding_qty is
  // always 0 for them).
  _applySellableRentalStock(products) {
    (products || []).forEach(p => {
      if (p.is_rental) p.stock_qty = Math.max(0, (p.stock_qty || 0) - (p.rental_outstanding_qty || 0));
    });
  },

  async renderPOS() {
    // Resolved before the products fetch (depends only on currentUser.branches,
    // already loaded at login — no async call needed) so branch_id can be
    // passed in immediately. This is also what makes the branch-scoped price
    // tier and per-branch stock actually show up in the grid, neither of
    // which worked before this was wired through.
    const branches = this.currentUser.branches || [];
    const defaultBranch = branches.find(b => b.is_default) || branches[0] || null;
    if (!this.posBranch || !branches.find(b => b.id === this.posBranch.id)) {
      this.posBranch = defaultBranch;
    }
    const branchParam = this.posBranch?.id ? `&branch_id=${this.posBranch.id}` : '';

    [this.allCategories, this.allProducts] = await Promise.all([
      this.api('GET', '/categories'),
      this.api('GET', `/products?active=1&for_sale=1${branchParam}`),
    ]);
    this._applySellableRentalStock(this.allProducts);
    if (this.section !== 'pos') return;
    this.posCategory = 'all';
    this.posSearch = '';
    this._selectedCartLine = null;

    // Right-hand action grid — 4 columns, grouped like the reference terminal
    // (lookups / ticket actions / hold&quote / transactional), each button a
    // relocation of an existing capability (see the POS button-mapping plan).
    // Buttons the current employee can't use are simply omitted rather than
    // shown disabled, matching how e.g. Hold/Recall are already gated today.
    const gridButtons = [
      this.can('pos_customer_lookup') ? `<button class="pos-grid-btn" onclick="App.selectCustomer()">Cust Lookup</button>` : '',
      this.can('pos_customer_lookup') ? `<button class="pos-grid-btn" onclick="App.posCustZoom()">Cust Zoom</button>` : '',
      this.can('pos_item_lookup') ? `<button class="pos-grid-btn" onclick="App.showItemLookupModal()">Item Lookup</button>` : '',
      this.can('pos_item_lookup') ? `<button class="pos-grid-btn" onclick="App.posItemZoom()">Item Zoom</button>` : '',
      this.can('pos_discounts') ? `<button class="pos-grid-btn" onclick="App.showTicketDiscountModal()">Ticket Discount</button>` : '',
      this.can('pos_tax_exempt') ? `<button class="pos-grid-btn" onclick="App.showTaxExemptModal()">Tax Exempt</button>` : '',
      this.can('layaway_create') ? `<button class="pos-grid-btn" onclick="App.posCreateLayawayFromCart()">Create Layaway</button>` : '',
      this.can('quotations') ? `<button class="pos-grid-btn" onclick="App.posCreateQuoteFromCart()">Create Quote</button>` : '',
      this.can('quotations') ? `<button class="pos-grid-btn" onclick="App.showQuoteSearch()">Quote Recall</button>` : '',
      this.can('pos_hold') ? `<button class="pos-grid-btn hold" onclick="App.holdOrder()">Hold</button>` : '',
      this.can('pos_hold') ? `<button class="pos-grid-btn hold" onclick="App.recallOrder()">Hold Recall <span id="hold-count-badge" style="display:none;background:rgba(0,0,0,0.15);border-radius:10px;padding:0 5px;font-size:10px;margin-left:2px"></span></button>` : '',
      this.can('pos_reprint_ticket') ? `<button class="pos-grid-btn" onclick="App.posReprintTicket()">Reprint Ticket</button>` : '',
      this.can('transactions') ? `<button class="pos-grid-btn" onclick="App.showSection('transactions')">Returns</button>` : '',
      this.can('pos_pay_on_account') ? `<button class="pos-grid-btn pay-acct" onclick="App.processPayment('credit')">Pay On Acct</button>` : '',
      this.currentUser?.permissions?.pos_receive_payment ? `<button class="pos-grid-btn pay-acct" onclick="App.showReceivePaymentModal()" title="Take a payment from a customer toward their account">Receive Payment</button>` : '',
      this.currentUser?.permissions?.pos_petty_cash ? `<button class="pos-grid-btn" onclick="App.showPettyCashModal()" title="Pay petty cash out of your drawer against a petty cash request slip">Petty Cash</button>` : '',
      this.can('pos_change_quantity') ? `<button class="pos-grid-btn" onclick="App.posQuantitySelectedLine()">Quantity</button>` : '',
      `<button class="pos-grid-btn" onclick="App.showCommentItemModal()" title="Add a comment line — free text printed on the receipt/invoice, no price">C Item</button>`,
      `<button class="pos-grid-btn" onclick="App.showDeliveryItemModal()" title="Add a delivery charge — your description and a price before tax">Delivery</button>`,
      this.can('pos_q_item') ? `<button class="pos-grid-btn" onclick="App.showQItemModal()" title="Add something not in inventory — the ticket then goes to a quote (Create Quote), and Purchasing orders it once the customer accepts">Q Item</button>` : '',
      this.can('pos_cancel_ticket') ? `<button class="pos-grid-btn void" onclick="App.posCancelTicket()">Cancel Ticket</button>` : '',
      this.can('pos_payment') ? `<button class="pos-grid-btn payment" style="grid-column:1 / -1" onclick="App.showPOSPaymentModal()">PAYMENT</button>` : '',
    ].filter(Boolean).join('');

    const cashierName = this.currentUser ? `${this.currentUser.first_name} ${this.currentUser.last_name}` : '';

    document.getElementById('content').innerHTML = `
      <div id="pos-section" style="height:100%;display:flex;flex-direction:column;">
        <div class="pos-kiosk-topbar">
          <button class="pos-kiosk-exit" title="Exit POS" onclick="App.showSection('dashboard')">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.59L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>
          </button>
          <div id="pos-branch-bar" style="display:flex;align-items:center;gap:10px"></div>
          <div class="pos-item-input-wrap">
            <input type="text" id="pos-item-input" placeholder="ITEM NUMBER  (or qty*item)" title="Scan or type an item number. To ring up several at once, type the quantity, a *, then the item — e.g. 250*HAMMER-16" autocomplete="off">
            <button class="btn btn-sm btn-primary" onclick="App.posSubmitItemInput()">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            </button>
          </div>
        </div>
        <div id="pos-drawer-banner" style="display:none;align-items:center;gap:14px;padding:10px 16px;background:#fff8e1;border-bottom:2px solid #ffc107;flex-shrink:0">
          <svg viewBox="0 0 24 24" fill="#f59e0b" width="20" height="20"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          <span style="font-size:14px;font-weight:500;color:#7c5c00">No cash drawer is open for this session.</span>
          <button class="btn btn-sm" style="background:#f59e0b;color:#fff;font-weight:600;border:none;padding:5px 14px" onclick="App.checkPOSDrawer()">Open Drawer</button>
        </div>
        <div class="pos-ticket-info">
          <div class="customer-bar" id="cart-customer-bar">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
            <span style="color:var(--text-muted)">Customer:</span>
            <div id="cart-customer-name" style="flex:1">${this._cartCustomerHtml()}</div>
            <button class="btn btn-outline btn-sm" onclick="App.selectCustomer()">Select</button>
            <button class="btn btn-secondary btn-sm" id="remove-customer-btn" style="display:${this.cartCustomer ? 'inline-flex' : 'none'}" onclick="App.removeCustomer()">✕</button>
          </div>
          <label style="color:var(--text-muted);display:flex;align-items:center;gap:6px;margin:0" title="Who made this sale — it counts toward their sales targets. Leave on the cashier when they made it. A ticket a salesperson started is always theirs.">Salesperson:
            <select id="pos-salesperson" onchange="App._ticketSalesperson = this.value ? Number(this.value) : null" style="margin:0;padding:3px 6px;width:auto;min-width:160px">
              <option value="">${this.escapeAttr(cashierName)}</option>
            </select>
          </label>
          <label style="color:var(--text-muted);display:flex;align-items:center;gap:6px;margin:0" title="The customer's purchase order number — printed on the Retail Tax Invoice. Leave blank for a write-in line.">P.O. #:
            <input id="pos-po-number" value="${this.escapeAttr(this._ticketPoNumber || '')}" oninput="App._ticketPoNumber = this.value.trim() || null" placeholder="Customer P.O. (optional)" style="margin:0;padding:3px 6px;width:170px">
          </label>
          <div id="active-quote-bar" style="display:none;background:#e8f0fe;border:1px solid #b3c8f7;border-radius:6px;padding:6px 10px;font-size:12px;align-items:center;gap:8px">
            <svg viewBox="0 0 24 24" fill="#1a73e8" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM16 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-4H8V6h5v2z"/></svg>
            <span style="color:#1a73e8">Invoice: <strong id="active-quote-number"></strong></span>
            <button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:11px;margin-left:auto" onclick="App.clearActiveQuote()">✕ Remove</button>
          </div>
          <div id="store-credit-bar" style="display:none;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;padding:6px 10px;font-size:12px;align-items:center;gap:8px">
            <span style="color:#2e7d32">💳 Available Credit: <strong id="store-credit-balance"></strong></span>
            <button class="btn btn-sm" style="background:#2e7d32;color:#fff;padding:3px 10px;font-size:11px;margin-left:auto" onclick="App.applyStoreCredit()">Apply</button>
            <button class="btn btn-sm btn-secondary" id="remove-store-credit-btn" style="display:none;padding:3px 8px;font-size:11px" onclick="App.removeStoreCredit()">✕</button>
          </div>
          <div id="cash-back-bar" style="display:none;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:6px 10px;font-size:12px;align-items:center;gap:8px">
            <span style="color:#8d6e00">🎁 Cash Back Available: <strong id="cash-back-balance"></strong></span>
            <button class="btn btn-sm" style="background:#f9a825;color:#fff;padding:3px 10px;font-size:11px;margin-left:auto" onclick="App.applyCashBack()">Apply</button>
            <button class="btn btn-sm btn-secondary" id="remove-cash-back-btn" style="display:none;padding:3px 8px;font-size:11px" onclick="App.removeCashBack()">✕</button>
          </div>
        </div>
        <div class="pos-ticket-wrap">
          <div class="pos-ticket-table-wrap">
            <table class="pos-ticket-table">
              <thead><tr><th>Item Number</th><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Tax</th><th style="text-align:right">Line Total<div style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0">incl. tax</div></th><th></th></tr></thead>
              <tbody id="cart-items-list"></tbody>
            </table>
          </div>
          <div class="pos-action-grid">${gridButtons}</div>
        </div>
        <div class="pos-bottom-bar" id="cart-totals"></div>
        <div class="pos-status-line">
          <span id="pos-kiosk-clock"></span>
          <span>Cashier: ${cashierName}</span>
        </div>
      </div>`;

    this._posHasDrawers = false;
    this._loadPOSSalespeople();
    this.renderPOSBranchBar();
    this.renderCart();
    this.checkPOSDrawer();
    if (this.can('pos_hold')) this.updateHoldBadge();
    this.updateClock();

    document.getElementById('pos-item-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.posSubmitItemInput();
    });
  },

  // Primary item-entry path in the kiosk layout — types/scans go here rather
  // than the old always-visible product grid. An exact SKU/barcode match
  // wins; otherwise the first name/SKU substring match, mirroring what the
  // Item Lookup grid (renderProductGrid's search) already does.
  // A quantity can go in front of the item as quantity*item (e.g.
  // 250*HAMMER-16, or 12.5*ROPE for a measured unit) to ring up that many
  // at once instead of scanning each one.
  posSubmitItemInput() {
    const input = document.getElementById('pos-item-input');
    let q = (input?.value || '').trim();
    if (!q) return;
    let qty = 1;
    const m = q.match(/^(\d+(?:\.\d+)?)\s*\*\s*(.+)$/);
    if (m) {
      qty = Number(m[1]);
      q = m[2].trim();
      if (!(qty > 0)) { this.alert('Enter a quantity above 0, e.g. 25*ITEM', 'warning'); return; }
      if (qty !== 1 && !this.can('pos_change_quantity')) { this.alert("You don't have permission to change quantities", 'error'); return; }
    }
    const ql = q.toLowerCase();
    // An alternate unit's own barcode (e.g. the case) rings up that unit
    // without asking (lib/units.js).
    for (const p of this.allProducts) {
      const choice = this._unitChoices(p).find(c => !c.isBase && (c.barcode || '').toLowerCase() === ql);
      if (choice) { if (input) { input.value = ''; input.focus(); } this.addToCart(p.id, choice, qty); return; }
    }
    let product = this.allProducts.find(p => (p.sku || '').toLowerCase() === ql || (p.barcode || '').toLowerCase() === ql);
    if (!product) product = this.allProducts.find(p => (p.name || '').toLowerCase().includes(ql) || (p.sku || '').toLowerCase().includes(ql));
    if (!product) { this.alert(`No item found matching "${q}"`, 'warning'); return; }
    if (input) { input.value = ''; input.focus(); }
    this.addToCart(product.id, null, qty);
  },

  // "Item Lookup" grid button — today's clickable product grid (search +
  // category bar), unchanged, relocated into a modal for browsing when the
  // item number isn't known. renderProductGrid()/addToCart() are reused
  // exactly as before.
  showItemLookupModal() {
    this.posCategory = 'all';
    this.posSearch = '';
    this.showModal(`
      <div class="modal" style="max-width:900px">
        <div class="modal-header"><span class="modal-title">Item Lookup</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="search-bar" style="margin-bottom:10px">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            <input type="text" id="pos-search" placeholder="Search products by name, SKU, or barcode...">
          </div>
          <div class="category-bar" id="cat-bar" style="margin-bottom:10px;">
            <div class="cat-btn active" data-cat="all">All</div>
            ${this.allCategories.map(c => `<div class="cat-btn" data-cat="${c.id}">${this.categoryEmoji(c.name)} ${c.name}</div>`).join('')}
          </div>
          <div class="product-grid" id="product-grid" style="max-height:420px"></div>
        </div>
      </div>`);
    this.renderProductGrid();
    let searchTimer = null;
    document.getElementById('pos-search').addEventListener('input', e => {
      this.posSearch = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.renderProductGrid(), 150);
    });
    document.getElementById('cat-bar').addEventListener('click', e => {
      const btn = e.target.closest('.cat-btn');
      if (!btn) return;
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.posCategory = btn.dataset.cat;
      this.renderProductGrid();
    });
  },

  // "Ticket Discount" grid button — the manual $ discount and promo-code UI,
  // unchanged (applyDiscount/applyPromoCode/removePromoCode read/write these
  // same ids), just relocated from an always-visible row into an on-demand
  // modal. Re-syncs the modal's fields from current state on open, since this
  // markup no longer stays mounted between openings.
  showTicketDiscountModal() {
    this.showModal(`
      <div class="modal" style="max-width:420px">
        <div class="modal-header"><span class="modal-title">Ticket Discount</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px" id="discount-row">
            <select id="discount-type" style="width:auto" title="Dollar amount or percentage of the ticket" onchange="document.getElementById('discount-input').placeholder = this.value === 'percent' ? 'Discount %' : 'Discount $'">
              <option value="amount">$</option>
              <option value="percent">%</option>
            </select>
            <input type="number" id="discount-input" placeholder="Discount $" min="0" step="0.01" style="width:120px;" onkeydown="if(event.key==='Enter'){event.preventDefault();App.applyDiscount()}">
            <button class="btn btn-secondary btn-sm" onclick="App.applyDiscount()">Apply</button>
            <span id="discount-display" style="font-size:13px;color:var(--success);"></span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px" id="promo-row">
            <input type="text" id="promo-code-input" placeholder="Promo code" style="flex:1;text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">
            <button class="btn btn-secondary btn-sm" onclick="App.applyPromoCode()">Apply</button>
            <button class="btn btn-outline btn-sm" id="remove-promo-btn" style="display:none" onclick="App.removePromoCode()">✕</button>
          </div>
          <div id="promo-display" style="font-size:12px;color:var(--success);display:none"></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
      </div>`);
    if (this.appliedPromoCode) {
      const pd = document.getElementById('promo-display');
      pd.textContent = `✓ ${this.appliedPromoCode.promo_name}: -${this.fmt(this.appliedPromoCode.discount_amount)}`;
      pd.style.display = 'block';
      document.getElementById('remove-promo-btn').style.display = '';
    } else if (this.autoAppliedPromo) {
      const pd = document.getElementById('promo-display');
      const changeBtn = (this._availablePromos || []).length > 1 ? ` <button class="btn btn-sm" onclick="App._showPromoPickerDropdown()" style="font-size:11px;padding:2px 8px;margin-left:6px">${this._availablePromos.length} promos ▼</button>` : '';
      pd.innerHTML = `✓ ${this.autoAppliedPromo.name}: -${this.fmt(this.autoAppliedPromo.discount_amount)}${changeBtn}`;
      pd.style.display = 'block';
    } else if (this.cartDiscount > 0) {
      const pct = this._manualTicketDiscountPct;
      if (pct) {
        document.getElementById('discount-type').value = 'percent';
        document.getElementById('discount-input').placeholder = 'Discount %';
      }
      document.getElementById('discount-input').value = pct ? String(pct) : this.cartDiscount.toFixed(2);
      document.getElementById('discount-display').textContent = `-${this.fmt(this.cartDiscount)}${pct ? ` (${pct}%)` : ''}`;
    }
    this._updateDiscountCardUI();
  },

  // "Payment" grid button — the same 6 tender buttons that used to sit
  // always-visible under the cart, now opened on demand; processPayment()
  // itself is untouched. Named distinctly from other payment modals (e.g.
  // showReceivePaymentModal for account payments) — App is one flat object,
  // so a same-named method would silently win or lose the definition
  // depending on declaration order.
  // ─── Receive Payment (POS) ────────────────────────────────
  // A cashier takes a payment toward a customer's credit account
  // (lib/customerPayments.js, permission pos_receive_payment): either an
  // open payment on account, or applied to invoices the cashier picks. It
  // goes into the open drawer session. Open payments waiting to be applied
  // are listed too, and can be applied to invoices here.
  async showReceivePaymentModal() {
    if (!this.currentDrawerSession) { this.alert('Open a cash drawer before receiving a payment', 'error'); return; }
    // The ticket's customer comes in already chosen; anyone else is found
    // with the server-side customer search (name, business name, account #,
    // phone or email), each result showing what they owe.
    const preset = this.cartCustomer || null;
    this._custPickerOnSelect = { ...(this._custPickerOnSelect || {}), 'rp-customer': c => this._rpLoad(c?.id || null) };
    this.showModal(`
      <div class="modal" style="max-width:760px">
        <div class="modal-header"><span class="modal-title">Receive Payment</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Customer</label>${this._customerPickerHtml('rp-customer', preset ? [preset] : [], preset?.id, { placeholder: 'Search by name, account #, phone or email…', remote: '&owing_first=1', allowAdd: false, showBalance: true })}</div>
          <div id="rp-body"><p style="font-size:13px;color:var(--text-muted)">Choose the customer who is paying.</p></div>
        </div>
        <div class="modal-footer" id="rp-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        </div>
      </div>`);
    if (preset) this._rpLoad(preset.id);
  },

  async _rpLoad(customerId, keep = {}) {
    const body = document.getElementById('rp-body');
    if (!body) return;
    if (!customerId) { body.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Choose the customer who is paying.</p>'; this._rpFooter(''); return; }
    body.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Loading account…</p>';
    try { this._rp = { summary: await this.api('GET', `/customer-payments/${customerId}`), mode: keep.mode || 'open', method: keep.method || 'cash', applying: null }; }
    catch (e) { body.innerHTML = `<p class="color-danger">${this.escapeAttr(e.message)}</p>`; return; }
    this._rpRender();
  },

  _rpFooter(html) {
    const f = document.getElementById('rp-footer');
    if (f) f.innerHTML = `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>${html}`;
  },

  // The most an invoice can take: its balance, or under Tax Exempt (main form only) the GCT still to clear.
  _rpCap(inv, prefix) { return prefix === 'rp' && this._rp.method === 'tax_exempt' ? Number(inv.gct_room) || 0 : Number(inv.balance_due) || 0; },

  _rpInvoiceRows(prefix) {
    const { invoices } = this._rp.summary;
    if (!invoices.length) return '<p style="font-size:12px;color:var(--text-muted);margin:6px 0">No open invoices on this account.</p>';
    const gctCol = prefix === 'rp' && this._rp.method === 'tax_exempt';
    return `<div class="table-wrap" style="max-height:240px;overflow-y:auto"><table>
      <thead><tr><th style="width:32px"></th><th>Invoice</th><th>Date</th><th>Total</th><th>Balance Due</th>${gctCol ? '<th title="GCT on the invoice not yet cleared">GCT to Clear</th>' : ''}<th style="width:120px">Apply</th></tr></thead>
      <tbody>${invoices.map((inv, i) => `<tr${gctCol && !(this._rpCap(inv, prefix) > 0.005) ? ' style="opacity:.5"' : ''}>
        <td><input type="checkbox" class="${prefix}-pick" data-i="${i}" onchange="App._rpPick(this,'${prefix}')" style="width:auto;margin:0" ${gctCol && !(this._rpCap(inv, prefix) > 0.005) ? 'disabled title="No GCT left to clear on this invoice"' : ''}></td>
        <td class="fw-600" style="font-size:12px">${this.escapeAttr(inv.transaction_number)}${inv.kind === 'legacy' ? ' <span class="badge-pill badge-secondary" style="font-size:10px">Legacy</span>' : ''}</td>
        <td style="font-size:12px;color:var(--text-muted)">${inv.kind === 'legacy' ? this._apDate(inv.created_at) : this.fmtDate(inv.created_at)}</td>
        <td style="font-size:12px">${this.fmt(inv.total)}</td>
        <td style="font-size:12px" class="color-danger fw-600">${this.fmt(inv.balance_due)}</td>
        ${gctCol ? `<td style="font-size:12px" title="GCT on the invoice: ${this.fmt(inv.gct)}">${this.fmt(inv.gct_room)}</td>` : ''}
        <td><input type="number" class="${prefix}-amt" data-i="${i}" step="0.01" min="0" max="${this._rpCap(inv, prefix).toFixed(2)}" disabled placeholder="0.00" oninput="App._rpRecalc('${prefix}')" style="width:110px;padding:4px 6px;font-size:12px"></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  },

  _rpPick(cb, prefix) {
    const inv = this._rp.summary.invoices[cb.dataset.i];
    const amt = document.querySelector(`.${prefix}-amt[data-i="${cb.dataset.i}"]`);
    amt.disabled = !cb.checked;
    amt.value = cb.checked ? this._rpCap(inv, prefix).toFixed(2) : '';
    this._rpRecalc(prefix);
  },

  _rpAllocations(prefix) {
    return Array.from(document.querySelectorAll(`.${prefix}-pick:checked`)).map(cb => {
      const inv = this._rp.summary.invoices[cb.dataset.i];
      const amount = parseFloat(document.querySelector(`.${prefix}-amt[data-i="${cb.dataset.i}"]`).value) || 0;
      return inv.kind === 'legacy' ? { legacy_invoice_id: inv.legacy_invoice_id, amount } : { transaction_id: inv.id, amount };
    }).filter(a => a.amount > 0);
  },

  // Invoice mode: the amount received follows the invoices ticked, but can be
  // raised above them — the rest is left on account as unapplied credit.
  // (Tax Exempt always equals the GCT cleared.)
  _rpRecalc(prefix) {
    const total = Math.round(this._rpAllocations(prefix).reduce((t, a) => t + a.amount, 0) * 100) / 100;
    if (prefix === 'rp' && this._rp.mode === 'invoices') {
      const amt = document.getElementById('rp-amount');
      if (amt) {
        const exempt = this._rp.method === 'tax_exempt';
        if (exempt || !this._rp.amountEdited || (parseFloat(amt.value) || 0) < total) { amt.value = total ? total.toFixed(2) : ''; if (!exempt) this._rp.amountEdited = false; }
      }
    }
    const el = document.getElementById(`${prefix}-applied-total`);
    if (el) el.textContent = this.fmt(total);
    if (prefix === 'rp') this._rpExtraNote(total);
  },

  // "x left on account" under the amount when the payment is more than what's applied.
  _rpExtraNote(applied) {
    const note = document.getElementById('rp-extra-note');
    if (!note) return;
    const amount = Math.round((parseFloat(document.getElementById('rp-amount')?.value) || 0) * 100) / 100;
    if (applied == null) applied = Math.round(this._rpAllocations('rp').reduce((t, a) => t + a.amount, 0) * 100) / 100;
    const extra = Math.round((amount - applied) * 100) / 100;
    note.innerHTML = this._rp.mode === 'invoices' && this._rp.method !== 'tax_exempt' && extra > 0.005
      ? `<span class="color-success">${this.fmt(applied)} applied to invoices · <strong>${this.fmt(extra)} left on account</strong> as unapplied credit</span>`
      : this._rp.mode === 'invoices' && extra < -0.005 ? `<span class="color-danger">Less than the ${this.fmt(applied)} applied to the invoices ticked</span>` : '';
  },

  _rpRender() {
    const { summary, mode } = this._rp;
    const c = summary.customer;
    // Nothing owing and no earlier payment left to apply — say so rather
    // than offering a payment the server will refuse.
    if (!(Number(c.account_balance) > 0.005) && !summary.open_payments.length && !summary.invoices.length) {
      document.getElementById('rp-body').innerHTML = `<div style="padding:12px 14px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <strong>${this.escapeAttr(`${c.first_name || ''} ${c.last_name || ''}`.trim())}</strong> has nothing owing on account (balance ${this.fmt(c.account_balance)}), so there's no payment to receive.
        ${c.customer_type !== 'credit' ? '<div style="margin-top:6px;color:var(--text-muted)">This is a cash customer — payments on account are only for credit customers.</div>' : ''}
      </div>`;
      this._rpFooter('');
      return;
    }
    const methods = [['cash', 'Cash'], ['credit_card', 'Credit Card'], ['debit_card', 'Debit Card'], ['check', 'Cheque'], ['direct_deposit', 'Direct Deposit']];
    // TAX-EXEMPT clears the GCT on chosen invoices for a Tax Exempt customer — no money, no drawer.
    if (c.tax_exempt) methods.push(['tax_exempt', 'Tax Exempt (clear GCT)']);
    const taxExempt = this._rp.method === 'tax_exempt';
    document.getElementById('rp-body').innerHTML = `
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:12px">
        <div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Open Invoices (${summary.invoices.length})</div><div class="fw-600 color-danger" style="font-size:18px">${this.fmt(summary.invoices.reduce((t, i) => t + Number(i.balance_due || 0), 0))}</div></div>
        ${summary.unapplied_total > 0 ? `<div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Credit On Account</div><div class="fw-600 color-success" style="font-size:18px">${this.fmt(summary.unapplied_total)}</div><div style="font-size:10px;color:var(--text-muted)">kept unless applied below</div></div>` : ''}
        <div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">Net Balance</div><div class="fw-600 ${Number(c.account_balance) > 0.005 ? '' : 'color-success'}" style="font-size:18px">${this.fmt(c.account_balance)}</div></div>
        ${c.account_blocked ? `<div style="align-self:center"><span class="badge-pill badge-danger">Account Blocked</span></div>` : ''}
      </div>
      <div style="display:flex;gap:18px;margin-bottom:10px;font-size:13px">
        <label style="display:flex;gap:6px;align-items:center;margin:0;cursor:pointer;font-weight:${mode === 'open' ? 600 : 400}"><input type="radio" name="rp-mode" value="open" ${mode === 'open' ? 'checked' : ''} onchange="App._rpSetMode('open')" style="width:auto;margin:0"> Open payment (on account)</label>
        <label style="display:flex;gap:6px;align-items:center;margin:0;cursor:pointer;font-weight:${mode === 'invoices' ? 600 : 400}"><input type="radio" name="rp-mode" value="invoices" ${mode === 'invoices' ? 'checked' : ''} onchange="App._rpSetMode('invoices')" style="width:auto;margin:0" ${summary.invoices.length ? '' : 'disabled'}> Pay specific invoices</label>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">${taxExempt
        ? '<strong>Tax Exempt:</strong> clears the GCT on the invoices you tick — no money is taken and nothing goes in the drawer. Each invoice defaults to the GCT still on it.'
        : mode === 'open'
        ? 'The payment comes off the balance now without being applied to any invoice. It can be applied to invoices later from this screen.'
        : 'Tick the invoices being paid. Each one defaults to its full balance due — change the amount for a part payment. The amount received is their sum; raise it if the customer paid more, and the rest stays on account as unapplied credit. Existing credit on the account is not used.'}</p>
      ${mode === 'invoices' ? `${this._rpInvoiceRows('rp')}<div style="text-align:right;font-size:12px;margin-top:6px">Applied: <strong id="rp-applied-total">${this.fmt(0)}</strong></div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:12px">
        <div class="form-group" style="margin:0"><label>${taxExempt ? 'GCT Cleared' : 'Amount Received *'}</label><input type="number" id="rp-amount" step="0.01" min="0" ${taxExempt ? 'readonly' : ''} oninput="App._rp.amountEdited = true; App._rpExtraNote()" placeholder="0.00">
          <div id="rp-extra-note" style="font-size:11px;margin-top:3px"></div></div>
        <div class="form-group" style="margin:0"><label>Paid By *</label><select id="rp-method" onchange="App._rpMethodChanged(true)">${methods.map(([v, l]) => `<option value="${v}" ${this._rp.method === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="form-group" style="margin:0" id="rp-ref-wrap"><label id="rp-ref-label">Reference</label><input id="rp-ref" placeholder="Optional for cash"></div>
      </div>
      <div class="form-group" style="margin:10px 0 0"><label>Notes</label><input id="rp-notes" placeholder="Optional"></div>
      ${summary.open_payments.length ? `
      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">
        <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase">Payments Waiting to Be Applied</strong>
        ${summary.open_payments.map(p => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span><span class="fw-600">${this.escapeAttr(p.payment_number)}</span> · ${this.fmtDate(p.created_at)} · ${this.fmt(p.amount)} paid, <span class="color-success fw-600">${this.fmt(p.unapplied)} not yet applied</span></span>
          ${summary.invoices.length ? `<button class="btn btn-secondary btn-sm" onclick="App._rpStartApply(${p.id})">Apply to Invoices</button>` : ''}
        </div>`).join('')}
        <div id="rp-apply"></div>
      </div>` : ''}`;
    this._rpMethodChanged();
    this._rpFooter(`<button class="btn btn-success" id="rp-submit" onclick="App._rpSubmit()">Receive Payment</button>`);
  },

  _rpSetMode(mode) {
    if (mode === 'open' && this._rp.method === 'tax_exempt') { this.alert('Tax Exempt clears the GCT on particular invoices — pick the invoices', 'warning'); return this._rpRender(); }
    this._rp.mode = mode; this._rpRender();
  },

  // Card, cheque and deposit payments need their approval / cheque / deposit number.
  _rpMethodChanged(fromSelect) {
    const m = document.getElementById('rp-method')?.value;
    // Switching to or from Tax Exempt redraws the form (invoice mode, GCT column).
    if (fromSelect && this._rp && (m === 'tax_exempt') !== (this._rp.method === 'tax_exempt')) {
      this._rp.method = m;
      if (m === 'tax_exempt') this._rp.mode = 'invoices';
      return this._rpRender();
    }
    if (this._rp && m) this._rp.method = m;
    const label = document.getElementById('rp-ref-label'), ref = document.getElementById('rp-ref');
    if (!label || !ref) return;
    const labels = { tax_exempt: ['Exemption Ref #', this._rp?.summary?.customer?.tax_exemption_number || 'Tax exemption reference'], cash: ['Reference', 'Optional for cash'], credit_card: ['Approval Code *', 'Card approval code'], debit_card: ['Approval Code *', 'Card approval code'], check: ['Cheque # *', 'Cheque number'], direct_deposit: ['Deposit Ref # *', 'Bank deposit reference'] };
    [label.textContent, ref.placeholder] = labels[m] || labels.cash;
  },

  async _rpSubmit() {
    const { summary, mode } = this._rp;
    const amount = parseFloat(document.getElementById('rp-amount').value) || 0;
    const payment_method = document.getElementById('rp-method').value;
    const reference = document.getElementById('rp-ref').value.trim();
    if (!(amount > 0)) { this.alert(mode === 'invoices' ? 'Tick at least one invoice to pay' : 'Enter the amount received', 'error'); return; }
    if (mode === 'invoices') {
      const applied = this._rpAllocations('rp').reduce((t, a) => t + a.amount, 0);
      if (!(applied > 0)) { this.alert('Tick at least one invoice to pay', 'error'); return; }
      if (applied - amount > 0.005) { this.alert(`The amount received is less than the ${this.fmt(applied)} applied to the invoices`, 'error'); return; }
      const extra = Math.round((amount - applied) * 100) / 100;
      if (extra > 0.005 && payment_method !== 'tax_exempt' && !confirm(`${this.fmt(applied)} goes to the invoices ticked and ${this.fmt(extra)} stays on the account as unapplied credit. Continue?`)) return;
    }
    if (payment_method !== 'cash' && payment_method !== 'tax_exempt' && !reference) { this.alert('Enter the approval code, cheque number or deposit reference', 'error'); return; }
    const btn = document.getElementById('rp-submit');
    if (btn) btn.disabled = true;
    try {
      const p = await this.api('POST', '/customer-payments', {
        customer_id: summary.customer.id, amount, payment_method, payment_mode: mode, reference,
        allocations: mode === 'invoices' ? this._rpAllocations('rp') : undefined,
        notes: document.getElementById('rp-notes').value.trim(), drawer_session_id: this.currentDrawerSession?.id || null,
        branch_id: this.currentDrawerSession?.branch_id || null,
      });
      this.closeModal();
      if (this.cartCustomer?.id === p.customer_id) this.setCartCustomer(p.customer_id);
      if (payment_method === 'tax_exempt') {
        this.alert(`${p.payment_number}: GCT of ${this.fmt(p.amount)} cleared (tax exempt) for ${p.customer_name}. Balance now ${this.fmt(p.balance_after)}.`);
        return;
      }
      this.alert(`Payment ${p.payment_number} received: ${this.fmt(p.amount)} from ${p.customer_name}${p.unapplied > 0.005 ? ' (on account)' : ''}. Balance now ${this.fmt(p.balance_after)}.`);
      this.showPaymentReceipt(p.id);
    } catch (e) { if (btn) btn.disabled = false; this.alert(e.message, 'error'); }
  },

  _rpStartApply(paymentId) {
    const p = this._rp.summary.open_payments.find(x => x.id === paymentId);
    this._rp.applying = p;
    document.getElementById('rp-apply').innerHTML = `
      <div style="margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:6px">
        <div style="font-size:13px;margin-bottom:6px">Apply up to <strong>${this.fmt(p.unapplied)}</strong> of ${this.escapeAttr(p.payment_number)} to:</div>
        ${this._rpInvoiceRows('rpa')}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:12px">
          <span>Applying: <strong id="rpa-applied-total">${this.fmt(0)}</strong></span>
          <span style="display:flex;gap:8px"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('rp-apply').innerHTML=''">Cancel</button>
          <button class="btn btn-primary btn-sm" id="rpa-submit" onclick="App._rpSubmitApply()">Apply</button></span>
        </div>
      </div>`;
  },

  async _rpSubmitApply() {
    const p = this._rp.applying;
    const allocations = this._rpAllocations('rpa');
    const total = allocations.reduce((t, a) => t + a.amount, 0);
    if (!allocations.length) { this.alert('Tick at least one invoice', 'error'); return; }
    if (total - p.unapplied > 0.005) { this.alert(`Only ${this.fmt(p.unapplied)} of ${p.payment_number} is left to apply`, 'error'); return; }
    const btn = document.getElementById('rpa-submit');
    if (btn) btn.disabled = true;
    try {
      await this.api('POST', `/customer-payments/${p.id}/apply`, { allocations });
      this.alert(`Applied ${this.fmt(total)} of ${p.payment_number} to ${allocations.length} invoice${allocations.length === 1 ? '' : 's'}`);
      this._rpLoad(this._rp.summary.customer.id, { mode: this._rp.mode });
    } catch (e) { if (btn) btn.disabled = false; this.alert(e.message, 'error'); }
  },

  // A ticket with a Q item (not in inventory) can't be paid for or put on
  // layaway at the till — it has to wait on Purchasing, so it goes to a
  // quotation; accepting the quote raises the Purchase Request. Returns true
  // (and explains, offering Create Quote) when the ticket is held up by one.
  _posQItemBlocksSale() {
    const q = this.cart.filter(i => i.is_q_item);
    if (!q.length) return false;
    const canQuote = this.can('quotations');
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">Q Item — Create a Quote</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="margin:0 0 10px">This ticket has ${q.length === 1 ? 'a Q item' : `${q.length} Q items`} — not in inventory, so ${q.length === 1 ? 'it has' : 'they have'} to be ordered first:</p>
          <ul style="margin:0 0 10px 18px;padding:0">${q.map(i => `<li>${this.escapeAttr(i.name)} × ${i.quantity}</li>`).join('')}</ul>
          <p style="font-size:13px;color:var(--text-muted);margin:0">It can't be paid for at the till. Create a quote for the customer instead — once they accept it, a Purchase Request goes to Purchasing, and the quote is recalled at the POS to complete the sale.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Back to Ticket</button>
          ${canQuote ? `<button class="btn btn-primary" onclick="App.closeModal();App.posCreateQuoteFromCart()">Create Quote</button>` : ''}
        </div>
      </div>`);
    return true;
  },

  showPOSPaymentModal() {
    if (!this.cart.length) { this.alert('Cart is empty', 'warning'); return; }
    if (this._posQItemBlocksSale()) return;
    // Available Credit and/or Cash Back already cover the whole ticket — no
    // cash/card/other tender is actually changing hands, so skip straight to
    // completing the sale instead of forcing a tender pick (previously the
    // only way through here was e.g. picking Cash and typing in "0").
    const { total } = this.getCartTotals();
    const hasStoreCredit = this._storeCreditApplied > 0;
    const hasCashBack = this._cashBackApplied > 0;
    if (total <= 0 && (hasStoreCredit || hasCashBack)) {
      const method = hasStoreCredit && hasCashBack ? 'available_credit_and_cash_back' : hasCashBack ? 'cash_back' : 'available_credit';
      const rows = [
        hasStoreCredit ? { label: 'Applied from Available Credit', amount: this._storeCreditApplied } : null,
        hasCashBack ? { label: 'Applied from Cash Back', amount: this._cashBackApplied } : null,
      ].filter(Boolean);
      const summary = hasStoreCredit && hasCashBack ? 'Available Credit and Cash Back together fully cover this ticket' : hasCashBack ? 'Cash Back fully covers this ticket' : 'Available Credit fully covers this ticket';
      this.showModal(`
        <div class="modal" style="max-width:420px">
          <div class="modal-header"><span class="modal-title">Payment</span><button class="modal-close">✕</button></div>
          <div class="modal-body">
            <p style="text-align:center;font-size:14px;color:var(--text-muted);margin-bottom:12px">${summary} — no additional tender needed.</p>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${rows.map(r => `<div style="text-align:center;background:var(--bg);border-radius:8px;padding:14px">
                <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">${r.label}</div>
                <div style="font-size:28px;font-weight:700;color:var(--success)">${this.fmt(r.amount)}</div>
              </div>`).join('')}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
            <button class="btn btn-primary" onclick="App.closeModal();App.processPayment('${method}')">Complete Sale</button>
          </div>
        </div>`);
      return;
    }
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">Payment</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="payment-btns" style="grid-template-columns:1fr 1fr 1fr;">
            <button class="pay-btn pay-cash" onclick="App.closeModal();App.processPayment('cash')"><span>💵</span> Cash<span>Exact / Change</span></button>
            <button class="pay-btn pay-credit-card" onclick="App.closeModal();App.processPayment('credit_card')"><span>💳</span> Credit Card<span>Credit</span></button>
            <button class="pay-btn pay-debit-card" onclick="App.closeModal();App.processPayment('debit_card')"><span>🏧</span> Debit Card<span>Debit</span></button>
            <button class="pay-btn pay-check" onclick="App.closeModal();App.processPayment('check')"><span>🏦</span> Check<span>Personal / Business</span></button>
            <button class="pay-btn" style="background:#9C27B0;color:#fff;" onclick="App.closeModal();App.processPayment('credit')"><span>🧾</span> Credit<span>Charge Account</span></button>
            <button class="pay-btn" style="background:#EC407A;color:#fff;" onclick="App.closeModal();App.processPayment('gift_card')"><span>🎁</span> Gift Card<span>Stored Value</span></button>
            <button class="pay-btn" style="background:#0277BD;color:#fff;" onclick="App.closeModal();App.processPayment('direct_deposit')"><span>🏛️</span> Direct Deposit<span>Bank Transfer</span></button>
            <button class="pay-btn pay-split" onclick="App.closeModal();App.processPayment('split')"><span>➗</span> Split Tender<span>Multiple Methods</span></button>
          </div>
        </div>
      </div>`);
  },

  // ─── Right-grid actions that act on the currently selected ticket row ────
  // (row selection itself is set by clicking a row — see renderCart()).

  // "C Item" — a comment line on the ticket: free text that prints on the
  // receipt/invoice (e.g. delivery instructions, a serial or colour note),
  // with no price, tax or stock. Goes in under the selected line, so it
  // reads as a note on that item; with nothing selected, at the end.
  showCommentItemModal(editIdx = null) {
    const editing = editIdx != null && this.cart[editIdx]?.is_comment;
    this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header"><span class="modal-title">${editing ? 'Edit Comment' : 'Add Comment (C Item)'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <textarea id="pos-comment-text" rows="4" style="width:100%" placeholder="e.g. Deliver to back gate — call 876-555-0100 on arrival">${editing ? this.escapeAttr(this.cart[editIdx].name) : ''}</textarea>
          <p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">Prints on the receipt and invoice as written. No price or tax.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveCommentItem(${editing ? editIdx : 'null'})">${editing ? 'Save' : 'Add to Ticket'}</button>
        </div>
      </div>`);
    setTimeout(() => document.getElementById('pos-comment-text')?.focus(), 50);
  },

  saveCommentItem(editIdx) {
    const text = (document.getElementById('pos-comment-text')?.value || '').trim();
    if (!text) { this.alert('Type the comment first', 'warning'); return; }
    if (editIdx != null && this.cart[editIdx]?.is_comment) {
      this.cart[editIdx].name = text;
    } else {
      const line = { product_id: null, is_comment: 1, name: text, price: 0, quantity: 1, tax_rate: 0, is_service: 0 };
      const at = this._selectedCartLine != null && this.cart[this._selectedCartLine] ? this._selectedCartLine + 1 : this.cart.length;
      this.cart.splice(at, 0, line);
      this._selectedCartLine = null;
    }
    this.closeModal();
    this.renderCart();
    document.getElementById('pos-item-input')?.focus();
  },

  // "Delivery" — a delivery charge on the ticket: description + price before
  // tax, taxed at the store rate (the server applies that rate itself — see
  // the is_delivery branch in routes/transactions.js). Always quantity 1.
  showDeliveryItemModal(editIdx = null) {
    const editing = editIdx != null && this.cart[editIdx]?.is_delivery;
    const line = editing ? this.cart[editIdx] : null;
    const rate = parseFloat(this.settings?.tax_rate) || 0;
    this.showModal(`
      <div class="modal" style="max-width:440px">
        <div class="modal-header"><span class="modal-title">${editing ? 'Edit Delivery' : 'Add Delivery'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="form-group"><label>Description</label><input id="pos-delivery-desc" value="${this.escapeAttr(line ? line.name : 'Delivery')}" placeholder="e.g. Delivery to Ocho Rios"></div>
          <div class="form-group" style="margin:0"><label>Price (before tax) *</label><input id="pos-delivery-price" type="number" min="0" step="0.01" value="${line ? line.price : ''}" placeholder="0.00"
            onkeydown="if(event.key==='Enter'){event.preventDefault();App.saveDeliveryItem(${editing ? editIdx : 'null'})}"></div>
          <p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">Tax is added on top at ${rate}%.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveDeliveryItem(${editing ? editIdx : 'null'})">${editing ? 'Save' : 'Add to Ticket'}</button>
        </div>
      </div>`);
    setTimeout(() => document.getElementById('pos-delivery-price')?.focus(), 50);
  },

  saveDeliveryItem(editIdx) {
    const name = (document.getElementById('pos-delivery-desc')?.value || '').trim() || 'Delivery';
    const priceVal = document.getElementById('pos-delivery-price')?.value;
    const price = parseFloat(priceVal);
    if (priceVal === '' || !(price >= 0)) { this.alert('Enter the delivery price (before tax)', 'warning'); return; }
    const rounded = Math.round(price * 100) / 100;
    if (editIdx != null && this.cart[editIdx]?.is_delivery) {
      Object.assign(this.cart[editIdx], { name, price: rounded });
    } else {
      this.cart.push({ product_id: null, is_delivery: 1, name, price: rounded, quantity: 1, tax_rate: parseFloat(this.settings?.tax_rate) || 0, is_service: 1 });
      this._selectedCartLine = null;
    }
    this.closeModal();
    this.renderCart();
    document.getElementById('pos-item-input')?.focus();
  },

  // "Q Item" (pos_q_item) — something not in inventory that Purchasing orders
  // for the customer: description, whole quantity and price before tax,
  // taxed at the store rate. The ticket can be held but not paid for — it
  // goes to a quote (Create Quote; see _posQItemBlocksSale), and accepting
  // the quote raises the Purchase Request.
  showQItemModal(editIdx = null) {
    const editing = editIdx != null && this.cart[editIdx]?.is_q_item;
    const line = editing ? this.cart[editIdx] : null;
    const rate = parseFloat(this.settings?.tax_rate) || 0;
    const save = `App.saveQItem(${editing ? editIdx : 'null'})`;
    this.showModal(`
      <div class="modal" style="max-width:460px">
        <div class="modal-header"><span class="modal-title">${editing ? 'Edit Q Item' : 'Add Q Item'}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">For something not in inventory. A ticket with a Q item can't be paid for at the till — use <strong>Create Quote</strong>. Once the customer accepts the quote, a Purchase Request goes to Purchasing to order it.</p>
          <div class="form-group"><label>Description *</label><input id="pos-qitem-desc" value="${this.escapeAttr(line ? line.name : '')}" placeholder="e.g. 3/4 inch brass gate valve, model GV-75"></div>
          <div style="display:flex;gap:10px">
            <div class="form-group" style="margin:0;width:110px"><label>Quantity *</label><input id="pos-qitem-qty" type="number" min="1" step="1" value="${line ? line.quantity : 1}"></div>
            <div class="form-group" style="margin:0;flex:1"><label>Price each (before tax) *</label><input id="pos-qitem-price" type="number" min="0" step="0.01" value="${line ? line.price : ''}" placeholder="0.00"
              onkeydown="if(event.key==='Enter'){event.preventDefault();${save}}"></div>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:6px 0 0">Tax is added on top at ${rate}%.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="${save}">${editing ? 'Save' : 'Add to Ticket'}</button>
        </div>
      </div>`);
    setTimeout(() => document.getElementById('pos-qitem-desc')?.focus(), 50);
  },

  saveQItem(editIdx) {
    const name = (document.getElementById('pos-qitem-desc')?.value || '').trim();
    const quantity = Number(document.getElementById('pos-qitem-qty')?.value);
    const priceVal = document.getElementById('pos-qitem-price')?.value;
    const price = parseFloat(priceVal);
    if (!name) { this.alert('Describe the item to order', 'warning'); return; }
    if (!Number.isInteger(quantity) || quantity < 1) { this.alert('Enter a whole quantity of 1 or more', 'warning'); return; }
    if (priceVal === '' || !(price >= 0)) { this.alert('Enter the price (before tax)', 'warning'); return; }
    const rounded = Math.round(price * 100) / 100;
    if (editIdx != null && this.cart[editIdx]?.is_q_item) {
      Object.assign(this.cart[editIdx], { name, quantity, price: rounded });
    } else {
      this.cart.push({ product_id: null, is_q_item: 1, name, price: rounded, quantity, tax_rate: parseFloat(this.settings?.tax_rate) || 0, is_service: 1 });
      this._selectedCartLine = null;
    }
    this.closeModal();
    this.renderCart();
    document.getElementById('pos-item-input')?.focus();
  },

  posItemZoom() {
    const idx = this._selectedCartLine;
    if (idx == null || !this.cart[idx]) { this.alert('Click a ticket line first', 'warning'); return; }
    const item = this.cart[idx];
    if (item.is_comment) { this.showCommentItemModal(idx); return; }
    if (item.is_delivery) { this.showDeliveryItemModal(idx); return; }
    if (item.is_q_item) { this.showQItemModal(idx); return; }
    if (!item.product_id) { this.alert('No catalog record for this line', 'warning'); return; }
    this.showProductCard(item.product_id);
  },

  posCustZoom() {
    if (!this.cartCustomer) { this.alert('No customer attached to this ticket', 'warning'); return; }
    this.viewCustomer(this.cartCustomer.id);
  },

  posQuantitySelectedLine() {
    const idx = this._selectedCartLine;
    if (idx == null || !this.cart[idx]) { this.alert('Click a ticket line first', 'warning'); return; }
    const item = this.cart[idx];
    const input = prompt(`New quantity for ${item.name}:`, item.quantity);
    if (input == null) return;
    this.setCartQty(idx, input);
  },

  // Sets a ticket line to a typed quantity — from the Quantity button's
  // prompt or straight into the quantity box on the line (both need
  // pos_change_quantity). 0 removes the line, like the − button. A rejected
  // entry re-renders the cart so the box goes back to the line's quantity.
  setCartQty(idx, input) {
    const item = this.cart[idx];
    if (!item) return;
    if (item.is_comment) { this.alert('A comment line has no quantity', 'warning'); return; }
    if (item.is_delivery) { this.alert('A delivery line is always 1 — add another Delivery for a second drop', 'warning'); this.renderCart(); return; }
    if (!this.can('pos_change_quantity')) { this.alert("You don't have permission to change quantities", 'error'); this.renderCart(); return; }
    // Measured units (yards, kg… — lib/units.js) take part quantities.
    const newQty = item.allow_decimal ? Math.round(parseFloat(input) * 1000) / 1000 : Number(input);
    if (String(input).trim() === '' || !Number.isFinite(newQty) || newQty < 0) { this.alert('Enter a valid quantity', 'error'); this.renderCart(); return; }
    if (!item.allow_decimal && !Number.isInteger(newQty)) { this.alert(`${item.name} is sold in whole units`, 'error'); this.renderCart(); return; }
    if (newQty === item.quantity) return;
    const before = item.quantity;
    this.updateCartQty(idx, newQty - item.quantity);
    // updateCartQty refuses (e.g. not enough stock) without re-rendering.
    if (this.cart[idx] === item && item.quantity === before) this.renderCart();
    document.getElementById('pos-item-input')?.focus();
  },

  posReprintTicket() {
    if (!this._lastReceiptTx) { this.alert('No completed sale to reprint yet this session', 'warning'); return; }
    this.showReceipt(this._lastReceiptTx, this._lastReceiptChange, this._lastReceiptCash);
  },

  posCancelTicket() {
    if (!this.cart.length) return;
    if (!confirm('Cancel this ticket? All items will be removed.')) return;
    this.clearCart();
  },

  // "Create Quote" grid button — opens the normal (unchanged) quote form,
  // then prefills it from the current ticket instead of leaving it blank.
  async posCreateQuoteFromCart() {
    await this.showQuoteForm();
    if (this.cartCustomer?.id) this._selectCustomerPicker('qt-cust', this.cartCustomer.id);
    if (this.posBranch?.id) { const el = document.getElementById('qt-branch'); if (el) el.value = this.posBranch.id; }
    if (this.cart.length) {
      document.getElementById('qt-item-0')?.remove();
      for (const item of this.cart) {
        if (item.is_comment) { this.addQuoteCommentItem({ product_name: item.name }); continue; }
        if (item.is_delivery) { this.addQuoteDeliveryItem({ product_name: item.name, unit_price: item.price }); continue; }
        // A Q item (or any line with no product) is a retail quote's Q line.
        if (!item.product_id) { this.addQuoteCustomItem({ product_name: item.name, quantity: item.quantity, unit_price: item.price }); continue; }
        if (item.variation_id) {
          // quotation_items has no variation_id/variation_name column —
          // encode the variant into the description instead of silently
          // collapsing the line to the base product.
          this.addQuoteCustomItem({ product_name: `${item.name} (${item.variation_name})`, quantity: item.quantity, unit_price: item.price });
        } else {
          this.addQuoteItem({ product_id: item.product_id, product_name: item.name, serial_number: item.serial_number || null, quantity: item.quantity, unit_price: item.price, uom_id: item.uom_id ?? null, sell_unit: item.sell_unit || null });
        }
      }
    }
  },

  // Quote form → "Special Project" / "Work Order" buttons (next to Retail /
  // Rental, permission-gated). Special Projects are a quote_type but need
  // the form opened in SP mode (cost/margin columns, Q items, Save Draft),
  // and Work Orders are a separate record with their own intake form — so
  // both reopen the right form and carry over what's already been entered.
  _quoteFormSnapshot() {
    const customer_id = document.getElementById('qt-cust')?.value || null;
    const branch_id = document.getElementById('qt-branch')?.value || null;
    const notes = document.getElementById('qt-notes')?.value || '';
    const items = [];
    document.querySelectorAll('#qt-items > [id^="qt-item-"]').forEach(row => {
      const idx = row.id.split('-').pop();
      const quantity = parseInt(document.getElementById(`qti-qty-${idx}`)?.value) || 1;
      const unit_price = parseFloat(document.getElementById(`qti-price-${idx}`)?.value) || 0;
      const prodSel = document.getElementById(`qti-prod-${idx}`);
      if (prodSel) {
        if (!prodSel.value) return;
        const prod = (this._quoteProducts || []).find(p => String(p.id) === String(prodSel.value));
        const snInp = document.getElementById(`qti-sn-${idx}`);
        items.push({ product_id: parseInt(prodSel.value), product_name: prod?.name, serial_number: snInp?.value.trim() || null, quantity, unit_price });
        return;
      }
      const desc = document.getElementById(`qti-desc-${idx}`)?.value.trim();
      if (desc) items.push({ product_name: desc, quantity, unit_price, is_delivery: row.dataset.delivery === '1' });
    });
    return { customer_id, branch_id, notes, items };
  },

  async _quoteSwitchToSpecialProject() {
    const snap = this._quoteFormSnapshot();
    await this.showQuoteForm(null, 'special_project');
    if (snap.customer_id) this._selectCustomerPicker('qt-cust', snap.customer_id);
    if (snap.branch_id) { const el = document.getElementById('qt-branch'); if (el) { el.value = snap.branch_id; el.onchange?.(); } }
    const notesEl = document.getElementById('qt-notes'); if (notesEl) notesEl.value = snap.notes;
    if (snap.items.length) {
      document.getElementById('qt-item-0')?.remove();
      for (const item of snap.items) item.product_id ? this.addQuoteItem(item) : item.is_delivery ? this.addQuoteDeliveryItem(item) : this.addQuoteCustomItem(item);
    }
  },

  async _quoteSwitchToWorkOrder() {
    const snap = this._quoteFormSnapshot();
    await this.showWOIntakeModal();
    if (snap.customer_id) this._selectCustomerPicker('wo-customer', snap.customer_id);
    const branchEl = document.getElementById('wo-branch');
    if (snap.branch_id && branchEl?.tagName === 'SELECT') branchEl.value = snap.branch_id;
    // Items don't map onto a work order (parts are added after assessment),
    // so the most useful carry-over is the first item as the tag label.
    const labelEl = document.getElementById('wo-item-label');
    if (labelEl && snap.items[0]?.product_name) labelEl.value = snap.items[0].product_name;
  },

  // "Create Layaway" grid button — opens the normal (unchanged) layaway
  // form at POS's actual branch, then prefills customer + whatever cart
  // items are layaway-eligible there (createLayawayPlan() itself, and
  // everything downstream — collections, cancellation — is untouched).
  async posCreateLayawayFromCart() {
    if (this._posQItemBlocksSale()) return;
    await this.showLayawayCheckoutModal();
    // Set only after the modal opens (which resets it to false itself) —
    // so an abandoned/cancelled POS-seeded attempt can't leak into clearing
    // the cart on some later, unrelated layaway created normally.
    this._layawayFromPOSCart = true;
    const branchSel = document.getElementById('lc-branch');
    if (branchSel && this.posBranch?.id) {
      branchSel.value = this.posBranch.id;
      await this._refreshLayawayCheckoutBranch();
    }
    if (this.cartCustomer?.id) this._selectLayawayCustomer(this.cartCustomer.id);
    const eligible = this.cart.filter(item => (this._layawayProducts || []).some(p => p.id === item.product_id));
    const skipped = this.cart.filter(i => !i.is_comment).length - eligible.length;
    if (eligible.length) {
      document.getElementById('layaway-line-0')?.remove();
      for (const item of eligible) {
        this.addLayawayLine();
        const idx = this._layawayLineIdx - 1;
        const qtyEl = document.getElementById(`ll-qty-${idx}`);
        if (qtyEl) qtyEl.value = item.quantity;
        // Sets the line's price/tax/stock data and label too — setting the
        // hidden input's value alone left the totals and deposit at $0.
        this._selectLayawayLineOption(idx, item.product_id);
        if (item.uom_id != null) { const u = document.getElementById(`ll-unit-${idx}`); if (u) { u.value = String(item.uom_id); this._recalcLayawayTotals(); } }
      }
      this._recalcLayawayTotals();
    }
    if (skipped > 0) this.alert(`${skipped} cart item(s) aren't eligible for layaway and were left out — add eligible items manually if needed.`, 'warning');
  },

  // ─── Tax-exempt override ──────────────────────────────────────────────
  // A per-ticket manual override, independent of the attached customer's
  // saved profile flag — for a one-off exemption (e.g. a walk-in government
  // or non-profit purchase) that shouldn't require editing that customer's
  // record. Wins over the customer flag when set; cleared per clearCart().
  isCartTaxExempt() { return !!(this._manualTaxExempt || this.cartCustomer?.tax_exempt); },
  cartTaxExemptionNumber() { return this._manualTaxExempt?.number || this.cartCustomer?.tax_exemption_number || null; },

  showTaxExemptModal() {
    this.showModal(`
      <div class="modal" style="max-width:380px">
        <div class="modal-header"><span class="modal-title">Tax Exempt Sale</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">Marks this ticket tax-exempt regardless of the customer's saved profile — for a one-off exemption (e.g. government/non-profit purchase). Leave blank to clear.</p>
          <div class="form-group"><label>Exemption Number (optional)</label>
            <input id="tx-exempt-number" value="${this.escapeAttr(this._manualTaxExempt?.number || '')}" placeholder="e.g. EX-12345">
          </div>
        </div>
        <div class="modal-footer">
          ${this._manualTaxExempt ? `<button class="btn btn-secondary" onclick="App._manualTaxExempt=null;App.closeModal();App.renderCart()">Clear</button>` : ''}
          <button class="btn btn-primary" onclick="App._manualTaxExempt={number:document.getElementById('tx-exempt-number').value.trim()||null};App.closeModal();App.renderCart()">Apply</button>
        </div>
      </div>`);
  },

  // Click-to-select a ticket row (highlighted green) — the only new
  // interaction, needed so the Quantity/Item Zoom grid buttons have
  // a target. Per-row inline controls (qty +/-, %, ×) stay fully
  // functional independent of selection — a click that lands on one of them
  // still fires its own handler as it bubbles, but is ignored here so it
  // doesn't also toggle row selection (checking the target rather than
  // stopping propagation on the whole cell, so clicking blank space in the
  // qty/actions columns still selects the row like everywhere else in it).
  selectCartLine(event, idx) {
    if (event.target.closest('button')) return;
    this._selectedCartLine = this._selectedCartLine === idx ? null : idx;
    this.renderCart();
  },

  renderProductGrid() {
    let products = this.allProducts;
    if (this.posCategory !== 'all') products = products.filter(p => String(p.category_id) === String(this.posCategory));
    if (this.posSearch) {
      const q = this.posSearch.toLowerCase();
      products = products.filter(p => (p.name || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode && p.barcode.toLowerCase().includes(q)));
    }

    const grid = document.getElementById('product-grid');
    if (!grid) return;
    if (!products.length) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><p>No products found</p></div>'; return; }
    // Drawing thousands of cards (with images) on every keystroke is what
    // made the lookup crawl — show the first matches and ask to narrow.
    const GRID_LIMIT = 120;
    const more = products.length - GRID_LIMIT;
    if (more > 0) products = products.slice(0, GRID_LIMIT);

    grid.innerHTML = products.map(p => {
      const hasVars = p.has_variations > 0;
      const oos = !hasVars && !p.is_service && p.stock_qty <= 0;
      const stockLabel = p.is_service
        ? `<span style="color:var(--accent);font-size:11px;font-weight:600">Service${p.unit ? ' · ' + p.unit : ''}</span>`
        : hasVars ? '<span style="color:var(--accent);font-size:11px;font-weight:600">▼ Select variant</span>'
        : (oos ? '⚠️ Out of stock' : `Stock: ${p.stock_qty}${p.base_unit_id ? ' ' + (p.base_unit_abbr || p.base_unit_name) : ''}`);
      const altUnits = this._unitChoices(p).filter(c => !c.isBase);
      const thumb = p.image_path ? `<img src="${p.image_path}" style="width:44px;height:44px;object-fit:cover;border-radius:4px;margin:0 auto 4px;display:block" alt="">` : `<div class="product-emoji">${this.productEmoji(p.category_name)}</div>`;
      return `<div class="product-card ${oos ? 'out-of-stock' : ''} ${hasVars ? 'has-vars' : ''}" onclick="App.addToCart(${p.id})">
        ${thumb}
        <div class="product-name">${p.name}${p.is_rental ? ' <span style="font-size:9px;background:#fff3e0;color:#e65100;padding:1px 5px;border-radius:3px;vertical-align:middle">RENTAL ITEM</span>' : ''}</div>
        ${p.sku ? `<div class="product-sku">SKU: ${this.escapeAttr(p.sku)}</div>` : ''}
        <div class="product-price">${this.fmt(p.price)}${p.base_unit_id ? ` <span style="font-size:11px;font-weight:400">/ ${this.escapeAttr(p.base_unit_abbr || p.base_unit_name)}</span>` : ''}</div>
        ${altUnits.length && !oos ? `<div title="You'll be asked which unit" style="margin:4px auto 2px;font-size:11px;font-weight:600;padding:2px 6px;border:1px solid var(--primary);color:var(--primary);border-radius:10px;display:inline-block">Also by ${altUnits.map(c => this.escapeAttr(c.label)).join(', ')}</div>` : ''}
        <div class="product-stock">${stockLabel}</div>
      </div>`;
    }).join('') + (more > 0 ? `<div style="grid-column:1/-1;padding:8px;text-align:center;font-size:12px;color:var(--text-muted)">${more} more — search or pick a category to narrow it down</div>` : '');
  },

  // The "SN" item (seeded server-side, see lib/serialNumber.js) exists only
  // to record a serial number on a ticket/quote — ring up the serialized
  // item, then add SN and key in its serial. Mirrors isSerialNumberProduct().
  _isSerialNumberProduct(p) {
    return !!p && String(p.sku || '').toUpperCase() === 'SN';
  },

  _promptSerialNumber(current = '') {
    for (;;) {
      const input = prompt('Enter serial number:', current);
      if (input == null) return null;
      // Serials are optional — a blank entry just adds no SN line.
      const serial = input.trim();
      if (!serial) return null;
      // An item number keyed or scanned at the serial prompt records
      // nothing useful — ask again (the server refuses it too).
      const clash = this._serialItemClash(serial);
      if (!clash) return serial;
      alert(`"${serial}" is the item number for ${clash.name}, not a serial number.\n\nEnter the serial printed on the product, or leave it blank to skip.`);
      current = '';
    }
  },

  // The catalog product whose item number or barcode equals `serial`
  // (other than the SN item itself), or null.
  _serialItemClash(serial) {
    const s = String(serial || '').trim().toLowerCase();
    if (!s) return null;
    return (this.allProducts || []).find(p => !this._isSerialNumberProduct(p) && ((p.sku || '').toLowerCase() === s || (p.barcode || '').toLowerCase() === s)) || null;
  },

  // Receipts/invoices/quotes show a serial-number line as a plain note under
  // the item it belongs to ("Serial: X") rather than a $0.00 item.
  _serialNote(i) {
    return `Serial: ${this.escapeAttr(i.serial_number)}`;
  },

  // Unit fields for a cart line recalled from a held ticket or quote line.
  _recalledUnitFields(item, product) {
    const choice = item.uom_id != null ? this._unitChoiceFor(product, item.uom_id) : null;
    return { uom_id: item.uom_id ?? null, sell_unit: item.sell_unit || null, units_per: item.units_per || 1, allow_decimal: choice?.allow_decimal ?? (product?.base_unit_decimal ? 1 : 0) };
  },

  // Stock units of a product already on the ticket, across all its unit lines.
  _cartStockUnits(productId, exceptIdx = -1) {
    return this.cart.reduce((n, i, idx) => n + (idx !== exceptIdx && i.product_id === productId && !i.variation_id ? i.quantity * (i.units_per || 1) : 0), 0);
  },

  // unit: a _unitChoices() entry (e.g. from a scanned unit barcode); when
  // left out, a product with alternate units asks which one.
  // qty: how many to add (typed as quantity*item in the item box) — whole
  // numbers unless the unit is a measured one (yards, kg…) or a service.
  async addToCart(productId, unit = null, qty = 1) {
    const product = this.allProducts.find(p => p.id === productId);
    if (!product) return;
    if (!unit && !this._isSerialNumberProduct(product) && !(product.has_variations > 0)) {
      unit = await this._pickUnit(product);
      if (!unit) return;
    }
    qty = Math.round(qty * 1000) / 1000;
    if (!Number.isInteger(qty) && !(product.is_service || unit?.allow_decimal)) { this.alert(`${product.name} is sold in whole units — enter a whole quantity`, 'warning'); return; }
    if (qty !== 1 && (this._isSerialNumberProduct(product) || product.has_variations > 0)) { this.alert(product.has_variations > 0 ? 'Pick the variant first, then use Quantity to change how many' : 'Each serial number is its own line', 'warning'); return; }
    const fmtQty = n => Math.round(n * 1000) / 1000;
    // A plain Each line takes the usual path below; anything with a named
    // unit (an alternate, or a stock unit like Foot) is its own line per unit.
    if (unit && (!unit.isBase || unit.label)) {
      const stockLeft = product.stock_qty - this._cartStockUnits(product.id);
      if (!product.is_service && unit.factor * qty > stockLeft) { this.alert(qty === 1 ? `Not enough stock for 1 ${unit.label || unit.name}` : `Not enough stock for ${qty} × ${unit.label || unit.name} — only ${fmtQty(stockLeft / unit.factor)} available`, 'warning'); return; }
      const line = this.cart.find(i => i.product_id === productId && !i.variation_id && (i.uom_id ?? null) === (unit.uom_id ?? null));
      if (line) line.quantity = fmtQty(line.quantity + qty);
      else this.cart.push({ product_id: product.id, category_id: product.category_id || null, name: this._unitLineName(product.name, unit), price: unit.price, cost: (product.cost || 0) * unit.factor, tax_rate: product.tax_rate, quantity: qty, is_service: 0, uom_id: unit.uom_id, sell_unit: unit.name, units_per: unit.factor, allow_decimal: unit.allow_decimal });
      this._checkAutoPromos();
      this._bundleUpsell(product.id);
      return;
    }
    if (this._isSerialNumberProduct(product)) {
      // Each serial is its own qty-1 line (never merged), placed after
      // whatever was just rung up so it reads as that item's serial.
      const serial = this._promptSerialNumber();
      if (!serial) return;
      this.cart.push({ product_id: product.id, category_id: product.category_id || null, name: `SN: ${serial}`, serial_number: serial, price: product.price, tax_rate: product.tax_rate, quantity: 1, is_service: 1 });
      this._checkAutoPromos();
      return;
    }
    if (product.has_variations > 0) { this.showVariationPicker(product); return; }
    if (!product.is_service) {
      if (product.stock_qty <= 0) return;
      const stockLeft = product.stock_qty - this._cartStockUnits(product.id);
      if (qty > stockLeft) { this.alert(qty === 1 ? 'Not enough stock' : `Not enough stock for ${qty} — only ${fmtQty(Math.max(0, stockLeft))} available`, 'warning'); return; }
    }
    const existing = this.cart.find(i => i.product_id === productId && !i.variation_id && !i.sell_unit && !i.uom_id);
    if (existing) {
      existing.quantity = fmtQty(existing.quantity + qty);
    } else {
      this.cart.push({ product_id: product.id, category_id: product.category_id || null, name: product.name, price: product.price, cost: product.cost, tax_rate: product.tax_rate, quantity: qty, is_service: product.is_service || 0, ...(product.is_service ? { allow_decimal: 1 } : {}) });
    }
    this._checkAutoPromos();
    this._bundleUpsell(product.id);
  },

  // ── Bundle upsell ─────────────────────────────────────────────
  // When an item that's part of an active bundle promotion (no code needed —
  // those apply at checkout by themselves) goes on the ticket, a card beside
  // the cart says so: the bundle, its price or saving, which pieces are
  // already on the ticket, and Add the rest. It doesn't take focus, so the
  // scanner keeps working, and each bundle is offered once per ticket — not
  // again once dismissed or once the ticket holds a complete set.
  async _bundleUpsell(productId) {
    if (this.section !== 'pos' || this._bundleAdding || !productId) return;
    this._bundleSeen ||= new Set();
    this._bundleCache ||= {};
    let bundles;
    const hit = this._bundleCache[productId];
    if (hit && Date.now() - hit.at < 60000) bundles = hit.data;
    else {
      try { bundles = await this.api('GET', `/promotions/bundles-for/${productId}`); } catch (e) { return; }
      this._bundleCache[productId] = { at: Date.now(), data: bundles };
    }
    if (this.section !== 'pos') return;
    const offer = (bundles || []).filter(b => !this._bundleSeen.has(b.id) && this._bundleMissing(b).some(m => m.missing > 0));
    if (!offer.length) return;
    this._showBundleUpsell(offer, productId);
  },

  // Each component with how many the ticket has toward one more set, counted
  // the way checkout counts them (computeBundleDiscount in lib/promotions.js:
  // line quantity, lines with their own discount don't count).
  _bundleMissing(b) {
    const have = {};
    for (const i of this.cart) {
      if (!i.product_id || i.is_q_item || i.serial_number || this._cartLineDiscountPct(i) > 0) continue;
      have[i.product_id] = (have[i.product_id] || 0) + (Number(i.quantity) || 0);
    }
    // Sets already complete stay complete; offer the next one only if this item started it.
    const sets = Math.min(...b.components.map(c => Math.floor((have[c.product_id] || 0) / c.quantity)));
    return b.components.map(c => {
      const toward = (have[c.product_id] || 0) - sets * c.quantity;
      return { ...c, have: Math.max(0, Math.min(c.quantity, toward)), missing: Math.max(0, c.quantity - Math.max(0, toward)) };
    });
  },

  _showBundleUpsell(bundles, productId) {
    this._closeBundleUpsell();
    this._bundleOffer = bundles;
    const trigger = (this.allProducts || []).find(p => p.id === productId);
    const card = document.createElement('div');
    card.id = 'bundle-upsell';
    card.setAttribute('role', 'status');
    card.style.cssText = 'position:fixed;bottom:150px;right:20px;width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 160px);overflow:auto;z-index:950;background:var(--card-bg,#fff);color:var(--text);border:2px solid var(--primary);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:14px 16px';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
        <div><div style="font-size:12px;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:.04em">🎁 Bundle offer</div>
          <div style="font-size:13px;color:var(--text-muted)">${this.escapeAttr(trigger?.name || 'This item')} is part of ${bundles.length > 1 ? `${bundles.length} bundles` : 'a bundle'} — suggest it to the customer</div></div>
        <button class="btn btn-sm btn-outline" title="Close" onclick="App._dismissBundleUpsell()">✕</button>
      </div>
      ${bundles.map((b, bi) => {
        const lines = this._bundleMissing(b);
        const missing = lines.filter(l => l.missing > 0);
        const extra = missing.reduce((s, l) => s + l.missing * l.price, 0);
        const deal = b.bundle_pricing === 'price' ? `Bundle price <strong>${this.fmt(b.set_price)}</strong>` : `<strong>${b.value}% off</strong> the set`;
        return `<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
          <div class="fw-600" style="font-size:15px">${this.escapeAttr(b.name)}</div>
          ${b.description ? `<div style="font-size:12px;color:var(--text-muted)">${this.escapeAttr(b.description)}</div>` : ''}
          <div style="font-size:13px;margin:4px 0 8px">${deal} · regular ${this.fmt(b.regular_price)}${b.saving > 0 ? ` · <span style="color:var(--success);font-weight:700">customer saves ${this.fmt(b.saving)}</span>` : ''}</div>
          <table style="width:100%;font-size:13px;border-collapse:collapse">
            ${lines.map(l => `<tr>
              <td style="padding:3px 0;width:22px">${l.missing ? '<span style="color:var(--text-muted)">○</span>' : '<span style="color:var(--success);font-weight:700">✓</span>'}</td>
              <td style="padding:3px 0">${l.quantity > 1 ? `${l.quantity} × ` : ''}${this.escapeAttr(l.name)}${l.missing && l.stock_qty < l.missing ? ' <span class="badge-pill badge-danger" style="font-size:10px">low stock</span>' : ''}</td>
              <td style="padding:3px 0;text-align:right;color:var(--text-muted);white-space:nowrap">${l.missing ? `need ${l.missing}` : 'on ticket'}</td>
            </tr>`).join('')}
          </table>
          ${b.min_purchase > 0 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Applies on tickets of ${this.fmt(b.min_purchase)} or more.</div>` : ''}
          ${b.end_date ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Ends ${this.fmtDate(b.end_date)}.</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-sm btn-success" style="flex:1" onclick="App._addBundleRest(${bi})">Add the rest${extra > 0 ? ` (+${this.fmt(extra)} before saving)` : ''}</button>
          </div>
        </div>`;
      }).join('')}
      <div style="text-align:right;margin-top:10px"><button class="btn btn-sm btn-secondary" onclick="App._dismissBundleUpsell()">No thanks</button></div>`;
    document.body.appendChild(card);
    this._placeBundleUpsell();
    if (!this._bundleResizeHooked) { this._bundleResizeHooked = true; window.addEventListener('resize', () => this._placeBundleUpsell()); }
  },

  // Sits in the bottom-right of the ticket lines — the empty space while
  // ringing up — clear of the item box, button grid and totals.
  _placeBundleUpsell() {
    const card = document.getElementById('bundle-upsell');
    const wrap = document.querySelector('.pos-ticket-table-wrap');
    if (!card || !wrap) return;
    const r = wrap.getBoundingClientRect();
    if (r.width < 300 || r.height < 200) return; // narrow/phone layout: keep the default corner
    card.style.right = `${Math.max(8, window.innerWidth - r.right + 12)}px`;
    card.style.bottom = `${Math.max(8, window.innerHeight - r.bottom + 12)}px`;
    card.style.width = `${Math.min(380, r.width - 24)}px`;
    card.style.maxHeight = `${Math.max(200, r.height - 24)}px`;
  },

  _closeBundleUpsell() { document.getElementById('bundle-upsell')?.remove(); this._bundleOffer = null; },

  // No thanks / ✕: don't offer these bundles again on this ticket.
  _dismissBundleUpsell() {
    for (const b of this._bundleOffer || []) (this._bundleSeen ||= new Set()).add(b.id);
    this._closeBundleUpsell();
  },

  async _addBundleRest(idx) {
    const b = (this._bundleOffer || [])[idx];
    if (!b) return;
    const skipped = [];
    this._bundleAdding = true;
    try {
      for (const l of this._bundleMissing(b)) {
        if (!l.missing) continue;
        const p = (this.allProducts || []).find(x => x.id === l.product_id);
        // Items that need a choice at the till (variant, serial number) are left for the cashier.
        if (!p || p.has_variations > 0 || this._isSerialNumberProduct(p)) { skipped.push(l.name); continue; }
        const before = this._cartStockUnits(p.id);
        await this.addToCart(p.id, this._unitChoices(p)[0], l.missing);
        if (this._cartStockUnits(p.id) === before) skipped.push(l.name);
      }
    } finally { this._bundleAdding = false; }
    (this._bundleSeen ||= new Set()).add(b.id);
    this._closeBundleUpsell();
    this.renderCart();
    if (skipped.length) this.alert(`Add ${skipped.join(', ')} yourself — ${skipped.length > 1 ? 'they need' : 'it needs'} a variant, serial number or more stock`, 'warning');
    else this.alert(`${b.name} added — the bundle discount applies at checkout`);
    setTimeout(() => document.getElementById('pos-item-input')?.focus(), 0);
  },

  removeFromCart(idx) {
    this.cart.splice(idx, 1);
    this._checkAutoPromos();
  },

  updateCartQty(idx, delta) {
    const item = this.cart[idx];
    if (!item) return;
    const newQty = Math.round((item.quantity + delta) * 1000) / 1000;
    if (item.serial_number && newQty > 1) { this.alert('Each SN line holds one serial number — add SN again for another', 'warning'); return; }
    if (newQty <= 0) { this.cart.splice(idx, 1); }
    else {
      const stockLimit = item.variation_id ? (item.stock_qty ?? Infinity) : (this.allProducts.find(p => p.id === item.product_id)?.stock_qty ?? Infinity);
      // Stock is in the stock unit — count every line of this product (quantity × unit size).
      const needed = item.variation_id ? newQty : this._cartStockUnits(item.product_id, idx) + newQty * (item.units_per || 1);
      if (needed > stockLimit) { this.alert('Not enough stock', 'warning'); return; }
      item.quantity = newQty;
    }
    this._checkAutoPromos();
  },

  applyDiscount() {
    if (this.appliedDiscountCard) { this.alert(`This customer already has a ${(this.appliedDiscountCard.label || 'Discount Card').toLowerCase()} applied — remove the customer to use a manual discount instead.`, 'error'); return; }
    let val = parseFloat(document.getElementById('discount-input')?.value) || 0;
    const maxPct = parseFloat(this.settings.max_discount_pct) || 0;
    // A percentage is of the ticket (after line discounts) and is kept as a
    // percentage, so the amount follows the ticket as it changes.
    if (document.getElementById('discount-type')?.value === 'percent') {
      let pct = Math.min(100, Math.max(0, val));
      if (maxPct > 0 && pct > maxPct) {
        pct = maxPct;
        document.getElementById('discount-input').value = String(pct);
        this.alert(`Discount capped at ${maxPct}%`, 'warning');
      }
      this._manualTicketDiscountPct = pct > 0 ? pct : null;
      val = this._manualPctDiscount();
    } else {
      this._manualTicketDiscountPct = null;
    }
    if (!this._manualTicketDiscountPct && maxPct > 0 && val > 0) {
      const subtotal = this.cart.reduce((s, i) => s + i.price * i.quantity, 0);
      const maxAllowed = parseFloat((subtotal * maxPct / 100).toFixed(2));
      if (val > maxAllowed) {
        val = maxAllowed;
        document.getElementById('discount-input').value = val.toFixed(2);
        this.alert(`Discount capped at ${maxPct}% (${this.fmt(maxAllowed)})`, 'warning');
      }
    }
    this.cartDiscount = val;
    this._manualTicketDiscount = val > 0;
    if (!(val > 0)) this._manualTicketDiscountPct = null;
    if (val > 0) {
      // A manual discount replaces an automatic promotion.
      this.autoAppliedPromo = null;
      const pd = document.getElementById('promo-display');
      if (pd) { pd.style.display = 'none'; pd.innerHTML = ''; }
    }
    document.getElementById('discount-display').textContent = val > 0 ? `-${this.fmt(val)}${this._manualTicketDiscountPct ? ` (${this._manualTicketDiscountPct}%)` : ''}` : '';
    if (val > 0) this.renderCart(); else this._checkAutoPromos();
  },

  // Dollar amount of a percentage Ticket Discount on the ticket as it is now
  // (after line discounts).
  _manualPctDiscount() {
    const net = this.cart.reduce((s, i) => s + this._cartLineNet(i), 0);
    return parseFloat((net * (this._manualTicketDiscountPct || 0) / 100).toFixed(2));
  },

  async applyPromoCode() {
    if (this.appliedDiscountCard) { this.alert(`This customer already has a ${(this.appliedDiscountCard.label || 'Discount Card').toLowerCase()} applied — promo codes can't be combined with it.`, 'error'); return; }
    const code = document.getElementById('promo-code-input')?.value?.trim();
    if (!code) return;
    const subtotal = this.cart.reduce((s, i) => s + i.price * i.quantity, 0);
    const cartItems = this.cart.map(i => ({ product_id: i.product_id, category_id: i.category_id, price: i.price, quantity: i.quantity, discount_percent: this._cartLineDiscountPct(i) }));
    try {
      const result = await this.api('POST', '/promotions/validate-code', { code, subtotal, cart_items: cartItems });
      this.appliedPromoCode = result;
      this.cartDiscount = result.discount_amount;
      this._manualTicketDiscount = false; this._manualTicketDiscountPct = null;
      const di = document.getElementById('discount-input');
      if (di) di.value = '';
      document.getElementById('discount-display').textContent = '';
      const pd = document.getElementById('promo-display');
      pd.textContent = `✓ ${result.promo_name}: -${this.fmt(result.discount_amount)}`;
      pd.style.display = 'block';
      document.getElementById('remove-promo-btn').style.display = '';
      this.renderCart();
    } catch (e) { this.alert(e.message, 'error'); }
  },

  removePromoCode() {
    this.appliedPromoCode = null;
    this.cartDiscount = 0;
    const pi = document.getElementById('promo-code-input');
    if (pi) pi.value = '';
    const pd = document.getElementById('promo-display');
    if (pd) { pd.style.display = 'none'; pd.textContent = ''; }
    document.getElementById('remove-promo-btn').style.display = 'none';
    this._checkAutoPromos();
  },

  // Recomputes the flat $ discount from a customer's active discount card
  // percentage against the current cart subtotal — the card mirrors what
  // _checkAutoPromos does for promotions, just percent-of-subtotal only
  // (no item/category scoping), and it wins over any promo automatically
  // since a card and a promo can never both be active (see setCartCustomer).
  _updateDiscountCardUI() {
    const row = document.getElementById('promo-row');
    const discountRow = document.getElementById('discount-row');
    const pd = document.getElementById('promo-display');
    if (this.appliedDiscountCard) {
      // cartDiscount must be computed unconditionally, not just when the
      // Ticket Discount modal happens to be open (promo-display etc. only
      // exist in that modal's markup) — otherwise attaching a discount-card
      // or customer-category customer wouldn't actually reduce the visible
      // total/Amount Due until the cashier opened that modal at least once.
      const subtotal = this.cart.reduce((s, i) => s + i.price * i.quantity, 0);
      this.cartDiscount = parseFloat((subtotal * this.appliedDiscountCard.percent / 100).toFixed(2));
      if (row) row.style.display = 'none';
      if (discountRow) discountRow.style.display = 'none';
      if (pd) {
        pd.innerHTML = `✓ ${this.appliedDiscountCard.type_name} ${this.appliedDiscountCard.label || 'Discount Card'}${this.appliedDiscountCard.card_number ? ` (${this.appliedDiscountCard.card_number})` : ''}: -${this.fmt(this.cartDiscount)}`;
        pd.style.display = 'block';
      }
      const rb = document.getElementById('remove-promo-btn');
      if (rb) rb.style.display = 'none';
    } else {
      if (row) row.style.display = '';
      if (discountRow) discountRow.style.display = '';
    }
  },

  // What a held ticket's discount was, so Hold Recall can put it back the
  // same way (routes/transactions.js POST /hold stores it).
  _ticketDiscountSource() {
    if (!(this.cartDiscount > 0)) return {};
    if (this.appliedDiscountCard) return { discount_source: 'card' };
    if (this.appliedPromoCode) return { discount_source: 'promo_code', promotion_code: this.appliedPromoCode.code, promotion_name: this.appliedPromoCode.promo_name };
    if (this.autoAppliedPromo && !this._manualTicketDiscount) return { discount_source: 'auto_promo', promotion_name: this.autoAppliedPromo.name };
    return { discount_source: 'manual', ticket_discount_percent: this._manualTicketDiscountPct || null };
  },

  // Hold Recall: the customer's discount card / category discount wins (as it
  // does at the till); otherwise the held promo code is re-applied, a manual
  // discount comes back as the same amount, and automatic promotions are
  // re-checked. A hold from before discount_source existed keeps its amount.
  async _restoreHeldTicketDiscount(held, customer) {
    this.appliedPromoCode = null;
    this.autoAppliedPromo = null;
    this._availablePromos = [];
    this._manualTicketDiscount = false; this._manualTicketDiscountPct = null;
    this.cartDiscount = 0;
    this.appliedDiscountCard = customer ? this._customerDiscountCard(customer) : null;
    const amount = parseFloat(held.discount_amount || 0);
    const source = held.discount_source || (amount > 0 ? 'manual' : null);
    if (this.appliedDiscountCard) { this._updateDiscountCardUI(); return; }
    if (source === 'promo_code' && held.promotion_code) {
      try {
        const subtotal = this.cart.reduce((s, i) => s + i.price * i.quantity, 0);
        const cart_items = this.cart.map(i => ({ product_id: i.product_id, category_id: i.category_id, price: i.price, quantity: i.quantity, discount_percent: this._cartLineDiscountPct(i) }));
        const result = await this.api('POST', '/promotions/validate-code', { code: held.promotion_code, subtotal, cart_items });
        this.appliedPromoCode = result;
        this.cartDiscount = result.discount_amount;
        return;
      } catch (e) {
        // No longer valid (expired, used up) — keep what the customer was
        // given when the ticket was held, as a manual discount.
        this.alert(`Promo code ${held.promotion_code} no longer applies (${e.message}) — kept the ${this.fmt(amount)} discount from the held ticket`, 'warning');
        this.cartDiscount = amount;
        this._manualTicketDiscount = true;
        return;
      }
    }
    if (source === 'manual') {
      this._manualTicketDiscount = amount > 0;
      this._manualTicketDiscountPct = amount > 0 && held.ticket_discount_percent > 0 ? held.ticket_discount_percent : null;
      this.cartDiscount = this._manualTicketDiscountPct ? this._manualPctDiscount() : amount;
      return;
    }
    await this._checkAutoPromos();
  },

  async _checkAutoPromos() {
    const seq = this._autoPromoSeq = (this._autoPromoSeq || 0) + 1;
    // An exchange's return credit is money the customer already paid — it
    // stays the ticket's discount whatever goes on the replacement ticket.
    if (this._returnCredit) { this.cartDiscount = this._returnCredit.amount; this.renderCart(); return; }
    if (this.appliedDiscountCard) { this._updateDiscountCardUI(); this.renderCart(); return; }
    if (this.appliedPromoCode) { this.renderCart(); return; }
    // A manual Ticket Discount stays as entered when the ticket changes —
    // automatic promotions don't overwrite it (clear it to let them apply).
    if (this._manualTicketDiscount && this.cartDiscount > 0 && this.cart.length) {
      if (this._manualTicketDiscountPct) this.cartDiscount = this._manualPctDiscount();
      this.renderCart();
      return;
    }
    if (!this.cart.length) {
      this._manualTicketDiscount = false; this._manualTicketDiscountPct = null;
      this.autoAppliedPromo = null;
      this._availablePromos = [];
      this.cartDiscount = 0;
      this.renderCart();
      return;
    }
    const subtotal = this.cart.reduce((s, i) => s + i.price * i.quantity, 0);
    const cartItems = this.cart.map(i => ({ product_id: i.product_id, category_id: i.category_id, price: i.price, quantity: i.quantity, discount_percent: this._cartLineDiscountPct(i) }));
    // Show the line straight away; the promo lookup is a server round trip
    // and only adjusts the discount. When items go in faster than it
    // answers, only the latest cart's answer is applied.
    this.renderCart();
    try {
      const promos = await this.api('POST', '/promotions/auto-apply', { cart_items: cartItems, subtotal });
      if (seq !== this._autoPromoSeq) return;
      this._availablePromos = promos || [];
      if (this._availablePromos.length > 0) {
        const best = this._availablePromos[0];
        this.autoAppliedPromo = best;
        this.cartDiscount = best.discount_amount;
        const pd = document.getElementById('promo-display');
        if (pd) {
          const changeBtn = this._availablePromos.length > 1
            ? ` <button class="btn btn-sm" onclick="App._showPromoPickerDropdown()" style="font-size:11px;padding:2px 8px;margin-left:6px">${this._availablePromos.length} promos ▼</button>`
            : '';
          pd.innerHTML = `✓ ${best.name}: -${this.fmt(best.discount_amount)}${changeBtn}`;
          pd.style.display = 'block';
        }
        const rb = document.getElementById('remove-promo-btn');
        if (rb) rb.style.display = 'none';
      } else {
        this.autoAppliedPromo = null;
        this._availablePromos = [];
        this.cartDiscount = 0;
        const pd = document.getElementById('promo-display');
        if (pd) { pd.style.display = 'none'; pd.innerHTML = ''; }
      }
    } catch(e) {}
    this.renderCart();
  },

  _showPromoPickerDropdown() {
    const promos = this._availablePromos || [];
    if (!promos.length) return;
    this.showModal(`
      <div class="modal" style="max-width:380px">
        <div class="modal-header">
          <span class="modal-title">Select Promotion</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body" style="padding:8px">
          ${promos.map(p => `
            <button class="btn btn-outline" style="width:100%;text-align:left;margin-bottom:8px;padding:10px 14px;${this.autoAppliedPromo?.id===p.id?'border-color:var(--primary);background:var(--primary-light,#e8f4fd)':''}" onclick="App._selectAutoPromo(${p.id})">
              <div class="fw-600">${p.name}</div>
              <div style="font-size:12px;color:var(--text-muted)">${p.type==='percentage'?p.value+'% off':this.fmt(p.value)+' off'} · saves ${this.fmt(p.discount_amount)}</div>
            </button>`).join('')}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button></div>
      </div>`);
  },

  _selectAutoPromo(promoId) {
    const promo = (this._availablePromos || []).find(p => p.id === promoId);
    if (!promo) return;
    this.autoAppliedPromo = promo;
    this.cartDiscount = promo.discount_amount;
    const pd = document.getElementById('promo-display');
    if (pd) {
      const changeBtn = this._availablePromos.length > 1
        ? ` <button class="btn btn-sm" onclick="App._showPromoPickerDropdown()" style="font-size:11px;padding:2px 8px;margin-left:6px">${this._availablePromos.length} promos ▼</button>`
        : '';
      pd.innerHTML = `✓ ${promo.name}: -${this.fmt(promo.discount_amount)}${changeBtn}`;
      pd.style.display = 'block';
    }
    this.closeModal();
    this.renderCart();
  },

  // The ticket's Salesperson dropdown: active salespeople (fetched once per
  // POS visit), with the cashier as the default blank choice.
  async _loadPOSSalespeople() {
    try { this._posSalespeople = await this.api('GET', '/sales-targets/salespeople'); } catch (e) { this._posSalespeople = []; }
    this._renderTicketSalesperson();
  },

  _renderTicketSalesperson() {
    const sel = document.getElementById('pos-salesperson');
    if (!sel) return;
    // The customer's assigned salesperson owns the sale. Otherwise a ticket
    // started by a Salesperson — a hold they put up, their quote, or one
    // they're ringing up themselves — is theirs. Either way the cashier can't
    // hand it to someone else (the server applies the same rule, see
    // ticketSalesperson in routes/transactions.js).
    const initiatorId = this._ticketCreatedBy || this.currentUser?.id;
    const owner = (this._posSalespeople || []).find(sp => sp.id === this.cartCustomer?.salesperson_id);
    const initiator = owner || (this._posSalespeople || []).find(sp => sp.id === initiatorId);
    sel.disabled = !!initiator;
    sel.title = owner ? `This customer's salesperson — the sale is credited to them` : initiator ? `Started by ${`${initiator.first_name} ${initiator.last_name}`.trim()} — the sale is credited to them` : '';
    if (initiator) {
      sel.innerHTML = `<option value="${initiator.id}">${this.escapeAttr(`${initiator.first_name} ${initiator.last_name}`.trim())}</option>`;
      sel.value = String(initiator.id);
      return;
    }
    const list = [...(this._posSalespeople || [])];
    // A recalled hold's salesperson stays shown even if no longer flagged.
    if (this._ticketSalesperson && !list.some(s => s.id === this._ticketSalesperson)) list.push({ id: this._ticketSalesperson, first_name: this._ticketSalespersonName || `Employee #${this._ticketSalesperson}`, last_name: '' });
    sel.innerHTML = sel.options[0].outerHTML + list.map(s => `<option value="${s.id}">${this.escapeAttr(`${s.first_name} ${s.last_name}`.trim())}</option>`).join('');
    sel.value = this._ticketSalesperson ? String(this._ticketSalesperson) : '';
  },

  _renderTicketPoNumber() {
    const el = document.getElementById('pos-po-number');
    if (el) el.value = this._ticketPoNumber || '';
  },

  clearCart() {
    this._bundleSeen = new Set(); this._closeBundleUpsell();
    this._ticketPoNumber = null;
    this.cart = []; this.cartCustomer = null; this.cartDiscount = 0; this._storeCreditApplied = 0; this._cashBackApplied = 0; this.appliedPromoCode = null; this.autoAppliedPromo = null; this._availablePromos = []; this._returnCredit = null; this._activeQuoteId = null; this._ticketCreatedBy = null; this._ticketSalesperson = null; this.appliedDiscountCard = null; this._manualTaxExempt = null; this._manualTicketDiscount = false; this._manualTicketDiscountPct = null;
    this.renderCart();
    const aqBar = document.getElementById('active-quote-bar');
    if (aqBar) aqBar.style.display = 'none';
    this._renderCartCustomer();
    this._renderTicketSalesperson();
    this._renderTicketPoNumber();
    const di = document.getElementById('discount-input');
    if (di) di.value = '';
    const dd = document.getElementById('discount-display');
    if (dd) dd.textContent = '';
    const pi = document.getElementById('promo-code-input');
    if (pi) pi.value = '';
    const pd = document.getElementById('promo-display');
    if (pd) { pd.style.display = 'none'; pd.textContent = ''; }
    const rb = document.getElementById('remove-promo-btn');
    if (rb) rb.style.display = 'none';
    this._updateDiscountCardUI();
  },

  // Quoted prices (mirrors POST /transactions): a catalog line rung up from a
  // quote that's still valid is charged the quoted price, up to the quoted
  // quantity; past expiry, or once more are rung up than were quoted, it's
  // today's catalog price. Sets quoted_price / quoted_qty / catalog_price on
  // the line (left off when the quote has expired).
  _quoteStillValid(validUntil) {
    return !validUntil || String(validUntil).slice(0, 10) >= this._storeDay(new Date());
  },
  _quotedLineFields(storedLine, product, valid) {
    const catalog = product ? (this._unitChoiceFor(product, storedLine.uom_id)?.price ?? Number(product.price) ?? 0) : parseFloat(storedLine.unit_price);
    const quoted = parseFloat(storedLine.unit_price);
    if (!valid) return { price: catalog };
    return { price: quoted, quoted_price: quoted, quoted_qty: Number(storedLine.quantity) || 0, catalog_price: catalog };
  },
  _applyQuotedPrices() {
    for (const i of this.cart) {
      if (i.quoted_price == null) continue;
      i.price = i.quantity <= i.quoted_qty + 1e-9 ? i.quoted_price : i.catalog_price;
    }
  },

  renderCart() {
    this._renderTicketSalesperson();
    const list = document.getElementById('cart-items-list');
    const totals = document.getElementById('cart-totals');
    if (!list || !totals) return;
    this._applyQuotedPrices();

    if (!this.cart.length) {
      // list is a <tbody> in the kiosk ticket table — a row, not a bare div.
      list.innerHTML = '<tr><td colspan="7" class="empty-state" style="padding:24px;border:none">Cart is empty — scan or type an item number to begin.</td></tr>';
      totals.innerHTML = '';
      this._selectedCartLine = null;
      return;
    }

    const isExempt = this.isCartTaxExempt();
    const showMargin = !!this.currentUser?.permissions?.pos_view_margin;
    const { lineTaxes, lineShares } = this.getCartTotals();
    const canTypeQty = this.can('pos_change_quantity');
    list.innerHTML = this.cart.map((item, idx) => {
      if (item.is_comment) return `
      <tr class="pos-ticket-row${this._selectedCartLine === idx ? ' selected' : ''}" onclick="App.selectCartLine(event,${idx})" ondblclick="App.showCommentItemModal(${idx})" title="Comment line — double-click to edit">
        <td><span class="badge-pill badge-info" style="font-size:10px">C</span></td>
        <td colspan="5" style="font-style:italic;white-space:pre-wrap;color:var(--text-muted)">${this.escapeAttr(item.name)}</td>
        <td style="white-space:nowrap"><button class="btn-remove" onclick="event.stopPropagation();App.removeFromCart(${idx})">×</button></td>
      </tr>`;
      if (item.is_delivery) {
        const lineShare = lineShares[idx], lineTax = lineTaxes[idx];
        return `
      <tr class="pos-ticket-row${this._selectedCartLine === idx ? ' selected' : ''}" onclick="App.selectCartLine(event,${idx})" ondblclick="App.showDeliveryItemModal(${idx})" title="Delivery line — double-click to edit">
        <td><span class="badge-pill badge-teal" style="font-size:10px">Delivery</span></td>
        <td>${this.escapeAttr(item.name)}</td>
        <td style="text-align:center"><span class="qty-val">1</span></td>
        <td style="text-align:right">${this.fmt(item.price)}</td>
        <td style="text-align:right;color:var(--text-muted)">${isExempt ? '—' : this.fmt(lineTax)}</td>
        <td style="text-align:right;font-weight:600">${this.fmt(item.price - lineShare + lineTax)}</td>
        <td style="white-space:nowrap"><button class="btn-remove" onclick="event.stopPropagation();App.removeFromCart(${idx})">×</button></td>
      </tr>`;
      }
      if (item.is_q_item) {
        const lineShare = lineShares[idx], lineTax = lineTaxes[idx], gross = item.price * item.quantity;
        return `
      <tr class="pos-ticket-row${this._selectedCartLine === idx ? ' selected' : ''}" onclick="App.selectCartLine(event,${idx})" ondblclick="App.showQItemModal(${idx})" title="Q item — not in inventory; this ticket goes to a quote (Create Quote). Double-click to edit">
        <td><span class="badge-pill badge-warning" style="font-size:10px">Q</span></td>
        <td>${this.escapeAttr(item.name)}</td>
        <td style="text-align:center"><span class="qty-val">${item.quantity}</span></td>
        <td style="text-align:right">${this.fmt(item.price)}</td>
        <td style="text-align:right;color:var(--text-muted)">${isExempt ? '—' : this.fmt(lineTax)}</td>
        <td style="text-align:right;font-weight:600">${this.fmt(gross - lineShare + lineTax)}</td>
        <td style="white-space:nowrap"><button class="btn-remove" onclick="event.stopPropagation();App.removeFromCart(${idx})">×</button></td>
      </tr>`;
      }
      const sku = item.sku || this.allProducts.find(p => p.id === item.product_id)?.sku || '—';
      const lineGross = item.price * item.quantity;
      const lineNet = this._cartLineNet(item);
      // Same per-line tax the totals below add up — after any line discount
      // and the line's share of a ticket discount/promotion (see
      // getCartTotals), and the line total shown is net of that share too.
      const lineTax = lineTaxes[idx];
      const lineShare = lineShares[idx];
      return `
      <tr class="pos-ticket-row${this._selectedCartLine === idx ? ' selected' : ''}" onclick="App.selectCartLine(event,${idx})">
        <td style="font-family:monospace;font-size:12px">${sku}</td>
        <td>${item.name}${item.variation_name ? `<div style="font-size:11px;color:var(--text-muted)">${item.variation_name}</div>` : ''}${item.discountPercent > 0 || item.discountFixed > 0 ? `<div style="font-size:11px;color:var(--success)">-${item.discountFixed > 0 ? this.fmt(item.discountFixed) : `${item.discountPercent}%`} off${item.discountOverrideName ? ` (override: ${item.discountOverrideName})` : ''}</div>` : ''}${showMargin ? this._cartLineMarginTag(item) : ''}</td>
        <td style="text-align:center">
          <div class="qty-ctrl" style="justify-content:center">
            <button class="qty-btn" onclick="App.updateCartQty(${idx},-1)">−</button>
            ${canTypeQty ? `<input type="number" class="qty-input" value="${item.quantity}" min="0" step="${item.allow_decimal ? 'any' : '1'}" title="Type a quantity, then Enter" onclick="event.stopPropagation()" onfocus="this.select()" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}else if(event.key==='Escape'){this.value='${item.quantity}';this.blur()}" onchange="App.setCartQty(${idx},this.value)">` : `<span class="qty-val">${item.quantity}</span>`}
            <button class="qty-btn" onclick="App.updateCartQty(${idx},1)">+</button>
          </div>
        </td>
        <td style="text-align:right">${this.fmt(item.price)}</td>
        <td style="text-align:right;color:var(--text-muted)">${isExempt ? '—' : this.fmt(lineTax)}</td>
        <td style="text-align:right;font-weight:600">${item.discountPercent > 0 || item.discountFixed > 0 || lineShare > 0 ? `<span style="text-decoration:line-through;color:var(--text-muted);font-weight:400;font-size:11px" title="Before discount">${this.fmt(lineGross + (isExempt ? 0 : parseFloat((lineGross * (item.tax_rate || 0) / 100).toFixed(2))))}</span> ` : ''}${this.fmt(lineNet - lineShare + lineTax)}</td>
        <td style="white-space:nowrap">
          ${this.can('pos_discounts') ? `<button class="btn-secondary" style="padding:2px 8px;font-size:11px" title="Line Discount" onclick="event.stopPropagation();App.showLineDiscountModal(${idx})">%</button>
          <button class="btn-secondary" style="padding:2px 8px;font-size:11px" title="Line Discount — fixed amount" onclick="event.stopPropagation();App.showLineDiscountModal(${idx},'fixed')">$</button>` : ''}
          <button class="btn-remove" onclick="App.removeFromCart(${idx})">×</button>
        </td>
      </tr>`;
    }).join('');

    const isTaxExempt = this.isCartTaxExempt();
    // Straight from getCartTotals() — this is what the "Amount Due" box
    // below shows, so it has to be exactly what checkout charges.
    const { subtotal, tax, discount, total, discountPreTax } = this.getCartTotals();
    const discountLabel = this._returnCredit ? `↩ Return Credit ${this._returnCredit.return_number}` : this.autoAppliedPromo ? `🏷 ${this.autoAppliedPromo.name}` : this._manualTicketDiscountPct ? `Discount (${this._manualTicketDiscountPct}%)` : 'Discount';

    totals.innerHTML = `
      <div class="pos-totals">
        <div class="pos-total-item"><label>Subtotal</label><span>${this.fmt(subtotal)}</span></div>
        ${discount > 0 && discountPreTax ? `<div class="pos-total-item"><label>${discountLabel}</label><span style="color:var(--success)">-${this.fmt(discount)}</span></div>` : ''}
        <div class="pos-total-item"><label>${isTaxExempt ? 'Tax Exempt' : 'Tax'}</label><span>${isTaxExempt ? '—' : this.fmt(tax)}</span></div>
        ${discount > 0 && !discountPreTax ? `<div class="pos-total-item"><label>Total incl. Tax</label><span>${this.fmt(subtotal + tax)}</span></div>` : ''}
        ${discount > 0 && !discountPreTax ? `<div class="pos-total-item"><label>${discountLabel}</label><span style="color:var(--success)">-${this.fmt(discount)}</span></div>` : ''}
        ${this._storeCreditApplied > 0 ? `<div class="pos-total-item"><label>💳 Available Credit</label><span style="color:var(--success)">-${this.fmt(this._storeCreditApplied)}</span></div>` : ''}
        ${this._cashBackApplied > 0 ? `<div class="pos-total-item"><label>🎁 Cash Back</label><span style="color:var(--success)">-${this.fmt(this._cashBackApplied)}</span></div>` : ''}
      </div>
      <div class="pos-amount-due"><label>Amount Due</label><span>${this.fmt(total)}</span></div>`;
  },

  // Per-line margin readout, same formula and look as Special Projects'
  // _updateQuoteItemMargin — (price − cost) / price, on the price actually
  // charged after any line discount. Gated in renderCart on the standalone
  // pos_view_margin key (Security Groups → "View POS Margin") — cost is
  // sensitive and the POS screen can face the customer.
  // Lines added before this field existed (recalled holds, converted
  // quotes) fall back to the product's catalog cost; no cost on file, or a
  // zero cost, shows nothing rather than a misleading 100%.
  _cartLineMarginTag(item) {
    const cost = item.cost != null ? item.cost : (this.allProducts || []).find(p => p.id === item.product_id)?.cost;
    if (!(cost > 0) || !item.quantity) return '';
    const unitNet = this._cartLineNet(item) / item.quantity;
    if (!(unitNet > 0)) return '';
    const marginPct = (unitNet - cost) / unitNet * 100;
    return `<div style="font-size:11px;color:${marginPct < 0 ? 'var(--danger)' : 'var(--text-muted)'}">${marginPct >= 0 ? '+' : ''}${marginPct.toFixed(0)}% margin</div>`;
  },

  // Net (post-line-discount) amount for one cart line — the single place
  // both renderCart() and getCartTotals() derive subtotal/tax from, so the
  // two can never drift out of sync with each other (see the comment on
  // renderCart's total below).
  _cartLineNet(item) {
    const gross = item.price * item.quantity;
    // A "$" discount is a fixed amount off the whole line, never below zero.
    if (item.discountFixed > 0) return parseFloat(Math.max(0, gross - item.discountFixed).toFixed(2));
    const pct = item.discountPercent || 0;
    return parseFloat((gross * (1 - pct / 100)).toFixed(2));
  },

  // The line's manual discount as a percentage — a "$" discount converted
  // on the line's current amount (what the store limit and promotions see).
  _cartLineDiscountPct(item) {
    if (item.discountFixed > 0) {
      const gross = item.price * item.quantity;
      return gross > 0 ? Math.min(100, item.discountFixed / gross * 100) : 0;
    }
    return item.discountPercent || 0;
  },

  // Spreads a ticket discount over lines by their net amount — the exact
  // split lib/ticketDiscount.js makes at checkout, so the cart shows what
  // the server will charge. Returns the discount (capped at the lines'
  // total) and each line's share, last line taking the rounding remainder.
  _allocateTicketDiscount(amounts, discount) {
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const nets = amounts.map(a => Math.max(0, Number(a) || 0));
    const base = r2(nets.reduce((s, a) => s + a, 0));
    const disc = r2(Math.min(Math.max(0, Number(discount) || 0), base));
    const shares = nets.map(() => 0);
    if (!(disc > 0)) return { discount: 0, shares };
    let last = -1;
    nets.forEach((a, i) => { if (a > 0) last = i; });
    let given = 0;
    nets.forEach((a, i) => {
      if (!(a > 0) || i === last) return;
      shares[i] = r2(disc * a / base);
      given = r2(given + shares[i]);
    });
    shares[last] = r2(disc - given);
    return { discount: disc, shares };
  },

  // Ticket discounts (Ticket Discount, promo, auto promotion, discount card)
  // come off before tax — each line is taxed on its net less its share. A
  // return credit on an exchange is money already paid, tax included, so it
  // stays after tax like Available Credit and Cash Back.
  getCartTotals() {
    const nets = this.cart.map(i => this._cartLineNet(i));
    const subtotal = nets.reduce((s, n) => s + n, 0);
    const isTaxExempt = this.isCartTaxExempt();
    const discountPreTax = !this._returnCredit;
    const split = discountPreTax ? this._allocateTicketDiscount(nets, this.cartDiscount || 0) : { discount: this.cartDiscount || 0, shares: nets.map(() => 0) };
    const lineTaxes = this.cart.map((i, idx) => isTaxExempt ? 0 : parseFloat(((nets[idx] - split.shares[idx]) * (i.tax_rate || 0) / 100).toFixed(2)));
    const tax = lineTaxes.reduce((s, t) => s + t, 0);
    const discount = split.discount;
    const storeCredit = this._storeCreditApplied || 0;
    const cashBack = this._cashBackApplied || 0;
    const total = Math.max(0, subtotal - discount + tax - storeCredit - cashBack);
    return { subtotal: parseFloat(subtotal.toFixed(2)), tax: parseFloat(tax.toFixed(2)), discount: parseFloat(discount.toFixed(2)), storeCredit: parseFloat(storeCredit.toFixed(2)), cashBack: parseFloat(cashBack.toFixed(2)), total: parseFloat(total.toFixed(2)), discountPreTax, lineTaxes, lineShares: split.shares };
  },

  // Manual per-line discount ("%" button on a cart row, or "$" for a fixed
  // amount off the line — mode 'fixed', held to the same cap as the
  // percentage it works out to) — capped at the
  // store's configured limit (Settings → POS Discounts) for items not
  // already covered by an active promotion and not on the brand-exclusion
  // list; going over the cap prompts for a manager PIN with override
  // privileges. Re-validated server-side at checkout
  // either way (see POST /transactions) — this modal is convenience, not
  // the actual gate.
  async showLineDiscountModal(idx, mode = 'percent') {
    const item = this.cart[idx];
    if (!item) return;
    if (!item.product_id) { this.alert('This line has no catalog product to check discount eligibility against', 'error'); return; }
    let eligibility;
    try {
      eligibility = await this.api('GET', `/promotions/discount-eligibility/${item.product_id}`);
    } catch(e) { this.alert(e.message, 'error'); return; }

    if (!eligibility.eligible) {
      const reasonText = eligibility.reason === 'brand_excluded'
        ? 'This brand is on the store\'s discount-exclusion list and can\'t be manually discounted.'
        : `This item is already covered by the promotion "${eligibility.promotion_name||''}" — a manual discount can't be stacked on top of it.`;
      this.showModal(`
        <div class="modal" style="max-width:380px">
          <div class="modal-header"><span class="modal-title">Discount Not Available</span><button class="modal-close">✕</button></div>
          <div class="modal-body"><p style="font-size:13px;color:var(--text-muted)">${reasonText}</p></div>
          <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Close</button></div>
        </div>`);
      return;
    }

    const maxPct = parseFloat(eligibility.max_percent) || 0;
    const fixed = mode === 'fixed';
    const gross = parseFloat((item.price * item.quantity).toFixed(2));
    const limitText = maxPct > 0
      ? (fixed ? `Up to ${this.fmt(Math.floor(gross * maxPct + 1e-6) / 100)} (${maxPct}% of ${this.fmt(gross)}) without a manager override.` : `Up to ${maxPct}% without a manager override.`)
      : 'No store limit currently configured.';
    this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header"><span class="modal-title">Line Discount — ${this.escapeAttr(item.name)}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-muted)">${limitText}</p>
          ${fixed
            ? `<div class="form-group"><label>Discount Amount (off this line of ${this.fmt(gross)})</label><input type="number" id="line-disc-amt" min="0" max="${gross}" step="0.01" value="${item.discountFixed||''}" placeholder="e.g. 5.00" onkeydown="if(event.key==='Enter')App.confirmLineDiscount(${idx},${maxPct},'fixed')"></div>`
            : `<div class="form-group"><label>Discount %</label><input type="number" id="line-disc-pct" min="0" max="100" step="0.1" value="${item.discountFixed > 0 ? '' : item.discountPercent||''}" placeholder="e.g. 10" onkeydown="if(event.key==='Enter')App.confirmLineDiscount(${idx},${maxPct})"></div>`}
          <div id="line-disc-override" style="display:none">
            <div class="form-group"><label>Manager Override PIN</label>
              <input type="password" id="line-disc-pin" maxlength="8" placeholder="Enter PIN" style="letter-spacing:4px;font-size:18px;text-align:center" onkeydown="if(event.key==='Enter')App.confirmLineDiscount(${idx},${maxPct},'${mode}')">
            </div>
          </div>
          <div id="line-disc-err" style="color:var(--danger);font-size:13px;min-height:16px"></div>
        </div>
        <div class="modal-footer">
          ${item.discountPercent > 0 || item.discountFixed > 0 ? `<button class="btn btn-outline" onclick="App.clearLineDiscount(${idx})">Remove Discount</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.confirmLineDiscount(${idx},${maxPct},'${mode}')">Apply</button>
        </div>
      </div>`);
    setTimeout(() => document.getElementById(fixed ? 'line-disc-amt' : 'line-disc-pct')?.focus(), 50);
  },

  confirmLineDiscount(idx, maxPct, mode = 'percent') {
    const item = this.cart[idx];
    if (!item) return;
    const errEl = document.getElementById('line-disc-err');
    const fixed = mode === 'fixed';
    let pct, amt = 0;
    if (fixed) {
      const gross = parseFloat((item.price * item.quantity).toFixed(2));
      amt = Math.round((parseFloat(document.getElementById('line-disc-amt')?.value) || 0) * 100) / 100;
      if (!(amt > 0)) { if (errEl) errEl.textContent = 'Enter a discount amount.'; return; }
      if (amt > gross) { if (errEl) errEl.textContent = `Discount can't exceed the line amount of ${this.fmt(gross)}.`; return; }
      pct = gross > 0 ? amt / gross * 100 : 0;
    } else {
      pct = parseFloat(document.getElementById('line-disc-pct')?.value);
      if (!pct || pct <= 0) { if (errEl) errEl.textContent = 'Enter a discount percentage.'; return; }
      if (pct > 100) { if (errEl) errEl.textContent = 'Discount can\'t exceed 100%.'; return; }
    }
    const label = fixed ? this.fmt(amt) : `${pct}%`;

    if (maxPct > 0 && pct > maxPct) {
      const overrideRow = document.getElementById('line-disc-override');
      const pin = document.getElementById('line-disc-pin')?.value;
      if (overrideRow && overrideRow.style.display === 'none') {
        overrideRow.style.display = 'block';
        if (errEl) errEl.textContent = `Exceeds the ${maxPct}% store limit${fixed ? ` (${pct.toFixed(2)}%)` : ''} — enter a manager PIN to override.`;
        document.getElementById('line-disc-pin')?.focus();
        return;
      }
      if (!pin) { if (errEl) errEl.textContent = 'PIN is required to override the store limit.'; return; }
      this.api('POST', '/employees/validate-pin', { pin, permission: 'pos_discount_override' }).then(result => {
        item.discountPercent = fixed ? 0 : pct;
        item.discountFixed = fixed ? amt : 0;
        item.discountOverrideEmployeeId = result.id;
        item.discountOverrideName = result.name;
        this.closeModal();
        this._checkAutoPromos();
        this.alert(`${label} discount applied — authorised by ${result.name}`, 'success');
      }).catch(e => {
        if (errEl) errEl.textContent = e.message;
        document.getElementById('line-disc-pin').value = '';
      });
      return;
    }

    item.discountPercent = fixed ? 0 : pct;
    item.discountFixed = fixed ? amt : 0;
    item.discountOverrideEmployeeId = null;
    item.discountOverrideName = null;
    this.closeModal();
    // Re-checks promotions too: a discounted line no longer counts toward a bundle.
    this._checkAutoPromos();
  },

  clearLineDiscount(idx) {
    const item = this.cart[idx];
    if (!item) return;
    item.discountPercent = 0;
    item.discountFixed = 0;
    item.discountOverrideEmployeeId = null;
    item.discountOverrideName = null;
    this.closeModal();
    this._checkAutoPromos();
  },

  async processPayment(method) {
    if (!this.cart.length) { this.alert('Cart is empty', 'warning'); return; }
    if (this._posQItemBlocksSale()) return;

    if (method === 'credit') {
      if (!this.cartCustomer) { this.alert('Please select a customer to use charge account', 'error'); return; }
      if (this.cartCustomer.customer_type !== 'credit') { this.alert('Selected customer does not have a credit account. Edit the customer and set type to Credit.', 'error'); return; }
      if (this.cartCustomer.account_blocked) { this.alert(this._creditBlockedText(this.cartCustomer), 'error'); return; }
    }

    const { subtotal, tax, discount, total } = this.getCartTotals();

    // Refuse up front a charge that would take the account over its credit
    // limit (same rule the server applies — lib/creditBlock.js
    // creditLimitError), using the customer's current balance, not the one
    // from when they were added to the ticket.
    if (method === 'credit') {
      const fresh = await this.api('GET', `/customers/${this.cartCustomer.id}`).catch(() => this.cartCustomer);
      this.cartCustomer = { ...this.cartCustomer, ...fresh };
      if (fresh.account_blocked) { this.alert(this._creditBlockedText(fresh), 'error'); return; }
      const limit = Number(fresh.credit_limit) || 0, balance = Number(fresh.account_balance) || 0;
      if (limit > 0 && fresh.block_override !== 'unblock' && balance + total - limit > 0.005) {
        this.alert(`This sale (${this.fmt(total)}) would take the account over its credit limit of ${this.fmt(limit)}. Available credit: ${this.fmt(Math.max(0, limit - balance))}.`, 'error');
        return;
      }
    }

    let amountTendered = total;
    let changeAmount = 0;
    let cashResult = null;
    let approvalCode = null;
    let splitTenders = null;
    let splitForeignCash = null;

    if (method === 'cash') {
      cashResult = await this.showCashTenderModal(total);
      if (!cashResult) return;
      amountTendered = cashResult.amountTendered;
      changeAmount = cashResult.changeAmount;
    } else if (method === 'credit_card' || method === 'debit_card') {
      approvalCode = await this.showCardApprovalModal();
      if (approvalCode === null) return;
    } else if (method === 'direct_deposit') {
      approvalCode = await this.showDepositReferenceModal();
      if (approvalCode === null) return;
    } else if (method === 'gift_card') {
      approvalCode = await this.showGiftCardModal();
      if (approvalCode === null) return;
    } else if (method === 'split') {
      const splitResult = await this.showSplitTenderModal(total);
      if (!splitResult) return;
      splitTenders = splitResult.tenders;
      splitForeignCash = splitResult.foreignCash;
    }

    const isTaxExempt = this.isCartTaxExempt();

    try {
      const tx = await this.api('POST', '/transactions', {
        customer_id: this.cartCustomer?.id || null,
        employee_id: this.currentUser?.id || 1,
        created_by: this._ticketCreatedBy || null,
        salesperson_id: this._ticketSalesperson || null,
        branch_id: this.posBranch?.id || null,
        drawer_session_id: this.currentDrawerSession?.id || null,
        // A custom/temp line (no product_id — e.g. a Special Project's
        // free-typed labour/equipment line) has no catalog product for the
        // server to look up name/price/tax from, so those are sent through
        // directly for that case only; a real product_id line still has its
        // price/tax authoritatively re-derived server-side, never trusted
        // from the client.
        items: this.cart.map(i => ({ product_id: i.product_id, variation_id: i.variation_id||null, serial_number: i.serial_number||null, uom_id: i.uom_id ?? null, sell_unit: i.sell_unit || null, quantity: i.quantity, discount_percent: i.discountPercent||0, discount_fixed: i.discountFixed||0, discount_override_employee_id: i.discountOverrideEmployeeId||null, ...(i.product_id ? {} : { product_name: i.name, unit_price: i.price, tax_rate: i.tax_rate||0, is_comment: i.is_comment ? 1 : 0, is_delivery: i.is_delivery ? 1 : 0, is_q_item: i.is_q_item ? 1 : 0 }) })),
        discount_amount: discount,
        promotion_code: this.appliedDiscountCard ? (this.appliedDiscountCard.card_number || null) : (this.appliedPromoCode?.code || null),
        promotion_name: this.appliedDiscountCard ? `${this.appliedDiscountCard.type_name} ${this.appliedDiscountCard.label || 'Discount Card'}` : (this.appliedPromoCode?.promo_name || this.autoAppliedPromo?.name || null),
        payment_method: method,
        amount_tendered: amountTendered,
        source_return_id: this._returnCredit?.id || null,
        store_credit_applied: this._storeCreditApplied || 0,
        cash_back_applied: this._cashBackApplied || 0,
        quote_id: this._activeQuoteId || null,
        po_number: this._ticketPoNumber || null,
        tax_exempt: isTaxExempt ? 1 : 0,
        tax_exemption_number: isTaxExempt ? this.cartTaxExemptionNumber() : null,
        approval_code: approvalCode || null,
        tenders: splitTenders,
      });

      // Record promo code usage
      if (this.appliedPromoCode?.code_id) {
        try { await this.api('POST', '/promotions/use-code', { code_id: this.appliedPromoCode.code_id }); } catch(e) {}
      }

      // Update local stock
      this.cart.forEach(item => {
        if (item.variation_id) {
          item.stock_qty = Math.max(0, (item.stock_qty || 0) - item.quantity);
        } else {
          const p = this.allProducts.find(p => p.id === item.product_id);
          if (p) p.stock_qty -= item.quantity * (item.units_per || 1);
        }
      });

      if (method === 'cash' && changeAmount > 0) {
        this.alert(`Change due: ${this._changeDisplay(cashResult, changeAmount)}`, 'success');
      }

      this.showReceipt(tx, changeAmount, cashResult, splitForeignCash);
      this.clearCart();
      this.renderProductGrid();
    } catch (e) {
      this.alert(e.message, 'error');
    }
  },

  async holdOrder() {
    if (!this.cart.length) { this.alert('Cart is empty', 'warning'); return; }
    try {
      const cartItems = this.cart.map(i => {
        const product = this.allProducts?.find(p => p.id === i.product_id);
        return {
          product_id: i.product_id,
          variation_id: i.variation_id || null,
          product_name: i.name,
          sku: product?.sku || '',
          quantity: i.quantity,
          unit_price: i.price,
          tax_rate: i.tax_rate || 0,
          variation_name: i.variation_name || null,
          serial_number: i.serial_number || null,
          uom_id: i.uom_id ?? null,
          sell_unit: i.sell_unit || null,
          is_comment: i.is_comment ? 1 : 0,
          is_delivery: i.is_delivery ? 1 : 0,
          is_q_item: i.is_q_item ? 1 : 0,
          discount_percent: i.discountPercent || 0,
          discount_fixed: i.discountFixed || 0,
          discount_override_employee_id: i.discountOverrideEmployeeId || null,
        };
      });
      await this.api('POST', '/transactions/hold', {
        customer_id: this.cartCustomer?.id || null,
        employee_id: this.currentUser?.id || 1,
        created_by: this._ticketCreatedBy || null,
        salesperson_id: this._ticketSalesperson || null,
        branch_id: this.posBranch?.id || null,
        items: cartItems,
        discount_amount: this.cartDiscount || 0,
        po_number: this._ticketPoNumber || null,
        ...this._ticketDiscountSource(),
      });
      const customerName = this.cartCustomer ? `${this.cartCustomer.first_name} ${this.cartCustomer.last_name}` : 'Walk-in Customer';
      this.clearCart();
      this.alert(`Order held for ${customerName}`, 'success');
      this.updateHoldBadge();
    } catch(e) {
      this.alert(e.message, 'error');
    }
  },

  async recallOrder() {
    const customerId = this.cartCustomer?.id;
    const ordersUrl = customerId ? `/transactions?status=hold&customer_id=${customerId}` : '/transactions?status=hold&limit=50';
    const rentalsUrl = customerId ? `/rentals/agreements?view=pending&customer_id=${customerId}` : '/rentals/agreements?view=pending';
    // A rental returned with a balance still owed (see needsCashierHold in
    // routes/rentals.js's /return handler) lands here the same way — item's
    // already back in stock, only the settlement payment is outstanding.
    const rentalBalanceUrl = customerId ? `/rentals/agreements?view=awaiting_payment&customer_id=${customerId}` : '/rentals/agreements?view=awaiting_payment&limit=50';
    // Work orders awaiting an assessment fee (status='intake') or a deposit
    // (status='pending_deposit') are collected here rather than by whoever
    // did the assessment — keeps cash handling with the cashier/drawer, same
    // as the pending-rentals flow below.
    const woUrl = customerId ? `/work-orders?view=awaiting_payment&customer_id=${customerId}` : '/work-orders?view=awaiting_payment&limit=50';
    // Exchange returns whose replacement hasn't been rung up yet — e.g. the
    // return was processed by someone without POS access.
    const exchangesUrl = customerId ? `/transactions/pending-exchanges?customer_id=${customerId}` : '/transactions/pending-exchanges';
    try {
      const [held, pendingRentals, pendingRentalBalances, pendingWOs, pendingExchanges] = await Promise.all([
        this.api('GET', ordersUrl),
        this.can('rentals') ? this.api('GET', rentalsUrl).catch(() => []) : Promise.resolve([]),
        this.can('rentals') ? this.api('GET', rentalBalanceUrl).catch(() => []) : Promise.resolve([]),
        this.can('work_orders') ? this.api('GET', woUrl).catch(() => []) : Promise.resolve([]),
        this.api('GET', exchangesUrl).catch(() => []),
      ]).then(([h, pr, ...rest]) => [h, pr.filter(r => !r.quotation_id), ...rest]);
      if (!held.length && !pendingRentals.length && !pendingRentalBalances.length && !pendingWOs.length && !pendingExchanges.length) {
        this.alert(customerId ? `No held orders for ${this.cartCustomer.first_name} ${this.cartCustomer.last_name}` : 'No held orders', 'info');
        return;
      }
      const combined = [
        ...held.map(h => ({ type: 'order', created_at: h.created_at, data: h })),
        ...pendingRentals.map(r => ({ type: 'rental', created_at: r.created_at, data: r })),
        ...pendingRentalBalances.map(r => ({ type: 'rental_balance', created_at: r.returned_at || r.created_at, data: r })),
        ...pendingWOs.map(w => ({ type: 'work_order', created_at: w.created_at, data: w })),
        ...pendingExchanges.map(r => ({ type: 'exchange', created_at: r.created_at, data: r })),
      ].sort((a, b) => this._utcDate(b.created_at) - this._utcDate(a.created_at));
      this.showModal(`
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Recall Held Order</span>
            <button class="modal-close">✕</button>
          </div>
          <div class="modal-body" style="padding:0">
            <div style="max-height:420px;overflow-y:auto;padding:14px">
              ${combined.map(entry => entry.type === 'order' ? (h => `
                <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''" onclick="App.loadHeldOrder(${h.id})">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <strong style="font-size:14px">${h.customer_name || 'Walk-in Customer'} <span class="badge-pill badge-success" style="font-size:10px;margin-left:4px">RETAIL</span>${h.source_quote_number ? ` <span class="badge-pill badge-info" style="font-size:10px;margin-left:2px">QUOTE</span>` : ''}</strong>
                    <span style="font-size:12px;color:var(--text-muted);font-family:monospace">${h.source_quote_number || h.transaction_number}</span>
                  </div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:3px">
                    Total: <strong>${this.fmt(h.total)}</strong> &bull; ${this._storeDateTime(h.created_at)}
                    ${h.notes ? `&bull; ${h.notes}` : ''}
                  </div>
                  ${this._recallMetaLine(h.employee_name, h.branch_name)}
                </div>`)(entry.data) : entry.type === 'rental' ? (r => `
                <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''" onclick="App.closeModal();App.showFinalizeRentalModal(${r.id})">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <strong style="font-size:14px">${r.customer_name || '—'} <span class="badge-pill badge-warning" style="font-size:10px;margin-left:4px">RENTAL</span>${r.source_quote_number ? ` <span class="badge-pill badge-info" style="font-size:10px;margin-left:2px">QUOTE</span>` : ''}</strong>
                    <span style="font-size:12px;color:var(--text-muted);font-family:monospace">${r.source_quote_number || r.agreement_number}</span>
                  </div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:3px">
                    ${r.item_count} item${r.item_count===1?'':'s'} &bull; Due ${this.fmtDate(r.due_date)} &bull; ${this._storeDateTime(r.created_at)}
                  </div>
                  ${this._recallMetaLine(r.employee_name, r.branch_name)}
                </div>`)(entry.data) : entry.type === 'rental_balance' ? (r => `
                <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''" onclick="App.closeModal();App.showRentalBalanceDueModal(${r.id})">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <strong style="font-size:14px">${r.customer_name || '—'} <span class="badge-pill badge-warning" style="font-size:10px;margin-left:4px">RENTAL BALANCE DUE</span></strong>
                    <span style="font-size:12px;color:var(--text-muted);font-family:monospace">${r.agreement_number}</span>
                  </div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:3px">
                    Balance Due: <strong>${this.fmt(r.balance_due)}</strong> &bull; returned ${this._storeDateTime(r.returned_at)}
                  </div>
                  ${this._recallMetaLine(r.employee_name, r.branch_name)}
                </div>`)(entry.data) : entry.type === 'exchange' ? (r => `
                <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''" onclick="App.recallExchange(${r.id})">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <strong style="font-size:14px">${this.escapeAttr(r.customer_name || 'Walk-in Customer')} <span class="badge-pill badge-info" style="font-size:10px;margin-left:4px">EXCHANGE</span></strong>
                    <span style="font-size:12px;color:var(--text-muted);font-family:monospace">${r.return_number}</span>
                  </div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:3px">
                    Credit: <strong>${this.fmt(r.total)}</strong> &bull; returned ${this.escapeAttr(r.item_names || '')} from ${r.original_transaction_number || '—'} &bull; ${this._storeDateTime(r.created_at)}
                  </div>
                  ${this._recallMetaLine(r.employee_name, r.branch_name).replace('Held by', 'Returned by')}
                </div>`)(entry.data) : (w => `
                <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''" onclick="App.closeModal();${w.status==='intake' ? `App.showWOAssessmentFeeModal(${w.id})` : w.status==='pending_deposit' ? `App.showWODepositModal(${w.id})` : `App.showWOFinalPaymentModal(${w.id})`}">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <strong style="font-size:14px">${w.customer_name || '—'} <span class="badge-pill badge-warning" style="font-size:10px;margin-left:4px">WORK ORDER</span></strong>
                    <span style="font-size:12px;color:var(--text-muted);font-family:monospace">${w.wo_number}</span>
                  </div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:3px">
                    ${w.status==='intake' ? `Assessment Fee: <strong>${this.fmt(w.assessment_fee)}</strong>`
                      : w.status==='pending_deposit' ? `Deposit: <strong>${this.fmt(w.deposit_amount)}</strong>`
                      : `Balance Due: <strong>${this.fmt(Math.max(0, (parseFloat(w.estimate_labor)||0) + (parseFloat(w.estimate_consumables)||0) + (parseFloat(w.parts_total)||0) - (parseFloat(w.deposit_amount)||0)))}</strong>`}
                    &bull; ${this._storeDateTime(w.created_at)}
                  </div>
                  ${this._recallMetaLine(w.employee_name, w.branch_name)}
                </div>`)(entry.data)).join('')}
            </div>
          </div>
        </div>`);
    } catch(e) {
      this.alert(e.message, 'error');
    }
  },

  // Shared "who/where" line for each Hold Recall card — employee_name and
  // branch_name are already joined by every source endpoint (transactions,
  // rentals/agreements, work-orders), so this just formats what's there.
  _recallMetaLine(employeeName, branchName) {
    if (!employeeName && !branchName) return '';
    return `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">
      ${employeeName ? `Held by <strong>${employeeName}</strong>` : ''}${employeeName && branchName ? ' &bull; ' : ''}${branchName || ''}
    </div>`;
  },

  async loadHeldOrder(id) {
    try {
      const held = await this.api('GET', `/transactions/${id}`);
      if (this.cart.length) {
        if (!confirm('Loading this held order will replace your current cart. Continue?')) return;
      }
      // Each line's share of the held ticket discount — its tax was charged
      // on its total less that share (discount before tax).
      const heldShares = this._allocateTicketDiscount(held.items.map(i => i.total), held.discount_amount).shares;
      // A hold made by converting a quote carries the quoted prices — kept
      // while the quote is valid, today's prices once it has expired.
      const fromQuote = !!held.source_quote_id;
      const quoteValid = fromQuote && this._quoteStillValid(held.source_quote_valid_until);
      this.cart = held.items.map((item, idx) => {
        if (item.is_comment) return { product_id: null, is_comment: 1, name: item.product_name, price: 0, quantity: 1, tax_rate: 0, is_service: 0 };
        const product = this.allProducts?.find(p => p.id === item.product_id);
        // A custom/temp line (no product_id — e.g. a Special Project's
        // free-typed labour/equipment line) has no product to read a tax
        // rate from — reconstruct the rate that was actually already
        // charged on this line, from its own stored tax_amount over its
        // total less its discount share, instead of silently dropping to 0% tax.
        const taxedBase = item.total - heldShares[idx];
        const derivedTaxRate = taxedBase > 0 ? parseFloat((item.tax_amount / taxedBase * 100).toFixed(4)) : 0;
        return {
          product_id: item.product_id,
          variation_id: item.variation_id || null,
          name: item.product_name,
          price: parseFloat(item.unit_price),
          tax_rate: (item.is_delivery || item.is_q_item) ? (parseFloat(this.settings?.tax_rate) || 0) : product ? (product.tax_rate || 0) : derivedTaxRate,
          quantity: item.quantity,
          is_delivery: item.is_delivery ? 1 : 0,
          is_q_item: item.is_q_item ? 1 : 0,
          variation_name: item.variation_name || null,
          serial_number: item.serial_number || null,
          is_service: product?.product_type === 'service' ? 1 : 0,
          stock_qty: product?.stock_qty ?? 999,
          // A line's manual % discount (and manager override) comes back
          // as it was held; checkout re-validates it.
          discountPercent: item.discount_fixed > 0 ? 0 : parseFloat(item.discount_percent) || 0,
          discountFixed: parseFloat(item.discount_fixed) || 0,
          discountOverrideEmployeeId: item.discount_override_by || null,
          discountOverrideName: item.discount_override_name || null,
          ...this._recalledUnitFields(item, product),
          ...(fromQuote && item.product_id && !item.variation_id && !item.serial_number ? this._quotedLineFields(item, product, quoteValid) : {}),
        };
      });
      if (fromQuote && !quoteValid && held.items.some(i => i.product_id && !i.serial_number)) {
        setTimeout(() => this.alert(`${held.source_quote_number} expired on ${this.fmtDate(held.source_quote_valid_until)} — its items are at today's prices, not the quoted prices`, 'warning'), 600);
      }
      this._storeCreditApplied = 0;
      this._cashBackApplied = 0;
      this._returnCredit = null;
      const customer = held.customer_id ? await this.api('GET', `/customers/${held.customer_id}`) : null;
      await this._restoreHeldTicketDiscount(held, customer);
      // A hold created by converting a quotation carries that link through
      // (via the existing quotations.converted_to_tx join on GET /transactions/:id)
      // — restoring it here is what makes checkout finalize the quote correctly,
      // exactly like loadQuoteToCart does for its own "Load Quote" pull flow.
      this._activeQuoteId = held.source_quote_id || null;
      this._ticketCreatedBy = held.created_by || held.employee_id || null;
      this._ticketSalesperson = held.salesperson_id || null;
      this._ticketSalespersonName = held.salesperson_name || null;
      this._renderTicketSalesperson();
      this._ticketPoNumber = held.po_number || null;
      this._renderTicketPoNumber();
      if (held.customer_id) {
        this.cartCustomer = customer;
        if (this.section !== 'pos') return;
        this._renderCartCustomer();
        const bar = document.getElementById('store-credit-bar');
        if (bar) bar.style.display = 'none';
        const cbBar = document.getElementById('cash-back-bar');
        if (cbBar) cbBar.style.display = 'none';
      } else {
        this.cartCustomer = null;
        if (this.section !== 'pos') return;
        this._renderCartCustomer();
      }
      const aqBar = document.getElementById('active-quote-bar');
      if (aqBar) {
        if (held.source_quote_number) {
          document.getElementById('active-quote-number').textContent = held.source_quote_number;
          aqBar.style.display = 'flex';
        } else {
          aqBar.style.display = 'none';
        }
      }
      await this.api('DELETE', `/transactions/${id}/hold`);
      this.closeModal();
      this.renderCart();
      this.updateHoldBadge();
      this.alert('Order recalled', 'success');
    } catch(e) {
      this.alert(e.message, 'error');
    }
  },

  async updateHoldBadge() {
    try {
      const [held, pendingRentals, pendingRentalBalances, pendingWOs, pendingExchanges] = await Promise.all([
        this.api('GET', '/transactions?status=hold&limit=50'),
        this.can('rentals') ? this.api('GET', '/rentals/agreements?view=pending').catch(() => []) : Promise.resolve([]),
        this.can('rentals') ? this.api('GET', '/rentals/agreements?view=awaiting_payment&limit=50').catch(() => []) : Promise.resolve([]),
        this.can('work_orders') ? this.api('GET', '/work-orders?view=awaiting_payment&limit=50').catch(() => []) : Promise.resolve([]),
        this.api('GET', '/transactions/pending-exchanges').catch(() => []),
      ]).then(([h, pr, ...rest]) => [h, pr.filter(r => !r.quotation_id), ...rest]);
      const count = held.length + pendingRentals.length + pendingRentalBalances.length + pendingWOs.length + pendingExchanges.length;
      const badge = document.getElementById('hold-count-badge');
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    } catch(e) {}
  },

  async showQuoteSearch() {
    const customerId = this.cartCustomer?.id;
    let quotes = [];
    try {
      const qs = customerId
        ? await this.api('GET', `/quotations?customer_id=${customerId}`)
        : await this.api('GET', '/quotations?limit=50');
      // Rental quotes become rental agreements (Convert on the quote), never
      // a POS sale, so they aren't offered here.
      quotes = qs.filter(q => this._quoteRecallable(q));
    } catch(e) {}

    const renderList = (list) => list.length
      ? list.map(q => {
          const statusColors = { draft:'#9ca3af', sent:'#3b82f6', accepted:'#10b981' };
          const color = statusColors[q.status] || '#9ca3af';
          return `<div style="border:1px solid var(--border);border-radius:8px;padding:11px 14px;margin-bottom:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''" onclick="App.loadQuoteToCart(${q.id})">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <strong style="font-size:13px;font-family:monospace">${q.quote_number}</strong>
              <span style="font-size:11px;background:${color}22;color:${color};border-radius:10px;padding:1px 8px;font-weight:600;text-transform:uppercase">${q.status}</span>
            </div>
            <div style="font-size:13px;margin-top:3px">${q.customer_name || 'No customer'}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:1px">Total: <strong>${this.fmt(q.total)}</strong> &bull; ${this.fmtDate(q.created_at)}</div>
          </div>`;
        }).join('')
      : '<p style="color:var(--text-muted);text-align:center;padding:20px 0">No open quotes found</p>';

    const overlay = this.showModal(`
      <div class="modal" style="max-width:480px">
        <div class="modal-header">
          <span class="modal-title">Load Quote / Invoice</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body" style="padding:14px">
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input type="text" id="qt-search" placeholder="Quote # or customer name…" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            <button class="btn btn-primary btn-sm" onclick="App._filterQuoteList()">Search</button>
          </div>
          <div id="qt-list" style="max-height:380px;overflow-y:auto">${renderList(quotes)}</div>
        </div>
      </div>`);

    this._quoteSearchData = quotes;

    overlay.querySelector('#qt-search').addEventListener('keydown', e => { if (e.key === 'Enter') this._filterQuoteList(); });
    overlay.querySelector('#qt-search').addEventListener('input', () => this._filterQuoteList());
  },

  async _filterQuoteList() {
    const input = document.getElementById('qt-search');
    if (!input) return;
    const q = input.value.trim().toLowerCase();
    if (!q) {
      const filtered = (this._quoteSearchData || []).filter(x => this._quoteRecallable(x));
      document.getElementById('qt-list').innerHTML = filtered.length
        ? filtered.map(x => this._quoteRow(x)).join('') : '<p style="color:var(--text-muted);text-align:center;padding:20px 0">No open quotes found</p>';
      return;
    }
    try {
      const results = await this.api('GET', `/quotations?quote_number=${encodeURIComponent(q)}&limit=30`);
      const filtered = results.filter(x => this._quoteRecallable(x))
        .filter(x => x.quote_number.toLowerCase().includes(q) || (x.customer_name||'').toLowerCase().includes(q));
      document.getElementById('qt-list').innerHTML = filtered.length
        ? filtered.map(x => this._quoteRow(x)).join('') : '<p style="color:var(--text-muted);text-align:center;padding:20px 0">No matching quotes</p>';
    } catch(e) {}
  },

  // Quote Recall: open quotes only, not rentals, and a Special Project only once approved.
  _quoteRecallable(q) {
    if (['converted','declined','cancelled'].includes(q.status) || q.quote_type === 'rental') return false;
    return !(q.quote_type === 'special_project' && ['draft','pending_approval'].includes(q.status));
  },

  _quoteRow(q) {
    const statusColors = { draft:'#9ca3af', sent:'#3b82f6', accepted:'#10b981' };
    const color = statusColors[q.status] || '#9ca3af';
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:11px 14px;margin-bottom:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background=''" onclick="App.loadQuoteToCart(${q.id})">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <strong style="font-size:13px;font-family:monospace">${q.quote_number}</strong>
        <span style="font-size:11px;background:${color}22;color:${color};border-radius:10px;padding:1px 8px;font-weight:600;text-transform:uppercase">${q.status}</span>
      </div>
      <div style="font-size:13px;margin-top:3px">${q.customer_name || 'No customer'}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:1px">Total: <strong>${this.fmt(q.total)}</strong> &bull; ${this.fmtDate(q.created_at)}</div>
    </div>`;
  },

  async loadQuoteToCart(quoteId) {
    try {
      const quote = await this.api('GET', `/quotations/${quoteId}`);
      if (quote.status === 'converted') { this.alert('This quote has already been converted to a transaction', 'error'); return; }
      if (['declined','cancelled'].includes(quote.status)) { this.alert(`Cannot load a ${quote.status} quote`, 'error'); return; }
      if (!quote.items || !quote.items.length) { this.alert('Quote has no items', 'error'); return; }
      if (quote.quote_type === 'rental') { this.alert(`${quote.quote_number} is a rental quote — convert it to a rental agreement from Quotations, not at the POS`, 'error'); return; }
      if (quote.quote_type === 'special_project' && ['draft','pending_approval'].includes(quote.status)) { this.alert(`${quote.quote_number} hasn't been approved yet, so it can't be sold`, 'error'); return; }
      const quoteValid = this._quoteStillValid(quote.valid_until);

      if (this.cart.length && !confirm(`Loading ${quote.quote_number} will replace your current cart. Continue?`)) return;

      // Each line's share of the quote's Discount — its tax was quoted on its
      // total less that share (discount before tax).
      const quoteShares = this._allocateTicketDiscount(quote.items.map(i => i.total), quote.discount_amount).shares;
      this.cart = quote.items.map((item, idx) => {
        if (item.is_comment) return { product_id: null, is_comment: 1, name: item.product_name, price: 0, quantity: 1, tax_rate: 0, is_service: 0 };
        const product = this.allProducts?.find(p => p.id === item.product_id);
        // A custom/temp line (no product_id — e.g. a Special Project's
        // free-typed labour/equipment line, or a retail quote's "Q" item)
        // has no product to read a tax rate from — reconstruct the rate
        // that was actually already quoted, from its own stored tax_amount
        // over its total less its discount share, instead of silently
        // dropping to 0% tax.
        const taxedBase = item.total - quoteShares[idx];
        const derivedTaxRate = taxedBase > 0 ? parseFloat((item.tax_amount / taxedBase * 100).toFixed(4)) : 0;
        return {
          product_id: item.product_id,
          variation_id: null,
          name: item.sale_line?.name ?? item.product_name,
          serial_number: item.serial_number || null,
          price: parseFloat(item.sale_line?.unit_price ?? item.unit_price),
          tax_rate: product ? (product.tax_rate || 0) : derivedTaxRate,
          quantity: item.sale_line?.quantity ?? item.quantity,
          is_service: product?.product_type === 'service' ? 1 : 0,
          is_delivery: item.is_delivery ? 1 : 0,
          stock_qty: product?.stock_qty ?? 999,
          ...this._recalledUnitFields(item, product),
          // Catalog line (not a Special Project rental line or SN line):
          // quoted price while the quote is valid, else today's price.
          ...(item.product_id && !item.is_rental_line && !item.serial_number ? this._quotedLineFields(item, product, quoteValid) : {}),
        };
      });
      this.cartDiscount = parseFloat(quote.discount_amount || 0);
      this._storeCreditApplied = 0;
      this._cashBackApplied = 0;
      this.appliedPromoCode = null;
      this._returnCredit = null;
      this._activeQuoteId = quote.id;
      // The quote's salesperson started this sale (credit and receipt).
      this._ticketCreatedBy = quote.original_employee_id || quote.employee_id || null;
      this._renderTicketSalesperson();
      this._ticketPoNumber = quote.po_number || null;
      this._renderTicketPoNumber();

      if (quote.customer_id) {
        const customer = await this.api('GET', `/customers/${quote.customer_id}`);
        this.cartCustomer = customer;
        if (this.section !== 'pos') return;
        this._renderCartCustomer();
        const bar = document.getElementById('store-credit-bar');
        if (bar) bar.style.display = 'none';
        const cbBar = document.getElementById('cash-back-bar');
        if (cbBar) cbBar.style.display = 'none';
      }
      if (this.section !== 'pos') return;

      const aqBar = document.getElementById('active-quote-bar');
      if (aqBar) {
        document.getElementById('active-quote-number').textContent = quote.quote_number;
        aqBar.style.display = 'flex';
      }

      this.closeModal();
      this.renderCart();
      if (!quoteValid && quote.items.some(i => i.product_id && !i.is_rental_line && !i.serial_number)) {
        this.alert(`${quote.quote_number} expired on ${this.fmtDate(quote.valid_until)} — its items are at today's prices, not the quoted prices`, 'warning');
      } else {
        this.alert(`Loaded ${quote.quote_number} — select payment method to complete`, 'success');
      }
    } catch(e) {
      this.alert(e.message, 'error');
    }
  },

  clearActiveQuote() {
    this._activeQuoteId = null;
    const aqBar = document.getElementById('active-quote-bar');
    if (aqBar) aqBar.style.display = 'none';
  },

  // Itemized per-leg rows for a split-tender sale's receipt, replacing the
  // single Payment/Tendered/Approval-code block used for normal sales.
  // foreignCash is a same-order-as-tx.payments array from
  // showSplitTenderModal (or undefined for older/API-created split sales) —
  // the DB itself only ever stores base-currency amounts, so this detail is
  // only available right after the sale, same as the single-tender cash flow.
  _splitPaymentReceiptRows(tx, foreignCash) {
    const payments = tx.payments || [];
    return payments.map((p, i) => {
      const refLabel = p.payment_method === 'direct_deposit' ? 'Ref #' : p.payment_method === 'gift_card' ? 'Gift Card #' : (p.payment_method === 'credit_card' || p.payment_method === 'debit_card') ? 'Approval' : null;
      const foreign = foreignCash && foreignCash[i];
      const foreignLine = foreign ? `<div class="receipt-row" style="font-size:10px;color:#666"><span>Tendered (${foreign.currency})</span><span>${foreign.currency} ${this._n2(foreign.tenderedAlt)}</span></div>` : '';
      return `<div class="receipt-row"><span>${p.payment_method.replace('_',' ').toUpperCase()}</span><span>${this.fmt(p.amount)}</span></div>${foreignLine}${p.approval_code && refLabel ? `<div class="receipt-row" style="font-size:10px;color:#666"><span>${refLabel}</span><span>${p.approval_code}</span></div>` : ''}`;
    }).join('');
  },

  // Rental transactions skip the on-screen thermal receipt preview — its
  // Normal/Letter choice doesn't apply to them (there's no thermal-printer
  // rental workflow) — and go straight to the letter-size rental tax
  // invoice, same document printRentalInvoice() opens from the agreement.
  // Document title for a sale's printed/emailed copy. A sale that came from
  // a quotation converted to an invoice (sent to a cashier and cashed out)
  // is a tax invoice, not a receipt — source_quote_id is joined by both
  // POST /transactions and GET /transactions/:id. Mirrors receiptDocTitle()
  // in routes/email.js.
  // Settings → Receipt Footer Message as HTML, keeping its line breaks
  // (mirrors footerHtml() in routes/email.js).
  _receiptFooterHtml(fallback) {
    return String(this.settings?.receipt_footer || fallback)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\r?\n/g, '<br>');
  },

  _txDocTitle(tx) {
    // A rental's checkout invoice is the Rental Agreement (the Full Summary
    // is the Rental Tax Invoice). A Special Project invoice that includes a
    // rental is still the project's own Retail Tax Invoice, as is every
    // other retail sale on the letter-size copy.
    if (tx.rental_role === 'settlement') return 'Rental Settlement';
    if (tx.rental_role === 'checkout' && !tx.rental_quotation_id) return 'Rental Agreement';
    return 'Retail Tax Invoice';
  },

  printReceiptOrInvoice(tx, change = 0, cashResult = null, splitForeignCash = null) {
    if (tx.rental_agreement_number) {
      this._lastReceiptTx = tx;
      this._lastReceiptChange = change;
      this._lastReceiptCash = cashResult;
      this._lastReceiptSplitForeign = splitForeignCash;
      this.printReceiptLetter();
    } else {
      this.showReceipt(tx, change, cashResult, splitForeignCash);
    }
  },

  // Percentage a manual line-item discount took off a sold line (the "%"
  // button in the POS cart), for receipts — 0 when the line wasn't
  // discounted. Prefers the stored discount_percent; falls back to deriving
  // it from discount_amount for lines discounted some other way.
  _lineDiscountPct(i) {
    const pct = parseFloat(i.discount_percent) || 0;
    if (pct > 0) return pct;
    const gross = (parseFloat(i.unit_price) || 0) * (parseFloat(i.quantity) || 0);
    const amt = parseFloat(i.discount_amount) || 0;
    return amt > 0 && gross > 0 ? parseFloat((amt / gross * 100).toFixed(2)) : 0;
  },

  showReceipt(tx, change = 0, cashResult = null, splitForeignCash = null) {
    const items = tx.items || [];
    const storeName = this.settings.store_name || 'My Store';
    const footer = this._receiptFooterHtml('Thank you!');
    // Stashed for printReceiptLetter(), which can't take these as onclick
    // arguments (tx/cashResult are objects) — same pattern as App._viewTx
    // used elsewhere to hand a full record across an onclick boundary.
    this._lastReceiptTx = tx;
    this._lastReceiptChange = change;
    this._lastReceiptCash = cashResult;
    this._lastReceiptSplitForeign = splitForeignCash;

    const overlay = this.showModal(`
      <div class="modal" style="max-width:400px">
        <div class="modal-header">
          <span class="modal-title">${tx.source_quote_id ? 'Tax Invoice' : 'Receipt'}</span>
          <button class="modal-close" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="receipt">
            <div class="receipt-store" style="text-align:center;font-weight:700;font-size:15px;margin-bottom:6px">${storeName}</div>
            ${this._printLogoTag(36, true)}
            ${tx.branch_name ? `<div class="receipt-title">${tx.branch_name}</div>` : ''}
            ${tx.source_quote_id ? `<div class="receipt-title" style="margin-top:6px">RETAIL TAX INVOICE</div>` : ''}
            ${tx.branch_address ? `<div style="text-align:center;font-size:11px;color:#666">${tx.branch_address}${tx.branch_city ? ', ' + tx.branch_city : ''}${tx.branch_state ? ' ' + tx.branch_state : ''}${tx.branch_zip ? ' ' + tx.branch_zip : ''}</div>` : `<div style="text-align:center;font-size:11px;color:#666">${this.settings.store_address || ''}</div>`}
            <div style="text-align:center;font-size:11px;color:#666">${tx.branch_phone || this.settings.store_phone || ''}</div>
            <hr>
            <div class="receipt-row"><span>Transaction #:</span><span>${tx.transaction_number}</span></div>
            <div class="receipt-row"><span>Date:</span><span>${this.fmtDateTime(tx.created_at)}</span></div>
            ${tx.customer_name ? `<div class="receipt-row"><span>Customer:</span><span>${tx.customer_name}</span></div>` : ''}
            ${tx.created_by_name ? `<div class="receipt-row"><span>Created By:</span><span>${tx.created_by_name}</span></div>` : ''}
            ${tx.salesperson_name ? `<div class="receipt-row"><span>Salesperson:</span><span>${tx.salesperson_name}</span></div>` : ''}
            ${tx.employee_name ? `<div class="receipt-row"><span>Cashier:</span><span>${tx.employee_name}</span></div>` : ''}
            <hr>
            ${items.map(i => { if (i.is_comment) return `<div class="receipt-item" style="font-style:italic;white-space:pre-wrap;padding-left:8px">${this.escapeAttr(i.product_name)}</div>`; if (i.serial_number) return `<div class="receipt-item" style="padding-left:8px;font-size:12px">${this._serialNote(i)}</div>`; const pct = this._lineDiscountPct(i); return `<div class="receipt-item">
              <div>${i.sku ? `<span style="font-size:11px;color:#555">${i.sku}</span> ` : ''}${i.product_name}</div>
              <div class="receipt-row"><span style="padding-left:8px">${i.quantity} x ${this.fmt(i.unit_price)}</span><span>${this.fmt(i.total)}</span></div>
              ${pct > 0 ? `<div style="color:#666;font-size:11px;padding-left:8px">less ${i.discount_fixed > 0 ? this.fmt(i.discount_amount) : `${pct}% (-${this.fmt(i.discount_amount)})`}</div>` : ''}
            </div>`; }).join('')}
            <hr>
            <div class="receipt-row"><span>Subtotal</span><span>${this.fmt(tx.subtotal)}</span></div>
            ${tx.discount_amount > 0 && tx.discount_pre_tax ? `<div class="receipt-row"><span>Discount${tx.promotion_code ? ` (${tx.promotion_code})` : ''}</span><span>-${this.fmt(tx.discount_amount)}</span></div>${tx.promotion_name ? `<div style="color:#666;font-size:11px;padding-left:4px">${tx.promotion_name}</div>` : ''}` : ''}
            ${tx.tax_exempt ? `<div class="receipt-row" style="color:#2e7d32"><span>Tax Exempt${tx.tax_exemption_number ? ` — Ref: ${tx.tax_exemption_number}` : ''}</span><span>—</span></div>` : `<div class="receipt-row"><span>Tax</span><span>${this.fmt(tx.tax_amount)}</span></div>`}
            ${tx.discount_amount > 0 && !tx.discount_pre_tax ? `<div class="receipt-row"><span>Discount${tx.promotion_code ? ` (${tx.promotion_code})` : ''}</span><span>-${this.fmt(tx.discount_amount)}</span></div>${tx.promotion_name ? `<div style="color:#666;font-size:11px;padding-left:4px">${tx.promotion_name}</div>` : ''}` : ''}
            <hr>
            <div class="receipt-row receipt-total"><span>TOTAL</span><span>${this.fmt(tx.total)}</span></div>
            ${tx.payment_method === 'split' ? this._splitPaymentReceiptRows(tx, splitForeignCash) : `<div class="receipt-row"><span>Payment</span><span>${tx.payment_method.replace('_',' ').toUpperCase()}</span></div>
            ${tx.amount_tendered > tx.total ? (cashResult?.rate && cashResult.rate !== 1 ? `<div class="receipt-row"><span>Tendered (${cashResult.currency})</span><span>${cashResult.currency} ${this._n2(cashResult.tenderedAlt)}</span></div><div class="receipt-row" style="font-size:10px;color:#666"><span>Equivalent</span><span>${this.fmt(tx.amount_tendered)}</span></div><div class="receipt-row"><span>Change</span><span>${this._changeDisplay(cashResult, change)}</span></div>` : `<div class="receipt-row"><span>Tendered</span><span>${this.fmt(tx.amount_tendered)}</span></div><div class="receipt-row"><span>Change</span><span>${this._changeDisplay(cashResult, change)}</span></div>`) : ''}
            ${tx.approval_code ? `<div class="receipt-row"><span>${tx.payment_method === 'direct_deposit' ? 'Deposit Ref #' : tx.payment_method === 'gift_card' ? 'Gift Card #' : 'Approval Code'}</span><span style="font-family:monospace;font-weight:600">${tx.approval_code}</span></div>` : ''}`}
            <hr>
            <div style="text-align:center;margin-top:4px">${footer}</div>
          </div>
        </div>
        <div class="modal-footer no-print">
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
          <button class="btn btn-secondary" onclick="App.emailReceipt(${tx.id},'${(tx.customer_email||'').replace(/'/g,"\\'")}')">✉️ Email</button>
          ${tx.rental_agreement_number
            ? `<button class="btn btn-primary" onclick="App.printReceiptLetter()">🖨️ Print</button>`
            : `<button class="btn btn-secondary" onclick="window.print()">🖨️ Normal</button><button class="btn btn-primary" onclick="App.printReceiptLetter()">🖨️ Letter</button>`}
        </div>
      </div>`);
  },

  // All Issue and Return signature checkpoints in one row (up to 4 columns)
  // instead of two stacked rows — each label is prefixed with which
  // checkpoint it belongs to, so the grouping stays clear at a glance while
  // taking a fraction of the vertical space.
  _signatureRowsHtml(issueSignatures, returnSignatures) {
    const sigs = [
      ...issueSignatures.map(([label, name, src, signedAt]) => [`Issued — ${label}`, name, src, signedAt]),
      ...returnSignatures.map(([label, name, src, signedAt]) => [`Returned — ${label}`, name, src, signedAt]),
    ];
    if (!sigs.length) return '';
    return `<div style="margin-top:24px;display:flex;justify-content:space-between;gap:16px">
      ${sigs.map(([label, name, src, signedAt]) => `<div style="flex:1;text-align:center">
        <img src="${src}" style="max-height:50px;max-width:100%;border-bottom:1px solid #333;padding-bottom:4px" />
        <div style="font-size:10px;color:#555;margin-top:4px">${label}${name ? ` — ${name}` : ''}</div>
        ${signedAt ? `<div style="font-size:9px;color:#888;margin-top:1px">${this.fmtDateTime(signedAt)}</div>` : ''}
      </div>`).join('')}
    </div>`;
  },

  // Rental-linked transactions always print letter-size (routed here
  // directly by showReceipt's Print button); other transactions get this as
  // an alternative to the default narrow thermal-receipt print. A separate
  // full-page popup document — same window.open('')+document.write()+
  // auto-print pattern as printCustomerHistory/printPickList/
  // printDrawerReport — rather than trying to conditionally swap @page size
  // on the existing thermal .receipt modal, which isn't reliably scriptable
  // across browsers.
  async printReceiptLetter() {
    const tx = this._lastReceiptTx;
    if (!tx) return;
    // Opened synchronously, before any await below — a window.open() that
    // happens after an await is no longer inside the original click's user-
    // gesture stack, so browsers silently block it as a popup. Grabbing the
    // window handle here first, then filling it in once the async rental
    // lookup below resolves, keeps this a direct response to the click.
    const win = window.open('', '_blank', 'width=850,height=1000');
    if (!win) { this.alert('Your browser blocked the print popup — allow popups for this site and try again', 'warning'); return; }
    const change = this._lastReceiptChange || 0;
    const cashResult = this._lastReceiptCash;
    const splitForeignCash = this._lastReceiptSplitForeign;
    const items = tx.items || [];
    const storeName = this.settings.store_name || 'My Store';
    const footer = this._receiptFooterHtml('Thank you!');
    const addressLine = tx.branch_address || this.settings.store_address || '';
    const cityLine = tx.branch_address ? `${tx.branch_city ? ', ' + tx.branch_city : ''}${tx.branch_state ? ' ' + tx.branch_state : ''}${tx.branch_zip ? ' ' + tx.branch_zip : ''}` : '';
    const phoneLine = tx.branch_phone || this.settings.store_phone || '';

    const isRental = !!tx.rental_agreement_number;
    // Customer P.O. # — the sale's own, else a credit rental's.
    const poNumber = tx.po_number || tx.rental_po_number || '';
    // The line items on this specific transaction only tell the financial
    // story (checkout = rental fee + deposit, settlement = duration
    // adjustment + deposit applied) — neither reliably names the physical
    // item(s) rented, so pull that straight from the agreement. The same
    // fetch also carries the digitally-captured signatures for whichever
    // checkpoint (issue vs return) this transaction corresponds to.
    let rentedItemsLabel = '';
    // Both checkpoints' signatures are shown on whichever invoice gets
    // printed (checkout or settlement) — not just the one matching this
    // specific transaction's role — since by the time a settlement invoice
    // exists the issue signatures are already on file, and printing the
    // checkout invoice after return shouldn't hide that the item came back
    // signed-for too.
    let issueSignatures = [];
    let returnSignatures = [];
    if (isRental && tx.rental_agreement_id) {
      try {
        const agreement = await this.api('GET', `/rentals/agreements/${tx.rental_agreement_id}`);
        rentedItemsLabel = (agreement.items || []).filter(i => !i.parent_item_id).map(i => `${i.product_name} x${i.quantity}`).join(', ');
        if (agreement.issue_customer_signature) issueSignatures.push(['Customer Signature', agreement.customer_name, agreement.issue_customer_signature, agreement.issued_at]);
        if (agreement.issue_security_signature) issueSignatures.push(['Security Signature', agreement.issue_security_employee_name, agreement.issue_security_signature, agreement.issue_security_confirmed_at]);
        if (agreement.return_security_signature) returnSignatures.push(['Security Signature', agreement.return_security_employee_name, agreement.return_security_signature, agreement.return_security_confirmed_at]);
        if (agreement.return_driver_signature) returnSignatures.push(['Driver Signature', agreement.return_driver_employee_name, agreement.return_driver_signature, agreement.return_driver_confirmed_at]);
      } catch(e) {}
    }
    const signatureBlocks = [...issueSignatures, ...returnSignatures];
    const rentalRentedLabel = tx.rental_checkout_datetime ? this.fmtDateTime(tx.rental_checkout_datetime) : '—';
    const rentalReturnedLabel = tx.rental_returned_at ? this.fmtDateTime(tx.rental_returned_at) : 'Not yet returned';
    const rentalDurationCellLabel = this.rentalDurationLabel(tx.rental_checkout_datetime, tx.rental_due_date, tx.rental_returned_at);
    const hasLineDiscount = items.some(i => this._lineDiscountPct(i) > 0);
    const itemCols = 5 + (isRental ? 3 : 0) + (hasLineDiscount ? 1 : 0);
    const itemRows = items.map(i => i.is_comment || i.serial_number ? `<tr>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8"></td>
        <td colspan="${itemCols - 1}" style="padding:8px;border-bottom:1px solid #e8e8e8;${i.is_comment ? 'font-style:italic;white-space:pre-wrap' : 'font-size:12px;color:#444'}">${i.is_comment ? this.escapeAttr(i.product_name) : this._serialNote(i)}</td>
      </tr>` : `<tr>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;white-space:nowrap;color:#555">${i.sku || ''}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8">${i.product_name}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:center">${i.quantity}</td>
        ${isRental ? `<td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:center">${rentalRentedLabel}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:center">${rentalReturnedLabel}</td>
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:center">${rentalDurationCellLabel}</td>` : ''}
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:right">${this.fmt(i.unit_price)}</td>
        ${hasLineDiscount ? `<td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:right">${this._lineDiscountPct(i) > 0 ? (i.discount_fixed > 0 ? this.fmt(i.discount_amount) : `${this._lineDiscountPct(i)}%`) : '—'}</td>` : ''}
        <td style="padding:8px;border-bottom:1px solid #e8e8e8;text-align:right;font-weight:600">${this.fmt(i.total)}</td>
      </tr>`).join('');

    // A rental CHECKOUT transaction (not a settlement/return one — those
    // reverse the deposit instead of charging it, so their DEPOSIT line is
    // negative) breaks the totals down as Sub-Total Amount / Sales Tax /
    // Sales Total / Rental Deposit / Grand Total instead of the plain
    // Subtotal/Tax/TOTAL every other transaction type uses — the deposit
    // equals Sales Total (fee + tax), per the double-charge model in
    // PATCH .../checkout in routes/rentals.js.
    let rentalBreakdown = null;
    if (isRental) {
      const depositLine = items.find(i => i.sku === 'DEPOSIT' && i.total > 0);
      if (depositLine) {
        const serviceTotal = items.filter(i => ['DELIVERY', 'PICKUP', 'OPERATOR'].includes(i.sku)).reduce((s, i) => s + i.total, 0);
        const subTotalAmount = parseFloat((tx.subtotal - depositLine.total - serviceTotal).toFixed(2));
        rentalBreakdown = { subTotalAmount, salesTotal: parseFloat((subTotalAmount + tx.tax_amount).toFixed(2)), depositAmt: depositLine.total };
      }
    }

    const summaryRows = (rentalBreakdown ? [
      ['Sub-Total Amount', this.fmt(rentalBreakdown.subTotalAmount)],
      ['Sales Tax', this.fmt(tx.tax_amount)],
      ['Sales Total', this.fmt(rentalBreakdown.salesTotal)],
      ['Rental Deposit', this.fmt(rentalBreakdown.depositAmt)],
      tx.discount_amount > 0 ? ['Discount', `-${this.fmt(tx.discount_amount)}`] : null,
    ] : [
      ['Subtotal', this.fmt(tx.subtotal)],
      // Discount above tax on sales where it came off before tax (discount_pre_tax), below it on older ones.
      tx.discount_amount > 0 && tx.discount_pre_tax ? [`Discount${tx.promotion_code ? ` (${tx.promotion_code})` : ''}`, `-${this.fmt(tx.discount_amount)}`] : null,
      tx.tax_exempt ? [`Tax Exempt${tx.tax_exemption_number ? ` — Ref: ${tx.tax_exemption_number}` : ''}`, '—'] : ['Tax', this.fmt(tx.tax_amount)],
      tx.discount_amount > 0 && !tx.discount_pre_tax ? [`Discount${tx.promotion_code ? ` (${tx.promotion_code})` : ''}`, `-${this.fmt(tx.discount_amount)}`] : null,
    ]).filter(Boolean);

    const tenderRows = [];
    if (tx.payment_method === 'split') {
      (tx.payments || []).forEach((p, i) => {
        const refLabel = p.payment_method === 'direct_deposit' ? 'Ref #' : p.payment_method === 'gift_card' ? 'Gift Card #' : (p.payment_method === 'credit_card' || p.payment_method === 'debit_card') ? 'Approval' : null;
        tenderRows.push([p.payment_method.replace('_',' ').toUpperCase(), this.fmt(p.amount)]);
        const foreign = splitForeignCash && splitForeignCash[i];
        if (foreign) tenderRows.push([`Tendered (${foreign.currency})`, `${foreign.currency} ${this._n2(foreign.tenderedAlt)}`]);
        if (p.approval_code && refLabel) tenderRows.push([refLabel, p.approval_code]);
      });
    } else {
      if (tx.amount_tendered > tx.total) {
        if (cashResult?.rate && cashResult.rate !== 1) {
          tenderRows.push([`Tendered (${cashResult.currency})`, `${cashResult.currency} ${this._n2(cashResult.tenderedAlt)}`], ['Equivalent', this.fmt(tx.amount_tendered)], ['Change', this._changeDisplay(cashResult, change)]);
        } else {
          tenderRows.push(['Tendered', this.fmt(tx.amount_tendered)], ['Change', this._changeDisplay(cashResult, change)]);
        }
      }
      if (tx.approval_code) {
        const label = tx.payment_method === 'direct_deposit' ? 'Deposit Ref #' : tx.payment_method === 'gift_card' ? 'Gift Card #' : 'Approval Code';
        tenderRows.push([label, tx.approval_code]);
      }
    }

    win.document.write(`<!DOCTYPE html><html><head><title>${this._txDocTitle(tx)} – ${tx.transaction_number}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:13px;margin:0;padding:48px;color:#111}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
      .store h1{font-size:20px;margin:0 0 2px}
      .store div{font-size:12px;color:#555}
      .doc-title{font-size:22px;font-weight:700;text-align:right;color:#333}
      .meta{display:flex;gap:32px;margin-bottom:20px;font-size:12px}
      .meta div{line-height:1.6}
      .meta label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      table{width:100%;border-collapse:collapse}
      th{background:#f0f0f0;text-align:left;padding:8px;font-size:11px;text-transform:uppercase;color:#555}
      ${this._billToPrintCss}
      .totals{width:280px;margin-left:auto;margin-top:16px;font-size:13px}
      .totals tr td{padding:4px 0;border:none}
      .totals .total-row td{border-top:2px solid #111;font-size:16px;font-weight:700;padding-top:8px}
      .footer{margin-top:32px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:10px;text-align:center}
      @page { size: letter; margin: 0.75in; }
      @media print{body{padding:0}}
    </style></head><body>
    <div style="text-align:center;font-weight:700;font-size:20px;margin-bottom:16px">${storeName}</div>
    <div class="header">
      <div class="store">
        ${this._printLogoTag(50)}
        ${tx.branch_name ? `<h1>${tx.branch_name}</h1>` : ''}
        ${addressLine ? `<div>${addressLine}${cityLine}</div>` : ''}
        ${phoneLine ? `<div>${phoneLine}</div>` : ''}
      </div>
      <div class="doc-title">${this._txDocTitle(tx).toUpperCase()}</div>
    </div>
    ${this._billToPrintHtml(tx, [['Invoice #', tx.transaction_number], ['Date', this.fmtDateTime(tx.created_at)], ['P.O. #', this._poValueHtml(poNumber)], ['Quotation', tx.source_quote_number]])}
    <div class="meta">
      ${tx.rental_agreement_number ? `<div><label>Rental Agreement</label>${tx.rental_agreement_number}</div>` : ''}
      ${tx.created_by_name || tx.employee_name ? `<div><label>Created By</label>${tx.created_by_name || tx.employee_name}</div>` : ''}
      ${tx.salesperson_name ? `<div><label>Salesperson</label>${tx.salesperson_name}</div>` : ''}
      ${tx.employee_name ? `<div><label>Cashier</label>${tx.employee_name}</div>` : ''}
      ${rentedItemsLabel ? `<div><label>Item(s) Rented</label>${rentedItemsLabel}</div>` : ''}
      ${tx.rental_due_date ? `<div><label>Due Date</label>${this.fmtDate(tx.rental_due_date)}</div>` : ''}
    </div>
    <table>
      <thead><tr><th>SKU</th><th>Item</th><th style="text-align:center">Qty</th>${isRental ? `<th style="text-align:center">Rented</th><th style="text-align:center">Returned</th><th style="text-align:center">Duration</th>` : ''}<th style="text-align:right">Unit Price</th>${hasLineDiscount ? '<th style="text-align:right">Discount</th>' : ''}<th style="text-align:right">Total</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <table class="totals">
      ${summaryRows.map(([l,v]) => `<tr><td>${l}</td><td style="text-align:right">${v}</td></tr>`).join('')}
      <tr class="total-row"><td>${rentalBreakdown ? 'Grand Total' : 'TOTAL'}</td><td style="text-align:right">${this.fmt(tx.total)}</td></tr>
      <tr><td>Payment</td><td style="text-align:right">${tx.payment_method.replace('_',' ').toUpperCase()}</td></tr>
      ${tenderRows.map(([l,v]) => `<tr><td>${l}</td><td style="text-align:right">${v}</td></tr>`).join('')}
    </table>
    ${tx.rental_pauses?.length ? `
    <div style="margin-top:20px">
      <div style="font-size:11px;font-weight:bold;text-transform:uppercase;color:#555;margin-bottom:6px">Paused Periods</div>
      <table>
        <thead><tr><th>Reason</th><th>Notes</th><th>Start</th><th>Stop</th></tr></thead>
        <tbody>${tx.rental_pauses.map(p => `<tr>
          <td style="text-transform:capitalize">${p.reason}</td>
          <td>${p.notes || '—'}</td>
          <td>${this.fmtDateTime(p.started_at)}</td>
          <td>${p.ended_at ? this.fmtDateTime(p.ended_at) : 'Ongoing'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : ''}
    ${signatureBlocks.length ? this._signatureRowsHtml(issueSignatures, returnSignatures) + this._invoiceSignatureLinesHtml(issueSignatures.some(([l]) => l === 'Customer Signature')) : (tx.rental_agreement_number ? `
    <div style="display:flex;justify-content:space-between;margin-top:70px;gap:24px">
      <div style="flex:1;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">Customer Signature</div></div>
      <div style="flex:1;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">Rep Signature</div></div>
      <div style="flex:1;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">Manager Signature</div></div>
    </div>` : this._invoiceSignatureLinesHtml())}
    <div class="footer">${footer}</div>
    <script>window.onload=()=>{window.print()}<\/script>
    </body></html>`);
    win.document.close();
  },

  // Searches the server as the cashier types (first 50 matches) rather than
  // loading every customer on file into the modal. Rows are picked by index
  // into the current results, so names with quotes (O'Brien) can't break
  // the click handler.
  selectCustomer() {
    const overlay = this.showModal(`
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Select Customer</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input type="text" id="cust-search-modal" placeholder="Search by name, phone, email or customer #..." style="flex:1;margin:0" autocomplete="off">
            ${this.can('customers_add') ? `<button class="btn btn-primary" style="white-space:nowrap" onclick="App._addCustomerFromLookup('pos')">+ Add New Customer</button>` : ''}
          </div>
          <div style="max-height:320px;overflow-y:auto" id="cust-list"><div style="padding:10px;color:var(--text-muted)">Loading…</div></div>
        </div>
      </div>`);
    const input = overlay.querySelector('#cust-search-modal');
    const list = overlay.querySelector('#cust-list');
    const LIMIT = 50;
    let results = [], seq = 0, timer = null;
    const esc = v => this.escapeAttr(v ?? '');
    const load = async () => {
      const q = input.value.trim();
      const mine = ++seq;
      try {
        const rows = await this.api('GET', `/customers?active=1&limit=${LIMIT}${q ? `&search=${encodeURIComponent(q)}` : ''}`);
        if (mine !== seq || !overlay.isConnected) return;
        results = rows;
        if (!rows.length) { list.innerHTML = `<div style="padding:10px;color:var(--text-muted)">No customers found</div>`; return; }
        list.innerHTML = rows.map((c, i) => {
          const blocked = c.customer_type === 'credit' && c.account_blocked;
          const typeTag = c.customer_type === 'credit'
            ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#e3f2fd;color:#1565c0;margin-left:4px">Credit</span>`
            : '';
          const blockedTag = blocked
            ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#ffebee;color:#c62828;margin-left:4px">BLOCKED</span>`
            : '';
          const taxExemptTag = c.tax_exempt
            ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#e8f5e9;color:#2e7d32;margin-left:4px">Tax Exempt</span>`
            : '';
          return `<div class="nav-item" data-idx="${i}" style="color:var(--text);border-radius:6px;${blocked?'opacity:0.6':''}">
            <div><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong><span style="color:var(--text-muted);font-size:12px;margin-left:4px">${esc(c.customer_number)}</span>${typeTag}${blockedTag}${taxExemptTag}</div>
            <div style="font-size:12px;color:var(--text-muted)">${esc(c.phone)} &bull; ${c.loyalty_points || 0} pts</div>
          </div>`;
        }).join('') + (rows.length >= LIMIT ? `<div style="padding:8px 10px;font-size:12px;color:var(--text-muted)">Showing the first ${LIMIT} — keep typing to narrow it down</div>` : '');
      } catch (e) {
        if (mine === seq) list.innerHTML = `<div style="padding:10px;color:var(--danger)">${esc(e.message)}</div>`;
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    list.addEventListener('click', e => {
      const c = results[e.target.closest('[data-idx]')?.dataset.idx];
      if (!c) return;
      if (c.customer_type === 'credit' && c.account_blocked) {
        this.alert('Account blocked: overdue balance must be settled before making purchases.', 'error');
        return;
      }
      overlay.remove();
      this.setCartCustomer(c.id, `${c.first_name} ${c.last_name}`);
    });
    input.focus();
    load();
  },

  // "+ Add New Customer" from any customer lookup. What was typed in the
  // lookup's search box seeds the form (digits → phone, "@" → email,
  // otherwise first/last name); once saved, the new customer is picked in
  // that lookup just as if it had been searched for and clicked.
  _addCustomerFromLookup(kind) {
    const searchId = { pos: 'cust-search-modal', rental: 'rc-customer-search', layaway: 'lc-customer-search' }[kind] || `${kind}-search`;
    const q = (document.getElementById(searchId)?.value || '').trim();
    document.querySelectorAll('.cust-picker-dd, #rc-customer-dd, #lc-customer-dd').forEach(dd => { dd.style.display = 'none'; });
    const addTo = (list, c) => { if (list && !list.some(x => String(x.id) === String(c.id))) list.unshift(c); };
    this.openCustomerFormOver(q, c => {
      if (kind === 'pos') { this.closeModal(); this.setCartCustomer(c.id, `${c.first_name} ${c.last_name}`); }
      else if (kind === 'rental') { addTo(this._rentalCustomers, c); this._selectRentalCustomer(c.id); }
      else if (kind === 'layaway') { addTo(this._layawayCustomers, c); this._selectLayawayCustomer(c.id); }
      else {
        addTo((this._custPickerLists || {})[kind]?.customers, c);
        this._selectCustomerPicker(kind, c.id);
      }
    });
  },

  // Dropdown row appended to the searchable customer pickers.
  _addCustomerRowHtml(kind) {
    if (!this.can('customers_add')) return '';
    return `<div class="nav-item" style="padding:8px 10px;cursor:pointer;color:var(--accent);font-weight:600;border-bottom:1px solid var(--border)" onclick="App._addCustomerFromLookup('${kind}')">+ Add New Customer</div>`;
  },

  // showModal only allows one overlay at a time, so opening the customer
  // form normally would destroy the half-filled form underneath (a quote,
  // rental, etc.). Instead the current overlay is stashed (hidden, and
  // renamed so showModal/closeModal skip it) and restored once the customer
  // form — or the duplicate-customer modal that can replace it — is gone.
  async openCustomerFormOver(query, onCreated) {
    const q = (query || '').trim();
    const prefill = {};
    if (q.includes('@')) prefill.email = q;
    else if (q && /^[\d\s()+-]+$/.test(q)) prefill.phone = q;
    else if (q) {
      const parts = q.split(/\s+/);
      prefill.first_name = parts.shift();
      prefill.last_name = parts.join(' ');
    }
    const parents = [...document.querySelectorAll('.modal-overlay')];
    parents.forEach(el => { el.classList.replace('modal-overlay', 'modal-overlay-stashed'); el.style.display = 'none'; });
    const stack = { onCreated };
    stack.restore = () => {
      stack.obs?.disconnect();
      if (this._customerFormStack === stack) this._customerFormStack = null;
      parents.forEach(el => { el.classList.replace('modal-overlay-stashed', 'modal-overlay'); el.style.display = ''; });
    };
    this._customerFormStack = stack;
    try {
      await this.showCustomerForm(null, { prefill });
    } catch (e) {
      stack.restore();
      return this.alert(e.message, 'error');
    }
    stack.obs = new MutationObserver(() => { if (!document.querySelector('.modal-overlay')) stack.restore(); });
    stack.obs.observe(document.body, { childList: true });
  },

  // Called with the new (or chosen existing duplicate) customer's id when
  // the customer form was opened via openCustomerFormOver.
  async _finishStackedCustomerForm(customerId) {
    const stack = this._customerFormStack;
    if (!stack) return;
    try {
      const c = await this.api('GET', `/customers/${customerId}`);
      this.closeModal();
      stack.restore();
      this.alert('Customer added');
      stack.onCreated(c);
    } catch (e) { this.alert(e.message, 'error'); }
  },

  // Client-side mirror of computeAvailableCashBack() in routes/transactions.js
  // — used only to decide whether to show the bar; the backend independently
  // re-derives and clamps this at checkout, so this never needs to be exact
  // to the millisecond (cooldown check).
  availableCashBack(c) {
    if (!c.cash_back_card_type_id || !c.cash_back_card_type_active) return 0;
    const threshold = c.cash_back_points_threshold, reward = c.cash_back_reward_amount;
    if (!threshold || !reward) return 0;
    const accrued = Math.floor((c.loyalty_points || 0) / threshold) * reward;
    if (accrued <= 0) return 0;
    if (c.cash_back_min_redeem_amount > 0 && accrued < c.cash_back_min_redeem_amount) return 0;
    if (c.cash_back_min_redeem_days > 0 && c.cash_back_last_redeemed_at) {
      const daysSince = (Date.now() - this._toDate(c.cash_back_last_redeemed_at).getTime()) / 86400000;
      if (daysSince < c.cash_back_min_redeem_days) return 0;
    }
    return accrued;
  },

  // The POS ticket's customer block — name on its own line, then phone,
  // category, Cash/Credit type and a Rental badge, so the cashier can
  // confirm at a glance they've attached the right customer (and which
  // tenders/rentals apply) without opening the customer record.
  _cartCustomerHtml() {
    const c = this.cartCustomer;
    if (!c) return 'Walk-in Customer';
    const esc = v => this.escapeAttr(v);
    const isCredit = String(c.customer_type || '').toLowerCase() === 'credit';
    const meta = [
      c.phone ? `<span>📞 ${esc(c.phone)}</span>` : '',
      c.customer_category_name ? `<span class="badge-pill badge-teal" title="Customer category">${esc(c.customer_category_name)}</span>` : '',
      `<span class="badge-pill ${isCredit ? 'badge-blue' : 'badge-success'}" title="Customer type">${isCredit ? 'Credit' : 'Cash'}</span>`,
      c.is_rental_customer ? `<span class="badge-pill badge-purple" title="Rental customer">🔑 Rental</span>` : '',
      c.account_blocked ? `<span class="badge-pill badge-danger" title="${this.escapeAttr(this._creditBlockedText(c))}">Blocked</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="cart-cust-name">${esc(`${c.first_name || ''} ${c.last_name || ''}`.trim())}</div><div class="cart-cust-meta">${meta}</div>`;
  },

  // Repaints the customer block from this.cartCustomer; no-op off the POS
  // screen (several callers set the customer before/without rendering POS).
  _renderCartCustomer() {
    const el = document.getElementById('cart-customer-name');
    if (el) el.innerHTML = this._cartCustomerHtml();
    const btn = document.getElementById('remove-customer-btn');
    if (btn) btn.style.display = this.cartCustomer ? 'inline-flex' : 'none';
  },

  // A customer's discount card, else their category discount (also used by
  // Hold Recall) — null when neither applies.
  _customerDiscountCard(c) {
    if (c.discount_card_type_id && c.discount_card_type_active) return { type_name: c.discount_card_type_name, percent: c.discount_card_percent, card_number: c.discount_card_number, label: 'Discount Card' };
    if (c.customer_category_id && c.customer_category_active && c.customer_category_discount_percent > 0) return { type_name: c.customer_category_name, percent: c.customer_category_discount_percent, card_number: null, label: 'Customer Discount' };
    return null;
  },

  setCartCustomer(id, name) {
    this.api('GET', `/customers/${id}`).then(async c => {
      this.cartCustomer = c;
      this._storeCreditApplied = 0;
      this._cashBackApplied = 0;
      this._renderCartCustomer();
      this._renderTicketSalesperson();
      const bar = document.getElementById('store-credit-bar');
      const bal = parseFloat(c.account_balance || 0);
      // account_balance is a receivable (positive = customer owes the
      // store); a credit note (routes/transactions.js return handling,
      // routes/rentals.js deposit credit notes) decrements it, so a
      // negative balance here means the store owes THEM — that's the
      // available credit this bar lets them redeem.
      if (bal < 0 && c.customer_type !== 'credit') {
        document.getElementById('store-credit-balance').textContent = this.fmt(Math.abs(bal));
        document.getElementById('remove-store-credit-btn').style.display = 'none';
        bar.style.display = 'flex';
      } else {
        bar.style.display = 'none';
      }
      const cbBar = document.getElementById('cash-back-bar');
      const cbAvailable = this.availableCashBack(c);
      if (cbAvailable > 0) {
        document.getElementById('cash-back-balance').textContent = this.fmt(cbAvailable);
        document.getElementById('remove-cash-back-btn').style.display = 'none';
        cbBar.style.display = 'flex';
      } else {
        cbBar.style.display = 'none';
      }
      // Discount cards never stack with a promo code — a card-carrying
      // customer takes priority over whatever promo was already applied.
      // A customer category's discount works the same way but only kicks in
      // when there's no discount card — a card is a more deliberate,
      // specific assignment and wins if the customer somehow has both.
      this.appliedDiscountCard = this._customerDiscountCard(c);
      if (this.appliedDiscountCard) {
        this.appliedPromoCode = null;
        this.autoAppliedPromo = null;
        this._availablePromos = [];
        this._manualTicketDiscount = false; this._manualTicketDiscountPct = null;
        const pi = document.getElementById('promo-code-input');
        if (pi) pi.value = '';
        const rb = document.getElementById('remove-promo-btn');
        if (rb) rb.style.display = 'none';
      }
      this._updateDiscountCardUI();
      await this._checkAutoPromos();
      this.renderCart();
      if (this.can('pos_hold')) {
        try {
          const held = await this.api('GET', `/transactions?status=hold&customer_id=${id}`);
          if (held.length > 0) {
            this.alert(`${held.length} held order${held.length > 1 ? 's' : ''} found for ${name} — click Recall to load`, 'info');
          }
        } catch(e) {}
      }
    }).catch(e => this.alert(e.message, 'error'));
  },

  applyStoreCredit() {
    const bal = parseFloat(this.cartCustomer?.account_balance || 0);
    if (bal >= 0) return;
    const available = Math.abs(bal);
    const { subtotal, tax, discount } = this.getCartTotals();
    const maxApplicable = Math.max(0, parseFloat((subtotal - discount + tax).toFixed(2)));
    this._storeCreditApplied = Math.min(available, maxApplicable);
    document.getElementById('remove-store-credit-btn').style.display = 'inline-flex';
    document.querySelector('#store-credit-bar button:not(#remove-store-credit-btn)').style.display = 'none';
    this.renderCart();
  },

  removeStoreCredit() {
    this._storeCreditApplied = 0;
    document.getElementById('remove-store-credit-btn').style.display = 'none';
    document.querySelector('#store-credit-bar button:not(#remove-store-credit-btn)').style.display = '';
    this.renderCart();
  },

  applyCashBack() {
    const available = this.availableCashBack(this.cartCustomer || {});
    if (available <= 0) return;
    const { subtotal, tax, discount } = this.getCartTotals();
    const maxApplicable = Math.max(0, parseFloat((subtotal - discount + tax - (this._storeCreditApplied || 0)).toFixed(2)));
    this._cashBackApplied = Math.min(available, maxApplicable);
    document.getElementById('remove-cash-back-btn').style.display = 'inline-flex';
    document.querySelector('#cash-back-bar button:not(#remove-cash-back-btn)').style.display = 'none';
    this.renderCart();
  },

  removeCashBack() {
    this._cashBackApplied = 0;
    document.getElementById('remove-cash-back-btn').style.display = 'none';
    document.querySelector('#cash-back-bar button:not(#remove-cash-back-btn)').style.display = '';
    this.renderCart();
  },

  removeCustomer() {
    this.cartCustomer = null;
    this._storeCreditApplied = 0;
    this._cashBackApplied = 0;
    this.appliedDiscountCard = null;
    this._renderCartCustomer();
    document.getElementById('store-credit-bar').style.display = 'none';
    document.getElementById('cash-back-bar').style.display = 'none';
    this._updateDiscountCardUI();
    this._checkAutoPromos();
    this.renderCart();
  },

  // ─── Category and product emoji ──────────────────────────────────
  categoryEmoji(name = '') {
    const map = { electronics: '🔌', clothing: '👕', 'food & beverage': '🍕', 'home & garden': '🏠', 'sports & outdoors': '⚽', 'toys & games': '🎮' };
    return map[name.toLowerCase()] || '📦';
  },

  productEmoji(cat) {
    const map = { electronics: '💻', clothing: '👗', 'food & beverage': '🍫', 'home & garden': '🌿', 'sports & outdoors': '🏃', 'toys & games': '🧸' };
    return map[(cat || '').toLowerCase()] || '🛍️';
  },
});
