#!/usr/bin/env node

import { setTimeout as delayTimeout } from 'timers/promises';

import { chromium } from 'playwright';

const BASE_URL = 'https://sm.midnight.gd/api/statistics';
const SITE_ORIGIN = 'https://sm.midnight.gd/';
const DEFAULT_REQUEST_DELAY = parseInt(process.env.STATS_REQUEST_DELAY || '2000', 10);
const DEFAULT_COLLECTION_MINUTE = clampMinute(parseInt(process.env.STATS_COLLECTION_MINUTE || '30', 10));
const FETCH_TIMEOUT_MS = parseInt(process.env.STATS_FETCH_TIMEOUT || '20000', 10);
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.STATS_MAX_CONSECUTIVE_ERRORS || '5', 10);
const PLAYWRIGHT_REINIT_THRESHOLD = 3;

let addresses = [];
let serviceUrl = process.env.STATS_SERVICE_URL || '';
let serviceEndpoint = resolveServiceEndpoint(serviceUrl);
let requestDelay = Number.isFinite(DEFAULT_REQUEST_DELAY) ? DEFAULT_REQUEST_DELAY : 2000;
let collectionMinute = DEFAULT_COLLECTION_MINUTE ?? 30;
let isRunningCycle = false;
let scheduleTimer = null;
let initialized = false;
let browser = null;
let context = null;
let page = null;
let playwrightInitAttempts = 0;

process.on('message', (message) => {
  if (!message || message.type !== 'init' || !message.payload) {
    return;
  }

  const {
    addresses: incomingAddresses,
    serviceUrl: incomingServiceUrl,
    requestDelay: incomingDelay,
    collectionMinute: incomingMinute,
  } = message.payload;
  if (Array.isArray(incomingAddresses)) {
    addresses = Array.from(new Set(incomingAddresses.filter(addr => typeof addr === 'string' && addr.length > 0)));
  }

  if (typeof incomingServiceUrl === 'string' && incomingServiceUrl.length > 0) {
    serviceUrl = incomingServiceUrl;
  }
  serviceEndpoint = resolveServiceEndpoint(serviceUrl);

  const parsedDelay = parseInt(incomingDelay, 10);
  if (Number.isFinite(parsedDelay) && parsedDelay > 0) {
    requestDelay = parsedDelay;
  }

  const parsedMinute = clampMinute(parseInt(incomingMinute, 10));
  if (parsedMinute !== null) {
    collectionMinute = parsedMinute;
  }

  if (!initialized) {
    initialized = true;
    console.log(`[STATS-COLLECTOR] ✅ Initialized with ${addresses.length} address(es). Service URL set: ${serviceUrl ? serviceEndpoint : 'no'}. Collection minute: ${collectionMinute}`);
    scheduleNextRun();
  } else {
    console.log(`[STATS-COLLECTOR] ℹ️ Received updated configuration for statistics collection (minute=${collectionMinute}, endpoint=${serviceEndpoint || 'none'})`);
  }
});

process.on('SIGINT', () => {
  console.log('[STATS-COLLECTOR] Received SIGINT, exiting gracefully');
  shutdown().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('[STATS-COLLECTOR] Received SIGTERM, exiting gracefully');
  shutdown().finally(() => process.exit(0));
});

function scheduleNextRun() {
  if (!initialized) {
    return;
  }

  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }

  const now = new Date();
  const nextRun = new Date(now);
  const targetMinute = collectionMinute;

  nextRun.setSeconds(0, 0);
  if (now.getMinutes() < targetMinute) {
    nextRun.setMinutes(targetMinute, 0, 0);
  } else if (now.getMinutes() === targetMinute && now.getSeconds() === 0 && now.getMilliseconds() === 0) {
    nextRun.setHours(nextRun.getHours() + 1, targetMinute, 0, 0);
  } else {
    nextRun.setHours(nextRun.getHours() + 1, targetMinute, 0, 0);
  }

  const delay = Math.max(nextRun.getTime() - now.getTime(), 0);
  console.log(`[STATS-COLLECTOR] ⏰ Next statistics collection scheduled in ${Math.round(delay / 1000)} seconds (at ${nextRun.toISOString()}, minute=${collectionMinute})`);

  scheduleTimer = setTimeout(async () => {
    scheduleTimer = null;
    await runCycleSafely();
    scheduleNextRun();
  }, delay);
}

class StatisticsFetchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StatisticsFetchError';
    this.status = options.status ?? null;
    this.address = options.address ?? null;
  }
}

