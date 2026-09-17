import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./contracts.ts";

export type JournalEvent = {
  at: string;
  type: string;
  state?: string;
  detail?: Record<string, unknown>;
};

export const appendJournal = (path: string, event: JournalEvent): void => {
  ensureDir(join(path, ".."));
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
};

export const readJournal = (path: string): JournalEvent[] => {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const events: JournalEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as JournalEvent;
      if (value && typeof value.type === "string") events.push(value);
    } catch {
      // A truncated final JSONL line is discarded; prior events remain authoritative.
    }
  }
  return events;
};

export type SnapshotStore<T> = {
  path: string;
  read(): T;
  write(value: T): void;
};

export const snapshotStore = <T>(path: string, fallback: () => T): SnapshotStore<T> => ({
  path,
  read: () => (existsSync(path) ? readJson<T>(path) : fallback()),
  write: (value) => writeJsonAtomic(path, value),
});
