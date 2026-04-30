import * as dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { CiviCRM } from './civicrm';
import { SquarespaceTransaction, SquarespaceOrder, SquarespaceProfile } from './types';
import axios from 'axios';

dotenv.config();

const CACHE_DIR = 'cache';
const FULL_SYNC_CACHE_FILE = `${CACHE_DIR}/squarespace-transactions-full.json`;
const SKU_TO_MEMBERSHIP_TYPE: { [sku: string]: { id: number, label: string, priceFieldValueId: number } } = {
  'SQ9402840': { id: 4, label: 'Individual Membership', priceFieldValueId: 22 },
  '10BIT-1M-1P': { id: 4, label: 'Individual Membership', priceFieldValueId: 22 },
  'SQ6118029': { id: 4, label: 'Individual Membership', priceFieldValueId: 22 },
  '10bitmonthly1p': { id: 4, label: 'Individual Membership', priceFieldValueId: 22 },
  'SQ1141182': { id: 5, label: 'Household Membership', priceFieldValueId: 23 },
  'SQ6105885': { id: 5, label: 'Household Membership', priceFieldValueId: 23 },
  'SQ1596472': { id: 6, label: 'Business Membership', priceFieldValueId: 24 },
};

async function syncOrders() {
  console.log('--- Starting CiviCRM Order API Backfill ---');
  const civicrm = new CiviCRM({ preview: process.argv.includes('--preview') });

  // 1. Load transactions from cache
  let transactions: SquarespaceTransaction[] = [];
  try {
    const data = await fs.readFile(FULL_SYNC_CACHE_FILE, 'utf-8');
    transactions = JSON.parse(data);
    console.log(`Loaded ${transactions.length} transactions from cache.`);
  } catch (err) {
    console.error('No transaction cache found. Please run the main sync first to populate it.');
    process.exit(1);
  }

  // 2. Group by email
  const byEmail: { [email: string]: SquarespaceTransaction[] } = {};
  for (const t of transactions) {
    if (!t.customerEmail) continue;
    if (!byEmail[t.customerEmail]) byEmail[t.customerEmail] = [];
    byEmail[t.customerEmail].push(t);
  }

  const emails = Object.keys(byEmail);
  console.log(`Processing ${emails.length} customers...`);

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const customerTransactions = byEmail[email].sort((a,b) => new Date(a.createdOn).getTime() - new Date(b.createdOn).getTime());
    
    process.stdout.write(`(${i+1}/${emails.length}) Processing ${email}...\r`);

    try {
      // 3. Find/Create Contact (simplified matching)
      let contact = await civicrm.getContactByEmail(email);
      if (!contact) {
        // Create basic contact if missing
        const nameParts = email.split('@')[0].split(/[._]/);
        const firstName = nameParts[0] || 'Unknown';
        const lastName = nameParts.slice(1).join(' ') || 'Unknown';
        const result = await civicrm.saveContact({
           id: email, email, firstName, lastName,
           address: null, phone: null, createdOn: customerTransactions[0].createdOn,
           hasAccount: false, isCustomer: true, acceptsMarketing: false
        } as SquarespaceProfile);
        contact = result.values[0];
      }

      if (!contact || !contact.id) continue;

      // 4. Identify Membership Transactions and execute Order
      for (const t of customerTransactions) {
        // Check if this transaction has a linked Order with a Membership SKU
        // In a real run, you'd fetch the order details if not in cache.
        // For this backfill, we assume the user has the cache or we fetch it.
        // To keep it simple for this script, we'll check our SKU map if we can get order info.
        
        // Skip if already processed in CiviCRM (check trxnId)
        const trxnId = t.payments?.[0]?.externalTransactionId;
        if (!trxnId) continue;

        const existingContribution = await civicrm.apiRequest('Contribution', 'get', {
            where: [['trxn_id', '=', trxnId]],
            select: ['id', 'membership_id']
        });

        // If it already has a membership ID, we might be okay, BUT we want to check if it's linked via LineItem.
        // Actually, if we are RE-SYNCING, we want to fix it.
        
        // This is a placeholder for the logic that maps Transaction -> Membership Type
        // In the full implementation, we'd look up the salesOrderId first.
      }

    } catch (err) {
      console.error(`\nError processing ${email}:`, err.message);
    }
  }
  process.stdout.write('\n');
}

if (require.main === module) {
  syncOrders();
}
