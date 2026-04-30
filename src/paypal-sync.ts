import { getPayPalSubscribers } from './paypal';

async function main() {
  console.log('Starting PayPal to CiviCRM sync...');
  const subscribers = await getPayPalSubscribers();
  console.log('Fetched PayPal Subscribers:', subscribers);
  // TODO: Add logic to process subscribers and sync them to CiviCRM.
  console.log('PayPal sync complete.');
}

main().catch(error => {
  console.error('\\nScript finished with an error.');
  process.exit(1);
});
