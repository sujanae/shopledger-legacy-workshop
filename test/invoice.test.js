'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

// Synthetic fixtures only. These modules do not import the store or access files.
// CURRENT BEHAVIOUR assertions preserve unchanged results; REGRESSION assertions
// cover the invoice calculation defects corrected by this ticket.
function item(overrides = {}) {
  return {
    id: 901,
    sku: 'TEST-001',
    name: 'Test tea',
    hsn: '0902',
    price: 100,
    qty: 1,
    ...overrides
  };
}

function order(overrides = {}) {
  return {
    id: 9001,
    date: '01/04/2026',
    customer: 'Test customer',
    paymentMode: 'cash',
    status: 'completed',
    items: [item()],
    coupon: '',
    subtotal: 100,
    discount: 0,
    tax: 18,
    total: 118,
    ...overrides
  };
}

function amounts(figures) {
  const { subtotal, discount, tax, cgst, sgst, total } = figures;
  return { subtotal, discount, tax, cgst, sgst, total };
}

function checkout(items, coupon = '') {
  const billed = pricing.computeTotals(items, coupon);
  // Match the monetary fields persisted by routes/orders.js, without invoking
  // the router or storage. Expected amounts below are independent literals.
  const savedOrder = order({
    items,
    coupon,
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  });
  return { billed, savedOrder, printed: invoice.computeInvoiceFigures(savedOrder) };
}

test('REGRESSION: a discounted 5% invoice matches the total and GST the customer was billed', () => {
  const savedOrder = order({
    items: [item({ hsn: '1006', price: 640 })],
    coupon: 'SAVE10', subtotal: 640, discount: 64, tax: 28.8, total: 604.8
  });
  const printed = invoice.computeInvoiceFigures(savedOrder);

  assert.deepEqual(amounts(printed), {
    subtotal: 640, discount: 64, tax: 28.8, cgst: 14.4, sgst: 14.4, total: 604.8
  });
  assert.equal(printed.rows[0].gstPercent, 5);
  assert.equal(printed.rows[0].lineTax, 28.8);
  const html = invoice.render(savedOrder);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹28\.80/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹604\.80/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
  const reconciliation = reports.getGstReconciliation({ orders: [savedOrder] });
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.rows[0].matched, true);
});

test('CURRENT BEHAVIOUR: an undiscounted 18% item matches the bill and exposes invoice row figures', () => {
  const savedOrder = order();
  const before = structuredClone(savedOrder);

  assert.deepEqual(invoice.computeInvoiceFigures(savedOrder), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118,
    rows: [{
      name: 'Test tea', sku: 'TEST-001', hsn: '0902', qty: 1, price: 100,
      gstPercent: 18, line: 100, lineTax: 18
    }]
  });
  assert.deepEqual(savedOrder, before);
});

test('REGRESSION: invoice GST uses the same 5%, 12%, and 18% HSN slabs as checkout', () => {
  const { billed, printed } = checkout([
    item({ id: 901, hsn: '1006' }),
    item({ id: 902, hsn: '0405' }),
    item({ id: 903, hsn: '0902' })
  ]);

  assert.deepEqual(amounts(billed), {
    subtotal: 300, discount: 0, tax: 35, cgst: 17.5, sgst: 17.5, total: 335
  });
  assert.deepEqual(billed.lines.map(line => line.gstPercent), [5, 12, 18]);
  assert.deepEqual(amounts(printed), {
    subtotal: 300, discount: 0, tax: 35, cgst: 17.5, sgst: 17.5, total: 335
  });
  assert.deepEqual(printed.rows.map(row => [row.gstPercent, row.lineTax]), [
    [5, 5], [12, 12], [18, 18]
  ]);
});

