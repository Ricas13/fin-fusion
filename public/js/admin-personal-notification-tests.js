'use strict';

(function(){
  function csrfValue(){return document.querySelector('input[name="_csrf"]')?.value||'';}
  function form(channel,label,disabled=false){
    const f=document.createElement('form');
    f.method='post';
    f.action=`/admin/profile/notifications/test/${channel}`;
    f.className='personalNotificationTest';
    const token=document.createElement('input');
    token.type='hidden';token.name='_csrf';token.value=csrfValue();
    const button=document.createElement('button');
    button.type='submit';button.className='button secondary';button.textContent=label;button.disabled=disabled;
    f.append(token,button);
    return f;
  }
  function cardByTitle(title){
    return [...document.querySelectorAll('.formPanel')].find(card=>card.querySelector('h3')?.textContent.trim()===title)||null;
  }
  function appendTest(card,channel,label,disabled){
    if(!card||card.querySelector(`form[action="/admin/profile/notifications/test/${channel}"]`))return;
    card.appendChild(form(channel,label,disabled));
  }
  function setup(){
    if(location.pathname!=='/admin/profile/notifications')return;
    const profilePanel=[...document.querySelectorAll('.formPanel')].find(card=>card.textContent.includes('Email:'));
    const emailMissing=profilePanel?.textContent.includes('Email: not set')??true;
    appendTest(profilePanel,'email','Send test email',emailMissing);

    const telegram=cardByTitle('Telegram');
    appendTest(telegram,'telegram','Send test Telegram',!telegram||telegram.textContent.includes('Not connected'));

    const discord=cardByTitle('Discord');
    appendTest(discord,'discord','Send test Discord',!discord||discord.textContent.includes('Not connected'));
  }
  document.addEventListener('DOMContentLoaded',setup);
})();
