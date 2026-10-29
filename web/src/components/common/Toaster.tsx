import { X } from 'lucide-react'
import { cx } from '../../lib/format'
import { dismissToast, useToasts } from '../../state/toast'
import styles from './Toaster.module.css'

/** The stack of transient messages, bottom-left above the call bar. */
export function Toaster({ inCall }: { inCall?: boolean }) {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div className={cx(styles.stack, inCall && styles.inCall)} role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={styles.toast} data-surface="call">
          <div className={styles.body}>
            {t.title && <div className={styles.title}>{t.title}</div>}
            <div className={styles.message}>{t.message}</div>
          </div>
          {t.actions && (
            <div className={styles.actions}>
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className={cx(styles.action, a.primary && styles.primary)}
                  onClick={() => {
                    a.onClick()
                    dismissToast(t.id)
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
          <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  )
}
