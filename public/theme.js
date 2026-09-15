// 首屏前应用主题，避免闪烁；index.html 与 share.html 共用
(() => {
  const safe = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  window.dropThemeCtl = {
    apply() {
      const theme = safe('drop-theme') || 'paper';
      const mode = safe('drop-mode') || 'auto';
      const dark =
        mode === 'dark' ||
        (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
      const root = document.documentElement;
      root.dataset.theme = theme;
      root.dataset.mode = dark ? 'dark' : 'light';
    },
  };
  window.dropThemeCtl.apply();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((safe('drop-mode') || 'auto') === 'auto') window.dropThemeCtl.apply();
  });
})();
