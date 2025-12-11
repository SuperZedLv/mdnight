// 新的任务调度器 - 基于整点周期的任务管理
import { chromium } from 'playwright';

// 配置参数（可通过环境变量覆盖）
// 3 3 1
// 6 12 4
// 20 25 5 / 16 20 4
export const CONFIG = {
  MAX_ACTIVE_MINING: parseInt(process.env.MAX_ACTIVE_MINING) || 6,
  MAX_OPEN_PAGES: parseInt(process.env.MAX_OPEN_PAGES) || 12,
  PAGE_OPEN_CONCURRENCY: parseInt(process.env.PAGE_OPEN_CONCURRENCY) || 4,
  STATUS_CHECK_INTERVAL: parseInt(process.env.STATUS_CHECK_INTERVAL) || 5000, // 5秒检查一次状态
  COMPLETION_WAIT_TIME: 1000, // 任务完成后等待30秒再关闭
  RESET_AT_HOUR: process.env.RESET_AT_HOUR !== 'false', // 默认启用（设置为 'false' 禁用）
};

// 任务状态
export const TaskStatus = {
  PENDING: 'pending',        // 待执行
  INITIALIZING: 'initializing', // 初始化中（从点击enter address到start session）
  MINING: 'mining',          // 正在挖矿中（页面显示"finding a solution"，任务正在进行）
  COMPLETED: 'completed',    // 已完成（页面显示"waiting for the next challenge"，任务已完成）
  WAITING_CLOSE: 'waiting_close', // 等待关闭（已完成后等待30s）
  CLOSED: 'closed',          // 已关闭
  ERROR: 'error',            // 错误
};

class TaskScheduler {
  constructor() {
    this.tasks = new Map(); // taskId -> taskInfo
    this.isRunning = false;
    this.intervalId = null;
    this.currentCycleStartTime = null; // 当前周期的开始时间
    
    // ⚠️ 共享浏览器实例 - 所有任务共享同一个浏览器实例
    this.sharedBrowser = null;
    this.browserInitializing = false; // 防止并发初始化
    
    // ⚠️ 状态日志节流：减少日志输出频率
    this.lastStatusLogTime = 0;
    this.statusLogInterval = parseInt(process.env.STATUS_LOG_INTERVAL) || 10000; // 每10秒输出一次状态日志（可配置）
    this.lastStatusSnapshot = null; // 上次状态快照，用于检测变化
    
    // ⚠️ 事件驱动：待处理的事件队列（避免重复触发）
    this.pendingEvents = new Set(); // 待处理的事件类型
    this.isProcessingEvents = false; // 是否正在处理事件
    this.isStartingNewTasks = false; // ⚠️ 防止并发启动新任务
    
    // ⚠️ 全局速率限制管理
    this.rateLimitInfo = {
      consecutive429Errors: 0,      // 连续429错误次数
      last429ErrorTime: null,       // 最后一次429错误时间
      pauseUntil: null,             // 暂停启动新任务直到这个时间
      maxConsecutive429Errors: 3,   // 连续3次429错误后暂停
      pauseDuration: 60000,        // 暂停5分钟（300000ms）
    };
    
    // 统计信息
    this.stats = {
      cycle: 0,
      totalCompleted: 0,
      cycleCompleted: 0,
      // ⚠️ 详细统计（与 runbatch.mjs 保持一致）
      success: 0,           // 成功完成的任务数
      failed: 0,            // 失败的任务数
      loggingIn: 0,         // 登录阶段：页面已打开但还未到达start session页面
      loggedIn: 0,          // 已登录状态：已到达start session页面但还未点击start按钮
      miningStarted: 0,     // 已开始挖矿的任务数（状态为"finding a solution"）
      submitSolution: 0,    // 提交solution的次数（累计）
      cycleSubmitSolution: 0, // 当前周期提交solution的次数
      loginTimes: [],       // 登录时间数组（从打开页面到start session页面的时间，单位：秒）
      miningTimes: [],      // 挖矿时间数组（从点击start session到状态变成waiting的时间，单位：秒）
      taskTimers: new Map(), // 每个任务的时间记录 { taskId: { pageOpenTime, loginCompleteTime, miningStartTime } }
    };
  }
  
