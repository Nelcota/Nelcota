import Activity from "@lucide/svelte/icons/activity";
import Archive from "@lucide/svelte/icons/archive";
import Bell from "@lucide/svelte/icons/bell";
import Boxes from "@lucide/svelte/icons/boxes";
import Settings2 from "@lucide/svelte/icons/settings-2";

export const hostAreas = [
  { id: "projects", icon: Boxes },
  { id: "health", icon: Activity },
  { id: "backups", icon: Archive },
  { id: "settings", icon: Settings2 },
  { id: "alerts", icon: Bell },
] as const;
export type HostArea = (typeof hostAreas)[number]["id"];
