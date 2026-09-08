/**
 * FB 智能私信大师 - UI 注入模块
 * 在贴文底部（互动区）自动注入“一键加入监控”按钮
 */

let toastTimer = null;

function showToast(message, type = 'success') {
  let toast = document.getElementById('fb-auto-dm-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fb-auto-dm-toast';
    toast.className = 'fb-auto-dm-toast';
    document.body.appendChild(toast);
  }
  
  toast.textContent = message;
  toast.style.backgroundColor = type === 'success' ? '#2e7d32' : '#c62828';
  toast.classList.add('show');
  
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function isPostPermalink(url) {
  if (!url) return false;
  const s = url.toLowerCase();
  // 必须严格拒绝 profile.php 相关链接 (无论是 profile.php# 还是 profile.php?)
  if (s.includes('profile.php')) return false;

  return s.includes('/posts/') || 
         s.includes('/videos/') || 
         s.includes('/watch') ||
         s.includes('/reel/') || 
         s.includes('/share/p/') || 
         s.includes('/share/v/') || 
         s.includes('/share/r/') || 
         s.includes('permalink.php') || 
         s.includes('story.php') || 
         s.includes('photo.php?fbid=') || 
         s.includes('/photo/?fbid=') || 
         s.includes('/photo?fbid=') || 
         s.includes('/photos/') || 
         s.includes('pfbid');
}

function cleanFbUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, window.location.origin);
    // 严格剔除 profile.php
    if (url.pathname.includes('profile.php')) return null;

    const paramsToDelete = [
      '__cft__[0]', '__tn__', 'fbclid', 'ref', 'source', 'mibextid', 'rdid',
      'comment_id', 'reply_comment_id', 'notif_id', 'notif_t', 'refid', 'paipv', 'locale'
    ];
    for (const p of paramsToDelete) {
      url.searchParams.delete(p);
    }
    url.hash = ''; // 剥离任何 #?hdf 等占位 hash
    return url.href;
  } catch (e) {
    return rawUrl;
  }
}

/**
 * 触发 Facebook Comet 深度链接水合
 * 通过模拟原生事件促使 React / CometLink 将 profile.php# 替换为真实的直达链接
 */
function hydrateLink(element) {
  if (!element) return;
  const events = [
    new PointerEvent('pointerover', { bubbles: true, cancelable: true, view: window }),
    new PointerEvent('pointerenter', { bubbles: false, cancelable: true, view: window }),
    new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }),
    new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }),
    new FocusEvent('focusin', { bubbles: true, cancelable: true, view: window }),
    new FocusEvent('focus', { bubbles: false, cancelable: true, view: window }),
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window })
  ];
  for (const ev of events) {
    try { element.dispatchEvent(ev); } catch (e) {}
  }
  const children = Array.from(element.querySelectorAll('*'));
  for (const child of children) {
    for (const ev of events) {
      try { child.dispatchEvent(ev); } catch (e) {}
    }
  }
}

/**
 * 在贴文容器内寻找时间戳链接元素（排除评论区）
 */
function findTimestampAnchor(container) {
  if (!container) return null;

  const links = Array.from(container.querySelectorAll('a[href]')).filter(a => {
    // 严苛排除评论区、回复区、输入框、已注入按钮内部
    if (a.closest('ul') || a.closest('form')) return false;
    if (a.closest('div[role="article"] div[role="article"]')) return false;
    if (a.closest('.fb-auto-dm-btn')) return false;

    const txt = (a.innerText || a.getAttribute('aria-label') || '').trim();
    return /\d+\s*(秒|分|小时|小時|天|周|週|月|年|s|m|h|d|w|y|hr|day|min|mins|剛剛|刚刚|昨天)/i.test(txt) ||
           /(\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日/.test(txt) ||
           /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}/i.test(txt);
  });

  return links[0] || null;
}

/**
 * 在贴文容器内寻找已有真实直达链接 (Reel, Video, Photo, Posts, pfbid 等，排除评论区)
 */
function findValidPostLinkInContainer(container) {
  if (!container) return null;

  const allLinks = Array.from(container.querySelectorAll('a[href]'));
  const postLinks = allLinks.filter(a => {
    if (a.closest('ul') || a.closest('form')) return false;
    if (a.closest('div[role="article"] div[role="article"]')) return false;
    if (a.closest('.fb-auto-dm-btn')) return false;
    return true;
  });

  for (const a of postLinks) {
    const rawHref = a.getAttribute('href') || '';
    if (!rawHref || rawHref === '#' || rawHref.startsWith('javascript:')) continue;
    if (rawHref.includes('profile.php')) continue;

    const fullUrl = a.href || '';
    if (isPostPermalink(fullUrl)) {
      const cleaned = cleanFbUrl(fullUrl);
      if (cleaned && isPostPermalink(cleaned)) {
        return cleaned;
      }
    }
  }

  return null;
}

/**
 * 智能解析贴文直达真实 URL (多阶段水合与容错校验)
 */
