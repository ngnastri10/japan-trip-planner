// ============================================================================
// Japan Trip Planner — main app logic
// Plain JS + Leaflet (map) + Firebase Firestore (shared live data).
// No build step: this file is loaded directly as an ES module by index.html.
// ============================================================================

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
// The ?v= here is its own cache-buster, separate from main.js's -- this file
// is reached via this import path directly, not the <script v=> in index.html,
// so bumping that alone doesn't force Cloudflare to refetch this one.
import { NEIGHBORHOODS } from "./neighborhoods-data.js?v=2";

const CATEGORIES = {
  food:     { emoji: "🍜", label: "Food",             color: "#e08e0b" },
  temple:   { emoji: "🏯", label: "Temple / Shrine",   color: "#c0392b" },
  nature:   { emoji: "🌳", label: "Nature / Park",     color: "#16a34a" },
  shopping: { emoji: "🛍️", label: "Shopping",          color: "#d6336c" },
  culture:  { emoji: "🎌", label: "Culture / Museum",  color: "#2563eb" },
  cafe:     { emoji: "☕", label: "Café / Tea",         color: "#8b5e34" },
  bar:      { emoji: "🍸", label: "Bar",               color: "#7c3aed" },
  activity: { emoji: "🧭", label: "Activity / Sights", color: "#0891b2" },
  other:    { emoji: "📍", label: "Other",             color: "#6b7280" }
};
function cat(key) { return CATEGORIES[key] || CATEGORIES.other; }

// City quick-jump targets for the header nav — zoom chosen to comfortably
// frame each city's core + day-trip-able surroundings on a typical screen.
const CITIES = {
  tokyo: { label: "Tokyo", lat: 35.6852, lng: 139.7528, zoom: 11, tiles: "esri" },
  kyoto: { label: "Kyoto", lat: 35.0116, lng: 135.7681, zoom: 12, tiles: "esri" },
  osaka: { label: "Osaka", lat: 34.6937, lng: 135.5023, zoom: 12, tiles: "esri" },
  // Esri's basemap has no real street-level data for South Korea (a legal
  // export restriction, not a bug — see README) and just shows a blank
  // placeholder there. Plain OSM has full Seoul/Busan detail instead, at the
  // cost of Korean-only tile labels; every neighborhood label, pin, and
  // popup stays in English regardless, since those are drawn by our own
  // code on top, independent of whichever tiles are underneath.
  seoul: { label: "Seoul", lat: 37.5665, lng: 126.9780, zoom: 11, tiles: "osm" },
  busan: { label: "Busan", lat: 35.1796, lng: 129.0756, zoom: 11, tiles: "osm" }
};
function cityLabel(key) { return (CITIES[key] && CITIES[key].label) || ""; }

// ---------------------------------------------------------------------------
// 0. Boot: load firebase-config.js (user-created from the .sample file).
//    If it's missing or still has placeholder values, show a friendly
//    on-page message instead of a silent blank app.
// ---------------------------------------------------------------------------
let db = null;

async function boot() {
  let firebaseConfig;
  try {
    ({ firebaseConfig } = await import("./firebase-config.js"));
  } catch (e) {
    showSetupBanner(
      "No firebase-config.js found yet.",
      "Copy js/firebase-config.sample.js, rename the copy to js/firebase-config.js, " +
      "and paste in your Firebase project's config values. See README.md."
    );
    return;
  }
  const stillPlaceholder = Object.values(firebaseConfig).some(v => String(v).startsWith("PASTE_YOUR"));
  if (stillPlaceholder) {
    showSetupBanner(
      "firebase-config.js still has placeholder values.",
      "Open js/firebase-config.js and paste in the real values from your Firebase project settings."
    );
    return;
  }

  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  startApp();
}

