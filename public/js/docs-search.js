'use strict';
document.addEventListener('DOMContentLoaded',function(){
  var input=document.querySelector('[data-doc-search]');
  if(!input)return;
  input.addEventListener('input',function(){
    var q=input.value.trim().toLowerCase();
    document.querySelectorAll('[data-doc-nav-section]').forEach(function(section){
      var anyVisible=false;
      section.querySelectorAll('[data-doc-nav-link]').forEach(function(link){
        var match=!q||link.textContent.toLowerCase().indexOf(q)>-1;
        link.hidden=!match;
        if(match)anyVisible=true;
      });
      section.hidden=!anyVisible;
    });
  });
});
