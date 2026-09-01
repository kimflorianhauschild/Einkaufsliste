import Dexie, { type Table } from "dexie";

export interface ShoppingItem {
  id?: number;
  listId: number;
  name: string;
  quantity: string; // freie Mengenangabe, z. B. "2", "500 g", "1 Packung"
  done: boolean;
  createdAt: number;
  sortOrder: number; // Position offener Artikel (Drag & Drop)
}

export interface ShoppingList {
  id?: number;
  name: string;
  createdAt: number;
  sortOrder: number;
}

export interface HistoryItem {
  name: string; // Primärschlüssel (kleingeschrieben zum Vergleich)
  displayName: string; // Anzeigename in Originalschreibweise
  count: number; // wie oft hinzugefügt
  lastUsed: number;
  sortOrder: number;
}

export class ShoppingDB extends Dexie {
  items!: Table<ShoppingItem, number>;
  history!: Table<HistoryItem, string>;
  lists!: Table<ShoppingList, number>;

  constructor() {
    super("einkaufsliste");

    this.version(1).stores({
      items: "++id, done, createdAt"
    });

    this.version(2).stores({
      items: "++id, done, createdAt",
      history: "name, count, lastUsed"
    });

    this.version(3)
      .stores({
        items: "++id, done, createdAt, sortOrder",
        history: "name, count, lastUsed"
      })
      .upgrade(async (tx) => {
        const items = await tx.table("items").toArray();
        items.sort((a, b) => b.createdAt - a.createdAt);
        for (let i = 0; i < items.length; i++) {
          await tx.table("items").update(items[i].id, { sortOrder: i });
        }
      });

    this.version(4)
      .stores({
        items: "++id, listId, done, createdAt, sortOrder",
        history: "name, count, lastUsed",
        lists: "++id, createdAt"
      })
      .upgrade(async (tx) => {
        const listId = await tx.table("lists").add({
          name: "Meine Einkaufsliste",
          createdAt: Date.now()
        });
        const items = await tx.table("items").toArray();
        for (const item of items) {
          await tx.table("items").update(item.id, { listId });
        }
      });

    this.version(5)
      .stores({
        items: "++id, listId, done, createdAt, sortOrder",
        history: "name, count, lastUsed, sortOrder",
        lists: "++id, createdAt"
      })
      .upgrade(async (tx) => {
        const history = await tx.table("history").orderBy("lastUsed").reverse().toArray();
        for (let i = 0; i < history.length; i++) {
          await tx.table("history").update(history[i].name, { sortOrder: i });
        }
      });

    this.version(6)
      .stores({
        items: "++id, listId, done, createdAt, sortOrder",
        history: "name, count, lastUsed, sortOrder",
        lists: "++id, createdAt, sortOrder"
      })
      .upgrade(async (tx) => {
        const lists = await tx.table("lists").orderBy("createdAt").toArray();
        for (let i = 0; i < lists.length; i++) {
          await tx.table("lists").update(lists[i].id, { sortOrder: i });
        }
      });
  }
}

export const db = new ShoppingDB();

export async function rememberName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  await db.transaction("rw", db.history, async () => {
    const existing = await db.history.get(key);
    const lastItem = await db.history.orderBy("sortOrder").last();
    await db.history.put({
      name: key,
      displayName: trimmed,
      count: (existing?.count ?? 0) + 1,
      lastUsed: Date.now(),
      sortOrder: existing?.sortOrder ?? (lastItem?.sortOrder ?? -1) + 1
    });
  });
}

export async function renameRememberedName(item: HistoryItem, name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.toLowerCase() === item.name) return;
  const key = trimmed.toLowerCase();
  await db.transaction("rw", db.history, async () => {
    const existing = await db.history.get(key);
    await db.history.put({
      name: key,
      displayName: trimmed,
      count: item.count + (existing?.count ?? 0),
      lastUsed: Math.max(item.lastUsed, existing?.lastUsed ?? 0),
      sortOrder: item.sortOrder
    });
    await db.history.delete(item.name);
  });
}

export async function deleteRememberedName(item: HistoryItem) {
  await db.history.delete(item.name);
}
