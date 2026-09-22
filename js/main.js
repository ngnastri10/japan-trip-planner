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
import { DAY_ZONES } from "./dayzones-data.js?v=1";

const CATEGORIES = {
  food:     { emoji: "🍜", label: "Food",             color: "#e08e0b" },
  temple:   { emoji: "🏯", label: "Temple / Shrine",   color: "#c0392b" },
  nature:   { emoji: "🌳", label: "Nature / Park",     color: "#16a34a" },
  shopping: { emoji: "🛍️", label: "Shopping",          color: "#d6336c" },
  culture:  { emoji: "🎌", label: "Culture / Museum",  color: "#2563eb" },
  cafe:     { emoji: "☕", label: "Café / Tea",         color: "#8b5e34" },
  bar:      { emoji: "🍸", label: "Bar",               color: "#7c3aed" },
  activity: { emoji: "🧭", label: "Activity / Sights", color: "#0891b2" },
  hotel:    { emoji: "🏨", label: "Hotel",             color: "#334155" },
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

// Smart default for the price-entry currency dropdown, based on city.
const CURRENCY_FOR_CITY = { tokyo: "JPY", kyoto: "JPY", osaka: "JPY", seoul: "KRW", busan: "KRW" };

// ---------------------------------------------------------------------------
// Price / currency — prices are entered and stored in whatever currency was
// actually paid, then converted to USD purely for display, everywhere a
// place shows up (map popup, list card, itinerary card). Fixed, approximate
// rates (checked ~Sept 2026) rather than a live FX API -- day-to-day
// fluctuation is small enough that "close enough" is fine for trip budgeting.
// ---------------------------------------------------------------------------
const FX_PER_USD = { USD: 1, JPY: 156, KRW: 1345 };
const CURRENCY_SYMBOL = { USD: "$", JPY: "¥", KRW: "₩" };

function toUSD(amount, currency) {
  const rate = FX_PER_USD[currency] || 1;
  return amount / rate;
}

// Returns a display string like "≈$15" or null if this place has no price set.
function formatPriceUSD(place) {
  if (place.priceAmount == null || place.priceAmount === "" || !place.priceCurrency) return null;
  const amount = Number(place.priceAmount);
  if (Number.isNaN(amount)) return null;
  const usd = toUSD(amount, place.priceCurrency);
  // Whole dollars once it's not tiny -- this is a rough trip-budget figure,
  // not an exact receipt, so cents past that point are just noise.
  const rounded = usd >= 10 ? Math.round(usd) : Math.round(usd * 100) / 100;
  return `≈$${rounded}`;
}

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
      // Same deal as the map above -- the calendar gets built while its tab
      // is hidden (width 0), so its columns are laid out wrong until it's
      // told to re-measure once it's actually visible.
      if (btn.dataset.view === "itinerary") setTimeout(() => calendar && calendar.updateSize(), 50);
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
  renderMapOverlays();

  // (used to open the add-place form on any map click -- removed, it kept
  // firing by accident while just panning/zooming around. Adding a place
  // now only happens via search or the + button.)

  document.getElementById("fab-add").addEventListener("click", () => {
    openPlaceModal({ mode: "add" });
  });
}

// ---------------------------------------------------------------------------
// Map overlays — shaded outlines, either real neighborhoods (real OSM
// boundary where one exists, hand-drawn approximation otherwise; see
// neighborhoods-data.js) or the looser Day Zones that group several nearby
// neighborhoods into "what you could do in one day" areas (dayzones-data.js).
// Purely a visual/info layer on the Map tab — doesn't touch places, votes, or
// dates. Only one of the two ever shows at once, via the overlay-toggle
// control (see initOverlayToggle below) -- default is neighborhoods.
// ---------------------------------------------------------------------------
const NBHD_REST_OPACITY = 0.16;
const NBHD_HOVER_OPACITY = 0.5;
// The Korea cities render on a grayscaled base (see setBaseTiles/"osmPane") --
// the same fill opacity that pops nicely on Esri's pale backdrop reads as
// nearly invisible against that darker gray, so those get a stronger wash.
const NBHD_REST_OPACITY_KOREA = 0.55;
const NBHD_HOVER_OPACITY_KOREA = 0.78;

