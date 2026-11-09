import { useEffect, useRef } from 'react';

/**
 * 通用确认弹窗：替代 window.confirm，统一交互与可访问性。
 * - 焦点陷阱：打开后聚焦确认按钮，Tab 在弹窗内循环，关闭后焦点归还触发元素
 * - Escape 关闭（等同「取消」）
 * - 点击背景关闭（等同「取消」）
 * - role="dialog" + aria-modal + aria-labelledby 语义
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useRef(`confirm-title-${Math.random().toString(36).slice(2)}`);

  // 焦点陷阱 + Escape 关闭
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const confirmBtn = confirmRef.current;
    // 打开后聚焦确认按钮
    confirmBtn?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      // 在弹窗内循环 Tab
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
      >
        <h2 id={titleId.current}>{title}</h2>
        <p className="muted">{message}</p>
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="mini" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`mini${danger ? ' danger' : ''}`}
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
