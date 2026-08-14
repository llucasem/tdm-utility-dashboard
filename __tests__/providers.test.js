import { describe, it, expect } from 'vitest';
import { extractBill, parseDate, parseAmount, last4, splitServiceAddress } from '../lib/providers.js';

// Los textos de abajo son emails REALES del buzon de Edonis, leidos el
// 14/08/2026 y recortados. Si un proveedor cambia de plantilla, estos tests
// fallan y nos enteramos ANTES de perder facturas — que es justo lo que paso
// con SoCalGas y LADWP en el sistema anterior.

const email = (from, subject, body) => ({ from, subject, body, snippet: '' });

describe('utilidades', () => {
  it('parsea las fechas de los 5 proveedores', () => {
    expect(parseDate('08/26/2026')).toBe('2026-08-26');
    expect(parseDate('8/12/2026')).toBe('2026-08-12');
    expect(parseDate('August 25, 2026')).toBe('2026-08-25');
    expect(parseDate('Aug. 19, 2026')).toBe('2026-08-19');
    expect(parseDate('el martes')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });

  it('parsea importes con separador de miles', () => {
    expect(parseAmount('$3,174.09')).toBe(3174.09);
    expect(parseAmount('190.90')).toBe(190.9);
    expect(parseAmount(null)).toBeNull();
  });

  it('saca los ultimos 4 digitos de cualquier formato enmascarado', () => {
    expect(last4('Ending in 8625')).toBe('8625');
    expect(last4('******22085')).toBe('2085');
    expect(last4('2933798944')).toBe('8944');
    expect(last4('XXXXX-XX846-7')).toBe('8467');   // ConEd parte los digitos
    expect(last4('XXXXXXX63745')).toBe('3745');
    expect(last4('12')).toBeNull();
  });

  it('separa calle y unidad de la Service Address', () => {
    expect(splitServiceAddress('4750 Lincoln Blvd Apt 382 Marina Del Rey, CA 90292'))
      .toEqual({ address: '4750 Lincoln Blvd', unit: '382' });
    expect(splitServiceAddress('939 S Broadway Apt 508 Los Angeles, CA 90015'))
      .toEqual({ address: '939 S Broadway', unit: '508' });
  });
});

describe('Spectrum', () => {
  it('lee el statement, con direccion y unidad incluidas', () => {
    const r = extractBill(email('Spectrum <myaccount@spectrumemails.com>', 'Your Spectrum Statement is Ready',
      `Your Account at a Glance Account Number: Ending in 8625 Statement Amount: $79.99
       Auto Pay Date: August 25, 2026 Service Address: 4750 Lincoln Blvd Apt 382 Marina Del Rey, CA 90292
       --> Choose Your Auto Pay Date`));
    expect(r.kind).toBe('bill');
    expect(r.account_last4).toBe('8625');
    expect(r.amount_due).toBe(79.99);
    expect(r.due_date).toBe('2026-08-25');
    expect(r.service_address).toBe('4750 Lincoln Blvd');
    expect(r.unit).toBe('382');
  });

  it('lee el recordatorio de domiciliacion', () => {
    const r = extractBill(email('Spectrum <myaccount@spectrumemails.com>', 'Your Payment Is Scheduled Soon',
      `Your Payment Details Account Number: Ending in 9786 Payment Amount: $60.00
       Auto Pay Date: August 18, 2026 Payment Method: Card Ending in 8197
       Service Address: 939 S Broadway Apt 508 Los Angeles, CA 90015`));
    expect(r.kind).toBe('bill');
    expect(r.account_last4).toBe('9786');
    expect(r.amount_due).toBe(60);
    expect(r.unit).toBe('508');
  });

  it('descarta el codigo de verificacion y el aviso de inicio de sesion', () => {
    expect(extractBill(email('Spectrum <myaccount@spectrumemails.com>', 'Your Verification Code',
      'Your Spectrum verification code is 966591 . This code expires in 15 minutes.')).kind).toBe('noise');

    expect(extractBill(email('Spectrum <myaccount@spectrumemails.com>', 'There was a new sign in',
      'Account number ending in: 9786 If this was you, there is nothing you need to do.')).kind).toBe('noise');
  });
});

describe('ConEd', () => {
  it('lee el aviso clasico de factura', () => {
    const r = extractBill(email('Con Edison <noreply@billing.coned.com>', 'Your Con Edison Bill Is Ready',
      'Your bill of $241.37 for your account ending in 7226 is ready. Want to take care of that now?'));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '7226', amount_due: 241.37 });
  });

  it('lee el recordatorio de vencimiento con su fecha', () => {
    const r = extractBill(email('Con Edison <noreply@billing.coned.com>', 'Your Con Edison Bill Is Due',
      'Your bill of $117.87 for your account ending in 7417 is due on Aug. 19, 2026.'));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '7417', amount_due: 117.87, due_date: '2026-08-19' });
  });

  it('lee la plantilla de domiciliacion, con la cuenta partida por guiones', () => {
    const r = extractBill(email('Con Edison <noreply@billing.coned.com>', 'Your Con Edison bill is ready',
      `Your Con Edison Bill is ready 08/13/2026 Amount to be deducted $652.29
       Payment will be deducted from your bank on 08/27/2026 Account number XXXXX-XX846-7 Bill through 08/11/2026`));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '8467', amount_due: 652.29, due_date: '2026-08-27' });
  });

  it('marca la confirmacion de pago como pago, no como factura', () => {
    const r = extractBill(email('Con Edison <noreply@billing.coned.com>', 'Thanks for Paying Your Con Edison Bill',
      'We got your payment for $117.87 and applied it to your account ending in 7417. Thanks!'));
    expect(r).toMatchObject({ kind: 'payment', account_last4: '7417', amount_due: 117.87 });
  });
});

