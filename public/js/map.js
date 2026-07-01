let map, addMarker;
const IS_LOGGED = document.body && document.body.dataset && document.body.dataset.isLogged === 'true';

document.addEventListener('DOMContentLoaded', () => {
  map = L.map('map', { maxZoom: 19 }).setView([48.8566, 2.3522], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  // Restaure la position depuis le hash ou le localStorage
  const hash = location.hash.match(/^#map=(\d+\.?\d*)\/(-?\d+\.?\d*)\/(-?\d+\.?\d*)$/);
  if (hash) {
    map.setView([parseFloat(hash[2]), parseFloat(hash[3])], parseInt(hash[1]));
  } else {
    const saved = localStorage.getItem('mapView');
    if (saved) {
      const { lat, lng, zoom } = JSON.parse(saved);
      map.setView([lat, lng], zoom);
    }
  }

  map.on('moveend', () => {
    const c = map.getCenter();
    const z = map.getZoom();
    const hash = `#map=${z}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
    history.replaceState(null, '', hash);
    localStorage.setItem('mapView', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: z }));
  });

  // Si l'URL est /wifi/:id (ex: après actualisation), ouvrir le modal sur PC
  const wifiMatch = location.pathname.match(/^\/wifi\/(\d+)$/);
  if (wifiMatch && window.innerWidth >= 768) {
    loadWifi().then(() => openWifiModal(wifiMatch[1]));
  } else {
    loadWifi();
  }

  setTimeout(() => {
    const zoom = document.querySelector('.leaflet-control-zoom');
    if (zoom) {
      // Bouton locate
      const locateBtn = document.createElement('a');
      locateBtn.className = 'control-button control-button-last';
      locateBtn.href = '#';
      locateBtn.role = 'button';
      locateBtn.setAttribute('aria-label', 'Afficher mon emplacement');
      locateBtn.innerHTML = '<i class="fs-5 bi bi-cursor-fill"></i>';
      locateBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true });
      });
      zoom.appendChild(locateBtn);

      // Bouton recherche
      const searchBtn = document.createElement('a');
      searchBtn.className = 'control-button control-button-last';
      searchBtn.href = '#';
      searchBtn.role = 'button';
      searchBtn.setAttribute('aria-label', 'Rechercher un lieu');
      searchBtn.innerHTML = '<i class="fs-5 bi bi-search"></i>';
      searchBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('search-bar').classList.toggle('open');
        document.getElementById('search-input').focus();
      });
      zoom.appendChild(searchBtn);
    }
  }, 0);

  if (IS_LOGGED) {
    map.on('click', e => {
      const { lat, lng } = e.latlng;
      L.popup()
        .setLatLng(e.latlng)
        .setContent(`
          <div style="display:flex;flex-direction:column;gap:.5rem;min-width:160px">
            <a href="/wifi/add?lat=${lat}&lng=${lng}" class="btn-primary" style="justify-content:center">➕ Créer un réseau</a>
            <button type="button" data-copy-coords="${lat.toFixed(6)}, ${lng.toFixed(6)}" class="btn-secondary copy-coords-btn" style="justify-content:center">📋 Copier les coordonnées</button>
          </div>
        `)
        .openOn(map);
    });
  }

  map.on('locationfound', e => {
    if (window._locateMarker) window._locateMarker.remove();
    window._locateMarker = L.circleMarker(e.latlng, {
      radius: 10,
      fillColor: '#3b82f6',
      fillOpacity: 1,
      color: '#fff',
      weight: 3
    }).addTo(map);
  });

  map.on('locationerror', e => {
    const s = document.createElement('div');
    s.className = 'snackbar';
    s.textContent = 'Localisation échouée : ' + e.message;
    document.body.appendChild(s);
    setTimeout(() => s.classList.add('snackbar-show'), 10);
    setTimeout(() => { s.classList.remove('snackbar-show'); setTimeout(() => s.remove(), 300); }, 4000);
  });

  document.getElementById('wifi-modal-close-btn').addEventListener('click', closeWifiModal);

  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });

  // Recherche
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    if (!q) { searchResults.innerHTML = ''; return; }
    // Coordonnées directes
    const coords = q.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
    if (coords) {
      searchResults.innerHTML = `<div class="search-result" data-lat="${coords[1]}" data-lng="${coords[2]}">📍 ${coords[1]}, ${coords[2]}</div>`;
      return;
    }
    searchTimeout = setTimeout(async () => {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`);
      const data = await r.json();
      searchResults.innerHTML = data.map(d =>
        `<div class="search-result" data-lat="${d.lat}" data-lng="${d.lon}">${d.display_name}</div>`
      ).join('') || '<div class="search-result-empty">Aucun résultat</div>';
    }, 400);
  });

  document.addEventListener('click', e => {
    // Modal wifi sur PC
    const detailLink = e.target.closest('.wifi-detail-link');
    if (detailLink && window.innerWidth >= 768) {
      e.preventDefault();
      const id = detailLink.dataset.id;
      openWifiModal(id);
      return;
    }

    const copyButton = e.target.closest('[data-copy-coords]');
    if (copyButton) {
      const coords = copyButton.dataset.copyCoords;
      navigator.clipboard.writeText(coords).then(() => {
        copyButton.textContent = '✅ Copié !';
      });
      return;
    }

    const searchResult = e.target.closest('.search-result');
    if (searchResult && searchResults.contains(searchResult)) {
      const lat = parseFloat(searchResult.dataset.lat);
      const lng = parseFloat(searchResult.dataset.lng);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        goTo(lat, lng);
      }
      return;
    }

    if (!e.target.closest('#search-bar')) {
      searchResults.innerHTML = '';
      document.getElementById('search-bar').classList.remove('open');
    }
  });
});

