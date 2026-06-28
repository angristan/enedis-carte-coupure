const map = L.map("map", {
  zoomControl: false,
  easeLinearity: 0.22,
  inertia: true,
  inertiaDeceleration: 2600,
  inertiaMaxSpeed: 1600,
  markerZoomAnimation: true,
  wheelDebounceTime: 24,
  wheelPxPerZoomLevel: 92,
  zoomAnimation: true,
  zoomDelta: 0.5,
  zoomSnap: 0.25,
}).setView([48.8566, 2.3522], 12);

L.control.zoom({ position: "bottomleft" }).addTo(map);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

map.createPane("streetCasingPane");
map.createPane("streetStrokePane");
map.createPane("streetHitPane");

map.getPane("streetCasingPane").style.zIndex = 405;
map.getPane("streetCasingPane").style.pointerEvents = "none";
map.getPane("streetStrokePane").style.zIndex = 420;
map.getPane("streetStrokePane").style.pointerEvents = "none";
map.getPane("streetHitPane").style.zIndex = 430;

const streetRenderer = {
  casing: L.svg({ pane: "streetCasingPane", padding: 0.35 }),
  stroke: L.svg({ pane: "streetStrokePane", padding: 0.35 }),
  hit: L.svg({ pane: "streetHitPane", padding: 0.35 }),
};

const outageLayer = L.layerGroup().addTo(map);
const polygonLayer = L.layerGroup().addTo(map);

const elements = {
  status: document.querySelector("#status"),
  streetCount: document.querySelector("#streetCount"),
  outageCount: document.querySelector("#outageCount"),
  htaCount: document.querySelector("#htaCount"),
  btCount: document.querySelector("#btCount"),
  visibleCount: document.querySelector("#visibleCount"),
  updatedAt: document.querySelector("#updatedAt"),
  streetList: document.querySelector("#streetList"),
  mapPane: document.querySelector(".map-pane"),
  hoverLabel: document.querySelector("#hoverLabel"),
  template: document.querySelector("#streetItemTemplate"),
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  filterButtons: [...document.querySelectorAll(".segment")],
};

const state = {
  data: null,
  activeFilter: "all",
  query: "",
  layerByKey: new Map(),
  itemByKey: new Map(),
  activeKey: null,
  didFitInitialBounds: false,
  abortController: null,
};

window.addEventListener("resize", () => map.invalidateSize());
map.on("zoomend", updateStreetStyles);
map.on("movestart zoomstart popupopen", hideHoverLabel);
elements.refreshButton.addEventListener("click", () => loadData({ force: true }));
elements.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

for (const button of elements.filterButtons) {
  button.addEventListener("click", () => {
    state.activeFilter = button.dataset.filter || "all";
    for (const item of elements.filterButtons) item.classList.toggle("active", item === button);
    render({ fitMap: true });
  });
}

await loadData();

