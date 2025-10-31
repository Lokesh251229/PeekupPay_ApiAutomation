import fetch from 'node-fetch'; // Add this import at the top
import fs from 'fs';
import { test, expect } from '@playwright/test';
import { initiateCashIn, sendTelegramMessage, PaymentStatus, sendStatusTelegramMessage } from '../../utils/apiClient';
import { ENV } from '../../config/env';
import { CashInPayload as baseCashInPayload } from '../../utils/testData';
import { fail } from 'assert';

let PaymentUrl: string;
let QrCode: string;
let externalId1: string;
let errorCodeMessage: string;
let errorReason: string;


test.describe.configure({ mode: "serial" });
test.describe('Hourly Cash-in Flow Monitoring', () => {

  test('should perform cash-in API call and collect metrics', async () => {
  // Set timeout based on configured interval (default 10s)
  const waitMs = Number(ENV.PAYMENT_STATUS_INTERVAL_MS || 10000);
  const maxTimeoutMs = 6 * 60 * 1000; // 6 minutes polling ceiling
  // ensure test timeout is large enough for polling (max of simple heuristic or full polling ceiling + buffer)
  test.setTimeout(Math.max(waitMs * 2 + 30000, maxTimeoutMs + 60000));

  function generateTenDigitNumber() {
  // Generate exactly 10 random digits
  const randomDigits = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
  return `+63${randomDigits}`; // Format: +63XXXXXXXXXX (10 digits)
}
const now = Date.now();
    const CashInPayload = {
      ...baseCashInPayload,
      unique_id: generateTenDigitNumber(),
      externalPaymentId: `ext-${now}`,    
  };

  externalId1 = CashInPayload.externalPaymentId;

     // console.log('Using CashInPayload:', JSON.stringify(CashInPayload, null, 2));

      const initiateResponse = await initiateCashIn(CashInPayload);
      const status = initiateResponse.status();
      if ([200, 201].includes(status)) {
        const initiateResBody = await initiateResponse.json();
       // console.log("Initiate Cash-In Response Body:", initiateResBody);
        PaymentUrl = initiateResBody.data.payment_url;
        QrCode = initiateResBody.data.qr_code;
        console.log("PaymentUrl:", PaymentUrl);
        if (PaymentUrl) {
          const sent = await sendTelegramMessage(PaymentUrl);
          console.log(sent ? 'Telegram message sent.' : 'Failed to send Telegram message.');
        }
        // Do NOT send a Telegram message here. We persist the result and let the
        // aggregator compose a single combined Telegram message (start -> result -> end).
  expect(initiateResponse.ok()).toBeTruthy();

  // Fetch payment status twice with 5 minute interval
  const externalId = initiateResBody.data.external_payment_id;
  console.log('External Payment ID:', externalId);

  // After sending the payment URL, poll the PaymentStatus API every `waitMs` ms
  // until we observe a terminal state (COMPLETED, EXPIRED, FAILED) or we hit the 6 minute ceiling.
  console.log(`Waiting initial ${waitMs}ms before first status check...`);
  await new Promise((r) => setTimeout(r, waitMs));

  const terminalStates = new Set(['COMPLETED', 'EXPIRED', 'FAILED']);
  const startTime = Date.now();
  let lastStatusBody: any = null;
  let lastResp: any = null;
  let finalStatus: string | null = null;

  while (Date.now() - startTime < maxTimeoutMs) {
    try {
      const resp = await PaymentStatus(externalId);
      lastResp = resp;
      const body = await resp.json().catch(() => null);
      lastStatusBody = body;
      const statusText = (body?.data?.status || '').toString().toUpperCase();
      console.log('Polled payment status:', resp.status(), statusText);
      if (terminalStates.has(statusText)) {
        finalStatus = statusText;
        break;
      }
    } catch (err) {
      console.log('PaymentStatus polling error:', err);
      // continue polling until timeout
    }

    // wait before next poll
    console.log(`Waiting ${waitMs}ms before next poll...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  // If we exited without a terminal state, use the last observed status (likely PENDING) as final
  const observed = finalStatus || (lastStatusBody?.data?.status) || 'UNKNOWN';
  try {
    const result = {
      externalId,
      success: true,
      finalStatus: observed,
      // include payment link and QR if available so aggregator/notifications can use them
      paymentUrl: PaymentUrl || null,
      qrCode: QrCode || null,
      // keep an explicit empty error message field for consistent schema
      errorCodeMessage: '',
      timestamp: new Date().toISOString(),
    };
    try { fs.mkdirSync('artifacts', { recursive: true }); } catch {}
    fs.writeFileSync('artifacts/cashin_result.json', JSON.stringify(result, null, 2));
    console.log('Wrote artifacts/cashin_result.json', result);
  } catch (e) {
    console.log('Failed to write cashin result artifact:', e);
  }
      } else {
        const failedResBody = await initiateResponse.json().catch(() => ({}));
        console.log(`Failure Response (status ${status}):`, failedResBody);
        const code = failedResBody?.error_code ?? status ?? 'Unknown';
        const messageText = failedResBody?.message ?? failedResBody?.data?.error ?? 'Unknown error';
        errorCodeMessage = `${code} ${messageText}`;

        errorReason = failedResBody?.data?.error ?? 'Unknown error';

        const failResult = {
          externalId: externalId1,
          success: false,
          errorCode: code,
          errorMessage: messageText,
          errorCodeMessage: errorCodeMessage || `${code} ${messageText}`,
          errorReason,
        };
        try { fs.mkdirSync('artifacts', { recursive: true }); } catch {}
        fs.writeFileSync('artifacts/cashin_result.json', JSON.stringify(failResult, null, 2));
        console.log('Wrote artifacts/cashin_result.json', failResult);

        expect([200, 201]).toContain(status); // This will fail the test and log the response
      }
  });


});