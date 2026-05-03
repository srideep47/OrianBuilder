import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API = "http://localhost:3001/api";

interface Item {
  id: number;
  name: string;
  created_at: string;
}

async function fetchItems(): Promise<Item[]> {
  const res = await fetch(`${API}/items`);
  if (!res.ok) throw new Error("Failed to fetch items");
  return res.json();
}

async function createItem(name: string): Promise<Item> {
  const res = await fetch(`${API}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to create item");
  return res.json();
}

async function deleteItem(id: number): Promise<void> {
  const res = await fetch(`${API}/items/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete item");
}

export function useItems() {
  return useQuery({ queryKey: ["items"], queryFn: fetchItems });
}

export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createItem,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }),
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteItem,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }),
  });
}
