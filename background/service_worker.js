/**
 * FB 智能私信大师 - Background Service Worker v5.0.0
 * 单标签轮询架构：维护唯一一个工作标签页，依次处理贴文 URL
 */

importScripts('../utils/storage.js');

async function getWorkerState() {
  return new Promise(resolve => {
    chrome.storage.local.get(['workerState'], (res) => {
      resolve(res.workerState || { workerTabId: null, currentUrlIndex: 0, isNextFiller: false });
    });
  });
}

async function setWorkerState(newState) {
  const current = await getWorkerState();
  const updated = { ...current, ...newState };
  return new Promise(resolve => {
    chrome.storage.local.set({ workerState: updated }, () => resolve(updated));
  });
}

console.log("FB Auto-Responder Service Worker v5.0.0 Initialized.");

// ── 监听来自 Popup 与 Content Script 的指令 ──────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === "START_MONITOR") {
    startMonitoring();
    sendResponse({ status: "STARTED" });
  } else if (req.action === "PAUSE_MONITOR") {
    stopMonitoring(true);
    sendResponse({ status: "PAUSED" });
  } else if (req.action === "STOP_MONITOR") {
    stopMonitoring(false);
    sendResponse({ status: "STOPPED" });
  } else if (req.action === "TRIGGER_EMERGENCY_BRAKE") {
    triggerEmergencyBrake(req.reason);
    sendResponse({ status: "BRAKED" });
  } else if (req.action === "PAGE_FINISHED") {
    // Content Script 报告当前页面已处理完毕，切换下一个 URL
    console.log("收到 PAGE_FINISHED，准备切换下一条贴文");
    scheduleNextUrl();
    sendResponse({ status: "ACK" });
  } else if (req.action === "SYNC_GOOGLE_SHEETS") {
    syncToGoogleSheets(req.payload).then(res => {
      sendResponse(res);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // 异步响应
  } else if (req.action === "TEST_GOOGLE_SHEET") {
    testGoogleSheetConnection(req.webhookUrl, req.sheetName).then(res => {
      sendResponse(res);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // 异步响应
  }
  return true;
});

// ── 核心调度逻辑 ────────────────────────────────────────────────────────────

async function startMonitoring() {
  const settings = await StorageUtil.getSettings();
  const hasNotifications = settings.enableNotificationMode !== false;
  const hasTargets = settings.enableTargetUrlsMode && settings.targetUrls && settings.targetUrls.length > 0;

  if (!hasNotifications && !hasTargets) {
    await StorageUtil.saveSettings({ isRunning: false, statusMessage: "提示: 请开启全主页通知流监控，或在贴文列表中添加链接" });
    return;
  }
  
  await StorageUtil.saveSettings({ isRunning: true, isPaused: false, emergencyBrakeReason: "" });
  loadCurrentUrl();
}

async function stopMonitoring(isPaused) {
  await StorageUtil.saveSettings({ isRunning: false, isPaused: isPaused });
  if (!isPaused) {
    await setWorkerState({ currentUrlIndex: 0, forceTargetUrl: false });
  }
  await closeWorkerTab();
}

async function scheduleNextUrl() {
  const settings = await StorageUtil.getSettings();
  if (!settings.isRunning || settings.isPaused) return;

  const isNotificationMode = settings.enableNotificationMode !== false;

  // 如果开启了全主页通知流监控模式，单条贴文处理完毕后，自动返回通知中心继续守候
  if (isNotificationMode) {
    const waitSec = Math.max(2, settings.notificationCheckInterval || 5);
    await StorageUtil.saveSettings({ statusMessage: `本条留言已处理完毕，${waitSec} 秒后返回全主页通知流...` });
    setTimeout(() => {
      loadCurrentUrl();
    }, waitSec * 1000);
    return;
  }

  // 纯指定贴文循环监控模式
  const urls = settings.targetUrls || [];
  if (urls.length === 0) return;

  const state = await getWorkerState();
  let currentUrlIndex = state.currentUrlIndex;

  // 只有当刚处理完目标贴文（即 isNextFiller 为 true），才将目标贴文 index + 1
  if (state.isNextFiller) {
    currentUrlIndex++;
    if (currentUrlIndex >= urls.length) {
      currentUrlIndex = 0;
    }
    await setWorkerState({ currentUrlIndex });
  }

  // 页面切换间隔，防封（读取用户设置，默认 15 秒）
  const waitMs = (settings.switchIntervalSeconds || 15) * 1000;
  await StorageUtil.saveSettings({ statusMessage: `等待 ${waitMs / 1000} 秒后切换至下一个链接...` });
  setTimeout(() => {
    loadCurrentUrl();
  }, waitMs);
}

async function loadCurrentUrl() {
  const settings = await StorageUtil.getSettings();
  if (!settings.isRunning || settings.isPaused) return;

  const isNotificationMode = settings.enableNotificationMode !== false;
  let targetUrl = "";
  const state = await getWorkerState();

  // 模式1：全主页通知流模式 (默认驻留 https://www.facebook.com/notifications)
  if (isNotificationMode && !state.forceTargetUrl) {
    targetUrl = "https://www.facebook.com/notifications";
    await StorageUtil.saveSettings({
      statusMessage: "正在驻留全主页通知流，秒级监听未读留言...",
      currentWorkerMode: 'notification'
    });
  } else {
    // 模式2：经典指定贴文循环模式
    const targets = settings.targetUrls || [];
    const fillers = settings.activeUrls || [];

    if (targets.length === 0) {
      if (isNotificationMode) {
        await setWorkerState({ forceTargetUrl: false });
        loadCurrentUrl();
        return;
      }
      return;
    }

    let currentUrlIndex = state.currentUrlIndex;
    let isNextFiller = state.isNextFiller;

    if (isNextFiller && fillers.length > 0 && settings.enableFillerUrls !== false) {
      targetUrl = fillers[Math.floor(Math.random() * fillers.length)];
      if (fillers.length > 1 && state.lastFillerUrl === targetUrl) {
        const currentIndex = fillers.indexOf(targetUrl);
        targetUrl = fillers[(currentIndex + 1) % fillers.length];
      }
      
      await StorageUtil.saveSettings({
        statusMessage: `正在访问伪装链接 (防封浏览): ${targetUrl.substring(0, 45)}...`,
        currentWorkerMode: 'filler'
      });
      await setWorkerState({ isNextFiller: false, lastFillerUrl: targetUrl });
    } else {
      if (currentUrlIndex >= targets.length) {
        currentUrlIndex = 0;
        await setWorkerState({ currentUrlIndex });
      }
      targetUrl = targets[currentUrlIndex];
      await StorageUtil.saveSettings({
        statusMessage: `正在监控 [${currentUrlIndex + 1}/${targets.length}]: ${targetUrl.substring(0, 45)}...`,
        currentWorkerMode: 'target'
      });
      await setWorkerState({ isNextFiller: true });
    }
  }

  const finalState = await getWorkerState();
  const workerTabId = finalState.workerTabId;

  if (workerTabId) {
    chrome.tabs.get(workerTabId, async (tab) => {
      if (chrome.runtime.lastError || !tab) {
        await setWorkerState({ workerTabId: null });
        createWorkerTab(targetUrl);
      } else {
        // 提取核心 URL 进行精准比对，忽略查询参数和锚点，避免出现 facebook.com/ 包含 facebook.com/xxx 的误判
        const stripUrl = (u) => { try { const url = new URL(u); return url.origin + url.pathname.replace(/\/$/, ''); } catch(e) { return u.split('?')[0].replace(/\/$/, ''); } };
        if (tab.url && stripUrl(tab.url) === stripUrl(targetUrl)) {
          chrome.tabs.reload(workerTabId);
        } else {
          chrome.tabs.update(workerTabId, { url: targetUrl, active: false });
        }
      }
    });
  } else {
    createWorkerTab(targetUrl);
  }
}

function createWorkerTab(url) {
  chrome.tabs.create({ url: url, active: false }, async (tab) => {
    if (chrome.runtime.lastError) {
      console.error("Tab create error:", chrome.runtime.lastError.message);
      return;
    }
    await setWorkerState({ workerTabId: tab.id });
  });
}

async function closeWorkerTab() {
  const state = await getWorkerState();
  if (state.workerTabId) {
    chrome.tabs.remove(state.workerTabId, () => {
      if (chrome.runtime.lastError) { /* suppress */ }
    });
    await setWorkerState({ workerTabId: null });
  }
}

// ── 触发风控紧急熔断保护 ──────────────────────────────────────────────────
async function triggerEmergencyBrake(reason) {
  try {
    await stopMonitoring(true);

    const alertMsg = reason || "检测到 Facebook 安全验证提示，系统已自动熔断暂停！";

    await StorageUtil.saveSettings({
      isRunning: false,
      isPaused: false,
      emergencyBrakeReason: alertMsg,
      statusMessage: "🚨 触发紧急熔断保护，任务已终止！"
    });

    await StorageUtil.addLog({
      userName: "风控引擎",
      postUrl: "全局风控检测",
      matchedKeyword: "熔断报警",
      dmStatus: "紧急刹车",
      level: "error"
    });

    const iconUrl = chrome.runtime.getURL('assets/icon128.png');
    chrome.notifications.create("fb_emergency_brake", {
      type: "basic",
      iconUrl: iconUrl,
      title: "FB 智能私信大师 - 紧急熔断通知",
      message: alertMsg
    }, () => {
      if (chrome.runtime.lastError) { /* suppress */ }
    });
  } catch (err) {
    console.error("triggerEmergencyBrake error:", err);
  }
}

// ── 谷歌表格同步引擎 ──────────────────────────────────────────────────────
async function syncToGoogleSheets(rowPayload) {
  try {
    const sheets = await StorageUtil.getGoogleSheets();
    const enabledSheets = sheets.filter(s => s.enabled && s.webhookUrl);
    if (enabledSheets.length === 0) return { success: true, count: 0 };

    console.log(`[Google Sheets] 开始向 ${enabledSheets.length} 个启用表格推送数据...`);
    const promises = enabledSheets.map(async (sheet) => {
      const bodyData = {
        sheetName: sheet.sheetName || "Sheet1",
        row: rowPayload
      };
      try {
        const resp = await fetch(sheet.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(bodyData)
        });
        const resText = await resp.text();
        console.log(`[Google Sheets] 表格 [${sheet.name}] 同步成功:`, resText);
        return { id: sheet.id, success: true, response: resText };
      } catch (err) {
        console.error(`[Google Sheets] 表格 [${sheet.name}] 同步失败:`, err);
        return { id: sheet.id, success: false, error: err.message };
      }
    });

    const results = await Promise.all(promises);
    return { success: true, count: enabledSheets.length, results };
  } catch (e) {
    console.error("[Google Sheets] syncToGoogleSheets 发生异常:", e);
    return { success: false, error: e.message };
  }
}

async function testGoogleSheetConnection(webhookUrl, sheetName) {
  try {
    if (!webhookUrl) throw new Error("缺少 Webhook 链接");
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const hourStr = String(now.getHours());

    const testRow = [
      "100088889999000",             // A: FB id
      "测试用户_TestUser",           // B: 姓名
      "连通性测试 | 测试通过",       // C: 自定义字段
      "FB自动私信插件 (测试)",       // D: 来源
      "测试连接",                    // E: 标签
      timeStr,                       // F: 订阅时间
      "",                            // G: 性别
      "https://facebook.com/test",   // H: 最新贴文
      "https://facebook.com/test",   // I: 评论贴文
      "这是一条来自插件的连通性测试数据！", // J: 评论内容
      dateStr,                       // K: 日期
      hourStr,                       // L: 时间点
      "page_test_123",               // M: 专页id
      timeStr                        // N: 创建时间
    ];

    const bodyData = {
      sheetName: sheetName || "Sheet1",
      row: testRow
    };

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(bodyData)
    });

    const resText = await resp.text();
    return { success: true, response: resText };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

