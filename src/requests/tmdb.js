'use strict';

const BASE_URL='https://api.themoviedb.org/3';
const ALLOWED_PATH=/^\/(search\/(movie|tv)|trending\/all\/(day|week)|movie\/\d+|tv\/\d+\/external_ids)$/;

function token(){return String(process.env.TMDB_ACCESS_TOKEN||'').trim()}
function enabled(){return token().length>=20}
function cleanPage(value){const n=Number.parseInt(value,10);return Number.isInteger(n)&&n>=1&&n<=1000?n:1}
function cleanQuery(value){return String(value||'').trim().slice(0,120)}
async function request(path,params={}){
    if(!enabled())throw new Error('TMDB is not configured');
    if(!ALLOWED_PATH.test(path))throw new Error('Unsupported TMDB request');
    const url=new URL(BASE_URL+path);
    for(const [key,value] of Object.entries(params)){if(value!==undefined&&value!==null&&String(value)!=='')url.searchParams.set(key,String(value))}
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),6000);
    try{
        const response=await fetch(url,{method:'GET',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${token()}`,Accept:'application/json'}});
        if(!response.ok)throw new Error(`TMDB request failed (${response.status})`);
        const type=String(response.headers.get('content-type')||'');if(!type.includes('application/json'))throw new Error('TMDB returned an unexpected response');
        return await response.json();
    }catch(error){if(error.name==='AbortError')throw new Error('TMDB request timed out');throw error}finally{clearTimeout(timer)}
}
function normalize(item,forcedType=null){const mediaType=forcedType||(item.media_type==='tv'?'series':item.media_type==='movie'?'movie':null);if(!mediaType)return null;const date=mediaType==='movie'?item.release_date:item.first_air_date;return{mediaType,tmdbId:Number(item.id),title:String(mediaType==='movie'?item.title:item.name||''),originalTitle:String(mediaType==='movie'?item.original_title:item.original_name||''),overview:String(item.overview||''),year:date?Number(String(date).slice(0,4))||null:null,posterPath:item.poster_path||null,backdropPath:item.backdrop_path||null,popularity:Number(item.popularity||0),voteAverage:Number(item.vote_average||0)}}
async function search(mediaType,query,page=1){query=cleanQuery(query);if(!query)return[];const kind=mediaType==='series'?'tv':'movie';const data=await request(`/search/${kind}`,{query,page:cleanPage(page),include_adult:false,language:'en-US'});return (data.results||[]).map(x=>normalize(x,mediaType)).filter(Boolean)}
async function trending(){const data=await request('/trending/all/week',{language:'en-US'});return(data.results||[]).map(x=>normalize(x)).filter(Boolean)}
async function movieDetails(tmdbId){const data=await request(`/movie/${Number(tmdbId)}`,{language:'en-US'});return normalize(data,'movie')}
async function seriesExternalIds(tmdbId){const data=await request(`/tv/${Number(tmdbId)}/external_ids`);return{tvdbId:Number(data.tvdb_id)||null,imdbId:data.imdb_id||null}}
function posterUrl(path,size='w342'){if(!path)return null;if(!/^\/[A-Za-z0-9._/-]+$/.test(String(path)))return null;return`https://image.tmdb.org/t/p/${size}${path}`}
module.exports={enabled,search,trending,movieDetails,seriesExternalIds,posterUrl,normalize};
