// run-batch.js
import { chromium } from 'playwright';
import { readFileSync, statSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 5; // 并发数（可通过环境变量配置）
const TASK_TIMEOUT_MS = 120_000;
export const BASE_URL = 'https://sm.midnight.gd/wizard/mine'; // 目标网页

// 签名服务 URL（可通过环境变量配置）
export const SIGN_SERVICE_URL = process.env.SIGN_SERVICE_URL || 'https://as.lku3ogjddfkj2.shop';

// ⚠️ 检查页面是否已关闭的辅助函数
function isPageClosed(page) {
  if (!page) {
    return true;
  }
  try {
    return page.isClosed();
  } catch (e) {
    // 如果检查时出错，认为页面已关闭
    return true;
  }
}

// ⚠️ 安全执行页面操作的辅助函数（自动检查页面状态）
async function safePageOperation(page, operation, operationName = 'Page operation') {
  if (isPageClosed(page)) {
    throw new Error(`${operationName} failed: page is closed`);
  }
  
  try {
    return await operation();
  } catch (error) {
    // 检查错误是否因为页面关闭
    const errorMsg = String(error.message || error);
    if (errorMsg.includes('Target page') && errorMsg.includes('closed') ||
        errorMsg.includes('Target closed') ||
        errorMsg.includes('context or browser has been closed') ||
        isPageClosed(page)) {
      throw new Error(`${operationName} failed: page was closed during operation`);
    }
    throw error;
  }
}

// 通用重试机制函数
async function retryWithBackoff(operation, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffMultiplier = 2,
    retryCondition = () => true, // 返回 true 表示应该重试
    operationName = 'Operation',
    getDelay = null // ⚠️ 自定义延迟函数：getDelay(error, attempt, baseDelay) => delay
  } = options;
  
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await operation();
      if (attempt > 0) {
        console.log(`[RETRY] ${operationName} succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      const errorMsg = String(error);
      
      // 检查是否应该重试
      if (!retryCondition(error, attempt)) {
        throw error;
      }
      
      // 如果是最后一次尝试，直接抛出错误
      if (attempt === maxRetries - 1) {
        console.error(`[RETRY] ${operationName} failed after ${maxRetries} attempts:`, errorMsg);
        throw error;
      }
      
      // 计算等待时间（指数退避）
      const baseDelay = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt), maxDelay);
      // ⚠️ 如果提供了自定义延迟函数，使用它；否则使用基础延迟
      const delay = getDelay ? getDelay(error, attempt, baseDelay) : baseDelay;
      console.log(`[RETRY] ${operationName} failed (attempt ${attempt + 1}/${maxRetries}): ${errorMsg.substring(0, 100)}... Retrying in ${Math.floor(delay/1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error(`${operationName} failed after ${maxRetries} attempts`);
}

// ⚠️ 全局 Rate Limiter - 控制整个脚本的请求速率，避免429错误
// 使用令牌桶算法，支持动态调整速率
class GlobalRateLimiter {
  constructor(options = {}) {
    // 默认配置：每5秒最多1个请求（可配置，比之前更快）
    this.minInterval = options.minInterval || 5000; // 最小请求间隔（毫秒）
    this.maxConcurrent = options.maxConcurrent || 1; // 最大并发请求数
    this.lastRequestTime = 0;
    this.requestQueue = [];
    this.activeRequests = 0;
    this.queue = Promise.resolve(); // 全局请求队列
    this.consecutive429Errors = 0; // 连续429错误计数
    this.last429ErrorTime = null; // 最后一次429错误时间
    this.adaptiveInterval = this.minInterval; // 自适应间隔（根据429错误动态调整）
  }

  // 记录429错误，动态调整速率
  record429Error() {
    this.consecutive429Errors++;
    this.last429ErrorTime = Date.now();
    
    // 如果连续出现429错误，增加间隔时间
    if (this.consecutive429Errors >= 3) {
      this.adaptiveInterval = Math.min(this.minInterval * 3, 30000); // 最多30秒
      console.log(`[RATE-LIMITER] ⚠️ Multiple 429 errors detected, increasing interval to ${this.adaptiveInterval}ms`);
    } else if (this.consecutive429Errors >= 2) {
      this.adaptiveInterval = this.minInterval * 2;
    }
  }

  // 记录成功请求，恢复正常速率
  recordSuccess() {
    if (this.consecutive429Errors > 0) {
      // 如果距离最后一次429错误超过1分钟，恢复正常速率
      if (this.last429ErrorTime && (Date.now() - this.last429ErrorTime) > 60000) {
        this.consecutive429Errors = 0;
        this.adaptiveInterval = this.minInterval;
        console.log(`[RATE-LIMITER] ✅ No 429 errors for 1 minute, restoring normal interval to ${this.adaptiveInterval}ms`);
      }
    }
  }

  // 等待直到可以发送请求
  async waitForSlot() {
    return new Promise((resolve) => {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      const currentInterval = this.adaptiveInterval; // 使用自适应间隔
      
      if (timeSinceLastRequest >= currentInterval && this.activeRequests < this.maxConcurrent) {
        // 可以立即发送请求
        this.activeRequests++;
        this.lastRequestTime = now;
        resolve();
      } else {
        // 需要等待
        const waitTime = Math.max(0, currentInterval - timeSinceLastRequest);
        if (waitTime > 0) {
          console.log(`[RATE-LIMITER] ⏳ Waiting ${(waitTime/1000).toFixed(1)}s before next request (interval: ${currentInterval}ms, active: ${this.activeRequests}/${this.maxConcurrent})`);
        }
        setTimeout(() => {
          this.activeRequests++;
          this.lastRequestTime = Date.now();
          resolve();
        }, waitTime);
      }
    });
  }

  // 释放请求槽位
  releaseSlot() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  // 执行带速率限制的操作
  async execute(operation) {
    return new Promise((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          await this.waitForSlot();
          try {
            const result = await operation();
            this.recordSuccess(); // 记录成功请求
            resolve(result);
          } catch (error) {
            // 检查是否是429错误
            if (error.message && error.message.includes('429')) {
              this.record429Error();
            }
            reject(error);
          } finally {
            this.releaseSlot();
          }
        } catch (error) {
          this.releaseSlot();
          reject(error);
        }
      });
    });
  }
}

// 创建全局 rate limiter 实例
// 配置：每5秒最多1个请求（可配置，通过环境变量调整）
// 使用自适应算法，根据429错误动态调整速率
const globalRateLimiter = new GlobalRateLimiter({
  minInterval: parseInt(process.env.GLOBAL_RATE_LIMIT_INTERVAL) || 5000, // 5秒间隔（默认，可配置）
  maxConcurrent: 1, // 串行执行，确保速率控制
});

// ⚠️ Challenge提交速率控制器 - 专门用于控制challenge提交的速率
// 自适应调整：如果没看到429就正常提交，看到429就减慢提交速度，一点一点减慢
class ChallengeSubmissionRateLimiter {
  constructor(options = {}) {
    // 默认配置：初始间隔1秒（challenge提交通常比较频繁）
    this.baseInterval = options.baseInterval || 1000; // 基础提交间隔（毫秒）
    this.minInterval = options.minInterval || 500; // 最小间隔（毫秒）
    this.maxInterval = options.maxInterval || 30000; // 最大间隔（毫秒）
    this.currentInterval = this.baseInterval; // 当前间隔
    this.consecutive429Errors = 0; // 连续429错误计数
    this.last429ErrorTime = null; // 最后一次429错误时间
    this.successCount = 0; // 成功提交计数（用于逐步恢复速率）
    this.successThreshold = 10; // 连续成功10次后尝试加快速率
    this.lastSubmissionTime = 0; // 最后一次提交时间
    
    // ⚠️ 新增：全局阻塞机制 - 当有solution提交时，阻塞所有challenge请求
    this.isBlockingForSolution = false; // 是否正在阻塞（有solution提交中）
    this.blockingSolutionPageId = null; // 正在提交solution的页面ID
    this.blockedChallengeRequests = new Set(); // 被阻塞的challenge请求
  }
  
  // ⚠️ 开始阻塞challenge请求（当检测到solution提交时）
  startBlockingForSolution(pageId) {
    this.isBlockingForSolution = true;
    this.blockingSolutionPageId = pageId;
    // ⚠️ 注意：这里无法直接获取 taskId，因为这是全局的 rate limiter
    // taskId 信息会在 API-SOLUTION 日志中显示
    console.log(`[CHALLENGE-RATE-LIMITER] 🚦 Solution submission detected (page: ${pageId}), blocking all /api/challenge requests`);
  }
  
  // ⚠️ 停止阻塞challenge请求（当solution提交完成时）
  stopBlockingForSolution() {
    if (this.isBlockingForSolution) {
      console.log(`[CHALLENGE-RATE-LIMITER] ✅ Solution submission completed, resuming /api/challenge requests`);
      this.isBlockingForSolution = false;
      this.blockingSolutionPageId = null;
      // 释放所有被阻塞的请求
      this.blockedChallengeRequests.clear();
    }
  }
  
  // ⚠️ 检查是否应该阻塞challenge请求
  shouldBlockChallenge() {
    return this.isBlockingForSolution;
  }

  // 记录429错误，逐步减慢速率
  record429Error() {
    this.consecutive429Errors++;
    this.last429ErrorTime = Date.now();
    this.successCount = 0; // 重置成功计数
    
    // 逐步增加间隔：每次429错误增加20%的间隔时间
    const increaseFactor = 1.2; // 增加20%
    this.currentInterval = Math.min(
      Math.floor(this.currentInterval * increaseFactor),
      this.maxInterval
    );
    
    console.log(`[CHALLENGE-RATE-LIMITER] ⚠️ 429 error detected (count: ${this.consecutive429Errors}), increasing interval to ${this.currentInterval}ms`);
  }

  // 记录成功提交，逐步恢复速率
  recordSuccess() {
    this.successCount++;
    
    // 如果连续成功提交且距离最后一次429错误超过30秒，尝试逐步恢复速率
    if (this.consecutive429Errors > 0) {
      const timeSinceLast429 = this.last429ErrorTime ? (Date.now() - this.last429ErrorTime) : Infinity;
      
      if (timeSinceLast429 > 30000 && this.successCount >= this.successThreshold) {
        // 逐步减少间隔：每次减少10%的间隔时间
        const decreaseFactor = 0.9; // 减少10%
        this.currentInterval = Math.max(
          Math.floor(this.currentInterval * decreaseFactor),
          this.baseInterval
        );
        
        // 如果恢复到基础速率，重置错误计数
        if (this.currentInterval <= this.baseInterval) {
          this.consecutive429Errors = 0;
          this.currentInterval = this.baseInterval;
          console.log(`[CHALLENGE-RATE-LIMITER] ✅ Rate restored to normal (${this.currentInterval}ms) after ${this.successCount} successful submissions`);
        } else {
          console.log(`[CHALLENGE-RATE-LIMITER] 📈 Gradually restoring rate: ${this.currentInterval}ms (${this.successCount} successful submissions, ${timeSinceLast429/1000}s since last 429)`);
        }
        
        this.successCount = 0; // 重置成功计数，等待下一轮
      }
    }
  }

  // 等待直到可以提交下一个challenge
  async waitForNextSubmission() {
    const now = Date.now();
    const timeSinceLastSubmission = now - this.lastSubmissionTime;
    const waitTime = Math.max(0, this.currentInterval - timeSinceLastSubmission);
    
    if (waitTime > 0) {
      // 只在等待时间较长时输出日志（避免日志过多）
      if (waitTime > 2000) {
        console.log(`[CHALLENGE-RATE-LIMITER] ⏳ Waiting ${(waitTime/1000).toFixed(1)}s before next challenge submission (interval: ${this.currentInterval}ms)`);
      }
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastSubmissionTime = Date.now();
  }

  // 获取当前间隔（用于监控）
  getCurrentInterval() {
    return this.currentInterval;
  }

  // 获取429错误统计（用于监控）
  getStats() {
    return {
      currentInterval: this.currentInterval,
      consecutive429Errors: this.consecutive429Errors,
      last429ErrorTime: this.last429ErrorTime,
      successCount: this.successCount,
    };
  }
}

// 创建全局challenge提交速率控制器实例
const challengeSubmissionRateLimiter = new ChallengeSubmissionRateLimiter({
  baseInterval: parseInt(process.env.CHALLENGE_SUBMISSION_INTERVAL) || 1000, // 默认1秒
  minInterval: parseInt(process.env.CHALLENGE_SUBMISSION_MIN_INTERVAL) || 500, // 最小0.5秒
  maxInterval: parseInt(process.env.CHALLENGE_SUBMISSION_MAX_INTERVAL) || 30000, // 最大30秒
});

// 页面导航请求速率限制：使用全局 rate limiter
let navigationQueue = Promise.resolve(); // 全局导航队列（保留用于导航顺序）

// 等待页面稳定（没有正在进行的导航或DOM变化）
async function waitForPageStable(page, timeoutMs = 5000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // 检查是否有正在进行的导航
      const isNavigating = await page.evaluate(() => {
        return document.readyState !== 'complete' || 
               (window.performance && window.performance.navigation && 
                window.performance.navigation.type === 1); // TYPE_RELOAD = 1
      }).catch(() => false);
      
      if (!isNavigating) {
        // 等待一小段时间，确认DOM稳定（没有快速变化）
        await page.waitForTimeout(300);
        
        // 再次检查DOM是否还在变化
        const domStable = await page.evaluate(() => {
          // 如果页面有正在进行的动画或过渡，可能还在变化
          const hasActiveAnimations = document.querySelectorAll('*').length > 0;
          return document.readyState === 'complete';
        }).catch(() => true);
        
        if (domStable) {
          return true; // 页面已稳定
        }
      }
    } catch (e) {
      // 如果检查失败，继续等待
    }
    
    await page.waitForTimeout(200);
  }
  
  return false; // 超时，但继续执行
}

// 检查元素是否稳定存在（多次确认，避免因用户交互导致临时消失）
async function waitForElementStable(page, selectorOrLocator, options = {}) {
  const { timeout = 10000, checkInterval = 500, minStableCount = 2 } = options;
  const startTime = Date.now();
  let stableCount = 0;
  
  while (Date.now() - startTime < timeout) {
    try {
      const isVisible = typeof selectorOrLocator === 'string' 
        ? await page.locator(selectorOrLocator).first().isVisible().catch(() => false)
        : await selectorOrLocator.isVisible().catch(() => false);
      
      if (isVisible) {
        stableCount++;
        if (stableCount >= minStableCount) {
          return true; // 元素稳定存在
        }
      } else {
        stableCount = 0; // 重置计数
      }
    } catch (e) {
      stableCount = 0;
    }
    
    await page.waitForTimeout(checkInterval);
  }
  
  return stableCount >= minStableCount;
}

// ⚠️ 模拟真实用户行为（鼠标移动、滚动、随机延迟）
async function simulateHumanBehavior(page, options = {}) {
  const { 
    mouseMove = true, 
    scroll = true, 
    randomDelay = true,
    minDelay = 100,
    maxDelay = 500 
  } = options;
  
  try {
    // 随机鼠标移动（模拟真实用户）
    if (mouseMove) {
      const viewport = page.viewportSize();
      if (viewport) {
        const randomX = Math.floor(Math.random() * viewport.width);
        const randomY = Math.floor(Math.random() * viewport.height);
        await page.mouse.move(randomX, randomY, { steps: Math.floor(Math.random() * 5) + 1 });
        await page.waitForTimeout(Math.floor(Math.random() * 100) + 50);
      }
    }
    
    // 随机滚动（模拟真实用户浏览）
    if (scroll) {
      const scrollAmount = Math.floor(Math.random() * 300) + 100;
      const scrollDirection = Math.random() > 0.5 ? 1 : -1;
      await page.evaluate((amount, direction) => {
        window.scrollBy(0, amount * direction);
      }, scrollAmount, scrollDirection);
      await page.waitForTimeout(Math.floor(Math.random() * 200) + 100);
    }
    
    // 随机延迟（模拟真实用户的思考时间）
    if (randomDelay) {
      const delay = Math.floor(Math.random() * (maxDelay - minDelay)) + minDelay;
      await page.waitForTimeout(delay);
    }
  } catch (e) {
    // 忽略模拟行为错误，不影响主流程
  }
}

// 安全点击（检测并处理可能的用户交互干扰）
async function safeClick(page, selectorOrLocator, options = {}) {
  const { timeout = 10000, force = true, retries = 3 } = options;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // 等待页面稳定（EC2 上可能需要更长时间）
      await waitForPageStable(page, 3000);
      
      // 等待元素稳定
      const locator = typeof selectorOrLocator === 'string' 
        ? page.locator(selectorOrLocator).first()
        : selectorOrLocator;
      
      // 在 EC2 上放宽稳定性要求，增加超时时间
      const isStable = await waitForElementStable(page, locator, { 
        timeout: 8000,  // 增加超时时间
        minStableCount: 1  // 降低稳定性要求（从2降到1）
      });
      if (!isStable) {
        console.warn(`[SAFE-CLICK] Element not stable, attempt ${attempt}/${retries}, will still try to click`);
        // 即使不稳定也继续尝试，但增加等待时间
        if (attempt < retries) {
          await page.waitForTimeout(2000 * attempt); // 递增等待时间
        }
        // 不 continue，继续尝试点击
      }
      
      // ⚠️ 点击前模拟真实用户行为（鼠标移动到元素上）
      try {
        const box = await locator.boundingBox();
        if (box) {
          // 鼠标移动到元素附近（模拟真实用户）
          await page.mouse.move(
            box.x + box.width / 2 + (Math.random() - 0.5) * 10,
            box.y + box.height / 2 + (Math.random() - 0.5) * 10,
            { steps: Math.floor(Math.random() * 3) + 1 }
          );
          await page.waitForTimeout(Math.floor(Math.random() * 200) + 100);
        }
      } catch (e) {
        // 忽略鼠标移动错误
      }
      
      // 先尝试等待元素可见和可点击
      try {
        await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
      } catch (e) {
        // 如果等待可见失败，仍然尝试点击（使用 force）
        console.warn(`[SAFE-CLICK] Element visibility wait failed, will try force click: ${e.message}`);
      }
      
      // 执行点击（使用 force 选项，即使元素被其他元素覆盖也能点击）
      // 在 EC2 上增加超时时间
      const clickTimeout = timeout * 1.5; // 增加50%的超时时间
      await locator.click({ timeout: clickTimeout, force });
      
      // ⚠️ 点击后模拟真实用户行为（短暂停留）
      await page.waitForTimeout(Math.floor(Math.random() * 200) + 200);
      
      return true;
    } catch (e) {
      console.warn(`[SAFE-CLICK] Attempt ${attempt}/${retries} failed: ${e.message}`);
      if (attempt < retries) {
        const waitTime = 2000 * attempt; // 递增等待时间（2s, 4s, 6s...）
        console.warn(`[SAFE-CLICK] Waiting ${waitTime}ms before retry...`);
        await page.waitForTimeout(waitTime);
      } else {
        // 最后一次尝试失败，抛出错误
        throw e;
      }
    }
  }
  
  return false;
}

// 检查页面是否被重定向到错误页面（429错误页面或其他错误页面）
// 检测 Vercel security check 页面
async function checkIfVercelSecurityCheck(page) {
  try {
    const currentUrl = page.url();
    
    // 检查 URL 是否包含 vercel 相关的内容
    if (currentUrl.includes('vercel') || currentUrl.includes('_vercel')) {
      return { isVercelCheck: true, url: currentUrl };
    }
    
    // 检查页面内容
    try {
      const pageContent = await page.evaluate(() => {
        const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
        const bodyHTML = document.body ? document.body.innerHTML.toLowerCase() : '';
        const title = document.title ? document.title.toLowerCase() : '';
        const allText = bodyText + ' ' + bodyHTML + ' ' + title;
        
        // 检查是否包含 Vercel security check 的特征文本
        const vercelIndicators = [
          'just a moment',
          'checking your browser',
          'vercel',
          'verifying you are human',
          'please wait',
          'security check',
          'bot protection',
          'cloudflare',
          'challenge',
          'verifying'
        ];
        
        for (const indicator of vercelIndicators) {
          if (allText.includes(indicator)) {
            return true;
          }
        }
        
        // 检查是否有特定的 Vercel 验证元素
        const vercelElements = document.querySelectorAll('[class*="vercel"], [id*="vercel"], [class*="challenge"], [id*="challenge"]');
        if (vercelElements.length > 0) {
          return true;
        }
        
        return false;
      }).catch(() => false);
      
      if (pageContent) {
        return { isVercelCheck: true, url: currentUrl };
      }
    } catch (e) {
      // 忽略检查错误
    }
    
    return { isVercelCheck: false };
  } catch (e) {
    return { isVercelCheck: false };
  }
}

// 等待 Vercel security check 完成
async function waitForVercelSecurityCheck(page, maxWaitMs = 60000) {
  const startTime = Date.now();
  const checkInterval = 1000; // 每秒检查一次
  
  console.log('[VERCEL-CHECK] Waiting for Vercel security check to complete...');
  
  while (Date.now() - startTime < maxWaitMs) {
    const check = await checkIfVercelSecurityCheck(page);
    
    if (!check.isVercelCheck) {
      // 验证已完成，检查是否已经导航到目标页面
      const currentUrl = page.url();
      console.log(`[VERCEL-CHECK] Security check completed, current URL: ${currentUrl}`);
      
      // 等待页面稳定
      await page.waitForTimeout(2000);
      return { completed: true, url: currentUrl };
    }
    
    // 还在验证中，继续等待
    await page.waitForTimeout(checkInterval);
  }
  
  // 超时
  const stillOnCheck = await checkIfVercelSecurityCheck(page);
  if (stillOnCheck.isVercelCheck) {
    console.warn(`[VERCEL-CHECK] Security check timeout after ${maxWaitMs}ms, still on check page`);
    return { completed: false, timeout: true, url: page.url() };
  }
  
  return { completed: true, url: page.url() };
}

async function checkIfErrorPage(page) {
  try {
    const currentUrl = page.url();
    // 检查是否是 429 错误页面
    if (currentUrl.includes('/error?code=429') || (currentUrl.includes('/error') && currentUrl.includes('429'))) {
      return { isErrorPage: true, errorCode: '429', url: currentUrl };
    }
    // 检查是否是 403 错误页面
    if (currentUrl.includes('/error?code=403') || (currentUrl.includes('/error') && currentUrl.includes('403'))) {
      return { isErrorPage: true, errorCode: '403', url: currentUrl };
    }
    // 检查页面内容中是否显示403错误
    try {
      const pageText = await page.textContent('body').catch(() => '');
      if (pageText && /403|forbidden/i.test(pageText)) {
        // 检查是否在错误页面元素中
        const errorElements = await page.locator('[role="alert"], .error, .error-message, [class*="error"]').all().catch(() => []);
        for (const el of errorElements) {
          const text = await el.textContent().catch(() => '');
          if (text && /403|forbidden/i.test(text)) {
            return { isErrorPage: true, errorCode: '403', url: currentUrl };
          }
        }
      }
    } catch (e) {
      // 忽略检查错误
    }
    // 检查是否是其他错误页面（如 /wizard/t-c）
    if (currentUrl.includes('/wizard/t-c') || currentUrl.includes('/error')) {
      return { isErrorPage: true, errorCode: 'other', url: currentUrl };
    }
    return { isErrorPage: false };
  } catch (e) {
    return { isErrorPage: false };
  }
}

// 通过 Reset session 重置页面到初始状态
async function resetSessionAndReturn(page) {
  try {
    console.log('[RESET-SESSION] Attempting to reset via Reset session button...');
    
    // 1. 查找 "Reset session" 按钮
    let resetBtn = null;
    
    // 策略1: 使用 getByRole 查找
    try {
      const resetBtns = page.getByRole('button', { name: /reset\s*session/i });
      const buttons = await resetBtns.all();
      for (const btn of buttons) {
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          resetBtn = btn;
          break;
        }
      }
    } catch {}
    
    // 策略2: 使用 locator 查找
    if (!resetBtn) {
      try {
        const resetLocator = page.locator('button').filter({ hasText: /reset\s*session/i }).first();
        if (await resetLocator.isVisible({ timeout: 3000 }).catch(() => false)) {
          resetBtn = resetLocator;
        }
      } catch {}
    }
    
    // 策略3: 通过页面评估查找
    if (!resetBtn) {
      const btnFound = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const resetBtn = buttons.find(btn => {
          const text = (btn.textContent || '').toLowerCase();
          return text.includes('reset') && text.includes('session') && btn.offsetParent !== null;
        });
        if (resetBtn) {
          resetBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        return false;
      }).catch(() => false);
      
      if (btnFound) {
        resetBtn = page.locator('button').filter({ hasText: /reset\s*session/i }).first();
      }
    }
    
    if (!resetBtn) {
      console.warn('[RESET-SESSION] Reset session button not found');
      return false;
    }
    
    // 2. 记录第一个按钮的位置/特征，然后点击它
    console.log('[RESET-SESSION] Clicking first Reset session button...');
    await waitForPageStable(page, 2000);
    
    // 获取第一个按钮的信息（用于后续排除）
    let firstBtnInfo = null;
    try {
      const firstBtnHandle = await resetBtn.elementHandle().catch(() => null);
      if (firstBtnHandle) {
        firstBtnInfo = await firstBtnHandle.evaluate((btn) => {
          const rect = btn.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            text: btn.textContent?.trim() || ''
          };
        }).catch(() => null);
      }
    } catch {}
    
    await safeClick(page, resetBtn, { timeout: 10000, force: true, retries: 3 });
    
    // 等待弹出窗口出现（最多等待3秒）
    console.log('[RESET-SESSION] Waiting for confirmation dialog to appear...');
    await page.waitForTimeout(1500);
    
    // 3. 查找并点击第二个 Reset session 按钮（确认对话框中的）
    console.log('[RESET-SESSION] Looking for confirmation Reset session button in dialog...');
    let confirmResetBtn = null;
    let confirmBtnFound = false;
    
    // 尝试多次查找确认按钮（因为弹出窗口可能需要时间）
    for (let attempt = 1; attempt <= 5; attempt++) {
      // 策略1: 查找所有 Reset session 按钮，排除第一个按钮
      try {
        const allResetBtns = page.getByRole('button', { name: /reset\s*session/i });
        const buttons = await allResetBtns.all();
        
        for (const btn of buttons) {
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            // 获取按钮位置信息
            const btnHandle = await btn.elementHandle().catch(() => null);
            if (btnHandle) {
              const btnInfo = await btnHandle.evaluate((b) => {
                const rect = b.getBoundingClientRect();
                return {
                  x: rect.x,
                  y: rect.y,
                  text: b.textContent?.trim() || ''
                };
              }).catch(() => null);
              
              // 如果位置不同，或者找不到第一个按钮的信息，就认为是确认按钮
              if (!firstBtnInfo || 
                  btnInfo && (btnInfo.x !== firstBtnInfo.x || btnInfo.y !== firstBtnInfo.y)) {
                confirmResetBtn = btn;
                confirmBtnFound = true;
                console.log('[RESET-SESSION] Found confirmation Reset session button (by position)');
                break;
              }
            }
          }
        }
      } catch {}
      
      // 策略2: 查找在对话框/模态框中的按钮（通常在更高层级）
      if (!confirmBtnFound) {
        try {
          // 查找可能的对话框或模态框
          const dialogBtns = page.locator('[role="dialog"] button, .modal button, [class*="dialog"] button, [class*="modal"] button').filter({ hasText: /reset\s*session/i });
          const dialogButton = await dialogBtns.first().isVisible({ timeout: 1000 }).catch(() => false);
          if (dialogButton) {
            confirmResetBtn = dialogBtns.first();
            confirmBtnFound = true;
            console.log('[RESET-SESSION] Found confirmation Reset session button (in dialog)');
            break;
          }
        } catch {}
      }
      
      // 策略3: 查找所有可见的 Reset session 按钮，选择第二个可见的
      if (!confirmBtnFound) {
        try {
          const allBtns = page.locator('button').filter({ hasText: /reset\s*session/i });
          const count = await allBtns.count();
          let visibleIndex = -1;
          
          for (let i = 0; i < count; i++) {
            const btn = allBtns.nth(i);
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
              visibleIndex++;
              // 第二个可见的按钮通常是确认按钮
              if (visibleIndex === 1) {
                confirmResetBtn = btn;
                confirmBtnFound = true;
                console.log('[RESET-SESSION] Found confirmation Reset session button (second visible button)');
                break;
              }
            }
          }
        } catch {}
      }
      
      // 策略4: 通过 evaluate 查找所有可见按钮，选择位置不同的那个
      if (!confirmBtnFound) {
        try {
          const btnInfo = await page.evaluate((firstBtnPos) => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const resetButtons = buttons.filter(btn => {
              const text = (btn.textContent || '').toLowerCase();
              return text.includes('reset') && text.includes('session') && btn.offsetParent !== null;
            });
            
            if (resetButtons.length >= 2 && firstBtnPos) {
              // 找到位置不同的按钮
              for (const btn of resetButtons) {
                const rect = btn.getBoundingClientRect();
                if (rect.x !== firstBtnPos.x || rect.y !== firstBtnPos.y) {
                  return {
                    x: rect.x,
                    y: rect.y,
                    text: btn.textContent?.trim() || ''
                  };
                }
              }
            }
            return null;
          }, firstBtnInfo).catch(() => null);
          
          if (btnInfo) {
            // 使用文本和位置信息再次定位
            const confirmBtns = page.locator('button').filter({ hasText: /reset\s*session/i });
            const buttons = await confirmBtns.all();
            for (const btn of buttons) {
              if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                const btnPos = await btn.elementHandle().then(h => 
                  h?.evaluate(b => ({ x: b.getBoundingClientRect().x, y: b.getBoundingClientRect().y })).catch(() => null)
                ).catch(() => null);
                
                if (btnPos && (btnPos.x !== firstBtnInfo?.x || btnPos.y !== firstBtnInfo?.y)) {
                  confirmResetBtn = btn;
                  confirmBtnFound = true;
                  console.log('[RESET-SESSION] Found confirmation Reset session button (by evaluate)');
                  break;
                }
              }
            }
          }
        } catch {}
      }
      
      if (confirmBtnFound) break;
      
      if (attempt < 5) {
        console.log(`[RESET-SESSION] Confirmation button not found yet, waiting... (attempt ${attempt}/5)`);
        await page.waitForTimeout(500);
      }
    }
    
    if (confirmResetBtn && confirmBtnFound) {
      console.log('[RESET-SESSION] Clicking confirmation Reset session button...');
      await waitForPageStable(page, 2000);
      await safeClick(page, confirmResetBtn, { timeout: 10000, force: true, retries: 3 });
      await page.waitForTimeout(2000);
    } else {
      // 如果没有找到第二个按钮，可能对话框已经自动关闭，或者按钮文本不同
      console.warn('[RESET-SESSION] Confirmation button not found after all attempts, checking if already reset...');
      // 检查是否已经回到初始状态
      const alreadyReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 2000 }).catch(() => false);
      if (alreadyReset) {
        console.log('[RESET-SESSION] Already returned to initial state (no confirmation needed)');
        return true;
      }
      // 如果还没重置，等待一下看看是否会自动关闭
      await page.waitForTimeout(2000);
    }
    
    // 4. 等待页面回到初始状态
    console.log('[RESET-SESSION] Waiting for page to return to initial state...');
    await page.waitForTimeout(3000);
    
    // 5. 验证是否回到了初始状态（检查是否有 "Enter an address manually" 按钮）
    const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 5000 }).catch(() => false);
    
    if (isReset) {
      console.log('[RESET-SESSION] Successfully reset to initial state via Reset session!');
      return true;
    } else {
      console.warn('[RESET-SESSION] Page may not be fully reset, but continuing...');
      return true;
    }
  } catch (e) {
    console.error(`[RESET-SESSION] Error during reset session: ${e.message}`);
    return false;
  }
}

