// Admin Active Sessions and the security groups list.
Object.assign(App, {
  // Rough browser/OS/device read from the User-Agent — enough for an admin
  // to tell "the front-counter Windows PC" from "someone's phone".
  _describeUserAgent(ua) {
    if (!ua) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|axios|python/i.test(ua) ? 'Script / API client' : 'Other';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
    const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet' : /Mobi|iPhone|Android/.test(ua) ? 'Mobile' : 'Desktop';
    return { browser, os, device };
  },

  _isPrivateIp(ip) {
    return !ip || ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  },

  _sectionLabel(key) {
    if (!key) return '-';
    for (const [hubKey, hub] of Object.entries(this._hubGroups)) {
      if (hubKey === key) return hub.title;
      const child = hub.children.find(c => c.section === key);
      if (child) return child.label;
    }
    return key.replace(/[-_]/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
  },

  // "PATCH /work-orders/12/signoff" -> "Updated work orders". The raw path
  // is always shown next to it, this is just the scannable headline.
  _describeAction(method, path) {
    const seg = (path || '').split('/').filter(Boolean);
    const resource = (seg[0] || '').replace(/[-_]/g, ' ');
    const tail = seg.length > 1 && !/^\d+$/.test(seg[seg.length - 1]) ? seg[seg.length - 1].replace(/[-_]/g, ' ') : '';
    const verb = { POST: tail ? '' : 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[method] ?? method;
    return [verb, tail, tail ? `(${resource})` : resource].filter(Boolean).join(' ').replace(/^\w/, ch => ch.toUpperCase());
  },

  _activityRow(a, showUser) {
    const esc = v => this.escapeAttr(v);
    const who = a.first_name ? `${esc(a.first_name)} ${esc(a.last_name)}` : '<span style="color:var(--text-muted)">—</span>';
    let badge, text;
    switch (a.kind) {
      case 'login': badge = '<span class="badge-pill badge-success">Login</span>'; text = `Signed in with ${esc(a.detail || 'password')}`; break;
      case 'logout': badge = '<span class="badge-pill badge-info">Logout</span>'; text = 'Signed out'; break;
      case 'login_failed': badge = '<span class="badge-pill badge-danger">Failed login</span>'; text = `Bad credentials for username “${esc(a.detail)}”`; break;
      case 'revoked': badge = '<span class="badge-pill badge-warning">Forced out</span>'; text = `Session ended ${esc(a.detail)}`; break;
      case 'view': badge = '<span class="badge-pill" style="background:var(--bg-secondary);color:var(--text-muted)">View</span>'; text = `Opened ${esc(this._sectionLabel(a.detail))}`; break;
      default: {
        const failed = a.status >= 400;
        badge = `<span class="badge-pill ${failed ? 'badge-danger' : 'badge-info'}">${esc(a.method)}${failed ? ` ${a.status}` : ''}</span>`;
        text = `${esc(this._describeAction(a.method, a.path))} <span style="font-family:monospace;font-size:11px;color:var(--text-muted)">${esc(a.path)}</span>`;
      }
    }
    const at = this._utcDate(a.created_at);
    return `<tr>
      <td style="white-space:nowrap" title="${at ? esc(at.toLocaleString()) : ''}">${this._timeAgo(a.created_at)}</td>
      ${showUser ? `<td>${who}</td>` : ''}
      <td>${badge}</td>
      <td>${text}</td>
      <td style="font-family:monospace;font-size:11px">${esc(a.ip_address || '-')}</td>
    </tr>`;
  },

  async renderUserSessions() {
    const c = document.getElementById('content');
    if (!this._sessionsView) this._sessionsView = { status: 'active', search: '' };
    if (!c.querySelector('#us-root')) c.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    let data, activity;
    try {
      [data, activity] = await Promise.all([
        this.api('GET', `/sessions?status=${this._sessionsView.status}`),
        this.api('GET', '/sessions/activity?limit=100'),
      ]);
    } catch (e) {
      if (this.section === 'user-sessions') c.innerHTML = `<div class="empty-state"><p>${this.escapeAttr(e.message)}</p></div>`;
      return;
    }
    if (this.section !== 'user-sessions') return;
    this._sessionsData = data;
    const esc = v => this.escapeAttr(v);
    const st = data.stats;
    c.innerHTML = `<div id="us-root">
      <div class="section-header">
        <h2>Active Sessions</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          <input id="us-search" placeholder="Search user, IP, branch…" value="${esc(this._sessionsView.search)}" style="width:220px;margin:0" oninput="App._sessionsView.search=this.value;App._renderSessionsTable()">
          <select style="width:auto;margin:0" onchange="App._sessionsView.status=this.value;App.renderUserSessions()">
            <option value="active" ${this._sessionsView.status === 'active' ? 'selected' : ''}>Logged in now</option>
            <option value="all" ${this._sessionsView.status === 'all' ? 'selected' : ''}>All sessions (last 7 days)</option>
          </select>
          <button class="btn btn-secondary" onclick="App.renderUserSessions()">Refresh</button>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card green"><div class="stat-label">Online now</div><div class="stat-value">${st.online_now}</div><div class="stat-sub">active in last ${data.online_window_min} min</div></div>
        <div class="stat-card blue"><div class="stat-label">Users logged in</div><div class="stat-value">${st.users_logged_in}</div><div class="stat-sub">${st.active_sessions} open session${st.active_sessions === 1 ? '' : 's'}</div></div>
        <div class="stat-card purple"><div class="stat-label">Logins (24h)</div><div class="stat-value">${st.logins_24h}</div></div>
        <div class="stat-card orange"><div class="stat-label">Actions (24h)</div><div class="stat-value">${st.actions_24h}</div><div class="stat-sub">creates, edits, deletes</div></div>
        <div class="stat-card ${st.failed_logins_24h ? 'red' : ''}"><div class="stat-label">Failed logins (24h)</div><div class="stat-value">${st.failed_logins_24h}</div></div>
      </div>
      <div class="card" style="margin-bottom:18px">
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Status</th><th>Location</th><th>Device</th><th>Currently on</th><th>Last action</th><th>Signed in</th><th></th></tr></thead>
            <tbody id="us-tbody"></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px 0">
          <h3 style="margin:0;font-size:15px">Recent activity</h3>
          <span style="font-size:12px;color:var(--text-muted)">Logins, screens opened and every create/edit/delete — last 100 events</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>When</th><th>User</th><th>Event</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>${activity.length ? activity.map(a => this._activityRow(a, true)).join('') : '<tr><td colspan="5" class="empty-state">No activity recorded yet</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>`;
    this._renderSessionsTable();
    const search = document.getElementById('us-search');
    if (this._sessionsView.focusSearch && search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }

    // Auto-refresh while this screen is open. The timer checks this.section
    // itself so navigating away stops it without any teardown hook.
    clearTimeout(this._sessionsTimer);
    this._sessionsTimer = setTimeout(() => {
      if (this.section !== 'user-sessions' || document.querySelector('.modal-overlay')) {
        if (this.section === 'user-sessions') this._sessionsTimer = setTimeout(() => this.renderUserSessions(), 30000);
        return;
      }
      this._sessionsView.focusSearch = document.activeElement?.id === 'us-search';
      this.renderUserSessions();
    }, 30000);
  },

  _renderSessionsTable() {
    const canRevoke = this.can('sessions_logout');
    const tbody = document.getElementById('us-tbody');
    const data = this._sessionsData;
    if (!tbody || !data) return;
    const esc = v => this.escapeAttr(v);
    const q = (this._sessionsView.search || '').toLowerCase();
    const rows = data.sessions.filter(s => !q || `${s.first_name} ${s.last_name} ${s.username} ${s.ip_address} ${s.branch_name}`.toLowerCase().includes(q));
    tbody.innerHTML = rows.length ? rows.map(s => {
      const ua = this._describeUserAgent(s.user_agent);
      const status = s.ended
        ? `<span class="badge-pill" style="background:var(--bg-secondary);color:var(--text-muted)">${s.revoked_at ? 'Ended' : 'Expired'}</span>`
        : s.online ? '<span class="badge-pill badge-success">Online</span>' : `<span class="badge-pill badge-warning">Idle ${s.idle_minutes >= 60 ? Math.floor(s.idle_minutes / 60) + 'h' : s.idle_minutes + 'm'}</span>`;
      const signedIn = this._utcDate(s.created_at);
      return `<tr style="cursor:pointer" onclick="App.showSessionActivity(${s.id})">
        <td><div class="fw-600">${esc(s.first_name)} ${esc(s.last_name)}${s.is_current ? ' <span class="badge-pill badge-info">You</span>' : ''}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(s.username)} · ${esc(s.security_group_name || 'No group')}</div></td>
        <td>${status}<div style="font-size:11px;color:var(--text-muted);margin-top:2px">seen ${this._timeAgo(s.last_seen_at)}</div></td>
        <td><div>${esc(s.branch_name || 'No branch')}</div>
          <div style="font-size:11px;font-family:monospace;color:var(--text-muted)">${esc(s.ip_address || 'unknown IP')}${s.ip_address ? (this._isPrivateIp(s.ip_address) ? ' (local network)' : ' (internet)') : ''}</div></td>
        <td><div>${esc(ua.browser)} on ${esc(ua.os)}</div><div style="font-size:11px;color:var(--text-muted)">${esc(ua.device)}</div></td>
        <td>${esc(this._sectionLabel(s.last_section))}</td>
        <td>${s.last_action ? `<div>${esc(this._describeAction(...s.last_action.split(' ')))}</div><div style="font-size:11px;color:var(--text-muted)">${this._timeAgo(s.last_action_at)} · ${s.action_count} total</div>` : '<span style="color:var(--text-muted)">None yet</span>'}</td>
        <td style="white-space:nowrap" title="${signedIn ? esc(signedIn.toLocaleString()) : ''}">${this._timeAgo(s.created_at)}</td>
        <td onclick="event.stopPropagation()">${canRevoke && !s.ended && !s.is_current ? `<button class="btn btn-sm btn-danger" onclick="App.revokeUserSession(${s.id})">Log out</button>` : ''}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" class="empty-state">${q ? 'No sessions match your search' : 'No one is logged in'}</td></tr>`;
  },

  async showSessionActivity(sessionId) {
    const s = (this._sessionsData?.sessions || []).find(x => x.id === sessionId);
    if (!s) return;
    let activity;
    try { activity = await this.api('GET', `/sessions/activity?session_id=${sessionId}&limit=300`); }
    catch (e) { return this.alert(e.message, 'error'); }
    const esc = v => this.escapeAttr(v);
    const ua = this._describeUserAgent(s.user_agent);
    const signedIn = this._utcDate(s.created_at);
    this.showModal(`
      <div class="modal" style="max-width:860px">
        <div class="modal-header"><span class="modal-title">${esc(s.first_name)} ${esc(s.last_name)} — session activity</span><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px;font-size:13px">
            <div><div class="stat-label">Signed in</div>${signedIn ? esc(signedIn.toLocaleString()) : '-'}</div>
            <div><div class="stat-label">Branch</div>${esc(s.branch_name || 'No branch')}</div>
            <div><div class="stat-label">IP address</div><span style="font-family:monospace">${esc(s.ip_address || '-')}</span></div>
            <div><div class="stat-label">Device</div>${esc(ua.browser)} on ${esc(ua.os)} (${esc(ua.device)})</div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;word-break:break-all">${esc(s.user_agent || '')}</div>
          <div class="table-wrap" style="max-height:55vh;overflow:auto">
            <table>
              <thead><tr><th>When</th><th>Event</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>${activity.length ? activity.map(a => this._activityRow(a, false)).join('') : '<tr><td colspan="4" class="empty-state">No activity recorded for this session</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer">
          ${this.can('sessions_logout') && !s.ended && !s.is_current ? `<button class="btn btn-danger" onclick="App.revokeUserSession(${s.id})">Log this session out</button>` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        </div>
      </div>`);
  },

  async revokeUserSession(id) {
    const s = (this._sessionsData?.sessions || []).find(x => x.id === id);
    if (!confirm(`Log ${s ? `${s.first_name} ${s.last_name}` : 'this user'} out? Any unsaved work on their screen will be lost.`)) return;
    try {
      await this.api('POST', `/sessions/${id}/revoke`);
      this.closeModal();
      this.alert('Session ended');
      this.renderUserSessions();
    } catch (e) { this.alert(e.message, 'error'); }
  },

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
