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
  }
  return true;
});

// ── 核心调度逻辑 ────────────────────────────────────────────────────────────

async function startMonitoring() {
  const settings = await StorageUtil.getSettings();
  if (settings.targetUrls.length === 0) {
    await StorageUtil.saveSettings({ isRunning: false, statusMessage: "提示: 未配置任何目标贴文链接" });
    return;
  }
  
  await StorageUtil.saveSettings({ isRunning: true, isPaused: false, emergencyBrakeReason: "" });
  loadCurrentUrl();
}

async function stopMonitoring(isPaused) {
  await StorageUtil.saveSettings({ isRunning: false, isPaused: isPaused });
  if (!isPaused) {
    await setWorkerState({ currentUrlIndex: 0 });
  }
  await closeWorkerTab();
}

async function scheduleNextUrl() {
  const settings = await StorageUtil.getSettings();
  if (!settings.isRunning || settings.isPaused) return;

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

  const targets = settings.targetUrls || [];
  const fillers = settings.activeUrls || [];

  if (targets.length === 0) return;

  let targetUrl = "";
  const state = await getWorkerState();
  let currentUrlIndex = state.currentUrlIndex;
  let isNextFiller = state.isNextFiller;

  if (isNextFiller && fillers.length > 0) {
    // 这次应该加载伪装链接
    targetUrl = fillers[Math.floor(Math.random() * fillers.length)];
    await StorageUtil.saveSettings({
      statusMessage: `正在访问伪装链接 (防封浏览): ${targetUrl.substring(0, 45)}...`,
      currentWorkerMode: 'filler'
    });
    await setWorkerState({ isNextFiller: false });
  } else {
    // 这次应该加载真实监控贴文
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
