import * as dotenv from 'dotenv';
import { CiviCRM } from './src/civicrm';

dotenv.config();

async function testRenewals() {
  const civicrm = new CiviCRM({ preview: false });
  // Find Sam Selig (Contact ID 3306)
  const contactId = 3306;
  const membershipTypeId = 4; // Individual

  const memberships = await civicrm.apiRequest('Membership', 'get', {
    where: [['contact_id', '=', contactId]],
    limit: 1
  });

  if (memberships.count === 0) {
    console.log('No membership found for Sam.');
    return;
  }
  const membershipId = memberships.values[0].id;
  console.log(`Testing with Membership ID: ${membershipId}`);

  // 10 transactions = 10 renewals?
  for (let i = 0; i < 2; i++) {
    const trxnId = `renewal_test_${Date.now()}_${i}`;
    const date = `2026-0${3 + i}-01 10:00:00`;
    console.log(`Performing renewal ${i+1} on ${date}...`);

    const orderRes = await (civicrm as any).syncMembershipWithPayment({
      contactId,
      membershipTypeId,
      priceFieldValueId: 22,
      amount: 75,
      currency: 'USD',
      trxnId,
      receiveDate: date,
      source: `Renewal Test ${i+1}`,
      membershipId
    });
    console.log(`Order created: ${orderRes.values?.[0]?.id}`);

    // Fetch again to see state
    const current = await civicrm.apiRequest('Membership', 'get', { where: [['id', '=', membershipId]] });
    const currentEnd = new Date(current.values[0].end_date);
    currentEnd.setMonth(currentEnd.getMonth() + 1);
    const newEnd = currentEnd.toISOString().slice(0, 10);
    
    await civicrm.saveMembership({
      id: membershipId,
      end_date: newEnd,
      is_override: false
    });
    console.log(`Membership updated to end on ${newEnd}`);
  }

  const logs = await civicrm.apiRequest('MembershipLog', 'get', {
    where: [['membership_id', '=', membershipId]]
  });
  console.log(`Found ${logs.count} log entries.`);
}

testRenewals().catch(console.error);
