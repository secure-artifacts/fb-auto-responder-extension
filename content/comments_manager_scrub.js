/**
 * FB 智能私信大师 - Comments Manager Content Script (v1.2.0)
 * 专为 Facebook 专业面板【评论管理工具】打造的集中式极速私信引擎
 * 页面地址: https://www.facebook.com/professional_dashboard/engagement/comments_manager/
 *
 * 核心设计原则：
 *   100% 还原人工操作：在当前页面找到【发消息】按钮 -> 点击展开私信弹窗 ->
 *   在【发消息给 [UserName]】窗口中粘贴私信内容 -> 点击蓝色【发消息】发送 ->
 *   关闭弹窗并等待防封间隔 -> 继续处理下一位留言用户！
 *   杜绝打开外部分页，杜绝跳转，极简、原生、最稳定！
 */

(async function () {
  // 仅在专业面板评论管理工具生效
  if (!window.location.pathname.includes('/comments_manager')) {
    return;
  }

  console.log("[Comments Manager Engine v1.2.0] 专业面板评论管理工具引擎已挂载！");

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

    if (settings.enableCommentsManagerMode === false) {
      console.log("[Comments Manager Engine] 评论管理工具监控已被用户设置关闭");
      return;
    }

    if (checkFacebookEmergencyBrake(settings)) return;

    isProcessingLoop = true;

    try {
      await StorageUtil.saveSettings({
        statusMessage: "正在扫描评论管理工具，检索待回复留言...",
        currentWorkerMode: 'comments_manager'
      });

      // 1. 尝试确认并保持【你未回复】筛选器激活
      await ensureUnrepliedFilterActive();

      // 2. 扫描并精准解析当前页面的所有留言卡片
      let rows = findCommentRows();
      console.log(`[Comments Manager Engine] 扫描到 ${rows.length} 条待处理留言卡片`);

      if (rows.length === 0) {
        // 当前首屏未发现，向下平滑滚动加载更多
        window.scrollBy({ top: 500, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 1500));
        rows = findCommentRows();
      }

      if (rows.length === 0) {
        // 确实暂无可回复留言，回到顶部，稍后巡检
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
      const cooldownHours = settings.dmCooldownHours !== undefined
        ? settings.dmCooldownHours
        : (settings.globalCooldownHours !== undefined ? settings.globalCooldownHours : 24);
      const cooldownMs = cooldownHours * 3600 * 1000;

      let processedCountInBatch = 0;

      for (let i = 0; i < rows.length; i++) {
        if (checkFacebookEmergencyBrake(settings)) break;
        const currentSettings = await StorageUtil.getSettings();
        if (!currentSettings.isRunning || currentSettings.isPaused) break;
        if (currentSettings.enableCommentsManagerMode === false) break;

        const rowItem = rows[i];
        const parsed = parseCommentRow(rowItem);

        // 视觉高亮当前正在检测的卡片（蓝色边框）
        if (rowItem.container) {
          rowItem.container.style.transition = 'box-shadow 0.3s ease';
          rowItem.container.style.boxShadow = '0 0 0 2px #3b82f6';
        }

        const commentKey = (parsed.userName + "_" + parsed.commentText).replace(/\s+/g, '_');
        const userKey = parsed.userName;

        // 设置项检查 1：是否处理历史留言 (超过24小时)
        if (!currentSettings.includeHistory && isHistoricalTime(parsed.commentTime)) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 留言为历史留言 (${parsed.commentTime})，已根据设置跳过`);
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 设置项检查 2：查重（本会话已发、历史已发）
        if (sessionProcessedKeys.has(commentKey)) {
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        if (processedComments[commentKey]) {
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 设置项检查 3：全局用户冷却时间
        const userTouch = userHistory[userKey];
        if (cooldownHours > 0 && userTouch && userTouch.lastDmTime && (Date.now() - userTouch.lastDmTime < cooldownMs)) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 处于私信冷却期内，跳过`);
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 设置项检查 4：关键词规则匹配
        const matchResult = findMatchingRule(parsed.commentText, rules);
        if (!matchResult) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 留言 "${parsed.commentText}" 未匹配任何关键词规则，跳过`);
          sessionProcessedKeys.add(commentKey);
          if (rowItem.container) rowItem.container.style.boxShadow = '';
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
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 占位符全面替换
        const firstName = parsed.userName.split(' ')[0] || parsed.userName;
        let finalDmText = dmTemplate
          .replace(/\[Name\]/ig, parsed.userName)
          .replace(/\{Name\}/ig, parsed.userName)
          .replace(/\{userName\}/ig, parsed.userName)
          .replace(/\[FullName\]/ig, parsed.userName)
          .replace(/\{FullName\}/ig, parsed.userName)
          .replace(/\[FirstName\]/ig, firstName)
          .replace(/\{FirstName\}/ig, firstName)
          .replace(/\[姓名\]/g, parsed.userName)
          .replace(/\{姓名\}/g, parsed.userName)
          .replace(/\[名\]/g, firstName)
          .replace(/\{名\}/g, firstName);

        // 视觉高亮改为绿色（表示正在发送）
        if (rowItem.container) rowItem.container.style.boxShadow = '0 0 0 2px #10b981';

        console.log(`[Comments Manager Engine] 开始对用户 [${parsed.userName}] 执行原生弹窗私信...`);
        
        // ★ 核心：执行原生弹窗私信（在当前页面直接点击、填写、发送）
        const dmResult = await performNativeDialogDm(rowItem, parsed.userName, finalDmText);

        if (rowItem.container) rowItem.container.style.boxShadow = '';

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
          commentText: parsed.commentText,
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
            timeStr,
            dateStr,
            parsed.fbId || "",
            parsed.userName,
            parsed.profileLink || "",
            parsed.postUrl || window.location.href,
            parsed.commentText || "",
            "FB评论管理工具",
            matchResult.rule.name || matchResult.matchedKeyword,
            parsed.commentTime || "刚刚",
            parsed.pageId || ""
          ];

          chrome.runtime.sendMessage({ action: "SYNC_GOOGLE_SHEETS", payload: rowData }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        } catch (e) {
          console.warn("[Comments Manager Engine] 同步 Google Sheets 异常:", e);
        }

        processedCountInBatch++;

        // 设置项检查 5：连续私信防封间隔时间 (秒)
        const dmIntervalSec = currentSettings.dmIntervalSeconds !== undefined ? currentSettings.dmIntervalSeconds : 10;
        const dmIntervalMs = dmIntervalSec * 1000 + Math.floor(Math.random() * 2000);
        await StorageUtil.saveSettings({
          statusMessage: `已向 [${parsed.userName}] 发送私信，等待 ${Math.round(dmIntervalMs / 1000)} 秒后继续...`
        });
        await new Promise(r => setTimeout(r, dmIntervalMs));
      }

      // 本轮遍历完成后，轻量向下滚动加载更多未回复
      console.log(`[Comments Manager Engine] 当前批次处理完成，处理数: ${processedCountInBatch}`);
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

  // ===========================================================================
  // 核心原生弹窗私信引擎：点击【发消息】-> 弹窗 -> 输入 -> 发送 -> 关闭
  // ===========================================================================

  async function performNativeDialogDm(rowItem, userName, dmText) {
    try {
      const container = rowItem.container;
      const sendBtn = findSendMessageButton(container, rowItem.sendBtn);

      if (!sendBtn) {
        console.warn(`[Native DM] 未在卡片中定位到【发消息】按钮: ${userName}`);
        return {
          success: false,
          statusText: "⚠️ 跳过：未定位到【发消息】按钮"
        };
      }

      // 1. 关闭可能还残留的旧弹窗
      const existingDialog = findOpenDmDialog();
      if (existingDialog) {
        closeDialog(existingDialog);
        await new Promise(r => setTimeout(r, 400));
      }

      // 2. 将【发消息】按钮平滑滚入视口中央
      sendBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 500));

      // 3. 计算真实屏幕物理坐标并获取承接点击的顶层元素
      const rect = sendBtn.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);
      const hitTarget = document.elementFromPoint(clientX, clientY) || sendBtn;

      console.log(`[Native DM] 准备点击【发消息】按钮，目标元素: ${sendBtn.tagName}, 顶层命中元素: ${hitTarget.tagName}`);

      // 绝不删除 href！如果 target 是 _blank 则移除 target 防止多开窗口
      if (sendBtn.getAttribute && sendBtn.getAttribute('target') === '_blank') {
        sendBtn.removeAttribute('target');
      }

      // 4. 精准派发单次完整物理鼠标交互事件流
      const evCommons = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: clientX,
        clientY: clientY,
        screenX: clientX + window.screenX,
        screenY: clientY + window.screenY
      };

      try { hitTarget.focus(); } catch(e) {}

      hitTarget.dispatchEvent(new PointerEvent('pointerover', { ...evCommons, pointerId: 1, pointerType: 'mouse' }));
      hitTarget.dispatchEvent(new MouseEvent('mouseover', evCommons));
      hitTarget.dispatchEvent(new PointerEvent('pointerdown', { ...evCommons, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, pressure: 0.5 }));
      hitTarget.dispatchEvent(new MouseEvent('mousedown', { ...evCommons, button: 0, buttons: 1 }));

      // 模拟真人 80ms 按压
      await new Promise(r => setTimeout(r, 80));

      hitTarget.dispatchEvent(new PointerEvent('pointerup', { ...evCommons, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 }));
      hitTarget.dispatchEvent(new MouseEvent('mouseup', { ...evCommons, button: 0, buttons: 0 }));
      hitTarget.dispatchEvent(new MouseEvent('click', { ...evCommons, button: 0, buttons: 0 }));

      // 5. 等待私信弹窗展开 (首轮探测 2.5 秒)
      let dialog = await waitForNativeDmDialog(2500);

      // 若物理事件流未展开，尝试一级原生 targetBtn.click() 兜底 (仅当未打开时触发，杜绝双击闪退)
      if (!dialog) {
        console.log("[Native DM] 首轮事件流未展开，尝试 sendBtn.click() 一级兜底...");
        sendBtn.click();
        dialog = await waitForNativeDmDialog(2500);
      }

      // 若仍未展开，尝试 hitTarget.click() 二级兜底
      if (!dialog && hitTarget !== sendBtn) {
        console.log("[Native DM] 尝试 hitTarget.click() 二级兜底...");
        hitTarget.click();
        dialog = await waitForNativeDmDialog(2500);
      }

      if (!dialog) {
        console.warn("[Native DM] 等待私信弹窗超时，未检测到弹窗");
        return {
          success: false,
          statusText: "❌ 发送失败：未弹出私信窗口 (网络延迟或受 FB 频率限制)"
        };
      }

      console.log("[Native DM] ✅ 私信弹窗已成功展开！寻找输入框...");

      // 6. 定位弹窗中的输入框
      const inputElem = findDialogInputField(dialog);
      if (!inputElem) {
        console.warn("[Native DM] 弹窗已展开，但未找到输入框");
        closeDialog(dialog);
        return {
          success: false,
          statusText: "❌ 发送失败：未定位到私信输入框"
        };
      }

      // 7. 填写私信内容
      console.log("[Native DM] 正在输入私信内容...");
      await injectTextToInput(inputElem, dmText);
      await new Promise(r => setTimeout(r, 800));

      // 8. 点击弹窗中的蓝色【发消息】按钮
      console.log("[Native DM] 正在点击弹窗中的【发消息】发送按钮...");
      const sent = await clickDialogSendButton(dialog);

      if (!sent) {
        console.log("[Native DM] 未能点击发送按钮，尝试回车发送...");
        inputElem.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      }

      // 9. 等待 2.5 秒确保网络请求已发送
      await new Promise(r => setTimeout(r, 2500));

      // 10. 检查弹窗是否仍处于打开状态，若仍打开则优雅关闭
      const dialogStillOpen = document.contains(dialog) && isVisible(dialog);
      if (dialogStillOpen) {
        console.log("[Native DM] 发送完成，正在关闭弹窗...");
        closeDialog(dialog);
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`[Native DM] ✅ 成功向用户 [${userName}] 发送私信！`);
      return {
        success: true,
        statusText: "✅ 私信发送成功"
      };

    } catch (e) {
      console.error("[Native DM] performNativeDialogDm 发生异常:", e);
      return {
        success: false,
        statusText: "❌ 发送异常: " + (e.message || "未知错误")
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 弹窗与输入辅助函数
  // ---------------------------------------------------------------------------

  function findSendMessageButton(container, cachedBtn) {
    const sendKeywords = ['发消息', '发送消息', '发讯息', '發訊息', '傳送訊息', 'send message', 'message', 'enviar mensagem', 'enviar mensaje', 'envoyer un message'];

    // 1. 若此前缓存的按钮有效且在 DOM 中
    if (cachedBtn && document.contains(cachedBtn) && isVisible(cachedBtn)) {
      return cachedBtn;
    }

    if (!container || !document.contains(container)) return null;

    // 2. 优先找 role="button", a, button, span[role="button"]
    const clickables = Array.from(container.querySelectorAll('div[role="button"], a[role="link"], a, button, span[role="button"]'));
    for (const el of clickables) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (sendKeywords.some(k => txt === k)) {
        return el;
      }
    }

    // 3. 找文本为【发消息】的叶子节点，向上找最近的可点击祖先
    const allEls = Array.from(container.querySelectorAll('*'));
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (sendKeywords.some(k => txt === k)) {
        const parentBtn = el.closest('div[role="button"], a, button, span[role="button"]');
        return parentBtn || el;
      }
    }

    return null;
  }

  async function waitForNativeDmDialog(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const dialog = findOpenDmDialog();
      if (dialog) return dialog;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  function findOpenDmDialog() {
    const titleKeywords = ['发消息给', '发送消息给', '發訊息給', '傳送訊息給', 'Send message to', 'Enviar mensagem para', 'Enviar mensaje a', 'Envoyer un message à'];
    
    // 方式 1: 标准 role="dialog" 或 aria-modal="true"
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]'));
    for (const d of dialogs) {
      if (!isVisible(d)) continue;
      const txt = d.innerText || d.textContent || '';
      if (titleKeywords.some(k => txt.includes(k))) {
        return d;
      }
      if ((txt.includes('返回评论') || txt.includes('Back to comment') || txt.includes('Voltar ao comentário')) &&
          d.querySelector('[contenteditable="true"], textarea')) {
        return d;
      }
    }

    // 方式 2: 兜底扫描包含"发消息给"标题的可见容器
    const allDivs = Array.from(document.querySelectorAll('div'));
    for (const d of allDivs) {
      if (!isVisible(d)) continue;
      const txt = d.innerText || '';
      if (titleKeywords.some(k => txt.includes(k)) && 
          (txt.includes('返回评论') || txt.includes('Messenger') || txt.includes('Back')) &&
          d.querySelector('[contenteditable="true"], textarea')) {
        return d;
      }
    }

    return null;
  }

  function findDialogInputField(dialog) {
    const selectors = [
      '[contenteditable="true"][aria-multiline="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'div[aria-label*="消息"][contenteditable]',
      'div[aria-label*="Message"][contenteditable]',
      'textarea',
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
    await new Promise(r => setTimeout(r, 200));

    // 全选可能存在的占位文字
    try {
      document.execCommand('selectAll', false, null);
    } catch(e) {}

    let success = false;

    // 尝试 1: ClipboardEvent paste (对 Facebook Lexical/Draft.js 最原生、最兼容)
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEv = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      inputElem.dispatchEvent(pasteEv);
      await new Promise(r => setTimeout(r, 300));
      const content = inputElem.textContent || inputElem.value || '';
      if (content.includes(text.substring(0, Math.min(6, text.length)))) {
        success = true;
      }
    } catch (e) {}

    // 尝试 2: document.execCommand insertText
    if (!success) {
      try {
        document.execCommand('insertText', false, text);
        await new Promise(r => setTimeout(r, 300));
        const content = inputElem.textContent || inputElem.value || '';
        if (content.includes(text.substring(0, Math.min(6, text.length)))) {
          success = true;
        }
      } catch (e) {}
    }

    // 尝试 3: TextEvent
    if (!success) {
      try {
        const textEvent = document.createEvent('TextEvent');
        textEvent.initTextEvent('textInput', true, true, window, text, 9, "en-US");
        inputElem.dispatchEvent(textEvent);
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {}
    }

    // 尝试 4: 暴力赋值 + Input 事件
    if (!success) {
      if (inputElem.tagName === 'TEXTAREA' || inputElem.tagName === 'INPUT') {
        inputElem.value = text;
      } else {
        inputElem.innerText = text;
      }
      inputElem.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      inputElem.dispatchEvent(new Event('input', { bubbles: true }));
      inputElem.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async function clickDialogSendButton(dialog) {
    const sendKeywords = ['发消息', '发送消息', '发送', '發送', '發訊息', '傳送訊息', 'Send message', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message', 'Kirim Pesan'];
    const skipKeywords = ['返回', '取消', 'Back', 'Cancel', 'Voltar', '返回评论'];

    const allButtons = Array.from(dialog.querySelectorAll('div[role="button"], a[role="link"], button, span[role="button"]'));
    let sendBtn = null;

    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const txt = (btn.innerText || btn.textContent || '').trim();
      if (skipKeywords.some(k => txt.includes(k))) continue;
      if (sendKeywords.some(kw => txt === kw || txt.includes(kw))) {
        sendBtn = btn;
        break;
      }
    }

    if (!sendBtn) {
      for (const btn of allButtons) {
        if (!isVisible(btn)) continue;
        const label = (btn.getAttribute('aria-label') || '').trim();
        if (skipKeywords.some(k => label.includes(k))) continue;
        if (sendKeywords.some(kw => label === kw || label.includes(kw))) {
          sendBtn = btn;
          break;
        }
      }
    }

    if (sendBtn) {
      console.log("[Comments Manager Engine] 找到弹窗发送按钮:", sendBtn.innerText || sendBtn.getAttribute('aria-label'));

      // 等待发送按钮解除禁用状态 (最多 3 秒)
      const startWait = Date.now();
      while (Date.now() - startWait < 3000) {
        const isDisabled = sendBtn.getAttribute('aria-disabled') === 'true' || 
                           sendBtn.disabled || 
                           sendBtn.classList.contains('disabled');
        if (!isDisabled) break;
        await new Promise(r => setTimeout(r, 300));
      }

      // 仅调用一次 click()，防止 React 重复捕获
      sendBtn.click();
      await new Promise(r => setTimeout(r, 500));
      return true;
    }

    return false;
  }

  function closeDialog(dialog) {
    const closeBtn = dialog.querySelector('div[aria-label="关闭"], div[aria-label="Close"], svg[aria-label="关闭"], button[aria-label="关闭"]');
    if (closeBtn) {
      closeBtn.click();
    } else {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
  }

  // ---------------------------------------------------------------------------
  // DOM 提取与列表解析辅助函数
  // ---------------------------------------------------------------------------

  function findCommentRows() {
    const sendKeywords = ['发消息', '发送消息', '发讯息', '發訊息', '傳送訊息', 'send message', 'message', 'enviar mensagem', 'enviar mensaje', 'envoyer un message'];
    
    // 优先从可点击元素中寻找【发消息】按钮
    const allClickables = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], a[role="link"], a, button, span, div'));
    
    const sendButtons = allClickables.filter(el => {
      if (!isVisible(el)) return false;
      if (el.children.length > 2) return false;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      return sendKeywords.some(k => txt === k.toLowerCase());
    });

    const rows = [];
    const seenContainers = new Set();

    for (const btn of sendButtons) {
      let curr = btn.parentElement;
      let cardContainer = null;

      while (curr && curr !== document.body) {
        const text = curr.innerText || '';
        // 包含时间标识和操作标识
        if ((text.includes('·') || text.includes('•') || /\d+\s*(小时|天|周|月|年|h|d|m)/i.test(text)) && 
            (text.includes('回复') || text.includes('Reply') || text.includes('隐藏') || text.includes('Hide') || text.includes('赞') || text.includes('Like'))) {
          const innerSendCount = Array.from(curr.querySelectorAll('*')).filter(el => {
            const t = (el.innerText || '').trim();
            return t === '发消息' || t === 'Send message';
          }).length;

          if (innerSendCount <= 4) {
            cardContainer = curr;
            break;
          }
        }
        curr = curr.parentElement;
      }

      if (cardContainer && !seenContainers.has(cardContainer)) {
        seenContainers.add(cardContainer);
        rows.push({
          container: cardContainer,
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

    // 1. 查找所有链接
    const links = Array.from(container.querySelectorAll('a[href]'));
    const postKeywords = ['/posts/', '/reel/', '/videos/', 'permalink.php', 'story_fbid'];
    const postLinkEl = links.find(a => postKeywords.some(k => (a.href || '').toLowerCase().includes(k)));
    if (postLinkEl) postUrl = postLinkEl.href;

    const userLinks = links.filter(a => {
      if (a === postLinkEl) return false;
      const h = (a.href || '').toLowerCase();
      if (!h) return false;
      if (h.includes('/professional_dashboard/')) return false;
      if (h.includes('/messages/')) return false;
      if (postKeywords.some(k => h.includes(k))) return false;
      return true;
    });

    // 优先从 <a> 文本提取用户名
    for (const a of userLinks) {
      const rawA = (a.innerText || a.textContent || '').trim();
      if (!rawA) continue;
      const namePart = rawA.split(/[·•]/)[0].trim();
      const actionWords = ['赞', '回复', '发消息', '隐藏', '...', 'Like', 'Reply', 'Send message', 'Hide'];
      if (namePart.length > 0 && !actionWords.includes(namePart) && !namePart.includes('条评论') && namePart !== '没有文字内容') {
        userName = namePart;
        profileLink = a.href;
        break;
      }
    }

    if (!profileLink && userLinks.length > 0) profileLink = userLinks[0].href;

    // 2. 从文本行提取用户名、时间、留言内容
    const rawText = container.innerText || '';
    const lines = rawText.split('\n').map(s => s.trim()).filter(Boolean);

    const dotLineIdx = lines.findIndex(l => (l.includes('·') || l.includes('•')) && !l.includes('条评论'));
    if (dotLineIdx !== -1) {
      const dotLine = lines[dotLineIdx];
      const sep = dotLine.includes('·') ? '·' : '•';
      const parts = dotLine.split(sep);

      if (parts[0] && parts[0].trim() && userName === "未知用户") {
        userName = parts[0].trim();
      } else if (userName === "未知用户" && dotLineIdx > 0) {
        const prevLine = lines[dotLineIdx - 1];
        if (!['没有文字内容', '条评论'].some(k => prevLine.includes(k))) userName = prevLine;
      }

      if (parts[1] && parts[1].trim()) commentTime = parts[1].trim();
    }

    // 3. 精准提取留言内容
    const actionWords = ['赞', '回复', '发消息', '隐藏', 'Like', 'Reply', 'Send message', 'Hide', '...'];
    const candidateLines = [];
    let startCollecting = (dotLineIdx !== -1) ? (dotLineIdx + 1) : 1;

    for (let i = startCollecting; i < lines.length; i++) {
      const line = lines[i];
      if (actionWords.includes(line)) break;
      if (line === commentTime || line === userName) continue;
      if (line.includes('条评论') || line === '没有文字内容') continue;
      candidateLines.push(line);
    }

    if (candidateLines.length > 0) {
      commentText = candidateLines.join(' ').trim();
    }

    if (!commentText) {
      const contentEls = Array.from(container.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
      for (const el of contentEls) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        if (t === userName || t.includes('·') || t === '没有文字内容' || actionWords.includes(t)) continue;
        commentText = t;
        break;
      }
    }

    // 提取用户 ID
    let fbId = "";
    if (profileLink) {
      try {
        const u = new URL(profileLink);
        fbId = u.searchParams.get('id') || u.pathname.split('/').filter(Boolean)[0] || "";
      } catch (e) { fbId = profileLink; }
    }

    let pageId = "";
    if (postUrl) {
      try {
        const u = new URL(postUrl);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length > 0 && !['reel', 'watch', 'groups', 'permalink.php'].includes(parts[0])) pageId = parts[0];
      } catch(e) {}
    }

    return { userName, commentTime, commentText, profileLink, postUrl, fbId, pageId, sendBtn };
  }

  function isHistoricalTime(timeStr) {
    if (!timeStr) return false;
    const s = timeStr.trim().toLowerCase();
    if (/刚刚|秒|分|小时/.test(s)) return false;
    if (/\b\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.test(s)) return false;
    if (/^(just now|now|\d+[smh])$/i.test(s)) return false;
    if (/[天周月年]/.test(s)) return true;
    if (/\b\d+\s*(d|day|days|w|week|weeks|mo|mon|month|months|y|yr|yrs|year|years)\b/i.test(s)) return true;
    if (/^\d+[dwy]$/i.test(s) || /^\d+mo$/i.test(s)) return true;
    if (/(dia|sem|m[êe]s|ano)/i.test(s)) return true;
    if (/\d{4}[-/.]|\d{1,2}[-/.]\d{1,2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true;
    return false;
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

  function checkFacebookEmergencyBrake(settings) {
    if (settings && settings.emergencyBrakeEnabled === false) return false;
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
