import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  db,
  deleteRememberedName,
  rememberName,
  renameRememberedName,
  type HistoryItem,
  type ShoppingItem,
  type ShoppingList
} from "./db";

const MAX_SUGGESTIONS = 12;
type UndoAction = { message: string; restore: () => Promise<void> };
type AppRoute = {
  view: "overview" | "list" | "manager" | "suggestions";
  listId: number | null;
};

const overviewRoute: AppRoute = { view: "overview", listId: null };

function readRoute(state: unknown): AppRoute {
  if (!state || typeof state !== "object" || !("appRoute" in state)) return overviewRoute;
  const route = (state as { appRoute?: AppRoute }).appRoute;
  if (!route || !["overview", "list", "manager", "suggestions"].includes(route.view)) return overviewRoute;
  return route;
}

function useAppNavigation() {
  const [route, setRoute] = useState<AppRoute>(() => readRoute(window.history.state));

  useEffect(() => {
    if (!window.history.state?.appRoute) {
      window.history.replaceState({ appRoute: overviewRoute }, "");
    }
    const handlePopState = (event: PopStateEvent) => setRoute(readRoute(event.state));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigate(nextRoute: AppRoute) {
    window.history.pushState({ appRoute: nextRoute }, "");
    setRoute(nextRoute);
  }

  function replace(nextRoute: AppRoute) {
    window.history.replaceState({ appRoute: nextRoute }, "");
    setRoute(nextRoute);
  }

  return { route, navigate, replace };
}

function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
}

function UndoBar({ action, onUndo }: { action: UndoAction; onUndo: () => void }) {
  return (
    <div className="undo-bar" role="status">
      <span>{action.message}</span>
      <button className="undo-button" type="button" onClick={onUndo}>
        Rückgängig
      </button>
    </div>
  );
}

export default function App() {
  const { route, navigate, replace } = useAppNavigation();
  const [listToDelete, setListToDelete] = useState<ShoppingList | null>(null);
  const lists = useLiveQuery(() => db.lists.orderBy("sortOrder").toArray(), []);

  async function createList(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const lastList = await db.lists.orderBy("sortOrder").last();
    const id = await db.lists.add({
      name: trimmed,
      createdAt: Date.now(),
      sortOrder: (lastList?.sortOrder ?? -1) + 1
    });
    navigate({ view: "list", listId: id });
  }

  async function renameList(list: ShoppingList, name: string) {
    const trimmed = name.trim();
    if (!trimmed || list.id == null) return;
    await db.lists.update(list.id, { name: trimmed });
  }

  async function deleteList(list: ShoppingList) {
    if (list.id == null) return;
    await db.transaction("rw", db.lists, db.items, async () => {
      await db.items.where("listId").equals(list.id!).delete();
      await db.lists.delete(list.id!);
    });
    replace(overviewRoute);
    setListToDelete(null);
  }

  if (!lists) return <div className="app"><p className="empty">Lädt …</p></div>;
  if (route.view === "overview" || route.listId == null) {
    return <ListOverview lists={lists} onCreate={createList} onOpen={(id) => navigate({ view: "list", listId: id })} />;
  }

  const selectedList = lists.find((list) => list.id === route.listId);
  if (!selectedList) return null;
  return <>
    {route.view === "manager" ? (
      <ListManager list={selectedList} onRename={renameList} onDelete={() => setListToDelete(selectedList)} />
    ) : route.view === "suggestions" ? (
      <ShoppingListView list={selectedList} onOpenSuggestions={() => undefined} onOpenManager={() => navigate({ view: "manager", listId: selectedList.id! })} showSuggestions />
    ) : (
      <ShoppingListView list={selectedList} onOpenSuggestions={() => navigate({ view: "suggestions", listId: selectedList.id! })} onOpenManager={() => navigate({ view: "manager", listId: selectedList.id! })} />
    )}
    {listToDelete && (
      <DeleteDialog list={listToDelete} onCancel={() => setListToDelete(null)} onConfirm={deleteList} />
    )}
  </>;
}

function DeleteDialog({
  list,
  onCancel,
  onConfirm
}: {
  list: ShoppingList;
  onCancel: () => void;
  onConfirm: (list: ShoppingList) => Promise<void>;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
        <h2 id="delete-dialog-title">Liste löschen?</h2>
        <p>Möchtest du „{list.name}“ wirklich löschen?</p>
        <div className="dialog-actions">
          <button className="btn dialog-cancel" type="button" onClick={onCancel}>Abbrechen</button>
          <button className="btn dialog-confirm" type="button" onClick={() => void onConfirm(list)}>Liste löschen</button>
        </div>
      </section>
    </div>
  );
}

function ListOverview({
  lists,
  onCreate,
  onOpen
}: {
  lists: ShoppingList[];
  onCreate: (name: string) => Promise<void>;
  onOpen: (id: number) => void;
}) {
  const [newListName, setNewListName] = useState("");
  const [error, setError] = useState("");
  const sensors = useSortableSensors();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!newListName.trim()) {
      setError("Bitte gib der Liste einen Namen.");
      return;
    }
    setError("");
    await onCreate(newListName);
    setNewListName("");
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = lists.findIndex((list) => list.id === active.id);
    const newIndex = lists.findIndex((list) => list.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(lists, oldIndex, newIndex);
    await db.transaction("rw", db.lists, async () => {
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].sortOrder !== i) {
          await db.lists.update(reordered[i].id!, { sortOrder: i });
        }
      }
    });
  }

  return (
    <div className="app overview">
      <header className="overview-header">
        <p className="eyebrow">Dein Einkaufsraum</p>
        <h1>Welche Liste steht heute an?</h1>
      </header>
      <form className="new-list-form" onSubmit={submit}>
        <div className="new-list-input">
          <input className="input" type="text" placeholder="Name der neuen Liste" value={newListName} onChange={(event) => { setNewListName(event.target.value); setError(""); }} aria-invalid={Boolean(error)} />
          {error && <span className="form-error">{error}</span>}
        </div>
        <button className="btn btn-add" type="submit">Liste anlegen</button>
      </form>
      {lists.length === 0 ? (
        <section className="empty-overview">
          <strong>Noch keine Listen</strong>
          <p>Lege oben deine erste Einkaufsliste an.</p>
        </section>
      ) : (
        <section className="lists-section">
          <div className="section-heading">
            <h2>Deine Listen</h2>
            <span>{lists.length} {lists.length === 1 ? "Liste" : "Listen"}</span>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={lists.map((list) => list.id!)} strategy={verticalListSortingStrategy}>
              <ul className="lists-grid">
                {lists.map((list) => <ListCard key={list.id} list={list} onOpen={onOpen} />)}
              </ul>
            </SortableContext>
          </DndContext>
        </section>
      )}
    </div>
  );
}