window.loadWifi = async function () {
  const r = await fetch('/api/wifi');
  const geojson = await r.json();
  if (window._wifiLayer) map.removeLayer(window._wifiLayer);

  const cluster = L.markerClusterGroup({
    iconCreateFunction: c => {
      const count = c.getChildCount();
      return L.divIcon({
        html: `<div class="cluster-icon">${count}</div>`,
        className: '',
        iconSize: [38, 38],
        iconAnchor: [19, 19]
      });
    }
  });

  L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => {
      const p = feature.properties;
      const { color, emoji } = getMarkerStyle(parseFloat(p.confidence_score));
      const icon = L.divIcon({
        html: `<div class="wifi-marker" style="background:${color}">${emoji}</div>`,
        className: '',
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      });
      return L.marker(latlng, { icon });
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      const { color } = getMarkerStyle(parseFloat(p.confidence_score));
      layer.bindPopup(`
        <div class="popup-content">
          <strong>📶 ${p.ssid}</strong>
          <div style="color:${color};font-weight:bold">Score : ${p.confidence_score}%</div>
          <div>🔒 ${p.encryption.toUpperCase()}</div>
          ${p.place_type ? `<div>🏢 ${p.place_type}</div>` : ''}
          ${p.isp ? `<div>🌍 ${p.isp}</div>` : ''}
          <a href="/wifi/${p.id}" class="btn-primary wifi-detail-link" data-id="${p.id}" style="margin-top:.5rem;display:inline-block">Voir les détails</a>
        </div>
      `);
    }
  }).addTo(cluster);

  window._wifiLayer = cluster;
  map.addLayer(cluster);
};

function getMarkerStyle(score) {
  if (score >= 80) return { color: '#2ecc71', emoji: 'ᯤ' };
  if (score >= 60) return { color: '#f1c40f', emoji: 'ᯤ' };
  if (score >= 35) return { color: '#e67e22', emoji: 'ᯤ' };
  return { color: '#e74c3c', emoji: 'ᯤ' };
}

window.goTo = function(lat, lng) {
  map.setView([lat, lng], 17);
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-bar').classList.remove('open');
  document.getElementById('search-input').value = '';
};

window.closeModal = function (id) {
  document.getElementById(id).classList.add('hidden');
};

function paginateList(containerId, paginationId, perPage) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = Array.from(container.children);
  if (items.length <= perPage) return;
  let page = 0;
  const pages = Math.ceil(items.length / perPage);
  function render() {
    items.forEach((el, i) => el.style.display = (i >= page * perPage && i < (page + 1) * perPage) ? '' : 'none');
    const nav = document.getElementById(paginationId);
    nav.innerHTML = '';
    for (let i = 0; i < pages; i++) {
      const btn = document.createElement('button');
      btn.textContent = i + 1;
      btn.className = 'pagination-btn' + (i === page ? ' active' : '');
      btn.onclick = () => { page = i; render(); };
      nav.appendChild(btn);
    }
  }
  render();
}

