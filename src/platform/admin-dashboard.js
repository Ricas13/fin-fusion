'use strict';
const {layout}=require('./admin-html');
const {dashboardData}=require('./admin-dashboard-data');
const {renderDashboard}=require('./admin-dashboard-view');
function isNativeAdmin(req){return Boolean(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)}
async function dashboardPage(req,res){
  if(!isNativeAdmin(req))return res.redirect('/login?session=expired');
  res.setHeader('Cache-Control','no-store, private, max-age=0');
  res.setHeader('Pragma','no-cache');
  try{
    const stats=await dashboardData();
    return res.send(layout({siteName:process.env.SITE_NAME||'CAPTaINFiN',active:'dashboard',title:'Admin Dashboard',subtitle:'Customers, resellers, subscriptions and Jellyfin operations',body:renderDashboard(stats),action:'<a class="button" href="/admin/users/new">+ Add customer</a>'}));
  }catch(error){
    console.error('Admin dashboard failed:',error.message);
    return res.status(500).render('auth/message',{siteName:process.env.SITE_NAME||'CAPTaINFiN',title:'Dashboard unavailable',message:'The administration dashboard could not be loaded safely.',link:'/admin/servers',linkText:'Open Servers'});
  }
}
module.exports={dashboardPage,dashboardData};