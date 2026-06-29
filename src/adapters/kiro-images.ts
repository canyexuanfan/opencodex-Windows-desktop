import type { OcxContentPart } from "../types";

// CodeWhisperer native image part (matches Kiro IDE wire format): the base64 bytes live directly in
// userInputMessage.images, NOT in userInputMessageContext. Verified against kiro-gateway.
export interface KiroImage {
  format: string; // "jpeg" | "png" | "webp" | "gif" — derived from the media subtype
  source: { bytes: string }; // pure base64, no "data:...;base64," prefix
}

// Codex sends each image as a `data:` URL (base64) or a remote https URL. Only data URLs can be
// inlined as bytes here; remote URLs are not fetchable at request-build time.
function parseDataUrlImage(imageUrl: string): KiroImage | undefined {
  if (!imageUrl.startsWith("data:")) return undefined;
  const comma = imageUrl.indexOf(",");
  if (comma === -1) return undefined;
  const header = imageUrl.slice(5, comma);
  const bytes = imageUrl.slice(comma + 1);
  if (!bytes) return undefined;
  const mediaType = header.split(";")[0] || "image/jpeg";
  const subtype = (mediaType.includes("/") ? mediaType.split("/")[1] : mediaType) || "jpeg";
  // CodeWhisperer/Bedrock expects "jpeg", not the "jpg" alias.
  const format = subtype.toLowerCase() === "jpg" ? "jpeg" : subtype.toLowerCase();
  return { format, source: { bytes } };
}

export function extractKiroImages(content: string | OcxContentPart[]): KiroImage[] {
  if (typeof content === "string") return [];
  const out: KiroImage[] = [];
  for (const p of content) {
    if (p.type !== "image") continue;
    const img = parseDataUrlImage(p.imageUrl);
    if (img) out.push(img);
  }
  return out;
}
