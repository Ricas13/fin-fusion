'use strict';

(() => {
  let sequence=0;

  function nextId(){
    let id;
    do{id=`admin-field-${++sequence}`;}while(document.getElementById(id));
    return id;
  }

  function visibleLabelFor(control){
    const group=control.closest('.formGroup');
    if(!group)return null;
    return [...group.children].find(node=>node.tagName==='LABEL'&&!node.contains(control))||null;
  }

  function normalize(){
    document.querySelectorAll('input:not([type="hidden"]),select,textarea').forEach(control=>{
      if(control.labels?.length||control.getAttribute('aria-label')||control.getAttribute('aria-labelledby'))return;

      const label=visibleLabelFor(control);
      if(label){
        if(!control.id)control.id=nextId();
        label.htmlFor=control.id;
        return;
      }

      // Search/filter controls sometimes communicate their purpose entirely
      // through a visible placeholder. Preserve that visible wording as the
      // accessible name when no separate label exists.
      const placeholder=String(control.getAttribute('placeholder')||'').trim();
      if(placeholder)control.setAttribute('aria-label',placeholder.replace(/…+$/,'').trim());
    });
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',normalize,{once:true});
  else normalize();
})();
