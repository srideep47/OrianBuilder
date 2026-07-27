import { atom } from "jotai";

// Atom to track if any dropdown is currently open in the UI
export const dropdownOpenAtom = atom<boolean>(false);

// The old nav-item-driven secondary panel is gone. Its replacement is
// space-driven and owns its own persisted state — see
// `shell/ContextPanel.tsx`'s `contextPanelOpenAtom`.

// Controls the in-page peer-list panel on the /network route.
// Toggled from the Peers view's own header, now that the nav rail no longer
// carries per-page controls.
export const isNetworkPeerListOpenAtom = atom<boolean>(true);
