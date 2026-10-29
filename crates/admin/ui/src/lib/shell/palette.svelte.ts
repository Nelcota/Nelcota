// Opens/closes the command palette from anywhere (shortcut, topbar button).
export const palette = $state({ open: false });

/** Ctrl/Cmd+K toggles the palette. Lives here, not in the palette, so the palette's code can load on first use. */
export function handlePaletteShortcut(event: KeyboardEvent) {
  if (event.ctrlKey === false && event.metaKey === false) return;
  if (event.key.toLowerCase() !== "k") return;
  event.preventDefault();
  // Respect the active modal's focus and draft; never open a hidden palette.
  if (
    palette.open === false &&
    document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
  )
    return;
  palette.open = palette.open === false;
}
