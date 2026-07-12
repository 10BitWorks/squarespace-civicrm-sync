# Squarespace to CiviCRM Sync

This project contains a script to sync data from Squarespace to CiviCRM.

## Setup

1.  Install dependencies:
    
    `npm install` 
    
2.  Create a `.env` file in the root of the project and add the following environment variables:
    
    `SQUARESPACE_API_KEY=` 
    `CIVICRM_API_KEY=` 
    `CIVICRM_API_URL=` 
    
3.  Build the project:
    
    `npm run build` 
    
4.  Run a one-off sync:
    
    `npm start` 
    
    > **Note:** The sync script supports graceful shutdown. Pressing `Ctrl+C` will finish the current customer, clean up the `.sync.lock` file, and exit safely.
    
5.  Run as a background server (Webhooks & Polling):
    
    `npm run serve`
    
    This starts an Express server on port 3000 (or `$PORT`) that provides a `/webhook` endpoint to trigger syncs in real-time. It also automatically runs a sync every 12 hours (configurable via `SYNC_INTERVAL` in seconds).
    
    If the `SERVICE_URL_APP` environment variable is provided (e.g. by Coolify), the server will automatically register its `/webhook` endpoint with the Squarespace Webhook Subscriptions API on startup.
