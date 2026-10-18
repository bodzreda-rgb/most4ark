import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Default marker icons (bundlers break Leaflet's automatic icon path detection)
const icon = L.divIcon({
  className: '', iconSize: [28, 28], iconAnchor: [14, 28],
  html: '<div style="font-size:26px;line-height:26px">📍</div>',
});

/** Click to choose a point. No continuous device location is collected; "use my location" is an explicit one-shot action. */
export default function MapPicker({ lat, lng, onPick, height = 260 }) {
  const el = useRef(null);
  const state = useRef({ map: null, marker: null });

  useEffect(() => {
    const center = lat != null && lng != null ? [lat, lng] : [30.0444, 31.2357];   // Cairo
    const map = L.map(el.current, { zoomControl: true }).setView(center, lat != null ? 15 : 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    state.current.map = map;
    if (lat != null && lng != null) state.current.marker = L.marker(center, { icon }).addTo(map);
    map.on('click', (e) => onPick(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))));
    setTimeout(() => map.invalidateSize(), 50);
    return () => { map.remove(); state.current = { map: null, marker: null }; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const { map, marker } = state.current;
    if (!map) return;
    if (lat == null || lng == null) { if (marker) { marker.remove(); state.current.marker = null; } return; }
    if (marker) marker.setLatLng([lat, lng]);
    else state.current.marker = L.marker([lat, lng], { icon }).addTo(map);
    map.setView([lat, lng], Math.max(map.getZoom(), 15));
  }, [lat, lng]);

  return <div ref={el} style={{ height, borderRadius: 12, border: '1px solid var(--border)', zIndex: 0 }} role="application" aria-label="map" />;
}
