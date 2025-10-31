import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const metricsPath = process.env.METRICS_PATH || 'artifacts/metrics.json';

async function waitForFreshMetrics(filePath: string, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        // consider fresh if modified within last 30 seconds
        if (Date.now() - stat.mtimeMs < 30000) return true;
      }
    } catch (e) {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function extractMetricsEndTime(metrics: any): Date | null {
  if (!metrics || typeof metrics !== 'object') return null;
  const s = metrics.stats || {};
  // Common Playwright stats keys that may contain end timestamps
  const candidates = ['wallClockEndedAt', 'end', 'endTime', 'wallClockEnd', 'wallClockEnded'];
  for (const k of candidates) {
    const v = s[k] || metrics[k] || (metrics.stats && metrics.stats[k]);
    if (v && typeof v === 'string') {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
    if (v && typeof v === 'number') {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function readMetrics(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e: any) {
    console.error('Failed to parse metrics file:', e?.message || e);
    return null;
  }
}

function summarizeFailures(metrics: any) {
  if (!metrics) return null;

  const summary: { failed: number; total: number; details: string[] } = { failed: 0, total: 0, details: [] };

  // If Playwright JSON reporter produced a stats block use it as authoritative for total
  if (metrics.stats && typeof metrics.stats.expected === 'number') {
    summary.total = metrics.stats.expected || 0;
  }

  // Walk suites/specs to count actual results and failures
  function walkSuites(suites: any[]) {
    if (!suites || !Array.isArray(suites)) return;
    for (const s of suites) {
      // specs at this level
      if (Array.isArray(s.specs)) {
        for (const spec of s.specs) {
          if (Array.isArray(spec.tests)) {
            for (const testRec of spec.tests) {
              if (Array.isArray(testRec.results)) {
                for (const res of testRec.results) {
                  summary.total += 1;
                  if (res.status && res.status !== 'passed') {
                    summary.failed += 1;
                    summary.details.push(`${testRec.title} => ${res.status}`);
                  }
                }
              }
            }
          }
        }
      }
      // recurse into nested suites
      if (Array.isArray(s.suites)) walkSuites(s.suites);
    }
  }

  if (Array.isArray(metrics.suites)) {
    // reset total if we will compute it from the suites
    summary.total = 0;
    walkSuites(metrics.suites);
  }

  return summary;
}

function normalizeToken(t?: string | undefined) {
  if (!t) return '';
  return t.startsWith('bot') ? t : `bot${t}`;
}

async function sendTelegram(message: string) {
  // Prefer status bot vars, fall back to generic ones
  const token = normalizeToken(process.env.TELEGRAM_STATUS_BOT_TOKEN) || normalizeToken(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = process.env.TELEGRAM_FRIEND_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('TELEGRAM env vars not set; would have sent message:');
    console.log(message);
    return false;
  }
  const url = `https://api.telegram.org/${token}/sendMessage`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: message }) });
  return res.ok;
}

