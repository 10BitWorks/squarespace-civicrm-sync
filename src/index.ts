import axios from 'axios';
import * as dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { CiviCRM } from './civicrm';
import { OpenCollective } from './opencollective';
import { SquarespaceOrder, SquarespaceTransaction, SquarespaceProfile, CiviCRMMembership } from './types';

dotenv.config();

const SKU_TO_MEMBERSHIP_TYPE: { [sku: string]: string } = {
  'SQ9402840': 'Individual Membership',
  '10BIT-1M-1P': 'Individual Membership',
  'SQ6118029': 'Individual Membership',
  '10bitmonthly1p': 'Individual Membership',
  'SQ1141182': 'Household Membership',
  'SQ6105885': 'Household Membership',
  'SQ1596472': 'Business Membership',
  'SQ_SINGLE_DAY': 'Single Day Membership',
  'SINGLE-DAY-1': 'Single Day Membership',
};

const PRICE_FIELD_VALUE_MAP: { [sku: string]: number } = {
  'SQ9402840': 22, // Individual Membership
  '10BIT-1M-1P': 22,
  'SQ6118029': 22,
  '10bitmonthly1p': 22,
  'SQ1141182': 23, // Household Membership
  'SQ6105885': 23,
  'SQ1596472': 24, // Business Membership
  'SQ_SINGLE_DAY': 22, // Fallback for single day
  'SINGLE-DAY-1': 22,
};

const SPECIAL_CASE_SKUS = new Set(['10BIT-1M-1P']);
const SINGLE_DAY_SKUS = new Set(['SQ_SINGLE_DAY', 'SINGLE-DAY-1']);

const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY;
const OPENCOLLECTIVE_API_KEY = process.env.OPENCOLLECTIVE_API_KEY;
const OPENCOLLECTIVE_SLUG = process.env.OPENCOLLECTIVE_SLUG;
const SQUARESPACE_API_URL = 'https://api.squarespace.com/1.0';
const TIMESTAMP_FILE = '.last_sync_timestamp';
const OC_SYNC_MAP_FILE = 'cache/opencollective-sync-map.json';
const PROGRESS_FILE = '.last_successful_email';
const CACHE_DIR = 'cache';
const FULL_SYNC_CACHE_FILE = `${CACHE_DIR}/squarespace-transactions-full.json`;
const ORDERS_FULL_CACHE_FILE = `${CACHE_DIR}/squarespace-orders-full.json`;
const PROFILES_FULL_CACHE_FILE = `${CACHE_DIR}/squarespace-profiles-full.json`;
const SYNC_LOCK_FILE = '.sync.lock';

interface SquarespaceTransactionsResponse {
  documents: SquarespaceTransaction[];
  pagination: {
    nextPageCursor: string | null;
  };
}

async function readLastSyncTimestamp(): Promise<string | null> {
  try {
    return await fs.readFile(TIMESTAMP_FILE, 'utf-8');
  } catch (error) {
    // If the file doesn't exist, it's the first run.
    return null;
  }
}

async function writeLastSyncTimestamp(timestamp: string): Promise<void> {
  await fs.writeFile(TIMESTAMP_FILE, timestamp, 'utf-8');
}

async function readLastSuccessfulEmail(): Promise<string | null> {
  try {
    return await fs.readFile(PROGRESS_FILE, 'utf-8');
  } catch (error) {
    return null; // File doesn't exist, first run
  }
}

async function writeLastSuccessfulEmail(email: string): Promise<void> {
  await fs.writeFile(PROGRESS_FILE, email, 'utf-8');
}

async function getNameFromLineItems(order: SquarespaceOrder | null): Promise<string | null> {
  if (order?.lineItems) {
    for (const item of order.lineItems) {
      if (item.customizations) {
        // Special case for certain SKUs where only emergency contact info is provided.
        if (item.sku && SPECIAL_CASE_SKUS.has(item.sku) && item.customizations.length <= 2) {
          return null; // Force use of billing contact name
        }

        for (const custom of item.customizations) {
          // The member's name can be in a field labeled "Name" or "Full Name".
          const label = custom.label.toLowerCase();
          if ((label === 'name' || label === 'full name') && custom.value) {
            return custom.value;
          }
        }
      }
    }
  }
  return null;
}

export function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function computeMembershipEndDate(civicrm: CiviCRM, startDateStr: string, membershipTypeId: number, sku?: string): Promise<string | null> {
  // If this SKU denotes a single-day membership, the end date == start date
  if (sku && SINGLE_DAY_SKUS.has(sku)) {
    return startDateStr.slice(0, 10);
  }

  const details = await civicrm.getMembershipTypeDetails(membershipTypeId);
  // Fallback: if we can't get details, default to 1-month period
  if (!details) {
    const sd = new Date(`${startDateStr.slice(0, 10)}T00:00:00`);
    const ed = new Date(sd);
    ed.setMonth(ed.getMonth() + 1);
    ed.setDate(ed.getDate() - 1);
    return formatDateOnly(ed);
  }

  const unit = (details.duration_unit || 'month').toLowerCase();
  const interval = parseInt(details.duration_interval || '1', 10) || 1;
  if (unit === 'lifetime') return null;

  const sd = new Date(`${startDateStr.slice(0, 10)}T00:00:00`);
  let ed = new Date(sd);

  if (unit === 'year') {
    ed = new Date(sd.getFullYear() + interval, sd.getMonth(), sd.getDate());
    // subtract one day to make it inclusive
    ed.setDate(ed.getDate() - 1);
  } else if (unit === 'month') {
    ed = new Date(sd);
    ed.setMonth(ed.getMonth() + interval);
    // If the new date's day-of-the-month has changed, it means we rolled over.
    // e.g., Jan 31 + 1 month = March 3. We need to go back to the end of Feb.
    if (ed.getDate() !== sd.getDate()) {
      ed.setDate(0);
    }
  } else if (unit === 'day') {
    ed = new Date(sd);
    ed.setDate(ed.getDate() + interval);
  } else {
    // Unknown unit - fallback to 1 month
    ed = new Date(sd);
    ed.setMonth(ed.getMonth() + 1);
    ed.setDate(ed.getDate() - 1);
  }

  return formatDateOnly(ed);
}

