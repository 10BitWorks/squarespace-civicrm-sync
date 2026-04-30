#!/bin/bash

echo "Starting Squarespace-to-CiviCRM Webhook Server & Scheduler..."

# Run the server (which includes the 12-hour polling logic)
npm run serve
