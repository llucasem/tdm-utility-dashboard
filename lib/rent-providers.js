/**
 * Reglas deterministas para los portales de RENTA (paso 5 del plan).
 *
 * El gemelo de lib/providers.js aplicado al otro circuito: los 7 portales por
 * los que Edonis paga alquileres mandan confirmaciones con plantilla rigida.
 * Se leen con expresiones regulares — la IA (lib/rent-parser.js) queda de
 * reserva para remitentes que no reconozcamos.
 *
 * Por que existe: el circuito de rentas dependia de Claude para CADA email, y
 * el 1/8/2026 la cuenta se quedo sin credito y 12 rentas de fin de mes se
 * atascaron en silencio. Una regla fija no se queda sin credito.
 *
 * Cada regla devuelve:
 *   { kind:'rent_payment', amount_paid, paid_date, confirmation_number,
 *     landlord, payment_portal, property_address?, unit?, template }
 *   { kind:'noise', template }   remitente de portal sin datos de pago
 *   null                         remitente desconocido -> IA de reserva
 */
import { parseDate, parseAmount, toText } from './providers.js';

/**
 * Limpia el designador de unidad tal como llega de los portales:
 *   "Unit#140"    -> 140      "1 - 306-PR" -> 306
 *   "1420-501"    -> 501      "306-PR"     -> 306
 * El prefijo de 3-4 digitos es el numero del edificio/calle pegado; el sufijo
 * de letras tras el guion es coletilla del portal, no parte de la unidad.
 */
export function cleanRentUnit(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/^(?:unit|apt|apartment|ste|suite)?\s*#?\s*/i, '').trim();
  // Entrata a veces arrastra lo que sigue en la linea ("306-PR NAME: SUGEY
  // FLORES", "306-PR -"). Se corta en la primera ETIQUETA en mayusculas
  // seguida de dos puntos, y se limpian separadores sueltos del final.
  // OJO: no vale quedarse con el primer token — "1 - 306-PR" lleva espacios
  // dentro y es una sola unidad.
  s = s.split(/\s+[A-Z][A-Za-z]*\s*:/)[0].replace(/[\s,:;-]+$/, '').trim();
  const pref = s.match(/^(\d{1,4})\s*-\s*(.+)$/);
  if (pref && /\d/.test(pref[2]) && (pref[1].length === 1 || pref[1].length >= 3)) s = pref[2].trim();
  s = s.replace(/-[A-Za-z]{2,}$/, '').trim();
  return s.toUpperCase() || null;
}

const dinero = (t, re) => { const m = t.match(re); return m ? parseAmount(m[1]) : null; };

