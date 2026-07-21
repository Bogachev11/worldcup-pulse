// stage13 — team-abbreviation → flag CDN URL. Extracted VERBATIM from stage13.js.
// Pure lookup table + accessor; no coupling to render state.

export const FLAG = {
  MEX: 'mx', SAF: 'za', SKO: 'kr', CZE: 'cz', CAN: 'ca', BAN: 'ba', QAT: 'qa',
  SWI: 'ch', BRA: 'br', MOR: 'ma', USA: 'us', PAR: 'py', HAI: 'ht', SCO: 'gb-sct',
  GER: 'de', CUR: 'cw', NET: 'nl', JAP: 'jp', AUS: 'at', TUR: 'tr', ICO: 'ci',
  ECU: 'ec', BEL: 'be', EGY: 'eg', SPA: 'es', CVE: 'cv', SAR: 'sa', URU: 'uy',
  SWE: 'se', TUN: 'tn', IRA: 'iq', NZE: 'nz', FRA: 'fr', SEN: 'sn', NOR: 'no',
  JOR: 'jo', ARG: 'ar', ALG: 'dz', ENG: 'gb-eng', CRO: 'hr', POR: 'pt',
  DCO: 'cd', UZB: 'uz', COL: 'co', GHA: 'gh', PAN: 'pa',
};

// Some abbreviations collide across teams (AUS is used for BOTH Australia and
// Austria in the source data). When a team NAME is known, resolve by name first so
// the two never share a flag: Australia → au, Austria → at.
const FLAG_BY_NAME = {
  australia: 'au',
  austria: 'at',
};

// Flags are LOCAL, bundled assets (public/flags/<code>.png — flagcdn w320 rasters,
// ~0.2–5KB each, visually identical at the 13–26px display size). Serving them from
// the SAME origin as the site (instead of the flagcdn.com CDN, whose detailed SVGs run
// up to ~143KB and add DNS+TLS+N external round-trips) makes them appear instantly on
// mobile and lets them cache with the rest of the site.
export function flagSrc(abbr, name) {
  if (name) {
    const byName = FLAG_BY_NAME[String(name).trim().toLowerCase()];
    if (byName) return `/flags/${byName}.png`;
  }
  const code = FLAG[abbr];
  return code ? `/flags/${code}.png` : '';
}
