/**
 * Reglas deterministas por proveedor.
 *
 * Los 5 proveedores que mandan facturas de verdad usan plantillas rígidas: el
 * numero de cuenta, el importe y el vencimiento estan siempre en el mismo
 * sitio y con la misma etiqueta. Se leen con expresiones regulares, sin IA.
 *
 * La IA queda SOLO para remitentes que no reconozcamos (lib/parser.js), y aun
 * ahi limitada a leer importe / vencimiento / cuenta.
 *
 * Cada regla devuelve:
 *   { kind, utility_type, account_last4, amount_due, due_date,
 *     service_address, unit, nickname, template }
 *
 * kind:
 *   'bill'    una factura a pagar
 *   'payment' confirmacion de pago -> marca como pagada la factura que case
 *   'noise'   no lleva informacion de facturacion
 */

// ── utilidades ───────────────────────────────────────────────────────────────

const MESES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Convierte a YYYY-MM-DD los formatos que usan los proveedores:
 *   "08/26/2026"  "8/12/2026"  "August 25, 2026"  "Aug. 19, 2026"
 * Devuelve null si no reconoce el formato (mejor sin fecha que con una inventada).
 */
export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const numerica = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numerica) {
    const [, m, d, y] = numerica;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const textual = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (textual) {
    const mes = MESES[textual[1].slice(0, 3).toLowerCase()];
    if (!mes) return null;
    return `${textual[3]}-${String(mes).padStart(2, '0')}-${String(textual[2]).padStart(2, '0')}`;
  }

  return null;
}

