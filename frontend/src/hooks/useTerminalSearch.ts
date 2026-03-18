import { useState, useRef, useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';
import {
  collectTerminalSearchMatches,
  getNextTerminalSearchIndex,
  type TerminalSearchMatch,
  type TerminalSearchResult,
} from '../utils/terminalSearch';

export interface UseTerminalSearchReturn {
  isSearchOpen: boolean;
  searchQuery: string;
  searchStatus: TerminalSearchResult;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  openSearch: () => void;
  closeSearch: () => void;
  onQueryChange: (query: string) => void;
  onStep: (direction: 'next' | 'prev') => void;
}

const DEFAULT_SEARCH_RESULT: TerminalSearchResult = {
  found: false,
  currentIndex: 0,
  total: 0,
};

export function useTerminalSearch(
  terminalRef: React.RefObject<Terminal | null>
): UseTerminalSearchReturn {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<TerminalSearchResult>(DEFAULT_SEARCH_RESULT);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keep the latest matches in a ref so onStep can access them without
  // requiring them as a dependency in its callback.
  const matchesRef = useRef<TerminalSearchMatch[]>([]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    // Focus after the overlay has been rendered
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchStatus(DEFAULT_SEARCH_RESULT);
    matchesRef.current = [];
    terminalRef.current?.clearSelection();
  }, [terminalRef]);

  const selectAndScrollToMatch = useCallback(
    (matches: TerminalSearchMatch[], index: number) => {
      const terminal = terminalRef.current;
      if (!terminal || matches.length === 0 || index < 0) return;

      const match = matches[index];
      terminal.select(match.col, match.row, match.length);
      terminal.scrollToLine(match.row);
    },
    [terminalRef]
  );

  const onQueryChange = useCallback(
    (query: string) => {
      setSearchQuery(query);

      const terminal = terminalRef.current;
      if (!terminal) {
        setSearchStatus(DEFAULT_SEARCH_RESULT);
        matchesRef.current = [];
        return;
      }

      const buffer = terminal.buffer.active;
      const matches = collectTerminalSearchMatches(buffer, query);
      matchesRef.current = matches;

      if (matches.length === 0) {
        terminal.clearSelection();
        setSearchStatus({ found: false, currentIndex: 0, total: 0 });
        return;
      }

      const firstIndex = 0;
      selectAndScrollToMatch(matches, firstIndex);
      setSearchStatus({ found: true, currentIndex: firstIndex, total: matches.length });
    },
    [terminalRef, selectAndScrollToMatch]
  );

  const onStep = useCallback(
    (direction: 'next' | 'prev') => {
      const matches = matchesRef.current;
      if (matches.length === 0) return;

      setSearchStatus((prev) => {
        const nextIndex = getNextTerminalSearchIndex(matches, prev.currentIndex, direction);
        if (nextIndex === -1) return prev;

        selectAndScrollToMatch(matches, nextIndex);
        return { found: true, currentIndex: nextIndex, total: matches.length };
      });
    },
    [selectAndScrollToMatch]
  );

  return {
    isSearchOpen,
    searchQuery,
    searchStatus,
    searchInputRef,
    openSearch,
    closeSearch,
    onQueryChange,
    onStep,
  };
}
