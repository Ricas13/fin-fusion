'use strict';

// The stable base renderer owns the admin document chrome and the
// /css/admin-capability.css link. This wrapper only adds progressive behavior.
const base=require('./admin-html-core-base');

function layout(options={}){
  const html=base.layout(options);
  const script='<script src="/js/admin-setting-controls.js" defer></script>';
  return html.includes('</body>')?html.replace('</body>',`${script}</body>`):`${html}${script}`;
}

module.exports={...base,layout};