function buildDiffRows(snapshot) {
  if (!snapshot?.before || !snapshot?.after) return [];
  const fields = ['ssid','password','encryption','captive_portal','gateway','dhcp_range','isp','place_type','hours','download_mbps','upload_mbps','ping_ms'];
  return fields.map(field => {
    const norm = v => (v === '1' || v === 1 || v === true) ? true : (!v && v !== 0) ? null : v;
    const fmt = v => v === null ? '•' : v === true ? 'Oui' : v === false ? 'Non' : String(v);
    const oldVal = norm(snapshot.before[field]);
    const newVal = norm(snapshot.after[field]);
    const oldText = fmt(oldVal);
    const newText = fmt(newVal);
    if (oldText === newText) return null;
    const kind = oldVal === null ? 'added' : newVal === null ? 'removed' : 'changed';
    return { field, oldText, newText, kind };
  }).filter(Boolean);
}

function renderHistoryEntry(entry) {
  let snap = null;
  try { snap = entry.snapshot ? JSON.parse(entry.snapshot) : null; } catch {}
  const diffs = buildDiffRows(snap);
  const kind = entry.action.includes('✅') ? 'success'
    : entry.action.includes('❌') || entry.action.includes('Ne fonctionne') ? 'danger'
    : entry.action.includes('📶') ? 'info' : 'neutral';
  const diffsHtml = diffs.length ? `<div class="history-diff">${diffs.map(d =>
    `<div class="history-change ${d.kind}">
      <span class="history-field-name">${d.field}</span>
      <div style="display:flex;flex-direction:column;gap:.2rem;margin-top:.2rem">
        <span class="history-old">${d.oldText}</span>
        <span class="history-new">${d.newText}</span>
      </div>
    </div>`
  ).join('')}</div>` : '';
  return `<li class="history-entry history-entry--${kind}">
    <div class="history-bullet"></div>
    <div class="history-main">
      <div class="history-header">
        <div class="history-meta"><strong>${entry.username}</strong><span class="history-action">${entry.action}</span></div>
        <small>${new Date(entry.created_at).toLocaleDateString('fr-FR')}</small>
      </div>
      ${diffsHtml}
    </div>
  </li>`;
}

