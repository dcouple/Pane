interface BinaryFilePreviewProps {
  kind: 'image' | 'pdf';
  /** Object URL once the bytes have arrived; null shows a placeholder. */
  blobUrl: string | null;
  fileName: string;
}

export function BinaryFilePreview({ kind, blobUrl, fileName }: BinaryFilePreviewProps) {
  if (!blobUrl) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-primary">
        <div className="animate-pulse flex flex-col items-center gap-3">
          <div className="w-48 h-48 bg-surface-tertiary rounded" />
          <div className="w-32 h-3 bg-surface-tertiary rounded" />
        </div>
      </div>
    );
  }
  if (kind === 'image') {
    return (
      <div className="flex items-center justify-center h-full bg-surface-primary p-4 overflow-auto">
        <img src={blobUrl} alt={fileName} className="max-w-full max-h-full object-contain rounded" />
      </div>
    );
  }
  return (
    <object data={blobUrl} type="application/pdf" className="w-full h-full">
      <div className="flex items-center justify-center h-full text-text-secondary">
        PDF preview not available.
      </div>
    </object>
  );
}
