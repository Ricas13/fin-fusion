'use strict';

const http=require('http');
const https=require('https');
const net=require('net');
const outbound=require('../security/outbound-url-policy');
const client=require('./source-client');

function range(value){const text=String(value||'').trim();if(!text)return'';if(text.length>200||!/^(?:bytes=)?\d*-\d*(?:,\d*-\d*)*$/i.test(text))return'';return text.toLowerCase().startsWith('bytes=')?text:`bytes=${text}`;}
async function open(source,itemId,mediaSourceId,rangeHeader=''){
  const item=String(itemId||'').trim(),media=String(mediaSourceId||'').trim();
  if(!item||item.length>200||!media||media.length>300)throw new Error('Invalid Jellyfin playback identifier.');
  const url=client.sourceUrl(source.base_url,`/Videos/${encodeURIComponent(item)}/stream`);
  url.searchParams.set('Static','true');url.searchParams.set('MediaSourceId',media);
  const checked=await outbound.assertSafeIntegrationUrl(url,{purpose:`Stremio playback source ${source.name||'Jellyfin'}`});
  const address=checked.addresses.find(v=>net.isIP(v)===4)||checked.addresses[0],family=net.isIP(address),transport=url.protocol==='https:'?https:http;
  const headers={Authorization:client.jellyfinAuthHeader(client.sourceToken(source)),Accept:'*/*'},safeRange=range(rangeHeader);if(safeRange)headers.Range=safeRange;
  return new Promise((resolve,reject)=>{
    const lookup=(_hostname,options,callback)=>{if(typeof options==='function'){callback=options;options={};}if(options?.all)return callback(null,[{address,family}]);return callback(null,address,family);};
    const request=transport.request(url,{method:'GET',headers,lookup},response=>resolve({request,response,url}));
    request.setTimeout(15000,()=>request.destroy(new Error('Jellyfin playback connection timed out.')));request.on('error',reject);request.end();
  });
}

module.exports={range,open};
