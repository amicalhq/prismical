import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import type { SlashMenuItem } from "./slash-menu-items";

export interface SlashMenuPopoverProps {
  items: SlashMenuItem[];
  command: (item: SlashMenuItem) => void;
}

export interface SlashMenuPopoverHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const SlashMenuPopover = forwardRef<
  SlashMenuPopoverHandle,
  SlashMenuPopoverProps
>(function SlashMenuPopover({ items, command }, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  function pick(i: number): void {
    const item = items[i];
    if (item) command(item);
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) return false;
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        pick(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return null;

  return (
    <div className="z-50 min-w-[220px] rounded-md border border-border bg-popover text-popover-foreground shadow-md p-1">
      <ul className="flex flex-col">
        {items.map((item, i) => (
          <li
            key={item.label}
            role="option"
            aria-selected={selectedIndex === i}
            className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${
              selectedIndex === i ? "bg-accent text-accent-foreground" : ""
            }`}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => pick(i)}
          >
            <span className="text-muted-foreground">{item.icon}</span>
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});