function titleCase(str: string): string {
  if (str.toUpperCase() === str) {
    return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
  }
  return str;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getSquarespaceTransactions(modifiedAfter?: string | null, modifiedBefore?: string | null): Promise<SquarespaceTransaction[]> {
  let allTransactions: SquarespaceTransaction[] = [];
  let cursor: string | null = null;
  const MAX_RETRIES = 3;
  const INITIAL_RETRY_DELAY = 1000; // 1 second
  let pageCount = 0;

  console.log(modifiedAfter ? `Fetching transactions modified between ${modifiedAfter} and ${modifiedBefore}...` : 'Fetching all transactions from Squarespace...');

  do {
    let retries = 0;
    let success = false;
    pageCount++;

    while (retries < MAX_RETRIES && !success) {
      try {
        const url = new URL(`${SQUARESPACE_API_URL}/commerce/transactions`);

        if (cursor) {
          url.searchParams.append('cursor', cursor);
        } else if (modifiedAfter && modifiedBefore) {
          url.searchParams.append('modifiedAfter', modifiedAfter);
          url.searchParams.append('modifiedBefore', modifiedBefore);
        }

        const response = await axios.get<SquarespaceTransactionsResponse>(url.toString(), {
          headers: {
            'Authorization': `Bearer ${SQUARESPACE_API_KEY}`,
            'User-Agent': 'squarespace-civicrm-sync',
          },
        });

        if (response.data.documents) {
          allTransactions = allTransactions.concat(response.data.documents);
          process.stdout.write(`Fetched ${pageCount} pages, ${allTransactions.length} transactions...\r`);
        }

        cursor = response.data.pagination ? response.data.pagination.nextPageCursor : null;
        success = true; // Mark as successful to exit the retry loop

      } catch (error: any) {
        if (error.response && error.response.status >= 500 && retries < MAX_RETRIES) {
          retries++;
          const waitTime = INITIAL_RETRY_DELAY * Math.pow(2, retries);
          console.warn(`Received status ${error.response.status}. Retrying in ${waitTime / 1000}s... (${retries}/${MAX_RETRIES})`);
          await delay(waitTime);
        } else {
          console.error('Error fetching Squarespace transactions:', error);
          throw error;
        }
      }
    }
    // Add a small delay between each paginated request to respect rate limits
    if (cursor) {
      await delay(250); // ~4 requests per second, well under the 5/sec limit
    }
  } while (cursor);

  process.stdout.write('\n'); // Move to the next line after fetching is complete
  console.log(`Finished fetching. Found ${allTransactions.length} total transactions.`);
  return allTransactions;
}

async function getSquarespaceOrderById(orderId: string): Promise<SquarespaceOrder | null> {
  const MAX_RETRIES = 3;
  const INITIAL_RETRY_DELAY = 1000; // 1 second

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${SQUARESPACE_API_URL}/commerce/orders/${orderId}`;
      const response = await axios.get<SquarespaceOrder>(url, {
        headers: {
          'Authorization': `Bearer ${SQUARESPACE_API_KEY}`,
          'User-Agent': 'squarespace-civicrm-sync',
        },
      });
      return response.data; // Success
    } catch (error: any) {
      if (error.response && error.response.status >= 500 && attempt < MAX_RETRIES) {
        const waitTime = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
        console.warn(`Attempt ${attempt} failed for order ${orderId} with status ${error.response.status}. Retrying in ${waitTime / 1000}s...`);
        await delay(waitTime);
      } else {
        console.error(`Failed to fetch Squarespace order ${orderId} after ${attempt} attempts:`, error);
        return null; // Final failure or non-retriable error
      }
    }
  }
  return null;
}

// We'll maintain an in-memory map of orders and profiles to reduce API calls
const ordersCacheMap: Map<string, SquarespaceOrder> = new Map();
const profilesCacheMap: Map<string, SquarespaceProfile> = new Map();

async function getCachedSquarespaceOrderById(orderId: string): Promise<SquarespaceOrder | null> {
  if (!orderId) return null;
  if (ordersCacheMap.has(orderId)) return ordersCacheMap.get(orderId) as SquarespaceOrder;
  const order = await getSquarespaceOrderById(orderId);
  if (order) ordersCacheMap.set(orderId, order);
  return order;
}

async function getSquarespaceProfileByEmail(email: string): Promise<SquarespaceProfile | null> {
  if (!email) return null;
  if (profilesCacheMap.has(email)) return profilesCacheMap.get(email) as SquarespaceProfile;
  const MAX_RETRIES = 3;
  const INITIAL_RETRY_DELAY = 1000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${SQUARESPACE_API_URL}/profiles?filter=email,${encodeURIComponent(email)}`;
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${SQUARESPACE_API_KEY}`,
          'User-Agent': 'squarespace-civicrm-sync',
        },
      });
      const profiles = (response.data && (response.data.profiles || response.data.Profiles)) || [];
      if (profiles && profiles.length > 0) {
        const profile = profiles[0] as SquarespaceProfile;
        profilesCacheMap.set(email, profile);
        return profile;
      }
      return null;
    } catch (err: any) {
      if (err.response && err.response.status >= 500 && attempt < MAX_RETRIES) {
        const waitTime = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
        console.warn(`Attempt ${attempt} failed fetching profile for ${email}; retrying in ${waitTime / 1000}s...`);
        await delay(waitTime);
      } else {
        console.error(`Failed to fetch profile for ${email}:`, err?.message || err);
        return null;
      }
    }
  }
  return null;
}


console.log('Starting Squarespace to CiviCRM sync...');

// Main run function (exported so other scripts can call it)
export async function runSync(opts?: { singleEmail?: string; apply?: boolean; forceFull?: boolean; opencollective?: boolean; dryRun?: boolean }) {
  const syncStartTime = new Date().toISOString();
  let lastSync = await readLastSyncTimestamp();
  if (opts && opts.forceFull) {
    console.log('Force full sync requested for this run; ignoring last sync timestamp.');
    lastSync = null;
  }
  const lastSuccessfulEmail = await readLastSuccessfulEmail();

  // --- Startup Warning for Full Sync ---
  if (!lastSync) {
    console.warn('\n--- FULL SYNC DETECTED ---');
    console.warn(`To re-fetch all data from scratch, run 'npm run reset:hard' before starting the sync.`);
    console.warn('--------------------------\n');
  }

  const civicrm = new CiviCRM({ preview: !(opts && opts.apply) });

  // Initialize OpenCollective if requested
  let openCollective: OpenCollective | null = null;
  let ocSyncMap: { [sqId: string]: string } = {};

  if (opts?.opencollective) {
    if (!OPENCOLLECTIVE_API_KEY || !OPENCOLLECTIVE_SLUG) {
      console.error('Missing OPENCOLLECTIVE_API_KEY or OPENCOLLECTIVE_SLUG env vars.');
      process.exit(1);
    }
    console.log(`OpenCollective Sync ENABLED (Target: ${OPENCOLLECTIVE_SLUG})`);
    if (opts.dryRun) console.log('OpenCollective Dry Run: ENABLED');

    openCollective = new OpenCollective(
      OPENCOLLECTIVE_API_KEY,
      OPENCOLLECTIVE_SLUG,
      'cpd', // Fallback/Proxy user
      opts.dryRun
    );

    // Load Sync Map
    try {
      const mapData = await fs.readFile(OC_SYNC_MAP_FILE, 'utf-8');
      ocSyncMap = JSON.parse(mapData);
      console.log(`Loaded ${Object.keys(ocSyncMap).length} previously synced transactions from map.`);
    } catch (e) {
      console.log('No existing OpenCollective sync map found. Starting fresh.');
    }
  }

  // --- Caching Logic ---
  let transactions: SquarespaceTransaction[];
  // Ensure cache directory exists
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating cache directory:', error);
    process.exit(1);
  }

  if (lastSync) {
    // Incremental sync: always fetch from the API
    console.log('Performing incremental sync, bypassing cache.');
    transactions = await getSquarespaceTransactions(lastSync, syncStartTime);
    // Re-fetch Profiles for emails that appear among changed transactions; this updates the local profile cache.
    const changedEmails = Array.from(new Set(transactions.map(t => t.customerEmail).filter(Boolean)));
    console.log(`Re-fetching ${changedEmails.length} changed profile(s) from Squarespace to ensure accurate profile data.`);
    for (const email of changedEmails) {
      if (!email) continue;
      await getSquarespaceProfileByEmail(email);
    }
  } else {
    // Full sync: try to use cache
    try {
      const cachedData = await fs.readFile(FULL_SYNC_CACHE_FILE, 'utf-8');
      console.log(`Using cached Squarespace transaction data from ${FULL_SYNC_CACHE_FILE}.`);
      transactions = JSON.parse(cachedData);
    } catch (error) {
      // Cache miss: fetch from API and write to cache
      console.log('No cached data found. Fetching all transactions from Squarespace...');
      transactions = await getSquarespaceTransactions();
      try {
        await fs.writeFile(FULL_SYNC_CACHE_FILE, JSON.stringify(transactions, null, 2), 'utf-8');
        console.log(`Saved full transaction list to ${FULL_SYNC_CACHE_FILE}.`);
      } catch (writeError) {
        console.error('Error writing to cache file:', writeError);
      }
    }
  }
  // Persist orders and profiles caches for full syncs so subsequent runs can rehydrate them.
  if (!lastSync) {
    try {
      const ordersArray = Array.from(ordersCacheMap.values());
      await fs.writeFile(ORDERS_FULL_CACHE_FILE, JSON.stringify(ordersArray, null, 2), 'utf-8');
      console.log(`Saved ${ordersArray.length} orders to ${ORDERS_FULL_CACHE_FILE}.`);
    } catch (e) {
      console.error('Error writing orders cache:', e);
    }
    try {
      const profilesArray = Array.from(profilesCacheMap.values());
      await fs.writeFile(PROFILES_FULL_CACHE_FILE, JSON.stringify(profilesArray, null, 2), 'utf-8');
      console.log(`Saved ${profilesArray.length} profiles to ${PROFILES_FULL_CACHE_FILE}.`);
    } catch (e) {
      console.error('Error writing profiles cache:', e);
    }
  }
  // --- End Caching Logic ---

  // For a full sync, try loading the orders and profiles caches if they exist to avoid re-fetching lots of data.
  if (!lastSync) {
    try {
      const ordersCachedData = await fs.readFile(ORDERS_FULL_CACHE_FILE, 'utf-8');
      const ordersArray = JSON.parse(ordersCachedData) as SquarespaceOrder[];
      ordersArray.forEach(o => ordersCacheMap.set(o.id, o));
      console.log(`Loaded ${ordersArray.length} orders from ${ORDERS_FULL_CACHE_FILE}.`);
    } catch (e) {
      // No cached orders, that's okay.
    }
    try {
      const profilesCachedData = await fs.readFile(PROFILES_FULL_CACHE_FILE, 'utf-8');
      const profilesArray = JSON.parse(profilesCachedData) as SquarespaceProfile[];
      profilesArray.forEach(p => {
        if (p.email) profilesCacheMap.set(p.email, p);
      });
      console.log(`Loaded ${profilesArray.length} profiles from ${PROFILES_FULL_CACHE_FILE}.`);
    } catch (e) {
      // No cached profiles, that's okay.
    }
  }

  // Group transactions by customer email
  const transactionsByCustomer: { [email: string]: SquarespaceTransaction[] } = {};
  for (const transaction of transactions) {
    if (!transaction.customerEmail) continue;
    if (!transactionsByCustomer[transaction.customerEmail]) {
      transactionsByCustomer[transaction.customerEmail] = [];
    }
    transactionsByCustomer[transaction.customerEmail].push(transaction);
  }

  const customerEmails = Object.keys(transactionsByCustomer);
  const totalCustomers = customerEmails.length;
  let customerCount = 0;

  // Find the index of the last successful email to resume from there
  let startIndex = 0;
  if (lastSuccessfulEmail) {
    startIndex = customerEmails.indexOf(lastSuccessfulEmail);
    if (startIndex !== -1) {
      startIndex++; // Start from the next one
      console.log(`Resuming sync after ${lastSuccessfulEmail}. Starting at customer ${startIndex + 1}/${totalCustomers}.`);
    } else {
      console.log(`Last successful email "${lastSuccessfulEmail}" not found in current transaction list. Starting from the beginning.`);
      startIndex = 0;
    }
  }

  const singleRun = Boolean(opts && opts.singleEmail);
  if (singleRun) {
    const idx = customerEmails.indexOf(opts!.singleEmail!);
    if (idx === -1) {
      console.error(`Email ${opts!.singleEmail} not found in transaction set.`);
      return;
    }
    startIndex = idx;
    console.log(`Running single-customer mode for ${opts!.singleEmail} (customer ${startIndex + 1}/${totalCustomers}).`);
  }

  for (let i = startIndex; i < totalCustomers; i++) {
    const email = customerEmails[i];
    customerCount = i + 1;
    const customerTransactions = transactionsByCustomer[email].sort((a, b) => new Date(a.createdOn).getTime() - new Date(b.createdOn).getTime());
    const progress = `(Customer ${customerCount}/${totalCustomers})`;

    try {
      console.log(`\nProcessing ${progress}: ${email} (${customerTransactions.length} transactions)`);

      // --- Find or Create Contact ---
      // Prioritize finding the member's name from the order details, as the billing contact might be different.
      const firstTransaction = customerTransactions[0];
      const orderForContact = firstTransaction.salesOrderId ? await getCachedSquarespaceOrderById(firstTransaction.salesOrderId) : null;

      let firstName: string;
      let lastName: string;

      const memberNameFromLineItems = await getNameFromLineItems(orderForContact);
      // Attempt to re-use the Squarespace profile if available in the cache (updated for incremental syncs)
      const profileFromApi = await getSquarespaceProfileByEmail(email);

      if (memberNameFromLineItems) {
        const nameParts = memberNameFromLineItems.split(' ').map(part => titleCase(part));
        firstName = nameParts.shift() || '';
        lastName = nameParts.join(' ');
        console.log(`${progress} Found member name "${firstName} ${lastName}" in order details. Prioritizing over billing contact.`);
      } else if (profileFromApi) {
        // If profile exists, prefer its canonical name
        firstName = titleCase(profileFromApi.firstName || '');
        lastName = titleCase(profileFromApi.lastName || '(Last Name Unknown)');
      } else {
        const billingAddress = orderForContact?.billingAddress;
        const nameFromEmail = email.split('@')[0].replace(/[._]/g, ' ');
        firstName = titleCase(billingAddress?.firstName || nameFromEmail);
        lastName = titleCase(billingAddress?.lastName || '(Last Name Unknown)');
      }

      // Find the personal phone number from any of the customer's transactions
      let personalPhoneNumber: string | null = null;
      for (const transaction of customerTransactions) {
        const order = transaction.salesOrderId ? await getCachedSquarespaceOrderById(transaction.salesOrderId) : null;
        if (order?.lineItems) {
          for (const item of order.lineItems) {
            if (item.customizations) {
              // Special case for certain SKUs where the phone number is for the emergency contact.
              if (item.sku && SPECIAL_CASE_SKUS.has(item.sku) && item.customizations.length <= 2) {
                continue; // Skip this item, as it's not the member's phone
              }

              for (const custom of item.customizations) {
                if (custom.label === 'Personal Phone Number' && custom.value) {
                  personalPhoneNumber = custom.value;
                  break;
                }
              }
            }
            if (personalPhoneNumber) break;
          }
        }
        if (personalPhoneNumber) break;
      }

      // De-duplication logic: Prefer matching by email, then by phone, then by name.
      // This relies on native CiviCRM email/phone matching and avoids using external IDs.
      let existingContact = await civicrm.getContactByEmail(email);
      if (!existingContact) {
        // Try personal phone number, then billing phone as fallbacks
        const phoneToTry = personalPhoneNumber || orderForContact?.billingAddress?.phone || null;
        if (phoneToTry) {
          existingContact = await civicrm.getContactByPhone(phoneToTry);
        }
      }
      if (!existingContact) {
        existingContact = await civicrm.getContactByName(firstName, lastName);
      }

      // Normalize address and phone from either the profile API or the order/billing info
      let addressForSave = null;
      if (profileFromApi && profileFromApi.address) {
        addressForSave = profileFromApi.address;
      } else if (orderForContact && orderForContact.billingAddress) {
        addressForSave = {
          ...orderForContact.billingAddress,
          firstName: titleCase(orderForContact.billingAddress.firstName),
          lastName: titleCase(orderForContact.billingAddress.lastName),
        };
      }
      const phoneForSave = personalPhoneNumber || (profileFromApi && profileFromApi.phone) || (orderForContact && orderForContact.billingAddress && orderForContact.billingAddress.phone) || null;

      const profileForSave: SquarespaceProfile = {
        // Avoid driving matching by an external identifier. Use email/phone lookups instead.
        id: email || '',
        email: email,
        firstName: firstName,
        lastName: lastName,
        // If we have a Squarespace profile for this email, prefer those address/phone details
        address: addressForSave,
        phone: phoneForSave,
        createdOn: firstTransaction.createdOn,
        hasAccount: false,
        isCustomer: true,
        acceptsMarketing: false,
      };

      const saveResult = await civicrm.saveContact(profileForSave, existingContact || undefined);
      const contactId = saveResult.values[0].id;

      if (!contactId) {
        console.error(`${progress} Could not find or create contact for email: ${email}`);
        continue;
      }
      console.log(`${progress} Contact saved (ID: ${contactId}).`);
      // --- End Contact ---

      let membershipPeriods: {
        membershipTypeName: string;
        membershipTypeId: number;
        sku?: string | undefined;
        transactions: SquarespaceTransaction[];
      }[] = [];

      // --- Identify Membership Periods ---
      // Cache membership type details per SKU (or name) to avoid repeated API calls
      const membershipTypeDetailsCache: { [name: string]: any } = {};
      for (const transaction of customerTransactions) {
        const order = transaction.salesOrderId ? await getCachedSquarespaceOrderById(transaction.salesOrderId) : null;
        if (!order || !order.lineItems) continue;

        for (const item of order.lineItems) {
          const membershipTypeName = item.sku ? SKU_TO_MEMBERSHIP_TYPE[item.sku] : null;
          if (membershipTypeName) {
            const transactionDate = new Date(transaction.createdOn);
            let addedToPeriod = false;

            // Fetch membership type details for this SKU (cached)
            if (!membershipTypeDetailsCache[membershipTypeName]) {
              try {
                const membershipTypeId = await civicrm.getMembershipTypeId(membershipTypeName);
                const details = await civicrm.getMembershipTypeDetails(membershipTypeId);
                membershipTypeDetailsCache[membershipTypeName] = details || { duration_unit: 'month', duration_interval: 1 };
              } catch (err) {
                // Fallback to 1 month if anything goes wrong
                membershipTypeDetailsCache[membershipTypeName] = { duration_unit: 'month', duration_interval: 1 };
              }
            }

            // Try to add to an existing period
            for (const period of membershipPeriods) {
              if (period.membershipTypeName === membershipTypeName) {
                const lastTransactionDate = new Date(period.transactions[period.transactions.length - 1].createdOn);
                // Compute the expected next payment date based on membership type duration
                const details = membershipTypeDetailsCache[membershipTypeName];
                const expectedNext = new Date(lastTransactionDate);
                const interval = details?.duration_interval || 1;
                const unit = details?.duration_unit || 'month';
                if (unit === 'month') {
                  expectedNext.setMonth(expectedNext.getMonth() + interval);
                } else if (unit === 'year') {
                  expectedNext.setFullYear(expectedNext.getFullYear() + interval);
                } else if (unit === 'day') {
                  expectedNext.setDate(expectedNext.getDate() + interval);
                } else {
                  // Default to month
                  expectedNext.setMonth(expectedNext.getMonth() + interval);
                }

                // Allow a retry window (grace) of 10 days past the expected date.
                const allowedLatest = new Date(expectedNext);
                allowedLatest.setDate(allowedLatest.getDate() + 10);

                // If the next transaction occurred on or before the allowed latest date, treat as contiguous
                if (transactionDate.getTime() <= allowedLatest.getTime()) {
                  period.transactions.push(transaction);
                  addedToPeriod = true;
                  break;
                }
              }
            }

            // If not added, create a new period
            if (!addedToPeriod) {
              const membershipTypeId = await civicrm.getMembershipTypeId(membershipTypeName);
              membershipPeriods.push({
                membershipTypeName,
                membershipTypeId,
                sku: item.sku || undefined,
                transactions: [transaction],
              });
            }
            break; // Assume one membership per order
          }
        }
      }
      console.log(`${progress} Identified ${membershipPeriods.length} distinct membership period(s).`);
      // --- End Membership Identification ---

      // We'll re-fetch the contact's memberships at the start of each period
      // so that new memberships created earlier in this run are visible and
      // we can detect overlaps to avoid creating duplicate/overlapping memberships.
      let isFirstPeriod = true;

      // --- Process Memberships and Contributions ---
      for (const period of membershipPeriods) {
        let existingMembership: CiviCRMMembership | null = null;

        // Re-fetch memberships so we include any memberships created earlier in this run.
        const currentMemberships = await civicrm.getMembershipsForContact(contactId);

        // Helper: convert a date-time string to a date-only Date object
        const toDateOnly = (dtStr: string) => new Date(`${dtStr.slice(0, 10)}T00:00:00`);

        // Compute candidate start + candidate end for the current period to allow overlap checks
        const firstPaymentOfPeriod = period.transactions && period.transactions[0] ? toDateOnly(period.transactions[0].createdOn) : null;
        const lastPaymentOfPeriod = period.transactions && period.transactions.length ? period.transactions[period.transactions.length - 1] : null;
        const candidateEndDateStr = lastPaymentOfPeriod ? await computeMembershipEndDate(civicrm, lastPaymentOfPeriod.createdOn, period.membershipTypeId, period.sku) : null;
        const candidateEndDate = candidateEndDateStr ? new Date(`${candidateEndDateStr}T00:00:00`) : null;

        // For the first period only, behave as before and try to detect a renewal of an existing membership.
        if (isFirstPeriod) {
          // Find pre-existing memberships of the same type.
          const sameType = currentMemberships.filter((m: CiviCRMMembership) => m.membership_type_id === period.membershipTypeId);

          // Check if an existing membership actually spans this period (start <= firstPayment <= end)
          const spanning = sameType.find((m: CiviCRMMembership) => {
            if (!m.start_date || !m.end_date || !firstPaymentOfPeriod) return false;
            const start = toDateOnly(m.start_date);
            const end = toDateOnly(m.end_date);
            return start.getTime() <= firstPaymentOfPeriod.getTime() && end.getTime() >= firstPaymentOfPeriod.getTime();
          });

          if (spanning) {
            existingMembership = spanning;
          } else {
            // If not spanning, check if it's a near-term renewal of the most recent existing membership (within 90 days)
            const latestExisting = sameType.sort((a: CiviCRMMembership, b: CiviCRMMembership) => new Date(b.end_date || 0).getTime() - new Date(a.end_date || 0).getTime())[0];
            if (latestExisting?.id && latestExisting.end_date && firstPaymentOfPeriod) {
              const existingEndDate = toDateOnly(latestExisting.end_date);
              const daysBetween = (firstPaymentOfPeriod.getTime() - existingEndDate.getTime()) / (1000 * 3600 * 24);
              if (daysBetween >= 0 && daysBetween <= 10) {
                existingMembership = latestExisting;
              }
            }
          }
        }

        // For subsequent periods (and as a final safety check for first period), check for any overlapping
        // membership ranges and treat them as the existing membership rather than creating another one.
        if (!existingMembership && firstPaymentOfPeriod) {
          const overlaps = currentMemberships.find((m: CiviCRMMembership) => {
            if (!m.start_date || !m.end_date) return false;
            if (m.membership_type_id !== period.membershipTypeId) return false;
            const existingStart = toDateOnly(m.start_date);
            const existingEnd = toDateOnly(m.end_date);
            // Candidate end may be null (single-day or unknown), treat accordingly
            const candStart = firstPaymentOfPeriod;
            const candEnd = candidateEndDate || candStart;
            // Overlap if existingStart <= candEnd && existingEnd >= candStart
            return (existingStart.getTime() <= candEnd.getTime() && existingEnd.getTime() >= candStart.getTime());
          });
          if (overlaps) {
            console.log(`${progress} Detected overlapping membership (ID: ${overlaps.id}). Treating current period as part of that membership.`);
            existingMembership = overlaps;
          }
        }

        if (existingMembership?.id) {
          // This is a renewal or update of an existing membership using Order API.
          console.log(`${progress} Found existing membership (ID: ${existingMembership.id}). Syncing transactions via Order API.`);

          for (const transaction of period.transactions) {
            if (!transaction.payments || transaction.payments.length === 0) continue;
            const order = transaction.salesOrderId ? await getCachedSquarespaceOrderById(transaction.salesOrderId) : null;
            const payment = transaction.payments[0];
            const sku = period.sku || 'SQ9402840';
            const priceFieldValueId = PRICE_FIELD_VALUE_MAP[sku] || 22;

            const orderResult = await civicrm.syncMembershipWithPayment({
              contactId,
              membershipTypeId: period.membershipTypeId,
              priceFieldValueId,
              amount: parseFloat(transaction.total.value),
              currency: transaction.total.currency,
              trxnId: payment.externalTransactionId,
              receiveDate: transaction.createdOn,
              source: `Squarespace Order #${order?.orderNumber || transaction.id}`,
              membershipId: existingMembership.id // Renewal
            });

            if (orderResult.values?.[0]) {
              const contributionId = orderResult.values[0].id;
              console.log(`${progress} Saved renewed contribution ${contributionId} for transaction ${transaction.id}.`);

              // Incrementally update end date to trigger renewal logic/logs
              const intermediateEndDate = await computeMembershipEndDate(civicrm, transaction.createdOn, period.membershipTypeId, period.sku);
              if (intermediateEndDate) {
                await civicrm.saveMembership({
                  id: existingMembership.id,
                  end_date: intermediateEndDate,
                  is_override: false,
                });
              }

              // Record the renewal activity for dashboard summary
              await civicrm.recordMembershipActivity({
                membershipId: existingMembership.id,
                contactId: contactId,
                activityType: 'Renewal',
                date: transaction.createdOn,
                subject: `Squarespace Renewal (Order #${order?.orderNumber || transaction.id})`,
              });
            }
          }

          // 2. Final update to the membership end date.
          const lastTransaction = period.transactions[period.transactions.length - 1];
          const finalEndDateStr = await computeMembershipEndDate(civicrm, lastTransaction.createdOn, period.membershipTypeId, period.sku);

          await civicrm.saveMembership({
            id: existingMembership.id,
            end_date: finalEndDateStr || undefined,
            is_override: false, // Let CiviCRM calculate status automatically based on end_date
          });
          console.log(`${progress} Finalized renewal for membership ${existingMembership.id} with is_override: false.`);

        } else {
          // New implementation using Order API for proper financial linkage
          console.log(`${progress} No existing membership found. Creating a new one via Order API.`);
          
          let localMembershipId: number | undefined = undefined;
          let isFirst = true;

          for (const transaction of period.transactions) {
            if (!transaction.payments || transaction.payments.length === 0) continue;
            const order = transaction.salesOrderId ? await getCachedSquarespaceOrderById(transaction.salesOrderId) : null;
            const payment = transaction.payments[0];
            const sku = period.sku || 'SQ9402840';
            const priceFieldValueId = PRICE_FIELD_VALUE_MAP[sku] || 22;

            const orderResult = await civicrm.syncMembershipWithPayment({
              contactId,
              membershipTypeId: period.membershipTypeId,
              priceFieldValueId,
              amount: parseFloat(transaction.total.value),
              currency: transaction.total.currency,
              trxnId: payment.externalTransactionId,
              receiveDate: transaction.createdOn,
              source: `Squarespace Order #${order?.orderNumber || transaction.id}`,
              membershipId: localMembershipId
            });

            if (isFirst && orderResult.values?.[0]) {
              // After the first Order.create, find the membership ID that was created
              const contributionId = orderResult.values[0].id;
              const lineItems = await civicrm.apiRequest('LineItem', 'get', {
                where: [['contribution_id', '=', contributionId], ['entity_table', '=', 'civicrm_membership']],
                select: ['entity_id']
              });
              if (lineItems.values?.[0]) {
                localMembershipId = lineItems.values[0].entity_id;
                console.log(`${progress} Created Membership ID: ${localMembershipId} linked to Contribution: ${contributionId}`);
              }
              
              if (localMembershipId) {
                // Recording signup activity for the dashboard summary
                await civicrm.recordMembershipActivity({
                  membershipId: localMembershipId,
                  contactId: contactId,
                  activityType: 'Signup',
                  date: transaction.createdOn,
                  subject: `Squarespace Signup (Order #${order?.orderNumber || transaction.id})`,
                });
              }

            } else if (localMembershipId) {
              // Incrementally update end date to trigger renewal logic/logs for subsequent payments
              const intermediateEndDate = await computeMembershipEndDate(civicrm, transaction.createdOn, period.membershipTypeId, period.sku);
              if (intermediateEndDate) {
                await civicrm.saveMembership({
                  id: localMembershipId,
                  end_date: intermediateEndDate,
                  is_override: false,
                });
              }
              
              // Record renewal activity for every subsequent payment in this period too!
              await civicrm.recordMembershipActivity({
                membershipId: localMembershipId,
                contactId: contactId,
                activityType: 'Renewal',
                date: transaction.createdOn,
                subject: `Squarespace Renewal (Order #${order?.orderNumber || transaction.id})`,
              });
              console.log(`${progress} Linked additional transaction ${payment.externalTransactionId} to Membership ${localMembershipId} and updated end date to ${intermediateEndDate}`);
            }
            isFirst = false;
          }

          // Final update to the membership end date.
          if (localMembershipId) {
            const lastTransaction = period.transactions[period.transactions.length - 1];
            const finalEndDateStr = await computeMembershipEndDate(civicrm, lastTransaction.createdOn, period.membershipTypeId, period.sku);

            await civicrm.saveMembership({
              id: localMembershipId,
              end_date: finalEndDateStr || undefined,
              is_override: false, // Let CiviCRM calculate status automatically based on end_date
            });
            console.log(`${progress} Finalized new membership ${localMembershipId} with is_override: false.`);
          }
        }
        isFirstPeriod = false;
      }
      // --- End Membership and Contribution Processing ---

      // --- Process Standalone Donations and other details (Emergency Contact, etc.) ---
      const processedEmergencyContacts = new Set<string>(); // Track processed ECs to avoid duplicates
      for (const transaction of customerTransactions) {
        if (!transaction.payments || transaction.payments.length === 0) {
          // This check is repeated, but it's a good safeguard.
          continue;
        }
        const isDonation = !transaction.salesOrderId;
        if (isDonation) {
          const payment = transaction.payments[0];
          const processingFees = (payment && (payment as any).processingFees) || [];
          let feeAmount = 0;
          if (processingFees && processingFees.length) {
            feeAmount = processingFees.reduce((acc: number, p: any) => {
              const net = p.netAmount?.value || p.amount?.value || '0';
              return acc + parseFloat(net);
            }, 0);
          }
          const paymentInstrumentId = await civicrm.getPaymentInstrumentId(payment?.creditCardType || 'Credit Card');

          await civicrm.saveContribution({
            contact_id: contactId,
            financial_type_id: await civicrm.getFinancialTypeId('Donation'),
            contribution_status_id: 1, // Completed
            total_amount: parseFloat(transaction.total.value),
            currency: transaction.total.currency,
            trxn_id: payment.externalTransactionId,
            invoice_id: transaction.id,
            source: 'Squarespace Donation' + (payment?.creditCardType ? ` (Card: ${payment.creditCardType})` : ''),
            receive_date: transaction.createdOn,
            payment_processor_id: 6, // Squarespace_Stripe_Import
            payment_instrument_id: paymentInstrumentId || undefined,
            fee_amount: feeAmount || undefined,
            non_deductible_amount: 0,
          });
          console.log(`${progress} Saved standalone donation for transaction ${transaction.id}.`);
        }

        // --- Emergency Contact Processing ---
        const order = transaction.salesOrderId ? await getCachedSquarespaceOrderById(transaction.salesOrderId) : null;
        if (order && order.lineItems) {
          let emergencyContactName: string | null = null;
          let emergencyContactPhone: string | null = null;
          for (const item of order.lineItems) {
            if (item.customizations) {
              // Special case for SKUs with only emergency contact info.
              if (item.sku && SPECIAL_CASE_SKUS.has(item.sku) && item.customizations.length <= 2) {
                for (const custom of item.customizations) {
                  if (custom.label.toLowerCase() === 'name') emergencyContactName = custom.value;
                  if (custom.label.toLowerCase() === 'personal phone number') emergencyContactPhone = custom.value;
                }
              } else {
                for (const custom of item.customizations) {
                  if (custom.label === 'Emergency Contact Name' && custom.value) emergencyContactName = custom.value;
                  if (custom.label === 'Emergency Contact Phone Number' && custom.value) emergencyContactPhone = custom.value;
                }
              }
            }
          }

          if (emergencyContactName) {
            const ecIdentifier = `${emergencyContactName}|${emergencyContactPhone || ''}`;

            // Check if the emergency contact is the person themselves (case-insensitive)
            const selfContact = emergencyContactName.trim().toLowerCase() === `${firstName} ${lastName}`.trim().toLowerCase();

            if (selfContact && emergencyContactPhone) {
              console.log(`${progress} Emergency contact is the person themselves. Adding phone to their record.`);
              await civicrm.savePhone(contactId, emergencyContactPhone);
              processedEmergencyContacts.add(ecIdentifier); // Mark as processed to avoid re-adding the phone
            } else if (!processedEmergencyContacts.has(ecIdentifier)) {
              const nameParts = emergencyContactName.split(' ');
              const ecFirstName = titleCase(nameParts.shift() || '');
              const ecLastName = titleCase(nameParts.join(' '));
              const ecProfile: SquarespaceProfile = {
                // Don't assign an external identifier for emergency contacts.
                id: '',
                firstName: ecFirstName,
                lastName: ecLastName,
                email: null, phone: emergencyContactPhone, address: null, createdOn: transaction.createdOn,
                hasAccount: false, isCustomer: false, acceptsMarketing: false,
              };

              // Try to locate an existing emergency contact by phone or name before creating.
              let ecExisting = null;
              if (emergencyContactPhone) {
                ecExisting = await civicrm.getContactByPhone(emergencyContactPhone);
              }
              if (!ecExisting) {
                ecExisting = await civicrm.getContactByName(ecFirstName, ecLastName);
              }

              const ecSaveResult = await civicrm.saveContact(ecProfile, ecExisting || undefined);
              const emergencyContactId = ecSaveResult.values[0].id;

              if (emergencyContactId) {
                const relationshipTypeId = await civicrm.getRelationshipTypeId('Emergency Contact Of');
                await civicrm.saveRelationship(contactId, emergencyContactId, relationshipTypeId);
                console.log(`${progress} Saved emergency contact relationship for ${emergencyContactName}.`);
              }
              processedEmergencyContacts.add(ecIdentifier); // Mark as processed
            }
          }
        }

        // --- Ensure contributions exist for all other purchases (non-membership, non-donation products)
        for (const transaction of customerTransactions) {
          if (!transaction.payments || transaction.payments.length === 0) continue;
          const order = transaction.salesOrderId ? await getCachedSquarespaceOrderById(transaction.salesOrderId) : null;
          // Skip donations and skip transactions that are membership-related (handled above)
          const isDonation = !transaction.salesOrderId;
          let hasMembership = false;
          if (order && order.lineItems) {
            for (const item of order.lineItems) {
              if (item.sku && SKU_TO_MEMBERSHIP_TYPE[item.sku]) {
                hasMembership = true;
                break;
              }
            }
          }
          if (isDonation || hasMembership) continue;

          // It's a product purchase: create a contribution for reporting and reconciliation.
          const payment = transaction.payments[0];
          const processingFees = (payment && (payment as any).processingFees) || [];
          let feeAmount = 0;
          if (processingFees && processingFees.length) {
            feeAmount = processingFees.reduce((acc: number, p: any) => {
              const net = p.netAmount?.value || p.amount?.value || '0';
              return acc + parseFloat(net);
            }, 0);
          }
          const paymentInstrumentId = await civicrm.getPaymentInstrumentId(payment?.creditCardType || 'Credit Card');
          let financialTypeId: number;
          try {
            financialTypeId = await civicrm.getFinancialTypeId('Sales');
          } catch (e) {
            try { financialTypeId = await civicrm.getFinancialTypeId('Other'); } catch (e2) { financialTypeId = await civicrm.getFinancialTypeId('Donation'); }
          }
          const nonDeductibleAmount = parseFloat(transaction.total.value);
          await civicrm.saveContribution({
            contact_id: contactId,
            financial_type_id: financialTypeId,
            contribution_status_id: 1, // Completed
            total_amount: parseFloat(transaction.total.value),
            currency: transaction.total.currency,
            trxn_id: payment.externalTransactionId,
            invoice_id: order?.orderNumber || transaction.id,
            source: `Squarespace Order #${order?.orderNumber}` + (payment?.creditCardType ? ` (Card: ${payment.creditCardType})` : ''),
            receive_date: transaction.createdOn,
            payment_processor_id: 6,
            payment_instrument_id: paymentInstrumentId || undefined,
            fee_amount: feeAmount || undefined,
            non_deductible_amount: nonDeductibleAmount,
          });
          console.log(`${progress} Ensured contribution exists for product transaction ${transaction.id}.`);
          console.log(`${progress} Ensured contribution exists for product transaction ${transaction.id}.`);
        }

        // --- OPENCOLLECTIVE SYNC ---
        if (openCollective) {
          // Iterate ALL transactions for this customer to ensure we capture donations + memberships + products
          for (const transaction of customerTransactions) {
            // Skip if already synced
            if (ocSyncMap[transaction.id]) {
              // console.log(`${progress} [OC] Transaction ${transaction.id} already synced.`);
              continue;
            }

            // Skip if no payments (e.g. $0 or failed)
            if (!transaction.payments || transaction.payments.length === 0) continue;

            const amount = parseFloat(transaction.total.value);
            const currency = transaction.total.currency;
            if (amount <= 0) continue; // Don't sync zero/negative transactions

            const order = transaction.salesOrderId ? await getCachedSquarespaceOrderById(transaction.salesOrderId) : null;

            // Determine Description & Donor Name for Attribution
            // We have computed 'firstName', 'lastName' earlier for Civi. Let's reuse them if accurate, or recompute.
            // Note: firstName/lastName variables are scoped to the membership block above. We need to access them or re-derive.
            // Re-deriving is safer as we are in the main scope now.

            let donorName = '(Unknown)';
            // Try line items name first
            const nameFromItems = await getNameFromLineItems(order);
            if (nameFromItems) {
              donorName = nameFromItems;
            } else if (profileFromApi) {
              const fn = profileFromApi.firstName || '';
              const ln = profileFromApi.lastName || '';
              if (fn || ln) donorName = `${fn} ${ln}`.trim();
            } else if (order?.billingAddress) {
              donorName = `${order.billingAddress.firstName || ''} ${order.billingAddress.lastName || ''}`.trim();
            }
            if (donorName === '(Unknown)' || !donorName) {
              // Fallback to email name
              donorName = email.split('@')[0];
            }

            const desc = transaction.salesOrderId
              ? `Squarespace Order #${order?.orderNumber || transaction.salesOrderId}`
              : `Squarespace Transaction ${transaction.id}`;

            // Add Funds
            try {
              console.log(`${progress} [OC] Syncing transaction ${transaction.id} ($${amount})...`);
              const result = await openCollective.addFunds(
                amount,
                currency,
                donorName,
                email,
                desc,
                transaction.createdOn // Pass date (check if client supports it, we added it as optional arg)
              );

              if (result) {
                // Update map
                ocSyncMap[transaction.id] = result.id;
                // Save map immediately to prevent re-syncs on crash
                await fs.writeFile(OC_SYNC_MAP_FILE, JSON.stringify(ocSyncMap, null, 2), 'utf-8');
                console.log(`${progress} [OC] Synced Successfully! (OC ID: ${result.id})`);
              } else if (openCollective['dryRun']) {
                console.log(`${progress} [OC] Dry Run - Skipped actual sync.`);
              }

            } catch (err: any) {
              console.error(`${progress} [OC] FAILED to sync transaction ${transaction.id}: ${err.message}`);
            }
          }
        }
      }
      // If we got here, the customer was processed successfully.
      await writeLastSuccessfulEmail(email);

      // Diagnostic: check for overlapping memberships created for this contact and warn
      try {
        const overlaps = await civicrm.detectOverlappingMemberships(contactId);
        if (overlaps && overlaps.length) {
          console.warn(`${progress} WARNING: Detected ${overlaps.length} overlapping membership pair(s) for contact ${contactId}.`);
          for (const pair of overlaps) {
            console.warn(`${progress} Overlap: Membership ${pair.a.id} (${pair.a.start_date} -> ${pair.a.end_date}) overlaps Membership ${pair.b.id} (${pair.b.start_date} -> ${pair.b.end_date})`);
          }
        }
      } catch (e) {
        // Don't let diagnostic failures block the run.
      }

      // If we were asked to run just one customer, stop after this iteration
      if (singleRun) {
        console.log('Single-customer run complete; exiting.');
        break;
      }
    } catch (error) {
      console.error(`\n--- FAILED WHILE PROCESSING CUSTOMER: ${email} (${progress}) ---`);
      console.error(error); // Log the full error
      console.error(`--- SKIPPING TO NEXT CUSTOMER ---\n`);
    }
  }

  // Persist orders and profiles caches for full syncs so subsequent runs can rehydrate them.
  if (!lastSync) {
    try {
      const ordersArray = Array.from(ordersCacheMap.values());
      await fs.writeFile(ORDERS_FULL_CACHE_FILE, JSON.stringify(ordersArray, null, 2), 'utf-8');
      console.log(`Saved ${ordersArray.length} orders to ${ORDERS_FULL_CACHE_FILE}.`);
    } catch (e) {
      console.error('Error writing orders cache:', e);
    }
    try {
      const profilesArray = Array.from(profilesCacheMap.values());
      await fs.writeFile(PROFILES_FULL_CACHE_FILE, JSON.stringify(profilesArray, null, 2), 'utf-8');
      console.log(`Saved ${profilesArray.length} profiles to ${PROFILES_FULL_CACHE_FILE}.`);
    } catch (e) {
      console.error('Error writing profiles cache:', e);
    }
  }

  // Persist the timestamp only when running in apply mode (not preview)
  if (opts && opts.apply) {
    await writeLastSyncTimestamp(syncStartTime);
    console.log(`Sync complete. Timestamp updated to ${syncStartTime}`);
  } else {
    console.log('Preview mode: no timestamp written.');
  }
}

