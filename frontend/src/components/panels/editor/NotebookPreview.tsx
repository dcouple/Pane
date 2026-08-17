import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { MarkdownPreview } from '../../MarkdownPreview';

// --- Notebook JSON types ---

interface NotebookCellOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, string | string[] | unknown>;
  name?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  execution_count?: number | null;
  outputs?: NotebookCellOutput[];
  metadata?: Record<string, unknown>;
}

interface NotebookData {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: {
      display_name?: string;
      language?: string;
      name?: string;
    };
    language_info?: {
      name?: string;
      version?: string;
    };
    [key: string]: unknown;
  };
  nbformat?: number;
  nbformat_minor?: number;
}

// --- Helpers ---

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

function joinText(text: string | string[] | undefined): string {
  if (!text) return '';
  return Array.isArray(text) ? text.join('') : text;
}

/** Strip ANSI escape codes from traceback strings */
function stripAnsi(str: string): string {
  // oxlint-disable-next-line eslint/no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function getMimeData(data: Record<string, string | string[] | unknown>, mime: string): string | undefined {
  const val = data[mime];
  if (val === undefined) return undefined;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(String).join('');
  // For non-string values (e.g. application/json stored as object), stringify
  return JSON.stringify(val, null, 2);
}

// --- Sub-components ---

function CellOutputRenderer({ output, index }: { output: NotebookCellOutput; index: number }) {
  const { output_type } = output;

  if (output_type === 'stream') {
    return (
      <pre className="nb-output-stream">
        {joinText(output.text)}
      </pre>
    );
  }

  if (output_type === 'error') {
    const traceback = (output.traceback || []).map(stripAnsi).join('\n');
    return (
      <div className="nb-output-error">
        <div className="nb-output-error-header">
          {output.ename}: {output.evalue}
        </div>
        <pre className="nb-output-error-traceback">{traceback}</pre>
      </div>
    );
  }

  if (output_type === 'execute_result' || output_type === 'display_data') {
    const data = output.data;
    if (!data) return null;

    // Priority: image > HTML > SVG > JSON > plain text
    const png = getMimeData(data, 'image/png');
    if (png) {
      return (
        <div className="nb-output-image">
          <img src={`data:image/png;base64,${png.trim()}`} alt={`Output ${index}`} />
        </div>
      );
    }

    const jpeg = getMimeData(data, 'image/jpeg');
    if (jpeg) {
      return (
        <div className="nb-output-image">
          <img src={`data:image/jpeg;base64,${jpeg.trim()}`} alt={`Output ${index}`} />
        </div>
      );
    }

    const svg = getMimeData(data, 'image/svg+xml');
    if (svg) {
      const sanitized = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      return (
        <div
          className="nb-output-image"
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      );
    }

    const html = getMimeData(data, 'text/html');
    if (html) {
      const sanitized = DOMPurify.sanitize(html);
      return (
        <div
          className="nb-output-html"
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      );
    }

    const jsonVal = data['application/json'];
    if (jsonVal !== undefined) {
      let formatted: string;
      if (typeof jsonVal === 'string') {
        try {
          formatted = JSON.stringify(JSON.parse(jsonVal), null, 2);
        } catch {
          formatted = jsonVal;
        }
      } else {
        formatted = JSON.stringify(jsonVal, null, 2);
      }
      return <pre className="nb-output-stream">{formatted}</pre>;
    }

    const plain = getMimeData(data, 'text/plain');
    if (plain) {
      return <pre className="nb-output-stream">{plain}</pre>;
    }

    return null;
  }

  return null;
}

function CodeCell({ cell, cellIndex }: { cell: NotebookCell; cellIndex: number }) {
  const source = joinSource(cell.source);
  const execCount = cell.execution_count;
  const label = execCount != null ? `In [${execCount}]:` : 'In [ ]:';

  return (
    <div className="nb-cell nb-cell-code">
      <div className="nb-cell-header">
        <span className="nb-cell-badge nb-badge-code">{label}</span>
      </div>
      <pre className="nb-code-source">
        <code>{source}</code>
      </pre>
      {cell.outputs && cell.outputs.length > 0 && (
        <div className="nb-cell-outputs">
          {cell.outputs.map((output, i) => (
            <CellOutputRenderer key={`${cellIndex}-out-${i}`} output={output} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function MarkdownCell({ cell }: { cell: NotebookCell }) {
  const source = joinSource(cell.source);
  return (
    <div className="nb-cell nb-cell-markdown">
      <MarkdownPreview content={source} />
    </div>
  );
}

function RawCell({ cell }: { cell: NotebookCell }) {
  const source = joinSource(cell.source);
  return (
    <div className="nb-cell nb-cell-raw">
      <pre className="nb-raw-source">{source}</pre>
    </div>
  );
}

// --- Main component ---

interface NotebookPreviewProps {
  content: string;
  className?: string;
}

export const NotebookPreview: React.FC<NotebookPreviewProps> = ({ content, className = '' }) => {
  const notebook = useMemo<NotebookData | null>(() => {
    try {
      const parsed = JSON.parse(content) as NotebookData;
      if (!parsed.cells || !Array.isArray(parsed.cells)) return null;
      return parsed;
    } catch {
      return null;
    }
  }, [content]);

  if (!notebook) {
    return (
      <div className={`nb-preview ${className}`}>
        <div className="nb-error">
          <p>Invalid notebook format</p>
          <p className="nb-error-hint">Unable to parse this file as a Jupyter notebook.</p>
        </div>
      </div>
    );
  }

  const kernelLang =
    notebook.metadata?.kernelspec?.display_name ||
    notebook.metadata?.language_info?.name ||
    'Unknown kernel';

  return (
    <div className={`nb-preview ${className}`}>
      <div className="nb-header">
        <span className="nb-header-kernel">{kernelLang}</span>
        {notebook.nbformat != null && (
          <span className="nb-header-format">
            nbformat {notebook.nbformat}.{notebook.nbformat_minor ?? 0}
          </span>
        )}
      </div>
      <div className="nb-cells">
        {notebook.cells.map((cell, index) => {
          switch (cell.cell_type) {
            case 'markdown':
              return <MarkdownCell key={index} cell={cell} />;
            case 'code':
              return <CodeCell key={index} cell={cell} cellIndex={index} />;
            case 'raw':
              return <RawCell key={index} cell={cell} />;
            default:
              return (
                <div key={index} className="nb-cell nb-cell-unknown">
                  <span className="nb-cell-badge">Unknown cell type: {cell.cell_type}</span>
                  <pre>{joinSource(cell.source)}</pre>
                </div>
              );
          }
        })}
      </div>
    </div>
  );
};
