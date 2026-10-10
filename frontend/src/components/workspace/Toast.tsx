'use client';

import { useEffect } from 'react';
import { CheckCircle, XCircle, X, Info } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface ToastData {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

// The icon chip and a tinted edge carry the tone; the message itself stays readable foreground text.
const toneClass: Record<ToastData['type'], { border: string; icon: string }> = {
  success: { border: 'border-success/30', icon: 'bg-success/12 text-success' },
  info: { border: 'border-sky-500/30', icon: 'bg-sky-500/12 text-sky-600 dark:text-sky-400' },
  error: { border: 'border-destructive/30', icon: 'bg-destructive/12 text-destructive' },
};

export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastData;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 3000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const Icon = toast.type === 'success' ? CheckCircle : toast.type === 'info' ? Info : XCircle;
  const tone = toneClass[toast.type];

  return createPortal(
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      className={cn(
        'nova-float nova-toast fixed bottom-4 right-4 z-[10000] flex max-w-sm items-center gap-2.5 rounded-2xl py-2.5 pl-2.5 pr-3 text-sm',
        tone.border,
      )}
    >
      <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', tone.icon)}>
        <Icon className="size-4" />
      </span>
      <span className="flex-1 leading-5">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-70 transition-[opacity,background-color] hover:bg-muted hover:opacity-100"
        aria-label="关闭通知"
      >
        <X className="size-3.5" />
      </button>
    </div>,
    document.body,
  );
}