function showSetupBanner(title, body) {
  document.body.innerHTML = `
    <div style="max-width:520px;margin:60px auto;padding:28px;font-family:sans-serif;
                background:#fff8f0;border:1px solid #e6d8c3;border-radius:14px;">
      <h1 style="font-size:1.2rem;">⚙️ One setup step left</h1>
      <p style="font-weight:600;">${title}</p>
      <p style="color:#555;">${body}</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// 1. Identity (per-device display name, stored in localStorage)
// ---------------------------------------------------------------------------
const IDENTITY_KEY = "jtp_identity";
function getIdentity() { return localStorage.getItem(IDENTITY_KEY) || ""; }
function setIdentity(name) {
  localStorage.setItem(IDENTITY_KEY, name);
  document.getElementById("whoami-name").textContent = name;
}

function initIdentity() {
  const current = getIdentity();
  if (current) document.getElementById("whoami-name").textContent = current;
  else openWhoamiModal();

  document.getElementById("whoami-btn").addEventListener("click", openWhoamiModal);
  document.getElementById("whoami-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = document.getElementById("whoami-input").value.trim();
    if (!val) return;
    setIdentity(val);
    closeModal("whoami-modal");
  });
}
function openWhoamiModal() {
  document.getElementById("whoami-input").value = getIdentity();
  openModal("whoami-modal");
}

// ---------------------------------------------------------------------------
// 2. Generic modal helpers
// ---------------------------------------------------------------------------
function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

// ---------------------------------------------------------------------------
// 3. Tabs / views
// ---------------------------------------------------------------------------
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`view-${btn.dataset.view}`).classList.add("active");
      if (btn.dataset.view === "map") setTimeout(() => map && map.invalidateSize(), 50);
    });
  });
}

// Header city buttons: jump to the Map tab (if not already there) and pan/
// zoom straight to that city.
function initCityNav() {
  document.querySelectorAll(".city-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const city = CITIES[btn.dataset.city];
      if (!city) return;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.view === "map"));
      document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-map"));
      setBaseTiles(city.tiles);
      setTimeout(() => {
        map.invalidateSize();
        map.setView([city.lat, city.lng], city.zoom);
      }, 50);
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Map setup
// ---------------------------------------------------------------------------
let map;
let markerLayer;
let previewMarker = null; // temporary pin from search — not saved until confirmed

// Drops (or replaces) a plain, unstyled pin at a searched location. Nothing
// is saved yet — clicking the pin reveals an "Add to trip" button, which is
// what actually opens the real add-place form.
function showPreviewPin(lat, lng, name) {
  if (previewMarker) map.removeLayer(previewMarker);

  const popupNode = document.createElement("div");
  popupNode.innerHTML = `
    <div class="popup-title">${escapeHtml(name)}</div>
    <div class="popup-actions" style="margin-top:8px;">
      <button type="button" class="btn-primary">+ Add to trip</button>
    </div>`;
  popupNode.querySelector("button").addEventListener("click", () => {
    map.closePopup();
    openPlaceModal({ mode: "add", lat, lng, name });
  });

  previewMarker = L.marker([lat, lng]).addTo(map).bindPopup(popupNode);
}

const baseTileSets = {}; // "esri" | "osm" -> Leaflet layer, populated in initMap()
let currentTileSet = null;

function setBaseTiles(which) {
  if (which === currentTileSet || !baseTileSets[which]) return;
  if (currentTileSet) map.removeLayer(baseTileSets[currentTileSet]);
  baseTileSets[which].addTo(map);
  currentTileSet = which;
}

function initMap() {
  // Opens centered on the Imperial Palace at a zoom that covers roughly a
  // 25-30 mile radius — Shibuya, Shinjuku, etc. all visible without having
  // to zoom in manually (which used to trigger a cascade of tile loads at
  // every intermediate zoom level between "all of Japan" and here).
  map = L.map("map").setView([35.6852, 139.7528], 11);
  map.zoomControl.setPosition("bottomleft"); // top-left was covering the search results dropdown
  // Esri's free "Light Gray Canvas" basemap: bilingual (Japanese + English)
  // labels, and roughly 4x fewer bytes per tile than a full-color street map
  // (no API key required either way). It's two stacked layers: a plain gray
  // base, then a reference layer that carries the roads/labels on top.
  // maxNativeZoom: the tile server itself only renders up to z16; beyond that
  // Leaflet just scales up the z16 tile so you can still zoom in for precise
  // pin placement (map.setView("15") calls elsewhere stay valid either way).
  const esriOpts = { maxZoom: 19, maxNativeZoom: 16, attribution: "Tiles &copy; Esri" };
  baseTileSets.esri = L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", esriOpts),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", esriOpts)
  ]);
  // Esri has no real street-level data for South Korea (see the CITIES
  // comment above), so Seoul/Busan use plain OpenStreetMap instead — full
  // detail there, Korean-only tile labels as the tradeoff. OSM's default
  // style is full-color, which competes visually with the pins/neighborhoods
  // it's meant to show off, so it renders in its own pane with a grayscale
  // filter (roughly matching how muted the Esri style is) rather than the
  // shared default tile pane Esri uses.
  map.createPane("osmPane");
  // A custom pane gets no z-index by default, which left it free to paint
  // above the neighborhood/marker panes once the DOM settled (only briefly
  // showing them in the correct order during a zoom transform) -- pin it to
  // the same z-index as Leaflet's own tile pane so it unambiguously sits
  // below everything at every point, not just mid-animation.
  map.getPane("osmPane").style.zIndex = 200;
  map.getPane("osmPane").style.filter = "grayscale(90%)";
  baseTileSets.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    subdomains: "abc",
    pane: "osmPane",
    attribution: "&copy; OpenStreetMap contributors"
  });
  baseTileSets.esri.addTo(map);
  currentTileSet = "esri";
  markerLayer = L.layerGroup().addTo(map);
  renderNeighborhoods();

  // Click empty map => add a place at that spot
  map.on("click", (e) => {
    openPlaceModal({ mode: "add", lat: e.latlng.lat, lng: e.latlng.lng });
  });

  document.getElementById("fab-add").addEventListener("click", () => {
    openPlaceModal({ mode: "add" });
  });
}

// ---------------------------------------------------------------------------
// Neighborhood overlay — shaded outlines (real OSM boundary where one exists,
// hand-drawn approximation otherwise; see neighborhoods-data.js). Purely a
// visual/info layer on the Map tab — doesn't touch places, votes, or dates.
// ---------------------------------------------------------------------------
const NBHD_REST_OPACITY = 0.16;
const NBHD_HOVER_OPACITY = 0.5;
// The Korea cities render on a grayscaled base (see setBaseTiles/"osmPane") --
// the same fill opacity that pops nicely on Esri's pale backdrop reads as
// nearly invisible against that darker gray, so those get a stronger wash.
const NBHD_REST_OPACITY_KOREA = 0.55;
const NBHD_HOVER_OPACITY_KOREA = 0.78;
let neighborhoodLayer;

function renderNeighborhoods() {
  neighborhoodLayer = L.layerGroup();

  NEIGHBORHOODS.forEach(n => {
    const isKorea = n.city === "seoul" || n.city === "busan";
    const restOpacity = isKorea ? NBHD_REST_OPACITY_KOREA : NBHD_REST_OPACITY;
    const hoverOpacity = isKorea ? NBHD_HOVER_OPACITY_KOREA : NBHD_HOVER_OPACITY;

    const rings = n.parts.map(p => [p.outer, ...p.holes]);
    const layer = L.polygon(rings, {
      color: n.color,
      weight: 2,
      opacity: 0.75,
      fillColor: n.color,
      fillOpacity: restOpacity,
      bubblingMouseEvents: false // clicking a shaded area shows its info, not the "add place" form
    });

    layer.bindTooltip(
      `<b>${escapeHtml(n.name)}</b>${escapeHtml(n.desc)}`,
      { className: "nbhd-tip", sticky: true }
    );
    layer.on("mouseover", () => layer.setStyle({ fillOpacity: hoverOpacity, weight: 3 }));
    layer.on("mouseout", () => layer.setStyle({ fillOpacity: restOpacity, weight: 2 }));
    layer.on("click", () => layer.setStyle({ fillOpacity: hoverOpacity, weight: 3 }));

    layer.addTo(neighborhoodLayer);

    // Always-visible name label (not just on hover). labelLat/labelLng is a
    // point precomputed to fall inside the actual shape, even after carving.
    L.marker([n.labelLat, n.labelLng], {
      icon: L.divIcon({
        className: "nbhd-label",
        html: escapeHtml(n.name),
        iconSize: [140, 14],
        iconAnchor: [70, 7] // box is wider than most names on purpose — text-align:center
      }),                    // keeps it truly centered even where it overflows the box
      interactive: false
    }).addTo(neighborhoodLayer);
  });

  const checkbox = document.getElementById("toggle-neighborhoods");
  if (checkbox.checked) neighborhoodLayer.addTo(map);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) neighborhoodLayer.addTo(map);
    else map.removeLayer(neighborhoodLayer);
  });
}

function makeDivIcon(category) {
  return L.divIcon({
    html: `<div class="marker-emoji">${cat(category).emoji}</div>`,
    className: "",
    iconSize: [30, 30],
    iconAnchor: [15, 26],
    popupAnchor: [0, -24]
  });
}

// ---------------------------------------------------------------------------
// 5. Firestore live data
// ---------------------------------------------------------------------------
const placesById = new Map(); // id -> place data (includes .id)

function startApp() {
  initTabs();
  initCityNav();
  initIdentity();
  initMap();
  initSearch();
  initPlaceForm();
  initListControls();
  document.getElementById("itinerary-filter-city").addEventListener("change", renderItinerary);

  onSnapshot(collection(db, "places"), (snap) => {
    placesById.clear();
    snap.forEach(d => placesById.set(d.id, { id: d.id, ...d.data() }));
    renderMarkers();
    renderList();
    renderItinerary();
  }, (err) => {
    console.error(err);
    showToast("Couldn't load data — check Firestore rules / config.");
  });

  initCategoryFilter();
}

// Every category starts checked (on) — unchecking one hides its markers.
const activeCategories = new Set(Object.keys(CATEGORIES));

function initCategoryFilter() {
  const btn = document.getElementById("cat-filter-btn");
  const label = document.getElementById("cat-filter-label");
  const panel = document.getElementById("cat-filter-panel");

  panel.innerHTML = `
    <div class="cat-filter-actions">
      <button type="button" id="cat-filter-all">Select all</button>
      <button type="button" id="cat-filter-none">Deselect all</button>
    </div>
    ${Object.keys(CATEGORIES).map(key => {
      const c = CATEGORIES[key];
      return `
        <label class="cat-filter-row">
          <input type="checkbox" data-cat="${key}" checked>
          <span style="color:${c.color}">${c.emoji} ${escapeHtml(c.label)}</span>
        </label>`;
    }).join("")}`;

  const checkboxes = panel.querySelectorAll("input[type=checkbox]");

  function updateLabel() {
    const total = Object.keys(CATEGORIES).length;
    label.textContent = activeCategories.size === total ? "All categories"
      : activeCategories.size === 0 ? "No categories"
      : `${activeCategories.size} categor${activeCategories.size === 1 ? "y" : "ies"}`;
  }

  checkboxes.forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) activeCategories.add(cb.dataset.cat);
      else activeCategories.delete(cb.dataset.cat);
      updateLabel();
      renderMarkers();
    });
  });

  document.getElementById("cat-filter-all").addEventListener("click", () => {
    checkboxes.forEach(cb => { cb.checked = true; activeCategories.add(cb.dataset.cat); });
    updateLabel();
    renderMarkers();
  });
  document.getElementById("cat-filter-none").addEventListener("click", () => {
    checkboxes.forEach(cb => { cb.checked = false; activeCategories.delete(cb.dataset.cat); });
    updateLabel();
    renderMarkers();
  });

  btn.addEventListener("click", () => panel.classList.toggle("hidden"));
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".filter-wrap")) panel.classList.add("hidden");
  });
}

function renderMarkers() {
  markerLayer.clearLayers();
  placesById.forEach(place => {
    if (!activeCategories.has(place.category)) return;
    if (place.lat == null || place.lng == null) return;
    const marker = L.marker([place.lat, place.lng], { icon: makeDivIcon(place.category) });
    marker.bindPopup(buildPopupHTML(place));
    marker.addTo(markerLayer);
  });
}

function voteCount(place) { return Object.keys(place.votes || {}).length; }
function hasVoted(place, name) { return !!(place.votes && place.votes[name]); }

function buildPopupHTML(place) {
  const votes = voteCount(place);
  const voted = hasVoted(place, getIdentity());
  const dateStr = place.date ? formatDate(place.date) : "no date yet";
  const gmaps = googleMapsUrl(place);
  const c = cat(place.category);
  return `
    <span class="popup-cat" style="color:${c.color}">${c.emoji} ${escapeHtml(c.label)}</span>
    <div class="popup-title">${escapeHtml(place.name)}</div>
    <div class="popup-meta">${place.city ? escapeHtml(cityLabel(place.city)) + " · " : ""}${dateStr}${place.addedBy ? " · added by " + escapeHtml(place.addedBy) : ""}</div>
    ${place.notes ? `<div class="popup-notes">${escapeHtml(place.notes)}</div>` : ""}
    <div class="popup-actions">
      <button class="vote-btn ${voted ? "voted" : ""}" data-action="vote" data-id="${place.id}">👍 ${votes}</button>
      <a class="gmaps-link" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps</a>
      <a class="edit-link" href="#" data-action="edit" data-id="${place.id}">✏️ edit</a>
    </div>`;
}

function googleMapsUrl(place) {
  if (place.lat != null && place.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name + " Japan")}`;
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Event delegation for vote / edit clicks coming from map popups, list cards,
// and itinerary cards (all built as raw HTML, not permanent DOM nodes).
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const id = el.dataset.id;
  if (!id) return;
  if (el.dataset.action === "vote") {
    e.preventDefault();
    toggleVote(id);
  } else if (el.dataset.action === "edit") {
    e.preventDefault();
    const place = placesById.get(id);
    if (place) openPlaceModal({ mode: "edit", place });
  }
});

