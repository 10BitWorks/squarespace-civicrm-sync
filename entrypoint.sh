#!/bin/bash

# Default sync interval is 15 minutes (900 seconds)
INTERVAL=${SYNC_INTERVAL:-900}

echo "Starting Squarespace-to-CiviCRM Sync Loop (Interval: ${INTERVAL}s)..."

while true; do
    echo "[$(date)] Starting sync process..."
    npm start
    
    echo "[$(date)] Sync complete. Sleeping for ${INTERVAL}s..."
    sleep $INTERVAL
done