const PORTALES = [
  {
    portal: 'AppFolio',
    matches: f => /appfolio\.com/i.test(f),
    extract(t, subject) {
      // "Thank you for your automatic payment of $3,150.00 on 09/01/2026.
      //  Your confirmation number is FA56-E460."
      const pago = t.match(/payment of\s*\$([\d,]+\.\d{2})\s*on\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (!pago) return { kind: 'noise', template: 'appfolio/otro' };
      return {
        kind: 'rent_payment',
        amount_paid: parseAmount(pago[1]),
        paid_date: parseDate(pago[2]),
        confirmation_number: t.match(/confirmation number is\s*([A-Z0-9-]+)/i)?.[1] ?? null,
        // El landlord viene en el asunto: "6th ST. Lofts, LLC - Online Payment..."
        landlord: subject?.split(' - ')[0]?.trim() || null,
        template: 'appfolio/confirmacion',
      };
    },
  },
  {
    portal: 'Bilt',
    matches: f => /biltrewards\.com|bilt\.com/i.test(f),
    extract(t) {
      // Dos plantillas:
      //   "Your payment of $1.00 for VRS Portofino LLC is processing."
      //   "Your payment of $5,019.93 is processing. ... Payment Amount: $X
      //    - Transaction ID: uuid"   (la automatica: SIN landlord en el cuerpo;
      //    lo resuelve el mapa de alias por buzon)
      const txid = t.match(/Transaction ID:\s*([a-f0-9-]{8,})/i)?.[1] ?? null;
      // Sin Transaction ID, "rent payment of $X" ya identifica un pago real
      // (Bilt tiene una plantilla asi). El marketing habla de puntos, no de
      // "rent payment of".
      const fraseRenta = /(?:rent payment|payment) of\s*\$[\d,]+\.\d{2}/i.test(t);
      const conLandlord = t.match(/payment of\s*\$([\d,]+\.\d{2})\s*for\s+(.+?)\s+(?:is|was|has been)/i);
      const importe = conLandlord
        ? parseAmount(conLandlord[1])
        : (dinero(t, /(?:Total\s+)?Payment\s+[Aa]mount:\s*\$([\d,]+\.\d{2})/)
           ?? dinero(t, /payment of\s*\$([\d,]+\.\d{2})\s*is processing/i)
           // "...on your automatic rent payment of $3,873.08" / "on your payment of $X"
           ?? dinero(t, /payment of\s*\$([\d,]+\.\d{2})/i)
           // "- Amount: $4,840.97"
           ?? dinero(t, /\bAmount:\s*\$([\d,]+\.\d{2})/i));
      // El marketing de Bilt tambien menciona dolares: sin Transaction ID ni
      // frase de pago, es ruido.
      if (!importe || (!txid && !conLandlord && !fraseRenta)) {
        return { kind: 'noise', template: 'bilt/otro' };
      }
      return {
        kind: 'rent_payment',
        amount_paid: importe,
        paid_date: null,                       // Bilt no fecha el pago: se usa la del email
        confirmation_number: txid,
        landlord: conLandlord?.[2]?.trim() ?? null,
        template: conLandlord ? 'bilt/confirmacion' : 'bilt/automatica',
      };
    },
  },
  {
    portal: 'ClickPay',
    matches: f => /clickpay\.com/i.test(f),
    extract(t) {
      // "Your payment of $2,717.23 for 312 E 93RD Street, #3A, NEW YORK, NY"
      const pago = t.match(/payment of\s*\$([\d,]+\.\d{2})\s*for\s+(.+?)\s+is being processed/i);
      if (!pago) return { kind: 'noise', template: 'clickpay/otro' };
      const lugar = pago[2].match(/^(.*?),\s*#?\s*([\w-]+),/);
      return {
        kind: 'rent_payment',
        amount_paid: parseAmount(pago[1]),
        paid_date: parseDate(t.match(/Payment date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]),
        confirmation_number: t.match(/Confirmation Number:\s*([\w\\_-]+)/i)?.[1]?.replace(/\\/g, '') ?? null,
        landlord: t.match(/please contact\s+(.+?)\.\s/i)?.[1] ?? null,
        property_address: lugar ? lugar[1].trim() : pago[2].trim(),
        unit: lugar ? cleanRentUnit(lugar[2]) : null,
        template: 'clickpay/confirmacion',
      };
    },
  },
  {
    portal: 'Entrata',
    matches: f => /entrata\.com/i.test(f),
    extract(t, subject) {
      // "AUTHORIZATION CODE: 1841240368 ... PAYMENT DATE: Sep 01, 2026 ...
      //  Unit: 1 - 306-PR 1548 6th Street, Santa Monica, CA 90401 ...
      //  Payment Amount: $4,526.08"
      // El total aparece con dos nombres segun la plantilla:
      //   "Payment Amount: $4,526.08"
      //   "Purchase Summary Total Amount: $4,465.43"
      const importe = dinero(t, /Payment Amount:\s*\$([\d,]+\.\d{2})/i)
                   ?? dinero(t, /Total Amount:\s*\$([\d,]+\.\d{2})/i);
      if (!importe) return { kind: 'noise', template: 'entrata/otro' };
      // Tres variantes de la misma linea:
      //   "Unit: 1 - 306-PR 1548 6th Street, ..."            (pegada)
      //   "Unit: 1420 - 501 Address: 1420 5th St Apt 501..." (con etiqueta)
      //   "Unit: 1420 - 501, 1420 5th St Apt 501..."         (con coma)
      // Con etiqueta o coma, el corte es claro. En la pegada, la direccion
      // exige que la palabra tras el numero LLEVE letra ("6th", "5th") — asi
      // ni "306-PR" ni un "501" suelto pueden arrancarla.
      const DIR = /(\d+\s+(?=\w*[a-z])\w+[^,]*,[^,]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/;
      const unidad =
        t.match(new RegExp(/Unit:\s*(.+?)\s*(?:,|Address:)\s*/.source + DIR.source, 'i'))
        // Otra variante intercala "NAME: ..." entre la unidad y la direccion.
        || t.match(/Unit:\s*(.+?)\s+NAME:/i)
        || t.match(new RegExp(/Unit:\s*(.+?)\s+/.source + DIR.source, 'i'));
      return {
        kind: 'rent_payment',
        amount_paid: importe,
        paid_date: parseDate(t.match(/PAYMENT DATE:\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})/i)?.[1]),
        confirmation_number: t.match(/AUTHORIZATION CODE:\s*(\w+)/i)?.[1] ?? null,
        landlord: subject?.match(/.*for\s+(.+)$/i)?.[1]?.trim() ?? null,
        property_address: unidad?.[2]?.trim() ?? null,
        unit: unidad ? cleanRentUnit(unidad[1]) : null,
        template: 'entrata/recibo',
      };
    },
  },
  {
    portal: 'Paymentus',
    matches: f => /paymentus\.com/i.test(f),
    extract(t) {
      // "Payment amount: 4,379.15" (sin $) · "Payment date: Sep 01, 2026"
      // La unidad viaja dentro del numero de cuenta: "CG18756760-CA120-004-4522-3"
      const importe = dinero(t, /Payment amount:\s*\$?([\d,]+\.\d{2})/i);
      if (!importe) return { kind: 'noise', template: 'paymentus/otro' };
      const cuenta = t.match(/Account number:\s*([\w-]+)/i)?.[1] ?? null;
      const unidad = cuenta?.match(/-0*(\d{3,4})-\d$/)?.[1] ?? null;
      return {
        kind: 'rent_payment',
        amount_paid: importe,
        paid_date: parseDate(t.match(/Payment date:\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})/i)?.[1]),
        confirmation_number: t.match(/Confirmation number:\s*(\w+)/i)?.[1] ?? null,
        landlord: t.match(/payment with\s+(.+?)(?:\s+Biller)?[.,\s]/i)?.[1] ?? null,
        unit: unidad,
        template: 'paymentus/confirmacion',
      };
    },
  },
  {
    portal: 'RentCafe',
    matches: f => /rentcafe\.com/i.test(f),
    extract(t) {
      const importe = dinero(t, /Payment Amount:\s*\$([\d,]+\.\d{2})/i);
      if (!importe) return { kind: 'noise', template: 'rentcafe/otro' };
      return {
        kind: 'rent_payment',
        amount_paid: importe,
        paid_date: null,                       // RentCafe tampoco fecha: la del email
        confirmation_number: t.match(/Confirmation Number:\s*(\w+)/i)?.[1] ?? null,
        landlord: null,                        // lo resuelve el mapa de alias
        template: 'rentcafe/confirmacion',
      };
    },
  },
  {
    portal: 'WelcomeHome',
    matches: f => /welcomehome\.com/i.test(f),
    extract(t) {
      // "Thanks for your payment to Jefferson at Marina Del Rey for Unit#140
      //  ... Payment Date: 8/1/2026 Payment Amount: $5,285.41"
      const pago = t.match(/payment to\s+(.+?)\s+for\s+Unit\s*#?\s*([\w-]+)/i);
      const importe = dinero(t, /Payment Amount:\s*\$([\d,]+\.\d{2})/i);
      if (!importe) return { kind: 'noise', template: 'welcomehome/otro' };
      return {
        kind: 'rent_payment',
        amount_paid: importe,
        paid_date: parseDate(t.match(/Payment Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]),
        confirmation_number: t.match(/Confirmation\s*#?:\s*(\w+)/i)?.[1] ?? null,
        landlord: pago?.[1]?.trim() ?? null,
        unit: pago ? cleanRentUnit(pago[2]) : null,
        template: 'welcomehome/confirmacion',
      };
    },
  },
];

/**
 * Lee un email de un portal de renta conocido. Devuelve null si el remitente
 * no es de ninguno — ese caso va a la IA de reserva (lib/rent-parser.js).
 */
export function extractRentPayment(email) {
  const from = (email.fromEmail || email.from || '').toLowerCase();
  const portal = PORTALES.find(p => p.matches(from));
  if (!portal) return null;

  // Entrata envuelve las etiquetas en asteriscos de markdown
  // ("**Payment Date**: ..."); se quitan antes de aplicar las reglas.
  const texto = toText(email.content || email.htmlContent || '').replace(/\*+/g, '');
  const out = portal.extract(texto, email.subject || '');

  // Un pago sin importe no sirve: mejor ruido visible que un pago a medias.
  if (out.kind === 'rent_payment' && !(out.amount_paid > 0)) {
    return { ...out, kind: 'noise', template: `${out.template}/incompleto` };
  }
  return { payment_portal: portal.portal, ...out };
}
