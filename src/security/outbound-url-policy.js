'use strict';
const dns=require('dns').promises;
const net=require('net');
const http=require('http');
const https=require('https');
const operations=require('../platform/operations-settings');
const CACHE_TTL_MS=30000;
const cache=new Map();

function ipv4(value){
  const parts=String(value||'').split('.').map(Number);
  return parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)?parts:null;
}

function stripHostLiteral(value){
  const raw=String(value||'').trim().toLowerCase().split('%')[0];
  return raw.startsWith('[')&&raw.endsWith(']')?raw.slice(1,-1):raw;
}

function expandIpv6Hex(value){
  const raw=stripHostLiteral(value);
  if(!raw||raw.includes('.')||net.isIP(raw)!==6)return null;
  const halves=raw.split('::');
  if(halves.length>2)return null;
  const left=halves[0]?halves[0].split(':'):[];
  const right=halves.length===2&&halves[1]?halves[1].split(':'):[];
  let hextets;
  if(halves.length===1){
    if(left.length!==8)return null;
    hextets=left;
  }else{
    const missing=8-left.length-right.length;
    if(missing<1)return null;
    hextets=[...left,...Array(missing).fill('0'),...right];
  }
  if(hextets.length!==8)return null;
  const values=hextets.map(part=>/^[0-9a-f]{1,4}$/.test(part)?parseInt(part,16):NaN);
  return values.every(Number.isInteger)?values:null;
}

function mappedIpv4(value){
  let raw=stripHostLiteral(value);
  if(net.isIP(raw)!==6)return null;
  if(raw.includes('.')){
    const lastColon=raw.lastIndexOf(':');
    const dotted=ipv4(raw.slice(lastColon+1));
    if(!dotted)return null;
    const high=((dotted[0]<<8)|dotted[1]).toString(16);
    const low=((dotted[2]<<8)|dotted[3]).toString(16);
    raw=`${raw.slice(0,lastColon)}:${high}:${low}`;
  }
  const words=expandIpv6Hex(raw);
  if(!words||words.slice(0,5).some(word=>word!==0)||words[5]!==0xffff)return null;
  const high=words[6],low=words[7];
  return `${high>>>8}.${high&0xff}.${low>>>8}.${low&0xff}`;
}

function nat64Ipv4(value){
  const words=expandIpv6Hex(value);
  if(!words)return null;
  const bytes=[];
  for(const word of words)bytes.push(word>>>8,word&0xff);

  // RFC 6052 well-known prefix 64:ff9b::/96.
  if(words[0]===0x64&&words[1]===0xff9b&&words.slice(2,6).every(word=>word===0)){
    return bytes.slice(12,16).join('.');
  }

  // RFC 8215 local-use translation prefix 64:ff9b:1::/48, encoded using
  // the RFC 6052 /48 format: 16 IPv4 bits, the zero u-octet, then 16 bits.
  if(words[0]===0x64&&words[1]===0xff9b&&words[2]===1&&bytes[8]===0&&bytes.slice(11).every(byte=>byte===0)){
    return [bytes[6],bytes[7],bytes[9],bytes[10]].join('.');
  }
  return null;
}

function classify(address){
  const normalized=stripHostLiteral(address),mapped=mappedIpv4(normalized),translated=nat64Ipv4(normalized);
  if(mapped)return classify(mapped);
  if(translated)return classify(translated);
  const version=net.isIP(normalized);
  if(version===4){
    const p=ipv4(normalized);
    if(!p)return{hard:true,private:false,reason:'invalid address'};
    const [a,b]=p;
    if(a===169&&b===254)return{hard:true,private:true,reason:'link-local / metadata network'};
    if(a===100&&b>=64&&b<=127)return{hard:true,private:true,reason:'carrier/shared infrastructure range'};
    if(a===0||a>=224)return{hard:true,private:false,reason:'non-unicast/reserved range'};
    if(a===198&&(b===18||b===19))return{hard:true,private:false,reason:'benchmark network'};
    if(a===127)return{hard:false,private:true,reason:'loopback'};
    if(a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168))return{hard:false,private:true,reason:'private network'};
    return{hard:false,private:false,reason:'public'};
  }
  if(version===6){
    const s=normalized;
    if(s==='::'||s==='0:0:0:0:0:0:0:0')return{hard:true,private:false,reason:'unspecified address'};
    if(s.startsWith('fe8')||s.startsWith('fe9')||s.startsWith('fea')||s.startsWith('feb'))return{hard:true,private:true,reason:'IPv6 link-local network'};
    if(s.startsWith('ff'))return{hard:true,private:false,reason:'IPv6 multicast network'};
    if(s==='fd00:ec2::254')return{hard:true,private:true,reason:'cloud metadata endpoint'};
    if(s==='::1'||s==='0:0:0:0:0:0:0:1')return{hard:false,private:true,reason:'loopback'};
    const first=parseInt((s.split(':')[0]||'0'),16);
    if((first&0xfe00)===0xfc00)return{hard:false,private:true,reason:'unique-local network'};
    return{hard:false,private:false,reason:'public'};
  }
  return{hard:true,private:false,reason:'unresolved/non-IP address'};
}

