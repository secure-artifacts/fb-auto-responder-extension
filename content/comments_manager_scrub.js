/**
 * FB 智能私信大师 - Comments Manager Content Script (v1.1.0)
 * 专为 Facebook 专业面板【评论管理工具】打造的集中式极速私信引擎
 * 页面地址: https://www.facebook.com/professional_dashboard/engagement/comments_manager/
 */

(async function () {
  // 仅在专业面板评论管理工具生效
  if (!window.location.pathname.includes('/comments_manager')) {
    return;
  }

  console.log("[Comments Manager Engine] 专业面板评论管理工具引擎已挂载！");

  let isProcessingLoop = false;
  let pollTimer = null;
  const sessionProcessedKeys = new Set();

  function scheduleNextPoll(seconds) {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollTimer = setTimeout(() => {
      runCommentsManagerLoop();
    }, seconds * 1000);
  }

  // 监听来自后台的软巡检唤醒消息
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === "SOFT_REFRESH_COMMENTS_MANAGER" || req.action === "SOFT_REFRESH_NOTIFICATIONS") {
      console.log("[Comments Manager Engine] 收到软巡检唤醒指令...");
      if (!isProcessingLoop) {
        runCommentsManagerLoop();
      }
      sendResponse({ status: "ACK" });
    }
    return true;
  });

  async function runCommentsManagerLoop() {
    if (isProcessingLoop) {
      console.log("[Comments Manager Engine] 任务循环进行中，跳过重复触发");
      return;
    }

    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    const settings = await StorageUtil.getSettings();
    if (!settings.isRunning || settings.isPaused) {
      console.log("[Comments Manager Engine] 任务未启动或已暂停");
      return;
    }

    if (checkFacebookEmergencyBrake()) return;

    isProcessingLoop = true;

    try {
      await StorageUtil.saveSettings({
        statusMessage: "正在扫描评论管理工具，检索待回复留言...",
        currentWorkerMode: 'comments_manager'
      });

      // 1. 尝试确认并保持【你未回复】筛选器激活
      await ensureUnrepliedFilterActive();

      // 2. 扫描并解析当前页面的所有留言行
      const rows = findCommentRows();
      console.log(`[Comments Manager Engine] 扫描到 ${rows.length} 条待处理留言卡片`);

      if (rows.length === 0) {
        // 当前首屏未发现，尝试微平滑滚动加载更多
        window.scrollBy({ top: 500, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 1500));
        const retryRows = findCommentRows();
        if (retryRows.length > 0) {
          rows.push(...retryRows);
        }
      }

      if (rows.length === 0) {
        // 确实暂无可回复留言，滚动回到顶部，稍候再次巡检
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const waitSec = Math.max(3, settings.notificationCheckInterval || 5);
        await StorageUtil.saveSettings({
          statusMessage: `暂无未回复留言，${waitSec} 秒后再次巡检...`
        });
        isProcessingLoop = false;
        scheduleNextPoll(waitSec);
        return;
      }

      // 3. 读取规则、冷却记录、历史记录
      const rules = await StorageUtil.getRules();
      const processedComments = await StorageUtil.getProcessedComments();
      const userHistory = await StorageUtil.getUserHistory();
      const cooldownHours = settings.dmCooldownHours || 24;
      const cooldownMs = cooldownHours * 3600 * 1000;

      let processedCountInBatch = 0;

      for (let i = 0; i < rows.length; i++) {
        if (checkFacebookEmergencyBrake()) break;
        const currentSettings = await StorageUtil.getSettings();
        if (!currentSettings.isRunning || currentSettings.isPaused) break;

        const rowItem = rows[i];
        const parsed = parseCommentRow(rowItem);

        const commentKey = (parsed.userName + "_" + parsed.commentText).replace(/\s+/g, '_');
        const userKey = parsed.userName;

        // 查重：本会话已发、历史已发、或处于冷却期
        if (sessionProcessedKeys.has(commentKey)) {
          continue;
        }

        if (processedComments[commentKey]) {
          continue;
        }

        const userTouch = userHistory[userKey];
        if (userTouch && userTouch.lastDmTime && (Date.now() - userTouch.lastDmTime < cooldownMs)) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 处于私信冷却期内，跳过`);
          continue;
        }

        // 关键词匹配
        const matchResult = findMatchingRule(parsed.commentText, rules);
        if (!matchResult) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 留言 "${parsed.commentText}" 未匹配任何关键词规则，跳过`);
          sessionProcessedKeys.add(commentKey);
          continue;
        }

        // 找到符合条件的留言，准备发送私信
        await StorageUtil.saveSettings({
          statusMessage: `正在私信 [${parsed.userName}]: 匹配 "${matchResult.matchedKeyword}"...`
        });

        const dmTemplate = getRandomItem(matchResult.rule.dmTemplates, parsed.userName);
        if (!dmTemplate) {
          console.warn("[Comments Manager Engine] 规则未配置私信话术模板");
          sessionProcessedKeys.add(commentKey);
          continue;
        }

        const firstName = parsed.userName.split(' ')[0];
        const finalDmText = dmTemplate
          .replace(/\[Name\]/ig, parsed.userName)
          .replace(/\[FullName\]/ig, parsed.userName)
          .replace(/\[FirstName\]/ig, firstName);

        // 执行原地唤起原生私信弹窗并发送
        console.log(`[Comments Manager Engine] 开始向 [${parsed.userName}] 原地发送私信...`);
        const dmResult = await performNativeDialogDm(rowItem.sendBtn, parsed.userName, finalDmText);

        // 记录状态
        sessionProcessedKeys.add(commentKey);
        await StorageUtil.markCommentProcessed(commentKey);
        await StorageUtil.recordUserTouch(userKey, {
          userName: parsed.userName,
          dmSentSuccess: dmResult.success
        });

        // 更新统计数据
        const stats = currentSettings.stats || { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
        stats.totalProcessed += 1;
        if (dmResult.success) stats.totalDmSent += 1;
        else stats.totalErrors += 1;
        await StorageUtil.saveSettings({ stats });

        // 添加详细日志
        await StorageUtil.addLog({
          userName: parsed.userName,
          postUrl: parsed.postUrl || window.location.href,
          profileLink: parsed.profileLink,
          matchedKeyword: matchResult.matchedKeyword,
          dmStatus: dmResult.statusText,
          level: dmResult.success ? "info" : "error"
        });

        // 异步同步到 Google 表格 11 列标准字段
        try {
          const now = new Date();
          const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
          const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

          const rowData = [
            timeStr,                                      // A: 填表时间戳
            dateStr,                                      // B: 填表日期
            parsed.fbId || "",                            // C: 留言用户ID
            parsed.userName,                              // D: 留言用户姓名
            parsed.profileLink || "",                     // E: 留言用户主页连接
            parsed.postUrl || window.location.href,       // F: 评论贴文连接
            parsed.commentText || "",                     // G: 评论内容
            "FB评论管理工具",                             // H: 来源
            matchResult.rule.name || matchResult.matchedKeyword, // I: 标签
            parsed.commentTime || "刚刚",                 // J: 留言日期
            parsed.pageId || ""                           // K: 本公共主页ID
          ];

          chrome.runtime.sendMessage({ action: "SYNC_GOOGLE_SHEETS", payload: rowData }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        } catch (e) {
          console.warn("[Comments Manager Engine] 同步 Google Sheets 异常:", e);
        }

        processedCountInBatch++;

        // 连续私信防封间隔
        const dmIntervalMs = (settings.dmIntervalSeconds || 10) * 1000 + Math.floor(Math.random() * 2000);
        await StorageUtil.saveSettings({
          statusMessage: `已向 [${parsed.userName}] 发送私信，等待 ${Math.round(dmIntervalMs / 1000)} 秒后继续...`
        });
        await new Promise(r => setTimeout(r, dmIntervalMs));
      }

      // 本轮遍历完成后，轻量向下滚动加载更多未回复
      console.log(`[Comments Manager Engine] 当前视口批次处理完成，处理数: ${processedCountInBatch}，平滑滚动加载更多...`);
      window.scrollBy({ top: 600, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      console.error("[Comments Manager Engine] 巡检循环异常:", err);
    } finally {
      isProcessingLoop = false;
      const waitSec = Math.max(3, settings.notificationCheckInterval || 5);
      scheduleNextPoll(waitSec);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM 提取与解析辅助函数
  // ---------------------------------------------------------------------------

  function findCommentRows() {
    const sendKeywords = ['发消息', '发送消息', '发讯息', '發訊息', '傳送訊息', 'send message', 'message', 'enviar mensagem', 'enviar mensaje', 'envoyer un message'];
    const allElements = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], a[role="button"], span, div, a'));
    
    // 查找所有文案包含【发消息】且结构简洁的按钮
    const sendButtons = allElements.filter(el => {
      if (el.children.length > 2) return false;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      return sendKeywords.some(k => txt === k.toLowerCase());
    });

    const rows = [];
    const visitedContainers = new Set();

    for (const btn of sendButtons) {
      if (!isVisible(btn)) continue;

      // 向上查找该评论所在的卡片行容器
      let parent = btn.parentElement;
      let cardRow = null;
      for (let i = 0; i < 9; i++) {
        if (!parent) break;
        const text = parent.innerText || '';
        // 检查容器是否同时包含点赞/回复/隐藏，且有时间符号 "·"
        if (text.includes('·') && (text.includes('回复') || text.includes('Reply') || text.includes('隐藏') || text.includes('Hide') || text.includes('赞') || text.includes('Like'))) {
          cardRow = parent;
        }
        parent = parent.parentElement;
      }

      if (cardRow && !visitedContainers.has(cardRow)) {
        visitedContainers.add(cardRow);
        rows.push({
          container: cardRow,
          sendBtn: btn
        });
      }
    }

    return rows;
  }

  function parseCommentRow(rowObj) {
    const { container, sendBtn } = rowObj;

    let userName = "未知用户";
    let commentTime = "刚刚";
    let commentText = "";
    let profileLink = "";
    let postUrl = "";

    // 1. 从卡片内的所有 <a> 链接中分类提取贴文链接与用户主页链接
    const links = Array.from(container.querySelectorAll('a[href]'));
    
    // 贴文链接特征
    const postKeywords = ['/posts/', '/reel/', '/videos/', 'permalink.php', 'story_fbid'];
    const postLinkEl = links.find(a => postKeywords.some(k => (a.href || '').toLowerCase().includes(k)));
    if (postLinkEl) {
      postUrl = postLinkEl.href;
    }

    // 用户主页链接特征（排除贴文链接与当前管理面板链接）
    const profileLinkEl = links.find(a => {
      if (a === postLinkEl) return false;
      const h = (a.href || '').toLowerCase();
      if (!h) return false;
      if (h.includes('/professional_dashboard/')) return false;
      if (postKeywords.some(k => h.includes(k))) return false;
      return true;
    });

    if (profileLinkEl) {
      profileLink = profileLinkEl.href;
      if (profileLinkEl.innerText && profileLinkEl.innerText.trim()) {
        userName = profileLinkEl.innerText.trim();
      }
    }

    // 2. 从文本行分析提取用户名、时间、留言文本
    const rawText = container.innerText || '';
    const lines = rawText.split('\n').map(s => s.trim()).filter(Boolean);

    // 寻找带 "·" 的那一行（例如 "Hollymoon Cee Brown Pedro · 2小时" 或 "· 2小时"）
    const dotLineIdx = lines.findIndex(l => l.includes('·') && !l.includes('条评论'));
    if (dotLineIdx !== -1) {
      const dotLine = lines[dotLineIdx];
      const parts = dotLine.split('·');
      if (parts[0] && parts[0].trim() && userName === "未知用户") {
        userName = parts[0].trim();
      }
      if (parts[1] && parts[1].trim()) {
        commentTime = parts[1].trim();
      }

      // 留言内容通常紧随其后（在作者行之后，在赞/回复/发消息操作按钮之前）
      const actionWords = ['赞', '回复', '发消息', '隐藏', 'Like', 'Reply', 'Send message', 'Hide', '...'];
      for (let i = dotLineIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (actionWords.includes(line)) break;
        if (!commentText) {
          commentText = line;
        } else {
          commentText += " " + line;
        }
      }
    }

    // 如果依然未能提取到留言内容，尝试读取具有 dir="auto" 的 div/span
    if (!commentText) {
      const contentEls = Array.from(container.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
      for (const el of contentEls) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        if (t === userName || t.includes('·') || t === '没有文字内容' || ['赞', '回复', '发消息', '隐藏'].includes(t)) continue;
        commentText = t;
        break;
      }
    }

    // 提取用户 ID
    let fbId = "";
    if (profileLink) {
      try {
        const u = new URL(profileLink);
        if (u.searchParams.get('id')) {
          fbId = u.searchParams.get('id');
        } else {
          const parts = u.pathname.split('/').filter(Boolean);
          if (parts.length > 0) fbId = parts[0];
        }
      } catch (e) {
        fbId = profileLink;
      }
    }

    // 提取主页 ID
    let pageId = "";
    if (postUrl) {
      try {
        const u = new URL(postUrl);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length > 0 && !['reel', 'watch', 'groups', 'permalink.php'].includes(parts[0])) {
          pageId = parts[0];
        }
      } catch(e) {}
    }

    return {
      userName,
      commentTime,
      commentText,
      profileLink,
      postUrl,
      fbId,
      pageId,
      sendBtn
    };
  }

  async function ensureUnrepliedFilterActive() {
    try {
      const allButtons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], div[role="tab"], button, span'));
      const unrepliedBtn = allButtons.find(b => {
        const txt = (b.innerText || b.textContent || '').trim();
        return txt === '你未回复' || txt === '未回复' || txt === 'Unreplied' || txt === 'Não respondidas' || txt === 'No respondidos';
      });

      if (unrepliedBtn) {
        const isSelected = unrepliedBtn.getAttribute('aria-pressed') === 'true' || 
                           unrepliedBtn.getAttribute('aria-selected') === 'true' ||
                           unrepliedBtn.classList.contains('active');
        if (!isSelected && unrepliedBtn.getAttribute('aria-pressed') !== 'true') {
          console.log("[Comments Manager Engine] 尝试激活【你未回复】筛选器...");
          unrepliedBtn.click();
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch (e) {
      console.warn("[Comments Manager Engine] 筛选器检测异常:", e);
    }
  }

  // ---------------------------------------------------------------------------
  // 原生私信弹窗交互引擎
  // ---------------------------------------------------------------------------

  async function performNativeDialogDm(sendMsgBtn, userName, dmText) {
    try {
      if (!sendMsgBtn) {
        return { success: false, statusText: "⚠️ 跳过：留言无【发消息】按钮" };
      }

      // 关闭旧弹窗
      const existingDialog = document.querySelector('div[role="dialog"]');
      if (existingDialog) {
        closeDialog(existingDialog);
        await new Promise(r => setTimeout(r, 500));
      }

      if (sendMsgBtn.tagName === 'A') {
        sendMsgBtn.removeAttribute('target');
        sendMsgBtn.removeAttribute('href');
      }

      // 触发真实人类点击事件
      sendMsgBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 300));
      sendMsgBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      sendMsgBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      sendMsgBtn.click();

      // 等待原生私信弹窗展开
      const dialog = await waitForNativeDmDialog(5000);
      if (!dialog) {
        return {
          success: false,
          statusText: "❌ 发送失败：未弹出私信窗口 (网络延迟或受 FB 频率限制)"
        };
      }

      const inputElem = findDialogInputField(dialog);
      if (!inputElem) {
        closeDialog(dialog);
        return {
          success: false,
          statusText: "❌ 发送失败：未定位到私信输入框"
        };
      }

      await injectTextToInput(inputElem, dmText);
      await new Promise(r => setTimeout(r, 1000));

      const sent = await clickDialogSendButton(dialog);
      if (!sent) {
        inputElem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }

      // 等待网络请求发送
      await new Promise(r => setTimeout(r, 2500));

      const dialogStillOpen = document.contains(dialog) && isVisible(dialog);
      if (dialogStillOpen) {
        closeDialog(dialog);
      }

      return {
        success: true,
        statusText: "✅ 私信发送成功"
      };

    } catch (e) {
      console.error("[Comments Manager Engine] performNativeDialogDm error:", e);
      return {
        success: false,
        statusText: "❌ 发送异常: " + (e.message || "未知错误")
      };
    }
  }

  async function waitForNativeDmDialog(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      for (const d of dialogs) {
        if (!isVisible(d)) continue;
        const titleText = d.innerText || '';
        const titleKeys = ['发消息给', '发送消息给', '發訊息給', '傳送訊息給', 'Send message to', 'Enviar mensagem para', 'Enviar mensaje a', 'Envoyer un message à'];
        if (titleKeys.some(k => titleText.includes(k))) {
          return d;
        }
        const hasInput = d.querySelector('[contenteditable="true"]');
        if (hasInput && isVisible(hasInput)) return d;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  }

  function findDialogInputField(dialog) {
    const selectors = [
      '[contenteditable="true"][aria-multiline="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea'
    ];
    for (const s of selectors) {
      const el = dialog.querySelector(s);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  async function injectTextToInput(inputElem, text) {
    inputElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    inputElem.focus();
    inputElem.click();
    inputElem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    inputElem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    inputElem.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));

    // 尝试 1: ClipboardEvent (Paste)
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });
      inputElem.dispatchEvent(pasteEvent);
      await new Promise(r => setTimeout(r, 400));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 2: document.execCommand
    try {
      inputElem.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 400));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 3: TextEvent
    try {
      const textEvent = document.createEvent('TextEvent');
      textEvent.initTextEvent('textInput', true, true, window, text, 9, "en-US");
      inputElem.dispatchEvent(textEvent);
      await new Promise(r => setTimeout(r, 400));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 4: 暴力赋值 + Input 事件
    inputElem.innerText = text;
    inputElem.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    inputElem.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
  }

  async function clickDialogSendButton(dialog) {
    const sendKeywords = ['发消息', '发送消息', '发送', '發送', '發訊息', '傳送訊息', 'Send message', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message'];
    const allButtons = Array.from(dialog.querySelectorAll('div[role="button"], a[role="link"], button, span[role="button"]'));
    let sendBtn = null;

    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const txt = btn.innerText ? btn.innerText.trim() : '';
      if (sendKeywords.some(kw => txt === kw || txt.includes(kw))) {
        if (txt.includes('返回') || txt.includes('Back') || txt.includes('返回评论')) continue;
        sendBtn = btn;
        break;
      }
    }

    if (!sendBtn) {
      for (const btn of allButtons) {
        if (!isVisible(btn)) continue;
        const label = btn.getAttribute('aria-label') || '';
        if (sendKeywords.some(kw => label.includes(kw))) {
          sendBtn = btn;
          break;
        }
      }
    }

    if (sendBtn) {
      sendBtn.click();
      await new Promise(r => setTimeout(r, 400));
      return true;
    }
    return false;
  }

  function closeDialog(dialog) {
    const closeBtn = dialog.querySelector('div[aria-label="关闭"], div[aria-label="Close"], svg[aria-label="关闭"], button[aria-label="关闭"]');
    if (closeBtn) closeBtn.click();
  }

  function findMatchingRule(commentText, rules) {
    const normalize = (s) => (s || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const textNorm = normalize(commentText);
    for (const r of rules) {
      if (!r.keywords || r.keywords.length === 0) continue;
      for (const kw of r.keywords) {
        const kwNorm = normalize(kw);
        if (!kwNorm) continue;
        if (r.matchType === 'exact' ? textNorm === kwNorm : textNorm.includes(kwNorm)) {
          return { rule: r, matchedKeyword: kw };
        }
      }
    }
    return null;
  }

  function getRandomItem(array, userName) {
    if (!array || array.length === 0) return null;
    const raw = array[Math.floor(Math.random() * array.length)];
    return raw ? raw.replace(/{userName}/g, userName) : null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function checkFacebookEmergencyBrake() {
    const pageText = document.body ? document.body.innerText : "";
    const warningKeywords = ["验证码", "Security Check Required", "您已被限制使用此功能", "You're Temporarily Blocked", "Action Blocked"];
    for (const kw of warningKeywords) {
      if (pageText.includes(kw)) {
        chrome.runtime.sendMessage({ action: "TRIGGER_EMERGENCY_BRAKE", reason: `检测到安全拦截: "${kw}"` });
        return true;
      }
    }
    return false;
  }

  // 启动巡检
  scheduleNextPoll(2);

})();
