import express from 'express';
import axios from 'axios';
import { runSync } from './index';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  console.log(`[${new Date().toISOString()}] Received webhook from Squarespace`);
  
  // We trigger a sync immediately. 
  // Note: runSync handles its own locking, so if one is already running, this will just return.
  runSync({ apply: true }).catch(err => {
    console.error('Error during webhook-triggered sync:', err);
  });

  res.status(200).send('Webhook received and sync triggered.');
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

async function registerSquarespaceWebhook(serviceUrl: string) {
  // Ensure there are no trailing slashes in the service URL
  const baseUrl = serviceUrl.replace(/\/$/, '');
  const webhookUrl = `${baseUrl}/webhook`;
  console.log(`[Webhook] Attempting to register webhook URL: ${webhookUrl}`);
  
  if (!process.env.SQUARESPACE_API_KEY) {
    console.warn('[Webhook] SQUARESPACE_API_KEY is not set. Cannot register webhook.');
    return;
  }
  
  try {
    const response = await axios.post(
      'https://api.squarespace.com/1.0/webhook_subscriptions',
      {
        endpointUrl: webhookUrl,
        topics: ['order.create', 'order.update']
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.SQUARESPACE_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Squarespace-CiviCRM-Sync-App'
        }
      }
    );
    console.log(`[Webhook] Successfully registered with Squarespace! Secret: ${response.data.secret}`);
  } catch (err: any) {
    console.error('[Webhook] Failed to register webhook:');
    if (err.response) {
      console.error(JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
  }
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);

  if (process.env.SERVICE_URL_APP) {
    registerSquarespaceWebhook(process.env.SERVICE_URL_APP).catch(console.error);
  }
  
  // Set up periodic polling (default twice per day = every 12 hours)
  const intervalSeconds = parseInt(process.env.SYNC_INTERVAL || '43200');
  const INTERVAL_MS = intervalSeconds * 1000;
  setInterval(() => {
    console.log(`[${new Date().toISOString()}] Starting scheduled periodic sync...`);
    runSync({ apply: true }).catch(err => {
      console.error('Error during scheduled sync:', err);
    });
  }, INTERVAL_MS);

  // Run an initial sync on startup
  console.log('Running initial sync on startup...');
  runSync({ apply: true }).catch(err => {
    console.error('Error during startup sync:', err);
  });
});
