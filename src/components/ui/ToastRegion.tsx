import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
}

interface ToastContextValue {
  pushToast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const value = useMemo<ToastContextValue>(() => ({
    pushToast(message) {
      const id = Date.now();
      setToasts((current) => [...current, { id, message }]);
      window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4500);
    },
  }), []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => <div className="toast" key={toast.id}>{toast.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return context;
}