async function toggleVote(id) {
  const name = getIdentity();
  if (!name) { openWhoamiModal(); return; }
  const place = placesById.get(id);
  if (!place) return;
  const already = hasVoted(place, name);
  try {
    await updateDoc(doc(db, "places", id), {
      [`votes.${name}`]: already ? deleteField() : true
    });
  } catch (e) {
    console.error(e);
    showToast("Vote didn't save — check your connection.");
  }
}

// ---------------------------------------------------------------------------
// 6. Place search (Photon / Komoot, built on OpenStreetMap data — free, no
//    API key, and unlike Nominatim's endpoint it reliably sends the CORS
//    header browsers require. lang=en asks it to prefer English names.)
// ---------------------------------------------------------------------------
const JAPAN_BBOX = "122.8,20.4,154.0,45.6"; // west,south,east,north — biases/filters results to Japan

function initSearch() {
  const input = document.getElementById("place-search");
  const results = document.getElementById("search-results");
  let debounceTimer;
  let latestQueryId = 0;

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.classList.add("hidden"); return; }
    debounceTimer = setTimeout(() => runSearch(q), 400);
  });

  // Typing-and-waiting isn't obvious, so Enter searches immediately too.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) return;
    runSearch(q);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) results.classList.add("hidden");
  });

  async function runSearch(q) {
    const queryId = ++latestQueryId;
    showMessage("Searching…");
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&lat=36.2048&lon=138.2529&bbox=${JAPAN_BBOX}`;
      const res = await fetch(url);
      if (queryId !== latestQueryId) return; // a newer keystroke already superseded this
      if (!res.ok) throw new Error(`Search API returned ${res.status}`);
      const data = await res.json();
      renderResults(data.features || []);
    } catch (e) {
      console.error(e);
      if (queryId === latestQueryId) showMessage("Search failed — check your connection and try again.");
    }
  }

  function showMessage(text) {
    results.innerHTML = `<div class="result-item" style="cursor:default;color:#8a8579;">${escapeHtml(text)}</div>`;
    results.classList.remove("hidden");
  }

  function renderResults(features) {
    if (!features.length) { showMessage("No matches — try a different spelling."); return; }
    results.innerHTML = features.map((f, i) =>
      `<div class="result-item" data-i="${i}">${escapeHtml(label(f))}</div>`
    ).join("");
    results.classList.remove("hidden");
    results.querySelectorAll(".result-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        const f = features[i];
        const [lng, lat] = f.geometry.coordinates;
        const name = f.properties.name || label(f);
        results.classList.add("hidden");
        input.value = "";
        map.setView([lat, lng], 16);
        showPreviewPin(lat, lng, name);
      });
    });
  }

  function label(feature) {
    const p = feature.properties;
    const parts = [p.name, p.city || p.district, p.state, p.country].filter(Boolean);
    return parts.join(", ");
  }
}

// ---------------------------------------------------------------------------
// 7. Add / edit place modal
// ---------------------------------------------------------------------------
let formState = { mode: "add", id: null };

function openPlaceModal({ mode, place = null, lat = null, lng = null, name = "" }) {
  formState = { mode, id: place ? place.id : null };
  document.getElementById("place-modal-title").textContent = mode === "edit" ? "Edit place" : "Add a place";
  document.getElementById("place-modal-delete").classList.toggle("hidden", mode !== "edit");

  const f = fieldRefs();
  if (mode === "edit" && place) {
    f.name.value = place.name || "";
    f.city.value = place.city || "";
    f.category.value = place.category || "other";
    f.notes.value = place.notes || "";
    f.date.value = place.date || "";
    f.lat.value = place.lat ?? "";
    f.lng.value = place.lng ?? "";
  } else {
    f.name.value = name;
    f.city.value = "";
    f.category.value = "other";
    f.notes.value = "";
    f.date.value = "";
    f.lat.value = lat ?? "";
    f.lng.value = lng ?? "";
  }
  document.getElementById("pf-gmaps-link").value = "";
  const gmapsStatus = document.getElementById("pf-gmaps-status");
  gmapsStatus.className = "gmaps-status hidden";
  wikiLookupToken++; // invalidate any lookup still in flight from a previous open
  clearWikiFlag();

  updateCoordsDisplay();
  openModal("place-modal");
  f.name.focus();

  if (mode === "add" && name) tryWikipediaAutofill();
}

function fieldRefs() {
  return {
    name: document.getElementById("pf-name"),
    city: document.getElementById("pf-city"),
    category: document.getElementById("pf-category"),
    notes: document.getElementById("pf-notes"),
    date: document.getElementById("pf-date"),
    lat: document.getElementById("pf-lat"),
    lng: document.getElementById("pf-lng")
  };
}

function updateCoordsDisplay() {
  const f = fieldRefs();
  const disp = document.getElementById("pf-coords-display");
  if (f.lat.value && f.lng.value) {
    disp.textContent = `📍 Location set (${parseFloat(f.lat.value).toFixed(4)}, ${parseFloat(f.lng.value).toFixed(4)})`;
  } else {
    disp.textContent = "📍 No location set yet — close this, then click the map or search above (optional; you can still save without one).";
  }
}

// Pulls coordinates (and a name, if present) out of a pasted Google Maps
// URL. Long-format links only — Google's short links (maps.app.goo.gl,
// goo.gl/maps) resolve server-side and can't be read from a static page with
// no backend, so those are explicitly reported as unsupported rather than
// silently failing.
function parseGoogleMapsUrl(url) {
  if (/goo\.gl\/maps|maps\.app\.goo\.gl/.test(url)) {
    return { error: "That's a shortened Google Maps link, which can't be read directly. Open it once so the address bar shows the full maps.google.com URL, then paste that instead — or just click the spot on the map." };
  }
  // A share link's !3d<lat>!4d<lng> is the actual pin location; the @lat,lng
  // earlier in the same URL is just wherever the map view happened to be
  // centered, which can be a bit off. Prefer !3d/!4d when both are present.
  let m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (!m) m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) return { error: "Couldn't find coordinates in that link — try clicking the spot on the map instead." };

  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return { error: "Couldn't find coordinates in that link — try clicking the spot on the map instead." };

  let name = null;
  const nameMatch = url.match(/\/place\/([^/@]+)/);
  if (nameMatch) {
    try { name = decodeURIComponent(nameMatch[1].replace(/\+/g, " ")); } catch (e) { /* leave name null */ }
  }
  return { lat, lng, name };
}

// ---------------------------------------------------------------------------
// Wikipedia notes auto-fill — free, no API key, CORS-friendly. Coverage is
// limited to places famous enough to have an article (temples, museums,
// landmarks); a small restaurant or café will just find nothing, silently.
// Whatever gets pulled in is flagged and blocks Save until reviewed, since
// it's someone else's summary, not a verified fact about this specific trip.
// ---------------------------------------------------------------------------
let pendingWikiConfirm = false;
let wikiLookupToken = 0;

async function fetchWikipediaSummary(name) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return null; // 404 etc. -- no matching article, nothing to fill
    const data = await res.json();
    if (data.type === "disambiguation") return null; // ambiguous title, not a real summary
    return data.extract || null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

async function tryWikipediaAutofill() {
  const f = fieldRefs();
  const name = f.name.value.trim();
  if (!name || f.notes.value.trim()) return; // nothing to look up, or already has notes

  const token = ++wikiLookupToken;
  const extract = await fetchWikipediaSummary(name);
  if (token !== wikiLookupToken) return;      // a newer name superseded this lookup
  if (!extract) return;
  if (f.notes.value.trim()) return;           // user typed their own notes while we waited

  f.notes.value = extract;
  pendingWikiConfirm = true;
  document.getElementById("pf-notes").classList.add("notes-flagged");
  document.getElementById("pf-wiki-banner").classList.remove("hidden");
}

function clearWikiFlag() {
  pendingWikiConfirm = false;
  document.getElementById("pf-notes").classList.remove("notes-flagged");
  document.getElementById("pf-wiki-banner").classList.add("hidden");
}

function initWikiAutofill() {
  document.getElementById("pf-name").addEventListener("blur", tryWikipediaAutofill);
  document.getElementById("pf-notes").addEventListener("input", () => {
    if (pendingWikiConfirm) clearWikiFlag(); // editing it yourself counts as reviewing it
  });
  document.getElementById("wiki-keep-btn").addEventListener("click", clearWikiFlag);
  document.getElementById("wiki-clear-btn").addEventListener("click", () => {
    document.getElementById("pf-notes").value = "";
    clearWikiFlag();
  });
}

function initGmapsLinkPaste() {
  const input = document.getElementById("pf-gmaps-link");
  const status = document.getElementById("pf-gmaps-status");
  input.addEventListener("input", () => {
    const url = input.value.trim();
    if (!url) { status.className = "gmaps-status hidden"; return; }

    const result = parseGoogleMapsUrl(url);
    if (result.error) {
      status.textContent = "⚠️ " + result.error;
      status.className = "gmaps-status fail";
      return;
    }

    const f = fieldRefs();
    f.lat.value = result.lat;
    f.lng.value = result.lng;
    updateCoordsDisplay();
    if (result.name && !f.name.value.trim()) {
      f.name.value = result.name;
      tryWikipediaAutofill();
    }

    status.textContent = "✅ Location set from link" + (result.name ? ` — "${result.name}"` : "") + ". Fill in the rest below.";
    status.className = "gmaps-status ok";
  });
}

function initPlaceForm() {
  initGmapsLinkPaste();
  initWikiAutofill();
  document.getElementById("place-modal-cancel").addEventListener("click", () => closeModal("place-modal"));

  document.getElementById("place-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pendingWikiConfirm) {
      showToast("Review the auto-filled notes first — keep, clear, or edit them.");
      document.getElementById("pf-notes").focus();
      return;
    }
    const name = getIdentity();
    if (!name) { openWhoamiModal(); return; }
    const f = fieldRefs();
    const payload = {
      name: f.name.value.trim(),
      city: f.city.value,
      category: f.category.value,
      notes: f.notes.value.trim(),
      date: f.date.value || "",
      lat: f.lat.value ? parseFloat(f.lat.value) : null,
      lng: f.lng.value ? parseFloat(f.lng.value) : null
    };
    if (!payload.name) return;

    try {
      if (formState.mode === "edit" && formState.id) {
        await updateDoc(doc(db, "places", formState.id), payload);
        showToast("Saved changes");
      } else {
        await addDoc(collection(db, "places"), {
          ...payload,
          addedBy: name,
          votes: {},
          createdAt: serverTimestamp()
        });
        showToast("Added!");
        // The real synced marker now exists (or will as soon as Firestore
        // confirms), so drop the temporary search-preview pin if any.
        if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
      }
      closeModal("place-modal");
    } catch (err) {
      console.error(err);
      showToast("Couldn't save — check your connection.");
    }
  });

  document.getElementById("place-modal-delete").addEventListener("click", async () => {
    if (!formState.id) return;
    if (!confirm("Delete this place for everyone?")) return;
    try {
      await deleteDoc(doc(db, "places", formState.id));
      showToast("Deleted");
      closeModal("place-modal");
    } catch (err) {
      console.error(err);
      showToast("Couldn't delete — check your connection.");
    }
  });
}

// ---------------------------------------------------------------------------
// 8. List view
// ---------------------------------------------------------------------------
function initListControls() {
  document.getElementById("list-filter-city").addEventListener("change", renderList);
  document.getElementById("list-filter-category").addEventListener("change", renderList);
  document.getElementById("list-filter-person").addEventListener("change", renderList);
  document.getElementById("list-sort").addEventListener("change", renderList);
  document.getElementById("list-add-btn").addEventListener("click", () => openPlaceModal({ mode: "add" }));
}

// "Added by" options aren't a fixed list like cities/categories -- whoever's
// actually added something shows up here, so this rebuilds from live data
// every render, keeping the current selection if that person still has places.
function updatePersonFilterOptions() {
  const select = document.getElementById("list-filter-person");
  const current = select.value;
  const people = new Set();
  placesById.forEach(p => { if (p.addedBy) people.add(p.addedBy); });
  const sorted = Array.from(people).sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">All people</option>` +
    sorted.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  if (sorted.includes(current)) select.value = current;
}

