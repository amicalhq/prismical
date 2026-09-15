import type { Doc } from "yjs";

const deliveries = new WeakMap<Doc, () => Promise<void>>();

export function registerNoteDelivery(doc: Doc, deliver: () => Promise<void>): () => void {
  deliveries.set(doc, deliver);
  return () => { deliveries.delete(doc); };
}

export async function waitForNoteDelivery(doc: Doc): Promise<void> {
  const deliver = deliveries.get(doc);
  if (!deliver) throw new Error("The note delivery connection is unavailable.");
  await deliver();
}