function ListCard({ list, onOpen }: { list: ShoppingList; onOpen: (id: number) => void }) {
  const items = useLiveQuery(
    () => (list.id == null ? Promise.resolve([] as ShoppingItem[]) : db.items.where("listId").equals(list.id).toArray()),
    [list.id]
  );
  const itemCount = items?.length ?? 0;
  const doneCount = items?.filter((item) => item.done).length ?? 0;
  const progress = itemCount ? Math.round((doneCount / itemCount) * 100) : 0;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: list.id! });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  };

  return (
    <li ref={setNodeRef} style={style} className="list-card">
      <div
        className="list-card-open"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(list.id!)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onOpen(list.id!);
        }}
      >
        <button type="button" className="drag-handle list-drag-handle" aria-label="Liste verschieben" title="Zum Verschieben gedrückt halten" onClick={(event) => event.stopPropagation()} {...attributes} {...listeners}>⋮⋮</button>
        <span className="list-card-copy">
          <strong>{list.name}</strong>
          <small>{itemCount === 0 ? "Noch leer" : `${itemCount - doneCount} offen · ${doneCount} erledigt`}</small>
          <span className="list-card-progress" aria-label={`${progress} Prozent erledigt`}>
            <span style={{ width: `${progress}%` }} />
          </span>
        </span>
        <span className="list-card-arrow" aria-hidden="true">→</span>
      </div>
    </li>
  );
}

