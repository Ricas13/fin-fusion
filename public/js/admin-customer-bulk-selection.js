'use strict';

(function(){
  const all=document.getElementById('checkAllPage');
  const form=document.getElementById('bulkForm');
  const table=document.getElementById('customersTable');
  if(all&&table){
    all.addEventListener('change',()=>{
      table.querySelectorAll('.rowCheck').forEach(cb=>{cb.checked=all.checked;});
    });
  }
  if(form&&table){
    form.addEventListener('submit',()=>{
      form.querySelectorAll('input[data-bulk-customer-copy="1"]').forEach(input=>input.remove());
      table.querySelectorAll('.rowCheck:checked').forEach(cb=>{
        const input=document.createElement('input');
        input.type='hidden';
        input.name='customerId';
        input.value=cb.value;
        input.dataset.bulkCustomerCopy='1';
        form.appendChild(input);
      });
    });
  }
})();
