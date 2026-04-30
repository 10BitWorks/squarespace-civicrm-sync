import * as dotenv from 'dotenv';
import { CiviCRM } from './civicrm';

dotenv.config();

async function checkTypes() {
  const civicrm = new CiviCRM({ preview: false });
  const types = await civicrm.apiRequest('ActivityType', 'get', {
    select: ['id', 'name', 'label'],
  });
  console.log('Activity Types:', JSON.stringify(types.values, null, 2));
}

checkTypes().catch(console.error);
