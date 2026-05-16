import { atom } from "jotai";

// Atom to track if any dropdown is currently open in the UI
export const dropdownOpenAtom = atom<boolean>(false);

// Atom to track which sidebar panel is open (null = closed)
export type SidebarPanelItem = "Apps" | "Chat" | "Settings" | "Library" | null;
export const sidebarPanelAtom = atom<SidebarPanelItem>(null);
