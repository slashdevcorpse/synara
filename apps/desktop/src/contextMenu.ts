// FILE: contextMenu.ts
// Purpose: Normalizes renderer context-menu requests and builds safe Electron menu templates.
// Layer: Desktop main-process helpers

import type { ContextMenuItem } from "@synara/contracts";
import type { MenuItemConstructorOptions } from "electron";

export interface NormalizedContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly separatorBefore: boolean;
  readonly destructive: boolean;
  readonly disabled: boolean;
}

export function normalizeContextMenuItems(
  items: readonly ContextMenuItem[],
): readonly NormalizedContextMenuItem[] {
  return items
    .filter((item) => typeof item.id === "string" && typeof item.label === "string")
    .map((item) => ({
      id: item.id,
      label: item.label,
      separatorBefore: item.separatorBefore === true,
      destructive: item.destructive === true,
      disabled: item.disabled === true,
    }));
}

export function buildContextMenuTemplate(input: {
  readonly items: readonly NormalizedContextMenuItem[];
  readonly onSelect: (id: string) => void;
  readonly getDestructiveIcon?: () => MenuItemConstructorOptions["icon"] | undefined;
}): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  let hasInsertedDestructiveSeparator = false;

  for (const item of input.items) {
    const shouldInsertSeparator =
      item.separatorBefore ||
      (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0);
    if (shouldInsertSeparator && template.length > 0) {
      template.push({ type: "separator" });
    }
    if (item.destructive) {
      hasInsertedDestructiveSeparator = true;
    }

    const itemOption: MenuItemConstructorOptions = {
      label: item.label,
      enabled: !item.disabled,
      click: () => {
        if (!item.disabled) {
          input.onSelect(item.id);
        }
      },
    };
    if (item.destructive) {
      const destructiveIcon = input.getDestructiveIcon?.();
      if (destructiveIcon) {
        itemOption.icon = destructiveIcon;
      }
    }
    template.push(itemOption);
  }

  return template;
}
