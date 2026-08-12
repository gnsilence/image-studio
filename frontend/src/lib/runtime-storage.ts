import { getDesktopBridge } from '@/lib/desktop-bridge';

export const runtimeStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem(key: string): string | null {
    const desktop = getDesktopBridge();
    return desktop ? desktop.config.get(key) : window.localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    const desktop = getDesktopBridge();
    if (desktop) desktop.config.set(key, value);
    else window.localStorage.setItem(key, value);
  },
  removeItem(key: string): void {
    const desktop = getDesktopBridge();
    if (desktop) desktop.config.remove(key);
    else window.localStorage.removeItem(key);
  },
};
