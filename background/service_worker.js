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

// ── v1.1.6: Messenger 标签页发送引擎（完全绕开 isTrusted 限制）──────────────
/**
 * 在新标签页中打开 Facebook Messenger 会话，通过 chrome.scripting.executeScript
 * 直接在页面上填写并发送私信。
 * 
 * v1.1.6 改进：
 *   - 改为前台打开标签页 (active: true)，确保 Chrome 对 React/Lexical 完整执行 JS
 *   - 发送完成后自动切回评论管理工具标签页
 *   - React 水合等待时间从 4 秒延长到 7 秒
 *   - 大幅扩展输入框选择器列表（覆盖新旧 Messenger UI 和多语言）
 */
async function sendViaMessengerTab(messengerHref, userName, dmText) {
  let targetUrl = messengerHref;
  if (!targetUrl || !targetUrl.includes('/messages/')) {
    return { success: false, error: "Messenger URL 无效: " + targetUrl };
  }

  try {
    const parsed = new URL(targetUrl);
    if (parsed.hostname.includes('messenger.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      targetUrl = 'https://www.facebook.com/messages/t/' + (parts[1] || parts[0]);
    }
  } catch (e) {}

  console.log(`[Messenger Tab] 准备向 [${userName}] 发送私信，打开 Messenger 标签页: ${targetUrl}`);

  return new Promise((resolve) => {
    let resolved = false;
    let newTabId = null;
    let previousActiveTabId = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (newTabId) chrome.tabs.remove(newTabId, () => { if (chrome.runtime.lastError) {} });
        if (previousActiveTabId) chrome.tabs.update(previousActiveTabId, { active: true }, () => {});
        resolve({ success: false, error: "Messenger 标签页操作超时（60 秒）" });
      }
    }, 60000);

    // 记住当前活跃的评论管理工具标签页
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      if (activeTabs && activeTabs[0]) {
        previousActiveTabId = activeTabs[0].id;
        console.log(`[Messenger Tab] 记录当前活跃标签页 ID: ${previousActiveTabId}`);
      }

      // v1.1.6: 改为 active:true 前台打开 —— 后台标签页 Chrome 会限速 JS，React 水合失败
      chrome.tabs.create({ url: targetUrl, active: true }, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          clearTimeout(timeout);
          resolve({ success: false, error: "无法创建 Messenger 标签页: " + (chrome.runtime.lastError?.message || "未知") });
          return;
        }

        newTabId = tab.id;
        chrome.tabs.update(newTabId, { autoDiscardable: false });
        console.log(`[Messenger Tab] 已前台创建标签页 ID: ${newTabId}`);

        const onUpdatedListener = (tabId, changeInfo) => {
          if (tabId !== newTabId || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(onUpdatedListener);

          const finalUrl = changeInfo.url || '';
          console.log(`[Messenger Tab] 标签页 ${newTabId} 加载完成，等待 React/Lexical 完整水合（7 秒）...`);

          // v1.1.6: 延长到 7 秒，让 Lexical 编辑器完全挂载
          setTimeout(async () => {
            if (resolved) return;

            try {
              const results = await chrome.scripting.executeScript({
                target: { tabId: newTabId },
                world: 'MAIN',
                func: async (textToSend) => {
                  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

                  async function findInputBox(maxWait = 15000) {
                    // v1.1.6: 扩展选择器，覆盖所有可能的 Messenger 输入框形态
                    const selectors = [
                      '[data-lexical-editor="true"]',
                      'div[contenteditable="true"][role="textbox"]',
                      'div[contenteditable="true"][aria-multiline="true"]',
                      'div[contenteditable="true"][spellcheck="true"]',
                      'div[aria-label="Aa"][contenteditable="true"]',
                      'div[aria-label="Message"][contenteditable="true"]',
                      'div[aria-label="消息"][contenteditable="true"]',
                      'div[aria-label="Mensagem"][contenteditable="true"]',
                      'div[aria-label="Mensaje"][contenteditable="true"]',
                      'div[aria-label*="消息"][contenteditable]',
                      'div[aria-label*="Message"][contenteditable]',
                      'div[aria-label*="Aa"][contenteditable]',
                      'div.notranslate[contenteditable="true"]',
                      'div[contenteditable="true"]',
                      'div[role="textbox"]',
                      'textarea',
                    ];

                    const start = Date.now();
                    let attempt = 0;
                    while (Date.now() - start < maxWait) {
                      attempt++;
                      for (const sel of selectors) {
                        const els = Array.from(document.querySelectorAll(sel));
                        for (const el of els) {
                          const rect = el.getBoundingClientRect();
                          const style = window.getComputedStyle(el);
                          if (rect.width > 0 && rect.height > 0 &&
                              style.display !== 'none' && style.visibility !== 'hidden') {
                            console.log(`[Messenger Sender] 第${attempt}次尝试，选择器"${sel}"找到输入框`);
                            return el;
                          }
                        }
                      }
                      // 每 3 秒点击一下页面中心，激活可能懒加载的 React 组件
                      if (attempt % 8 === 0) {
                        try {
                          const el = document.elementFromPoint(window.innerWidth/2, window.innerHeight*0.7);
                          if (el) el.click();
                        } catch(e) {}
                      }
                      await sleep(400);
                    }
                    const allCE = Array.from(document.querySelectorAll('[contenteditable]'));
                    console.warn(`[Messenger Sender] 超时！页面上所有 contenteditable (${allCE.length}):`,
                      allCE.map(e => ({ tag:e.tagName, role:e.getAttribute('role'), label:e.getAttribute('aria-label'), w:e.getBoundingClientRect().width }))
                    );
                    return null;
                  }

                  async function injectText(el, text) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.focus(); el.click();
                    await sleep(300);
                    document.execCommand('selectAll', false, null);

                    try {
                      document.execCommand('insertText', false, text);
                      await sleep(400);
                      if ((el.textContent||'').includes(text.slice(0,10))) return true;
                    } catch(e) {}

                    try {
                      const dt = new DataTransfer();
                      dt.setData('text/plain', text);
                      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                      await sleep(400);
                      if ((el.textContent||'').includes(text.slice(0,10))) return true;
                    } catch(e) {}

                    el.innerText = text;
                    el.dispatchEvent(new InputEvent('input', { inputType:'insertText', data:text, bubbles:true }));
                    el.dispatchEvent(new Event('change', { bubbles:true }));
                    await sleep(400);
                    return true;
                  }

                  function findSendButton() {
                    const labels = ['发送','发消息','傳送','傳訊息','Send','Envoyer','Enviar','送信'];
                    const btns = Array.from(document.querySelectorAll('div[role="button"],button,span[role="button"]'));
                    for (const btn of btns) {
                      const rect = btn.getBoundingClientRect();
                      if (!rect.width || !rect.height) continue;
                      const style = window.getComputedStyle(btn);
                      if (style.display==='none'||style.visibility==='hidden') continue;
                      const label = (btn.getAttribute('aria-label')||'').trim();
                      const txt = (btn.innerText||btn.textContent||'').trim();
                      if ((labels.includes(label)||labels.includes(txt)) &&
                          !label.includes('取消') && !txt.includes('取消') &&
                          !label.includes('Cancel') && !txt.includes('Cancel')) return btn;
                    }
                    return Array.from(document.querySelectorAll('[aria-label]')).find(el => {
                      const l = el.getAttribute('aria-label')||'';
                      return (l.includes('发送')||l==='Send'||l.includes('Enviar')) && !l.includes('取消');
                    }) || null;
                  }

                  try {
                    console.log("[Messenger Sender] 开始查找输入框... URL:", window.location.href);
                    const inputBox = await findInputBox(15000);
                    if (!inputBox) {
                      return { success: false, error: "找不到输入框（15 秒超时，URL:" + window.location.href + "）" };
                    }
                    console.log("[Messenger Sender] ✅ 找到输入框，注入内容...");
                    await injectText(inputBox, textToSend);
                    await sleep(1000);

                    let sendBtn = null;
                    const t0 = Date.now();
                    while (Date.now()-t0 < 5000) {
                      sendBtn = findSendButton();
                      if (sendBtn) break;
                      await sleep(300);
                    }

                    if (sendBtn) {
                      console.log("[Messenger Sender] ✅ 找到发送按钮，点击...");
                      sendBtn.click();
                      await sleep(1500);
                      return { success: true };
                    } else {
                      console.log("[Messenger Sender] 未找到发送按钮，用 Enter 键...");
                      inputBox.dispatchEvent(new KeyboardEvent('keydown', {
                        key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true
                      }));
                      await sleep(1500);
                      return { success: true, note: "Enter 键发送" };
                    }
                  } catch(err) {
                    return { success: false, error: err.message };
                  }
                },
                args: [dmText]
              });

              if (resolved) return;

              const scriptResult = results && results[0] && results[0].result;
              console.log(`[Messenger Tab] 执行结果:`, scriptResult);

              await new Promise(r => setTimeout(r, 2000));

              // v1.1.6: 发完先切回评论管理工具，再关闭 Messenger 标签页
              if (previousActiveTabId) {
                chrome.tabs.update(previousActiveTabId, { active: true }, () => {
                  if (chrome.runtime.lastError) {
                    console.warn("[Messenger Tab] 切回失败:", chrome.runtime.lastError.message);
                  } else {
                    console.log(`[Messenger Tab] ✅ 已切回标签页 ${previousActiveTabId}`);
                  }
                });
              }
              setTimeout(() => chrome.tabs.remove(newTabId, () => { if (chrome.runtime.lastError) {} }), 1000);

              clearTimeout(timeout);
              resolved = true;
              resolve(scriptResult && scriptResult.success
                ? { success: true }
                : { success: false, error: (scriptResult && scriptResult.error) || "脚本执行失败" });

            } catch (execErr) {
              console.error("[Messenger Tab] executeScript 异常:", execErr);
              if (previousActiveTabId) chrome.tabs.update(previousActiveTabId, { active: true }, () => {});
              chrome.tabs.remove(newTabId, () => {});
              clearTimeout(timeout);
              if (!resolved) { resolved = true; resolve({ success: false, error: "executeScript 异常: " + execErr.message }); }
            }
          }, 7000); // v1.1.6: 7 秒等待 Lexical 编辑器完全挂载
        };

        chrome.tabs.onUpdated.addListener(onUpdatedListener);
      });
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

