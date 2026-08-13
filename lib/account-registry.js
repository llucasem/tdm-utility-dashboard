/**
 * Registro de cuentas: (tipo de servicio, account_last4) -> propiedad + unidad.
 *
 * El principio del reset: el numero de cuenta ES la identidad. La propiedad de
 * una factura no se deduce leyendo el email, se mira aqui.
 *
 * Este modulo es la unica fuente de normalizacion de direcciones y unidades.
 * Sustituye a lib/address-normalize.js, que se comia los tokens direccionales
 * y convertia "507 WILSHIRE BLVD" en "507 WIL HIRE BLVD".
 */

const STREET_ABBR = [
  [/\bAVENUE\b/g, 'AVE'], [/\bSTREET\b/g, 'ST'], [/\bBOULEVARD\b/g, 'BLVD'],
  [/\bROAD\b/g, 'RD'], [/\bDRIVE\b/g, 'DR'], [/\bPLACE\b/g, 'PL'],
  [/\bCOURT\b/g, 'CT'], [/\bLANE\b/g, 'LN'], [/\bTERRACE\b/g, 'TER'],
];

/**
 * Normaliza una direccion a su forma canonica: solo la calle, en mayusculas,
 * con las abreviaturas unificadas. Los tokens direccionales (N/S/E/W) se dejan
 * intactos a proposito.
 */
export function normAddress(raw) {
  if (!raw) return null;
  let s = String(raw).split(',')[0];
  s = s.toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of STREET_ABBR) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim() || null;
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
    `select utility_type, account_last4, provider, property_address, unit,
            confidence, locked, typical_amount
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
