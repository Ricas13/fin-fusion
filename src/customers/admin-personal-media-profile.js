'use strict';

const {transaction}=require('../db');
const linkedProfile=require('./admin-linked-profile');

async function createPersonalMediaProfile({
  userId,
  displayName='',
  planCode=''
}){
  return transaction(client=>linkedProfile.createPersonalMediaProfileTx(client,{
    userId,
    displayName,
    planCode,
    actorUserId:userId
  }));
}

module.exports={createPersonalMediaProfile};
