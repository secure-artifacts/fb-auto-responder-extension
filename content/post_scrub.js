/**
 * FB 智能私信大师 - Post Scrub Content Script (V5.0 纯私信单页单线程架构)
 */

(async function () {
  console.log("FB Auto-Responder Post Scrub V5.0 Active.");

  const settings = await StorageUtil.getSettings();
  if (!settings.isRunning || settings.isPaused) return;

  // 放弃脆弱的 URL 字符串比对（脸书经常重定向链接导致匹配失败）
  // 直接读取后台调度引擎指派的模式
  const mode = settings.currentWorkerMode || 'target';

  if (mode === 'filler') {
    // 这是一个伪装链接，执行真人模拟浏览，然后退出
    await simulateHumanBrowsingAndFinish(settings);
    return;
  }

  // 这是一个真实的监控贴文，开始执行核心扫描循环
  startSingleRun(window.location.href);

  async function startSingleRun(targetUrl) {
    await StorageUtil.saveSettings({ statusMessage: `等待页面加载 (4秒)...` });
    await new Promise(r => setTimeout(r, 4000)); // 先等待 4 秒

    // 针对 Reels 或隐藏评论区的页面，自动点击评论按钮展开面板
    await ensureCommentsPanelOpen();

    await StorageUtil.saveSettings({ statusMessage: `等待评论区渲染 (4秒)...` });
    await new Promise(r => setTimeout(r, 4000)); // 再等待 4 秒确保渲染

    if (checkFacebookEmergencyBrake()) return;

    await ensureNewestCommentSorting();
    
    // 给重新排序留点时间
    await new Promise(r => setTimeout(r, 3000));

    const queue = await buildPriorityQueue();
    await StorageUtil.saveSettings({ statusMessage: `扫描完毕，待私信人数: ${queue.length}` });
    console.log(`[V5.0] 扫描完毕，待私信队列长度: ${queue.length}`);

    if (queue.length === 0) {
      await new Promise(r => setTimeout(r, 3000));
      finishPageAndNext();
      return;
    }

    await processQueue(queue, targetUrl);
  }

  function finishPageAndNext() {
    console.log("[V5.0] 当前页面处理完毕，通知 Service Worker 切换...");
    chrome.runtime.sendMessage({ action: "PAGE_FINISHED" });
  }

  async function simulateHumanBrowsingAndFinish(settings) {
    console.log("[V5.0] 当前为活跃账号伪装链接，模拟真人浏览...");
    
    // 读取设定的页面停留时间范围，默认 15 - 45 秒
    const minWait = settings.fillerWaitMin || 15;
    const maxWait = settings.fillerWaitMax || 45;
    const waitSeconds = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
    
    await StorageUtil.saveSettings({ statusMessage: `正在模拟真人浏览伪装页面，随机停留 ${waitSeconds} 秒...` });
    
    // 把总时间切分成几次随机动作（滑动、暂停）
    const actions = Math.floor(waitSeconds / 3); // 大约每3秒一个动作
    const intervalMs = (waitSeconds * 1000) / actions;

    for (let i = 0; i < actions; i++) {
      if (checkFacebookEmergencyBrake()) return;
      
      await new Promise(r => setTimeout(r, intervalMs));
      
      // 随机决定是向下滚、向上滚、还是原地看
      const actionType = Math.random();
      if (actionType < 0.6) {
        // 60%概率向下滚
        const scrollAmount = 200 + Math.random() * 800;
        window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      } else if (actionType < 0.8) {
        // 20%概率向上回看
        const scrollAmount = -(100 + Math.random() * 400);
        window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
      // 剩下20%概率原地不动看内容
    }

    finishPageAndNext();
  }

  async function buildPriorityQueue() {
    const settings = await StorageUtil.getSettings();
    const rules = await StorageUtil.getRules();
    const processedComments = await StorageUtil.getProcessedComments();
    const dmCooldownHours = settings.dmCooldownHours || 24;

    const nodes = getIndividualCommentNodes();
    let queue = [];

    let debugInfo = { total: nodes.length, author: 0, historical: 0, missingElem: 0, noKeyword: 0, cooldown: 0 };

    for (const node of nodes) {
      if (isPageAuthorComment(node)) { debugInfo.author++; continue; }
      
      // V5.0: 过滤超过24小时的留言
      if (isHistoricalComment(node) && !settings.includeHistory) {
        debugInfo.historical++; continue;
      }

      let commentText = "";
      let userName = "未知用户";
      let profileLink = "";

      // 混合解析方案：先尝试 DOM，失败则用 innerText 换行分析
      const textElem = node.querySelector('div[dir="auto"], span[lang]');
      // 过滤掉头像链接（头像链接没有 innerText），只保留有文字的链接
      const authorLinks = Array.from(node.querySelectorAll('a')).filter(a => {
        const txt = a.innerText ? a.innerText.trim() : "";
        // 名字通常大于1个字符
        return txt.length > 1 && a.href && !a.href.endsWith('#');
      });
      const authorLink = authorLinks.length > 0 ? authorLinks[0] : null;
      // 名字元素就是拥有文字的链接本身（或者是它内部的标签）
      const authorNameElem = authorLink;

      if (textElem && authorNameElem) {
        commentText = textElem.innerText ? textElem.innerText.trim() : "";
        userName = authorNameElem.innerText ? authorNameElem.innerText.trim() : "未知用户";
        profileLink = authorLink ? authorLink.href : "";
      } else {
        // Fallback: 基于文本行的解析
        const lines = (node.innerText || "").split('\n').map(s => s.trim()).filter(Boolean);
        let authorLineIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('·')) { authorLineIdx = i; break; }
        }
        if (authorLineIdx !== -1) {
          userName = lines[authorLineIdx].split('·')[0].trim();
          if (lines.length > authorLineIdx + 1) {
            commentText = lines[authorLineIdx + 1];
          }
        }
        if (authorLink) profileLink = authorLink.href;
      }

      if (!commentText) { debugInfo.missingElem++; continue; }

      const commentId = userName + "_" + commentText.substring(0, 30);
      if (processedComments.includes(commentId)) { debugInfo.cooldown++; continue; }

      const matchedObj = findMatchingRule(commentText, rules);
      if (!matchedObj) { debugInfo.noKeyword++; continue; }

      const userKey = "usr_" + userName;
      const inDmCooldown = await StorageUtil.isUserInDmCooldown(userKey, dmCooldownHours);
      if (inDmCooldown) { debugInfo.cooldown++; continue; }

      queue.push({
        node, userName, profileLink, commentText, commentId, userKey, matchedObj
      });
    }

    if (queue.length === 0) {
      await StorageUtil.addLog({
        userName: "🛠️ 诊断信息",
        postUrl: window.location.href,
        commentText: `节点数:${debugInfo.total} | 本人:${debugInfo.author} | 历史:${debugInfo.historical} | 缺元素:${debugInfo.missingElem} | 无词匹配:${debugInfo.noKeyword} | 已发冷却:${debugInfo.cooldown}`,
        matchedKeyword: "-",
        dmStatus: "队列为空，自动跳过",
        level: "warning"
      });
    }

    return queue;
  }

  async function processQueue(queue, targetUrl) {
    for (let i = 0; i < queue.length; i++) {
      const dmIntervalMs = (settings.dmIntervalSeconds || 10) * 1000 + Math.floor(Math.random() * 3000); // 随机附加 0~3 秒，防爬虫机制
      if (checkFacebookEmergencyBrake()) return;

      const currentSettings = await StorageUtil.getSettings();
      if (!currentSettings.isRunning || currentSettings.isPaused) return;

      const task = queue[i];
      await StorageUtil.saveSettings({ statusMessage: `正在私信 [${i + 1}/${queue.length}]: ${task.userName}...` });
      
      const dmTemplate = getRandomItem(task.matchedObj.rule.dmTemplates, task.userName);
      let dmSentSuccess = false;
      let dmStatus = "未配置私信";

      if (dmTemplate) {
        // 替换动态变量
        const firstName = task.userName.split(' ')[0];
        let finalDmText = dmTemplate
          .replace(/\[Name\]/ig, task.userName)
          .replace(/\[FullName\]/ig, task.userName)
          .replace(/\[FirstName\]/ig, firstName);
        
        dmSentSuccess = await performNativeDialogDm(task.node, task.userName, finalDmText);
        dmStatus = dmSentSuccess ? "✅ 私信发送成功" : "❌ 发送失败 (原生弹窗)";
      }

      // 记录状态
      await StorageUtil.markCommentProcessed(task.commentId);
      await StorageUtil.recordUserTouch(task.userKey, {
        userName: task.userName,
        dmSentSuccess: dmSentSuccess
      });

      // 更新统计数据
      const stats = currentSettings.stats || { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
      stats.totalProcessed += 1;
      if (dmSentSuccess) stats.totalDmSent += 1;
      else stats.totalErrors += 1;
      await StorageUtil.saveSettings({ stats });

      // 记录详细日志（带贴文链接和主页链接）
      await StorageUtil.addLog({
        userName: task.userName,
        postUrl: targetUrl,
        profileLink: task.profileLink,
        matchedKeyword: task.matchedObj.matchedKeyword,
        dmStatus: dmStatus,
        level: dmSentSuccess ? "info" : "error"
      });

      // 如果不是最后一个，等待自定义的间隔时间
      if (i < queue.length - 1) {
        await StorageUtil.saveSettings({ statusMessage: `等待 ${settings.dmIntervalSeconds} 秒后发送下一个...` });
        await new Promise(r => setTimeout(r, dmIntervalMs));
      }
    }

    // 整个队列处理完毕
    finishPageAndNext();
  }

  // =========================================================================
  // DOM 与核心注入交互逻辑
  // =========================================================================

  async function ensureNewestCommentSorting() {
    try {
      const sortButtons = Array.from(document.querySelectorAll('div[role="button"], span')).filter(el => {
        const txt = el.innerText ? el.innerText.trim() : '';
        return txt === '最相关' || txt === 'Most relevant' || txt === '所有留言' || txt === 'All comments';
      });
      if (sortButtons.length > 0) {
        // Facebook 的 DOM 层级较深，有时需点击上一级的 role="button"
        const btn = sortButtons[0].closest('div[role="button"]') || sortButtons[0];
        btn.click();
        await new Promise(r => setTimeout(r, 1200));

        // 查找下拉菜单里的选项，扩大选择器范围，并过滤不可见元素
        const menuItems = Array.from(document.querySelectorAll('div[role="menuitem"], div[role="option"], span'));
        const newestOption = menuItems.find(el => {
          if (!isVisible(el)) return false;
          const txt = el.innerText ? el.innerText.trim() : '';
          return txt.includes('由新到旧') || txt.includes('Newest') || txt.includes('最新');
        });
        
        if (newestOption) {
          const clickable = newestOption.closest('div[role="menuitem"]') || newestOption;
          clickable.click();
          console.log("✓ 已点击 [由新到旧] 排序选项");
        }
      }
    } catch (e) { 
      console.error("[V5.0] 自动切换最新留言排序失败:", e);
    }
  }

  function isVisible(elem) {
    if (!elem) return false;
    const style = window.getComputedStyle(elem);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = elem.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  async function ensureCommentsPanelOpen() {
    try {
      // 1. 严格判断面板是否已完全展开
      // 不再仅仅依赖"表单/输入框"来判断，必须看到"排序按钮"或者实质性的回复按钮
      const sortButtons = Array.from(document.querySelectorAll('div[role="button"], span')).filter(el => {
        const txt = el.innerText ? el.innerText.trim() : '';
        return ['最相关', 'Most relevant', '所有留言', 'All comments', 'Newest', '最新'].some(k => txt.includes(k));
      });
      // 检查是不是有很多评论已经被渲染出来了（比如页面上有多个 '回复'/'Reply' 文字）
      const replyTexts = Array.from(document.querySelectorAll('span, div')).filter(el => {
        const t = el.innerText ? el.innerText.trim() : '';
        return t === '回复' || t === 'Reply' || t === 'Responder';
      });

      if (sortButtons.length > 0 || replyTexts.length > 3) {
        return; // 已经展开
      }

      console.log("[V5.0] 未检测到完全开放的评论列表，尝试寻找并点击【评论】按钮以展开面板...");
      
      const normalizeStr = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const keywords = ['comment', '留言', '评论', 'coment', 'komentar'];
      
      // 提取所有包含 SVG 图像的潜在互动按钮（Reels 右侧的点赞/评论/分享按钮必带 SVG）
      const allClickables = Array.from(document.querySelectorAll('[aria-label], div[role="button"], span[role="button"], div[tabindex="0"]'))
        .filter(isVisible)
        .filter(el => el.querySelector('svg') || el.tagName.toLowerCase() === 'svg');
      
      let commentBtns = allClickables.filter(btn => {
        const ariaLabel = (btn.getAttribute('aria-label') || '');
        const textContent = (btn.textContent || '');
        const combinedStr = normalizeStr(ariaLabel + " " + textContent);
        
        if (!combinedStr.trim()) return false;
        if (!keywords.some(kw => combinedStr.includes(kw))) return false;
        if (combinedStr.includes('reply') || combinedStr.includes('回复') || combinedStr.includes('responder')) return false;
        if (combinedStr.includes('write') || combinedStr.includes('写') || combinedStr.includes('escreva')) return false;
        return true;
      });
      
      // 2. 拓扑结构推断 (降维打击：如果是无字天书，就找邻居)
      if (commentBtns.length === 0) {
        console.log("[V5.0] 文字特征未命中，启动结构拓扑推断 (寻找 Like / Share 的邻居)...");
        
        const isShareBtn = (el) => {
           const str = normalizeStr((el.getAttribute('aria-label') || '') + " " + (el.textContent || ''));
           return ['share', '分享', 'compartilhar', 'compartir'].some(k => str.includes(k));
        };
        const isLikeBtn = (el) => {
           const str = normalizeStr((el.getAttribute('aria-label') || '') + " " + (el.textContent || ''));
           return ['like', '赞', '讚', 'curtir', 'me gusta'].some(k => str.includes(k)) && !str.includes('comment') && !str.includes('share');
        };

        for (let i = 0; i < allClickables.length; i++) {
           if (isShareBtn(allClickables[i])) {
              let prev = allClickables[i - 1]; // 分享的上一个通常是评论
              if (prev && !isLikeBtn(prev)) {
                 commentBtns.push(prev);
                 console.log("[V5.0] 拓扑推断成功：通过 Share 按钮定位到其上方的邻居节点作为评论按钮");
                 break;
              }
           }
        }

        if (commentBtns.length === 0) {
           for (let i = 0; i < allClickables.length; i++) {
              if (isLikeBtn(allClickables[i])) {
                 let next = allClickables[i + 1]; // 点赞的下一个通常是评论
                 if (next && !isShareBtn(next)) {
                    commentBtns.push(next);
                    console.log("[V5.0] 拓扑推断成功：通过 Like 按钮定位到其下方的邻居节点作为评论按钮");
                    break;
                 }
              }
           }
        }
      }

      if (commentBtns.length > 0) {
        const targetBtn = commentBtns[0];
        
        // Facebook React 点击事件可能绑在父级或者子级上，所以我们全都触发一遍
        const simulateClick = (el) => {
          if (!el) return;
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.click();
        };

        simulateClick(targetBtn);
        if (targetBtn.firstElementChild) simulateClick(targetBtn.firstElementChild);
        if (targetBtn.parentElement) simulateClick(targetBtn.parentElement);
        
        console.log("[V5.0] 已深入点击目标评论按钮:", targetBtn.getAttribute('aria-label') || targetBtn.textContent.trim().substring(0, 20) || "SVG Icon");
      } else {
        console.warn("[V5.0] 未能在页面上找到任何符合特征的按钮，展开大概率失败。");
      }
    } catch(e) {
      console.error("[V5.0] 自动展开评论面板失败:", e);
    }
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

  function getIndividualCommentNodes() {
    let nodes = Array.from(document.querySelectorAll('div[role="article"], div[data-commentid]'));
    
    if (nodes.length === 0) {
      // 超强兼容模式：基于动作按钮逆向寻找容器
      const actionKeywords = ['回复', '回覆', 'Reply', 'Responder', 'Répondre', 'Balas', '发消息', '发送消息', '发讯息', '發訊息', '傳送訊息', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message', 'Kirim Pesan', 'Magpadala ng Mensahe'];
      const els = Array.from(document.querySelectorAll('div[role="button"], span, a, div'));
      const buttons = els.filter(el => {
        if (el.children.length > 2) return false;
        const txt = el.innerText ? el.innerText.trim() : '';
        return actionKeywords.some(k => txt === k || txt === k.toUpperCase());
      });
      
      const set = new Set();
      buttons.forEach(btn => {
        let p = btn.parentElement;
        for (let i = 0; i < 9; i++) {
          if (!p) break;
          // FB 评论内容区必然包含文字和时间标志（例如 "·"）
          if (p.innerText && p.innerText.includes('·') && p.innerText.length < 2000) {
             set.add(p);
          }
          p = p.parentElement;
        }
      });
      nodes = Array.from(set);
    }
    
    // DOM 拓扑过滤：滤除包含子节点的巨大容器，只保留最底层的独立评论块
    return nodes.filter(node => {
      if (nodes.some(other => other !== node && node.contains(other))) return false;
      if (node.querySelectorAll('div[role="article"]').length > 1) return false;
      return true;
    });
  }

  function isPageAuthorComment(node) {
    const text = node.innerText || "";
    if (text.includes("· 作者") || text.includes("· Author")) return true;
    const hasSendMsg = ['发消息', '发送消息', '发讯息', '發訊息', '傳送訊息', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message', 'Kirim Pesan', 'Magpadala ng Mensahe'].some(k => text.includes(k) || text.includes(k.toUpperCase()));
    const hasReply = ['回复', '回覆', 'Reply', 'Responder', 'Répondre', 'Balas'].some(k => text.includes(k) || text.includes(k.toUpperCase()));
    if (hasReply && !hasSendMsg) return true;
    return false;
  }

  function isHistoricalComment(node) {
    const lines = (node.innerText || "").split('\n').map(s => s.trim()).filter(Boolean);
    const authorLine = lines.find(l => l.includes('·'));
    if (authorLine) {
      const timePart = authorLine.split('·')[1] || "";
      return timePart.includes('天') || timePart.includes('周') || timePart.includes('d') || timePart.includes('w');
    }
    return false;
  }

  function findMatchingRule(commentText, rules) {
    const textLower = commentText.toLowerCase();
    for (const r of rules) {
      if (!r.keywords || r.keywords.length === 0) continue;
      for (const kw of r.keywords) {
        const kwLower = kw.trim().toLowerCase();
        if (!kwLower) continue;
        if (r.matchType === 'exact' ? textLower === kwLower : textLower.includes(kwLower)) {
          return { rule: r, matchedKeyword: kw };
        }
      }
    }
    return null;
  }

  function findButtonByText(container, keywords) {
    const els = Array.from(container.querySelectorAll('div[role="button"], a[role="link"], span[role="button"], span, a'));
    for (const el of els) {
      const txt = el.innerText ? el.innerText.trim() : '';
      if (keywords.some(k => txt === k || txt === k.toUpperCase() || txt.startsWith(k + ' '))) return el;
    }
    return null;
  }

  function findSendMessageBtn(node) {
    const keywords = ['发消息', '发送消息', '发讯息', '發訊息', '傳送訊息', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message', 'Kirim Pesan', 'Magpadala ng Mensahe'];
    const els = Array.from(node.querySelectorAll('div[role="button"], a[role="link"], span, a'));
    for (const el of els) {
      const txt = el.innerText ? el.innerText.trim() : '';
      if (keywords.includes(txt) || keywords.includes(txt.toUpperCase())) return el;
    }
    for (const el of els) {
      const label = el.getAttribute('aria-label') || '';
      if (keywords.some(k => label === k || label.includes(k + ' '))) return el;
    }
    const replyBtn = findButtonByText(node, ['回复', '回覆', 'Reply', 'Responder', 'Répondre', 'Balas']);
    if (replyBtn && replyBtn.parentElement) {
      const siblings = Array.from(replyBtn.parentElement.children);
      const idx = siblings.indexOf(replyBtn);
      for (let i = idx + 1; i < siblings.length; i++) {
        const txt = siblings[i].innerText ? siblings[i].innerText.trim() : '';
        if (keywords.some(k => txt === k)) return siblings[i];
      }
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getRandomItem(array, userName) {
    if (!array || array.length === 0) return null;
    const raw = array[Math.floor(Math.random() * array.length)];
    return raw ? raw.replace(/\{userName\}/g, userName) : null;
  }

  // =========================================================================
  // 核心私信动作：点击弹窗 -> 注入 -> 发送
  // =========================================================================
  async function performNativeDialogDm(commentNode, userName, dmText) {
    try {
      const sendMsgBtn = findSendMessageBtn(commentNode);
      if (!sendMsgBtn) {
        console.warn(`⚠️ 未找到 [发消息] 按钮: ${userName}`);
        return false;
      }

      // 关闭可能还开着的旧弹窗
      const existingDialog = document.querySelector('div[role="dialog"]');
      if (existingDialog) {
        closeDialog(existingDialog);
        await new Promise(r => setTimeout(r, 500));
      }

      // 避免点击时跳转新标签页影响脚本运行
      if (sendMsgBtn.tagName === 'A') {
        sendMsgBtn.removeAttribute('target');
        sendMsgBtn.removeAttribute('href'); // 彻底禁止原生跳转，依赖 React 事件
      }

      // 通过多重事件模拟真实人类点击，彻底激活 Facebook React 状态机
      sendMsgBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      sendMsgBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      sendMsgBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      const dialog = await waitForNativeDmDialog(5000);
      if (!dialog) return false;

      const inputElem = findDialogInputField(dialog);
      if (!inputElem) {
        closeDialog(dialog);
        return false;
      }

      await injectTextToInput(inputElem, dmText);

      // 给输入框一点时间响应内容变化
      await new Promise(r => setTimeout(r, 1000));
      
      const sent = await clickDialogSendButton(dialog);

      if (!sent) {
        // 如果没找到发送按钮，尝试回车键发送
        inputElem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }

      // 等待 2.5 秒确保网络请求发出去（FB 弹窗发消息通常不会自动关闭）
      await new Promise(r => setTimeout(r, 2500));
      
      const dialogStillOpen = document.contains(dialog) && isVisible(dialog);
      if (dialogStillOpen) {
        closeDialog(dialog);
      }
      
      return true;

    } catch (e) {
      console.error("performNativeDialogDm error:", e);
      return false;
    }
  }

  async function waitForNativeDmDialog(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      for (const d of dialogs) {
        if (!isVisible(d)) continue;
        const titleText = d.innerText || '';
        const titleKeys = ['发消息给', '发送消息给', '發訊息給', '傳送訊息給', 'Send message to', 'Enviar mensagem para', 'Enviar mensaje a', 'Envoyer un message à', 'Kirim pesan ke', 'Magpadala ng mensahe kay'];
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
      'textarea',
    ];
    for (const s of selectors) {
      const el = dialog.querySelector(s);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  async function injectTextToInput(inputElem, text) {
    // 强制获取焦点并激活 React 状态
    inputElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    inputElem.focus();
    inputElem.click();
    inputElem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    inputElem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    inputElem.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));

    inputElem.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));

    // 尝试 1: ClipboardEvent (Paste) - 对于保留 Facebook Lexical/Draft.js 中的换行符最有效
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

    // 尝试 2: document.execCommand (备选，可能会丢失换行符)
    try {
      inputElem.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 400));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 2: Clipboard Paste
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      inputElem.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      await new Promise(r => setTimeout(r, 400));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}

    // 尝试 3: TextEvent (备用注入)
    try {
      const textEvent = document.createEvent('TextEvent');
      textEvent.initTextEvent('textInput', true, true, window, text, 9, "en-US");
      inputElem.dispatchEvent(textEvent);
      await new Promise(r => setTimeout(r, 400));
      if (inputElem.textContent && inputElem.textContent.includes(text.substring(0, 5))) return;
    } catch (e) {}
    
    // 尝试 4: 暴力赋值 + Input 事件 (有时管用，但对 React 往往无效，作为最后手段)
    inputElem.innerText = text;
    inputElem.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    inputElem.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
  }

  async function clickDialogSendButton(dialog) {
    const sendKeywords = ['发消息', '发送消息', '发送', '發送', '發訊息', '傳送訊息', 'Send message', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message', 'Kirim Pesan', 'Magpadala ng Mensahe'];
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
      // 仅调用一次 click()，移除冗余的 dispatchEvent 避免 React 重复捕获导致发两条
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

})();
