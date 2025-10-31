import crypto from 'crypto';
import { request } from '@playwright/test';
import fetch from 'node-fetch';
import { ENV } from '../config/env';

function _generateSignature(rawBody: string, timestamp: string): string {
  const stringToSign = rawBody + timestamp;
  const secretBuffer = Buffer.from(ENV.API_SECRET, 'utf8');
  const secretBase64 = secretBuffer.toString('base64');
  return crypto
    .createHmac('sha256', secretBase64)
    .update(stringToSign)
    .digest('hex');
}

export async function initiateCashIn(data: object) {
  // Use the exact raw JSON string for both signature and request body
  const rawBody = JSON.stringify(data);
  const timestamp = Date.now().toString();
  const signature = _generateSignature(rawBody, timestamp);

  const url = `${ENV.API_BASE_URL_CASHIN}/api/v1/payments/v2/initiate/?timestamp=${timestamp}&signature=${signature}`;
  const headers = {
    'X-PPAY-APIKEY': ENV.API_KEY,
    'Content-Type': 'application/json',
  };

  const apiRequest = await request.newContext();
  const response = await apiRequest.post(url, {
    headers,
    data: rawBody,
  });
  return response;
}

export async function sendTelegramMessage(paymentUrl: string) {
  const message = `1. Please click the link below to proceed with payment: ${paymentUrl}\n 2. Complete the payment by scanning the displayed QR code.`;
  const token = ENV.BOT_TOKEN && ENV.BOT_TOKEN.startsWith('bot') ? ENV.BOT_TOKEN : `bot${ENV.BOT_TOKEN}`;
  const telegramApiUrl = `https://api.telegram.org/${token}/sendMessage?chat_id=${ENV.QR_CHAT_ID}&text=${encodeURIComponent(message)}`;
  // const response = await fetch(telegramApiUrl, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  // });
  // return response.ok;
  const apiRequest = await request.newContext();
  const response = await apiRequest.get(telegramApiUrl);
  return response;
}

export async function sendStatusTelegramMessage(message: string) {
  // Normalize token in case env contains or omits the 'bot' prefix
  const token = ENV.STATUS_BOT_TOKEN && ENV.STATUS_BOT_TOKEN.startsWith('bot')
    ? ENV.STATUS_BOT_TOKEN
    : `bot${ENV.STATUS_BOT_TOKEN}`;
  const telegramApiUrl = `https://api.telegram.org/${token}/sendMessage?chat_id=${ENV.STATUS_CHAT_ID}&text=${encodeURIComponent(message)}`;
  const apiRequest = await request.newContext();
  const response = await apiRequest.get(telegramApiUrl);
  return response;
}

/**
 * Fetch payment status by externalPaymentId.
 * Uses empty raw body ('') for signature when there is no request body.
 */
export async function PaymentStatus(externalPaymentId: string) {
  // Build the body required by the payment-status API
  const body = {
    merchant_id: ENV.MERCHANT_ID,
    type: 'cashin',
  };
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const signature = _generateSignature(rawBody, timestamp);

  const url = `${ENV.API_BASE_URL_CASHIN}/api/v1/payments/payment-status/${externalPaymentId}/?timestamp=${timestamp}&signature=${signature}`;
  const headers = {
    'X-PPAY-APIKEY': ENV.API_KEY,
    'Content-Type': 'application/json',
  };

  const apiRequest = await request.newContext();
  const response = await apiRequest.post(url, { headers, data: rawBody });
  return response;
}
