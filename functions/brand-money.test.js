const {test}=require('node:test'),assert=require('node:assert/strict');
const finance=require('./brand-finance'),content=require('./brand-content');
const deal=(id,fee,payment='outstanding',extra={})=>({id,brand:id,commercial:{stage:'contracted',reviewed:true,evidence:'Agreed booking',currency:'ZAR',fee,paymentStatus:payment,paymentEvidence:'Owner confirmation',billingStatus:'invoiced',billingEvidence:'Invoice sent',invoices:[],...extra}});
test('money view shows confirmed outstanding brands without fabricating invoice numbers or dates',()=>{
 const a=deal('Brand A',6000),b=deal('Brand B',20000),paid=deal('Paid brand',10000,'paid');
 const view=finance.moneyView([a,b,paid],'ZAR','2026-10-31');
 assert.equal(view.paidFees,10000);assert.equal(view.owed,26000);assert.equal(view.owing.length,2);assert.equal(view.invoices.length,0);
 assert.ok(view.owing.every(row=>row.invoice==='Sent, details not recorded'&&row.due===null));
});
test('changing the shared payment state to paid removes the owed row and updates the paid total',()=>{
 const original=deal('Brand',8000),unpaid=finance.moneyView([original],'ZAR','2026-10-31');
 const paid=finance.moneyView([{...original,commercial:{...original.commercial,paymentStatus:'paid'}}],'ZAR','2026-10-31');
 assert.equal(unpaid.owed,8000);assert.equal(paid.owed,0);assert.equal(paid.owing.length,0);assert.equal(paid.paidFees,8000);
});
test('partial invoice payments reduce what is owed, drafts remain visible, voids and other currencies stay separate',()=>{
 const invoice={id:'i',number:'INV1',issuedDate:'2026-10-01',amount:8000,paidAmount:2000,paidDate:'2026-10-20',evidence:'Receipt',dueConfirmed:true,dueDate:'2026-11-01'};
 const a=deal('Partial',8000,'outstanding',{invoices:[invoice,{id:'draft',number:'',amount:100,void:false},{id:'void',amount:500,void:true}]}),usd=deal('USD',500,'outstanding',{currency:'USD'}),archived={...deal('Archived',9000),archived:true};
 const view=finance.moneyView([a,usd,archived],'ZAR','2026-10-31');
 assert.equal(view.owed,6000);assert.equal(view.owing[0].due,'2026-11-01');assert.equal(view.invoices.length,2);assert.equal(view.invoices[1].invoice.id,'draft');
});
test('unconfirmed payment states are flagged instead of appearing as confirmed zero debt',()=>{
 const a=deal('Unknown',8000,'unknown',{billingStatus:'unknown',billingEvidence:''});const view=finance.moneyView([a],'ZAR','2026-10-31');
 assert.equal(view.owed,0);assert.equal(view.unconfirmed.length,1);assert.equal(view.unconfirmed[0].id,a.id);
});
test('content groups use live brand headings while preserving independent skit titles and scripts',()=>{
 const ally={deals:{deals:[{id:'brand',brand:'Market Liquors'},{id:'other',brand:'Taptap Send'}],aliases:{old:'brand'}},brandContent:{items:[{id:'piece',dealId:'old',title:'GETTING READY FOR THE JOL',desc:'Script',caption:'Caption'},{id:'story',dealId:'other',title:'Story',desc:'Story script'}]}};
 const before=JSON.stringify(ally),groups=content.groups(ally);
 assert.equal(groups[0].brand,'Market Liquors');assert.equal(groups[0].items[0].title,'GETTING READY FOR THE JOL');assert.equal(groups[1].brand,'Taptap Send');assert.equal(groups[1].items[0].title,'Story');assert.equal(JSON.stringify(ally),before);
 assert.equal(content.groups(ally,'market').length,1);assert.equal(content.groups(ally,'JOL')[0].brand,'Market Liquors');
 ally.deals.deals[0].brand='Updated brand';assert.equal(content.groups(ally)[0].brand,'Updated brand');
});
test('a known sent invoice number remains visible before its amount and dates are entered',()=>{
 const a=deal('Brand',5000,'outstanding',{invoices:[{id:'known',number:'91255',amount:null,issuedDate:null,dueDate:null,void:false},{id:'blank',number:'',amount:null,paidAmount:null}]});
 const view=finance.moneyView([a],'ZAR','2026-10-31');assert.equal(view.owed,5000);assert.equal(view.owing[0].invoice,'Sent · 91255');assert.equal(view.invoices.length,1);
});
