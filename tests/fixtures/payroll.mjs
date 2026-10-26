import assert from 'node:assert/strict';

export const gustoFixture = () => {
  const company='synthetic-coaster-100',employee='synthetic-coaster-101',payrollId='synthetic-coaster-102';
  let payroll={payroll_uuid:payrollId,company_uuid:company,check_date:'2031-06-13',off_cycle:false,processed:false,employee_compensations:[{
    employee_uuid:employee,version:'synthetic-coaster-103',excluded:false,payment_method:'Direct Deposit',
    reimbursements:[{uuid:'synthetic-coaster-104',description:'Existing reimbursement',amount:'2.00'}],
    fixed_compensations:[{name:'Bonus',amount:'3.00',job_uuid:'synthetic-coaster-105'},{name:'Salary',amount:'1000.00',job_uuid:'synthetic-coaster-105'}],
  }]};
  const writes=[];
  const fixture={company,employee,payrollId,writes,lostAck:false,hold:null,get payroll(){return payroll;},set payroll(value){payroll=value;},async fetch(request){
    const url=new URL(request.url),path=url.pathname;
    assert.equal(url.origin,'https://api.gusto-demo.com');
    if(fixture.hold)await fixture.hold(request);
    if(path===`/v1/companies/${company}`)return Response.json({uuid:company,name:'Harbour and Finch sandbox'});
    if(path.endsWith('/employees'))return Response.json([{uuid:employee,first_name:'Sam',last_name:'Taylor',email:'sam@harbourfinch.example',terminated:false}]);
    if(path.endsWith('/payrolls'))return Response.json([payroll]);
    if(path.endsWith('/prepare'))return Response.json(payroll);
    if(path===`/v1/companies/${company}/payrolls/${payrollId}`){
      if(request.method==='PUT'){
        const body=await request.json();writes.push(body);
        assert.equal(body.employee_compensations[0].version,payroll.employee_compensations[0].version);
        payroll={...payroll,employee_compensations:body.employee_compensations.map(e=>({...e,version:'synthetic-coaster-106',reimbursements:e.reimbursements.map((r,i)=>({...r,uuid:`synthetic-coaster-${110+i}`}))}))};
        if(fixture.lostAck)return new Response('',{status:503});
      }
      return Response.json(payroll);
    }
    if(path===`/v1/payrolls/${payrollId}/receipt`)return Response.json({payroll_uuid:payrollId,company_uuid:company,employee_compensations:payroll.employee_compensations.map(e=>({employee_uuid:e.employee_uuid,total_reimbursement:e.reimbursements.reduce((sum,r)=>sum+Math.round(Number(r.amount)*100),0)/100+'',net_pay:'1000.00',total_tax:'5.00'}))});
    assert.fail(`Unexpected Gusto request ${request.method} ${path}`);
  }};
  return fixture;
};
