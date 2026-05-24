import { atom } from "jotai";

// Atom to track if any dropdown is currently open in the UI
export const dropdownOpenAtom = atom<boolean>(false);

// Atom to track which sidebar panel is open (null = closed)
export type SidebarPanelItem =
  | "Apps"
  | "Chat"
  | "Settings"
  | "Library"
  | "Gen Assets"
  | null;
export const sidebarPanelAtom = atom<SidebarPanelItem>(null);

// Controls the in-page peer-list panel on the /network route.
// Toggled from AppSidebar's Network button so users can close/open it
// without an extra in-page toggle.
export const isNetworkPeerListOpenAtom = atom<boolean>(true);