// If invoked directly, run the sync in normal apply mode (not preview)
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    apply: !args.includes('--preview'),
    opencollective: args.includes('--opencollective'),
    dryRun: args.includes('--dry-run'),
    singleEmail: args.find(a => a.startsWith('--single-email='))?.split('=')[1]
  };

  /**
   * Lock File Protection
   * Prevents multiple instances of the sync from running simultaneously.
   */
  const fsSync = require('fs');
  if (fsSync.existsSync(SYNC_LOCK_FILE)) {
    console.error(`\n[!] ABORT: Sync already in progress (Lock file ${SYNC_LOCK_FILE} exists).`);
    console.error(`If you are sure no other sync is running, delete ${SYNC_LOCK_FILE} and try again.\n`);
    process.exit(1);
  }

  // Create lock
  fsSync.writeFileSync(SYNC_LOCK_FILE, process.pid.toString());
  
  // Ensure lock is removed on exit
  const cleanup = () => {
    if (fsSync.existsSync(SYNC_LOCK_FILE)) {
      try { fsSync.unlinkSync(SYNC_LOCK_FILE); } catch {}
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { process.exit(); });
  process.on('SIGTERM', () => { process.exit(); });
  process.on('uncaughtException', (e) => {
    console.error('Uncaught Exception:', e);
    process.exit(1);
  });

  runSync(options).catch(error => {
    console.error('\nScript finished with an error.');
    process.exit(1);
  });
}