// 通过 Disconnect 重置页面到初始状态
async function disconnectAndReset(page) {
  try {
    console.log('[DISCONNECT] Attempting to reset page via Disconnect...');
    
    // 1. 查找 "Scavenger Mine" 下面的 "Disconnect" 按钮
    let disconnectBtn = null;
    
    // 策略1: 查找包含 "Scavenger Mine" 文本附近的 Disconnect 按钮
    try {
      const scavengerMineText = page.getByText('Scavenger Mine', { exact: false });
      if (await scavengerMineText.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        // 在 Scavenger Mine 的父容器或兄弟元素中查找 Disconnect
        const container = await scavengerMineText.first().locator('..').first().locator('..').first().elementHandle().catch(() => null);
        if (container) {
          const disconnectInContainer = page.locator('button, a, [role="button"]').filter({ hasText: /disconnect/i });
          const buttons = await disconnectInContainer.all();
          for (const btn of buttons) {
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
              disconnectBtn = btn;
              break;
            }
          }
        }
      }
    } catch {}
    
    // 策略2: 直接查找所有 Disconnect 按钮，选择可见的第一个
    if (!disconnectBtn) {
      try {
        const allDisconnectBtns = page.getByRole('button', { name: /disconnect/i });
        const buttons = await allDisconnectBtns.all();
        for (const btn of buttons) {
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            disconnectBtn = btn;
            break;
          }
        }
      } catch {}
    }
    
    // 策略3: 使用 locator 查找包含 disconnect 文本的按钮
    if (!disconnectBtn) {
      try {
        const disconnectLocator = page.locator('button').filter({ hasText: /disconnect/i }).first();
        if (await disconnectLocator.isVisible({ timeout: 3000 }).catch(() => false)) {
          disconnectBtn = disconnectLocator;
        }
      } catch {}
    }
    
    if (!disconnectBtn) {
      console.warn('[DISCONNECT] Disconnect button not found, trying alternative methods...');
      // 尝试通过页面评估查找
      const btnFound = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const disconnectBtn = buttons.find(btn => {
          const text = (btn.textContent || '').toLowerCase();
          return text.includes('disconnect') && btn.offsetParent !== null;
        });
        if (disconnectBtn) {
          disconnectBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        return false;
      }).catch(() => false);
      
      if (!btnFound) {
        throw new Error('Disconnect button not found on page');
      }
      
      // 再次尝试查找
      disconnectBtn = page.locator('button').filter({ hasText: /disconnect/i }).first();
    }
    
    // 点击 Disconnect 按钮
    if (disconnectBtn) {
      console.log('[DISCONNECT] Clicking Disconnect button...');
      await disconnectBtn.scrollIntoViewIfNeeded();
      await disconnectBtn.click({ timeout: 5000 });
      await page.waitForTimeout(1500); // 等待对话框/子页面出现
    } else {
      throw new Error('Could not find Disconnect button');
    }
    
    // 2. 等待并处理弹出的对话框/子页面
    console.log('[DISCONNECT] Waiting for dialog/modal to appear...');
    await page.waitForTimeout(1000);
    
    // 在对话框/子页面中点击 Disconnect
    let dialogDisconnectClicked = false;
    try {
      // 查找对话框中的 Disconnect 按钮
      const dialogDisconnect = page.locator('button, [role="button"]').filter({ hasText: /^disconnect$/i }).first();
      if (await dialogDisconnect.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[DISCONNECT] Clicking Disconnect in dialog...');
        await dialogDisconnect.click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        dialogDisconnectClicked = true;
      }
    } catch {}
    
    // 如果没找到，尝试在所有 frame 中查找
    if (!dialogDisconnectClicked) {
      try {
        for (const frame of page.frames()) {
          try {
            const frameDisconnect = frame.locator('button, [role="button"]').filter({ hasText: /^disconnect$/i }).first();
            if (await frameDisconnect.isVisible({ timeout: 2000 }).catch(() => false)) {
              console.log('[DISCONNECT] Clicking Disconnect in frame...');
              await frameDisconnect.click({ timeout: 5000 });
              await page.waitForTimeout(1000);
              dialogDisconnectClicked = true;
              break;
            }
          } catch {}
        }
      } catch {}
    }
    
    // 使用页面评估查找并点击 Disconnect
    if (!dialogDisconnectClicked) {
      const clicked = await page.evaluate(() => {
        // 查找所有按钮，包括可能在 shadow DOM 中的
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const disconnectBtn = allButtons.find(btn => {
          const text = (btn.textContent || '').trim().toLowerCase();
          return text === 'disconnect' && btn.offsetParent !== null;
        });
        
        if (disconnectBtn) {
          disconnectBtn.click();
          return true;
        }
        return false;
      }).catch(() => false);
      
      if (clicked) {
        console.log('[DISCONNECT] Clicked Disconnect via evaluate...');
        await page.waitForTimeout(1000);
        dialogDisconnectClicked = true;
      }
    }
    
    // 3. 点击 Close 按钮关闭对话框
    console.log('[DISCONNECT] Looking for Close button...');
    await page.waitForTimeout(500);
    
    let closeClicked = false;
    try {
      const closeBtn = page.getByRole('button', { name: /^close$/i }).first();
      if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[DISCONNECT] Clicking Close button...');
        await closeBtn.click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        closeClicked = true;
      }
    } catch {}
    
    // 如果没找到 Close，尝试其他方式
    if (!closeClicked) {
      try {
        const closeLocator = page.locator('button, [role="button"]').filter({ hasText: /^close$/i }).first();
        if (await closeLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('[DISCONNECT] Clicking Close via locator...');
          await closeLocator.click({ timeout: 5000 });
          await page.waitForTimeout(1000);
          closeClicked = true;
        }
      } catch {}
    }
    
    // 使用页面评估查找并点击 Close
    if (!closeClicked) {
      const clicked = await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"], [aria-label*="close" i]'));
        const closeBtn = allButtons.find(btn => {
          const text = (btn.textContent || '').trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          return (text === 'close' || ariaLabel.includes('close')) && btn.offsetParent !== null;
        });
        
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
        return false;
      }).catch(() => false);
      
      if (clicked) {
        console.log('[DISCONNECT] Clicked Close via evaluate...');
        await page.waitForTimeout(1000);
        closeClicked = true;
      }
    }
    
    // 4. 等待页面回到初始状态
    console.log('[DISCONNECT] Waiting for page to reset to initial state...');
    await page.waitForTimeout(2000);
    
    // 5. 验证是否回到了初始状态（检查是否有 "Enter an address manually" 按钮）
    const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 5000 }).catch(() => false);
    
    if (isReset) {
      console.log('[DISCONNECT] Successfully reset to initial state!');
      return true;
    } else {
      console.warn('[DISCONNECT] Page may not be fully reset, but continuing...');
      // 即使没有确认回到初始状态，也返回 true，让流程继续
      return true;
    }
  } catch (e) {
    console.error(`[DISCONNECT] Error during disconnect and reset: ${e.message}`);
    
    // 如果是在 429 错误页面且找不到 Disconnect 按钮，尝试直接导航回去
    if (e.message.includes('Disconnect button not found')) {
      try {
        console.log('[DISCONNECT] Disconnect button not found, attempting direct navigation to BASE_URL...');
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        console.log('[DISCONNECT] Direct navigation successful');
        return true;
      } catch (navError) {
        console.error(`[DISCONNECT] Direct navigation also failed: ${navError.message}`);
      }
    }
    
    return false;
  }
}

// 检查页面是否显示 "too many requests" 错误（只检查实际显示的错误消息，不检查API错误）
async function checkPageForRateLimitError(page, retries = 3) {
  // 首先检查页面是否仍然打开
  if (!page || page.isClosed()) {
    return { hasError: false };
  }
  
  for (let i = 0; i < retries; i++) {
    try {
      // 每次重试前检查页面是否仍然打开
      if (page.isClosed()) {
        return { hasError: false };
      }
      
      // 检查页面是否还在加载中，避免在导航时检查
      try {
        const currentUrl = page.url();
        const evalUrl = await page.evaluate(() => window.location.href).catch(() => '');
        if (currentUrl !== evalUrl) {
          await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
        }
      } catch {}
      
      // 等待页面稳定（先检查页面是否仍然打开）
      if (!page.isClosed()) {
        await page.waitForTimeout(300).catch(() => {}); // 如果页面关闭，忽略错误
      } else {
        return { hasError: false };
      }
      
      // 再次检查页面是否仍然打开
      if (page.isClosed()) {
        return { hasError: false };
      }
      
      const checkResult = await page.evaluate(() => {
        // 只检查可见的错误消息元素，不检查页面文本中的"403"（可能是API错误）
        const errorSelectors = [
          '[role="alert"]',
          '.error',
          '.error-message',
          '[class*="error"]:not([class*="hidden"])',
          '[class*="rate-limit"]',
          '[class*="too-many"]',
          '[data-error]',
          '[aria-live="polite"][role="status"]',
          '[aria-live="assertive"]'
        ];
        
        let foundErrorText = null;
        
        // 首先检查专门的错误元素
        for (const selector of errorSelectors) {
          try {
            const els = document.querySelectorAll(selector);
            for (const el of els) {
              // 只检查可见的元素
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                continue;
              }
              
              const text = el.textContent?.trim() || '';
              if (text.length === 0) continue;
              
              // 检查是否是速率限制相关的错误消息（排除API响应中的403）
              if (/you'?re making too many requests/i.test(text) ||
                  /too many requests.*please wait/i.test(text) ||
                  /please wait.*try again/i.test(text) ||
                  /rate limit.*exceeded/i.test(text) ||
                  /try again later/i.test(text)) {
                foundErrorText = text;
                break;
              }
            }
            if (foundErrorText) break;
          } catch {}
        }
        
        // 如果没有找到错误元素，检查页面主要区域是否有明确的错误消息
        if (!foundErrorText) {
          const mainContent = document.querySelector('main, [role="main"], .content, .container, body');
          if (mainContent) {
            const mainText = mainContent.innerText || '';
            // 只匹配完整的错误消息，不是简单的"403"数字
            const errorMatch = mainText.match(/(you'?re making too many requests[^.!]*[.!]|too many requests[^.!]*please wait[^.!]*[.!]|please wait.*moment.*try again[^.!]*[.!])/i);
            if (errorMatch) {
              foundErrorText = errorMatch[0].trim();
            }
          }
        }
        
        return foundErrorText;
      }).catch((e) => {
        // 如果页面正在导航或执行上下文被销毁，返回 null（非错误状态）
        if (e.message && (e.message.includes('Execution context was destroyed') || 
                          e.message.includes('navigation') ||
                          e.message.includes('Target closed'))) {
          return null;
        }
        // 其他错误也返回 null，避免误判
        return null;
      });
      
      if (checkResult) {
        return { hasError: true, errorText: checkResult };
      }
      
      return { hasError: false };
    } catch (e) {
      // 如果是因为页面导航导致的错误，不算作真正的错误，返回 false
      if (e.message && (e.message.includes('Execution context was destroyed') || 
                        e.message.includes('Target closed') ||
                        e.message.includes('navigation'))) {
        return { hasError: false };
      }
      
      if (i === retries - 1) {
        // 只在最后一次重试失败时才记录警告
        // 但如果是页面关闭错误，不记录警告
        if (!e.message || !e.message.includes('Target page') && !e.message.includes('Target closed')) {
          console.warn(`[RATE-LIMIT-CHECK] Failed to check page for rate limit error: ${e.message}`);
        }
      }
      // 在等待前检查页面是否仍然打开
      if (!page.isClosed()) {
        await page.waitForTimeout(500).catch(() => {}); // 如果页面关闭，忽略错误
      } else {
        return { hasError: false };
      }
    }
  }
  
  return { hasError: false };
}

// 处理错误页面：检测并恢复（只有429错误页面使用Disconnect重置，其他错误页面直接导航回去）
async function handleErrorPage(page, targetUrl = BASE_URL) {
  const errorPageCheck = await checkIfErrorPage(page);
  if (!errorPageCheck.isErrorPage) {
    return false; // 不是错误页面
  }
  
  // 429 或 403 错误页面：使用 Disconnect 重置
  if (errorPageCheck.errorCode === '429' || errorPageCheck.errorCode === '403') {
    const errorType = errorPageCheck.errorCode === '429' ? '429' : '403';
    console.warn(`[${errorType}-ERROR] Detected ${errorType} error page at ${errorPageCheck.url}`);
    console.log(`[${errorType}-ERROR] Attempting to reset via Disconnect...`);
    
    // 429/403 错误页面需要使用 Disconnect 重置
    const reset = await disconnectAndReset(page);
    if (reset) {
      return true;
    }
    
    // 如果 Disconnect 失败，尝试直接导航
    console.warn(`[${errorType}-ERROR] Disconnect reset failed, trying direct navigation...`);
    try {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await page.waitForTimeout(2000);
      return true;
    } catch (e) {
      console.error(`[${errorType}-ERROR] Navigation also failed: ${e.message}`);
      return false;
    }
  }
  
  // 其他错误页面（如 /wizard/t-c）：直接导航回去，不使用 Disconnect
  console.warn(`[ERROR-PAGE] Detected error page (non-429/403) at ${errorPageCheck.url}`);
  console.log(`[ERROR-PAGE] Navigating back to ${targetUrl}...`);
  
  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2000); // 等待页面加载
    
    // 检查是否仍然在错误页面
    const afterNavCheck = await checkIfErrorPage(page);
    if (afterNavCheck.isErrorPage) {
      console.warn(`[ERROR-PAGE] Still on error page after navigation, waiting longer...`);
      // 等待一段时间后再试导航
      await page.waitForTimeout(5000);
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await page.waitForTimeout(2000);
    }
    
    console.log(`[ERROR-PAGE] Successfully navigated back to target page`);
    return true;
  } catch (e) {
    console.error(`[ERROR-PAGE] Failed to navigate back: ${e.message}`);
    return false;
  }
}

// 保持向后兼容的别名
async function handle429ErrorPage(page, targetUrl = BASE_URL) {
  return await handleErrorPage(page, targetUrl);
}

// 等待页面错误消失（限制最大等待时间，避免无限循环）
async function waitForRateLimitErrorToClear(page, maxWaitMs = 30000, checkIntervalMs = 3000, targetUrl = BASE_URL) {
  const startTime = Date.now();
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5; // 最多连续5次检查到错误就放弃等待
  
  while (Date.now() - startTime < maxWaitMs) {
    // 首先检查是否是429错误页面
    const errorPageCheck = await checkIfErrorPage(page);
    if (errorPageCheck.isErrorPage && errorPageCheck.errorCode === '429') {
      console.warn(`[429-ERROR] Detected 429 error page, navigating back to ${targetUrl}...`);
      const navigated = await handleErrorPage(page, targetUrl);
      if (navigated) {
        // 导航成功后，检查页面错误消息
        await page.waitForTimeout(2000);
        const check = await checkPageForRateLimitError(page, 1);
        if (!check.hasError) {
          console.log(`[RATE-LIMIT] Error cleared after navigating back from 429 page`);
          return true;
        }
      }
    }
    
    // 检查页面错误消息
    const check = await checkPageForRateLimitError(page, 1);
    if (!check.hasError) {
      // 确认不在错误页面
      const stillOnErrorPage = await checkIfErrorPage(page);
      if (!stillOnErrorPage.isErrorPage) {
        console.log(`[RATE-LIMIT] Error cleared after ${Date.now() - startTime}ms`);
        return true; // 错误已消失
      }
    }
    
    consecutiveErrors++;
    if (consecutiveErrors >= maxConsecutiveErrors) {
      console.warn(`[RATE-LIMIT] Error persists after ${consecutiveErrors} checks, checking for 429 error page...`);
      
      // 最后检查是否是错误页面，如果是则处理
      const finalErrorPageCheck = await checkIfErrorPage(page);
      if (finalErrorPageCheck.isErrorPage) {
        console.log(`[ERROR-PAGE] Final attempt: handling error page (${finalErrorPageCheck.errorCode})...`);
        await handleErrorPage(page, targetUrl);
        await page.waitForTimeout(2000);
      } else {
        // 尝试刷新页面
        try {
          console.log(`[RATE-LIMIT] Attempting to refresh page...`);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);
          
          // 刷新后检查是否跳转到错误页面
          const afterRefreshErrorCheck = await checkIfErrorPage(page);
          if (afterRefreshErrorCheck.isErrorPage) {
            await handleErrorPage(page, targetUrl);
          }
          
          // 检查一次，如果还有错误就放弃
          const afterRefreshCheck = await checkPageForRateLimitError(page, 1);
          if (!afterRefreshCheck.hasError) {
            const finalErrorCheck = await checkIfErrorPage(page);
            if (!finalErrorCheck.isErrorPage) {
              console.log(`[RATE-LIMIT] Error cleared after refresh`);
              return true;
            }
          }
        } catch {}
      }
      
      // 即使刷新后还有错误，也继续执行，因为可能是API错误不影响页面功能
      console.warn(`[RATE-LIMIT] Continuing despite error (may be API-only error)...`);
      return false;
    }
    
    const remaining = Math.max(0, maxWaitMs - (Date.now() - startTime));
    const waitTime = Math.min(checkIntervalMs, remaining);
    if (waitTime > 0) {
      console.log(`[RATE-LIMIT] Rate limit error still present (${consecutiveErrors}/${maxConsecutiveErrors}), waiting ${waitTime}ms...`);
      await page.waitForTimeout(waitTime);
    } else {
      break;
    }
  }
  
  // 超时前最后检查错误页面
  const timeoutErrorPageCheck = await checkIfErrorPage(page);
  if (timeoutErrorPageCheck.isErrorPage) {
    console.log(`[ERROR-PAGE] Timeout detected error page (${timeoutErrorPageCheck.errorCode}), handling...`);
    await handleErrorPage(page, targetUrl);
  }
  
  console.warn(`[RATE-LIMIT] Wait timeout after ${Date.now() - startTime}ms, continuing...`);
  return false; // 超时，但继续执行
}

// 带速率限制和重试的页面导航函数（全局串行化）
async function gotoWithRateLimit(page, url, options = {}) {
  // 使用全局队列确保并发任务串行化
  // ⚠️ 减少日志：只在关键步骤输出
  // console.log(`[NAV] 🚀 gotoWithRateLimit called for URL: ${url}`);
  return new Promise((resolve, reject) => {
    navigationQueue = navigationQueue.then(async () => {
      try {
        // ⚠️ 减少日志：不输出导航队列处理开始
        // console.log(`[NAV] 🔄 Starting navigation queue processing for: ${url}`);
        // ⚠️ 先访问主页建立会话（模拟真实用户行为）
        const homepageUrl = 'https://sm.midnight.gd/';
        // ⚠️ 只有完全等于主页URL时才认为是主页（避免误判 /wizard/mine 等路径）
        const isHomepage = url === homepageUrl || url === homepageUrl.replace(/\/$/, '');
        
        // ⚠️ 减少日志：不输出主页检查
        // console.log(`[NAV] 🔍 Checking if homepage visit needed. Target URL: ${url}, Is homepage: ${isHomepage}`);
        
        // ⚠️ 优化：检查当前页面URL，如果已经在目标页面或相关页面，跳过homepage访问
        let currentUrl = '';
        try {
          currentUrl = page.url();
        } catch (e) {
          // ignore
        }
        const alreadyOnTarget = currentUrl && (currentUrl === url || currentUrl.replace(/\/$/, '') === url.replace(/\/$/, ''));
        const alreadyOnRelatedPage = currentUrl && (
          (url.includes('/wizard/mine') && currentUrl.includes('/wizard/')) ||
          (url.includes('/wizard/wallet') && currentUrl.includes('/wizard/'))
        );
        
        // ⚠️ 优化：如果已经在目标页面，跳过homepage访问和等待
        if (alreadyOnTarget) {
          console.log(`[NAV] ℹ️  Already on target page (${currentUrl}), skipping homepage visit and navigation`);
          resolve();
          return;
        }
        
        // ⚠️ 优化：如果已经在相关页面（如wallet/mine），且不是首次访问，可以跳过homepage访问
        const needsHomepageVisit = !isHomepage && !alreadyOnRelatedPage;
        
        if (needsHomepageVisit) {
          // ⚠️ 使用全局 rate limiter 控制主页访问速率
          await globalRateLimiter.execute(async () => {
            try {
              // ⚠️ 减少日志：不输出主页访问步骤
              // console.log(`[NAV] 📍 Step 1: Visiting homepage first to establish session: ${homepageUrl}`);
              const homepageResponse = await page.goto(homepageUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
              }).catch((err) => {
                console.warn(`[NAV] ⚠️ Homepage visit failed: ${err.message}, continuing to target URL...`);
                return null;
              });
              
              // ⚠️ 根据响应状态智能调整等待时间
              let sessionEstablished = false;
              if (homepageResponse) {
                const status = homepageResponse.status();
                // ⚠️ 减少日志：不输出主页加载成功（除非是错误状态）
                if (status !== 200 && status !== 429) {
                  console.log(`[NAV] ✅ Homepage loaded successfully (status: ${status})`);
                }
                // 如果返回429，说明已经建立了会话（服务器识别到了请求），可以减少等待
                if (status === 429) {
                  console.log(`[NAV] ℹ️  Status 429 detected, session already established, reducing wait time...`);
                  // ⚠️ 记录429错误到全局 rate limiter
                  globalRateLimiter.record429Error();
                  sessionEstablished = true;
                }
              }
              
              // ⚠️ 优化：减少等待时间，使用全局 rate limiter 后不需要长时间等待
              if (!sessionEstablished) {
                // ⚠️ 减少日志：不输出模拟人类行为步骤
                // console.log(`[NAV] 📍 Step 2: Simulating human behavior on homepage...`);
                await simulateHumanBehavior(page, {
                  mouseMove: true,
                  scroll: true,
                  randomDelay: true,
                  minDelay: 200, // 优化：减少到0.2秒
                  maxDelay: 400  // 优化：减少到0.4秒
                });
                
                // 减少额外等待时间（全局 rate limiter 已经控制了速率）
                const extraWait = 200 + Math.floor(Math.random() * 200); // 0.2-0.4秒（优化：从0.3-0.6秒减少）
                // ⚠️ 减少日志：不输出等待会话建立步骤
                // console.log(`[NAV] 📍 Step 3: Waiting ${(extraWait/1000).toFixed(1)}s for session to establish...`);
                await page.waitForTimeout(extraWait);
              } else {
                // 会话已建立，只需短暂等待确保稳定
                // ⚠️ 减少日志：不输出会话已建立步骤
                // console.log(`[NAV] 📍 Step 2-3: Session already established, minimal wait (0.2s)...`);
                await page.waitForTimeout(200); // 优化：从300ms减少到200ms
              }
              
              // ⚠️ 减少日志：不输出会话建立成功（关键步骤已保留）
              // console.log(`[NAV] ✅ Session established, proceeding to target URL...`);
            } catch (homepageError) {
              console.warn(`[NAV] ⚠️ Homepage visit error (continuing): ${homepageError.message}`);
              // 继续尝试目标页面
            }
          });
        } else if (alreadyOnRelatedPage) {
          console.log(`[NAV] ℹ️  Already on related page (${currentUrl}), skipping homepage visit`);
        }
        
        // ⚠️ 使用全局 rate limiter 控制目标页面导航速率
        // 移除所有固定延迟，rate limiter 已经控制了全局速率
        const result = await globalRateLimiter.execute(async () => {
          // ⚠️ 优化：如果已经在相关页面，减少或跳过准备等待
          if (!isHomepage && !alreadyOnRelatedPage) {
            const prepWait = 100 + Math.floor(Math.random() * 200); // 0.1-0.3秒
            // ⚠️ 减少日志：不输出准备步骤
            // console.log(`[NAV] 📍 Step 4: Final preparation before navigating to target URL (${Math.floor(prepWait)}ms)...`);
            await page.waitForTimeout(prepWait);
          } else if (alreadyOnRelatedPage) {
            // 已经在相关页面，只需短暂等待
            await page.waitForTimeout(100);
          }
          
          // 使用重试机制执行页面导航
          // ⚠️ 跟踪是否已经等待过Vercel检查，避免重复等待
          let vercelCheckWaited = false;
          return await retryWithBackoff(
            async () => {
            // ⚠️ 减少日志：不输出导航步骤（关键错误会保留）
            // console.log(`[NAV] 📍 Step 5: Navigating to target URL: ${url}...`);
  
            
            // 只监听主页面 URL 的响应错误（忽略 API 请求）
            let mainPageResponseError = null;
            const errorHandler = (response) => {
              if (!response) return;
              const responseUrl = response.url();
              const status = response.status();
              
              // ⚠️ 记录504错误（网关超时），即使不是主页面URL也要记录
              if (status === 504) {
                console.warn(`[NAV] ⚠️ Gateway timeout (504) detected on: ${responseUrl}`);
              }
              
              // 只检查主页面 URL 的响应，忽略 API 请求
              const isMainPageUrl = responseUrl === url || responseUrl.startsWith(url.split('?')[0]);
              const isApiRequest = responseUrl.includes('/api/') || responseUrl !== url;
              
              // 只有主页面响应错误才应该阻止导航
              if (isMainPageUrl && !isApiRequest) {
                if (status === 403) {
                  mainPageResponseError = { status: 403, url: responseUrl };
                } else if (status === 429) {
                  mainPageResponseError = { status: 429, url: responseUrl };
                } else if (status === 504) {
                  // ⚠️ 504错误也应该触发重试，但使用更短的延迟
                  mainPageResponseError = { status: 504, url: responseUrl };
                }
              }
            };
            
            page.on('response', errorHandler);
            
            try {
              // 在 headless 模式下使用更宽松的超时和等待策略
              const response = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 45000, // 增加超时时间，headless 模式下可能需要更长时间
                ...options
              }).catch(async (gotoError) => {
                // 如果是 ERR_ABORTED 错误，可能是某些资源加载失败，但页面可能已经加载了
                if (gotoError.message && gotoError.message.includes('ERR_ABORTED')) {
                  console.warn(`[NAV] Navigation aborted (ERR_ABORTED), but page may have loaded. Checking page state...`);
                  // 等待一下，然后检查页面是否实际加载了
                  await page.waitForTimeout(2000);
                  try {
                    const currentUrl = page.url();
                    // 如果 URL 已经改变，说明导航成功了（只是被中止）
                    if (currentUrl.includes(url.split('?')[0]) || currentUrl === url) {
                      console.log(`[NAV] Page actually loaded despite ERR_ABORTED, URL: ${currentUrl}`);
                      // 尝试获取响应（可能为 null）
                      return null; // 返回 null，后续检查会通过
                    }
                  } catch (checkError) {
                    // 如果检查失败，继续抛出原始错误
                  }
                }
                throw gotoError;
              });
              
              // 检查主页面响应状态（只有主页面响应才应该阻止导航）
              // 注意：response 可能为 null（如果导航被中止但页面已加载）
              if (response && !response.ok() && response.status() >= 400) {
                // 检查是否是速率限制或禁止访问错误
                if (response.status() === 429) {
                  throw new Error('Rate limit error (429): Too many requests');
                }
                if (response.status() === 403) {
                  throw new Error('Forbidden error (403): Access denied - possibly rate limited or blocked');
                }
                if (response.status() === 504) {
                  // ⚠️ 504错误：网关超时，应该快速重试
                  throw new Error('Gateway timeout (504): Server gateway timeout - will retry with shorter delay');
                }
                throw new Error(`Navigation failed with status ${response.status()}: ${response.statusText()}`);
              }
              
              // 检查主页面响应错误（API 403 不应该阻止导航）
              if (mainPageResponseError) {
                if (mainPageResponseError.status === 403) {
                  throw new Error('Forbidden error (403): Main page access denied - possibly rate limited');
                }
                if (mainPageResponseError.status === 429) {
                  throw new Error('Rate limit error (429): Too many requests');
                }
                if (mainPageResponseError.status === 504) {
                  // ⚠️ 504错误：网关超时，应该快速重试
                  throw new Error('Gateway timeout (504): Main page gateway timeout - will retry with shorter delay');
                }
              }
              
              // ⚠️ 模拟真实用户行为（页面加载后）
              await simulateHumanBehavior(page, { 
                mouseMove: true, 
                scroll: false, // 刚加载时不需要滚动
                randomDelay: true,
                minDelay: 500,
                maxDelay: 1500 
              });
              
              // ⚠️ 优化：先检查是否已经导航到wallet页面（说明已经通过了验证），避免不必要的等待
              const currentUrl = page.url();
              if (currentUrl.includes('/wizard/wallet')) {
                console.log(`[NAV] ℹ️  Already navigated to wallet page, Vercel check likely passed, skipping wait...`);
                vercelCheckWaited = true; // 标记已经通过验证
              } else {
                // 检查是否是 Vercel security check 页面
                const vercelCheck = await checkIfVercelSecurityCheck(page);
                if (vercelCheck.isVercelCheck) {
                  console.log(`[NAV] ⚠️ Detected Vercel security check during navigation: ${vercelCheck.url}`);
                  // ⚠️ 优化：减少Vercel检查等待时间（从60秒减少到30秒），因为通常很快就能通过
                  console.log(`[NAV]    Waiting up to 30s for security check to complete...`);
                  const waitResult = await waitForVercelSecurityCheck(page, 30000);
                  vercelCheckWaited = true; // 标记已经等待过
                  if (!waitResult.completed) {
                    console.warn(`[NAV] ⚠️ Vercel security check timeout after 30s, will continue anyway...`);
                  } else {
                    console.log(`[NAV] ✅ Vercel security check completed, continuing navigation...`);
                  }
                  await page.waitForTimeout(1000); // 减少等待时间，确保页面稳定
                }
              }
              
              // 检查是否被重定向到错误页面（429或403）
              const errorPageCheck = await checkIfErrorPage(page);
              if (errorPageCheck.isErrorPage) {
                if (errorPageCheck.errorCode === '429') {
                  console.warn(`[NAV] Redirected to 429 error page: ${errorPageCheck.url}`);
                  // ⚠️ 记录429错误到全局 rate limiter
                  globalRateLimiter.record429Error();
                  throw new Error(`429 error page detected: redirected to ${errorPageCheck.url}`);
                } else if (errorPageCheck.errorCode === '403') {
                  console.warn(`[NAV] Redirected to 403 error page: ${errorPageCheck.url}`);
                  throw new Error(`403 error page detected: redirected to ${errorPageCheck.url}`);
                }
              }
              
              // 只在页面稳定时检查错误（避免在导航时检查）
              // 注意：API 403 错误不应该阻止页面继续，只有页面显示的错误消息才应该阻止
              try {
                await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
                const rateLimitCheck = await checkPageForRateLimitError(page);
                // ⚠️ 如果检测到429错误，记录到全局 rate limiter
                if (rateLimitCheck.hasError && rateLimitCheck.errorType === '429') {
                  globalRateLimiter.record429Error();
                }
                // 只有真正在页面上显示的错误消息才抛出异常
                if (rateLimitCheck.hasError) {
                  console.warn(`[NAV] Rate limit error message detected on page: ${rateLimitCheck.errorText}`);
                  // 不立即抛出，先等待一段时间看是否清除
                  await page.waitForTimeout(3000);
                  const recheck = await checkPageForRateLimitError(page);
                  if (recheck.hasError) {
                    throw new Error(`Rate limit error message on page: ${recheck.errorText}`);
                  }
                }
              } catch (checkError) {
                // 如果是检查时的导航错误，忽略
                if (!checkError.message || (!checkError.message.includes('Execution context') && 
                                            !checkError.message.includes('Rate limit'))) {
                  throw checkError;
                }
              }
              
              return response;
            } finally {
              page.off('response', errorHandler);
            }
          },
          {
            maxRetries: 5, // 增加重试次数
            initialDelay: 8000, // 初始等待时间增加到8秒（403 错误需要更长时间）
            maxDelay: 90000, // 最大等待时间增加到90秒
            backoffMultiplier: 2,
            operationName: `Navigation to ${url}`,
            // ⚠️ 针对504错误的特殊处理：使用更短的延迟
            getDelay: (error, attempt, baseDelay) => {
              const errorMsg = String(error).toLowerCase();
              if (errorMsg.includes('504') || errorMsg.includes('gateway timeout')) {
                // 504错误：使用更短的延迟（2秒、4秒、8秒），因为网关超时通常是暂时的
                return Math.min(2000 * Math.pow(2, attempt), 10000);
              }
              return baseDelay;
            },
            retryCondition: (error, attempt) => {
              const errorMsg = String(error).toLowerCase();
              // 网络错误、超时、连接失败、速率限制、403、429错误页面 等应该重试
              const shouldRetry = errorMsg.includes('net::') || 
                                 errorMsg.includes('timeout') || 
                                 errorMsg.includes('connection') ||
                                 errorMsg.includes('failed') ||
                                 errorMsg.includes('err_') ||
                                 errorMsg.includes('rate limit') ||
                                 errorMsg.includes('too many requests') ||
                                 errorMsg.includes('429') ||
                                 errorMsg.includes('429 error page') ||
                                 errorMsg.includes('403') ||
                                 errorMsg.includes('forbidden') ||
                                 errorMsg.includes('504') ||
                                 errorMsg.includes('gateway timeout');
              
              if (shouldRetry && (errorMsg.includes('rate limit') || errorMsg.includes('429') || errorMsg.includes('403') || errorMsg.includes('forbidden'))) {
                console.log(`[NAV] Rate limit, 429 error page, or 403 detected, will retry after exponential backoff (attempt ${attempt + 1})`);
              } else if (shouldRetry && (errorMsg.includes('504') || errorMsg.includes('gateway timeout'))) {
                console.log(`[NAV] Gateway timeout (504) detected, will retry with shorter delay (attempt ${attempt + 1})`);
              }
              
              return shouldRetry;
            }
          }
          );
        });
        
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }).catch(reject);
  });
}

// 统一的输入框填写函数 - 优化版本，减少重试
async function fillInputFieldOptimized(pageOrFrame, labelPattern, value, options = {}) {
  const {
    inputType = 'input', // 'input', 'textarea', 或 'both'
    verifyAfter = true, // 是否在填写后验证
    timeout = 5000
  } = options;
  
  // 构建选择器
  const inputSelector = inputType === 'both' ? 'input,textarea' : inputType;
  const labelRe = new RegExp(labelPattern, 'i');
  
  // 策略1: 通过 label 的 for 属性定位（最可靠）
  try {
    const labels = await pageOrFrame.locator('label').all();
    for (const label of labels) {
      const labelText = await label.textContent().catch(() => '');
      if (labelRe.test(labelText)) {
        const forId = await label.getAttribute('for').catch(() => null);
        if (forId) {
          const input = pageOrFrame.locator(`#${forId}`);
          if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
            await input.scrollIntoViewIfNeeded();
            await input.fill('', { force: true });
            await pageOrFrame.waitForTimeout(50);
            await input.fill(value, { force: true });
            if (verifyAfter) {
              const verify = await pageOrFrame.evaluate((id, expected) => {
                const el = document.getElementById(id);
                return el && el.value === expected && el.value.length > 0;
              }, forId, value).catch(() => false);
              if (verify) {
                console.log(`[FILL] Successfully filled via label[for="${forId}"]`);
                return true;
              }
            } else {
              return true;
            }
          }
        }
      }
    }
  } catch (e) {
    // 继续下一个策略
  }
  
  // 策略2: 通过 label 的父容器定位（适用于大多数情况）
  try {
    const label = pageOrFrame.locator('label').filter({ hasText: labelRe }).first();
    if (await label.isVisible({ timeout: 2000 }).catch(() => false)) {
      const container = label.locator('..').locator('..'); // 向上两级
      const input = container.locator(inputSelector).first();
      if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
        await input.scrollIntoViewIfNeeded();
        const handle = await input.elementHandle();
        if (handle) {
          // 使用 evaluate 直接设置，这是最可靠的方法
          const filled = await pageOrFrame.evaluate((el, val) => {
            el.focus();
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
            return el.value === val && el.value.length > 0;
          }, handle, value).catch(() => false);
          
          if (filled) {
            console.log(`[FILL] Successfully filled via label container`);
            return true;
          }
          
          // 如果 evaluate 失败，使用 fill 方法
          await input.fill('', { force: true });
          await pageOrFrame.waitForTimeout(50);
          await input.fill(value, { force: true });
          if (verifyAfter) {
            const verify = await pageOrFrame.evaluate((el, expected) => {
              return el.value === expected && el.value.length > 0;
            }, handle, value).catch(() => false);
            if (verify) {
              console.log(`[FILL] Successfully filled via fill() method`);
              return true;
            }
          } else {
            return true;
          }
        }
      }
    }
  } catch (e) {
    // 继续下一个策略
  }
  
  // 策略3: 通过 placeholder 或 aria-label 定位
  try {
    const placeholders = [
      inputType === 'input' ? 'Please enter a public key' : null,
      inputType === 'textarea' ? 'Please enter a signature' : null,
      ...(labelRe.source.includes('public') ? ['public key'] : []),
      ...(labelRe.source.includes('signature') ? ['signature'] : [])
    ].filter(Boolean);
    
    for (const ph of placeholders) {
      const input = pageOrFrame.locator(`${inputSelector}[placeholder*="${ph}" i]`).first();
      if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
        await input.scrollIntoViewIfNeeded();
        await input.fill('', { force: true });
        await pageOrFrame.waitForTimeout(50);
        await input.fill(value, { force: true });
        if (verifyAfter) {
          const verify = await pageOrFrame.evaluate((el, expected) => {
            return el.value === expected && el.value.length > 0;
          }, await input.elementHandle(), value).catch(() => false);
          if (verify) {
            console.log(`[FILL] Successfully filled via placeholder`);
            return true;
          }
        } else {
          return true;
        }
      }
    }
  } catch (e) {
    // 继续下一个策略
  }
  
  // 策略4: 在页面中直接查找（最后兜底）
  try {
    const found = await pageOrFrame.evaluate((labelPattern, value, inputType) => {
      const labelRe = new RegExp(labelPattern, 'i');
      let target = null;
      
      // 通过 label 查找
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find(l => labelRe.test(l.textContent || ''));
      
      if (label) {
        const forId = label.getAttribute('for');
        if (forId) {
          const el = document.getElementById(forId);
          if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
            target = el;
          }
        }
        
        if (!target) {
          const container = label.closest('div, form, section');
          if (container) {
            const selector = inputType === 'both' ? 'input,textarea' : inputType;
            target = container.querySelector(selector);
          }
        }
      }
      
      // 如果还是没找到，尝试通过 placeholder
      if (!target) {
        const selector = inputType === 'both' ? 'input,textarea' : inputType;
        const inputs = Array.from(document.querySelectorAll(selector));
        target = inputs.find(el => {
          const ph = el.getAttribute('placeholder') || '';
          const aria = el.getAttribute('aria-label') || '';
          return labelRe.test(ph) || labelRe.test(aria);
        });
      }
      
      if (target) {
        target.focus();
        target.value = '';
        target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        target.value = value;
        target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        return target.value === value && target.value.length > 0;
      }
      
      return false;
    }, labelPattern, value, inputType).catch(() => false);
    
    if (found) {
      console.log(`[FILL] Successfully filled via evaluate`);
      return true;
    }
  } catch (e) {
    // 所有策略都失败
  }
  
  console.log(`[FILL] Failed to fill input with label pattern: ${labelPattern}`);
  return false;
}

