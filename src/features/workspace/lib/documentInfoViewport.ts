export const getDocumentInfoViewportStyle = (
  viewport: { height: number; offsetTop: number } | null,
  windowHeight: number,
) => {
  const fallbackHeight = Number.isFinite(windowHeight) && windowHeight > 0 ? windowHeight : 0;
  const height = viewport && Number.isFinite(viewport.height) && viewport.height > 0
    ? viewport.height : fallbackHeight;
  const top = viewport && Number.isFinite(viewport.offsetTop) && viewport.offsetTop > 0
    ? viewport.offsetTop : 0;
  return {
    "--document-info-viewport-height": `${height}px`,
    "--document-info-viewport-top": `${top}px`,
  };
};