// Zones cover much more area than a single neighborhood, so they run lighter
// at rest (a big region at neighborhood-strength fill would swamp the map).
const ZONE_REST_OPACITY = 0.12;
const ZONE_HOVER_OPACITY = 0.32;
const ZONE_REST_OPACITY_KOREA = 0.4;
const ZONE_HOVER_OPACITY_KOREA = 0.6;

let neighborhoodLayer;
let zoneLayer;

// Shared by both the neighborhood layer and the day-zone layer -- same
// shaded-polygon-plus-label-plus-hover behavior, just different data/opacity.
function buildOverlayLayer(entries, opts) {
  const { restOpacity, hoverOpacity, restOpacityKorea, hoverOpacityKorea, labelBox = [150, 14] } = opts;
  const layer = L.layerGroup();

  entries.forEach(n => {
    const isKorea = n.city === "seoul" || n.city === "busan";
    const rest = isKorea ? restOpacityKorea : restOpacity;
    const hover = isKorea ? hoverOpacityKorea : hoverOpacity;

    const rings = n.parts.map(p => [p.outer, ...(p.holes || [])]);
    const poly = L.polygon(rings, {
      color: n.color,
      weight: 2,
      opacity: 0.75,
      fillColor: n.color,
      fillOpacity: rest,
      bubblingMouseEvents: false // clicking a shaded area shows its info, not the "add place" form
    });

    poly.bindTooltip(
      `<b>${escapeHtml(n.name)}</b>${escapeHtml(n.desc)}`,
      { className: "nbhd-tip", sticky: true }
    );
    poly.on("mouseover", () => poly.setStyle({ fillOpacity: hover, weight: 3 }));
    poly.on("mouseout", () => poly.setStyle({ fillOpacity: rest, weight: 2 }));
    poly.on("click", () => poly.setStyle({ fillOpacity: hover, weight: 3 }));

    poly.addTo(layer);

    // Always-visible name label (not just on hover). labelLat/labelLng is a
    // point precomputed to fall inside the actual shape, even after carving.
    L.marker([n.labelLat, n.labelLng], {
      icon: L.divIcon({
        className: "nbhd-label",
        html: escapeHtml(n.name),
        iconSize: labelBox,
        iconAnchor: [labelBox[0] / 2, labelBox[1] / 2] // box is wider than most names on
      }),                                                // purpose -- text-align:center keeps
      interactive: false                                  // it truly centered past the overflow
    }).addTo(layer);
  });

  return layer;
}

const OVERLAY_MODES = ["off", "neighborhoods", "zones"];
let overlayMode = "neighborhoods";

// Slides (and resizes) the highlight pill to sit exactly under whichever
// button is active. The three labels are different lengths ("Off" vs.
// "Neighborhoods"), so this measures the real button box each time rather
// than assuming a fixed one-third split.
function positionOverlayThumb(mode) {
  const toggle = document.getElementById("overlay-toggle");
  const thumb = toggle.querySelector(".overlay-toggle-thumb");
  const btn = toggle.querySelector(`.overlay-toggle-opt[data-mode="${mode}"]`);
  if (!btn) return;
  thumb.style.left = btn.offsetLeft + "px";
  thumb.style.width = btn.offsetWidth + "px";
}

function setOverlayMode(mode) {
  if (!OVERLAY_MODES.includes(mode)) return;
  overlayMode = mode;
  if (neighborhoodLayer && map.hasLayer(neighborhoodLayer)) map.removeLayer(neighborhoodLayer);
  if (zoneLayer && map.hasLayer(zoneLayer)) map.removeLayer(zoneLayer);
  if (mode === "neighborhoods" && neighborhoodLayer) neighborhoodLayer.addTo(map);
  if (mode === "zones" && zoneLayer) zoneLayer.addTo(map);

  const toggle = document.getElementById("overlay-toggle");
  toggle.dataset.active = String(OVERLAY_MODES.indexOf(mode));
  toggle.querySelectorAll(".overlay-toggle-opt").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  positionOverlayThumb(mode);
}

