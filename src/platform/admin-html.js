'use strict';

const core=require('./admin-html-core');

// Admin pages are assembled from server-rendered HTML fragments. Keep the
// CSP boundary in one place: body fragments may contain legacy inline script
// tags while they are being migrated, but inline JavaScript is never emitted
// to the browser. Behaviour belongs in external /public/js modules instead.
function stripInlineScripts(body){
    return String(body||'').replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi,'');
}

function layout(options={}){
    return core.layout({...options,body:stripInlineScripts(options.body)});
}

module.exports={...core,layout,stripInlineScripts};
