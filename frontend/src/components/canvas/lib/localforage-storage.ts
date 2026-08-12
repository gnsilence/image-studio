import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { getDesktopBridge } from "@/lib/desktop-bridge";

localforage.config({
  name: "nova-image",
  storeName: "canvas_app_state",
});

export const localForageStorage: StateStorage = {
  getItem: async (name) => {
    if (typeof window === "undefined") return null;
    const desktop = getDesktopBridge();
    if (desktop) return desktop.records.get<string>('canvas-state', name);
    try {
      return (await localforage.getItem<string>(name)) || null;
    } catch {
      return window.localStorage.getItem(name);
    }
  },
  setItem: async (name, value) => {
    if (typeof window === "undefined") return;
    const desktop = getDesktopBridge();
    if (desktop) {
      await desktop.records.put('canvas-state', name, value);
      return;
    }
    try {
      await localforage.setItem(name, value);
    } catch {
      window.localStorage.setItem(name, value);
    }
  },
  removeItem: async (name) => {
    if (typeof window === "undefined") return;
    const desktop = getDesktopBridge();
    if (desktop) {
      await desktop.records.delete('canvas-state', name);
      return;
    }
    try {
      await localforage.removeItem(name);
    } catch {
      window.localStorage.removeItem(name);
    }
  },
};