test('CURRENT BEHAVIOUR: an unknown HSN falls back to 18% in checkout and invoice', () => {
  const { billed, printed } = checkout([item({ hsn: '9999' })]);

  assert.deepEqual(amounts(billed), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
  assert.deepEqual(amounts(printed), amounts(billed));
});

for (const scenario of [
  {
    name: 'percentage gstRate overrides HSN in both calculations',
    label: 'CURRENT BEHAVIOUR',
    gstRate: 5,
    billed: { subtotal: 100, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 105 },
    printed: { subtotal: 100, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 105 },
    gstPercent: 5
  },
  {
    name: 'invoice accepts decimal gstRate in the same units as checkout',
    label: 'REGRESSION',
    gstRate: 0.05,
    billed: { subtotal: 100, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 105 },
    printed: { subtotal: 100, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 105 },
    gstPercent: 5
  },
  {
    name: 'invoice preserves an explicit zero gstRate',
    label: 'REGRESSION',
    gstRate: 0,
    billed: { subtotal: 100, discount: 0, tax: 0, cgst: 0, sgst: 0, total: 100 },
    printed: { subtotal: 100, discount: 0, tax: 0, cgst: 0, sgst: 0, total: 100 },
    gstPercent: 0
  }
]) {
  test(scenario.label + ': ' + scenario.name, () => {
    const { billed, printed } = checkout([item({ hsn: '0405', gstRate: scenario.gstRate })]);

    assert.deepEqual(amounts(billed), scenario.billed);
    assert.deepEqual(amounts(printed), scenario.printed);
    assert.equal(printed.rows[0].gstPercent, scenario.gstPercent);
  });
}

test('REGRESSION: SAVE10 matches checkout discount, GST, and total on 18% goods', () => {
  const { billed, printed } = checkout([item({ price: 1000 })], 'SAVE10');

  assert.deepEqual(amounts(billed), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
  assert.deepEqual(amounts(printed), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
  assert.equal(billed.lines[0].taxable, 900);
  assert.equal(printed.rows[0].lineTax, 162);
});

test('REGRESSION: invoice apportions SAVE10 across mixed GST slabs like checkout', () => {
  const { billed, printed } = checkout([
    item({ id: 901, hsn: '1006', price: 600 }),
    item({ id: 902, hsn: '0405', price: 400 })
  ], 'SAVE10');

  assert.deepEqual(amounts(billed), {
    subtotal: 1000, discount: 100, tax: 70.2, cgst: 35.1, sgst: 35.1, total: 970.2
  });
  assert.deepEqual(billed.lines.map(line => ({
    discount: line.discount, taxable: line.taxable, tax: line.tax
  })), [
    { discount: 60, taxable: 540, tax: 27 },
    { discount: 40, taxable: 360, tax: 43.2 }
  ]);
  assert.deepEqual(amounts(printed), {
    subtotal: 1000, discount: 100, tax: 70.2, cgst: 35.1, sgst: 35.1, total: 970.2
  });
  assert.deepEqual(printed.rows.map(row => row.lineTax), [27, 43.2]);
});

test('REGRESSION: invoice percentage discounts respect the SAVE10 cap', () => {
  const { billed, printed } = checkout([item({ price: 2000 })], 'SAVE10');

  assert.deepEqual(amounts(billed), {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.5, sgst: 166.5, total: 2183
  });
  assert.deepEqual(amounts(printed), {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.5, sgst: 166.5, total: 2183
  });
});

test('REGRESSION: flat invoice discounts reduce the taxable amount like checkout', () => {
  const { billed, printed } = checkout([item({ price: 1000 })], 'FLAT50');

  assert.deepEqual(amounts(billed), {
    subtotal: 1000, discount: 50, tax: 171, cgst: 85.5, sgst: 85.5, total: 1121
  });
  assert.deepEqual(amounts(printed), {
    subtotal: 1000, discount: 50, tax: 171, cgst: 85.5, sgst: 85.5, total: 1121
  });
});

// These are legacy/synthetic stored orders. New-order routes would reject the
// ineligible coupons; invoice calculations must not introduce their discounts.
for (const scenario of [
  { name: 'respects coupon minimum spend', price: 100, coupon: 'SAVE10',
    tax: 18, total: 118 },
  { name: 'does not apply an inactive coupon', price: 1000, coupon: 'DIWALI20',
    tax: 180, total: 1180 },
  { name: 'does not subtract FLAT50 from an ineligible bill smaller than the discount',
    price: 10, coupon: 'FLAT50', tax: 1.8, total: 11.8 }
]) {
  test('REGRESSION: invoice ' + scenario.name, () => {
    const { billed, printed } = checkout([item({ price: scenario.price })], scenario.coupon);

    assert.equal(billed.discount, 0);
    assert.equal(billed.tax, scenario.tax);
    assert.equal(billed.total, scenario.total);
    assert.equal(printed.discount, 0);
    assert.equal(printed.tax, scenario.tax);
    assert.equal(printed.total, scenario.total);
  });
}

test('REGRESSION: invoice coupon lookup normalizes whitespace and case like checkout', () => {
  const { billed, printed } = checkout([item({ price: 1000 })], ' save10 ');

  assert.deepEqual(amounts(billed), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
  assert.deepEqual(amounts(printed), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
});

test('REGRESSION: invoice sums rounded line GST and matches checkout rounding', () => {
  const { billed, printed } = checkout([
    item({ id: 901, price: 0.03 }),
    item({ id: 902, price: 0.03 })
  ]);

  assert.deepEqual(amounts(billed), {
    subtotal: 0.06, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.08
  });
  assert.deepEqual(amounts(printed), {
    subtotal: 0.06, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.08
  });
  assert.deepEqual(printed.rows.map(row => row.lineTax), [0.01, 0.01]);
});

test('CURRENT BEHAVIOUR: invoice recomputes amounts instead of using saved billing figures', () => {
  const savedOrder = order({ subtotal: 80, discount: 5, tax: 9, total: 84 });
  const before = structuredClone(savedOrder);

  assert.deepEqual(amounts(invoice.computeInvoiceFigures(savedOrder)), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
  assert.deepEqual(savedOrder, before);
});

test('CURRENT BEHAVIOUR: rendered invoice warns when the stored total is below the calculated total', () => {
  const { savedOrder } = checkout([item({ hsn: '1006' })]);
  savedOrder.total = 100;
  const html = invoice.render(savedOrder);

  assert.equal(savedOrder.tax, 5);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹5\.00/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹105\.00/);
  assert.match(html, /Invoice computed total \(₹105\.00\)/);
  assert.match(html, /Order Ledger recorded total \(₹100\.00\) by \+₹5\.00/);
});

test('CURRENT BEHAVIOUR: rendered invoice warns when the stored total is above the calculated total', () => {
  const { savedOrder } = checkout([item({ price: 2000 })], 'SAVE10');
  savedOrder.total = 2200;
  const html = invoice.render(savedOrder);

  assert.match(html, /Invoice Total<\/td><td[^>]*>₹2183\.00/);
  assert.match(html, /Order Ledger recorded total \(₹2200\.00\) by -₹17\.00/);
});

test('CURRENT BEHAVIOUR: equal totals suppress the HTML warning even when stored GST differs', () => {
  const { savedOrder } = checkout([item({ price: 1000 })], 'SAVE10');
  savedOrder.tax = 180;
  const html = invoice.render(savedOrder);

  assert.equal(savedOrder.tax, 180);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹162\.00/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹100\.00/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹1062\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
});

test('CURRENT BEHAVIOUR: reconciliation flags a GST-only mismatch with zero total delta and skips cancellations', () => {
  const { savedOrder } = checkout([item({ price: 1000 })], 'SAVE10');
  savedOrder.tax = 180;
  const db = { orders: [savedOrder, order({ id: 9002 }), order({ id: 9003, status: 'cancelled' })] };
  const before = structuredClone(db);

  assert.deepEqual(reports.getGstReconciliation(db), {
    totalChecked: 2,
    mismatchCount: 1,
    totalDelta: 0,
    rows: [{
      orderId: 9001, date: '01/04/2026', customer: 'Test customer', coupon: 'SAVE10',
      ledgerSubtotal: 1000, ledgerDiscount: 100, ledgerTax: 180, ledgerTotal: 1062,
      invoiceDiscount: 100, invoiceTax: 162, invoiceTotal: 1062, delta: 0, matched: false
    }, {
      orderId: 9002, date: '01/04/2026', customer: 'Test customer', coupon: '',
      ledgerSubtotal: 100, ledgerDiscount: 0, ledgerTax: 18, ledgerTotal: 118,
      invoiceDiscount: 0, invoiceTax: 18, invoiceTotal: 118, delta: 0, matched: true
    }]
  });
  assert.deepEqual(db, before);
});