async function loadData({ force = false } = {}) {
  state.abortController?.abort();
  state.abortController = new AbortController();
  elements.refreshButton.disabled = true;
  elements.status.textContent = force ? "Rafraichissement..." : "Chargement des donnees Enedis...";

  try {
    const response = await fetch(`/api/outages${force ? `?t=${Date.now()}` : ""}`, {
      signal: state.abortController.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    elements.status.textContent = buildStatusText(state.data);
    render({ fitMap: true });
  } catch (error) {
    if (error.name !== "AbortError") {
      elements.status.textContent = `Erreur: ${error.message}`;
      elements.streetList.innerHTML = "";
    }
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function render({ fitMap = false } = {}) {
  if (!state.data) return;

  renderStats();
  renderMap({ fitMap });
  renderList();
}

function renderStats() {
  const stats = state.data.stats || {};
  elements.streetCount.textContent = formatNumber(stats.streets);
  elements.outageCount.textContent = formatNumber(stats.outages);
  elements.htaCount.textContent = formatNumber(stats.compteurIncidentHTA + stats.compteurTravauxHTA);
  elements.btCount.textContent = formatNumber(stats.compteurBT);
  elements.updatedAt.textContent = formatTime(state.data.updatedAt);
}

function renderMap({ fitMap = false } = {}) {
  map.invalidateSize();
  hideHoverLabel();
  outageLayer.clearLayers();
  polygonLayer.clearLayers();
  state.layerByKey.clear();

  if (state.data.polygon?.features?.length) {
    L.geoJSON(state.data.polygon, {
      style: {
        color: "#1b6d85",
        weight: 1.5,
        opacity: 0.7,
        fillColor: "#4fb99f",
        fillOpacity: 0.08,
      },
      interactive: false,
    }).addTo(polygonLayer);
  }

  const bounds = [];
  for (const street of filteredStreets()) {
    const entry = createStreetEntry(street);
    if (!entry) continue;
    entry.layer.addTo(outageLayer);
    state.layerByKey.set(street.key, entry);
    bounds.push(...entry.bounds);
  }

  if (fitMap || !state.didFitInitialBounds) {
    fitMapToBounds(bounds);
    state.didFitInitialBounds = true;
  }
  requestAnimationFrame(() => {
    map.invalidateSize();
    updateStreetStyles();
  });
}

function renderList() {
  const streets = filteredStreets();
  elements.visibleCount.textContent = `${formatNumber(streets.length)} rues visibles`;
  elements.streetList.innerHTML = "";
  state.itemByKey.clear();

  const fragment = document.createDocumentFragment();
  for (const street of streets) {
    const item = elements.template.content.firstElementChild.cloneNode(true);
    item.querySelector(".street-name").textContent = street.label;
    item.querySelector(".street-detail").textContent = detailText(street);
    item.querySelector(".street-tags").innerHTML = street.outageTypes.map(tagHtml).join("");
    item.disabled = !hasMapLayer(street);
    item.title = item.disabled ? "Rue non geocodee precisement" : "Centrer la carte sur cette rue";
    item.classList.toggle("active", street.key === state.activeKey);
    item.addEventListener("click", () => selectStreet(street, { fit: true, openPopup: true, scrollList: false }));
    state.itemByKey.set(street.key, item);
    fragment.appendChild(item);
  }

  elements.streetList.appendChild(fragment);
}

function focusStreet(street) {
  selectStreet(street, { fit: true, openPopup: true, scrollList: true });
}

function selectStreet(street, { fit = false, openPopup = false, scrollList = true } = {}) {
  const entry = state.layerByKey.get(street.key);
  if (!entry) return;
  hideHoverLabel();
  state.activeKey = street.key;
  updateStreetStyles();
  updateActiveListItem(scrollList);
  bringStreetToFront(entry);

  if (fit && entry.layer.getBounds) {
    const layerBounds = entry.layer.getBounds();
    if (layerBounds.isValid()) {
      map.fitBounds(layerBounds, {
        padding: mapPadding(),
        maxZoom: 17.5,
        animate: true,
        duration: 0.72,
        easeLinearity: 0.2,
      });
    }
  } else if (fit && entry.layer.getLatLng) {
    map.setView(entry.layer.getLatLng(), 16, { animate: true, duration: 0.72, easeLinearity: 0.2 });
  }

  if (openPopup) window.setTimeout(() => entry.popupTarget?.openPopup(), fit ? 220 : 0);
}

function updateActiveListItem(scrollList = false) {
  for (const [key, item] of state.itemByKey) {
    const active = key === state.activeKey;
    item.classList.toggle("active", active);
    item.setAttribute("aria-current", active ? "true" : "false");
    if (active && scrollList) {
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}

function showHoverLabel(street, event) {
  if (!elements.hoverLabel || window.matchMedia("(pointer: coarse)").matches) return;
  elements.hoverLabel.textContent = street.label;
  elements.hoverLabel.hidden = false;
  moveHoverLabel(event);
}

function moveHoverLabel(event) {
  if (!elements.hoverLabel || elements.hoverLabel.hidden || !event) return;
  const pointer = event.originalEvent || event;
  if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;

  const paneRect = elements.mapPane.getBoundingClientRect();
  const labelRect = elements.hoverLabel.getBoundingClientRect();
  const margin = 10;
  const x = clamp(
    pointer.clientX - paneRect.left,
    margin + labelRect.width / 2,
    paneRect.width - margin - labelRect.width / 2,
  );
  const y = clamp(
    pointer.clientY - paneRect.top,
    margin + labelRect.height + 14,
    paneRect.height - margin,
  );

  elements.hoverLabel.style.left = `${x}px`;
  elements.hoverLabel.style.top = `${y}px`;
}

function hideHoverLabel() {
  if (!elements.hoverLabel) return;
  elements.hoverLabel.hidden = true;
}

function fitMapToBounds(bounds) {
  if (bounds.length > 1) {
    map.fitBounds(bounds, {
      padding: mapPadding(),
      maxZoom: 14,
      animate: true,
      duration: 0.6,
      easeLinearity: 0.22,
    });
  }
  if (bounds.length === 1) map.setView(bounds[0], 15, { animate: true, duration: 0.6 });
}

function mapPadding() {
  return window.matchMedia("(max-width: 640px)").matches ? [30, 30] : [64, 64];
}

function createStreetEntry(street) {
  if (hasGeometry(street)) return createGeometryEntry(street);
  if (street.geocode?.status === "ok") return createPointEntry(street);
  return null;
}

function createGeometryEntry(street) {
  const group = L.featureGroup();
  const bounds = [];
  const casings = [];
  const strokes = [];
  const hitAreas = [];
  let popupTarget = null;
  const lines = mergedGeometryLines(street);

  for (const coords of lines) {
    bounds.push(...coords);

    const casing = L.polyline(coords, {
      ...streetCasingStyle(street),
      renderer: streetRenderer.casing,
      interactive: false,
    });
    casing.addTo(group);
    casings.push(casing);

    const stroke = L.polyline(coords, {
      ...streetStrokeStyle(street),
      renderer: streetRenderer.stroke,
      interactive: false,
    });
    stroke.addTo(group);
    strokes.push(stroke);

    const hitArea = L.polyline(coords, {
      className: "street-hit-path",
      color: "#000000",
      weight: hitWeight(),
      opacity: 0.001,
      lineCap: "round",
      lineJoin: "round",
      renderer: streetRenderer.hit,
    });
    hitArea.bindPopup(popupHtml(street));
    hitArea.addTo(group);
    hitAreas.push(hitArea);
    popupTarget ||= hitArea;
  }

  if (!bounds.length) return createPointEntry(street);

  const entry = { layer: group, popupTarget, bounds, street, casings, strokes, hitAreas, hovered: false };
  for (const hitArea of hitAreas) {
    hitArea.on("mouseover", (event) => {
      entry.hovered = true;
      bringStreetToFront(entry);
      applyStreetStyle(entry);
      showHoverLabel(street, event);
    });
    hitArea.on("mousemove", moveHoverLabel);
    hitArea.on("mouseout", () => {
      entry.hovered = false;
      applyStreetStyle(entry);
      hideHoverLabel();
    });
    hitArea.on("click", () => {
      hideHoverLabel();
      selectStreet(street, { fit: false, openPopup: true, scrollList: true });
    });
  }
  return entry;
}

function createPointEntry(street) {
  const marker = L.circleMarker([street.geocode.lat, street.geocode.lng], {
    radius: markerRadius(street),
    color: "#ffffff",
    fillColor: markerColor(street),
    fillOpacity: 0.8,
    opacity: 0.95,
    weight: 3,
  });
  marker.bindPopup(popupHtml(street));
  marker.on("mouseover", (event) => showHoverLabel(street, event));
  marker.on("mousemove", moveHoverLabel);
  marker.on("mouseout", hideHoverLabel);
  marker.on("click", hideHoverLabel);
  return {
    layer: marker,
    popupTarget: marker,
    bounds: [[street.geocode.lat, street.geocode.lng]],
    street,
  };
}

function lineCoords(line) {
  return line
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point) => [point.lat, point.lng]);
}

function hasMapLayer(street) {
  return hasGeometry(street) || street.geocode?.status === "ok";
}

function hasGeometry(street) {
  return street.geometry?.status === "ok" && street.geometry.lines?.length > 0;
}

function updateStreetStyles() {
  for (const entry of state.layerByKey.values()) applyStreetStyle(entry);
}

function applyStreetStyle(entry) {
  if (!entry.strokes?.length) return;
  const emphasized = entry.hovered || entry.street.key === state.activeKey;
  const casingStyle = streetCasingStyle(entry.street, emphasized);
  const strokeStyle = streetStrokeStyle(entry.street, emphasized);
  for (const casing of entry.casings) casing.setStyle(casingStyle);
  for (const stroke of entry.strokes) stroke.setStyle(strokeStyle);
}

function bringStreetToFront(entry) {
  for (const layer of [...(entry.casings || []), ...(entry.strokes || []), ...(entry.hitAreas || [])]) {
    layer.bringToFront?.();
  }
}

function filteredStreets() {
  const streets = state.data?.streets || [];
  return streets.filter((street) => {
    const filterMatches =
      state.activeFilter === "all" || street.outageTypes.some((type) => type === state.activeFilter);
    if (!filterMatches) return false;
    if (!state.query) return true;
    const haystack = [
      street.label,
      street.postcode,
      street.city,
      ...(street.outageTypes || []),
      ...(street.localisations || []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(state.query);
  });
}

function markerColor(street) {
  if (street.outageTypes.includes("Incident HTA")) return "#d94835";
  if (street.outageTypes.includes("Incident BT")) return "#e46d00";
  return "#007f7a";
}

function markerRadius(street) {
  const count = street.outageIds?.length || 1;
  return Math.min(13, 7 + count * 1.5);
}

function lineWeight(street) {
  const count = street.outageIds?.length || 1;
  const zoom = map.getZoom();
  const zoomWeight = zoom <= 11 ? 2.6 : zoom <= 12 ? 3.2 : zoom <= 13 ? 4 : zoom <= 15 ? 5 : 6.2;
  return Math.min(8.2, zoomWeight + Math.min(1.2, (count - 1) * 0.35));
}

function streetCasingStyle(street, emphasized = false) {
  const weight = lineWeight(street) + (emphasized ? 5.4 : 4.2);
  return {
    color: "#fffdf7",
    weight,
    opacity: emphasized ? 0.96 : 0.84,
    lineCap: "round",
    lineJoin: "round",
  };
}

function streetStrokeStyle(street, emphasized = false) {
  return {
    color: markerColor(street),
    weight: lineWeight(street) + (emphasized ? 1.8 : 0),
    opacity: emphasized ? 1 : 0.9,
    lineCap: "round",
    lineJoin: "round",
  };
}

function hitWeight() {
  return Math.max(18, lineWeight({ outageIds: [] }) + 12);
}

function mergedGeometryLines(street) {
  if (street.geometry._mergedLines) return street.geometry._mergedLines;
  const lines = (street.geometry.lines || [])
    .map(lineCoords)
    .map(cleanLine)
    .filter((line) => line.length > 1);
  street.geometry._mergedLines = mergeConnectedLines(lines);
  return street.geometry._mergedLines;
}

function mergeConnectedLines(lines) {
  const pending = lines.map((line) => [...line]);
  const merged = [];
  const tolerance = 0.000035;

  while (pending.length) {
    let current = pending.shift();
    let changed = true;

    while (changed) {
      changed = false;
      for (let index = 0; index < pending.length; index++) {
        const candidate = pending[index];
        const joined = joinLines(current, candidate, tolerance);
        if (!joined) continue;
        current = cleanLine(joined);
        pending.splice(index, 1);
        changed = true;
        break;
      }
    }

    merged.push(current);
  }

  return merged.sort((a, b) => b.length - a.length);
}

function joinLines(left, right, tolerance) {
  const leftFirst = left[0];
  const leftLast = left[left.length - 1];
  const rightFirst = right[0];
  const rightLast = right[right.length - 1];

  if (pointsClose(leftLast, rightFirst, tolerance)) return [...left, ...right.slice(1)];
  if (pointsClose(leftLast, rightLast, tolerance)) return [...left, ...[...right].reverse().slice(1)];
  if (pointsClose(leftFirst, rightLast, tolerance)) return [...right, ...left.slice(1)];
  if (pointsClose(leftFirst, rightFirst, tolerance)) return [...[...right].reverse(), ...left.slice(1)];
  return null;
}

function cleanLine(line) {
  const cleaned = [];
  for (const coord of line) {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || !pointsClose(previous, coord, 0.000001)) cleaned.push(coord);
  }
  return cleaned;
}

function pointsClose(a, b, tolerance) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

function clamp(value, min, max) {
  if (max < min) return value;
  return Math.min(max, Math.max(min, value));
}

function detailText(street) {
  const parts = [];
  if (street.postcode) parts.push(street.postcode);
  if (street.outageIds?.length) parts.push(`${street.outageIds.length} coupure${street.outageIds.length > 1 ? "s" : ""}`);
  if (street.estimatedRestoreAt) parts.push(`retour ${street.estimatedRestoreAt}`);
  if (hasGeometry(street)) parts.push("rue surlignee");
  else if (street.geocode?.status !== "ok") parts.push("non geocodee");
  return parts.join(" · ");
}

function popupHtml(street) {
  return `
    <div class="popup">
      <strong>${escapeHtml(street.label)}</strong>
      <span>${escapeHtml(detailText(street))}</span>
      <div>${street.outageTypes.map(tagHtml).join("")}</div>
    </div>
  `;
}

function tagHtml(type) {
  const className = type.includes("HTA") ? "hta" : type.includes("BT") ? "bt" : "other";
  return `<span class="tag ${className}">${escapeHtml(type.replace("Incident ", ""))}</span>`;
}

function buildStatusText(data) {
  const stats = data.stats || {};
  if (!stats.streets) return "Aucune rue touchee remontee par Enedis pour cette recherche.";
  if (stats.streetGeometry) {
    return `${formatNumber(stats.streetGeometry)} rues surlignees sur ${formatNumber(stats.streets)} rues remontees par Enedis`;
  }
  return `${formatNumber(stats.geocodedStreets)} rues placees sur ${formatNumber(stats.streets)} rues remontees par Enedis`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("fr-FR").format(Number(value || 0));
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
