import type { TranslatorBudget } from "../lib/translator-budget";
import {
  customToolItemId,
  restoreRoutedCustomCalls,
  unwrapRoutedCustomToolArguments,
} from "../responses/custom-tool-compat";
import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

const FREEFORM_WRAP_PREFIX = '{"input":"';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function partialCustomToolInput(argumentsText: string): string {
  if (!argumentsText.startsWith(FREEFORM_WRAP_PREFIX)) return argumentsText;
  const body = argumentsText.slice(FREEFORM_WRAP_PREFIX.length);
  let output = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '"') break;
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) break;
    index += 1;
    if (escaped === "n") output += "\n";
    else if (escaped === "t") output += "\t";
    else if (escaped === "r") output += "\r";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "u") {
      const hex = body.slice(index + 1, index + 5);
      if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else output += escaped;
  }
  return output;
}

function replaceSseEventName(block: string, type: string): string {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  let replaced = false;
  const next = lines.map(line => {
    if (!replaced && line.startsWith("event:")) {
      replaced = true;
      return `event: ${type}`;
    }
    return line;
  });
  return next.join(newline);
}

type OpenCustomCall = {
  argumentsText: string;
  emittedInput: string;
  retainedBytes: number;
};

type PendingArgumentBlock = {
  block: string;
  itemId?: string;
  outputIndex?: number;
  retainedBytes: number;
};

