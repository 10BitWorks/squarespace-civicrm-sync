import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const PAYPAL_API_URL = process.env.PAYPAL_API_URL || 'https://api.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

async function getPayPalAccessToken(): Promise<string> {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(`${PAYPAL_API_URL}/v1/oauth2/token`, 'grant_type=client_credentials', {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return response.data.access_token;
}

export async function getPayPalSubscribers() {
  try {
    const accessToken = await getPayPalAccessToken();
    console.log('Fetching subscribers from PayPal...');

    const response = await axios.get(`${PAYPAL_API_URL}/v1/billing/subscriptions`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    // The actual data is in response.data.subscriptions
    return response.data.subscriptions || [];
  } catch (error: any) {
    console.error('Error fetching PayPal subscribers:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    return []; // Return an empty array on error to prevent crashing the sync script
  }
}
