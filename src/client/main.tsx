import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // 註冊失敗（腳本載入失敗為 TypeError，瀏覽器拒絕為 DOMException）不影響排隊功能，其他錯誤照常拋出。
      if (error instanceof TypeError || error instanceof DOMException) {
        return;
      }
      throw error;
    });
  });
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
