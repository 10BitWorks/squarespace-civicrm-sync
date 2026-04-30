import * as dotenv from 'dotenv';
import { CiviCRM } from './civicrm';

dotenv.config();

async function checkCounts() {
  const civicrm = new CiviCRM({ preview: false });
  const counts = await civicrm.apiRequest('Activity', 'get', {
    select: ['row_count'],
    where: [['activity_type_id', '=', 2]],
  });
  console.log('Membership Renewal Activity Count:', counts.countMatched);
  
  const signups = await civicrm.apiRequest('Activity', 'get', {
    select: ['row_count'],
    where: [['activity_type_id', '=', 7]],
  });
  console.log('Membership Signup Activity Count:', signups.countMatched);
}

checkCounts().catch(console.error);
