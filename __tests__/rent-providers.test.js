import { describe, it, expect } from 'vitest';
import { extractRentPayment, cleanRentUnit } from '../lib/rent-providers.js';

// Textos REALES de los 7 portales (Airtable, leidos el 04/09/2026). Si un
// portal cambia de plantilla, esto falla y nos enteramos ANTES de perder
// rentas — la leccion de SoCalGas aplicada al circuito de rentas.

const email = (fromEmail, subject, content) => ({ fromEmail, subject, content, htmlContent: '' });

describe('cleanRentUnit', () => {
  it('limpia las formas reales de los portales', () => {
    expect(cleanRentUnit('Unit#140')).toBe('140');
    expect(cleanRentUnit('1 - 306-PR')).toBe('306');
    expect(cleanRentUnit('1420-501')).toBe('501');
    expect(cleanRentUnit('306-PR')).toBe('306');
    expect(cleanRentUnit('3A')).toBe('3A');
    expect(cleanRentUnit(null)).toBeNull();
  });

  it('corta la basura que Entrata arrastra detras de la unidad', () => {
    expect(cleanRentUnit('306-PR NAME: SUGEY FLORES')).toBe('306');
    expect(cleanRentUnit('306-PR -')).toBe('306');
    expect(cleanRentUnit('1420 - 501')).toBe('501');
  });
});

describe('variantes de plantilla que casi se pierden', () => {
  // Los 5 emails que la primera version de las reglas llamaba "ruido" — y que
  // eran pagos reales. Salieron de validar contra los 135 del historico.
  it('Bilt: "rent payment of $X" sin Transaction ID', () => {
    const r = extractRentPayment(email('notifications@alerts.biltrewards.com', 'Your automatic rent payment is processing',
      "With Bilt, you're earning 250 Bilt Points on your automatic rent payment of $3,873.08. The payment is being processed."));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 3873.08 });
  });

  it('Bilt: "- Amount: $X" con Transaction ID', () => {
    const r = extractRentPayment(email('notifications@alerts.biltrewards.com', 'Your automatic rent payment is processing',
      "You're earning 250 Bilt Points on this payment. Payment details: - Amount: $6,152.24 - Transaction ID: f557b165-2a44-4409-ac66-830ded7cea2c"));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 6152.24 });
  });

  it('Entrata: el total se llama "Purchase Summary Total Amount"', () => {
    const r = extractRentPayment(email('no-reply@entrata.com', 'Payment Confirmation for Sugey Flores for Arrive Seaside I',
      'Payment Receipt - **Authorization Code:** 1809434870 - **Payment Date:** Apr 01, 2026 02:44 AM PDT - **Unit:** 1 - 306-PR - **Address:** 1548 6th Street, Santa Monica, CA 90401 - **Purchase Summary Total Amount:** $4,465.43'));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 4465.43, paid_date: '2026-04-01', unit: '306' });
  });
});

describe('AppFolio', () => {
  it('lee la confirmacion, con el landlord del asunto', () => {
    const r = extractRentPayment(email('donotreply@appfolio.com', '6th ST. Lofts, LLC - Online Payment Confirmation',
      'Hello Edonis Hasani, Thank you for your automatic payment of $3,150.00 on 09/01/2026. Your confirmation number is FA56-E460.'));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 3150, paid_date: '2026-09-01',
      confirmation_number: 'FA56-E460', landlord: '6th ST. Lofts, LLC', payment_portal: 'AppFolio' });
  });
});

describe('Bilt', () => {
  it('lee el pago y el landlord; la fecha la pone el email', () => {
    const r = extractRentPayment(email('notifications@alerts.biltrewards.com', 'Your rent payment is processing',
      "Great news! Your payment of $1.00 for VRS Portofino LLC is processing. Payment Details: - Payment Amount: $1.00 - Transaction ID: cc33e887-e6c0-4aaf-8176-bc7a65a8b0ec"));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 1, paid_date: null,
      landlord: 'VRS Portofino LLC', confirmation_number: 'cc33e887-e6c0-4aaf-8176-bc7a65a8b0ec' });
  });
});

