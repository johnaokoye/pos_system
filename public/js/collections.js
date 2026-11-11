// Collections: sales waiting on goods from another branch (POS "Get from another branch", lib/saleTransfers.js) — the list, contacting the customer, handing over, and the ready-for-collection notice.
Object.assign(App, {
  // GET /transactions/collections for the person's branch, polled every
  // minute: the count of orders ready and not yet contacted shows on the POS
  // Collections button, and each newly ready one pops a notice once.
  _collectionsBranchId() {
    return this.posBranch?.id || (this.currentUser?.branches || []).find(b => b.is_default)?.id || this.currentUser?.branches?.[0]?.id || null;
  },
  _startCollectionsInbox() {
    clearInterval(this._collTimer);
    this._collCount = 0;
    if (!this.can('pos')) return;
    this._pollCollections();
    this._collTimer = setInterval(() => this._pollCollections(), 60000);
  },
  _stopCollectionsInbox() { clearInterval(this._collTimer); this._collTimer = null; this._collCount = 0; this._paintCollectionsBadge(); },
  _paintCollectionsBadge() {
    const el = document.getElementById('collect-count-badge');
    if (!el) return;
    const n = this._collCount || 0;
    el.style.display = n ? '' : 'none';
    el.textContent = n > 99 ? '99+' : n;
  },
  async _pollCollections() {
    if (!this.currentUser || !this.can('pos')) return;
    const branch = this._collectionsBranchId();
    let rows;
    try { rows = await this.api('GET', `/transactions/collections${branch ? `?branch_id=${branch}` : ''}`); } catch { return; }
    if (!this.currentUser) return;
    const ready = rows.filter(r => r.collection_status === 'ready' && !r.contacted_at);
    this._collCount = ready.length;
    this._paintCollectionsBadge();
    const key = `collSeen:${this.currentUser.id}`;
    let seen;
    try { seen = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { seen = new Set(); }
    // A notice only for the person who made or is credited with the sale (the
    // count on the Collections button is for everyone at the branch); several
    // at once come as one.
    const me = this.currentUser.id;
    const fresh = ready.filter(r => !seen.has(r.id) && (r.credited_id === me || r.employee_id === me));
    if (fresh.length > 1) {
      this._notify({ title: `📦 ${fresh.length} of your orders are ready for collection`,
        body: fresh.slice(0, 6).map(r => `${this.escapeAttr(r.transaction_number)} · ${this.escapeAttr(r.customer_name || 'Walk-in')}${r.customer_phone ? ` · ${this.escapeAttr(r.customer_phone)}` : ''}`).join('<br>') + (fresh.length > 6 ? `<br>…and ${fresh.length - 6} more` : '') + '<br>Contact the customers.',
        actions: [{ label: 'Open Collections', primary: true, run: () => this.showCollections() }] });
    } else if (fresh.length) {
      const r = fresh[0];
      this._notify({
        title: `📦 ${r.transaction_number} is ready for collection`,
        body: `<strong>${this.escapeAttr(r.customer_name || 'Walk-in')}</strong>${r.customer_phone ? ` · ${this.escapeAttr(r.customer_phone)}` : ''} — everything has arrived from the other branch. Contact the customer.`,
        actions: [{ label: 'Open Collections', primary: true, run: () => this.showCollections() }],
      });
    }
    for (const r of ready) seen.add(r.id);
    try { localStorage.setItem(key, JSON.stringify([...seen].slice(-300))); } catch { /* not kept */ }
  },

  async showCollections() {
    this._collShowDone = false;
    this.showModal(`
      <div class="modal" style="max-width:960px">
        <div class="modal-header"><span class="modal-title">Collections — paid, waiting on goods from another branch</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;font-size:13px">
            <span>${this.escapeAttr((this.currentUser?.branches || []).find(b => b.id === this._collectionsBranchId())?.name || this.posBranch?.name || 'All branches')}</span>
            <label style="display:flex;align-items:center;gap:6px;margin-left:auto;cursor:pointer"><input type="checkbox" id="coll-done" style="width:auto;margin:0" onchange="App._collShowDone=this.checked;App._loadCollections()"> Show handed over (last 30 days)</label>
          </div>
          <div id="coll-list"><div class="empty-state"><p>Loading…</p></div></div>
        </div>
      </div>`);
    this._loadCollections();
  },

  async _loadCollections() {
    const el = document.getElementById('coll-list');
    if (!el) return;
    const branch = this._collectionsBranchId();
    const qs = new URLSearchParams();
    if (branch) qs.set('branch_id', branch);
    if (this._collShowDone) qs.set('include', 'collected');
    let rows;
    try { rows = await this.api('GET', `/transactions/collections?${qs}`); }
    catch (e) { el.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`; return; }
    const esc = v => this.escapeAttr(v == null ? '' : String(v));
    const trfStatus = { requested: 'Requested — waiting for the inventory team to send it', pending: 'Sent — waiting for pickup', in_transit: 'On its way', received: 'Received here', cancelled: 'Cancelled' };
    const badge = s => s === 'ready' ? '<span class="badge-pill badge-success">Ready to collect</span>'
      : s === 'collected' ? '<span class="badge-pill badge-info">Handed over</span>'
      : '<span class="badge-pill badge-warning">Awaiting goods on transfer</span>';
    el.innerHTML = rows.length ? rows.map(r => `
      <div class="card" style="margin-bottom:10px;padding:12px 14px">
        <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
          <div style="flex:1;min-width:240px">
            <div class="fw-600">${esc(r.transaction_number)} ${badge(r.collection_status)}</div>
            <div style="font-size:13px;margin-top:2px"><strong>${esc(r.customer_name || 'Walk-in')}</strong>${r.business_name ? ` · ${esc(r.business_name)}` : ''}${r.customer_phone ? ` · <a href="tel:${esc(r.customer_phone)}">${esc(r.customer_phone)}</a>` : ''}${r.customer_email ? ` · ${esc(r.customer_email)}` : ''}</div>
            <div style="font-size:12px;color:var(--text-muted)">Sold ${this.fmtDateTime(r.created_at)} · ${this.fmt(r.total)} · ${esc(String(r.payment_method || '').replace(/_/g, ' '))}${r.salesperson_name ? ` · ${esc(r.salesperson_name)}` : ''}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${r.collection_status !== 'collected' ? `<button class="btn btn-sm btn-outline" onclick="App._collContacted(${r.id})">${r.contacted_at ? 'Contacted again' : 'Customer contacted'}</button>` : ''}
            ${r.collection_status === 'ready' ? `<button class="btn btn-sm btn-success" onclick="App._collHandOver(${r.id}, '${esc(r.transaction_number)}')">Hand over</button>` : ''}
            <button class="btn btn-sm btn-secondary" onclick="App.viewTransaction(${r.id})">View sale</button>
          </div>
        </div>
        <table style="margin:8px 0 0;font-size:12px"><thead><tr><th>Item</th><th style="text-align:right">Sold</th><th style="text-align:right">From other branch</th><th style="text-align:right">Arrived</th></tr></thead><tbody>
          ${r.lines.filter(l => l.transfer_qty > 0).map(l => `<tr><td>${esc(l.product_name)}</td><td style="text-align:right">${l.quantity * (l.units_per || 1)}</td><td style="text-align:right">${l.transfer_qty}</td>
            <td style="text-align:right;${l.transfer_received_qty >= l.transfer_qty ? 'color:var(--success);font-weight:600' : ''}">${l.transfer_received_qty}</td></tr>`).join('')}
        </tbody></table>
        <div style="font-size:12px;margin-top:6px">${r.transfers.map(t => `<div>Transfer <strong>${esc(t.transfer_number)}</strong> from ${esc(t.from_branch_name)}: ${esc(trfStatus[t.status] || t.status)}${t.items.some(i => i.sent < i.asked) && t.status !== 'requested' ? ' <span style="color:var(--danger)">— fewer sent than asked</span>' : ''}${t.status === 'cancelled' ? ' <span style="color:var(--danger)">— speak to the inventory team</span>' : ''}</div>`).join('')}</div>
        ${r.contacted_at ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">Contacted ${this.fmtDateTime(r.contacted_at)}${r.contacted_by_name ? ` by ${esc(r.contacted_by_name)}` : ''}${r.contact_note ? ` — ${esc(r.contact_note)}` : ''}</div>` : ''}
        ${r.collected_at ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">Handed over ${this.fmtDateTime(r.collected_at)}${r.collected_by_name ? ` by ${esc(r.collected_by_name)}` : ''}</div>` : ''}
      </div>`).join('') : '<div class="empty-state"><p>Nothing waiting to be collected at this branch.</p></div>';
  },

  async _collContacted(id) {
    const note = prompt('How was the customer contacted? (e.g. called, left message, emailed)', 'Called');
    if (note == null) return;
    try { await this.api('PATCH', `/transactions/${id}/collection-contacted`, { note }); this._loadCollections(); this._pollCollections(); }
    catch (e) { this.alert(e.message, 'error'); }
  },

  async _collHandOver(id, number) {
    if (!confirm(`Hand over the goods for ${number}? This records that the customer has collected everything.`)) return;
    try {
      await this.api('PATCH', `/transactions/${id}/collected`, {});
      this.alert(`${number} handed over`, 'success');
      this._loadCollections(); this._pollCollections();
    } catch (e) { this.alert(e.message, 'error'); }
  },
});
