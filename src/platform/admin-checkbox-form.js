'use strict';

function own(value,key){return Boolean(value)&&Object.prototype.hasOwnProperty.call(value,key);}

function explicitCheckboxes(body={},marker,fields=[]){
  const input={...(body||{})};
  if(String(input[marker]||'')!=='1')return input;
  for(const field of fields)input[field]=own(body,field)?body[field]:false;
  delete input[marker];
  return input;
}

module.exports={explicitCheckboxes};