function renderList() {
  updatePersonFilterOptions();
  const container = document.getElementById("place-list");
  const cityFilter = document.getElementById("list-filter-city").value;
  const filter = document.getElementById("list-filter-category").value;
  const personFilter = document.getElementById("list-filter-person").value;
  const sortBy = document.getElementById("list-sort").value;

  let items = Array.from(placesById.values());
  if (cityFilter) items = items.filter(p => p.city === cityFilter);
  if (filter) items = items.filter(p => p.category === filter);
  if (personFilter) items = items.filter(p => p.addedBy === personFilter);

  items.sort((a, b) => {
    if (sortBy === "votes") return voteCount(b) - voteCount(a);
    if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
    // newest first (fall back to name if createdAt missing, e.g. optimistic UI)
    const at = a.createdAt?.seconds || 0, bt = b.createdAt?.seconds || 0;
    return bt - at;
  });

  if (!items.length) {
    container.innerHTML = `<p style="color:#8a8579;padding:20px;">No places yet — add the first one!</p>`;
    return;
  }

  container.innerHTML = items.map(place => `
    <div class="place-card">
      <div class="pc-top">
        <div>
          <div class="pc-name">${escapeHtml(place.name)}</div>
          <div class="pc-meta">${place.addedBy ? "added by " + escapeHtml(place.addedBy) : ""}</div>
        </div>
        <div class="pc-cat">${cat(place.category).emoji}</div>
      </div>
      ${place.notes ? `<div class="pc-notes">${escapeHtml(place.notes)}</div>` : ""}
      <div>
        ${place.city ? `<span class="date-pill city-pill">${escapeHtml(cityLabel(place.city))}</span>` : ""}
        <span class="date-pill ${place.date ? "" : "unset"}">${place.date ? formatDate(place.date) : "no date yet"}</span>
      </div>
      <div class="pc-actions">
        <button class="vote-btn ${hasVoted(place, getIdentity()) ? "voted" : ""}" data-action="vote" data-id="${place.id}">👍 ${voteCount(place)}</button>
        <a class="gmaps-link" href="${googleMapsUrl(place)}" target="_blank" rel="noopener">Open in Google Maps</a>
        <a class="edit-link" href="#" data-action="edit" data-id="${place.id}">✏️ edit</a>
      </div>
    </div>
  `).join("");
}

