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

function cleanFbUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, window.location.origin);
    url.searchParams.delete('__cft__[0]');
    url.searchParams.delete('__tn__');
    url.searchParams.delete('fbclid');
    return url.href;
  } catch (e) {
    return rawUrl;
  }
}

function extractPostUrl(actionBar) {
  // 1. 如果当前页面已经是单独的 Reel 或 视频页
  if (window.location.href.includes('/reel/') || window.location.href.includes('/videos/')) {
    // 检查是否是主页信息流中的弹出框，如果是单页直接返回
    return cleanFbUrl(window.location.href);
  }

  // 2. 向上寻找贴文容器 (通常是 role="article" 或者是某个较大的容器)
  let container = actionBar.closest('div[role="article"]');
  if (!container) {
    // 如果没有 role="article"（有些 Reels 或新版 UI 没有），尝试向上找包含发帖人信息的块
    container = actionBar.parentElement;
    for (let i = 0; i < 8; i++) {
      if (container && container.parentElement) container = container.parentElement;
    }
  }

  if (container) {
    // 寻找时间戳链接，通常包含 posts, videos, permalink, story
    const links = Array.from(container.querySelectorAll('a[href]'));
    for (let a of links) {
      const href = a.getAttribute('href');
      if (!href || href === '#') continue;
      if (href.includes('/posts/') || 
          href.includes('/videos/') || 
          href.includes('/reel/') || 
          href.includes('permalink.php') || 
          href.includes('story.php')) {
        
        // 排除掉一些无关的分享或回复链接
        if (href.includes('comment_id=')) continue;

        return cleanFbUrl(a.href);
      }
    }
  }

  // 兜底：如果实在找不到，就用当前页面的 URL
  return cleanFbUrl(window.location.href);
}

async function toggleMonitorStatus(btn, postUrl) {
  try {
    const settings = await StorageUtil.getSettings();
    let urls = settings.targetUrls || [];
    const isActive = btn.classList.contains('state-active');
    
    if (isActive) {
      // 取消监控
      urls = urls.filter(u => u !== postUrl);
      await StorageUtil.saveSettings({ targetUrls: urls });
      
      btn.classList.remove('state-active');
      btn.classList.add('state-idle');
      btn.title = '🌟 开启监控';
      showToast('❌ 已取消监控该贴文');
    } else {
      // 加入监控
      if (!urls.includes(postUrl)) {
        urls.push(postUrl);
        await StorageUtil.saveSettings({ targetUrls: urls });
      }
      
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

async function injectButtons() {
  const settings = await StorageUtil.getSettings();
  const monitoredUrls = settings.targetUrls || [];

  // 寻找能够定位“互动区”的锚点
  const shareButtons = new Set();
  
  // 1. 通过 aria-label 查找 (包含赞、评论、分享的各种语言)
  const ariaLabels = [
    '分享', 'Share', '发送给朋友', 'Send to friends', '傳送', '发送', 'Send',
    '赞', 'Like', '讚', 
    '留言', 'Comment', '评论'
  ];
  const selectors = ariaLabels.map(label => `[aria-label^="${label}"]`).join(', ');
  const ariaNodes = document.querySelectorAll(selectors);
  ariaNodes.forEach(node => shareButtons.add(node));

  // 2. 查找所有的 SVG 图标按钮 (兜底 Facebook 纯图标无 aria-label 的情况)
  const svgs = document.querySelectorAll('div[role="button"] svg');
  svgs.forEach(svg => {
    shareButtons.add(svg.closest('div[role="button"]'));
  });

  const processedBars = new Set();

  shareButtons.forEach(shareBtn => {
    if (!shareBtn) return;
    
    // 找到包含该元素的真正的按钮容器
    const actualButton = shareBtn.closest('div[role="button"]') || shareBtn;
    
    // 找到互动栏的 flex 父容器
    const actionBar = actualButton.parentElement;
    if (!actionBar || actionBar.hasAttribute('data-dm-injected') || processedBars.has(actionBar)) return;

    // 严苛过滤：确保它是主贴文的互动栏，而不是评论区的回复栏
    // 特征 1: 必须包含多个子元素 (赞、评论、分享通常是连在一起的)
    if (actionBar.children.length < 2) return;
    
    // 特征 2: 主互动栏的按钮通常包含 SVG 图标，而评论区的“赞·回复”通常是纯文本
    const hasSvg = actionBar.querySelector('svg');
    if (!hasSvg) return;

    // 标记为已处理
    processedBars.add(actionBar);
    actionBar.setAttribute('data-dm-injected', 'true');

    // 提取 URL
    const postUrl = extractPostUrl(actionBar);
    if (!postUrl) return;

    const isMonitored = monitoredUrls.some(u => postUrl.includes(u) || u.includes(postUrl));

    // 创建精致的 Icon 按钮
    const btn = document.createElement('div');
    btn.className = 'fb-auto-dm-btn ' + (isMonitored ? 'state-active' : 'state-idle');
    btn.title = isMonitored ? '✓ 取消监控' : '🌟 开启监控';
    
    // 使用插件的 Logo 作为图标
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL("assets/icon48.png");
    btn.appendChild(img);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleMonitorStatus(btn, postUrl);
    });

    // 插入到 Flex 容器末尾
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
