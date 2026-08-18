import { DatabaseService } from '../database/database';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

type SidebarSection = 'pinned' | 'repositories';

const SIDEBAR_SECTION_KEYS = {
  pinned: 'treeView.pinnedSectionExpanded',
  repositories: 'treeView.repositoriesSectionExpanded'
} satisfies Record<SidebarSection, string>;

interface ExpandedUiState {
  expandedProjects: number[];
  expandedFolders: string[];
  sessionSortAscending: boolean;
  pinnedSectionExpanded: boolean;
  repositoriesSectionExpanded: boolean;
}

class UIStateManager {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  getExpandedProjects(): number[] {
    const value = this.db.getUIState('treeView.expandedProjects');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  getExpandedFolders(): string[] {
    const value = this.db.getUIState('treeView.expandedFolders');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  getSessionSortAscending(): boolean {
    const value = this.db.getUIState('treeView.sessionSortAscending');
    if (!value) return true; // Default to ascending (newest at bottom)
    try {
      return JSON.parse(value);
    } catch {
      return true;
    }
  }

  getSidebarSectionExpanded(section: SidebarSection): boolean {
    const value = this.db.getUIState(SIDEBAR_SECTION_KEYS[section]);
    if (!value) return true;
    try {
      return decodeBoundary(JSON.parse(value), boundary.boolean);
    } catch {
      return true;
    }
  }

  saveExpandedProjects(projectIds: number[]): void {
    this.db.setUIState('treeView.expandedProjects', JSON.stringify(projectIds));
  }

  saveExpandedFolders(folderIds: string[]): void {
    this.db.setUIState('treeView.expandedFolders', JSON.stringify(folderIds));
  }

  saveSessionSortAscending(ascending: boolean): void {
    this.db.setUIState('treeView.sessionSortAscending', JSON.stringify(ascending));
  }

  saveSidebarSectionExpanded(section: SidebarSection, expanded: boolean): void {
    this.db.setUIState(SIDEBAR_SECTION_KEYS[section], JSON.stringify(expanded));
  }

  saveExpandedState(projectIds: number[], folderIds: string[]): void {
    this.saveExpandedProjects(projectIds);
    this.saveExpandedFolders(folderIds);
  }

  getExpandedState(): ExpandedUiState {
    return {
      expandedProjects: this.getExpandedProjects(),
      expandedFolders: this.getExpandedFolders(),
      sessionSortAscending: this.getSessionSortAscending(),
      pinnedSectionExpanded: this.getSidebarSectionExpanded('pinned'),
      repositoriesSectionExpanded: this.getSidebarSectionExpanded('repositories')
    };
  }

  clear(): void {
    this.db.deleteUIState('treeView.expandedProjects');
    this.db.deleteUIState('treeView.expandedFolders');
    this.db.deleteUIState('treeView.sessionSortAscending');
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.pinned);
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.repositories);
  }
}

export { UIStateManager };
