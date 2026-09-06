/**
 * FB 智能私信大师 - Comments Manager Content Script (v1.1.2)
 * 专为 Facebook 专业面板【评论管理工具】打造的集中式极速私信引擎
 * 页面地址: https://www.facebook.com/professional_dashboard/engagement/comments_manager/
 */

(async function () {
  // 仅在专业面板评论管理工具生效
  if (!window.location.pathname.includes('/comments_manager')) {
    return;
  }

  console.log("[Comments Manager Engine v1.1.2] 专业面板评论管理工具引擎已挂载！");

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

    if (settings.enableCommentsManagerMode === false && settings.enableNotificationMode === false) {
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
      const cooldownHours = settings.dmCooldownHours !== undefined ? settings.dmCooldownHours : 24;
      const cooldownMs = cooldownHours * 3600 * 1000;

      let processedCountInBatch = 0;

      for (let i = 0; i < rows.length; i++) {
        if (checkFacebookEmergencyBrake(settings)) break;
        const currentSettings = await StorageUtil.getSettings();
        if (!currentSettings.isRunning || currentSettings.isPaused) break;

        const rowItem = rows[i];
        const parsed = parseCommentRow(rowItem);

        // 视觉高亮当前正在检测的卡片
        if (rowItem.container) {
          rowItem.container.style.transition = 'box-shadow 0.3s ease';
          rowItem.container.style.boxShadow = '0 0 0 2px #3b82f6';
        }

        const commentKey = (parsed.userName + "_" + parsed.commentText).replace(/\s+/g, '_');
        const userKey = parsed.userName;

        // 设置项检查：是否过滤历史留言（超过24小时）
        if (!currentSettings.includeHistory && isHistoricalTime(parsed.commentTime)) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 留言为历史留言 (${parsed.commentTime})，已根据设置跳过`);
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 查重：本会话已发、历史已发、或处于冷却期
        if (sessionProcessedKeys.has(commentKey)) {
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        if (processedComments[commentKey]) {
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        const userTouch = userHistory[userKey];
        if (userTouch && userTouch.lastDmTime && (Date.now() - userTouch.lastDmTime < cooldownMs)) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 处于私信冷却期内，跳过`);
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 关键词匹配
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

        // 占位符全面替换 (支持 [Name], {userName}, {姓名}, [FirstName] 等多种格式)
        const firstName = parsed.userName.split(' ')[0];
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

        // 执行原地唤起原生私信弹窗并发送
        console.log(`[Comments Manager Engine] 准备向 [${parsed.userName}] 原地发送私信... 内容: "${finalDmText.substring(0, 30)}..."`);
        const dmResult = await performNativeDialogDm(rowItem.sendBtn, parsed.userName, finalDmText);

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

        // 添加详细日志 (完整包含 commentText 便于看板呈现)
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

        // 连续私信防封间隔 (读取设置)
        const dmIntervalSec = currentSettings.dmIntervalSeconds !== undefined ? currentSettings.dmIntervalSeconds : 10;
        const dmIntervalMs = dmIntervalSec * 1000 + Math.floor(Math.random() * 2000);
        await StorageUtil.saveSettings({
          statusMessage: `已向 [${parsed.userName}] 处理，等待 ${Math.round(dmIntervalMs / 1000)} 秒后继续...`
        });
        await new Promise(r => setTimeout(r, dmIntervalMs));
      }

      // 本轮遍历完成后，轻量向下滚动加载更多未回复
      console.log(`[Comments Manager Engine] 当前批次处理完成，处理数: ${processedCountInBatch}，平滑滚动加载更多...`);
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
    const allClickables = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], a[role="link"], a, button, span, div'));
    
    // 1. 精准寻找【发消息】按钮（过滤掉子节点过多的巨大外壳）
    const sendButtons = allClickables.filter(el => {
      if (!isVisible(el)) return false;
      if (el.children.length > 2) return false;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      return sendKeywords.some(k => txt === k.toLowerCase());
    });

    const rows = [];
    const seenContainers = new Set();

    for (const btn of sendButtons) {
      // 2. 向上寻找该按钮所属的【单条评论独立卡片容器】（严禁冒泡到整张列表表格！）
      let curr = btn.parentElement;
      let cardContainer = null;

      while (curr && curr !== document.body) {
        const text = curr.innerText || '';
        // 单条评论卡片必须包含时间符号（· 或 •）以及操作词（回复/隐藏/赞）
        if ((text.includes('·') || text.includes('•')) && (text.includes('回复') || text.includes('Reply') || text.includes('隐藏') || text.includes('Hide') || text.includes('赞') || text.includes('Like'))) {
          // 核心隔离判定：该容器内部包含的“发消息”按钮数不能超过 3（防止选到了整张大表格）
          const innerSendCount = Array.from(curr.querySelectorAll('*')).filter(el => {
            const t = (el.innerText || '').trim();
            return t === '发消息' || t === 'Send message';
          }).length;

          if (innerSendCount <= 4) {
            cardContainer = curr;
            break; // 找到最近的单条卡片即刻终止，绝不继续向上扩散！
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
    
    // 贴文链接特征
    const postKeywords = ['/posts/', '/reel/', '/videos/', 'permalink.php', 'story_fbid'];
    const postLinkEl = links.find(a => postKeywords.some(k => (a.href || '').toLowerCase().includes(k)));
    if (postLinkEl) {
      postUrl = postLinkEl.href;
    }

    // 筛选用户主页链接（排除贴文链接与管理面板链接）
    const userLinks = links.filter(a => {
      if (a === postLinkEl) return false;
      const h = (a.href || '').toLowerCase();
      if (!h) return false;
      if (h.includes('/professional_dashboard/')) return false;
      if (postKeywords.some(k => h.includes(k))) return false;
      return true;
    });

    // 优先提取包含真实姓名文本的 <a> 链接，排除无文本的头像 <a>
    const textUserLink = userLinks.find(a => {
      const t = (a.innerText || a.textContent || '').trim();
      return t.length > 0 && !t.includes('·') && !['赞', '回复', '发消息', '隐藏', '...'].includes(t);
    });

    if (textUserLink) {
      profileLink = textUserLink.href;
      userName = (textUserLink.innerText || textUserLink.textContent || '').trim();
    } else if (userLinks.length > 0) {
      profileLink = userLinks[0].href;
    }

    // 2. 从文本行分析提取用户名、时间、留言文本
    const rawText = container.innerText || '';
    const lines = rawText.split('\n').map(s => s.trim()).filter(Boolean);

    // 寻找带 "·" 或 "•" 的那一行（排除“2条评论”这类贴文行）
    const dotLineIdx = lines.findIndex(l => (l.includes('·') || l.includes('•')) && !l.includes('条评论'));
    if (dotLineIdx !== -1) {
      const dotLine = lines[dotLineIdx];
      const sep = dotLine.includes('·') ? '·' : '•';
      const parts = dotLine.split(sep);

      if (parts[0] && parts[0].trim()) {
        if (userName === "未知用户") {
          userName = parts[0].trim();
        }
      } else if (userName === "未知用户" && dotLineIdx > 0) {
        // 点符号前面无文本，说明上一行就是作者名
        const prevLine = lines[dotLineIdx - 1];
        if (!['没有文字内容', '条评论'].some(k => prevLine.includes(k))) {
          userName = prevLine;
        }
      }

      if (parts[1] && parts[1].trim()) {
        commentTime = parts[1].trim();
      }

      // 提取留言内容：紧随作者行之后，在操作按钮（赞/回复/发消息/隐藏）之前
      const actionWords = ['赞', '回复', '发消息', '隐藏', 'Like', 'Reply', 'Send message', 'Hide', '...'];
      for (let i = dotLineIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (actionWords.includes(line)) break;
        if (line === commentTime) continue;
        if (!commentText) {
          commentText = line;
        } else {
          commentText += " " + line;
        }
      }
    }

    // 兜底提取留言内容
    if (!commentText) {
      const contentEls = Array.from(container.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
      for (const el of contentEls) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        if (t === userName || t.includes('·') || t === '没有文字内容' || ['赞', '回复', '发消息', '隐藏', '...'].includes(t)) continue;
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

  function isHistoricalTime(timeStr) {
    if (!timeStr) return false;
    return ['天', '周', '月', '年', 'd', 'w', 'm', 'y'].some(unit => {
      const regex = new RegExp(`\\d+\\s*${unit}`, 'i');
      return regex.test(timeStr);
    });
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
  // 原生私信弹窗交互引擎 (高度强化点击与弹窗捕获)
  // ---------------------------------------------------------------------------

  async function performNativeDialogDm(sendMsgBtn, userName, dmText) {
    try {
      if (!sendMsgBtn) {
        return { success: false, statusText: "⚠️ 跳过：留言无【发消息】按钮" };
      }

      // 1. 关闭任何旧残留弹窗
      const existingDialog = document.querySelector('div[role="dialog"]');
      if (existingDialog) {
        closeDialog(existingDialog);
        await new Promise(r => setTimeout(r, 500));
      }

      // 2. 定位真实具备点击事件的按钮容器
      const targetBtn = sendMsgBtn.closest('[role="button"], a, button, [tabindex="0"]') || sendMsgBtn;

      // 滚动至屏幕居中
      targetBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 500));

      // 视觉高亮绿框提示用户（所见即所得）
      const originalOutline = targetBtn.style.outline;
      targetBtn.style.outline = '3px solid #10b981';
      setTimeout(() => { targetBtn.style.outline = originalOutline; }, 2500);

      console.log(`[Comments Manager Engine] 正在对 [${userName}] 执行【发消息】物理点击... 目标标签: ${targetBtn.tagName}`);

      // 3. 计算真实坐标派发完整事件
      const rect = targetBtn.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;

      const mouseOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: clientX,
        clientY: clientY,
        buttons: 1
      };

      const triggerClick = (el) => {
        el.focus();
        if (el.tagName === 'A') {
          el.removeAttribute('target');
          const hrefBackup = el.getAttribute('href');
          el.removeAttribute('href'); // 临时移除 href 杜绝原生导航跳转，完全交由 React 事件处理
          el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          el.dispatchEvent(new MouseEvent('click', mouseOpts));
          if (hrefBackup) setTimeout(() => { el.setAttribute('href', hrefBackup); }, 2000);
        } else {
          el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          el.dispatchEvent(new MouseEvent('click', mouseOpts));
          el.click();
        }
      };

      triggerClick(targetBtn);
      if (sendMsgBtn !== targetBtn) {
        triggerClick(sendMsgBtn);
      }

      // 4. 等待原生私信弹窗展开（最多 8 秒）
      const dialog = await waitForNativeDmDialog(8000);
      if (!dialog) {
        return {
          success: false,
          statusText: "❌ 发送失败：未弹出私信窗口 (网络延迟或受 FB 频率限制)"
        };
      }

      console.log("[Comments Manager Engine] 成功捕获原生私信弹窗！开始定位输入框...");

      // 5. 定位输入框
      const inputElem = findDialogInputField(dialog);
      if (!inputElem) {
        closeDialog(dialog);
        return {
          success: false,
          statusText: "❌ 发送失败：未定位到私信输入框"
        };
      }

      // 6. 注入私信文案
      await injectTextToInput(inputElem, dmText);
      await new Promise(r => setTimeout(r, 1000));

      // 7. 点击弹窗内的【发消息】发送按钮
      const sent = await clickDialogSendButton(dialog);
      if (!sent) {
        console.warn("[Comments Manager Engine] 未能点击到发送按钮，尝试回车键发送...");
        inputElem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }

      // 等待网络请求发送完成
      await new Promise(r => setTimeout(r, 2500));

      // 8. 关闭弹窗
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

  async function waitForNativeDmDialog(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // 方式 1: 标准 role="dialog" 容器
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]'));
      for (const d of dialogs) {
        if (!isVisible(d)) continue;
        const text = d.innerText || '';
        if (text.includes('发消息给') || text.includes('Send message to') || text.includes('Enviar mensagem para') || (text.includes('以') && text.includes('身份发消息'))) {
          return d;
        }
        const hasInput = d.querySelector('[contenteditable="true"], textarea');
        if (hasInput && isVisible(hasInput) && text.includes('发消息')) {
          return d;
        }
      }

      // 方式 2: 基于标题文本逆向寻找弹窗卡片容器
      const allTextNodes = Array.from(document.querySelectorAll('h1, h2, h3, h4, span, div')).filter(el => {
        if (el.children.length > 2) return false;
        const t = (el.innerText || '').trim();
        return t.startsWith('发消息给') || t.startsWith('Send message to') || t.startsWith('Enviar mensagem para');
      });
      if (allTextNodes.length > 0) {
        const h = allTextNodes[0];
        const modal = h.closest('div[role="dialog"]') || h.closest('div[aria-modal="true"]') || h.parentElement?.parentElement?.parentElement;
        if (modal && isVisible(modal)) {
          return modal;
        }
      }

      // 方式 3: 直接探测输入框反查弹窗
      const inputs = Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).filter(isVisible);
      for (const inp of inputs) {
        const p = inp.closest('div[role="dialog"]') || inp.closest('div[aria-modal="true"]') || inp.parentElement?.parentElement?.parentElement;
        if (p && (p.innerText || '').includes('发消息')) {
          return p;
        }
      }

      await new Promise(r => setTimeout(r, 400));
    }
    return null;
  }

  function findDialogInputField(dialog) {
    const selectors = [
      '[contenteditable="true"][aria-multiline="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'div[role="textbox"]',
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
    await new Promise(r => setTimeout(r, 300));

    // 尝试 1: document.execCommand (在输入框聚焦状态下最贴合原生输入)
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 300));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 2: ClipboardEvent (Paste)
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true
      });
      inputElem.dispatchEvent(pasteEvent);
      await new Promise(r => setTimeout(r, 300));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 3: TextEvent
    try {
      const textEvent = document.createEvent('TextEvent');
      textEvent.initTextEvent('textInput', true, true, window, text, 9, "en-US");
      inputElem.dispatchEvent(textEvent);
      await new Promise(r => setTimeout(r, 300));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 4: 暴力赋值 + Input 事件
    inputElem.innerText = text;
    inputElem.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    inputElem.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
  }

  async function clickDialogSendButton(dialog) {
    const sendKeywords = ['发消息', '发送消息', '发送', '發送', '發訊息', '傳送訊息', 'Send message', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message'];
    const allButtons = Array.from(dialog.querySelectorAll('div[role="button"], a[role="link"], button, span[role="button"]'));
    let sendBtn = null;

    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const txt = (btn.innerText || btn.textContent || '').trim();
      if (sendKeywords.some(kw => txt === kw || txt.includes(kw))) {
        // 必须排除“返回评论”、“返回”、“取消”
        if (txt.includes('返回') || txt.includes('Back') || txt.includes('取消') || txt.includes('Cancel')) continue;
        // 必须排除对话框顶部的标题“发消息给XXX”
        if (txt.includes('发消息给') || txt.includes('Send message to')) continue;
        sendBtn = btn;
        break;
      }
    }

    if (!sendBtn) {
      for (const btn of allButtons) {
        if (!isVisible(btn)) continue;
        const label = btn.getAttribute('aria-label') || '';
        if (sendKeywords.some(kw => label.includes(kw))) {
          if (label.includes('返回') || label.includes('发消息给')) continue;
          sendBtn = btn;
          break;
        }
      }
    }

    if (sendBtn) {
      console.log("[Comments Manager Engine] 准备点击私信弹窗中的发送按钮:", sendBtn.innerText || sendBtn.getAttribute('aria-label'));
      
      const isDisabled = sendBtn.getAttribute('aria-disabled') === 'true' || sendBtn.disabled || sendBtn.classList.contains('disabled');
      if (isDisabled) {
        console.warn("[Comments Manager Engine] 发送按钮处于禁用状态，等待 1 秒响应内容输入...");
        await new Promise(r => setTimeout(r, 1000));
      }

      sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      sendBtn.click();
      await new Promise(r => setTimeout(r, 600));
      return true;
    }
    return false;
  }

  function closeDialog(dialog) {
    const closeBtn = dialog.querySelector('div[aria-label="关闭"], div[aria-label="Close"], svg[aria-label="关闭"], button[aria-label="关闭"], div[role="button"][aria-label*="close" i]');
    if (closeBtn) {
      closeBtn.click();
    } else {
      const backBtn = Array.from(dialog.querySelectorAll('div[role="button"], span')).find(el => {
        const t = (el.innerText || '').trim();
        return t === '返回评论' || t === 'Back';
      });
      if (backBtn) backBtn.click();
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