describe('LADWP', () => {
  // El sistema anterior daba por hecho que LADWP nunca manda "factura lista".
  // Si la manda — y con importe y vencimiento.
  it('lee el aviso de factura disponible', () => {
    const r = extractBill(email('LADWP <ladwp.webnoreply@ladwp.com>', 'Your LADWP Bill is Available',
      `Your LADWP bill for account number 2933798944 is available for online viewing and payment.
       Total Amount Due: $191.26 Payment Due Date: 8/12/2026`));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '8944', amount_due: 191.26, due_date: '2026-08-12' });
  });

  it('marca la confirmacion de pago como pago', () => {
    const r = extractBill(email('LADWP <ladwp.webnoreply@ladwp.com>', 'LADWP Payment Received (Confirmation)',
      `Account Number: 2933798944 Payment Details Confirmation Number: 79924
       Payment Amount: $191.26 Payment Type: Credit Card`));
    expect(r).toMatchObject({ kind: 'payment', account_last4: '8944', amount_due: 191.26 });
  });

  it('descarta el marketing de rebajas', () => {
    expect(extractBill(email('LADWP <noreply@ladwp.com>', 'Stay cool with bigger LADWP rebates',
      'Smart thermostats as low as $0, window ACs up to $125 back. Shop now!')).kind).toBe('noise');
  });
});

describe('SCE', () => {
  it('lee la factura', () => {
    const r = extractBill(email('SCE <sce@message.sce.com>', 'Bill is Ready',
      `Account XXXXXXX63745 | Your Bill is Due Soon Your current bill is now available for viewing.
       Statement Date 08/06/2026 Amount Due $190.90 Due Date 08/26/2026 VIEW YOUR BILL`));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '3745', amount_due: 190.9, due_date: '2026-08-26' });
  });
});

describe('SoCalGas', () => {
  // El apodo y la unidad vienen entre parentesis detras de la cuenta. El
  // sistema anterior lo ignoraba y ademas descartaba estos emails como ruido.
  it('lee la factura y captura el apodo del edificio', () => {
    const r = extractBill(email('SoCalGas <customerservice@socalgas.com>', 'Your bill from SoCalGas is now available',
      `Dear Dream, Your current bill is available on My Account.
       Total Balance $30.57 due 09/02/2026 Account Number ******22085 (JEFFERSON 269)`));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '2085', amount_due: 30.57, due_date: '2026-09-02', nickname: 'JEFFERSON 269' });
  });

  it('lee la domiciliacion — el email que el sistema viejo tiraba a la basura', () => {
    const r = extractBill(email('SoCalGas <customerservice@socalgas.com>', 'Your Automatic Monthly Payment is scheduled',
      `This confirms that your bill amount will be paid on your scheduled payment date.
       Payment Amount $1.28 Account Number *****44904 (VERONA 209) Scheduled Payment Date 08/12/2026`));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '4904', amount_due: 1.28, due_date: '2026-08-12', nickname: 'VERONA 209' });
  });

  it('lee el aviso final de corte', () => {
    const r = extractBill(email('SoCalGas <customerservice@socalgas.com>', 'Final Notice: Past Due Payment',
      `This is your final notice before your gas service is disconnected.
       Past Due Amount $3174.09 due 07-20-2026 Account Number ******XXX-XXX-4706 Current Charges $6.68 due 06-29-2026`));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '4706', amount_due: 3174.09, due_date: '2026-07-20' });
  });

  it('descarta los avisos que no llevan facturacion', () => {
    expect(extractBill(email('SoCalGas <customerservice@socalgas.com>', 'Important Privacy Notice for Customers',
      'Account Number ******64710 The Southern California Gas Company is committed to protecting your Energy Usage information.')).kind).toBe('noise');

    expect(extractBill(email('SoCalGas <customerservice@socalgas.com>', 'Routine Natural Gas Safety Inspections',
      'We will be performing routine safety inspections in your area.')).kind).toBe('noise');
  });
});