describe('ClickPay', () => {
  it('lee pago, fecha y la direccion con unidad del propio email', () => {
    const r = extractRentPayment(email('support@clickpay.com', 'Automatic Payment Confirmation A2607020434_BS9YW2',
      'Dear Juan, Thank you for using ClickPay! Your payment of $2,717.23 for 312 E 93RD Street, #3A, NEW YORK, NY is being processed. Payment Details: - Payment date: 07/02/2026 - Confirmation Number: A2607020434\_BS9YW2 - Payment Type: Autopay For questions, please contact Margit Realty LLC. Note: Allow 24-48 hours'));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 2717.23, paid_date: '2026-07-02',
      property_address: '312 E 93RD Street', unit: '3A', landlord: 'Margit Realty LLC' });
  });
});

describe('Entrata', () => {
  it('lee el recibo con unidad y direccion', () => {
    const r = extractRentPayment(email('no-reply@entrata.com', 'Payment Confirmation for Sugey Flores for Arrive Seaside I',
      'Payment Receipt AUTHORIZATION CODE: 1841240368 PAYMENT TYPE: eCheck x2335 PAYMENT DATE: Sep 01, 2026 11:58 AM PDT Arrive Seaside I Sugey Flores Unit: 1 - 306-PR 1548 6th Street, Santa Monica, CA 90401 PURCHASE SUMMARY Payment Amount: $4,526.08'));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 4526.08, paid_date: '2026-09-01',
      confirmation_number: '1841240368', unit: '306', property_address: '1548 6th Street, Santa Monica, CA 90401',
      landlord: 'Arrive Seaside I' });
  });
});

describe('Paymentus', () => {
  it('saca la unidad de dentro del numero de cuenta', () => {
    const r = extractRentPayment(email('info@paymentus.com', 'Payment Information for AvalonBay',
      'We are pleased to confirm your payment with AvalonBay Biller. Confirmation number: 2596028303 Payment date: Sep 01, 2026 Payment amount: 4,379.15 Processing fee: 0.00 Account Information Payment type: AVA Hollywood Payment Account number: CG18756760-CA120-004-4522-3 Zip Code: 90038'));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 4379.15, paid_date: '2026-09-01',
      confirmation_number: '2596028303', unit: '4522', landlord: 'AvalonBay' });
  });
});

describe('RentCafe', () => {
  it('lee el pago; propiedad y unidad las pone el mapa de alias', () => {
    const r = extractRentPayment(email('no-reply@rentcafe.com', 'RentCafe Payment Confirmation',
      'This email confirms we have received your one-time online payment. PAYMENT INFORMATION - Payment Confirmation Number: 4928368 - Payment Amount: $137.11'));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 137.11, confirmation_number: '4928368' });
  });
});

describe('WelcomeHome', () => {
  it('lee pago, unidad y landlord', () => {
    const r = extractRentPayment(email('Jefferson_at_Marina_Del_Rey@mail.welcomehome.com', 'Jefferson at Marina Del Rey - Payment Confirmation',
      'Payment Confirmation Dear Lucy, Thanks for your payment to Jefferson at Marina Del Rey for Unit#140 from Bank account ending 1878. Confirmation#: MFZM41LTA03 Payment Date: 8/1/2026 Payment Amount: $5,285.41'));
    expect(r).toMatchObject({ kind: 'rent_payment', amount_paid: 5285.41, paid_date: '2026-08-01',
      unit: '140', landlord: 'Jefferson at Marina Del Rey', confirmation_number: 'MFZM41LTA03' });
  });
});

describe('reserva y seguridad', () => {
  it('remitente desconocido -> null -> lo mira la IA', () => {
    expect(extractRentPayment(email('billing@conservice.com', 'Your statement', 'Total due $500'))).toBeNull();
  });

  it('email de portal SIN importe -> ruido visible, nunca pago a medias', () => {
    const r = extractRentPayment(email('notifications@alerts.biltrewards.com', 'Earn more points!',
      'Check out these limited-time offers from Bilt Rewards.'));
    expect(r.kind).toBe('noise');
  });
});
