import { useModalDialog } from "../hooks/useModalDialog";

export function IosInstallGuideDialog({ onClose }: { onClose: () => void }) {
  const dialogProps = useModalDialog(onClose);

  return (
    <dialog
      {...dialogProps}
      className="modal"
      aria-labelledby="ios-guide-title"
    >
      <div className="modal-card">
        <h3 id="ios-guide-title" className="modal-title">
          如何將網頁加入 iPhone 主畫面
        </h3>
        <div className="modal-body">
          <div className="ios-step-item">
            <span className="ios-step-num">1</span>
            <div>
              點擊<strong>「分享」按鈕</strong>（方框向上箭頭）：Safari
              在畫面底部工具列，Chrome、Edge 在網址列最右側
            </div>
          </div>
          <div className="ios-step-item">
            <span className="ios-step-num">2</span>
            <div>
              在選單中滑動並點選<strong>「加入主畫面」</strong>
            </div>
          </div>
          <div className="ios-step-item">
            <span className="ios-step-num">3</span>
            <div>
              點擊右上角<strong>「新增」</strong>完成安裝，即可接收推播提醒。
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onClose}
          >
            我知道了
          </button>
        </div>
      </div>
    </dialog>
  );
}
