// Home screen.
Object.assign(App, {
  // ─── Home ─────────────────────────────────────────────────────────────────
  // Landing page for users without the Dashboard: a live clock, the date and
  // the weather at their branch (Open-Meteo — free, no key; the branch's
  // city is geocoded once and cached in this browser), on a sky that follows
  // the time of day and the actual conditions, plus shortcuts to the screens
  // they can open.
  _homeWeatherText: { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' },
  // The forecast models often call a trace (0.1 mm) "light drizzle" or
  // "showers" over a small island when it's really just cloud, so light
  // drizzle / light rain / slight showers with no measurable rain are shown
  // as the sky's cloud cover instead (current, each hour and each day).
  _homeDropTraceRain(w) {
    const light = new Set([51, 53, 61, 80]);
    const sky = cover => cover == null ? 2 : cover < 25 ? 1 : cover < 80 ? 2 : 3;
    const fix = (code, rain, cover, trace) => light.has(code) && (Number(rain) || 0) < trace ? sky(cover) : code;
    if (w.current) w.current.weather_code = fix(w.current.weather_code, w.current.precipitation, w.current.cloud_cover, 0.2);
    const h = w.hourly;
    if (h?.weather_code) h.weather_code = h.weather_code.map((c, i) => fix(c, h.precipitation?.[i], h.cloud_cover?.[i], 0.2));
    const d = w.daily;
    if (d?.weather_code) d.weather_code = d.weather_code.map((c, i) => fix(c, d.precipitation_sum?.[i], d.cloud_cover_mean?.[i], 1));
  },

  _homeKind(code) {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2) return 'partly';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 71 && code <= 77 || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    if (code >= 51) return 'rain';
    return 'cloudy';
  },

  // Animated weather glyph (100×100 SVG) — sun/moon, clouds, rain, snow, lightning, fog.
  _homeWeatherSvg(kind, isDay) {
    const sun = `<g class="rays" stroke="#FFD54F" stroke-width="5" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<line x1="50" y1="14" x2="50" y2="22" transform="rotate(${a} 50 50)"/>`).join('')}</g><circle cx="50" cy="50" r="18" fill="#FFCA28"/>`;
    const moon = `<path d="M60 30a22 22 0 1 0 12 32a18 18 0 1 1-12-32z" fill="#FFF3C4"/>`;
    const cloud = (x, y, sc, fill) => `<g class="drift" transform="translate(${x} ${y}) scale(${sc})"><path d="M20 60h52a16 16 0 0 0 0-32a22 22 0 0 0-42-6a16 16 0 0 0-10 38z" fill="${fill}"/></g>`;
    const light = cloud(4, 16, 1, '#fff'), dark = cloud(4, 12, 1, '#cfd8dc');
    const body = isDay ? sun : moon;
    switch (kind) {
      case 'clear': return `<svg class="home-wicon" viewBox="0 0 100 100">${body}</svg>`;
      case 'partly': return `<svg class="home-wicon" viewBox="0 0 100 100"><g transform="translate(-14 -12)">${body}</g>${cloud(10, 22, .9, '#fff')}</svg>`;
      case 'cloudy': return `<svg class="home-wicon" viewBox="0 0 100 100">${cloud(-6, 4, .7, '#b0bec5')}${light}</svg>`;
      case 'fog': return `<svg class="home-wicon" viewBox="0 0 100 100">${cloud(4, 2, .9, '#eceff1')}<g class="fog" stroke="#eceff1" stroke-width="5" stroke-linecap="round"><line x1="18" y1="72" x2="82" y2="72"/><line x1="26" y1="84" x2="74" y2="84"/></g></svg>`;
      case 'rain': return `<svg class="home-wicon" viewBox="0 0 100 100">${dark}<g fill="#81D4FA">${[30, 48, 66].map((x, i) => `<path class="drop" style="animation-delay:${i * .35}s" d="M${x} 70q6 9 0 13q-6-4 0-13z"/>`).join('')}</g></svg>`;
      case 'snow': return `<svg class="home-wicon" viewBox="0 0 100 100">${light}<g fill="#fff">${[30, 50, 70].map((x, i) => `<circle class="flake" style="animation-delay:${i * .8}s" cx="${x}" cy="78" r="3.5"/>`).join('')}</g></svg>`;
      case 'storm': return `<svg class="home-wicon" viewBox="0 0 100 100">${cloud(4, 10, 1, '#90a4ae')}<path class="bolt" d="M52 66l-10 16h9l-5 14l16-20h-9l6-10z" fill="#FFEB3B"/><g fill="#81D4FA"><path class="drop" d="M30 72q6 9 0 13q-6-4 0-13z"/><path class="drop" style="animation-delay:.5s" d="M72 72q6 9 0 13q-6-4 0-13z"/></g></svg>`;
    }
    return '';
  },

  _homeUnit() { try { return localStorage.getItem('homeTempUnit') === 'F' ? 'F' : 'C'; } catch { return 'C'; } },
  _homeToggleUnit() {
    try { localStorage.setItem('homeTempUnit', this._homeUnit() === 'C' ? 'F' : 'C'); } catch {}
    this._homeWeather = null;
    this.renderHome();
  },

  async _homeLoadWeather() {
    // The user's default branch, or — with no branch, or one without a city
    // — the Drax Hall branch (weather_branch, set at login).
    const branches = this.currentUser.branches || [];
    const own = branches.find(x => x.is_default) || branches[0];
    const fb = this.currentUser.weather_branch;
    const b = own?.city ? own : fb ? { ...fb, city: fb.city || fb.name } : own;
    const city = String(b?.city || '').trim();
    if (!city) return { error: 'Add a city to your branch (Admin → Branches) to see the weather here.' };
    const unit = this._homeUnit();
    if (this._homeWeather && this._homeWeather.city === city && this._homeWeather.unit === unit && Date.now() - this._homeWeather.at < 15 * 60e3) return this._homeWeather;
    let place;
    // v2: earlier lookups could pick a same-named town abroad (Drax Hall, Barbados).
    const cacheKey = `homeGeo2:${city}|${b.state || ''}`;
    try { place = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch {}
    if (!place) {
      const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=en&format=json`).then(r => r.json());
      const results = g.results || [];
      if (!results.length) return { error: `Couldn't find "${city}" for the weather.` };
      // Same-named towns exist across countries (Drax Hall is in Jamaica and
      // Barbados), so rank: the branch's state/parish ("St. Ann" = "Saint Ann
      // Parish"), then the store's country (from its currency: JMD → JM),
      // then the geocoder's own order.
      const norm = v => String(v || '').toLowerCase().replace(/\bst\.?\s/g, 'saint ').replace(/\bparish\b/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
      const st = norm(b.state);
      const country = String(b.currency || this.settings?.currency || '').slice(0, 2).toUpperCase();
      const stateHit = r => st && [r.admin1, r.admin2, r.country].some(v => { const n = norm(v); return n && (n === st || n.includes(st) || st.includes(n)); });
      const score = r => (stateHit(r) ? 2 : 0) + (country && r.country_code === country ? 1 : 0);
      const hit = results.reduce((best, r) => score(r) > score(best) ? r : best, results[0]);
      place = { lat: hit.latitude, lon: hit.longitude, name: [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null, hit.country_code].filter(Boolean).join(', ') };
      try { localStorage.setItem(cacheKey, JSON.stringify(place)); } catch {}
    }
    const qs = new URLSearchParams({
      latitude: place.lat, longitude: place.lon, timezone: 'auto', forecast_days: '4',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,cloud_cover,precipitation',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,precipitation_sum,cloud_cover_mean',
      hourly: 'temperature_2m,weather_code,precipitation_probability,is_day,precipitation,cloud_cover', forecast_hours: '24',
      temperature_unit: unit === 'F' ? 'fahrenheit' : 'celsius', wind_speed_unit: unit === 'F' ? 'mph' : 'kmh',
    });
    const w = await fetch(`https://api.open-meteo.com/v1/forecast?${qs}`).then(r => r.json());
    if (!w.current) return { error: 'Weather is unavailable right now.' };
    this._homeDropTraceRain(w);
    this._homeWeather = { city, unit, at: Date.now(), place, w };
    return this._homeWeather;
  },

  // Sky for the moment: night / dawn / day / dusk from sunrise–sunset (or the
  // clock when there's no weather), greyed for overcast, darker for storms.
  _homeSkyClass(now, wx) {
    const kind = wx?.w ? this._homeKind(wx.w.current.weather_code) : null;
    let rise, set;
    if (wx?.w) { rise = new Date(wx.w.daily.sunrise[0]).getTime(); set = new Date(wx.w.daily.sunset[0]).getTime(); }
    else { rise = new Date(now).setHours(6, 15, 0, 0); set = new Date(now).setHours(18, 15, 0, 0); }
    const hr = 3600e3, t = now.getTime();
    let phase = t < rise - hr / 2 || t > set + hr / 2 ? 'night' : t < rise + hr ? 'dawn' : t > set - hr ? 'dusk' : 'day';
    // Grey only when the sky really is covered — a passing drizzle under a
    // mostly clear sky stays blue (its clouds and rain are drawn on top).
    const cover = wx?.w?.current?.cloud_cover ?? (kind === 'cloudy' ? 100 : 0);
    if (phase === 'day' && kind === 'storm') phase = 'storm';
    else if (phase === 'day' && (kind === 'cloudy' || kind === 'fog' || (['rain', 'snow'].includes(kind) && cover >= 60))) phase = 'grey';
    return phase;
  },

  async renderHome() {
    const c = document.getElementById('content');
    const u = this.currentUser;
    const links = Object.values(this._hubGroups).flatMap(h => h.children).filter((t, i, all) => all.findIndex(x => x.section === t.section) === i && this._hubTileAllowed(t.section)).slice(0, 8);
    c.innerHTML = `
      <div class="home-wrap">
        <div class="home-sky" id="home-sky">
          <div class="home-stars" id="home-stars"></div>
          <div class="home-flyers" id="home-flyers-far"></div>
          <div class="home-clouds" id="home-clouds"></div>
          <div class="home-flyers" id="home-flyers-near"></div>
          <div class="home-land">${this._homeLandscape()}</div>
          <div class="home-precip" id="home-precip"></div>
          <div class="home-greet" id="home-greet"></div>
          <div class="home-clock-row">
            <svg class="home-analog" viewBox="0 0 200 200" aria-hidden="true">
              <circle cx="100" cy="100" r="94" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.55)" stroke-width="3"/>
              ${Array.from({ length: 60 }, (_, i) => `<line x1="100" y1="${i % 5 ? 12 : 10}" x2="100" y2="${i % 5 ? 17 : 26}" stroke="rgba(255,255,255,${i % 5 ? .45 : .95})" stroke-width="${i % 5 ? 1.5 : 4}" stroke-linecap="round" transform="rotate(${i * 6} 100 100)"/>`).join('')}
              <line id="home-h" class="hand" x1="100" y1="104" x2="100" y2="54" stroke="#fff" stroke-width="7" stroke-linecap="round"/>
              <line id="home-m" class="hand" x1="100" y1="108" x2="100" y2="32" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>
              <line id="home-s" class="hand" x1="100" y1="118" x2="100" y2="24" stroke="#FFD54F" stroke-width="2" stroke-linecap="round"/>
              <circle cx="100" cy="100" r="6" fill="#FFD54F"/>
            </svg>
            <div>
              <div class="home-time" id="home-time"></div>
              <div class="home-date" id="home-date"></div>
              <div class="home-sub" id="home-sub"></div>
            </div>
          </div>
          <div class="home-weather-now" id="home-weather"><div style="opacity:.8">Loading the weather…</div></div>
          <div class="home-hours" id="home-hours"></div>
        </div>
        <div class="home-side">
          <div class="home-card" id="home-trf-late" style="display:none;border-left:4px solid var(--danger)"></div>
          <div class="home-card"><h3>Sun today</h3><div id="home-sun"><div style="color:var(--text-muted);font-size:13px">—</div></div></div>
          <div class="home-card"><h3>Next 3 days</h3><div id="home-forecast" class="home-forecast"><div style="color:var(--text-muted);font-size:13px;grid-column:1/-1">—</div></div></div>
          ${links.length ? `<div class="home-card"><h3>Go to</h3><div class="home-links">${links.map(t => `<div class="home-link" style="background:${t.color}" onclick="App.showSection('${t.section}')"><svg viewBox="0 0 24 24" fill="currentColor">${t.icon}</svg>${t.label}</div>`).join('')}</div></div>` : ''}
        </div>
      </div>`;
    this._paintHomeTransfersLate();
    const stars = document.getElementById('home-stars');
    stars.innerHTML = Array.from({ length: 40 }, (_, i) => `<i style="left:${(i * 37) % 100}%;top:${(i * 53) % 70}%;animation-delay:${(i % 7) * .4}s"></i>`).join('');

    let wx = null;
    const tick = () => {
      if (this.section !== 'home' || !document.getElementById('home-time')) { clearInterval(this._homeTimer); this._homeTimer = null; return; }
      const now = new Date();
      const h = now.getHours(), m = now.getMinutes(), sec = now.getSeconds();
      const t = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const [hm, ap] = t.split(' ');
      document.getElementById('home-time').innerHTML = `${hm}<small>${String(sec).padStart(2, '0')} ${ap || ''}</small>`;
      document.getElementById('home-date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const start = new Date(now.getFullYear(), 0, 1);
      const dayOfYear = Math.floor((now - start) / 864e5) + 1;
      const yearLen = (new Date(now.getFullYear() + 1, 0, 1) - start) / 864e5;
      const week = Math.ceil((dayOfYear + start.getDay()) / 7);
      document.getElementById('home-sub').textContent = `Day ${dayOfYear} of ${yearLen} · Week ${week}`;
      const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night';
      document.getElementById('home-greet').textContent = `${part}, ${u.first_name || ''}`;
      const sky = this._homeSkyClass(now, wx);
      document.getElementById('home-sky').className = `home-sky ${sky}`;
      stars.style.display = sky === 'night' ? '' : 'none';
      if (wx?.w && sec === 0) this._homePaintSun(wx.w, now);
    };
    // Hands sweep smoothly: positioned every animation frame from the exact
    // time (milliseconds included) rather than stepped once a second.
    const handH = document.getElementById('home-h'), handM = document.getElementById('home-m'), handS = document.getElementById('home-s');
    const sweep = () => {
      if (this.section !== 'home' || !handS.isConnected) return;
      const now = new Date();
      const secs = now.getSeconds() + now.getMilliseconds() / 1000;
      const mins = now.getMinutes() + secs / 60;
      const hrs = (now.getHours() % 12) + mins / 60;
      handS.style.transform = `rotate(${secs * 6}deg)`;
      handM.style.transform = `rotate(${mins * 6}deg)`;
      handH.style.transform = `rotate(${hrs * 30}deg)`;
      requestAnimationFrame(sweep);
    };
    requestAnimationFrame(sweep);
    this._homeStartFlyers();
    // Home is drawn straight after sign-in, often before GET /settings is
    // back: once it is, redraw the vehicles if the logo (or name) arrived.
    const drawnWith = `${this.settings?.company_logo_url || ''}|${this.settings?.store_name || ''}`;
    Promise.resolve(this._settingsReady).then(() => {
      const land = document.querySelector('#home-sky .home-land');
      if (this.section === 'home' && land && `${this.settings?.company_logo_url || ''}|${this.settings?.store_name || ''}` !== drawnWith) land.innerHTML = this._homeLandscape();
    });
    clearInterval(this._homeTimer);
    tick();
    this._homeTimer = setInterval(tick, 1000);

    try { wx = await this._homeLoadWeather(); } catch { wx = { error: 'Weather is unavailable right now.' }; }
    if (this.section !== 'home' || !document.getElementById('home-weather')) return;
    const el = document.getElementById('home-weather');
    if (wx.error) { el.innerHTML = `<div style="opacity:.85;font-size:14px">⛅ ${this.escapeAttr(wx.error)}</div>`; wx = null; tick(); return; }
    const cur = wx.w.current, unit = wx.unit, deg = `°${unit}`;
    this._homePaintSkyFx(cur);
    el.innerHTML = `
      ${this._homeWeatherSvg(this._homeKind(cur.weather_code), !!cur.is_day)}
      <div>
        <div class="home-temp">${Math.round(cur.temperature_2m)}<sup onclick="App._homeToggleUnit()" title="Switch to °${unit === 'C' ? 'F' : 'C'}">${deg}</sup></div>
        <div class="home-cond">${this._homeWeatherText[cur.weather_code] || ''} · ${this.escapeAttr(wx.place.name)}</div>
        <div class="home-meta"><span>Feels like ${Math.round(cur.apparent_temperature)}${deg}</span><span>💧 ${cur.relative_humidity_2m}%</span><span>💨 ${Math.round(cur.wind_speed_10m)} ${unit === 'F' ? 'mph' : 'km/h'}</span><span>H ${Math.round(wx.w.daily.temperature_2m_max[0])}° · L ${Math.round(wx.w.daily.temperature_2m_min[0])}°</span></div>
      </div>`;
    const hr = wx.w.hourly;
    if (hr?.time?.length) {
      // Every 2 hours across the next 16, the first one marked Now.
      document.getElementById('home-hours').innerHTML = [0, 2, 4, 6, 8, 10, 12, 14].filter(i => i < hr.time.length).map(i => `
        <div class="home-hour ${i === 0 ? 'now' : ''}">
          <div style="opacity:.85">${i === 0 ? 'Now' : new Date(hr.time[i]).toLocaleTimeString('en-US', { hour: 'numeric' })}</div>
          ${this._homeWeatherSvg(this._homeKind(hr.weather_code[i]), !!hr.is_day[i])}
          <b>${Math.round(hr.temperature_2m[i])}°</b>
          ${hr.precipitation_probability[i] >= 20 ? `<div style="opacity:.85">${hr.precipitation_probability[i]}%</div>` : ''}
        </div>`).join('');
    }
    const d = wx.w.daily;
    document.getElementById('home-forecast').innerHTML = [1, 2, 3].map(i => `
      <div class="home-day">
        <b>${new Date(d.time[i] + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</b>
        ${this._homeWeatherSvg(this._homeKind(d.weather_code[i]), true)}
        <div style="font-weight:700">${Math.round(d.temperature_2m_max[i])}° <span>${Math.round(d.temperature_2m_min[i])}°</span></div>
        <span style="font-size:11px">${this._homeWeatherText[d.weather_code[i]] || ''}${d.precipitation_probability_max?.[i] ? ` · ${d.precipitation_probability_max[i]}%` : ''}</span>
      </div>`).join('');
    this._homePaintSun(wx.w, new Date());
    tick();
  },

  // Background scene for Home: hills, a two-lane road and heavy equipment —
  // a dump truck, excavator and bulldozer heading right in the near lane, a
  // cement mixer and pipe flatbed heading left in the far one. Wheels and
  // tracks turn, the excavator digs, the mixer drum spins; headlights come on
  // at night (CSS). Drawn facing right; the far lane is mirrored.
  _homeLandscape() {
    const wheel = (cx, cy, r) => `<g class="wh" style="transform-origin:${cx}px ${cy}px"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#212121"/><circle cx="${cx}" cy="${cy}" r="${r * .5}" fill="#9E9E9E"/><path d="M${cx - r * .5} ${cy}h${r}M${cx} ${cy - r * .5}v${r}" stroke="#616161" stroke-width="1.6"/></g>`;
    const track = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#263238"/><rect class="trk" x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${h - 3}" rx="${(h - 3) / 2}" fill="none" stroke="#78909C" stroke-width="2.5" stroke-dasharray="4 4"/>${[0, 1, 2, 3].map(i => `<circle cx="${x + h / 2 + i * (w - h) / 3}" cy="${y + h / 2}" r="${h * .28}" fill="#546E7A"/>`).join('')}`;
    const dust = (x, y) => `<g class="dust">${[0, .35, .7].map(d => `<circle cx="${x}" cy="${y}" r="5" fill="rgba(210,190,160,.8)" style="animation-delay:${d}s"/>`).join('')}</g>`;
    const beam = (x, y) => `<path class="beam" d="M${x} ${y}l46 -9v20z" fill="rgba(255,241,150,.32)"/><circle cx="${x}" cy="${y}" r="2.4" fill="#FFF59D"/>`;
    const Y = '#F9A825', Y2 = '#FBC02D', DK = '#37474F', GL = '#B3E5FC';
    // The company logo (Settings → company_logo_url) on a white panel on each
    // vehicle's side, else the store name. Far-lane vehicles are drawn
    // mirrored, so their panel is flipped back to read the right way.
    const logoUrl = this.settings?.company_logo_url;
    const logoSrc = logoUrl ? this.escapeAttr(/^https?:\/\//.test(logoUrl) ? logoUrl : `${location.origin}${logoUrl}`) : '';
    const storeName = this.escapeAttr(this.settings?.store_name || '');
    const logo = (x, y, w, h, flip = false, rot = '') => {
      if (!logoSrc && !storeName) return '';
      const inner = logoSrc
        ? `<image href="${logoSrc}" x="${x + 1.5}" y="${y + 1.2}" width="${w - 3}" height="${h - 2.4}" preserveAspectRatio="xMidYMid meet"/>`
        : `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-weight="700" font-size="${Math.min(h * .55, w / Math.max(4, storeName.length) * 1.7)}" fill="#263238">${storeName}</text>`;
      return `<g class="logo"${flip || rot ? ` transform="${rot}${flip ? ` translate(${2 * x + w} 0) scale(-1 1)` : ''}"` : ''}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="#fff" opacity=".93"/>${inner}</g>`;
    };
    const dump = `<svg viewBox="0 0 140 70">${dust(10, 58)}<g class="body">
      <path d="M6 20h78l-4 28H10z" fill="${Y}" stroke="#E65100" stroke-width="1.5"/><path d="M14 22v24M76 22v24" stroke="#F57F17" stroke-width="1.5"/>${logo(18, 24, 54, 20)}
      <rect x="4" y="46" width="122" height="7" rx="2" fill="${DK}"/>
      <path d="M86 48V24h22l14 15v9z" fill="${Y2}" stroke="#E65100" stroke-width="1.5"/><path d="M92 28h14l9 10H92z" fill="${GL}"/>${beam(122, 43)}</g>
      ${wheel(24, 56, 10)}${wheel(48, 56, 10)}${wheel(108, 56, 10)}</svg>`;
    const excavator = `<svg viewBox="0 0 150 80">${dust(8, 70)}${track(8, 60, 84, 16)}<g class="body">
      <rect x="16" y="40" width="62" height="20" rx="3" fill="${Y}"/><rect x="10" y="44" width="12" height="14" rx="2" fill="${DK}"/>${logo(24, 44, 46, 13)}
      <rect x="48" y="20" width="24" height="22" rx="3" fill="${Y2}"/><rect x="53" y="24" width="15" height="12" rx="2" fill="${GL}"/>
      <g class="arm" style="transform-origin:74px 44px"><path d="M74 44L110 16" stroke="${Y}" stroke-width="9" stroke-linecap="round"/><path d="M110 16L130 46" stroke="${Y2}" stroke-width="7" stroke-linecap="round"/>
        <path d="M124 42h16l-3 14h-12z" fill="#455A64"/></g>${beam(78, 50)}</g></svg>`;
    const dozer = `<svg viewBox="0 0 130 70">${dust(10, 60)}${track(12, 50, 74, 16)}<g class="body">
      <rect x="18" y="32" width="62" height="20" rx="3" fill="${Y}"/><path d="M30 32V12h28v20" fill="none" stroke="${DK}" stroke-width="3"/><rect x="33" y="15" width="22" height="15" fill="${GL}" opacity=".85"/>${logo(22, 35, 54, 14)}
      <path d="M80 44l18 -4" stroke="${DK}" stroke-width="4"/><path d="M98 24q8 16 0 40h8V24z" fill="#FFB300" stroke="#E65100" stroke-width="1.5"/>${beam(81, 38)}</g></svg>`;
    const mixer = `<svg viewBox="0 0 150 72"><g class="body"><rect x="6" y="48" width="132" height="7" rx="2" fill="${DK}"/>
      <g transform="rotate(-12 64 32)"><ellipse cx="64" cy="32" rx="38" ry="18" fill="#ECEFF1" stroke="#90A4AE" stroke-width="1.5"/><ellipse class="drum" cx="64" cy="32" rx="30" ry="12" fill="none" stroke="#FB8C00" stroke-width="5" stroke-dasharray="10 10"/></g>${logo(42, 24, 44, 15, true, 'rotate(-12 64 32)')}
      <path d="M106 50V24h20l12 14v12z" fill="#1E88E5" stroke="#0D47A1" stroke-width="1.5"/><path d="M111 28h14l8 10h-22z" fill="${GL}"/>${beam(137, 44)}</g>
      ${wheel(26, 58, 10)}${wheel(50, 58, 10)}${wheel(122, 58, 10)}</svg>`;
    const flatbed = `<svg viewBox="0 0 150 72"><g class="body"><rect x="4" y="44" width="104" height="6" fill="#8D6E63"/>
      ${[0, 1, 2].map(i => `<rect x="10" y="${30 - i * 0}" width="90" height="7" rx="3.5" fill="#B0BEC5" transform="translate(0 ${-i * 7 + 6})"/>`).join('')}
      <rect x="4" y="48" width="134" height="6" rx="2" fill="${DK}"/><path d="M108 50V22h18l12 14v14z" fill="#E53935" stroke="#B71C1C" stroke-width="1.5"/><path d="M113 26h12l8 10h-20z" fill="${GL}"/>${logo(110, 37, 22, 10, true)}${beam(137, 44)}</g>
      ${wheel(22, 58, 9)}${wheel(44, 58, 9)}${wheel(122, 58, 9)}</svg>`;
    const near = [[dump, 0], [excavator, -11], [dozer, -22]];
    const far = [[mixer, -6], [flatbed, -28]];
    return `
      <svg viewBox="0 0 1000 330" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 150 C 90 70 180 90 260 120 S 420 60 520 100 S 700 70 800 110 S 940 80 1000 100 V 330 H 0 Z" fill="var(--hill-far)"/>
        <path d="M0 175 C 120 120 230 150 330 140 S 520 110 640 145 S 860 120 1000 140 V 330 H 0 Z" fill="var(--hill-near)"/>
        ${[[70, 128], [150, 132], [380, 126], [610, 132], [690, 136], [880, 128], [930, 130]].map(([x, y]) => `<path d="M${x} ${y}l7 -20l7 20z" fill="var(--hill-near)"/><rect x="${x + 6}" y="${y}" width="2" height="5" fill="var(--hill-near)"/>`).join('')}
        <rect x="0" y="138" width="1000" height="34" fill="var(--road)"/>
        <path d="M0 155 H1000" stroke="rgba(255,213,79,.7)" stroke-width="2" stroke-dasharray="22 18"/>
        <path d="M0 139 H1000 M0 171 H1000" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>
        <rect x="0" y="172" width="1000" height="158" fill="var(--ground)"/>
      </svg>
      ${far.map(([v, d]) => `<div class="home-veh far" style="animation-delay:${d}s">${v}</div>`).join('')}
      ${near.map(([v, d]) => `<div class="home-veh near" style="animation-delay:${d}s">${v}</div>`).join('')}`;
  },

  // Birds and planes crossing the sky now and then, each at a random
  // distance: far ones small, faint and slow, behind the clouds; near ones
  // bigger and quicker, in front. No birds at night or in a storm.
  _homeStartFlyers() {
    clearTimeout(this._homeFlyerTimer);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const loop = () => {
      if (this.section !== 'home' || !document.getElementById('home-sky')) { this._homeFlyerTimer = null; return; }
      this._homeSpawnFlyer();
      this._homeFlyerTimer = setTimeout(loop, 2500 + Math.random() * 8000);
    };
    this._homeFlyerTimer = setTimeout(loop, 600);
  },

  _homeSpawnFlyer(kind) {
    const sky = document.getElementById('home-sky');
    const far = document.getElementById('home-flyers-far'), near = document.getElementById('home-flyers-near');
    if (!sky || !far || !near || far.childElementCount + near.childElementCount >= 6) return null;
    const night = sky.classList.contains('night'), storm = sky.classList.contains('storm');
    const birdsOk = !night && !storm;
    if (!kind) {
      const r = Math.random();
      kind = birdsOk && r < .25 ? 'flock' : birdsOk && r < .5 ? 'bird' : r < .7 ? 'airliner' : r < .85 ? 'jet' : storm ? 'airliner' : 'prop';
    }
    const d = kind === 'jet' ? .05 + Math.random() * .2 : Math.random(); // 0 = far away, 1 = close
    const W = sky.clientWidth, H = sky.clientHeight;
    const { svg, w, h, speed } = this._homeFlyerSvg(kind, night, d);
    const scale = .3 + d * .9;
    const el = document.createElement('div');
    el.className = `home-flyer ${kind}`;
    el.style.cssText = `width:${w * scale}px;height:${h * scale}px;top:${H * (.03 + Math.random() * .38)}px;opacity:${(.4 + d * .6).toFixed(2)};${d < .45 ? `filter:blur(${((.45 - d) * 1.6).toFixed(2)}px)` : ''}`;
    const dir = Math.random() < .5 ? 1 : -1;
    el.innerHTML = `<div class="fx" style="${dir < 0 ? 'transform:scaleX(-1)' : ''}">${svg}</div>`;
    (d < .45 ? far : near).appendChild(el);
    const span = W + w * scale * 2, from = dir > 0 ? -w * scale - 10 : W + 10, to = from + dir * span;
    const climb = (Math.random() - .5) * 60 * (.3 + d);
    const anim = el.animate([{ transform: `translate(${from}px, 0)` }, { transform: `translate(${to}px, ${climb}px)` }], { duration: span / speed * 1000, easing: 'linear' });
    anim.onfinish = () => el.remove();
    return el;
  },

  // One bird (40×20 box, body at 20,10) whose outline morphs through the
  // wingbeat: a quick downstroke with the wings spread, a slower upstroke
  // with them bent at the wrist, the body rising and dipping against the
  // wings. Some flap steadily, others (gull-like) flap a few times and
  // glide; each has its own pace and starts at a random point.
  _homeBirdSvg(fill) {
    const pose = (wy, ty, tx) => {
      const L = (dx, dy) => `${(20 - dx).toFixed(1)} ${(10 + dy).toFixed(1)}`, R = (dx, dy) => `${(20 + dx).toFixed(1)} ${(10 + dy).toFixed(1)}`;
      const lx = (tx + 8.5) / 2, ly = (ty + wy) / 2 - 1.1; // leading edge, wrist → tip
      const trx = (tx + 8.5) / 2 - 1.5, tr = Math.max(ty, wy) + 1.6; // trailing edge
      return `M${L(tx, ty)}Q${L(lx, ly)} ${L(8.5, wy)}Q${L(4, wy * .35 - .8)} ${L(2.2, -.9)}Q20 7.6 ${R(2.2, -.9)}`
        + `Q${R(4, wy * .35 - .8)} ${R(8.5, wy)}Q${R(lx, ly)} ${R(tx, ty)}`
        + `Q${R(trx, tr)} ${R(2.4, 1.2)}Q20 13.4 ${L(2.4, 1.2)}Q${L(trx, tr)} ${L(tx, ty)}Z`;
    };
    // Top of the stroke (spread high), bottom (spread low), the upstroke with
    // the hand folded below the raised wrist, and level for gliding.
    const shapes = { up: pose(-5.5, -9.5, 14), down: pose(3, 7, 15.5), fold: pose(-4.5, -.5, 11), glide: pose(-.6, .4, 17.5) };
    const bob = { up: .9, down: -1.1, fold: .2, glide: 0 };
    const beat = .28 + Math.random() * .22; // seconds per wingbeat
    const steps = [['up', 0]];
    const flap = () => { steps.push(['down', beat * .4], ['fold', beat * .32], ['up', beat * .28]); };
    if (Math.random() < .45) for (let i = 0; i < 4; i++) flap(); // steady flapper
    else {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) flap();
      steps.push(['glide', beat * .6], ['glide', 1.2 + Math.random() * 2.2], ['up', beat * .5]);
    }
    const dur = steps.reduce((t, [, s]) => t + s, 0);
    let t = 0;
    const times = steps.map(([, s]) => (t += s) / dur).map((v, i) => (i === 0 ? 0 : v).toFixed(4));
    times[times.length - 1] = '1';
    const splines = steps.slice(1).map(() => '.45 0 .55 1').join(';');
    const begin = `-${(Math.random() * dur).toFixed(2)}s`;
    const anim = (attr, vals) => `<animate attributeName="${attr}" dur="${dur.toFixed(2)}s" begin="${begin}" repeatCount="indefinite" calcMode="spline" keyTimes="${times.join(';')}" keySplines="${splines}" values="${vals}"/>`;
    return `<g><animateTransform attributeName="transform" type="translate" dur="${dur.toFixed(2)}s" begin="${begin}" repeatCount="indefinite" calcMode="spline" keyTimes="${times.join(';')}" keySplines="${splines}" values="${steps.map(([p]) => `0 ${bob[p]}`).join(';')}"/>
      <path d="${shapes.up}" fill="${fill}">${anim('d', steps.map(([p]) => shapes[p]).join(';'))}</path></g>`;
  },

  // Facing right; flipped by the caller to fly left. speed is px/s at d (0–1).
  _homeFlyerSvg(kind, night, d) {
    const bird = (x, y, sc = 1) => `<g transform="translate(${x} ${y}) scale(${sc})">${this._homeBirdSvg(night ? '#1b1f2a' : '#263238')}</g>`;
    const body = night ? '#7b8794' : '#f5f7fa', tail = ['#c62828', '#1565c0', '#2e7d32', '#ef6c00'][Math.floor(Math.random() * 4)];
    const lights = (x1, y1, x2, y2) => `<circle class="strobe" cx="${x1}" cy="${y1}" r="1.6" fill="#fff"/><circle class="beacon" cx="${x2}" cy="${y2}" r="1.5" fill="#ff1744"/>`;
    if (kind === 'bird') return { w: 34, h: 22, speed: 35 + d * 110, svg: `<svg viewBox="0 0 40 26">${bird(0, 3)}</svg>` };
    if (kind === 'flock') {
      const n = 3 + Math.floor(Math.random() * 5);
      const pts = Array.from({ length: n }, (_, i) => { const k = Math.ceil(i / 2); return [64 - k * 14, 26 + (i % 2 ? -1 : 1) * k * 7]; });
      return { w: 96, h: 70, speed: 30 + d * 90, svg: `<svg viewBox="0 0 96 70">${pts.map(([x, y]) => bird(x - 4, y - 8, .7 + Math.random() * .12)).join('')}</svg>` };
    }
    if (kind === 'airliner') return { w: 120, h: 38, speed: 40 + d * 150, svg: `<svg viewBox="0 0 120 38">
      <path d="M10 15L4 2h10l12 13z" fill="${tail}"/>
      <path d="M6 19l-4 3h16l2-3z" fill="#b0bec5"/>
      <path d="M8 20q-4-4 4-5h88q16 0 18 5q-2 5-18 5H12q-8-1-4-5z" fill="${body}"/>
      <path d="M52 22L40 34h8l24-12z" fill="#b0bec5"/><rect x="45" y="26" width="12" height="5" rx="2.5" fill="#90a4ae"/>
      ${Array.from({ length: 17 }, (_, i) => `<rect x="${30 + i * 4}" y="17.6" width="1.8" height="1.8" rx=".5" fill="${night ? '#ffe082' : '#546e7a'}"/>`).join('')}
      <path d="M108 17q5 0 7 2h-7z" fill="#37474f"/>${lights(5, 3, 62, 25.5)}</svg>` };
    if (kind === 'prop') return { w: 70, h: 30, speed: 30 + d * 90, svg: `<svg viewBox="0 0 70 30">
      <path d="M6 15L3 4h7l8 8z" fill="${tail}"/>
      <path d="M6 15q2-4 14-4h32q8 0 10 4q-2 4-10 4H20q-12 0-14-4z" fill="${body}"/>
      <rect x="26" y="8" width="22" height="3" rx="1.5" fill="${tail}"/>
      <path d="M42 12h8q4 0 5 3H42z" fill="${night ? '#ffe082' : '#4fc3f7'}" opacity=".85"/>
      <path d="M40 19l-2 6M48 19l2 6" stroke="#455a64" stroke-width="1.2"/><circle cx="38" cy="26" r="1.6" fill="#263238"/><circle cx="50" cy="26" r="1.6" fill="#263238"/>
      <rect class="prop" x="62.5" y="6" width="2" height="18" rx="1" fill="#455a64"/>${lights(4, 4, 30, 9)}</svg>` };
    return { w: 60, h: 14, speed: 18 + d * 40, svg: `<span class="trail"></span><svg viewBox="0 0 60 14">
      <path d="M3 5L1 0h5l4 5z" fill="${night ? '#7b8794' : '#eceff1'}"/>
      <path d="M2 7q0-2 4-2h46q6 0 8 2q-2 2-8 2H6q-4 0-4-2z" fill="${night ? '#7b8794' : '#eceff1'}"/>
      <path d="M26 7l-8 6h4l14-6z" fill="#cfd8dc"/>${lights(2, 1, 30, 9)}</svg>` };
  },

  // Drifting clouds (as many as the cloud cover) and falling rain or snow
  // (heavier codes, more drops) over the sky.
  _homePaintSkyFx(cur) {
    const kind = this._homeKind(cur.weather_code);
    const cover = cur.cloud_cover ?? ({ clear: 0, partly: 40, cloudy: 90, fog: 80 }[kind] ?? 70);
    const clouds = Math.round(cover / 12);
    const cl = document.getElementById('home-clouds');
    if (cl) cl.innerHTML = Array.from({ length: clouds }, (_, i) => {
      const dur = 70 + (i * 23) % 60;
      return `<span style="top:${(i * 29) % 75}%;height:${50 + (i * 17) % 50}px;opacity:${.35 + (i % 4) * .15};animation-duration:${dur}s;animation-delay:-${(i * 37) % dur}s"></span>`;
    }).join('');
    const pr = document.getElementById('home-precip');
    if (!pr) return;
    const code = cur.weather_code;
    const drops = kind === 'snow' ? 40 : kind === 'storm' ? 110 : kind === 'rain' ? ([51, 56, 61, 80].includes(code) ? 30 : [53, 63, 66, 81].includes(code) ? 70 : 110) : 0;
    pr.className = `home-precip${kind === 'snow' ? ' snow' : ''}`;
    pr.innerHTML = Array.from({ length: drops }, (_, i) =>
      `<i style="left:${(i * 47) % 105}%;animation-duration:${kind === 'snow' ? 6 + (i % 5) : .7 + (i % 5) * .12}s;animation-delay:-${(i * 0.37) % 6}s"></i>`).join('');
  },

  // Sunrise → sunset arc with the sun (or moon, after dark) where it is now.
  _homePaintSun(w, now) {
    const box = document.getElementById('home-sun');
    if (!box) return;
    const rise = new Date(w.daily.sunrise[0]), set = new Date(w.daily.sunset[0]);
    const f = Math.min(1, Math.max(0, (now - rise) / (set - rise)));
    const up = now >= rise && now <= set;
    const a = Math.PI * (1 - f), cx = 150 + 120 * Math.cos(a), cy = 120 - 100 * Math.sin(a);
    const fmt = t => t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const len = set - rise, hrs = Math.floor(len / 3600e3), mins = Math.round(len % 3600e3 / 60e3);
    const left = up ? set - now : now < rise ? rise - now : null;
    box.innerHTML = `
      <svg class="home-sunarc" viewBox="0 0 300 150">
        <defs><linearGradient id="home-arc" x1="0" x2="1"><stop offset="0" stop-color="#FFB74D"/><stop offset=".5" stop-color="#FFD54F"/><stop offset="1" stop-color="#FF8A65"/></linearGradient></defs>
        <line x1="14" y1="120" x2="286" y2="120" stroke="var(--border)" stroke-width="2"/>
        <path d="M30 120 A120 100 0 0 1 270 120" fill="none" stroke="var(--border)" stroke-width="3" stroke-dasharray="4 6"/>
        ${up ? `<path d="M30 120 A120 100 0 0 1 ${cx.toFixed(1)} ${cy.toFixed(1)}" fill="none" stroke="url(#home-arc)" stroke-width="4" stroke-linecap="round"/>` : ''}
        ${up ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="16" fill="#FFD54F" opacity=".25"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="#FFC107"/>`
          : `<path d="M154 70a14 14 0 1 0 8 20a11 11 0 1 1-8-20z" fill="#9FA8DA"/>`}
        <text x="30" y="142" text-anchor="middle" font-size="12" fill="var(--text-muted)">↑ ${fmt(rise)}</text>
        <text x="270" y="142" text-anchor="middle" font-size="12" fill="var(--text-muted)">↓ ${fmt(set)}</text>
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-muted);margin-top:4px">
        <span>${hrs}h ${mins}m of daylight</span>
        <span>${left == null ? 'The sun has set' : `${up ? 'Sunset' : 'Sunrise'} in ${Math.floor(left / 3600e3)}h ${Math.round(left % 3600e3 / 60e3)}m`}</span>
      </div>`;
  },

});