  // ⚠️ 获取或创建共享浏览器实例
  async getSharedBrowser() {
    // 如果浏览器已存在且未关闭，直接返回
    if (this.sharedBrowser) {
      try {
        // 检查浏览器是否仍然连接
        if (this.sharedBrowser.isConnected()) {
          return this.sharedBrowser;
        }
      } catch (e) {
        // 浏览器已关闭，需要重新创建
        this.sharedBrowser = null;
      }
    }
    
    // 如果正在初始化，等待初始化完成
    if (this.browserInitializing) {
      // 等待最多10秒
      const maxWait = 10000;
      const startWait = Date.now();
      while (this.browserInitializing && (Date.now() - startWait) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (this.sharedBrowser) {
        return this.sharedBrowser;
      }
    }
    
    // 创建新的浏览器实例
    this.browserInitializing = true;
    try {
      const HEADLESS = process.env.HEADLESS !== 'false';
      const DISPLAY = process.env.DISPLAY || ':99';
      
      console.log('[SCHEDULER] 🚀 Creating shared browser instance...');
      
      this.sharedBrowser = await chromium.launch({
        headless: HEADLESS,
        args: [
          '--guest',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process,AutomationControlled,MediaRouter',
          '--disable-component-extensions-with-background-pages',
          '--disable-default-apps',
          '--disable-hang-monitor',
          '--disable-prompt-on-repost',
          '--disable-sync',
          '--metrics-recording-only',
          '--safebrowsing-disable-auto-update',
          '--enable-automation',
          '--password-store=basic',
          '--use-mock-keychain',
          '--lang=en-US,en',
          '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          '--disable-infobars',
          '--disable-notifications',
          '--disable-popup-blocking',
          '--disable-translate',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
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
      
      console.log('[SCHEDULER] ✅ Shared browser instance created');
      
      // 监听浏览器断开事件
      this.sharedBrowser.on('disconnected', () => {
        console.warn('[SCHEDULER] ⚠️ Shared browser disconnected, will recreate on next use');
        this.sharedBrowser = null;
      });
      
      return this.sharedBrowser;
    } catch (error) {
      console.error(`[SCHEDULER] ❌ Failed to create shared browser instance: ${error.message}`);
      this.sharedBrowser = null;
      throw error;
    } finally {
      this.browserInitializing = false;
    }
  }

  // 添加任务
  addTask(taskId, taskData) {
    if (this.tasks.has(taskId)) {
      console.warn(`[SCHEDULER] Task ${taskId} already exists`);
      return;
    }

    this.tasks.set(taskId, {
      id: taskId,
      addr: taskData.addr,
      status: TaskStatus.PENDING,
      page: null,
      context: null,
      browser: null, // 使用共享的browser context
      createdAt: Date.now(),
      completedAt: null,
      error: null,
      completionWaitStart: null, // 开始等待关闭的时间
      startSessionClickCount: 0, // 连续点击start session的次数
      lastStartSessionClickTime: null, // 最后一次点击start session的时间
      // ⚠️ 周期跟踪字段
      miningCycleStartTime: null, // 任务开始挖矿的周期开始时间
      miningCycle: null, // 任务在哪个周期开始挖矿（cycle编号）
      completedInCycle: null, // 任务在哪个周期完成的（cycle编号）
      // ⚠️ 页面崩溃恢复字段
      crashRefreshCount: 0, // 页面崩溃后的刷新次数
      lastCrashRefreshTime: null, // 最后一次崩溃刷新的时间
      // ⚠️ Submit Solution 跟踪字段
      hasSubmittedSolution: false, // 是否已经记录过 submitSolution（用于检测状态变为 waiting 时记录）
    });

    console.log(`[SCHEDULER] Added task ${taskId} (total: ${this.tasks.size})`);
  }

  // ⚠️ 记录submitSolution（由runbatch.mjs调用）
  recordSubmitSolution(taskId = null) {
    this.stats.submitSolution++;
    this.stats.cycleSubmitSolution++;
    
    // ⚠️ 如果提供了 taskId，标记该任务已经记录过 submitSolution
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (task) {
        task.hasSubmittedSolution = true;
      }
    }
  }

  // ⚠️ 检查是否应该暂停启动新任务（由于速率限制）
  shouldPauseNewTasks() {
    const now = Date.now();
    if (this.rateLimitInfo.pauseUntil && now < this.rateLimitInfo.pauseUntil) {
      const remainingSeconds = Math.ceil((this.rateLimitInfo.pauseUntil - now) / 1000);
      return { paused: true, remainingSeconds };
    }
    return { paused: false, remainingSeconds: 0 };
  }

  // ⚠️ 记录429错误并更新暂停状态
  record429Error() {
    this.rateLimitInfo.consecutive429Errors++;
    this.rateLimitInfo.last429ErrorTime = Date.now();
    
    if (this.rateLimitInfo.consecutive429Errors >= this.rateLimitInfo.maxConsecutive429Errors) {
      // 连续多次429错误，暂停启动新任务
      this.rateLimitInfo.pauseUntil = Date.now() + this.rateLimitInfo.pauseDuration;
      const pauseMinutes = Math.ceil(this.rateLimitInfo.pauseDuration / 60000);
      console.warn(`[SCHEDULER] ⚠️ RATE LIMIT: ${this.rateLimitInfo.consecutive429Errors} consecutive 429 errors detected. Pausing new task starts for ${pauseMinutes} minutes.`);
    } else {
      console.warn(`[SCHEDULER] ⚠️ RATE LIMIT: ${this.rateLimitInfo.consecutive429Errors} consecutive 429 error(s) (will pause after ${this.rateLimitInfo.maxConsecutive429Errors})`);
    }
  }

  // ⚠️ 重置429错误计数（当任务成功时）
  reset429ErrorCount() {
    if (this.rateLimitInfo.consecutive429Errors > 0) {
      console.log(`[SCHEDULER] ✓ Rate limit error count reset (was ${this.rateLimitInfo.consecutive429Errors})`);
      this.rateLimitInfo.consecutive429Errors = 0;
      this.rateLimitInfo.last429ErrorTime = null;
    }
  }

  // 获取当前打开的页面数
  // ⚠️ 修复：统计所有正在打开或已打开的页面（包括INITIALIZING状态但页面还未创建的任务）
  // 因为一旦设置为INITIALIZING，就表示正在打开页面，应该计入限制
  getOpenPagesCount() {
    let count = 0;
    for (const task of this.tasks.values()) {
      // ⚠️ 统计所有正在打开或已打开的页面
      // INITIALIZING状态：无论页面是否存在，都计入（正在打开中）
      // 其他状态（MINING、COMPLETED等）：只有页面存在且未关闭时才计入
      if (task.status === TaskStatus.INITIALIZING) {
        // ⚠️ INITIALIZING状态：无论页面是否存在，都计入（正在打开中）
        count++;
      } else if (task.status !== TaskStatus.PENDING && 
                 task.status !== TaskStatus.CLOSED && 
                 task.status !== TaskStatus.ERROR) {
        // ⚠️ 其他状态：只有页面存在且未关闭时才计入
        if (task.page) {
          try {
            if (!task.page.isClosed()) {
              count++;
            } else {
              // ⚠️ 页面已关闭，清理引用（不计入）
              task.page = null;
              task.context = null;
            }
          } catch (error) {
            // 如果检查isClosed()时出错，说明页面可能已经关闭或无效（不计入）
            task.page = null;
            task.context = null;
          }
        }
        // 如果没有页面，不计入
      }
    }
    return count;
  }

  // 获取当前正在挖矿的任务数
  // ⚠️ 只统计状态为MINING的任务（页面显示"finding a solution"，任务正在进行中）
  getActiveMiningCount() {
    let count = 0;
    for (const task of this.tasks.values()) {
      // 状态为MINING表示任务正在进行中（页面显示"finding a solution"）
      if (task.status === TaskStatus.MINING && task.page && !task.page.isClosed()) {
        count++;
      }
    }
    return count;
  }

  // 检测任务状态
  async detectTaskStatus(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.page || task.page.isClosed()) {
      return { status: TaskStatus.CLOSED };
    }

    // ⚠️ 如果任务已经是ERROR状态，直接返回，避免重复检测崩溃的页面
    if (task.status === TaskStatus.ERROR) {
      return { status: TaskStatus.ERROR, error: task.error || 'Page crashed' };
    }

    try {
      const page = task.page;
      
      // ⚠️ 先检查页面是否已崩溃（避免在崩溃的页面上执行操作）
      try {
        // 尝试获取URL，如果页面崩溃会抛出错误
        await page.url();
      } catch (urlError) {
        // 页面可能已崩溃
        if (urlError.message && urlError.message.includes('crashed')) {
          console.warn(`[SCHEDULER] ⚠️ Task ${taskId} page crashed detected, marking as ERROR`);
          return { status: TaskStatus.ERROR, error: 'Page crashed' };
        }
        throw urlError; // 其他错误继续抛出
      }
      
      await page.waitForTimeout(500);

      // 检查是否在挖矿页面
      const url = page.url();
      
      // 如果页面还在 wallet 页面，说明还在初始化阶段
      if (url.includes('/wizard/wallet')) {
        // 检查是否卡在 "Choose a Destination address" 页面
        const isStuck = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          return bodyText.includes('choose a destination address') || 
                 bodyText.includes('choose a destination');
        }).catch(() => false);
        
        if (isStuck) {
          console.warn(`[SCHEDULER] ⚠️ Task ${taskId} stuck on "Choose a Destination address" page, should click "Enter an address manually"`);
          // 返回 INITIALIZING 状态，让 runOne 继续处理
          return { status: TaskStatus.INITIALIZING };
        }
        
        // 如果不在挖矿页面，可能是初始化阶段
        if (task.status === TaskStatus.INITIALIZING || task.status === TaskStatus.PENDING) {
          return { status: TaskStatus.INITIALIZING };
        }
        return { status: TaskStatus.PENDING };
      }
      
      // 如果不在挖矿页面且不在wallet页面，可能是其他错误页面
      if (!url.includes('/wizard/mine')) {
        if (task.status === TaskStatus.INITIALIZING) {
          return { status: TaskStatus.INITIALIZING };
        }
        return { status: TaskStatus.PENDING };
      }

      // 检测页面状态
      // ⚠️ 增加等待时间，确保页面内容已完全渲染
      await page.waitForTimeout(1000);
      
      const statusInfo = await page.evaluate(() => {
        // 获取页面所有文本内容（包括隐藏元素）
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
        const allText = bodyText + ' ' + bodyHTML;
        
        // ⚠️ 在"Solve cryptographic challenges"页面检测状态
        // 状态显示位置通常在页面上的状态文本中
        // - "waiting for the next challenge" = 任务已完成
        // - "finding a solution" = 任务正在进行中（挖矿中）
        let challengeStatus = null;
        
        // 优先检测"waiting for the next challenge"（已完成状态）
        if (allText.includes('waiting for the next challenge')) {
          challengeStatus = 'waiting for the next challenge'; // ✅ 任务已完成
        } 
        // 然后检测"finding a solution"（正在进行中状态）
        else if (allText.includes('finding a solution')) {
          challengeStatus = 'finding a solution'; // ⛏️ 任务正在进行中（挖矿中）
        }
        // 兼容其他可能的"finding"文本（但要排除"finding"单独出现的情况，避免误判）
        else if (allText.includes('finding') && (allText.includes('solution') || allText.includes('challenge'))) {
          challengeStatus = 'finding a solution'; // ⛏️ 任务正在进行中
        }

        // 检测 start session 按钮
        const buttons = Array.from(document.querySelectorAll('button'));
        let hasStartSession = false;
        let hasStopSession = false;
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if ((text === 'start' || text === 'start session') && btn.offsetParent !== null && !btn.disabled) {
            hasStartSession = true;
          }
          if ((text === 'stop' || text === 'stop session') && btn.offsetParent !== null && !btn.disabled) {
            hasStopSession = true;
          }
        }

        return { challengeStatus, hasStartSession, hasStopSession, sampleText: bodyText.substring(0, 200) };
      });

      // ⚠️ 根据"Solve cryptographic challenges"页面的状态判断任务状态
      // 状态映射规则（根据用户要求）：
      // - "finding a solution" → MINING (任务正在进行中，挖矿中)
      // - "waiting for the next challenge" → COMPLETED (任务已完成)
      if (statusInfo.challengeStatus === 'waiting for the next challenge') {
        // ✅ 状态显示为"waiting for the next challenge"，任务已完成
        return { status: TaskStatus.COMPLETED };
      } else if (statusInfo.challengeStatus === 'finding a solution') {
        // ⛏️ 状态显示为"finding a solution"，任务正在进行中
        return { status: TaskStatus.MINING };
      } else if (statusInfo.hasStopSession) {
        // ⚠️ 有stop session按钮但没有状态文本，可能是正在挖矿（页面刚加载，状态文本还没更新）
        // 如果之前是MINING状态或INITIALIZING状态，保持或更新为MINING
        if (task.status === TaskStatus.MINING || task.status === TaskStatus.INITIALIZING) {
          return { status: TaskStatus.MINING };
        }
      } else if (statusInfo.hasStartSession) {
        // 有start session按钮，但还没有开始挖矿，处于初始化阶段
        return { status: TaskStatus.INITIALIZING };
      }

      // ⚠️ 如果没有检测到状态，但任务已经在MINING状态，保持MINING（避免误判）
      if (task.status === TaskStatus.MINING) {
        return { status: TaskStatus.MINING };
      }

      return { status: task.status }; // 保持当前状态
    } catch (error) {
      // ⚠️ 检查是否是页面崩溃错误
      const isCrashed = error.message && (
        error.message.includes('crashed') || 
        error.message.includes('Target crashed') ||
        error.message.includes('Target closed')
      );
      
      if (isCrashed) {
        console.warn(`[SCHEDULER] ⚠️ Task ${taskId} page crashed: ${error.message}`);
        return { status: TaskStatus.ERROR, error: 'Page crashed' };
      }
      
      // 其他错误只记录，不改变状态（避免误判）
      console.error(`[SCHEDULER] Error detecting status for task ${taskId}: ${error.message}`);
      // ⚠️ 返回当前状态而不是ERROR，避免因为临时错误导致任务被标记为ERROR
      return { status: task.status, error: error.message };
    }
  }

  // 点击Stop Session按钮
  // ⚠️ 用户要求：当超过MAX_ACTIVE_MINING限制时，点击stop session让任务回到start session状态
  async clickStopSession(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.error(`[SCHEDULER] Task ${taskId} not found`);
      return false;
    }

    if (!task.page || task.page.isClosed()) {
      console.warn(`[SCHEDULER] ⚠️ Task ${taskId} page not available`);
      return false;
    }

    try {
      const page = task.page;
      await page.waitForTimeout(500);
      
      // 查找Stop按钮并点击
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if ((text === 'stop' || text === 'stop session') && btn.offsetParent !== null && !btn.disabled) {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            btn.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (clicked) {
        console.log(`[SCHEDULER] 🛑 Stop session clicked for task ${taskId}, waiting for status update...`);
        await page.waitForTimeout(2000); // 等待状态更新（从"Finding a solution"回到"start session"状态）
        
        // 验证状态是否已更新（页面应该显示start session按钮）
        const hasStartButton = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.some(btn => {
            const text = (btn.textContent || '').trim().toLowerCase();
            return (text === 'start' || text === 'start session') && btn.offsetParent !== null && !btn.disabled;
          });
        }).catch(() => false);
        
        if (hasStartButton) {
          console.log(`[SCHEDULER] ✅ Task ${taskId} successfully stopped, now showing start session button`);
          return true;
        } else {
          console.warn(`[SCHEDULER] ⚠️ Task ${taskId} stop clicked but start button not found yet`);
          return true; // 仍然返回true，可能状态更新需要更多时间
        }
      } else {
        console.warn(`[SCHEDULER] ⚠️ Stop button not found or not clickable for task ${taskId}`);
        return false;
      }
    } catch (error) {
      console.error(`[SCHEDULER] Error clicking stop for task ${taskId}: ${error.message}`);
      return false;
    }
  }

  // 执行任务初始化（从点击enter address到start session）
  async initializeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    try {
      // 从runbatch.mjs导入任务执行函数
      const { runOne } = await import('./runbatch.mjs');
      
      // ⚠️ 获取共享浏览器实例
      const sharedBrowser = await this.getSharedBrowser();
      
      // 执行初始化流程（initOnly=true，完成到start session按钮出现但不点击）
      // 创建一个临时调度器适配器，用于接收页面和浏览器
      const self = this; // 保存 this 引用
      const adapter = {
        tasks: new Map(),
        addTask: (id, page, browser, context) => {
          // 保存页面和浏览器引用
          // ⚠️ 注意：browser 参数现在应该是共享浏览器实例
          task.page = page;
          task.context = context || null;
          task.browser = browser; // 保存共享浏览器引用（用于后续检查，但不关闭）
          self.tasks.set(id, task); // 确保任务已注册
        },
        // ⚠️ 添加 recordSubmitSolution 方法，转发到真正的 scheduler
        // ⚠️ 修复：必须传递 taskId 参数，否则 hasSubmittedSolution 不会被正确设置
        recordSubmitSolution: (taskId) => {
          self.recordSubmitSolution(taskId);
        }
      };

      // ⚠️ 在打开页面之前，再次检查OpenPages限制（防止并发导致超限）
      // ⚠️ 注意：使用 > 而不是 >=，允许达到上限（例如3/3时仍可以启动，因为这是异步的）
      const checkOpenPagesBeforeStart = this.getOpenPagesCount();
      if (checkOpenPagesBeforeStart > CONFIG.MAX_OPEN_PAGES) {
        console.warn(`[SCHEDULER] ⚠️ Cannot start task ${taskId}: OpenPages limit exceeded (${checkOpenPagesBeforeStart}/${CONFIG.MAX_OPEN_PAGES})`);
        task.status = TaskStatus.PENDING;
        return false;
      }
      
      // ⚠️ 记录任务开始时间（页面打开时间），任务进入"登录阶段"
      if (!this.stats.taskTimers.has(taskId)) {
        this.stats.taskTimers.set(taskId, { pageOpenTime: Date.now() });
      } else {
        this.stats.taskTimers.get(taskId).pageOpenTime = Date.now();
      }
      this.stats.loggingIn++;
      
      // ⚠️ 传递共享浏览器实例给 runOne
      const result = await runOne({ id: task.id, addr: task.addr }, { 
        initOnly: true, // 只完成到start session按钮出现
        scheduler: adapter,
        sharedBrowser: sharedBrowser // ⚠️ 传递共享浏览器实例
      });

      if (result && result.ok && task.page) {
        // ⚠️ 任务成功，重置429错误计数
        this.reset429ErrorCount();
        
        // ⚠️ 检查是否已到达start session页面（已登录状态）
        // 已登录状态的定义：页面显示出"Solve cryptographic challenges"且页面里包含start session或stop session按钮
        const isLoggedInPage = await task.page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const hasSolveCryptoText = bodyText.includes('solve cryptographic challenges');
          
          if (!hasSolveCryptoText) {
            return false;
          }
          
          const allButtons = Array.from(document.querySelectorAll('button'));
          const hasStartButton = allButtons.some(b => {
            const text = b.textContent?.trim().toLowerCase();
            return (text === 'start' || text === 'start session') && b.offsetParent !== null && !b.disabled;
          });
          const hasStopButton = allButtons.some(b => {
            const text = b.textContent?.trim().toLowerCase();
            return (text === 'stop' || text === 'stop session') && b.offsetParent !== null && !b.disabled;
          });
          
          return hasStartButton || hasStopButton;
        }).catch(() => false);
        
        if (isLoggedInPage) {
          // 已到达start session页面，从"登录阶段"转为"已登录状态"
          if (this.stats.loggingIn > 0) {
            this.stats.loggingIn--;
          }
          this.stats.loggedIn++;
          
          // ⚠️ 记录登录完成时间（到达start session页面的时间）
          const timer = this.stats.taskTimers.get(taskId);
          if (timer && timer.pageOpenTime) {
            timer.loginCompleteTime = Date.now();
            const loginTime = (timer.loginCompleteTime - timer.pageOpenTime) / 1000; // 转换为秒
            this.stats.loginTimes.push(loginTime);
          }
        }
        
        // 更新任务状态
        task.status = TaskStatus.INITIALIZING;
        console.log(`[SCHEDULER] ✅ Task ${taskId} initialized, page ready for start session`);
        
        // ⚠️ 事件驱动：任务初始化完成，触发点击start session检查
        this.triggerEvent('task-initialized');
        
        return true;
      } else {
        // 初始化失败，检查是否是429错误
        const errorMsg = String(result?.error || '').toLowerCase();
        const fullError = String(result?.error || 'Initialization failed');
        const is429Error = errorMsg.includes('429') || 
                          errorMsg.includes('rate limit') || 
                          errorMsg.includes('too many requests') ||
                          errorMsg.includes('rate limit error') ||
                          errorMsg.includes('429 error');
        
        if (is429Error) {
          console.warn(`[SCHEDULER] ⚠️ Detected 429/rate limit error in initializeTask for ${taskId}: ${fullError}`);
          this.record429Error();
        } else {
          // 非429错误，重置429错误计数
          this.reset429ErrorCount();
        }
        
      // ⚠️ 修复：清理页面和浏览器资源（初始化失败时）
      // ⚠️ 注意：初始化失败时不应该触发page-closed事件，因为页面可能还没真正打开
      // ⚠️ 直接清理资源，不调用closeTask()，避免触发事件
      await this.disposeTaskPage(task);
      // ⚠️ 不关闭浏览器，因为使用的是共享浏览器实例
      // 浏览器实例由调度器统一管理，只在 stop() 时关闭
      // 只清空浏览器引用
      task.browser = null;
      
      // 清理统计
      if (this.stats.loggingIn > 0) {
        this.stats.loggingIn--;
      }
      this.stats.taskTimers.delete(taskId);
      this.stats.failed++;
      
      // ⚠️ 修复：重置状态为PENDING而不是ERROR，允许后续重新尝试
      task.status = TaskStatus.PENDING;
      task.error = fullError;
      
      // ⚠️ 修复：初始化失败后，触发page-closed事件来启动新任务填补空缺
      // 因为资源已经清理，OpenPages数量减少了，需要启动新任务
      this.triggerEvent('page-closed');
      
      return false;
      }
    } catch (error) {
      const errorMsg = String(error.message || error.toString() || '').toLowerCase();
      const fullError = String(error.message || error.toString() || 'Unknown error');
      console.error(`[SCHEDULER] Error initializing task ${taskId}: ${fullError}`);
      
      // ⚠️ 检测429错误并记录（更全面的检测）
      const is429Error = errorMsg.includes('429') || 
                        errorMsg.includes('rate limit') || 
                        errorMsg.includes('too many requests') ||
                        errorMsg.includes('rate limit error') ||
                        errorMsg.includes('429 error');
      
      if (is429Error) {
        console.warn(`[SCHEDULER] ⚠️ Detected 429/rate limit error in catch block for ${taskId}: ${fullError}`);
        this.record429Error();
      } else {
        // 非429错误，重置429错误计数
        this.reset429ErrorCount();
      }
      
      // ⚠️ 修复：清理页面和浏览器资源（初始化失败时）
      // ⚠️ 注意：初始化失败时不应该触发page-closed事件，因为页面可能还没真正打开
      await this.disposeTaskPage(task);
      // ⚠️ 不关闭浏览器，因为使用的是共享浏览器实例
      // 浏览器实例由调度器统一管理，只在 stop() 时关闭
      // 只清空浏览器引用
      task.browser = null;
      
      // 清理统计
      if (this.stats.loggingIn > 0) {
        this.stats.loggingIn--;
      }
      this.stats.taskTimers.delete(taskId);
      this.stats.failed++;
      
      // ⚠️ 修复：重置状态为PENDING而不是ERROR，允许后续重新尝试
      task.status = TaskStatus.PENDING;
      task.error = fullError;
      
      // ⚠️ 修复：初始化失败后，触发page-closed事件来启动新任务填补空缺
      // 因为资源已经清理，OpenPages数量减少了，需要启动新任务
      this.triggerEvent('page-closed');
      
      return false;
    }
  }

  // ⚠️ 事件驱动：触发事件处理（异步，不阻塞）
  async triggerEvent(eventType) {
    if (!this.isRunning) {
      return;
    }
    
    // 将事件添加到待处理队列
    this.pendingEvents.add(eventType);
    
    // 如果正在处理事件，等待处理完成
    if (this.isProcessingEvents) {
      return;
    }
    
    // 异步处理事件（不阻塞）
    this.processPendingEvents().catch(err => {
      console.error(`[SCHEDULER] Error processing events: ${err.message}`);
    });
  }

  // ⚠️ 事件驱动：处理待处理的事件
  async processPendingEvents() {
    if (this.isProcessingEvents || this.pendingEvents.size === 0) {
      return;
    }
    
    this.isProcessingEvents = true;
    
    try {
      // 处理所有待处理的事件
      const events = Array.from(this.pendingEvents);
      this.pendingEvents.clear();
      
      for (const eventType of events) {
        switch (eventType) {
          case 'page-closed':
            await this.onPageClosed();
            break;
          case 'task-initialized':
            await this.onTaskInitialized();
            break;
          case 'task-status-changed':
            await this.onTaskStatusChanged();
            break;
          case 'task-completed':
            await this.onTaskCompleted();
            break;
          case 'task-mining-started':
            await this.onTaskMiningStarted();
            break;
          case 'task-error':
            await this.onTaskError();
            break;
        }
      }
    } finally {
      this.isProcessingEvents = false;
      
      // 如果处理过程中又有新事件，继续处理
      if (this.pendingEvents.size > 0) {
        await this.processPendingEvents();
      }
    }
  }

  // ⚠️ 事件驱动：页面关闭事件处理
  async onPageClosed() {
    await this.tryStartNewTaskAfterClose();
  }

  // ⚠️ 事件驱动：任务初始化完成事件处理 - 尝试点击start session
  async onTaskInitialized() {
    await this.tryClickStartSession();
    
    // ⚠️ 修复：任务初始化完成后，如果有可用槽位，启动新任务
    // 因为任务从 PENDING 变为 INITIALIZING 后，可以启动新任务了
    this.triggerEvent('page-closed'); // 触发新任务启动检查
  }

  // ⚠️ 事件驱动：尝试点击start session（从schedule()中提取的逻辑）
  async tryClickStartSession() {
    // ⚠️ 修复：只统计有实际页面的INITIALIZING任务
    const initializingTasks = Array.from(this.tasks.values()).filter(t => {
      if (t.status !== TaskStatus.INITIALIZING) {
        return false;
      }
      if (!t.page) {
        return false;
      }
      try {
        return !t.page.isClosed();
      } catch (error) {
        t.page = null;
        return false;
      }
    });

    for (const task of initializingTasks) {
      if (!task.page || task.page.isClosed()) {
        continue;
      }
      
      if (task.status === TaskStatus.ERROR) {
        continue;
      }

      try {
        const url = task.page.url();
        
        // 如果任务卡在 wallet 页面的 "Choose a Destination address"，需要重新初始化
        if (url.includes('/wizard/wallet')) {
          const isStuck = await task.page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            return bodyText.includes('choose a destination address') || 
                   bodyText.includes('choose a destination');
          }).catch(() => false);
          
          if (isStuck) {
            console.warn(`[SCHEDULER] ⚠️ Task ${task.id} stuck on "Choose a Destination address", retrying initialization...`);
            task.status = TaskStatus.PENDING;
            this.initializeTask(task.id).catch(err => {
              console.error(`[SCHEDULER] Error re-initializing stuck task ${task.id}: ${err.message}`);
              const timer = this.stats.taskTimers.get(task.id);
              if (timer) {
                this.stats.taskTimers.delete(task.id);
              }
              if (this.stats.loggingIn > 0) {
                this.stats.loggingIn--;
              }
              if (this.stats.loggedIn > 0) {
                this.stats.loggedIn--;
              }
              this.stats.failed++;
              task.status = TaskStatus.ERROR;
              task.error = err.message;
            });
            continue;
          }
        }

        // ⚠️ 检查限制条件
        const currentActiveMining = this.getActiveMiningCount();
        const currentOpenPages = this.getOpenPagesCount();
        
        if (currentActiveMining >= CONFIG.MAX_ACTIVE_MINING) {
          continue;
        }
        
        if (currentOpenPages >= CONFIG.MAX_OPEN_PAGES) {
          continue;
        }
        
        // 检查是否在挖矿页面并且有start session按钮
        if (url.includes('/wizard/mine')) {
          const pageStatus = await task.page.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
            const allText = bodyText + ' ' + bodyHTML;
            return {
              hasWaitingForNextChallenge: allText.includes('waiting for the next challenge'),
              hasFindingSolution: allText.includes('finding a solution'),
            };
          }).catch(() => ({ hasWaitingForNextChallenge: false, hasFindingSolution: false }));
          
          if (pageStatus.hasFindingSolution) {
            continue;
          }
          
          const startButton = task.page.getByRole('button', { name: /^(start|start session)$/i }).first();
          const isVisible = await startButton.isVisible({ timeout: 2000 }).catch(() => false);
          
          if (isVisible) {
            const isEnabled = await startButton.isEnabled().catch(() => false);
            if (isEnabled) {
              // 再次检查限制
              const finalCheckActiveMining = this.getActiveMiningCount();
              const finalCheckOpenPages = this.getOpenPagesCount();
              if (finalCheckActiveMining >= CONFIG.MAX_ACTIVE_MINING || finalCheckOpenPages >= CONFIG.MAX_OPEN_PAGES) {
                continue;
              }
              
              if (pageStatus.hasWaitingForNextChallenge) {
                console.log(`[SCHEDULER] 🎯 Clicking start session for task ${task.id} to start new mining cycle (page shows "waiting for the next challenge")... (active mining: ${finalCheckActiveMining}/${CONFIG.MAX_ACTIVE_MINING})`);
              } else {
                console.log(`[SCHEDULER] 🎯 Clicking start session for task ${task.id}... (active mining: ${finalCheckActiveMining}/${CONFIG.MAX_ACTIVE_MINING})`);
              }
              
              if (this.stats.loggedIn > 0) {
                this.stats.loggedIn--;
              }
              
              const timer = this.stats.taskTimers.get(task.id);
              if (pageStatus.hasWaitingForNextChallenge) {
                console.log(`[SCHEDULER] ℹ️ Task ${task.id} already completed (waiting for next challenge), skipping mining time tracking`);
                if (!timer) {
                  this.stats.taskTimers.set(task.id, {
                    pageOpenTime: Date.now(),
                    miningStartTime: null,
                  });
                }
              } else {
                if (timer && !timer.miningStartTime) {
                  timer.miningStartTime = Date.now();
                } else if (!timer) {
                  this.stats.taskTimers.set(task.id, {
                    pageOpenTime: Date.now(),
                    miningStartTime: Date.now(),
                  });
                }
              }
              
              task.startSessionClickCount = (task.startSessionClickCount || 0) + 1;
              task.lastStartSessionClickTime = Date.now();
              
              const clickCount = task.startSessionClickCount;
              let waitTime = 2000;
              if (clickCount > 3) {
                waitTime = 10000;
                console.warn(`[SCHEDULER] ⚠️ Task ${task.id} has clicked start session ${clickCount} times, waiting longer (${waitTime}ms) for API response...`);
              } else if (clickCount > 1) {
                waitTime = 5000;
              }
              
              await startButton.click({ timeout: 5000 }).catch(err => {
                console.warn(`[SCHEDULER] Error clicking start button for task ${task.id}: ${err.message}`);
              });
              await task.page.waitForTimeout(waitTime);
              
              // ⚠️ 点击后触发状态检查事件
              this.triggerEvent('task-status-changed');
            }
          }
        }
      } catch (error) {
        console.error(`[SCHEDULER] Error in tryClickStartSession for task ${task.id}: ${error.message}`);
      }
    }
  }

  // ⚠️ 事件驱动：任务状态变化事件处理
  async onTaskStatusChanged() {
    // 检查是否需要处理状态变化（如ActiveMining超限等）
    await this.checkAndEnforceActiveMiningLimit();
  }

  // ⚠️ 事件驱动：任务完成事件处理
  async onTaskCompleted() {
    // 立即关闭已完成的任务
    await this.closeCompletedTasks();
  }

  // ⚠️ 事件驱动：关闭已完成的任务
  async closeCompletedTasks() {
    const completedTasks = Array.from(this.tasks.values()).filter(t => 
      t.status === TaskStatus.COMPLETED || t.status === TaskStatus.WAITING_CLOSE
    );
    
    for (const task of completedTasks) {
      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.WAITING_CLOSE) {
        await this.closeTask(task.id);
        this.stats.totalCompleted++;
        this.stats.cycleCompleted++;
        this.stats.taskTimers.delete(task.id);
        console.log(`[SCHEDULER] ✅ Task ${task.id} closed immediately after completion (cycle ${task.completedInCycle || this.stats.cycle})`);
      }
    }
  }

  // ⚠️ 事件驱动：任务开始挖矿事件处理
  async onTaskMiningStarted() {
    // 检查ActiveMining是否超限
    await this.checkAndEnforceActiveMiningLimit();
    
    // ⚠️ 修复：任务进入挖矿状态后，如果有可用槽位，启动新任务
    // 因为任务从 INITIALIZING 变为 MINING 后，OpenPages 没有变化，但可以启动新任务了
    this.triggerEvent('page-closed'); // 触发新任务启动检查
  }

  // ⚠️ 事件驱动：检查并强制执行ActiveMining限制
  async checkAndEnforceActiveMiningLimit() {
    const allTasksWithPages = Array.from(this.tasks.values())
      .filter(t => t.page && !t.page.isClosed());
    
    const actuallyMiningTasks = [];
    for (const task of allTasksWithPages) {
      try {
        const page = task.page;
        const url = page.url();
        
        if (!url.includes('/wizard/mine')) {
          continue;
        }
        
        const isMining = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
          const allText = bodyText + ' ' + bodyHTML;
          
          if (allText.includes('finding a solution')) {
            return true;
          }
          
          const buttons = Array.from(document.querySelectorAll('button'));
          const hasStopSession = buttons.some(btn => {
            const text = (btn.textContent || '').trim().toLowerCase();
            return (text === 'stop' || text === 'stop session') && btn.offsetParent !== null && !btn.disabled;
          });
          
          if (hasStopSession && !allText.includes('waiting for the next challenge')) {
            return true;
          }
          
          return false;
        }).catch(() => false);
        
        if (isMining) {
          actuallyMiningTasks.push(task);
        }
      } catch (error) {
        // 忽略检测错误
      }
    }
    
    if (actuallyMiningTasks.length > CONFIG.MAX_ACTIVE_MINING) {
      console.warn(`[SCHEDULER] ⚠️ Active mining exceeded limit (${actuallyMiningTasks.length}/${CONFIG.MAX_ACTIVE_MINING} pages showing "Finding a solution"), stopping excess tasks...`);
      
      actuallyMiningTasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      
      const toStop = actuallyMiningTasks.slice(CONFIG.MAX_ACTIVE_MINING);
      for (const task of toStop) {
        console.log(`[SCHEDULER] 🛑 Stopping task ${task.id} to enforce active mining limit (clicking stop session)...`);
        const oldStatus = task.status;
        const stopped = await this.clickStopSession(task.id);
        if (stopped) {
          task.status = TaskStatus.INITIALIZING;
          if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
            this.stats.miningStarted--;
          }
          this.stats.loggedIn++;
          const timer = this.stats.taskTimers.get(task.id);
          if (timer) {
            timer.miningStartTime = null;
          }
        } else {
          console.warn(`[SCHEDULER] ⚠️ Failed to stop task ${task.id}, closing instead...`);
          await this.closeTask(task.id);
        }
      }
    }
  }

  // ⚠️ 事件驱动：任务错误事件处理
  async onTaskError() {
    // 处理错误任务
    await this.handleErrorTasks();
  }

  // ⚠️ 事件驱动：处理错误任务
  async handleErrorTasks() {
    const errorTasks = Array.from(this.tasks.values()).filter(t => 
      t.status === TaskStatus.ERROR && t.page
    );
    
    for (const task of errorTasks) {
      console.warn(`[SCHEDULER] ⚠️ Task ${task.id} is in ERROR state, closing page and resetting...`);
      await this.disposeTaskPage(task);
      
      const oldStatus = task.status;
      task.status = TaskStatus.PENDING;
      task.error = null;
      task.completionWaitStart = null;
      task.startSessionClickCount = 0;
      task.lastStartSessionClickTime = null;
      task.crashRefreshCount = 0;
      task.lastCrashRefreshTime = null;
      
      const timer = this.stats.taskTimers.get(task.id);
      if (timer) {
        this.stats.taskTimers.delete(task.id);
      }
      if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
        this.stats.miningStarted--;
      }
      if (oldStatus === TaskStatus.INITIALIZING && this.stats.loggedIn > 0) {
        this.stats.loggedIn--;
      }
      
      console.log(`[SCHEDULER] ✅ Task ${task.id} reset to PENDING after ERROR state`);
    }
  }

  // ⚠️ 事件驱动：当页面关闭后，立即检查并启动新任务
  async tryStartNewTaskAfterClose() {
    // ⚠️ 防止并发执行：如果正在启动新任务，直接返回
    if (this.isStartingNewTasks) {
      return;
    }
    
    this.isStartingNewTasks = true;
    
    try {
      // 检查是否应该暂停启动新任务（由于速率限制）
      const pauseCheck = this.shouldPauseNewTasks();
      if (pauseCheck.paused) {
        return; // 速率限制暂停中，不启动新任务（finally块会释放锁）
      }
      
      const currentOpenPages = this.getOpenPagesCount();
      const pendingTasks = Array.from(this.tasks.values())
        .filter(t => t.status === TaskStatus.PENDING)
        .sort((a, b) => {
          const aNum = parseInt(a.id.replace(/[^0-9]/g, '')) || 0;
          const bNum = parseInt(b.id.replace(/[^0-9]/g, '')) || 0;
          return aNum - bNum;
        });
      // ⚠️ 修复：统计所有INITIALIZING状态的任务（不管页面是否已创建）
      // 因为一旦设置为INITIALIZING，就表示正在打开页面，应该计入并发限制
      const initializingTasks = Array.from(this.tasks.values()).filter(t => 
        t.status === TaskStatus.INITIALIZING
      );
      
      // 检查是否可以启动新任务
      const initializingCount = initializingTasks.length;
      const availablePageSlots = CONFIG.MAX_OPEN_PAGES - currentOpenPages;
      
      // ⚠️ 严格检查：必须同时满足所有条件
      const canOpenMore = currentOpenPages < CONFIG.MAX_OPEN_PAGES &&
                         initializingCount < CONFIG.PAGE_OPEN_CONCURRENCY &&
                         availablePageSlots > 0 &&
                         pendingTasks.length > 0;
      
      if (canOpenMore) {
        // ⚠️ 计算可启动数量：取最小值，确保不超过任何限制
        const toStart = Math.min(
          CONFIG.PAGE_OPEN_CONCURRENCY - initializingCount, // 并发限制
          availablePageSlots, // 可用页面槽位
          pendingTasks.length // 待处理任务数
        );
        
        if (toStart > 0) {
          console.log(`[SCHEDULER] 🔔 Page closed, triggering new task start: available slots=${availablePageSlots}, concurrency=${CONFIG.PAGE_OPEN_CONCURRENCY - initializingCount}, pending=${pendingTasks.length}, currentOpenPages=${currentOpenPages}/${CONFIG.MAX_OPEN_PAGES}, initializingCount=${initializingCount}`);
          
          for (let i = 0; i < toStart; i++) {
            const task = pendingTasks[i];
            if (task.status === TaskStatus.PENDING) {
              // ⚠️ 先设置状态为INITIALIZING，这样会被计入统计，防止后续任务超限
              task.status = TaskStatus.INITIALIZING;
              
              // ⚠️ 设置状态后立即重新检查OpenPages和并发限制（状态已更新）
              const checkOpenPages = this.getOpenPagesCount();
              const checkInitializing = Array.from(this.tasks.values()).filter(t => 
                t.status === TaskStatus.INITIALIZING
              ).length;
              
              // ⚠️ 调试日志：显示当前状态
              if (i === 0) {
                console.log(`[SCHEDULER] 🔍 Debug: After setting task ${task.id} to INITIALIZING, checkOpenPages=${checkOpenPages}, checkInitializing=${checkInitializing}`);
              }
              
              // ⚠️ 严格检查：如果已达到任何限制，停止启动并重置状态
              if (checkOpenPages > CONFIG.MAX_OPEN_PAGES) {
                console.warn(`[SCHEDULER] ⚠️ Stopping new task starts: OpenPages limit exceeded (${checkOpenPages}/${CONFIG.MAX_OPEN_PAGES}), resetting task ${task.id} to PENDING`);
                task.status = TaskStatus.PENDING; // 重置状态
                break; // 已达到上限，停止启动
              }
              
              if (checkInitializing > CONFIG.PAGE_OPEN_CONCURRENCY) {
                console.warn(`[SCHEDULER] ⚠️ Stopping new task starts: Concurrency limit exceeded (${checkInitializing}/${CONFIG.PAGE_OPEN_CONCURRENCY}), resetting task ${task.id} to PENDING`);
                task.status = TaskStatus.PENDING; // 重置状态
                break; // 已达到并发限制，停止启动
              }
              
              console.log(`[SCHEDULER] 🚀 Starting task ${task.id} (triggered by page close)...`);
              // 异步启动，不阻塞
              this.initializeTask(task.id).catch(err => {
                const errorMsg = err?.message || String(err) || 'Unknown error';
                const errorStack = err?.stack || '';
                const fullError = errorStack || errorMsg;
                const errorMsgLower = errorMsg.toLowerCase();
                
                console.error(`[SCHEDULER] ❌ Error starting task ${task.id}: ${errorMsg}`);
                if (errorStack && errorStack !== errorMsg) {
                  console.error(`[SCHEDULER] Task ${task.id} error stack: ${errorStack.substring(0, 500)}`);
                }
                
                const is429Error = errorMsgLower.includes('429') || 
                                  errorMsgLower.includes('rate limit') || 
                                  errorMsgLower.includes('too many requests') ||
                                  errorMsgLower.includes('rate limit error') ||
                                  errorMsgLower.includes('429 error');
                
                if (is429Error) {
                  console.warn(`[SCHEDULER] ⚠️ Detected 429/rate limit error for task ${task.id}: ${errorMsg}`);
                  this.record429Error();
                } else {
                  this.reset429ErrorCount();
                }
                
                const timer = this.stats.taskTimers.get(task.id);
                if (timer) {
                  this.stats.taskTimers.delete(task.id);
                }
                if (this.stats.loggingIn > 0) {
                  this.stats.loggingIn--;
                }
                this.stats.failed++;
                
                task.status = TaskStatus.ERROR;
                task.error = errorMsg;
              });
            }
          }
        }
      }
    } finally {
      // ⚠️ 释放锁
      this.isStartingNewTasks = false;
    }
  }

  // ⚠️ 统一释放任务的页面/context资源
  async disposeTaskPage(task) {
    if (!task) {
      return false;
    }

    let hadOpenPage = false;
    if (task.page) {
      try {
        hadOpenPage = !task.page.isClosed();
      } catch {
        hadOpenPage = false;
      }
    }

    if (task.context) {
      try {
        await task.context.close();
      } catch (error) {
        // 忽略关闭错误
      }
      task.context = null;
      task.page = null;
      return hadOpenPage;
    }

    if (task.page) {
      try {
        if (!task.page.isClosed()) {
          await task.page.close().catch(() => {});
        }
      } catch (error) {
        // 忽略关闭错误
      }
      task.page = null;
    }

    task.context = null;
    return hadOpenPage;
  }

  // 关闭任务页面
  async closeTask(taskId, shouldTriggerEvent = true) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    try {
      // ⚠️ 如果任务是从COMPLETED或WAITING_CLOSE状态关闭的，确保统计已更新
      const wasCompleted = task.status === TaskStatus.COMPLETED || task.status === TaskStatus.WAITING_CLOSE;
      
      const hadOpenPage = await this.disposeTaskPage(task);

      // ⚠️ 不关闭浏览器，因为使用的是共享浏览器实例
      // 浏览器实例由调度器统一管理，只在 stop() 时关闭
      // 只清空浏览器引用
      task.browser = null;
      
      // ⚠️ 只有在任务状态不是PENDING时才设置为CLOSED（PENDING状态的任务不应该被标记为CLOSED）
      if (task.status !== TaskStatus.PENDING) {
        task.status = TaskStatus.CLOSED;
      }
      
      // ⚠️ 如果任务是从COMPLETED状态关闭的，确保统计已更新（防止重复计数）
      if (wasCompleted) {
        // 统计已在schedule()中更新，这里不需要再次更新
      }
      
      console.log(`[SCHEDULER] ✅ Closed task ${taskId}`);
      
      // ⚠️ 事件驱动：只有在有实际打开的页面被关闭时才触发事件
      // 初始化失败时（页面还没打开或已经关闭）不应该触发事件，避免错误启动新任务
      if (shouldTriggerEvent && hadOpenPage) {
        this.triggerEvent('page-closed');
      }
    } catch (error) {
      console.error(`[SCHEDULER] Error closing task ${taskId}: ${error.message}`);
      // ⚠️ 即使出错，也确保页面引用被清空
      if (task) {
        task.page = null;
        task.context = null;
        task.browser = null;
      }
      // ⚠️ 即使出错，也尝试启动新任务（因为页面已经关闭）
      // 但只有在有实际页面被关闭时才触发
      // ⚠️ 注意：这里应该触发事件，而不是直接调用，避免并发问题
      if (shouldTriggerEvent && hadOpenPage) {
        this.triggerEvent('page-closed');
      }
    }
  }

  // 检查是否到了新的周期（整点）
  checkCycleReset() {
    const now = new Date();
    const currentHour = now.getHours();
    
    if (!this.currentCycleStartTime) {
      // 第一次运行，设置当前周期
      this.currentCycleStartTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), currentHour, 0, 0);
      return false;
    }

    const cycleHour = this.currentCycleStartTime.getHours();
    
    // 如果当前小时与周期开始小时不同，说明进入了新周期
    if (currentHour !== cycleHour) {
      console.log(`[SCHEDULER] ⏰ New cycle detected: ${cycleHour}:00 -> ${currentHour}:00`);
      return true;
    }

    return false;
  }

  // 重置周期
  // ⚠️ 如果 RESET_AT_HOUR=true，关闭所有窗口并重新从 task 0 开始
  // ⚠️ 如果 RESET_AT_HOUR=false，保留正在挖矿的任务，只关闭超时或已完成的任务
  async resetCycle() {
    const oldCycle = this.stats.cycle;
    const newCycle = oldCycle + 1;
    console.log(`[SCHEDULER] 🔄 Resetting cycle ${oldCycle} -> ${newCycle}`);
    
    // 更新周期信息（先更新，以便后续判断）
    const now = new Date();
    const currentHour = now.getHours();
    const previousCycleStartTime = this.currentCycleStartTime;
    this.currentCycleStartTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), currentHour, 0, 0);
    this.stats.cycle = newCycle;
    this.stats.cycleCompleted = 0;
    
    if (CONFIG.RESET_AT_HOUR) {
      // ⚠️ RESET_AT_HOUR=true: 关闭所有窗口，重新从 task 0 开始
      console.log(`[SCHEDULER] 🔄 RESET_AT_HOUR enabled: Closing ALL windows and resetting all tasks to PENDING`);
      
      // 关闭所有打开的页面
      const allTasks = Array.from(this.tasks.values());
      let closedCount = 0;
      for (const task of allTasks) {
        if (task.page && !task.page.isClosed()) {
          try {
            await this.closeTask(task.id, false); // 不触发事件，避免重复启动
            closedCount++;
          } catch (error) {
            console.error(`[SCHEDULER] Error closing task ${task.id} during reset: ${error.message}`);
          }
        }
      }
      console.log(`[SCHEDULER] ✅ Closed ${closedCount} page(s) during reset`);
      
      // 重置所有任务状态为 PENDING
      for (const [taskId, task] of this.tasks) {
        task.status = TaskStatus.PENDING;
        task.page = null;
        task.context = null;
        task.browser = null;
        task.completedAt = null;
        task.error = null;
        task.completionWaitStart = null;
        task.startSessionClickCount = 0;
        task.lastStartSessionClickTime = null;
        task.miningCycle = null;
        task.miningCycleStartTime = null;
        task.completedInCycle = null;
        task.crashRefreshCount = 0;
        task.lastCrashRefreshTime = null;
        task.hasSubmittedSolution = false; // 重置 submitSolution 标记
        // 清理计时器
        this.stats.taskTimers.delete(taskId);
      }
      
      // 清理统计信息
      this.stats.loggingIn = 0;
      this.stats.loggedIn = 0;
      this.stats.cycleSubmitSolution = 0;
      
      // 清除速率限制暂停状态
      if (this.rateLimitInfo.pauseUntil || this.rateLimitInfo.consecutive429Errors > 0) {
        const hadPause = this.rateLimitInfo.pauseUntil !== null;
        const errorCount = this.rateLimitInfo.consecutive429Errors;
        this.rateLimitInfo.consecutive429Errors = 0;
        this.rateLimitInfo.last429ErrorTime = null;
        this.rateLimitInfo.pauseUntil = null;
        if (hadPause) {
          console.log(`[SCHEDULER] ✓ Cleared rate limit pause for new cycle (was paused with ${errorCount} consecutive errors)`);
        }
      }
      
      console.log(`[SCHEDULER] ✅ Cycle reset complete. All tasks reset to PENDING, will restart from task 0`);
      
      // ⚠️ 触发 page-closed 事件来启动新任务（从 task 0 开始）
      this.triggerEvent('page-closed');
      
    } else {
      // ⚠️ RESET_AT_HOUR=false: 保留正在挖矿的任务，只关闭超时或已完成的任务
      // 获取当前正在挖矿的任务
      const activeMiningTasks = Array.from(this.tasks.values()).filter(t => 
        t.status === TaskStatus.MINING && t.page && !t.page.isClosed()
      );
      const activeMiningCount = activeMiningTasks.length;
      
      console.log(`[SCHEDULER] 📊 Cycle reset: Found ${activeMiningCount} active mining task(s) to preserve`);
      
      // ⚠️ 处理正在挖矿的任务
      const tasksToClose = [];
      const tasksToPreserve = [];
      
      for (const task of activeMiningTasks) {
        // ⚠️ 检查任务是否从更早的周期开始挖矿，且在当前周期结束时还未完成
        // 判断条件：如果任务从更早的周期开始（miningCycle < oldCycle），说明任务已经跨越了一个完整周期还没完成，应该关闭
        // 如果任务在当前周期开始（miningCycle === oldCycle），应该继续在新周期挖矿
        const taskMiningCycle = task.miningCycle || oldCycle;
        const isFromEarlierCycle = taskMiningCycle < oldCycle;
        
        if (isFromEarlierCycle) {
          // 任务从更早的周期开始挖矿，且在当前周期结束时还未完成，需要强制关闭
          const miningStartTime = this.stats.taskTimers.get(task.id)?.miningStartTime;
          const miningDuration = miningStartTime ? Math.floor((Date.now() - miningStartTime) / 1000 / 60) : 'unknown'; // 分钟
          console.log(`[SCHEDULER] ⚠️ Task ${task.id} started mining at cycle ${taskMiningCycle} but not completed by end of cycle ${oldCycle}, will be closed (mining duration: ${miningDuration} minutes)`);
          tasksToClose.push(task.id);
        } else {
          // 任务在当前周期开始挖矿，继续在新周期挖矿
          console.log(`[SCHEDULER] ✅ Task ${task.id} will continue mining in cycle ${newCycle} (started at cycle ${taskMiningCycle})`);
          tasksToPreserve.push(task.id);
          // ⚠️ 如果任务是从上一周期继承的，确保周期信息正确
          if (!task.miningCycle) {
            task.miningCycle = oldCycle; // 标记为上一个周期开始的
          }
          // 如果任务在新周期完成，completedInCycle 将在状态更新时设置为 newCycle
        }
      }
      
      // ⚠️ 关闭超时的挖矿任务（从上一周期开始挖矿，且在当前周期内未完成）
      for (const taskId of tasksToClose) {
        console.log(`[SCHEDULER] 🔒 Closing timeout task ${taskId} (started in previous cycle, not completed in current cycle)`);
        await this.closeTask(taskId);
        const task = this.tasks.get(taskId);
        if (task) {
          task.status = TaskStatus.PENDING;
          task.miningCycle = null;
          task.miningCycleStartTime = null;
          // 清理计时器
          this.stats.taskTimers.delete(taskId);
        }
      }
      
      // ⚠️ 关闭所有非挖矿状态的页面（已完成、错误、等待关闭等）
      for (const [taskId, task] of this.tasks) {
        if (tasksToPreserve.includes(taskId)) {
          continue; // 跳过保留的任务
        }
        
        if (task.status !== TaskStatus.MINING && task.page && !task.page.isClosed()) {
          console.log(`[SCHEDULER] 🔒 Closing non-mining task ${taskId} (status: ${task.status})`);
          await this.closeTask(taskId);
        }
        
        // ⚠️ 重置非挖矿任务的状态（保留正在挖矿的任务）
        if (task.status !== TaskStatus.MINING) {
          task.status = TaskStatus.PENDING;
          task.page = null;
          task.context = null;
          task.completedAt = null;
          task.error = null;
          task.completionWaitStart = null;
          task.startSessionClickCount = 0;
          task.lastStartSessionClickTime = null;
          task.miningCycle = null;
          task.miningCycleStartTime = null;
          task.completedInCycle = null;
          task.crashRefreshCount = 0;
          task.lastCrashRefreshTime = null;
          task.hasSubmittedSolution = false; // 重置 submitSolution 标记
          // 清理计时器
          this.stats.taskTimers.delete(taskId);
        }
      }

      // ⚠️ 清理统计信息（周期重置时需要清理状态计数，但保留累计统计）
      // 清理状态计数（这些是当前周期的实时计数）
      this.stats.loggingIn = 0;
      this.stats.loggedIn = 0;
      this.stats.cycleSubmitSolution = 0; // 重置当前周期的submitSolution计数
      // 注意：不重置miningStarted、success和submitSolution，因为这些是累计统计
      // 但清理已关闭任务的计时器（已在上面处理）
      
      // ⚠️ 清除速率限制暂停状态（新周期开始时应该清除之前的限制）
      if (this.rateLimitInfo.pauseUntil || this.rateLimitInfo.consecutive429Errors > 0) {
        const hadPause = this.rateLimitInfo.pauseUntil !== null;
        const errorCount = this.rateLimitInfo.consecutive429Errors;
        this.rateLimitInfo.consecutive429Errors = 0;
        this.rateLimitInfo.last429ErrorTime = null;
        this.rateLimitInfo.pauseUntil = null;
        if (hadPause) {
          console.log(`[SCHEDULER] ✓ Cleared rate limit pause for new cycle (was paused with ${errorCount} consecutive errors)`);
        }
      }
      
      console.log(`[SCHEDULER] ✅ Cycle reset complete. Starting cycle ${newCycle} with ${tasksToPreserve.length} preserved mining task(s)`);
    }
  }

  // 主调度循环
  async schedule() {
    if (!this.isRunning) {
      return;
    }

    // 检查周期重置（如果启用了RESET_AT_HOUR）
    if (CONFIG.RESET_AT_HOUR && this.checkCycleReset()) {
      await this.resetCycle();
    }

    // ⚠️ 修复：在调度循环开始时立即检查OpenPages，如果超限则强制清理
    let openPages = this.getOpenPagesCount();
    if (openPages > CONFIG.MAX_OPEN_PAGES) {
      console.warn(`[SCHEDULER] ⚠️ OpenPages exceeds limit at start of schedule (${openPages}/${CONFIG.MAX_OPEN_PAGES}), forcing cleanup...`);
      
      // ⚠️ 强制清理：关闭所有非MINING状态的任务（保留正在挖矿的任务）
      // 优先级：1) INITIALIZING状态（最优先关闭） 2) 最晚创建的
      const tasksToForceClose = Array.from(this.tasks.values())
        .filter(t => {
          if (t.status === TaskStatus.CLOSED || t.status === TaskStatus.ERROR || t.status === TaskStatus.PENDING) {
            return false;
          }
          if (t.status === TaskStatus.MINING) {
            return false; // 保留MINING状态的任务
          }
          if (!t.page) {
            return false;
          }
          try {
            return !t.page.isClosed();
          } catch (error) {
            t.page = null;
            return false;
          }
        })
        .sort((a, b) => {
          // 优先关闭INITIALIZING状态的任务
          if (a.status === TaskStatus.INITIALIZING && b.status !== TaskStatus.INITIALIZING) {
            return -1;
          }
          if (a.status !== TaskStatus.INITIALIZING && b.status === TaskStatus.INITIALIZING) {
            return 1;
          }
          // 同状态时，最晚创建的优先关闭
          return (b.createdAt || 0) - (a.createdAt || 0);
        });
      
      let forceClosedCount = 0;
      for (const task of tasksToForceClose) {
        const currentOpen = this.getOpenPagesCount();
        if (currentOpen <= CONFIG.MAX_OPEN_PAGES) {
          break;
        }
        
        console.log(`[SCHEDULER] 🛑 Force closing task ${task.id} (status: ${task.status}) at schedule start (current: ${currentOpen}/${CONFIG.MAX_OPEN_PAGES})...`);
        const oldStatus = task.status;
        await this.closeTask(task.id);
        task.status = TaskStatus.PENDING;
        task.page = null;
        task.context = null;
        task.browser = null;
        
        // 清理统计
        const timer = this.stats.taskTimers.get(task.id);
        if (timer) {
          this.stats.taskTimers.delete(task.id);
        }
        if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
          this.stats.miningStarted--;
        }
        if (oldStatus === TaskStatus.INITIALIZING) {
          if (this.stats.loggingIn > 0) {
            this.stats.loggingIn--;
          }
          if (this.stats.loggedIn > 0) {
            this.stats.loggedIn--;
          }
        }
        
        forceClosedCount++;
      }
      
      if (forceClosedCount > 0) {
        openPages = this.getOpenPagesCount();
        console.log(`[SCHEDULER] ✅ Force closed ${forceClosedCount} task(s) at schedule start, OpenPages now: ${openPages}/${CONFIG.MAX_OPEN_PAGES}`);
      } else {
        // ⚠️ 如果没有关闭任何任务，说明可能有页面计数不准确的问题，尝试强制清理无效引用
        console.warn(`[SCHEDULER] ⚠️ OpenPages exceeds limit (${openPages}/${CONFIG.MAX_OPEN_PAGES}) but no tasks were closed. Attempting to clean invalid page references...`);
        let cleanedCount = 0;
        for (const task of this.tasks.values()) {
          if (task.page) {
            try {
              if (task.page.isClosed()) {
                task.page = null;
                task.context = null;
                cleanedCount++;
              }
            } catch (error) {
              task.page = null;
              task.context = null;
              cleanedCount++;
            }
          }
        }
        if (cleanedCount > 0) {
          const afterCleanup = this.getOpenPagesCount();
          console.log(`[SCHEDULER] ✅ Cleaned ${cleanedCount} invalid page reference(s), OpenPages now: ${afterCleanup}/${CONFIG.MAX_OPEN_PAGES}`);
          openPages = afterCleanup;
        }
      }
    }
    
    const activeMining = this.getActiveMiningCount();
    const totalTasks = this.tasks.size;

    // ⚠️ 统计待处理任务，按任务ID排序（确保从头开始取未完成的任务）
    const pendingTasks = Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.PENDING)
      .sort((a, b) => {
        // 按任务ID排序（job-1, job-2, ...）
        const aNum = parseInt(a.id.replace(/[^0-9]/g, '')) || 0;
        const bNum = parseInt(b.id.replace(/[^0-9]/g, '')) || 0;
        return aNum - bNum;
      });
    // ⚠️ 修复：统计所有 INITIALIZING 状态的任务（与 getOpenPagesCount() 逻辑一致）
    // 因为 getOpenPagesCount() 会将所有 INITIALIZING 状态的任务计入，无论页面是否存在
    const initializingTasks = Array.from(this.tasks.values()).filter(t => 
      t.status === TaskStatus.INITIALIZING
    );
    const miningTasks = Array.from(this.tasks.values()).filter(t => 
      t.status === TaskStatus.MINING
    );
    const completedTasks = Array.from(this.tasks.values()).filter(t => 
      t.status === TaskStatus.COMPLETED || t.status === TaskStatus.WAITING_CLOSE
    );
    // ⚠️ 修复：Completed统计应该包括COMPLETED、WAITING_CLOSE和CLOSED状态的任务
    const closedTasks = Array.from(this.tasks.values()).filter(t => 
      t.status === TaskStatus.CLOSED
    );

    // ⚠️ 统一日志格式：所有地方都使用相同的计数方法
    const totalCompleted = completedTasks.length + closedTasks.length;
    
    // ⚠️ 状态日志节流：只在重要状态变化或达到时间间隔时输出
    const now = Date.now();
    const currentStatusSnapshot = {
      pending: pendingTasks.length,
      initializing: initializingTasks.length,
      mining: miningTasks.length,
      completed: totalCompleted,
      openPages: openPages,
      activeMining: activeMining,
      submitSolution: this.stats.submitSolution,
      cycleSubmitSolution: this.stats.cycleSubmitSolution,
    };
    
    // 检查重要状态是否发生变化（包括OpenPages的变化，因为超限是严重问题）
    const importantStatusChanged = !this.lastStatusSnapshot || 
      this.lastStatusSnapshot.completed !== currentStatusSnapshot.completed ||
      this.lastStatusSnapshot.mining !== currentStatusSnapshot.mining ||
      this.lastStatusSnapshot.activeMining !== currentStatusSnapshot.activeMining ||
      this.lastStatusSnapshot.submitSolution !== currentStatusSnapshot.submitSolution ||
      this.lastStatusSnapshot.cycleSubmitSolution !== currentStatusSnapshot.cycleSubmitSolution ||
      (this.lastStatusSnapshot.openPages !== currentStatusSnapshot.openPages && 
       (currentStatusSnapshot.openPages > CONFIG.MAX_OPEN_PAGES || this.lastStatusSnapshot.openPages > CONFIG.MAX_OPEN_PAGES)); // ⚠️ OpenPages超限时立即记录
    
    // 检查是否达到时间间隔（默认60秒，减少日志频率）
    const timeSinceLastLog = now - this.lastStatusLogTime;
    const shouldLog = importantStatusChanged || timeSinceLastLog >= this.statusLogInterval;
    
    if (shouldLog) {
      // ⚠️ 修复：重新计算openPages，确保日志准确（可能在处理过程中已变化）
      const currentOpenPages = this.getOpenPagesCount();
      const openPagesWarning = currentOpenPages > CONFIG.MAX_OPEN_PAGES ? ' ⚠️ EXCEEDED!' : '';
      
      // ⚠️ 修复：统计实际有页面的任务数，用于调试（与 getOpenPagesCount() 逻辑一致）
      // 统计逻辑：INITIALIZING 状态无论页面是否存在都计入，其他状态只有页面存在且未关闭时才计入
      const tasksWithPages = Array.from(this.tasks.values()).filter(t => {
        if (t.status === TaskStatus.INITIALIZING) {
          // INITIALIZING 状态：无论页面是否存在，都计入（正在打开中）
          return true;
        } else if (t.status !== TaskStatus.PENDING && 
                   t.status !== TaskStatus.CLOSED && 
                   t.status !== TaskStatus.ERROR) {
          // 其他状态：只有页面存在且未关闭时才计入
          if (t.page) {
            try {
              return !t.page.isClosed();
            } catch {
              return false;
            }
          }
        }
        return false;
      }).length;
      
      // ⚠️ 获取正在 mining 的 task ids
      const miningTaskIds = miningTasks.map(t => t.id).join(', ');
      const miningInfo = miningTasks.length > 0 ? ` (${miningTaskIds})` : '';
      
      console.log(`[SCHEDULER] 📊 Status: Pending=${pendingTasks.length}, Initializing=${initializingTasks.length}, Mining=${miningTasks.length}${miningInfo}, Completed=${totalCompleted}, SubmitSolution=${this.stats.cycleSubmitSolution}, OpenPages=${currentOpenPages}/${CONFIG.MAX_OPEN_PAGES}${openPagesWarning} (tasks with pages: ${tasksWithPages}), ActiveMining=${activeMining}/${CONFIG.MAX_ACTIVE_MINING}${activeMining > CONFIG.MAX_ACTIVE_MINING ? ' ⚠️ EXCEEDED!' : ''}`);
      this.lastStatusLogTime = now;
      // ⚠️ 更新快照中的openPages为当前值
      currentStatusSnapshot.openPages = currentOpenPages;
      this.lastStatusSnapshot = currentStatusSnapshot;
    }

    // ⚠️ 事件驱动：已完成的任务通过事件处理（onTaskCompleted），这里不再轮询处理
    // 但为了兼容性，仍然检查并触发事件（如果状态检测发现了COMPLETED任务）
    if (completedTasks.length > 0) {
      this.triggerEvent('task-completed');
    }
    
    // ⚠️ 修复：关闭已完成任务后，重新检查OpenPages，如果仍然超过限制，强制关闭多余的任务
    const openPagesAfterCleanup = this.getOpenPagesCount();
    if (openPagesAfterCleanup > CONFIG.MAX_OPEN_PAGES) {
      console.warn(`[SCHEDULER] ⚠️ OpenPages still exceeds limit after cleanup (${openPagesAfterCleanup}/${CONFIG.MAX_OPEN_PAGES}), closing excess tasks...`);
      
      // ⚠️ 获取所有有页面的任务，按优先级排序关闭
      // 优先级：1) INITIALIZING（最优先关闭） 2) 最晚创建的
      const tasksWithPages = Array.from(this.tasks.values())
        .filter(t => {
          if (t.status === TaskStatus.CLOSED || t.status === TaskStatus.ERROR || t.status === TaskStatus.PENDING) {
            return false;
          }
          if (!t.page) {
            return false;
          }
          try {
            return !t.page.isClosed();
          } catch (error) {
            // 页面检查出错，视为已关闭
            t.page = null;
            return false;
          }
        })
        .sort((a, b) => {
          // 优先关闭INITIALIZING状态的任务
          if (a.status === TaskStatus.INITIALIZING && b.status !== TaskStatus.INITIALIZING) {
            return -1;
          }
          if (a.status !== TaskStatus.INITIALIZING && b.status === TaskStatus.INITIALIZING) {
            return 1;
          }
          // 同状态时，最晚创建的优先关闭
          return (b.createdAt || 0) - (a.createdAt || 0);
        });
      
      let closedCount = 0;
      const targetCount = CONFIG.MAX_OPEN_PAGES;
      
      for (const task of tasksWithPages) {
        const currentOpenPages = this.getOpenPagesCount();
        if (currentOpenPages <= targetCount) {
          break; // 已经降到限制以下，停止关闭
        }
        
        console.log(`[SCHEDULER] 🛑 Closing task ${task.id} (status: ${task.status}) to enforce OpenPages limit (current: ${currentOpenPages}/${CONFIG.MAX_OPEN_PAGES})...`);
        
        const oldStatus = task.status;
        await this.closeTask(task.id);
        
        // 重置任务状态为PENDING，以便后续重新启动
        task.status = TaskStatus.PENDING;
        task.page = null;
        task.context = null;
        task.browser = null;
        
        // 清理统计
        const timer = this.stats.taskTimers.get(task.id);
        if (timer) {
          this.stats.taskTimers.delete(task.id);
        }
        if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
          this.stats.miningStarted--;
        }
        if (oldStatus === TaskStatus.INITIALIZING) {
          if (this.stats.loggingIn > 0) {
            this.stats.loggingIn--;
          }
          if (this.stats.loggedIn > 0) {
            this.stats.loggedIn--;
          }
        }
        
        closedCount++;
      }
      
      if (closedCount > 0) {
        const finalOpenPages = this.getOpenPagesCount();
        console.log(`[SCHEDULER] ✅ Closed ${closedCount} task(s), OpenPages reduced from ${openPagesAfterCleanup} to ${finalOpenPages}/${CONFIG.MAX_OPEN_PAGES}`);
      } else {
        // ⚠️ 如果没有关闭任何任务，说明可能有页面计数不准确的问题
        console.warn(`[SCHEDULER] ⚠️ OpenPages exceeds limit (${openPagesAfterCleanup}/${CONFIG.MAX_OPEN_PAGES}) but no tasks were closed. This may indicate a counting issue.`);
        
        // 尝试强制清理：检查所有任务，清理无效的页面引用
        let cleanedCount = 0;
        for (const task of this.tasks.values()) {
          if (task.page) {
            try {
              if (task.page.isClosed()) {
                task.page = null;
                task.context = null;
                cleanedCount++;
              }
            } catch (error) {
              // 页面检查出错，清理引用
              task.page = null;
              task.context = null;
              cleanedCount++;
            }
          }
        }
        if (cleanedCount > 0) {
          const afterCleanup = this.getOpenPagesCount();
          console.log(`[SCHEDULER] ✅ Cleaned ${cleanedCount} invalid page reference(s), OpenPages now: ${afterCleanup}/${CONFIG.MAX_OPEN_PAGES}`);
        }
      }
    }

    // 2. 更新所有任务状态
    // ⚠️ 注意：在更新状态时，如果发现active mining超出限制，需要关闭部分任务
    for (const taskId of this.tasks.keys()) {
      const task = this.tasks.get(taskId);
      if (task.page && !task.page.isClosed()) {
        // ⚠️ 如果任务已经在等待关闭，不再更新状态（避免重置等待时间）
        if (task.status === TaskStatus.WAITING_CLOSE) {
          continue;
        }
        
        // ⚠️ 如果任务已经是ERROR状态，直接处理错误任务（关闭页面、重置状态）
        if (task.status === TaskStatus.ERROR) {
          console.warn(`[SCHEDULER] ⚠️ Task ${taskId} is in ERROR state, closing page and resetting...`);
          await this.disposeTaskPage(task);
          
          // 重置任务状态
          const oldStatus = task.status;
          task.status = TaskStatus.PENDING;
          task.error = null;
          task.completionWaitStart = null;
          task.startSessionClickCount = 0;
          task.lastStartSessionClickTime = null;
          task.crashRefreshCount = 0;
          task.lastCrashRefreshTime = null;
          
          // 清理统计
          const timer = this.stats.taskTimers.get(taskId);
          if (timer) {
            this.stats.taskTimers.delete(taskId);
          }
          if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
            this.stats.miningStarted--;
          }
          if (oldStatus === TaskStatus.INITIALIZING && this.stats.loggedIn > 0) {
            this.stats.loggedIn--;
          }
          
          console.log(`[SCHEDULER] ✅ Task ${taskId} reset to PENDING after ERROR state`);
          continue;
        }
        
        const detectedStatus = await this.detectTaskStatus(taskId);
        
        // ⚠️ 如果检测到页面崩溃，先尝试刷新恢复（每3秒刷新一次，最多3次）
        if (detectedStatus.status === TaskStatus.ERROR && detectedStatus.error && detectedStatus.error.includes('crashed')) {
          const now = Date.now();
          const timeSinceLastRefresh = task.lastCrashRefreshTime ? (now - task.lastCrashRefreshTime) : Infinity;
          
          // 如果距离上次刷新已经超过3秒，且刷新次数未达到3次，尝试刷新
          if (timeSinceLastRefresh >= 3000 && task.crashRefreshCount < 3) {
            task.crashRefreshCount++;
            task.lastCrashRefreshTime = now;
            
            console.warn(`[SCHEDULER] ⚠️ Task ${task.id} page crashed, attempting refresh ${task.crashRefreshCount}/3...`);
            
            try {
              if (task.page && !task.page.isClosed()) {
                await task.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await task.page.waitForTimeout(3000); // 等待页面加载
                
                // 刷新后再次检测状态
                const afterRefreshStatus = await this.detectTaskStatus(taskId);
                if (afterRefreshStatus.status !== TaskStatus.ERROR) {
                  // 刷新后页面恢复正常
                  console.log(`[SCHEDULER] ✅ Task ${task.id} page recovered after refresh ${task.crashRefreshCount}/3`);
                  task.crashRefreshCount = 0; // 重置刷新计数
                  task.lastCrashRefreshTime = null;
                  // 更新状态
                  if (afterRefreshStatus.status !== task.status) {
                    task.status = afterRefreshStatus.status;
                  }
                  continue; // 跳过后续处理，等待下次循环检测
                } else {
                  // 刷新后仍然崩溃
                  console.warn(`[SCHEDULER] ⚠️ Task ${task.id} page still crashed after refresh ${task.crashRefreshCount}/3`);
                  // 继续等待下次刷新（如果还有机会）
                  continue;
                }
              }
            } catch (refreshError) {
              console.error(`[SCHEDULER] ❌ Failed to refresh crashed page for task ${task.id}: ${refreshError.message}`);
              // 刷新失败，继续等待下次刷新（如果还有机会）
              continue;
            }
          } else if (task.crashRefreshCount >= 3) {
            // 已经刷新3次仍然崩溃，标记为ERROR
            console.error(`[SCHEDULER] ❌ Task ${task.id} page crashed after ${task.crashRefreshCount} refresh attempts, marking as ERROR`);
            task.status = TaskStatus.ERROR;
            task.error = 'Page crashed after 3 refresh attempts';
            
            // ⚠️ 事件驱动：任务错误，触发错误处理
            this.triggerEvent('task-error');
            
            // 关闭页面并重置状态
            await this.disposeTaskPage(task);
            
            const oldStatus = task.status;
            task.status = TaskStatus.PENDING;
            task.error = 'Page crashed after 3 refresh attempts';
            task.completionWaitStart = null;
            task.startSessionClickCount = 0;
            task.lastStartSessionClickTime = null;
            task.crashRefreshCount = 0;
            task.lastCrashRefreshTime = null;
            
            // 清理统计
            const timer = this.stats.taskTimers.get(task.id);
            if (timer) {
              this.stats.taskTimers.delete(task.id);
            }
            if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
              this.stats.miningStarted--;
            }
            if (oldStatus === TaskStatus.INITIALIZING && this.stats.loggedIn > 0) {
              this.stats.loggedIn--;
            }
            
            console.log(`[SCHEDULER] ✅ Task ${task.id} reset to PENDING after 3 failed refresh attempts`);
            continue;
          } else {
            // 距离上次刷新不足3秒，等待下次循环
            continue;
          }
        }
        
        if (detectedStatus.status !== task.status) {
          const oldStatus = task.status;
          
          // ⚠️ 如果检测到状态变为MINING，检查是否会超出限制
          if (detectedStatus.status === TaskStatus.MINING) {
            const currentActiveMining = this.getActiveMiningCount();
            if (currentActiveMining >= CONFIG.MAX_ACTIVE_MINING) {
              // 已达到最大挖矿数，不更新为MINING状态
              console.warn(`[SCHEDULER] ⚠️ Task ${task.id} would start mining but limit reached (${currentActiveMining}/${CONFIG.MAX_ACTIVE_MINING}), keeping status as ${oldStatus}`);
              continue; // 保持当前状态，不更新为MINING
            }
          }
          
          task.status = detectedStatus.status;
          
          // ⚠️ 事件驱动：任务状态变化，触发相应检查
          this.triggerEvent('task-status-changed');
          
          // ⚠️ 如果状态恢复正常（不再是ERROR），重置崩溃刷新计数
          if (oldStatus === TaskStatus.ERROR && detectedStatus.status !== TaskStatus.ERROR) {
            task.crashRefreshCount = 0;
            task.lastCrashRefreshTime = null;
          }
          
          // ⚠️ 更新统计信息
          if (detectedStatus.status === TaskStatus.COMPLETED) {
            // ⚠️ 当页面显示 "waiting for the next challenge" 时，表示任务在当前周期已经完成挖矿
            // 无论任务当前状态如何（包括 INITIALIZING），都应该标记为完成并关闭页面
            // 这样下个周期如果轮到它，可以重新开始挖矿
            
            // ⚠️ 修复：如果页面状态变成 "waiting for the next challenge"，说明 submit solution 成功了
            // 不管之前失败了多少次，只要最终变成 waiting，就应该记录 submitSolution
            // ⚠️ 注意：如果 API 调用已经成功（hasSubmittedSolution = true），这里不应该重复记录
            if (!task.hasSubmittedSolution) {
              // ⚠️ API 调用可能没有成功记录（例如网络问题、时序问题等），通过状态检测补充记录
              this.stats.submitSolution++;
              this.stats.cycleSubmitSolution++;
              task.hasSubmittedSolution = true;
              console.log(`[SCHEDULER] ✅ Task ${task.id} submit solution succeeded (detected via "waiting for the next challenge" status, API call may have failed or not recorded)`);
            } else {
              // ⚠️ API 已经成功记录过，这里不再重复记录（避免重复计数）
              // 静默处理，不输出日志，避免日志噪音
            }
            
            // 状态变为COMPLETED：页面显示"waiting for the next challenge"，任务已完成
            if (oldStatus === TaskStatus.INITIALIZING) {
              console.log(`[SCHEDULER] ✅ Task ${task.id} completed (${oldStatus} -> ${detectedStatus.status}) [waiting for the next challenge] - page was already completed from previous cycle`);
            } else {
              console.log(`[SCHEDULER] ✅ Task ${task.id} completed (${oldStatus} -> ${detectedStatus.status}) [waiting for the next challenge]`);
            }
            
            // ⚠️ 更新成功统计并记录挖矿完成时间
            this.stats.success++;
            
            // ⚠️ 标记任务在当前周期完成
            task.completedInCycle = this.stats.cycle;
            
            // ⚠️ 获取任务计时器
            const timer = this.stats.taskTimers.get(task.id);
            
            // ⚠️ 记录挖矿完成时间（状态变成waiting for the next challenge的时间）
            // ⚠️ 重要：只统计从"finding a solution"变成"waiting for the next challenge"的时间
            // 如果miningStartTime为null，说明点击start session时已经是"waiting for the next challenge"，不计入统计
            if (timer && timer.miningStartTime) {
              const miningCompleteTime = Date.now();
              const miningTime = (miningCompleteTime - timer.miningStartTime) / 1000; // 转换为秒
              this.stats.miningTimes.push(miningTime);
              const miningCycle = task.miningCycle || 'unknown';
              console.log(`[SCHEDULER] 📊 Task ${task.id} mining time recorded: ${miningTime.toFixed(2)}s (started in cycle ${miningCycle}, completed in cycle ${this.stats.cycle})`);
            } else {
              // miningStartTime为null，说明任务在点击start session时已经完成，不计入挖矿时间统计
              console.log(`[SCHEDULER] ℹ️ Task ${task.id} completed without mining phase (was already waiting), not counting in mining time statistics`);
            }
            
            // ⚠️ 清理状态计数（任务已完成）
            if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
              this.stats.miningStarted--;
            } else if (oldStatus === TaskStatus.INITIALIZING && this.stats.loggedIn > 0) {
              // 如果从INITIALIZING直接完成，也需要清理loggedIn计数
              this.stats.loggedIn--;
            }
            // 清理任务时间记录
            this.stats.taskTimers.delete(task.id);
            
            // ⚠️ 事件驱动：任务完成，触发关闭事件
            this.triggerEvent('task-completed');
            
          } else if (detectedStatus.status === TaskStatus.MINING) {
            // 状态变为MINING：页面显示"finding a solution"，任务正在进行中
            console.log(`[SCHEDULER] ⛏️ Task ${task.id} started mining (${oldStatus} -> ${detectedStatus.status}) [finding a solution]`);
            
            // ⚠️ 从"已登录状态"转为"挖矿中"（如果之前是INITIALIZING状态）
            if (oldStatus === TaskStatus.INITIALIZING && this.stats.loggedIn > 0) {
              this.stats.loggedIn--;
            }
            
            // ⚠️ 重置start session点击计数器（任务成功进入挖矿状态）
            if (task.startSessionClickCount > 0) {
              task.startSessionClickCount = 0;
              task.lastStartSessionClickTime = null;
            }
            
            // ⚠️ 更新挖矿开始统计（只在第一次变为MINING时计数，避免重复）
            // ⚠️ 重要：只有当状态从非MINING变为MINING，且miningStartTime未设置时才记录
            // 如果miningStartTime为null（点击start时已经是waiting状态），不应该记录
            const timer = this.stats.taskTimers.get(task.id);
            if (timer && timer.miningStartTime === undefined) {
              // 如果还没有记录挖矿开始时间，现在记录（状态变为"finding a solution"的时间）
              timer.miningStartTime = Date.now();
              // ⚠️ 记录任务开始挖矿的周期信息
              task.miningCycleStartTime = this.currentCycleStartTime;
              task.miningCycle = this.stats.cycle;
              console.log(`[SCHEDULER] 📊 Task ${task.id} mining start time recorded (status changed to "finding a solution", cycle: ${this.stats.cycle})`);
            } else if (timer && timer.miningStartTime === null) {
              // miningStartTime为null，说明点击start时已经是waiting状态，不应该记录
              console.log(`[SCHEDULER] ℹ️ Task ${task.id} status changed to MINING but was already completed, skipping mining time tracking`);
            }
            // 只有在任务第一次进入MINING状态时才增加计数
            if (oldStatus !== TaskStatus.MINING) {
              this.stats.miningStarted++;
              // ⚠️ 事件驱动：任务开始挖矿，触发ActiveMining检查
              this.triggerEvent('task-mining-started');
            }
            
          } else if (detectedStatus.status === TaskStatus.INITIALIZING && oldStatus === TaskStatus.PENDING) {
            // 状态变为INITIALIZING：任务开始初始化
            // 静默处理，避免日志过多
          }
        } else if (task.status === TaskStatus.MINING) {
          // ⚠️ 如果任务已经是MINING状态但没有被检测到，可能需要重新检测
          // 添加调试日志（仅在调试模式下）
          if (process.env.DEBUG_SCHEDULER === 'true') {
            console.log(`[SCHEDULER] 🔍 Task ${task.id} is MINING but status check returned same status`);
          }
        } else if (task.status === TaskStatus.INITIALIZING) {
          // ⚠️ 检查任务是否卡在INITIALIZING状态（连续点击start session多次仍然没有进入MINING状态）
          const clickCount = task.startSessionClickCount || 0;
          const lastClickTime = task.lastStartSessionClickTime;
          
          if (clickCount > 5 && lastClickTime) {
            const timeSinceLastClick = Date.now() - lastClickTime;
            
            // 如果最后一次点击后已经等待了超过30秒，仍然没有进入MINING状态，标记为错误
            if (timeSinceLastClick > 30000) {
              console.error(`[SCHEDULER] ❌ Task ${task.id} failed to start mining after ${clickCount} attempts (last click ${Math.floor(timeSinceLastClick / 1000)}s ago). Marking as error.`);
              task.status = TaskStatus.ERROR;
              task.error = `Failed to start mining after ${clickCount} attempts (likely API 403 errors)`;
              
              // 清理统计
              const timer = this.stats.taskTimers.get(task.id);
              if (timer) {
                this.stats.taskTimers.delete(task.id);
              }
              if (this.stats.loggedIn > 0) {
                this.stats.loggedIn--;
              }
              this.stats.failed++;
            }
          }
        }
      }
    }
    
    // ⚠️ 页面健康检查：定期检查页面是否崩溃或显示不正常
    // 在点击start session之后，或当页面停在待挖矿待点击start session按钮的时候，要定期看页面是否已经崩溃或显示不正常
    // ⚠️ 频率控制：只在达到检查间隔时执行健康检查
    const timeSinceLastHealthCheck = now - this.lastHealthCheckTime;
    const shouldHealthCheck = timeSinceLastHealthCheck >= this.healthCheckInterval;
    
    if (shouldHealthCheck) {
      this.lastHealthCheckTime = now;
      
      const tasksToHealthCheck = Array.from(this.tasks.values())
        .filter(t => t.page && !t.page.isClosed() && 
          (t.status === TaskStatus.INITIALIZING || t.status === TaskStatus.MINING));
      
      for (const task of tasksToHealthCheck) {
        try {
          // ⚠️ 在访问页面属性前，先检查页面是否已关闭
          const page = task.page;
          if (!page || page.isClosed()) {
            continue; // 页面已关闭，跳过健康检查
          }
          
          // 检查页面是否仍然有效（避免在调度器关闭时访问已关闭的页面）
          let url;
          try {
            url = page.url();
          } catch (urlError) {
            // 页面可能已经关闭，跳过健康检查
            console.warn(`[SCHEDULER][HEALTH-CHECK] ⚠️ Task ${task.id} page is no longer accessible, skipping health check`);
            continue;
          }
          
          // ⚠️ 只检查在 /wizard/mine 或 /wizard/wallet 页面的任务
          if (!url.includes('/wizard/mine') && !url.includes('/wizard/wallet')) {
            continue; // 不在目标页面，跳过健康检查
          }
        
        // 检查页面是否崩溃或显示不正常
        const healthCheck = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
          const allText = bodyText + ' ' + bodyHTML;
          
          // 检查崩溃状态
          const isCrashed = 
            bodyText.includes('something went wrong with this page') ||
            bodyText.includes('something went wrong') ||
            bodyText.includes('page crashed') ||
            bodyText.includes('aw snap') ||
            bodyText.includes('chrome crashed') ||
            bodyText.includes('this page isn\'t working') ||
            bodyText.includes('this page isn\'t responding');
          
          // 检查是否显示正常状态
          const hasFindingSolution = allText.includes('finding a solution');
          const hasWaitingForNextChallenge = allText.includes('waiting for the next challenge');
          const hasStartSession = allText.includes('start session') || allText.includes('start');
          const hasStopSession = allText.includes('stop session') || allText.includes('stop');
          
          // 检查是否有错误信息
          const hasError = 
            bodyText.includes('error') ||
            bodyText.includes('failed') ||
            bodyText.includes('unable to') ||
            bodyText.includes('cannot');
          
          // 检查页面是否为空或异常
          const isEmpty = !bodyText || bodyText.trim().length < 50;
          
          return {
            isCrashed,
            hasFindingSolution,
            hasWaitingForNextChallenge,
            hasStartSession,
            hasStopSession,
            hasError,
            isEmpty,
            isHealthy: !isCrashed && !isEmpty && (hasFindingSolution || hasWaitingForNextChallenge || hasStartSession || hasStopSession),
          };
        }).catch(() => ({
          isCrashed: true,
          isHealthy: false,
          error: 'Failed to evaluate page',
        }));
        
        // 如果页面不健康，尝试恢复
        if (!healthCheck.isHealthy || healthCheck.isCrashed) {
          console.warn(`[SCHEDULER][HEALTH-CHECK] ⚠️ Task ${task.id} page is unhealthy (crashed: ${healthCheck.isCrashed}, healthy: ${healthCheck.isHealthy}), attempting recovery...`);
          
          // 第一步：刷新当前页面
          try {
            // ⚠️ 再次检查页面是否已关闭（可能在检查过程中被关闭）
            if (!page || page.isClosed()) {
              console.warn(`[SCHEDULER][HEALTH-CHECK] ⚠️ Task ${task.id} page was closed during health check, skipping refresh`);
              continue;
            }
            
            console.log(`[SCHEDULER][HEALTH-CHECK] 🔄 Refreshing page for task ${task.id}...`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000); // 等待页面加载
            
            // 检查刷新后的状态
            const afterRefreshCheck = await page.evaluate(() => {
              const bodyText = (document.body?.innerText || '').toLowerCase();
              const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
              const allText = bodyText + ' ' + bodyHTML;
              
              const hasFindingSolution = allText.includes('finding a solution');
              const hasWaitingForNextChallenge = allText.includes('waiting for the next challenge');
              const hasStartSession = allText.includes('start session') || allText.includes('start');
              
              return {
                hasFindingSolution,
                hasWaitingForNextChallenge,
                hasStartSession,
                isHealthy: hasFindingSolution || hasWaitingForNextChallenge || hasStartSession,
              };
            }).catch(() => ({ isHealthy: false }));
            
            if (afterRefreshCheck.isHealthy) {
              // 刷新后页面正常
              if (afterRefreshCheck.hasFindingSolution) {
                console.log(`[SCHEDULER][HEALTH-CHECK] ✅ Task ${task.id} page recovered after refresh, showing "finding a solution"`);
                // 页面正常显示finding a solution，保持MINING状态
                if (task.status !== TaskStatus.MINING) {
                  task.status = TaskStatus.MINING;
                }
              } else if (afterRefreshCheck.hasStartSession) {
                console.log(`[SCHEDULER][HEALTH-CHECK] ✅ Task ${task.id} page recovered after refresh, showing "start session" button`);
                // 页面显示start session按钮，需要点击
                task.status = TaskStatus.INITIALIZING;
                // 将在后续处理中点击start session
              } else if (afterRefreshCheck.hasWaitingForNextChallenge) {
                console.log(`[SCHEDULER][HEALTH-CHECK] ✅ Task ${task.id} page recovered after refresh, showing "waiting for the next challenge"`);
                // 页面显示waiting for the next challenge，任务已完成
                task.status = TaskStatus.COMPLETED;
              }
              continue; // 恢复成功，继续下一个任务
            } else {
              // 刷新后页面仍然异常，需要重新登录
              console.warn(`[SCHEDULER][HEALTH-CHECK] ⚠️ Task ${task.id} page still unhealthy after refresh, will re-initialize...`);
            }
          } catch (refreshError) {
            console.error(`[SCHEDULER][HEALTH-CHECK] ❌ Failed to refresh page for task ${task.id}: ${refreshError.message}`);
          }
          
          // 第二步：如果刷新后仍然异常，重新初始化任务
          // 关闭当前页面，重置任务状态，让调度器重新初始化
          console.log(`[SCHEDULER][HEALTH-CHECK] 🔄 Re-initializing task ${task.id} (closing page and resetting status)...`);
          await this.disposeTaskPage(task);
          
          // 保存旧状态用于清理统计
          const oldStatus = task.status;
          
          // 重置任务状态
          task.status = TaskStatus.PENDING;
          task.error = null;
          task.completionWaitStart = null;
          task.startSessionClickCount = 0;
          task.lastStartSessionClickTime = null;
          
          // 清理统计
          const timer = this.stats.taskTimers.get(task.id);
          if (timer) {
            this.stats.taskTimers.delete(task.id);
          }
          if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
            this.stats.miningStarted--;
          }
          if (oldStatus === TaskStatus.INITIALIZING && this.stats.loggedIn > 0) {
            this.stats.loggedIn--;
          }
          
          console.log(`[SCHEDULER][HEALTH-CHECK] ✅ Task ${task.id} reset to PENDING, will be re-initialized in next cycle`);
        }
      } catch (error) {
        console.error(`[SCHEDULER][HEALTH-CHECK] ❌ Error checking health for task ${task.id}: ${error.message}`);
      }
      }
    }
    
    // ⚠️ 检查并处理超出限制的情况（如果状态更新后超出限制）
    // ⚠️ 用户要求：当检测出超过MAX_ACTIVE_MINING限制时，点击"stop session"按钮
    // 让任务回到显示"start session"按钮的状态，等待其他任务完成后重新启动
    // ⚠️ 重要：需要实际检测页面内容，因为有些页面可能显示"Finding a solution"但状态还没更新
    const allTasksWithPages = Array.from(this.tasks.values())
      .filter(t => t.page && !t.page.isClosed());
    
    // 实际检测所有页面，找出真正显示"Finding a solution"的页面
    const actuallyMiningTasks = [];
    for (const task of allTasksWithPages) {
      try {
        const page = task.page;
        const url = page.url();
        
        // 只检查挖矿页面
        if (!url.includes('/wizard/mine')) {
          continue;
        }
        
        // 实际检测页面是否显示"Finding a solution"
        const isMining = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const bodyHTML = (document.body?.innerHTML || '').toLowerCase();
          const allText = bodyText + ' ' + bodyHTML;
          
          // 检查是否有"finding a solution"文本
          if (allText.includes('finding a solution')) {
            return true;
          }
          
          // 检查是否有stop session按钮（表示正在挖矿）
          const buttons = Array.from(document.querySelectorAll('button'));
          const hasStopSession = buttons.some(btn => {
            const text = (btn.textContent || '').trim().toLowerCase();
            return (text === 'stop' || text === 'stop session') && btn.offsetParent !== null && !btn.disabled;
          });
          
          // 如果有stop按钮且没有"waiting for the next challenge"，则认为正在挖矿
          if (hasStopSession && !allText.includes('waiting for the next challenge')) {
            return true;
          }
          
          return false;
        }).catch(() => false);
        
        if (isMining) {
          actuallyMiningTasks.push(task);
        }
      } catch (error) {
        // 忽略检测错误，继续处理其他任务
      }
    }
    
    // 如果实际挖矿任务数超过限制，停止多余的任务
    if (actuallyMiningTasks.length > CONFIG.MAX_ACTIVE_MINING) {
      console.warn(`[SCHEDULER] ⚠️ Active mining exceeded limit (${actuallyMiningTasks.length}/${CONFIG.MAX_ACTIVE_MINING} pages showing "Finding a solution"), stopping excess tasks...`);
      
      // 按创建时间排序，停止最晚的任务（后启动的优先停止）
      actuallyMiningTasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      
      // 停止超出限制的任务
      const toStop = actuallyMiningTasks.slice(CONFIG.MAX_ACTIVE_MINING);
      for (const task of toStop) {
        console.log(`[SCHEDULER] 🛑 Stopping task ${task.id} to enforce active mining limit (clicking stop session)...`);
        const oldStatus = task.status; // 保存旧状态
        const stopped = await this.clickStopSession(task.id);
        if (stopped) {
          // 点击stop成功后，将任务状态改回INITIALIZING，等待后续重新启动
          task.status = TaskStatus.INITIALIZING;
          // ⚠️ 更新统计：减少miningStarted计数（如果之前是MINING状态）
          if (oldStatus === TaskStatus.MINING && this.stats.miningStarted > 0) {
            this.stats.miningStarted--;
          }
          // ⚠️ 增加loggedIn计数（因为现在处于start session页面但未点击start按钮的状态）
          this.stats.loggedIn++;
          // ⚠️ 清理miningStartTime（因为停止挖矿了）
          const timer = this.stats.taskTimers.get(task.id);
          if (timer) {
            timer.miningStartTime = null;
          }
        } else {
          // 如果点击stop失败，尝试关闭页面（降级处理）
          console.warn(`[SCHEDULER] ⚠️ Failed to stop task ${task.id}, closing instead...`);
          await this.closeTask(task.id);
        }
      }
    }

    // ⚠️ 事件驱动：启动新任务和点击start session都通过事件处理，不再轮询
    // ⚠️ 修复：schedule()中不再主动启动新任务，完全由事件驱动
    // ⚠️ 初始启动应该在start()方法中触发，或者通过第一次schedule()触发
    // ⚠️ 后续的启动完全由页面关闭事件触发，避免重复启动
    
    // ⚠️ 事件驱动：初始化完成的任务通过事件处理（onTaskInitialized），不再轮询
    if (initializingTasks.length > 0) {
      this.triggerEvent('task-initialized');
    }

    // ⚠️ 定期检查并点击 start session（确保 INITIALIZING 状态的任务能够被处理）
    // 修复：如果任务在提交 solution 失败后状态变为 "waiting for the next challenge"，
    // 需要定期检查并点击 start session，不能只依赖初始化完成时的一次调用
    if (initializingTasks.length > 0) {
      await this.tryClickStartSession();
    }

    // ⚠️ 事件驱动：所有关键逻辑已迁移到事件处理，不再需要轮询
    // 以下代码已移除，改为事件驱动：
    // - 启动新任务：通过页面关闭事件触发（tryStartNewTaskAfterClose）
    // - 点击start session：通过初始化完成事件触发（tryClickStartSession）+ 定期检查
    // - 检查ActiveMining限制：通过状态变化事件触发（checkAndEnforceActiveMiningLimit）
    // - 关闭已完成任务：通过任务完成事件触发（closeCompletedTasks）
    // - 处理错误任务：通过错误事件触发（handleErrorTasks）
  }

  // 启动调度器
  async start() {
    if (this.isRunning) {
      console.warn('[SCHEDULER] Scheduler is already running');
      return;
    }

    this.isRunning = true;
    this.currentCycleStartTime = null; // 将在第一次schedule时设置

    // ⚠️ 初始化共享浏览器实例
    try {
      await this.getSharedBrowser();
    } catch (error) {
      console.error(`[SCHEDULER] ❌ Failed to initialize shared browser: ${error.message}`);
      this.isRunning = false;
      throw error;
    }

    // ⚠️ 初始启动：触发一次page-closed事件来启动初始任务
    this.triggerEvent('page-closed');

    // 启动调度循环
    this.intervalId = setInterval(() => {
      this.schedule().catch(err => {
        console.error(`[SCHEDULER] Error in schedule loop: ${err.message}`);
      });
    }, CONFIG.STATUS_CHECK_INTERVAL);

    console.log('[SCHEDULER] ✅ Scheduler started');
    
    // 立即执行一次
    await this.schedule();
  }

  // 停止调度器
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // 关闭所有页面（不关闭浏览器，因为页面关闭时会自动清理）
    for (const taskId of this.tasks.keys()) {
      await this.closeTask(taskId);
    }

    // ⚠️ 关闭共享浏览器实例
    if (this.sharedBrowser) {
      try {
        console.log('[SCHEDULER] 🔄 Closing shared browser instance...');
        await this.sharedBrowser.close();
        console.log('[SCHEDULER] ✅ Shared browser instance closed');
      } catch (error) {
        console.warn(`[SCHEDULER] ⚠️ Error closing shared browser: ${error.message}`);
      } finally {
        this.sharedBrowser = null;
      }
    }

    console.log('[SCHEDULER] ✅ Scheduler stopped');
  }

  // 获取状态信息
  getStatus() {
    // 计算平均登录时间和平均挖矿时间
    const avgLoginTime = this.stats.loginTimes.length > 0 
      ? (this.stats.loginTimes.reduce((sum, t) => sum + t, 0) / this.stats.loginTimes.length).toFixed(2)
      : '0.00';
    const avgMiningTime = this.stats.miningTimes.length > 0
      ? (this.stats.miningTimes.reduce((sum, t) => sum + t, 0) / this.stats.miningTimes.length).toFixed(2)
      : '0.00';
    
    // ⚠️ 当前正在挖矿的任务数应该直接使用getActiveMiningCount()（基于实际任务状态）
    // 而不是通过miningStarted - success计算，因为周期重置时统计可能不一致
    const activeMiningCount = this.getActiveMiningCount();
    
    const status = {
      isRunning: this.isRunning,
      cycle: this.stats.cycle,
      totalTasks: this.tasks.size,
      openPages: this.getOpenPagesCount(),
      activeMining: activeMiningCount,
      maxActiveMining: CONFIG.MAX_ACTIVE_MINING,
      maxOpenPages: CONFIG.MAX_OPEN_PAGES,
      // ⚠️ 详细统计（与 runbatch.mjs 保持一致）
      success: this.stats.success,
      failed: this.stats.failed,
      loggingIn: this.stats.loggingIn,
      loggedIn: this.stats.loggedIn,
      miningStarted: this.stats.miningStarted, // 累计开始挖矿的任务数
      submitSolution: this.stats.submitSolution, // 累计提交solution的次数
      cycleSubmitSolution: this.stats.cycleSubmitSolution, // 当前周期提交solution的次数
      currentlyMining: activeMiningCount, // 当前实际正在挖矿的任务数（与activeMining一致）
      avgLoginTime: avgLoginTime,
      avgMiningTime: avgMiningTime,
      loginTimesCount: this.stats.loginTimes.length,
      miningTimesCount: this.stats.miningTimes.length,
      tasks: {},
    };

    // ⚠️ 修复：对于 INITIALIZING 状态，需要检查任务是否有实际页面且页面未关闭
    // 与 schedule() 中的统计逻辑保持一致
    for (const [taskId, task] of this.tasks) {
      let taskStatus = task.status;
      
      // ⚠️ 对于 INITIALIZING 状态，如果页面不存在或已关闭，应该标记为 PENDING（用于状态报告）
      if (taskStatus === TaskStatus.INITIALIZING) {
        if (!task.page) {
          taskStatus = TaskStatus.PENDING; // 没有页面，视为 PENDING
        } else {
          try {
            if (task.page.isClosed()) {
              taskStatus = TaskStatus.PENDING; // 页面已关闭，视为 PENDING
            }
          } catch (error) {
            taskStatus = TaskStatus.PENDING; // 页面检查出错，视为 PENDING
          }
        }
      }
      
      status.tasks[taskId] = {
        status: taskStatus,
        error: task.error,
        completedAt: task.completedAt,
      };
    }

    return status;
  }
}

export { TaskScheduler };
