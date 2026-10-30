// 起動
import { App } from './app.js';

const app = new App();
window.kanade = app; // デバッグ用（開発者ツールから触れる）
app.init().catch((e) => {
  console.error(e);
  document.getElementById('status').textContent = '起動エラー：' + e.message;
});

// オフラインでも動くように（https か localhost のときだけ有効）
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker 登録失敗', e));
}
