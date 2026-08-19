'use strict';

function positive(value,label,max=10000){const n=Number(value);if(!Number.isInteger(n)||n<0||n>max)throw new Error(`Invalid ${label}.`);return n;}
function query({userId,seriesId,season,episode,fields='Path'}){
  const user=String(userId||'').trim(),series=String(seriesId||'').trim();if(!user||!series)throw new Error('Jellyfin user and series identifiers are required.');
  const seasonNumber=positive(season,'season number',999),episodeNumber=positive(episode,'episode number',9999);
  return new URLSearchParams({
    ParentId:series,
    Recursive:'true',
    IncludeItemTypes:'Episode',
    IndexNumber:String(episodeNumber),
    ParentIndexNumber:String(seasonNumber),
    Fields:String(fields||'Path'),
    StartIndex:'0',
    Limit:'25',
    EnableImages:'false',
    EnableUserData:'false',
    EnableTotalRecordCount:'false',
    IsMissing:'false'
  });
}
function pick(payload,season,episode){
  const seasonNumber=Number(season),episodeNumber=Number(episode),items=Array.isArray(payload?.Items)?payload.Items:[];
  return items.find(item=>Number(item?.IndexNumber)===episodeNumber&&Number(item?.ParentIndexNumber)===seasonNumber)||null;
}
function userItemsPath({userId,seriesId,season,episode,fields='Path'}){
  const qs=query({userId,seriesId,season,episode,fields});
  return `/Users/${encodeURIComponent(String(userId))}/Items?${qs.toString()}`;
}

module.exports={positive,query,pick,userItemsPath};
