'use strict';

const passwordBreach=require('./password-breach');

function validatePassword(password){
  if(typeof password!=='string'||password.length<8||password.length>200){
    throw new Error('Password must be between 8 and 200 characters');
  }
}

async function validateNewPassword(password){
  validatePassword(password);
  await passwordBreach.assertNotBreached(password);
}

module.exports={validatePassword,validateNewPassword};
