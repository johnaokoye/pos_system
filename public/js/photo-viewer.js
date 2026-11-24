// Photo viewer: click a checkpoint thumbnail (rentals, work orders) to see it full screen over whatever's open, step through its set, zoom in.
Object.assign(App, {
  // A thumbnail link that opens in the viewer (ctrl/middle-click still opens the file in a new tab).
  // `group` = the set it steps through (every link on the page with the same group), `caption` = text under it.
  _zoomThumbHtml(url, group, caption, size = 72) {
    return `<a href="${url}" target="_blank" rel="noopener" data-zoom="${this.escapeAttr(group)}" data-caption="${this.escapeAttr(caption || '')}" onclick="return App._zoomPhoto(event,this)" style="display:block;cursor:zoom-in"><img src="${url}" loading="lazy" alt="" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:4px;border:1px solid var(--border)"${caption ? ` title="${this.escapeAttr(caption)}"` : ''}></a>`;
  },

  _zoomPhoto(e, link) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return true;
    e.preventDefault(); e.stopPropagation();
    const seen = new Set();
    const set = [...document.querySelectorAll(`a[data-zoom="${CSS.escape(link.dataset.zoom)}"]`)]
      .filter(a => !seen.has(a.href) && seen.add(a.href))
      .map(a => ({ url: a.href, caption: a.dataset.caption || '' }));
    this._zoomSet = set.length ? set : [{ url: link.href, caption: link.dataset.caption || '' }];
    this._zoomIdx = Math.max(0, this._zoomSet.findIndex(p => p.url === link.href));
    this._zoomOpen();
    return false;
  },

  _zoomOpen() {
    document.getElementById('photo-zoom')?.remove();
    const many = this._zoomSet.length > 1;
    const btn = 'position:absolute;top:50%;transform:translateY(-50%);width:48px;height:64px;border:none;border-radius:6px;background:rgba(255,255,255,.15);color:#fff;font-size:30px;cursor:pointer';
    const el = document.createElement('div');
    el.id = 'photo-zoom';
    el.tabIndex = -1;
    el.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.92);display:flex;flex-direction:column;outline:none';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;color:#fff;font-size:13px">
        <span id="pz-count" style="opacity:.7;white-space:nowrap"></span>
        <span id="pz-caption" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        <a id="pz-orig" target="_blank" rel="noopener" style="color:#fff;opacity:.8;white-space:nowrap">Open original ↗</a>
        <button type="button" title="Close (Esc)" onclick="App._zoomClose()" style="border:none;background:rgba(255,255,255,.15);color:#fff;width:36px;height:36px;border-radius:50%;font-size:18px;cursor:pointer">✕</button>
      </div>
      <div id="pz-stage" style="flex:1;min-height:0;position:relative;overflow:auto;display:flex;align-items:center;justify-content:center">
        <img id="pz-img" alt="" style="max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-in;user-select:none" onclick="App._zoomToggle(event)">
      </div>
      ${many ? `<button type="button" title="Previous (←)" onclick="App._zoomStep(-1)" style="${btn};left:10px">‹</button>
      <button type="button" title="Next (→)" onclick="App._zoomStep(1)" style="${btn};right:10px">›</button>` : ''}`;
    // Click the dark background to close.
    el.addEventListener('click', ev => { if (ev.target === el || ev.target.id === 'pz-stage') this._zoomClose(); });
    // Keys stay here so Esc doesn't also close the modal underneath.
    el.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') this._zoomClose();
      else if (ev.key === 'ArrowLeft') this._zoomStep(-1);
      else if (ev.key === 'ArrowRight') this._zoomStep(1);
      else return;
      ev.preventDefault(); ev.stopPropagation();
    });
    // Swipe on a phone/tablet.
    let x0 = null;
    el.addEventListener('touchstart', ev => { x0 = ev.touches.length === 1 ? ev.touches[0].clientX : null; }, { passive: true });
    el.addEventListener('touchend', ev => {
      if (x0 == null || this._zoomBig) return;
      const dx = ev.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) this._zoomStep(dx < 0 ? 1 : -1);
    });
    this._zoomPrevFocus = document.activeElement;
    document.body.appendChild(el);
    this._zoomShow();
    el.focus();
  },

  _zoomShow() {
    const p = this._zoomSet[this._zoomIdx];
    const img = document.getElementById('pz-img');
    if (!p || !img) return;
    this._zoomBig = false;
    img.style.maxWidth = '100%'; img.style.maxHeight = '100%'; img.style.cursor = 'zoom-in';
    img.src = p.url;
    document.getElementById('pz-caption').textContent = p.caption;
    document.getElementById('pz-orig').href = p.url;
    document.getElementById('pz-count').textContent = this._zoomSet.length > 1 ? `${this._zoomIdx + 1} / ${this._zoomSet.length}` : '';
    // Load the neighbours so stepping is instant.
    [1, -1].forEach(d => { const n = this._zoomSet[(this._zoomIdx + d + this._zoomSet.length) % this._zoomSet.length]; if (n) new Image().src = n.url; });
  },

  _zoomStep(d) {
    if (!document.getElementById('photo-zoom') || this._zoomSet.length < 2) return;
    this._zoomIdx = (this._zoomIdx + d + this._zoomSet.length) % this._zoomSet.length;
    this._zoomShow();
  },

  // Click the photo: full size (scroll to look around), centred on where you clicked; click again to fit.
  _zoomToggle(e) {
    e.stopPropagation();
    const img = e.currentTarget, stage = document.getElementById('pz-stage');
    this._zoomBig = !this._zoomBig;
    if (!this._zoomBig) { img.style.maxWidth = '100%'; img.style.maxHeight = '100%'; img.style.cursor = 'zoom-in'; stage.style.alignItems = stage.style.justifyContent = 'center'; return; }
    const r = img.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    img.style.maxWidth = img.style.maxHeight = 'none'; img.style.cursor = 'zoom-out';
    stage.style.alignItems = stage.style.justifyContent = 'flex-start';
    stage.scrollLeft = Math.max(0, fx * img.naturalWidth - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, fy * img.naturalHeight - stage.clientHeight / 2);
  },

  _zoomClose() {
    document.getElementById('photo-zoom')?.remove();
    this._zoomPrevFocus?.focus?.();
  },
});
