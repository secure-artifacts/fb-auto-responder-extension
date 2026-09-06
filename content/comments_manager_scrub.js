/**
 * FB 智能私信大师 - Comments Manager Content Script (v1.1.5)
 * 专为 Facebook 专业面板【评论管理工具】打造的集中式极速私信引擎
 * 页面地址: https://www.facebook.com/professional_dashboard/engagement/comments_manager/
 *
 * v1.1.4 架构改变：
 *   不再尝试在当前页面点击弹窗（Facebook React 18 会检查 event.isTrusted 拒绝机器操作）
 *   改为提取【发消息】按钮的 href (Messenger 会话链接)，交由后台在新标签页中
 *   通过 chrome.scripting.executeScript 直接在 Messenger 页面填写并发送私信。
 */

(async function () {
  // 仅在专业面板评论管理工具生效
  if (!window.location.pathname.includes('/comments_manager')) {
    return;
  }

  console.log("[Comments Manager Engine v1.1.5] 专业面板评论管理工具引擎已挂载！");

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
        // 当前首屏未发现，尝试微平滑滚动加载更多
        window.scrollBy({ top: 500, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 1500));
        rows = findCommentRows();
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

        // v1.1.4 核心改变：
        // 通过后台在新的 Messenger 标签页中发送私信，完全绕开 isTrusted 限制
        console.log(`[Comments Manager Engine] 通过 Messenger 标签页向 [${parsed.userName}] 发送私信...`);
        
        // 视觉高亮改为绿色（表示正在发送）
        if (rowItem.container) rowItem.container.style.boxShadow = '0 0 0 2px #10b981';
        
        const dmResult = await sendViaMessengerTab(parsed.messengerHref, parsed.userName, finalDmText);

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

  // ---------------------------------------------------------------------------
  // v1.1.4 核心：通过后台在新 Messenger 标签页发送私信，完全绕开 isTrusted 问题
  // ---------------------------------------------------------------------------

  function sendViaMessengerTab(messengerHref, userName, dmText) {
    return new Promise((resolve) => {
      // 如果没有有效的 Messenger 链接，返回失败
      if (!messengerHref || !messengerHref.includes('facebook.com/messages')) {
        console.warn("[Comments Manager Engine] 未找到有效的 Messenger 链接，跳过:", messengerHref);
        resolve({
          success: false,
          statusText: "⚠️ 跳过：未能从评论卡片提取到用户数字 ID（评论卡片可能尚未完全加载，或头像图片结构已更新）"
        });
        return;
      }

      const timeoutHandle = setTimeout(() => {
        resolve({ success: false, statusText: "❌ 发送超时：Messenger 标签页操作超时（60 秒未完成）" });
      }, 60000);

      chrome.runtime.sendMessage({
        action: "SEND_VIA_MESSENGER_TAB",
        messengerHref: messengerHref,
        userName: userName,
        dmText: dmText
      }, (response) => {
        clearTimeout(timeoutHandle);
        if (chrome.runtime.lastError) {
          resolve({ success: false, statusText: "❌ 通信异常: " + chrome.runtime.lastError.message });
          return;
        }
        if (response && response.success) {
          resolve({ success: true, statusText: "✅ 私信发送成功（Messenger 标签页方式）" });
        } else {
          resolve({ success: false, statusText: "❌ 发送失败: " + (response ? response.error : "未知错误") });
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // DOM 提取与解析辅助函数
  // ---------------------------------------------------------------------------

  function findCommentRows() {
    const sendKeywords = ['发消息', '发送消息', '发讯息', '發訊息', '傳送訊息', 'send message', 'message', 'enviar mensagem', 'enviar mensaje', 'envoyer un message'];
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

  /**
   * 从评论卡片中提取用户的 Facebook 数字 ID（10+ 位纯数字）
   * 策略（优先级从高到低）：
   *   1. 从 profile.php?id=XXXX URL 直接提取
   *   2. 从用户头像 <img src> 中提取（Facebook CDN URL 永远包含数字用户 ID，最可靠）
   *   3. 从 data-userid / data-id 等 HTML 属性提取
   *   4. 从 <a href="/messages/t/XXXX"> 提取（如果恰好存在）
   */
  function extractNumericFbId(container, profileLink) {
    // 方法 1: profile.php?id= 格式
    if (profileLink) {
      try {
        const url = new URL(profileLink);
        const idParam = url.searchParams.get('id');
        if (idParam && /^\d{8,}$/.test(idParam)) {
          console.log("[ID提取] 方法1 profile.php?id 成功:", idParam);
          return idParam;
        }
      } catch(e) {}
    }

    // 方法 2: 头像 <img> src 中的 Facebook CDN 数字 ID（最可靠！）
    // Facebook CDN URL 格式示例：
    //   https://scontent-xxx.fbcdn.net/v/t39.30808-1/...100028XXXXXXXX_1234.jpg...
    //   https://scontent.facebook.com/v/t1.6435-1/...p100x100/100028XXXXXXXX_...
    const imgs = Array.from(container.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.src || img.getAttribute('src') || '';
      if (!src || !src.includes('fbcdn')) continue;
      // 匹配路径中 10 位以上的纯数字段（用户数字 ID 通常是 15 位）
      const allMatches = [...src.matchAll(/[\/._-]?(\d{10,})[.\/]/g)];
      for (const m of allMatches) {
        const candidate = m[1];
        // 过滤掉时间戳（Unix timestamp 10 位，但用户 ID 通常从 10000 开头或更长）
        // Facebook 用户 ID 通常以 100 开头（10 位以上）
        if (candidate.length >= 12 || (candidate.length >= 10 && candidate.startsWith('100'))) {
          console.log("[ID提取] 方法2 avatar img src 成功:", candidate);
          return candidate;
        }
      }
    }

    // 方法 3: data-userid / data-id 等 HTML 属性
    for (const attr of ['data-userid', 'data-id', 'data-uid', 'data-profile-id']) {
      const el = container.querySelector('[' + attr + ']');
      if (el) {
        const val = el.getAttribute(attr);
        if (val && /^\d{8,}$/.test(val)) {
          console.log("[ID提取] 方法3 data属性成功:", val, "attr:", attr);
          return val;
        }
      }
    }

    // 方法 4: 容器内直接存在 messages href
    const msgA = container.querySelector('a[href*="/messages/t/"], a[href*="messenger.com/t/"]');
    if (msgA && msgA.href) {
      const parts = msgA.href.split('/t/');
      if (parts[1]) {
        const candidate = parts[1].split(/[/?#]/)[0].replace('p_', '');
        if (/^\d{8,}$/.test(candidate)) {
          console.log("[ID提取] 方法4 messages href 成功:", candidate);
          return candidate;
        }
      }
    }

    console.warn("[ID提取] 所有方法均未找到数字用户 ID");
    return null;
  }

  function parseCommentRow(rowObj) {
    const { container, sendBtn } = rowObj;

    let userName = "未知用户";
    let commentTime = "刚刚";
    let commentText = "";
    let profileLink = "";
    let postUrl = "";
    let messengerHref = "";

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

    // ★ v1.1.5: 提取数字用户 ID 并构造 Messenger 链接
    // Facebook 的【发消息】按钮没有 href 属性（纯 React onClick），
    // 所以我们从头像 img src 等来源提取数字 ID，自行构造 Messenger 会话 URL
    const numericFbId = extractNumericFbId(container, profileLink);
    if (numericFbId) {
      messengerHref = `https://www.facebook.com/messages/t/${numericFbId}`;
      console.log(`[Comments Manager Engine] 已构造 Messenger 链接: ${messengerHref}`);
    } else {
      console.warn("[Comments Manager Engine] ⚠️ 未能从评论卡片提取到数字用户 ID");
    }

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

    // 从 Messenger href 提取用户 ID 作为兜底
    if (!fbId && messengerHref) {
      try {
        const parts = new URL(messengerHref).pathname.split('/').filter(Boolean);
        // /messages/t/USERID
        const tIndex = parts.indexOf('t');
        if (tIndex !== -1 && parts[tIndex + 1]) fbId = parts[tIndex + 1];
      } catch (e) {}
    }

    let pageId = "";
    if (postUrl) {
      try {
        const u = new URL(postUrl);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length > 0 && !['reel', 'watch', 'groups', 'permalink.php'].includes(parts[0])) pageId = parts[0];
      } catch(e) {}
    }

    return { userName, commentTime, commentText, profileLink, postUrl, fbId, pageId, sendBtn, messengerHref };
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
