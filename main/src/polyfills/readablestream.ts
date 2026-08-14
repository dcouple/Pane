/**
 * ReadableStream polyfill for Node.js environments
 * This ensures the Web Streams API is available as a global
 */

// Check if ReadableStream is already available
if (typeof globalThis.ReadableStream === 'undefined') {
  try {
    // Try to import from Node.js built-in stream/web module (Node 16.5+)
    const { ReadableStream, WritableStream, TransformStream } = require('stream/web');
    
    // Make them available globally
    globalThis.ReadableStream = ReadableStream;
    globalThis.WritableStream = WritableStream;
    globalThis.TransformStream = TransformStream;
    
    console.log('[Polyfill] Using Node.js built-in ReadableStream from stream/web');
  } catch (error) {
    // If stream/web is not available, use the web-streams-polyfill package
    try {
      const streams = require('web-streams-polyfill/ponyfill');
      
      globalThis.ReadableStream = streams.ReadableStream;
      globalThis.WritableStream = streams.WritableStream;
      globalThis.TransformStream = streams.TransformStream;
      
      console.log('[Polyfill] Using web-streams-polyfill for ReadableStream');
    } catch (polyfillError) {
      console.error('[Polyfill] Failed to load ReadableStream polyfill:', polyfillError);
      console.error('[Polyfill] Dependencies relying on a global ReadableStream may not function properly');
    }
  }
} else {
  console.log('[Polyfill] ReadableStream already available, skipping polyfill');
}

// Export for TypeScript typing if needed
export {};