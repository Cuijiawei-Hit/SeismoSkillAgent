/* GitHub Pages reads the same saved example as the downloadable Python app.
 * No credentials, LLM calls or engineering execution are used by this preview. */
(() => {
  'use strict';
  const originFetch = window.fetch.bind(window);
  const base = new URL('./', document.currentScript.src);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return originFetch(input, options);
    const method = options.method || (typeof input === 'object' && input.method) || 'GET';
    if (method !== 'GET') return new Response(JSON.stringify({error:'Download the local platform and configure your own API to create tasks.'}), {status:403,headers:{'Content-Type':'application/json'}});
    const lang = url.searchParams.get('language') === 'zh-CN' ? 'zh' : 'en';
    let file;
    if (url.pathname === '/api/health') file = 'health.json';
    else if (url.pathname === '/api/sessions') file = `sessions.${lang}.json`;
    else if (url.pathname === '/api/power-case') file = 'power-case.json';
    else if (url.pathname === '/api/sessions/demo-auckland') file = `session.${lang}.json`;
    else if (url.pathname === '/api/sessions/demo-auckland/power-scene') file = 'scene.json';
    else if (url.pathname === '/api/sessions/demo-auckland/reference-figures') file = `figures.${lang}.json`;
    if (!file) return new Response(JSON.stringify({error:'This action is available in the local download.'}), {status:404,headers:{'Content-Type':'application/json'}});
    return originFetch(new URL('example/' + file, base), {cache:'default'});
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('submit-task')?.addEventListener('click', event => {
      event.preventDefault(); event.stopImmediatePropagation();
      location.href = new URL('../#usage', base).href;
    }, true);
  });
})();
