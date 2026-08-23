/**
 * Registro de cuentas: (tipo de servicio, account_last4) -> propiedad + unidad.
 *
 * El principio del reset: el numero de cuenta ES la identidad. La propiedad de
 * una factura no se deduce leyendo el email, se mira aqui.
 *
 * Dos formas de la direccion, y no hay que confundirlas:
 *   property_address  forma CANONICA — solo la calle, en mayusculas. Es la
 *                     clave con la que se agrupan las facturas.
 *   display_address   lo que ve Jake — direccion completa, con ciudad.
 *
 * Convive con lib/address-normalize.js, que hace matching difuso para el
 * cotejo con QuickBooks; este se limita a producir la forma canonica.
 */

const STREET_ABBR = [
  [/\bAVENUE\b/g, 'AVE'], [/\bSTREET\b/g, 'ST'], [/\bBOULEVARD\b/g, 'BLVD'],
  [/\bROAD\b/g, 'RD'], [/\bDRIVE\b/g, 'DR'], [/\bPLACE\b/g, 'PL'],
  [/\bCOURT\b/g, 'CT'], [/\bLANE\b/g, 'LN'], [/\bTERRACE\b/g, 'TER'],
  // Direccionales: "439 West 51st Street" y "439 W 51st St" son la misma calle.
  [/\bNORTH\b/g, 'N'], [/\bSOUTH\b/g, 'S'], [/\bEAST\b/g, 'E'], [/\bWEST\b/g, 'W'],
];

// Terminaciones de tipo de via. Sirven para saber donde acaba la calle y
// empieza la ciudad cuando el remitente no pone comas.
const SUFIJOS = /\b(AVE|ST|BLVD|RD|DR|PL|CT|LN|TER|WAY|CIR|PKWY)$/;

// Ciudades que aparecen en los datos de Edonis. Solo se recortan al FINAL y
// solo si lo que queda sigue terminando en tipo de via, para no estropear
// "620 SANTA MONICA BLVD".
const CIUDADES = [
  'MARINA DEL REY', 'MARINA DEL RAY', 'WEST HOLLYWOOD', 'W HOLLYWOOD',
  'SANTA MONICA', 'BEVERLY HILLS', 'PALM SPRINGS', 'LOS ANGELES', 'NEW YORK',
];

/**
 * Forma canonica de una direccion: solo la calle, en mayusculas, con las
 * abreviaturas unificadas. Es la CLAVE con la que se agrupan las facturas,
 * no lo que se le enseña a nadie.
 *
 * Aguanta las tres formas en que llegan las direcciones:
 *   "1420 5th St, Santa Monica, CA 90401"      -> 1420 5TH ST
 *   "4250 Glencoe Ave Marina del Rey CA 90292" -> 4250 GLENCOE AVE
 *   "439 West 51st Street, New York, NY 10019" -> 439 W 51ST ST
 */
export function normAddress(raw) {
  if (!raw) return null;
  let s = String(raw).split(',')[0];
  s = s.toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of STREET_ABBR) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ').trim();

  // Sin comas, la ciudad / estado / codigo postal se pegan a la calle. Se
  // quitan de fuera hacia dentro: primero el codigo postal, luego el estado,
  // luego la ciudad.
  s = s.replace(/\s+\d{5}(-\d{4})?$/, '').trim();

  // Estado de dos letras. OJO: "ST" tambien son dos letras y es tipo de via,
  // asi que solo se quita si NO es un sufijo de calle.
  const ultimo = s.split(' ').pop();
  if (/^[A-Z]{2}$/.test(ultimo) && !SUFIJOS.test(ultimo)) {
    s = s.slice(0, -(ultimo.length + 1)).trim();
  }

  for (const ciudad of CIUDADES) {
    if (s.endsWith(' ' + ciudad)) {
      const resto = s.slice(0, -(ciudad.length + 1)).trim();
      if (SUFIJOS.test(resto)) { s = resto; break; }
    }
  }

  return s || null;
}

/**
 * Normaliza un designador de unidad: "Apt 607", "#607", "607 " -> "607".
 * Conserva los designadores de NYC tal cual ("3FL", "4D", "2W").
 */
export function normUnit(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).toUpperCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(APARTMENT|APT|UNIT|STE|SUITE)\s*/, '').trim();
  if (!s || s === '-' || s === 'NULL') return null;
  return s;
}

/**
 * Elige, entre todas las grafias vistas de una misma propiedad, la que se le
 * enseña a Jake. Prefiere por este orden:
 *   1. que lleve ciudad (tiene coma)
 *   2. que no este entera en mayusculas
 *   3. que conserve el tipo de via ("175 W 107th St" gana a "175 W 107th")
 *   4. la mas repetida, y a igualdad la mas larga
 *
 * `variantes` es [{ text, count }, ...]
 */
export function pickDisplayAddress(variantes) {
  const puntua = ({ text }) => {
    // Una direccion bien puesta lleva dos comas: "calle, ciudad, ST 00000".
    const comas     = Math.min((text.match(/,/g) || []).length, 2) * 3;
    const mixta     = text !== text.toUpperCase() ? 2 : 0;
    const conSufijo = SUFIJOS.test(normAddress(text) || '') ? 1 : 0;
    return comas + mixta + conSufijo;
  };
  return [...variantes]
    .sort((a, b) => puntua(b) - puntua(a) || b.count - a.count || b.text.length - a.text.length)
    [0]?.text || null;
}

/** Clave canonica de una cuenta. */
export const accountKey = (utilityType, last4) => `${utilityType}|${last4}`;

/** Niveles de confianza en los que confiamos para asignar propiedad sin preguntar. */
export const CONFIABLES = ['solida', 'mayoria', 'manual'];

/**
 * Carga el registro entero en memoria como Map. Son ~114 filas: cabe de sobra,
 * y evita una consulta por factura (el matcher viejo hacia justo eso).
 */
export async function loadRegistry(pool, { soloConfiables = true } = {}) {
  const { rows } = await pool.query(
    `select utility_type, account_last4, provider, property_address, display_address,
            unit, confidence, locked, typical_amount
       from account_registry
      where property_address is not null
        ${soloConfiables ? `and confidence = any($1)` : ''}`,
    soloConfiables ? [CONFIABLES] : []
  );
  return new Map(rows.map(r => [accountKey(r.utility_type, r.account_last4), r]));
}

/**
 * Resuelve la propiedad de una factura. Devuelve null si la cuenta no esta en
 * el registro o no es de fiar: en ese caso la factura cae en "Unassigned" para
 * que Jake la resuelva UNA vez, y a partir de ahi queda fijada.
 */
export function resolveAccount(registry, utilityType, last4) {
  if (!last4) return null;
  return registry.get(accountKey(utilityType, last4)) || null;
}