/** "$1,234.56" -> 1234.56 */
export function parseAmount(raw) {
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Ultimos 4 digitos de un numero de cuenta enmascarado.
 * Aguanta todas las formas que usan los proveedores:
 *   "Ending in 8625"  "******22085"  "2933798944"  "XXXXX-XX846-7"
 */
export function last4(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Convierte el HTML del email en texto plano de una sola linea. */
export function toText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ConEd escribe la unidad al final y a veces por duplicado:
 *   "472 9TH AVE FL 4 4FL"  ->  { address: '472 9TH AVE', unit: '4FL' }
 */
export function splitConEdAddress(raw) {
  if (!raw) return { address: null, unit: null };
  const s = String(raw).replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*?)\s+(?:FL|APT|UNIT|#)\s*[\w-]*\s*([\dA-Z]+(?:FL|[A-Z])?)$/i);
  if (m) return { address: m[1].trim(), unit: m[2].trim() };
  const simple = s.match(/^(.*?)\s+(?:FL|APT|UNIT|#)\s*([\w-]+)$/i);
  if (simple) return { address: simple[1].trim(), unit: simple[2].trim() };
  return { address: s || null, unit: null };
}

/** Separa "4750 Lincoln Blvd Apt 382 Marina Del Rey, CA 90292" en calle + unidad. */
export function splitServiceAddress(raw) {
  if (!raw) return { address: null, unit: null };
  const m = String(raw).match(/^(.*?)\s+(?:APT|UNIT|STE|SUITE|#)\s*([\w-]+)\b(.*)$/i);
  if (!m) return { address: String(raw).split(',')[0].trim() || null, unit: null };
  return { address: m[1].trim() || null, unit: m[2].trim() || null };
}

// ── proveedores ──────────────────────────────────────────────────────────────

const SPECTRUM = {
  name: 'Spectrum',
  utilityType: 'internet',
  matches: from => /spectrumemails\.com|exchange\.spectrum\.com|spectrumcustomersurvey/i.test(from),
  extract(text, subject) {
    // El correo de marketing y las encuestas nunca traen "Account Number:".
    const cuenta = text.match(/Account Number:\s*Ending in\s*(\d{4})/i)
                || text.match(/Account number ending in:\s*(\d{4})/i);

    // "Your Spectrum Statement is Ready" -> la factura
    const statement = text.match(/Statement Amount:\s*\$([\d,]+\.\d{2})/i);
    // "Your Payment Is Scheduled Soon" -> recordatorio de la misma factura
    const pago      = text.match(/Payment Amount:\s*\$([\d,]+\.\d{2})/i);

    if (!cuenta || (!statement && !pago)) return { kind: 'noise', template: 'spectrum/otro' };

    // "Thank You for Your Payment" es un pago YA hecho, no una factura por
    // pagar. Lleva el mismo campo "Payment Amount" que el recordatorio, asi
    // que hay que distinguirlo por el asunto.
    if (/thank you for your payment|payment (?:was )?(?:received|posted)/i.test(`${subject} ${text}`) && !statement) {
      return {
        kind: 'payment',
        utility_type: 'internet',
        account_last4: cuenta[1],
        amount_due: parseAmount(pago[1]),
        due_date: null,
        template: 'spectrum/pago-recibido',
      };
    }

    const fecha = text.match(/Auto Pay Date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
    const dir   = text.match(/Service Address:\s*(.+?)(?:\s+Choose Your Auto Pay|\s+-->|$)/i);
    const { address, unit } = splitServiceAddress(dir?.[1]);

    return {
      kind: 'bill',
      utility_type: 'internet',
      account_last4: cuenta[1],
      amount_due: parseAmount((statement || pago)[1]),
      due_date: parseDate(fecha?.[1]),
      service_address: address,
      unit,
      template: statement ? 'spectrum/statement' : 'spectrum/payment-scheduled',
    };
  },
};

const CONED = {
  name: 'ConEd',
  utilityType: 'electricity',
  matches: from => /coned\.com/i.test(from),
  extract(text, subject) {
    // "Thanks for Your Payment ... We got your payment for $117.87 and applied
    //  it to your account ending in 7417"
    const pago = text.match(/payment for\s*\$([\d,]+\.\d{2}).*?account ending in\s*(\d{4})/i);
    if (pago) {
      return {
        kind: 'payment',
        utility_type: 'electricity',
        account_last4: pago[2],
        amount_due: parseAmount(pago[1]),
        due_date: null,
        template: 'coned/pago-recibido',
      };
    }

    // "Your bill of $241.37 for your account ending in 7226 is ready|due on Aug. 19, 2026"
    const clasico = text.match(/bill of\s*\$([\d,]+\.\d{2})\s*for your account ending in\s*(\d{4})/i);
    if (clasico) {
      const vence = text.match(/is due on\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})/i);
      return {
        kind: 'bill',
        utility_type: 'electricity',
        account_last4: clasico[2],
        amount_due: parseAmount(clasico[1]),
        due_date: parseDate(vence?.[1]),
        template: 'coned/aviso',
      };
    }

    // Statement CONSOLIDADO: una tabla con N cuentas dentro del mismo email.
    //   Account ending in: Amount Due: Due Date: Address:
    //   XXXXX-XX741-7  -$226.12  08/18/2026  472 9TH AVE FL 4 4FL
    // A diferencia de la plantilla vieja, esta SI trae la direccion por linea.
    // Un importe negativo es saldo a favor, no una factura a pagar.
    if (/Account ending in:\s*Amount Due:/i.test(text)) {
      const filas = [...text.matchAll(
        /([X\d]+-[X\d]+-[X\d]+)\s+(-?)\$([\d,]+\.\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(.*?)(?=\s+[X\d]+-[X\d]+-[X\d]+\s|\s+View Bills|\s*$)/gi
      )];
      const vistas = new Map();
      for (const f of filas) {
        const cuenta = last4(f[1]);
        const importe = parseAmount(f[3]) * (f[2] === '-' ? -1 : 1);
        const vence = parseDate(f[4]);
        const clave = `${cuenta}|${importe}|${vence}`;
        if (!cuenta || vistas.has(clave)) continue;   // la plantilla repite filas
        const { address, unit } = splitConEdAddress(f[5]);
        vistas.set(clave, {
          kind: importe > 0 ? 'bill' : 'credit',
          utility_type: 'electricity',
          account_last4: cuenta,
          amount_due: Math.abs(importe),
          due_date: vence,
          service_address: address,
          unit,
          template: 'coned/consolidado',
        });
      }
      const items = [...vistas.values()];
      if (items.length) return { kind: 'multi', items, template: 'coned/consolidado' };
    }

    // Plantilla de domiciliacion:
    //   "Amount to be deducted $652.29 ... deducted from your bank on 08/27/2026
    //    Account number XXXXX-XX846-7"
    const domiciliado = text.match(/Amount to be deducted\s*\$([\d,]+\.\d{2})/i);
    if (domiciliado) {
      const cuenta = text.match(/Account number\s*([X\d-]{6,})/i);
      const vence  = text.match(/deducted from your bank on\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      return {
        kind: 'bill',
        utility_type: 'electricity',
        account_last4: last4(cuenta?.[1]),
        amount_due: parseAmount(domiciliado[1]),
        due_date: parseDate(vence?.[1]),
        template: 'coned/domiciliado',
      };
    }

    return { kind: 'noise', template: 'coned/otro' };
  },
};

const LADWP = {
  name: 'LADWP',
  utilityType: 'electricity',
  matches: from => /ladwp\.com/i.test(from),
  extract(text, subject) {
    // OJO: LADWP SI manda "tu factura esta lista". El sistema anterior daba por
    // hecho que no y trataba las confirmaciones de pago como si fueran facturas.
    //   "bill for account number 2933798944 is available ...
    //    Total Amount Due: $191.26  Payment Due Date: 8/12/2026"
    const factura = text.match(/account number\s*(\d{6,})\s*is available/i);
    if (factura) {
      const importe = text.match(/Total Amount Due:\s*\$([\d,]+\.\d{2})/i);
      const vence   = text.match(/Payment Due Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (importe) {
        return {
          kind: 'bill',
          utility_type: 'electricity',
          account_last4: last4(factura[1]),
          amount_due: parseAmount(importe[1]),
          due_date: parseDate(vence?.[1]),
          template: 'ladwp/factura',
        };
      }
    }

    // "Account Number: 2933798944 ... Payment Amount: $191.26"
    const cuenta = text.match(/Account Number:\s*(\d{6,})/i);
    const pagado = text.match(/Payment Amount:\s*\$([\d,]+\.\d{2})/i);
    if (cuenta && pagado) {
      return {
        kind: 'payment',
        utility_type: 'electricity',
        account_last4: last4(cuenta[1]),
        amount_due: parseAmount(pagado[1]),
        due_date: null,
        template: 'ladwp/pago-recibido',
      };
    }

    return { kind: 'noise', template: 'ladwp/otro' };
  },
};

const SCE = {
  name: 'SCE',
  utilityType: 'electricity',
  matches: from => /sce\.com|scewebservices\.com/i.test(from),
  extract(text, subject) {
    // "Account XXXXXXX63745 | Your Bill is Due Soon ...
    //  Amount Due $190.90  Due Date 08/26/2026"
    const importe = text.match(/Amount Due\s*\$([\d,]+\.\d{2})/i);
    if (!importe) return { kind: 'noise', template: 'sce/otro' };

    const cuenta = text.match(/Account\s+([X\d]{6,})/i);
    const vence  = text.match(/Due Date\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    return {
      kind: 'bill',
      utility_type: 'electricity',
      account_last4: last4(cuenta?.[1]),
      amount_due: parseAmount(importe[1]),
      due_date: parseDate(vence?.[1]),
      template: 'sce/factura',
    };
  },
};

const SOCALGAS = {
  name: 'SoCalGas',
  utilityType: 'gas',
  matches: from => /socalgas\.com|socalgas\.messages2\.com/i.test(from),
  extract(text, subject) {
    // El apodo del edificio y la unidad vienen SIEMPRE entre parentesis
    // detras del numero de cuenta: "Account Number ******22085 (JEFFERSON 269)".
    // El sistema anterior lo ignoraba y le preguntaba a la IA.
    // El enmascarado varia entre plantillas: "******22085", "*****44904",
    // "******XXX-XXX-4706". Se captura el bloque entero y last4() se queda con
    // los digitos.
    const cuenta = text.match(/Account Number[:\s]*([*X#\d-]{4,})\s*(?:\(([^)]+)\))?/i);
    const apodo  = cuenta?.[2]?.trim() || null;

    // "Total Balance $0.05 Credit due No Payment Required (Credit Balance)"
    // La factura llego y no hay nada que pagar. Es real, no es ruido: sirve
    // para saber que la cuenta sigue viva y que el email no se perdio.
    const favor = text.match(/Total Balance\s*\$([\d,]+\.\d{2})\s*Credit\s*due\s*No Payment Required/i);
    if (favor && cuenta) {
      return {
        kind: 'credit',
        utility_type: 'gas',
        account_last4: last4(cuenta[1]),
        amount_due: 0,
        credit_balance: parseAmount(favor[1]),
        due_date: null,
        nickname: apodo,
        template: 'socalgas/saldo-a-favor',
      };
    }

    // "Total Balance $30.57 due 09/02/2026"  -> la factura
    const saldo = text.match(/Total Balance\s*\$([\d,]+\.\d{2})\s*due\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (saldo && cuenta) {
      return {
        kind: 'bill',
        utility_type: 'gas',
        account_last4: last4(cuenta[1]),
        amount_due: parseAmount(saldo[1]),
        due_date: parseDate(saldo[2]),
        nickname: apodo,
        template: 'socalgas/factura',
      };
    }

    // "Payment Amount $1.28 ... Scheduled Payment Date 08/12/2026" -> domiciliacion.
    // Esto ES la factura para las cuentas en AutoPay: el importe real esta aqui.
    const domiciliado = text.match(/Payment Amount\s*\$([\d,]+\.\d{2})/i);
    if (domiciliado && cuenta) {
      const vence = text.match(/(?:Scheduled Payment Date|Payment Date)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      return {
        kind: 'bill',
        utility_type: 'gas',
        account_last4: last4(cuenta[1]),
        amount_due: parseAmount(domiciliado[1]),
        due_date: parseDate(vence?.[1]),
        nickname: apodo,
        template: 'socalgas/domiciliado',
      };
    }

    // Impago. La fecha viene con guiones o con barras segun la plantilla:
    //   "Past Due Amount $3174.09 due 07-20-2026"   (aviso final de corte)
    //   "Past Due Amount $3,180.77 due 08/14/2026"  (aviso de impago)
    const moroso = text.match(/Past Due Amount\s*\$([\d,]+\.\d{2})\s*due\s*(\d{1,2})[-/](\d{1,2})[-/](\d{4})/i);
    if (moroso && cuenta) {
      return {
        kind: 'bill',
        utility_type: 'gas',
        account_last4: last4(cuenta[1]),
        amount_due: parseAmount(moroso[1]),
        due_date: `${moroso[4]}-${moroso[2].padStart(2, '0')}-${moroso[3].padStart(2, '0')}`,
        nickname: apodo,
        past_due: true,
        template: 'socalgas/impago',
      };
    }

    return { kind: 'noise', template: 'socalgas/otro' };
  },
};

const TMOBILE = {
  name: 'T-Mobile',
  utilityType: 'internet',
  matches: from => /t-mobile\.com/i.test(from),
  extract(text) {
    // "Account: XXXXX4780 Payment received: $61.00 on 08/13/2026"
    const pago = text.match(/Payment received:\s*\$([\d,]+\.\d{2})\s*on\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (pago) {
      const cuenta = text.match(/Account:\s*([X\d]{4,})/i);
      return {
        kind: 'payment',
        utility_type: 'internet',
        account_last4: last4(cuenta?.[1]),
        amount_due: parseAmount(pago[1]),
        due_date: null,
        template: 'tmobile/pago-recibido',
      };
    }

    const importe = text.match(/(?:Amount due|Total due|Your bill(?: is)?)\s*\$?([\d,]+\.\d{2})/i);
    if (!importe) return { kind: 'noise', template: 'tmobile/otro' };
    const cuenta = text.match(/(?:Account|line ending in)\D{0,12}(\d{4})\b/i);
    return {
      kind: 'bill',
      utility_type: 'internet',
      account_last4: cuenta?.[1] || null,
      amount_due: parseAmount(importe[1]),
      due_date: null,
      template: 'tmobile/factura',
    };
  },
};

export const PROVIDERS = [SPECTRUM, CONED, LADWP, SCE, SOCALGAS, TMOBILE];

/** Devuelve el proveedor que corresponde al remitente, o null. */
export function findProvider(from) {
  if (!from) return null;
  return PROVIDERS.find(p => p.matches(from)) || null;
}

/**
 * Lee un email de un proveedor conocido. Devuelve null si el remitente no es
 * de ninguno de ellos — ese caso va a la IA de reserva.
 */
export function extractBill(email) {
  const provider = findProvider(email.from || '');
  if (!provider) return null;

  const text = toText(email.body || email.snippet || '');
  const out  = provider.extract(text, email.subject || '');

  // Una factura sin importe o sin cuenta no sirve: la tratamos como ruido para
  // no meter filas a medias. Es preferible una factura ausente y visible en el
  // panel de esperadas que una factura inventada.
  if (out.kind === 'bill' && (!out.amount_due || !out.account_last4)) {
    return { ...out, kind: 'noise', template: `${out.template}/incompleto` };
  }
  if ((out.kind === 'credit' || out.kind === 'payment') && !out.account_last4) {
    return { ...out, kind: 'noise', template: `${out.template}/incompleto` };
  }

  return { provider: provider.name, ...out };
}