function initOverlayToggle() {
  const toggle = document.getElementById("overlay-toggle");
  toggle.querySelectorAll(".overlay-toggle-opt").forEach(btn => {
    btn.addEventListener("click", () => setOverlayMode(btn.dataset.mode));
  });
  // Button widths can change (e.g. the small-screen media query shrinks their
  // padding/font-size), so re-measure and reposition the thumb on resize.
  window.addEventListener("resize", () => positionOverlayThumb(overlayMode));
  setOverlayMode(overlayMode); // applies the default now that both layers exist
}

function renderMapOverlays() {
  neighborhoodLayer = buildOverlayLayer(NEIGHBORHOODS, {
    restOpacity: NBHD_REST_OPACITY, hoverOpacity: NBHD_HOVER_OPACITY,
    restOpacityKorea: NBHD_REST_OPACITY_KOREA, hoverOpacityKorea: NBHD_HOVER_OPACITY_KOREA
  });
  zoneLayer = buildOverlayLayer(DAY_ZONES, {
    restOpacity: ZONE_REST_OPACITY, hoverOpacity: ZONE_HOVER_OPACITY,
    restOpacityKorea: ZONE_REST_OPACITY_KOREA, hoverOpacityKorea: ZONE_HOVER_OPACITY_KOREA,
    labelBox: [180, 14]
  });
  initOverlayToggle();
}

// Ray-casting point-in-polygon test against one [lat,lng] ring.
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const crosses = ((lngI > lng) !== (lngJ > lng)) &&
      (lat < (latJ - latI) * (lng - lngI) / (lngJ - lngI) + latI);
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInZoneEntry(lat, lng, zone) {
  return zone.parts.some(p =>
    pointInRing(lat, lng, p.outer) && !(p.holes || []).some(h => pointInRing(lat, lng, h))
  );
}

// Which of this city's Day Zones (by name) contain the given point. Zones are
// deliberately loose and can overlap, so a place may match more than one --
// this returns all matches rather than a single "owning" zone.
function zonesForPoint(city, lat, lng) {
  if (lat == null || lng == null) return [];
  return DAY_ZONES.filter(z => z.city === city && pointInZoneEntry(lat, lng, z)).map(z => z.name);
}

