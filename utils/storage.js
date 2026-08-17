/**
 * FB 智能私信大师 - 本地存储封装 (V5.0 纯私信单签页架构)
 */

const DEFAULT_SETTINGS = {
  isRunning: false,
  isPaused: false,
  targetUrls: [],
  activeUrls: [
    "https://www.facebook.com/",
    "https://www.facebook.com/reels",
    "https://www.facebook.com/events"
  ],
  globalCooldownHours: 24,
  dmCooldownHours: 24, // 私信专属 24 小时冷却
  dmIntervalSeconds: 10, // 连续发私信的时间间隔
  switchIntervalSeconds: 15, // 页面停留与切换间隔（秒）
  fillerWaitMin: 15, // 伪装页面最短停留时间（秒）
  fillerWaitMax: 45, // 伪装页面最长停留时间（秒）
  emergencyBrakeEnabled: true,
  emergencyBrakeReason: "",
  statusMessage: "系统就绪，等待启动任务...",
  stats: {
    totalProcessed: 0,
    totalDmSent: 0,
    totalErrors: 0
  }
};

const DEFAULT_RULES = [
  {
    id: "default_rule_1",
    name: "通用关键词触发",
    matchType: "contains",
    keywords: ["Amen", "Amém", "领用", "资料", "价格", "想了解"],
    dmTemplates: [
      "Hi {userName}，非常感谢您的留言！这是您需要的专属资料链接，请查收：https://example.com/info",
      "你好 {userName}！已收到您的需求，小帮手已将详细内容发到您的私信中咯~"
    ]
  }
];

const StorageUtil = {
  async getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['settings'], (res) => {
        resolve({ ...DEFAULT_SETTINGS, ...(res.settings || {}) });
      });
    });
  },

  async saveSettings(newSettings) {
    const current = await this.getSettings();
    const updated = { ...current, ...newSettings };
    return new Promise((resolve) => {
      chrome.storage.local.set({ settings: updated }, () => resolve(updated));
    });
  },

  async getRules() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['rules'], (res) => {
        resolve(res.rules || DEFAULT_RULES);
      });
    });
  },

  async saveRules(rules) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ rules }, () => resolve(rules));
    });
  },

  async getUserHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['userHistory'], (res) => {
        resolve(res.userHistory || {});
      });
    });
  },

  /**
   * 记录某个用户的触达记录
   */
  async recordUserTouch(userKey, record) {
    const history = await this.getUserHistory();
    const current = history[userKey] || {};

    history[userKey] = {
      ...current,
      ...record,
      lastTriggerTime: Date.now(),
      lastDmTime: record.dmSentSuccess ? Date.now() : (current.lastDmTime || 0)
    };

    return new Promise((resolve) => {
      chrome.storage.local.set({ userHistory: history }, () => resolve(history));
    });
  },

  async clearUserHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ userHistory: {}, processedComments: [] }, () => resolve({}));
    });
  },

  /**
   * 私信专属 24 小时冷却检测
   */
  async isUserInDmCooldown(userKey, dmCooldownHours) {
    if (dmCooldownHours <= 0) return false; // 0 小时代表测试模式禁用冷却

    const history = await this.getUserHistory();
    const userRec = history[userKey];
    if (!userRec || !userRec.lastDmTime) return false;

    const elapsedMs = Date.now() - userRec.lastDmTime;
    const cooldownMs = dmCooldownHours * 60 * 60 * 1000;
    return elapsedMs < cooldownMs;
  },

  async getProcessedComments() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['processedComments'], (res) => {
        resolve(res.processedComments || []);
      });
    });
  },

  async markCommentProcessed(commentId) {
    const list = await this.getProcessedComments();
    if (!list.includes(commentId)) {
      list.push(commentId);
      if (list.length > 5000) list.shift();
      return new Promise((resolve) => {
        chrome.storage.local.set({ processedComments: list }, () => resolve(list));
      });
    }
  },

  async getLogs() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['logs'], (res) => {
        resolve(res.logs || []);
      });
    });
  },

  async addLog(logEntry) {
    const logs = await this.getLogs();
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    const item = {
      id: "log_" + Date.now() + "_" + Math.floor(Math.random()*1000),
      timestamp: timeStr,
      userName: logEntry.userName || "未知用户",
      postUrl: logEntry.postUrl || "",
      profileLink: logEntry.profileLink || "",
      commentText: logEntry.commentText || "",
      matchedKeyword: logEntry.matchedKeyword || "-",
      dmStatus: logEntry.dmStatus || "未发送",
      level: logEntry.level || "info"
    };

    logs.unshift(item);
    if (logs.length > 1000) logs.pop();

    return new Promise((resolve) => {
      chrome.storage.local.set({ logs }, () => resolve(item));
    });
  },

  async clearLogs() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ logs: [] }, () => resolve([]));
    });
  }
};

// 兼容 Service Worker (无 window) 与 content script / popup (有 window) 两种环境
if (typeof globalThis !== 'undefined') {
  globalThis.StorageUtil = StorageUtil;
}
if (typeof window !== 'undefined') {
  window.StorageUtil = StorageUtil;
}
