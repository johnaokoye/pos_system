// App state, init, auth, My Profile, notifications, hubs, showSection, api(), utilities, modals.
const App = {
  section: 'home',
  currentUser: null,
  cart: [],
  cartCustomer: null,
  cartDiscount: 0,
  _storeCreditApplied: 0,
  _cashBackApplied: 0,
  _activeQuoteId: null,
  // Employee who started the current cart, when recalled from a hold someone
  // else created — sent as created_by so the receipt can show both people.
  _ticketCreatedBy: null,
  _ticketSalesperson: null,
  allProducts: [],
  allCategories: [],
  posCategory: 'all',
  posSearch: '',
  settings: {},
  activeCurrency: null,
  altCurrencies: [],
  appliedPromoCode: null,

  CURRENCIES: [
    ['USD','USD - US Dollar ($)'],['EUR','EUR - Euro (€)'],['GBP','GBP - British Pound (£)'],
    ['CAD','CAD - Canadian Dollar (CA$)'],['AUD','AUD - Australian Dollar (A$)'],
    ['JPY','JPY - Japanese Yen (¥)'],['CHF','CHF - Swiss Franc'],['CNY','CNY - Chinese Yuan (¥)'],
    ['INR','INR - Indian Rupee (₹)'],['ZAR','ZAR - South African Rand (R)'],
    ['NGN','NGN - Nigerian Naira (₦)'],['GHS','GHS - Ghanaian Cedi (₵)'],
    ['KES','KES - Kenyan Shilling (KSh)'],['UGX','UGX - Ugandan Shilling (USh)'],
    ['TZS','TZS - Tanzanian Shilling (TSh)'],['ETB','ETB - Ethiopian Birr (Br)'],
    ['EGP','EGP - Egyptian Pound (£)'],['MAD','MAD - Moroccan Dirham (MAD)'],
    ['XOF','XOF - West African CFA Franc'],['XAF','XAF - Central African CFA Franc'],
    ['JMD','JMD - Jamaican Dollar (J$)'],
    ['MXN','MXN - Mexican Peso ($)'],['BRL','BRL - Brazilian Real (R$)'],
    ['ARS','ARS - Argentine Peso ($)'],['COP','COP - Colombian Peso ($)'],
    ['CLP','CLP - Chilean Peso ($)'],['PEN','PEN - Peruvian Sol (S/)'],
    ['AED','AED - UAE Dirham (د.إ)'],['SAR','SAR - Saudi Riyal (﷼)'],
    ['QAR','QAR - Qatari Riyal (﷼)'],['KWD','KWD - Kuwaiti Dinar (د.ك)'],
    ['BHD','BHD - Bahraini Dinar (BD)'],['OMR','OMR - Omani Rial (﷼)'],
    ['JOD','JOD - Jordanian Dinar (JD)'],['ILS','ILS - Israeli Shekel (₪)'],
    ['TRY','TRY - Turkish Lira (₺)'],['RUB','RUB - Russian Ruble (₽)'],
    ['UAH','UAH - Ukrainian Hryvnia (₴)'],['PLN','PLN - Polish Złoty (zł)'],
    ['CZK','CZK - Czech Koruna (Kč)'],['HUF','HUF - Hungarian Forint (Ft)'],
    ['RON','RON - Romanian Leu (lei)'],['SEK','SEK - Swedish Krona (kr)'],
    ['NOK','NOK - Norwegian Krone (kr)'],['DKK','DKK - Danish Krone (kr)'],
    ['SGD','SGD - Singapore Dollar (S$)'],['HKD','HKD - Hong Kong Dollar (HK$)'],
    ['NZD','NZD - New Zealand Dollar (NZ$)'],['MYR','MYR - Malaysian Ringgit (RM)'],
    ['THB','THB - Thai Baht (฿)'],['PHP','PHP - Philippine Peso (₱)'],
    ['IDR','IDR - Indonesian Rupiah (Rp)'],['VND','VND - Vietnamese Dong (₫)'],
    ['PKR','PKR - Pakistani Rupee (₨)'],['BDT','BDT - Bangladeshi Taka (৳)'],
    ['LKR','LKR - Sri Lankan Rupee (₨)'],['NPR','NPR - Nepalese Rupee (₨)'],
    ['TWD','TWD - Taiwan Dollar (NT$)'],['KRW','KRW - South Korean Won (₩)'],
    ['ZMW','ZMW - Zambian Kwacha (ZK)'],['BWP','BWP - Botswana Pula (P)'],
    ['NAD','NAD - Namibian Dollar (N$)'],['MZN','MZN - Mozambican Metical (MT)'],
    ['RWF','RWF - Rwandan Franc (RF)'],['AOA','AOA - Angolan Kwanza (Kz)'],
  ],

  currencyOptions(selected, includeGlobal = false) {
    const globalOpt = includeGlobal ? `<option value=""${!selected ? ' selected' : ''}>— Use global setting —</option>` : '';
    return globalOpt + this.CURRENCIES.map(([code, label]) =>
      `<option value="${code}"${selected === code ? ' selected' : ''}>${label}</option>`
    ).join('');
  },

  // ─── Init ────────────────────────────────────────────────
  async init() {
    this._initSearchableSelects();
    this.updateClock();
    setInterval(() => this.updateClock(), 1000);
    // The 8h session cookie survives a page reload even though this.currentUser
    // (in-memory only) doesn't — a backgrounded tab getting discarded/reloaded
    // by the browser, or a plain refresh, used to always bounce straight to the
    // login screen even with a still-valid session. Try to restore it first.
    try {
      const emp = await this.api('GET', '/employees/me');
      this.currentUser = emp;
      if (emp.must_change_password) this.showChangePasswordModal(emp.id, true);
      else this.enterApp();
      return;
    } catch (e) { /* no valid session — fall through to the login screen */ }
    // Show the login form (and bind its handlers) before the branding fetch,
    // not after. The form was already on screen during the session check, so
    // keep anything typed in it meanwhile.
    this.showLoginScreen(true);
    // GET /settings is authenticated (tax rate, SMTP creds, etc. live there
    // too) so it 401s before login — /settings/public exposes just the
    // store name/logo so the login screen can show real branding.
    try {
      const pub = await this.api('GET', '/settings/public');
      this.applyBranding(pub.company_logo_url, pub.store_name);
      this._showBuildVersion(pub.build_commit, 'login-build-version');
    } catch(e) {}
  },

  // Shown on the login screen (pre-auth, from /settings/public) and in
  // Settings (post-auth, from /settings) — same value either way, just two
  // places someone would think to look to answer "is this Docker deployment
  // actually running the latest code?" without shelling into the container.
  _showBuildVersion(commit, elId) {
    const el = document.getElementById(elId);
    if (!el || !commit) return;
    el.textContent = `Build: ${commit}`;
  },

  // Swaps the "RetailPOS" wordmark for an uploaded logo image, both on the
  // pre-login screen and the sidebar — called on init() (public branding)
  // and again after enterApp()/saveSettings() load the full settings object.
  applyBranding(logoUrl, storeName) {
    const html = logoUrl
      ? `<div class="brand-logo-wrap"><img src="${logoUrl}" alt="${(storeName || 'Company logo').replace(/"/g,'&quot;')}"><p>Business Hub</p></div>`
      : `<h1>&#9673; RetailPOS</h1><p>Point of Sale System</p>`;
    const loginEl = document.getElementById('login-logo-content');
    const sidebarEl = document.getElementById('sidebar-logo-content');
    if (loginEl) { loginEl.innerHTML = html; if (logoUrl) this._fitBrandCaption(loginEl); }
    if (sidebarEl) { sidebarEl.innerHTML = html; if (logoUrl) this._fitBrandCaption(sidebarEl); }
  },

  // Scales the "Business Hub" caption's font-size so the left-aligned text
  // spans exactly as wide as the logo image above it (rather than justify's
  // spread-the-words trick) — measured against the image's actual rendered
  // width, which varies per uploaded logo, so this has to happen in JS
  // after the image has loaded rather than as a fixed CSS value.
  _fitBrandCaption(container) {
    const img = container.querySelector('img');
    const p = container.querySelector('p');
    if (!img || !p) return;
    const fit = () => {
      const targetWidth = img.offsetWidth;
      p.style.fontSize = '';
      const naturalWidth = p.offsetWidth;
      if (!targetWidth || !naturalWidth) return;
      const baseSize = parseFloat(getComputedStyle(p).fontSize);
      p.style.fontSize = `${(baseSize * (targetWidth / naturalWidth)).toFixed(2)}px`;
    };
    if (img.complete) fit(); else img.addEventListener('load', fit, { once: true });
  },

  // Shared by every printable document (sale/void/return/cancellation
  // receipts, customer history, pick lists, drawer reports) — always emits
  // an absolute URL since several of these render inside a separate blank
  // popup window (window.open('') + document.write()) with no base URL of
  // its own to resolve a relative /uploads/... path against. Left-aligned
  // by default (no centering) since none of these templates set text-align
  // on their container, so it lands top-left without extra styling; pass
  // center=true for the narrow thermal receipt, where it sits under the
  // centered store name.
  _printLogoTag(maxHeight = 40, center = false) {
    const url = this.settings?.company_logo_url;
    if (!url) return '';
    const src = /^https?:\/\//.test(url) ? url : `${location.origin}${url}`;
    const alt = (this.settings.store_name || 'Logo').replace(/"/g, '&quot;');
    return `<img src="${src}" alt="${alt}" style="display:block;max-height:${maxHeight}px;max-width:220px;object-fit:contain;margin:${center ? '0 auto 8px' : '0 0 8px'}">`;
  },

  updateClock() {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('clock').textContent = t;
    // POS kiosk mode hides #topbar (and its #clock) entirely — this mirrors
    // the same running interval into the POS status bar's own clock when
    // that page is open, rather than starting a second interval.
    const posClock = document.getElementById('pos-kiosk-clock');
    if (posClock) posClock.textContent = t;
  },

  bindNav() {
    document.querySelectorAll('.nav-item[data-section]').forEach(el => {
      el.addEventListener('click', () => this.showSection(el.dataset.section));
    });
  },

  // ─── Auth ─────────────────────────────────────────────────
  showLoginScreen(keepInput = false) {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('main').style.display = 'none';
    if (!keepInput) {
      document.getElementById('login-user').value = '';
      document.getElementById('login-pass').value = '';
      document.getElementById('login-error').textContent = '';
    }
    setTimeout(() => {
      if (document.activeElement?.id !== 'login-pass') document.getElementById('login-user').focus();
    }, 50);
    document.getElementById('login-user').onkeydown = e => { if (e.key === 'Enter') document.getElementById('login-pass').focus(); };
    document.getElementById('login-pass').onkeydown = e => { if (e.key === 'Enter') this.doLogin(); };
  },

  async doLogin() {
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    if (!username || !password) { errEl.textContent = 'Please enter username and password.'; return; }
    try {
      const emp = await this.api('POST', '/employees/login', { username, password });
      this.currentUser = emp;
      if (emp.must_change_password) {
        this.showChangePasswordModal(emp.id, true);
      } else {
        this.enterApp();
      }
    } catch (e) {
      errEl.textContent = 'Invalid username or password.';
    }
  },

  // ── My Profile / saved approval signature ─────────────────────
  // Everyone can open My Profile (their name in the top bar or the sidebar
  // footer) to save their approval signature ahead of time — drawn or an
  // uploaded picture — so the Approve dialogs just apply it
  // (lib/signatures.js resolveApprovalSignature). Employees editors can do the
  // same for a staff member from the employee form.
  async showMyProfile() {
    const u = this.currentUser;
    if (!u) return;
    let sig = null, canSign = false;
    try { ({ approval_signature: sig, can_sign: canSign } = await this.api('GET', '/employees/me/signature')); } catch (e) {}
    const branches = (u.branches || []).map(b => this.escapeAttr(b.name)).join(', ');
    // Only approvers keep a signature; anyone who lost approval rights can still remove an old one.
    const sigSection = canSign ? `
          <div style="font-weight:700;margin-bottom:4px">Approval signature</div>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Applied when you approve purchase orders, purchase requests, payment requests, Special Projects or commissions. Documents you've already approved keep the signature they were signed with.</p>
          <div id="my-sig-box">${this._signaturePreviewHtml(sig)}</div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" onclick="App._editMySignature()">${sig ? 'Replace signature' : 'Add signature'}</button>
            ${sig ? `<button class="btn btn-sm btn-outline" onclick="App._removeMySignature()">Remove</button>` : ''}
          </div>` : sig ? `
          <div style="font-weight:700;margin-bottom:4px">Approval signature</div>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">You no longer have approval permissions, so this saved signature isn't used. You can remove it.</p>
          <div>${this._signaturePreviewHtml(sig)}</div>
          <div style="margin-top:8px"><button class="btn btn-sm btn-outline" onclick="App._removeMySignature()">Remove</button></div>` : '';
    this.showModal(`
      <div class="modal" style="max-width:520px">
        <div class="modal-header"><span class="modal-title">My Profile</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13px;margin-bottom:16px">
            <span style="color:var(--text-muted)">Name</span><strong>${this.escapeAttr(`${u.first_name || ''} ${u.last_name || ''}`)}</strong>
            <span style="color:var(--text-muted)">Username</span><span>${this.escapeAttr(u.username || '—')}</span>
            ${u.employee_number ? `<span style="color:var(--text-muted)">Employee #</span><span>${this.escapeAttr(u.employee_number)}</span>` : ''}
            <span style="color:var(--text-muted)">Security group</span><span>${this.escapeAttr(u.security_group_name || '—')}</span>
            ${branches ? `<span style="color:var(--text-muted)">Branches</span><span>${branches}</span>` : ''}
          </div>
          ${sigSection}
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="App.showChangePasswordModal(${u.id})">Change Password</button>
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  showChangePasswordModal(empId, required = false) {
    if (required) document.getElementById('login-screen').style.display = 'none';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'change-pw-overlay';
    overlay.style.zIndex = '9500';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <div class="modal-header"><span class="modal-title">${required ? 'Password Change Required' : 'Change Password'}</span></div>
        <div class="modal-body">
          ${required ? '<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">You must set a new password before continuing.</p>' : ''}
          <div class="form-group"><label>New Password</label><input type="password" id="cp-new" placeholder="Enter new password"></div>
          <div class="form-group"><label>Confirm Password</label><input type="password" id="cp-confirm" placeholder="Confirm new password"></div>
          <div id="cp-error" style="color:var(--danger);font-size:13px;min-height:18px"></div>
        </div>
        <div class="modal-footer">
          ${required ? '' : `<button class="btn btn-secondary" onclick="document.getElementById('change-pw-overlay')?.remove()">Cancel</button>`}
          <button class="btn btn-primary" onclick="App.doChangePassword(${empId}, ${required})">Update Password</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('cp-new').focus(), 50);
  },

  async doChangePassword(empId, required = false) {
    const newPw = document.getElementById('cp-new').value;
    const confirm = document.getElementById('cp-confirm').value;
    const errEl = document.getElementById('cp-error');
    errEl.textContent = '';
    if (!newPw) { errEl.textContent = 'Password cannot be empty.'; return; }
    if (newPw !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
    try {
      await this.api('PUT', `/employees/${empId}/change-password`, { password: newPw });
      document.getElementById('change-pw-overlay')?.remove();
      if (required) this.enterApp();
      else this.alert('Password updated successfully');
    } catch (e) {
      errEl.textContent = e.message || 'Failed to update password';
    }
  },

  enterApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('sidebar').style.display = '';
    document.getElementById('main').style.display = '';
    // Non-blocking — the pre-login /settings/public fetch in init() already
    // painted a best-effort logo; this replaces it with the authenticated
    // GET /settings response (needed since /settings/public never runs again).
    this.loadSettings().catch(() => {});
    const name = this.currentUser.first_name + ' ' + this.currentUser.last_name;
    const defaultBranch = (this.currentUser.branches || []).find(b => b.is_default) || (this.currentUser.branches || [])[0];
    this.activeCurrency = defaultBranch?.currency || null;
    document.getElementById('cashier-name').textContent = name;
    document.getElementById('cashier-role').textContent = this.currentUser.security_group_name || 'No Group';
    document.getElementById('topbar-user').textContent = name;
    this.bindNav();
    this.applyNavPermissions();
    // Everyone starts on Home; drivers/guards on their own purpose-built
    // view — neither role needs more than their rental checkpoint queue.
    let firstSection;
    if (this.currentUser.is_driver) firstSection = 'driver-dashboard';
    else if (this.currentUser.is_security) firstSection = 'guard-dashboard';
    else firstSection = 'home';
    this.showSection(firstSection);
    this.checkLowStock();
    this._startTransferInbox();
    this._startShopUseInbox();
    this._startCollectionsInbox();
    this._startPayablesInbox();
    this._resumeDownloadAfterLogin();
  },

  // ─── Transfer request notifications ─────────────────────────────────────
  // The inventory team (transfers_approve) is told when a branch requests
  // stock from one of their branches: GET /transfers/inbox is polled every
  // minute; each request not seen before pops a notice that stays until
  // dismissed, and the waiting count shows on the Warehouse menu item and
  // the Branch Transfers tile. Requests that arrived while signed out come
  // up as one summary at sign-in. Seen ids are remembered per user in this
  // browser (localStorage) so a reload doesn't repeat them.
  _startTransferInbox() {
    clearInterval(this._trfInboxTimer);
    this._trfInboxCount = 0;
    this._trfInboxFirst = true;
    if (!this.can('transfers_approve')) return this._paintTransferBadges();
    this._pollTransferInbox();
    this._trfInboxTimer = setInterval(() => this._pollTransferInbox(), 60000);
  },

  _stopTransferInbox() {
    clearInterval(this._trfInboxTimer);
    this._trfInboxTimer = null;
    this._trfInboxCount = 0;
    this._paintTransferBadges();
    document.getElementById('notify-stack')?.remove();
  },

  _trfSeenKey() { return `trfInboxSeen:${this.currentUser?.id}`; },
  _trfSeenIds() {
    try { return new Set(JSON.parse(localStorage.getItem(this._trfSeenKey()) || '[]')); } catch { return new Set(); }
  },
  _trfRememberSeen(ids) {
    try { localStorage.setItem(this._trfSeenKey(), JSON.stringify([...ids].slice(-200))); } catch {}
  },

  async _pollTransferInbox() {
    if (!this.currentUser || !this.can('transfers_approve')) return;
    let inbox;
    try { inbox = await this.api('GET', '/transfers/inbox'); } catch { return; }
    if (!this.currentUser) return;
    this._trfInboxCount = inbox.count;
    this._paintTransferBadges();
    const seen = this._trfSeenIds();
    const fresh = inbox.requests.filter(r => !seen.has(r.id));
    if (fresh.length) {
      if (this._trfInboxFirst && fresh.length > 1) {
        this._notify({
          title: `📦 ${fresh.length} transfer requests waiting`,
          body: `Branches are waiting on stock from ${[...new Set(fresh.map(r => r.from_branch_name))].join(', ')}.`,
          actions: [{ label: 'Open Branch Transfers', run: () => this.showSection('transfers') }],
        });
      } else {
        for (const r of fresh.slice().reverse()) {
          this._notify({
            title: `📦 Transfer request ${r.transfer_number}`,
            body: `<strong>${this.escapeAttr(r.to_branch_name)}</strong> requests ${r.item_count} item${r.item_count === 1 ? '' : 's'} (${r.unit_count} unit${r.unit_count === 1 ? '' : 's'}) from ${this.escapeAttr(r.from_branch_name)}${r.employee_name ? ` · ${this.escapeAttr(r.employee_name)}` : ''}${r.notes ? `<div style="color:var(--text-muted);margin-top:4px">${this.escapeAttr(r.notes)}</div>` : ''}`,
            actions: [
              { label: 'Review &amp; Send', primary: true, run: () => this.showSendTransfer(r.id) },
              { label: '🗒 Pick List', run: () => this.printTransferPickList(r.id) },
            ],
          });
        }
      }
      fresh.forEach(r => seen.add(r.id));
      this._trfRememberSeen(seen);
    }
    this._trfInboxFirst = false;
  },

  // ─── Accounts Payable notifications ─────────────────────────────────────
  // Payment requests waiting on the signed-in person — to approve
  // (payables_approve; never their own) or, once approved, to pay
  // (payables_payments): GET /payables/payment-requests/inbox, polled every
  // minute. Each one not seen before (per request + stage) pops a notice
  // that stays until dismissed; the waiting count shows on the Accounts menu
  // item and the Accounts Payable tile. Seen ones are remembered per user in
  // this browser, like the transfer inbox above.
  _startPayablesInbox() {
    clearInterval(this._apInboxTimer);
    this._apInboxCount = 0;
    this._apInboxFirst = true;
    if (!this.can('payables_approve') && !this.can('payables_payments')) return this._paintPayablesBadges();
    this._pollPayablesInbox();
    this._apInboxTimer = setInterval(() => this._pollPayablesInbox(), 60000);
  },

  _stopPayablesInbox() {
    clearInterval(this._apInboxTimer);
    this._apInboxTimer = null;
    this._apInboxCount = 0;
    this._paintPayablesBadges();
  },

  _apSeenKey() { return `apInboxSeen:${this.currentUser?.id}`; },

  // "Pay by" text for a request, flagged when the date is close or past.
  _prqPayByHtml(date, { short = false, label = 'Pay by ' } = {}) {
    if (!date) return short ? '—' : '';
    const today = this._storeDay(new Date());
    const days = Math.round((new Date(date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
    const when = days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    const color = days < 0 ? 'var(--danger,#dc2626)' : days <= 3 ? 'var(--warning,#b45309)' : 'inherit';
    return `<span style="color:${color};${days <= 3 ? 'font-weight:600' : ''}">${short ? '' : label}${this._apDate(date)}${days <= 7 ? ` <span style="font-size:11px">(${when})</span>` : ''}</span>`;
  },

  async _pollPayablesInbox() {
    if (!this.currentUser || (!this.can('payables_approve') && !this.can('payables_payments'))) return;
    let inbox;
    try { inbox = await this.api('GET', '/payables/payment-requests/inbox'); } catch { return; }
    if (!this.currentUser) return;
    this._apInboxCount = inbox.count;
    this._paintPayablesBadges();
    let seen;
    try { seen = new Set(JSON.parse(localStorage.getItem(this._apSeenKey()) || '[]')); } catch { seen = new Set(); }
    const key = r => `${r.id}:${r.stage}`;
    const fresh = inbox.requests.filter(r => !seen.has(key(r)));
    if (fresh.length) {
      if (this._apInboxFirst && fresh.length > 1) {
        const toApprove = fresh.filter(r => r.stage === 'approve').length, toPay = fresh.length - toApprove;
        this._notify({
          title: `💵 ${fresh.length} payment requests waiting`,
          body: [toApprove ? `${toApprove} to approve` : '', toPay ? `${toPay} approved and ready to pay` : ''].filter(Boolean).join(' · ')
            + (fresh.some(r => r.scheduled_date || r.required_date) ? `<div style="margin-top:4px">Earliest date: ${this._prqPayByHtml(fresh.filter(r => r.scheduled_date || r.required_date).map(r => r.scheduled_date || r.required_date).sort()[0], { short: true })}</div>` : ''),
          actions: [{ label: 'Open Accounts Payable', primary: true, run: () => this._openPayablesRequests() }],
        });
      } else {
        for (const r of fresh.slice().reverse()) {
          const what = r.request_type === 'advance' ? `Advance on ${this.escapeAttr(r.po_number || 'PO')}` : (this._prqTypeLabel[r.request_type] || r.request_type);
          this._notify({
            title: r.stage === 'approve' ? `💵 Payment request ${r.request_number}` : `💵 ${r.request_number} approved — ready to pay`,
            body: `<strong>${this.escapeAttr(r.supplier_name)}</strong> · ${this.fmt(r.amount)} · ${what}`
              + `${r.requested_by_name ? `<div style="color:var(--text-muted)">Requested by ${this.escapeAttr(r.requested_by_name)}</div>` : ''}`
              + `${r.required_date ? `<div>${this._prqPayByHtml(r.required_date, { label: 'Requested for ' })}</div>` : ''}`
              + `${r.stage === 'pay' && r.scheduled_date ? `<div>${this._prqPayByHtml(r.scheduled_date, { label: 'Scheduled for ' })}</div>` : ''}`
              + `${r.notes ? `<div style="color:var(--text-muted);margin-top:4px">${this.escapeAttr(r.notes)}</div>` : ''}`,
            actions: [{ label: r.stage === 'approve' ? 'Review' : 'Open', primary: true, run: () => this._openPayablesRequests(r.id) }],
          });
        }
      }
      fresh.forEach(r => seen.add(key(r)));
      try { localStorage.setItem(this._apSeenKey(), JSON.stringify([...seen].slice(-300))); } catch {}
    }
    this._apInboxFirst = false;
  },

  async _openPayablesRequests(requestId) {
    this._apTab = 'requests';
    this._prqFilter = { status: 'open', supplier_id: '', q: '' };
    await this.showSection('payables');
    if (requestId) this.viewPaymentRequest(requestId);
  },

  // Waiting count on the Accounts menu item and the Accounts Payable tile.
  _paintPayablesBadges() {
    const n = this._apInboxCount || 0;
    for (const el of [document.querySelector('.nav-item[data-section="accounts-hub"]'), document.querySelector('.hub-tile[data-section="payables"]')]) {
      if (!el) continue;
      let pill = el.querySelector('.count-pill.ap-inbox');
      if (!n) { pill?.remove(); continue; }
      if (!pill) { pill = document.createElement('span'); pill.className = 'count-pill ap-inbox'; el.appendChild(pill); }
      pill.textContent = n > 99 ? '99+' : n;
      pill.title = `${n} payment request${n === 1 ? '' : 's'} waiting on you (to approve or pay)`;
    }
  },

  // A notice that stays on screen (bottom-right) until closed or acted on —
  // unlike alert(), which fades after 3 seconds.
  _notify({ title, body, actions = [] }) {
    let stack = document.getElementById('notify-stack');
    if (!stack) { stack = document.createElement('div'); stack.id = 'notify-stack'; document.body.appendChild(stack); }
    const card = document.createElement('div');
    card.className = 'notify-card';
    card.innerHTML = `
      <div class="notify-title"><span>${title}</span><button class="notify-close" title="Dismiss">✕</button></div>
      <div>${body}</div>
      ${actions.length ? `<div class="notify-actions">${actions.map((a, i) => `<button class="btn btn-sm ${a.primary ? 'btn-primary' : 'btn-outline'}" data-i="${i}">${a.label}</button>`).join('')}</div>` : ''}`;
    card.querySelector('.notify-close').onclick = () => card.remove();
    card.querySelectorAll('.notify-actions button').forEach(btn => {
      btn.onclick = () => { card.remove(); actions[btn.dataset.i].run(); };
    });
    stack.appendChild(card);
    while (stack.children.length > 4) stack.firstElementChild.remove();
  },

  // Waiting-request count on the Warehouse menu item and (when the hub is
  // open) the Branch Transfers tile; nothing shown at 0.
  _paintTransferBadges() {
    const n = this._trfInboxCount || 0;
    const paint = (el, cls) => {
      if (!el) return;
      let pill = el.querySelector(`.count-pill.${cls}`);
      if (!n) { pill?.remove(); return; }
      if (!pill) { pill = document.createElement('span'); pill.className = `count-pill ${cls}`; el.appendChild(pill); }
      pill.textContent = n > 99 ? '99+' : n;
      pill.title = `${n} transfer request${n === 1 ? '' : 's'} waiting to be sent`;
    };
    paint(document.querySelector('.hub-tile[data-section="transfers"]'), 'trf-inbox');
    this._paintWarehouseNavBadge();
  },

  // The Warehouse menu item carries one pill: transfer requests to send plus
  // Shop Use requests waiting on you.
  _paintWarehouseNavBadge() {
    const el = document.querySelector('.nav-item[data-section="warehouse-hub"]');
    if (!el) return;
    el.querySelector('.count-pill.trf-inbox')?.remove();
    const t = this._trfInboxCount || 0, u = this._suInboxCount || 0, n = t + u;
    let pill = el.querySelector('.count-pill.wh-inbox');
    if (!n) { pill?.remove(); return; }
    if (!pill) { pill = document.createElement('span'); pill.className = 'count-pill wh-inbox'; el.appendChild(pill); }
    pill.textContent = n > 99 ? '99+' : n;
    pill.title = [t ? `${t} transfer request${t === 1 ? '' : 's'} waiting to be sent` : '', u ? `${u} Shop Use request${u === 1 ? '' : 's'} waiting on you` : ''].filter(Boolean).join(' · ');
  },

  // server.js redirects a logged-out browser hitting a document download
  // link, or a protected /uploads/ file (ID scan, signature), to
  // /?next=<that link>; once signed in, open it. Downloads are sent as
  // attachments, so the app stays open. Only those same-origin paths are
  // honoured, so ?next can't redirect elsewhere.
  _resumeDownloadAfterLogin() {
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    if (!next) return;
    history.replaceState(null, '', window.location.pathname);
    if (/^\/api\/[\w\-\/]+\/download$/.test(next) || /^\/uploads\/[\w-]+\/[\w.-]+$/.test(next)) window.location.assign(next);
  },

  // Sidebar headers that expand into a grid of large touch tiles instead of
  // listing their sub-links directly in the sidebar.
  _hubGroups: {
    'dispatch': { title: 'Dispatch', children: [
      { section: 'transfer-dispatch', label: 'Branch Transfers', color: '#2196F3', icon: '<path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/>' },
    ]},
    'purchasing-hub': { title: 'Purchasing', children: [
      { section: 'suppliers', label: 'Suppliers', color: '#2196F3', icon: '<path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>' },
      { section: 'purchasing', label: 'Purchase Orders', color: '#00897B', icon: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/>' },
      { section: 'purchase-requests', label: 'Purchase Requests', color: '#FF9800', icon: '<path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>' },
    ]},
    'sales-hub': { title: 'Sales', children: [
      { section: 'pos', label: 'Point of Sale', color: '#2196F3', icon: '<path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/>' },
      { section: 'customers', label: 'Customers', color: '#00897B', icon: '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>' },
      { section: 'quotations', label: 'Quotations', color: '#4CAF50', icon: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>' },
      { section: 'special-projects', label: 'Special Projects', color: '#c62828', icon: '<path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>' },
      { section: 'special-orders', label: 'Special Orders', color: '#6A1B9A', icon: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>' },
      { section: 'rentals', label: 'Rentals', color: '#FF9800', icon: '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6l-3 3-4.3-4.3C.6 7.1 1 10.1 3 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.4-.4.4-1 0-1.4z"/>' },
      { section: 'rental-dispatch', label: 'Rental Dispatch', color: '#ef6c00', icon: '<path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>' },
      { section: 'rental-deposits', label: 'Rental Deposits', color: '#d84315', icon: '<path d="M19.5 3.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2v16H3v3c0 1.66 1.34 3 3 3h12c1.66 0 3-1.34 3-3V2l-1.5 1.5zM19 19c0 .55-.45 1-1 1s-1-.45-1-1v-3H8V5h11v14z"/>' },
      { section: 'rental-items', label: 'Rental Items', color: '#f4511e', icon: '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6l-3 3-4.3-4.3C.6 7.1 1 10.1 3 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.4-.4.4-1 0-1.4z"/>' },
      { section: 'work-orders', label: 'Work Orders', color: '#546e7a', icon: '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6l-3 3-4.3-4.3C.6 7.1 1 10.1 3 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.4-.4.4-1 0-1.4z"/>' },
      { section: 'layaway', label: 'Layaway', color: '#8d6e63', icon: '<path d="M20 6h-2.18c.11-.31.18-.65.18-1a2.996 2.996 0 0 0-5.5-1.65l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v6z"/>' },
      { section: 'transactions', label: 'Transactions', color: '#9c27b0', icon: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/>' },
      { section: 'online-orders', label: 'Online Orders', color: '#3b6bc4', icon: '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm4.24 16L12 15.45 7.77 18l1.12-4.81-3.73-3.23 4.92-.42L12 5l1.92 4.53 4.92.42-3.73 3.23L16.23 18z"/>' },
      { section: 'shipping', label: 'Shipping', color: '#607d8b', icon: '<path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 13.93l-3.5-3.5 1.41-1.41L11 12.1l5.59-5.59L18 7.93l-7 7z"/>' },
      { section: 'crm', label: 'CRM / Sales', color: '#7e57c2', icon: '<path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/>' },
      { section: 'commissions', label: 'Commissions', color: '#26a69a', icon: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z"/>' },
      { section: 'promotions', label: 'Promotions', color: '#5c6bc0', icon: '<path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>' },
      { section: 'discount-cards', label: 'Discount Cards', color: '#ec407a', icon: '<path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/>' },
      { section: 'cash-back-cards', label: 'Cash Back Cards', color: '#f9a825', icon: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15.63V19h-2v-1.35c-1.5-.28-2.77-1.14-3.28-2.68l1.79-.74c.36 1.11 1.24 1.82 2.49 1.82.99 0 1.79-.4 1.79-1.14 0-.86-1.03-1.13-2.19-1.44-1.55-.4-3.46-.94-3.46-3.09 0-1.47 1.13-2.58 2.66-2.87V6h2v1.35c1.28.26 2.4.94 2.94 2.14l-1.71.86c-.36-.75-1.08-1.28-2.02-1.28-.99 0-1.61.44-1.61 1.05 0 .75.94.98 2.1 1.28 1.6.42 3.55.94 3.55 3.22 0 1.55-1.16 2.63-2.7 2.9z"/>' },
    ]},
    'accounts-hub': { title: 'Accounts', children: [
      { section: 'accounts', label: 'Accounts / AR', color: '#2196F3', icon: '<path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>' },
      { section: 'payables', label: 'Accounts Payable', color: '#e53935', icon: '<path d="M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/>' },
      { section: 'drawers', label: 'Cash Drawers', color: '#00897B', icon: '<path d="M20 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V8h16v2zM6 14h2v2H6zm4 0h6v2h-6z"/>' },
      { section: 'reports', label: 'Reports', color: '#4CAF50', icon: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>' },
    ]},
    'reports-hub': { title: 'Reports', children: [
      { section: 'reports-marketing', label: 'Marketing', color: '#5c6bc0', icon: '<path d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"/>' },
      { section: 'reports-sales', label: 'Sales', color: '#26a69a', icon: '<path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/>' },
      { section: 'reports-purchasing', label: 'Purchasing', color: '#8d6e63', icon: '<path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1.003 1.003 0 0020 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/>' },
      { section: 'reports-inventory', label: 'Inventory', color: '#ef6c00', icon: '<path d="M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z"/>' },
      { section: 'reports-accounts', label: 'Accounts', color: '#2196F3', icon: '<path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>' },
    ]},
    'warehouse-hub': { title: 'Warehouse', children: [
      { section: 'inventory', label: 'Retail Inventory', color: '#2196F3', icon: '<path d="M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z"/>' },
      { section: 'warehouse', label: 'Warehouse Mgmt', color: '#00897B', icon: '<path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM3 7h12v7H3V7zm3 9.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V7.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>' },
      { section: 'cycle-counts', label: 'Cycle Counts', color: '#4CAF50', icon: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/>' },
      { section: 'transfers', label: 'Branch Transfers', color: '#FF9800', icon: '<path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/>' },
      { section: 'shop-use', label: 'Shop Use', color: '#6d4c41', icon: '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6l-3 3-4.3-4.3C.6 7.1 1 10.1 3 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.4-.4.4-1 0-1.4z"/>' },
      { section: 'services', label: 'Services', color: '#4CAF50', icon: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>' },
    ]},
    'admin-hub': { title: 'Admin', children: [
      { section: 'employees', label: 'Employees', color: '#2196F3', icon: '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>' },
      { section: 'branches', label: 'Branches', color: '#00897B', icon: '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>' },
      { section: 'user-sessions', label: 'Active Sessions', color: '#3949ab', icon: '<path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12zM12 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm-4.5 9h9v-.75c0-1.5-3-2.25-4.5-2.25s-4.5.75-4.5 2.25V16z"/>' },
      { section: 'assessment', label: 'Assessment', color: '#c79100', icon: '<path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 15.9V19H7v2h10v-2h-4v-3.1a5.01 5.01 0 0 0 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>' },
      { section: 'security', label: 'Security Groups', color: '#9c27b0', icon: '<path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>' },
      { section: 'settings', label: 'Settings', color: '#FF9800', icon: '<path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>' },
    ]},
  },

  // Rentals module access for hub tiles / direct nav. this.can('rentals') is
  // deliberately bidirectional (a sub-permission alone grants the parent
  // key), but the two driver-facing subs (rentals_confirm_pickup,
  // rentals_confirm_delivery) must NOT unlock the full Rentals / Rental
  // Dispatch / Rental Deposits / Rental Items screens — a driver should only
  // ever reach rental data through the restricted My Deliveries dashboard
  // (renderDriverDashboard / GET /rentals/agreements/driver-queue).
  _canManageRentals() {
    const perms = this.currentUser?.permissions;
    if (!perms) return true;
    if (perms.rentals) return true;
    const driverOnlySubs = new Set(['rentals_confirm_pickup', 'rentals_confirm_delivery']);
    const mod = this._permissionTree.find(m => m.key === 'rentals');
    return !!mod && mod.subs.some(s => !driverOnlySubs.has(s.key) && !!perms[s.key]);
  },

  // Cash Drawers needs Manage Drawers or one of the reconcile keys, read as
  // stored (the parent drawers key only grants POS drawer access); Online
  // Orders piggybacks on the transactions permission since it has no key of
  // its own.
  _hubTileAllowed(section) {
    if (section === 'drawers') return this._canOpenDrawersScreen();
    if (section === 'online-orders') return this.can('transactions');
    if (section === 'rentals') return this._canManageRentals();
    if (section === 'rental-items') return this._canManageRentals();
    if (section === 'rental-deposits') return this._canManageRentals();
    if (section === 'rental-dispatch') return this._canManageRentals();
    if (section === 'transfer-dispatch') return this.can('transfers');
    if (section === 'purchase-requests') return this.can('purchase_requests');
    if (section === 'work-orders') return this.can('work_orders');
    if (section === 'wo-schedule') return this.can('work_orders');
    // Approvers who don't hold special_projects itself still need the tile
    // visible so they can reach the approval queue.
    if (section === 'special-projects') return this.can('special_projects') || this.can('special_projects_approve');
    // Payment-request approvers reach their queue in Payables without the A/P module itself.
    if (section === 'payables') return this.can('payables') || this.can('payables_approve');
    if (section === 'shop-use') return this._suCanOpen();
    if (section === 'special-orders') return this._canSeeSpecialOrders();
    // The three report category tiles all gate on the same `reports`
    // permission every other report endpoint already uses — none of them
    // expose anything more sensitive than what's already visible elsewhere
    // (CRM, Customers, Transactions).
    if (section === 'reports-marketing' || section === 'reports-sales' || section === 'reports-accounts' || section === 'reports-purchasing') return this.can('reports');
    // Inventory Reports is also opened from the Reports button on Retail
    // Inventory, so inventory staff get it without the full `reports` grant.
    if (section === 'reports-inventory') return this.can('reports') || this.can('inventory');
    return this.can(section);
  },

  // Every leaf section lives under exactly one hub in _hubGroups (the sole
  // exception is 'dashboard', which has no hub) — walk the groups once to
  // find which one a given section belongs to, for the breadcrumb trail.
  _findHubForSection(name) {
    for (const key of Object.keys(this._hubGroups)) {
      if (this._hubGroups[key].children.some(c => c.section === name)) return key;
    }
    return null;
  },

  // Home > [Hub] > Current — mirrors the sidebar's own hierarchy so a leaf
  // section (e.g. Quotations) always has a one-click way back to its hub's
  // tile grid (e.g. Sales), not just to the sidebar nav item.
  buildBreadcrumb(name, currentTitle) {
    const homeIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`;
    const homeLink = `<a href="#" class="breadcrumb-link" onclick="event.preventDefault();App.showSection('home')">${homeIcon}Home</a>`;
    if (name === 'dashboard' || name === 'home') return `<span class="breadcrumb-current">${currentTitle}</span>`;
    const sep = `<span class="breadcrumb-sep">›</span>`;
    const parts = [homeLink];
    if (this._hubGroups[name]) {
      // Viewing a hub's own tile grid — the hub name IS the current page.
      parts.push(sep, `<span class="breadcrumb-current">${currentTitle}</span>`);
    } else {
      const hubKey = this._findHubForSection(name);
      if (hubKey) {
        parts.push(sep, `<a href="#" class="breadcrumb-link" onclick="event.preventDefault();App.showSection('${hubKey}')">${this._hubGroups[hubKey].title}</a>`);
      }
      parts.push(sep, `<span class="breadcrumb-current">${currentTitle}</span>`);
    }
    return parts.join('');
  },

  canAccessHub(hubKey) {
    const hub = this._hubGroups[hubKey];
    if (!hub) return false;
    return hub.children.some(c => this._hubTileAllowed(c.section));
  },

  async renderHub(hubKey) {
    const hub = this._hubGroups[hubKey];
    const tiles = hub.children
      .filter(c => this._hubTileAllowed(c.section))
      .map(c => `
        <div class="hub-tile" data-section="${c.section}" style="background:${c.color}" onclick="App.showSection('${c.section}')">
          <svg viewBox="0 0 24 24" fill="currentColor">${c.icon}</svg>
          <span>${c.label}</span>
        </div>`).join('');

    // Warehouse hub gets a dashboard-style reports panel above the tiles —
    // Top Selling Products + Inventory Snapshot, filterable the same way the
    // full Reports screen is (location, category, date range).
    const showReports = hubKey === 'warehouse-hub' && this.can('reports');
    let reportsPanel = '';
    if (showReports) {
      const [branches, categories] = await Promise.all([
        this.api('GET', '/branches').catch(() => []),
        this.api('GET', '/categories').catch(() => []),
      ]);
      if (this.section !== hubKey) return;
      const activeBranches = (branches || []).filter(b => b.active && !b.is_warehouse);
      const today = new Date().toISOString().slice(0,10);
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
      reportsPanel = `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header" style="flex-wrap:wrap;gap:10px">
            <span class="card-title">Warehouse Reports</span>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <select id="whr-branch" style="min-width:140px">
                <option value="">All Locations</option>
                ${activeBranches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
              </select>
              <select id="whr-category" style="min-width:140px">
                <option value="">All Categories</option>
                ${(categories||[]).map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
              </select>
              <input type="date" id="whr-start" value="${monthStart}" style="width:140px">
              <span>to</span>
              <input type="date" id="whr-end" value="${today}" style="width:140px">
              <button class="btn btn-sm btn-primary" onclick="App.loadWarehouseHubReports()">Generate</button>
            </div>
          </div>
          <div id="warehouse-hub-report-content"><div class="empty-state"><p>Loading...</p></div></div>
        </div>`;
    }

    document.getElementById('content').innerHTML = `
      <div class="section-header"><h2>${hub.title}</h2></div>
      <div class="hub-grid" style="margin-bottom:${reportsPanel ? '16px' : '0'}">${tiles}</div>
      ${reportsPanel}`;
    this._paintTransferBadges();
    this._paintPayablesBadges();
    this._paintShopUseBadges();

    if (showReports) this.loadWarehouseHubReports();
  },

  async loadWarehouseHubReports() {
    const branchId = document.getElementById('whr-branch')?.value || '';
    const categoryId = document.getElementById('whr-category')?.value || '';
    const start = document.getElementById('whr-start')?.value || '';
    const end = document.getElementById('whr-end')?.value || '';
    const bq = branchId ? `&branch_id=${branchId}` : '';
    const cq = categoryId ? `&category_id=${categoryId}` : '';
    const invParams = [branchId ? `branch_id=${branchId}` : '', categoryId ? `category_id=${categoryId}` : ''].filter(Boolean).join('&');
    const [topProds, inv] = await Promise.all([
      this.api('GET', `/reports/top-products?start=${start}&end=${end}&limit=8${bq}${cq}`),
      this.api('GET', `/reports/inventory${invParams ? '?' + invParams : ''}`),
    ]);
    const el = document.getElementById('warehouse-hub-report-content');
    if (!el) return;
    el.innerHTML = `
      <div class="two-col">
        <div>
          <h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">Top Selling Products <span style="text-transform:none;font-weight:400;letter-spacing:0">· by number of transactions</span></h4>
          <table>
            <thead><tr><th>#</th><th>Product</th><th title="Number of completed transactions the item was on">Transactions</th><th>Units</th><th>Revenue</th></tr></thead>
            <tbody>${topProds.length ? topProds.map((p,i) => `<tr><td style="color:var(--text-muted)">${i+1}</td><td class="fw-600">${p.product_name}</td><td class="fw-600" style="text-align:center">${p.transactions}</td><td style="text-align:center">${p.units_sold}</td><td class="fw-600 color-success">${this.fmt(p.revenue)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No sales in this period</td></tr>'}</tbody>
          </table>
        </div>
        <div>
          <h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">Inventory Snapshot</h4>
          <div class="stats-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:12px">
            <div class="stat-card"><div class="stat-label">Total Products</div><div class="stat-value">${inv.summary.total_products||0}</div></div>
            <div class="stat-card"><div class="stat-label">Total Units</div><div class="stat-value">${inv.summary.total_units||0}</div></div>
            <div class="stat-card blue"><div class="stat-label">Cost Value</div><div class="stat-value" style="font-size:18px">${this.fmt(inv.summary.cost_value||0)}</div></div>
            <div class="stat-card green"><div class="stat-label">Retail Value</div><div class="stat-value" style="font-size:18px">${this.fmt(inv.summary.retail_value||0)}</div></div>
          </div>
          ${!inv.lowStock.length ? '<div style="font-size:12px;color:var(--success)">✓ All products have sufficient stock</div>' : ''}
        </div>
      </div>
      ${inv.lowStock.length ? `
      <div style="margin-top:16px">
        <h4 style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--danger);text-transform:uppercase;letter-spacing:.5px">⚠️ Low Stock (${inv.lowStock.length})</h4>
        <table>
          <thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Branch</th><th>Stock Level</th><th>Minimum</th></tr></thead>
          <tbody>${inv.lowStock.map(p => `<tr><td style="font-family:monospace;font-size:12px">${p.sku}</td><td class="fw-600">${p.name}</td><td>${p.category_name||'—'}</td><td>${p.branch_name||'—'}</td><td class="fw-600 color-danger">${p.stock_qty}</td><td style="color:var(--text-muted)">${p.min_stock}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}`;
  },

  applyNavPermissions() {
    // Flag-based, not permission-based — these two are shown purely off the
    // employee's is_driver/is_security attribute (Employees → edit), same
    // idea as those flags filtering the delivery/security dropdowns
    // elsewhere. Applied unconditionally, ahead of the `!perms` early
    // return below, so it still works for an employee with no permissions
    // object at all.
    const driverEl = document.querySelector('.nav-item[data-section="driver-dashboard"]');
    if (driverEl) driverEl.style.display = this.currentUser.is_driver ? '' : 'none';
    const guardEl = document.querySelector('.nav-item[data-section="guard-dashboard"]');
    if (guardEl) guardEl.style.display = this.currentUser.is_security ? '' : 'none';

    const perms = this.currentUser.permissions;
    if (!perms) return;
    document.querySelectorAll('.nav-item[data-section]').forEach(el => {
      const s = el.dataset.section;
      if (s === 'driver-dashboard' || s === 'guard-dashboard') return;
      // Home is open to everyone (it's also where users without the
      // Dashboard land); the Dashboard item follows its permission below.
      if (s === 'home') { el.style.display = ''; return; }
      // Cash Drawers nav: see _hubTileAllowed
      const show = s === 'drawers' ? this._canOpenDrawersScreen() : s === 'online-orders' ? this.can('transactions') : this._hubGroups[s] ? this.canAccessHub(s) : this.can(s);
      el.style.display = show ? '' : 'none';
    });
  },

  logout() {
    // Best-effort — destroys the server-side session so the cookie can't be
    // replayed. Don't block the UI reset on it.
    this.api('POST', '/employees/logout').catch(() => {});
    this._stopTransferInbox();
    this._stopShopUseInbox();
    this._stopCollectionsInbox();
    this._stopPayablesInbox();
    this.currentUser = null;
    this.currentDrawerSession = null;
    this._posHasDrawers = false;
    this.posBranch = null;
    this.cart = [];
    this.cartCustomer = null;
    this.cartDiscount = 0;
    document.getElementById('drawer-status-badge')?.remove();
    this.showLoginScreen();
  },

  async showSection(name) {
    // Users without the Dashboard get the Home page wherever the app would
    // send them to it (POS Exit, the Home breadcrumb, the sidebar item).
    if (name === 'dashboard' && this.currentUser && !this.can('dashboard')) name = 'home';
    if (this.section === 'settings' && name !== 'settings' && this._settingsDirty) {
      if (!confirm('You have unsaved changes in Settings. Leave without saving them?')) return;
      this._settingsDirty = false;
    }
    const perms = this.currentUser?.permissions;
    const sectionAllowed = name === 'home' ? true : name === 'driver-dashboard' ? !!this.currentUser?.is_driver : name === 'guard-dashboard' ? !!this.currentUser?.is_security : name === 'online-orders' ? this.can('transactions') : name === 'rentals' ? this._canManageRentals() : name === 'rental-items' ? this._canManageRentals() : name === 'rental-deposits' ? this._canManageRentals() : name === 'rental-dispatch' ? this._canManageRentals() : name === 'transfer-dispatch' ? this.can('transfers') : name === 'purchase-requests' ? this.can('purchase_requests') : name === 'work-orders' ? this.can('work_orders') : name === 'wo-schedule' ? this.can('work_orders') : name === 'special-projects' ? (this.can('special_projects') || this.can('special_projects_approve')) : name === 'payables' ? (this.can('payables') || this.can('payables_approve')) : name === 'shop-use' ? this._suCanOpen() : name === 'special-orders' ? this._canSeeSpecialOrders() : (name === 'reports-marketing' || name === 'reports-sales' || name === 'reports-accounts' || name === 'reports-purchasing') ? this.can('reports') : name === 'reports-inventory' ? (this.can('reports') || this.can('inventory')) : this._hubGroups[name] ? this.canAccessHub(name) : this.can(name);
    if (perms && !sectionAllowed) return;
    this.section = name;
    this._reportSection(name);
    this.closeModal();
    if (name !== 'pos') this._closeBundleUpsell?.();
    this.closeSidebar();
    document.querySelectorAll('.nav-item').forEach(el => {
      const ds = el.dataset.section;
      const hub = this._hubGroups[ds];
      el.classList.toggle('active', ds === name || !!(hub && hub.children.some(c => c.section === name)));
    });
    const titles = { home: 'Home', dashboard: 'Dashboard', 'driver-dashboard': 'My Deliveries', 'guard-dashboard': 'My Verifications', pos: 'Point of Sale', inventory: 'Retail Inventory Management', services: 'Services & Non-Inventory Items', rentals: 'Rentals', 'rental-items': 'Rental Items', 'work-orders': 'Work Orders', 'wo-schedule': 'Technician Schedule', dispatch: 'Dispatch', 'rental-dispatch': 'Rental Dispatch', 'transfer-dispatch': 'Branch Transfer Dispatch', 'rental-deposits': 'Rental Deposits & Credit Notes', 'purchase-requests': 'Purchase Requests', layaway: 'Layaway', customers: 'Customers', transactions: 'Transactions', 'online-orders': 'Online Orders', reports: 'Reports & Analytics', employees: 'Employees', settings: 'Settings', suppliers: 'Suppliers', purchasing: 'Purchasing', quotations: 'Quotations', 'special-projects': 'Special Projects', 'special-orders': 'Special Orders', accounts: 'Accounts Receivable', payables: 'Accounts Payable', 'shop-use': 'Shop Use', branches: 'Branch Management', security: 'Security Groups', 'user-sessions': 'Active Sessions', assessment: 'Training Assessment', transfers: 'Branch Transfers', crm: 'CRM & Sales', commissions: 'Commission Tracking', warehouse: 'Warehouse Management', shipping: 'Shipping', 'cycle-counts': 'Cycle Counts', drawers: 'Cash Drawers', promotions: 'Promotions', 'discount-cards': 'Discount Cards', 'cash-back-cards': 'Cash Back Cards', 'purchasing-hub': 'Purchasing', 'sales-hub': 'Sales', 'accounts-hub': 'Accounts', 'warehouse-hub': 'Warehouse', 'admin-hub': 'Admin', 'reports-hub': 'Reports', 'reports-marketing': 'Marketing Reports', 'reports-sales': 'Sales Reports', 'reports-accounts': 'Accounts Reports', 'reports-purchasing': 'Purchasing Reports', 'reports-inventory': 'Inventory Reports' };
    document.getElementById('topbar-title').innerHTML = this.buildBreadcrumb(name, titles[name] || name);
    const content = document.getElementById('content');
    content.style.padding = name === 'pos' ? '0' : '20px';
    content.style.overflow = name === 'pos' ? 'hidden' : 'auto';
    content.style.height = name === 'pos' ? '100%' : 'auto';
    // POS used to force full-screen kiosk mode (hiding the sidebar/topbar via
    // `body.pos-kiosk` CSS) — removed so staff can navigate away without
    // using the in-page Exit button first. The content-area sizing above
    // still gives POS its own full-height layout within the remaining space.
    const renders = { home: () => this.renderHome(), dashboard: () => this.renderDashboard(), 'driver-dashboard': () => this.renderDriverDashboard(), 'guard-dashboard': () => this.renderGuardDashboard(), pos: () => this.renderPOS(), inventory: () => this.renderInventory(), services: () => this.renderServices(), rentals: () => this.renderRentals(), 'rental-items': () => this.renderRentalItems(), 'work-orders': () => this.renderWorkOrders(), 'wo-schedule': () => this.renderWOSchedule(), dispatch: () => this.renderHub('dispatch'), 'rental-dispatch': () => this.renderRentalDispatch(), 'transfer-dispatch': () => this.renderTransferDispatch(), 'rental-deposits': () => this.renderRentalDeposits(), 'purchase-requests': () => this.renderPurchasing('requests'), layaway: () => this.renderLayaway(), customers: () => this.renderCustomers(), transactions: () => this.renderTransactions(), 'online-orders': () => this.renderOnlineOrders(), reports: () => this.renderReports(), employees: () => this.renderEmployees(), settings: () => this.renderSettings(), suppliers: () => this.renderSuppliers(), purchasing: () => this.renderPurchasing(), quotations: () => this.renderQuotations(), 'special-projects': () => this.renderSpecialProjects(), 'special-orders': () => this.renderSpecialOrders(), accounts: () => this.renderAccounts(), payables: () => this.renderPayables(), 'shop-use': () => this.renderShopUse(), branches: () => this.renderBranches(), security: () => this.renderSecurity(), 'user-sessions': () => this.renderUserSessions(), assessment: () => this.renderAssessment(), transfers: () => this.renderTransfers(), crm: () => this.renderCRM(), commissions: () => this.renderCommissions(), warehouse: () => this.renderWarehouse(), shipping: () => this.renderShipping(), 'cycle-counts': () => this.renderCycleCounts(), drawers: () => this.renderDrawers(), promotions: () => this.renderPromotions(), 'discount-cards': () => this.renderDiscountCards(), 'cash-back-cards': () => this.renderCashBackCards(), 'purchasing-hub': () => this.renderHub('purchasing-hub'), 'sales-hub': () => this.renderHub('sales-hub'), 'accounts-hub': () => this.renderHub('accounts-hub'), 'warehouse-hub': () => this.renderHub('warehouse-hub'), 'admin-hub': () => this.renderHub('admin-hub'), 'reports-hub': () => this.renderHub('reports-hub'), 'reports-marketing': () => this.renderReportsMarketing(), 'reports-sales': () => this.renderReportsSales(), 'reports-accounts': () => this.renderReportsAccounts(), 'reports-purchasing': () => this.renderReportsPurchasing(), 'reports-inventory': () => this.renderReportsInventory() };
    if (renders[name]) await renders[name]();
  },

  // Mobile off-canvas sidebar — no-ops harmlessly above the 880px breakpoint
  // since #sidebar/.sidebar-backdrop have no fixed positioning there.
  toggleSidebar() {
    document.getElementById('sidebar')?.classList.toggle('sidebar-open');
    document.querySelector('.sidebar-backdrop')?.classList.toggle('sidebar-backdrop-open');
  },

  closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('sidebar-open');
    document.querySelector('.sidebar-backdrop')?.classList.remove('sidebar-backdrop-open');
  },

  // ─── API ──────────────────────────────────────────────────
  async api(method, url, data) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (data) opts.body = JSON.stringify(data);
    const res = await fetch('/api' + url, opts);
    // An error page that isn't JSON (e.g. a proxy's 502) reads as its status.
    const json = res.ok ? await res.json() : await res.json().catch(() => ({ error: `The server didn't respond properly (HTTP ${res.status})` }));
    if (!res.ok) {
      // Session expired/invalid server-side — force a clean re-login instead
      // of leaving the UI in a confusing half-authenticated state. Skip this
      // for the login endpoint itself (invalid credentials also come back as
      // 401 and shouldn't bounce the user off the login screen they're on).
      if (res.status === 401 && url !== '/employees/login' && this.currentUser) {
        this._stopTransferInbox();
        this._stopShopUseInbox();
        this._stopCollectionsInbox();
        this._stopPayablesInbox();
        this.currentUser = null;
        this.showLoginScreen();
      }
      const err = new Error(json.error || 'Request failed');
      err.status = res.status;
      err.data = json;
      throw err;
    }
    return json;
  },

  // ─── Settings ─────────────────────────────────────────────
  async loadSettings() {
    this.settings = await this.api('GET', '/settings');
    if (this.settings.store_name) document.title = this.settings.store_name + ' - POS';
    this.applyBranding(this.settings.company_logo_url, this.settings.store_name);
    try { this.altCurrencies = this.settings.alt_currencies ? JSON.parse(this.settings.alt_currencies) : []; } catch(e) { this.altCurrencies = []; }
    // Settings stores each rate as "1 <alt> = base_per_unit <base>" (1 USD =
    // 155 JMD); `rate` (alt per 1 base) is derived from it for the POS
    // conversions. Older entries only have `rate`.
    this.altCurrencies.forEach(c => { const per = this._altBasePerUnit(c); if (per) { c.base_per_unit = per; c.rate = 1 / per; } });
  },

  async checkLowStock() {
    try {
      const data = await this.api('GET', '/reports/dashboard');
      const el = document.getElementById('low-stock-alert');
      if (data.lowStock.count > 0) {
        el.style.display = 'inline-flex';
        document.getElementById('low-stock-count').textContent = data.lowStock.count;
      }
    } catch(e) {}
  },

  // ─── Utilities ────────────────────────────────────────────
  // For interpolating free text into an HTML attribute value="...". Without
  // this, a stray " in the text terminates the attribute early and truncates
  // everything after it (bit us in quotation/PR notes editing).
  escapeAttr(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); },
  fmt(n) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: this.activeCurrency || this.settings.currency || 'USD' }).format(n || 0); },
  // An amount with thousands separators and 2 decimals, no currency sign (1,234.50) — for text, never an input's value.
  _n2(n) { return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  // Short money for narrow chart columns (JMD 2.63M); pair with fmt() in a tooltip.
  fmtCompact(n) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: this.activeCurrency || this.settings.currency || 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(n || 0).replace(/\u00a0/g, ' '); },
  // Mirrors lib/rentals.js's rateBasisLabel — "1 month @ $4,000.00/mo + 3
  // days @ $250.00/day" from an item's server-computed rate_basis, i.e. the
  // rate(s) that actually apply to the rental period.
  _rateBasisLabel(lines) {
    if (!lines || !lines.length) return '';
    const units = { month: ['month', 'mo'], week: ['week', 'wk'], day: ['day', 'day'], hour: ['hr', 'hr'] };
    return lines.map(l => {
      const [name, per] = units[l.unit];
      const count = Math.round(l.count * 100) / 100;
      return `${count} ${name}${count === 1 ? '' : 's'} @ ${this.fmt(l.rate)}/${per}${l.tier ? ` (${l.tier} rate)` : ''}`;
    }).join(' + ');
  },
  // Dates/times are shown on the store clock (Settings → Store Time Zone).
  // Database timestamps are UTC (see _toDate); a plain "YYYY-MM-DD" is a
  // calendar date and is shown as that day, never shifted.
  fmtDate(d) {
    if (d == null || d === '') return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const dt = this._toDate(d);
    return isNaN(dt) ? '' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: this._storeTz() });
  },
  fmtDateTime(d) {
    if (d == null || d === '') return '';
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return this.fmtDate(d);
    const dt = this._toDate(d);
    return isNaN(dt) ? '' : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: this._storeTz() });
  },

  // Calendar-day difference, normalized to UTC midnight so a checkout/due
  // pair on the same two dates always reads as a whole number of days
  // regardless of the time-of-day component on datetime values.
  _daysBetween(a, b) {
    // Must read UTC calendar-day components, not local ones: a date-only
    // value ("2026-07-25") parses as UTC midnight, so in any timezone behind
    // UTC the local getters roll it back to the previous calendar day —
    // while a full datetime value (checkout_datetime) mostly doesn't shift
    // the same way, since it carries a real time-of-day. Mixing local
    // getters across a date-only value and a datetime value (exactly what
    // happens comparing a rental_agreements row's due_date against a linked
    // transaction's rental_checkout_datetime) silently produced different
    // day counts for the same rental depending on which pair was compared.
    // Staying in UTC throughout matches how the backend derives these
    // fields to begin with (SQLite's date('now') / Date#toISOString() are
    // both UTC), so it's consistent everywhere this helper is used.
    const da = new Date(a), db = new Date(b);
    const utcA = Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), da.getUTCDate());
    const utcB = Date.UTC(db.getUTCFullYear(), db.getUTCMonth(), db.getUTCDate());
    return Math.round((utcB - utcA) / 86400000);
  },

  // Shared by the rental agreements list/detail and the linked transaction's
  // detail view — planned duration is checkout→due; once returned, shows the
  // actual checkout→return span too, flagging any variance from the plan.
  rentalDurationLabel(checkout, dueDate, returnedAt) {
    if (!checkout || !dueDate) return '—';
    const planned = this._daysBetween(checkout, dueDate);
    const plannedLabel = `${planned} day${planned === 1 ? '' : 's'}`;
    if (!returnedAt) return plannedLabel;
    const actual = this._daysBetween(checkout, returnedAt);
    if (actual === planned) return `${plannedLabel} <span style="color:var(--success)">(returned on time)</span>`;
    const diff = actual - planned;
    return `${actual} day${actual === 1 ? '' : 's'} <span style="color:${diff > 0 ? 'var(--danger)' : 'var(--success)'}">(planned ${plannedLabel}, ${diff > 0 ? '+' : ''}${diff}d)</span>`;
  },

  alert(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  },

  showModal(html) {
    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    overlay.querySelector('.modal-close')?.addEventListener('click', () => overlay.remove());
    return overlay;
  },

  closeModal() { document.querySelector('.modal-overlay')?.remove(); },

  // Type-to-search for long dropdowns (suppliers/vendors): any <select
  // data-searchable> gets a text box + filtered list in front of it as soon
  // as it's added to the page. The select stays (hidden) and holds the value,
  // so code reading .value or listening for change works unchanged.
  // data-add="App._someFn" also offers "+ Add …" when nothing matches
  // exactly; the fn gets the typed text and returns { value, text } (or
  // null), which becomes a new option and is selected.
  _initSearchableSelects() {
    const enhance = root => {
      if (root.matches?.('select[data-searchable]')) this._searchableSelect(root);
      root.querySelectorAll?.('select[data-searchable]').forEach(sel => this._searchableSelect(sel));
    };
    new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) enhance(n); })))
      .observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', e => {
      document.querySelectorAll('.ss-wrap').forEach(w => { if (!w.contains(e.target)) w._ssClose(); });
    });
  },
  _searchableSelect(sel) {
    if (sel.dataset.ssDone) return;
    sel.dataset.ssDone = '1';
    const wrap = document.createElement('span');
    wrap.className = 'ss-wrap';
    const inline = sel.style.width === 'auto';
    wrap.style.cssText = `position:relative;display:${inline ? 'inline-block' : 'block'};${sel.style.minWidth ? `min-width:${sel.style.minWidth};` : ''}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.style.width = '100%';
    input.disabled = sel.disabled;
    const blank = [...sel.options].find(o => o.value === '');
    input.placeholder = 'Type to search…';
    const dd = document.createElement('div');
    dd.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;min-width:220px;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:300;max-height:260px;overflow-y:auto;margin-top:2px;text-align:left';
    const shown = () => { const o = sel.options[sel.selectedIndex]; return o && o.value !== '' ? o.text : ''; };
    input.value = shown();
    const matches = q => {
      q = q.toLowerCase().trim();
      return [...sel.options].filter(o => q ? o.value !== '' && o.text.toLowerCase().includes(q) : true);
    };
    const pick = o => {
      const changed = sel.value !== o.value;
      sel.value = o.value;
      input.value = shown();
      dd.style.display = 'none';
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const addFn = sel.dataset.add && sel.dataset.add.replace(/^App\./, '');
    const canAdd = q => addFn && q.trim() && ![...sel.options].some(o => o.value !== '' && o.text.toLowerCase() === q.trim().toLowerCase());
    const add = async q => {
      dd.style.display = 'none';
      const made = await this[addFn](q.trim().replace(/\s+/g, ' ')).catch(err => { this.alert(err.message, 'error'); return null; });
      if (!made) { input.value = shown(); return; }
      let o = [...sel.options].find(x => String(x.value) === String(made.value));
      if (!o) { o = new Option(made.text, made.value); sel.add(o); }
      pick(o);
    };
    const itemEl = (text, color, onPick) => {
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.style.cssText = `padding:8px 10px;cursor:pointer;color:${color}`;
      item.textContent = text;
      item.addEventListener('click', onPick);
      return item;
    };
    const render = q => {
      const list = matches(q);
      const items = list.slice(0, 100).map(o => itemEl(o.text, o.value === '' ? 'var(--text-muted)' : 'var(--text)', () => pick(o)));
      if (canAdd(q)) items.push(itemEl(`+ Add “${q.trim()}”`, 'var(--accent)', () => add(q)));
      else if (addFn && !q.trim()) items.push(itemEl('+ Add new… (type its name above)', 'var(--accent)', startAdd));
      dd.replaceChildren(...(items.length ? items : [Object.assign(document.createElement('div'), { textContent: 'No matches', style: 'padding:10px;color:var(--text-muted);font-size:13px' })]));
      dd.style.display = '';
    };
    // The + button (and "+ Add new…" in the list): empty the box and ask
    // for the new name; typing it then offers "+ Add “…”" / Enter.
    const startAdd = () => {
      input.value = '';
      input.placeholder = 'Type the new name, then press Enter';
      input.focus();
      render('');
    };
    // Leaving without picking puts back the current choice's name.
    wrap._ssClose = () => { if (dd.style.display !== 'none') { dd.style.display = 'none'; input.value = shown(); input.placeholder = placeholder; } };
    input.addEventListener('focus', () => { input.select(); render(''); });
    input.addEventListener('click', () => { if (dd.style.display === 'none') { input.select(); render(''); } });
    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = input.value.trim() && matches(input.value)[0];
        if (first) pick(first); else if (canAdd(input.value)) add(input.value); else wrap._ssClose();
      }
      else if (e.key === 'Escape') { e.stopPropagation(); wrap._ssClose(); }
      else if (e.key === 'Tab') wrap._ssClose();
    });
    if (blank) input.placeholder = `${blank.text.replace(/^[\s—–-]+|[\s—–-]+$/g, '')} — type to search`;
    const placeholder = input.placeholder;
    sel.style.display = 'none';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.append(input, dd);
    if (addFn) {
      wrap.style.display = 'flex';
      wrap.style.gap = '6px';
      input.style.flex = '1';
      input.style.minWidth = '0';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline';
      btn.textContent = '+';
      btn.title = 'Add a new one';
      btn.style.cssText = 'flex:none;padding:0 14px;font-size:18px;font-weight:700';
      btn.disabled = sel.disabled;
      btn.addEventListener('click', startAdd);
      wrap.append(btn);
    }
  },

  // ─── Secondary modal (a dialog over a dialog) ────────────────────
  showSecondaryModal(html) {
    document.getElementById('secondary-modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'secondary-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '1100';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    overlay.querySelector('.modal-close')?.addEventListener('click', () => overlay.remove());
    return overlay;
  },

  closeSecondaryModal() { document.getElementById('secondary-modal-overlay')?.remove(); },
};
