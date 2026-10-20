import type { Message } from "@earendil-works/pi-ai";
import type { WireVision } from "../../src/wire/protocol.js";
export const vision: WireVision = {
  formats: ["png", "jpeg"], budgets: [70, 140, 280, 560, 1120], default_budget: 280,
  max_bytes: 48 * 1024 * 1024, max_context_media_bytes: 256 * 1024 * 1024, media_refs: true,
};
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
export function photo(text = "What is in this image?", data = png): Message {
  return { role: "user", content: [{ type: "text", text }, { type: "image", data, mimeType: "image/png" }], timestamp: 0 };
}
