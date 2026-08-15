'use strict';

const core=require('./admin-html-core');

function scriptBoundary(ch){return ch===undefined||/[\s/>]/.test(ch);}
function externalScriptTag(openTag){return /\bsrc\s*=/i.test(openTag);}

// Admin body fragments are server-generated HTML with escaped dynamic values.
// Until the last legacy inline behaviours are physically removed from every
// fragment, discard inline script elements before rendering. This deliberately
// scans tag boundaries instead of attempting multi-character HTML sanitization
// with regex replacement. External <script src=...> elements are preserved.
function stripInlineScripts(body){
    const html=String(body||'');
    const lower=html.toLowerCase();
    let cursor=0,out='';
    while(cursor<html.length){
        const start=lower.indexOf('<script',cursor);
        if(start<0){out+=html.slice(cursor);break;}
        if(!scriptBoundary(lower[start+7])){
            out+=html.slice(cursor,start+7);
            cursor=start+7;
            continue;
        }
        const openEnd=html.indexOf('>',start+7);
        if(openEnd<0){
            // A server-generated malformed script tag is safer omitted than
            // passed through to browser error-recovery parsing.
            out+=html.slice(cursor,start);
            break;
        }
        const openTag=html.slice(start,openEnd+1);
        if(externalScriptTag(openTag)){
            out+=html.slice(cursor,openEnd+1);
            cursor=openEnd+1;
            continue;
        }
        const closeStart=lower.indexOf('</script',openEnd+1);
        if(closeStart<0){
            out+=html.slice(cursor,start);
            break;
        }
        const closeEnd=html.indexOf('>',closeStart+8);
        if(closeEnd<0){
            out+=html.slice(cursor,start);
            break;
        }
        out+=html.slice(cursor,start);
        cursor=closeEnd+1;
    }
    return out;
}

function layout(options={}){
    return core.layout({...options,body:stripInlineScripts(options.body)});
}

module.exports={...core,layout,stripInlineScripts};
