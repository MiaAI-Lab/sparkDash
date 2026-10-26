import { observation } from './journal.js';

/** Bounded OpenAI-compatible JSON/SSE observer. Never retain prompts/reasoning or alter the stream. */
export function createCompletionObserver(options, emit) {
  let buffer = '', bytes = 0, gap = false, ended = false, mode = null, recognized = false, emittedTools = 0;
  const pending = new Map();
  function emitTool(fn) {
    if (!fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string' || emittedTools >= 32) { gap = true; return; }
    if (fn.name.length > 256 || fn.arguments.length > 65536) gap = true;
    emittedTools++;
    emit(observation({ name: fn.name.slice(0, 256), arguments: fn.arguments.slice(0, 65536) }, { ...options, kind: 'tool-proposal' }));
  }
  function inspect(value) {
    if (!value || !Array.isArray(value.choices)) { gap = true; return; }
    recognized = true;
    if (value.choices.length > 16) gap = true;
    for (const choice of value.choices.slice(0, 16)) {
      if (!choice || typeof choice !== 'object') { gap = true; continue; }
      const direct = choice.message?.tool_calls ?? [];
      const delta = choice.delta?.tool_calls ?? [];
      if (!Array.isArray(direct) || !Array.isArray(delta)) { gap = true; continue; }
      if (direct.length > 32 || delta.length > 32) gap = true;
      for (const tool of direct.slice(0, 32)) emitTool(tool?.function);
      for (const tool of delta.slice(0, 32)) {
        if (!tool || typeof tool !== 'object') { gap = true; continue; }
        const key = `${choice.index ?? 0}:${tool.index ?? 0}`;
        if (!pending.has(key) && pending.size >= 32) { gap = true; continue; }
        const entry = pending.get(key) ?? { name: '', arguments: '' };
        if (typeof tool.function?.name === 'string') entry.name += tool.function.name;
        if (typeof tool.function?.arguments === 'string') entry.arguments += tool.function.arguments;
        if (entry.arguments.length > 65536 || entry.name.length > 256) gap = true;
        entry.arguments = entry.arguments.slice(0, 65536);
        entry.name = entry.name.slice(0, 256);
        pending.set(key, entry);
      }
    }
  }
  function frame(line) {
    if (!line.trim() || line.startsWith(':') || /^(event|id|retry):/.test(line)) return;
    if (!line.startsWith('data:')) { gap = true; return; }
    const text = line.slice(5).trim();
    if (text === '[DONE]' || !text) return;
    try { inspect(JSON.parse(text)); } catch { gap = true; }
  }
  return {
    push(text) {
      if (ended) return;
      bytes += Buffer.byteLength(text);
      if (bytes > 2 * 1024 * 1024) { gap = true; return; }
      buffer += text;
      if (!mode && buffer.trim()) mode = /^[{[]/.test(buffer.trimStart()) ? 'json' : 'sse';
      if (mode === 'sse') {
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          frame(buffer.slice(0, newline).replace(/\r$/, ''));
          buffer = buffer.slice(newline + 1);
        }
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (buffer.trim()) {
        if (mode === 'sse') frame(buffer.replace(/\r$/, ''));
        else { try { inspect(JSON.parse(buffer)); } catch { gap = true; } }
      }
      for (const entry of pending.values()) emitTool(entry);
      if (recognized) emit(observation('OpenAI-compatible response', { ...options, kind: 'model-response' }));
      gap ||= !recognized;
      if (gap) emit({ ...observation('bounded inspection', { ...options, kind: 'coverage-gap' }), signals: ['inspection-gap'] });
    },
  };
}