window.openWifiModal = async function(id) {
  const modal = document.getElementById('wifi-modal');
  const body = document.getElementById('wifi-modal-body');
  const title = document.getElementById('wifi-modal-title');
  modal.classList.remove('hidden');
  body.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted)">Chargement…</div>';
  history.pushState({ wifiModal: id }, '', `/wifi/${id}`);
  try {
    const r = await fetch(`/wifi/${id}/json`);
    const data = await r.json();
    const { wifi, stats, comments } = data;
    const hist = data.history;
    title.textContent = `📶 ${wifi.ssid}`;
    const scoreColor = wifi.confidence_score >= 80 ? '#2ecc71' : wifi.confidence_score >= 60 ? '#f1c40f' : wifi.confidence_score >= 35 ? '#e67e22' : '#e74c3c';

    const infoCard = `<div class="detail-card">
      <h3>Réseau</h3>
      <p>Chiffrement : <strong>${wifi.encryption.toUpperCase()}</strong></p>
      ${wifi.password ? `<p>Mot de passe : <code class="pwd-reveal">${wifi.password}</code></p>` : ''}
      <p>Captive portal : <strong>${wifi.captive_portal ? 'Oui' : 'Non'}</strong></p>
      ${wifi.gateway ? `<p>Passerelle : <code>${wifi.gateway}</code></p>` : ''}
      ${wifi.dhcp_range ? `<p>DHCP : <code>${wifi.dhcp_range}</code></p>` : ''}
      ${wifi.isp ? `<p>FAI : <strong>${wifi.isp}</strong></p>` : ''}
      ${wifi.place_type ? `<p>Lieu : <strong>${wifi.place_type}</strong></p>` : ''}
      ${wifi.hours ? `<p>Horaires : <strong>${wifi.hours}</strong></p>` : ''}
      ${wifi.author_name ? `<p>Ajouté par : <strong>${wifi.author_name}</strong></p>` : ''}
      ${wifi.last_verified ? `<p style="color:var(--text-muted);font-size:.8rem">Vérifié le ${new Date(wifi.last_verified).toLocaleDateString('fr-FR')}</p>` : ''}
    </div>`;

    const perfCard = `<div class="detail-card" style="margin-top:.75rem">
      <h3>Performances</h3>
      ${stats.avg_download ? `<p>Descendant : <strong>${stats.avg_download} Mbps</strong></p>` : ''}
      ${stats.avg_upload ? `<p>Montant : <strong>${stats.avg_upload} Mbps</strong></p>` : ''}
      ${stats.avg_ping ? `<p>Ping : <strong>${stats.avg_ping} ms</strong></p>` : ''}
      <p>Confirmations : <strong style="color:var(--green)">${stats.works}</strong> &nbsp; Signalements : <strong style="color:var(--red)">${stats.broken}</strong></p>
    </div>`;

    const commentsHtml = comments.length ? `<div class="detail-card" style="margin-top:.75rem">
      <h3>Commentaires</h3>
      ${comments.map(c => `<div class="comment"><strong>${c.username}</strong><small style="margin-left:.5rem">${new Date(c.created_at).toLocaleDateString('fr-FR')}</small><p>${c.content}</p></div>`).join('')}
    </div>` : '';

    const historyHtml = hist && hist.length ? `<div class="detail-card" style="margin-top:.75rem">
      <h3>Historique</h3>
      <ul class="history-list" id="sidebar-history-list">${hist.map(renderHistoryEntry).join('')}</ul>
      <div id="sidebar-history-pagination" class="pagination"></div>
    </div>` : '';

    body.innerHTML = `
      <div style="margin-bottom:1rem">
        <div style="color:${scoreColor};font-size:.9rem">Score de confiance : <strong>${wifi.confidence_score}%</strong></div>
        <div class="progress-bar" style="margin-top:.4rem"><div class="progress-fill" style="width:${wifi.confidence_score}%;background:${scoreColor}"></div></div>
      </div>
      ${IS_LOGGED ? `<div style="display:flex;gap:.5rem;margin-bottom:.75rem">
        <button class="btn-green verify-sidebar-btn" data-id="${wifi.id}" data-status="works" style="flex:1">Fonctionne</button>
        <button class="btn-red verify-sidebar-btn" data-id="${wifi.id}" data-status="broken" style="flex:1">Ne fonctionne plus</button>
        <button class="btn-secondary sidebar-edit-btn" style="flex-shrink:0">✏️</button>
      </div>` : ''}
      ${infoCard}${perfCard}${commentsHtml}${historyHtml}`;

    if (hist && hist.length) paginateList('sidebar-history-list', 'sidebar-history-pagination', 5);

    body.querySelectorAll('.verify-sidebar-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = await fetch(`/wifi/${btn.dataset.id}/verify`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: btn.dataset.status }) });
        const json = await r.json();
        if (r.status === 429) return showSnackbar(`Cooldown actif, réessaye dans ${json.remaining}h`);
        if (r.ok) openWifiModal(btn.dataset.id);
      });
    });

    const editBtn = body.querySelector('.sidebar-edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => openEditForm(wifi.id));
  } catch(e) {
    body.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--red)">Erreur de chargement</div>';
  }
};

function showSnackbar(msg) {
  const s = document.createElement('div');
  s.className = 'snackbar';
  s.textContent = msg;
  document.body.appendChild(s);
  setTimeout(() => s.classList.add('snackbar-show'), 10);
  setTimeout(() => { s.classList.remove('snackbar-show'); setTimeout(() => s.remove(), 300); }, 3000);
}

