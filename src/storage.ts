// Saving the text size and reading places on this device (localStorage).
// Storage can be blocked or full; the app keeps working without it.

import { emptyMemory, parseMemory, type Memory } from "./logic/memory";

const KEY = "column-reader:v1";

export function loadMemory(): Memory {
  try {
    return parseMemory(localStorage.getItem(KEY));
  } catch {
    return emptyMemory();
  }
}

export function saveMemory(mem: Memory): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem));
    return true;
  } catch {
    return false;
  }
}