async function runCycleSafely() {
  if (isRunningCycle) {
    console.warn('[STATS-COLLECTOR] ⚠️ Previous statistics collection cycle still running, skipping this cycle');
    return;
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    console.warn('[STATS-COLLECTOR] ⚠️ No addresses configured. Skipping statistics collection.');
    return;
  }

  isRunningCycle = true;
  try {
    console.log(`[STATS-COLLECTOR] 🚀 Starting statistics collection for ${addresses.length} address(es)`);
    let consecutiveErrors = 0;
    let lastErrorStatus = null;
    for (const addr of addresses) {
      const result = await collectAndForward(addr);
      if (result.success) {
        consecutiveErrors = 0;
        lastErrorStatus = null;
      } else if (result.skipped) {
        // Skipped (e.g., due to 403) - treat as non-fatal but still reset consecutive error counter
        consecutiveErrors = 0;
        lastErrorStatus = null;
      } else {
        consecutiveErrors += 1;
        if (result.status && result.status !== lastErrorStatus) {
          lastErrorStatus = result.status;
        }
        if (Number.isFinite(MAX_CONSECUTIVE_ERRORS) && MAX_CONSECUTIVE_ERRORS > 0 && consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.warn(`[STATS-COLLECTOR] ⚠️ Reached ${consecutiveErrors} consecutive statistics fetch errors (last status: ${lastErrorStatus ?? 'unknown'}). Aborting current cycle to avoid pressure on API.`);
          break;
        }
        if (consecutiveErrors >= PLAYWRIGHT_REINIT_THRESHOLD) {
          console.warn('[STATS-COLLECTOR] ⚠️ Consecutive errors exceeded threshold, resetting Playwright session.');
          await resetPlaywrightSession();
          consecutiveErrors = 0;
          lastErrorStatus = null;
        }
      }
      await delayTimeout(requestDelay);
    }
    console.log('[STATS-COLLECTOR] ✅ Statistics collection cycle completed');
  } catch (error) {
    console.error(`[STATS-COLLECTOR] ❌ Statistics collection cycle failed: ${error.message}`);
  } finally {
    isRunningCycle = false;
  }
}

async function collectAndForward(address) {
  try {
    const stats = await fetchStatistics(address);
    if (!stats) {
      return { success: false, skipped: true };
    }

    const payload = {
      address,
      cryptoReceipts: stats.cryptoReceipts,
      nightAllocation: stats.nightAllocation,
      collectedAt: new Date().toISOString(),
    };

    if (!serviceEndpoint) {
      console.log(`[STATS-COLLECTOR] ℹ️ No service URL configured. Data for ${address.slice(0, 20)}... not forwarded.`);
      return { success: true };
    }

    await postStatistics(payload);
    return { success: true };
  } catch (error) {
    if (error instanceof StatisticsFetchError && error.status === 403) {
      console.warn(`[STATS-COLLECTOR] ⚠️ Statistics API returned 403 for address ${address.slice(0, 20)}..., likely access denied. Skipping this address for this cycle.`);
      // 重新初始化会话，避免持续命中403
      await resetPlaywrightSession();
      return { success: false, skipped: true, status: error.status };
    }
    console.error(`[STATS-COLLECTOR] ❌ Failed to process statistics for address ${address.slice(0, 20)}...: ${error.message}`);
    return { success: false, skipped: false, status: error.status ?? null };
  }
}

async function fetchStatistics(address) {
  await ensurePlaywrightSession();

  if (!page) {
    throw new StatisticsFetchError('Playwright page not initialized', { address });
  }

  const url = `${BASE_URL}/${encodeURIComponent(address)}`;

  try {
    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: FETCH_TIMEOUT_MS,
    });

    if (!response) {
      throw new StatisticsFetchError('No response received', { address });
    }

    const status = response.status();
    if (status !== 200) {
      const statusText = response.statusText();
      throw new StatisticsFetchError(`HTTP ${status}: ${statusText}`, { status, address });
    }

    const data = await response.json();
    const nightAllocation = data?.local?.night_allocation ?? 0;
    const cryptoReceipts = data?.local?.crypto_receipts ?? 0;

    return { nightAllocation, cryptoReceipts };
  } catch (error) {
    if (error instanceof StatisticsFetchError) {
      throw error;
    }
    if (error.name === 'TimeoutError') {
      throw new StatisticsFetchError('Request timed out', { status: null, address });
    }
    throw new StatisticsFetchError(error.message || 'Unknown error', { status: null, address });
  }
}

async function postStatistics(payload) {
  try {
    const endpoint = serviceEndpoint;
    if (!endpoint) {
      return;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Service responded with ${response.status}: ${text}`);
    }
  } catch (error) {
    console.error(`[STATS-COLLECTOR] ⚠️ Failed to forward statistics to service: ${error.message}`);
  }
}

function clampMinute(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 59) {
    return null;
  }
  return value;
}

function resolveServiceEndpoint(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  try {
    const parsed = new URL(rawUrl);
    if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/update';
    }
    return parsed.toString();
  } catch {
    // 如果不是合法的 URL（例如只输入了 host），尝试补全
    if (rawUrl.endsWith('/')) {
      return `${rawUrl}update`;
    }
    if (rawUrl.includes('://')) {
      return `${rawUrl}/update`;
    }
    // 缺少协议时默认 http
    return `http://${rawUrl}${rawUrl.endsWith('/') ? '' : '/'}update`;
  }
}

async function ensurePlaywrightSession() {
  if (browser && context && page) {
    return;
  }

  await resetPlaywrightSession();

  if (browser && context && page) {
    return;
  }

  try {
    playwrightInitAttempts += 1;
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    page = await context.newPage();

    try {
      await page.goto(SITE_ORIGIN, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      console.log('[STATS-COLLECTOR] ✅ Playwright session established (Cloudflare cleared)');
    } catch (error) {
      console.warn(`[STATS-COLLECTOR] ⚠️ Initial session warm-up may have failed: ${error.message}`);
    }
  } catch (error) {
    console.error(`[STATS-COLLECTOR] ❌ Failed to initialize Playwright session: ${error.message}`);
    await resetPlaywrightSession();
  }
}

async function resetPlaywrightSession() {
  if (page) {
    try {
      await page.close();
    } catch {}
    page = null;
  }
  if (context) {
    try {
      await context.close();
    } catch {}
    context = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
  }
}

async function shutdown() {
  await resetPlaywrightSession();
}


