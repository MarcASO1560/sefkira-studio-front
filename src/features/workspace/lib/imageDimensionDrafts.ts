import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXEL_COUNT, MAX_IMAGE_DOCUMENT_PIXELS, isValidImageDimensions } from "../../pixel-art/lib/document";

/** Validate before allocating pixels; never silently replace a requested size. */
export const validateImageDimensionDrafts = (width: number, height: number, layerCount = 1): string | null => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return "Width and height must be positive whole numbers.";
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return `Each side can be up to ${MAX_IMAGE_DIMENSION.toLocaleString("en-US")} px.`;
  }
  if (!isValidImageDimensions(width, height)) {
    return `The canvas can contain up to ${MAX_IMAGE_PIXEL_COUNT.toLocaleString("en-US")} pixels (for example, 2048 × 2048).`;
  }
  if (width * height * layerCount > MAX_IMAGE_DOCUMENT_PIXELS) {
    return "This size exceeds the document's total layer capacity. Use fewer layers or a smaller canvas.";
  }
  return null;
};