// ---------------------------------------------------------------------------
// 9. Itinerary view (grouped by proposed date)
// ---------------------------------------------------------------------------
function renderItinerary() {
  const board = document.getElementById("itinerary-board");
  const cityFilter = document.getElementById("itinerary-filter-city").value;
  const groups = new Map(); // date ("" = unscheduled) -> [places]

  placesById.forEach(place => {
    if (cityFilter && place.city !== cityFilter) return;
    const key = place.date || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(place);
  });

  const dateKeys = Array.from(groups.keys()).filter(k => k).sort();
  const orderedKeys = groups.has("") ? [...dateKeys, ""] : dateKeys;

  if (!orderedKeys.length) {
    const msg = cityFilter
      ? `No ${escapeHtml(cityLabel(cityFilter))} places yet — add some, or assign that city on existing places.`
      : "No places yet — add some, then assign dates to build your itinerary.";
    board.innerHTML = `<p style="color:#8a8579;padding:20px;">${msg}</p>`;
    return;
  }

  board.innerHTML = orderedKeys.map(key => {
    const list = groups.get(key).slice().sort((a, b) => voteCount(b) - voteCount(a));
    const heading = key ? formatDate(key) : "Unscheduled";
    return `
      <div class="day-column">
        <h3>${heading}</h3>
        ${list.map(place => `
          <div class="day-card">
            <div class="dc-name">${cat(place.category).emoji} ${escapeHtml(place.name)}${place.city ? ` <span class="dc-city">· ${escapeHtml(cityLabel(place.city))}</span>` : ""}</div>
            <div class="dc-votes">👍 ${voteCount(place)} · <a class="edit-link" href="#" data-action="edit" data-id="${place.id}">edit</a></div>
          </div>
        `).join("")}
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
boot();
