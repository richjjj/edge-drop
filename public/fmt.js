'use strict';

// 展示用格式化工具；app.js 与 share.js 共用
window.dropFmt = (() => {
  function formatSize(bytes = 0) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }

  // 过去时间点的相对描述："刚刚" / "5 分钟前" / 日期
  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const day = Math.floor(hour / 24);
    if (day < 7) return `${day} 天前`;
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  // 距未来时间点的剩余时长："不到 1 分钟" / "45 分钟" / "3 小时" / "6 天"
  function untilTime(ts) {
    const diff = (ts || 0) - Date.now();
    if (diff <= 60000) return '不到 1 分钟';
    const min = Math.ceil(diff / 60000);
    if (min < 60) return `${min} 分钟`;
    const hour = Math.round(min / 60);
    if (hour < 48) return `${hour} 小时`;
    return `${Math.round(hour / 24)} 天`;
  }

  // 有效期选项（秒）对应的文案，与后端 TTL_OPTIONS 一致
  const TTL_LABELS = { 600: '10 分钟', 3600: '1 小时', 86400: '1 天', 604800: '7 天' };
  function ttlLabel(sec) {
    return TTL_LABELS[sec] || `${sec} 秒`;
  }

  return { formatSize, relTime, untilTime, ttlLabel };
})();
