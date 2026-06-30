let map, addMarker;

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

  loadWifi();

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
          <a href="/wifi/${p.id}" class="btn-primary" style="margin-top:.5rem;display:inline-block">Voir les détails</a>
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
