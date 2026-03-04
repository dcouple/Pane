import { useState, useCallback } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyableField({ icon: Icon, value, mono }: { icon: React.FC<{ className?: string }>; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 w-full text-left rounded px-0.5 -mx-0.5 hover:bg-surface-hover transition-colors group"
    >
      <Icon className="w-3 h-3 text-text-tertiary flex-shrink-0" />
      <span className={`text-text-secondary truncate flex-1 ${mono ? 'font-mono' : ''}`}>{value}</span>
      {copied ? (
        <Check className="w-2.5 h-2.5 text-status-success flex-shrink-0" />
      ) : (
        <Copy className="w-2.5 h-2.5 text-text-tertiary flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  );
}
