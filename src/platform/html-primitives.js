'use strict';

function esc(value){
  return String(value==null?'':value).replace(/[&<>"']/g,char=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  })[char]);
}

function csrfHidden(token){
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}

module.exports={esc,csrfHidden};