// Rebuilds a zone <select>'s options for the given city (List/Itinerary tabs
// each have their own). Zones only make sense within one city at a time, so
// the dropdown is disabled until a specific city is chosen.
function updateZoneFilterOptions(selectId, cityValue) {
  const select = document.getElementById(selectId);
  const current = select.value;
  if (!cityValue) {
    select.innerHTML = `<option value="">Pick a city for zones</option>`;
    select.value = "";
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const zones = DAY_ZONES.filter(z => z.city === cityValue);
  select.innerHTML = `<option value="">All zones</option>` +
    zones.map(z => `<option value="${escapeHtml(z.name)}">${escapeHtml(z.name)}</option>`).join("");
  if (zones.some(z => z.name === current)) select.value = current;
}

// Same idea as zonesForPoint/updateZoneFilterOptions above, but for the
// actual (tighter) neighborhood boundaries instead of the looser Day Zones.
function neighborhoodsForPoint(city, lat, lng) {
  if (lat == null || lng == null) return [];
  return NEIGHBORHOODS.filter(n => n.city === city && pointInZoneEntry(lat, lng, n)).map(n => n.name);
}

function updateNeighborhoodFilterOptions(selectId, cityValue) {
  const select = document.getElementById(selectId);
  const current = select.value;
  if (!cityValue) {
    select.innerHTML = `<option value="">Pick a city for neighborhoods</option>`;
    select.value = "";
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const nbhds = NEIGHBORHOODS.filter(n => n.city === cityValue);
  select.innerHTML = `<option value="">All neighborhoods</option>` +
    nbhds.map(n => `<option value="${escapeHtml(n.name)}">${escapeHtml(n.name)}</option>`).join("");
  if (nbhds.some(n => n.name === current)) select.value = current;
}

// Switches to the Map tab, pans/zooms to a place, and pops its info bubble
// open -- used by the "Open in map" link on the itinerary's unscheduled tiles.
function jumpToPlaceOnMap(place) {
  if (place.lat == null || place.lng == null) return;
  document.querySelector('.tab-btn[data-view="map"]').click(); // handles the tab switch + invalidateSize
  const city = CITIES[place.city];
  if (city) setBaseTiles(city.tiles);
  setTimeout(() => {
    map.invalidateSize();
    map.setView([place.lat, place.lng], 16);
    L.popup().setLatLng([place.lat, place.lng]).setContent(buildPopupHTML(place)).openOn(map);
  }, 80);
}

// Small floating detail bubble anchored near a clicked calendar event --
// same idea (and same content) as the map's own popups, so clicking an
// itinerary event shows details instead of jumping straight to edit.
function showDetailPopup(place, anchorEl) {
  closeDetailPopup();
  // Lives inside the scrolling calendar area (not document.body), positioned
  // relative to it -- so it scrolls along with the event it's pointing at
  // instead of staying glued to one spot on screen.
  const container = document.querySelector(".itinerary-layout");
  const containerRect = container.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  const left = Math.min(anchorRect.right - containerRect.left + container.scrollLeft + 6, container.scrollWidth - 300);

  const popup = document.createElement("div");
  popup.id = "itinerary-detail-popup";
  popup.innerHTML = `<button type="button" class="detail-popup-close">✕</button>` + buildPopupHTML(place);
  popup.style.left = `${left}px`;
  container.appendChild(popup);

  // Center the popup on the tile's middle, not its top -- needs the popup's
  // real height, which we only know now that it's actually in the DOM.
  const anchorMiddle = anchorRect.top + anchorRect.height / 2 - containerRect.top + container.scrollTop;
  const naturalTop = anchorMiddle - popup.offsetHeight / 2;

  popup.querySelector(".detail-popup-close").addEventListener("click", closeDetailPopup);

  // Keep it tied to the event as you scroll, but don't let it scroll off
  // the top -- clamp it to the top of the visible area instead.
  function reposition() { popup.style.top = `${Math.max(naturalTop, container.scrollTop + 6)}px`; }
  reposition();
  container.addEventListener("scroll", reposition);
  popup._cleanup = () => container.removeEventListener("scroll", reposition);

  const link = popup.querySelector(".gmaps-link");
  if (link && place.lat != null && place.lng != null) {
    link.textContent = "Open in map";
    link.href = "#";
    link.addEventListener("click", (e) => { e.preventDefault(); closeDetailPopup(); jumpToPlaceOnMap(place); });
  }
}

function closeDetailPopup() {
  const existing = document.getElementById("itinerary-detail-popup");
  if (existing) {
    existing._cleanup();
    existing.remove();
  }
}

// Closes the popup on a click anywhere else -- but not on the same click
// that opened it (that click's target is the calendar event itself).
document.addEventListener("click", (e) => {
  const popup = document.getElementById("itinerary-detail-popup");
  if (popup && !popup.contains(e.target) && !e.target.closest(".fc-event")) closeDetailPopup();
});

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
  updateZoneFilterOptions("itinerary-filter-zone", document.getElementById("itinerary-filter-city").value);
  updateNeighborhoodFilterOptions("itinerary-filter-neighborhood", document.getElementById("itinerary-filter-city").value);
  initItinerary();

  onSnapshot(collection(db, "places"), (snap) => {
    placesById.clear();
    snap.forEach(d => placesById.set(d.id, { id: d.id, ...d.data() }));
    renderMarkers();
    renderList();
    renderItineraryCalendar();
  }, (err) => {
    console.error(err);
    showToast("Couldn't load data — check Firestore rules / config.");
  });

  initCategoryFilter();
}

// Every category starts checked (on) — unchecking one hides matching items.
// Map and List each get their own independent set/panel, built by the same
// factory below rather than duplicating this wiring per tab.
const activeCategories = new Set(Object.keys(CATEGORIES));     // Map tab
const activeListCategories = new Set(Object.keys(CATEGORIES)); // List tab

function createCategoryFilter({ btnId, labelId, panelId, activeSet, onChange }) {
  const btn = document.getElementById(btnId);
  const label = document.getElementById(labelId);
  const panel = document.getElementById(panelId);

  panel.innerHTML = `
    <div class="cat-filter-actions">
      <button type="button" class="cf-all">Select all</button>
      <button type="button" class="cf-none">Deselect all</button>
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
    label.textContent = activeSet.size === total ? "All categories"
      : activeSet.size === 0 ? "No categories"
      : `${activeSet.size} categor${activeSet.size === 1 ? "y" : "ies"}`;
  }

  checkboxes.forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) activeSet.add(cb.dataset.cat);
      else activeSet.delete(cb.dataset.cat);
      updateLabel();
      onChange();
    });
  });

  panel.querySelector(".cf-all").addEventListener("click", () => {
    checkboxes.forEach(cb => { cb.checked = true; activeSet.add(cb.dataset.cat); });
    updateLabel();
    onChange();
  });
  panel.querySelector(".cf-none").addEventListener("click", () => {
    checkboxes.forEach(cb => { cb.checked = false; activeSet.delete(cb.dataset.cat); });
    updateLabel();
    onChange();
  });

  btn.addEventListener("click", () => panel.classList.toggle("hidden"));
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      panel.classList.add("hidden");
    }
  });
}

function initCategoryFilter() {
  createCategoryFilter({
    btnId: "cat-filter-btn", labelId: "cat-filter-label", panelId: "cat-filter-panel",
    activeSet: activeCategories, onChange: renderMarkers
  });
}

function initListCategoryFilter() {
  createCategoryFilter({
    btnId: "list-cat-filter-btn", labelId: "list-cat-filter-label", panelId: "list-cat-filter-panel",
    activeSet: activeListCategories, onChange: renderList
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
    ${formatPriceUSD(place) ? `<span class="price-pill">${formatPriceUSD(place)}</span>` : ""}
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
    f.time.value = place.time || "";
    f.lat.value = place.lat ?? "";
    f.lng.value = place.lng ?? "";
    f.priceAmount.value = place.priceAmount ?? "";
    f.priceCurrency.value = place.priceCurrency || CURRENCY_FOR_CITY[place.city] || "USD";
  } else {
    f.name.value = name;
    f.city.value = "";
    f.category.value = "other";
    f.notes.value = "";
    f.date.value = "";
    f.time.value = "";
    f.lat.value = lat ?? "";
    f.lng.value = lng ?? "";
    f.priceAmount.value = "";
    f.priceCurrency.value = "USD"; // no city picked yet -- the city-change listener
  }                                 // in initPlaceForm re-defaults this once one is
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
    time: document.getElementById("pf-time"),
    lat: document.getElementById("pf-lat"),
    lng: document.getElementById("pf-lng"),
    priceAmount: document.getElementById("pf-price-amount"),
    priceCurrency: document.getElementById("pf-price-currency")
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

  // Re-default the price currency to match whichever city gets picked --
  // but only while the amount is still blank, so it never clobbers a
  // currency the user already deliberately chose alongside a real number.
  document.getElementById("pf-city").addEventListener("change", () => {
    const amountField = document.getElementById("pf-price-amount");
    if (amountField.value.trim()) return;
    const city = document.getElementById("pf-city").value;
    document.getElementById("pf-price-currency").value = CURRENCY_FOR_CITY[city] || "USD";
  });

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
    const priceAmountRaw = f.priceAmount.value.trim();
    // Keep the existing duration on edit (it may have been resized on the
    // calendar); default a brand-new timed place to 1 hour.
    const existingPlace = formState.id ? placesById.get(formState.id) : null;
    const payload = {
      name: f.name.value.trim(),
      city: f.city.value,
      category: f.category.value,
      notes: f.notes.value.trim(),
      date: f.date.value || "",
      time: f.time.value || "",
      durationMinutes: f.time.value ? ((existingPlace && existingPlace.durationMinutes) || 60) : null,
      lat: f.lat.value ? parseFloat(f.lat.value) : null,
      lng: f.lng.value ? parseFloat(f.lng.value) : null,
      priceAmount: priceAmountRaw ? parseFloat(priceAmountRaw) : null,
      priceCurrency: priceAmountRaw ? f.priceCurrency.value : null
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
  initListCategoryFilter();
  updateZoneFilterOptions("list-filter-zone", document.getElementById("list-filter-city").value);
  document.getElementById("list-filter-city").addEventListener("change", () => {
    updateZoneFilterOptions("list-filter-zone", document.getElementById("list-filter-city").value);
    renderList();
  });
  document.getElementById("list-filter-zone").addEventListener("change", renderList);
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
  const zoneFilter = document.getElementById("list-filter-zone").value;
  const personFilter = document.getElementById("list-filter-person").value;
  const sortBy = document.getElementById("list-sort").value;

  let items = Array.from(placesById.values());
  if (cityFilter) items = items.filter(p => p.city === cityFilter);
  if (zoneFilter) items = items.filter(p => zonesForPoint(p.city, p.lat, p.lng).includes(zoneFilter));
  items = items.filter(p => activeListCategories.has(p.category));
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
        ${formatPriceUSD(place) ? `<span class="price-pill">${formatPriceUSD(place)}</span>` : ""}
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
// 9. Itinerary view — a real day-planner calendar (FullCalendar), spanning
// the whole trip as one scrollable view. Places with a date show up as
// draggable/resizable blocks; places with no date sit in the "Unscheduled"
// sidebar and get dragged onto the calendar to pick a day/time.
// ---------------------------------------------------------------------------
const TRIP_START = "2026-11-20"; // first day shown on the calendar
const TRIP_DAYS = 15;            // Nov 20 - Dec 4
const TRIP_END = "2026-12-05";   // one day past the last real day (validRange end is exclusive)
let calendar;

// Adds minutes to a "HH:MM" string. Doesn't handle wrapping past midnight --
// fine here, nothing we're scheduling runs that long.
function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}

// Saves a place's schedule back to Firestore -- called after a drag, a
// resize, or dropping an unscheduled item onto the calendar.
async function savePlaceSchedule(id, { date, time, durationMinutes }) {
  try {
    await updateDoc(doc(db, "places", id), { date, time, durationMinutes });
  } catch (e) {
    console.error(e);
    showToast("Couldn't save that change — check your connection.");
  }
}

function initItinerary() {
  calendar = new FullCalendar.Calendar(document.getElementById("itinerary-calendar"), {
    headerToolbar: { left: "title", center: "", right: "allDaysBtn dayView today prev next" },
    initialView: "tripView",
    // A plain "tripView" toolbar button just re-shows whatever date you'd
    // wandered to in Day view -- this custom one always snaps back to the
    // actual start of the trip instead, so "All days" really means all days.
    customButtons: {
      allDaysBtn: { text: "All days", click: () => calendar.changeView("tripView", TRIP_START) }
    },
    views: {
      // The trip range is clamped (validRange below), so today/prev/next
      // don't do anything useful here -- just the two view buttons.
      tripView: {
        type: "timeGrid", duration: { days: TRIP_DAYS },
        headerToolbar: { left: "title", center: "", right: "allDaysBtn dayView" }
      },
      dayView: { type: "timeGrid", duration: { days: 1 }, buttonText: "Day" }
    },
    initialDate: TRIP_START,
    validRange: { start: TRIP_START, end: TRIP_END }, // can't scroll past the trip into empty days
    navLinks: true, // click a day's header (in the All-days view) to jump into that day
    navLinkDayClick: (date) => calendar.changeView("dayView", date),
    // Keeps the "jump to a day" dropdown in sync no matter how the view
    // changed (nav link click, day-view's own prev/next, etc).
    datesSet: (info) => {
      const picker = document.getElementById("itinerary-day-picker");
      picker.value = calendar.view.type === "dayView" ? info.startStr.slice(0, 10) : "";
      // Same header-glitch fix as the tab-switch one below, but this covers
      // switching between the week/day views themselves (that also needs a
      // re-measure, not just the initial hidden-tab case).
      setTimeout(() => calendar.updateSize(), 50);
    },
    // Day-of-month on top, weekday abbreviation below it -- a plain text
    // format like "Tue 24" wraps inconsistently depending on column width,
    // so build the two-line layout ourselves instead.
    dayHeaderContent: (arg) => ({
      html: `<div class="day-header-num">${arg.date.getDate()}</div>`
          + `<div class="day-header-dow">${arg.date.toLocaleDateString(undefined, { weekday: "short" })}</div>`
    }),
    slotMinTime: "07:00:00",
    slotMaxTime: "24:00:00",
    height: "auto",
    nowIndicator: true,
    editable: true,   // drag to move, drag the bottom edge to resize
    droppable: true,  // accepts drags from the unscheduled sidebar
    eventDrop: (info) => {
      const p = placesById.get(info.event.id);
      savePlaceSchedule(info.event.id, {
        date: info.event.startStr.slice(0, 10),
        time: info.event.startStr.slice(11, 16),
        durationMinutes: p ? (p.durationMinutes || 60) : 60
      });
    },
    eventResize: (info) => {
      const minutes = Math.round((info.event.end - info.event.start) / 60000);
      savePlaceSchedule(info.event.id, {
        date: info.event.startStr.slice(0, 10),
        time: info.event.startStr.slice(11, 16),
        durationMinutes: minutes
      });
    },
    // Drag an event off the calendar entirely (e.g. onto the Unscheduled
    // sidebar) to pull it back out of the schedule. eventDrop only fires
    // for a valid drop *inside* the calendar, so this is the one that
    // catches "let go somewhere else."
    eventDragStop: (info) => {
      const rect = document.getElementById("itinerary-calendar").getBoundingClientRect();
      const { clientX: x, clientY: y } = info.jsEvent;
      const droppedOutside = x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
      if (droppedOutside) savePlaceSchedule(info.event.id, { date: "", time: "", durationMinutes: null });
    },
    drop: (info) => {
      const id = info.draggedEl.dataset.id;
      const p = placesById.get(id);
      savePlaceSchedule(id, {
        date: info.dateStr.slice(0, 10),
        time: info.dateStr.slice(11, 16),
        durationMinutes: (p && p.durationMinutes) || 60
      });
    },
    // Dropping a sidebar item makes FullCalendar auto-add its own temporary
    // copy of the event (that's what eventReceive hands us). We don't want
    // it -- renderItineraryCalendar rebuilds the real one from Firestore a
    // moment later -- so just throw this placeholder copy away, otherwise
    // it sits there forever and you get the same activity shown twice.
    eventReceive: (info) => {
      info.event.remove();
    },
    eventClick: (info) => {
      const p = placesById.get(info.event.id);
      if (p) showDetailPopup(p, info.el);
    }
  });
  calendar.render();

  // Makes the unscheduled sidebar a source of draggable events. Set up once
  // on the container -- FullCalendar delegates by itemSelector, so this
  // keeps working even after the list's HTML gets rebuilt on every render.
  new FullCalendar.Draggable(document.getElementById("itinerary-unscheduled-list"), {
    itemSelector: ".unscheduled-item",
    eventData: (el) => ({ id: el.dataset.id, title: el.dataset.title, duration: "01:00", color: el.dataset.color })
  });

  // Click a sidebar tile (not a link/button inside it) to expand it in
  // place and show the same detail popup content the map markers use --
  // not the full add/edit form, just a closer look.
  document.getElementById("itinerary-unscheduled-list").addEventListener("click", (e) => {
    const item = e.target.closest(".unscheduled-item");
    if (!item || e.target.closest("[data-action], a")) return;
    const detail = item.querySelector(".unscheduled-item-detail");
    const wasOpen = !detail.classList.contains("hidden");
    document.querySelectorAll("#itinerary-unscheduled-list .unscheduled-item-detail").forEach(d => d.classList.add("hidden"));
    if (!wasOpen) {
      const p = placesById.get(item.dataset.id);
      if (p) {
        detail.innerHTML = buildPopupHTML(p);
        // Here specifically (not on the map's own popups) swap the Google
        // Maps link for one that jumps to our own Map tab instead, so you
        // can actually see where this sits relative to everything else.
        const link = detail.querySelector(".gmaps-link");
        if (link && p.lat != null && p.lng != null) {
          link.textContent = "Open in map";
          link.href = "#";
          link.addEventListener("click", (ev) => { ev.preventDefault(); jumpToPlaceOnMap(p); });
        }
      }
      detail.classList.remove("hidden");
    }
  });

  document.getElementById("itinerary-filter-city").addEventListener("change", () => {
    const city = document.getElementById("itinerary-filter-city").value;
    updateZoneFilterOptions("itinerary-filter-zone", city);
    updateNeighborhoodFilterOptions("itinerary-filter-neighborhood", city);
    renderItineraryCalendar();
  });
  document.getElementById("itinerary-filter-zone").addEventListener("change", renderItineraryCalendar);
  document.getElementById("itinerary-filter-neighborhood").addEventListener("change", renderItineraryCalendar);

  // Day-picker dropdown, filled with every date of the trip -- picking one
  // switches the calendar into single-day view on that date.
  const dayPicker = document.getElementById("itinerary-day-picker");
  for (let i = 0; i < TRIP_DAYS; i++) {
    const d = addDaysToDateStr(TRIP_START, i);
    dayPicker.insertAdjacentHTML("beforeend", `<option value="${d}">${formatDate(d)}</option>`);
  }
  dayPicker.addEventListener("change", () => {
    if (dayPicker.value) calendar.changeView("dayView", dayPicker.value);
    else calendar.changeView("tripView", TRIP_START);
  });
}

// "2026-11-24" + 2 -> "2026-11-26". Plain date-string math, no Date/timezone
// juggling needed since we only ever add whole days.
function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function renderItineraryCalendar() {
  const cityFilter = document.getElementById("itinerary-filter-city").value;
  const zoneFilter = document.getElementById("itinerary-filter-zone").value;
  const nbhdFilter = document.getElementById("itinerary-filter-neighborhood").value;
  const scheduled = [];
  const unscheduled = [];

  // The city/zone/neighborhood filters only narrow down the Unscheduled
  // list -- once something's on the calendar it stays put no matter what's
  // picked up top.
  placesById.forEach(place => {
    if (!place.date) {
      if (cityFilter && place.city !== cityFilter) return;
      if (zoneFilter && !zonesForPoint(place.city, place.lat, place.lng).includes(zoneFilter)) return;
      if (nbhdFilter && !neighborhoodsForPoint(place.city, place.lat, place.lng).includes(nbhdFilter)) return;
      unscheduled.push(place);
    } else {
      scheduled.push(place);
    }
  });

  const events = scheduled.map(p => {
    const time = p.time || "09:00";
    const durationMin = p.durationMinutes || 60;
    return {
      id: p.id,
      title: `${cat(p.category).emoji} ${p.name}`,
      start: `${p.date}T${time}`,
      end: `${p.date}T${addMinutes(time, durationMin)}`,
      color: cat(p.category).color
    };
  });
  calendar.removeAllEventSources();
  calendar.addEventSource(events);

  const list = document.getElementById("itinerary-unscheduled-list");
  if (!unscheduled.length) {
    list.innerHTML = `<p style="color:#8a8579;font-size:0.82rem;">Nothing unscheduled.</p>`;
  } else {
    list.innerHTML = unscheduled.map(p => `
      <div class="unscheduled-item" data-id="${p.id}" data-title="${escapeHtml(cat(p.category).emoji + " " + p.name)}" data-color="${cat(p.category).color}">
        <div class="unscheduled-item-name">${cat(p.category).emoji} ${escapeHtml(p.name)}${p.city ? ` <span style="color:var(--ink-soft);font-size:0.8em;">· ${escapeHtml(cityLabel(p.city))}</span>` : ""}</div>
        <div class="unscheduled-item-detail hidden"></div>
      </div>
    `).join("");
  }
}

// ---------------------------------------------------------------------------
boot();