function ShoppingListView({ list, onOpenSuggestions, onOpenManager, showSuggestions = false }: { list: ShoppingList; onOpenSuggestions: () => void; onOpenManager: () => void; showSuggestions?: boolean }) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);

  const items = useLiveQuery(
    () => db.items.where("listId").equals(list.id!).sortBy("createdAt").then((result) => result.reverse()),
    [list.id]
  );

  const history = useLiveQuery(
    () => db.history.orderBy("sortOrder").toArray(),
    []
  );

  // Vorhandene Artikel einmalig in den Verlauf übernehmen.
  useEffect(() => {
    if (!items || !history || history.length > 0 || items.length === 0) return;
    (async () => {
      for (const item of items) await rememberName(item.name);
    })();
  }, [items, history]);

  useEffect(() => {
    if (!undoAction) return;
    const timeout = window.setTimeout(() => setUndoAction(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [undoAction]);

  useEffect(() => {
    if (!statusMessage) return;
    const timeout = window.setTimeout(() => setStatusMessage(""), 2500);
    return () => window.clearTimeout(timeout);
  }, [statusMessage]);

  const openItems = (items?.filter((item) => !item.done) ?? [])
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const doneItems = items?.filter((item) => item.done) ?? [];

  const sensors = useSortableSensors();

  const query = name.trim().toLowerCase();
  const openNames = new Set(openItems.map((item) => item.name.toLowerCase()));
  const suggestions = (history ?? [])
    .filter((entry) => !openNames.has(entry.name))
    .filter((entry) => !query || entry.name.includes(query))
    .slice(0, MAX_SUGGESTIONS);

  async function addNamed(itemName: string, itemQuantity: string) {
    const trimmed = itemName.trim();
    if (!trimmed) return;

    const maxOrder = openItems.length ? Math.max(...openItems.map((item) => item.sortOrder)) : -1;

    await db.items.add({
      listId: list.id!,
      name: trimmed,
      quantity: itemQuantity.trim(),
      done: false,
      createdAt: Date.now(),
      sortOrder: maxOrder + 1
    });
    await rememberName(trimmed);
    setStatusMessage("Artikel hinzugefügt");
  }

  async function addItem(event: React.FormEvent) {
    event.preventDefault();
    // Echten Feldinhalt lesen: mobile Tastaturen committen den letzten
    // (per Autokorrektur schwebenden) Text nicht immer in den React-State.
    const nameValue = nameRef.current?.value ?? name;
    const quantityValue = quantityRef.current?.value ?? quantity;
    await addNamed(nameValue, quantityValue);
    setName("");
    setQuantity("");
  }

  async function addFromSuggestion(displayName: string) {
    await addNamed(displayName, "");
  }

  async function addSuggestion(displayName: string) {
    const trimmed = displayName.trim();
    if (!trimmed) return;
    await rememberName(trimmed);
  }

  async function toggleItem(item: ShoppingItem) {
    if (item.id == null) return;
    await db.items.update(item.id, { done: !item.done });
  }

  async function deleteItem(item: ShoppingItem) {
    if (item.id == null) return;
    await db.items.delete(item.id);
    const { id: _id, ...itemToRestore } = item;
    setUndoAction({
      message: `„${item.name}“ gelöscht`,
      restore: async () => {
        await db.items.add(itemToRestore);
      }
    });
  }

  async function clearDone() {
    const deletedItems = [...doneItems];
    const ids = doneItems
      .map((item) => item.id)
      .filter((id): id is number => id != null);
    if (!ids.length) return;
    await db.items.bulkDelete(ids);
    setUndoAction({
      message: `${ids.length} erledigte ${ids.length === 1 ? "Position" : "Positionen"} gelöscht`,
      restore: async () => {
        await db.items.bulkAdd(deletedItems.map(({ id: _id, ...item }) => item));
      }
    });
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = openItems.findIndex((item) => item.id === active.id);
    const newIndex = openItems.findIndex((item) => item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(openItems, oldIndex, newIndex);
    await db.transaction("rw", db.items, async () => {
      for (let i = 0; i < reordered.length; i++) {
        const item = reordered[i];
        if (item.id != null && item.sortOrder !== i) {
          await db.items.update(item.id, { sortOrder: i });
        }
      }
    });
  }

  if (showSuggestions) {
    return (
      <SuggestionManager
        history={history ?? []}
        onAdd={addSuggestion}
        onRename={renameRememberedName}
        onDelete={deleteRememberedName}
      />
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-topline">
          <p className="eyebrow">Einkaufsliste</p>
          {items && (
            <span className="counter">
              {openItems.length} offen · {doneItems.length} erledigt
            </span>
          )}
        </div>
        <div className="list-title-row">
          <h1>{list.name}</h1>
          <button className="list-settings" type="button" onClick={onOpenManager} aria-label="Liste verwalten" title="Liste verwalten">⋯</button>
        </div>
      </header>

      <form className="add-form" onSubmit={addItem}>
        <div className="input-wrap input-wrap-name">
          <input
            className="input input-name"
            type="text"
            placeholder="Artikel, z. B. Milch"
            value={name}
            ref={nameRef}
            onChange={(event) => setName(event.target.value)}
          />
          {name && (
            <button
              type="button"
              className="btn-clear-input"
              onClick={() => setName("")}
              aria-label="Artikel-Eingabe leeren"
            >
              ✕
            </button>
          )}
        </div>
        <div className="input-wrap input-wrap-qty">
          <input
            className="input input-qty"
            type="text"
            placeholder="Menge, z. B. 2 kg"
            value={quantity}
            ref={quantityRef}
            onChange={(event) => setQuantity(event.target.value)}
          />
          {quantity && (
            <button
              type="button"
              className="btn-clear-input"
              onClick={() => setQuantity("")}
              aria-label="Mengen-Eingabe leeren"
            >
              ✕
            </button>
          )}
        </div>
        <div className="add-actions">
          <button className="btn btn-add" type="submit">
            Hinzufügen
          </button>
        </div>
      </form>

      <section className="suggestions">
        <div className="suggestions-heading">
          <span className="suggestions-label">Zuletzt verwendet</span>
          <div className="suggestions-heading-actions">
            <button className="suggestions-manage" type="button" onClick={onOpenSuggestions}>
            {suggestions.length > 0 ? "Bearbeiten" : "Verwalten"}
            </button>
          </div>
        </div>
        {suggestions.length > 0 && (
          <div className="suggestions-list">
            {suggestions.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className="chip"
                onClick={() => addFromSuggestion(entry.displayName)}
              >
                {entry.displayName}
              </button>
            ))}
          </div>
        )}
      </section>

      {!items ? (
        <p className="empty">Lädt …</p>
      ) : items.length === 0 ? (
        <p className="empty">Die Liste ist leer. Füge deinen ersten Artikel hinzu.</p>
      ) : (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={openItems.map((item) => item.id!)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="list">
                {openItems.map((item) => (
                  <SortableItem
                    key={item.id}
                    item={item}
                    onToggle={toggleItem}
                    onDelete={deleteItem}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          {doneItems.length > 0 && (
            <section className="done-section">
              <div className="done-header">
                <h2>Erledigt</h2>
                <div className="done-actions">
                  <button className="btn btn-toggle-done" type="button" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
                    {showDone ? "Ausblenden" : `${doneItems.length} anzeigen`}
                  </button>
                  {showDone && (
                    <button className="btn btn-clear" type="button" onClick={clearDone}>
                      Erledigte löschen
                    </button>
                  )}
                </div>
              </div>
              {showDone && (
                <ul className="list">
                  {doneItems.map((item) => (
                    <li key={item.id} className="item item-done">
                      <label className="item-main">
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={() => toggleItem(item)}
                        />
                        <span className="item-name">{item.name}</span>
                        {item.quantity && (
                          <span className="item-qty">{item.quantity}</span>
                        )}
                      </label>
                      <button
                        className="btn btn-delete"
                        type="button"
                        onClick={() => deleteItem(item)}
                        aria-label="Löschen"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
      {undoAction && <UndoBar action={undoAction} onUndo={() => { void undoAction.restore(); setUndoAction(null); }} />}
      {statusMessage && !undoAction && (
        <div className="status-bar" role="status">{statusMessage}</div>
      )}
    </div>
  );
}

function ListManager({ list, onRename, onDelete }: { list: ShoppingList; onRename: (list: ShoppingList, name: string) => Promise<void>; onDelete: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(list.name);

  return (
    <div className="app list-manager">
      <header className="manager-header">
        <div>
          <p className="eyebrow">Listenverwaltung</p>
          <h1>{list.name}</h1>
        </div>
      </header>
      <section className="manager-panel">
        <div className="manager-panel-heading">
          <div>
            <h2>Listenname</h2>
            <p>Der Name wird in deiner Listenübersicht angezeigt.</p>
          </div>
          {!isEditing && (
            <button className="btn btn-secondary" type="button" onClick={() => setIsEditing(true)}>Umbenennen</button>
          )}
        </div>
        {isEditing && (
          <form className="manager-edit-form" onSubmit={async (event) => { event.preventDefault(); await onRename(list, draftName); setIsEditing(false); }}>
            <input className="input" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
            <div className="manager-edit-actions">
              <button className="btn btn-secondary" type="button" onClick={() => { setDraftName(list.name); setIsEditing(false); }}>Abbrechen</button>
              <button className="btn btn-small" type="submit">Speichern</button>
            </div>
          </form>
        )}
      </section>
      <section className="manager-panel manager-danger-zone">
        <div>
          <h2>Liste löschen</h2>
          <p>Alle Artikel dieser Liste werden dauerhaft entfernt.</p>
        </div>
        <button className="btn btn-danger-outline" type="button" onClick={onDelete}>Liste löschen</button>
      </section>
    </div>
  );
}

function SuggestionManager({
  history,
  onAdd,
  onRename,
  onDelete
}: {
  history: HistoryItem[];
  onAdd: (name: string) => Promise<void>;
  onRename: (item: HistoryItem, name: string) => Promise<void>;
  onDelete: (item: HistoryItem) => Promise<void>;
}) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const sensors = useSortableSensors();

  useEffect(() => {
    if (!undoAction) return;
    const timeout = window.setTimeout(() => setUndoAction(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [undoAction]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Bitte gib einen Namen ein.");
      return;
    }
    if (history.some((item) => item.name === trimmed.toLowerCase())) {
      setError("Dieser Eintrag ist bereits vorhanden.");
      return;
    }
    await onAdd(trimmed);
    setNewName("");
    setError("");
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = history.findIndex((item) => item.name === active.id);
    const newIndex = history.findIndex((item) => item.name === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(history, oldIndex, newIndex);
    await db.transaction("rw", db.history, async () => {
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].sortOrder !== i) {
          await db.history.update(reordered[i].name, { sortOrder: i });
        }
      }
    });
  }

  async function deleteSuggestion(item: HistoryItem) {
    await onDelete(item);
    setUndoAction({
      message: `„${item.displayName}“ entfernt`,
      restore: async () => {
        await db.history.put(item);
      }
    });
  }

  return (
    <div className="app suggestion-manager">
      <header className="manager-header">
        <div>
          <p className="eyebrow">Einkaufsliste</p>
          <h1>Zuletzt verwendet</h1>
        </div>
      </header>
      <form className="suggestion-add-form" onSubmit={add}>
        <div className="new-list-input">
          <input className="input" type="text" placeholder="Neuer Artikel" value={newName} onChange={(event) => { setNewName(event.target.value); setError(""); }} aria-invalid={Boolean(error)} />
          {error && <span className="form-error">{error}</span>}
        </div>
        <button className="btn btn-add" type="submit">Hinzufügen</button>
      </form>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={history.map((item) => item.name)} strategy={verticalListSortingStrategy}>
          <ul className="suggestion-manager-list">
            {history.map((item) => <ManagedSuggestion key={item.name} item={item} onRename={onRename} onDelete={deleteSuggestion} />)}
          </ul>
        </SortableContext>
      </DndContext>
      {history.length === 0 && <p className="empty">Noch keine Einträge vorhanden.</p>}
      {undoAction && <UndoBar action={undoAction} onUndo={() => { void undoAction.restore(); setUndoAction(null); }} />}
    </div>
  );
}

function ManagedSuggestion({
  item,
  onRename,
  onDelete
}: {
  item: HistoryItem;
  onRename: (item: HistoryItem, name: string) => Promise<void>;
  onDelete: (item: HistoryItem) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(item.displayName);

  async function save() {
    if (!draftName.trim()) return;
    await onRename(item, draftName);
    setIsEditing(false);
  }

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: item.name });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  };

  return (
    <li ref={setNodeRef} style={style} className="managed-suggestion">
      {isEditing ? (
        <form className="managed-edit-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <input className="input" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          <button className="btn btn-small" type="submit">Speichern</button>
        </form>
      ) : (
        <>
          <button type="button" className="drag-handle suggestion-drag-handle" aria-label="Verschieben" title="Zum Verschieben gedrückt halten" {...attributes} {...listeners}>⋮⋮</button>
          <span className="managed-suggestion-name">{item.displayName}</span>
          <div className="managed-suggestion-actions">
            <button className="text-button" type="button" onClick={() => setIsEditing(true)} aria-label="Umbenennen" title="Umbenennen">✎</button>
            <button className="text-button text-button-danger" type="button" onClick={() => void onDelete(item)} aria-label="Entfernen" title="Entfernen">✕</button>
          </div>
        </>
      )}
    </li>
  );
}

function SortableItem({
  item,
  onToggle,
  onDelete
}: {
  item: ShoppingItem;
  onToggle: (item: ShoppingItem) => void;
  onDelete: (item: ShoppingItem) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: item.id! });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  };

  return (
    <li ref={setNodeRef} style={style} className="item">
      <button
        type="button"
        className="drag-handle"
        aria-label="Verschieben"
        title="Zum Verschieben gedrückt halten"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <label className="item-main">
        <input
          type="checkbox"
          checked={item.done}
          onChange={() => onToggle(item)}
        />
        <span className="item-name">{item.name}</span>
        {item.quantity && <span className="item-qty">{item.quantity}</span>}
      </label>
      <button
        className="btn btn-delete"
        type="button"
        onClick={() => onDelete(item)}
        aria-label="Löschen"
      >
        ✕
      </button>
    </li>
  );
}
