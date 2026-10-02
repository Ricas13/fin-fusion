'use strict';

function requireAdminSession(req,res,next){
  if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();
  return res.redirect('/login?session=expired');
}

function noStore(_req,res,next){
  res.setHeader('Cache-Control','no-store, private, max-age=0');
  res.setHeader('Pragma','no-cache');
  return next();
}

function redirectWith(res,path,key,message){
  return res.redirect(`${path}${path.includes('?')?'&':'?'}${key}=${encodeURIComponent(message)}`);
}

function redirectMessage(res,path,message){return redirectWith(res,path,'message',message);}
function redirectError(res,path,error){return redirectWith(res,path,'error',error?.message||error||'Request failed.');}

module.exports={requireAdminSession,noStore,redirectWith,redirectMessage,redirectError};
