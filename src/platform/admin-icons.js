'use strict';

const iconPaths=Object.freeze({
  dashboard:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
  people:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  servers:'<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  stremio:'<path d="m9 7 8 5-8 5V7Z"/><path d="M4 5.5v13"/><path d="M20 5.5v13"/>',
  commerce:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h2"/>',
  automation:'<path d="M18 8a6 6 0 1 0 1.76 4.24"/><path d="M18 3v5h5"/><path d="m13 9-3 4h4l-3 4"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06-.06A1.7 1.7 0 0 0 19.4 9c.2.37.52.68.9.87.33.16.7.24 1.06.23H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>'
});

const aliases=Object.freeze({
  customers:'people',
  jellyfin:'servers',
  operations:'automation',
  resellers:'people'
});

function icon(name){
  const key=aliases[name]||name;
  return iconPaths[key]||iconPaths.dashboard;
}

function iconEl(name){
  return `<span class="navIcon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon(name)}</svg></span>`;
}

module.exports={icon,iconEl};
