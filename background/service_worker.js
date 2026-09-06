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
  } else if (req.action === "SEND_VIA_MESSENGER_TAB") {
    // v1.1.4: 通过新建 Messenger 标签页来发送私信，完全绕开 isTrusted 限制
    sendViaMessengerTab(req.messengerHref, req.userName, req.dmText).then(res => {
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
  let hasCommentsManager = settings.enableCommentsManagerMode !== false;
  let hasNotifications = settings.enableNotificationMode === true;
  let hasTargets = settings.enableTargetUrlsMode && settings.targetUrls && settings.targetUrls.length > 0;

  if (!hasCommentsManager && !hasNotifications && !hasTargets) {
    hasCommentsManager = true;
    await StorageUtil.saveSettings({ enableCommentsManagerMode: true });
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

  const isCommentsManagerMode = settings.enableCommentsManagerMode !== false;
  const isNotificationMode = settings.enableNotificationMode === true && !isCommentsManagerMode;

  // 模式1：专业面板评论管理工具模式
  if (isCommentsManagerMode) {
    const waitSec = Math.max(2, settings.notificationCheckInterval || 5);
    await StorageUtil.saveSettings({ statusMessage: `本批次已处理，${waitSec} 秒后继续扫描评论管理工具...` });
    setTimeout(() => {
      loadCurrentUrl();
    }, waitSec * 1000);
    return;
  }

  // 模式2：全主页通知流监控模式
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

  const isCommentsManagerMode = settings.enableCommentsManagerMode !== false;
  const isNotificationMode = settings.enableNotificationMode === true && !isCommentsManagerMode;
  let targetUrl = "";
  const state = await getWorkerState();

  // 模式1：专业面板评论管理工具模式 (默认推荐首选)
  if (isCommentsManagerMode && !state.forceTargetUrl) {
    targetUrl = "https://www.facebook.com/professional_dashboard/engagement/comments_manager/";
    await StorageUtil.saveSettings({
      statusMessage: "正在驻留专业面板【评论管理工具】，集中响应未回复留言...",
      currentWorkerMode: 'comments_manager'
    });
  } else if (isNotificationMode && !state.forceTargetUrl) {
    // 模式2：全主页通知流模式
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
        console.log(`[Worker Tab Guard] 工作标签页已处于评论管理工具，通过页面内软巡检，禁止全页重载！`);
        chrome.tabs.sendMessage(tabId, { action: "SOFT_REFRESH_COMMENTS_MANAGER" }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      } else if (targetClean.includes('/notifications')) {
        console.log(`[Worker Tab Guard] 工作标签页已处于通知中心，通过页面内软刷新/软巡检，禁止全页重载！`);
        chrome.tabs.sendMessage(tabId, { action: "SOFT_REFRESH_NOTIFICATIONS" }, () => {
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

// ── v1.1.4: Messenger 标签页发送引擎（完全绕开 isTrusted 限制）──────────────
/**
 * 在新标签页中打开 Facebook Messenger 会话，通过 chrome.scripting.executeScript
 * 直接在页面上填写并发送私信，完全绕开 Facebook React 的 isTrusted 拦截。
 * 
 * @param {string} messengerHref - Messenger 会话 URL，如 https://www.facebook.com/messages/t/1234567
 * @param {string} userName - 用户名（仅用于日志）
 * @param {string} dmText - 要发送的私信内容
 */
async function sendViaMessengerTab(messengerHref, userName, dmText) {
  // 规范化 URL
  let targetUrl = messengerHref;
  if (!targetUrl || !targetUrl.includes('/messages/')) {
    return { success: false, error: "Messenger URL 无效: " + targetUrl };
  }

  // 确保使用标准的 facebook.com/messages/ 路径
  try {
    const parsed = new URL(targetUrl);
    if (parsed.hostname.includes('messenger.com')) {
      // 转换 messenger.com URL 到 facebook.com/messages/
      const parts = parsed.pathname.split('/').filter(Boolean);
      targetUrl = 'https://www.facebook.com/messages/t/' + (parts[1] || parts[0]);
    }
  } catch (e) {}

  console.log(`[Messenger Tab] 准备向 [${userName}] 发送私信，打开 Messenger 标签页: ${targetUrl}`);

  return new Promise((resolve) => {
    let resolved = false;
    let newTabId = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (newTabId) {
          chrome.tabs.remove(newTabId, () => { if (chrome.runtime.lastError) {} });
        }
        resolve({ success: false, error: "Messenger 标签页操作超时（60 秒）" });
      }
    }, 60000);

    // 在后台（非活跃）新建一个 Messenger 标签页
    chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        clearTimeout(timeout);
        resolve({ success: false, error: "无法创建 Messenger 标签页: " + (chrome.runtime.lastError?.message || "未知错误") });
        return;
      }

      newTabId = tab.id;
      chrome.tabs.update(newTabId, { autoDiscardable: false });
      console.log(`[Messenger Tab] 已在后台创建标签页 ID: ${newTabId}`);

      // 监听标签页加载完成
      const onUpdatedListener = (tabId, changeInfo) => {
        if (tabId !== newTabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);

        console.log(`[Messenger Tab] 标签页 ${newTabId} 加载完成，等待 React 水合...`);

        // 等待 React 完全水合并渲染输入框（4 秒）
        setTimeout(async () => {
          if (resolved) return;

          try {
            // 通过 chrome.scripting.executeScript 注入发送函数到 MAIN world
            const results = await chrome.scripting.executeScript({
              target: { tabId: newTabId },
              world: 'MAIN',
              func: async (textToSend) => {
                // 此函数在页面的 MAIN world 中执行（有完整的 DOM 访问权限）
                // isTrusted 对于 chrome.scripting.executeScript 无限制
                
                function sleep(ms) {
                  return new Promise(r => setTimeout(r, ms));
                }

                // 1. 找到 Messenger 输入框
                async function findInputBox(maxWait = 10000) {
                  const selectors = [
                    'div[role="textbox"][aria-multiline="true"]',
                    'div[contenteditable="true"][aria-multiline="true"]',
                    'div[contenteditable="true"][role="textbox"]',
                    'div[contenteditable="true"]',
                    'div[aria-label*="消息"][contenteditable]',
                    'div[aria-label*="Message"][contenteditable]',
                    'div[aria-label*="Aa"][contenteditable]',
                    '[data-lexical-editor="true"]',
                    'p[class*="xat24cr"]',
                  ];

                  const start = Date.now();
                  while (Date.now() - start < maxWait) {
                    for (const sel of selectors) {
                      const el = document.querySelector(sel);
                      if (el) {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        if (rect.width > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                          return el;
                        }
                      }
                    }
                    await sleep(400);
                  }
                  return null;
                }

                // 2. 注入文本（尝试多种方式）
                async function injectText(el, text) {
                  el.focus();
                  el.click();
                  await sleep(200);

                  // 清空现有内容
                  document.execCommand('selectAll', false, null);

                  // 方式 1: execCommand
                  try {
                    document.execCommand('insertText', false, text);
                    await sleep(300);
                    const content = el.textContent || el.innerText || '';
                    if (content.includes(text.substring(0, Math.min(10, text.length)))) {
                      return true;
                    }
                  } catch (e) {}

                  // 方式 2: ClipboardEvent paste
                  try {
                    const dt = new DataTransfer();
                    dt.setData('text/plain', text);
                    const pasteEv = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
                    el.dispatchEvent(pasteEv);
                    await sleep(300);
                    const content = el.textContent || el.innerText || '';
                    if (content.includes(text.substring(0, Math.min(10, text.length)))) {
                      return true;
                    }
                  } catch (e) {}

                  // 方式 3: innerText 强制赋值 + input 事件
                  el.innerText = text;
                  el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
                  await sleep(300);
                  return true;
                }

                // 3. 找发送按钮
                function findSendButton() {
                  const sendKeywords = ['发送', '发消息', '傳送', 'Send', 'Envoyer', 'Enviar'];
                  const buttons = Array.from(document.querySelectorAll(
                    'div[role="button"], button, span[role="button"]'
                  ));

                  for (const btn of buttons) {
                    const txt = (btn.innerText || btn.textContent || '').trim();
                    const label = btn.getAttribute('aria-label') || '';
                    const isMatch = sendKeywords.some(kw => txt === kw || label === kw || label.includes(kw));
                    if (!isMatch) continue;

                    // 排除不相关按钮
                    if (txt.includes('主页') || txt.includes('取消') || label.includes('取消')) continue;
                    
                    const rect = btn.getBoundingClientRect();
                    const style = window.getComputedStyle(btn);
                    if (rect.width === 0 || style.display === 'none') continue;

                    return btn;
                  }

                  // 备用：找 aria-label 包含"发送"的按钮
                  return Array.from(document.querySelectorAll('[aria-label]')).find(el => {
                    const label = el.getAttribute('aria-label') || '';
                    return label.includes('发送') || label === 'Send' || label.includes('Enviar');
                  });
                }

                // 主流程
                try {
                  const inputBox = await findInputBox(12000);
                  if (!inputBox) {
                    return { success: false, error: "找不到 Messenger 输入框（等待 12 秒后超时）" };
                  }

                  console.log("[Messenger Sender] 找到输入框，注入私信内容...");
                  await injectText(inputBox, textToSend);
                  await sleep(800);

                  // 等待发送按钮激活
                  let sendBtn = null;
                  const btnWaitStart = Date.now();
                  while (Date.now() - btnWaitStart < 5000) {
                    sendBtn = findSendButton();
                    if (sendBtn) break;
                    await sleep(300);
                  }

                  if (sendBtn) {
                    console.log("[Messenger Sender] 找到发送按钮，执行点击...");
                    sendBtn.click();
                    await sleep(1000);
                    return { success: true };
                  } else {
                    // 回车键发送兜底
                    console.log("[Messenger Sender] 未找到发送按钮，尝试回车发送...");
                    inputBox.dispatchEvent(new KeyboardEvent('keydown', {
                      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                    }));
                    await sleep(1000);
                    return { success: true, note: "使用回车发送" };
                  }
                } catch (err) {
                  return { success: false, error: err.message };
                }
              },
              args: [dmText]
            });

            if (resolved) return;

            const scriptResult = results && results[0] && results[0].result;
            console.log(`[Messenger Tab] 脚本执行结果:`, scriptResult);

            // 等待 2 秒让发送请求完成网络传输
            await new Promise(r => setTimeout(r, 2000));

            // 关闭 Messenger 标签页
            chrome.tabs.remove(newTabId, () => {
              if (chrome.runtime.lastError) {}
            });

            clearTimeout(timeout);
            resolved = true;

            if (scriptResult && scriptResult.success) {
              resolve({ success: true });
            } else {
              resolve({ success: false, error: (scriptResult && scriptResult.error) || "Messenger 脚本执行失败" });
            }

          } catch (execErr) {
            console.error("[Messenger Tab] executeScript 异常:", execErr);
            chrome.tabs.remove(newTabId, () => {});
            clearTimeout(timeout);
            if (!resolved) {
              resolved = true;
              resolve({ success: false, error: "executeScript 异常: " + execErr.message });
            }
          }
        }, 4000); // 等待 React 水合的时间
      };

      chrome.tabs.onUpdated.addListener(onUpdatedListener);
    });
  });
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

