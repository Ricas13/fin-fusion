'use strict';

// Reads the repo's own GitBook-structured documentation (docs/guide/,
// driven by SUMMARY.md and published via .gitbook.yaml) and adapts it for
// in-app rendering by docs-render.js. This is the single source of truth
// for both the admin guide (/admin/docs) and the end-user guide
// (/account/docs) -- neither audience gets separately hand-authored
// content, so the two surfaces can never drift from each other or from
// the GitBook-published version.

const fs=require('fs');
const path=require('path');

const GUIDE_DIR=path.join(__dirname,'..','..','docs','guide');

function slugify(value){return String(value||'').toLowerCase().replace(/\.md$/,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'page';}
function stripLeadingHeading(content){return String(content||'').replace(/^\s*#\s+[^\n]*\n+/,'');}

function parseSummary(){
  const raw=fs.readFileSync(path.join(GUIDE_DIR,'SUMMARY.md'),'utf8');
  const sections=[];
  let current=null;
  for(const line of raw.split('\n')){
    const heading=line.match(/^##\s+(.*)/);
    if(heading){current={title:heading[1].trim(),pages:[]};sections.push(current);continue;}
    const item=line.match(/^\*\s*\[([^\]]+)\]\(([^)]+)\)/);
    if(item&&current)current.pages.push({label:item[1].trim(),file:item[2].trim()});
  }
  return sections;
}

function loadSections(sectionTitles){
  const all=parseSummary();
  return sectionTitles.map(title=>all.find(section=>section.title===title)).filter(Boolean).map(section=>({
    slug:slugify(section.title),
    title:section.title,
    pages:section.pages.map(page=>({
      slug:slugify(page.file),
      title:page.label,
      body:stripLeadingHeading(fs.readFileSync(path.join(GUIDE_DIR,page.file),'utf8'))
    }))
  }));
}

module.exports={loadSections};