async function resolvePostUrl(btnElement, postContainer) {
  // 1. 如果当前页面本身已经是单独的贴文详情页、Reel、Photo 或 视频页
  const curUrl = window.location.href;
  const curPath = window.location.pathname;
  if (!curPath.includes('/professional_dashboard/') && isPostPermalink(curUrl)) {
    return cleanFbUrl(curUrl);
  }

  const container = postContainer || getPostContainer(btnElement);
  if (!container) return null;

  // 2. 检查容器内现有的真实直达链接 (Photo, Video, Reel, Posts, pfbid 等)
  const validLink = findValidPostLinkInContainer(container);
  if (validLink) {
    return validLink;
  }

  // 3. 寻找时间戳链接并进行 Facebook Comet 深度水合 (Hydration)
  const timeAnchor = findTimestampAnchor(container);
  if (timeAnchor) {
    hydrateLink(timeAnchor);

    if (isPostPermalink(timeAnchor.href)) {
      const cleaned = cleanFbUrl(timeAnchor.href);
      if (cleaned && isPostPermalink(cleaned)) return cleaned;
    }

    // 等待 120ms 供 Comet 渲染或写入 href
    await new Promise(r => setTimeout(r, 120));

    if (isPostPermalink(timeAnchor.href)) {
      const cleaned = cleanFbUrl(timeAnchor.href);
      if (cleaned && isPostPermalink(cleaned)) return cleaned;
    }

    // 二次尝试水合
    hydrateLink(timeAnchor);
    await new Promise(r => setTimeout(r, 80));

    if (isPostPermalink(timeAnchor.href)) {
      const cleaned = cleanFbUrl(timeAnchor.href);
      if (cleaned && isPostPermalink(cleaned)) return cleaned;
    }
  }

  // 4. 再次扫描容器
  const finalCheck = findValidPostLinkInContainer(container);
  if (finalCheck) {
    return finalCheck;
  }

  // 坚决返回 null，彻底杜绝 profile.php# 占位链接
  return null;
}

function extractPostUrl(actionBar) {
  // 同步初筛接口（供 inject 初始状态判断）
  const curUrl = window.location.href;
  const curPath = window.location.pathname;
  if (!curPath.includes('/professional_dashboard/') && isPostPermalink(curUrl)) {
    return cleanFbUrl(curUrl);
  }

  let container = actionBar.closest('div[role="article"], div[data-pagelet^="FeedUnit"], div[data-pagelet*="Timeline"], div[data-pagelet*="ProfileTimeline"], div[data-pagelet*="feed"], div[role="feed"] > div');
  if (!container) {
    container = actionBar.parentElement;
    for (let i = 0; i < 8; i++) {
      if (container && container.parentElement && container.parentElement !== document.body) {
        container = container.parentElement;
        if (container.getAttribute('data-pagelet') || container.getAttribute('role') === 'article') break;
      }
    }
  }

  if (container) {
    const validLink = findValidPostLinkInContainer(container);
    if (validLink) return validLink;

    const timeAnchor = findTimestampAnchor(container);
    if (timeAnchor && isPostPermalink(timeAnchor.href)) {
      return cleanFbUrl(timeAnchor.href);
    }
  }

  return null;
}

async function toggleMonitorStatus(btn, postUrl, container) {
  if (!postUrl) {
    // 尝试高亮时间戳元素，引导用户一键点击单贴添加
    const timeAnchor = container ? findTimestampAnchor(container) : null;
    if (timeAnchor) {
      timeAnchor.style.outline = '3px solid #1877f2';
      timeAnchor.style.borderRadius = '4px';
      timeAnchor.style.transition = 'outline 0.3s ease';
      setTimeout(() => {
        timeAnchor.style.outline = '';
      }, 3000);
      showToast('💡 已标出贴文发布时间，请点击进入单贴后一键加入监控', 'error');
    } else {
      showToast('⚠️ 无法直接解析此贴文链接，请点击贴文发布时间进入单贴后加入监控', 'error');
    }
    return;
  }
  try {
    const settings = await StorageUtil.getSettings();
    let urls = settings.targetUrls || [];
    const isAlreadyMonitored = urls.some(u => u === postUrl || postUrl.includes(u) || u.includes(postUrl));
    
    if (isAlreadyMonitored) {
      // 取消监控
      urls = urls.filter(u => u !== postUrl && !u.includes(postUrl) && !postUrl.includes(u));
      await StorageUtil.saveSettings({ targetUrls: urls });
      
      btn.classList.remove('state-active');
      btn.classList.add('state-idle');
      btn.title = '🌟 开启监控';
      showToast('❌ 已取消监控该贴文');
    } else {
      // 加入监控
      urls.push(postUrl);
      await StorageUtil.saveSettings({ targetUrls: urls });
      
      btn.classList.remove('state-idle');
      btn.classList.add('state-active');
      btn.title = '✓ 取消监控';
      showToast('✅ 已成功加入智能监控队列！');
    }
  } catch (err) {
    console.error("操作失败", err);
    showToast('操作失败，请重试', 'error');
  }
}