async function resolveHost(hostname){
  const key=stripHostLiteral(hostname),now=Date.now(),prior=cache.get(key);
  if(prior&&prior.expires>now)return prior.addresses;
  let addresses;
  if(net.isIP(key))addresses=[key];
  else{
    const rows=await dns.lookup(key,{all:true,verbatim:true});
    addresses=[...new Set(rows.map(row=>stripHostLiteral(row.address)))];
  }
  if(!addresses.length)throw new Error('Integration hostname did not resolve to an address.');
  cache.set(key,{addresses,expires:now+CACHE_TTL_MS});
  return addresses;
}

function addressTrustedByCidrs(address,cidrs=[]){
  const normalized=stripHostLiteral(address),mapped=mappedIpv4(normalized),candidate=mapped||normalized,family=net.isIP(candidate);
  if(!family)return false;
  const block=new net.BlockList();
  for(const raw of cidrs||[]){
    const entry=String(raw||'').trim(),slash=entry.lastIndexOf('/');
    if(slash<1)continue;
    const base=stripHostLiteral(entry.slice(0,slash)),version=net.isIP(base),prefix=Number(entry.slice(slash+1));
    if(!version||version!==family||!Number.isInteger(prefix))continue;
    try{block.addSubnet(base,prefix,version===4?'ipv4':'ipv6');}catch(_){}
  }
  return block.check(candidate,family===4?'ipv4':'ipv6');
}

async function assertSafeIntegrationUrl(raw,{purpose='integration'}={}){
  let parsed;
  try{parsed=new URL(String(raw||'').trim())}catch{throw new Error(`Invalid ${purpose} URL.`)}
  if(!['http:','https:'].includes(parsed.protocol))throw new Error(`${purpose} URL must use http or https.`);
  if(parsed.username||parsed.password||parsed.hash)throw new Error(`${purpose} URL may not contain credentials or a fragment.`);
  const cfg=await operations.get().catch(()=>operations.DEFAULTS);
  const hostname=stripHostLiteral(parsed.hostname);
  const trustedHosts=new Set((cfg.outboundTrustedHosts||[]).map(x=>stripHostLiteral(x)));
  const explicitHost=trustedHosts.has(hostname);
  const addresses=await resolveHost(hostname);
  let privateSeen=false,cidrTrusted=false;
  for(const address of addresses){
    const info=classify(address);
    if(info.hard)throw new Error(`${purpose} destination ${hostname} resolved to a blocked ${info.reason}.`);
    if(info.private){
      privateSeen=true;
      const trustedAddress=addressTrustedByCidrs(address,cfg.outboundTrustedCidrs||[]);
      cidrTrusted=cidrTrusted||trustedAddress;
      if(!cfg.allowPrivateIntegrations||(!explicitHost&&!trustedAddress))throw new Error(`${purpose} destination resolves to a private address that is not explicitly allowed by Operations trusted hostname/CIDR policy.`);
    }
  }
  return{url:parsed.toString(),hostname,addresses,private:privateSeen,explicitlyTrusted:explicitHost||cidrTrusted};
}

function responseFromBuffer(status,headers,buffer){
  return{status:Number(status||0),ok:Number(status||0)>=200&&Number(status||0)<300,headers,async text(){return buffer.toString('utf8')},async json(){const text=buffer.toString('utf8');return text?JSON.parse(text):{}}};
}

async function safeFetch(raw,{purpose='integration',method='GET',headers={},body=undefined,timeoutMs=10000,signal=null,maxBytes=10*1024*1024}={}){
  const checked=await assertSafeIntegrationUrl(raw,{purpose}),parsed=new URL(checked.url),address=checked.addresses.find(value=>net.isIP(value)===4)||checked.addresses[0],family=net.isIP(address);
  if(!family)throw new Error(`${purpose} destination did not resolve to an IP address.`);
  const transport=parsed.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    let settled=false,total=0,chunks=[];
    const finishReject=error=>{if(settled)return;settled=true;reject(error)};
    const lookup=(_hostname,options,callback)=>{if(typeof options==='function'){callback=options;options={};}if(options?.all)return callback(null,[{address,family}]);return callback(null,address,family);};
    const request=transport.request(parsed,{method:String(method||'GET').toUpperCase(),headers,lookup},response=>{
      response.on('data',chunk=>{total+=chunk.length;if(total>maxBytes){request.destroy(new Error(`${purpose} response exceeded the ${maxBytes}-byte safety limit.`));return;}chunks.push(chunk)});
      response.on('end',()=>{if(settled)return;settled=true;resolve(responseFromBuffer(response.statusCode,response.headers,Buffer.concat(chunks)))});
      response.on('error',finishReject);
    });
    const timer=setTimeout(()=>{const error=new Error(`${purpose} request timed out.`);error.name='AbortError';request.destroy(error)},Math.max(1000,Math.min(60000,Number(timeoutMs)||10000)));
    request.on('close',()=>clearTimeout(timer));
    request.on('error',finishReject);
    let abortHandler=null;
    if(signal){abortHandler=()=>{const error=new Error('The operation was aborted.');error.name='AbortError';request.destroy(error)};if(signal.aborted)abortHandler();else signal.addEventListener('abort',abortHandler,{once:true});request.on('close',()=>signal.removeEventListener?.('abort',abortHandler));}
    if(body!==undefined&&body!==null)request.write(body);
    request.end();
  });
}

function clearCache(){cache.clear();}
module.exports={classify,resolveHost,addressTrustedByCidrs,assertSafeIntegrationUrl,safeFetch,clearCache,mappedIpv4,nat64Ipv4};
