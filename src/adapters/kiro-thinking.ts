import type { AdapterEvent } from "../types";

type ThinkingTag = "<thinking>" | "<think>" | "<reasoning>";
type ParserState = "pre" | "thinking" | "streaming";

const OPEN_TAGS: ThinkingTag[] = ["<thinking>", "<think>", "<reasoning>"];
const MAX_OPEN_TAG = Math.max(...OPEN_TAGS.map(t => t.length));
const MAX_CLOSE_TAG = Math.max(...OPEN_TAGS.map(t => `</${t.slice(1)}`.length));

function closeTagFor(openTag: ThinkingTag): string {
  return `</${openTag.slice(1)}`;
}

function isPossibleOpenTagPrefix(text: string): boolean {
  return OPEN_TAGS.some(tag => tag.startsWith(text) && text.length < tag.length);
}

export class KiroThinkingParser {
  private state: ParserState = "pre";
  private preBuffer = "";
  private thinkingBuffer = "";
  private closeTag = "";

  feed(text: string): AdapterEvent[] {
    if (!text) return [];
    if (this.state === "streaming") return [{ type: "text_delta", text }];
    if (this.state === "thinking") {
      this.thinkingBuffer += text;
      return this.drainThinking();
    }
    this.preBuffer += text;
    const stripped = this.preBuffer.trimStart();
    const openTag = OPEN_TAGS.find(tag => stripped.startsWith(tag));
    if (openTag) {
      this.state = "thinking";
      this.closeTag = closeTagFor(openTag);
      this.thinkingBuffer = stripped.slice(openTag.length);
      this.preBuffer = "";
      return this.drainThinking();
    }
    if (stripped.length <= MAX_OPEN_TAG && isPossibleOpenTagPrefix(stripped)) return [];
    this.state = "streaming";
    const out = this.preBuffer;
    this.preBuffer = "";
    return out ? [{ type: "text_delta", text: out }] : [];
  }

  flush(): AdapterEvent[] {
    if (this.state === "thinking") {
      const out = this.thinkingBuffer;
      this.thinkingBuffer = "";
      this.state = "streaming";
      return out ? [{ type: "reasoning_raw_delta", text: out }] : [];
    }
    if (this.preBuffer) {
      const out = this.preBuffer;
      this.preBuffer = "";
      this.state = "streaming";
      return [{ type: "text_delta", text: out }];
    }
    return [];
  }

  private drainThinking(): AdapterEvent[] {
    const close = this.closeTag;
    const idx = this.thinkingBuffer.indexOf(close);
    if (idx >= 0) {
      const thinking = this.thinkingBuffer.slice(0, idx);
      const after = this.thinkingBuffer.slice(idx + close.length).trimStart();
      this.thinkingBuffer = "";
      this.state = "streaming";
      const events: AdapterEvent[] = [];
      if (thinking) events.push({ type: "reasoning_raw_delta", text: thinking });
      if (after) events.push({ type: "text_delta", text: after });
      return events;
    }
    if (this.thinkingBuffer.length <= MAX_CLOSE_TAG) return [];
    const send = this.thinkingBuffer.slice(0, -MAX_CLOSE_TAG);
    this.thinkingBuffer = this.thinkingBuffer.slice(-MAX_CLOSE_TAG);
    return send ? [{ type: "reasoning_raw_delta", text: send }] : [];
  }
}
