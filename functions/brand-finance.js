/* Shared, dependency-free commercial rules. Never migrate production status into payment status. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrandFinance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const LANES = [ ['proposed','Proposed','#98a8d9'], ['negotiating','Negotiating','#d3b37c'], ['contracted','Contracted','#ac9be9'], ['awaiting_invoice','Invoice to confirm','#d3b37c'], ['invoiced','Invoiced','#7dbbd1'], ['paid','Paid','#86c7a8'], ['barter','Product exchange','#86c7a8'], ['declined','Declined','#a1a1aa'], ['needs_review','Needs review','#a1a1aa'] ];
  const STAGES = ['proposed', 'negotiating', 'contracted', 'declined'];
  function date(value) {
    if (value === '' || value == null) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Use a real YYYY-MM-DD date.');
    const d = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== value) throw Error('Use a real date.');
    return value;
  }
  function amount(value) {
    if (value === '' || value == null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e10 || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) throw Error('Amounts must be positive numbers with at most two decimals.');
    return value;
  }
  function str(value, max=4000) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) throw Error('Text is too long or invalid.');
    return value.trim();
  }
  function bool(value) { if (value == null) return false; if (typeof value !== 'boolean') throw Error('Use true or false.'); return value; }
  function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Commercial terms must be an object.');
    const allowed = ['stage','campaign','currency','fee','agencyFee','tax','paymentTerms','deliverables','rights','contact','agency','evidence','reviewed','invoices','paymentStatus','paymentEvidence','billingStatus','billingEvidence'];
    if (Object.keys(raw).some(k=>!allowed.includes(k))) throw Error('Unknown commercial field.');
    const out = { stage: raw.stage || 'proposed', currency: str(raw.currency || 'ZAR',3), fee: amount(raw.fee), agencyFee: amount(raw.agencyFee), tax: amount(raw.tax), reviewed: bool(raw.reviewed) };
    if (!STAGES.includes(out.stage) || !/^[A-Z]{3}$/.test(out.currency)) throw Error('Invalid commercial stage or currency.');
    for (const k of ['campaign','paymentTerms','deliverables','rights','contact','agency','evidence']) out[k] = str(raw[k]);
    out.paymentStatus = raw.paymentStatus || 'unknown';
    out.paymentEvidence = str(raw.paymentEvidence);
    out.billingStatus = raw.billingStatus || 'unknown';
    out.billingEvidence = str(raw.billingEvidence);
    if (!['unknown','outstanding','paid','barter'].includes(out.paymentStatus) || !['unknown','not_invoiced','invoiced'].includes(out.billingStatus)) throw Error('Invalid payment or invoice status.');
    if (out.paymentStatus !== 'unknown' && (!out.paymentEvidence || out.stage !== 'contracted' || !out.reviewed)) throw Error('Confirm the booking and payment status source first.');
    if (out.paymentStatus === 'barter' && out.fee !== 0) throw Error('A product exchange must have an explicit zero cash fee.');
    if (out.billingStatus === 'invoiced' && (!out.billingEvidence || out.stage !== 'contracted' || !out.reviewed)) throw Error('Add the source confirming that the invoice was sent.');
    if (out.stage === 'contracted' && (!out.reviewed || !out.evidence)) throw Error('Confirm the agreed terms and add their source before marking contracted.');
    if (raw.invoices != null && !Array.isArray(raw.invoices)) throw Error('Invoices must be a list.');
    if ((raw.invoices || []).length > 50) throw Error('Use at most 50 invoice instalments per deal.');
    const ids = new Set();
    out.invoices = (raw.invoices || []).map(i=> {
      if (!i || typeof i !== 'object' || Array.isArray(i)) throw Error('Invalid invoice.');
      const keys = ['id','number','amount','issuedDate','dueDate','dueConfirmed','evidence','paidAmount','paidDate','void'];
      if (Object.keys(i).some(k=>!keys.includes(k))) throw Error('Unknown invoice field.');
      const item = { id: str(i.id,100), number: str(i.number,120), amount: amount(i.amount), issuedDate: date(i.issuedDate), dueDate: date(i.dueDate), dueConfirmed: bool(i.dueConfirmed), evidence: str(i.evidence), paidAmount: amount(i.paidAmount), paidDate: date(i.paidDate), void: bool(i.void) };
      if (!item.id || !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw Error('Each invoice needs a unique stable ID.');
      ids.add(item.id);
      if (item.dueConfirmed && (!item.dueDate || !item.evidence)) throw Error('A confirmed due date needs a date and source evidence.');
      if (item.paidAmount > 0 && (!item.paidDate || !item.evidence)) throw Error('Record the bank receipt date and evidence for payments.');
      if (item.amount == null && item.paidAmount > 0 || item.amount != null && (item.paidAmount || 0) > item.amount) throw Error('Payment cannot exceed the invoice amount.');
      return item;
    });
    return out;
  }
  const terms = d => d.commercial || { stage:'proposed', currency:'ZAR', invoices:[], reviewed:false };
  const cents = n => Math.round((n || 0) * 100);
  const balance = i => (cents(i.amount) - cents(i.paidAmount)) / 100;
  const issued = i => !i.void && i.amount != null && !!i.issuedDate && !!i.number;
  const confirmedPayment = d => { const c=terms(d); return c.stage==='contracted' && c.reviewed && !!c.paymentEvidence ? c.paymentStatus : 'unknown'; };
  const settled = d => ['paid','barter'].includes(confirmedPayment(d));
  const billingConfirmed = d => { const c=terms(d); return c.stage==='contracted' && c.reviewed && c.billingStatus==='invoiced' && !!c.billingEvidence; };
  const receivableFee = d => { const c=terms(d); return c.fee==null ? null : Math.max(0,cents(c.fee)-cents(c.agencyFee))/100; };
  function invoicedFees(d) {
    const c=terms(d), total=(c.invoices||[]).filter(issued).reduce((n,i)=>n+cents(i.amount),0)/100;
    return billingConfirmed(d) && c.fee!=null ? c.fee : c.fee==null ? total : Math.min(c.fee,total);
  }
  function outstanding(d) {
    const c=terms(d);
    if (d.archived || c.stage!=='contracted' || !c.reviewed || settled(d)) return 0;
    const invoices=(c.invoices||[]).filter(issued), remaining=invoices.reduce((n,i)=>n+cents(balance(i)),0);
    // An owner's unpaid-fee confirmation need not manufacture an invoice or a due date.
    const expected=confirmedPayment(d)==='outstanding' && receivableFee(d)!=null ? cents(receivableFee(d))-invoices.reduce((n,i)=>n+cents(i.paidAmount),0) : 0;
    return Math.max(0,remaining,expected)/100;
  }
  function lane(d) {
    if (!d.commercial) return 'needs_review';
    const c = terms(d), invoices = (c.invoices || []).filter(issued);
    if (c.stage !== 'contracted') return STAGES.includes(c.stage) ? c.stage : 'needs_review';
    if (confirmedPayment(d)==='barter') return 'barter';
    if (confirmedPayment(d)==='paid' || invoices.length && c.fee != null && invoices.reduce((n,i)=>n+cents(i.paidAmount),0) >= cents(receivableFee(d)) && invoices.every(i=>balance(i)===0)) return 'paid';
    return billingConfirmed(d) || invoices.length ? 'invoiced' : confirmedPayment(d)==='outstanding' ? 'awaiting_invoice' : 'contracted';
  }
  function dashboard(deals, day) {
    const totals = {};
    for (const d of deals) {
      if (d.archived) continue;
      const c = terms(d), currency = c.currency || 'ZAR';
      const t = totals[currency] ||= { proposed:0, contracted:0, invoiced:0, invoicedFees:0, paid:0, paidFees:0, outstanding:0, awaitingInvoice:0, overdue:0, unknownFees:0, missingDates:0, paidAmountsMissing:0, invoiceAmountsMissing:0 };
      if (c.stage === 'declined') continue;
      if (c.fee == null) t.unknownFees++;
      else t[c.stage === 'contracted' ? 'contracted' : 'proposed'] += cents(c.fee);
      if (c.stage !== 'contracted' || !c.reviewed) continue;
      const invoices=(c.invoices||[]).filter(issued), isSettled=settled(d);
      t.invoicedFees+=cents(invoicedFees(d));
      if(lane(d)==='paid') t.paidFees+=cents(c.fee);
      if(confirmedPayment(d)==='paid' && !invoices.some(i=>i.paidAmount>0)) t.paidAmountsMissing++;
      const remaining=outstanding(d);
      t.outstanding+=cents(remaining);
      if(!billingConfirmed(d)) t.awaitingInvoice+=Math.max(0,cents(remaining)-invoices.reduce((n,i)=>n+cents(balance(i)),0));
      if(billingConfirmed(d) && !invoices.length) { t.invoiceAmountsMissing++; if(remaining>0) t.missingDates++; }
      for (const i of invoices) {
        t.invoiced += cents(i.amount); t.paid += cents(i.paidAmount);
        if (!isSettled && balance(i) > 0 && (!i.dueConfirmed || !i.dueDate)) t.missingDates++;
        if (!isSettled && balance(i) > 0 && i.dueConfirmed && i.dueDate < day) t.overdue += cents(balance(i));
      }
    }
    for (const t of Object.values(totals)) for (const k of ['proposed','contracted','invoiced','invoicedFees','paid','paidFees','outstanding','awaitingInvoice','overdue']) t[k] /= 100;
    return totals;
  }
  function payable(d, i) { const c = terms(d); return !d.archived && !d.paused && !settled(d) && c.stage === 'contracted' && c.reviewed && issued(i) && i.dueConfirmed && !!i.dueDate && !!i.evidence && balance(i) > 0; }
  function reminder(d, i, day) {
    if (!payable(d,i)) return null;
    const delta = Math.round((new Date(i.dueDate+'T00:00:00Z')-new Date(day+'T00:00:00Z'))/86400000);
    if (delta === 3) return 'upcoming';
    if (delta === 0) return 'due';
    if (delta < 0) return 'overdue';
    return null;
  }
  function money(n,currency='ZAR') { return n == null ? 'Not set' : new Intl.NumberFormat('en-ZA',{style:'currency',currency}).format(n); }
  function nextDay(day) { const d = new Date(day+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10); }
  return { LANES, STAGES, date, validate, terms, balance, issued, lane, dashboard, payable, reminder, money, nextDay, confirmedPayment, settled, billingConfirmed, outstanding, invoicedFees };
});