window.openEditForm = async function(id) {
  const body = document.getElementById('wifi-modal-body');
  const title = document.getElementById('wifi-modal-title');
  body.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted)">Chargement…</div>';
  const r = await fetch(`/wifi/${id}/json`);
  const { wifi } = await r.json();
  title.textContent = '✏️ Modifier';
  body.innerHTML = `
    <button class="btn-secondary sidebar-back-btn" style="margin-bottom:1rem">← Retour</button>
    <form id="sidebar-edit-form" class="detail-card">
      <h3>Modifier le réseau</h3>
      <label class="ssid-label">SSID<span class="ssid-help"><a href="/faq/ssid" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span> *<input type="text" name="ssid" value="${wifi.ssid}" required></label>
      <label class="ssid-label">Chiffrement<span class="ssid-help"><a href="/faq/security" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span> *
        <select name="encryption" id="sidebar-enc">
          <option value="open" ${wifi.encryption==='open'?'selected':''}>Ouvert</option>
          <option value="wpa2" ${wifi.encryption==='wpa2'?'selected':''}>WPA2</option>
          <option value="wpa3" ${wifi.encryption==='wpa3'?'selected':''}>WPA3</option>
          <option value="wep" ${wifi.encryption==='wep'?'selected':''}>WEP</option>
        </select>
      </label>
      <label class="ssid-label" id="sidebar-pwd-field">Mot de passe<span class="ssid-help"><a href="/faq/password" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="text" name="password" value="${wifi.password || ''}"></label>
      <label class="ssid-label">Captive portal<span class="ssid-help"><a href="/faq/captiveportal" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span>
        <select name="captive_portal">
          <option value="">•</option>
          <option value="1" ${wifi.captive_portal?'selected':''}>Oui</option>
          <option value="0" ${!wifi.captive_portal?'selected':''}>Non</option>
        </select>
      </label>
      <label class="ssid-label">FAI<span class="ssid-help"><a href="/faq/isp" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span>
        <select name="isp">
          <option value="">•</option>
          ${['Orange','Free','SFR','Bouygues','Autre'].map(v => `<option ${wifi.isp===v?'selected':''}>${v}</option>`).join('')}
        </select>
      </label>
      <label class="ssid-label">Lieu<span class="ssid-help"><a href="/faq/location" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span>
        <select name="place_type">
          <option value="">•</option>
          ${['Restaurant','Café','Bibliothèque','Hôtel','Gare','Aéroport','Autre'].map(v => `<option ${wifi.place_type===v?'selected':''}>${v}</option>`).join('')}
        </select>
      </label>
      <label class="ssid-label">Horaires<span class="ssid-help"><a href="/faq/hours" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="text" name="hours" value="${wifi.hours || ''}" placeholder="Mo-Fr 08:00-20:00"></label>
      <label class="ssid-label">Passerelle<span class="ssid-help"><a href="/faq/gateway" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="text" name="gateway" value="${wifi.gateway || ''}"></label>
      <label class="ssid-label">DHCP<span class="ssid-help"><a href="/faq/dhcp" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="text" name="dhcp_range" value="${wifi.dhcp_range || ''}"></label>
      <label class="ssid-label">Débit ↓ (Mbps)<span class="ssid-help"><a href="/faq/speedtest" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="number" name="download_mbps" min="0" step="0.1" value="${wifi.download_mbps || ''}"></label>
      <label class="ssid-label">Débit ↑ (Mbps)<span class="ssid-help"><a href="/faq/speedtest" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="number" name="upload_mbps" min="0" step="0.1" value="${wifi.upload_mbps || ''}"></label>
      <label class="ssid-label">Ping (ms)<span class="ssid-help"><a href="/faq/speedtest" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="number" name="ping_ms" min="0" value="${wifi.ping_ms || ''}"></label>
      <label class="ssid-label">Latitude<span class="ssid-help"><a href="/faq/coordinates" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="number" name="lat" step="any" value="${wifi.lat}"></label>
      <label class="ssid-label">Longitude<span class="ssid-help"><a href="/faq/coordinates" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none;font-weight:700;margin-left:0">?</a></span><input type="number" name="lng" step="any" value="${wifi.lng}"></label>
      <button type="submit" class="btn-primary" style="width:100%;justify-content:center;margin-top:.5rem">Sauvegarder</button>
    </form>`;

  const enc = document.getElementById('sidebar-enc');
  const pwdField = document.getElementById('sidebar-pwd-field');

  body.querySelector('.sidebar-back-btn').addEventListener('click', () => openWifiModal(id));

  function togglePwd() {
    const open = enc.value === 'open';
    pwdField.style.display = open ? 'none' : '';
    pwdField.querySelector('input').disabled = open;
  }
  enc.addEventListener('change', togglePwd);
  togglePwd();

  document.getElementById('sidebar-edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      const res = await fetch(`/wifi/${id}/edit`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
      const json = await res.json();
      if (res.ok) {
        showSnackbar('Modifications sauvegardées !');
        openWifiModal(id);
      } else {
        showSnackbar(json.error || 'Erreur lors de la sauvegarde');
      }
    } catch(err) {
      showSnackbar('Erreur réseau');
    }
  });
};

window.closeWifiModal = function() {
  document.getElementById('wifi-modal').classList.add('hidden');
  history.pushState(null, '', '/');
};

window.addEventListener('popstate', e => {
  if (!e.state?.wifiModal) {
    document.getElementById('wifi-modal')?.classList.add('hidden');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeWifiModal();
});
