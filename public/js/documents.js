// Shared document pieces: Bill To box, P.O. #, signature lines, server-rendered print, email dialog.
Object.assign(App, {
  // ─── Bill To box, P.O. # and signature lines on printed invoices ────
  // The invoice's "Bill To" lines after the (bold) customer name — account
  // code, then address. Mirrors billToLines() in routes/email.js.
  _billToLines(tx) {
    const cityLine = [tx.customer_city, [tx.customer_state, tx.customer_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [tx.customer_number ? `Account #: ${tx.customer_number}` : '', tx.customer_address, cityLine].filter(Boolean);
  },

  // Printed invoices (letter popups): Bill To box at the top left, the
  // document's reference fields ([label, html]) beside it — P.O. # among
  // them, a write-in line when empty (_poValueHtml) — and blank signature
  // lines at the bottom (_invoiceSignatureLinesHtml).
  _billToPrintCss: `
      .bill-row{display:flex;justify-content:space-between;gap:24px;margin-bottom:16px}
      .bill-to{flex:0 1 55%;border:1px solid #ccc;border-radius:6px;padding:10px 12px;font-size:12px;line-height:1.5}
      .bill-to .bill-name{font-weight:700;font-size:15px;color:#111}
      .bill-row label{font-weight:bold;text-transform:uppercase;font-size:10px;color:#555;display:block}
      .inv-ref{display:grid;grid-template-columns:auto auto;gap:6px 24px;align-content:start;font-size:12px}
      .write-in{display:inline-block;width:120px;border-bottom:1px solid #333;height:14px}`,

  _billToPrintHtml(x, refs) {
    return `<div class="bill-row">
      <div class="bill-to">
        <label>Bill To</label>
        <div class="bill-name">${this.escapeAttr(x.customer_name || 'Cash Customer')}</div>
        ${this._billToLines(x).map(l => `<div>${this.escapeAttr(l)}</div>`).join('')}
      </div>
      <div class="inv-ref">
        ${refs.filter(([, v]) => v != null && v !== '').map(([l, v]) => `<div><label>${l}</label>${v}</div>`).join('')}
      </div>
    </div>`;
  },

  _poValueHtml(po) {
    return po ? this.escapeAttr(po) : '<span class="write-in"></span>';
  },

  // Customer (unless they already signed digitally) and Manager.
  _invoiceSignatureLinesHtml(customerSigned = false) {
    const labels = [customerSigned ? null : 'Customer Signature', 'Manager Signature'].filter(Boolean);
    return `<div style="display:flex;justify-content:space-between;margin-top:70px;gap:64px">
      ${labels.map(l => `<div style="flex:1;text-align:center"><div style="border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555">${l}</div></div>`).join('')}
    </div>`;
  },

  // ─── Print a server-rendered document ────────────────────────────
  // Opens a server-rendered printable document (tagged by the server with
  // X-Pos-Document: <tag>) in a popup and prints it. Fetched first rather
  // than opening the URL directly, so an error (no access, not printable
  // yet, or a server running older code that returns the SPA shell for an
  // unknown path) shows as a message instead of printing whatever page came
  // back. The window is opened synchronously, before the fetch, so it stays
  // inside the click's user gesture and isn't blocked as a popup.
  async _printServerDocument(url, tag, label) {
    const win = window.open('', '_blank', 'width=850,height=1000');
    if (!win) { this.alert('Your browser blocked the print popup — allow popups for this site and try again', 'warning'); return; }
    win.document.write(`<p style="font-family:Arial,sans-serif;padding:24px;color:#555">Preparing ${label}…</p>`);
    let html;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/json')) throw new Error((await res.json()).error || `Request failed (${res.status})`);
      html = await res.text();
      if (!res.ok) throw new Error(html.replace(/<[^>]+>/g, '').trim() || `Request failed (${res.status})`);
      if (res.headers.get('x-pos-document') !== tag) throw new Error(`the server returned something other than the ${label} — it may be running an older version and need a restart`);
    } catch(e) {
      win.close();
      this.alert(`Could not print ${label}: ${e.message}`, 'error');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    // document.write() doesn't fire a fresh load event reliably across
    // browsers — give layout a beat, then print.
    setTimeout(() => win.print(), 300);
  },

  // ─── Email a document dialog ─────────────────────────────────────
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
});
