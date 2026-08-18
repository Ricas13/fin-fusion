'use strict';
document.addEventListener('change',event=>{
  if(!event.target.matches('[data-attention-select-all]'))return;
  document.querySelectorAll('input[form="attentionBulkForm"][name="itemKey"]').forEach(input=>{input.checked=event.target.checked;});
});
