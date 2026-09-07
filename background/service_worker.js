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

console.log("FB Auto-Responder Service Worker v5.1.0 Initialized (Anti-Sleep & Strict Single-Tab Guard).");

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
  } else if (req.action === "OPEN_COMMENTS_MANAGER") {
    const cmUrl = "https://www.facebook.com/professional_dashboard/engagement/comments_manager/";
    chrome.tabs.create({ url: cmUrl, active: true }, (tab) => {
      chrome.tabs.update(tab.id, { autoDiscardable: false });
      setWorkerState({ workerTabId: tab.id });
    });
    sendResponse({ status: "OPENED" });
    return true;
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
  await StorageUtil.saveSettings({
    isRunning: true,
    isPaused: false,
    enableCommentsManagerMode: true,
    emergencyBrakeReason: ""
  });
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

  // 核心聚焦：专业面板评论管理工具
  const waitSec = Math.max(5, settings.notificationCheckInterval || 15);
  setTimeout(() => {
    loadCurrentUrl();
  }, waitSec * 1000);

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

  const targetUrl = "https://www.facebook.com/professional_dashboard/engagement/comments_manager/";
  await StorageUtil.saveSettings({
    statusMessage: "正在驻留专业面板【评论管理工具】，集中响应未回复留言...",
    currentWorkerMode: 'comments_manager'
  });

  // 统一交给单标签安全调度守卫处理（查重、防多开、防休眠、防硬刷）
  await ensureWorkerTab(targetUrl);
}

const stripUrl = (u) => {
  if (!u) return '';
  try {
    const url = new URL(u);
    return (url.origin + url.pathname).replace(/\/$/, '').toLowerCase();
  } catch(e) {
    return u.split('?')[0].replace(/\/$/, '').toLowerCase();
  }
};

async function ensureWorkerTab(targetUrl) {
  const state = await getWorkerState();
  const targetClean = stripUrl(targetUrl);
  let activeWorkerTab = null;

  // 1. 如果此前已记录 workerTabId，检验该标签页是否依然存在
  if (state.workerTabId) {
    activeWorkerTab = await new Promise(resolve => {
      chrome.tabs.get(state.workerTabId, tab => {
        if (chrome.runtime.lastError || !tab) {
          resolve(null);
        } else {
          resolve(tab);
        }
      });
    });
  }

  // 2. 跨所有浏览器窗口查询当前所有 Facebook 标签页（查重与防多开）
  const allFbTabs = await new Promise(resolve => {
    chrome.tabs.query({ url: ["*://*.facebook.com/*"] }, tabs => {
      if (chrome.runtime.lastError || !tabs) resolve([]);
      else resolve(tabs);
    });
  });

  // 如果 activeWorkerTab 已经失效，但在所有打开的标签页里找到了现成的 Facebook 页面，优先认领并复用！
  if (!activeWorkerTab && allFbTabs.length > 0) {
    const matchedTab = allFbTabs.find(t => t.url && stripUrl(t.url) === targetClean) ||
                       allFbTabs.find(t => t.url && stripUrl(t.url).includes('/comments_manager')) ||
                       allFbTabs.find(t => t.url && stripUrl(t.url).includes('/notifications')) ||
                       allFbTabs[0];
    if (matchedTab) {
      console.log(`[Worker Tab Guard] 成功从已有标签页中认领并复用: ID ${matchedTab.id} (${matchedTab.url})`);
      activeWorkerTab = matchedTab;
      await setWorkerState({ workerTabId: matchedTab.id });
    }
  }

  // 3. 严格去重：如果发现当前浏览器中有多个 /notifications 标签页，关闭除当前工作标签之外的所有重复项！
  if (allFbTabs.length > 1) {
    for (const t of allFbTabs) {
      if (activeWorkerTab && t.id === activeWorkerTab.id) continue;
      const cleanU = stripUrl(t.url);
      if (cleanU.includes('/notifications') || cleanU.includes('/comments_manager')) {
        console.warn(`[Worker Tab Guard] 发现多余的工作标签页 ID ${t.id}，自动清理关闭，保持全局单标签！`);
        chrome.tabs.remove(t.id, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    }
  }

  // 4. 如果找到了可复用的工作标签页
  if (activeWorkerTab) {
    const tabId = activeWorkerTab.id;

    // 方案一：【防止标签页休眠】设置 autoDiscardable 为 false，禁止 Chrome 丢弃/睡眠此标签
    try {
      chrome.tabs.update(tabId, { autoDiscardable: false }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) {
      console.warn("[Worker Tab Guard] 设置 autoDiscardable 异常:", e);
    }

    const currentClean = stripUrl(activeWorkerTab.url);

    // 方案三：【避免硬 F5 刷新】
    if (currentClean === targetClean) {
      if (targetClean.includes('/comments_manager')) {
        chrome.tabs.sendMessage(tabId, { action: "SOFT_REFRESH_COMMENTS_MANAGER" }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      } else {
        console.log(`[Worker Tab Guard] 工作标签页已处于目标贴文，维持当前页面`);
      }
    } else {
      // 只有当 URL 确实不同时（例如从贴文跳回通知流，或从通知流跳到新贴文），才触发平滑导航
      console.log(`[Worker Tab Guard] 标签页 ${tabId} 导航至目标地址: ${targetUrl}`);
      chrome.tabs.update(tabId, { url: targetUrl, active: false });
    }
    return activeWorkerTab;
  }

  // 5. 如果全局没有任何 Facebook 标签页，仅在此处新建 1 个标签页
  return new Promise(resolve => {
    console.log(`[Worker Tab Guard] 未检测到任何可复用的 Facebook 标签页，新建唯一工作标签页...`);
    chrome.tabs.create({ url: targetUrl, active: false }, async (newTab) => {
      if (chrome.runtime.lastError || !newTab) {
        console.error("[Worker Tab Guard] 创建工作标签页失败:", chrome.runtime.lastError?.message);
        resolve(null);
        return;
      }
      await setWorkerState({ workerTabId: newTab.id });

      // 新建标签页同样立即施加【防休眠保护】
      chrome.tabs.update(newTab.id, { autoDiscardable: false }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
      console.log(`[Worker Tab Guard] 成功创建并锁定唯一工作标签页: ID ${newTab.id} (已禁用休眠)`);
      resolve(newTab);
    });
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

// ── 监听标签页关闭事件，实时同步释放 workerTabId ─────────────────────────
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  const state = await getWorkerState();
  if (state.workerTabId === closedTabId) {
    console.log(`[Worker Tab Guard] 工作标签页 ${closedTabId} 已被关闭，自动重置状态`);
    await setWorkerState({ workerTabId: null });
  }
});

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
      timeStr,                                      // A: 填表时间戳
      dateStr,                                      // B: 填表日期
      "100088889999000",                            // C: 留言用户ID
      "测试用户_TestUser",                          // D: 留言用户姓名
      "https://facebook.com/test_user",             // E: 留言用户主页连接
      "https://facebook.com/reel/123456789",        // F: 评论贴文连接
      "这是一条来自插件的连通性测试数据！",        // G: 评论内容
      "FB自动监控插件 (测试)",                      // H: 来源
      "测试连接",                                   // I: 标签
      "刚刚",                                       // J: 留言日期
      "page_test_123"                               // K: 本公共主页ID
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

