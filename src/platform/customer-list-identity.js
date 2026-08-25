'use strict';

function clean(value){return String(value||'').trim();}
function sameIdentity(a,b){const left=clean(a),right=clean(b);return Boolean(left&&right&&left.toLowerCase()===right.toLowerCase());}

function customerIdentity(row={}){
    const primary=[row.display_name,row.login_username,row.jellyfin_username,row.email].map(clean).find(Boolean)||'Customer';
    const secondary=[row.email,row.login_username,row.jellyfin_username].map(clean).find(value=>value&&!sameIdentity(value,primary))||'';
    return{primary,secondary};
}

module.exports={customerIdentity,sameIdentity};
