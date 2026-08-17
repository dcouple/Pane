export interface Folder {
  id: string;
  name: string;
  projectId: number;
  parentFolderId?: string | null;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  children?: Folder[]; // For tree representation
}
