// Visual identity per kind — colour AND glyph (never colour alone).
export const EVENT_KINDS = {
  hearing:          { icon: '⚖️', color: 'var(--k-hearing)' },
  appointment:      { icon: '👥', color: 'var(--k-appointment)' },
  task:             { icon: '✔',  color: 'var(--k-task)' },
  payment_deadline: { icon: '💰', color: 'var(--k-payment_deadline)' },
  case_deadline:    { icon: '⏳', color: 'var(--k-case_deadline)' },
  personal:         { icon: '👤', color: 'var(--k-personal)' },
};
export const EDITABLE_KINDS = ['hearing', 'appointment', 'case_deadline', 'payment_deadline', 'personal'];

export function mapsLinks(lat, lng) {
  if (lat == null || lng == null) return null;
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`,
    geo: `geo:${lat},${lng}`,
  };
}
