/**
 * Address normalizer — collapses common US street address variants into a
 * single comparable form so "175 W 107th, NY 10025" and
 * "175 W 107th St, New York, NY 10025" compare equal.
 *
 * Used by the QB class linker to match bills against property mappings.
 */

const ABBREVIATIONS = [
  // suffix         canonical
  ['street',        'st'],
  ['avenue',        'ave'],
  ['boulevard',     'blvd'],
  ['road',          'rd'],
  ['drive',         'dr'],
  ['lane',          'ln'],
  ['place',         'pl'],
  ['court',         'ct'],
  ['parkway',       'pkwy'],
  ['highway',       'hwy'],
  ['terrace',       'ter'],
  ['way',           'wy'],
  // directionals
  ['west',          'w'],
  ['east',          'e'],
  ['north',         'n'],
  ['south',         's'],
];

/**
 * Normalize an address for matching purposes.
 *
 *   "175 W 107th, New York, NY 10025"
 *      → "175 w 107th"
 *   "175 West 107th Street, NY 10025"
 *      → "175 w 107th st"  (after replacement → "175 w 107th st")
 *   "3221 Carter Avenue"
 *      → "3221 carter ave"
 *   "3221 Carter Ave, Marina Del Rey, CA 90292"
 *      → "3221 carter ave"
 *
 * Drops everything after the first comma (city/state/zip) then collapses
 * abbreviations to their short form.
 */
export function normalizeAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  let s = addr.toLowerCase().split(',')[0].trim();

  // Collapse multiple spaces to single
  s = s.replace(/\s+/g, ' ');

  // Drop trailing periods on tokens (St. → St)
  s = s.replace(/\.(\s|$)/g, '$1');

  // Replace long forms with abbreviations, surrounded by word boundaries
  for (const [long, short] of ABBREVIATIONS) {
    s = s.replace(new RegExp(`\\b${long}\\b`, 'g'), short);
  }

  return s.trim();
}

/**
 * Normalize a unit identifier.
 *
 *   "Apt 3", "#3", "3", "apt. 3", "Unit 3" → "3"
 *   "3B", "Apt 3B" → "3b"
 */
export function normalizeUnit(unit) {
  if (!unit || typeof unit !== 'string') return '';
  return unit
    .toLowerCase()
    .replace(/^apt\.?\s*/, '')
    .replace(/^unit\s*/, '')
    .replace(/^suite\s*/, '')
    .replace(/^ste\.?\s*/, '')
    .replace(/^#\s*/, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Compare two addresses (true if they match after normalization).
 *
 * Comma-less variants keep city/state/zip glued to the street part
 * ("4250 Glencoe Ave Marina del Rey CA 90292"), so plain equality never
 * matched them against "4250 Glencoe Ave, Marina Del Rey, CA 90292".
 * Accept a prefix match on a word boundary to cover that case.
 */
export function addressesMatch(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(nb + ' ') || nb.startsWith(na + ' ');
}

/**
 * Compare a property+unit pair.
 */
export function propertyMatches(a, b) {
  if (!a || !b) return false;
  return addressesMatch(a.property_address, b.property_address)
      && normalizeUnit(a.unit) === normalizeUnit(b.unit);
}
