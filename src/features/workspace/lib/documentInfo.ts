export type DocumentInfoDetail = Readonly<{ label: string; value: string }>;

export const buildDocumentInfoDetails = (info: {
  projectName: string;
  typeLabel: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  revision?: number | null;
  image?: { width: number; height: number; layerCount: number } | null;
}): DocumentInfoDetail[] => {
  const details: DocumentInfoDetail[] = [
    { label: "Project", value: info.projectName },
    { label: "Type", value: info.typeLabel },
  ];
  if (info.image) {
    details.push(
      { label: "Size", value: `${info.image.width} × ${info.image.height} px` },
      { label: "Layers", value: String(info.image.layerCount) },
    );
  }
  for (const [label, timestamp] of [["Created", info.createdAt], ["Updated", info.updatedAt]] as const) {
    if (!timestamp) continue;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) continue;
    details.push({ label, value: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short",
    }).format(date) });
  }
  if (typeof info.revision === "number" && Number.isInteger(info.revision) && info.revision >= 0) {
    details.push({ label: "Revision", value: String(info.revision) });
  }
  return details;
};