function getPostContainer(btn) {
  let c = btn.closest('div[role="article"]') || 
          btn.closest('div[data-pagelet^="FeedUnit"]') ||
          btn.closest('div[data-pagelet*="Reel"]') ||
          btn.closest('div[aria-label*="Reel"]');
  if (!c) {
    c = btn.parentElement;
    for (let i = 0; i < 6; i++) {
      if (c && c.parentElement && c.parentElement !== document.body) {
        c = c.parentElement;
      }
    }
  }
  return c;
}

function getBestTargetButton(container) {
  const share = container.querySelector('div[role="button"][aria-label*="分享"], div[role="button"][aria-label*="Share"], div[role="button"][aria-label*="发送"], div[role="button"][aria-label*="Send"]');
  if (share) return share;

  const comment = container.querySelector('div[role="button"][aria-label*="留言"], div[role="button"][aria-label*="Comment"], div[role="button"][aria-label*="评论"]');
  if (comment) return comment;

  const like = container.querySelector('div[role="button"][aria-label*="赞"], div[role="button"][aria-label*="Like"], div[role="button"][aria-label*="讚"]');
  if (like) return like;

  return null;
}

async function injectButtons() {
  // 如果短视频已经被点击点开（进入 Reels 沉浸式详情页），则不需要显示监控按钮
  if (window.location.pathname.includes('/reel/')) {
    return;
  }

  const settings = await StorageUtil.getSettings();
  const monitoredUrls = settings.targetUrls || [];

  const ariaKeywords = [
    '赞', 'Like', '讚', 
    '留言', 'Comment', '评论',
    '分享', 'Share', '发送', 'Send'
  ];
  
  const selectors = ariaKeywords.map(k => `div[role="button"][aria-label^="${k}"], div[role="button"][aria-label*="${k}"]`).join(', ');
  const candidateButtons = document.querySelectorAll(selectors);

  candidateButtons.forEach(btnElement => {
    if (!btnElement) return;
    
    // 严苛排除：评论区、回复区、发评论输入框
    if (btnElement.closest('form') || 
        btnElement.closest('ul') || 
        btnElement.closest('div[role="article"] div[role="article"]')) {
      return;
    }

    // 向上穿透寻找真正的横向按钮排列栏 (跳过只有1个子元素的单按钮包装层)
    let actionBar = btnElement.parentElement;
    while (actionBar && actionBar !== document.body && actionBar.children.length === 1) {
      actionBar = actionBar.parentElement;
    }

    if (!actionBar || actionBar.hasAttribute('data-dm-injected')) return;

    // 向上寻找一个较大的共同容器（整个贴文），确保一篇贴文里绝对只加一个蓝按钮
    const postContainer = btnElement.closest('div[role="article"]') || btnElement.closest('div[data-pagelet]') || actionBar.parentElement;
    if (postContainer && postContainer.querySelector('.fb-auto-dm-btn')) return;

    // 标记当前贴文互动栏
    actionBar.setAttribute('data-dm-injected', 'true');

    // 尝试对贴文时间戳链接进行预防水合
    const timeAnchor = findTimestampAnchor(postContainer);
    if (timeAnchor) hydrateLink(timeAnchor);

    // 提取贴文链接 (初筛)
    const postUrl = extractPostUrl(btnElement);
    const isMonitored = postUrl ? monitoredUrls.some(u => postUrl.includes(u) || u.includes(postUrl)) : false;

    // 创建精致图标按钮
    const btn = document.createElement('div');
    btn.className = 'fb-auto-dm-btn ' + (isMonitored ? 'state-active' : 'state-idle');
    btn.title = isMonitored ? '✓ 取消监控' : '🌟 开启监控';
    
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL("assets/icon48.png");
    btn.appendChild(img);

    // 鼠标悬停到按钮时立即执行前置水合，为点击争取充分的 React 渲染时间
    btn.addEventListener('mouseenter', () => {
      const c = getPostContainer(btnElement) || postContainer;
      if (c) {
        const a = findTimestampAnchor(c);
        if (a) hydrateLink(a);
      }
    });

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const currentUrl = await resolvePostUrl(btnElement, postContainer);
      toggleMonitorStatus(btn, currentUrl, postContainer);
    });

    // 针对时间线贴文，恢复横向 Flex 排版以修复按钮与“查看更多评论”文本重叠的问题
    try {
      actionBar.style.setProperty('display', 'flex', 'important');
      actionBar.style.setProperty('flex-direction', 'row', 'important');
      actionBar.style.setProperty('flex-wrap', 'nowrap', 'important');
      actionBar.style.setProperty('align-items', 'center', 'important');
    } catch (e) {}

    // 挂载到互动栏末尾
    actionBar.appendChild(btn);
  });
}

// 持续监听页面变化（无限滚动）
const observer = new MutationObserver(() => {
  injectButtons();
});

observer.observe(document.body, { childList: true, subtree: true });

// 初始执行
setTimeout(injectButtons, 2000);
