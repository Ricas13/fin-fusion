'use strict';

// The stable base renderer owns the admin document chrome and the
// /css/admin-capability.css link. This wrapper only adds progressive behavior.
const base=require('./admin-html-core-base');

function layout(options={}){
  const html=base.layout(options);
  const scripts='<script src="/js/admin-setting-controls.js" defer></script><script src="/js/admin-customer-filters.js" defer></script><script src="/js/admin-safety-confirmations.js" defer></script>';
  return html.includes('</body>')?html.replace('</body>',`${scripts}</body>`):`${html}${scripts}`;
}

module.exports={...base,layout};