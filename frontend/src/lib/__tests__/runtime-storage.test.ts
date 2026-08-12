import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeStorage } from '@/lib/runtime-storage';
import type { NovaDesktopBridge } from '@/lib/desktop-bridge';

afterEach(() => {
  delete window.novaDesktop;
  localStorage.clear();
});

describe('runtimeStorage', () => {
  it('uses browser localStorage when the desktop bridge is absent', () => {
    runtimeStorage.setItem('theme', 'dark');
    expect(runtimeStorage.getItem('theme')).toBe('dark');
    runtimeStorage.removeItem('theme');
    expect(runtimeStorage.getItem('theme')).toBeNull();
  });

  it('uses the synchronous desktop config bridge when present', () => {
    const values = new Map<string, string>();
    const config = {
      get: vi.fn((key: string) => values.get(key) ?? null),
      set: vi.fn((key: string, value: string) => { values.set(key, value); }),
      remove: vi.fn((key: string) => { values.delete(key); }),
    };
    window.novaDesktop = { platform: 'win32', config } as unknown as NovaDesktopBridge;

    runtimeStorage.setItem('theme', 'light');
    expect(runtimeStorage.getItem('theme')).toBe('light');
    runtimeStorage.removeItem('theme');
    expect(config.set).toHaveBeenCalledWith('theme', 'light');
    expect(config.remove).toHaveBeenCalledWith('theme');
  });
});