describe('plantillas que el sistema viejo perdia', () => {
  it('SoCalGas: saldo a favor — la factura llego y no hay nada que pagar', () => {
    const r = extractBill(email('SoCalGas <customerservice@socalgas.com>', 'Your bill from SoCalGas is now available',
      `Total Balance $0.05 Credit due No Payment Required (Credit Balance)
       Account Number ******29031 (DOMAIN 321) Retrieve your account number`));
    expect(r).toMatchObject({ kind: 'credit', account_last4: '9031', amount_due: 0, credit_balance: 0.05, nickname: 'DOMAIN 321' });
  });

  it('SoCalGas: aviso de impago con la fecha en barras', () => {
    const r = extractBill(email('SoCalGas <customerservice@socalgas.com>', 'Past Due Notice from SoCalGas',
      `Past Due Amount $3,180.77 due 08/14/2026 Account Number ******47065 (STELLA 469)
       Current Charges $10.83 due 08/19/2026`));
    expect(r).toMatchObject({ kind: 'bill', account_last4: '7065', amount_due: 3180.77, due_date: '2026-08-14', past_due: true });
  });

  it('ConEd: statement consolidado — una tabla con N cuentas y su direccion', () => {
    const r = extractBill(email('Con Edison <noreply@billing.coned.com>', 'Your Con Edison bill is ready',
      `Your Con Edison Bill is ready 07/28/2026 Your Bills are ready to view
       Account ending in: Amount Due: Due Date: Address:
       XXXXX-XX741-7 -$226.12 08/18/2026 472 9TH AVE FL 4 4FL
       XXXXX-XX741-7 -$226.12 08/18/2026 472 9TH AVE FL 4 4FL
       View Bills Pay Now Contact Us`));
    expect(r.kind).toBe('multi');
    expect(r.items).toHaveLength(1);            // la plantilla repite la fila
    expect(r.items[0]).toMatchObject({
      kind: 'credit',                            // importe negativo = saldo a favor
      account_last4: '7417', amount_due: 226.12, due_date: '2026-08-18', unit: '4FL',
    });
  });

  it('T-Mobile: confirmacion de pago', () => {
    const r = extractBill(email('T-Mobile <donotreply@system.t-mobile.com>', "We've received your payment",
      'Thanks for your payment. Account: XXXXX4780 Payment received: $61.00 on 08/13/2026 using Card ending in 8197'));
    expect(r).toMatchObject({ kind: 'payment', account_last4: '4780', amount_due: 61 });
  });

  it('T-Mobile: el marketing sigue siendo ruido', () => {
    expect(extractBill(email('T-Mobile <donotreply@notifications.t-mobile.com>', 'An all-new Galaxy is here',
      'Get the new Samsung Galaxy Z Flip8 for only $100 No trade-in needed.')).kind).toBe('noise');
  });
});

describe('remitentes desconocidos', () => {
  it('devuelve null para que se ocupe la IA de reserva', () => {
    expect(extractBill(email('Agua SA <facturas@agua.example>', 'Su factura', 'Importe 42.00'))).toBeNull();
  });
});

describe('regla de seguridad', () => {
  it('una factura sin importe o sin cuenta nunca se guarda a medias', () => {
    // Falta el importe: mejor factura ausente y visible en "esperadas" que inventada.
    expect(extractBill(email('SCE <sce@message.sce.com>', 'Bill is Ready',
      'Account XXXXXXX63745 | Your bill is now available. Due Date 08/26/2026')).kind).toBe('noise');
  });
});
