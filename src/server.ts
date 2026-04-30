import express from 'express';
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

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  
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
