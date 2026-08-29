'use strict';

const {esc}=require('./admin-html-core');

const STYLESHEET='<link rel="stylesheet" href="/css/admin-setting-controls.css">';
function stylesheet(){return STYLESHEET;}

function checkboxAttrs({name,value='on',checked=false,disabled=false,form='',ariaLabel='',title='',confirmWhenChecked=''}){
  return [
    'type="checkbox"',
    name?`name="${esc(name)}"`:'',
    value!==undefined?`value="${esc(value)}"`:'',
    checked?'checked':'',
    disabled?'disabled':'',
    form?`form="${esc(form)}"`:'',
    ariaLabel?`aria-label="${esc(ariaLabel)}"`:'',
    title?`title="${esc(title)}"`:'',
    confirmWhenChecked?`data-confirm-when-checked="${esc(confirmWhenChecked)}"`:''
  ].filter(Boolean).join(' ');
}

function field({label,help='',control='',className='formGroup'}){
  return `<div class="${esc(className)}"><label>${esc(label)}</label>${help?`<div class="fieldHelp">${esc(help)}</div>`:''}${String(control||'')}</div>`;
}

function toggle({name,label,description='',checked=false,disabled=false,value='on',form='',tone='',className='',title='',confirmWhenChecked=''}){
  const text=String(label||name||'Setting');
  return `<label class="settingToggle ${tone?`settingToggle-${esc(tone)}`:''} ${esc(className)}" ${title?`title="${esc(title)}"`:''}>
    <input class="settingToggleInput" ${checkboxAttrs({name,value,checked,disabled,form,ariaLabel:text,confirmWhenChecked})}>
    <span class="settingToggleCopy"><strong>${esc(text)}</strong>${description?`<small>${esc(description)}</small>`:''}</span>
  </label>`;
}

function grid(items,{className=''}={}){
  const rows=(items||[]).filter(Boolean).map(item=>typeof item==='string'?item:toggle(item)).join('');
  return `<div class="settingToggleGrid ${esc(className)}">${rows}</div>`;
}

function switchInput({name,checked=false,disabled=false,value='on',form='',label='',title='',className='',confirmWhenChecked=''}){
  const text=String(label||title||name||'Toggle');
  return `<label class="settingSwitch ${esc(className)}" ${title?`title="${esc(title)}"`:''}><input class="settingSwitchInput" ${checkboxAttrs({name,value,checked,disabled,form,ariaLabel:text,confirmWhenChecked})}><span aria-hidden="true"></span></label>`;
}

function configured(label,configured,{configuredLabel='Configured',missingLabel='Not configured',href='',actionLabel='Edit'}={}){
  return `<div class="settingCredential"><span>${esc(label)}</span><strong class="${configured?'good':'warn'}">${esc(configured?configuredLabel:missingLabel)}</strong>${href?`<a class="button secondary btn-sm" href="${esc(href)}">${esc(actionLabel)}</a>`:''}</div>`;
}

module.exports={stylesheet,field,toggle,grid,switchInput,configured};
