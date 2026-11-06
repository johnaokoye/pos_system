// Permission tree, App.can(), security groups list and editor, group membership.
Object.assign(App, {
  _permissionTree: [
    { key: 'dashboard', label: 'Dashboard', subs: [] },
    { key: 'pos', label: 'Point of Sale', subs: [
      { key: 'pos_discounts', label: 'Apply Discounts' },
      { key: 'pos_discount_override', label: 'Override Discount Limit' },
      { key: 'pos_refunds', label: 'Process Refunds' },
      { key: 'pos_hold', label: 'Hold & Recall Orders' },
      { key: 'pos_customer_lookup', label: 'Customer Lookup & Zoom' },
      { key: 'pos_item_lookup', label: 'Item Lookup & Zoom' },
      { key: 'pos_tax_exempt', label: 'Tax Exempt' },
      { key: 'pos_reprint_ticket', label: 'Reprint Ticket' },
      { key: 'pos_pay_on_account', label: 'Pay On Account' },
      { key: 'pos_change_quantity', label: 'Change Quantity' },
      { key: 'pos_cancel_ticket', label: 'Cancel Ticket' },
      { key: 'pos_payment', label: 'Take Payment' },
      { key: 'pos_q_item', label: 'Q Items (add something not in inventory — the ticket goes to a quote)' },
    ]},
    { key: 'drawers', label: 'Cash Drawers', subs: [
      { key: 'drawers_manage', label: 'Manage Drawers (setup & access)' },
      { key: 'drawers_open', label: 'Open Drawer Sessions' },
      { key: 'drawers_close', label: 'Close & Reconcile Own Drawer' },
      { key: 'drawers_reconcile_all', label: 'Reconcile All Drawers' },
      { key: 'void_transactions', label: 'Void Transactions' },
    ]},
    { key: 'inventory', label: 'Inventory', subs: [
      { key: 'inventory_view', label: 'View Retail Inventory (read only, no cost)' },
      { key: 'inventory_add', label: 'Add Products' },
      { key: 'inventory_edit', label: 'Edit Products' },
      { key: 'inventory_delete', label: 'Delete Products' },
      { key: 'inventory_adjust', label: 'Manual Stock Adjustments' },
      { key: 'inventory_print_labels', label: 'Print Labels' },
      { key: 'inventory_merge', label: 'Merge Duplicate Products' },
      { key: 'inventory_export', label: 'Export Products CSV' },
      { key: 'inventory_missing_data', label: 'Export Missing Data CSV' },
      { key: 'inventory_template', label: 'Download Import Template' },
      { key: 'inventory_import', label: 'Import Products CSV' },
      { key: 'inventory_import_history', label: 'Review & Reverse Imports' },
      { key: 'inventory_scan_images', label: 'Scan Product Images' },
      { key: 'inventory_categories', label: 'Manage Categories' },
      { key: 'inventory_units', label: 'Manage Units of Measure' },
      { key: 'inventory_brands', label: 'Manage Brands' },
    ]},
    { key: 'customers', label: 'Customers', subs: [
      { key: 'customers_add', label: 'Add Customers' },
      { key: 'customers_edit', label: 'Edit Customers' },
      { key: 'customers_delete', label: 'Delete Customers' },
      { key: 'customers_credit', label: 'Manage Credit Limits (Cash ↔ Credit, limits, terms)' },
      { key: 'customers_merge', label: 'Find & Merge Duplicate Customers' },
      { key: 'customers_import', label: 'Import Customers (CSV)' },
      { key: 'customers_import_history', label: 'View & Reverse Import History' },
      { key: 'customers_export', label: 'Export Customers (CSV)' },
      { key: 'customers_export_balances', label: 'Export Balances' },
      { key: 'customers_missing_rental_info', label: 'Missing Rental Info Report' },
      { key: 'customers_print_history', label: 'Print Customer History' },
      { key: 'customers_rental_preapprove', label: 'Preapprove Rental Customers With Incomplete Info' },
    ]},
    { key: 'transactions', label: 'Transactions', subs: [
      { key: 'transactions_export', label: 'Export Transactions' },
      { key: 'transactions_refund', label: 'Issue Refunds' },
      { key: 'transactions_credit_note', label: 'Issue Credit Notes' },
      { key: 'transactions_returns', label: 'Process Returns' },
    ]},
    { key: 'reports', label: 'Reports', subs: [
      { key: 'reports_export', label: 'Export Reports' },
      { key: 'reports_financial', label: 'View Financial Data' },
    ]},
    { key: 'employees', label: 'Employees', subs: [
      { key: 'employees_add', label: 'Add Employees' },
      { key: 'employees_edit', label: 'Edit Employees' },
      { key: 'employees_delete', label: 'Deactivate Employees' },
      { key: 'employees_salaries', label: 'View Salary Info' },
    ]},
    { key: 'suppliers', label: 'Suppliers', subs: [
      { key: 'suppliers_add', label: 'Add Suppliers' },
      { key: 'suppliers_edit', label: 'Edit Suppliers' },
      { key: 'suppliers_delete', label: 'Delete Suppliers' },
    ]},
    { key: 'services', label: 'Services & Non-Inventory', subs: [] },
    { key: 'rentals', label: 'Rentals', subs: [
      { key: 'rentals_manage_items', label: 'Manage Rental Items' },
      { key: 'rentals_checkout', label: 'Check Out Rentals' },
      { key: 'rentals_returns', label: 'Process Returns & Cancellations' },
      { key: 'rentals_issue', label: 'Issue / Dispatch Rentals' },
      { key: 'rentals_pause', label: 'Authorize Rental Pauses' },
      { key: 'rentals_confirm_pickup', label: 'Confirm Rental Pickups (Driver)' },
      { key: 'rentals_deposit_refund', label: 'Record Deposit Refunds' },
      { key: 'rentals_credit_note', label: 'Issue Credit Notes' },
      { key: 'rentals_security_signoff', label: 'Sign Off on Delivery (Security)' },
      { key: 'rentals_confirm_delivery', label: 'Accept & Sign for Delivery (Driver)' },
    ]},
    { key: 'work_orders', label: 'Work Orders', subs: [
      { key: 'wo_intake', label: 'Open Work Orders' },
      { key: 'wo_assess', label: 'Assess & Estimate' },
      { key: 'wo_assign_parts', label: 'Assign Parts' },
      { key: 'wo_technician', label: 'Technician (Tasks & Time Tracking)' },
      { key: 'wo_signoff', label: 'Supervisor Sign-Off' },
    ]},
    { key: 'layaway', label: 'Layaway', subs: [
      { key: 'layaway_create', label: 'Create Layaway Plans' },
      { key: 'layaway_payments', label: 'Record Payments' },
      { key: 'layaway_cancel', label: 'Cancel Plans' },
    ]},
    { key: 'purchase_requests', label: 'Purchase Requests', subs: [
      { key: 'pr_create', label: 'Create Requests' },
      { key: 'pr_approve', label: 'Approve Requests' },
      { key: 'pr_convert', label: 'Convert to PO' },
      { key: 'pr_delete', label: 'Delete Requests (not yet converted to a PO)' },
    ]},
    { key: 'purchasing', label: 'Purchase Orders', subs: [
      { key: 'purchasing_create', label: 'Create Orders' },
      { key: 'purchasing_approve', label: 'Approve Orders' },
      { key: 'purchasing_receive', label: 'Receive Orders' },
      { key: 'purchasing_delete', label: 'Delete Orders (draft/cancelled, nothing received or billed)' },
      { key: 'purchasing_request_payment', label: 'Request Payment on an approved PO (advance / deposit, sent to Accounts Payable)' },
      { key: 'purchasing_receive_direct', label: 'Receive Without PO (stock on hand at once, updates cost, raises the A/P bill)' },
    ]},
    { key: 'transfers', label: 'Branch Transfers', subs: [
      { key: 'transfers_create', label: 'Create Transfers' },
      { key: 'transfers_approve', label: 'Approve Transfers' },
      { key: 'transfers_pickup', label: 'Mark Picked Up' },
      { key: 'transfers_dropoff', label: 'Mark Dropped Off' },
      { key: 'transfers_quick', label: 'Quick Transfer (move stock instantly)' },
    ]},
    { key: 'quotations', label: 'Quotations', subs: [
      { key: 'quotations_create', label: 'Create Quotes' },
      { key: 'quotations_approve', label: 'Approve Quotes' },
      { key: 'quotations_convert', label: 'Convert to Invoice' },
    ]},
    { key: 'sales_manager', label: 'Sales Manager', subs: [] },
    // Independent top-level permissions, not parent/sub — creating a
    // Special Project and approving one are meant to be separable (the
    // parent-checkbox auto-checks-all-subs behavior below would otherwise
    // grant approval rights the moment "Special Projects" is checked).
    { key: 'special_projects', label: 'Special Projects', subs: [] },
    { key: 'special_projects_approve', label: 'Approve Special Projects', subs: [] },
    { key: 'accounts', label: 'Accounts Receivable', subs: [
      { key: 'accounts_create', label: 'Create Invoices' },
      { key: 'accounts_payments', label: 'Record Payments' },
      { key: 'accounts_writeoff', label: 'Write Off Debt' },
    ]},
    { key: 'payables', label: 'Accounts Payable', subs: [
      { key: 'payables_bills', label: 'Enter & Edit Bills' },
      { key: 'payables_requests', label: 'Raise Payment Requests' },
      { key: 'payables_payments', label: 'Pay Approved Requests' },
      { key: 'payables_void', label: 'Void Bills & Payments' },
      { key: 'payables_contra', label: 'Raise Contra / Barter Offsets (approved by Approve Payment Requests, posted by Pay Approved Requests)' },
    ]},
    // Its own checkbox for the same reason as Approve Special Projects —
    // whoever raises a payment request shouldn't get to sign it off.
    { key: 'payables_approve', label: 'Approve Payment Requests', subs: [] },
    { key: 'shop_use', label: 'Shop Use', subs: [
      { key: 'shop_use_request', label: 'Raise Requests' },
      { key: 'shop_use_issue', label: 'Issue Items, Returns & Tool Register' },
      { key: 'shop_use_finance', label: 'Finance: Accounts, Postings, Reversals & Reconciliation' },
      { key: 'shop_use_routing', label: 'Approval Rules & Limits' },
      { key: 'shop_use_reports', label: 'Dashboards & Reports' },
    ] },
    { key: 'shop_use_approve', label: 'Approve Shop Use Requests', subs: [] },
    { key: 'crm', label: 'CRM & Sales', subs: [
      { key: 'crm_leads', label: 'Manage Leads' },
      { key: 'crm_opportunities', label: 'Manage Opportunities' },
    ]},
    { key: 'commissions', label: 'Commissions', subs: [
      { key: 'commissions_plans', label: 'Manage Plans & Assignments' },
      { key: 'commissions_approve', label: 'Approve Commissions' },
      { key: 'commissions_pay', label: 'Mark as Paid' },
      { key: 'commissions_delete', label: 'Delete Records' },
    ]},
    { key: 'warehouse', label: 'Warehouse', subs: [
      { key: 'warehouse_bins', label: 'Manage Bins' },
      { key: 'warehouse_assign', label: 'Assign Products to Bins' },
    ]},
    { key: 'shipping', label: 'Shipping', subs: [
      { key: 'shipping_create', label: 'Create Shipments' },
      { key: 'shipping_carriers', label: 'Manage Carriers' },
    ]},
    { key: 'cycle-counts', label: 'Cycle Counts', subs: [
      { key: 'cyclecounts_create', label: 'Create Count Sessions' },
      { key: 'cyclecounts_approve', label: 'Approve & Apply Counts' },
    ]},
    { key: 'branches', label: 'Branches', subs: [
      { key: 'branches_add', label: 'Add Branches' },
      { key: 'branches_edit', label: 'Edit Branches' },
      { key: 'branches_delete', label: 'Delete Branches' },
    ]},
    { key: 'security', label: 'Security Groups', subs: [
      { key: 'security_manage', label: 'Manage Groups' },
      { key: 'security_assign', label: 'Assign Employees' },
    ]},
    { key: 'user-sessions', label: 'Active Sessions', subs: [
      { key: 'sessions_logout', label: 'Force Log Out Other Users' },
    ]},
    { key: 'assessment', label: 'Training Assessment', subs: [] },
    { key: 'promotions', label: 'Promotions', subs: [
      { key: 'promotions_create', label: 'Create Promotions' },
      { key: 'promotions_codes', label: 'Manage Promo Codes' },
    ]},
    { key: 'discount-cards', label: 'Discount Cards', subs: [] },
    { key: 'cash-back-cards', label: 'Cash Back Cards', subs: [] },
    { key: 'settings', label: 'Settings', subs: [
      { key: 'settings_company', label: 'Company Info' },
      { key: 'settings_tax', label: 'Tax Configuration' },
      { key: 'settings_payment', label: 'Payment Methods' },
      { key: 'settings_integrations', label: 'Integrations' },
    ]},
  ],

  // Sub-key resolution: an explicit value on the sub-key (true or false)
  // always wins over the parent module flag — checking the module but
  // unchecking one specific sub-permission must deny just that feature.
  // The parent is only used as a fallback when the sub-key was never
  // configured at all (see lib/permissions.js's can(), which this mirrors).
  can(key) {
    const perms = this.currentUser?.permissions;
    if (!perms) return true;
    const mod = this._permissionTree.find(m => m.key === key);
    if (mod) {
      return !!perms[key] || mod.subs.some(s => !!perms[s.key]);
    }
    const parent = this._permissionTree.find(m => m.subs.some(s => s.key === key));
    if (parent) {
      if (Object.prototype.hasOwnProperty.call(perms, key)) return !!perms[key];
      return !!perms[parent.key];
    }
    return !!perms[key];
  },

  async showSecurityGroupForm(id) {
    let g = { permissions: {} };
    if (id) g = await this.api('GET', `/security-groups/${id}`);
    const perms = g.permissions || {};
    // Kept so saveSecurityGroup() can preserve keys this editor doesn't show.
    this._sgEditingPerms = { ...perms };
    // A sub-key that was never saved inherits its module's flag — the same
    // fallback can() uses on both client and server. Without this, a group
    // stored as just { security: true } (e.g. the seeded Administrator)
    // rendered every sub unchecked, syncParent() then unticked the module
    // too, and pressing Save silently revoked the whole module.
    const subChecked = (mod, key) => (Object.prototype.hasOwnProperty.call(perms, key) ? !!perms[key] : !!perms[mod.key]);
    const moduleRows = this._permissionTree.map(mod => {
      const subsHtml = mod.subs.length ? `
        <div class="perm-subs">
          ${mod.subs.map(s => `
            <label class="perm-sub-item">
              <input type="checkbox" id="perm-${s.key}" ${subChecked(mod, s.key) ? 'checked' : ''}>
              <span>${s.label}</span>
            </label>`).join('')}
        </div>` : '';
      return `
        <div class="perm-module">
          <label class="perm-module-header">
            <input type="checkbox" id="perm-${mod.key}" ${perms[mod.key] ? 'checked' : ''}>
            <span>${mod.label}</span>
          </label>
          ${subsHtml}
        </div>`;
    }).join('');
    this.showModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header"><span class="modal-title">${id ? 'Edit' : 'New'} Security Group</span><button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          <div class="form-group"><label>Group Name *</label><input id="sg-name" value="${this.escapeAttr(g.name)}"></div>
          <div class="form-group"><label>Description</label><input id="sg-desc" value="${this.escapeAttr(g.description)}"></div>
          <div class="form-group">
            <label>Branch Access</label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-multi-branch" ${perms.multi_branch_access ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>Multi-Branch Access</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Allow users in this group to switch between and view data across all their assigned branches.</span>
              </span>
            </label>
          </div>
          <div class="form-group">
            <label>Cost Visibility</label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-pos-margin" ${perms.pos_view_margin ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>View POS Margin</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Show each cart line's profit margin on the Point of Sale screen. Separate from POS access, so cashiers don't get it unless ticked here.</span>
              </span>
            </label>
          </div>
          <div class="form-group">
            <label>Customer Payments</label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-receive-payment" ${perms.pos_receive_payment ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>Receive Customer Payments (POS)</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Take payments toward customers' credit accounts at the POS — on account, or applied to chosen invoices — and apply open payments to invoices later. Meant for cashiers only; separate from POS access, so it isn't granted with the POS module.</span>
              </span>
            </label>
          </div>
          <div class="form-group">
            <label>Petty Cash</label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-petty-cash" ${perms.pos_petty_cash ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>Pay Out Petty Cash (POS)</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Pay cash out of the open drawer against a numbered petty cash request slip; it comes off the drawer's expected cash at reconciliation. Separate from POS access, so it isn't granted with the POS module.</span>
              </span>
            </label>
          </div>
          <div class="form-group">
            <label>Returns</label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-returns-override" ${perms.returns_override ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>Authorize Return Override</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Every return needs a manager to enter their PIN; members of this group can authorize it. Separate from Transactions access, so it isn't granted with the Transactions module.</span>
              </span>
            </label>
          </div>
          <div class="form-group">
            <label>Credit Control</label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-credit-block" ${perms.customers_credit_block ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>Block / Unblock Credit Accounts</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Change the Block box on a credit customer: unblock an overdue account, or block one that's up to date. Separate from Customers access, so it isn't granted with the Customers module.</span>
              </span>
            </label>
          </div>
          <div class="form-group">
            <label>Customer Credit</label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-legacy-credit" ${perms.customers_legacy_credit ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>Add Old Credit Notes</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Put a credit note from the old system on a cash customer's account, to spend at the POS as Available Credit. Separate from Customers access, so it isn't granted with the Customers module.</span>
              </span>
            </label>
            <label class="perm-item" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-top:6px">
              <input type="checkbox" id="sg-legacy-credit-void" ${perms.customers_legacy_credit_void ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <span>
                <strong>Void Old Credit Notes</strong><br>
                <span style="font-size:12px;color:var(--text-muted)">Remove an old credit note entered by mistake, with a reason — only while none of it has been used.</span>
              </span>
            </label>
          </div>
          <div class="form-group">
            <label>Module Access &amp; Permissions</label>
            <div style="margin-top:6px">${moduleRows}</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="App.saveSecurityGroup(${id||'null'})">Save Group</button>
        </div>
      </div>`);
    this._wirePermissionCheckboxes();
  },

  _wirePermissionCheckboxes() {
    this._permissionTree.forEach(mod => {
      if (!mod.subs.length) return;
      const parentEl = document.getElementById(`perm-${mod.key}`);
      if (!parentEl) return;
      const subEls = mod.subs.map(s => document.getElementById(`perm-${s.key}`)).filter(Boolean);
      if (!subEls.length) return;

      const syncParent = () => {
        const n = subEls.filter(el => el.checked).length;
        if (n === subEls.length) {
          parentEl.checked = true;
          parentEl.indeterminate = false;
        } else if (n > 0) {
          parentEl.checked = true;
          parentEl.indeterminate = true;
        } else {
          // No sub-actions ticked is NOT the same as no access: a module
          // can be granted on its own for base access only (e.g. Cashier's
          // layaway/work_orders). Leave the module box as the admin set it
          // — untick the module header itself to revoke it — and show it as
          // partial when it's still on.
          parentEl.indeterminate = parentEl.checked;
        }
      };

      syncParent();

      parentEl.addEventListener('change', () => {
        parentEl.indeterminate = false;
        subEls.forEach(el => { el.checked = parentEl.checked; });
      });

      subEls.forEach(subEl => {
        subEl.addEventListener('change', () => {
          if (subEl.checked) parentEl.checked = true;
          syncParent();
        });
      });
    });
  },

  async saveSecurityGroup(id) {
    const name = document.getElementById('sg-name').value.trim();
    const description = document.getElementById('sg-desc').value.trim();
    if (!name) { this.alert('Name required', 'error'); return; }
    // Start from the stored blob so keys outside _permissionTree survive a save.
    const permissions = { ...(id ? this._sgEditingPerms : {}), multi_branch_access: document.getElementById('sg-multi-branch')?.checked || false, pos_view_margin: document.getElementById('sg-pos-margin')?.checked || false, customers_credit_block: document.getElementById('sg-credit-block')?.checked || false, pos_receive_payment: document.getElementById('sg-receive-payment')?.checked || false, pos_petty_cash: document.getElementById('sg-petty-cash')?.checked || false, returns_override: document.getElementById('sg-returns-override')?.checked || false, customers_legacy_credit: document.getElementById('sg-legacy-credit')?.checked || false, customers_legacy_credit_void: document.getElementById('sg-legacy-credit-void')?.checked || false };
    this._permissionTree.forEach(mod => {
      permissions[mod.key] = document.getElementById(`perm-${mod.key}`)?.checked || false;
      mod.subs.forEach(s => { permissions[s.key] = document.getElementById(`perm-${s.key}`)?.checked || false; });
    });
    try {
      if (id) await this.api('PUT', `/security-groups/${id}`, { name, description, permissions });
      else await this.api('POST', '/security-groups', { name, description, permissions });
      this.closeModal();
      this.alert('Security group saved');
      this.renderSecurity();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async deleteSecurityGroup(id) {
    if (!confirm('Delete this security group?')) return;
    try {
      await this.api('DELETE', `/security-groups/${id}`);
      this.alert('Group deleted');
      this.renderSecurity();
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async showAssignGroup(groupId, groupName) {
    const [group, employees] = await Promise.all([
      this.api('GET', `/security-groups/${groupId}`),
      this.api('GET', '/employees'),
    ]);
    const memberIds = new Set(group.members.map(m => m.id));
    const unassigned = employees.filter(e => !memberIds.has(e.id));
    this.showModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-header"><span class="modal-title">Assign Users — ${groupName}</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="card-header"><span class="card-title">Current Members</span></div>
          <div style="margin-bottom:14px">
            ${group.members.length ? group.members.map(m => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">
                <span>${m.first_name} ${m.last_name} <small style="color:var(--text-muted)">(${m.username})</small></span>
                <button class="btn btn-sm btn-danger" onclick="App.removeFromGroup(${groupId},${m.id})">Remove</button>
              </div>`).join('') : '<p style="color:var(--text-muted);font-size:13px">No members yet</p>'}
          </div>
          ${unassigned.length ? `
            <div class="card-header"><span class="card-title">Add Member</span></div>
            <div class="input-row" style="align-items:flex-end">
              <div class="form-group" style="flex:1"><label>Employee</label>
                <select id="assign-emp-sel">
                  ${unassigned.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name} (${e.username})</option>`).join('')}
                </select>
              </div>
              <button class="btn btn-primary" style="margin-bottom:14px" onclick="App.assignToGroup(${groupId})">Assign</button>
            </div>` : '<p style="font-size:13px;color:var(--text-muted)">All employees are assigned to this group.</p>'}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="App.closeModal()">Done</button></div>
      </div>`);
  },

  async assignToGroup(groupId) {
    const emp_id = document.getElementById('assign-emp-sel').value;
    if (!emp_id) return;
    try {
      await this.api('POST', `/security-groups/${groupId}/assign`, { employee_id: emp_id });
      this.alert('Employee assigned to group');
      const g = await this.api('GET', `/security-groups/${groupId}`);
      this.showAssignGroup(groupId, g.name);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  async removeFromGroup(groupId, empId) {
    try {
      await this.api('DELETE', `/security-groups/${groupId}/assign/${empId}`);
      this.alert('Employee removed from group');
      const g = await this.api('GET', `/security-groups/${groupId}`);
      this.showAssignGroup(groupId, g.name);
    } catch(e) { this.alert(e.message, 'error'); }
  },

  // ─── Security groups list ────────────────────────────────────────
  async renderSecurity() {
    const c = document.getElementById('content');
    c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    const groups = await this.api('GET', '/security-groups');
    if (this.section !== 'security') return;
    c.innerHTML = `
      <div class="section-header">
        <h2>Security Groups</h2>
        <button class="btn btn-primary" onclick="App.showSecurityGroupForm()">+ New Group</button>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Group Name</th><th>Description</th><th>Members</th><th>Branch Access</th><th>Permissions</th><th>Actions</th></tr></thead>
            <tbody>
              ${groups.length ? groups.map(g => {
                const moduleKeys = new Set(this._permissionTree.map(m => m.key));
                const perms = Object.entries(g.permissions).filter(([k,v]) => v && moduleKeys.has(k)).map(([k]) => this._permissionTree.find(m=>m.key===k)?.label || k);
                return `<tr>
                  <td class="fw-600">${g.name}</td>
                  <td>${g.description||'-'}</td>
                  <td><span class="badge-pill badge-info">${g.member_count} members</span></td>
                  <td>${g.permissions.multi_branch_access ? '<span class="badge-pill badge-success">Multi-Branch</span>' : '<span class="badge-pill" style="background:var(--bg-secondary);color:var(--text-muted)">Single Branch</span>'}</td>
                  <td style="font-size:11px">${perms.slice(0,5).join(', ')}${perms.length > 5 ? ` +${perms.length-5} more` : ''}</td>
                  <td>
                    <button class="btn btn-sm btn-secondary" onclick="App.showSecurityGroupForm(${g.id})">Edit</button>
                    <button class="btn btn-sm btn-outline" onclick="App.showAssignGroup(${g.id},'${g.name}')">Assign Users</button>
                    ${g.member_count === 0 ? `<button class="btn btn-sm btn-danger" onclick="App.deleteSecurityGroup(${g.id})">Delete</button>` : ''}
                  </td>
                </tr>`;}).join('') : '<tr><td colspan="6" class="empty-state">No security groups</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  },
});