async function main() {
  // Wait briefly for Playwright to flush the JSON reporter output so aggregator reads the latest file.
  // Increased timeout to reduce chances of race between Playwright finishing and aggregator starting.
  await waitForFreshMetrics(metricsPath, 60000);
  const metrics = readMetrics(metricsPath);
  let summary = summarizeFailures(metrics);

  // In some environments (local runs) Playwright's JSON reporter may not be present.
  // If metrics are missing but the test produced a cashin result and an exit code,
  // treat this as a post-run and proceed to compose/send the combined message.
  const cashinResultPath = 'artifacts/cashin_result.json';
  const exitCodePath = 'artifacts/exit_code.txt';
  let cashinArtifact: any = null;
  try {
    if (fs.existsSync(cashinResultPath)) {
      const raw = fs.readFileSync(cashinResultPath, 'utf8');
      cashinArtifact = JSON.parse(raw);
    }
  } catch (e) {
    // ignore
  }

  let exitCodeFromFile: number | null = null;
  try {
    if (fs.existsSync(exitCodePath)) {
      const raw = fs.readFileSync(exitCodePath, 'utf8').trim();
      const n = Number(raw || '0');
      if (!Number.isNaN(n)) exitCodeFromFile = n;
    }
  } catch (e) {
    // ignore
  }

  // Prefer to report the test completion time from the metrics if available,
  // otherwise fall back to the aggregator's current time.
  const metricsEnd = extractMetricsEndTime(metrics);
  const runAt = metricsEnd || new Date();

  // Format run time in Indian Standard Time (Asia/Kolkata)
  function formatToIST(d: Date) {
    try {
      // Use Intl.DateTimeFormat with Asia/Kolkata timezone for a reliable localised string
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).format(d) + ' IST';
    } catch (e) {
      // Fallback: compute offset (+5:30) and format manually
      const ms = d.getTime() + (5.5 * 60 * 60 * 1000);
      const dd = new Date(ms);
      return dd.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' IST';
    }
  }
  const runNotice = `Payment API Monitor run at ${formatToIST(runAt)}`;

  const startMarkerPath = 'artifacts/monitor_start.txt';
  

  if (!summary) {
    // No metrics found. If we have a cashin artifact and an exit code, treat this
    // as a post-run and synthesize a minimal summary so we can still send the
    // combined message (useful for local runs or when JSON reporter isn't enabled).
    if (cashinArtifact && exitCodeFromFile !== null) {
      summary = {
        failed: exitCodeFromFile === 0 ? 0 : 1,
        total: 1,
        details: exitCodeFromFile === 0 ? [] : [`Test process exited with code ${exitCodeFromFile}`],
      };
      // keep going to compose/send the message below
    } else {
      // Pre-flight: record the start time so the post-run aggregator can include it
      // in a single combined Telegram message (start -> test result -> end).
      console.log('No metrics found or unable to parse. Pre-flight run — recording start time.');
      try {
        try { fs.mkdirSync('artifacts', { recursive: true }); } catch {}
        fs.writeFileSync(startMarkerPath, new Date().toISOString());
        console.log('Wrote', startMarkerPath);
      } catch (e) {
        console.log('Failed to write start marker:', e);
      }
      return;
    }
  }

  // Compute success count (we may adjust summary below if the test process exit code indicates failure)
  let successCount = Math.max(0, summary.total - summary.failed);

  // If there is an exit code file produced by the test step, prefer it to detect failures
  // This helps when the JSON reporter isn't yet updated or is stale.
  if (fs.existsSync(exitCodePath)) {
    try {
      const raw = fs.readFileSync(exitCodePath, 'utf8').trim();
      const exitCode = Number(raw || '0');
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        // if the test process failed but our summary shows 0 failures, reflect that
        if (summary.failed === 0) {
          summary.failed = 1;
          summary.total = Math.max(1, summary.total);
          successCount = Math.max(0, summary.total - summary.failed);
          summary.details.push(`Test process exited with code ${exitCode}`);
        }
      }
    } catch (e) {
      // ignore and proceed
    }
  }
  // Compose a single combined message: start time (from pre-flight), test result
  // (from artifacts/cashin_result.json), and end time + summary (this run).
  let startAt: Date | null = null;
  try {
    if (fs.existsSync(startMarkerPath)) {
      const raw = fs.readFileSync(startMarkerPath, 'utf8').trim();
      const d = new Date(raw);
      if (!isNaN(d.getTime())) startAt = d;
    }
  } catch (e) {
    // ignore
  }

  // Use the earlier-read cashin artifact if available
  let cashin: any = cashinArtifact;
  if (!cashin) {
    try {
      if (fs.existsSync(cashinResultPath)) {
        const raw = fs.readFileSync(cashinResultPath, 'utf8');
        cashin = JSON.parse(raw);
      }
    } catch (e) {
      // ignore
    }
  }

  const parts: string[] = [];
  // Start section
  if (startAt) {
    parts.push(`Payment API Monitor run at ${formatToIST(startAt)}`);
  } else {
    parts.push(runNotice);
  }

  // Result section (from cashin artifact)
  if (cashin) {
    if (cashin.success) {
      parts.push(`✅ PAYMENT INITIATED SUCCESSFULLY\nExternal ID: ${cashin.externalId}\nPayment Status: ${cashin.finalStatus}`);
    } else {
      const code = cashin.errorCodeMessage ?? '';
      const reason = cashin.errorReason ?? '';
      parts.push(`🚨 Cash-in API Failures\nExternal ID: ${cashin.externalId}\nError Code: ${code}\nErrorReason: ${reason}`);
    }
  } else {
    // Fallback: include what we can from summary
    if (summary.failed > 0) {
      parts.push(`🚨 Cash-in API Failures\nNo detailed cashin artifact found.`);
    } else {
      parts.push('✅ PAYMENT INITIATED (no detailed artifact)');
    }
  }

  // End section with run-end time and test counts
  parts.push(`ENDS: ${runNotice}`);
  parts.push(`Tests: ${summary.total}  Failures: ${summary.failed}  Success: ${successCount}`);

  const combined = parts.join('\n\n');
  const sent = await sendTelegram(combined);
  console.log('Combined message sent to Telegram?', sent);

  // Cleanup marker/result files so next pre-flight starts fresh
  try { if (fs.existsSync(startMarkerPath)) fs.unlinkSync(startMarkerPath); } catch {}
  try { if (fs.existsSync(cashinResultPath)) fs.unlinkSync(cashinResultPath); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
