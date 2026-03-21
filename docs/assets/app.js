(() => {
  // Tabs
  const tabs = document.querySelectorAll('.tab');
  const panels = {
    compose: document.getElementById('tab-compose'),
    run: document.getElementById('tab-run')
  };

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const key = btn.getAttribute('data-tab');
      Object.values(panels).forEach(p => p.classList.remove('active'));
      panels[key].classList.add('active');

      tabs.forEach(b => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
    });
  });

  // Theme toggle
  const root = document.documentElement;
  const btn = document.getElementById('themeToggle');
  const icon = document.getElementById('themeIcon');

  const STORAGE_KEY = 'theme-preference'; // 'light' | 'dark' | 'system'

  function systemPrefersDark(){
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme(mode){
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');

    const effectiveDark = (mode === 'dark') || (mode === 'system' && systemPrefersDark());
    if (icon) icon.textContent = effectiveDark ? '🌙' : '☀️';
    if (btn) btn.title = `切换主题（当前：${mode === 'system' ? '跟随系统' : (effectiveDark ? '深色' : '浅色')}）`;
  }

  function getSavedTheme(){
    return localStorage.getItem(STORAGE_KEY) || 'system';
  }

  function saveTheme(mode){
    localStorage.setItem(STORAGE_KEY, mode);
  }

  applyTheme(getSavedTheme());

  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', () => {
      if (getSavedTheme() === 'system') applyTheme('system');
    });
  } else if (mq && mq.addListener) {
    mq.addListener(() => {
      if (getSavedTheme() === 'system') applyTheme('system');
    });
  }

  if (btn) {
    btn.addEventListener('click', () => {
      const mode = getSavedTheme();
      const next = mode === 'system' ? 'light' : (mode === 'light' ? 'dark' : 'system');
      saveTheme(next);
      applyTheme(next);
    });
  }

  // Copy buttons for all code blocks
  function wrapPre(pre){
    if (pre.closest('.code-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';

    const head = document.createElement('div');
    head.className = 'code-head';

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.setAttribute('aria-label', '复制代码');

    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      const text = code ? code.innerText : pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1200);
      } catch (e) {
        btn.textContent = '复制失败';
        setTimeout(() => (btn.textContent = '复制'), 1200);
      }
    });

    head.appendChild(btn);

    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pre);
  }

  document.querySelectorAll('pre').forEach(wrapPre);
})();