export function createRoutedCustomToolRestoreBlockRewrite(
  names: ReadonlySet<string>,
  budget?: TranslatorBudget,
): SseBlockRewrite {
  const itemNames = new Map<string, string>();
  const ordinaryItemIds = new Set<string>();
  const openCalls = new Map<string, OpenCustomCall>();
  let pendingArguments: PendingArgumentBlock[] = [];
  let disposed = false;

  const releaseCall = (itemId: string): void => {
    const open = openCalls.get(itemId);
    if (!open) return;
    if (open.retainedBytes > 0) {
      budget?.releaseRetained(open.retainedBytes, { kind: "retained_collectors" });
    }
    openCalls.delete(itemId);
  };

  const releaseAll = (): void => {
    if (disposed) return;
    disposed = true;
    for (const itemId of openCalls.keys()) releaseCall(itemId);
    const pendingBytes = pendingArguments.reduce((total, pending) => total + pending.retainedBytes, 0);
    if (pendingBytes > 0) {
      budget?.releaseRetained(pendingBytes, { kind: "retained_collectors" });
    }
    pendingArguments = [];
    itemNames.clear();
    ordinaryItemIds.clear();
  };

  const retainPendingArgument = (
    block: string,
    itemId: string | undefined,
    outputIndex: number | undefined,
  ): void => {
    const retainedBytes = Buffer.byteLength(block, "utf8");
    if (retainedBytes > 0) budget?.chargeRetained(retainedBytes, { kind: "retained_collectors" });
    pendingArguments.push({ block, itemId, outputIndex, retainedBytes });
  };

  const takePendingArguments = (
    itemId: string | undefined,
    outputIndex: number | undefined,
  ): string[] => {
    const matched: PendingArgumentBlock[] = [];
    const remaining: PendingArgumentBlock[] = [];
    for (const pending of pendingArguments) {
      const matches = pending.itemId !== undefined
        ? itemId !== undefined && pending.itemId === itemId
        : outputIndex !== undefined && pending.outputIndex === outputIndex;
      (matches ? matched : remaining).push(pending);
    }
    pendingArguments = remaining;
    const retainedBytes = matched.reduce((total, pending) => total + pending.retainedBytes, 0);
    if (retainedBytes > 0) {
      budget?.releaseRetained(retainedBytes, { kind: "retained_collectors" });
    }
    return matched.map(pending => pending.block);
  };

  const rewrite: SseBlockRewrite = (block: string): readonly string[] => {
    if (disposed) return [block];
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isPlainObject(parsed)) return [block];

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const outputIndex = typeof parsed.output_index === "number"
      && Number.isInteger(parsed.output_index)
      && parsed.output_index >= 0
      ? parsed.output_index
      : undefined;
    if (
      (type === "response.output_item.added" || type === "response.output_item.done")
      && isPlainObject(parsed.item)
      && parsed.item.type === "function_call"
      && typeof parsed.item.name === "string"
    ) {
      const upstreamItemId = typeof parsed.item.id === "string" ? parsed.item.id : undefined;
      const routed = names.has(parsed.item.name);
      if (upstreamItemId) {
        if (routed) {
          itemNames.set(upstreamItemId, parsed.item.name);
          ordinaryItemIds.delete(upstreamItemId);
        } else {
          ordinaryItemIds.add(upstreamItemId);
        }
        if (routed && type === "response.output_item.added") {
          openCalls.set(upstreamItemId, { argumentsText: "", emittedInput: "", retainedBytes: 0 });
        }
      }
      const pending = takePendingArguments(upstreamItemId, outputIndex);
      if (!routed) {
        if (type === "response.output_item.done" && upstreamItemId) ordinaryItemIds.delete(upstreamItemId);
        return [...pending, block];
      }
      if (upstreamItemId && pending.length > 0 && !openCalls.has(upstreamItemId)) {
        openCalls.set(upstreamItemId, { argumentsText: "", emittedInput: "", retainedBytes: 0 });
      }
      const restored = restoreRoutedCustomCalls(parsed, names);
      const restoredBlock = restored.changed
        ? replaceSseDataPayload(block, JSON.stringify(restored.value))
        : block;
      const replayed = pending.flatMap(pendingBlock => rewrite(pendingBlock));
      if (type === "response.output_item.done" && upstreamItemId) releaseCall(upstreamItemId);
      return type === "response.output_item.added"
        ? [restoredBlock, ...replayed]
        : [...replayed, restoredBlock];
    }

    const upstreamItemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
    const argumentEvent = type === "response.function_call_arguments.delta"
      || type === "response.function_call_arguments.done";
    if (argumentEvent && (!upstreamItemId || (!itemNames.has(upstreamItemId) && !ordinaryItemIds.has(upstreamItemId)))) {
      retainPendingArgument(block, upstreamItemId, outputIndex);
      return [];
    }
    if (
      type === "response.function_call_arguments.delta"
      && upstreamItemId
      && itemNames.has(upstreamItemId)
    ) {
      const open = openCalls.get(upstreamItemId) ?? { argumentsText: "", emittedInput: "", retainedBytes: 0 };
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      const deltaBytes = Buffer.byteLength(delta, "utf8");
      if (deltaBytes > 0) budget?.chargeRetained(deltaBytes, { kind: "retained_collectors" });
      open.argumentsText += delta;
      open.retainedBytes += deltaBytes;
      openCalls.set(upstreamItemId, open);
      if (FREEFORM_WRAP_PREFIX.startsWith(open.argumentsText)) return [];
      const fullInput = partialCustomToolInput(open.argumentsText);
      if (!fullInput.startsWith(open.emittedInput) || fullInput.length === open.emittedInput.length) return [];
      const inputDelta = fullInput.slice(open.emittedInput.length);
      open.emittedInput = fullInput;
      const nextType = "response.custom_tool_call_input.delta";
      const next = {
        ...parsed,
        type: nextType,
        item_id: customToolItemId(upstreamItemId),
        delta: inputDelta,
      };
      return [replaceSseDataPayload(replaceSseEventName(block, nextType), JSON.stringify(next))];
    }

    if (
      type === "response.function_call_arguments.done"
      && upstreamItemId
      && itemNames.has(upstreamItemId)
    ) {
      const nextType = "response.custom_tool_call_input.done";
      const source = typeof parsed.arguments === "string"
        ? parsed.arguments
        : openCalls.get(upstreamItemId)?.argumentsText ?? "";
      const { arguments: _arguments, ...rest } = parsed;
      const next = {
        ...rest,
        type: nextType,
        item_id: customToolItemId(upstreamItemId),
        input: unwrapRoutedCustomToolArguments(source),
      };
      return [replaceSseDataPayload(replaceSseEventName(block, nextType), JSON.stringify(next))];
    }

    const restored = restoreRoutedCustomCalls(parsed, names);
    const terminal = type === "response.completed" || type === "response.failed" || type === "response.incomplete";
    if (terminal) releaseAll();
    return restored.changed
      ? [replaceSseDataPayload(block, JSON.stringify(restored.value))]
      : [block];
  };
  rewrite.dispose = releaseAll;
  return rewrite;
}
