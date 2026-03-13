/** Image MIME types supported by Claude vision */
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);

/** Check if a MIME type is a supported image type for Claude vision. */
export function isImageMimeType(mimeType: string | undefined): boolean {
  return mimeType !== undefined && SUPPORTED_IMAGE_MIMES.has(mimeType);
}

/** Map image MIME type to file extension */
export function imageExtensionForMime(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/bmp": return ".bmp";
    default: return ".jpg";
  }
}
