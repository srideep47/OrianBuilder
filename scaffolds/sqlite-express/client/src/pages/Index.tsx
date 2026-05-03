import { useState } from "react";
import { useItems, useCreateItem, useDeleteItem } from "../hooks/useItems";

export default function IndexPage() {
  const { data: items, isLoading, error } = useItems();
  const createItem = useCreateItem();
  const deleteItem = useDeleteItem();
  const [name, setName] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createItem.mutateAsync(name.trim());
    setName("");
  };

  return (
    <main className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-lg mx-auto px-4 space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">
            SQLite + Express App
          </h1>
          <p className="mt-2 text-gray-500">
            Edit{" "}
            <code className="bg-gray-100 px-1 rounded font-mono text-sm">
              client/src/pages/Index.tsx
            </code>{" "}
            to get started.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New item name..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={createItem.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {createItem.isPending ? "Adding…" : "Add"}
          </button>
        </form>

        {isLoading && <p className="text-center text-gray-400">Loading…</p>}
        {error && (
          <p className="text-center text-red-500">Error: {String(error)}</p>
        )}

        <ul className="space-y-2">
          {items?.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3"
            >
              <span className="text-gray-800">{item.name}</span>
              <button
                onClick={() => deleteItem.mutate(item.id)}
                className="text-red-400 hover:text-red-600 text-sm transition-colors"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
