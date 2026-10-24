// jsdom 沒有實作 HTMLDialogElement.showModal() 與 close()；這裡只模擬「開／關」的狀態，
// 不模擬 top layer、focus 管理與 Escape 觸發 cancel，這些行為要靠瀏覽器驗證。
// 測試用 node 環境時沒有 HTMLDialogElement，直接略過。
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) {
      return;
    }
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
