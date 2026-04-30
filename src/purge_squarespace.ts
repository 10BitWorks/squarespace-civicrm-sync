import * as dotenv from 'dotenv';
import { CiviCRM } from './civicrm';

dotenv.config();

const isDryRun = process.argv.includes('--apply') ? false : true;

async function runPurge() {
  console.log(`--- CiviCRM Squarespace Data Purge (${isDryRun ? 'DRY-RUN' : 'APPLY'}) ---`);
  const civicrm = new CiviCRM({ preview: false });

  // 1. Purge Activities
  console.log('Targeting Activities with subjects "Squarespace Signup %" or "Squarespace Renewal %"...');
  const activityWhere = [['OR', [
    ['subject', 'LIKE', 'Squarespace Signup %'],
    ['subject', 'LIKE', 'Squarespace Renewal %'],
    ['details', 'LIKE', '%squarespace%']
  ]]];
  const activityMatches = await civicrm.apiRequest('Activity', 'get', {
    select: ['row_count'],
    where: activityWhere,
  });
  const activityCount = activityMatches.countMatched || 0;
  console.log(`Found ${activityCount} matched activities.`);

  if (!isDryRun && activityCount > 0) {
    console.log('Deleting matched activities...');
    // In APIv4, we can use where in delete
    const result = await civicrm.apiRequest('Activity', 'delete', {
      where: activityWhere
    });
    console.log(`Successfully deleted activities.`);
  }

  // 2. Purge Contributions
  console.log('Targeting Contributions with source "Squarespace Order #%"...');
  const contribWhere = [['source', 'LIKE', 'Squarespace Order #%']];
  const contribMatches = await civicrm.apiRequest('Contribution', 'get', {
    select: ['row_count'],
    where: contribWhere,
  });
  const contribCount = contribMatches.countMatched || 0;
  console.log(`Found ${contribCount} matched contributions.`);

  if (!isDryRun && contribCount > 0) {
    console.log('Deleting matched contributions...');
    const result = await civicrm.apiRequest('Contribution', 'delete', {
      where: contribWhere
    });
    console.log(`Successfully deleted contributions.`);
  }

  // 3. Purge Memberships
  console.log('Targeting Memberships with source like "Squarespace Order #" or "Squarespace Sync"...');
  const membershipWhere = [['OR', [['source', 'LIKE', 'Squarespace Order #%'], ['source', 'LIKE', 'Squarespace Sync%']]]];
  const membershipMatches = await civicrm.apiRequest('Membership', 'get', {
    select: ['id'],
    where: membershipWhere,
  });
  const membershipCount = membershipMatches.countMatched || 0;
  console.log(`Found ${membershipCount} matched memberships.`);

  if (!isDryRun && membershipCount > 0) {
    console.log('Deleting matched memberships...');
    const result = await civicrm.apiRequest('Membership', 'delete', {
      where: membershipWhere
    });
    console.log(`Successfully deleted memberships.`);
  }

  if (isDryRun) {
    console.log('\nDRY RUN complete. Add "--apply" to permanently delete these records.');
  } else {
    console.log('\nPURGE complete. Database is clean of Squarespace membership data.');
  }
}

runPurge().catch(console.error);
