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
  return s.includes('/posts/') || 
         s.includes('/videos/') || 
         s.includes('/reel/') || 
         s.includes('/share/p/') || 
         s.includes('/share/v/') || 
         s.includes('/share/r/') || 
         s.includes('permalink.php') || 
         s.includes('story.php') || 
         s.includes('photo.php?fbid=') || 
         s.includes('/photo/?fbid=') || 
         s.includes('/photos/') || 
         s.includes('pfbid');
}

function cleanFbUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, window.location.origin);
    const paramsToDelete = ['__cft__[0]', '__tn__', 'fbclid', 'ref', 'source', 'mibextid', 'rdid'];
    for (const p of paramsToDelete) {
      url.searchParams.delete(p);
    }
    return url.href;
  } catch (e) {
    return rawUrl;
  }
}

function extractPostUrl(actionBar) {
  // 1. 如果当前页面本身已经是单独的贴文详情页、Reel 或 视频页
  if (isPostPermalink(window.location.href) && !window.location.pathname.endsWith('/')) {
    const path = window.location.pathname;
    if (!path.includes('/professional_dashboard/') && 
        (path.includes('/posts/') || path.includes('/videos/') || path.includes('/reel/') || 
         path.includes('permalink.php') || path.includes('story.php') || path.includes('/share/'))) {
      return cleanFbUrl(window.location.href);
    }
  }

  // 2. 向上寻找贴文容器 (适配 FeedUnit, Timeline, role="article" 等多种容器)
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
    // 寻找贴文特征链接
    const links = Array.from(container.querySelectorAll('a[href]'));
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:')) continue;
      if (href.includes('comment_id=') || href.includes('/comments/')) continue;
      if (isPostPermalink(href)) {
        return cleanFbUrl(a.href);
      }
    }

    // 备用：检查包含时间文本的链接
    const timeLinks = links.filter(a => {
      const txt = (a.innerText || a.getAttribute('aria-label') || '').trim();
      return /\d+\s*(秒|分|小时|小時|天|周|週|月|年|s|m|h|d|w|y|hr|day|min|mins|剛剛|刚刚|昨天)/i.test(txt);
    });
    for (const a of timeLinks) {
      const href = a.getAttribute('href');
      if (href && href !== '#' && !href.startsWith('javascript:')) {
        return cleanFbUrl(a.href);
      }
    }
  }

  // ★ 核心修复：严禁将当前公共主页 URL 作为兜底返回！
  // 无法识别独立贴文链接时返回 null，彻底防止全页面所有按钮被同时误点亮
  return null;
}

async function toggleMonitorStatus(btn, postUrl) {
  if (!postUrl) {
    showToast('⚠️ 无法直接解析此贴文链接，请点击贴文发布时间进入单贴后加入监控', 'error');
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

    // 提取贴文链接
    const postUrl = extractPostUrl(btnElement);
    const isMonitored = postUrl ? monitoredUrls.some(u => postUrl.includes(u) || u.includes(postUrl)) : false;

    // 创建精致图标按钮
    const btn = document.createElement('div');
    btn.className = 'fb-auto-dm-btn ' + (isMonitored ? 'state-active' : 'state-idle');
    btn.title = isMonitored ? '✓ 取消监控' : '🌟 开启监控';
    
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL("assets/icon48.png");
    btn.appendChild(img);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const currentUrl = extractPostUrl(btnElement) || postUrl;
      toggleMonitorStatus(btn, currentUrl);
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
