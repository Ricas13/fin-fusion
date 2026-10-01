'use strict';

const assert=require('assert');
const fs=require('fs');

const source=fs.readFileSync('src/platform/configuration-transfer.js','utf8');

for(const owner of [
  "../catalog/plan-command-service",
  "../configuration/platform-settings-command-service",
  "../integrations/notification-preferences-command-service",
  "../automation/job-health"
]){
  assert(source.includes(`require('${owner}')`), `configuration transfer must delegate to ${owner}`);
}

for(const table of [
  'plans',
  'plan_server_eligibility',
  'plan_provider_prices',
  'platform_settings',
  'notification_preferences',
  'automation_job_state'
]){
  const mutation=new RegExp('(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+'+table+'\\b','i');
  assert(!mutation.test(source), `configuration transfer must not directly mutate ${table}`);
}

assert(source.includes('planCommands.applyImportedPlans('),'plan import must use the catalog command owner');
assert(source.includes('planCommands.applyImportedProviderMappings('),'provider mapping import must use the catalog command owner');
assert(source.includes('platformSettingsCommands.applyImportedSettings('),'settings import must use the settings command owner');
assert(source.includes('notificationPreferenceCommands.applyImportedPreferences('),'notification import must use the notification command owner');
assert(source.includes('jobHealth.applyImportedState('),'automation import must use the automation state owner');
assert(source.includes('return transaction(async client=>'),'configuration application must remain one explicit transaction boundary');

console.log('configuration transfer ownership smoke: ok');