// 签名请求速率限制：全局队列，每次请求间隔至少 500ms
let lastSignRequestTime = 0;
const SIGN_REQUEST_MIN_INTERVAL = 500; // 最小请求间隔（毫秒）

// 检查签名服务是否可用
async function checkSignServiceAvailable(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒超时
    
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    }).catch(() => null);
    
    clearTimeout(timeoutId);
    return response !== null;
  } catch {
    return false;
  }
}

// 带速率限制和重试的签名请求函数
async function signWithRateLimit(addr, hex, retries = 5) {
  const signUrl = `${SIGN_SERVICE_URL}/sign?addr=${encodeURIComponent(addr)}&hex=${encodeURIComponent(hex)}`;
  
  // 首次检查服务是否可用（仅在第一次调用时）
  if (!signWithRateLimit._serviceChecked) {
    console.log(`[SIGN] Checking if signing service is available at ${SIGN_SERVICE_URL}...`);
    const available = await checkSignServiceAvailable(`${SIGN_SERVICE_URL}/sign?addr=test&hex=test`);
    if (!available) {
      console.error(`[SIGN] WARNING: Signing service appears to be unavailable at ${SIGN_SERVICE_URL}`);
      console.error('[SIGN] Will retry anyway, but errors are expected if service is not running.');
    } else {
      // ⚠️ 减少日志：不输出签名服务可用信息
      // console.log(`[SIGN] Signing service is available at ${SIGN_SERVICE_URL}.`);
    }
    signWithRateLimit._serviceChecked = true;
  }
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // 速率限制：确保请求间隔
      const now = Date.now();
      const timeSinceLastRequest = now - lastSignRequestTime;
      if (timeSinceLastRequest < SIGN_REQUEST_MIN_INTERVAL) {
        const waitTime = SIGN_REQUEST_MIN_INTERVAL - timeSinceLastRequest;
        console.log(`[SIGN] Rate limiting: waiting ${waitTime}ms before request...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      // ⚠️ 减少日志：不输出签名请求信息（关键错误会保留）
      // console.log(`[SIGN] Requesting signature (attempt ${attempt + 1}/${retries}) from ${signUrl.substring(0, 50)}...`);
      
      lastSignRequestTime = Date.now();
      
      // 添加超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
      
      let signResp;
      try {
        signResp = await fetch(signUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
      
      if (!signResp.ok) {
        const errorText = await signResp.text().catch(() => '');
        // 检查是否是速率限制错误
        if (signResp.status === 429 || errorText.toLowerCase().includes('too many requests')) {
          const waitTime = (attempt + 1) * 2000; // 递增等待时间：2s, 4s, 6s
          console.log(`[SIGN] Rate limit detected, waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue; // 重试
        }
        throw new Error(`Sign service returned ${signResp.status}: ${errorText}`);
      }
      
      const signData = await signResp.json();
      // ⚠️ 减少日志：不输出签名接收成功信息
      // console.log(`[SIGN] Signature received successfully`);
      return signData;
      
    } catch (e) {
      const errorMsg = String(e);
      const errorCause = e.cause ? String(e.cause) : '';
      const errorCode = e.cause?.code || '';
      
      // 构建更详细的错误信息
      let detailedError = errorMsg;
      if (errorCode) {
        detailedError += ` (code: ${errorCode})`;
      }
      if (errorCause && errorCause !== errorMsg) {
        detailedError += ` - ${errorCause}`;
      }
      
      console.error(`[SIGN] Error (attempt ${attempt + 1}/${retries}): ${detailedError}`);
      
      // 检查是否是连接错误（服务不可用）
      const isConnectionError = errorCode === 'ECONNREFUSED' || 
                                errorCode === 'ETIMEDOUT' ||
                                errorCode === 'ENOTFOUND' ||
                                errorMsg.toLowerCase().includes('fetch failed') ||
                                errorMsg.toLowerCase().includes('connection refused') ||
                                errorMsg.toLowerCase().includes('econnrefused');
      
      // 检查是否是速率限制相关的错误
      const isRateLimitError = errorMsg.toLowerCase().includes('too many requests') || 
                               errorMsg.toLowerCase().includes('rate limit');
      
      // 最后一次尝试失败，抛出更详细的错误
      if (attempt === retries - 1) {
        if (isConnectionError) {
          throw new Error(`Failed to connect to signing service at ${SIGN_SERVICE_URL} after ${retries} attempts. Please ensure the service is running. Original error: ${detailedError}`);
        }
        throw new Error(`Sign request failed after ${retries} attempts: ${detailedError}`);
      }
      
      // 计算等待时间（连接错误等待更长时间）
      let waitTime;
      if (isConnectionError) {
        // 连接错误：指数退避，最大30秒
        waitTime = Math.min(2000 * Math.pow(2, attempt), 30000);
        console.log(`[SIGN] Connection error detected, waiting ${waitTime}ms before retry (service may be starting up)...`);
      } else if (isRateLimitError) {
        waitTime = (attempt + 1) * 2000;
        console.log(`[SIGN] Rate limit error detected, waiting ${waitTime}ms before retry...`);
      } else {
        // 其他错误：递增等待时间
        waitTime = 1000 * (attempt + 1);
        console.log(`[SIGN] Retrying in ${waitTime}ms...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  throw new Error('Sign request failed after all retries');
}

// 从 JSON 文件或文件夹加载任务列表
// ⚠️ 默认从项目根目录下的 task 文件夹读取任务列表
// 如果路径指向文件夹，会读取文件夹中所有 .json 文件并合并
// 如果路径指向文件，则直接读取该文件
const TASKS_PATH = process.env.TASKS_FILE || join(__dirname, '..', 'task');

function loadTasks() {
  try {
    const stats = statSync(TASKS_PATH);
    let allTasks = [];
    let loadedFiles = [];
    
    if (stats.isDirectory()) {
      // 如果是文件夹，读取文件夹中所有 .json 文件
      console.log(`[CONFIG] Loading tasks from directory: ${TASKS_PATH}`);
      const files = readdirSync(TASKS_PATH).filter(f => extname(f).toLowerCase() === '.json');
      
      if (files.length === 0) {
        throw new Error(`No JSON files found in directory: ${TASKS_PATH}`);
      }
      
      for (const file of files) {
        const filePath = join(TASKS_PATH, file);
        try {
          const fileContent = readFileSync(filePath, 'utf8');
          const data = JSON.parse(fileContent);
          // 支持两种格式：直接是数组，或者包装在 tasks 属性中
          const tasks = Array.isArray(data) ? data : (data.tasks || []);
          
          if (Array.isArray(tasks) && tasks.length > 0) {
            allTasks = allTasks.concat(tasks);
            loadedFiles.push(`${file} (${tasks.length} tasks)`);
            console.log(`[CONFIG]   ✓ Loaded ${tasks.length} task(s) from ${file}`);
          }
        } catch (err) {
          console.warn(`[CONFIG]   ⚠️ Failed to load ${file}: ${err.message}`);
        }
      }
      
      if (allTasks.length === 0) {
        throw new Error(`No valid tasks found in any JSON file in directory: ${TASKS_PATH}`);
      }
      
      console.log(`[CONFIG] Loaded ${allTasks.length} task(s) from ${loadedFiles.length} file(s)`);
    } else if (stats.isFile()) {
      // 如果是文件，直接读取
      console.log(`[CONFIG] Loading tasks from file: ${TASKS_PATH}`);
      const fileContent = readFileSync(TASKS_PATH, 'utf8');
      const data = JSON.parse(fileContent);
      // 支持两种格式：直接是数组，或者包装在 tasks 属性中
      allTasks = Array.isArray(data) ? data : (data.tasks || []);
      
      if (!Array.isArray(allTasks) || allTasks.length === 0) {
        throw new Error('Tasks file must contain a non-empty array of tasks');
      }
      
      console.log(`[CONFIG] Loaded ${allTasks.length} task(s) from ${TASKS_PATH}`);
    } else {
      throw new Error(`Path is neither a file nor a directory: ${TASKS_PATH}`);
    }
    
    // 验证每个任务都有必需的字段
    for (let i = 0; i < allTasks.length; i++) {
      const task = allTasks[i];
      if (!task.id) {
        throw new Error(`Task at index ${i} is missing required field 'id'`);
      }
      if (!task.addr) {
        throw new Error(`Task at index ${i} (id: ${task.id}) is missing required field 'addr'`);
      }
    }
    
    return allTasks;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`[ERROR] Tasks path not found: ${TASKS_PATH}`);
      console.error(`[ERROR] Please create a task directory or file, or set TASKS_FILE environment variable`);
      console.error(`[ERROR] Example: TASKS_FILE=./my-tasks.json node runbatch.mjs`);
      console.error(`[ERROR] Example: TASKS_FILE=./task node runbatch.mjs`);
    } else {
      console.error(`[ERROR] Failed to load tasks from ${TASKS_PATH}:`, error.message);
    }
    process.exit(1);
  }
}

const tasks = loadTasks();

// 初始化任务（只完成流程到挖矿页面，不启动挖矿）
async function runOneInitOnly(task, scheduler = null) {
  // 复用runOne的逻辑，但在建立session后不启动，而是注册到scheduler
  // 这个函数会完成整个流程直到建立session，但不会点击Start
  return await runOne(task, { initOnly: true, scheduler });
}

async function runOne(task, options = {}) {
  const { initOnly = false, scheduler = null, sharedBrowser = null } = options;
  
  // ⚠️ 记录任务开始时间（页面打开时间），任务进入"登录阶段"
  const taskId = task.id;
  if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
    if (!taskStats.taskTimers.has(taskId)) {
      taskStats.taskTimers.set(taskId, { pageOpenTime: Date.now() });
    } else {
      taskStats.taskTimers.get(taskId).pageOpenTime = Date.now();
    }
    taskStats.loggingIn++;
    console.log(`[STATS] 🔐 Task ${taskId} started (logging in, Logging In: ${taskStats.loggingIn})`);
  }
  
  // 支持 headless 模式（可通过环境变量控制）
  const HEADLESS = process.env.HEADLESS !== 'false'; // 默认 headless 模式
  const DISPLAY = process.env.DISPLAY || ':99';
  
  // ⚠️ 生成随机的浏览器指纹参数（每次运行都不同，但保持合理）
  const screenResolutions = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1600, height: 900 },
  ];
  const hardwareConcurrencyValues = [4, 6, 8, 12, 16];
  const deviceMemoryValues = [4, 8, 16];
  
  const randomScreen = screenResolutions[Math.floor(Math.random() * screenResolutions.length)];
  const randomHardwareConcurrency = hardwareConcurrencyValues[Math.floor(Math.random() * hardwareConcurrencyValues.length)];
  const randomDeviceMemory = deviceMemoryValues[Math.floor(Math.random() * deviceMemoryValues.length)];
  
  // ⚠️ 使用共享浏览器实例（如果提供），否则创建新的浏览器实例
  let browser;
  let shouldCloseBrowser = false; // 标记是否需要关闭浏览器（只有自己创建的才需要关闭）
  
  if (sharedBrowser) {
    // 使用共享浏览器实例
    browser = sharedBrowser;
    shouldCloseBrowser = false;
    console.log(`[RUNONE] Using shared browser instance for task ${task.id}`);
  } else {
    // 创建新的浏览器实例（向后兼容，用于非调度器模式）
    browser = await chromium.launch({
    headless: HEADLESS, // 可通过环境变量 HEADLESS=false 启用可视化
    args: [
      '--guest',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      // ⚠️ 增强反检测参数（适用于所有模式）
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process,AutomationControlled,MediaRouter',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--enable-automation',
      '--password-store=basic',
      '--use-mock-keychain',
      '--lang=en-US,en',
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      // ⚠️ 添加更多反检测标志
      '--disable-infobars',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--disable-translate',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      `--window-size=${randomScreen.width},${randomScreen.height}`,
      ...(HEADLESS ? [
        '--headless=new',
        '--disable-web-security',
        '--disable-site-isolation-trials',
        '--disable-setuid-sandbox',
        '--no-sandbox',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-background-networking',
      ] : [
        `--display=${DISPLAY}`,
        '--disable-gpu',
      ])
    ]
  });
    shouldCloseBrowser = true; // 标记需要关闭自己创建的浏览器
    console.log(`[RUNONE] Created new browser instance for task ${task.id}`);
  }
  
  // ⚠️ 创建 context，添加真实浏览器的特征（特别是 headless 模式下）
  const timezones = ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'Europe/London', 'Europe/Paris'];
  const randomTimezone = timezones[Math.floor(Math.random() * timezones.length)];
  
  // ⚠️ 生成随机的语言偏好
  const languageVariants = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'en-US,en;q=0.9,en-GB;q=0.8',
  ];
  const randomAcceptLanguage = languageVariants[Math.floor(Math.random() * languageVariants.length)];
  
  const context = await browser.newContext({
    viewport: { width: randomScreen.width, height: randomScreen.height },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: randomTimezone,
    permissions: [],
    // ⚠️ 增强的HTTP头（更真实的浏览器行为）
    extraHTTPHeaders: {
      'Accept-Language': randomAcceptLanguage,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Linux"',
      'Sec-CH-UA-Platform-Version': '"5.15.0"',
      'Sec-CH-UA-Arch': '"x86"',
      'Sec-CH-UA-Bitness': '"64"',
      'Sec-CH-UA-Model': '""',
      'Sec-CH-UA-Full-Version-List': '"Google Chrome";v="131.0.6778.85", "Chromium";v="131.0.6778.85", "Not_A Brand";v="24.0.0.0"',
      'DNT': '1',
      'Referer': 'https://www.google.com/', // 模拟从Google搜索进入
    },
    // ⚠️ 添加真实的颜色方案
    colorScheme: 'light',
    // ⚠️ 添加真实的设备比例因子
    deviceScaleFactor: 1,
    // ⚠️ 添加真实的存储状态（模拟已有浏览历史）
    storageState: {
      cookies: [],
      origins: [],
    },
  });
  
  const page = await context.newPage();
  // ⚠️ 设置 taskId 到 page 对象，用于日志记录
  page._taskId = taskId;
  
  // ⚠️ 为页面生成唯一ID（用于日志和追踪）
  const pageId = `page-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // ⚠️ 存储每个页面的solution提交重试信息
  const solutionRetryInfo = new Map(); // pageId -> { startTime, retryCount, currentRetryInterval, last429Time, requestData }
  
  // ⚠️ 添加请求拦截，实现solution提交时的阻塞机制
  // ⚠️ 拦截 /api/solution POST 请求
  // ⚠️ 关键：api/solution 请求受全局 rate limiter 限制，但在提交时临时阻塞所有 /api/challenge 请求
  await page.route('**/api/solution/**', async (route) => {
    // ⚠️ 检查页面状态
    if (isPageClosed(page)) {
      console.warn(`[API-SOLUTION] ⚠️ Page closed, aborting solution submit request`);
      await route.abort();
      return;
    }
    
    const request = route.request();
    const method = request.method();
    
    if (method === 'POST') {
      // ⚠️ 检测到solution提交，开始临时阻塞所有 /api/challenge 请求
      // ⚠️ 关键：在 solution 提交期间，所有 challenge 请求会被阻塞等待
      challengeSubmissionRateLimiter.startBlockingForSolution(pageId);
      
      // 保存请求数据用于重试
      const requestData = {
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
      };
      
      // 初始化重试信息
      if (!solutionRetryInfo.has(pageId)) {
        solutionRetryInfo.set(pageId, {
          startTime: Date.now(),
          retryCount: 0,
          currentRetryInterval: 5000, // 初始5秒
          last429Time: null,
          max400Retries: 10, // 400错误最多重试10次（增加重试次数以提高成功率）
          requestData: requestData,
        });
      }
      
      console.log(`[API-SOLUTION] 🚀 Solution submit request detected (task: ${taskId}, page: ${pageId}) - blocking all /api/challenge requests until completion`);
      
      // ⚠️ 关键：api/solution 请求受全局 rate limiter 限制
      // 使用全局 rate limiter 控制请求速率
      await globalRateLimiter.execute(async () => {
        await route.continue();
      });
    } else {
      // 非 POST 请求直接放行
      await route.continue();
    }
  });
  
  // ⚠️ 拦截 /api/challenge GET 请求，当有solution提交时阻塞
  // ⚠️ 优先级：api/challenge 优先级低于 api/solution，当有 solution 提交时会被阻塞等待
  await page.route('**/api/challenge/**', async (route) => {
    // ⚠️ 检查页面状态
    if (isPageClosed(page)) {
      console.warn(`[API-CHALLENGE] ⚠️ Page closed, aborting challenge request`);
      await route.abort();
      return;
    }
    
    const request = route.request();
    const method = request.method();
    
    if (method === 'GET') {
      // ⚠️ 优先级检查：如果正在提交 solution，阻塞此 challenge 请求
      // ⚠️ api/solution 具有最高优先级，所有 api/challenge 请求必须等待
      if (challengeSubmissionRateLimiter.shouldBlockChallenge()) {
        const blockingPageId = challengeSubmissionRateLimiter.blockingSolutionPageId;
        console.log(`[API-CHALLENGE] ⏸️ Challenge request blocked (page: ${pageId}) - waiting for solution submission to complete (blocking page: ${blockingPageId}) - api/solution has HIGHEST PRIORITY`);
        
        // 等待直到solution提交完成
        const checkInterval = 100; // 每100ms检查一次
        const maxWait = 60000; // 最多等待60秒
        const startWait = Date.now();
        
        while (challengeSubmissionRateLimiter.shouldBlockChallenge() && (Date.now() - startWait) < maxWait) {
          // ⚠️ 检查页面状态
          if (isPageClosed(page)) {
            console.warn(`[API-CHALLENGE] ⚠️ Page closed while waiting for solution, aborting challenge request`);
            await route.abort();
            return;
          }
          await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
        
        if (challengeSubmissionRateLimiter.shouldBlockChallenge()) {
          console.warn(`[API-CHALLENGE] ⚠️ Challenge request timeout waiting for solution submission (page: ${pageId}, waited: ${maxWait/1000}s)`);
        } else {
          console.log(`[API-CHALLENGE] ✅ Challenge request unblocked (page: ${pageId}) - solution submission completed`);
        }
      }
      
      // 等待速率控制器允许提交（仅在非阻塞状态下）
      await challengeSubmissionRateLimiter.waitForNextSubmission();
    }
    
    // 继续请求
    await route.continue();
  });
  
  // ⚠️ 在 headless 模式下，注入脚本隐藏 webdriver 特征
  // ⚠️ 将随机值注入到 init script 中
  if (HEADLESS) {
    await page.addInitScript(({ 
    hwConcurrency, 
    devMemory, 
    screenWidth, 
    screenHeight 
  }) => {
    try {
      // 隐藏 webdriver 特征（必须在所有其他操作之前）
      if (navigator && typeof navigator === 'object') {
        try {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
          });
          // 删除 webdriver 属性
          delete navigator.webdriver;
        } catch (e) {
          // 忽略错误，可能属性已存在
        }
        
        // ⚠️ 覆盖 navigator.__proto__.webdriver
        if (navigator.__proto__) {
          try {
            delete navigator.__proto__.webdriver;
          } catch (e) {}
        }
      }
      
      // ⚠️ 覆盖 window.chrome 对象（更完整）
      if (typeof window !== 'undefined') {
        window.chrome = {
          runtime: {
            onConnect: undefined,
            onMessage: undefined,
          },
          loadTimes: function() {
            return {
              commitLoadTime: Date.now() / 1000 - Math.random() * 2,
              finishDocumentLoadTime: Date.now() / 1000 - Math.random() * 1.5,
              finishLoadTime: Date.now() / 1000 - Math.random() * 1,
              firstPaintAfterLoadTime: 0,
              firstPaintTime: Date.now() / 1000 - Math.random() * 1.8,
              navigationType: 'Other',
              npnNegotiatedProtocol: 'unknown',
              requestTime: Date.now() / 1000 - Math.random() * 3,
              startLoadTime: Date.now() / 1000 - Math.random() * 2.5,
              wasAlternateProtocolAvailable: false,
              wasFetchedViaSpdy: false,
              wasNpnNegotiated: false,
            };
          },
          csi: function() {
            return {
              startE: Date.now(),
              onloadT: Date.now(),
              pageT: Date.now() - Math.random() * 1000,
              tran: 15,
            };
          },
          app: {
            isInstalled: false,
            InstallState: {
              DISABLED: 'disabled',
              INSTALLED: 'installed',
              NOT_INSTALLED: 'not_installed',
            },
            RunningState: {
              CANNOT_RUN: 'cannot_run',
              READY_TO_RUN: 'ready_to_run',
              RUNNING: 'running',
            },
          },
        };
        
        // ⚠️ 添加 window.chrome.runtime.connect 和 sendMessage
        if (!window.chrome.runtime.connect) {
          window.chrome.runtime.connect = function() {
            return {
              onMessage: { addListener: function() {}, removeListener: function() {} },
              postMessage: function() {},
              disconnect: function() {},
            };
          };
        }
        if (!window.chrome.runtime.sendMessage) {
          window.chrome.runtime.sendMessage = function() {};
        }
      }
      
      // ⚠️ 添加真实的 plugins（模拟 Chrome 插件）
      if (navigator && typeof navigator === 'object') {
        try {
          const pluginsArray = [
            {
              0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
              description: 'Portable Document Format',
              filename: 'internal-pdf-viewer',
              length: 1,
              name: 'Chrome PDF Plugin',
            },
            {
              0: { type: 'application/pdf', suffixes: 'pdf', description: '' },
              description: '',
              filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
              length: 1,
              name: 'Chrome PDF Viewer',
            },
            {
              0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
              1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
              description: '',
              filename: 'internal-nacl-plugin',
              length: 2,
              name: 'Native Client',
            },
          ];
          
          Object.defineProperty(navigator, 'plugins', {
            get: () => pluginsArray,
            configurable: true,
          });
        } catch (e) {
          // 忽略错误
        }
      }
      
      // ⚠️ 添加真实的 languages
      if (navigator && typeof navigator === 'object') {
        try {
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en', 'zh-CN', 'zh'],
            configurable: true,
          });
          Object.defineProperty(navigator, 'language', {
            get: () => 'en-US',
            configurable: true,
          });
        } catch (e) {
          // 忽略错误
        }
      }
        
        // 覆盖 permissions
        if (navigator && navigator.permissions && typeof navigator.permissions.query === 'function') {
          try {
            const originalQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (parameters) => (
              parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
            );
          } catch (e) {
            // 忽略错误
          }
        }
        
        // 添加更多反检测措施
        // 覆盖 navigator.platform
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'platform', {
              get: () => 'Linux x86_64',
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // 覆盖 navigator.vendor
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'vendor', {
              get: () => 'Google Inc.',
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 navigator.hardwareConcurrency（使用随机值）
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'hardwareConcurrency', {
              get: () => hwConcurrency,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 navigator.deviceMemory（使用随机值）
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'deviceMemory', {
              get: () => devMemory,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 screen 对象（使用随机值）
        if (typeof window !== 'undefined' && window.screen) {
          try {
            Object.defineProperty(window.screen, 'width', {
              get: () => screenWidth,
              configurable: true,
            });
            Object.defineProperty(window.screen, 'height', {
              get: () => screenHeight,
              configurable: true,
            });
            Object.defineProperty(window.screen, 'availWidth', {
              get: () => screenWidth,
              configurable: true,
            });
            Object.defineProperty(window.screen, 'availHeight', {
              get: () => screenHeight - 40, // 减去任务栏高度
              configurable: true,
            });
            Object.defineProperty(window.screen, 'colorDepth', {
              get: () => 24,
              configurable: true,
            });
            Object.defineProperty(window.screen, 'pixelDepth', {
              get: () => 24,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // 覆盖 navigator.maxTouchPoints
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'maxTouchPoints', {
              get: () => 0,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 navigator.connection / navigator.networkInformation（如果存在）
        if (navigator && typeof navigator === 'object') {
          try {
            const connectionProps = {
              effectiveType: '4g',
              rtt: 50 + Math.floor(Math.random() * 50), // 50-100ms
              downlink: 8 + Math.random() * 4, // 8-12 Mbps
              saveData: false,
              onchange: null,
              addEventListener: function() {},
              removeEventListener: function() {},
              dispatchEvent: function() { return true; },
            };
            
            Object.defineProperty(navigator, 'connection', {
              get: () => connectionProps,
              configurable: true,
            });
            Object.defineProperty(navigator, 'networkInformation', {
              get: () => connectionProps,
              configurable: true,
            });
            Object.defineProperty(navigator, 'mozConnection', {
              get: () => connectionProps,
              configurable: true,
            });
            Object.defineProperty(navigator, 'webkitConnection', {
              get: () => connectionProps,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 Canvas 指纹（添加随机噪音）
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function() {
          const context = this.getContext('2d');
          if (context) {
            const imageData = context.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < imageData.data.length; i += 4) {
              // 添加微小的随机噪音（不会影响视觉效果）
              imageData.data[i] += Math.floor(Math.random() * 3) - 1;
            }
            context.putImageData(imageData, 0, 0);
          }
          return originalToDataURL.apply(this, arguments);
        };
        
        // ⚠️ 覆盖 WebGL 指纹
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) { // UNMASKED_VENDOR_WEBGL
            return 'Intel Inc.';
          }
          if (parameter === 37446) { // UNMASKED_RENDERER_WEBGL
            return 'Intel Iris OpenGL Engine';
          }
          return getParameter.apply(this, arguments);
        };
        
        // ⚠️ 覆盖 AudioContext 指纹（添加随机噪音）
        const originalCreateAnalyser = AudioContext.prototype.createAnalyser;
        AudioContext.prototype.createAnalyser = function() {
          const analyser = originalCreateAnalyser.apply(this, arguments);
          const originalGetFloatFrequencyData = analyser.getFloatFrequencyData;
          analyser.getFloatFrequencyData = function(array) {
            originalGetFloatFrequencyData.apply(this, arguments);
            // 添加微小的随机噪音
            for (let i = 0; i < array.length; i++) {
              array[i] += (Math.random() - 0.5) * 0.0001;
            }
          };
          return analyser;
        };
        
        // ⚠️ 覆盖 document.documentElement.webdriver
        if (document && document.documentElement && typeof document.documentElement === 'object') {
          try {
            Object.defineProperty(document.documentElement, 'webdriver', {
              get: () => undefined,
              configurable: true,
            });
            // 删除属性
            delete document.documentElement.webdriver;
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 window.navigator.webdriver（再次确保）
        if (navigator && navigator.__proto__) {
          try {
            delete navigator.__proto__.webdriver;
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 Notification.permission
        if (typeof Notification !== 'undefined') {
          try {
            Object.defineProperty(Notification, 'permission', {
              get: () => 'default',
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 Permissions API
        if (navigator && navigator.permissions && typeof navigator.permissions.query === 'function') {
          const originalQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = function(parameters) {
            if (parameters.name === 'notifications') {
              return Promise.resolve({ state: 'default' });
            }
            return originalQuery(parameters);
          };
        }
        
        // ⚠️ 模拟 localStorage 和 sessionStorage（真实浏览器通常有这些）
        if (typeof Storage !== 'undefined') {
          try {
            // 添加一些常见的localStorage项（模拟真实用户）
            if (typeof localStorage !== 'undefined') {
              try {
                localStorage.setItem('_ga', 'GA1.1.' + Math.random().toString(36).substring(2, 15));
                localStorage.setItem('_gid', 'GA1.1.' + Math.random().toString(36).substring(2, 15));
              } catch (e) {
                // 忽略localStorage错误（可能被禁用）
              }
            }
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 navigator.cookieEnabled
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'cookieEnabled', {
              get: () => true,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 navigator.doNotTrack
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'doNotTrack', {
              get: () => '1',
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 添加真实的 performance.timing 数据
        if (window.performance && window.performance.timing) {
          try {
            const now = Date.now();
            const timing = window.performance.timing;
            // 模拟真实的页面加载时间
            Object.defineProperty(timing, 'navigationStart', {
              get: () => now - 1000 - Math.random() * 500,
              configurable: true,
            });
            Object.defineProperty(timing, 'domContentLoadedEventEnd', {
              get: () => now - 500 - Math.random() * 300,
              configurable: true,
            });
            Object.defineProperty(timing, 'loadEventEnd', {
              get: () => now - 200 - Math.random() * 200,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
        
        // ⚠️ 覆盖 navigator.onLine
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'onLine', {
              get: () => true,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
      } catch (e) {
        // 忽略所有初始化脚本错误，避免影响页面加载
      }
    }, {
      hwConcurrency: randomHardwareConcurrency,
      devMemory: randomDeviceMemory,
      screenWidth: randomScreen.width,
      screenHeight: randomScreen.height,
    });
  } else {
    // ⚠️ 非 headless 模式下也添加增强的反检测（Vercel 可能在非 headless 模式下也检测）
    await page.addInitScript(({ 
      hwConcurrency, 
      devMemory, 
      screenWidth, 
      screenHeight 
    }) => {
      try {
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'webdriver', {
              get: () => undefined,
              configurable: true,
            });
            delete navigator.webdriver;
          } catch (e) {
            // 忽略错误
          }
        }
        
        if (typeof window !== 'undefined') {
          window.chrome = {
            runtime: {
              onConnect: undefined,
              onMessage: undefined,
            },
            loadTimes: function() {
              return {
                commitLoadTime: Date.now() / 1000 - Math.random() * 2,
                finishDocumentLoadTime: Date.now() / 1000 - Math.random() * 1.5,
                finishLoadTime: Date.now() / 1000 - Math.random() * 1,
                firstPaintAfterLoadTime: 0,
                firstPaintTime: Date.now() / 1000 - Math.random() * 1.8,
                navigationType: 'Other',
                npnNegotiatedProtocol: 'unknown',
                requestTime: Date.now() / 1000 - Math.random() * 3,
                startLoadTime: Date.now() / 1000 - Math.random() * 2.5,
                wasAlternateProtocolAvailable: false,
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: false,
              };
            },
            csi: function() {
              return {
                startE: Date.now(),
                onloadT: Date.now(),
                pageT: Date.now() - Math.random() * 1000,
                tran: 15,
              };
            },
            app: {
              isInstalled: false,
            },
          };
          
          if (!window.chrome.runtime.connect) {
            window.chrome.runtime.connect = function() {
              return {
                onMessage: { addListener: function() {}, removeListener: function() {} },
                postMessage: function() {},
                disconnect: function() {},
              };
            };
          }
        }
        
        // 添加硬件信息
        if (navigator && typeof navigator === 'object') {
          try {
            Object.defineProperty(navigator, 'hardwareConcurrency', {
              get: () => hwConcurrency,
              configurable: true,
            });
            Object.defineProperty(navigator, 'deviceMemory', {
              get: () => devMemory,
              configurable: true,
            });
          } catch (e) {
            // 忽略错误
          }
        }
      } catch (e) {
        // 忽略所有初始化脚本错误
      }
    }, {
      hwConcurrency: randomHardwareConcurrency,
      devMemory: randomDeviceMemory,
      screenWidth: randomScreen.width,
      screenHeight: randomScreen.height,
    });
  }
  // 打印浏览器控制台日志与错误（过滤掉非关键错误以减少日志噪音）
  page.on('console', (msg) => {
    try { 
      const text = msg.text();
      // 过滤掉以下非关键错误（不影响功能）：
      // - 字体相关的 CORS 错误
      // - 资源加载失败（ERR_FAILED, ERR_ABORTED）
      // - 非关键资源的加载错误
      const shouldIgnore = 
        text.includes('CORS policy') ||
        text.includes('font') ||
        text.includes('Access to font') ||
        text.includes('Failed to load resource') ||
        text.includes('net::ERR_FAILED') ||
        text.includes('net::ERR_ABORTED') ||
        /fonts\.gstatic\.com/.test(text) ||
        /\.woff2?/.test(text);
      
      if (!shouldIgnore) {
        console.log('[PAGE]', msg.type(), text); 
      }
    } catch {}
  });
  page.on('pageerror', (err) => {
    try { 
      const errMsg = String(err);
      // 过滤掉非关键错误
      const shouldIgnore = 
        errMsg.includes('CORS') ||
        errMsg.includes('font') ||
        errMsg.includes('Failed to load resource') ||
        errMsg.includes('net::ERR_FAILED') ||
        errMsg.includes('net::ERR_ABORTED') ||
        // ⚠️ 过滤掉429错误相关的页面错误（这些错误会在重试逻辑中处理，不需要重复显示）
        (errMsg.includes('429') && errMsg.includes('submitMiningSolution'));
      
      if (!shouldIgnore) {
        console.log('[PAGE][error]', errMsg); 
      }
    } catch {}
  });
  
  // 过滤掉非关键资源加载失败的错误（减少日志噪音）
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure();
    
    // 静默忽略以下资源的加载失败（不影响功能）：
    // 1. 字体文件
    // 2. 图片资源（.jpg, .png, .gif, .svg, .webp）
    // 3. 第三方统计/广告服务
    // 4. 其他非关键资源
    const shouldIgnore = 
      url.includes('fonts.gstatic.com') ||
      url.includes('.woff2') ||
      url.includes('.woff') ||
      url.includes('.ttf') ||
      url.includes('.eot') ||
      /\.(jpg|jpeg|png|gif|svg|webp|ico)$/i.test(url) ||
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('doubleclick') ||
      url.includes('googleadservices') ||
      url.includes('analytics') ||
      failure?.errorText === 'net::ERR_FAILED' || // 一般性的网络失败
      failure?.errorText === 'net::ERR_ABORTED';  // 被中止的请求
    
    if (shouldIgnore) {
      return; // 不输出日志
    }
    
    // 只记录关键资源的失败（如 API 调用失败）
    // console.warn(`[PAGE] Request failed: ${url} - ${failure?.errorText || 'unknown'}`);
  });
  
  // 监听 API 响应错误（特别是 403），但不阻止流程
  // API 403 错误可能是后台调用失败，不影响页面功能
  let api403Count = 0;
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    const request = response.request();
    const method = request.method();
    
    // ⚠️ 处理 /api/solution POST 请求的响应和重试
    if (url.includes('/api/solution') && method === 'POST') {
      const retryInfo = solutionRetryInfo.get(pageId);
      if (!retryInfo) {
        // 如果没有重试信息，说明这是第一次响应（没有重试），直接处理
        if (status === 200 || status === 201) {
          // ⚠️ 关键：请求成功后立即解除对 challenge 接口的阻塞
          challengeSubmissionRateLimiter.stopBlockingForSolution();
          if (scheduler && typeof scheduler.recordSubmitSolution === 'function') {
            scheduler.recordSubmitSolution(taskId);
          }
          console.log(`[API-SOLUTION] ✅ Solution submitted successfully (task: ${taskId}, page: ${pageId}) - challenge requests unblocked`);
        } else if (status === 403) {
          // 403错误：权限被拒绝，不应该重试，立即解除阻塞
          console.error(`[API-SOLUTION] ❌ Solution submit failed with 403 (task: ${taskId}, page: ${pageId}): Forbidden - access denied, likely account blocked. No retry.`);
          challengeSubmissionRateLimiter.stopBlockingForSolution();
        } else {
          // 其他错误（如400、429等），保持阻塞状态，等待重试逻辑处理
          // 重试逻辑会在成功或最终失败时解除阻塞
        }
        return;
      }
      
      // ⚠️ 防止重复处理：如果已经在处理中，跳过
      if (retryInfo.isProcessing) {
        return;
      }
      retryInfo.isProcessing = true;
      
      const maxRetryTime = 120000; // 2分钟（增加超时时间以支持更多重试次数）
      const elapsed = Date.now() - retryInfo.startTime;
      
      if (status === 200 || status === 201) {
        // ⚠️ 关键：请求成功后立即解除对 challenge 接口的阻塞
        challengeSubmissionRateLimiter.stopBlockingForSolution();
        
        // ⚠️ 记录submitSolution统计
        if (scheduler && typeof scheduler.recordSubmitSolution === 'function') {
          scheduler.recordSubmitSolution(taskId);
        }
        
        console.log(`[API-SOLUTION] ✅ Solution submitted successfully (task: ${taskId}, page: ${pageId}, retries: ${retryInfo.retryCount}) - challenge requests unblocked`);
        retryInfo.isProcessing = false;
        solutionRetryInfo.delete(pageId);
        challengeSubmissionRateLimiter.recordSuccess();
        return; // 已处理，不再继续执行后面的代码
      } else if (status === 400) {
        // 400错误：提交失败，solution可能已过期或无效
        // ⚠️ 400错误不应该无限重试，最多重试10次，然后放弃（已增加重试次数）
        const max400Retries = retryInfo.max400Retries || 10;
        const current400Retries = retryInfo.retryCount || 0;
        
        if (current400Retries >= max400Retries) {
          // 已达到最大重试次数，放弃
          console.error(`[API-SOLUTION] ❌ Solution submit failed with 400 after ${current400Retries} retries (task: ${taskId}, page: ${pageId}): Solution is likely invalid or expired, giving up`);
          retryInfo.isProcessing = false;
          challengeSubmissionRateLimiter.stopBlockingForSolution();
          solutionRetryInfo.delete(pageId);
          return;
        }
        
        console.error(`[API-SOLUTION] ❌ Solution submit failed with 400 (task: ${taskId}, page: ${pageId}, attempt: ${current400Retries + 1}/${max400Retries}): Bad Request - solution may be invalid or expired`);
        
        // 异步重试（不阻塞response监听器）
        (async () => {
          const retryLoop = async () => {
            const currentElapsed = Date.now() - retryInfo.startTime;
              if (currentElapsed >= maxRetryTime) {
              console.error(`[API-SOLUTION] ❌ Solution submit failed after ${retryInfo.retryCount} retries (task: ${taskId}, timeout: ${maxRetryTime/1000}s)`);
              retryInfo.isProcessing = false;
              challengeSubmissionRateLimiter.stopBlockingForSolution();
              solutionRetryInfo.delete(pageId);
              return;
            }
            
            // 检查400错误重试次数
            if (retryInfo.retryCount >= max400Retries) {
              console.error(`[API-SOLUTION] ❌ Solution submit failed with 400 after ${retryInfo.retryCount} retries (task: ${taskId}, page: ${pageId}): Solution is likely invalid or expired, giving up`);
              retryInfo.isProcessing = false;
              challengeSubmissionRateLimiter.stopBlockingForSolution();
              solutionRetryInfo.delete(pageId);
              return;
            }
            
            retryInfo.retryCount++;
            const remainingTime = maxRetryTime - currentElapsed;
            // ⚠️ 400错误使用更长的重试间隔（15秒），避免过于频繁
            const waitTime = Math.min(15000, remainingTime); // 15秒间隔
            console.log(`[API-SOLUTION] 🔄 Retrying solution submit in ${waitTime/1000}s (${retryInfo.retryCount}/${max400Retries} retries, ${Math.floor(remainingTime/1000)}s remaining)...`);
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // ⚠️ 检查页面状态
            if (isPageClosed(page)) {
              console.error(`[API-SOLUTION] ❌ Page closed during 400 retry, aborting solution submit (task: ${taskId}, page: ${pageId})`);
              retryInfo.isProcessing = false;
              challengeSubmissionRateLimiter.stopBlockingForSolution();
              solutionRetryInfo.delete(pageId);
              return;
            }
            
            try {
              // ⚠️ 使用安全页面操作
              const retryResponse = await safePageOperation(page, async () => {
                return await page.evaluate(async (reqData) => {
                  const response = await fetch(reqData.url, {
                    method: reqData.method,
                    headers: reqData.headers,
                    body: reqData.postData,
                  });
                  return { status: response.status, ok: response.ok };
                }, retryInfo.requestData);
              }, `Solution submit retry for 400 error (attempt ${retryInfo.retryCount})`);
              
              if (retryResponse.status === 200 || retryResponse.status === 201) {
                // ⚠️ 关键：重试成功后立即解除对 challenge 接口的阻塞
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                if (scheduler && typeof scheduler.recordSubmitSolution === 'function') {
                  scheduler.recordSubmitSolution(taskId);
                }
                console.log(`[API-SOLUTION] ✅ Solution submitted successfully after retry (task: ${taskId}, page: ${pageId}, retries: ${retryInfo.retryCount}) - challenge requests unblocked`);
                retryInfo.isProcessing = false;
                solutionRetryInfo.delete(pageId);
                challengeSubmissionRateLimiter.recordSuccess(); // 记录成功
                return; // 重试成功，退出
              } else if (retryResponse.status === 400) {
                // 400错误，继续重试（但不超过最大次数）
                // ⚠️ 不要重置startTime，保持原始时间窗口
                await retryLoop();
              } else if (retryResponse.status === 403) {
                // 403错误：权限被拒绝，不应该重试
                console.error(`[API-SOLUTION] ❌ Solution submit failed with 403 (task: ${taskId}, page: ${pageId}, retries: ${retryInfo.retryCount}): Forbidden - access denied, likely account blocked. Giving up immediately.`);
                retryInfo.isProcessing = false;
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                solutionRetryInfo.delete(pageId);
                return;
              } else if (retryResponse.status === 429) {
                // 429错误，切换到429处理逻辑
                retryInfo.last429Time = Date.now();
                challengeSubmissionRateLimiter.record429Error();
                // 继续重试，但使用429的降频逻辑
                await retryLoop();
              } else {
                console.error(`[API-SOLUTION] ⚠️ Solution submit failed with status ${retryResponse.status} (task: ${taskId}, page: ${pageId}, retries: ${retryInfo.retryCount}): Unknown error, giving up`);
                retryInfo.isProcessing = false;
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                solutionRetryInfo.delete(pageId);
              }
            } catch (error) {
              console.error(`[API-SOLUTION] ❌ Retry request error (page: ${pageId}): ${error.message}`);
              const errorElapsed = Date.now() - retryInfo.startTime;
              if (errorElapsed >= maxRetryTime) {
                console.error(`[API-SOLUTION] ❌ Solution submit failed after ${retryInfo.retryCount} retries (task: ${taskId}, timeout: ${maxRetryTime/1000}s)`);
                retryInfo.isProcessing = false;
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                solutionRetryInfo.delete(pageId);
              } else if (retryInfo.retryCount >= max400Retries) {
                console.error(`[API-SOLUTION] ❌ Solution submit failed with 400 after ${retryInfo.retryCount} retries (page: ${pageId}): Giving up`);
                retryInfo.isProcessing = false;
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                solutionRetryInfo.delete(pageId);
              } else {
                await retryLoop();
              }
            }
          };
          await retryLoop();
        })();
      } else if (status === 429) {
        // 429错误：速率限制，需要重试并自适应降频
        console.error(`[API-SOLUTION] ⚠️ Solution submit failed with 429 (task: ${taskId}, page: ${pageId}, attempt: ${retryInfo.retryCount + 1}): Rate Limit - too many requests`);
        
        // ⚠️ 自适应降频：如果出现429，增加重试间隔
        const now = Date.now();
        if (retryInfo.last429Time && (now - retryInfo.last429Time) < 10000) {
          // 如果10秒内再次出现429，增加重试间隔
          retryInfo.currentRetryInterval = Math.min(retryInfo.currentRetryInterval * 1.5, 30000); // 最多30秒
          console.log(`[API-SOLUTION] 📉 Adaptive rate reduction: increasing retry interval to ${retryInfo.currentRetryInterval/1000}s due to consecutive 429 errors`);
        } else {
          // 第一次429，稍微增加间隔
          retryInfo.currentRetryInterval = Math.min(retryInfo.currentRetryInterval * 1.2, 20000); // 最多20秒
          console.log(`[API-SOLUTION] 📉 Adaptive rate reduction: increasing retry interval to ${retryInfo.currentRetryInterval/1000}s due to 429 error`);
        }
        retryInfo.last429Time = now;
        
        // 记录429错误到rate limiter
        challengeSubmissionRateLimiter.record429Error();
        
        // 异步重试（不阻塞response监听器）
        (async () => {
          const retryLoop = async () => {
            const currentElapsed = Date.now() - retryInfo.startTime;
            if (currentElapsed >= maxRetryTime) {
              console.error(`[API-SOLUTION] ❌ Solution submit failed after ${retryInfo.retryCount} retries (task: ${taskId}, timeout: ${maxRetryTime/1000}s, last error: 429)`);
              challengeSubmissionRateLimiter.stopBlockingForSolution();
              solutionRetryInfo.delete(pageId);
              return;
            }
            
            retryInfo.retryCount++;
            const remainingTime = maxRetryTime - currentElapsed;
            const waitTime = Math.min(retryInfo.currentRetryInterval, remainingTime);
            console.log(`[API-SOLUTION] 🔄 Retrying solution submit in ${waitTime/1000}s (${retryInfo.retryCount} retries, ${Math.floor(remainingTime/1000)}s remaining, adaptive interval: ${retryInfo.currentRetryInterval/1000}s)...`);
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // ⚠️ 检查页面状态
            if (isPageClosed(page)) {
              console.error(`[API-SOLUTION] ❌ Page closed during 429 retry, aborting solution submit (task: ${taskId}, page: ${pageId})`);
              retryInfo.isProcessing = false;
              challengeSubmissionRateLimiter.stopBlockingForSolution();
              solutionRetryInfo.delete(pageId);
              return;
            }
            
            try {
              // ⚠️ 使用安全页面操作
              // ⚠️ 注意：重试请求通过 page.evaluate 直接发送，不受 route 拦截器控制
              // 但重试时仍然需要保持阻塞 challenge 请求，直到成功或失败
              const retryResponse = await safePageOperation(page, async () => {
                return await page.evaluate(async (reqData) => {
                  const response = await fetch(reqData.url, {
                    method: reqData.method,
                    headers: reqData.headers,
                    body: reqData.postData,
                  });
                  return { status: response.status, ok: response.ok };
                }, retryInfo.requestData);
              }, `Solution submit retry for 429 error (attempt ${retryInfo.retryCount})`);
              
              if (retryResponse.status === 200 || retryResponse.status === 201) {
                // ⚠️ 关键：重试成功后立即解除对 challenge 接口的阻塞
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                if (scheduler && typeof scheduler.recordSubmitSolution === 'function') {
                  scheduler.recordSubmitSolution(taskId);
                }
                console.log(`[API-SOLUTION] ✅ Solution submitted successfully after retry (task: ${taskId}, page: ${pageId}, retries: ${retryInfo.retryCount}) - challenge requests unblocked`);
                retryInfo.isProcessing = false;
                solutionRetryInfo.delete(pageId);
                challengeSubmissionRateLimiter.recordSuccess(); // 记录成功
                return; // 重试成功，退出
              } else if (retryResponse.status === 429) {
                // 429错误，继续自适应降频并重试
                const now = Date.now();
                if (retryInfo.last429Time && (now - retryInfo.last429Time) < 10000) {
                  retryInfo.currentRetryInterval = Math.min(retryInfo.currentRetryInterval * 1.5, 30000);
                  console.log(`[API-SOLUTION] 📉 Adaptive rate reduction: increasing retry interval to ${retryInfo.currentRetryInterval/1000}s due to consecutive 429 errors`);
                } else {
                  retryInfo.currentRetryInterval = Math.min(retryInfo.currentRetryInterval * 1.2, 20000);
                  console.log(`[API-SOLUTION] 📉 Adaptive rate reduction: increasing retry interval to ${retryInfo.currentRetryInterval/1000}s due to 429 error`);
                }
                retryInfo.last429Time = now;
                challengeSubmissionRateLimiter.record429Error();
                // ⚠️ 不要重置startTime，保持原始时间窗口
                await retryLoop();
              } else if (retryResponse.status === 400) {
                // 400错误，检查是否超过最大重试次数（已增加重试次数）
                const max400Retries = retryInfo.max400Retries || 10;
                if (retryInfo.retryCount >= max400Retries) {
                  console.error(`[API-SOLUTION] ❌ Solution submit failed with 400 after ${retryInfo.retryCount} retries (task: ${taskId}, page: ${pageId}): Solution is likely invalid or expired, giving up`);
                  retryInfo.isProcessing = false;
                  challengeSubmissionRateLimiter.stopBlockingForSolution();
                  solutionRetryInfo.delete(pageId);
                  return;
                }
                // ⚠️ 不要重置startTime，保持原始时间窗口
                await retryLoop();
              } else if (retryResponse.status === 403) {
                // 403错误：权限被拒绝，不应该重试
                console.error(`[API-SOLUTION] ❌ Solution submit failed with 403 (task: ${taskId}, page: ${pageId}, retries: ${retryInfo.retryCount}): Forbidden - access denied, likely account blocked. Giving up immediately.`);
                retryInfo.isProcessing = false;
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                solutionRetryInfo.delete(pageId);
                return;
              } else {
                console.error(`[API-SOLUTION] ⚠️ Solution submit failed with status ${retryResponse.status} (task: ${taskId}, page: ${pageId}, retries: ${retryInfo.retryCount}): Unknown error, giving up`);
                retryInfo.isProcessing = false;
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                solutionRetryInfo.delete(pageId);
              }
            } catch (error) {
              console.error(`[API-SOLUTION] ❌ Retry request error (page: ${pageId}): ${error.message}`);
              const errorElapsed = Date.now() - retryInfo.startTime;
              if (errorElapsed >= maxRetryTime) {
                console.error(`[API-SOLUTION] ❌ Solution submit failed after ${retryInfo.retryCount} retries (task: ${taskId}, timeout: ${maxRetryTime/1000}s, last error: 429)`);
                retryInfo.isProcessing = false;
                challengeSubmissionRateLimiter.stopBlockingForSolution();
                solutionRetryInfo.delete(pageId);
              } else {
                await retryLoop();
              }
            }
          };
          await retryLoop();
        })();
      } else if (status === 403) {
        // 403错误：权限被拒绝，通常表示账户被封禁或权限问题
        // ⚠️ 403错误不应该重试，直接放弃
        console.error(`[API-SOLUTION] ❌ Solution submit failed with 403 (task: ${taskId}, page: ${pageId}): Forbidden - access denied, likely account blocked or permission issue. Giving up immediately.`);
        retryInfo.isProcessing = false;
        challengeSubmissionRateLimiter.stopBlockingForSolution();
        solutionRetryInfo.delete(pageId);
      } else {
        // 其他错误（如500等）
        console.error(`[API-SOLUTION] ⚠️ Solution submit failed with status ${status} (task: ${taskId}, page: ${pageId}, attempt: ${retryInfo.retryCount + 1}): Unknown error, giving up`);
        retryInfo.isProcessing = false;
        challengeSubmissionRateLimiter.stopBlockingForSolution();
        solutionRetryInfo.delete(pageId);
      }
      return; // 已处理，不再继续
    }
    
    if (status === 403) {
      api403Count++;
      // 只在第一次或每10次时记录，避免日志过多
      if (api403Count === 1 || api403Count % 10 === 0) {
        console.warn(`[API-403] 403 Forbidden detected on: ${url} (count: ${api403Count}, this may be normal for API calls)`);
      }
    } else if (status === 429) {
      console.warn(`[API-429] Rate limit detected on: ${url}`);
      
      // ⚠️ 如果是challenge提交相关的API（/api/solution或/api/challenge），通知challenge提交速率控制器
      if (url.includes('/api/solution') || url.includes('/api/challenge')) {
        challengeSubmissionRateLimiter.record429Error();
        console.warn(`[CHALLENGE-RATE-LIMITER] ⚠️ Challenge submission 429 error detected, rate limiter will slow down`);
      }
    } else if (status === 200 || status === 201) {
      // ⚠️ 如果是challenge提交相关的API成功响应，记录成功
      if (url.includes('/api/solution') || url.includes('/api/challenge')) {
        challengeSubmissionRateLimiter.recordSuccess();
      }
    }
  });

  // 后台监控：定期检查速率限制错误和 429 错误页面，防止任务卡死
  let rateLimitMonitorInterval = null;
  let rateLimitErrorDetected = false;
  
  const startRateLimitMonitor = () => {
    if (rateLimitMonitorInterval) return; // 已经启动
    
    rateLimitMonitorInterval = setInterval(async () => {
      try {
        // 只在检测到 429 错误页面时才处理（其他错误页面在主流程中处理）
        const errorPageCheck = await checkIfErrorPage(page);
        if (errorPageCheck.isErrorPage && errorPageCheck.errorCode === '429') {
          console.warn(`[429-MONITOR] Background monitor detected 429 error page: ${errorPageCheck.url}`);
          console.warn(`[429-MONITOR] Attempting automatic recovery via disconnect...`);
          // 尝试自动恢复（但不阻塞主流程）
          handleErrorPage(page, BASE_URL).catch(err => {
            console.warn(`[429-MONITOR] Auto-recovery failed: ${err.message}`);
          });
          return;
        }
        
        // 检查速率限制错误
        const check = await checkPageForRateLimitError(page, 1);
        if (check.hasError && !rateLimitErrorDetected) {
          rateLimitErrorDetected = true;
          console.warn(`[RATE-LIMIT-MONITOR] Background monitor detected rate limit error: ${check.errorText}`);
          console.warn(`[RATE-LIMIT-MONITOR] Will wait for error to clear...`);
        } else if (!check.hasError && rateLimitErrorDetected) {
          rateLimitErrorDetected = false;
          console.log(`[RATE-LIMIT-MONITOR] Rate limit error cleared!`);
        }
      } catch (e) {
        // 忽略监控错误，不影响主流程
      }
    }, 5000); // 每5秒检查一次（减少频率）
  };
  
  const stopRateLimitMonitor = () => {
    if (rateLimitMonitorInterval) {
      clearInterval(rateLimitMonitorInterval);
      rateLimitMonitorInterval = null;
    }
  };

  try {
    page.setDefaultTimeout(20_000);

    // 启动后台监控
    startRateLimitMonitor();

    // ⚠️ 添加初始化超时检测（5分钟超时）
    const INIT_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟
    const initStartTime = Date.now();
    
    // 使用 Promise.race 来检测初始化超时
    const initPromise = (async () => {
      // 使用速率限制的页面导航（带重试）
      await gotoWithRateLimit(page, BASE_URL, { waitUntil: 'domcontentloaded' });
    })();
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        const elapsed = Date.now() - initStartTime;
        reject(new Error(`Initialization timeout after ${Math.floor(elapsed/1000)}s (${Math.floor(elapsed/60000)} minutes). Task may be stuck.`));
      }, INIT_TIMEOUT_MS);
    });
    
    await Promise.race([initPromise, timeoutPromise]);
    
    // 导航后检查页面错误（只检查页面显示的错误，不检查API错误）
    // 等待页面加载稳定后再检查
    await page.waitForTimeout(2000);
    
    // ⚠️ 优化：先检查是否已经导航到wallet页面，避免不必要的等待
    const currentUrl = page.url();
    if (currentUrl.includes('/wizard/wallet')) {
      console.log(`[VERCEL-CHECK] ℹ️  Already at wallet page (${currentUrl}), Vercel check likely passed, skipping...`);
    } else {
      // 首先检查是否是 Vercel security check 页面
      const vercelCheck = await checkIfVercelSecurityCheck(page);
      if (vercelCheck.isVercelCheck) {
        console.log(`[VERCEL-CHECK] ⚠️ Detected Vercel security check page: ${vercelCheck.url}`);
        // ⚠️ 优化：减少Vercel检查等待时间（从60秒减少到30秒）
        console.log(`[VERCEL-CHECK]    Waiting up to 30s for security check to complete...`);
        const waitResult = await waitForVercelSecurityCheck(page, 30000);
        if (!waitResult.completed) {
          console.warn(`[VERCEL-CHECK] ⚠️ Security check timeout after 30s, will continue anyway...`);
        } else {
          console.log(`[VERCEL-CHECK] Security check completed, continuing...`);
        }
        // ⚠️ 优化：减少等待时间（从2秒减少到1秒）
        await page.waitForTimeout(1000);
      } else {
        console.log(`[VERCEL-CHECK] ℹ️  No Vercel check detected, page ready`);
      }
    }
    
    // 首先检查是否被重定向到错误页面（429或403需要 disconnect）
    const errorPageCheck = await checkIfErrorPage(page);
    if (errorPageCheck.isErrorPage && (errorPageCheck.errorCode === '429' || errorPageCheck.errorCode === '403')) {
      const errorType = errorPageCheck.errorCode;
      console.warn(`[${errorType}-ERROR] Detected ${errorType} error page after navigation: ${errorPageCheck.url}`);
      const handled = await handleErrorPage(page, BASE_URL);
      if (handled) {
        await page.waitForTimeout(2000);
        // 如果成功重置，可能需要从头开始，但先检查页面状态
        const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 3000 }).catch(() => false);
        if (isReset) {
          console.log(`[${errorType}-ERROR] Page reset successful, will continue from beginning...`);
        }
      }
    } else if (errorPageCheck.isErrorPage && errorPageCheck.errorCode === 'other') {
      // 其他错误页面：直接导航回去，不使用 disconnect
      console.warn(`[ERROR-PAGE] Detected non-429 error page after navigation: ${errorPageCheck.url}, navigating back...`);
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      } catch (e) {
        console.warn(`[ERROR-PAGE] Failed to navigate back: ${e.message}`);
      }
    }
    
    const postNavCheck = await checkPageForRateLimitError(page);
    if (postNavCheck.hasError) {
      console.warn(`[RATE-LIMIT] Rate limit error message detected after navigation: ${postNavCheck.errorText}`);
      console.log(`[RATE-LIMIT] Waiting for error message to clear (max 30s)...`);
      const cleared = await waitForRateLimitErrorToClear(page, 30000, 3000, BASE_URL);
      if (!cleared) {
        // 如果等待后仍有错误，检查是否在 429 错误页面（只有 429 才需要 disconnect）
        const finalErrorPageCheck = await checkIfErrorPage(page);
        if (finalErrorPageCheck.isErrorPage && finalErrorPageCheck.errorCode === '429') {
          console.log(`[429-ERROR] Still on 429 error page after waiting, attempting recovery via disconnect...`);
          const handled = await handleErrorPage(page, BASE_URL);
          if (handled) {
            await page.waitForTimeout(2000);
            // 检查是否重置成功，如果成功可能需要从头开始
            const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 3000 }).catch(() => false);
            if (isReset) {
              console.log('[429-ERROR] Page reset successful, will retry from beginning...');
              // 重置成功，抛出特殊错误让外部重试机制从头开始
              throw new Error('429 error page reset successful, retry from beginning');
            }
          }
        } else if (finalErrorPageCheck.isErrorPage && finalErrorPageCheck.errorCode === 'other') {
          // 其他错误页面：直接导航回去
          console.warn(`[ERROR-PAGE] Still on non-429 error page (${finalErrorPageCheck.url}), navigating back...`);
          try {
            await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);
          } catch (e) {
            console.warn(`[ERROR-PAGE] Failed to navigate back: ${e.message}`);
          }
        } else {
          // 尝试刷新页面一次
          console.log(`[RATE-LIMIT] Error message persists, refreshing page once...`);
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
            
            // 刷新后检查是否跳转到错误页面
            const afterRefreshErrorCheck = await checkIfErrorPage(page);
            if (afterRefreshErrorCheck.isErrorPage && afterRefreshErrorCheck.errorCode === '429') {
              await handleErrorPage(page, BASE_URL);
              await page.waitForTimeout(2000);
            }
            
            const afterReloadCheck = await checkPageForRateLimitError(page);
            if (afterReloadCheck.hasError) {
              // 即使刷新后还有错误，也继续执行，因为可能是暂时的或API错误
              console.warn(`[RATE-LIMIT] Error message persists after refresh, but continuing anyway...`);
            }
          } catch (reloadError) {
            console.warn(`[RATE-LIMIT] Failed to refresh: ${reloadError.message}, continuing...`);
          }
        }
      }
    }

    // ⚠️ 在点击按钮前，先检查是否已经在 wallet 页面（可能由于之前的状态）
    const urlBeforeClick = page.url();
    if (urlBeforeClick.includes('/wizard/wallet')) {
      // ⚠️ 减少日志：不输出钱包页面检测（关键错误会保留）
      // console.log(`[WALLET-PAGE] Page is already at wallet page (${urlBeforeClick}) before clicking button, will handle in retry function`);
    }

    // 点击 Enter an address manually（带重试）
    await retryWithBackoff(
      async () => {
        // ⚠️ 在执行操作前检查当前页面URL，如果在 wallet 页面需要特殊处理
        const currentUrlCheck = page.url();
        if (currentUrlCheck.includes('/wizard/wallet')) {
          // ⚠️ 减少日志：不输出钱包页面检测
          // console.log(`[WALLET-PAGE] Detected wallet page at start of retry (${currentUrlCheck})`);
        }
        
        // 在执行操作前检查是否在 429 错误页面（只有 429 才需要 disconnect）
        const preErrorCheck = await checkIfErrorPage(page);
        if (preErrorCheck.isErrorPage && preErrorCheck.errorCode === '429') {
          console.warn(`[429-ERROR] Detected 429 error page before clicking button, attempting recovery via disconnect...`);
          const handled = await handleErrorPage(page, BASE_URL);
          if (!handled) {
            throw new Error(`429 error page detected and recovery failed: ${preErrorCheck.url}`);
          }
          await page.waitForTimeout(2000);
          // 恢复成功后，确保页面已重置
          const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 5000 }).catch(() => false);
          if (!isReset) {
            throw new Error('429 error page recovery attempted but not in initial state');
          }
          // 页面已重置到初始状态，可以继续执行（从头开始流程）
          console.log('[429-ERROR] Page reset successful, continuing from initial state...');
          // 不需要抛出错误，直接继续执行后续步骤
        } else if (preErrorCheck.isErrorPage && preErrorCheck.errorCode === 'other') {
          // 其他错误页面：直接导航回去
          console.warn(`[ERROR-PAGE] Detected non-429 error page before clicking button, navigating back...`);
          try {
            await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);
          } catch (e) {
            console.warn(`[ERROR-PAGE] Failed to navigate back: ${e.message}`);
          }
        }
        
        // 在执行操作前检查是否有速率限制错误
        const preCheck = await checkPageForRateLimitError(page);
        if (preCheck.hasError) {
          throw new Error(`Rate limit error detected before clicking button: ${preCheck.errorText}`);
        }
        
        // ⚠️ 优化：减少等待时间
        // 等待页面稳定后再操作（避免用户交互干扰）
        await waitForPageStable(page, 1000); // 减少到1秒
        
        // ⚠️ 用户要求：无论URL是什么，如果页面出现"Choose a Destination address"就填写地址继续下一步
        // 先检查页面内容，不依赖URL
        const pageContent = await page.evaluate(() => {
          return (document.body?.innerText || '').toLowerCase();
        }).catch(() => '');
        
        const hasChooseDestination = /choose.*destination.*address/i.test(pageContent);
        const hasEnterAddressManually = /enter.*address.*manually/i.test(pageContent);
        
        // ⚠️ 检查地址输入框是否已经可见（避免重复点击按钮）
        let addressInputVisible = false;
        try {
          const inputCheck1 = page.getByPlaceholder('Enter address');
          addressInputVisible = await inputCheck1.first().isVisible({ timeout: 1000 }).catch(() => false);
          if (!addressInputVisible) {
            const textboxes = page.locator('input[type="text"], input:not([type]), textarea');
            const count = await textboxes.count();
            for (let i = 0; i < Math.min(count, 5); i++) {
              const tb = textboxes.nth(i);
              if (await tb.isVisible({ timeout: 500 }).catch(() => false)) {
                const placeholder = await tb.getAttribute('placeholder').catch(() => '');
                const ariaLabel = await tb.getAttribute('aria-label').catch(() => '');
                if (placeholder && /address/i.test(placeholder) || ariaLabel && /address/i.test(ariaLabel)) {
                  addressInputVisible = true;
                  break;
                }
              }
            }
          }
        } catch (e) {
          // 忽略错误，继续检查
        }
        
        // ⚠️ 如果页面显示"Choose a Destination address"，无论输入框是否可见，都必须点击"Enter an address manually"按钮
        // ⚠️ 用户反馈：页面在 /wizard/wallet 或 /wizard/mine 卡在了"Choose a Destination address"子页面，没有点击"Enter an address"
        const currentUrl = page.url();
        const isWalletPage = currentUrl.includes('/wizard/wallet');
        const isMinePage = currentUrl.includes('/wizard/mine');
        const needsButtonClick = hasChooseDestination || isWalletPage || isMinePage || hasEnterAddressManually;
        
        // ⚠️ 如果地址输入框已经可见，跳过点击按钮的步骤（无论是否检测到"Choose a Destination address"）
        // ⚠️ 如果检测到"Choose a Destination address"但输入框已可见，说明页面已经显示输入框，不需要点击按钮
        if (addressInputVisible) {
          if (hasChooseDestination) {
            // ⚠️ 减少日志：不输出地址输入框已可见（关键错误会保留）
            // console.log(`[WALLET-PAGE] ✓ "Choose a Destination address" detected and address input already visible, skipping button click`);
          } else {
            // console.log(`[WALLET-PAGE] ✓ Address input already visible, skipping button click`);
          }
          // 跳过按钮点击，直接进入填写地址的步骤
        } else {
          // ⚠️ 如果页面显示"Choose a Destination address"，或者输入框不可见，或者是在 wallet/mine 页面，都需要点击按钮
          if (hasChooseDestination) {
            // ⚠️ 减少日志：不输出按钮点击提示（关键错误会保留）
            // console.log(`[WALLET-PAGE] ⚠️ Page shows "Choose a Destination address", will click "Enter an address manually" button to proceed`);
          } else if (!addressInputVisible) {
            // ⚠️ 减少日志：不输出地址输入框不可见提示
            // console.log(`[WALLET-PAGE] ⚠️ Address input not visible, will click button to show input`);
          } else if (isWalletPage || isMinePage) {
            // ⚠️ 减少日志：不输出页面类型检测
            // console.log(`[WALLET-PAGE] ⚠️ On ${isWalletPage ? 'wallet' : 'mine'} page, will click button to ensure input is shown`);
          }
          
          if (needsButtonClick) {
            // ⚠️ 减少日志：不输出按钮检查（关键错误会保留）
            // console.log(`[WALLET-PAGE] Detected wallet page or "Enter an address manually" text (${currentUrl}), checking for button...`);
            
            // 尝试多种方式找到按钮
            let btn = null;
            let btnFound = false;
            
            // 方法1: 精确文本匹配
            try {
              btn = page.getByText('Enter an address manually', { exact: true });
              btnFound = await btn.isVisible({ timeout: 3000 }).catch(() => false);
              if (btnFound) {
                // ⚠️ 减少日志：不输出按钮找到信息（关键错误会保留）
                // console.log(`[WALLET-PAGE] Found "Enter an address manually" button (exact match)`);
              }
            } catch (e) {
              // 继续尝试其他方法
            }
            
            // 方法2: 不区分大小写匹配
            if (!btnFound) {
              try {
                btn = page.getByText(/enter.*address.*manually/i);
                btnFound = await btn.first().isVisible({ timeout: 3000 }).catch(() => false);
                if (btnFound) {
                  // ⚠️ 减少日志：不输出按钮找到信息
                  // console.log(`[WALLET-PAGE] Found "Enter an address manually" button (case-insensitive)`);
                  btn = btn.first();
                }
              } catch (e) {
                // 继续尝试其他方法
              }
            }
            
            // 方法3: 查找包含 "manually" 的按钮
            if (!btnFound) {
              try {
                const buttons = page.locator('button').filter({ hasText: /manually/i });
                const count = await buttons.count();
                if (count > 0) {
                  btn = buttons.first();
                  btnFound = await btn.isVisible({ timeout: 3000 }).catch(() => false);
                  if (btnFound) {
                    // ⚠️ 减少日志：不输出按钮找到信息
                    // console.log(`[WALLET-PAGE] Found button with "manually" text`);
                  }
                }
              } catch (e) {
                // 继续尝试其他方法
              }
            }
            
            // 方法4: 查找所有可见按钮，找到包含 "address" 和 "enter" 的
            if (!btnFound) {
              try {
                const allButtons = page.locator('button');
                const count = await allButtons.count();
                for (let i = 0; i < Math.min(count, 50); i++) {
                  const button = allButtons.nth(i);
                  const isVisible = await button.isVisible({ timeout: 500 }).catch(() => false);
                  if (isVisible) {
                    const text = await button.textContent().catch(() => '');
                    if (text && /enter.*address.*manually/i.test(text.trim())) {
                      btn = button;
                      btnFound = true;
                      // ⚠️ 减少日志：不输出按钮找到信息
                      // console.log(`[WALLET-PAGE] Found button by scanning: "${text.trim()}"`);
                      break;
                    }
                  }
                }
              } catch (e) {
                // 继续尝试默认方法
              }
            }
            
            // 方法5: 使用 CSS 选择器直接查找（基于用户提供的 HTML 结构）
            if (!btnFound) {
              try {
                // 查找包含 "Enter an address manually" 文本的按钮
                const btnBySelector = page.locator('button:has-text("Enter an address manually")');
                const count = await btnBySelector.count();
                if (count > 0) {
                  for (let i = 0; i < count; i++) {
                    const button = btnBySelector.nth(i);
                    const isVisible = await button.isVisible({ timeout: 1000 }).catch(() => false);
                    if (isVisible) {
                      const text = await button.textContent().catch(() => '');
                      if (text && text.trim() === 'Enter an address manually') {
                        btn = button;
                        btnFound = true;
                        // ⚠️ 减少日志：不输出按钮找到信息
                        // console.log(`[WALLET-PAGE] Found button by CSS selector: "${text.trim()}"`);
                        break;
                      }
                    }
                  }
                }
              } catch (e) {
                console.warn(`[WALLET-PAGE] Method 5 (CSS selector) failed: ${e.message}`);
              }
            }
            
            // 方法6: 使用 page.evaluate 直接在页面中查找并点击按钮
            if (!btnFound) {
              try {
                const clicked = await page.evaluate(() => {
                  const buttons = Array.from(document.querySelectorAll('button'));
                  for (const btn of buttons) {
                    const text = (btn.textContent || '').trim();
                    if (text.toLowerCase() === 'enter an address manually' || 
                        /^enter\s+an\s+address\s+manually$/i.test(text)) {
                      // 检查按钮是否可见且可点击
                      const rect = btn.getBoundingClientRect();
                      const style = window.getComputedStyle(btn);
                      const isVisible = rect.width > 0 && rect.height > 0 && 
                                       style.visibility !== 'hidden' &&
                                       style.display !== 'none' &&
                                       !btn.disabled;
                      if (isVisible) {
                        // 滚动到按钮位置
                        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // 直接点击按钮
                        btn.click();
                        return { clicked: true, text: text };
                      }
                    }
                  }
                  return { clicked: false };
                }).catch(() => ({ clicked: false }));
                
                if (clicked.clicked) {
                  btnFound = true;
                  // 标记为已点击，避免后续重复点击
                  btn = { clicked: true };
                  // ⚠️ 减少日志：不输出按钮点击成功信息
                  // console.log(`[WALLET-PAGE] Found and clicked button by page.evaluate: "${clicked.text}"`);
                  // 等待页面响应
                  await page.waitForTimeout(1000);
                }
              } catch (e) {
                console.warn(`[WALLET-PAGE] Method 6 (page.evaluate) failed: ${e.message}`);
              }
            }
            
            // 方法7: 如果检测到"Choose a Destination address"但找不到"Enter an address manually"按钮，
            // 尝试多种方式处理：1) 直接查找输入框 2) 查找替代按钮 3) 查找所有可点击元素
            if (!btnFound && hasChooseDestination) {
              console.log(`[WALLET-PAGE] ⚠️ "Choose a Destination address" detected but "Enter an address manually" button not found, trying multiple approaches...`);
              await page.waitForTimeout(1000); // ⚠️ 优化：减少等待时间到1秒
              
              // 策略1: 尝试查找地址输入框（可能已经可见）
              const directInputCheck = await page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea, input[type="search"]'));
                for (const input of inputs) {
                  const rect = input.getBoundingClientRect();
                  const style = window.getComputedStyle(input);
                  const isVisible = rect.width > 0 && rect.height > 0 && 
                                   style.display !== 'none' && 
                                   style.visibility !== 'hidden' &&
                                   style.opacity !== '0';
                  if (isVisible) {
                    const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
                    const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
                    const name = (input.getAttribute('name') || '').toLowerCase();
                    const id = (input.getAttribute('id') || '').toLowerCase();
                    if (/address/.test(placeholder) || /address/.test(ariaLabel) || /address/.test(name) || /address/.test(id)) {
                      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      input.focus();
                      return { found: true, placeholder: input.getAttribute('placeholder') || '', id: id };
                    }
                  }
                }
                // 也检查隐藏的输入框（可能只需要focus就能显示）
                for (const input of inputs) {
                  const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
                  const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
                  const name = (input.getAttribute('name') || '').toLowerCase();
                  if (/address/.test(placeholder) || /address/.test(ariaLabel) || /address/.test(name)) {
                    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    input.focus();
                    input.click();
                    return { found: true, placeholder: input.getAttribute('placeholder') || '', hidden: true };
                  }
                }
                return { found: false };
              }).catch(() => ({ found: false }));
              
              if (directInputCheck.found) {
                // ⚠️ 减少日志：不输出地址输入框找到信息
                // console.log(`[WALLET-PAGE] ✓ Found address input directly on "Choose a Destination address" page (placeholder: ${directInputCheck.placeholder || 'N/A'}, hidden: ${directInputCheck.hidden || false})`);
                addressInputVisible = true; // 标记输入框已可见，跳过按钮点击逻辑
                btnFound = false; // 不标记为已找到按钮，这样后续会直接填写地址
                await page.waitForTimeout(1000); // 等待输入框显示
              } else {
                // 策略2: 尝试查找所有可能的可点击元素（按钮、链接、div等）
                const allClickableElements = await page.evaluate(() => {
                  const selectors = ['button', 'a', '[role="button"]', '[onclick]', '[tabindex="0"]', 'div[class*="button"]', 'div[class*="click"]'];
                  const candidates = [];
                  for (const selector of selectors) {
                    const elements = Array.from(document.querySelectorAll(selector));
                    for (const el of elements) {
                      const text = (el.textContent || '').trim().toLowerCase();
                      const rect = el.getBoundingClientRect();
                      const style = window.getComputedStyle(el);
                      const isVisible = rect.width > 0 && rect.height > 0 && 
                                       style.display !== 'none' && 
                                       style.visibility !== 'hidden' &&
                                       style.opacity !== '0' &&
                                       !el.disabled;
                      if (isVisible && text.length > 0) {
                        // 查找包含关键词的元素
                        const keywords = ['manual', 'type', 'enter', 'address', 'continue', 'next', 'proceed', 'input', 'fill'];
                        if (keywords.some(keyword => text.includes(keyword))) {
                          candidates.push({ text: (el.textContent || '').trim(), element: el });
                        }
                      }
                    }
                  }
                  return candidates.map(c => c.text);
                }).catch(() => []);
                
                if (allClickableElements.length > 0) {
                  console.log(`[WALLET-PAGE] Found ${allClickableElements.length} potential clickable elements: ${allClickableElements.slice(0, 5).join(', ')}`);
                  // 优先尝试包含 "manual" 或 "enter" 的元素
                  const preferredText = allClickableElements.find(t => /manual|enter|type/i.test(t)) || allClickableElements[0];
                  console.log(`[WALLET-PAGE] Trying to click element with text: "${preferredText}"`);
                  try {
                    const elementToClick = page.getByText(new RegExp(preferredText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
                    if (await elementToClick.first().isVisible({ timeout: 2000 }).catch(() => false)) {
                      await safeClick(page, elementToClick.first(), { timeout: 10000, force: true, retries: 3 });
                      btnFound = true;
                      await page.waitForTimeout(2000); // 等待输入框出现
                      console.log(`[WALLET-PAGE] ✓ Successfully clicked element: "${preferredText}"`);
                    }
                  } catch (e) {
                    console.warn(`[WALLET-PAGE] Failed to click element "${preferredText}": ${e.message}`);
                  }
                }
                
                // 策略3: 如果还是找不到，尝试直接通过 CSS 选择器查找输入框并尝试填写
                if (!btnFound && !addressInputVisible) {
                  console.log(`[WALLET-PAGE] ⚠️ No button found, trying to find and interact with input directly via CSS selectors...`);
                  try {
                    // 尝试多种可能的输入框选择器
                    const inputSelectors = [
                      'input[placeholder*="address" i]',
                      'input[placeholder*="Address" i]',
                      'input[name*="address" i]',
                      'input[id*="address" i]',
                      'textarea[placeholder*="address" i]',
                      'input[type="text"]',
                      'textarea'
                    ];
                    
                    for (const selector of inputSelectors) {
                      try {
                        const input = page.locator(selector).first();
                        const count = await page.locator(selector).count();
                        if (count > 0) {
                          console.log(`[WALLET-PAGE] Found ${count} input(s) with selector: ${selector}`);
                          // 尝试点击或focus输入框
                          await input.click({ timeout: 2000 }).catch(() => {});
                          await input.focus({ timeout: 2000 }).catch(() => {});
                          const isVisible = await input.isVisible({ timeout: 1000 }).catch(() => false);
                          if (isVisible) {
                            console.log(`[WALLET-PAGE] ✓ Input is visible with selector: ${selector}`);
                            addressInputVisible = true;
                            break;
                          }
                        }
                      } catch (e) {
                        // 继续尝试下一个选择器
                      }
                    }
                  } catch (e) {
                    console.warn(`[WALLET-PAGE] Failed to find input via CSS selectors: ${e.message}`);
                  }
                }
              }
            }
            
            if (btnFound && btn && !btn.clicked) {
              // 只有当btn是Playwright locator且未被点击时，才执行点击
              // ⚠️ 减少日志：不输出按钮点击提示（关键错误会保留）
              // console.log(`[WALLET-PAGE] Clicking "Enter an address manually" button on wallet page...`);
              await safeClick(page, btn, { timeout: 10000, force: true, retries: 3 });
            } else if (btnFound && btn && btn.clicked) {
              // 方法6已经点击了按钮，跳过点击步骤
              console.log(`[WALLET-PAGE] Button already clicked via page.evaluate, continuing...`);
            }
            
            // ⚠️ 无论用哪种方法点击了按钮，都需要等待输入框出现并继续流程
            // 如果输入框已经可见（通过方法7直接找到），跳过等待
            if (btnFound && !addressInputVisible) {
              // ⚠️ 用户要求：点击Enter an address manually后，应该等待输入框出现并继续流程
              // ⚠️ 优化：减少等待时间和重试次数
              // 等待输入框出现（最多等待5秒）
              let inputVisible = false;
              for (let waitAttempt = 0; waitAttempt < 5; waitAttempt++) { // 从10次减少到5次
                await page.waitForTimeout(300); // 从500ms减少到300ms
                try {
                  // 尝试多种方式查找输入框
                  const inputByPlaceholder = page.getByPlaceholder(/enter.*address/i);
                  inputVisible = await inputByPlaceholder.first().isVisible({ timeout: 1000 }).catch(() => false);
                  if (!inputVisible) {
                    // 尝试通过input type查找
                    const inputByType = page.locator('input[type="text"]');
                    const count = await inputByType.count();
                    for (let i = 0; i < count; i++) {
                      const input = inputByType.nth(i);
                      const isVisible = await input.isVisible({ timeout: 500 }).catch(() => false);
                      if (isVisible) {
                        const placeholder = await input.getAttribute('placeholder').catch(() => '');
                        if (placeholder && /address/i.test(placeholder)) {
                          inputVisible = true;
                          break;
                        }
                      }
                    }
                  }
                  if (inputVisible) {
                    // ⚠️ 减少日志：不输出地址输入框可见信息（关键错误会保留）
                    // console.log(`[WALLET-PAGE] ✓ Address input is now visible after clicking button`);
                    break;
                  }
                } catch (e) {
                  // 继续等待
                }
              }
              
              if (!inputVisible) {
                console.warn(`[WALLET-PAGE] ⚠️ Button clicked but address input not visible after waiting, will try to fill anyway...`);
                // 即使输入框不可见，也尝试填写（可能已经出现但检测不到）
                await page.waitForTimeout(1000);
              }
            } else {
              console.warn(`[WALLET-PAGE] "Enter an address manually" button not found on wallet/mine page, trying default method...`);
              // 如果找不到，尝试默认方法
              try {
                const defaultBtn = page.getByText('Enter an address manually', { exact: true });
                await safeClick(page, defaultBtn, { timeout: 10000, force: true, retries: 3 });
                // 等待输入框出现
                await page.waitForTimeout(2000);
                console.log(`[WALLET-PAGE] ✓ Successfully clicked "Enter an address manually" button using default method`);
              } catch (e) {
                console.warn(`[WALLET-PAGE] ⚠️ Failed to click button using default method: ${e.message}, but continuing...`);
                // 即使失败也继续，可能输入框已经可见
              }
            }
          } else {
            // 不在 wallet/mine 页面，但仍需要点击按钮（可能因为其他原因进入此分支）
            console.log(`[WALLET-PAGE] Attempting to find and click "Enter an address manually" button using default method...`);
            try {
              const btn = page.getByText('Enter an address manually', { exact: true });
              // 使用安全点击，确保即使有用户交互也能成功
              await safeClick(page, btn, { timeout: 10000, force: true, retries: 3 });
              // 等待输入框出现
              await page.waitForTimeout(2000);
              console.log(`[WALLET-PAGE] ✓ Successfully clicked "Enter an address manually" button using default method`);
            } catch (e) {
              console.warn(`[WALLET-PAGE] ⚠️ Failed to click button using default method: ${e.message}, but continuing...`);
              // 即使失败也继续，可能输入框已经可见
            }
          }
        }
        
        // ⚠️ 优化：减少等待时间
        // 点击后等待并检查错误
        await page.waitForTimeout(500); // 减少到0.5秒
        
        // 检查是否跳转到 429 错误页面（只有 429 才需要 disconnect）
        const postErrorCheck = await checkIfErrorPage(page);
        if (postErrorCheck.isErrorPage && postErrorCheck.errorCode === '429') {
          console.warn(`[429-ERROR] Detected 429 error page after clicking button, attempting recovery via disconnect...`);
          const handled = await handleErrorPage(page, BASE_URL);
          if (!handled) {
            throw new Error(`429 error page detected after click and recovery failed: ${postErrorCheck.url}`);
          }
          await page.waitForTimeout(2000);
          // 恢复成功后，检查页面是否重置
          const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 5000 }).catch(() => false);
          if (isReset) {
            console.log('[429-ERROR] Page reset successful after click, continuing from initial state...');
            // 页面已重置，继续执行（会重新点击 "Enter an address manually"）
            // 但此时按钮已存在，所以可以直接继续
          } else {
            throw new Error('429 error page detected after click, recovery attempted but page not in initial state');
          }
        } else if (postErrorCheck.isErrorPage && postErrorCheck.errorCode === 'other') {
          // 其他错误页面：直接导航回去
          console.warn(`[ERROR-PAGE] Detected non-429 error page after clicking button, navigating back...`);
          try {
            await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);
          } catch (e) {
            console.warn(`[ERROR-PAGE] Failed to navigate back: ${e.message}`);
          }
        }
        
        const postCheck = await checkPageForRateLimitError(page);
        if (postCheck.hasError) {
          throw new Error(`Rate limit error detected after clicking button: ${postCheck.errorText}`);
        }
      },
      {
        maxRetries: 3, // 减少重试次数，避免过度等待
        initialDelay: 3000, // 减少初始延迟
        maxDelay: 30000, // 减少最大延迟
        backoffMultiplier: 2,
        operationName: 'Click "Enter an address manually" button',
        retryCondition: (error, attempt) => {
          const errorMsg = String(error).toLowerCase();
          // 只对真正的错误消息重试，不重试API错误
          return (errorMsg.includes('rate limit') && errorMsg.includes('message')) || 
                 errorMsg.includes('too many requests') ||
                 errorMsg.includes('wait.*try again') ||
                 errorMsg.includes('timeout') ||
                 errorMsg.includes('not found');
        }
      }
    );

    // 等待输入框出现并稳健填入地址（多策略兜底）
    const fillAddress = async (addr) => {
      // 策略1：placeholder 精确
      const loc1 = page.getByPlaceholder('Enter address');
      if (await loc1.first().isVisible().catch(() => false)) {
        await loc1.first().fill(addr);
        return true;
      }
      // 策略2：role=textbox 且可见
      const loc2 = page.getByRole('textbox', { name: /address/i });
      if (await loc2.first().isVisible().catch(() => false)) {
        await loc2.first().fill(addr);
        return true;
      }
      // 策略3：页面上唯一/第一个可编辑文本框
      const textboxes = page.locator('input[type="text"], input:not([type]), textarea');
      await textboxes.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      if (await textboxes.first().isVisible().catch(() => false)) {
        await textboxes.first().fill(addr);
        return true;
      }
      return false;
    };

    const filled = await fillAddress(task.addr);
    if (!filled) {
      throw new Error('Address input not found/filled');
    }
    // 其它参数...
    // await page.fill('input[name="extra"]', task.extra);

    // 点击 Continue 前检查 429 错误页面（只有 429 才需要 disconnect）
    const continuePreErrorCheck = await checkIfErrorPage(page);
    if (continuePreErrorCheck.isErrorPage && continuePreErrorCheck.errorCode === '429') {
      console.warn(`[429-ERROR] Detected 429 error page before Continue, attempting recovery via disconnect...`);
      await handleErrorPage(page, BASE_URL);
      await page.waitForTimeout(2000);
    }
    
    // 点击 Continue 前检查错误
    const continueCheck = await checkPageForRateLimitError(page);
    if (continueCheck.hasError) {
      console.warn(`[RATE-LIMIT] Rate limit error before Continue button: ${continueCheck.errorText}`);
      const cleared = await waitForRateLimitErrorToClear(page, 20000, 3000);
      if (!cleared) {
        throw new Error(`Rate limit error before Continue: ${continueCheck.errorText}`);
      }
    }
    
    // 等待页面稳定，使用安全点击
    await waitForPageStable(page, 2000);
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    await safeClick(page, continueBtn, { timeout: 10000, force: true, retries: 3 });
    
    // 点击后检查 429 错误页面（只有 429 才需要 disconnect）
    await page.waitForTimeout(1000);
    const continuePostErrorCheck = await checkIfErrorPage(page);
    if (continuePostErrorCheck.isErrorPage && continuePostErrorCheck.errorCode === '429') {
      console.warn(`[429-ERROR] Detected 429 error page after Continue, attempting recovery via disconnect...`);
      await handleErrorPage(page, BASE_URL);
      await page.waitForTimeout(2000);
    }
    
    // 点击后检查
    const afterContinueCheck = await checkPageForRateLimitError(page);
    if (afterContinueCheck.hasError) {
      console.warn(`[RATE-LIMIT] Rate limit error after Continue: ${afterContinueCheck.errorText}`);
      const cleared = await waitForRateLimitErrorToClear(page, 20000, 3000);
      if (!cleared) {
        throw new Error(`Rate limit error after Continue: ${afterContinueCheck.errorText}`);
      }
    }
    
    // ⚠️ 优化：减少等待时间，快速检查并点击
    await waitForPageStable(page, 1000); // 减少到1秒
    const nextBtn1 = page.getByRole('button', { name: 'Next' });
    await safeClick(page, nextBtn1, { timeout: 10000, force: true, retries: 3 });

    // 等 connecting 结束（改为文本检测，避免无效的 :has-text 选择器）
    await page.waitForFunction(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      // 若页面包含 "connecting" 视为未结束；否则结束
      return !text.includes('connecting');
    }, { timeout: 30_000 }).catch(() => { /* 容忍页面未出现该文案 */ });

    // 点击 Next 前检查 429 错误页面（只有 429 才需要 disconnect）
    const nextPreErrorCheck = await checkIfErrorPage(page);
    if (nextPreErrorCheck.isErrorPage && nextPreErrorCheck.errorCode === '429') {
      console.warn(`[429-ERROR] Detected 429 error page before Next, attempting recovery via disconnect...`);
      await handleErrorPage(page, BASE_URL);
      await page.waitForTimeout(2000);
    }
    
    // 点击 Next 前检查错误
    const nextCheck = await checkPageForRateLimitError(page);
    if (nextCheck.hasError) {
      console.warn(`[RATE-LIMIT] Rate limit error before Next button: ${nextCheck.errorText}`);
      const cleared = await waitForRateLimitErrorToClear(page, 20000, 3000);
      if (!cleared) {
        throw new Error(`Rate limit error before Next: ${nextCheck.errorText}`);
      }
    }

    // ⚠️ 优化：减少等待时间，快速检查并点击
    await waitForPageStable(page, 1000); // 减少到1秒
    const nextBtn2 = page.getByRole('button', { name: 'Next' });
    await safeClick(page, nextBtn2, { timeout: 10000, force: true, retries: 3 });
    
    // ⚠️ 优化：减少等待时间
    // 点击后检查 429 错误页面（只有 429 才需要 disconnect）
    await page.waitForTimeout(500); // 减少到0.5秒
    const nextPostErrorCheck = await checkIfErrorPage(page);
    if (nextPostErrorCheck.isErrorPage && nextPostErrorCheck.errorCode === '429') {
      console.warn(`[429-ERROR] Detected 429 error page after Next, attempting recovery via disconnect...`);
      await handleErrorPage(page, BASE_URL);
      await page.waitForTimeout(2000);
    }
    
    // 点击后检查
    const afterNextCheck = await checkPageForRateLimitError(page);
    if (afterNextCheck.hasError) {
      console.warn(`[RATE-LIMIT] Rate limit error after Next: ${afterNextCheck.errorText}`);
      const cleared = await waitForRateLimitErrorToClear(page, 20000, 3000);
      if (!cleared) {
        throw new Error(`Rate limit error after Next: ${afterNextCheck.errorText}`);
      }
    }

    // 下个页面点击 check（更健壮：跨 frame 多文案兜底 + 重试）
    const clickCheckButton = async () => {
      const variants = [
        /^(check)$/i,
        /check\s*address/i,
        /check\s*eligibility/i,
        /verify/i
      ];
      const tryInFrame = async (frame) => {
        for (const rx of variants) {
          const byRole = frame.getByRole('button', { name: rx }).first();
          if (await byRole.isVisible().catch(() => false)) {
            // 等待 frame 稳定后再点击
            await frame.waitForTimeout(300);
            await byRole.click({ force: true });
            return true;
          }
          const byText = frame.locator('button').filter({ hasText: rx }).first();
          if (await byText.isVisible().catch(() => false)) {
            // 等待 frame 稳定后再点击
            await frame.waitForTimeout(300);
            await byText.click({ force: true });
            return true;
          }
          // CSS :has-text 作为兜底（转义特殊字符）
          const escapedPattern = rx.source.replace(/[\\"]/g, '\\$&');
          const css = frame.locator(`button:has-text("${escapedPattern}")`).first();
          if (await css.isVisible().catch(() => false)) {
            // 等待 frame 稳定后再点击
            await frame.waitForTimeout(300);
            await css.click({ force: true });
            return true;
          }
        }
        return false;
      };
      // ⚠️ 优化：减少重试次数和等待时间
      for (let i = 0; i < 5; i++) { // 从8次减少到5次
        // 先主页面
        if (await tryInFrame(page)) return true;
        // 再所有子 frame
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue;
          if (await tryInFrame(f)) return true;
        }
        await page.waitForTimeout(800); // 从1500ms减少到800ms
      }
      return false;
    };
    const clickedCheck = await clickCheckButton();
    if (!clickedCheck) {
      // 如果未找到 Check，尝试检测是否已直接进入 Terms 页面，则跳过该步骤继续
      const hasTerms = await (async () => {
        const probe = async (frame) => frame.evaluate(() => {
          const text = document.body?.innerText || '';
          return /Accept Token End User Terms/i.test(text) || /By checking this box/i.test(text) || /have read and understood the Glacier Drop terms/i.test(text);
        }).catch(() => false);
        if (await probe(page)) return true;
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue;
          if (await probe(f)) return true;
        }
        return false;
      })();
      if (!hasTerms) {
        throw new Error('Check button not found');
      }
    }

    // 若进入 Terms 页面：提取 hex，用本地签名服务签名；滚动到底部，勾选复选框并接受
    let minedHex = null; // 在外层定义，后续签名页也要用到
    let signDataTerms = null; // 在 Terms 页面获取的签名数据
    let termsSigned = false; // 标记是否已在 Terms 页面成功签名
    
    // ⚠️ 详细日志：记录Terms页面处理的开始
    const taskId = page._taskId || 'unknown';
    const termsStartTime = Date.now();
    let termsPageUrl = 'unknown';
    try {
      termsPageUrl = page.url();
    } catch (e) {
      // ignore error
    }
    // ⚠️ 减少日志：只保留关键的开始信息
    // console.log(`[TERMS-DETAIL] ========================================`);
    // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🚀 Starting Terms page processing`);
    // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 📍 Current URL: ${termsPageUrl}`);
    // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⏰ Start time: ${new Date(termsStartTime).toISOString()}`);
    
    try {
      // 仅当看到页面标题或关键文案时才执行（主文档或子 frame）
      // ⚠️ 减少日志：不输出步骤检测信息（关键错误会保留）
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 1: Detecting Terms page frame...`);
      const detectStartTime = Date.now();
      const findTermsFrame = async () => {
        // 主页面先检查
        const hasInMain = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
          const allText = bodyText + ' ' + bodyHTML;
          const hasAcceptTokenTerms = /accept token end user terms/i.test(allText);
          const hasTokenEndUserTerms = /token end-user terms/i.test(allText);
          const hasByCheckingBox = /by checking this box/i.test(allText);
          const hasLastUpdated = /last updated/i.test(allText);
          const hasDecline = /decline/i.test(allText);
          const hasAcceptSign = /accept and sign/i.test(allText);
          const hasMessageToSign = /message to be signed/i.test(allText);
          const hasPublicKey = /public\s*key/i.test(allText);
          const hasSignature = /signature/i.test(allText);
          
          return {
            found: hasAcceptTokenTerms || hasTokenEndUserTerms || hasByCheckingBox,
            hasAcceptTokenTerms,
            hasTokenEndUserTerms,
            hasByCheckingBox,
            hasLastUpdated,
            hasDecline,
            hasAcceptSign,
            hasMessageToSign,
            hasPublicKey,
            hasSignature,
            url: window.location.href,
            title: document.title,
            bodyTextLength: bodyText.length,
            bodyHTMLLength: bodyHTML.length
          };
        }).catch(() => ({ found: false }));
        
        if (hasInMain.found) {
          const detectTime = Date.now() - detectStartTime;
          // ⚠️ 减少日志：不输出详细的检测信息（关键错误会保留）
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 1: Detected Terms page in MAIN frame (${detectTime}ms)`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - URL: ${hasInMain.url || termsPageUrl}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Title: ${hasInMain.title || 'N/A'}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Accept Token End User Terms": ${hasInMain.hasAcceptTokenTerms}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "TOKEN END-USER TERMS": ${hasInMain.hasTokenEndUserTerms}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "By checking this box": ${hasInMain.hasByCheckingBox}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Last updated": ${hasInMain.hasLastUpdated}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Decline" button: ${hasInMain.hasDecline}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Accept and sign": ${hasInMain.hasAcceptSign}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Message to be signed": ${hasInMain.hasMessageToSign}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Public key" field: ${hasInMain.hasPublicKey}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Signature" field: ${hasInMain.hasSignature}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Body text length: ${hasInMain.bodyTextLength || 0}`);
          return page;
        } else {
          // ⚠️ 减少日志：不输出子 frame 检查提示（关键错误会保留）
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Step 1: Main frame check failed, checking sub-frames...`);
        }
        
        // 子 frame 检查
        const allFrames = page.frames();
        // ⚠️ 减少日志：不输出 frame 数量
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Total frames: ${allFrames.length}`);
        for (let i = 0; i < allFrames.length; i++) {
          const f = allFrames[i];
          if (f === page.mainFrame()) continue;
          try {
            const found = await f.evaluate(() => {
              const bodyText = (document.body?.innerText || '').toLowerCase();
              const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
              const allText = bodyText + ' ' + bodyHTML;
              const hasAcceptTokenTerms = /accept token end user terms/i.test(allText);
              const hasTokenEndUserTerms = /token end-user terms/i.test(allText);
              const hasByCheckingBox = /by checking this box/i.test(allText);
              const hasAcceptSign = /accept and sign/i.test(allText);
              
              return {
                found: hasAcceptTokenTerms || hasTokenEndUserTerms || hasByCheckingBox,
                hasAcceptTokenTerms,
                hasTokenEndUserTerms,
                hasByCheckingBox,
                hasAcceptSign,
                url: window.location.href
              };
            });
            if (found.found) {
              const detectTime = Date.now() - detectStartTime;
              // ⚠️ 减少日志：不输出子 frame 检测详细信息
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 1: Detected Terms page in SUB-FRAME #${i} (${detectTime}ms)`);
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Frame URL: ${found.url || 'N/A'}`);
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Accept Token End User Terms": ${found.hasAcceptTokenTerms}`);
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "TOKEN END-USER TERMS": ${found.hasTokenEndUserTerms}`);
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "By checking this box": ${found.hasByCheckingBox}`);
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has "Accept and sign": ${found.hasAcceptSign}`);
              return f;
            }
          } catch (e) {
            console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Sub-frame #${i} check error: ${e.message}`);
          }
        }
        
        const detectTime = Date.now() - detectStartTime;
        // ⚠️ 减少日志：只在关键错误时输出
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ❌ Step 1: Terms page NOT detected in any frame (${detectTime}ms)`);
        return null;
      };

      const host = await findTermsFrame();
      if (!host) {
        console.error(`[TERMS-DETAIL] [Task: ${taskId}] ❌ CRITICAL: Terms page not detected!`);
        throw new Error('Terms page not detected');
      }
      // ⚠️ 减少日志：不输出 frame 检测完成信息
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Frame detection completed, using ${host === page ? 'MAIN' : 'SUB'} frame`);

      // 提取"Copy to Clipboard"区域中的 mining process: 后的 hex
      // ⚠️ 减少日志：不输出 hex 提取步骤（关键错误会保留）
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 2: Extracting mining process hex...`);
      const hexExtractStartTime = Date.now();
      minedHex = await (async () => {
        try {
          const text = await host.evaluate(() => document.body?.innerText || '');
          const m = text.match(/mining\s+process:\s*([0-9a-f]{64,})/i);
          if (m) {
            // ⚠️ 减少日志：不输出 hex 找到信息
            // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 2: Found hex in body text (length: ${m[1].length})`);
            return m[1].toLowerCase();
          }
          // ⚠️ 减少日志：不输出 hex 未找到信息（关键错误会保留）
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Step 2: Hex not found in body text`);
          return null;
        } catch (e) {
          // ⚠️ 减少日志：不输出 hex 提取错误（关键错误会保留）
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Step 2: Error extracting hex from body: ${e.message}`);
          return null;
        }
      })();
      
      // 若未提取到，尝试从可能的代码块/复制源附近查找
      if (!minedHex) {
        // ⚠️ 减少日志：不输出替代提取方法
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 2: Trying alternative extraction from code elements...`);
        minedHex = await host.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('pre, code, textarea, [data-copy], .copy, .clipboard, [data-clipboard-text]'));
          console.log(`[TERMS-DETAIL]    - Found ${candidates.length} candidate elements`);
          for (const el of candidates) {
            const t = (el.getAttribute('data-clipboard-text') || el.textContent || '').trim();
            const m = t.match(/mining\s+process:\s*([0-9a-f]{64,})/i);
            if (m) {
              console.log(`[TERMS-DETAIL]    - Found hex in element: ${el.tagName}`);
              return m[1].toLowerCase();
            }
          }
          return null;
        }).catch((e) => {
          // ⚠️ 减少日志：不输出替代提取错误
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Step 2: Error in alternative extraction: ${e.message}`);
          return null;
        });
      }
      
      const hexExtractTime = Date.now() - hexExtractStartTime;
      if (minedHex) {
        // ⚠️ 减少日志：不输出 hex 提取成功信息
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 2: Hex extraction successful (${hexExtractTime}ms, length: ${minedHex.length})`);
      } else {
        // ⚠️ 减少日志：不输出 hex 提取失败信息（关键错误会保留）
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Step 2: Hex extraction failed (${hexExtractTime}ms), will retry later in sign page`);
      }
      // 如果仍没有，稍后在签名页再尝试一次，不阻塞流程

      // 优化：快速滚动到底部（简化逻辑，减少等待）
      const quickScrollToBottom = async () => {
        // 使用 locator 穿透 shadow 定位到标题元素
        const headerLoc = host.getByText(/TOKEN END-USER TERMS/i).first();
        const headerEl = await headerLoc.elementHandle().catch(() => null);
        if (!headerEl) {
          // 找不到标题，则尝试滚动整个页面
          await host.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
          return false;
        }
        // 在页面端寻找可滚动祖先（跨越 shadow root）
        const reachedBottom = await host.evaluate((el) => {
          function getScrollParentDeep(node) {
            let current = node;
            // 优化：减少循环次数，50 次足够
            for (let i = 0; i < 50 && current; i++) {
              const style = current instanceof Element ? getComputedStyle(current) : null;
              if (style) {
                const oy = style.overflowY;
                const canScroll = (oy === 'auto' || oy === 'scroll') && current.scrollHeight > current.clientHeight + 2;
                if (canScroll) return current;
              }
              // 向上一个常规父元素
              if (current.parentElement) { current = current.parentElement; continue; }
              // 穿过 shadow boundary
              const root = current.getRootNode && current.getRootNode();
              if (root && root.host) { current = root.host; continue; }
              break;
            }
            return null;
          }
          const panel = getScrollParentDeep(el) || document.scrollingElement || document.documentElement;
          // 给容器聚焦，模拟真实滚轮事件（有些站点只接受 wheel 触发）
          if (panel instanceof HTMLElement) { panel.focus && panel.focus(); }
          const target = panel;
          function atBottom() {
            return Math.abs(target.scrollHeight - target.clientHeight - target.scrollTop) < 4;
          }
          // 优化：直接滚动到底，减少循环次数
          target.scrollTop = target.scrollHeight;
          const rect = (target instanceof Element ? target.getBoundingClientRect() : document.body.getBoundingClientRect());
          const wheel = new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: 10000,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
          });
          (target instanceof Element ? target : document.body).dispatchEvent(wheel);
          return atBottom();
        }, headerEl).catch(() => false);

        // 优化：快速鼠标滚轮和键盘滚动（一次性完成）
        try {
          const box = await headerLoc.boundingBox().catch(() => null);
          if (box) {
            await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await host.mouse.wheel(0, 5000); // 一次性大滚动
          }
          await host.keyboard.press('End');
        } catch {}
        return reachedBottom;
      };

      // 优化：同时滚动所有可滚动容器作为兜底（并行执行）
      await host.evaluate(() => {
        Array.from(document.querySelectorAll('*'))
          .filter(el => {
            const style = getComputedStyle(el);
            return (style.overflowY === 'auto' || style.overflowY === 'scroll') && 
                   el.scrollHeight > el.clientHeight;
          })
          .forEach(el => { el.scrollTop = el.scrollHeight; });
      }).catch(() => {});

      // ⚠️ 优化：检查Terms页面是否有hex字段和签名字段，如果没有则跳过签名步骤
      const hasHexAndSignFields = await host.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
        const allText = bodyText + ' ' + bodyHTML;
        const hasMessageToSign = /message to be signed/i.test(allText);
        const hasPublicKey = /public\s*key/i.test(allText);
        const hasSignature = /signature/i.test(allText);
        return hasMessageToSign || hasPublicKey || hasSignature;
      }).catch(() => false);
      
      // ⚠️ 减少日志：不输出字段检测信息
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Has hex/signature fields: ${hasHexAndSignFields}`);
      
      // 优化：简化循环，只尝试一次快速滚动
      // ⚠️ 减少日志：不输出滚动步骤
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 3: Scrolling to bottom of Terms page...`);
      const scrollStartTime = Date.now();
      await quickScrollToBottom();
      await host.waitForTimeout(50); // 优化：从100ms减少到50ms
      const scrollTime = Date.now() - scrollStartTime;
      // ⚠️ 减少日志：不输出滚动完成信息
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 3: Scroll completed (${scrollTime}ms)`);

      // ⚠️ 优化：只有在Terms页面有hex字段时才尝试提取和签名
      // 在 Terms 页面直接完成签名字段填充（Public key / Signature），避免卡在此页
      if (minedHex && hasHexAndSignFields) {
        // ⚠️ 减少日志：不输出签名请求步骤
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 4: Requesting signature data...`);
        const signStartTime = Date.now();
        try {
          signDataTerms = await signWithRateLimit(task.addr, minedHex);
          termsSigned = true; // 标记已在 Terms 页面成功签名
          const signTime = Date.now() - signStartTime;
          // ⚠️ 减少日志：不输出签名数据接收信息
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 4: Signature data received (${signTime}ms)`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Public key length: ${signDataTerms?.publicKeyHex?.length || 0}`);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Signature length: ${signDataTerms?.coseSign1Hex?.length || 0}`);
          
          if (signDataTerms) {
            // 将 publicKeyHex 和 coseSign1Hex 填入（作用于 host frame 内）
            const fillInHost = async (labelRegex, value) => {
              // 在浏览器端做深度遍历（含 shadowRoot），根据 label 文本或 aria/name/placeholder 匹配
              const found = await host.evaluate((regexSource, val) => {
                const labelRe = new RegExp(regexSource, 'i');
                function* walk(node) {
                  if (!node) return;
                  yield node;
                  if (node.shadowRoot) {
                    for (const c of node.shadowRoot.querySelectorAll('*')) yield c;
                  }
                  if (node.children) {
                    for (const c of node.children) yield* walk(c);
                  }
                }
                function setVal(el, v) {
                  const proto = Object.getPrototypeOf(el);
                  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (desc && desc.set) desc.set.call(el, '');
                  el.value = '';
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.value = v;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                // 尝试直接通过可访问性属性匹配
                const q = '[name],[aria-label],[placeholder]';
                const all = Array.from(document.querySelectorAll(`input${q},textarea${q}`));
                let target = all.find(el => labelRe.test(el.getAttribute('aria-label')||'') || labelRe.test(el.getAttribute('name')||'') || labelRe.test(el.getAttribute('placeholder')||''));
                // 精确命中截图里的占位符（如果是查找 Public key）
                if (!target && /public\s*key/i.test(regexSource)) {
                  target = document.querySelector('input[placeholder="Please enter a public key"], textarea[placeholder="Please enter a public key"]');
                }
                if (!target) {
                  // 根据 label 文本邻近
                  const labels = Array.from(document.querySelectorAll('*')).filter(n => labelRe.test(n.textContent||''));
                  for (const lab of labels) {
                    const sibInput = lab.closest('*')?.querySelector('input,textarea');
                    if (sibInput) { target = sibInput; break; }
                  }
                }
                if (!target) {
                  // 精确：若 label 有 for 属性，按 id 取 input
                  const labelEl = Array.from(document.querySelectorAll('label'))
                    .find(l => labelRe.test(l.textContent||''));
                  const forId = labelEl && labelEl.getAttribute('for');
                  if (forId) {
                    const byId = document.getElementById(forId);
                    if (byId && (byId instanceof HTMLInputElement || byId instanceof HTMLTextAreaElement)) {
                      target = byId;
                    }
                  }
                }
                if (!target) {
                  // 深度遍历 shadowRoot 查找
                  for (const n of walk(document.body)) {
                    if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) {
                      const a = (n.getAttribute('aria-label')||'') + ' ' + (n.getAttribute('name')||'') + ' ' + (n.getAttribute('placeholder')||'');
                      if (labelRe.test(a)) { target = n; break; }
                    }
                    // 兼容 contenteditable 容器
                    if (n instanceof HTMLElement && n.getAttribute && n.getAttribute('contenteditable') === 'true') {
                      const a = (n.getAttribute('aria-label')||'') + ' ' + (n.getAttribute('name')||'') + ' ' + (n.getAttribute('placeholder')||'');
                      if (labelRe.test(a)) { target = n; break; }
                    }
                  }
                }
                if (!target) return false;
                target.scrollIntoView({ block: 'center', behavior: 'instant' });
                if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                  setVal(target, val);
                } else if (target instanceof HTMLElement && target.getAttribute('contenteditable') === 'true') {
                  target.focus();
                  target.textContent = '';
                  target.dispatchEvent(new Event('input', { bubbles: true }));
                  target.textContent = val;
                  target.dispatchEvent(new Event('input', { bubbles: true }));
                  target.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return true;
              }, labelRegex.source, value).catch(() => false);
              // 若浏览器端未能设置，回退到 Playwright 键入
              if (!found) {
                const loc = host.locator('input[placeholder="Please enter a public key"], textarea[placeholder="Please enter a public key"]').first();
                if (await loc.isVisible().catch(() => false)) {
                  await loc.click({ timeout: 2000 }).catch(() => {});
                  try { await loc.fill(''); } catch {}
                  try { await host.keyboard.type(value, { delay: 2 }); } catch {}
                  return true;
                }
              }
              return !!found;
            };

            // 滚动容器函数：滚动所有可滚动容器以确保内容可见
            const doScrollContainers = async () => {
              await host.evaluate(() => {
                Array.from(document.querySelectorAll('*'))
                  .filter(el => {
                    const style = getComputedStyle(el);
                    return (style.overflowY === 'auto' || style.overflowY === 'scroll') && 
                           el.scrollHeight > el.clientHeight;
                  })
                  .forEach(el => { el.scrollTop = el.scrollHeight; });
              }).catch(() => {});
            };

            // 滚动容器，确保输入框出现
            await doScrollContainers();
            
            // 使用优化后的统一函数填写 Public key
            // ⚠️ 减少日志：不输出字段填充步骤（关键错误会保留）
            // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 5: Filling Public key field...`);
            const pkFillStartTime = Date.now();
            const filledPk = await fillInputFieldOptimized(
              host,
              /public\s*key/i,
              signDataTerms.publicKeyHex,
              { inputType: 'input', verifyAfter: true }
            );
            const pkFillTime = Date.now() - pkFillStartTime;
            // ⚠️ 减少日志：只在失败时输出
            if (!filledPk) {
              console.log(`[TERMS-DETAIL] [Task: ${taskId}] ❌ Step 5: Public key fill failed (${pkFillTime}ms)`);
            }
            
            // 使用优化后的统一函数填写 Signature
            await doScrollContainers();
            // ⚠️ 减少日志：不输出字段填充步骤（关键错误会保留）
            // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 6: Filling Signature field...`);
            const sigFillStartTime = Date.now();
            const filledSig = await fillInputFieldOptimized(
              host,
              /^(\s*)signature(\s*)$/i,
              signDataTerms.coseSign1Hex,
              { inputType: 'textarea', verifyAfter: true }
            );
            const sigFillTime = Date.now() - sigFillStartTime;
            // ⚠️ 减少日志：只在失败时输出
            if (!filledSig) {
              console.log(`[TERMS-DETAIL] [Task: ${taskId}] ❌ Step 6: Signature fill failed (${sigFillTime}ms)`);
            }

            // 触发校验：对两个输入派发 blur，并等待页面校验完成
            await host.waitForTimeout(500); // 给页面一点时间处理输入
            await host.evaluate(() => {
              const pk = document.getElementById('input');
              const sig = document.querySelector('textarea') || Array.from(document.querySelectorAll('textarea')).find(t => t.value && t.value.length > 100);
              const blur = (el) => el && el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
              if (pk) { blur(pk); pk.dispatchEvent(new Event('change', { bubbles: true })); }
              if (sig) { blur(sig); sig.dispatchEvent(new Event('change', { bubbles: true })); }
            }).catch(() => {});
            
            // 等待页面校验逻辑完成，Sign 按钮变为可用
            console.log('[DEBUG] Waiting for Sign button to become enabled...');
            await host.waitForFunction(() => {
              const btn = Array.from(document.querySelectorAll('button')).find(b => /^(\s*)sign(\s*)$/i.test(b.textContent || ''));
              if (!btn) return false;
              const ariaDis = btn.getAttribute('aria-disabled');
              const isEnabled = !btn.disabled && ariaDis !== 'true';
              if (isEnabled) console.log('Sign button is now enabled!');
              return isEnabled;
            }, { timeout: 5000 }).catch(() => {  // 优化：减少超时时间
              console.log('[DEBUG] Sign button did not become enabled, checking current state...');
            });

            const signBtnHost = host.getByRole('button', { name: /^sign$/i }).first();
            if (await signBtnHost.isVisible().catch(() => false)) {
              await signBtnHost.scrollIntoViewIfNeeded().catch(() => {});
              await signBtnHost.click().catch(() => {});
            }
          }
        } catch {}
      }

      // 勾选复选框：多种策略，确保checkbox被正确选中
      // ⚠️ 减少日志：不输出 checkbox 查找步骤（关键错误会保留）
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 7: Finding and checking checkbox...`);
      const checkboxStartTime = Date.now();
      const checkCheckbox = async () => {
        // 策略1: 通过ID直接查找（HTML中id="accept-terms"）
        try {
          console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 1: Looking for #accept-terms...`);
          const byId = host.locator('#accept-terms');
          const isVisible = await byId.isVisible({ timeout: 2000 }).catch(() => false);
          console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 1: Checkbox visible: ${isVisible}`);
          
          if (isVisible) {
            const isChecked = await byId.isChecked().catch(() => false);
            // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 1: Checkbox checked state: ${isChecked}`);
            
            if (!isChecked) {
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 1: Attempting to check checkbox...`);
              await byId.check({ force: true });
              // 验证是否选中成功
              await host.waitForTimeout(100); // 优化：从200ms减少到100ms
              const verifyChecked = await byId.isChecked().catch(() => false);
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 1: After check, verified state: ${verifyChecked}`);
              
              if (verifyChecked) {
                // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Strategy 1: Checkbox checked successfully via ID (#accept-terms)`);
                return true;
              } else {
                // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Strategy 1: Checkbox check failed verification`);
              }
            } else {
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Strategy 1: Checkbox already checked via ID`);
              return true;
            }
          } else {
            // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Strategy 1: Checkbox not visible`);
          }
        } catch (e) {
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Strategy 1: Error - ${e.message}`);
        }
        
        // 策略2: 通过 label 关联查找
        try {
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 2: Looking for checkbox by label...`);
          const byLabel = host.getByLabel(/By checking this box|accept.*terms|read.*understood/i);
          const isVisible = await byLabel.first().isVisible({ timeout: 2000 }).catch(() => false);
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 2: Checkbox visible: ${isVisible}`);
          
          if (isVisible) {
            const isChecked = await byLabel.first().isChecked().catch(() => false);
            // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 2: Checkbox checked state: ${isChecked}`);
            
            if (!isChecked) {
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 2: Attempting to check checkbox...`);
              await byLabel.first().check({ force: true });
              await host.waitForTimeout(100); // 优化：从200ms减少到100ms
              const verifyChecked = await byLabel.first().isChecked().catch(() => false);
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Strategy 2: After check, verified state: ${verifyChecked}`);
              
              if (verifyChecked) {
                // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Strategy 2: Checkbox checked successfully via label`);
                return true;
              } else {
                // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Strategy 2: Checkbox check failed verification`);
              }
            } else {
              // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Strategy 2: Checkbox already checked via label`);
              return true;
            }
          } else {
            // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Strategy 2: Checkbox not visible`);
          }
        } catch (e) {
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Strategy 2: Error - ${e.message}`);
        }
        
        // 策略3: 通过文本查找附近的checkbox
        try {
          const nearText = host.getByText(/By checking this box|read.*understood.*Glacier Drop/i);
          if (await nearText.first().isVisible({ timeout: 2000 }).catch(() => false)) {
            // 查找label或附近的checkbox
            const container = nearText.first().locator('xpath=ancestor::label | ..');
            const cb = container.locator('input[type="checkbox"], [role="checkbox"]').first();
            if (await cb.isVisible({ timeout: 1000 }).catch(() => false)) {
              const isChecked = await cb.isChecked().catch(() => false);
              if (!isChecked) {
                try { 
                  await cb.check({ force: true });
                } catch { 
                  await cb.click({ force: true });
                }
                await host.waitForTimeout(200);
                const verifyChecked = await cb.isChecked().catch(() => false);
                if (verifyChecked) {
                  console.log('[TERMS] Checkbox checked via text near checkbox');
          return true;
        }
              } else {
                console.log('[TERMS] Checkbox already checked via text');
                return true;
              }
            }
          }
        } catch {}
        
        // 策略4: 直接查找任何可见的checkbox
        try {
          const anyCb = host.locator('input[type="checkbox"][id*="accept"], input[type="checkbox"][name*="accept"], input[type="checkbox"]').first();
          if (await anyCb.isVisible({ timeout: 2000 }).catch(() => false)) {
            const isChecked = await anyCb.isChecked().catch(() => false);
            if (!isChecked) {
              try { 
                await anyCb.check({ force: true });
              } catch { 
                await anyCb.click({ force: true });
              }
              await host.waitForTimeout(200);
              const verifyChecked = await anyCb.isChecked().catch(() => false);
              if (verifyChecked) {
                console.log('[TERMS] Checkbox checked via direct locator');
                return true;
              }
            } else {
              console.log('[TERMS] Checkbox already checked via direct locator');
              return true;
            }
          }
        } catch {}
        
        return false;
      };
      
      // 多次尝试选中checkbox，直到成功
      let checked = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
        // ⚠️ 减少日志：不输出 checkbox 尝试信息
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Attempt ${attempt}/5 to check checkbox...`);
        checked = await checkCheckbox();
        if (checked) {
          const checkboxTime = Date.now() - checkboxStartTime;
          // ⚠️ 减少日志：不输出 checkbox 成功信息
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 7: Checkbox check succeeded on attempt ${attempt} (${checkboxTime}ms)`);
          break;
        }
        
        if (attempt < 5) {
          // ⚠️ 减少日志：不输出 checkbox 重试信息
          // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Attempt ${attempt} failed, retrying...`);
          await host.waitForTimeout(200); // 优化：从300ms减少到200ms
        }
      }
      
      if (!checked) {
        const checkboxTime = Date.now() - checkboxStartTime;
        console.error(`[TERMS-DETAIL] [Task: ${taskId}] ❌ Step 7: Failed to check checkbox after all attempts (${checkboxTime}ms)`);
        throw new Error('Terms checkbox not found or could not be checked');
      }
      
      // 最终验证：确保checkbox已选中
      await host.waitForTimeout(150); // 优化：从300ms减少到150ms
      // ⚠️ 减少日志：不输出 checkbox 验证步骤
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 7: Verifying checkbox state...`);
      const finalCheck = await (async () => {
        try {
          const byId = host.locator('#accept-terms');
          if (await byId.isVisible({ timeout: 1000 }).catch(() => false)) {
            const isChecked = await byId.isChecked().catch(() => false);
            console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Final verification via #accept-terms: ${isChecked}`);
            return isChecked;
          }
          const anyCb = host.locator('input[type="checkbox"]').first();
          if (await anyCb.isVisible({ timeout: 1000 }).catch(() => false)) {
            const isChecked = await anyCb.isChecked().catch(() => false);
            console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Final verification via generic checkbox: ${isChecked}`);
            return isChecked;
          }
          console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Final verification: No checkbox found`);
          return false;
        } catch (e) {
          console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Final verification error: ${e.message}`);
          return false;
        }
      })();
      
      if (!finalCheck) {
        console.warn(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Step 7: Final checkbox verification failed, but continuing anyway...`);
      } else {
        // ⚠️ 减少日志：不输出 checkbox 验证成功信息
        // console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 7: Checkbox verified as checked`);
      }

      // 等待按钮变为可用（checkbox选中后，按钮可能需要一些时间才能启用）
      // ⚠️ 减少日志：不输出按钮查找步骤
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 8: Finding "Accept and sign" button...`);
      const buttonFindStartTime = Date.now();
      const acceptBtn = host.getByRole('button', { name: /Accept and Sign/i }).first();
      const buttonFound = await acceptBtn.isVisible({ timeout: 2000 }).catch(() => false);
      const buttonFindTime = Date.now() - buttonFindStartTime;
      if (buttonFound) {
        console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 8: Button found (${buttonFindTime}ms)`);
      } else {
        console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Step 8: Button not immediately visible (${buttonFindTime}ms), will retry...`);
      }
      await acceptBtn.scrollIntoViewIfNeeded().catch(() => {});
      console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 8: Button scrolled into view`);
      
      // 等待按钮启用（最多等待3秒）
      // ⚠️ 减少日志：不输出按钮启用检查步骤
      // console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 9: Checking if button is enabled...`);
      const buttonEnableStartTime = Date.now();
      let buttonEnabled = false;
      for (let i = 0; i < 6; i++) {
        console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Check ${i + 1}/6: Checking button state...`);
        const isVisible = await acceptBtn.isVisible({ timeout: 1000 }).catch(() => false);
        const isDisabled = await acceptBtn.isDisabled({ timeout: 1000 }).catch(() => true);
        console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Check ${i + 1}/6: visible=${isVisible}, disabled=${isDisabled}`);
        
        if (isVisible && !isDisabled) {
          buttonEnabled = true;
          const buttonEnableTime = Date.now() - buttonEnableStartTime;
          console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 9: Button is enabled (${buttonEnableTime}ms)`);
          break;
        }
        
        if (i < 5) {
          console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⏳ Check ${i + 1}/6: Button not enabled yet, waiting...`);
          try { await host.keyboard.press('End'); } catch {}
          await host.waitForTimeout(300); // 优化：从500ms减少到300ms
          
          // 如果按钮仍然禁用，再次检查checkbox状态
          if (isDisabled) {
            console.log('[TERMS] Button still disabled, re-checking checkbox...');
            // 重新定义checkCheckbox函数（因为可能在外部作用域）
            const recheckCheckbox = async () => {
              try {
                const byId = host.locator('#accept-terms');
                if (await byId.isVisible({ timeout: 1000 }).catch(() => false)) {
                  const isChecked = await byId.isChecked().catch(() => false);
                  if (!isChecked) {
                    await byId.check({ force: true });
                    await host.waitForTimeout(100); // 优化：从200ms减少到100ms
                    return await byId.isChecked().catch(() => false);
                  }
                  return true;
                }
                const anyCb = host.locator('input[type="checkbox"]').first();
                if (await anyCb.isVisible({ timeout: 1000 }).catch(() => false)) {
                  const isChecked = await anyCb.isChecked().catch(() => false);
                  if (!isChecked) {
                    try { await anyCb.check({ force: true }); } catch { await anyCb.click({ force: true }); }
                    await host.waitForTimeout(100); // 优化：从200ms减少到100ms
                    return await anyCb.isChecked().catch(() => false);
                  }
                  return true;
                }
                return false;
              } catch {
                return false;
              }
            };
            const rechecked = await recheckCheckbox();
            if (rechecked) {
              console.log('[TERMS] ✓ Checkbox re-checked successfully');
              await host.waitForTimeout(300);
            } else {
              console.warn('[TERMS] Failed to re-check checkbox');
            }
          }
        }
      }
      
      if (!buttonEnabled) {
        console.warn('[TERMS] Accept and Sign button may still be disabled, will try to click anyway');
      }
      
      // 尝试点击 Accept and Sign 并验证离开 Terms 页面（最多重试 3 次）
      console.log(`[TERMS-DETAIL] [Task: ${taskId}] 🔍 Step 10: Clicking "Accept and sign" button...`);
      const buttonClickStartTime = Date.now();
      let leftTermsPage = false;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Attempt ${attempt}/${maxRetries}: Clicking button...`);
        
        // 等待页面稳定，使用安全点击
        await waitForPageStable(page, 2000);
        
        // 重新获取按钮（可能因为页面变化而失效）
        const acceptBtnRetry = host.getByRole('button', { name: /Accept and Sign/i }).first();
        const isVisible = await acceptBtnRetry.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Attempt ${attempt}: Button visible: ${isVisible}`);
        
        if (!isVisible) {
          console.warn(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Attempt ${attempt}: Button not visible, checking if still in Terms page...`);
          // 可能已经跳转了，检查一下
          const checkStillInTerms = await (async () => {
            try {
              const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
              if (/Accept Token End User Terms/i.test(text) || /TOKEN END-USER TERMS/i.test(text)) {
                return await acceptBtnRetry.isVisible({ timeout: 500 }).catch(() => false);
              }
              return false;
            } catch {
              return false;
            }
          })();
          
          if (!checkStillInTerms) {
            console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Attempt ${attempt}: Already left Terms page`);
            leftTermsPage = true;
            break;
          }
          
          if (attempt < maxRetries) {
            console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⏳ Attempt ${attempt}: Still in Terms page, waiting before retry...`);
            await page.waitForTimeout(2000);
            continue;
          }
        }
        
        // 滚动到按钮位置
        console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Attempt ${attempt}: Scrolling button into view...`);
        await acceptBtnRetry.scrollIntoViewIfNeeded().catch(() => {});
        await host.waitForTimeout(300);
        
        // 点击按钮
        const clickBtnStartTime = Date.now();
        try {
          await safeClick(page, acceptBtnRetry, { timeout: 10000, force: true, retries: 2 });
          const clickBtnTime = Date.now() - clickBtnStartTime;
          console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Attempt ${attempt}/${maxRetries}: Button clicked successfully (${clickBtnTime}ms)`);
        } catch (e) {
          const clickBtnTime = Date.now() - clickBtnStartTime;
          console.warn(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Attempt ${attempt}: Failed to click button (${clickBtnTime}ms): ${e.message}`);
          if (attempt < maxRetries) {
            await page.waitForTimeout(2000);
            continue;
          }
        }
        
        console.log(`[TERMS-DETAIL] [Task: ${taskId}]    Attempt ${attempt}: Waiting for page transition...`);
        
        // 等待并验证是否成功离开 Terms 页面（最多等待 15 秒）
        const transitionStartTime = Date.now();
        leftTermsPage = await (async () => {
          const maxWait = 15000;
          const startTime = Date.now();
          const checkInterval = 500;
          let checkCount = 0;
          
          while (Date.now() - startTime < maxWait) {
            checkCount++;
            // 检查是否还在 Terms 页面
            const stillInTerms = await (async () => {
              try {
                // 等待一下，让页面有时间跳转
                await page.waitForTimeout(300);
                
                const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
                // 检查是否还有 Terms 页面的特征文本
                if (/Accept Token End User Terms/i.test(text) || /TOKEN END-USER TERMS/i.test(text)) {
                  // 再检查是否还有 Accept and Sign 按钮（可能还没跳转）
                  const hasAcceptBtn = await host.getByRole('button', { name: /Accept and Sign/i }).first().isVisible({ timeout: 500 }).catch(() => false);
                  if (hasAcceptBtn) {
                    return true; // 还在 Terms 页面
                  }
                }
                
                // 检查所有 frame
                for (const f of page.frames()) {
                  try {
                    const frameText = await f.evaluate(() => document.body?.innerText || '').catch(() => '');
                    if (/Accept Token End User Terms/i.test(frameText) || /TOKEN END-USER TERMS/i.test(frameText)) {
                      const frameAcceptBtn = f.getByRole('button', { name: /Accept and Sign/i }).first();
                      if (await frameAcceptBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                        return true; // 还在 Terms 页面
                      }
                    }
                  } catch {}
                }
                
                return false; // 已经离开 Terms 页面
              } catch (e) {
                return false; // 检查失败，假设已离开
              }
            })();
            
            if (!stillInTerms) {
              const transitionTime = Date.now() - startTime;
              console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Attempt ${attempt}/${maxRetries}: Successfully left Terms page (${transitionTime}ms, ${checkCount} checks)`);
              await page.waitForTimeout(1000); // 额外等待 1 秒确保页面稳定
              return true;
            }
            
            if (checkCount % 4 === 0) {
              console.log(`[TERMS-DETAIL] [Task: ${taskId}] ⏳ Attempt ${attempt}: Still in Terms page (${Date.now() - startTime}ms elapsed, ${checkCount} checks)...`);
            }
            
            await page.waitForTimeout(checkInterval);
          }
          
          return false; // 超时，可能还在 Terms 页面
        })();
        
        if (leftTermsPage) {
          const totalClickTime = Date.now() - buttonClickStartTime;
          console.log(`[TERMS-DETAIL] [Task: ${taskId}] ✅ Step 10: Successfully clicked and left Terms page (${totalClickTime}ms)`);
          break; // 成功离开，退出重试循环
        } else {
          console.warn(`[TERMS-DETAIL] [Task: ${taskId}] ⚠️ Attempt ${attempt}: Still in Terms page after click, will retry...`);
          if (attempt < maxRetries) {
            await page.waitForTimeout(3000); // 等待更长时间再重试
          }
        }
      }
      
      if (!leftTermsPage) {
        const totalClickTime = Date.now() - buttonClickStartTime;
        console.error(`[TERMS-DETAIL] [Task: ${taskId}] ❌ Step 10: Failed to leave Terms page after all retries (${totalClickTime}ms)`);
        // 不立即抛出错误，先尝试继续执行，看看是否能从后续流程恢复
      }
      
      const totalTermsTime = Date.now() - termsStartTime;
      console.log(`[TERMS-DETAIL] [Task: ${taskId}] 📊 Terms page processing summary:`);
      console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Total time: ${totalTermsTime}ms`);
      console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Hex extracted: ${minedHex ? 'Yes' : 'No'}`);
      console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Signature data: ${signDataTerms ? 'Yes' : 'No'}`);
      console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Checkbox checked: ${checked ? 'Yes' : 'No'}`);
      console.log(`[TERMS-DETAIL] [Task: ${taskId}]    - Left Terms page: ${leftTermsPage ? 'Yes' : 'No'}`);
      console.log(`[TERMS-DETAIL] ========================================`);
    } catch (e) {
      const totalTermsTime = Date.now() - termsStartTime;
      console.error(`[TERMS-DETAIL] [Task: ${taskId}] ❌ CRITICAL ERROR in Terms page processing (${totalTermsTime}ms): ${e.message}`);
      console.error(`[TERMS-DETAIL] [Task: ${taskId}]    Stack: ${e.stack}`);
      console.log(`[TERMS-DETAIL] ========================================`);
      // 不抛出错误，继续执行，看看是否能从签名页面继续
    }

    // 进入签名页：若未取到 hex，再次从页面复制块中抓取
    if (!minedHex) {
      try {
        await page.waitForTimeout(200); // 优化：减少等待时间
        const text2 = await page.evaluate(() => document.body?.innerText || '');
        const m2 = text2.match(/mining\s+process:\s*([0-9a-f]{64,})/i);
        if (m2) minedHex = m2[1].toLowerCase();
      } catch {}
    }

    if (!minedHex) {
      throw new Error('Failed to extract mining process hex');
    }

    // 请求本地签名服务（如果 Terms 页面已经签名过，复用数据，避免重复请求）
    let signData;
    if (termsSigned && signDataTerms) {
      console.log('[SIGN] Reusing signature data from Terms page to avoid duplicate request');
      signData = signDataTerms;
    } else {
      signData = await signWithRateLimit(task.addr, minedHex);
    }

    // 将 publicKeyHex 和 coseSign1Hex 填入页面
    const fillIfExists = async (labelRegex, value) => {
      const byLabel = page.getByLabel(labelRegex).first();
      if (await byLabel.isVisible().catch(() => false)) {
        await byLabel.fill(value);
        return true;
      }
      const byPh = page.getByPlaceholder(labelRegex).first();
      if (await byPh.isVisible().catch(() => false)) {
        await byPh.fill(value);
        return true;
      }
      const inputNear = page.getByText(labelRegex).first().locator('..').locator('input, textarea').first();
      if (await inputNear.isVisible().catch(() => false)) {
        await inputNear.fill(value);
        return true;
      }
      return false;
    };

    // 使用优化后的统一函数填写 Public key
    console.log('[DEBUG] Filling Public key on sign page...');
    let pkFilled = await fillInputFieldOptimized(
      page,
      /public\s*key/i,
      signData.publicKeyHex,
      { inputType: 'input', verifyAfter: true }
    );
    console.log('[DEBUG] Public key filled on sign page:', pkFilled);
    
    // 使用优化后的统一函数填写 Signature
    console.log('[DEBUG] Filling Signature on sign page...');
    let sigFilled = await fillInputFieldOptimized(
      page,
      /^(\s*)signature(\s*)$/i,
      signData.coseSign1Hex,
      { inputType: 'textarea', verifyAfter: true }
    );
    console.log('[DEBUG] Signature filled on sign page:', sigFilled);
    
    // 如果填写失败，尝试在所有 frame 中填写（更积极的策略）
    let pkFilledResult = pkFilled;
    let sigFilledResult = sigFilled;
    
    if (!pkFilledResult || !sigFilledResult) {
      console.log('[DEBUG] Retrying in all frames with more aggressive strategies...');
      
      // 等待页面稳定
      await page.waitForTimeout(500);
      
      // 尝试所有 frame（包括主页面）
      const allFrames = [page, ...page.frames()];
      for (const frame of allFrames) {
        try {
          if (!pkFilledResult) {
            const result = await fillInputFieldOptimized(frame, /public\s*key/i, signData.publicKeyHex, { 
              inputType: 'input', 
              verifyAfter: false,
              timeout: 3000 
            });
            if (result) {
              console.log('[DEBUG] Public key filled successfully in frame');
              pkFilledResult = true;
            }
          }
          if (!sigFilledResult) {
            const result = await fillInputFieldOptimized(frame, /^(\s*)signature(\s*)$/i, signData.coseSign1Hex, { 
              inputType: 'textarea', 
              verifyAfter: false,
              timeout: 3000 
            });
            if (result) {
              console.log('[DEBUG] Signature filled successfully in frame');
              sigFilledResult = true;
            }
          }
          
          // 如果都填好了，立即退出，不要等待其他 frame
          if (pkFilledResult && sigFilledResult) {
            console.log('[DEBUG] Both fields filled successfully, exiting frame loop immediately');
            break;
          }
    } catch (e) {
          // 忽略单个 frame 的错误，继续尝试其他 frame
          console.warn(`[DEBUG] Error filling in frame: ${e.message}`);
        }
      }
      
      // 如果还是失败，尝试直接通过 DOM 操作填写
      if (!pkFilledResult || !sigFilledResult) {
        console.log('[DEBUG] Attempting direct DOM manipulation as last resort...');
        try {
          await page.evaluate(({ pkValue, sigValue }) => {
            // 查找所有 input 和 textarea
            const allInputs = Array.from(document.querySelectorAll('input, textarea'));
            
            // 查找 Public key 输入框
            for (const input of allInputs) {
              const label = input.closest('div, form, section')?.textContent || '';
              const placeholder = input.getAttribute('placeholder') || '';
              const ariaLabel = input.getAttribute('aria-label') || '';
              
              if (/public\s*key/i.test(label + placeholder + ariaLabel)) {
                input.value = pkValue;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                console.log('Direct DOM: Public key filled');
                break;
              }
            }
            
            // 查找 Signature 输入框
            for (const input of allInputs) {
              const label = input.closest('div, form, section')?.textContent || '';
              const placeholder = input.getAttribute('placeholder') || '';
              const ariaLabel = input.getAttribute('aria-label') || '';
              
              if (/^(\s*)signature(\s*)$/i.test(label + placeholder + ariaLabel)) {
                input.value = sigValue;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                console.log('Direct DOM: Signature filled');
                break;
              }
            }
          }, { pkValue: signData.publicKeyHex, sigValue: signData.coseSign1Hex });
          
          // 标记为已填写（即使不确定）
          pkFilledResult = true;
          sigFilledResult = true;
          console.log('[DEBUG] Direct DOM manipulation attempted');
    } catch (e) {
          console.warn(`[DEBUG] Direct DOM manipulation failed: ${e.message}`);
        }
      }
    }
    
    // 更新变量
    pkFilled = pkFilledResult;
    sigFilled = sigFilledResult;
    
    // 无论填写成功方式如何，都触发验证事件（确保页面知道值已改变）
    if (pkFilled && sigFilled) {
      console.log('[DEBUG] Triggering validation events after successful filling...');
      try {
        // 快速在所有 frame 中触发验证事件（使用 Promise.race 确保不卡住）
        const triggerEvents = async () => {
          const frames = [page, ...page.frames()];
          for (const frame of frames) {
            try {
              await Promise.race([
                frame.evaluate(() => {
                  const allInputs = Array.from(document.querySelectorAll('input, textarea'));
                  for (const input of allInputs) {
                    input.dispatchEvent(new Event('blur', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
              ]).catch(() => {});
            } catch {}
          }
        };
        
        // 最多等待1秒，然后继续（不阻塞）
        await Promise.race([
          triggerEvents(),
          new Promise((resolve) => setTimeout(resolve, 1000))
        ]).catch(() => {});
        console.log('[DEBUG] Validation events triggered');
      } catch {}
    }
    
    // 如果填写成功，直接等待一小段时间然后立即查找并点击 Sign 按钮
    if (pkFilled && sigFilled) {
      console.log('[DEBUG] Fields filled successfully, waiting briefly then proceeding to click Sign...');
      await page.waitForTimeout(800); // 给页面时间处理验证（800ms应该足够了）
    } else {
      // 如果填写失败，才进行验证和重填
      console.log('[DEBUG] Filling failed, performing quick verification...');
          await page.waitForTimeout(300);
      
      // 快速验证（最多等待1秒）
      const finalCheck = await Promise.race([
        (async () => {
          try {
            // 快速检查第一个 frame（通常Sign页面在frame中）
            if (page.frames().length > 0) {
              const frame = page.frames()[0];
              const check = await frame.evaluate(({ pkExpected, sigExpected }) => {
                let pkFound = false, sigFound = false;
                const allInputs = Array.from(document.querySelectorAll('input, textarea'));
                for (const input of allInputs) {
                  const label = input.closest('div, form, section')?.textContent || '';
                  const placeholder = input.getAttribute('placeholder') || '';
                  const ariaLabel = input.getAttribute('aria-label') || '';
                  if (/public\s*key/i.test(label + placeholder + ariaLabel) && input.value === pkExpected) pkFound = true;
                  if (/^(\s*)signature(\s*)$/i.test(label + placeholder + ariaLabel) && input.value === sigExpected) sigFound = true;
                }
                return { pkOk: pkFound, sigOk: sigFound };
              }, { pkExpected: signData.publicKeyHex, sigExpected: signData.coseSign1Hex }).catch(() => ({ pkOk: false, sigOk: false }));
              if (check.pkOk && check.sigOk) return check;
            }
            // 检查主页面
            const check = await page.evaluate(({ pkExpected, sigExpected }) => {
              let pkFound = false, sigFound = false;
              const allInputs = Array.from(document.querySelectorAll('input, textarea'));
              for (const input of allInputs) {
                const label = input.closest('div, form, section')?.textContent || '';
                const placeholder = input.getAttribute('placeholder') || '';
                const ariaLabel = input.getAttribute('aria-label') || '';
                if (/public\s*key/i.test(label + placeholder + ariaLabel) && input.value === pkExpected) pkFound = true;
                if (/^(\s*)signature(\s*)$/i.test(label + placeholder + ariaLabel) && input.value === sigExpected) sigFound = true;
              }
              return { pkOk: pkFound, sigOk: sigFound };
            }, { pkExpected: signData.publicKeyHex, sigExpected: signData.coseSign1Hex }).catch(() => ({ pkOk: false, sigOk: false }));
            return check;
          } catch {
            return { pkOk: false, sigOk: false };
          }
        })(),
        new Promise((resolve) => setTimeout(() => resolve({ pkOk: false, sigOk: false }), 1000))
      ]).catch(() => ({ pkOk: false, sigOk: false }));
      
      if ((!finalCheck.pkOk || !finalCheck.sigOk) && (!pkFilled || !sigFilled)) {
        console.log('[DEBUG] Verification failed, attempting refill...');
        if (!finalCheck.pkOk) {
          await fillInputFieldOptimized(page, /public\s*key/i, signData.publicKeyHex, { inputType: 'input', verifyAfter: false });
        }
        if (!finalCheck.sigOk) {
          await fillInputFieldOptimized(page, /^(\s*)signature(\s*)$/i, signData.coseSign1Hex, { inputType: 'textarea', verifyAfter: false });
        }
        await page.waitForTimeout(500);
      }
    }
    
    // 查找 Sign 按钮（在所有可能的位置）
    console.log('[DEBUG] Looking for Sign button to click...');
    let signBtn = null;
    let signBtnFrame = null;
    
    // 策略1: 在主页面查找
    try {
      const mainSignBtn = page.locator('button:has-text("Sign")').first();
      if (await mainSignBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        signBtn = mainSignBtn;
        signBtnFrame = page;
        console.log('[DEBUG] Found Sign button on main page');
      }
    } catch {}
    
    // 策略2: 如果主页面没找到，在所有 frame 中查找
    if (!signBtn) {
      for (const frame of page.frames()) {
        try {
          const frameSignBtn = frame.locator('button:has-text("Sign")').first();
          if (await frameSignBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            signBtn = frameSignBtn;
            signBtnFrame = frame;
            console.log('[DEBUG] Found Sign button in frame');
                break;
              }
        } catch {}
      }
    }
    
    // 策略3: 使用 role 定位
    if (!signBtn) {
      try {
        const roleSignBtn = page.getByRole('button', { name: /^sign$/i }).first();
        if (await roleSignBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          signBtn = roleSignBtn;
          signBtnFrame = page;
          console.log('[DEBUG] Found Sign button via role on main page');
        }
      } catch {}
    }
    
    if (!signBtn) {
      console.error('[DEBUG] Sign button not found! Trying to find it via evaluate...');
      // 最后尝试：通过 evaluate 查找并滚动到按钮
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /^(\s*)sign(\s*)$/i.test(b.textContent || ''));
        if (btn) {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // 尝试启用按钮
          btn.disabled = false;
          btn.removeAttribute('disabled');
          btn.setAttribute('aria-disabled', 'false');
        }
      }).catch(() => {});
      
      // 再次尝试查找
      signBtn = page.locator('button:has-text("Sign")').first();
      signBtnFrame = page;
    }
    
    if (signBtn) {
      // 检查按钮是否禁用，如果禁用尝试启用
      try {
        const isDisabled = await signBtn.isDisabled().catch(() => true);
        if (isDisabled) {
          console.log('[DEBUG] Sign button is disabled, attempting to enable it...');
          await (signBtnFrame || page).evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /^(\s*)sign(\s*)$/i.test(b.textContent || ''));
            if (btn) {
              btn.disabled = false;
              btn.removeAttribute('disabled');
              btn.setAttribute('aria-disabled', 'false');
            }
          }).catch(() => {});
          await page.waitForTimeout(300);
        }
      } catch {}
      
      // 点击 Sign 按钮
      console.log('[DEBUG] Attempting to click Sign button...');
      await waitForPageStable(page, 2000);
      const beforeClickUrl = page.url();
      
      try {
        // 使用找到的 frame 或主页面进行点击
        const targetPage = signBtnFrame || page;
        await safeClick(targetPage, signBtn, { timeout: 10000, force: true, retries: 3 });
        console.log('[DEBUG] Sign button clicked successfully!');
        } catch (e) {
        // 如果失败，尝试直接点击
        console.warn(`[SAFE-CLICK] Sign button click failed, trying direct click: ${e.message}`);
        try {
          await signBtn.click({ force: true, timeout: 5000 });
          console.log('[DEBUG] Sign button clicked via direct click!');
        } catch (e2) {
          // 如果还是失败，尝试使用 role 定位在正确的 frame 中
          console.warn(`[SAFE-CLICK] Direct click also failed, trying role method: ${e2.message}`);
          const targetPage = signBtnFrame || page;
          const btn2 = targetPage.getByRole('button', { name: /^sign$/i }).first();
          if (await btn2.isVisible({ timeout: 3000 }).catch(() => false)) {
            await safeClick(targetPage, btn2, { timeout: 10000, force: true, retries: 2 });
          } else {
            // 如果还是找不到，在所有 frame 中尝试
            for (const frame of page.frames()) {
              try {
                const frameBtn = frame.getByRole('button', { name: /^sign$/i }).first();
                if (await frameBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                  await safeClick(frame, frameBtn, { timeout: 10000, force: true, retries: 2 });
                  console.log('[DEBUG] Sign button clicked in alternative frame!');
                  break;
                }
              } catch {}
            }
          }
        }
      }
      
      // 等待一下看是否有页面变化或错误
      await page.waitForTimeout(2000);
      const afterClickUrl = page.url();
      console.log('[DEBUG] URL before click:', beforeClickUrl);
      console.log('[DEBUG] URL after click:', afterClickUrl);
    } else {
      console.error('[DEBUG] Sign button not found after all attempts!');
      throw new Error('Sign button not found on sign page');
    }
    
    // 检查是否被重定向到 429 错误页面（只有 429 才需要 disconnect）
    const signClickErrorPageCheck = await checkIfErrorPage(page);
    if (signClickErrorPageCheck.isErrorPage && signClickErrorPageCheck.errorCode === '429') {
      console.warn(`[429-ERROR] Detected 429 error page after Sign click: ${signClickErrorPageCheck.url}`);
      const handled = await handleErrorPage(page, BASE_URL);
      if (handled) {
        await page.waitForTimeout(2000);
        // 如果重置成功，检查是否在初始状态
        const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 3000 }).catch(() => false);
        if (isReset) {
          console.log('[429-ERROR] Page reset after Sign click, needs to restart from beginning');
          throw new Error('429 error page detected after Sign click and reset, restart from beginning');
        }
      }
    }
    
    // 检查是否有错误信息（包括速率限制错误）
    const rateLimitCheck = await checkPageForRateLimitError(page);
    if (rateLimitCheck.hasError) {
      console.warn(`[RATE-LIMIT] Rate limit error detected after Sign click: ${rateLimitCheck.errorText}`);
      console.log(`[RATE-LIMIT] Waiting for rate limit to clear (max 20s)...`);
      const cleared = await waitForRateLimitErrorToClear(page, 20000, 3000, BASE_URL);
      if (!cleared) {
        // 如果仍有错误，检查是否在 429 错误页面（只有 429 才需要 disconnect）
        const finalErrorPageCheck = await checkIfErrorPage(page);
        if (finalErrorPageCheck.isErrorPage && finalErrorPageCheck.errorCode === '429') {
          console.log(`[429-ERROR] Still on 429 error page after waiting, attempting recovery via disconnect...`);
          const handled = await handleErrorPage(page, BASE_URL);
          if (handled) {
            await page.waitForTimeout(2000);
            // 检查是否重置成功
            const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 3000 }).catch(() => false);
            if (isReset) {
              console.log('[ERROR-PAGE] Page reset after waiting, needs to restart from beginning');
              throw new Error('Error page detected after waiting and reset, restart from beginning');
            }
          }
        } else {
          // 尝试刷新页面
          console.log(`[RATE-LIMIT] Rate limit persists, refreshing page...`);
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
            
            // 刷新后检查是否跳转到错误页面
            const afterRefreshErrorCheck = await checkIfErrorPage(page);
            if (afterRefreshErrorCheck.isErrorPage) {
              await handleErrorPage(page, BASE_URL);
              await page.waitForTimeout(2000);
            }
            
            const afterReloadCheck = await checkPageForRateLimitError(page);
            if (afterReloadCheck.hasError) {
              // 即使刷新后还有错误，也继续执行
              console.warn(`[RATE-LIMIT] Error persists after refresh, but continuing anyway...`);
            }
          } catch (reloadError) {
            console.warn(`[RATE-LIMIT] Failed to refresh: ${reloadError.message}, continuing...`);
          }
        }
      }
    }
    
    // 检查其他错误信息
    const errorMsg = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[role="alert"], .error, .error-message, [class*="error"]');
      for (const el of errorEls) {
        const text = el.textContent || '';
        // 排除速率限制错误（已处理）
        if (text.trim().length > 0 && !/too many|rate limit/i.test(text)) {
          return text.trim();
        }
      }
      return null;
    }).catch(() => null);
    if (errorMsg) {
      console.log('[DEBUG] Page error detected:', errorMsg);
    }

    // 等待页面跳转或 Start 按钮出现（更灵活的方式）
    console.log('[DEBUG] Waiting for Start button or page navigation...');
    
    // 在等待过程中定期检查速率限制错误和429错误页面
    const waitForStartWithRateLimitCheck = async (maxWaitMs = 30000) => {
      const startTime = Date.now();
      const checkInterval = 2000; // 每2秒检查一次
      
      while (Date.now() - startTime < maxWaitMs) {
        // 首先检查是否在 429 错误页面（只有 429 才需要 disconnect）
        const errorPageCheck = await checkIfErrorPage(page);
        if (errorPageCheck.isErrorPage && errorPageCheck.errorCode === '429') {
          console.warn(`[429-ERROR] Detected 429 error page while waiting for Start button: ${errorPageCheck.url}`);
          const handled = await handleErrorPage(page, BASE_URL);
          if (handled) {
            await page.waitForTimeout(2000);
            // 如果重置成功，检查是否在初始状态
            const isReset = await page.getByText('Enter an address manually', { exact: true }).isVisible({ timeout: 3000 }).catch(() => false);
            if (isReset) {
              console.log('[429-ERROR] Page reset while waiting for Start, needs to restart from beginning');
              throw new Error('429 error page detected and reset, restart from beginning');
            }
          }
        }
        
        // 检查速率限制错误
        const check = await checkPageForRateLimitError(page, 1);
        if (check.hasError) {
          console.warn(`[RATE-LIMIT] Rate limit error detected while waiting for Start button: ${check.errorText}`);
          const cleared = await waitForRateLimitErrorToClear(page, 20000, 3000, BASE_URL);
          if (!cleared) {
            throw new Error(`Rate limit error while waiting for Start button: ${check.errorText}`);
          }
        }
        
        // 检查 Start 按钮是否出现
        const startButtonFound = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => /^(\s*)start(\s*)$/i.test(b.textContent || ''));
          return !!btn;
        }).catch(() => false);
        
        if (startButtonFound) {
          return true;
        }
        
        // ⚠️ 关键修复：检查是否已经进入挖矿状态（Stop session按钮、"Finding a solution"状态）
        const miningStateCheck = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          // 检查是否有Stop session按钮
          const hasStopButton = Array.from(document.querySelectorAll('button')).some(b => {
            const text = b.textContent?.trim().toLowerCase();
            return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
          });
          // 检查是否有"Finding a solution"状态
          const hasFindingSolution = bodyText.includes('finding a solution') || bodyText.includes('finding');
          // 检查是否有"Solve cryptographic challenges"标题
          const hasSolveCryptoTitle = bodyText.includes('solve cryptographic challenges');
          // 检查Miner status是否为ACTIVE
          const hasActiveStatus = bodyText.includes('miner status') && bodyText.includes('active');
          
          return {
            hasStopButton,
            hasFindingSolution,
            hasSolveCryptoTitle,
            hasActiveStatus,
            isMining: hasStopButton && (hasFindingSolution || hasActiveStatus) && hasSolveCryptoTitle
          };
        }).catch(() => ({ isMining: false }));
        
        if (miningStateCheck.isMining) {
          console.log('[DEBUG] ✅ Detected mining state after Sign click: Stop session button and "Finding a solution" status found');
          console.log(`[DEBUG]    - Stop button: ${miningStateCheck.hasStopButton}`);
          console.log(`[DEBUG]    - Finding solution: ${miningStateCheck.hasFindingSolution}`);
          console.log(`[DEBUG]    - Solve crypto title: ${miningStateCheck.hasSolveCryptoTitle}`);
          console.log(`[DEBUG]    - Active status: ${miningStateCheck.hasActiveStatus}`);
          return 'mining'; // 返回特殊值表示已进入挖矿状态
        }
        
        await page.waitForTimeout(checkInterval);
      }
      
      return false;
    };
    
    // 等待网络请求完成（Sign 可能触发提交）
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    
    // 等待 Start 按钮出现或进入挖矿状态（带速率限制检查）
    const waitResult = await waitForStartWithRateLimitCheck(30000).catch(() => {
      console.warn('[DEBUG] Start button not found within timeout, continuing...');
      return false;
    });
    
    // 如果已经进入挖矿状态，直接返回成功
    if (waitResult === 'mining') {
      console.log('[DEBUG] ✅ Already in mining state, skipping Start button click');
      // 标记为已登录状态
      if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
        if (taskStats.loggingIn > 0) {
          taskStats.loggingIn--;
        }
        taskStats.loggedIn++;
      }
      // 直接返回，不需要点击Start按钮
      return;
    }
    
    // ⚠️ 检查是否已到达start session页面（已登录状态）
    // 已登录状态的定义：页面显示出"Solve cryptographic challenges"且页面里包含start session或stop session按钮
    const isLoggedInPage = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      // 检查是否显示"Solve cryptographic challenges"
      const hasSolveCryptoText = bodyText.includes('solve cryptographic challenges');
      
      if (!hasSolveCryptoText) {
        return false;
      }
      
      // 检查是否有start session或stop session按钮
      const allButtons = Array.from(document.querySelectorAll('button'));
      const hasStartButton = allButtons.some(b => {
        const text = b.textContent?.trim().toLowerCase();
        return (text === 'start' || text === 'start session') && b.offsetParent !== null;
      });
      const hasStopButton = allButtons.some(b => {
        const text = b.textContent?.trim().toLowerCase();
        return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
      });
      
      return hasStartButton || hasStopButton;
    }).catch(() => false);
    
    if (isLoggedInPage) {
      // 已到达start session页面（显示"Solve cryptographic challenges"且有start/stop按钮），从"登录阶段"转为"已登录状态"
      if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
        if (taskStats.loggingIn > 0) {
          taskStats.loggingIn--;
        }
        taskStats.loggedIn++;
        
        // ⚠️ 记录登录完成时间（到达start session页面的时间）
        const timer = taskStats.taskTimers.get(task.id);
        if (timer && timer.pageOpenTime) {
          timer.loginCompleteTime = Date.now();
          const loginTime = (timer.loginCompleteTime - timer.pageOpenTime) / 1000; // 转换为秒
          taskStats.loginTimes.push(loginTime);
          console.log(`[STATS] 📝 Task ${task.id} logged in (reached "Solve cryptographic challenges" page, Logged In: ${taskStats.loggedIn}, Login Time: ${loginTime.toFixed(2)}s)`);
        } else {
          console.log(`[STATS] 📝 Task ${task.id} logged in (reached "Solve cryptographic challenges" page, Logged In: ${taskStats.loggedIn})`);
        }
      }
    }
    
    // 点击 Start 按钮（多种策略，失败也不抛出错误，因为监控脚本会在后台自动处理）
    let startClicked = false;
    const startBtn = page.locator('button:has-text("Start")').first();
    // 等待页面稳定，使用安全点击
    await waitForPageStable(page, 2000);
    
    // ⚠️ 在点击 start 按钮前，检查页面状态
    // 如果页面已经是 "waiting for the next challenge"，不应该记录 miningStartTime
    const checkPageStatusBeforeStart = async () => {
      try {
        const bodyText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).toLowerCase();
        const bodyHTML = (await page.evaluate(() => document.body?.innerHTML || '').catch(() => '')).toLowerCase();
        const allText = bodyText + ' ' + bodyHTML;
        return {
          hasWaitingForNextChallenge: allText.includes('waiting for the next challenge'),
          hasFindingSolution: allText.includes('finding a solution'),
        };
      } catch (e) {
        return { hasWaitingForNextChallenge: false, hasFindingSolution: false };
      }
    };
    
    const pageStatusBeforeStart = await checkPageStatusBeforeStart();
    
    if (await startBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      try {
        // ⚠️ 点击start按钮前，离开"已登录状态"
        if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
          if (taskStats.loggedIn > 0) {
            taskStats.loggedIn--;
          }
          
          // ⚠️ 重要：只有当页面不是 "waiting for the next challenge" 时才记录挖矿开始时间
          // 如果点击 start 时已经是 "waiting for the next challenge"，说明任务已完成，不计入挖矿时间统计
          const timer = taskStats.taskTimers.get(task.id);
          if (timer && !pageStatusBeforeStart.hasWaitingForNextChallenge) {
            // 页面不是 "waiting for the next challenge"，正常记录挖矿开始时间
            // 但实际开始时间应该是状态变为 "finding a solution" 时，这里先不记录
            // 将在状态检测时记录（当状态变为 "finding a solution" 时）
            timer.miningStartTime = undefined; // 先设置为 undefined，等待状态变为 "finding a solution" 时再记录
          } else if (timer && pageStatusBeforeStart.hasWaitingForNextChallenge) {
            // 页面已经是 "waiting for the next challenge"，明确设置为 null，表示不计入统计
            timer.miningStartTime = null;
            console.log(`[STATS] ℹ️ Task ${task.id} page already shows "waiting for the next challenge", skipping mining time tracking`);
          }
        }
        // EC2 上增加超时和重试次数
        await safeClick(page, startBtn, { timeout: 15000, force: true, retries: 5 });
        console.log('[DEBUG] Start button clicked successfully!');
        startClicked = true;
      } catch (e) {
        console.log('[DEBUG] Failed to click Start button (method 1):', String(e));
      }
    }
    
    if (!startClicked) {
      // 尝试用 role 定位
      try {
        // ⚠️ 点击start按钮前（如果还未点击），离开"已登录状态"
        if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
          if (taskStats.loggedIn > 0 && !startClicked) {
            taskStats.loggedIn--;
          }
          
          // ⚠️ 重要：只有当页面不是 "waiting for the next challenge" 时才记录挖矿开始时间
          const timer = taskStats.taskTimers.get(task.id);
          if (timer && !timer.miningStartTime && !pageStatusBeforeStart.hasWaitingForNextChallenge) {
            // 页面不是 "waiting for the next challenge"，先设置为 undefined，等待状态变为 "finding a solution" 时再记录
            timer.miningStartTime = undefined;
          } else if (timer && pageStatusBeforeStart.hasWaitingForNextChallenge) {
            // 页面已经是 "waiting for the next challenge"，明确设置为 null
            timer.miningStartTime = null;
            console.log(`[STATS] ℹ️ Task ${task.id} page already shows "waiting for the next challenge", skipping mining time tracking`);
          }
        }
        // 等待更长时间让页面完全加载
        await page.waitForTimeout(2000);
        const startBtnRole = page.getByRole('button', { name: /^start$/i });
        // EC2 上增加超时和重试次数
        await safeClick(page, startBtnRole, { timeout: 15000, force: true, retries: 5 });
        console.log('[DEBUG] Start button clicked via role!');
        startClicked = true;
      } catch (e) {
        console.log('[DEBUG] Failed to click Start button (method 2):', String(e));
      }
    }
    
    if (!startClicked) {
      console.log('[WARN] Could not click Start button initially, monitor will auto-click when session starts');
    }

    // 任务完成前：检查是否成功建立了挖矿 session（是否有 Start/Stop 按钮）
    const checkMiningSessionEstablished = async () => {
      try {
        await page.waitForTimeout(5000); // EC2 上增加等待时间，等待页面稳定
        
        // ⚠️ 关键修复：首先检查是否已经进入挖矿状态（Stop session按钮、"Finding a solution"状态）
        const miningStateCheck = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const hasStopButton = Array.from(document.querySelectorAll('button')).some(b => {
            const text = b.textContent?.trim().toLowerCase();
            return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
          });
          const hasFindingSolution = bodyText.includes('finding a solution') || bodyText.includes('finding');
          const hasSolveCryptoTitle = bodyText.includes('solve cryptographic challenges');
          const hasActiveStatus = bodyText.includes('miner status') && bodyText.includes('active');
          
          return {
            hasStopButton,
            hasFindingSolution,
            hasSolveCryptoTitle,
            hasActiveStatus,
            isMining: hasStopButton && (hasFindingSolution || hasActiveStatus) && hasSolveCryptoTitle
          };
        }).catch(() => ({ isMining: false }));
        
        if (miningStateCheck.isMining) {
          console.log('[SESSION-CHECK] ✅ Already in mining state: Stop session button and "Finding a solution" status found');
          console.log(`[SESSION-CHECK]    - Stop button: ${miningStateCheck.hasStopButton}`);
          console.log(`[SESSION-CHECK]    - Finding solution: ${miningStateCheck.hasFindingSolution}`);
          console.log(`[SESSION-CHECK]    - Solve crypto title: ${miningStateCheck.hasSolveCryptoTitle}`);
          console.log(`[SESSION-CHECK]    - Active status: ${miningStateCheck.hasActiveStatus}`);
          return true; // 已经进入挖矿状态，session已建立
        }
        
        // 首先检查是否还在 Terms 页面（如果是，说明没有成功离开）
        const stillInTerms = await (async () => {
          try {
            const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
            if (/Accept Token End User Terms/i.test(text) || /TOKEN END-USER TERMS/i.test(text)) {
              // 检查是否还有 Accept and Sign 按钮
              const hasAcceptBtn = await page.getByRole('button', { name: /Accept and Sign/i }).first().isVisible({ timeout: 500 }).catch(() => false);
              if (hasAcceptBtn) {
                return true; // 还在 Terms 页面
              }
            }
            
            // 检查所有 frame
            for (const f of page.frames()) {
              try {
                const frameText = await f.evaluate(() => document.body?.innerText || '').catch(() => '');
                if (/Accept Token End User Terms/i.test(frameText) || /TOKEN END-USER TERMS/i.test(frameText)) {
                  const frameAcceptBtn = f.getByRole('button', { name: /Accept and Sign/i }).first();
                  if (await frameAcceptBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                    return true; // 还在 Terms 页面
                  }
                }
              } catch {}
            }
            
            return false;
          } catch (e) {
            return false;
          }
        })();
        
        // ⚠️ 检查页面状态
        if (isPageClosed(page)) {
          console.warn('[SESSION-CHECK] ⚠️ Page closed, cannot check session status');
          throw new Error('Page closed during session check');
        }
        
        // 首先检查是否有 Start/Stop 按钮（挖矿 session）- 这是最重要的检查
        // 如果有 session，说明已经成功完成了流程，不需要检查是否在 Terms 页面
        const hasSession = await safePageOperation(page, async () => {
          return await page.evaluate(() => {
            const allButtons = Array.from(document.querySelectorAll('button'));
            const hasStart = allButtons.some(b => {
              const text = b.textContent?.trim().toLowerCase();
              return (text === 'start' || text === 'start session') && b.offsetParent !== null;
            });
            const hasStop = allButtons.some(b => {
              const text = b.textContent?.trim().toLowerCase();
              return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
            });
            return hasStart || hasStop; // 有 Start 或 Stop 按钮表示 session 已建立
          });
        }, 'Check session status').catch(() => false);
        
        if (hasSession) {
          console.log('[SESSION-CHECK] ✓ Mining session established successfully (Start/Stop buttons found)');
          // ⚠️ 重要：有 session 不代表任务完成，需要检查状态
          // 只有当状态显示为 "waiting for the next challenge" 时，task 才算作 completed
          // 如果状态是 "finding a solution"，表示正在挖矿，需要继续等待
          
          // ⚠️ 检查页面状态
          if (isPageClosed(page)) {
            console.warn('[SESSION-CHECK] ⚠️ Page closed, cannot check current status');
            throw new Error('Page closed during status check');
          }
          
          // 检查当前状态
          const currentStatus = await safePageOperation(page, async () => {
            return await page.evaluate(() => {
              const bodyText = (document.body?.innerText || '').toLowerCase();
              if (bodyText.includes('waiting for the next challenge')) {
                return 'waiting for the next challenge'; // ✅ 任务已完成
              } else if (bodyText.includes('finding a solution') || bodyText.includes('finding')) {
                return 'finding a solution'; // ⛏️ 任务正在进行中（挖矿中）
              }
              return 'unknown';
            });
          }, 'Check current status').catch(() => 'unknown');
          
          if (currentStatus === 'waiting for the next challenge') {
            // ⚠️ 记录挖矿完成时间（状态变成waiting for the next challenge的时间）
            if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
              const timer = taskStats.taskTimers.get(task.id);
              if (timer && timer.miningStartTime && !timer.miningCompleteRecorded) {
                const miningCompleteTime = Date.now();
                const miningTime = (miningCompleteTime - timer.miningStartTime) / 1000; // 转换为秒
                taskStats.miningTimes.push(miningTime);
                timer.miningCompleteRecorded = true; // 标记已记录，避免重复记录
                console.log(`[SESSION-CHECK] ✓ Task ${task.id} completed: Status is "waiting for the next challenge" (Mining Time: ${miningTime.toFixed(2)}s)`);
              } else {
                console.log('[SESSION-CHECK] ✓ Task completed: Status is "waiting for the next challenge"');
              }
            } else {
              console.log('[SESSION-CHECK] ✓ Task completed: Status is "waiting for the next challenge"');
            }
            return; // 任务已完成
          } else if (currentStatus === 'finding a solution') {
            console.log('[SESSION-CHECK] ⏳ Task is mining: Status is "finding a solution", waiting for "waiting for the next challenge"...');
            console.log('[SESSION-CHECK] ℹ️ No timeout set - will wait until status changes (mining difficulty varies by cycle)');
            // ⚠️ 更新统计：任务已开始挖矿
            if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
              // ⚠️ 重要：只有当状态变为 "finding a solution" 时才记录挖矿开始时间
              // 如果 miningStartTime 是 undefined（点击 start 时还不是 waiting 状态），现在记录
              // 如果 miningStartTime 是 null（点击 start 时已经是 waiting 状态），不记录
              const timer = taskStats.taskTimers.get(task.id);
              if (timer && timer.miningStartTime === undefined) {
                // 状态变为 "finding a solution"，记录挖矿开始时间
                timer.miningStartTime = Date.now();
                console.log(`[STATS] 📊 Task ${task.id} mining start time recorded (status changed to "finding a solution")`);
              } else if (timer && timer.miningStartTime === null) {
                // miningStartTime 为 null，说明点击 start 时已经是 waiting 状态，不计入统计
                console.log(`[STATS] ℹ️ Task ${task.id} status changed to "finding a solution" but was already completed, skipping mining time tracking`);
              }
              
              taskStats.miningStarted++;
              console.log(`[STATS] ⛏️ Task ${task.id} started mining (Active Mining: ${taskStats.miningStarted})`);
            }
            // ⚠️ 不设置超时时间，因为不同周期的挖矿难度不一样，可能很快也可能很慢
            // 持续等待直到状态变成 "waiting for the next challenge"
            // 使用轮询方式持续检查状态（每2秒检查一次）
            while (true) {
              // ⚠️ 检查页面状态
              if (isPageClosed(page)) {
                console.warn('[SESSION-CHECK] ⚠️ Page closed during status polling, aborting');
                throw new Error('Page closed during status polling');
              }
              
              const status = await safePageOperation(page, async () => {
                return await page.evaluate(() => {
                  const bodyText = (document.body?.innerText || '').toLowerCase();
                  return bodyText.includes('waiting for the next challenge') ? 'completed' : 
                         (bodyText.includes('finding a solution') || bodyText.includes('finding')) ? 'mining' : 'unknown';
                });
              }, 'Poll status').catch(() => 'unknown');
              
              if (status === 'completed') {
                // ⚠️ 记录挖矿完成时间（状态变成waiting for the next challenge的时间）
                if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
                  const timer = taskStats.taskTimers.get(task.id);
                  if (timer && timer.miningStartTime && !timer.miningCompleteRecorded) {
                    const miningCompleteTime = Date.now();
                    const miningTime = (miningCompleteTime - timer.miningStartTime) / 1000; // 转换为秒
                    taskStats.miningTimes.push(miningTime);
                    timer.miningCompleteRecorded = true; // 标记已记录，避免重复记录
                    console.log(`[SESSION-CHECK] ✓ Task ${task.id} completed: Status changed to "waiting for the next challenge" (Mining Time: ${miningTime.toFixed(2)}s)`);
                  } else {
                    console.log('[SESSION-CHECK] ✓ Task completed: Status changed to "waiting for the next challenge"');
                  }
                } else {
                  console.log('[SESSION-CHECK] ✓ Task completed: Status changed to "waiting for the next challenge"');
                }
                return; // 任务已完成
              } else if (status !== 'mining') {
                // 状态异常（既不是mining也不是completed），记录日志但继续等待
                console.warn(`[SESSION-CHECK] ⚠️ Unexpected status: ${status}, continuing to wait...`);
              }
              
              // 等待2秒后再次检查
              // ⚠️ 使用安全等待，检查页面状态
              if (isPageClosed(page)) {
                console.warn('[SESSION-CHECK] ⚠️ Page closed during wait, aborting');
                throw new Error('Page closed during wait');
              }
              await safePageOperation(page, async () => {
                await page.waitForTimeout(2000);
              }, 'Wait for next status check').catch(() => {
                // 如果等待时页面关闭，退出循环
                throw new Error('Page closed during wait');
              });
            }
          } else {
            console.log('[SESSION-CHECK] ✓ Session established, but status unknown. Task initialized successfully.');
            // session 已建立，虽然没有检测到明确状态，但至少流程走完了
            return;
          }
        }
        
        // 如果没有 session，才检查是否还在 Terms 页面
        if (stillInTerms) {
          console.error('[SESSION-CHECK] Still in Terms page and no mining session found! Attempting to recover...');
          
          // 策略1: 尝试使用 Reset session 按钮恢复
          console.log('[SESSION-CHECK] Trying Reset session button first...');
          const resetSuccess = await resetSessionAndReturn(page);
          if (resetSuccess) {
            console.log('[SESSION-CHECK] ✓ Successfully reset via Reset session, task will restart from beginning');
            throw new Error('Reset via Reset session, task needs to restart from beginning');
          }
          
          // 策略2: 尝试最后一次点击 "Accept and Sign" 按钮
          try {
            const acceptBtn = page.getByRole('button', { name: /Accept and Sign/i }).first();
            if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              console.log('[SESSION-CHECK] Found "Accept and Sign" button, attempting final click...');
              await waitForPageStable(page, 2000);
              await safeClick(page, acceptBtn, { timeout: 10000, force: true, retries: 2 });
              
              // 等待 10 秒看是否离开 Terms 页面或建立了 session
              await page.waitForTimeout(10000);
              
              // 再次检查是否有 session（优先）
              const hasSessionAfterRetry = await page.evaluate(() => {
                const allButtons = Array.from(document.querySelectorAll('button'));
                const hasStart = allButtons.some(b => {
                  const text = b.textContent?.trim().toLowerCase();
                  return (text === 'start' || text === 'start session') && b.offsetParent !== null;
                });
                const hasStop = allButtons.some(b => {
                  const text = b.textContent?.trim().toLowerCase();
                  return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
                });
                return hasStart || hasStop;
              }).catch(() => false);
              
              if (hasSessionAfterRetry) {
                console.log('[SESSION-CHECK] ✓ Mining session established after retry!');
                // ⚠️ 重要：检查状态，只有当状态是 "waiting for the next challenge" 才算完成
                const currentStatusAfterRetry = await page.evaluate(() => {
                  const bodyText = (document.body?.innerText || '').toLowerCase();
                  if (bodyText.includes('waiting for the next challenge')) {
                    return 'waiting for the next challenge';
                  } else if (bodyText.includes('finding a solution') || bodyText.includes('finding')) {
                    return 'finding a solution';
                  }
                  return 'unknown';
                }).catch(() => 'unknown');
                
                if (currentStatusAfterRetry === 'waiting for the next challenge') {
                  // ⚠️ 记录挖矿完成时间（重试后状态是waiting for the next challenge）
                  if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
                    const timer = taskStats.taskTimers.get(task.id);
                    if (timer && timer.miningStartTime && !timer.miningCompleteRecorded) {
                      const miningCompleteTime = Date.now();
                      const miningTime = (miningCompleteTime - timer.miningStartTime) / 1000; // 转换为秒
                      taskStats.miningTimes.push(miningTime);
                      timer.miningCompleteRecorded = true;
                      console.log(`[SESSION-CHECK] ✓ Task ${task.id} completed after retry: Status is "waiting for the next challenge" (Mining Time: ${miningTime.toFixed(2)}s)`);
                    } else {
                      console.log('[SESSION-CHECK] ✓ Task completed after retry: Status is "waiting for the next challenge"');
                    }
                  } else {
                    console.log('[SESSION-CHECK] ✓ Task completed after retry: Status is "waiting for the next challenge"');
                  }
                  return; // 任务已完成
                } else if (currentStatusAfterRetry === 'finding a solution') {
                  console.log('[SESSION-CHECK] ⏳ Task is mining after retry: Status is "finding a solution", waiting for "waiting for the next challenge"...');
                  console.log('[SESSION-CHECK] ℹ️ No timeout set - will wait until status changes (mining difficulty varies by cycle)');
                  // ⚠️ 更新统计：任务已开始挖矿
                  if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
                    taskStats.miningStarted++;
                    console.log(`[STATS] ⛏️ Task ${task.id} started mining after retry (Active Mining: ${taskStats.miningStarted})`);
                  }
                  // ⚠️ 不设置超时时间，因为不同周期的挖矿难度不一样，可能很快也可能很慢
                  // 持续等待直到状态变成 "waiting for the next challenge"
                  // 使用轮询方式持续检查状态（每2秒检查一次）
                  while (true) {
                    const status = await page.evaluate(() => {
                      const bodyText = (document.body?.innerText || '').toLowerCase();
                      return bodyText.includes('waiting for the next challenge') ? 'completed' : 
                             (bodyText.includes('finding a solution') || bodyText.includes('finding')) ? 'mining' : 'unknown';
                    }).catch(() => 'unknown');
                    
                    if (status === 'completed') {
                      // ⚠️ 记录挖矿完成时间（重试后轮询中状态变成waiting for the next challenge）
                      if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
                        const timer = taskStats.taskTimers.get(task.id);
                        if (timer && timer.miningStartTime && !timer.miningCompleteRecorded) {
                          const miningCompleteTime = Date.now();
                          const miningTime = (miningCompleteTime - timer.miningStartTime) / 1000; // 转换为秒
                          taskStats.miningTimes.push(miningTime);
                          timer.miningCompleteRecorded = true;
                          console.log(`[SESSION-CHECK] ✓ Task ${task.id} completed after retry: Status changed to "waiting for the next challenge" (Mining Time: ${miningTime.toFixed(2)}s)`);
                        } else {
                          console.log('[SESSION-CHECK] ✓ Task completed after retry: Status changed to "waiting for the next challenge"');
                        }
                      } else {
                        console.log('[SESSION-CHECK] ✓ Task completed after retry: Status changed to "waiting for the next challenge"');
                      }
                      return; // 任务已完成
                    } else if (status !== 'mining') {
                      // 状态异常（既不是mining也不是completed），记录日志但继续等待
                      console.warn(`[SESSION-CHECK] ⚠️ Unexpected status after retry: ${status}, continuing to wait...`);
                    }
                    
                    // 等待2秒后再次检查
                    await page.waitForTimeout(2000);
                  }
                } else {
                  console.log('[SESSION-CHECK] ✓ Session established after retry, but status unknown. Task initialized successfully.');
                  return; // session 已建立，至少流程走完了
                }
              }
              
              // 再次检查是否还在 Terms 页面
              const stillInTermsAfterRetry = await (async () => {
                try {
                  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
                  if (/Accept Token End User Terms/i.test(text) || /TOKEN END-USER TERMS/i.test(text)) {
                    return await acceptBtn.isVisible({ timeout: 500 }).catch(() => false);
                  }
                  return false;
                } catch {
                  return false;
                }
              })();
              
              if (stillInTermsAfterRetry) {
                console.error('[SESSION-CHECK] Still in Terms page after final retry, task failed');
                throw new Error('Still in Terms page, failed to complete the flow even after retries');
              } else {
                console.log('[SESSION-CHECK] ✓ Successfully left Terms page after final retry, but no session yet');
                // 已经离开 Terms 页面，但还没有 session，可能流程还在进行中
                // 不抛出错误，继续后续检查
              }
            } else {
              throw new Error('Still in Terms page, but "Accept and Sign" button not found');
          }
        } catch (e) {
            console.error(`[SESSION-CHECK] Recovery attempt failed: ${e.message}`);
            throw new Error('Still in Terms page, failed to complete the flow');
          }
        }
        
        // 如果既没有 session 也不在 Terms 页面，检查是否在其他错误状态
        if (!hasSession) {
          console.error('[SESSION-CHECK] Mining session not established (no Start/Stop buttons found)!');
          // 没有建立 session，抛出错误，让任务标记为失败
          throw new Error('Mining session not established - no Start/Stop buttons found');
        }
      } catch (e) {
        console.error(`[SESSION-CHECK] Error: ${e.message}`);
        throw e; // 重新抛出错误，让任务标记为失败
      }
    };
    
    // ⚠️ 如果只是初始化模式，跳过session完成检查，直接注册到scheduler
    if (initOnly && scheduler) {
      // 验证是否已到达"Solve cryptographic challenges"页面（有start session按钮）
      const hasStartButton = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        // 检查是否显示"Solve cryptographic challenges"
        const hasSolveCryptoText = bodyText.includes('solve cryptographic challenges');
        
        if (!hasSolveCryptoText) {
          return false;
        }
        
        // 检查是否有start session按钮
        const allButtons = Array.from(document.querySelectorAll('button'));
        const hasStart = allButtons.some(b => {
          const text = b.textContent?.trim().toLowerCase();
          return (text === 'start' || text === 'start session') && b.offsetParent !== null && !b.disabled;
        });
        return hasStart;
      }).catch(() => false);
      
      if (hasStartButton) {
        console.log(`[INIT] Task ${task.id} initialized, registering with scheduler (not starting mining)`);
        await scheduler.addTask(task.id, page, browser, context);
      } else {
        // 如果还没有到达start session页面，等待并检查一次session状态（但不等待完成）
        console.log(`[INIT] Task ${task.id} not yet at start session page, checking session establishment...`);
        // 只检查session是否建立，不等待完成
        const sessionEstablished = await page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button'));
          const hasStart = allButtons.some(b => {
            const text = b.textContent?.trim().toLowerCase();
            return (text === 'start' || text === 'start session') && b.offsetParent !== null;
          });
          const hasStop = allButtons.some(b => {
            const text = b.textContent?.trim().toLowerCase();
            return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
          });
          return hasStart || hasStop;
        }).catch(() => false);
        
        if (sessionEstablished) {
          console.log(`[INIT] Task ${task.id} initialized (session established), registering with scheduler (not starting mining)`);
          await scheduler.addTask(task.id, page, browser, context);
        } else {
          // 如果session还没建立，等待更长时间后再次检查（EC2 上需要更长时间）
          console.log(`[INIT] Task ${task.id} session not established, waiting 15s before final check...`);
          await page.waitForTimeout(15000);
          const sessionEstablishedAfterWait = await page.evaluate(() => {
            const allButtons = Array.from(document.querySelectorAll('button'));
            const hasStart = allButtons.some(b => {
              const text = b.textContent?.trim().toLowerCase();
              return (text === 'start' || text === 'start session') && b.offsetParent !== null;
            });
            const hasStop = allButtons.some(b => {
              const text = b.textContent?.trim().toLowerCase();
              return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
            });
            return hasStart || hasStop;
          }).catch(() => false);
          
          if (sessionEstablishedAfterWait || miningStateCheckAfterWait.isMining) {
            if (miningStateCheckAfterWait.isMining) {
              console.log(`[INIT] Task ${task.id} initialized (already in mining state after wait), registering with scheduler`);
            } else {
              console.log(`[INIT] Task ${task.id} initialized (session established after wait), registering with scheduler (not starting mining)`);
            }
            await scheduler.addTask(task.id, page, browser, context);
          } else {
            // EC2 上增加最后一次检查，等待更长时间
            console.log(`[INIT] Task ${task.id} session not established after 15s wait, trying extended wait (30s)...`);
            await page.waitForTimeout(30000);
            const finalCheck = await page.evaluate(() => {
              const allButtons = Array.from(document.querySelectorAll('button'));
              const hasStart = allButtons.some(b => {
                const text = b.textContent?.trim().toLowerCase();
                return (text === 'start' || text === 'start session') && b.offsetParent !== null;
              });
              const hasStop = allButtons.some(b => {
                const text = b.textContent?.trim().toLowerCase();
                return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
              });
              return hasStart || hasStop;
            }).catch(() => false);
            
            // 最终检查挖矿状态
            const finalMiningStateCheck = await page.evaluate(() => {
              const bodyText = (document.body?.innerText || '').toLowerCase();
              const hasStopButton = Array.from(document.querySelectorAll('button')).some(b => {
                const text = b.textContent?.trim().toLowerCase();
                return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
              });
              const hasFindingSolution = bodyText.includes('finding a solution') || bodyText.includes('finding');
              const hasSolveCryptoTitle = bodyText.includes('solve cryptographic challenges');
              const hasActiveStatus = bodyText.includes('miner status') && bodyText.includes('active');
              
              return {
                hasStopButton,
                hasFindingSolution,
                hasSolveCryptoTitle,
                hasActiveStatus,
                isMining: hasStopButton && (hasFindingSolution || hasActiveStatus) && hasSolveCryptoTitle
              };
            }).catch(() => ({ isMining: false }));
            
            if (finalCheck || finalMiningStateCheck.isMining) {
              if (finalMiningStateCheck.isMining) {
                console.log(`[INIT] Task ${task.id} session established after extended wait (already in mining state), registering with scheduler`);
              } else {
                console.log(`[INIT] Task ${task.id} session established after extended wait, registering with scheduler`);
              }
              await scheduler.addTask(task.id, page, browser, context);
            } else {
              throw new Error(`Task ${task.id} failed to establish session during initialization (even after extended wait)`);
            }
          }
        }
      }
      // 标记任务为READY状态
      const taskData = scheduler.tasks.get(task.id);
      if (taskData) {
        taskData.status = 'ready';
      }
      // 在初始化模式下，不注入自动启动监控，由scheduler统一管理
      return { id: task.id, ok: true, initialized: true };
    }

    // 注入监控：当 session 停掉（按钮从 Stop 变回 Start）时自动点击 Start 继续（仅在非初始化模式）
    await page.evaluate(() => {
      // 使用 Map 跟踪每个按钮对的状态（支持多个 session）
      const buttonStates = new Map(); // key: button element, value: { lastState: 'running'|'stopped', lastClickTime: number }
      const CLICK_THROTTLE_MS = 3000; // 至少间隔3秒才能再次点击
      
      // 生成按钮的唯一标识（用于 Map key）
      const getButtonKey = (btn) => {
        if (!btn) return null;
        // 使用位置和文本生成唯一标识
        try {
          const rect = btn.getBoundingClientRect();
          const text = btn.textContent?.trim() || '';
          const parent = btn.closest('div, section, form, [class*="card"], [class*="session"]');
          const parentId = parent ? (parent.id || parent.className || '') : '';
          return `${text}_${Math.round(rect.top)}_${Math.round(rect.left)}_${parentId.substring(0, 50)}`;
        } catch {
          return `${btn.textContent?.trim()}_${Date.now()}`;
        }
      };
      
      // 查找所有按钮对（Start 和 Stop 按钮）
      const findButtonPairs = () => {
        const allButtons = Array.from(document.querySelectorAll('button'));
        const pairs = [];
        
        // 找到所有 Start 和 Stop 按钮
        const startButtons = allButtons.filter(b => {
          if (b.disabled) return false;
          const text = b.textContent?.trim().toLowerCase();
          return (text === 'start' || text === 'start session') && b.offsetParent !== null; // offsetParent !== null 表示可见
        });
        
        const stopButtons = allButtons.filter(b => {
          if (b.disabled) return false;
          const text = b.textContent?.trim().toLowerCase();
          return (text === 'stop' || text === 'stop session') && b.offsetParent !== null;
        });
        
        // 为每个 Stop 按钮找到对应的 Start 按钮（通过位置关系）
        stopButtons.forEach(stopBtn => {
          const stopRect = stopBtn.getBoundingClientRect();
          const stopParent = stopBtn.closest('div, section, form, [class*="card"], [class*="session"]');
          
          // 找最近的 Start 按钮（在同一个容器或附近）
          const nearbyStart = startButtons.find(startBtn => {
            const startParent = startBtn.closest('div, section, form, [class*="card"], [class*="session"]');
            // 检查是否在同一个父容器中
            const sameParent = stopParent === startParent;
            // 或者位置相近（垂直距离小于 200px，水平距离小于 500px）
            const startRect = startBtn.getBoundingClientRect();
            const nearby = Math.abs(startRect.top - stopRect.top) < 200 && 
                          Math.abs(startRect.left - stopRect.left) < 500;
            return sameParent || nearby;
          });
          
          if (nearbyStart) {
            // 使用统一的位置key（不依赖文本）
            const unifiedKey = (() => {
              try {
                const rect = stopBtn.getBoundingClientRect();
                const parent = stopBtn.closest('div, section, form, [class*="card"], [class*="session"]');
                const parentId = parent ? (parent.id || parent.className || '') : '';
                return `${Math.round(rect.top / 10)}_${Math.round(rect.left / 10)}_${parentId.substring(0, 50)}`;
              } catch {
                return getButtonKey(stopBtn);
              }
            })();
            pairs.push({ startBtn: nearbyStart, stopBtn, key: unifiedKey });
      } else {
            // 只有 Stop 按钮，没有对应的 Start（可能是同一个按钮的不同状态）
            const unifiedKey = (() => {
              try {
                const rect = stopBtn.getBoundingClientRect();
                const parent = stopBtn.closest('div, section, form, [class*="card"], [class*="session"]');
                const parentId = parent ? (parent.id || parent.className || '') : '';
                return `${Math.round(rect.top / 10)}_${Math.round(rect.left / 10)}_${parentId.substring(0, 50)}`;
              } catch {
                return getButtonKey(stopBtn);
              }
            })();
            pairs.push({ startBtn: null, stopBtn, key: unifiedKey });
          }
        });
        
        // 对于没有对应 Stop 按钮的 Start 按钮，也创建单独的记录（这些是已停止的 session）
        // 注意：Start 和 Stop 可能是同一个按钮，只是文本在变化
        startButtons.forEach(startBtn => {
          const hasPair = pairs.some(p => p.startBtn === startBtn || p.stopBtn === startBtn);
          if (!hasPair) {
            // 检查是否可能是同一个按钮的不同状态（通过位置匹配）
            const startRect = startBtn.getBoundingClientRect();
            const startParent = startBtn.closest('div, section, form, [class*="card"], [class*="session"]');
            const samePositionStop = stopButtons.find(stopBtn => {
              const stopRect = stopBtn.getBoundingClientRect();
              const stopParent = stopBtn.closest('div, section, form, [class*="card"], [class*="session"]');
              return stopParent === startParent && 
                     Math.abs(stopRect.top - startRect.top) < 5 && 
                     Math.abs(stopRect.left - startRect.left) < 5;
            });
            
            // 使用统一的位置作为key，不依赖文本
            const unifiedKey = (() => {
              try {
                const rect = startBtn.getBoundingClientRect();
                const parent = startBtn.closest('div, section, form, [class*="card"], [class*="session"]');
                const parentId = parent ? (parent.id || parent.className || '') : '';
                // 去掉文本前缀，只使用位置信息
                return `${Math.round(rect.top / 10)}_${Math.round(rect.left / 10)}_${parentId.substring(0, 50)}`;
              } catch {
                return getButtonKey(startBtn);
              }
            })();
            
            pairs.push({ startBtn, stopBtn: samePositionStop || null, key: unifiedKey });
          }
        });
        
        return pairs;
      };
      
      const checkAndAutoStart = () => {
        const pairs = findButtonPairs();
        
        pairs.forEach(({ startBtn, stopBtn, key }) => {
          if (!key) return;
          
          // 确定当前状态（优先检查 Stop 按钮，因为 Stop 按钮存在表示正在运行）
          let currentState = null;
          if (stopBtn && stopBtn.offsetParent !== null) {
            currentState = 'running';
          } else if (startBtn && startBtn.offsetParent !== null) {
            currentState = 'stopped';
          }
          
          if (currentState === null) {
            // 按钮都不可见，清理状态记录
            buttonStates.delete(key);
            return;
          }
          
          // 获取或创建该按钮对的状态记录
          let stateRecord = buttonStates.get(key);
          
          if (!stateRecord) {
            // 首次检测，初始化状态（不触发自动点击）
            stateRecord = { 
              lastState: currentState, 
              lastClickTime: 0,
              startBtn,
              stopBtn
            };
            buttonStates.set(key, stateRecord);
            console.log(`[AUTO-START] Initialized button pair (${key.substring(0, 30)}...): ${currentState}`);
            return;
          }
          
          // 更新按钮引用（防止 DOM 变化导致引用失效）
          stateRecord.startBtn = startBtn;
          stateRecord.stopBtn = stopBtn;
          
          // 检测状态变化：从 running 变为 stopped
          if (stateRecord.lastState === 'running' && currentState === 'stopped' && startBtn) {
            const now = Date.now();
            // 节流检查：确保不在短时间内重复点击
            if (now - stateRecord.lastClickTime >= CLICK_THROTTLE_MS && !startBtn.disabled && startBtn.offsetParent !== null) {
              console.log(`[AUTO-START] Session stopped detected (${key.substring(0, 30)}...), auto-clicking Start...`);
              try {
                // 滚动到按钮位置，确保可见
                startBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => {
          startBtn.click();
                  stateRecord.lastClickTime = Date.now();
                  // 点击后，不立即更新 lastState，让下次检查时自然更新
                  // 这样可以确保如果点击没有生效，下次还能检测到并重试
                  console.log('[AUTO-START] Start button clicked successfully');
                }, 200);
              } catch (e) {
                console.error('[AUTO-START] Error clicking Start button:', e);
              }
            }
          } else {
            // 正常更新状态记录（包括从 stopped 变为 running 的情况）
            stateRecord.lastState = currentState;
          }
        });
        
        // 清理不再存在的按钮对的状态记录
        const currentKeys = new Set(pairs.map(p => p.key).filter(Boolean));
        for (const key of buttonStates.keys()) {
          if (!currentKeys.has(key)) {
            console.log(`[AUTO-START] Removing stale button state: ${key.substring(0, 30)}...`);
            buttonStates.delete(key);
          }
        }
      };
      
      // 轮询检查（每 1.5 秒检查一次，提高响应速度）
      const intervalId = setInterval(checkAndAutoStart, 1500);
      
      // MutationObserver 监听 DOM 变化，实时响应按钮状态变化
      const mo = new MutationObserver(() => {
        // DOM 变化时立即检查
        checkAndAutoStart();
      });
      mo.observe(document.body, { 
        subtree: true, 
        childList: true, 
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'disabled', 'aria-disabled', 'style', 'hidden'] // 监听按钮启用/禁用状态变化
      });
      
      // 立即执行一次检查，初始化所有按钮对的状态
      checkAndAutoStart();
      
      console.log('[AUTO-START] Monitor installed: will auto-click Start when session stops (supports multiple sessions)');
      
      // 清理函数（如果需要的话）
      window.__autoStartCleanup = () => {
        clearInterval(intervalId);
        mo.disconnect();
        buttonStates.clear();
      };
    });

    // 可选择在此维持一段时间或直到某条件成立
    // await page.waitForTimeout(60000);

    return { id: task.id, ok: true };
  } catch (e) {
    // ⚠️ 记录详细的错误信息
    const errorMsg = e?.message || String(e);
    const errorStack = e?.stack || '';
    const fullError = errorStack || errorMsg;
    
    // 如果是速率限制错误，记录详细信息
    if (errorMsg.toLowerCase().includes('rate limit') || errorMsg.toLowerCase().includes('too many')) {
      console.error(`[RATE-LIMIT] Task ${task.id} failed due to rate limit error: ${errorMsg}`);
      // 不立即返回失败，而是等待一段时间后重试（通过外部的重试机制）
    } else {
      // ⚠️ 输出详细的错误信息，帮助调试
      console.error(`[RUNONE] Task ${task.id} failed: ${errorMsg}`);
      if (errorStack && errorStack !== errorMsg) {
        console.error(`[RUNONE] Task ${task.id} error stack: ${errorStack.substring(0, 500)}`);
      }
    }
    
    // ⚠️ 如果初始化失败且还没有注册到调度器，需要关闭页面和浏览器以释放资源
    if (initOnly && !scheduler?.tasks.has(task.id)) {
      console.warn(`[RUNONE] Task ${task.id} failed before registration (error: ${errorMsg.substring(0, 100)}), closing page and browser to free resources...`);
      try {
        if (page && !page.isClosed()) {
          await page.close().catch(() => {});
        }
      } catch (closeErr) {
        // 忽略关闭错误
      }
      try {
        if (context) {
          await context.close().catch(() => {});
        }
      } catch (closeErr) {
        // 忽略关闭错误
      }
      // ⚠️ 只关闭自己创建的浏览器，不关闭共享浏览器
      if (shouldCloseBrowser && browser) {
        try {
          await browser.close().catch(() => {});
        } catch (closeErr) {
          // 忽略关闭错误
        }
      }
    }
    
    return { id: task.id, ok: false, error: errorMsg };
  } finally {
    // 停止后台监控
    stopRateLimitMonitor();
    
    // ⚠️ 清理solution重试信息（如果有）
    if (solutionRetryInfo.has(pageId)) {
      // 如果还有正在进行的重试，停止阻塞
      if (challengeSubmissionRateLimiter.blockingSolutionPageId === pageId) {
        challengeSubmissionRateLimiter.stopBlockingForSolution();
      }
      solutionRetryInfo.delete(pageId);
    }
    // ⚠️ 注意：如果任务已成功注册到调度器，页面和浏览器由调度器管理，不应在这里关闭
    // 只有在初始化失败且未注册到调度器时，才会在 catch 块中关闭
  }
}

// 全局统计对象
const taskStats = {
  total: 0,
  completed: 0,
  success: 0,
  failed: 0,
  miningStarted: 0, // 已开始挖矿的任务数（状态为"finding a solution"）
  loggingIn: 0, // 登录阶段：页面已打开但还未到达start session页面
  loggedIn: 0, // 已登录状态：已到达start session页面但还未点击start按钮
  loginTimes: [], // 登录时间数组（从打开页面到start session页面的时间，单位：秒）
  miningTimes: [], // 挖矿时间数组（从点击start session到状态变成waiting的时间，单位：秒）
  taskTimers: new Map(), // 每个任务的时间记录 { taskId: { pageOpenTime, loginCompleteTime, miningStartTime } }
  lastUpdateTime: Date.now(),
};

// 定期输出统计信息
// ⚠️ 在调度器模式下，这个统计信息不应该输出（调度器有自己的状态报告）
function logTaskStats() {
  // 如果是在调度器模式下运行，不输出统计信息（调度器有自己的状态报告）
  if (process.env.SCHEDULED_MODE === 'true' || process.env.RUN_SCHEDULED === 'true') {
    return; // 调度器模式下禁用此统计输出
  }
  
  const now = Date.now();
  const elapsed = Math.floor((now - taskStats.lastUpdateTime) / 1000);
  const successRate = taskStats.completed > 0 ? (taskStats.success / taskStats.completed * 100).toFixed(1) : '0.0';
  const remaining = taskStats.total - taskStats.completed;
  
  console.log('\n' + '='.repeat(60));
  console.log(`[STATS] Task Statistics (updated every 10 seconds)`);
  console.log(`  Total Tasks: ${taskStats.total}`);
  console.log(`  Completed: ${taskStats.completed} (${successRate}% success)`);
  console.log(`  ✓ Success (Completed): ${taskStats.success}`);
  console.log(`  ✗ Failed: ${taskStats.failed}`);
  console.log(`  Remaining: ${remaining}`);
  console.log(`  🔐 Logging In (before start session page): ${taskStats.loggingIn}`);
  console.log(`  📝 Logged In (at start session page): ${taskStats.loggedIn}`);
  // 当前正在挖矿的任务数 = 已开始挖矿的 - 已完成的
  const currentlyMining = Math.max(0, taskStats.miningStarted - taskStats.success);
  console.log(`  ⛏️ Active Mining (currently mining): ${currentlyMining}`);
  
  // ⚠️ 计算并显示平均登录时间和平均挖矿时间
  const avgLoginTime = taskStats.loginTimes.length > 0 
    ? (taskStats.loginTimes.reduce((sum, t) => sum + t, 0) / taskStats.loginTimes.length).toFixed(2)
    : '0.00';
  const avgMiningTime = taskStats.miningTimes.length > 0
    ? (taskStats.miningTimes.reduce((sum, t) => sum + t, 0) / taskStats.miningTimes.length).toFixed(2)
    : '0.00';
  console.log(`  📊 Avg Login Time: ${avgLoginTime}s (from ${taskStats.loginTimes.length} tasks)`);
  console.log(`  📊 Avg Mining Time: ${avgMiningTime}s (from ${taskStats.miningTimes.length} tasks)`);
  
  console.log(`  Last Update: ${elapsed}s ago`);
  console.log('='.repeat(60) + '\n');
}

async function runWithConcurrency() {
  const results = [];
  const queue = tasks.slice();
  let running = 0;
  
  // 初始化统计
  taskStats.total = tasks.length;
  taskStats.completed = 0;
  taskStats.success = 0;
  taskStats.failed = 0;
  taskStats.miningStarted = 0;
  taskStats.loggingIn = 0;
  taskStats.loggedIn = 0;
  taskStats.loginTimes = [];
  taskStats.miningTimes = [];
  taskStats.taskTimers.clear();
  taskStats.lastUpdateTime = Date.now();
  
  // 启动定期统计输出（每10秒）
  const statsInterval = setInterval(() => {
    logTaskStats();
  }, 10000);
  
  // 初始输出（只在非调度器模式下）
  if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
    console.log(`[STATS] Starting ${taskStats.total} tasks with concurrency ${CONCURRENCY}`);
  }

  return new Promise((resolve) => {
    const launchNext = () => {
      if (queue.length === 0 && running === 0) {
        clearInterval(statsInterval);
        // 最终统计
        logTaskStats();
        resolve(results);
        return;
      }
      while (running < CONCURRENCY && queue.length > 0) {
        const task = queue.shift();
        running++;
        // ⚠️ 不设置超时，因为挖矿任务需要在点击start session后等待状态变成"waiting for the next challenge"才算完成
        // 不同周期的挖矿难度不一样，可能很快也可能很慢
        const p = runOne(task);
        p.then(r => {
          results.push(r);
          taskStats.completed++;
          
          if (r.ok) {
            taskStats.success++;
            // 只在非调度器模式下输出详细日志
            if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
              console.log(`[STATS] ✓ Task ${r.id} completed successfully (Total: ${taskStats.success}/${taskStats.total})`);
            }
          } else {
            taskStats.failed++;
            // 只在非调度器模式下输出详细日志
            if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
              console.log(`[STATS] ✗ Task ${r.id} failed: ${r.error?.substring(0, 50) || 'unknown error'} (Failed: ${taskStats.failed}/${taskStats.total})`);
            }
          }
          
          // ⚠️ 任务完成或失败时，清理状态计数
          if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
            // 检查任务是否在挖矿中（通过检查taskTimers）
            const timer = taskStats.taskTimers.get(r.id);
            const wasMining = timer && timer.miningStartTime && !timer.miningCompleteRecorded;
            
            // 清理状态计数
            if (taskStats.loggingIn > 0) {
              taskStats.loggingIn--;
            }
            if (taskStats.loggedIn > 0) {
              taskStats.loggedIn--;
            }
            // ⚠️ 如果任务已经开始挖矿（无论成功还是失败），都需要清理miningStarted计数
            // 因为任务完成了（成功）或失败了，不再处于挖矿状态
            if (wasMining && taskStats.miningStarted > 0) {
              taskStats.miningStarted--;
            }
            
            // 清理任务时间记录
            taskStats.taskTimers.delete(r.id);
          }
          // 每完成一个任务也更新统计（只在非调度器模式下）
          if ((process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') && 
              (taskStats.completed % 5 === 0 || taskStats.completed === taskStats.total)) {
            logTaskStats();
          }
        })
         .catch(e => {
           results.push({ id: task.id, ok: false, error: String(e) });
           taskStats.completed++;
           taskStats.failed++;
           
           // ⚠️ 任务失败时，清理状态计数
           if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
             // 检查任务是否在挖矿中（通过检查taskTimers）
             const timer = taskStats.taskTimers.get(task.id);
             const wasMining = timer && timer.miningStartTime && !timer.miningCompleteRecorded;
             
             // 清理状态计数
             if (taskStats.loggingIn > 0) {
               taskStats.loggingIn--;
             }
             if (taskStats.loggedIn > 0) {
               taskStats.loggedIn--;
             }
             // ⚠️ 如果任务失败但已经开始挖矿，需要清理miningStarted计数
             if (wasMining && taskStats.miningStarted > 0) {
               taskStats.miningStarted--;
             }
             
             // 清理任务时间记录
             taskStats.taskTimers.delete(task.id);
           }
           
           // 只在非调度器模式下输出详细日志
           if (process.env.SCHEDULED_MODE !== 'true' && process.env.RUN_SCHEDULED !== 'true') {
             console.log(`[STATS] ✗ Task ${task.id} error: ${String(e).substring(0, 50)} (Failed: ${taskStats.failed}/${taskStats.total})`);
           }
         })
         .finally(() => {
           running--;
           launchNext();
         });
      }
    };
    launchNext();
  });
}

// 导出函数供其他模块使用
// 注意：BASE_URL 和 SIGN_SERVICE_URL 已经在上面通过 export const 导出了
export { runOne, runOneInitOnly, loadTasks };

// 如果不是被导入，则运行默认流程
// 检查是否是直接运行的脚本（不是被import）
// ⚠️ 在调度器模式下（SCHEDULED_MODE 或 RUN_SCHEDULED），不执行 runWithConcurrency
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
const isScheduledMode = process.env.SCHEDULED_MODE === 'true' || process.env.RUN_SCHEDULED === 'true';

// 只在直接运行脚本且非调度器模式下才执行 runWithConcurrency
if (isMainModule && !isScheduledMode) {
runWithConcurrency().then(res => {
  console.log('Done:', res);
  const failed = res.filter(r => !r.ok);
  if (failed.length) {
    console.error('Failed:', failed);
    process.exitCode = 1;
  }
});
}